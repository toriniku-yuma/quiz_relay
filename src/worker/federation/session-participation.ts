import { and, eq } from 'drizzle-orm';
import { API_PATHS } from '../../shared/api-paths.ts';
import { organizationAccounts } from '../db/schema.ts';
import type { Env } from '../env.ts';
import { failureDetails } from '../http/diagnostics.ts';
import { OrganizationError, validId } from '../organization/access.ts';
import { foreignLoginSession } from './login.ts';
import {
  exchangeParticipation,
  issueParticipation,
  participationMode,
  prepareParticipation,
  type ReservationRequest,
  reserveParticipation,
} from './participation.ts';
import { verifyParticipationGrant, verifyParticipationTicket } from './tickets.ts';
import { federationDatabase, requestPeer } from './transport.ts';

function request(value: unknown, keys: string) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys
  )
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  return value as Record<string, unknown>;
}

export async function authorizeSessionParticipation(
  env: Env,
  peerOrigin: string,
  value: unknown,
) {
  if (!value || typeof value !== 'object' || !('phase' in value))
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  const phase = value.phase;
  if (phase !== 'prepare' && phase !== 'issue')
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  const input = request(
    value,
    phase === 'prepare'
      ? 'grant,hostInstanceId,mode,operationId,phase'
      : 'authorizationId,grant,hostInstanceId,mode,operationId,phase,reservation',
  );
  const proof = await verifyParticipationGrant(env, peerOrigin, input.grant);
  const db = federationDatabase(env);
  const [account] = await db
    .select()
    .from(organizationAccounts)
    .where(
      and(
        eq(organizationAccounts.actorId, proof.actorId),
        eq(organizationAccounts.organizationId, proof.organizationId),
      ),
    );
  if (!account || account.withdrawnAt)
    throw new OrganizationError('ACCOUNT_WITHDRAWN', 403);
  const authorization = {
    peerOrigin,
    sourceOrganizationId: proof.organizationId,
    hostInstanceId: validId(input.hostInstanceId),
    mode: participationMode(input.mode),
    operationId: validId(input.operationId),
  };
  if (phase === 'prepare') {
    const prepared = await prepareParticipation(env, account.subject, authorization);
    return { reservation: prepared.reservation };
  }
  return issueParticipation(
    env,
    account.subject,
    authorization,
    validId(input.authorizationId),
    input.reservation,
  );
}

export async function joinForeignLogin(env: Env, secret: string, value: unknown) {
  const input = request(value, 'hostInstanceId,mode,operationId');
  let stage = 'login.read';
  const startedAt = Date.now();
  let operationId: string | undefined;
  try {
    const login = await foreignLoginSession(env, secret);
    const hostInstanceId = validId(input.hostInstanceId);
    const mode = participationMode(input.mode);
    operationId = validId(input.operationId);
    const home = async (body: Record<string, unknown>) => {
      const response = await requestPeer(
        env,
        login.peerOrigin,
        API_PATHS.participationAuthorize,
        'reservation.request',
        'reservation.response',
        { grant: login.grant, hostInstanceId, mode, operationId, ...body },
        32768,
        true,
      );
      if (
        response.body &&
        typeof response.body === 'object' &&
        !Array.isArray(response.body) &&
        Object.keys(response.body).sort().join(',') === 'code,status'
      ) {
        const denied = response.body as { code: unknown; status: unknown };
        if (
          typeof denied.code !== 'string' ||
          !/^[A-Z_]{3,80}$/.test(denied.code) ||
          (denied.status !== 401 && denied.status !== 403 && denied.status !== 409)
        )
          throw new OrganizationError('INVALID_PARTICIPATION', 503);
        throw new OrganizationError(denied.code, denied.status);
      }
      return response.body;
    };
    stage = 'home.prepare';
    const prepared = request(await home({ phase: 'prepare' }), 'reservation');
    const authorization = prepared.reservation as ReservationRequest;
    if (
      !authorization ||
      authorization.actorId !== login.sourceActorId ||
      authorization.sourceOrganizationId !== login.sourceOrganizationId ||
      authorization.hostInstanceId !== hostInstanceId ||
      authorization.mode !== mode ||
      authorization.operationId !== operationId
    )
      throw new OrganizationError('PARTICIPATION_TICKET_BINDING', 401);
    stage = 'login.recheck';
    await foreignLoginSession(env, secret);
    stage = 'host.reserve';
    const reservation = await reserveParticipation(env, login.peerOrigin, authorization);
    stage = 'home.issue';
    const result = request(
      await home({
        phase: 'issue',
        authorizationId: authorization.authorizationId,
        reservation,
      }),
      'expiresAt,ticket',
    );
    stage = 'ticket.verify';
    const proof = await verifyParticipationTicket(env, result.ticket);
    if (
      proof.iss !== login.peerOrigin ||
      proof.sub !== login.sourceActorId ||
      proof.sourceOrganizationId !== login.sourceOrganizationId ||
      proof.hostInstanceId !== hostInstanceId ||
      proof.mode !== mode ||
      proof.reservationId !== reservation.reservationId ||
      proof.matchId !== reservation.matchId ||
      proof.authorizationId !== authorization.authorizationId
    )
      throw new OrganizationError('PARTICIPATION_TICKET_BINDING', 401);
    stage = 'login.confirm';
    await foreignLoginSession(env, secret);
    stage = 'host.exchange';
    const joined = await exchangeParticipation(env, { ticket: result.ticket }, secret);
    console.log(
      JSON.stringify({
        event: 'federation_join_completed',
        operationId,
        elapsedMs: Date.now() - startedAt,
      }),
    );
    return joined;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'federation_join_failed',
        operationId,
        stage,
        elapsedMs: Date.now() - startedAt,
        ...failureDetails(error),
        ...(error instanceof OrganizationError ? { code: error.code } : {}),
      }),
    );
    throw error;
  }
}
