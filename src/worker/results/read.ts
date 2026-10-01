import { and, asc, desc, eq, notInArray, sql, sum } from 'drizzle-orm';
import type { ResultsOverview } from '../../shared/results';
import type { connectDatabase } from '../db/connection';
import { resultPlayers as p, matchResults as r } from '../db/schema.ts';
import { ratingPolicy } from './rating.ts';

export async function readResults(
  db: Pick<ReturnType<typeof connectDatabase>['db'], 'transaction'>,
  owner: string,
  actorId: string,
  excludedActors: string[] = [],
): Promise<ResultsOverview> {
  // ponytail: 全期間の直接集計。実測で遅くなったら同じ原本から再生成できる投影を追加する。
  return db.transaction(
    async (tx): Promise<ResultsOverview> => {
      const ranking = await tx
        .select({
          actorId: p.actorId,
          name: sql<string>`(array_agg(${p.name} order by ${r.finishedAt} desc, ${r.resultId} desc))[1]`,
          rating: sql<number>`${ratingPolicy.initial} + ${sum(p.ratingDelta)}`.mapWith(
            Number,
          ),
          rank: sql<number>`rank() over (order by sum(${p.ratingDelta}) desc)`.mapWith(
            Number,
          ),
        })
        .from(p)
        .innerJoin(r, eq(r.resultId, p.resultId))
        .where(
          and(
            eq(r.owner, owner),
            sql`${r.payload}->>'kind' = 'ranked'`,
            excludedActors.length ? notInArray(p.actorId, excludedActors) : undefined,
          ),
        )
        .groupBy(p.actorId)
        .orderBy(desc(sum(p.ratingDelta)), asc(p.actorId))
        .limit(100);

      const history = await tx
        .select({
          resultId: r.resultId,
          finishedAt: r.finishedAt,
          reason: sql<string>`${r.payload}->'result'->>'reason'`,
          winnerId: sql<string | null>`${r.payload}->'result'->>'winnerId'`,
          ratingDelta: p.ratingDelta,
          payload: sql<
            typeof r.$inferSelect.payload
          >`quiz_game.private_result(${r.payload})`,
        })
        .from(p)
        .innerJoin(r, eq(r.resultId, p.resultId))
        .where(and(eq(r.owner, owner), eq(p.actorId, actorId)))
        .orderBy(desc(r.finishedAt), desc(r.resultId))
        .limit(20);

      return {
        ranking,
        history: history.map(({ payload, ...entry }) => ({
          ...entry,
          kind: payload.kind,
          questions: payload.completedQuestions?.map(
            ({ id, text, displayAnswer, readings, explanation, source, authorName }) => ({
              id,
              text,
              displayAnswer,
              readings,
              explanation,
              source,
              ...(authorName ? { authorName } : {}),
            }),
          ),
          outcome:
            payload.players.find((p) => p.id === actorId)?.role === 'presenter'
              ? 'presenter'
              : entry.reason === 'connections' || entry.reason === 'disqualifications'
                ? 'invalid'
                : !entry.winnerId
                  ? 'draw'
                  : entry.winnerId === actorId
                    ? 'win'
                    : 'loss',
          players: payload.players.map(
            ({ id, name, correct, mistakes, ratingDelta, guest, role }) => ({
              id,
              name,
              correct,
              mistakes,
              ratingDelta,
              ...(guest ? { guest } : {}),
              ...(role ? { role } : {}),
            }),
          ),
        })),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
