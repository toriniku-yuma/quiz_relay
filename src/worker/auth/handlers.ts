import { createClient } from '@supabase/supabase-js';
import type { Handler, MiddlewareHandler } from 'hono';
import { contentHash } from '../catalog/hash';
import type { Env } from '../env';

export type AuthEnv = { Bindings: Env; Variables: { actorId: string } };

export const publicAuthConfig: Handler<AuthEnv> = (c) => {
  c.header('Cache-Control', 'no-store');
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_PUBLISHABLE_KEY)
    return c.json({ code: 'AUTH_NOT_CONFIGURED' }, 503);
  return c.json({
    url: c.env.SUPABASE_URL,
    publishableKey: c.env.SUPABASE_PUBLISHABLE_KEY,
  });
};

export const sameOrigin: MiddlewareHandler<AuthEnv> = async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const origin = c.req.header('Origin');
  if (
    !origin ||
    (origin !== new URL(c.req.url).origin &&
      !(import.meta.env.DEV && origin === c.env.PROBE_ORIGIN))
  )
    return c.json({ code: 'ORIGIN_REJECTED' }, 403);
  await next();
};

export const authenticate: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const bearer = c.req.header('Authorization') ?? '';
  if (!/^Bearer [A-Za-z0-9._-]+$/.test(bearer) || bearer.length > 8192)
    return c.json({ code: 'AUTH_REQUIRED' }, 401);
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_PUBLISHABLE_KEY)
    return c.json({ code: 'AUTH_NOT_CONFIGURED' }, 503);

  const auth = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(8000) }),
    },
  });
  const { data, error } = await auth.auth.getUser(bearer.slice(7));
  if (error || !data.user || data.user.is_anonymous || !data.user.email_confirmed_at)
    return c.json({ code: 'AUTH_REQUIRED' }, 401);
  c.set('actorId', await contentHash({ home: c.env.GAME_OWNER, subject: data.user.id }));
  await next();
};
