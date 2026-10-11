import { clerkBackend, clerkSubject, legacySubjectPrefix } from '../worker/auth/clerk.ts';
import type { Env } from '../worker/env.ts';

export function clerkAuthDeletion(
  env: Pick<Env, 'CLERK_SECRET_KEY' | 'CLERK_PUBLISHABLE_KEY' | 'CLERK_JWT_KEY'>,
) {
  const client = clerkBackend(env);
  return async (subject: string) => {
    let id: string;
    if (subject.startsWith('user_')) {
      id = subject;
    } else {
      const users = await client.users.getUserList({
        externalId: [`${legacySubjectPrefix}${subject}`],
        limit: 2,
      });
      if (
        users.totalCount > 1 ||
        users.data.some((user) => clerkSubject(user) !== subject)
      )
        throw new Error('AUTH_ERASURE_MAPPING_CONFLICT');
      if (users.data.length === 0) return;
      id = users.data[0].id;
    }
    try {
      await client.users.deleteUser(id);
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
