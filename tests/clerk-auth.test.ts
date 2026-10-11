import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  authenticateClerk,
  clerkSubject,
  legacySubjectPrefix,
} from '../src/worker/auth/clerk';
import { authConfig } from '../src/worker/auth/config';
import type { Env } from '../src/worker/env';

const mocks = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock('@clerk/backend', async (importOriginal) => {
  const original = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...original,
    createClerkClient: (...args: Parameters<typeof original.createClerkClient>) => {
      const client = original.createClerkClient(...args);
      // Keep actual Clerk request/JWT verification; isolate only the user lookup.
      return { ...client, users: { ...client.users, getUser: mocks.getUser } };
    },
  };
});

const issuer = 'https://auth-test.clerk.accounts.dev';
const origin = 'https://quiz.test';
const subject = '00000000-0000-4000-8000-000000000001';
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let configuration: Env;
let user: Record<string, unknown>;

beforeAll(async () => {
  keys = await generateKeyPair('RS256', { extractable: true });
  configuration = {
    AUTH_PROVIDER: 'clerk',
    CLERK_PUBLISHABLE_KEY: `pk_test_${btoa('auth-test.clerk.accounts.dev$')}`,
    CLERK_SECRET_KEY: 'sk_test_fixture',
    CLERK_JWT_KEY: await exportSPKI(keys.publicKey),
  } as Env;
});
beforeEach(() => {
  user = {
    object: 'user',
    id: 'user_fixture',
    externalId: null,
    passwordEnabled: false,
    banned: false,
    locked: false,
    email_addresses: [],
    phone_numbers: [],
    web3_wallets: [],
    externalAccounts: [{ provider: 'google', verification: { status: 'verified' } }],
    saml_accounts: [],
    enterprise_accounts: [],
    organization_memberships: [],
  };
  mocks.getUser.mockReset().mockImplementation(async () => user);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function token(
  payload: Record<string, unknown> = {},
  privateKey = keys.privateKey,
) {
  return new SignJWT({ sid: 'sess_fixture', azp: origin, ...payload })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'fixture' })
    .setSubject('user_fixture')
    .setIssuer(typeof payload.iss === 'string' ? payload.iss : issuer)
    .setIssuedAt()
    .setNotBefore(Math.floor(Date.now() / 1000) - 5)
    .setExpirationTime(typeof payload.exp === 'number' ? payload.exp : '+1m')
    .sign(privateKey);
}
async function authenticate(value: string) {
  return authenticateClerk(
    new Request(`${origin}/api/auth/identity`, {
      headers: { Authorization: `Bearer ${value}` },
    }),
    configuration,
  );
}

it('実SDKで署名を検証し、Googleアカウントを認証する', async () => {
  expect(await authenticate(await token())).toEqual({
    subject: 'user_fixture',
    displayName: '作問者',
  });
});
it('管理APIで付けた旧IDだけを引き継ぐ', async () => {
  user.externalId = legacySubjectPrefix + subject;
  user.unsafe_metadata = { subject: 'attacker' };
  expect((await authenticate(await token()))?.subject).toBe(subject);
  expect(() => clerkSubject({ id: 'user_fixture', externalId: 'other' })).toThrow(
    'INVALID_AUTH_MAPPING',
  );
});
it('別originのトークンと、別鍵で署名したトークンを拒否する', async () => {
  expect(await authenticate(await token({ azp: 'https://evil.test' }))).toBeNull();
  expect(await authenticate(await token({ azp: undefined }))).toBeNull();
  expect(
    await authenticate(await token({ iss: 'https://other.clerk.accounts.dev' })),
  ).toBeNull();
  expect(
    await authenticate(await token({ exp: Math.floor(Date.now() / 1000) - 60 })),
  ).toBeNull();
  const other = await generateKeyPair('RS256');
  expect(await authenticate(await token({}, other.privateKey))).toBeNull();
  expect(mocks.getUser).not.toHaveBeenCalled();
});
it.each(['banned', 'locked', 'passwordEnabled'])(
  '%sのアカウントを拒否する',
  async (field) => {
    user[field] = true;
    expect(await authenticate(await token())).toBeNull();
  },
);
it.each([
  { accounts: [] },
  { accounts: [{ provider: 'google', verification: { status: 'unverified' } }] },
  { accounts: [{ provider: 'github', verification: { status: 'verified' } }] },
])('検証済みGoogle連携がないアカウントを拒否する', async ({ accounts }) => {
  user.externalAccounts = accounts;
  expect(await authenticate(await token())).toBeNull();
});
it('Clerk選択時にキーが欠けたら旧Authへ戻らず、秘密鍵も公開設定へ出さない', () => {
  expect(
    authConfig({
      ...configuration,
      CLERK_SECRET_KEY: undefined,
      SUPABASE_URL: 'https://old.test',
      SUPABASE_PUBLISHABLE_KEY: 'old',
    }),
  ).toBeUndefined();
  expect(authConfig(configuration)).toEqual({
    provider: 'clerk',
    publishableKey: configuration.CLERK_PUBLISHABLE_KEY,
  });
});
