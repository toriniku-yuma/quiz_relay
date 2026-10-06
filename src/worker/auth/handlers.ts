import { createClient } from '@supabase/supabase-js';
import type { Handler, MiddlewareHandler } from 'hono';
import { contentHash } from '../catalog/hash';
import type { Env } from '../env';

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
  if (!context.env.SUPABASE_URL || !context.env.SUPABASE_PUBLISHABLE_KEY)
    return context.json({ code: 'AUTH_NOT_CONFIGURED' }, 503);
  return context.json({
    url: context.env.SUPABASE_URL,
    publishableKey: context.env.SUPABASE_PUBLISHABLE_KEY,
  });
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
  if (!context.env.SUPABASE_URL || !context.env.SUPABASE_PUBLISHABLE_KEY)
    return context.json({ code: 'AUTH_NOT_CONFIGURED' }, 503);
  if (
    context.env.API_LIMITER &&
    !(await context.env.API_LIMITER.limit({ key: `bearer:${await contentHash(bearer)}` }))
      .success
  )
    return context.json({ code: 'RATE_LIMIT' }, 429);

  const auth = createClient(
    context.env.SUPABASE_URL,
    context.env.SUPABASE_PUBLISHABLE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        fetch: (input, init) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(8000) }),
      },
    },
  );
  const { data, error } = await auth.auth.getUser(bearer.slice(7));
  if (error || !data.user || data.user.is_anonymous || !data.user.email_confirmed_at)
    return context.json({ code: 'AUTH_REQUIRED' }, 401);
  if (
    context.env.API_LIMITER &&
    !(await context.env.API_LIMITER.limit({ key: `subject:${data.user.id}` })).success
  )
    return context.json({ code: 'RATE_LIMIT' }, 429);
  context.set('subject', data.user.id);
  const displayName = data.user.user_metadata?.display_name;
  context.set(
    'displayName',
    typeof displayName === 'string' &&
      displayName.trim().length > 0 &&
      displayName.length <= 80
      ? displayName.trim()
      : '作問者',
  );
  context.set(
    'actorId',
    await contentHash({ home: context.env.GAME_OWNER, subject: data.user.id }),
  );
  await next();
};
