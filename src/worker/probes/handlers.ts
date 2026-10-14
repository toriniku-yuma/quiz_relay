import type { Handler } from 'hono';
import { authConfig } from '../auth/config.ts';
import type { Env } from '../env.ts';
import { peerRequest, rejectRedirect } from '../federation/egress.ts';
import { INBOX_PATH, signatureProbe } from '../federation/signatures.ts';
import { probeDatabase } from './database.ts';

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
    databaseConfigured: Boolean(context.env.GAME_D1),
    authConfigured: Boolean(authConfig(context.env)),
  });

export const getDurableObject: Handler<{ Bindings: Env }> = async (context) =>
  context.json(await context.env.PROBE.getByName('verification').snapshot());

export const incrementDurableObject: Handler<{ Bindings: Env }> = async (context) =>
  context.json(await context.env.PROBE.getByName('verification').increment());

// CLI/test-only WebSocket: Authorization header required; token never appears in URL.
export const openSocket: Handler<{ Bindings: Env }> = (context) =>
  context.env.PROBE.getByName('verification').fetch(context.req.raw);

export const checkSignature: Handler<{ Bindings: Env }> = async (context) =>
  context.json(await signatureProbe());

export const checkDatabase: Handler<{ Bindings: Env }> = async (context) => {
  if (!context.env.GAME_D1) return context.json({ code: 'DATABASE_NOT_CONFIGURED' }, 503);

  return context.json(await probeDatabase(context.env.GAME_D1));
};

export const getAuthConfig: Handler<{ Bindings: Env }> = (context) => {
  const config = authConfig(context.env);
  if (!config) return context.json({ code: 'AUTH_NOT_CONFIGURED' }, 503);

  return context.json(config);
};
