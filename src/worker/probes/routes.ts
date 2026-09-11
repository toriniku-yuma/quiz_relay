import { Hono } from 'hono';
import { API_PATHS, PROBE_PREFIX } from '../../shared/api-paths';
import type { Env } from '../env';
import { authorizeProbe } from './authorize';
import {
  checkDatabase,
  checkEgress,
  checkSignature,
  getAuthConfig,
  getDurableObject,
  getStatus,
  incrementDurableObject,
  openSocket,
} from './handlers';

const app = new Hono<{ Bindings: Env }>();

app.use(`${PROBE_PREFIX}/*`, authorizeProbe);

app.post(API_PATHS.egress, checkEgress);
app.get(API_PATHS.status, getStatus);
app.get(API_PATHS.durableObject, getDurableObject);
app.post(API_PATHS.durableObject, incrementDurableObject);
app.get(API_PATHS.socket, openSocket);
app.post(API_PATHS.signature, checkSignature);
app.post(API_PATHS.database, checkDatabase);
app.get(API_PATHS.authConfig, getAuthConfig);

export default app;
