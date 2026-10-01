import { DurableObject } from 'cloudflare:workers';
import { settings } from '../../shared/settings';
import { loadMatchDefinition } from '../catalog/database';
import type { MatchDefinition, VersionRef } from '../catalog/definition';
import type { Env } from '../env';
import { anonymizeDefinition } from '../game/privacy';

export type InstanceScope = { id: string; owner: string };
type Entry = {
  band?: number;
  created: number;
  room: string;
  key: string;
  token: string;
  name: string;
  pending?: MatchDefinition | true;
  revoking?: string;
  scope?: InstanceScope;
  generation?: string;
};
type Queue = {
  actors: Record<string, Entry>;
  withdrawals?: Record<string, string>;
  loggingOut?: Record<string, boolean>;
  rates: Record<string, { at: number; count: number; admissionId?: string }>;
};
type Admission = { entry: Entry } | { ok: false; code: string; instanceId?: string };
const generation = (entry: Entry) => entry.generation ?? entry.token;

export class Matchmaker extends DurableObject<Env> {
  private logouts = new Map<string, Promise<{ ok: true }>>();
  async enter(
    actorId: string,
    name: string,
    reference?: VersionRef,
    resume = false,
    scope?: InstanceScope,
  ) {
    const allowed = await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const allowed = this.rate(queue, actorId);
      await this.write(queue);
      return allowed;
    });
    if (!allowed) return { ok: false as const, code: 'RATE_LIMIT' };
    await this.clean(actorId);
    const admissionId = crypto.randomUUID();
    const initial = await this.ctx.blockConcurrencyWhile<Admission | null>(async () => {
      const queue = await this.read();
      const entry = queue.actors[actorId];
      if (queue.withdrawals?.[actorId])
        return { ok: false as const, code: 'WITHDRAWAL_PENDING' };
      if (this.logouts.has(actorId) || queue.loggingOut?.[actorId])
        return { ok: false as const, code: 'LOGOUT_PENDING' };
      if (entry) {
        await this.write(queue);
        if (entry.scope?.id !== scope?.id)
          return {
            ok: false as const,
            code: 'OTHER_INSTANCE_ACTIVE',
            instanceId: entry.scope?.id,
          };
        if (!resume) return { ok: false as const, code: 'ALREADY_JOINED' };
        return { entry };
      }
      if (resume) {
        await this.write(queue);
        return { ok: false as const, code: 'NO_ACTIVE_MATCH' };
      }
      queue.rates[actorId].admissionId = admissionId;
      await this.write(queue);
      return null;
    });
    if (initial)
      return 'entry' in initial ? this.reserve(actorId, initial.entry) : initial;

    let definition: MatchDefinition;
    try {
      definition = await loadMatchDefinition(
        scope ? { ...this.env, GAME_OWNER: scope.owner } : this.env,
        reference,
        actorId,
      );
    } catch (error) {
      if (
        scope &&
        error instanceof Error &&
        ['NO_RANKED_QUESTIONS', 'RANKED_NOT_CONFIGURED'].includes(error.message)
      ) {
        await this.stopWaiting(scope, (error as Error & { band?: number }).band);
        return { ok: false as const, code: error.message };
      }
      return { ok: false as const, code: 'GAME_DATABASE_UNAVAILABLE' };
    }
    if (scope && definition.competition.owner !== scope.owner)
      return { ok: false as const, code: 'INSTANCE_MISMATCH' };
    const key = JSON.stringify(
      scope ? [scope.id, definition.competition] : definition.competition,
    );
    if (
      new Set(
        Object.values((await this.read()).actors)
          .filter((entry) => entry.scope?.id === scope?.id)
          .map((entry) => entry.room),
      ).size >= settings.lobby.maxRooms
    )
      await this.clean(undefined, scope?.id ?? '');
    const snapshot = await this.read();
    const rooms = [
      ...new Set(
        Object.values(snapshot.actors)
          .filter((item) => item.key === key)
          .map((item) => item.room),
      ),
    ];
    // RPCs never hold the organization's storage lock. Recheck reservations when committing.
    const statuses = new Map(
      await Promise.all(
        rooms.map(async (room) => [room, await this.status(room)] as const),
      ),
    );
    const allocated = await this.ctx.blockConcurrencyWhile<Admission>(async () => {
      const queue = await this.read();
      if (queue.withdrawals?.[actorId])
        return { ok: false as const, code: 'WITHDRAWAL_PENDING' };
      if (this.logouts.has(actorId) || queue.loggingOut?.[actorId])
        return { ok: false as const, code: 'LOGOUT_PENDING' };
      if (Object.keys(queue.actors).length >= settings.lobby.maxRateActors)
        return { ok: false as const, code: 'MATCHMAKING_FULL' };
      if (queue.actors[actorId]) return { ok: false as const, code: 'ALREADY_JOINED' };
      if (queue.rates[actorId]?.admissionId !== admissionId)
        return { ok: false as const, code: 'STALE_REQUEST' };
      const same = Object.values(queue.actors).filter((item) => item.key === key);
      const available = same.find((item) => {
        const status = statuses.get(item.room);
        const pendingRoom = item.pending && !statuses.has(item.room);
        return (
          (pendingRoom || (status && !status.closed && status.phase === 'WAITING')) &&
          same.filter((other) => other.room === item.room).length <
            definition.playersPerMatch
        );
      })?.room;
      if (
        !available &&
        new Set(
          Object.values(queue.actors)
            .filter((item) => item.scope?.id === scope?.id)
            .map((item) => item.room),
        ).size >= settings.lobby.maxRooms
      )
        return { ok: false as const, code: 'MATCHMAKING_FULL' };
      const entry: Entry = {
        band: definition.selection?.band,
        created: Date.now(),
        room: available ?? crypto.randomUUID(),
        key,
        name,
        token: crypto.randomUUID() + crypto.randomUUID(),
        generation: crypto.randomUUID(),
        pending: true,
        ...(scope ? { scope } : {}),
      };
      await this.ctx.storage.put(`definition:${generation(entry)}`, definition);
      const receipts =
        (await this.ctx.storage.get<Record<string, number>>(`sessions:${actorId}`)) ?? {};
      for (const [room, expires] of Object.entries(receipts))
        if (expires <= Date.now()) delete receipts[room];
      receipts[entry.room] = Date.now() + settings.lobby.sessionLifetimeMs;
      await this.ctx.storage.put(`sessions:${actorId}`, receipts);
      queue.actors[actorId] = entry;
      await this.write(queue);
      return { entry };
    });
    return 'entry' in allocated ? this.reserve(actorId, allocated.entry) : allocated;
  }

  private async reserve(actor: string, entry: Entry) {
    if (entry.revoking) {
      await this.finishRevocation(actor, entry);
      const current = (await this.read()).actors[actor];
      if (!current || generation(current) !== generation(entry))
        return { ok: false as const, code: 'STALE_REQUEST' };
      entry = current;
    }
    const definition =
      entry.pending === true
        ? await this.ctx.storage.get<MatchDefinition>(`definition:${generation(entry)}`)
        : entry.pending;
    const result = await this.room(entry.room).reserve(
      actor,
      entry.name,
      entry.token,
      definition,
      entry.scope,
      generation(entry),
    );
    return this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const current = queue.actors[actor];
      if (
        !current ||
        generation(current) !== generation(entry) ||
        current.token !== entry.token
      )
        return { ok: false as const, code: 'STALE_REQUEST' };
      // A rejected token does not prove the actor has left an active match.
      delete current.pending;
      await this.ctx.storage.delete(`definition:${generation(entry)}`);
      await this.write(queue);
      return result.ok
        ? {
            ok: true as const,
            room: entry.room,
            token: entry.token,
            expires: result.expires,
          }
        : result;
    });
  }

  async cancel(
    actorId: string,
    expectedRoom: string,
    revoke = false,
    instanceId?: string,
  ) {
    const initial = await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const entry = queue.actors[actorId];
      if (entry && (entry.room !== expectedRoom || entry.scope?.id !== instanceId))
        return { ok: false as const, code: 'STALE_ROOM' };
      if (revoke && entry && !entry.revoking) {
        entry.revoking = entry.token;
        entry.token = crypto.randomUUID() + crypto.randomUUID();
      }
      if (queue.rates[actorId]) delete queue.rates[actorId].admissionId;
      await this.write(queue);
      return { entry };
    });
    if (!('entry' in initial)) return initial;
    const entry = initial.entry;
    if (!entry) {
      if (revoke) await this.room(expectedRoom).cancelReservation(actorId, true);
      return { ok: true as const };
    }
    if (revoke) {
      await this.finishRevocation(actorId, entry);
      return { ok: true as const };
    }
    const accepted = await this.room(entry.room).cancelReservation(
      actorId,
      revoke,
      generation(entry),
      entry.token,
    );
    if (!accepted) return { ok: false as const, code: 'MATCH_STARTED' };
    return this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const current = queue.actors[actorId];
      if (current && generation(current) === generation(entry)) {
        delete queue.actors[actorId];
        await this.ctx.storage.delete(`definition:${generation(entry)}`);
      }
      await this.write(queue);
      return { ok: true as const };
    });
  }

  private async finishRevocation(actor: string, entry: Entry) {
    if (!entry.revoking) return;
    const accepted = await this.room(entry.room).cancelReservation(
      actor,
      true,
      generation(entry),
      entry.revoking,
    );
    if (!accepted) throw new Error('REVOCATION_FAILED');
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const current = queue.actors[actor];
      if (
        current &&
        generation(current) === generation(entry) &&
        current.revoking === entry.revoking
      )
        delete current.revoking;
      await this.write(queue);
    });
  }

  async logoutActor(actor: string, cookieRooms: string[] = []) {
    // Keep all logout requests for one actor ordered, including their cookie rooms.
    // Admission stays blocked until the last queued request completes.
    const previous = this.logouts.get(actor);
    const operation = (async () => {
      await previous?.catch(() => {});
      return this.logoutActorSessions(actor, cookieRooms);
    })();
    this.logouts.set(actor, operation);
    try {
      return await operation;
    } finally {
      if (this.logouts.get(actor) === operation) this.logouts.delete(actor);
    }
  }

  private async logoutActorSessions(actor: string, cookieRooms: string[]) {
    const entry = await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      queue.loggingOut ??= {};
      const alreadyLoggingOut = queue.loggingOut[actor];
      queue.loggingOut[actor] = true;
      if (queue.rates[actor]) delete queue.rates[actor].admissionId;
      const entry = queue.actors[actor];
      if (entry && !entry.revoking && !alreadyLoggingOut) {
        entry.revoking = entry.token;
        entry.token = crypto.randomUUID() + crypto.randomUUID();
      }
      await this.write(queue);
      return entry;
    });
    if (entry) await this.finishRevocation(actor, entry);
    const receipts =
      (await this.ctx.storage.get<Record<string, number>>(`sessions:${actor}`)) ?? {};
    const rooms = new Set([
      ...cookieRooms,
      ...Object.keys(receipts).filter((room) => receipts[room] > Date.now()),
    ]);
    if (entry) rooms.delete(entry.room);
    await Promise.all(
      [...rooms].map((room) => this.room(room).cancelReservation(actor, true)),
    );
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      delete queue.loggingOut?.[actor];
      await this.ctx.storage.delete(`sessions:${actor}`);
      // Retain the active room for later logout, even if no cookie reached the browser.
      if (entry)
        await this.ctx.storage.put(`sessions:${actor}`, {
          [entry.room]: Date.now() + settings.lobby.sessionLifetimeMs,
        });
      await this.write(queue);
    });
    return { ok: true as const };
  }

  async refreshWaiting(actor: string, instanceId: string) {
    await this.clean(actor, instanceId);
  }

  async refreshInstanceWaiting(instanceId: string) {
    await this.clean(undefined, instanceId);
  }

  async beginWithdrawal(actor: string, operationId: string) {
    const blocked = await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      if (queue.withdrawals?.[actor] && queue.withdrawals[actor] !== operationId)
        return true;
      queue.withdrawals ??= {};
      queue.withdrawals[actor] = operationId;
      if (queue.rates[actor]) delete queue.rates[actor].admissionId;
      await this.write(queue);
      return false;
    });
    if (blocked) return { ok: false as const, code: 'WITHDRAWAL_PENDING' };
    await this.clean(actor);
    const entry = (await this.read()).actors[actor];
    if (!entry) return { ok: true as const };
    const status = await this.status(entry.room);
    return {
      ok: false as const,
      code: status?.phase === 'WAITING' ? 'CANCEL_WAITING_FIRST' : 'MATCH_STARTED',
    };
  }

  async cancelWithdrawal(actor: string, operationId: string) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      if (queue.withdrawals?.[actor] === operationId) delete queue.withdrawals[actor];
      await this.write(queue);
    });
  }

  async anonymizeAccount(actorId: string, questionIds: string[]) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      for (const [id, entry] of Object.entries(queue.actors)) {
        if (id === actorId) entry.name = '退会ユーザー';
        if (entry.pending && entry.pending !== true)
          anonymizeDefinition(entry.pending, new Set(questionIds));
      }
      await this.write(queue);
    });
  }

  private async status(room: string) {
    let timer: number | undefined;
    try {
      return await Promise.race([
        this.room(room).lobbyStatus(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(resolve, 3000);
        }),
      ]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async alarm() {
    const queue = await this.read();
    const scopes = new Map(
      Object.values(queue.actors).flatMap((entry) =>
        entry.scope
          ? [
              [
                `${entry.scope.id}:${entry.band ?? ''}`,
                { scope: entry.scope, band: entry.band },
              ] as const,
            ]
          : [],
      ),
    );
    await Promise.all(
      [...scopes.values()].map(async ({ scope, band }) => {
        try {
          await loadMatchDefinition({
            ...this.env,
            GAME_OWNER: scope.owner,
            GAME_CONFIG_PROFILE:
              band === undefined
                ? this.env.GAME_CONFIG_PROFILE
                : `${this.env.GAME_CONFIG_PROFILE}-band-${band}`,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            ['NO_RANKED_QUESTIONS', 'RANKED_NOT_CONFIGURED'].includes(error.message)
          )
            await this.stopWaiting(scope, band);
        }
      }),
    );
    await this.clean();
  }
  private async stopWaiting(scope: InstanceScope, band?: number) {
    const queue = await this.read();
    const entries = Object.entries(queue.actors).filter(
      ([, entry]) =>
        entry.scope?.id === scope.id && (band === undefined || entry.band === band),
    );
    const rooms = [...new Set(entries.map(([, entry]) => entry.room))];
    await Promise.allSettled(rooms.map((id) => this.room(id).stopWaiting(scope.id)));
    await Promise.allSettled(
      entries.map(async ([actor, entry]) => {
        if (
          !(await this.room(entry.room).cancelReservation(
            actor,
            false,
            generation(entry),
          ))
        )
          return;
        await this.ctx.blockConcurrencyWhile(async () => {
          const current = await this.read();
          if (
            current.actors[actor] &&
            generation(current.actors[actor]) === generation(entry)
          ) {
            delete current.actors[actor];
            await this.ctx.storage.delete(`definition:${generation(entry)}`);
          }
          await this.write(current);
        });
      }),
    );
  }
  private room(id: string) {
    return this.env.GAME_ROOM.getByName(`1c:${id}`);
  }
  private async read(): Promise<Queue> {
    return (await this.ctx.storage.get<Queue>('queue')) ?? { actors: {}, rates: {} };
  }
  private async write(queue: Queue) {
    await this.ctx.storage.put('queue', queue);
    if (Object.keys(queue.actors).length || Object.keys(queue.rates).length) {
      const next = Date.now() + settings.lobby.cleanupIntervalMs;
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm <= Date.now() || alarm > next)
        await this.ctx.storage.setAlarm(next);
    } else await this.ctx.storage.deleteAlarm();
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
  private async clean(actorId?: string, instanceId?: string) {
    const snapshot = await this.read();
    if (instanceId !== undefined)
      snapshot.actors = Object.fromEntries(
        Object.entries(snapshot.actors).filter(
          ([, entry]) => (entry.scope?.id ?? '') === instanceId,
        ),
      );
    if (actorId)
      snapshot.actors = snapshot.actors[actorId]
        ? { [actorId]: snapshot.actors[actorId] }
        : {};
    const rooms = [...new Set(Object.values(snapshot.actors).map((entry) => entry.room))];
    const statuses = new Map(
      await Promise.all(
        rooms.map(async (room) => {
          try {
            return [room, await this.status(room)] as const;
          } catch {
            return [room, undefined] as const;
          }
        }),
      ),
    );
    const released: [string, Entry][] = [];
    await Promise.all(
      Object.entries(snapshot.actors).map(async ([actor, entry]) => {
        const status = statuses.get(entry.room);
        if (status === undefined) return; // Unknown is never proof of completion.
        if (
          entry.pending &&
          !status?.actors.includes(actor) &&
          Date.now() < entry.created + settings.lobby.reservationLifetimeMs
        )
          return;
        if (
          !status ||
          status.closed ||
          status.phase === 'FINISHED' ||
          status.phase === 'INVALID' ||
          !status.actors.includes(actor)
        ) {
          try {
            // Fence the generation before releasing the actor, including delayed reserve RPCs.
            if (
              await this.room(entry.room).cancelReservation(
                actor,
                false,
                generation(entry),
              )
            )
              released.push([actor, entry]);
          } catch {
            /* Keep the reservation for reconciliation. */
          }
        }
      }),
    );
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      for (const [actor, entry] of released) {
        const current = queue.actors[actor];
        if (
          current &&
          generation(current) === generation(entry) &&
          current.token === entry.token
        ) {
          delete queue.actors[actor];
          await this.ctx.storage.delete(`definition:${generation(entry)}`);
        }
      }
      for (const [id, item] of Object.entries(queue.rates))
        if (Date.now() - item.at >= settings.lobby.rateWindowMs) delete queue.rates[id];
      await this.write(queue);
    });
  }
}
