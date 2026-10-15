import type { Context, Handler, MiddlewareHandler } from 'hono';
import type { AuthEnv } from '../auth/handlers.ts';
import { matchmaker } from '../matchmaking/instance.ts';
import { canViewInstance, OrganizationError } from './access.ts';
import {
  accountPermissions,
  addInstance,
  organizationDatabase,
  overview,
  publishInstance,
  renameInstance,
  renameOrganization,
  resolveInstance,
  setInstanceGrants,
  setInstanceSelection,
  setupOrganization,
} from './database.ts';
import { requestInstanceDeletion } from './deletion.ts';
import { changeInstanceOperation } from './operations.ts';
import { saveProfile } from './profile.ts';

export const organizationOverview: Handler<AuthEnv> = async (context) => {
  const { db, close } = organizationDatabase(context.env);
  try {
    const input = (await context.req.json().catch(() => ({}))) as {
      accountCursor?: string;
    } | null;
    const cursor = input?.accountCursor;
    return context.json(
      await overview(
        db,
        context.get('subject'),
        context.env.INITIAL_ADMIN_SUBJECT,
        cursor,
        context.env.GAME_CONFIG_PROFILE,
      ),
    );
  } finally {
    await close();
  }
};

export const mutateOrganization: Handler<AuthEnv> = async (context) => {
  const input: unknown = await context.req.json().catch(() => null);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new OrganizationError('INVALID_SETUP', 400);
  const { db, close } = organizationDatabase(context.env);
  try {
    const value = input as Record<string, unknown>;
    if (context.req.path.endsWith('/selection'))
      return context.json(await setInstanceSelection(db, context.get('subject'), value));
    if (context.req.path.endsWith('/delete'))
      return context.json(
        await requestInstanceDeletion(db, context.env, context.get('subject'), value),
      );
    if (context.req.path.endsWith('/operation')) {
      await changeInstanceOperation(db, context.get('subject'), value);
      await matchmaker(context.env)
        .refreshInstanceWaiting(String(value.id))
        .catch(() => undefined);
      return context.json({ ok: true });
    }
    if (context.req.path.endsWith('/profile'))
      return context.json(
        await saveProfile(
          db,
          context.get('subject'),
          value,
          context.env.GAME_CONFIG_PROFILE,
        ),
      );
    if (context.req.path.endsWith('/permissions'))
      return context.json(await accountPermissions(db, context.get('subject'), value));
    if (context.req.path.endsWith('/setup'))
      await setupOrganization(db, context.env, context.get('subject'), value);
    else if (context.req.path.endsWith('/settings'))
      await renameOrganization(db, context.get('subject'), value);
    else if (context.req.path.endsWith('/add'))
      await addInstance(db, context.get('subject'), value);
    else if (context.req.path.endsWith('/rename'))
      await renameInstance(db, context.get('subject'), value);
    else if (context.req.path.endsWith('/grants')) {
      await setInstanceGrants(db, context.get('subject'), value);
      await resolveInstance(db, context.get('subject'), String(value.id));
      // Admission checks also enforce the current permissions when notification fails.
      await matchmaker(context.env)
        .refreshWaiting(String(value.actorId), String(value.id))
        .catch(() => undefined);
    } else if (context.req.path.endsWith('/publish'))
      await publishInstance(db, context.get('subject'), value);
    else throw new OrganizationError('INVALID_OPERATION', 400);
    return context.json({ ok: true });
  } finally {
    await close();
  }
};

const contextFor =
  (existingParticipation: boolean): MiddlewareHandler<AuthEnv> =>
  async (context, next) => {
    const { db, close } = organizationDatabase(context.env);
    try {
      const { organization, account, instance, permissions } = await resolveInstance(
        db,
        context.get('subject'),
        context.req.query('instance') ?? '',
        existingParticipation,
      );
      if (
        !existingParticipation &&
        !canViewInstance(instance.state, account.administrator, permissions)
      )
        throw new OrganizationError('INSTANCE_PREPARING', 409);
      if (
        !existingParticipation &&
        context.req.path.startsWith('/api/matchmaking/') &&
        instance.rankedPauseReason &&
        !account.administrator &&
        !permissions.length
      )
        throw new OrganizationError('RANKED_PAUSED', 409);
      context.set('actorId', account.actorId);
      context.set('profileName', account.displayName ?? null);
      context.set('organizationId', organization.id);
      context.set('instanceId', instance.id);
      context.set('instanceOwner', instance.owner);
    } finally {
      await close();
    }
    await next();
  };

export const instanceContext = contextFor(false);
export const existingInstanceContext = contextFor(true);

export const organizationFailure = (context: Context<AuthEnv>) =>
  context.json({ code: 'INVALID_SETUP' }, 413);
