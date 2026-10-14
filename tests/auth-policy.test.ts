import { Hono } from 'hono';
import { beforeEach, expect, it, vi } from 'vitest';
import { type AuthEnv, authenticate, authIdentity } from '../src/worker/auth/handlers';
import type { Env } from '../src/worker/env';

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock('../src/worker/auth/clerk', () => ({ authenticateClerk: mocks.authenticate }));
const app = new Hono<AuthEnv>().get('/identity', authenticate, authIdentity);
const configuration = {
  CLERK_PUBLISHABLE_KEY: 'pk_test_fixture',
  CLERK_SECRET_KEY: 'sk_test_fixture',
  API_LIMITER: { limit: async () => ({ success: true }) },
} as unknown as Env;
beforeEach(() => {
  mocks.authenticate
    .mockReset()
    .mockResolvedValue({ subject: 'user_fixture', displayName: '作問者' });
});
function request(environment = configuration, authorization = 'Bearer fixture') {
  return app.request(
    'https://quiz.test/identity',
    { headers: { Authorization: authorization } },
    environment,
  );
}

it('Clerkが検証したユーザーIDだけを本人IDとして受け付ける', async () => {
  expect(await (await request()).json()).toEqual({ subject: 'user_fixture' });
  expect(mocks.authenticate).toHaveBeenCalledWith(expect.any(Request), {
    publishableKey: 'pk_test_fixture',
    secretKey: 'sk_test_fixture',
    jwtKey: undefined,
  });
  mocks.authenticate.mockResolvedValue(null);
  expect((await request()).status).toBe(401);
});
it('Bearer形式でないトークンはClerkへ渡さない', async () => {
  for (const authorization of ['', 'Basic fixture', 'Bearer a b'])
    expect((await request(configuration, authorization)).status).toBe(401);
  expect(mocks.authenticate).not.toHaveBeenCalled();
});
it('Clerkのキーが欠けていれば認証せず設定エラーを返す', async () => {
  for (const missing of [
    { CLERK_SECRET_KEY: undefined },
    { CLERK_PUBLISHABLE_KEY: undefined },
    { CLERK_PUBLISHABLE_KEY: 'public-fixture' },
  ]) {
    const response = await request({ ...configuration, ...missing });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'AUTH_NOT_CONFIGURED' });
  }
  expect(mocks.authenticate).not.toHaveBeenCalled();
});
it('レート制限のbindingが無ければ認証せず設定エラーを返す', async () => {
  const response = await request({ ...configuration, API_LIMITER: undefined });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: 'RATE_LIMITER_NOT_CONFIGURED' });
  expect(mocks.authenticate).not.toHaveBeenCalled();
});
it('Clerkの障害は未ログインと区別して返す', async () => {
  mocks.authenticate.mockRejectedValue(new Error('offline'));
  const response = await request();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: 'AUTH_UNAVAILABLE' });
});
