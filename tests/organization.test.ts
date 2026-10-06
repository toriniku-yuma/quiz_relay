import { expect, it } from 'vitest';
import { instanceApiPath } from '../src/shared/api-paths';
import type { Sanction } from '../src/shared/moderation';
import { canJoinInstance, type OrganizationOverview } from '../src/shared/organization';
import { defaultCasualSettings } from '../src/shared/rooms';
import { validateRef } from '../src/worker/catalog/definition';
import { contentHash } from '../src/worker/catalog/hash';
import {
  actorForSubject,
  canViewInstance,
  requireAdministrator,
  requireInstaller,
  validId,
  validName,
} from '../src/worker/organization/access';

it('既存GAME_OWNERと検証済みsubjectによる本人IDを維持する', async () => {
  expect(await actorForSubject('https://old.test', 'verified-subject')).toBe(
    await contentHash({ home: 'https://old.test', subject: 'verified-subject' }),
  );
  expect(await actorForSubject('https://old.test', 'other-subject')).not.toBe(
    await actorForSubject('https://old.test', 'verified-subject'),
  );
});
it('設置者指定なし・別人・非管理者は管理操作を拒否', () => {
  expect(() => requireInstaller('known-subject', undefined)).toThrow('SETUP_FORBIDDEN');
  expect(() => requireInstaller('other', 'known-subject')).toThrow('SETUP_FORBIDDEN');
  expect(() => requireInstaller('known-subject', 'known-subject')).not.toThrow();
  expect(() => requireAdministrator({ administrator: false })).toThrow('ADMIN_REQUIRED');
});
it('準備中は一般ユーザーに非公開、権限は対象インスタンスのものだけを使用', () => {
  expect(canViewInstance('preparing', false, [])).toBe(false);
  expect(canViewInstance('preparing', false, ['questions'])).toBe(true);
  expect(canViewInstance('preparing', true, [])).toBe(true);
  expect(canViewInstance('published', false, [])).toBe(true);
});
it('入力と内部ownerを限定し、旧HTTPS ownerの検証も維持する', () => {
  const id = crypto.randomUUID();
  expect(validId(id)).toBe(id);
  expect(() => validId('../other')).toThrow();
  expect(() => validName('\nname')).toThrow();
  expect(() => validName(' '.repeat(20))).toThrow();
  expect(validName(' 名前 ')).toBe('名前');
  expect(validateRef({ owner: `urn:uuid:${id}`, id: 'rank', version: 1 }).owner).toBe(
    `urn:uuid:${id}`,
  );
  expect(() =>
    validateRef({ owner: 'urn:uuid:unknown', id: 'rank', version: 1 }),
  ).toThrow();
  expect(() =>
    validateRef({ owner: 'https://old.test/path', id: 'rank', version: 1 }),
  ).toThrow();
  expect(instanceApiPath('/api/results/overview', id)).toBe(
    `/api/results/overview?instance=${id}`,
  );
});

const participant = { actorId: 'actor', administrator: false, displayName: '登録名' };
const publicInstance: OrganizationOverview['instances'][number] = {
  id: 'instance',
  name: '対象',
  state: 'published',
  permissions: [],
};
const modes = ['ranked', 'casual', 'room', 'roomCreate'] as const;
const restriction: Sanction = {
  id: 'restriction',
  actorId: 'actor',
  instanceId: 'instance',
  kind: 'partial',
  restrictions: ['ranked'],
  reason: '制限',
  expiresAt: null,
  revokedAt: null,
  revision: 1,
};

it('参加先の公開状態と対象管理権限を確認し、アーカイブは管理者も参加不可', () => {
  const preparing = { ...publicInstance, state: 'preparing' as const };
  for (const mode of modes) {
    expect(canJoinInstance(publicInstance, participant, [], mode)).toBe(true);
    expect(canJoinInstance(preparing, participant, [], mode)).toBe(false);
    expect(
      canJoinInstance(preparing, { ...participant, administrator: true }, [], mode),
    ).toBe(true);
    for (const permission of ['questions', 'authors', 'users'] as const) {
      expect(
        canJoinInstance(
          { ...preparing, permissions: [permission] },
          participant,
          [],
          mode,
        ),
      ).toBe(true);
    }
    expect(
      canJoinInstance(
        { ...publicInstance, state: 'archived' },
        { ...participant, administrator: true },
        [],
        mode,
      ),
    ).toBe(false);
  }
});

it('モード別停止の管理権限例外と、カジュアル無効・部屋参加の違いを維持する', () => {
  const rankedPaused = { ...publicInstance, rankedPauseReason: '停止' };
  const casualPaused = { ...publicInstance, casualPauseReason: '停止' };
  const casualDisabled = {
    ...publicInstance,
    casualConfig: { ...defaultCasualSettings, enabled: false },
  };
  for (const mode of modes) {
    expect(canJoinInstance(rankedPaused, participant, [], mode)).toBe(mode !== 'ranked');
    expect(canJoinInstance(casualPaused, participant, [], mode)).toBe(mode === 'ranked');
    expect(
      canJoinInstance(casualPaused, { ...participant, administrator: true }, [], mode),
    ).toBe(true);
    expect(
      canJoinInstance({ ...casualPaused, permissions: ['users'] }, participant, [], mode),
    ).toBe(true);
    expect(
      canJoinInstance(casualDisabled, { ...participant, administrator: true }, [], mode),
    ).toBe(mode !== 'casual');
  }
});

it('本人の処分は対象範囲・対戦種別・期限を確認し、管理権限で回避しない', () => {
  for (const mode of modes) {
    expect(canJoinInstance(publicInstance, participant, [restriction], mode)).toBe(
      mode !== 'ranked',
    );
    expect(
      canJoinInstance(
        publicInstance,
        participant,
        [{ ...restriction, restrictions: ['casual'] }],
        mode,
      ),
    ).toBe(mode === 'ranked');
    expect(
      canJoinInstance(
        publicInstance,
        participant,
        [{ ...restriction, restrictions: ['rooms'] }],
        mode,
      ),
    ).toBe(mode !== 'roomCreate');
    expect(
      canJoinInstance(
        publicInstance,
        { ...participant, administrator: true },
        [{ ...restriction, instanceId: null, kind: 'ban', restrictions: [] }],
        mode,
      ),
    ).toBe(false);
    expect(
      canJoinInstance(
        publicInstance,
        participant,
        [{ ...restriction, instanceId: 'other' }],
        mode,
      ),
    ).toBe(true);
    expect(
      canJoinInstance(
        publicInstance,
        participant,
        [{ ...restriction, revokedAt: new Date().toISOString() }],
        mode,
      ),
    ).toBe(true);
    expect(
      canJoinInstance(
        publicInstance,
        participant,
        [
          {
            ...restriction,
            kind: 'timeout',
            expiresAt: new Date(Date.now() - 1).toISOString(),
          },
        ],
        mode,
      ),
    ).toBe(true);
    expect(
      canJoinInstance(
        publicInstance,
        participant,
        [
          {
            ...restriction,
            kind: 'timeout',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        ],
        mode,
      ),
    ).toBe(false);
  }
});

it('本人・表示名・処分情報・対象が未確認なら新規参加の入口を表示しない', () => {
  expect(canJoinInstance(publicInstance, undefined, [], 'ranked')).toBe(false);
  expect(
    canJoinInstance(publicInstance, { ...participant, displayName: null }, [], 'ranked'),
  ).toBe(false);
  expect(canJoinInstance(publicInstance, participant, undefined, 'ranked')).toBe(false);
  expect(canJoinInstance(undefined, participant, [], 'ranked')).toBe(false);
});
