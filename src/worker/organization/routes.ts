import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { API_PATHS } from '../../shared/api-paths.ts';
import { type AuthEnv, authenticate, sameOrigin } from '../auth/handlers.ts';
import {
  mutateOrganization,
  organizationFailure,
  organizationOverview,
} from './handlers.ts';
import { manageUsers } from './moderation-handlers.ts';
import { accountWithdrawal, withdrawalStatus } from './withdrawal-handlers.ts';

const organization = new Hono<AuthEnv>();
organization.use('/api/organization/*', sameOrigin);
organization.use('/api/organization/*', (context, next) =>
  bodyLimit({
    maxSize:
      context.req.path === API_PATHS.moderationMutate
        ? 1000000
        : context.req.path.startsWith(API_PATHS.moderationUsers)
          ? 8192
          : 2048,
    onError: organizationFailure,
  })(context, next),
);
organization.post(API_PATHS.withdrawalStatus, withdrawalStatus);
organization.use('/api/organization/*', authenticate);
organization.post(API_PATHS.accountWithdrawal, accountWithdrawal);
organization.post(API_PATHS.organizationOverview, organizationOverview);
organization.post(API_PATHS.organizationProfile, mutateOrganization);
organization.post(API_PATHS.moderationUsers, manageUsers);
organization.post(API_PATHS.moderationWorkflow, manageUsers);
organization.post(API_PATHS.moderationHistory, manageUsers);
organization.post(API_PATHS.moderationMutate, manageUsers);
organization.post(API_PATHS.moderationPersonal, manageUsers);
organization.post(API_PATHS.organizationSetup, mutateOrganization);
organization.post(API_PATHS.organizationSettings, mutateOrganization);
organization.post(API_PATHS.organizationAdd, mutateOrganization);
organization.post(API_PATHS.organizationInstanceSelection, mutateOrganization);
organization.post(API_PATHS.organizationPublish, mutateOrganization);
organization.post(API_PATHS.organizationOperation, mutateOrganization);
organization.post(API_PATHS.instanceDeletion, mutateOrganization);
organization.post(API_PATHS.organizationPermissions, mutateOrganization);
organization.post(API_PATHS.organizationGrants, mutateOrganization);
organization.post(API_PATHS.organizationRename, mutateOrganization);
export default organization;
