import { beforeEach, expect, it, vi } from 'vitest';
import { clerkAuthDeletion } from '../src/erasure/clerk';

const mocks = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock('@clerk/backend', () => ({
  createClerkClient: () => ({ users: { deleteUser: mocks.remove } }),
}));
beforeEach(() => {
  mocks.remove.mockReset().mockResolvedValue({ deleted: true });
});
it('本人IDのClerkユーザーを削除し、応答消失後の再送も完了できる', async () => {
  const remove = clerkAuthDeletion('sk_test_fixture');
  await remove('user_fixture');
  expect(mocks.remove).toHaveBeenCalledWith('user_fixture');
  mocks.remove.mockRejectedValue({ status: 404 });
  await remove('user_fixture');
});
it('ClerkユーザーIDでない本人IDとサービス障害では削除完了にしない', async () => {
  const remove = clerkAuthDeletion('sk_test_fixture');
  await expect(remove('00000000-0000-4000-8000-000000000001')).rejects.toThrow(
    'INVALID_AUTH_SUBJECT',
  );
  expect(mocks.remove).not.toHaveBeenCalled();
  mocks.remove.mockRejectedValue({ status: 503 });
  await expect(remove('user_fixture')).rejects.toThrow('AUTH_ERASURE_FAILED');
});
