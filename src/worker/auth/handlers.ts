import { createClient } from '@supabase/supabase-js';
import type { Handler, MiddlewareHandler } from 'hono';
import { contentHash } from '../catalog/hash.ts';
import type { Env } from '../env.ts';
import { authenticateClerk } from './clerk.ts';
import { authConfig } from './config.ts';

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
  const config = authConfig(context.env);
  if (!config) return context.json({ code: 'AUTH_NOT_CONFIGURED' }, 503);
  if (
    context.env.API_LIMITER &&
    !(await context.env.API_LIMITER.limit({ key: `bearer:${await contentHash(bearer)}` }))
      .success
  )
    return context.json({ code: 'RATE_LIMIT' }, 429);

  let identity: { subject: string; displayName: string } | null;
  if (config.provider === 'clerk') {
    try {
      identity = await authenticateClerk(context.req.raw, context.env);
    } catch (error) {
      return context.json(
        {
          code:
            error instanceof Error && error.message === 'INVALID_AUTH_MAPPING'
              ? 'AUTH_MAPPING_REQUIRED'
              : 'AUTH_UNAVAILABLE',
        },
        503,
      );
    }
  } else {
    const auth = createClient(config.url, config.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        fetch: (input, init) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(8000) }),
      },
    });
    const { data, error } = await auth.auth.getUser(bearer.slice(7));
    if (error || !data.user || data.user.is_anonymous || !data.user.email_confirmed_at)
      return context.json({ code: 'AUTH_REQUIRED' }, 401);
    const { data: verified, error: claimsError } = await auth.auth.getClaims(
      bearer.slice(7),
    );
    if (
      claimsError ||
      verified?.claims.sub !== data.user.id ||
      !verified.claims.amr?.some(
        (method) => typeof method === 'object' && method.method === 'oauth',
      )
    )
      return context.json({ code: 'SOCIAL_LOGIN_REQUIRED' }, 401);
    const displayName = data.user.user_metadata?.display_name;
    identity = {
      subject: data.user.id,
      displayName:
        typeof displayName === 'string' &&
        displayName.trim().length > 0 &&
        displayName.length <= 80
          ? displayName.trim()
          : '作問者',
    };
  }
  if (!identity) return context.json({ code: 'AUTH_REQUIRED' }, 401);
  if (
    context.env.API_LIMITER &&
    !(await context.env.API_LIMITER.limit({ key: `subject:${identity.subject}` })).success
  )
    return context.json({ code: 'RATE_LIMIT' }, 429);
  context.set('subject', identity.subject);
  context.set('displayName', identity.displayName);
  context.set(
    'actorId',
    await contentHash({ home: context.env.GAME_OWNER, subject: identity.subject }),
  );
  await next();
};
