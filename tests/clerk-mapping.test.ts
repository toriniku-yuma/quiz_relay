import type { User as ClerkUser } from '@clerk/backend';
import type { User } from '@supabase/supabase-js';
import { expect, it } from 'vitest';
import {
  validateClerkMapping,
  validateQuizMappingAccounts,
} from '../scripts/map-clerk-accounts';

const legacy = {
  id: '00000000-0000-4000-8000-000000000001',
  identities: [
    {
      id: 'google-fixture',
      user_id: '00000000-0000-4000-8000-000000000001',
      identity_id: 'identity-fixture',
      provider: 'google',
      identity_data: { sub: 'google-fixture' },
    },
  ],
} as Pick<User, 'id' | 'identities'>;
const target = {
  id: 'user_fixture',
  externalId: null,
  externalAccounts: [
    {
      provider: 'google',
      providerUserId: 'google-fixture',
      verification: { status: 'verified' },
    },
  ],
} as Pick<ClerkUser, 'id' | 'externalId' | 'externalAccounts'>;
it('Googleの同一性を確認して旧IDを保持し、同じ対応の再送を許可する', () => {
  const externalId = validateClerkMapping(legacy, target);
  expect(externalId).toBe(`quiz-relay:supabase:${legacy.id}`);
  expect(validateClerkMapping(legacy, { ...target, externalId })).toBe(externalId);
});
it('別Googleアカウント・別の対応・メールだけの旧アカウントを拒否する', () => {
  expect(() => validateClerkMapping(legacy, { ...target, externalId: 'other' })).toThrow(
    'AUTH_MAPPING_CONFLICT',
  );
  expect(() => validateClerkMapping({ ...legacy, identities: [] }, target)).toThrow(
    'GOOGLE_IDENTITY_MISMATCH',
  );
  expect(() =>
    validateClerkMapping(legacy, {
      ...target,
      externalAccounts: [{ ...target.externalAccounts[0], providerUserId: 'other' }],
    }),
  ).toThrow('GOOGLE_IDENTITY_MISMATCH');
});

it('試しログインのプロフィールは残し、利用済み・別組織・退会済みの新IDを統合しない', () => {
  const existing = {
    subject: legacy.id,
    actorId: 'old-actor',
    organizationId: 'organization',
    administrator: true,
    withdrawnAt: null,
  };
  const profile = {
    ...existing,
    subject: target.id,
    actorId: 'new-actor',
    administrator: false,
  };
  const accounts = [existing, profile];
  expect(validateQuizMappingAccounts(accounts, legacy.id, target.id)).toEqual({
    legacy: existing,
    target: profile,
  });
  expect(accounts).toEqual([existing, profile]);
  for (const duplicate of [
    { ...existing, organizationId: 'other', actorId: 'other-old-actor' },
    { ...profile, organizationId: 'other', actorId: 'other-new-actor' },
  ])
    expect(() =>
      validateQuizMappingAccounts([...accounts, duplicate], legacy.id, target.id),
    ).toThrow('QUIZ_ACCOUNT_MAPPING_CONFLICT');
  expect(() => validateQuizMappingAccounts(accounts, legacy.id, target.id, true)).toThrow(
    'QUIZ_ACCOUNT_MAPPING_CONFLICT',
  );
  for (const changed of [
    { ...profile, organizationId: 'other' },
    { ...profile, administrator: true },
    { ...profile, withdrawnAt: new Date().toISOString() },
  ])
    expect(() =>
      validateQuizMappingAccounts([existing, changed], legacy.id, target.id),
    ).toThrow('QUIZ_ACCOUNT_MAPPING_CONFLICT');
  expect(() =>
    validateQuizMappingAccounts(
      [{ ...existing, withdrawnAt: new Date().toISOString() }],
      legacy.id,
      target.id,
    ),
  ).toThrow('QUIZ_ACCOUNT_MAPPING_CONFLICT');
});
