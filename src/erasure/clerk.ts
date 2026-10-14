import { clerkBackend } from '../worker/auth/clerk.ts';

export function clerkAuthDeletion(secretKey: string) {
  const client = clerkBackend({ secretKey });
  return async (subject: string) => {
    if (!/^user_[A-Za-z0-9]+$/.test(subject)) throw new Error('INVALID_AUTH_SUBJECT');
    try {
      await client.users.deleteUser(subject);
    } catch (error) {
      // A successful deletion with a lost response is safe to retry.
      if (
        !error ||
        typeof error !== 'object' ||
        !('status' in error) ||
        error.status !== 404
      )
        throw new Error('AUTH_ERASURE_FAILED');
    }
  };
}
