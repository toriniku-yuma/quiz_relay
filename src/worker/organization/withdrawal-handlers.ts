import { eq } from 'drizzle-orm';
import type { Handler } from 'hono';
import type { AuthEnv } from '../auth/handlers';
import { accountWithdrawals } from '../db/schema';
import { OrganizationError, validId } from './access';
import { organizationDatabase } from './database';
import { withdrawAccount } from './withdrawal';

export const accountWithdrawal: Handler<AuthEnv> = async (c) => {
  const input = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new OrganizationError('INVALID_SETUP', 400);
  const { db, close } = organizationDatabase(c.env);
  try {
    return c.json(await withdrawAccount(db, c.env, c.get('subject'), input));
  } finally {
    await close();
  }
};

// The unpredictable receipt is a capability. Expose no account identifiers or profile data.
export const withdrawalStatus: Handler<AuthEnv> = async (c) => {
  const input = await c.req.json<Record<string, unknown>>().catch(() => null);
  const id = validId(input?.operationId);
  const { db, close } = organizationDatabase(c.env);
  try {
    const [job] = await db
      .select({ completed: accountWithdrawals.authDeletedAt })
      .from(accountWithdrawals)
      .where(eq(accountWithdrawals.id, id));
    return c.json({ accepted: !!job, ready: !!job?.completed });
  } finally {
    await close();
  }
};
