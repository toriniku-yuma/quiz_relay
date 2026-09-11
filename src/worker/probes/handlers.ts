import type { Handler } from 'hono';
import type { Env } from '../env';
import { peerRequest, rejectRedirect } from '../federation/egress';
import { INBOX_PATH, signatureProbe } from '../federation/signatures';
import { probeDatabase } from './database';

// Fixed, public self-target only. Never forwards incoming credentials or URLs.
export const checkEgress: Handler<{ Bindings: Env }> = async (c) => {
  const target = 'https://quiz-relay-probe.quiz-relay.workers.dev';
  const request = peerRequest(target, [target], INBOX_PATH, 'public-egress-probe');
  const response = rejectRedirect(
    await fetch(request, { signal: AbortSignal.timeout(5000) }),
  );

  // No real federation inbox exists yet. The known JSON 404 proves this Worker was reached.
  const result = (await response.json()) as { code?: string };
  if (response.status !== 404 || result.code !== 'NOT_FOUND')
    throw new Error('EGRESS_TARGET');

  return c.json({
    reached: true,
    profile: 'approved-workers-dev',
    inboxImplemented: false,
  });
};

export const getStatus: Handler<{ Bindings: Env }> = (c) =>
  c.json({
    databaseConfigured: Boolean(c.env.HYPERDRIVE || c.env.DATABASE_URL),
    authConfigured: Boolean(c.env.SUPABASE_URL && c.env.SUPABASE_PUBLISHABLE_KEY),
  });

export const getDurableObject: Handler<{ Bindings: Env }> = async (c) =>
  c.json(await c.env.PROBE.getByName('phase-0').snapshot());

export const incrementDurableObject: Handler<{ Bindings: Env }> = async (c) =>
  c.json(await c.env.PROBE.getByName('phase-0').increment());

// CLI/test-only WebSocket: Authorization header required; token never appears in URL.
export const openSocket: Handler<{ Bindings: Env }> = (c) =>
  c.env.PROBE.getByName('phase-0').fetch(c.req.raw);

export const checkSignature: Handler<{ Bindings: Env }> = async (c) =>
  c.json(await signatureProbe());

export const checkDatabase: Handler<{ Bindings: Env }> = async (c) => {
  if (c.env.HYPERDRIVE)
    return c.json(
      await probeDatabase(c.env.HYPERDRIVE.connectionString, undefined, true),
    );
  if (!c.env.DATABASE_URL) return c.json({ code: 'DATABASE_NOT_CONFIGURED' }, 503);

  return c.json(await probeDatabase(c.env.DATABASE_URL, c.env.DATABASE_CA_CERT));
};

export const getAuthConfig: Handler<{ Bindings: Env }> = (c) => {
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_PUBLISHABLE_KEY)
    return c.json({ code: 'AUTH_NOT_CONFIGURED' }, 503);

  return c.json({
    url: c.env.SUPABASE_URL,
    publishableKey: c.env.SUPABASE_PUBLISHABLE_KEY,
  });
};
