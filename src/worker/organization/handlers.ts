import type { Context, Handler, MiddlewareHandler } from 'hono';
import type { AuthEnv } from '../auth/handlers';
import { canViewInstance, OrganizationError, organizationEnabled } from './access';
import {
  accountPermissions,
  addInstance,
  organizationDatabase,
  overview,
  publishInstance,
  renameInstance,
  resolveInstance,
  setInstanceGrants,
  setupOrganization,
} from './database';
import { requestInstanceDeletion } from './deletion';
import { changeInstanceOperation } from './operations';
import { saveProfile } from './profile';

export const organizationOverview: Handler<AuthEnv> = async (c) => {
  if (!organizationEnabled(c.env)) return c.json({ enabled: false, instances: [] });
  const { db, close } = organizationDatabase(c.env);
  try {
    const input = (await c.req.json().catch(() => ({}))) as {
      accountCursor?: string;
    } | null;
    const cursor = input?.accountCursor;
    return c.json(
      await overview(
        db,
        c.get('subject'),
        c.env.INITIAL_ADMIN_SUBJECT,
        cursor,
        c.env.GAME_CONFIG_PROFILE,
      ),
    );
  } finally {
    await close();
  }
};

export const mutateOrganization: Handler<AuthEnv> = async (c) => {
  if (!organizationEnabled(c.env))
    throw new OrganizationError('ORGANIZATION_UNAVAILABLE', 503);
  const input: unknown = await c.req.json().catch(() => null);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new OrganizationError('INVALID_SETUP', 400);
  const { db, close } = organizationDatabase(c.env);
  try {
    const value = input as Record<string, unknown>;
    if (c.req.path.endsWith('/delete'))
      return c.json(await requestInstanceDeletion(db, c.env, c.get('subject'), value));
    if (c.req.path.endsWith('/operation')) {
      const result = await changeInstanceOperation(db, c.get('subject'), value);
      await c.env.MATCHMAKER.getByName(result.organizationId)
        .refreshInstanceWaiting(String(value.id))
        .catch(() => undefined);
      return c.json({ ok: true });
    }
    if (c.req.path.endsWith('/profile'))
      return c.json(
        await saveProfile(db, c.get('subject'), value, c.env.GAME_CONFIG_PROFILE),
      );
    if (c.req.path.endsWith('/permissions'))
      return c.json(await accountPermissions(db, c.get('subject'), value));
    if (c.req.path.endsWith('/setup'))
      await setupOrganization(db, c.env, c.get('subject'), value);
    else if (c.req.path.endsWith('/add')) await addInstance(db, c.get('subject'), value);
    else if (c.req.path.endsWith('/rename'))
      await renameInstance(db, c.get('subject'), value);
    else if (c.req.path.endsWith('/grants')) {
      await setInstanceGrants(db, c.get('subject'), value);
      const { organization } = await resolveInstance(
        db,
        c.get('subject'),
        String(value.id),
      );
      // Durable room checks still block admission if notification fails; the queue alarm retries cleanup.
      await c.env.MATCHMAKER.getByName(organization.id)
        .refreshWaiting(String(value.actorId), String(value.id))
        .catch(() => undefined);
    } else if (c.req.path.endsWith('/publish'))
      await publishInstance(db, c.get('subject'), value);
    else throw new OrganizationError('INVALID_OPERATION', 400);
    return c.json({ ok: true });
  } finally {
    await close();
  }
};

const contextFor =
  (existingParticipation: boolean): MiddlewareHandler<AuthEnv> =>
  async (c, next) => {
    if (!organizationEnabled(c.env)) {
      c.set('instanceOwner', c.env.GAME_OWNER);
      c.set('instanceId', '');
      c.set('organizationId', c.env.GAME_OWNER);
    } else {
      const { db, close } = organizationDatabase(c.env);
      try {
        const { organization, account, instance, permissions } = await resolveInstance(
          db,
          c.get('subject'),
          c.req.query('instance') ?? '',
          existingParticipation,
        );
        if (
          !existingParticipation &&
          !canViewInstance(instance.state, account.administrator, permissions ?? [])
        )
          throw new OrganizationError('INSTANCE_PREPARING', 409);
        if (
          !existingParticipation &&
          c.req.path.startsWith('/api/matchmaking/') &&
          instance.rankedPauseReason &&
          !account.administrator &&
          !permissions.length
        )
          throw new OrganizationError('RANKED_PAUSED', 409);
        c.set('actorId', account.actorId);
        c.set('profileName', account.displayName ?? null);
        c.set('organizationId', organization.id);
        c.set('instanceId', instance.id);
        c.set('instanceOwner', instance.owner);
      } finally {
        await close();
      }
    }
    await next();
  };

export const instanceContext = contextFor(false);
export const existingInstanceContext = contextFor(true);

export const organizationFailure = (c: Context<AuthEnv>) =>
  c.json({ code: 'INVALID_SETUP' }, 413);
