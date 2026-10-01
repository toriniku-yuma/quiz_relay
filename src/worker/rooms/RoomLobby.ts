import type { Snapshot } from '../../shared/game';
import type {
  BroughtQuestion,
  RoomMember,
  RoomSettings,
  RoomView,
} from '../../shared/rooms';
import { validateBroughtSet, validateRoomSettings } from '../../shared/rooms';
import { settings as runtime } from '../../shared/settings';
import { type MatchDefinition, validateDefinition } from '../catalog/definition';
import { contentHash } from '../catalog/hash';
import type { Env } from '../env';
import { deleteStored, readStored, writeStored } from '../game/storage';
import type { InstanceScope } from '../matchmaking/Matchmaker';
import { OrganizationError, validId } from '../organization/access';
import { allowedInstanceActors } from '../organization/database';
import { registerInstanceRoom } from '../organization/rooms';
import { type Participant, publishRoom, roomDefinition } from './database';

type Member = RoomMember & {
  token: string;
  generation: string;
  expires: number;
  inLobby: boolean;
};
export type UserRoom = {
  createdAt: number;
  id: string;
  scope: InstanceScope;
  settings: RoomSettings;
  hostId: string;
  revision: number;
  password?: { salt: string; hash: string };
  invite: string;
  original: BroughtQuestion[];
  sourceOwner: string;
  sourceId: string;
  originalExpires: number;
  playing: boolean;
  members: Member[];
  closed: boolean;
  emptySince?: number;
  childSessionExpires?: number;
  match?: { id: string; actors: string[]; tokens: Record<string, string> };
  starting?: { operationId: string; hash: string; revision: number; id: string };
};
type Attachment = { actorId: string; live: boolean; lastSeen: number };
type ChildSession = {
  actor: string;
  room: string;
  token: string;
  parentToken: string;
  generation: string;
  expires: number;
};
type PreparedStart = {
  actor: string;
  hash: string;
  id: string;
  definition: MatchDefinition;
  tokens: Record<string, string>;
  members: (Participant & { role?: 'presenter' })[];
};
const secret = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          hash: 'SHA-256',
          salt: new TextEncoder().encode(salt),
          iterations: 100000,
        },
        key,
        256,
      ),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}

// Each match uses its own GameRoom. A new match never replaces the previous match's original or retry alarm.
export class RoomLobby {
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}
  private async atomic<T>(operation: () => Promise<T>): Promise<T> {
    // Expected admission errors must not reset the Durable Object and disconnect the whole lobby.
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        return { value: await operation() };
      } catch (error) {
        if (error instanceof OrganizationError) return { error };
        throw error;
      }
    });
    if ('error' in result) throw result.error;
    return result.value;
  }
  private child(id: string) {
    return this.env.GAME_ROOM.getByName(`1c:${id}`);
  }
  async read() {
    return readStored<UserRoom>(this.ctx.storage, 'user-room');
  }
  async create(
    id: string,
    scope: InstanceScope,
    actor: Participant,
    input: Record<string, unknown>,
  ) {
    if (actor.guest) throw new OrganizationError('LOGIN_REQUIRED');
    const hash = await contentHash(input),
      configuration = validateRoomSettings(input.settings);
    const original =
      configuration.source === 'original' ? validateBroughtSet(input.questions) : [];
    const password = typeof input.password === 'string' ? input.password : '';
    if (password.length > 128) throw new OrganizationError('INVALID_PASSWORD', 400);
    const salt = secret(),
      encrypted = password
        ? { salt, hash: await passwordHash(password, salt) }
        : undefined;
    await registerInstanceRoom(this.env, scope, this.ctx.id.toString(), false);
    await this.atomic(async () => {
      if (await this.ctx.storage.get('instanceDeleted'))
        throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
      const previous = await this.ctx.storage.get<{ actor: string; hash: string }>(
        'creation',
      );
      if (previous) {
        if (previous.actor !== actor.id || previous.hash !== hash)
          throw new OrganizationError('OPERATION_CONFLICT', 409);
        return;
      }
      const room: UserRoom = {
        createdAt: Date.now(),
        id,
        scope,
        settings: configuration,
        hostId: actor.id,
        revision: 0,
        password: encrypted,
        invite: secret(),
        original,
        sourceOwner: actor.id,
        sourceId: crypto.randomUUID(),
        originalExpires: Date.now() + 30 * 86400000,
        playing: false,
        members: [],
        closed: false,
        emptySince: Date.now(),
      };
      await this.save(room, { creation: { actor: actor.id, hash, invite: room.invite } });
    });
    await this.directory();
    return { ok: true as const, room: id };
  }
  async join(
    actor: Participant,
    token: string,
    generation: string,
    password: string,
    invite: string,
    scope?: InstanceScope,
  ) {
    const initial = await this.read();
    if (!initial || initial.closed) return { ok: false as const, code: 'ROOM_CLOSED' };
    if (
      scope?.id !== initial.scope.id ||
      scope.owner !== initial.scope.owner ||
      scope.mode !== 'room'
    )
      return { ok: false as const, code: 'INSTANCE_MISMATCH' };
    const existing = initial.members.some((m) => m.id === actor.id);
    if (!existing && !initial.settings.public && invite !== initial.invite)
      return { ok: false as const, code: 'INVITE_REQUIRED' };
    if (
      !existing &&
      initial.password &&
      (await passwordHash(password, initial.password.salt)) !== initial.password.hash
    )
      return { ok: false as const, code: 'PASSWORD_INCORRECT' };
    const allowed = await allowedInstanceActors(this.env, initial.scope, [actor.id]);
    if (
      !existing &&
      (!allowed.includes(actor.id) || (actor.guest && !initial.settings.guests))
    )
      return { ok: false as const, code: 'PARTICIPATION_RESTRICTED' };
    return this.atomic(async () => {
      const room = await this.read();
      if (
        !room ||
        room.closed ||
        room.revision !== initial.revision ||
        (await this.ctx.storage.get(`closed:${generation}`))
      )
        return { ok: false as const, code: 'STALE_RESERVATION' };
      const member = room.members.find((m) => m.id === actor.id);
      if (member) {
        if (member.generation !== generation || member.token !== token)
          return { ok: false as const, code: 'STALE_RESERVATION' };
        return { ok: true as const, expires: member.expires };
      }
      if (room.starting) return { ok: false as const, code: 'START_PENDING' };
      if (
        room.members.length >=
        room.settings.capacity + (room.settings.presenter ? 1 : 0)
      )
        return { ok: false as const, code: 'ROOM_FULL' };
      const expires = Date.now() + runtime.lobby.sessionLifetimeMs;
      room.members.push({
        ...actor,
        id: actor.id,
        ready: false,
        joinedAt: Date.now(),
        connected: false,
        token,
        generation,
        expires,
        inLobby: true,
      });
      this.sweep(room);
      await this.save(room);
      this.broadcast(room);
      return { ok: true as const, expires };
    });
  }
  async info(invite = '') {
    const room = await this.read();
    if (!room || room.closed || (!room.settings.public && invite !== room.invite))
      throw new OrganizationError('ROOM_NOT_FOUND', 404);
    const status = room.match ? await this.child(room.match.id).lobbyStatus() : null;
    return {
      ...this.view(room, '', this.isPlaying(status)),
      members: [],
      memberCount: room.members.length,
    };
  }
  async viewFor(actor: string, token?: string) {
    const room = await this.read();
    if (
      !room?.members.some(
        (m) => m.id === actor && (!token || m.token === token) && m.expires > Date.now(),
      )
    )
      throw new OrganizationError('ROOM_NOT_FOUND', 404);
    const status = room.match ? await this.child(room.match.id).lobbyStatus() : null;
    return this.view(room, actor, this.isPlaying(status));
  }
  async originals(actor: string) {
    const room = await this.read();
    if (!room || room.sourceOwner !== actor || !room.members.some((m) => m.id === actor))
      throw new OrganizationError('AUTHOR_REQUIRED');
    return { questions: room.original };
  }
  async mutate(actor: Participant, input: Record<string, unknown>) {
    const operationId = validId(input.operationId),
      hash = await contentHash(input);
    if (input.action === 'start') return this.start(actor, input, operationId, hash);
    await this.status();
    const snapshot = await this.read();
    if (!snapshot) throw new OrganizationError('ROOM_NOT_FOUND', 404);
    const allowed = await allowedInstanceActors(this.env, snapshot.scope, [actor.id]);
    const password = typeof input.password === 'string' ? input.password : undefined;
    if (password !== undefined && password.length > 128)
      throw new OrganizationError('INVALID_PASSWORD', 400);
    const salt = secret(),
      encrypted = password
        ? { salt, hash: await passwordHash(password, salt) }
        : undefined;
    const result = await this.atomic(async () => {
      const prior = await this.ctx.storage.get<{
        actor: string;
        hash: string;
        result: { ok: true };
      }>(`operation:${operationId}`);
      if (prior) {
        if (prior.actor !== actor.id || prior.hash !== hash)
          throw new OrganizationError('OPERATION_CONFLICT', 409);
        return prior.result;
      }
      const room = await this.read(),
        member = room?.members.find((m) => m.id === actor.id);
      if (!room || !member || room.closed)
        throw new OrganizationError('ROOM_NOT_FOUND', 404);
      if (room.starting) throw new OrganizationError('START_PENDING', 409);
      if (input.action === 'ready') {
        if (
          !member.inLobby ||
          !allowed.includes(actor.id) ||
          (actor.guest && !room.settings.guests)
        )
          throw new OrganizationError('PARTICIPATION_RESTRICTED', 409);
        if (typeof input.ready !== 'boolean')
          throw new OrganizationError('INVALID_SETUP', 400);
        member.ready = input.ready;
      } else if (input.action === 'return') {
        if (room.playing) throw new OrganizationError('MATCH_STARTED', 409);
        member.inLobby = true;
      } else {
        if (room.hostId !== actor.id) throw new OrganizationError('ROOM_HOST_REQUIRED');
        if (input.revision !== room.revision)
          throw new OrganizationError('EDIT_CONFLICT', 409);
        if (input.action === 'settings') {
          const next = validateRoomSettings(input.settings);
          if (room.members.length > next.capacity + (next.presenter ? 1 : 0))
            throw new OrganizationError('ROOM_FULL', 409);
          if (actor.guest && input.questions !== undefined)
            throw new OrganizationError('LOGIN_REQUIRED');
          if (next.source === 'original' && input.questions !== undefined) {
            room.original = validateBroughtSet(input.questions);
            room.sourceOwner = actor.id;
            room.sourceId = crypto.randomUUID();
            room.originalExpires = Date.now() + 30 * 86400000;
          }
          if (next.source === 'original' && !room.original.length)
            throw new OrganizationError('NO_ROOM_QUESTIONS', 409);
          room.settings = next;
          if (password !== undefined) room.password = encrypted;
          room.revision++;
          this.unready(room);
        } else if (input.action === 'invite') {
          room.invite = secret();
          room.revision++;
        } else if (input.action === 'close') {
          room.closed = true;
          room.revision++;
        } else throw new OrganizationError('INVALID_OPERATION', 400);
      }
      await this.save(room, {
        [`operation:${operationId}`]: { actor: actor.id, hash, result: { ok: true } },
      });
      this.broadcast(room);
      return { ok: true as const };
    });
    await this.directory();
    return result;
  }
  private async start(
    actor: Participant,
    input: Record<string, unknown>,
    operationId: string,
    hash: string,
  ) {
    const recovery = await readStored<PreparedStart>(
      this.ctx.storage,
      `start:${operationId}`,
    );
    if (recovery) {
      if (recovery.actor !== actor.id || recovery.hash !== hash)
        throw new OrganizationError('OPERATION_CONFLICT', 409);
      return this.finishStart(recovery, operationId);
    }
    const prepared = await this.atomic(async () => {
      const previous = await this.ctx.storage.get<{
        actor: string;
        hash: string;
        result: { ok: true; room: string };
      }>(`operation:${operationId}`);
      if (previous) {
        if (previous.actor !== actor.id || previous.hash !== hash)
          throw new OrganizationError('OPERATION_CONFLICT', 409);
        return { previous: previous.result };
      }
      const room = await this.read();
      if (!room || room.closed || room.hostId !== actor.id)
        throw new OrganizationError('ROOM_HOST_REQUIRED');
      this.sweep(room);
      if (input.revision !== room.revision)
        throw new OrganizationError('EDIT_CONFLICT', 409);
      if (
        room.starting &&
        (room.starting.operationId !== operationId || room.starting.hash !== hash)
      )
        throw new OrganizationError('START_PENDING', 409);
      const answerers = room.members.filter(
        (m) => !room.settings.presenter || m.id !== room.hostId,
      );
      if (
        answerers.length < 2 ||
        answerers.length > room.settings.capacity ||
        answerers.some((m) => !m.connected || !m.ready || !m.inLobby)
      )
        throw new OrganizationError('ROOM_NOT_READY', 409);
      room.starting ??= {
        operationId,
        hash,
        revision: room.revision,
        id: crypto.randomUUID(),
      };
      await this.save(room);
      return { room: structuredClone(room) };
    });
    if (prepared.previous) return prepared.previous;
    const initial = prepared.room;
    if (!initial?.starting) throw new OrganizationError('START_PENDING', 409);
    const childId = initial.starting.id;
    try {
      const previousStatus = initial.match
        ? await this.child(initial.match.id).lobbyStatus()
        : null;
      if (this.isPlaying(previousStatus))
        throw new OrganizationError('MATCH_STARTED', 409);
      const allowed = await allowedInstanceActors(
        this.env,
        initial.scope,
        initial.members.map((m) => m.id),
      );
      if (
        initial.members.some(
          (m) => !allowed.includes(m.id) || (m.guest && !initial.settings.guests),
        )
      )
        throw new OrganizationError('PARTICIPATION_RESTRICTED', 409);
      const definition = await roomDefinition(
        this.env,
        initial.scope,
        initial.settings,
        initial.original,
        initial.sourceId,
      );
      definition.playersPerMatch = initial.members.filter(
        (m) => !initial.settings.presenter || m.id !== initial.hostId,
      ).length;
      try {
        await validateDefinition(definition);
      } catch {
        throw new OrganizationError('INVALID_SETUP', 400);
      }
      const tokens = Object.fromEntries(initial.members.map((m) => [m.id, secret()]));
      // Persist the child identity and credentials before an RPC whose outcome could be unknown.
      const fixed = await this.atomic(async () => {
        const room = await this.read();
        if (
          !room?.starting ||
          room.starting.operationId !== operationId ||
          room.revision !== initial.revision
        )
          throw new OrganizationError('EDIT_CONFLICT', 409);
        this.sweep(room);
        if (
          JSON.stringify(
            room.members.map((m) => [m.id, m.generation, m.ready, m.inLobby]),
          ) !==
            JSON.stringify(
              initial.members.map((m) => [m.id, m.generation, m.ready, m.inLobby]),
            ) ||
          room.members.some((m) => !m.connected)
        )
          throw new OrganizationError('ROOM_NOT_READY', 409);
        const key = `start:${operationId}`;
        const saved = await readStored<PreparedStart>(this.ctx.storage, key);
        if (saved) return saved;
        const pending: PreparedStart = {
          actor: actor.id,
          hash,
          id: childId,
          definition,
          tokens,
          members: initial.members.map((m) => ({
            id: m.id,
            name: m.name,
            guest: m.guest,
            ...(initial.settings.presenter && m.id === initial.hostId
              ? { role: 'presenter' as const }
              : {}),
          })),
        };
        await this.ctx.storage.transaction((tx) => writeStored(tx, key, pending));
        return pending;
      });
      return await this.finishStart(fixed, operationId);
    } catch (error) {
      // A prepared child may have started. Only release the latch before any child RPC was prepared.
      if (
        error instanceof OrganizationError &&
        !(await this.ctx.storage.get(`start:${operationId}`))
      )
        await this.atomic(async () => {
          const room = await this.read();
          if (room?.starting?.operationId === operationId) {
            room.starting = undefined;
            await this.save(room);
          }
        });
      throw error;
    }
  }
  private async finishStart(fixed: PreparedStart, operationId: string) {
    const initial = await this.read();
    if (!initial) throw new OrganizationError('ROOM_NOT_FOUND', 404);
    await this.child(fixed.id).initializeRoomMatch(
      fixed.definition,
      initial.scope,
      fixed.members,
      fixed.tokens,
    );
    return this.atomic(async () => {
      const previous = await this.ctx.storage.get<{
        actor: string;
        hash: string;
        result: { ok: true; room: string };
      }>(`operation:${operationId}`);
      if (previous) return previous.result;
      const room = await this.read();
      if (!room?.starting || room.starting.operationId !== operationId)
        throw new OrganizationError('START_PENDING', 409);
      room.match = {
        id: fixed.id,
        actors: fixed.members.map((m) => m.id),
        tokens: fixed.tokens,
      };
      room.playing = true;
      for (const m of room.members)
        if (room.match.actors.includes(m.id)) m.inLobby = false;
      const result = { ok: true as const, room: fixed.id };
      const expires = Date.now() + runtime.lobby.sessionLifetimeMs;
      const sessions = Object.fromEntries(
        fixed.members.map((m) => [
          `child-session:${m.id}:${fixed.id}`,
          {
            actor: m.id,
            room: fixed.id,
            token: fixed.tokens[m.id],
            parentToken: room.members.find((member) => member.id === m.id)?.token ?? '',
            generation:
              room.members.find((member) => member.id === m.id)?.generation ?? '',
            expires,
          } satisfies ChildSession,
        ]),
      );
      room.childSessionExpires = Math.min(room.childSessionExpires ?? expires, expires);
      room.starting = undefined;
      this.unready(room);
      await this.save(
        room,
        {
          ...sessions,
          [`operation:${operationId}`]: { actor: fixed.actor, hash: fixed.hash, result },
        },
        [`start:${operationId}`],
      );
      this.broadcast(room);
      return result;
    });
  }
  async gameSession(actor: string, token: string) {
    const room = await this.read();
    const member = room?.members.find((m) => m.id === actor && m.token === token);
    if (!room?.match || !member || member.inLobby || !room.match.actors.includes(actor))
      throw new OrganizationError('MATCH_NOT_FOUND', 404);
    return { room: room.match.id, token: room.match.tokens[actor] };
  }
  async status(): Promise<{
    phase: Snapshot['phase'];
    closed: boolean;
    actors: string[];
    capacity: number;
  } | null> {
    const room = await this.read();
    if (!room) return null;
    const current = room.match ? await this.child(room.match.id).lobbyStatus() : null;
    const playing = this.isPlaying(current);
    return this.atomic(async () => {
      const latest = await this.read();
      if (!latest) return null;
      if (latest.match?.id === room.match?.id) {
        latest.playing = playing;
        if (current?.closed && current.phase === 'WAITING') {
          for (const m of latest.members) m.inLobby = true;
          latest.match = undefined;
          this.unready(latest);
        }
      }
      this.sweep(latest);
      await this.save(latest);
      this.broadcast(latest);
      return {
        phase: playing ? (current?.phase ?? 'WAITING') : ('WAITING' as const),
        closed: latest.closed && !playing,
        actors: [
          ...new Set([
            ...latest.members.map((m) => m.id),
            ...(playing ? (latest.match?.actors ?? []) : []),
          ]),
        ],
        capacity: latest.settings.capacity,
      };
    });
  }
  async cancel(actor: string, revoke = false, generation?: string, token?: string) {
    const room = await this.read();
    if (!room) {
      if (generation) await this.ctx.storage.put(`closed:${generation}`, true);
      return true;
    }
    const member = room.members.find((m) => m.id === actor);
    if (
      member &&
      ((generation && member.generation !== generation) ||
        (token && member.token !== token))
    ) {
      if (revoke) await this.revokeChildren(actor, generation, token);
      return false;
    }
    const current = room.match ? await this.child(room.match.id).lobbyStatus() : null;
    const playing = this.isPlaying(current) && !!room.match?.actors.includes(actor);
    if (playing && !revoke) return false;
    const result = await this.atomic(async () => {
      const latest = await this.read();
      if (revoke) {
        await this.revokeChildren(actor);
        if (latest?.match?.tokens[actor])
          await this.child(latest.match.id).cancelReservation(
            actor,
            true,
            undefined,
            latest.match.tokens[actor],
          );
      }
      if (latest?.starting) {
        const fixed = await readStored<PreparedStart>(
          this.ctx.storage,
          `start:${latest.starting.operationId}`,
        );
        if (fixed && !revoke) return false;
        if (fixed && revoke && fixed.tokens[actor]) {
          await this.child(fixed.id).cancelReservation(
            actor,
            true,
            undefined,
            fixed.tokens[actor],
          );
        }
      }
      if (generation) await this.ctx.storage.put(`closed:${generation}`, true);
      if (!latest) return true;
      for (const socket of this.sockets())
        if ((socket.deserializeAttachment() as Attachment).actorId === actor)
          this.close(socket);
      latest.members = latest.members.filter((m) => m.id !== actor);
      latest.revision++;
      this.sweep(latest);
      await this.save(latest);
      this.broadcast(latest);
      return true;
    });
    return result;
  }
  private async revokeChildren(actor: string, generation?: string, token?: string) {
    const sessions = await this.ctx.storage.list<ChildSession>({
      prefix: `child-session:${actor}:`,
    });
    const matching = [...sessions].filter(
      ([, s]) =>
        (!generation || s.generation === generation) &&
        (!token || s.parentToken === token),
    );
    for (const [, session] of matching)
      await this.child(session.room).cancelReservation(
        actor,
        true,
        undefined,
        session.token,
      );
    if (matching.length) await this.ctx.storage.delete(matching.map(([key]) => key));
  }
  async fetch(request: Request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response(null, { status: 426 });
    return this.atomic(async () => {
      const room = await this.read(),
        token = request.headers.get('X-Game-Session');
      const member = room?.members.find(
        (m) => m.token === token && m.expires > Date.now(),
      );
      if (!room || !member || room.scope.id !== request.headers.get('X-Game-Instance'))
        return new Response(null, { status: 401 });
      if (
        this.sockets().filter(
          (s) => (s.deserializeAttachment() as Attachment).actorId === member.id,
        ).length >= runtime.game.maxConnectionsPerActor
      )
        return new Response(null, { status: 429 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [member.id]);
      pair[1].serializeAttachment({
        actorId: member.id,
        live: true,
        lastSeen: Date.now(),
      });
      this.sweep(room);
      await this.save(room);
      this.broadcast(room);
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }
  async message(socket: WebSocket, message: string | ArrayBuffer) {
    if (message !== 'sync') {
      this.close(socket);
      return;
    }
    await this.atomic(async () => {
      const a = socket.deserializeAttachment() as Attachment;
      if (!a.live) return;
      a.lastSeen = Date.now();
      socket.serializeAttachment(a);
      const room = await this.read();
      if (!room) return;
      this.sweep(room);
      await this.save(room);
      this.broadcast(room);
    });
  }
  async disconnect(socket: WebSocket) {
    await this.atomic(async () => {
      this.close(socket);
      const room = await this.read();
      if (room) {
        this.sweep(room);
        await this.save(room);
        this.broadcast(room);
      }
    });
  }
  async alarm() {
    await this.atomic(async () => {
      const room = await this.read();
      if (!room?.childSessionExpires || room.childSessionExpires > Date.now()) return;
      const sessions = await this.ctx.storage.list<ChildSession>({
        prefix: 'child-session:',
      });
      const expired = [...sessions]
        .filter(([, session]) => session.expires <= Date.now())
        .map(([key]) => key);
      if (expired.length) await this.ctx.storage.delete(expired);
      const deadlines = [...sessions.values()]
        .filter((s) => s.expires > Date.now())
        .map((s) => s.expires);
      room.childSessionExpires = deadlines.length ? Math.min(...deadlines) : undefined;
      await this.save(room);
    });
    const room = await this.read();
    if (room?.starting) {
      const operationId = room.starting.operationId;
      const pending = await readStored<PreparedStart>(
        this.ctx.storage,
        `start:${operationId}`,
      );
      try {
        if (pending) await this.finishStart(pending, operationId);
        else {
          // No child RPC has been prepared yet; let the same request retry the admission checks.
          await this.atomic(async () => {
            const latest = await this.read();
            if (
              latest?.starting?.operationId === operationId &&
              !(await this.ctx.storage.get(`start:${operationId}`))
            ) {
              latest.starting = undefined;
              await this.save(latest);
            }
          });
        }
      } catch {
        await this.ctx.storage.setAlarm(
          Date.now() + runtime.connection.heartbeatTimeoutMs,
        );
      }
    }
    await this.status();
    await this.directory();
  }
  async anonymize(actor: string) {
    await this.atomic(async () => {
      const room = await this.read();
      if (!room) return;
      for (const m of room.members) if (m.id === actor) m.name = '退会ユーザー';
      if (room.sourceOwner === actor) room.original = [];
      await this.save(room);
      this.broadcast(room);
    });
  }
  private sockets() {
    return this.ctx
      .getWebSockets()
      .filter((s) => (s.deserializeAttachment() as Attachment).live);
  }
  private close(socket: WebSocket) {
    const a = socket.deserializeAttachment() as Attachment;
    a.live = false;
    socket.serializeAttachment(a);
    try {
      socket.close(1000, 'Closed');
    } catch {}
  }
  private sweep(room: UserRoom) {
    const now = Date.now();
    if (now >= room.originalExpires) room.original = [];
    for (const socket of this.sockets())
      if (
        (socket.deserializeAttachment() as Attachment).lastSeen +
          runtime.connection.heartbeatTimeoutMs <=
        now
      )
        this.close(socket);
    const connected = new Set(
      this.sockets().map((s) => (s.deserializeAttachment() as Attachment).actorId),
    );
    const expired = room.members.filter(
      (m) =>
        m.expires <= now &&
        !room.starting &&
        (!room.playing || !room.match?.actors.includes(m.id)),
    );
    if (expired.length) {
      const ids = new Set(expired.map((m) => m.id));
      room.members = room.members.filter((m) => !ids.has(m.id));
      for (const socket of this.sockets())
        if (ids.has((socket.deserializeAttachment() as Attachment).actorId))
          this.close(socket);
      room.revision++;
    }
    for (const m of room.members) {
      m.connected = connected.has(m.id) && m.expires > now;
      if (m.guest && now >= m.joinedAt + 30 * 86400000) m.name = 'ゲスト';
    }
    const host = room.members.find((m) => m.id === room.hostId);
    if (!host?.connected) {
      const next = room.members.find((m) => m.connected);
      if (next && next.id !== room.hostId) {
        room.hostId = next.id;
        room.settings.presenter = false;
        room.revision++;
        this.unready(room);
      }
    }
    if (connected.size) room.emptySince = undefined;
    else {
      room.emptySince ??= now;
      if (now >= room.emptySince + 600000) room.closed = true;
    }
  }
  private unready(room: UserRoom) {
    for (const m of room.members) m.ready = false;
  }
  private isPlaying(status: { phase: Snapshot['phase']; closed: boolean } | null) {
    return (
      !!status &&
      !(status.closed && status.phase === 'WAITING') &&
      !['FINISHED', 'INVALID'].includes(status.phase)
    );
  }
  private view(room: UserRoom, actor: string, playing = room.playing): RoomView {
    const member = room.members.find((m) => m.id === actor);
    return {
      id: room.id,
      instanceId: room.scope.id,
      settings: room.settings,
      password: !!room.password,
      revision: room.revision,
      hostId: room.hostId,
      members: room.members.map(({ id, name, guest, ready, joinedAt, connected }) => ({
        id,
        name,
        guest,
        ready,
        joinedAt,
        connected,
      })),
      closed: room.closed,
      playing,
      matchRoom:
        member && !member.inLobby && room.match?.actors.includes(actor)
          ? room.match.id
          : null,
      waiting: !!member && member.inLobby && playing,
      ...(actor === room.hostId ? { invite: room.invite } : {}),
    };
  }
  private broadcast(room: UserRoom) {
    for (const socket of this.sockets()) {
      const actor = (socket.deserializeAttachment() as Attachment).actorId;
      try {
        socket.send(JSON.stringify({ type: 'lobby', room: this.view(room, actor) }));
      } catch {
        this.close(socket);
      }
    }
  }
  private async save(
    room: UserRoom,
    receipts: Record<string, unknown> = {},
    remove: string[] = [],
  ) {
    const deadlines = this.sockets().map(
      (s) =>
        (s.deserializeAttachment() as Attachment).lastSeen +
        runtime.connection.heartbeatTimeoutMs,
    );
    if (!room.closed && room.emptySince !== undefined)
      deadlines.push(room.emptySince + 600000);
    if (room.original.length) deadlines.push(room.originalExpires);
    if (room.childSessionExpires) deadlines.push(room.childSessionExpires);
    for (const m of room.members)
      if (!room.starting && (!room.playing || !room.match?.actors.includes(m.id)))
        deadlines.push(m.expires);
    for (const m of room.members)
      if (m.guest && m.name !== 'ゲスト') deadlines.push(m.joinedAt + 30 * 86400000);
    if (room.playing || room.starting)
      deadlines.push(Date.now() + runtime.connection.heartbeatTimeoutMs);
    await this.ctx.storage.transaction(async (tx) => {
      await writeStored(tx, 'user-room', room);
      for (const [key, value] of Object.entries(receipts))
        await writeStored(tx, key, value);
      for (const key of remove) await deleteStored(tx, key);
      if (deadlines.length) await tx.setAlarm(Math.min(...deadlines));
      else await tx.deleteAlarm();
    });
  }
  private async directory() {
    const room = await this.read();
    if (room)
      await publishRoom(
        this.env,
        room.id,
        room.scope.id,
        room.settings.public,
        room.closed,
      );
  }
}
