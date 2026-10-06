import type { Handler } from 'hono';
import type { Env } from '../env';
import { peerRequest, rejectRedirect } from '../federation/egress';
import { INBOX_PATH, signatureProbe } from '../federation/signatures';
import { probeDatabase } from './database';

// Fixed, public self-target only. Never forwards incoming credentials or URLs.
export const checkEgress: Handler<{ Bindings: Env }> = async (context) => {
  const target = 'https://quiz-relay-probe.quiz-relay.workers.dev';
  const request = peerRequest(target, [target], INBOX_PATH, 'public-egress-probe');
  const response = rejectRedirect(
    await fetch(request, { signal: AbortSignal.timeout(5000) }),
  );

  // No real federation inbox exists yet. The known JSON 404 proves this Worker was reached.
  const result = (await response.json()) as { code?: string };
  if (response.status !== 404 || result.code !== 'NOT_FOUND')
    throw new Error('EGRESS_TARGET');

  return context.json({
    reached: true,
    profile: 'approved-workers-dev',
    inboxImplemented: false,
  });
};

export const getStatus: Handler<{ Bindings: Env }> = (context) =>
  context.json({
    databaseConfigured: Boolean(context.env.HYPERDRIVE || context.env.DATABASE_URL),
    authConfigured: Boolean(
      context.env.SUPABASE_URL && context.env.SUPABASE_PUBLISHABLE_KEY,
    ),
  });

export const getDurableObject: Handler<{ Bindings: Env }> = async (context) =>
  context.json(await context.env.PROBE.getByName('phase-0').snapshot());

export const incrementDurableObject: Handler<{ Bindings: Env }> = async (context) =>
  context.json(await context.env.PROBE.getByName('phase-0').increment());

// CLI/test-only WebSocket: Authorization header required; token never appears in URL.
export const openSocket: Handler<{ Bindings: Env }> = (context) =>
  context.env.PROBE.getByName('phase-0').fetch(context.req.raw);

export const checkSignature: Handler<{ Bindings: Env }> = async (context) =>
  context.json(await signatureProbe());

export const checkDatabase: Handler<{ Bindings: Env }> = async (context) => {
  if (context.env.HYPERDRIVE)
    return context.json(
      await probeDatabase(context.env.HYPERDRIVE.connectionString, undefined, true),
    );
  if (!context.env.DATABASE_URL)
    return context.json({ code: 'DATABASE_NOT_CONFIGURED' }, 503);

  return context.json(
    await probeDatabase(context.env.DATABASE_URL, context.env.DATABASE_CA_CERT),
  );
};

export const getAuthConfig: Handler<{ Bindings: Env }> = (context) => {
  if (!context.env.SUPABASE_URL || !context.env.SUPABASE_PUBLISHABLE_KEY)
    return context.json({ code: 'AUTH_NOT_CONFIGURED' }, 503);

  return context.json({
    url: context.env.SUPABASE_URL,
    publishableKey: context.env.SUPABASE_PUBLISHABLE_KEY,
  });
};
