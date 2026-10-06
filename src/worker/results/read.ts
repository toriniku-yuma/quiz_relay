import { and, asc, desc, eq, notInArray, sql, sum } from 'drizzle-orm';
import type { ResultsOverview, ResultsQuery } from '../../shared/results';
import type { connectDatabase } from '../db/connection';
import { resultPlayers as p, matchResults as r } from '../db/schema.ts';
import { ratingPolicy } from './rating.ts';

export async function readResults(
  db: Pick<ReturnType<typeof connectDatabase>['db'], 'transaction'>,
  owner: string,
  actorId: string,
  excludedActors: string[] = [],
  query: ResultsQuery & { finishedAfter?: string } = {},
): Promise<ResultsOverview> {
  // ponytail: 全期間の直接集計。実測で遅くなったら同じ原本から再生成できる投影を追加する。
  return db.transaction(
    async (tx): Promise<ResultsOverview> => {
      const ranked = tx
        .select({
          actorId: p.actorId,
          name: sql<string>`(array_agg(${p.name} order by ${r.finishedAt} desc, ${r.resultId} desc))[1]`.as(
            'name',
          ),
          rating: sql<number>`${ratingPolicy.initial} + ${sum(p.ratingDelta)}`
            .mapWith(Number)
            .as('rating'),
          rank: sql<number>`rank() over (order by sum(${p.ratingDelta}) desc)`
            .mapWith(Number)
            .as('rank'),
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
        .as('ranked_players');
      const ranking =
        query.section === 'history' || query.section === 'self'
          ? []
          : await tx
              .select()
              .from(ranked)
              .orderBy(desc(ranked.rating), asc(ranked.actorId))
              .limit(100);

      let self: ResultsOverview['self'];
      if (query.section !== 'history') {
        [self] = await tx
          .select({ rank: ranked.rank, rating: ranked.rating })
          .from(ranked)
          .where(eq(ranked.actorId, actorId));
        if (!self) {
          const [rating] = await tx
            .select({
              rating:
                sql<number>`${ratingPolicy.initial} + coalesce(sum(${p.ratingDelta}), 0)`.mapWith(
                  Number,
                ),
            })
            .from(p)
            .innerJoin(r, eq(r.resultId, p.resultId))
            .where(
              and(
                eq(r.owner, owner),
                eq(p.actorId, actorId),
                sql`${r.payload}->>'kind' = 'ranked'`,
              ),
            );
          self = { rank: null, rating: rating.rating };
        }
      }

      const history =
        query.section === 'ranking' || query.section === 'self'
          ? []
          : await tx
              .select({
                resultId: r.resultId,
                finishedAt: r.finishedAt,
                reason: sql<string>`${r.payload}->'result'->>'reason'`,
                winnerId: sql<string | null>`${r.payload}->'result'->>'winnerId'`,
                ratingDelta: p.ratingDelta,
                payload: sql<
                  typeof r.$inferSelect.payload
                >`quiz_game.private_result(${r.payload}) ${query.section === 'history' && !query.resultId ? sql`- 'completedQuestions'` : sql``}`,
              })
              .from(p)
              .innerJoin(r, eq(r.resultId, p.resultId))
              .where(
                and(
                  eq(r.owner, owner),
                  eq(p.actorId, actorId),
                  query.kind ? sql`${r.payload}->>'kind' = ${query.kind}` : undefined,
                  query.resultId ? eq(r.resultId, query.resultId) : undefined,
                  query.finishedAfter
                    ? sql`${r.finishedAt} > ${query.finishedAfter}::timestamptz`
                    : undefined,
                  query.cursor
                    ? sql`(${r.finishedAt}, ${r.resultId}) < (${query.cursor.finishedAt}::timestamptz, ${query.cursor.resultId}::uuid)`
                    : undefined,
                ),
              )
              .orderBy(desc(r.finishedAt), desc(r.resultId))
              .limit(query.resultId ? 1 : query.section === 'history' ? 21 : 20);

      const page = history.slice(0, 20),
        last = page.at(-1);

      return {
        ranking,
        ...(self ? { self } : {}),
        ...(query.section === 'history' && !query.resultId
          ? {
              nextCursor:
                history.length > 20 && last
                  ? {
                      finishedAt: new Date(last.finishedAt).toISOString(),
                      resultId: last.resultId,
                    }
                  : null,
            }
          : {}),
        history: page.map(({ payload, ...entry }) => ({
          ...entry,
          kind: payload.kind,
          correct: payload.players.find((player) => player.id === actorId)?.correct ?? 0,
          mistakes:
            payload.players.find((player) => player.id === actorId)?.mistakes ?? 0,
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
            payload.players.find((player) => player.id === actorId)?.role === 'presenter'
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
