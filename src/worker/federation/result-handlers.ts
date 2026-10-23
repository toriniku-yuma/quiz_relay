import type { Handler } from 'hono';
import { API_PATHS } from '../../shared/api-paths.ts';
import type { AuthEnv } from '../auth/handlers.ts';
import { OrganizationError } from '../organization/access.ts';
import { receiveControlEvent } from './controls.ts';
import { verifyEvent } from './events.ts';
import {
  foreignHistory,
  hostResultReview,
  receiveResultEvent,
  reviewForeignResult,
} from './results.ts';
import { receiveDelivery, signedDelivery } from './transport.ts';

export const resultInbox: Handler<AuthEnv> = async (context) => {
  const delivery = await receiveDelivery(context.req.raw, context.env, 'event', 100000);
  if (
    !delivery.body ||
    typeof delivery.body !== 'object' ||
    Array.isArray(delivery.body) ||
    Object.keys(delivery.body).join(',') !== 'event'
  )
    throw new OrganizationError('INVALID_RESULT_EVENT', 400);
  const payload = await verifyEvent(context.env, delivery.issuer, delivery.body.event);
  const receive =
    payload && typeof payload === 'object' && 'type' in payload
      ? receiveControlEvent
      : receiveResultEvent;
  const receipt = await receive(context.env, delivery.issuer, delivery.body.event);
  if (receive === receiveControlEvent && !receipt.applied) {
    if (!context.env.ACCOUNT_ERASURE)
      throw new OrganizationError('ERASURE_UNAVAILABLE', 503);
    const response = await context.env.ACCOUNT_ERASURE.fetch(
      'https://account-erasure.internal/maintenance',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: 'federationControlApply',
          peerOrigin: delivery.issuer,
          eventId: receipt.eventId,
        }),
      },
    );
    receipt.applied = response.ok;
    await response.arrayBuffer();
  }
  return context.json(
    {
      message: await signedDelivery(
        context.env,
        delivery.issuer,
        API_PATHS.federationInbox,
        'event.receipt',
        receipt,
        { replyTo: delivery.nonce },
      ),
    },
    receipt.duplicate ? 200 : 202,
  );
};
export const resultReview: Handler<AuthEnv> = async (context) => {
  const delivery = await receiveDelivery(context.req.raw, context.env, 'event', 16384),
    body = await hostResultReview(context.env, delivery.issuer, delivery.body);
  return context.json({
    message: await signedDelivery(
      context.env,
      delivery.issuer,
      API_PATHS.federationReview,
      'event.receipt',
      body,
      { replyTo: delivery.nonce },
    ),
  });
};
export const ownForeignResults: Handler<AuthEnv> = async (context) => {
  const input = await context.req.json().catch(() => null);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
  if (
    input.operation === 'history' &&
    Object.keys(input).every((key) => ['operation', 'cursor'].includes(key))
  )
    return context.json(
      await foreignHistory(context.env, context.get('subject'), input.cursor),
    );
  if (
    input.operation === 'review' &&
    Object.keys(input).sort().join(',') === 'eventId,operation,peerOrigin'
  )
    return context.json(
      await reviewForeignResult(
        context.env,
        context.get('subject'),
        input.peerOrigin,
        input.eventId,
      ),
    );
  throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
};
