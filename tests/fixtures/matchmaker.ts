import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import type { Env } from '../../src/worker/env';

const runtime = env as unknown as Env;
export async function resetMatchmaker() {
  await runInDurableObject(
    runtime.MATCHMAKER.getByName('matchmaker'),
    async (_instance, context) => {
      await context.storage.deleteAll();
      await context.storage.deleteAlarm();
    },
  );
  await evictDurableObject(runtime.MATCHMAKER.getByName('matchmaker'));
  if (!runtime.ADMISSION_LIMITER) throw new Error('RATE_LIMITER_NOT_CONFIGURED');
  vi.spyOn(runtime.ADMISSION_LIMITER, 'limit').mockResolvedValue({ success: true });
}
