import type { Handler, MiddlewareHandler } from 'hono';
import { contentHash } from '../catalog/hash.ts';
import type { Env } from '../env.ts';
import { authenticateClerk } from './clerk.ts';
import { authConfig, clerkKeys } from './config.ts';

export type AuthEnv = {
  Bindings: Env;
  Variables: {
    actorId: string;
    subject: string;
    displayName: string;
    profileName: string | null;
    instanceOwner: string;
    instanceId: string;
    organizationId: string;
  };
};

export const publicAuthConfig: Handler<AuthEnv> = (context) => {
  context.header('Cache-Control', 'no-store');
  const config = authConfig(context.env);
  if (!config) return context.json({ code: 'AUTH_NOT_CONFIGURED' }, 503);
  return context.json(config);
};

export const authIdentity: Handler<AuthEnv> = (context) => {
  context.header('Cache-Control', 'no-store');
  return context.json({ subject: context.get('subject') });
};

export const sameOrigin: MiddlewareHandler<AuthEnv> = async (context, next) => {
  context.header('Cache-Control', 'no-store');
  const origin = context.req.header('Origin');
  if (
    !origin ||
    (origin !== new URL(context.req.url).origin &&
      !(import.meta.env.DEV && origin === context.env.PROBE_ORIGIN))
  )
    return context.json({ code: 'ORIGIN_REJECTED' }, 403);
  await next();
};

export const authenticate: MiddlewareHandler<AuthEnv> = async (context, next) => {
  const bearer = context.req.header('Authorization') ?? '';
  if (!/^Bearer [A-Za-z0-9._-]+$/.test(bearer) || bearer.length > 8192)
    return context.json({ code: 'AUTH_REQUIRED' }, 401);
  const keys = clerkKeys(context.env);
  if (!keys) return context.json({ code: 'AUTH_NOT_CONFIGURED' }, 503);
  const limiter = context.env.API_LIMITER;
  if (!limiter) return context.json({ code: 'RATE_LIMITER_NOT_CONFIGURED' }, 503);
  if (!(await limiter.limit({ key: `bearer:${await contentHash(bearer)}` })).success)
    return context.json({ code: 'RATE_LIMIT' }, 429);

  let identity: Awaited<ReturnType<typeof authenticateClerk>>;
  try {
    identity = await authenticateClerk(context.req.raw, keys);
  } catch {
    return context.json({ code: 'AUTH_UNAVAILABLE' }, 503);
  }
  if (!identity) return context.json({ code: 'AUTH_REQUIRED' }, 401);
  if (!(await limiter.limit({ key: `subject:${identity.subject}` })).success)
    return context.json({ code: 'RATE_LIMIT' }, 429);
  context.set('subject', identity.subject);
  context.set('displayName', identity.displayName);
  context.set(
    'actorId',
    await contentHash({ home: context.env.GAME_OWNER, subject: identity.subject }),
  );
  await next();
};
