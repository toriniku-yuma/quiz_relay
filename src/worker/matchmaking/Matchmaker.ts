import { DurableObject } from 'cloudflare:workers';
import { settings } from '../../shared/settings';
import { loadMatchDefinition } from '../catalog/database';
import type { MatchDefinition, VersionRef } from '../catalog/definition';
import { contentHash } from '../catalog/hash';
import type { Env } from '../env';
import { anonymizeDefinition } from '../game/privacy';
import type { Participant } from '../rooms/database';

export type InstanceScope = { id: string; owner: string; mode?: 'casual' | 'room' };
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
  userRoom?: boolean;
  guest?: boolean;
  requestHash?: string;
  operationId?: string;
};
type Queue = {
  actors: Record<string, Entry>;
  withdrawals?: Record<string, string>;
  loggingOut?: Record<string, boolean>;
  switches?: Record<
    string,
    {
      previous: Entry;
      successor: string;
      committed: boolean;
      previousCancelled?: boolean;
    }
  >;
  rates: Record<string, { at: number; count: number; admissionId?: string }>;
};
type Admission =
  | { entry: Entry }
  | { ok: false; code: string; instanceId?: string; mode?: 'ranked' | 'casual' | 'room' };
type AdmissionReceipt = {
  hash?: string;
  generation?: string;
  expires: number;
  closed?: boolean;
  cancelling?: Entry;
};
const generation = (entry: Entry) => entry.generation ?? entry.token;

export class Matchmaker extends DurableObject<Env> {
  private logouts = new Map<string, Promise<{ ok: true }>>();
  async enter(
    actorId: string,
    name: string,
    reference?: VersionRef,
    resume = false,
    scope?: InstanceScope,
    guest = false,
    operationId?: string,
  ) {
    const requestHash = operationId
      ? await contentHash({
          name,
          reference: reference ?? null,
          scope: scope ?? null,
          guest,
        })
      : undefined;
    const allowed = await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const allowed = this.rate(queue, actorId);
      await this.write(queue);
      return allowed;
    });
    if (!allowed) return { ok: false as const, code: 'RATE_LIMIT' };
    await this.clean(actorId);
    await this.finishSwitch(actorId);
    const admissionId = crypto.randomUUID();
    const initial = await this.ctx.blockConcurrencyWhile<Admission | null>(async () => {
      const queue = await this.read();
      const entry = queue.actors[actorId];
      if (queue.withdrawals?.[actorId])
        return { ok: false as const, code: 'WITHDRAWAL_PENDING' };
      if (this.logouts.has(actorId) || queue.loggingOut?.[actorId])
        return { ok: false as const, code: 'LOGOUT_PENDING' };
      if (operationId) {
        const receipt = (
          await this.ctx.storage.get<Record<string, AdmissionReceipt>>(
            `admissions:${actorId}`,
          )
        )?.[operationId];
        if (receipt) {
          if (receipt.closed) return { ok: false, code: 'STALE_REQUEST' };
          if (receipt.hash !== requestHash)
            return { ok: false, code: 'OPERATION_CONFLICT' };
          if (!entry || generation(entry) !== receipt.generation)
            return { ok: false, code: 'STALE_REQUEST' };
          return { entry };
        }
      }
      if (entry) {
        await this.write(queue);
        if (!resume && operationId) {
          if (queue.switches?.[actorId])
            return { ok: false, code: 'MATCH_SWITCH_PENDING' };
          queue.rates[actorId].admissionId = admissionId;
          await this.write(queue);
          return null;
        }
        if (entry.scope?.id !== scope?.id || entry.scope?.mode !== scope?.mode)
          return {
            ok: false as const,
            code: 'OTHER_INSTANCE_ACTIVE',
            instanceId: entry.scope?.id,
            mode: entry.scope?.mode ?? 'ranked',
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
        scope
          ? {
              ...this.env,
              GAME_OWNER: scope.owner,
              GAME_CONFIG_PROFILE:
                scope.mode === 'casual'
                  ? `${this.env.GAME_CONFIG_PROFILE}-casual`
                  : this.env.GAME_CONFIG_PROFILE,
            }
          : this.env,
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
      scope
        ? [scope.id, scope.mode ?? 'ranked', definition.competition]
        : definition.competition,
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
      if (
        operationId &&
        (
          await this.ctx.storage.get<Record<string, AdmissionReceipt>>(
            `admissions:${actorId}`,
          )
        )?.[operationId]?.closed
      )
        return { ok: false, code: 'STALE_REQUEST' };
      if (queue.withdrawals?.[actorId])
        return { ok: false as const, code: 'WITHDRAWAL_PENDING' };
      if (this.logouts.has(actorId) || queue.loggingOut?.[actorId])
        return { ok: false as const, code: 'LOGOUT_PENDING' };
      if (Object.keys(queue.actors).length >= settings.lobby.maxRateActors)
        return { ok: false as const, code: 'MATCHMAKING_FULL' };
      if (queue.actors[actorId] && !operationId)
        return { ok: false as const, code: 'ALREADY_JOINED' };
      if (queue.switches?.[actorId]) return { ok: false, code: 'MATCH_SWITCH_PENDING' };
      if (queue.rates[actorId]?.admissionId !== admissionId)
        return { ok: false as const, code: 'STALE_REQUEST' };
      const previous = queue.actors[actorId];
      const same = Object.entries(queue.actors).filter(
        ([actor, item]) => actor !== actorId && item.key === key,
      );
      const available = same.find(([, item]) => {
        if (item.room === previous?.room) return false;
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
        guest,
        token: crypto.randomUUID() + crypto.randomUUID(),
        generation: crypto.randomUUID(),
        pending: true,
        operationId,
        requestHash,
        ...(scope ? { scope } : {}),
      };
      if (previous) {
        queue.switches ??= {};
        queue.switches[actorId] = {
          previous,
          successor: generation(entry),
          committed: false,
        };
      }
      if (operationId) {
        const operations =
          (await this.ctx.storage.get<Record<string, AdmissionReceipt>>(
            `admissions:${actorId}`,
          )) ?? {};
        for (const [id, receipt] of Object.entries(operations))
          if (receipt.expires <= Date.now() && !receipt.cancelling) delete operations[id];
        operations[operationId] = {
          hash: requestHash ?? '',
          generation: generation(entry),
          expires: Date.now() + settings.lobby.sessionLifetimeMs,
        };
        await this.ctx.storage.put(`admissions:${actorId}`, operations);
      }
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
    await this.finishSwitch(actor.id);
    const admission = await this.ctx.blockConcurrencyWhile<Admission>(async () => {
      const queue = await this.read();
      if (!this.rate(queue, actor.id)) {
        await this.write(queue);
        return { ok: false, code: 'RATE_LIMIT' };
      }
      if (queue.withdrawals?.[actor.id]) return { ok: false, code: 'WITHDRAWAL_PENDING' };
      if (this.logouts.has(actor.id) || queue.loggingOut?.[actor.id])
        return { ok: false, code: 'LOGOUT_PENDING' };
      const existing = queue.actors[actor.id];
      if (existing) {
        if (
          !existing.userRoom ||
          existing.room !== room ||
          existing.scope?.id !== scope.id
        ) {
          if (queue.switches?.[actor.id])
            return { ok: false, code: 'MATCH_SWITCH_PENDING' };
        } else {
          if (existing.pending && existing.requestHash !== hash)
            return { ok: false, code: 'OPERATION_CONFLICT' };
          return { entry: existing };
        }
      }
      const entry: Entry = {
        room,
        key: `room:${room}`,
        created: Date.now(),
        token: crypto.randomUUID() + crypto.randomUUID(),
        name: actor.name,
        generation: crypto.randomUUID(),
        scope,
        userRoom: true,
        guest: actor.guest,
        pending: true,
        requestHash: hash,
        operationId: input.operationId,
      };
      const receipts =
        (await this.ctx.storage.get<Record<string, AdmissionReceipt>>(
          `admissions:${actor.id}`,
        )) ?? {};
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
        generation: generation(entry),
        expires: Date.now() + settings.lobby.sessionLifetimeMs,
      };
      await this.ctx.storage.put(`admissions:${actor.id}`, receipts);
      if (existing) {
        queue.switches ??= {};
        queue.switches[actor.id] = {
          previous: existing,
          successor: generation(entry),
          committed: false,
        };
      }
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

  private async reserve(
    actor: string,
    entry: Entry,
    credentials?: { password: string; invite: string },
  ) {
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
    const result = await (entry.userRoom
      ? this.room(entry.room, true).joinUserRoom(
          { id: actor, name: entry.name, guest: !!entry.guest },
          entry.token,
          generation(entry),
          credentials?.password ?? '',
          credentials?.invite ?? '',
          entry.scope,
        )
      : this.room(entry.room).reserve(
          actor,
          entry.name,
          entry.token,
          definition,
          entry.scope,
          generation(entry),
          entry.guest,
        )
    ).catch(() => null);
    if (!result) return { ok: false as const, code: 'GAME_DATABASE_UNAVAILABLE' };
    if (!result.ok && entry.userRoom)
      await this.room(entry.room, true).cancelReservation(
        actor,
        false,
        generation(entry),
        entry.token,
      );
    const admitted = await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const current = queue.actors[actor];
      if (
        !current ||
        generation(current) !== generation(entry) ||
        current.token !== entry.token
      )
        return { ok: false as const, code: 'STALE_REQUEST' };
      // A rejected token does not prove the actor has left an active match.
      if (result.ok || !entry.userRoom) {
        delete current.pending;
        await this.ctx.storage.delete(`definition:${generation(entry)}`);
      }
      if (result.ok && entry.userRoom) {
        const receipts =
          (await this.ctx.storage.get<Record<string, number>>(`sessions:${actor}`)) ?? {};
        receipts[`room:${entry.room}`] = result.expires;
        await this.ctx.storage.put(`sessions:${actor}`, receipts);
      }
      if (!result.ok && entry.userRoom) delete queue.actors[actor];
      const switching = queue.switches?.[actor];
      if (switching?.successor === generation(entry)) {
        if (result.ok) switching.committed = true;
        else {
          if (switching.previousCancelled) delete queue.actors[actor];
          else queue.actors[actor] = switching.previous;
          delete queue.switches?.[actor];
        }
      }
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
    if (admitted.ok) await this.finishSwitch(actor);
    return admitted;
  }

  private async finishSwitch(actor: string) {
    const switching = (await this.read()).switches?.[actor];
    if (!switching?.committed) return;
    try {
      const previous = switching.previous;
      if (
        !(await this.room(previous.room, previous.userRoom).cancelReservation(
          actor,
          true,
          generation(previous),
          previous.revoking ?? previous.token,
          true,
        ))
      )
        return;
      await this.ctx.blockConcurrencyWhile(async () => {
        const queue = await this.read();
        if (queue.switches?.[actor]?.successor === switching.successor) {
          delete queue.switches[actor];
          await this.ctx.storage.delete(`definition:${generation(previous)}`);
        }
        await this.write(queue);
      });
    } catch {
      /* Keep the second slot until Alarm confirms the old participant has left. */
    }
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
      if (entry && (entry.room !== expectedRoom || entry.scope?.id !== instanceId))
        return { ok: false as const, code: 'STALE_ROOM' };
      if (revoke && !forfeit && entry && !entry.revoking) {
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
    if (revoke && !forfeit) {
      await this.finishRevocation(actorId, entry);
      return { ok: true as const };
    }
    const accepted = await this.room(entry.room, entry.userRoom).cancelReservation(
      actorId,
      revoke || forfeit,
      generation(entry),
      entry.token,
      forfeit,
    );
    if (!accepted) return { ok: false as const, code: 'MATCH_STARTED' };
    return this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const current = queue.actors[actorId];
      if (current && generation(current) === generation(entry)) {
        const switching = queue.switches?.[actorId];
        if (switching?.successor === generation(entry) && !switching.committed) {
          if (switching.previousCancelled) delete queue.actors[actorId];
          else queue.actors[actorId] = switching.previous;
          delete queue.switches?.[actorId];
        } else delete queue.actors[actorId];
        await this.ctx.storage.delete(`definition:${generation(entry)}`);
      }
      await this.write(queue);
      return { ok: true as const };
    });
  }

  private async finishRevocation(actor: string, entry: Entry) {
    if (!entry.revoking) return;
    const accepted = await this.room(entry.room, entry.userRoom).cancelReservation(
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

  async cancelAdmission(
    actor: string,
    operationId: string,
    instanceId?: string,
    mode?: 'casual',
  ) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const receipts =
        (await this.ctx.storage.get<Record<string, AdmissionReceipt>>(
          `admissions:${actor}`,
        )) ?? {};
      const receipt = receipts[operationId] ?? {
        expires: Date.now() + settings.lobby.sessionLifetimeMs,
      };
      const entry = [queue.actors[actor], queue.switches?.[actor]?.previous].find(
        (entry) =>
          entry?.operationId === operationId &&
          !entry.userRoom &&
          entry.scope?.id === instanceId &&
          entry.scope?.mode === mode,
      );
      if (
        entry?.operationId === operationId &&
        !entry.userRoom &&
        entry.scope?.id === instanceId &&
        entry.scope?.mode === mode &&
        (!receipt.generation || receipt.generation === generation(entry))
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
    const receipt = (
      await this.ctx.storage.get<Record<string, AdmissionReceipt>>(`admissions:${actor}`)
    )?.[operationId];
    const entry = receipt?.cancelling;
    if (!entry) return { ok: true as const };
    const accepted = await this.room(entry.room)
      .cancelReservation(actor, false, generation(entry), entry.token, false)
      .catch(() => null);
    if (accepted === null)
      return { ok: false as const, code: 'GAME_DATABASE_UNAVAILABLE' };
    await this.ctx.blockConcurrencyWhile(async () => {
      const receipts =
        (await this.ctx.storage.get<Record<string, AdmissionReceipt>>(
          `admissions:${actor}`,
        )) ?? {};
      const saved = receipts[operationId];
      if (saved?.cancelling && generation(saved.cancelling) === generation(entry))
        delete saved.cancelling;
      await this.ctx.storage.put(`admissions:${actor}`, receipts);
      const queue = await this.read();
      if (
        accepted &&
        queue.actors[actor] &&
        generation(queue.actors[actor]) === generation(entry)
      ) {
        const switching = queue.switches?.[actor];
        if (switching?.successor === generation(entry) && !switching.committed) {
          if (switching.previousCancelled) delete queue.actors[actor];
          else queue.actors[actor] = switching.previous;
          delete queue.switches?.[actor];
        } else delete queue.actors[actor];
        await this.ctx.storage.delete(`definition:${generation(entry)}`);
      }
      if (
        accepted &&
        queue.switches?.[actor] &&
        generation(queue.switches[actor].previous) === generation(entry)
      )
        queue.switches[actor].previousCancelled = true;
      await this.write(queue);
    });
    return accepted
      ? { ok: true as const }
      : {
          ok: false as const,
          code: 'MATCH_STARTED',
          room: entry.room,
          instanceId: entry.scope?.id,
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
    const { entry, previous } = await this.ctx.blockConcurrencyWhile(async () => {
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
      const previous = queue.switches?.[actor]?.previous;
      if (previous && !previous.revoking && !alreadyLoggingOut) {
        previous.revoking = previous.token;
        previous.token = crypto.randomUUID() + crypto.randomUUID();
      }
      await this.write(queue);
      return { entry, previous };
    });
    if (entry) await this.finishRevocation(actor, entry);
    if (
      previous &&
      !(await this.room(previous.room, previous.userRoom).cancelReservation(
        actor,
        true,
        generation(previous),
        previous.revoking ?? previous.token,
      ))
    )
      throw new Error('REVOCATION_FAILED');
    const receipts =
      (await this.ctx.storage.get<Record<string, number>>(`sessions:${actor}`)) ?? {};
    const rooms = new Set([
      ...cookieRooms,
      ...Object.keys(receipts).filter((room) => receipts[room] > Date.now()),
    ]);
    if (entry) rooms.delete(entry.userRoom ? `room:${entry.room}` : entry.room);
    if (previous)
      rooms.delete(previous.userRoom ? `room:${previous.room}` : previous.room);
    await Promise.all(
      [...rooms].map((room) =>
        this.room(
          room.startsWith('room:') ? room.slice(5) : room,
          room.startsWith('room:'),
        ).cancelReservation(actor, true),
      ),
    );
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      delete queue.loggingOut?.[actor];
      if (previous && queue.switches?.[actor]?.previous.token === previous.token)
        delete queue.switches[actor].previous.revoking;
      await this.ctx.storage.delete(`sessions:${actor}`);
      // Retain the active room for later logout, even if no cookie reached the browser.
      if (entry)
        await this.ctx.storage.put(`sessions:${actor}`, {
          [entry.userRoom ? `room:${entry.room}` : entry.room]:
            Date.now() + settings.lobby.sessionLifetimeMs,
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
    await this.finishSwitch(actor);
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
    if ((await this.read()).switches?.[actor])
      return { ok: false as const, code: 'MATCH_SWITCH_PENDING' };
    const entry = (await this.read()).actors[actor];
    if (!entry) return { ok: true as const };
    const status = await this.status(entry.room, entry.userRoom);
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
      const entries = [
        ...Object.entries(queue.actors),
        ...Object.entries(queue.switches ?? {}).map(
          ([id, switching]) => [id, switching.previous] as const,
        ),
      ];
      for (const [id, entry] of entries) {
        if (id === actorId) entry.name = '退会ユーザー';
        if (entry.pending === true) {
          const key = `definition:${generation(entry)}`;
          const definition = await this.ctx.storage.get<MatchDefinition>(key);
          if (definition) {
            anonymizeDefinition(definition, new Set(questionIds));
            await this.ctx.storage.put(key, definition);
          }
        } else if (entry.pending)
          anonymizeDefinition(entry.pending, new Set(questionIds));
      }
      await this.write(queue);
    });
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
    await Promise.all(
      Object.keys(queue.switches ?? {}).map((actor) => this.finishSwitch(actor)),
    );
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
    const scopes = new Map(
      Object.values(queue.actors).flatMap((entry) =>
        entry.scope && !entry.userRoom
          ? [
              [
                `${entry.scope.id}:${entry.scope.mode ?? ''}:${entry.band ?? ''}`,
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
              scope.mode === 'casual'
                ? `${this.env.GAME_CONFIG_PROFILE}-casual`
                : band === undefined
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
        entry.scope?.id === scope.id &&
        entry.scope?.mode === scope.mode &&
        !entry.userRoom &&
        (band === undefined || entry.band === band),
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
            const switching = current.switches?.[actor];
            if (switching?.successor === generation(entry) && !switching.committed) {
              if (switching.previousCancelled) delete current.actors[actor];
              else current.actors[actor] = switching.previous;
              delete current.switches?.[actor];
            } else delete current.actors[actor];
            await this.ctx.storage.delete(`definition:${generation(entry)}`);
          }
          await this.write(current);
        });
      }),
    );
  }
  private room(id: string, userRoom = false) {
    return this.env.GAME_ROOM.getByName(`${userRoom ? 'room' : '1c'}:${id}`);
  }
  private async read(): Promise<Queue> {
    return (await this.ctx.storage.get<Queue>('queue')) ?? { actors: {}, rates: {} };
  }
  private async write(queue: Queue) {
    await this.ctx.storage.put('queue', queue);
    if (
      Object.keys(queue.actors).length ||
      Object.keys(queue.rates).length ||
      Object.keys(queue.switches ?? {}).length
    ) {
      const next = Date.now() + settings.lobby.cleanupIntervalMs;
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm <= Date.now() || alarm > next)
        await this.ctx.storage.setAlarm(next);
    } else if ((await this.ctx.storage.list({ prefix: 'admissions:', limit: 1 })).size) {
      await this.ctx.storage.setAlarm(Date.now() + settings.lobby.sessionLifetimeMs);
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
              await this.room(entry.room, entry.userRoom).cancelReservation(
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
          const switching = queue.switches?.[actor];
          if (switching?.successor === generation(entry) && !switching.committed) {
            if (switching.previousCancelled) delete queue.actors[actor];
            else queue.actors[actor] = switching.previous;
            delete queue.switches?.[actor];
          } else delete queue.actors[actor];
          await this.ctx.storage.delete(`definition:${generation(entry)}`);
        }
      }
      for (const [id, item] of Object.entries(queue.rates))
        if (Date.now() - item.at >= settings.lobby.rateWindowMs) delete queue.rates[id];
      await this.write(queue);
    });
  }
}
