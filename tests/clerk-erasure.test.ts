import { beforeEach, expect, it, vi } from 'vitest';
import { clerkAuthDeletion } from '../src/erasure/clerk';
import { legacySubjectPrefix } from '../src/worker/auth/clerk';

const mocks = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn() }));
vi.mock('@clerk/backend', () => ({
  createClerkClient: () => ({
    users: { getUserList: mocks.list, deleteUser: mocks.remove },
  }),
}));
const subject = '00000000-0000-4000-8000-000000000001';
beforeEach(() => {
  mocks.list.mockReset().mockResolvedValue({
    data: [{ id: 'user_fixture', externalId: legacySubjectPrefix + subject }],
    totalCount: 1,
  });
  mocks.remove.mockReset().mockResolvedValue({ deleted: true });
});
it('旧IDを対応付けて削除し、応答消失後の再送も完了できる', async () => {
  const remove = clerkAuthDeletion({ CLERK_SECRET_KEY: 'fixture' });
  await remove(subject);
  expect(mocks.list).toHaveBeenCalledWith({
    externalId: [legacySubjectPrefix + subject],
    limit: 2,
  });
  expect(mocks.remove).toHaveBeenCalledWith('user_fixture');
  mocks.list.mockResolvedValue({ data: [], totalCount: 0 });
  await remove(subject);
  mocks.remove.mockRejectedValue({ status: 404 });
  await remove('user_fixture');
});
it('複数の対応先がある場合とサービス障害では削除完了にしない', async () => {
  const remove = clerkAuthDeletion({ CLERK_SECRET_KEY: 'fixture' });
  mocks.list.mockResolvedValue({ data: [], totalCount: 2 });
  await expect(remove(subject)).rejects.toThrow('AUTH_ERASURE_MAPPING_CONFLICT');
  expect(mocks.remove).not.toHaveBeenCalled();
  mocks.remove.mockRejectedValue({ status: 503 });
  await expect(remove('user_fixture')).rejects.toThrow('AUTH_ERASURE_FAILED');
});
