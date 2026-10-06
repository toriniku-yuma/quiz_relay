import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { API_PATHS } from '../../shared/api-paths';
import { type AuthEnv, authenticate, sameOrigin } from '../auth/handlers';
import {
  mutateOrganization,
  organizationFailure,
  organizationOverview,
} from './handlers';
import { manageUsers } from './moderation-handlers';
import { accountWithdrawal, withdrawalStatus } from './withdrawal-handlers';

const organization = new Hono<AuthEnv>();
organization.use('/api/organization/*', sameOrigin);
organization.use('/api/organization/*', (c, next) =>
  bodyLimit({
    maxSize:
      c.req.path === API_PATHS.moderationMutate
        ? 1000000
        : c.req.path.startsWith(API_PATHS.moderationUsers)
          ? 8192
          : 2048,
    onError: organizationFailure,
  })(c, next),
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
organization.post(API_PATHS.organizationAdd, mutateOrganization);
organization.post(API_PATHS.organizationInstanceSelection, mutateOrganization);
organization.post(API_PATHS.organizationPublish, mutateOrganization);
organization.post(API_PATHS.organizationOperation, mutateOrganization);
organization.post(API_PATHS.instanceDeletion, mutateOrganization);
organization.post(API_PATHS.organizationPermissions, mutateOrganization);
organization.post(API_PATHS.organizationGrants, mutateOrganization);
organization.post(API_PATHS.organizationRename, mutateOrganization);
export default organization;
