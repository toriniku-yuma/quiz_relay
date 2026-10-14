import type { GameRoom } from './game/GameRoom.ts';
import type { Matchmaker } from './matchmaking/Matchmaker.ts';
import type { Probe } from './probes/Probe.ts';

export interface Env {
  GAME_D1?: D1Database;
  ACCOUNT_ERASURE?: Fetcher;
  API_LIMITER?: RateLimit;
  FEDERATION_LIMITER?: RateLimit;
  PROBE: DurableObjectNamespace<Probe>;
  MATCHMAKER: DurableObjectNamespace<Matchmaker>;
  QUESTION_DIFFICULTY_ENABLED?: string;
  INITIAL_ADMIN_SUBJECT?: string;
  GAME_CONFIG_PROFILE: string;
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
  LOCAL_GAME_ENABLED?: string;
  ASSETS: Fetcher;
  PROBES_ENABLED: string;
  ROOM_LIFECYCLE_LOGS?: string;
  PROBE_TOKEN?: string;
  PROBE_ORIGIN?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_SECRET_KEY?: string;
  CLERK_JWT_KEY?: string;
  FEDERATION_ORIGIN?: string;
  SIGNING_KID?: string;
  SIGNING_PRIVATE_KEY?: string;
}
