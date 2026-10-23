import { expect, it } from 'vitest';
import { withdrawAccount } from '../src/worker/organization/withdrawal';

it('確認後にログインアカウントが変わった退会要求はDB操作前に拒否する', async () => {
  await expect(
    withdrawAccount(
      {} as Parameters<typeof withdrawAccount>[0],
      {} as Parameters<typeof withdrawAccount>[1],
      'new-user',
      { subject: 'old-user', confirmation: '退会', operationId: crypto.randomUUID() },
    ),
  ).rejects.toThrow('WITHDRAWAL_ACCOUNT_CHANGED');
});
