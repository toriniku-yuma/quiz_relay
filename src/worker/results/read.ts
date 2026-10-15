import { and, asc, desc, eq, sql, sum } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { ResultsOverview, ResultsQuery } from '../../shared/results.ts';
import { type Database, readD1 } from '../db/d1.ts';
import { resultPlayers as p, matches as r } from '../db/schema.ts';
import { privateResultSQL } from './privacy.ts';
import { ratingPolicy } from './rating.ts';
import type { ResultRecord } from './record.ts';

export async function readResults(
  db: Database,
  owner: string,
  actorId: string,
  excludedActors: string[] = [],
  query: ResultsQuery & { finishedAfter?: string } = {},
): Promise<ResultsOverview> {
  // ponytail: 全期間の直接集計。実測で遅くなったら同じ原本から再生成できる投影を追加する。
  return readD1(db, async (): Promise<ResultsOverview> => {
    const latest = alias(r, 'latest_result');
    const ranked = db
      .select({
        actorId: p.actorId,
        name: sql<string>`(select json_extract(player.value, '$.name')
            from ${r} as ${sql.identifier('latest_result')}, json_each(${privateResultSQL(latest.payload)}, '$.players') player
            where ${latest.owner} = ${owner} and json_extract(${latest.payload}, '$.kind') = 'ranked'
              and json_extract(player.value, '$.id') = ${p.actorId}
            order by ${latest.finishedAt} desc, ${latest.matchId} desc limit 1)`.as(
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
      .innerJoin(r, eq(r.matchId, p.matchId))
      .where(
        and(
          eq(r.owner, owner),
          sql`${r.payload}->>'kind' = 'ranked'`,
          excludedActors.length
            ? sql`${p.actorId} not in (select value from json_each(${JSON.stringify(excludedActors)}))`
            : undefined,
        ),
      )
      .groupBy(p.actorId)
      .as('ranked_players');
    const ranking =
      query.section === 'history' || query.section === 'self'
        ? []
        : await db
            .select()
            .from(ranked)
            .orderBy(desc(ranked.rating), asc(ranked.actorId))
            .limit(100);

    let self: ResultsOverview['self'];
    if (query.section !== 'history') {
      [self] = await db
        .select({ rank: ranked.rank, rating: ranked.rating })
        .from(ranked)
        .where(eq(ranked.actorId, actorId));
      if (!self) {
        const [rating] = await db
          .select({
            rating:
              sql<number>`${ratingPolicy.initial} + coalesce(sum(${p.ratingDelta}), 0)`.mapWith(
                Number,
              ),
          })
          .from(p)
          .innerJoin(r, eq(r.matchId, p.matchId))
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
        : await db
            .select({
              matchId: r.matchId,
              finishedAt: sql<string>`${r.finishedAt}`,
              reason: sql<string>`${r.payload}->'result'->>'reason'`,
              winnerId: sql<string | null>`${r.payload}->'result'->>'winnerId'`,
              ratingDelta: p.ratingDelta,
              payload: (query.section === 'history' && !query.matchId
                ? sql`json_remove(${privateResultSQL(r.payload)}, '$.completedQuestions')`
                : privateResultSQL(r.payload)
              ).mapWith((value: string) => JSON.parse(value) as ResultRecord),
            })
            .from(p)
            .innerJoin(r, eq(r.matchId, p.matchId))
            .where(
              and(
                eq(r.owner, owner),
                eq(p.actorId, actorId),
                query.kind ? sql`${r.payload}->>'kind' = ${query.kind}` : undefined,
                query.matchId ? eq(r.matchId, query.matchId) : undefined,
                query.finishedAfter
                  ? sql`${r.finishedAt} > ${query.finishedAfter}`
                  : undefined,
                query.cursor
                  ? sql`(${r.finishedAt}, ${r.matchId}) < (${query.cursor.finishedAt}, ${query.cursor.matchId})`
                  : undefined,
              ),
            )
            .orderBy(desc(r.finishedAt), desc(r.matchId))
            .limit(query.matchId ? 1 : query.section === 'history' ? 21 : 20);

    const page = history.slice(0, 20),
      last = page.at(-1);

    return {
      ranking,
      ...(self ? { self } : {}),
      ...(query.section === 'history' && !query.matchId
        ? {
            nextCursor:
              history.length > 20 && last
                ? {
                    finishedAt: new Date(last.finishedAt).toISOString(),
                    matchId: last.matchId,
                  }
                : null,
          }
        : {}),
      history: page.map(({ payload, ...entry }) => ({
        ...entry,
        kind: payload.kind,
        correct: payload.players.find((player) => player.id === actorId)?.correct ?? 0,
        mistakes: payload.players.find((player) => player.id === actorId)?.mistakes ?? 0,
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
  });
}
