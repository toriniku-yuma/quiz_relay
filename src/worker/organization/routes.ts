import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { API_PATHS } from '../../shared/api-paths';
import { type AuthEnv, authenticate, sameOrigin } from '../auth/handlers';
import {
  mutateOrganization,
  organizationFailure,
  organizationOverview,
} from './handlers';

const organization = new Hono<AuthEnv>();
organization.use('/api/organization/*', sameOrigin);
organization.use(
  '/api/organization/*',
  bodyLimit({ maxSize: 2048, onError: organizationFailure }),
);
organization.use('/api/organization/*', authenticate);
organization.post(API_PATHS.organizationOverview, organizationOverview);
organization.post(API_PATHS.organizationSetup, mutateOrganization);
organization.post(API_PATHS.organizationAdd, mutateOrganization);
organization.post(API_PATHS.organizationPublish, mutateOrganization);
organization.post(API_PATHS.organizationPermissions, mutateOrganization);
organization.post(API_PATHS.organizationGrants, mutateOrganization);
organization.post(API_PATHS.organizationRename, mutateOrganization);
export default organization;
