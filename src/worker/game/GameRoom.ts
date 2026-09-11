import { DurableObject } from 'cloudflare:workers';
import type { GameMessage } from '../../shared/game';
import type { Env } from '../env';
import { adjudicate, advance, createState, type State, snapshot } from './state';
import { parseCommand } from './validation';

type Room = { state: State; sessions: Record<string, string> };
type Attachment = { actorId: string; windowStart: number; count: number };

export class GameRoom extends DurableObject<Env> {
  async join(
    input: { name: string; questionIndex: number; players: number },
    token: string | undefined,
  ) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const room = (await this.ctx.storage.get<Room>('room')) ?? {
        state: createState(input.questionIndex, input.players),
        sessions: {},
      };
      const existing =
        token && Object.hasOwn(room.sessions, token) ? room.sessions[token] : undefined;
      if (existing) {
        if (this.ctx.getWebSockets(existing).length >= 3)
          return { ok: false as const, code: 'CONNECTION_LIMIT' };

        return { ok: true as const, token: token as string };
      }
      if (
        room.state.phase !== 'WAITING' ||
        room.state.players.length >= room.state.playersRequired
      )
        return { ok: false as const, code: 'ROOM_CLOSED' };
      if (
        room.state.question.id !==
          `mock-${String(input.questionIndex + 1).padStart(2, '0')}` ||
        room.state.playersRequired !== input.players
      )
        return { ok: false as const, code: 'SETUP_MISMATCH' };

      const actorId = crypto.randomUUID();
      const session = crypto.randomUUID() + crypto.randomUUID();
      room.sessions[session] = actorId;
      room.state.players.push({
        id: actorId,
        name: input.name,
        correct: 0,
        mistakes: 0,
        locked: false,
      });
      room.state.roomSeq++;

      await this.save(room);
      this.broadcast(room);
      return { ok: true as const, token: session };
    });
  }

  async fetch(request: Request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
        return new Response(null, { status: 426 });

      const room = await this.ctx.storage.get<Room>('room');
      const session = request.headers.get('X-Game-Session') ?? '';
      const actorId =
        room && Object.hasOwn(room.sessions, session)
          ? room.sessions[session]
          : undefined;
      if (!room || !actorId) return new Response(null, { status: 401 });
      if (this.ctx.getWebSockets(actorId).length >= 3)
        return new Response(null, { status: 429 });

      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [actorId]);
      pair[1].serializeAttachment({
        actorId,
        windowStart: Date.now(),
        count: 0,
      } satisfies Attachment);

      const connected = new Set(
        this.ctx
          .getWebSockets()
          .map((socket) => (socket.deserializeAttachment() as Attachment).actorId),
      );
      if (
        room.state.phase === 'WAITING' &&
        connected.size === room.state.playersRequired
      ) {
        room.state.phase = 'REVEALING';
        room.state.deadline = Date.now() + room.state.rules.revealIntervalMs;
        room.state.roomSeq++;
      }

      advance(room.state, Date.now());
      await this.save(room);
      this.broadcast(room);
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const attachment = socket.deserializeAttachment() as Attachment;
      const now = Date.now();
      if (now - attachment.windowStart >= 1000) {
        attachment.windowStart = now;
        attachment.count = 0;
      }
      attachment.count++;
      socket.serializeAttachment(attachment);
      if (attachment.count > 20) {
        socket.close(1008, 'RATE_LIMIT');
        return;
      }

      const room = await this.ctx.storage.get<Room>('room');
      if (!room?.state.players.some(({ id }) => id === attachment.actorId)) {
        socket.close(1008, 'SESSION_INVALID');
        return;
      }
      if (message === 'sync') {
        if (advance(room.state, now)) {
          await this.save(room);
          this.broadcast(room);
        } else this.sendState(socket, room);
        return;
      }

      const command = parseCommand(message);
      if (!command) {
        this.send(socket, { type: 'error', code: 'INVALID_COMMAND' });
        return;
      }

      const reply = adjudicate(room.state, attachment.actorId, command, now);
      await this.save(room);
      this.send(socket, { type: 'ack', reply });
      this.broadcast(room);
    });
  }

  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const room = await this.ctx.storage.get<Room>('room');
      if (!room) return;

      const changed = advance(room.state, Date.now());
      await this.save(room);
      if (changed) this.broadcast(room);
    });
  }

  webSocketClose(socket: WebSocket) {
    socket.close(1000, 'Closed');
  }

  webSocketError(socket: WebSocket) {
    socket.close(1011, 'Connection error');
  }

  private async save(room: Room) {
    await this.ctx.storage.transaction(async (tx) => {
      await tx.put('room', room);
      if (room.state.deadline === null) await tx.deleteAlarm();
      else await tx.setAlarm(room.state.deadline);
    });
  }

  private send(socket: WebSocket, message: GameMessage) {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      socket.close(1011, 'Send failed');
    }
  }

  private sendState(socket: WebSocket, room: Room) {
    const { actorId } = socket.deserializeAttachment() as Attachment;
    this.send(socket, {
      type: 'state',
      actorId,
      snapshot: snapshot(room.state),
      panel: room.state.holder === actorId ? room.state.panel : null,
      serverTime: Date.now(),
    });
  }

  private broadcast(room: Room) {
    for (const socket of this.ctx.getWebSockets()) this.sendState(socket, room);
  }
}
