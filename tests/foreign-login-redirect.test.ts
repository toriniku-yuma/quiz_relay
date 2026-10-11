import { afterEach, expect, it, vi } from 'vitest';
import { safeAuthReturn } from '../src/client/features/auth/callback';
import {
  beginForeignAuthorization,
  foreignAuthorizationCallback,
  foreignReturnUrl,
  readForeignAuthorization,
} from '../src/client/features/federation/redirect';
import {
  beginForeignRoomEntry,
  readForeignRoomEntry,
  restartForeignRoomEntry,
} from '../src/client/features/federation/roomEntry';
import type { ForeignSession } from '../src/shared/participation';
import { participationTarget } from '../src/shared/participation';

afterEach(() => vi.unstubAllGlobals());
it('自動ログインの遷移でstateを保存し、戻り先・stateが一致した短命証明だけを交換へ渡す', () => {
  const stored = new Map<string, string>(),
    replace = vi.fn();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  vi.stubGlobal('location', { origin: 'https://host.quiz-relay.workers.dev', replace });
  const target = {
    peerOrigin: 'https://home.quiz-relay.workers.dev',
    sourceInstanceId: crypto.randomUUID(),
    hostInstanceId: crypto.randomUUID(),
    mode: 'casual' as const,
  };
  beginForeignAuthorization(target, 'login');
  const authorize = new URL(replace.mock.calls[0][0]);
  expect(authorize.origin).toBe(target.peerOrigin);
  expect(participationTarget(authorize, true)).toMatchObject({
    peerOrigin: location.origin,
    mode: 'casual',
  });
  const pending = readForeignAuthorization(sessionStorage);
  expect(pending?.flow).toBe('login');
  const callback = new URL(
    foreignReturnUrl(
      { ...target, peerOrigin: location.origin },
      pending?.state ?? '',
      'proof',
    ),
  );
  expect(callback.searchParams.has('ticket')).toBe(false);
  expect(foreignAuthorizationCallback(callback, pending)?.ticket).toBe('proof');
  callback.hash = new URLSearchParams({
    qr_state: crypto.randomUUID(),
    qr_ticket: 'proof',
  }).toString();
  expect(foreignAuthorizationCallback(callback, pending)).toBeNull();
  expect(foreignAuthorizationCallback(callback, null)).toBeNull();
  const expired = pending ? { ...pending, startedAt: Date.now() - 600001 } : null;
  expect(readForeignAuthorization({ getItem: () => JSON.stringify(expired) })).toBeNull();
});
it('組織内ログインの戻り先は通常画面の同一originと一意のinstanceだけを許可する', () => {
  const id = crypto.randomUUID();
  expect(safeAuthReturn(`/casual/?instance=${id}`)).toBe(`/casual/?instance=${id}`);
  for (const value of [
    `https://other.example/game/?instance=${id}`,
    `/game/?instance=${id}&instance=${id}`,
    '/game/?instance=invalid',
    `/game/?instance=${id}#proof`,
    `/game/?home=https://peer.example`,
  ])
    expect(safeAuthReturn(value)).toBeUndefined();
});
it('保存した部屋操作は本人・所属元・instance・参加操作IDが一致する復帰だけに引き継ぐ', async () => {
  const stored = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  vi.stubGlobal('location', {
    origin: 'https://host.quiz-relay.workers.dev',
    replace: vi.fn(),
  });
  const account = {
      homeOrigin: 'https://home.quiz-relay.workers.dev',
      organizationId: crypto.randomUUID(),
      sourceActorId: 'a'.repeat(64),
      organizationName: '所属元',
      name: '参加者',
      expiresAt: Date.now() + 60000,
    },
    instanceId = crypto.randomUUID(),
    room = crypto.randomUUID();
  beginForeignRoomEntry(account, instanceId, 'join', { room, password: '', invite: '' });
  const pending = readForeignAuthorization(sessionStorage);
  const session: ForeignSession = {
    reservationId: crypto.randomUUID(),
    operationId: pending?.operationId ?? '',
    sourceInstanceId: account.organizationId,
    sourceActorId: account.sourceActorId,
    actorId: 'b'.repeat(64),
    homeOrigin: account.homeOrigin,
    instanceId,
    instanceName: '開催先',
    mode: 'room',
    room: '',
    name: account.name,
    expiresAt: account.expiresAt,
  };
  expect(readForeignRoomEntry(session)?.body.room).toBe(room);
  for (const changed of [
    { sourceActorId: 'c'.repeat(64) },
    { sourceInstanceId: crypto.randomUUID() },
    { operationId: crypto.randomUUID() },
    { instanceId: crypto.randomUUID() },
  ])
    expect(readForeignRoomEntry({ ...session, ...changed })).toBeNull();
  const key = 'quiz-relay-foreign-room-entry',
    saved = JSON.parse(stored.get(key) ?? '{}');
  stored.set(key, JSON.stringify({ ...saved, createdAt: 'invalid' }));
  expect(readForeignRoomEntry(session)).toBeNull();
  stored.set(key, JSON.stringify(saved));
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ code: 'PARTICIPATION_RELEASE_PENDING' }, { status: 503 }),
    );
  vi.stubGlobal('fetch', fetch);
  const corrected = { room, password: 'corrected', invite: 'new-invite' };
  await expect(
    restartForeignRoomEntry(session, account, instanceId, 'join', corrected),
  ).rejects.toThrow();
  expect(readForeignRoomEntry(session)?.body).toEqual(saved.body);
  expect(readForeignAuthorization(sessionStorage)?.operationId).toBe(session.operationId);
  for (const response of [
    Response.json({ ok: true }),
    Response.json({ code: 'SESSION_REQUIRED' }, { status: 401 }),
  ]) {
    fetch.mockResolvedValue(response);
    await restartForeignRoomEntry(session, account, instanceId, 'join', corrected);
    const renewed = readForeignAuthorization(sessionStorage);
    expect(renewed?.operationId).not.toBe(session.operationId);
    expect(
      readForeignRoomEntry({ ...session, operationId: renewed?.operationId ?? '' })?.body,
    ).toEqual(corrected);
  }
  expect(fetch).toHaveBeenCalledWith(
    expect.objectContaining({ pathname: '/api/v1/participation/cancel' }),
    expect.objectContaining({ body: JSON.stringify({ forfeit: false }) }),
  );
});
