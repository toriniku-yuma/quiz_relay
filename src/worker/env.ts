import type { GameRoom } from './game/GameRoom';
import type { Matchmaker } from './matchmaking/Matchmaker';
import type { Probe } from './probes/Probe';

export interface Env {
  API_LIMITER?: RateLimit;
  PROBE: DurableObjectNamespace<Probe>;
  MATCHMAKER: DurableObjectNamespace<Matchmaker>;
  GAME_OWNER: string;
  ORGANIZATION_ENABLED?: string;
  ORGANIZATION_DATABASE_URL?: string;
  ORGANIZATION_HYPERDRIVE?: Hyperdrive;
  INITIAL_ADMIN_SUBJECT?: string;
  GAME_CONFIG_PROFILE: string;
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
  LOCAL_GAME_ENABLED?: string;
  ASSETS: Fetcher;
  PROBES_ENABLED: string;
  PROBE_TOKEN?: string;
  PROBE_ORIGIN?: string;
  HYPERDRIVE?: Hyperdrive;
  GAME_HYPERDRIVE?: Hyperdrive;
  GAME_DATABASE_URL?: string;
  RESULT_DATABASE_URL?: string;
  RESULT_HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
  DATABASE_CA_CERT?: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
}
