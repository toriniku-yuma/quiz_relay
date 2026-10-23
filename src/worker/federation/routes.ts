import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { API_PATHS } from '../../shared/api-paths.ts';
import { type AuthEnv, authenticate, sameOrigin } from '../auth/handlers.ts';
import { OrganizationError } from '../organization/access.ts';
import { organizationDatabase } from '../organization/database.ts';
import { externalInstanceDirectory, favoriteExternalInstance } from './directory.ts';
import { preparePeer, publicPeerKey, resolveExternalInstance } from './discovery.ts';
import { federationOverview, manageFederation } from './management.ts';
import { localMetadata, METADATA_PATH, syncPeerMetadata } from './metadata.ts';
import {
  foreignLoginExchange,
  foreignLoginJoin,
  foreignLoginLogout,
  foreignLoginTickets,
  foreignLoginView,
  participationAuthorize,
  participationCancel,
  participationConfig,
  participationExchange,
  participationReservations,
  participationResume,
  participationSocket,
  participationTickets,
  participationValidation,
  participationView,
} from './participation-handlers.ts';
import { sharedQuestionManagement, sharedQuestionSync } from './question-handlers.ts';
import { ownForeignResults, resultInbox, resultReview } from './result-handlers.ts';
import {
  foreignLoginRoomActions,
  foreignRoomActions,
  foreignRoomSocket,
} from './room-handlers.ts';
import { federationDatabase, receiveDelivery, signedDelivery } from './transport.ts';

const federation = new Hono<AuthEnv>();
federation.get(API_PATHS.federationKey, (context) =>
  context.json(publicPeerKey(context.env)),
);
federation.post(API_PATHS.federationQuestionSync, sharedQuestionSync);
federation.post(
  API_PATHS.federationQuestions,
  sameOrigin,
  bodyLimit({ maxSize: 16384 }),
  authenticate,
  sharedQuestionManagement,
);
federation.post(API_PATHS.federationInbox, resultInbox);
federation.post(API_PATHS.federationReview, resultReview);
federation.post(
  API_PATHS.federationResults,
  sameOrigin,
  bodyLimit({ maxSize: 4096 }),
  authenticate,
  ownForeignResults,
);
federation.use('/api/v1/participation/*', async (context, next) => {
  const limiter = context.env.API_LIMITER;
  if (!limiter) return context.json({ code: 'RATE_LIMITER_NOT_CONFIGURED' }, 503);
  if (
    !(
      await limiter.limit({
        key: `participation-ip:${context.req.header('CF-Connecting-IP') ?? 'local'}`,
      })
    ).success
  )
    return context.json({ code: 'RATE_LIMIT' }, 429);
  await next();
});
federation.post(
  API_PATHS.participationTickets,
  sameOrigin,
  bodyLimit({ maxSize: 4096 }),
  authenticate,
  participationTickets,
);
federation.post(
  API_PATHS.foreignLoginTickets,
  sameOrigin,
  bodyLimit({ maxSize: 4096 }),
  authenticate,
  foreignLoginTickets,
);
federation.post(API_PATHS.participationReservations, participationReservations);
federation.post(API_PATHS.participationValidation, participationValidation);
federation.post(API_PATHS.participationAuthorize, participationAuthorize);
federation.use('/api/v1/participation/*', sameOrigin);
federation.post(
  API_PATHS.foreignLoginJoin,
  bodyLimit({ maxSize: 4096 }),
  foreignLoginJoin,
);
federation.post(
  `${API_PATHS.foreignLoginRooms}/:action`,
  bodyLimit({ maxSize: 2 * 1024 * 1024 }),
  foreignLoginRoomActions,
);
federation.post(
  API_PATHS.foreignLoginExchange,
  bodyLimit({ maxSize: 20000 }),
  foreignLoginExchange,
);
federation.post(
  API_PATHS.foreignLoginSession,
  bodyLimit({ maxSize: 1024 }),
  foreignLoginView,
);
federation.post(
  API_PATHS.foreignLoginLogout,
  bodyLimit({ maxSize: 1024 }),
  foreignLoginLogout,
);
federation.post(
  API_PATHS.participationExchange,
  bodyLimit({ maxSize: 20000 }),
  participationExchange,
);
federation.post(
  API_PATHS.participationSession,
  bodyLimit({ maxSize: 1024 }),
  participationView,
);
federation.post(
  API_PATHS.participationConfig,
  bodyLimit({ maxSize: 1024 }),
  participationConfig,
);
federation.post(
  API_PATHS.participationResume,
  bodyLimit({ maxSize: 1024 }),
  participationResume,
);
federation.post(
  API_PATHS.participationCancel,
  bodyLimit({ maxSize: 1024 }),
  participationCancel,
);
federation.get(API_PATHS.participationSocket, participationSocket);
federation.get(API_PATHS.participationRoomSocket, foreignRoomSocket);
federation.post(
  `${API_PATHS.participationRooms}/:action`,
  bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (context) => context.json({ code: 'INVALID_SETUP' }, 413),
  }),
  foreignRoomActions,
);
federation.post(
  API_PATHS.federationDirectory,
  sameOrigin,
  bodyLimit({ maxSize: 4096 }),
  authenticate,
  async (context) => {
    const input: unknown = await context.req.json().catch(() => null);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
    const value = input as Record<string, unknown>,
      { db } = organizationDatabase(context.env);
    if (value.operation === 'syncMetadata')
      return context.json(
        await syncPeerMetadata(context.env, context.get('subject'), value),
      );
    if (value.operation === 'favorite')
      return context.json(
        await favoriteExternalInstance(db, context.get('subject'), value),
      );
    if (value.operation === 'resolve')
      return context.json(
        await resolveExternalInstance(context.env, context.get('subject'), value),
      );
    if (value.operation === 'catalog' && Object.keys(value).length === 1)
      return context.json(
        await externalInstanceDirectory(db, context.get('subject'), true),
      );
    if (value.operation !== 'overview' || Object.keys(value).length !== 1)
      throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
    return context.json(await externalInstanceDirectory(db, context.get('subject')));
  },
);
federation.post(
  API_PATHS.federationManage,
  sameOrigin,
  bodyLimit({ maxSize: 65536 }),
  authenticate,
  async (context) => {
    const input: unknown = await context.req.json().catch(() => null);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
    const { db } = organizationDatabase(context.env);
    const value = input as Record<string, unknown>;
    if (value.operation === 'overview' && Object.keys(value).length !== 1)
      throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
    if (value.operation === 'preparePeer')
      return context.json(await preparePeer(context.env, context.get('subject'), value));
    if (value.operation === 'syncMetadata')
      return context.json(
        await syncPeerMetadata(context.env, context.get('subject'), value),
      );
    return context.json(
      value.operation === 'overview'
        ? await federationOverview(db, context.get('subject'))
        : await manageFederation(db, context.get('subject'), value),
    );
  },
);
federation.post(METADATA_PATH, async (context) => {
  const delivery = await receiveDelivery(
    context.req.raw,
    context.env,
    'metadata.request',
  );
  const body = await localMetadata(
    federationDatabase(context.env),
    delivery.issuer,
    delivery.body,
  );
  return context.json({
    message: await signedDelivery(
      context.env,
      delivery.issuer,
      METADATA_PATH,
      'metadata.response',
      body,
      { replyTo: delivery.nonce },
    ),
  });
});
export default federation;
