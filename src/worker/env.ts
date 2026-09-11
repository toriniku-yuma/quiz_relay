import type { GameRoom } from './game/GameRoom';
import type { Probe } from './probes/Probe';

export interface Env {
  PROBE: DurableObjectNamespace<Probe>;
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
  LOCAL_GAME_ENABLED?: string;
  ASSETS: Fetcher;
  PROBES_ENABLED: string;
  PROBE_TOKEN?: string;
  PROBE_ORIGIN?: string;
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
  DATABASE_CA_CERT?: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
}
