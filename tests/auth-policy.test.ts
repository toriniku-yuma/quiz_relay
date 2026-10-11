import { Hono } from 'hono';
import { beforeEach, expect, it, vi } from 'vitest';
import { type AuthEnv, authenticate, authIdentity } from '../src/worker/auth/handlers';
import type { Env } from '../src/worker/env';

const mocks = vi.hoisted(() => ({ user: vi.fn(), claims: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getUser: mocks.user, getClaims: mocks.claims } }),
}));
const app = new Hono<AuthEnv>().get('/identity', authenticate, authIdentity);
const configuration = {
  AUTH_PROVIDER: 'supabase',
  SUPABASE_URL: 'https://old.test',
  SUPABASE_PUBLISHABLE_KEY: 'public-fixture',
  GAME_OWNER: 'https://quiz.test',
} as Env;
beforeEach(() => {
  mocks.user.mockResolvedValue({
    data: { user: { id: 'fixture', email_confirmed_at: '2026-01-01' } },
    error: null,
  });
  mocks.claims.mockResolvedValue({
    data: { claims: { sub: 'fixture', amr: [{ method: 'oauth' }] } },
    error: null,
  });
});
function request() {
  return app.request(
    'https://quiz.test/identity',
    { headers: { Authorization: 'Bearer fixture' } },
    configuration,
  );
}
it('旧環境でも検証済みOAuthセッションだけを本人IDとして受け付ける', async () => {
  expect(await (await request()).json()).toEqual({ subject: 'fixture' });
  for (const method of ['otp', 'password']) {
    mocks.claims.mockResolvedValue({
      data: { claims: { sub: 'fixture', amr: [{ method }] } },
      error: null,
    });
    expect((await request()).status).toBe(401);
  }
  mocks.claims.mockResolvedValue({
    data: { claims: { sub: 'other', amr: [{ method: 'oauth' }] } },
    error: null,
  });
  expect((await request()).status).toBe(401);
  mocks.claims.mockResolvedValue({ data: null, error: new Error('offline') });
  expect((await request()).status).toBe(401);
});
