import { sql } from 'drizzle-orm';
import { federationActors, organizationAccounts } from '../db/schema.ts';

// Drizzle unqualifies Column chunks in a single-table SELECT. Keep these
// correlated IDs explicit so the subquery does not become actor_id = actor_id.
const matchingActor = sql`"quiz_federation_actors"."actor_id" = "quiz_game_organization_accounts"."actor_id"`;

export const accountDisplayName = sql<
  string | null
>`coalesce(${organizationAccounts.displayName},
  (select ${federationActors.displayName} from ${federationActors}
    where ${matchingActor}))`;
export const accountHomeOrigin = (localOrigin: string) => sql<string>`coalesce(
  (select ${federationActors.peerOrigin} from ${federationActors}
    where ${matchingActor}), ${localOrigin})`;
