import { DurableObject } from 'cloudflare:workers';
import { settings } from '../../shared/settings.ts';
import { loadMatchDefinition } from '../catalog/database.ts';
import type { MatchDefinition } from '../catalog/definition.ts';
import { contentHash } from '../catalog/hash.ts';
import type { Env } from '../env.ts';
import { matchRoomName, userRoomName } from '../game/room-names.ts';
import type { Participant } from '../rooms/database.ts';
import { joinRoom, leaveRoom } from '../rooms/store.ts';

export type InstanceScope = { id: string; owner: string; mode?: 'casual' | 'room' };
type Entry = {
  band?: number;
  created: number;
  room: string;
  key: string;
  token: string;
  name: string;
  serverName?: string | null;
  pending?: true;
  revoking?: string;
  scope: InstanceScope;
  generation: string;
  userRoom?: boolean;
  guest: boolean;
  requestHash?: string;
  operationId?: string;
};
type Queue = {
  actors: Record<string, Entry>;
  loggingOut: Record<string, boolean>;
  admitting: Record<string, { id: string; expires: number; operationId?: string }>;
};
type Admission =
  | { entry: Entry }
  | {
      ok: false;
      code: string;
      instanceId?: string;
      room?: string;
      mode?: 'ranked' | 'casual' | 'room';
    };
type AdmissionReceipt = {
  hash?: string;
  generation?: string;
  expires: number;
  closed?: boolean;
  cancelling?: Entry;
};

export class Matchmaker extends DurableObject<Env> {
  private logouts = new Map<string, Promise<{ ok: true }>>();
  async enter(
    actorId: string,
    name: string,
    resume: boolean,
    scope: InstanceScope,
    guest = false,
    operationId?: string,
    serverName?: string | null,
  ) {
    const requestHash = operationId
      ? await contentHash({ name, scope, guest })
      : undefined;
    if (!(await this.admissionAllowed(actorId)))
      return { ok: false as const, code: 'RATE_LIMIT' };
    await this.clean(actorId);
    const admissionId = crypto.randomUUID();
    const initial = await this.ctx.blockConcurrencyWhile<Admission | null>(async () => {
      const queue = await this.read();
      const entry = queue.actors[actorId];
      if (this.logouts.has(actorId) || queue.loggingOut[actorId])
        return { ok: false as const, code: 'LOGOUT_PENDING' };
      if (operationId) {
        const receipt = (await this.admissionReceipts(actorId))?.[operationId];
        if (receipt) {
          if (receipt.closed) return { ok: false, code: 'STALE_REQUEST' };
          if (receipt.hash !== requestHash)
            return { ok: false, code: 'OPERATION_CONFLICT' };
          if (!entry || entry.generation !== receipt.generation)
            return { ok: false, code: 'STALE_REQUEST' };
          return { entry };
        }
      }
      if (entry) {
        await this.write(queue);
        if (entry.scope.id !== scope.id || entry.scope.mode !== scope.mode)
          return {
            ok: false as const,
            code: 'OTHER_INSTANCE_ACTIVE',
            instanceId: entry.scope.id,
            room: entry.room,
            mode: entry.scope.mode ?? 'ranked',
          };
        if (!resume)
          return {
            ok: false as const,
            code: 'ALREADY_JOINED',
            instanceId: entry.scope.id,
            room: entry.room,
            mode: entry.scope.mode ?? 'ranked',
          };
        return { entry };
      }
      if (resume) {
        await this.write(queue);
        return { ok: false as const, code: 'NO_ACTIVE_MATCH' };
      }
      if (queue.admitting[actorId]?.expires > Date.now())
        return { ok: false, code: 'ALREADY_JOINED' };
      queue.admitting[actorId] = {
        id: admissionId,
        operationId,
        expires: Date.now() + settings.lobby.reservationLifetimeMs,
      };
      await this.write(queue);
      return null;
    });
    if (initial)
      return 'entry' in initial ? this.reserve(actorId, initial.entry) : initial;

    try {
      let definition: MatchDefinition;
      try {
        definition = await loadMatchDefinition(
          this.env,
          {
            owner: scope.owner,
            profile:
              scope.mode === 'casual'
                ? `${this.env.GAME_CONFIG_PROFILE}-casual`
                : this.env.GAME_CONFIG_PROFILE,
          },
          actorId,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          ['NO_RANKED_QUESTIONS', 'RANKED_NOT_CONFIGURED'].includes(error.message)
        ) {
          await this.stopWaiting(scope, (error as Error & { band?: number }).band);
          return { ok: false as const, code: error.message };
        }
        return { ok: false as const, code: 'GAME_DATABASE_UNAVAILABLE' };
      }
      if (definition.competition.owner !== scope.owner)
        return { ok: false as const, code: 'INSTANCE_MISMATCH' };
      const key = JSON.stringify([
        scope.id,
        scope.mode ?? 'ranked',
        definition.competition,
      ]);
      if (
        new Set(
          Object.values((await this.read()).actors)
            .filter((entry) => entry.scope.id === scope.id)
            .map((entry) => entry.room),
        ).size >= settings.lobby.maxRooms
      )
        await this.clean(undefined, scope.id);
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
        if (operationId && (await this.admissionReceipts(actorId))?.[operationId]?.closed)
          return { ok: false, code: 'STALE_REQUEST' };
        if (this.logouts.has(actorId) || queue.loggingOut[actorId])
          return { ok: false as const, code: 'LOGOUT_PENDING' };
        if (queue.actors[actorId]) return { ok: false as const, code: 'ALREADY_JOINED' };
        if (
          queue.admitting[actorId]?.id !== admissionId ||
          queue.admitting[actorId].expires <= Date.now()
        )
          return { ok: false as const, code: 'STALE_REQUEST' };
        const same = Object.entries(queue.actors).filter(
          ([actor, item]) => actor !== actorId && item.key === key,
        );
        const available = same.find(([, item]) => {
          const status = statuses.get(item.room);
          const pendingRoom = item.pending && !statuses.has(item.room);
          return (
            (pendingRoom || (status && !status.closed && status.phase === 'WAITING')) &&
            same.filter(
              ([actor, other]) =>
                other.room === item.room &&
                (!status ||
                  status.actors.includes(actor) ||
                  snapshot.actors[actor]?.token !== other.token),
            ).length < definition.playersPerMatch
          );
        })?.[1].room;
        if (
          !available &&
          new Set(
            Object.values(queue.actors)
              .filter((item) => item.scope.id === scope.id)
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
          serverName,
          guest,
          token: crypto.randomUUID() + crypto.randomUUID(),
          generation: crypto.randomUUID(),
          pending: true,
          operationId,
          requestHash,
          scope,
        };
        if (operationId) {
          const operations = await this.admissionReceipts(actorId);
          for (const [id, receipt] of Object.entries(operations))
            if (receipt.expires <= Date.now() && !receipt.cancelling)
              delete operations[id];
          operations[operationId] = {
            hash: requestHash ?? '',
            generation: entry.generation,
            expires: Date.now() + settings.lobby.sessionLifetimeMs,
          };
          await this.ctx.storage.put(`admissions:${actorId}`, operations);
        }
        await this.ctx.storage.put(`definition:${entry.generation}`, definition);

        delete queue.admitting[actorId];
        queue.actors[actorId] = entry;
        await this.write(queue);
        return { entry };
      });
      return 'entry' in allocated ? this.reserve(actorId, allocated.entry) : allocated;
    } finally {
      await this.ctx.blockConcurrencyWhile(async () => {
        const queue = await this.read();
        if (queue.admitting[actorId]?.id !== admissionId) return;
        delete queue.admitting[actorId];
        await this.write(queue);
      });
    }
  }

  async matchFinished(matchId: string) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      for (const [actor, entry] of Object.entries(queue.actors)) {
        if (entry.userRoom || entry.room !== matchId) continue;
        delete queue.actors[actor];
        await this.ctx.storage.delete(`definition:${entry.generation}`);
      }
      await this.write(queue);
    });
  }

  async enterRoom(
    actor: Participant,
    room: string,
    scope: InstanceScope,
    input: { operationId: string; password: string; invite: string },
    creation?: Record<string, unknown>,
  ) {
    const hash = await contentHash({
      room,
      scope,
      input,
      ...(creation ? { creation } : {}),
    });
    await this.clean(actor.id);
    if (!(await this.admissionAllowed(actor.id)))
      return { ok: false as const, code: 'RATE_LIMIT' };
    const admission = await this.ctx.blockConcurrencyWhile<Admission>(async () => {
      const queue = await this.read();
      if (this.logouts.has(actor.id) || queue.loggingOut[actor.id])
        return { ok: false, code: 'LOGOUT_PENDING' };
      const existing = queue.actors[actor.id];
      if (existing) {
        if (
          !existing.userRoom ||
          existing.room !== room ||
          existing.scope.id !== scope.id
        ) {
          return {
            ok: false,
            code: 'OTHER_INSTANCE_ACTIVE',
            instanceId: existing.scope.id,
            room: existing.room,
            mode: existing.scope.mode ?? 'ranked',
          };
        } else {
          if (existing.operationId !== input.operationId)
            return {
              ok: false,
              code: 'ALREADY_JOINED',
              room: existing.room,
              instanceId: existing.scope.id,
              mode: 'room',
            };
          if (existing.pending && existing.requestHash !== hash)
            return { ok: false, code: 'OPERATION_CONFLICT' };
          return { entry: existing };
        }
      }
      if (queue.admitting[actor.id]?.expires > Date.now())
        return { ok: false, code: 'ALREADY_JOINED' };
      const entry: Entry = {
        room,
        key: `room:${room}`,
        created: Date.now(),
        token: crypto.randomUUID() + crypto.randomUUID(),
        name: actor.name,
        serverName: actor.serverName,
        generation: crypto.randomUUID(),
        scope,
        userRoom: true,
        guest: actor.guest,
        pending: true,
        requestHash: hash,
        operationId: input.operationId,
      };
      const receipts = await this.admissionReceipts(actor.id);
      const receipt = receipts[input.operationId];
      if (receipt)
        return {
          ok: false,
          code: receipt.hash !== hash ? 'OPERATION_CONFLICT' : 'STALE_REQUEST',
        };
      for (const [id, receipt] of Object.entries(receipts))
        if (receipt.expires <= Date.now() && !receipt.cancelling) delete receipts[id];
      receipts[input.operationId] = {
        hash,
        generation: entry.generation,
        expires: Date.now() + settings.lobby.sessionLifetimeMs,
      };
      await this.ctx.storage.put(`admissions:${actor.id}`, receipts);
      queue.actors[actor.id] = entry;
      await this.write(queue);
      return { entry };
    });
    if (!('entry' in admission)) return admission;
    if (creation) {
      const lobby = this.room(room, true);
      const created = await lobby.createUserRoom(room, scope, actor, creation);
      if (!created.ok) {
        await this.cancel(actor.id, room, false, scope.id);
        return { ok: false as const, code: created.code, status: created.status };
      }
      input = { ...input, invite: await lobby.createdRoomInvite(actor.id) };
    }
    return this.reserve(actor.id, admission.entry, input);
  }

  async resumeRoom(actor: string, room: string, instanceId: string) {
    const entry = (await this.read()).actors[actor];
    if (!entry?.userRoom || entry.room !== room || entry.scope.id !== instanceId)
      return { ok: false as const, code: 'STALE_RESERVATION' };
    return this.reserve(actor, entry);
  }

  private async reserve(
    actor: string,
    entry: Entry,
    credentials?: { password: string; invite: string },
  ) {
    if (entry.revoking) {
      await this.finishRevocation(actor, entry);
      const current = (await this.read()).actors[actor];
      if (!current || current.generation !== entry.generation)
        return { ok: false as const, code: 'STALE_REQUEST' };
      entry = current;
    }
    const definition =
      entry.pending && !entry.userRoom
        ? await this.ctx.storage.get<MatchDefinition>(`definition:${entry.generation}`)
        : undefined;
    if (entry.pending && !entry.userRoom && !definition)
      throw new Error('MATCH_DEFINITION_REQUIRED');
    const result = await (entry.userRoom
      ? joinRoom(
          this.env,
          entry.room,
          {
            id: actor,
            name: entry.name,
            serverName: entry.serverName,
            guest: entry.guest,
          },
          entry.token,
          entry.generation,
          credentials?.password ?? '',
          credentials?.invite ?? '',
          entry.scope,
        )
      : this.room(entry.room).reserve(
          entry.room,
          actor,
          entry.name,
          entry.token,
          definition,
          entry.scope,
          entry.generation,
          entry.guest,
          entry.serverName,
        )
    ).catch(() => null);
    if (!result || (!result.ok && result.code === 'GAME_DATABASE_UNAVAILABLE'))
      return { ok: false as const, code: 'GAME_DATABASE_UNAVAILABLE' };
    if (!result.ok && entry.userRoom)
      await this.room(entry.room, true).cancelReservation(
        'room',
        actor,
        false,
        entry.generation,
        entry.token,
      );
    const admitted = await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const current = queue.actors[actor];
      if (
        !current ||
        current.generation !== entry.generation ||
        current.token !== entry.token
      )
        return { ok: false as const, code: 'STALE_REQUEST' };
      // A rejected token does not prove the actor has left an active match.
      if (result.ok || !entry.userRoom) {
        delete current.pending;
        await this.ctx.storage.delete(`definition:${entry.generation}`);
      }
      if (!result.ok && entry.userRoom) delete queue.actors[actor];
      await this.write(queue);
      return result.ok
        ? {
            ok: true as const,
            room: entry.room,
            operationId: entry.operationId,
            token: entry.token,
            expires: result.expires,
          }
        : result;
    });
    if (!admitted.ok && result.ok && entry.userRoom)
      await leaveRoom(this.env, entry.room, actor, entry.generation);
    return admitted;
  }

  async cancel(
    actorId: string,
    expectedRoom: string,
    revoke = false,
    instanceId?: string,
    forfeit = false,
  ) {
    const initial = await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const entry = queue.actors[actorId];
      if (entry && (entry.room !== expectedRoom || entry.scope.id !== instanceId))
        return { ok: false as const, code: 'STALE_ROOM' };
      if (revoke && !forfeit && entry && !entry.revoking) {
        entry.revoking = entry.token;
        entry.token = crypto.randomUUID() + crypto.randomUUID();
      }
      delete queue.admitting[actorId];
      await this.write(queue);
      return { entry };
    });
    if (!('entry' in initial)) return initial;
    const entry = initial.entry;
    if (!entry) {
      if (
        revoke &&
        !(await this.room(expectedRoom).cancelReservation('match', actorId, true))
      )
        throw new Error('REVOCATION_FAILED');
      return { ok: true as const };
    }
    if (revoke && !forfeit) {
      await this.finishRevocation(actorId, entry);
      return { ok: true as const };
    }
    const accepted = await this.room(entry.room, entry.userRoom).cancelReservation(
      entry.userRoom ? 'room' : 'match',
      actorId,
      revoke || forfeit,
      entry.generation,
      entry.token,
      forfeit,
    );
    if (!accepted) return { ok: false as const, code: 'MATCH_STARTED' };
    return this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const current = queue.actors[actorId];
      if (current && current.generation === entry.generation) {
        delete queue.actors[actorId];
        await this.ctx.storage.delete(`definition:${entry.generation}`);
      }
      await this.write(queue);
      return { ok: true as const };
    });
  }

  private async finishRevocation(actor: string, entry: Entry) {
    if (!entry.revoking) return;
    const accepted = await this.room(entry.room, entry.userRoom).cancelReservation(
      entry.userRoom ? 'room' : 'match',
      actor,
      true,
      entry.generation,
      entry.revoking,
    );
    if (!accepted) throw new Error('REVOCATION_FAILED');
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const current = queue.actors[actor];
      if (
        current &&
        current.generation === entry.generation &&
        current.revoking === entry.revoking
      )
        delete current.revoking;
      await this.write(queue);
    });
  }

  async cancelAdmission(
    actor: string,
    operationId: string,
    instanceId?: string,
    mode?: 'casual' | 'room',
  ) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      if (queue.admitting[actor]?.operationId === operationId)
        delete queue.admitting[actor];
      const receipts = await this.admissionReceipts(actor);
      const receipt = receipts[operationId] ?? {
        expires: Date.now() + settings.lobby.sessionLifetimeMs,
      };
      const entry = [queue.actors[actor]].find(
        (entry) =>
          entry?.operationId === operationId &&
          !!entry.userRoom === (mode === 'room') &&
          entry.scope.id === instanceId &&
          entry.scope.mode === mode,
      );
      if (
        entry?.operationId === operationId &&
        !!entry.userRoom === (mode === 'room') &&
        entry.scope.id === instanceId &&
        entry.scope.mode === mode &&
        (!receipt.generation || receipt.generation === entry.generation)
      )
        receipt.cancelling = entry;
      receipt.closed = true;
      receipts[operationId] = receipt;
      await this.ctx.storage.put(`admissions:${actor}`, receipts);
      await this.write(queue);
    });
    return this.finishWaitingCancel(actor, operationId);
  }

  private async finishWaitingCancel(actor: string, operationId: string) {
    const receipt = (await this.admissionReceipts(actor))?.[operationId];
    const entry = receipt?.cancelling;
    if (!entry) return { ok: true as const };
    const accepted = await this.room(entry.room, entry.userRoom)
      .cancelReservation(
        entry.userRoom ? 'room' : 'match',
        actor,
        false,
        entry.generation,
        entry.token,
        false,
      )
      .catch(() => null);
    if (accepted === null)
      return { ok: false as const, code: 'GAME_DATABASE_UNAVAILABLE' };
    await this.ctx.blockConcurrencyWhile(async () => {
      const receipts = await this.admissionReceipts(actor);
      const saved = receipts[operationId];
      if (saved?.cancelling && saved.cancelling.generation === entry.generation)
        delete saved.cancelling;
      await this.ctx.storage.put(`admissions:${actor}`, receipts);
      const queue = await this.read();
      if (
        accepted &&
        queue.actors[actor] &&
        queue.actors[actor].generation === entry.generation
      ) {
        delete queue.actors[actor];
        await this.ctx.storage.delete(`definition:${entry.generation}`);
      }
      await this.write(queue);
    });
    return accepted
      ? { ok: true as const }
      : {
          ok: false as const,
          code: 'MATCH_STARTED',
          room: entry.room,
          instanceId: entry.scope.id,
        };
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
    const { entry } = await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const alreadyLoggingOut = queue.loggingOut[actor];
      queue.loggingOut[actor] = true;
      delete queue.admitting[actor];
      const entry = queue.actors[actor];
      if (entry && !entry.revoking && !alreadyLoggingOut) {
        entry.revoking = entry.token;
        entry.token = crypto.randomUUID() + crypto.randomUUID();
      }
      await this.write(queue);
      return { entry };
    });
    if (entry) await this.finishRevocation(actor, entry);
    const rooms = new Set(cookieRooms);
    if (entry) rooms.delete(entry.userRoom ? `room:${entry.room}` : entry.room);
    await Promise.all(
      [...rooms].map(async (room) => {
        const accepted = await this.room(
          room.startsWith('room:') ? room.slice(5) : room,
          room.startsWith('room:'),
        ).cancelReservation(room.startsWith('room:') ? 'room' : 'match', actor, true);
        if (!accepted) throw new Error('REVOCATION_FAILED');
      }),
    );
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      delete queue.loggingOut[actor];
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

  private async status(room: string, userRoom = false) {
    let timer: number | undefined;
    try {
      return await Promise.race([
        this.room(room, userRoom).lobbyStatus(),
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
    const operations = await this.ctx.storage.list<Record<string, AdmissionReceipt>>({
      prefix: 'admissions:',
    });
    for (const [key, receipts] of operations) {
      for (const [id, receipt] of Object.entries(receipts))
        if (receipt.cancelling)
          await this.finishWaitingCancel(key.slice('admissions:'.length), id).catch(
            () => {},
          );
      await this.ctx.blockConcurrencyWhile(async () => {
        const current =
          (await this.ctx.storage.get<Record<string, AdmissionReceipt>>(key)) ?? {};
        for (const [id, receipt] of Object.entries(current))
          if (receipt.expires <= Date.now() && !receipt.cancelling) delete current[id];
        if (Object.keys(current).length) await this.ctx.storage.put(key, current);
        else await this.ctx.storage.delete(key);
      });
    }
    for (const [actor, entry] of Object.entries(queue.actors)) {
      if (
        !entry.pending ||
        entry.created + settings.lobby.reservationLifetimeMs > Date.now()
      )
        continue;
      await this.cancel(actor, entry.room, false, entry.scope.id).catch(() => {});
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.read();
      for (const [actor, admission] of Object.entries(current.admitting))
        if (admission.expires <= Date.now()) delete current.admitting[actor];
      await this.write(current);
    });
  }

  private async stopWaiting(scope: InstanceScope, band?: number) {
    const queue = await this.read();
    const entries = Object.entries(queue.actors).filter(
      ([, entry]) =>
        entry.scope.id === scope.id &&
        entry.scope.mode === scope.mode &&
        !entry.userRoom &&
        (band === undefined || entry.band === band),
    );
    const rooms = [...new Set(entries.map(([, entry]) => entry.room))];
    await Promise.allSettled(rooms.map((id) => this.room(id).stopWaiting(scope.id)));
    await Promise.allSettled(
      entries.map(async ([actor, entry]) => {
        if (
          !(await this.room(entry.room).cancelReservation(
            'match',
            actor,
            false,
            entry.generation,
          ))
        )
          return;
        await this.ctx.blockConcurrencyWhile(async () => {
          const current = await this.read();
          if (
            current.actors[actor] &&
            current.actors[actor].generation === entry.generation
          ) {
            delete current.actors[actor];
            await this.ctx.storage.delete(`definition:${entry.generation}`);
          }
          await this.write(current);
        });
      }),
    );
  }
  private room(id: string, userRoom = false) {
    return this.env.GAME_ROOM.getByName(userRoom ? userRoomName(id) : matchRoomName(id));
  }
  private async read(): Promise<Queue> {
    return (
      (await this.ctx.storage.get<Queue>('queue')) ?? {
        actors: {},
        loggingOut: {},
        admitting: {},
      }
    );
  }
  private async write(queue: Queue) {
    await this.ctx.storage.put('queue', queue);
    const deadlines = Object.values(queue.admitting).map((item) => item.expires);
    for (const entry of Object.values(queue.actors))
      if (entry.pending)
        deadlines.push(entry.created + settings.lobby.reservationLifetimeMs);
    const receipts = await this.ctx.storage.list<Record<string, AdmissionReceipt>>({
      prefix: 'admissions:',
    });
    for (const operations of receipts.values())
      for (const receipt of Object.values(operations))
        deadlines.push(
          receipt.cancelling
            ? Date.now() + settings.results.retryIntervalMs
            : receipt.expires,
        );
    if (deadlines.length)
      await this.ctx.storage.setAlarm(
        Math.min(...deadlines) <= Date.now()
          ? Date.now() + settings.results.retryIntervalMs
          : Math.min(...deadlines),
      );
    else await this.ctx.storage.deleteAlarm();
  }

  private async admissionReceipts(actor: string) {
    const key = `admissions:${actor}`;
    const receipts =
      (await this.ctx.storage.get<Record<string, AdmissionReceipt>>(key)) ?? {};
    let expired = false;
    for (const [id, receipt] of Object.entries(receipts)) {
      if (receipt.expires > Date.now() || receipt.cancelling) continue;
      delete receipts[id];
      expired = true;
    }
    if (expired) {
      if (Object.keys(receipts).length) await this.ctx.storage.put(key, receipts);
      else await this.ctx.storage.delete(key);
    }
    return receipts;
  }
  private async admissionAllowed(actor: string) {
    if (!this.env.ADMISSION_LIMITER) throw new Error('RATE_LIMITER_NOT_CONFIGURED');
    return (await this.env.ADMISSION_LIMITER.limit({ key: actor })).success;
  }
  private async clean(actorId?: string, instanceId?: string) {
    const snapshot = await this.read();
    if (instanceId !== undefined)
      snapshot.actors = Object.fromEntries(
        Object.entries(snapshot.actors).filter(
          ([, entry]) => entry.scope.id === instanceId,
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
            return [
              room,
              await this.status(
                room,
                Object.values(snapshot.actors).find((entry) => entry.room === room)
                  ?.userRoom,
              ),
            ] as const;
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
        if (status?.phase === 'FINISHED' || status?.phase === 'INVALID') return; // D1 completion is acknowledged by matchFinished.
        if (
          entry.pending &&
          !status?.actors.includes(actor) &&
          Date.now() < entry.created + settings.lobby.reservationLifetimeMs
        )
          return;
        if (!status || status.closed || !status.actors.includes(actor)) {
          try {
            // Fence the generation before releasing the actor, including delayed reserve RPCs.
            if (
              await this.room(entry.room, entry.userRoom).cancelReservation(
                entry.userRoom ? 'room' : 'match',
                actor,
                false,
                entry.generation,
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
          current.generation === entry.generation &&
          current.token === entry.token
        ) {
          delete queue.actors[actor];
          await this.ctx.storage.delete(`definition:${entry.generation}`);
        }
      }
      for (const [id, item] of Object.entries(queue.admitting))
        if (item.expires <= Date.now()) delete queue.admitting[id];
      await this.write(queue);
    });
  }
}
