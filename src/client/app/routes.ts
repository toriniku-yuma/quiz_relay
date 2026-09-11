import DebugPage from '../pages/DebugPage';
import { DEBUG_PATH } from './paths';

export const routes = [
  { path: '/', redirectTo: DEBUG_PATH },
  { path: DEBUG_PATH, component: DebugPage },
] as const;
