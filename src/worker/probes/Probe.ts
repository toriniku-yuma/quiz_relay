import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';

export class Probe extends DurableObject<Env> {
  private readonly instanceId = crypto.randomUUID();

  async snapshot() {
    return {
      count: (await this.ctx.storage.get<number>('count')) ?? 0,
      deadline: (await this.ctx.storage.get<number>('deadline')) ?? null,
      firedAt: (await this.ctx.storage.get<number>('firedAt')) ?? null,
    };
  }

  async increment() {
    await this.ctx.storage.transaction(async (tx) => {
      await tx.put('count', ((await tx.get<number>('count')) ?? 0) + 1);

      const deadline = Date.now() + 5000;
      await tx.put('deadline', deadline);
      await tx.setAlarm(deadline);
    });

    return this.snapshot();
  }

  async alarm() {
    await this.ctx.storage.transaction(async (tx) => {
      const deadline = await tx.get<number>('deadline');
      if (deadline === undefined) return;

      if (Date.now() < deadline) {
        await tx.setAlarm(deadline);
        return;
      }

      await tx.put('firedAt', Date.now());
      await tx.delete('deadline');
    });
  }

  async fetch(request: Request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response(null, { status: 426 });

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ connectedAt: Date.now() });

    pair[1].send(
      JSON.stringify({
        ...(await this.snapshot()),
        instanceId: this.instanceId,
        ...pair[1].deserializeAttachment(),
      }),
    );

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (message !== 'snapshot') {
      socket.close(1008, 'Unsupported message');
      return;
    }

    socket.send(
      JSON.stringify({
        ...(await this.snapshot()),
        instanceId: this.instanceId,
        ...socket.deserializeAttachment(),
      }),
    );
  }

  webSocketClose(socket: WebSocket) {
    socket.close(1000, 'Closed');
  }
}
