import { DurableObject } from 'cloudflare:workers';
import { settings } from '../../shared/settings';
import { loadMatchDefinition } from '../catalog/database';
import type { MatchDefinition, VersionRef } from '../catalog/definition';
import type { Env } from '../env';

// ponytail: 1開催元64ルームまでを直列化。規模を拡大するときはactor予約と待機列を分割する。
type Entry = {
  created: number;
  room: string;
  key: string;
  token: string;
  name: string;
  pending?: MatchDefinition;
};
type Queue = {
  actors: Record<string, Entry>;
  rates: Record<string, { at: number; count: number; admissionId?: string }>;
};
export class Matchmaker extends DurableObject<Env> {
  async enter(actorId: string, name: string, reference?: VersionRef, resume = false) {
    let definition: MatchDefinition | undefined;
    let rateChecked = false;
    const admissionId = crypto.randomUUID();
    for (;;) {
      const result = await this.ctx.blockConcurrencyWhile(async () => {
        const queue = await this.read();
        if (!rateChecked) {
          rateChecked = true;
          if (!this.rate(queue, actorId)) {
            await this.write(queue);
            return { ok: false as const, code: 'RATE_LIMIT' };
          }
        }
        await this.clean(queue);
        let entry = queue.actors[actorId];
        if (entry && !resume) {
          await this.write(queue);
          return { ok: false as const, code: 'ALREADY_JOINED' };
        }
        if (!entry && resume) {
          await this.write(queue);
          return { ok: false as const, code: 'NO_ACTIVE_MATCH' };
        }
        if (!entry) {
          if (!definition) {
            // The bounded per-actor request record also identifies the latest DB load.
            queue.rates[actorId].admissionId = admissionId;
            await this.write(queue);
            return null;
          }
          if (queue.rates[actorId]?.admissionId !== admissionId) {
            await this.write(queue);
            return { ok: false as const, code: 'STALE_REQUEST' };
          }
          const key = JSON.stringify(definition.competition);
          const rooms = [
            ...new Set(
              Object.values(queue.actors)
                .filter((item) => item.key === key)
                .map((item) => item.room),
            ),
          ];
          let available: string | undefined;
          for (const room of rooms) {
            const status = await this.env.GAME_ROOM.getByName(`1c:${room}`).lobbyStatus();
            const reserved = Object.values(queue.actors).filter(
              (item) => item.room === room,
            ).length;
            if (
              status &&
              !status.closed &&
              status.phase === 'WAITING' &&
              reserved < status.capacity
            ) {
              available = room;
              break;
            }
          }
          if (
            !available &&
            new Set(Object.values(queue.actors).map((item) => item.room)).size >=
              settings.lobby.maxRooms
          ) {
            await this.write(queue);
            return { ok: false as const, code: 'MATCHMAKING_FULL' };
          }
          entry = {
            created: Date.now(),
            room: available ?? crypto.randomUUID(),
            key,
            name,
            token: crypto.randomUUID() + crypto.randomUUID(),
            pending: definition,
          };
          queue.actors[actorId] = entry;
          // RPC前に予約を永続化。応答消失・DO復帰でも同じactor/token/roomで回復する。
          await this.write(queue);
        }
        const result = await this.env.GAME_ROOM.getByName(`1c:${entry.room}`).reserve(
          actorId,
          entry.name,
          entry.token,
          entry.pending,
        );
        if (!result.ok) {
          delete queue.actors[actorId];
          await this.write(queue);
          return result;
        }
        delete entry.pending;
        await this.write(queue);
        return {
          ok: true as const,
          room: entry.room,
          token: entry.token,
          expires: result.expires,
        };
      });
      if (result !== null) return result;

      // Re-enter with freshly loaded queue/room state before allocating any reservation.
      try {
        definition = await loadMatchDefinition(this.env, reference);
      } catch {
        return { ok: false as const, code: 'GAME_DATABASE_UNAVAILABLE' };
      }
    }
  }

  async cancel(actorId: string, expectedRoom: string, revoke = false) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const entry = queue.actors[actorId];
      if (!entry) {
        if (queue.rates[actorId]) delete queue.rates[actorId].admissionId;
        await this.write(queue);
        if (revoke)
          await this.env.GAME_ROOM.getByName(`1c:${expectedRoom}`).cancelReservation(
            actorId,
            true,
          );
        return { ok: true as const };
      }
      if (entry.room !== expectedRoom) return { ok: false as const, code: 'STALE_ROOM' };
      const accepted = await this.env.GAME_ROOM.getByName(
        `1c:${entry.room}`,
      ).cancelReservation(actorId, revoke);
      if (!accepted) return { ok: false as const, code: 'MATCH_STARTED' };
      if (queue.rates[actorId]) delete queue.rates[actorId].admissionId;
      if (revoke) entry.token = crypto.randomUUID() + crypto.randomUUID();
      else delete queue.actors[actorId];
      await this.write(queue);
      return { ok: true as const };
    });
  }

  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      await this.clean(queue);
      await this.write(queue);
    });
  }

  private async read(): Promise<Queue> {
    return (await this.ctx.storage.get<Queue>('queue')) ?? { actors: {}, rates: {} };
  }

  private async write(queue: Queue) {
    await this.ctx.storage.put('queue', queue);
    if (Object.keys(queue.actors).length || Object.keys(queue.rates).length)
      await this.ctx.storage.setAlarm(Date.now() + settings.lobby.cleanupIntervalMs);
    else await this.ctx.storage.deleteAlarm();
  }

  private rate(queue: Queue, actor: string) {
    for (const [id, item] of Object.entries(queue.rates))
      if (Date.now() - item.at >= settings.lobby.rateWindowMs) delete queue.rates[id];
    if (!queue.rates[actor]) {
      if (Object.keys(queue.rates).length >= settings.lobby.maxRateActors) return false;
      queue.rates[actor] = { at: Date.now(), count: 0 };
    }
    return ++queue.rates[actor].count <= settings.lobby.requestsPerWindow;
  }

  private async clean(queue: Queue) {
    const rooms = [...new Set(Object.values(queue.actors).map((entry) => entry.room))];
    const statuses = await Promise.all(
      rooms.map(
        async (room) =>
          [room, await this.env.GAME_ROOM.getByName(`1c:${room}`).lobbyStatus()] as const,
      ),
    );
    for (const [actor, entry] of Object.entries(queue.actors)) {
      const status = statuses.find(([room]) => room === entry.room)?.[1];
      if (
        entry.pending &&
        !status &&
        Date.now() < entry.created + settings.lobby.reservationLifetimeMs
      )
        continue;
      if (
        !status ||
        status.closed ||
        status.phase === 'FINISHED' ||
        status.phase === 'INVALID' ||
        ((!entry.pending ||
          Date.now() >= entry.created + settings.lobby.reservationLifetimeMs) &&
          !status.actors.includes(actor))
      )
        delete queue.actors[actor];
    }
    for (const [id, item] of Object.entries(queue.rates))
      if (Date.now() - item.at >= settings.lobby.rateWindowMs) delete queue.rates[id];
  }
}
