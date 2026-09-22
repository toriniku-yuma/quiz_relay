import { expect, it } from 'vitest';
import { instanceApiPath } from '../src/shared/api-paths';
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
