import { type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import type { QuestionSelection } from '../../shared/questions.ts';
import type { Database } from '../db/d1.ts';
import {
  federationDeletedInstances,
  federationQuestionLinks,
  instances,
  organizationAccounts,
  questionSubmissions,
  questionVersions,
} from '../db/schema.ts';
import type { ResultRecord } from './record.ts';

function retired(owner: SQL, question: SQL, series: SQL = question) {
  return sql`exists (
    select 1 from ${questionSubmissions}
    join ${instances} on ${instances.id} = ${questionSubmissions.instanceId}
    join ${organizationAccounts} on ${organizationAccounts.actorId} = ${questionSubmissions.authorId}
    where ${instances.owner} = ${owner}
      and ${organizationAccounts.withdrawnAt} is not null
      and (${questionSubmissions.provenance} is null or exists(select 1 from ${federationQuestionLinks} where ${federationQuestionLinks.submissionId}=${questionSubmissions.id}))
      and (${questionSubmissions.id} = ${question}
        or ${questionSubmissions.seriesId} = ${series}
        or ${questionSubmissions.publishedId} = ${question}
        or exists (select 1 from ${questionVersions}
          where ${questionVersions.owner} = ${owner}
            and ${questionVersions.questionId} = ${question}
            and json_extract(${questionVersions.payload}, '$.seriesId') = ${questionSubmissions.seriesId}))
  )`;
}

export function privateSelectionSQL(owner: SQLWrapper, selection: SQLWrapper) {
  return sql`case when json_type(${selection}, '$.authorNames') = 'object'
    then json_set(${selection}, '$.authorNames', json((select json_group_object(author.key, case
      when ${retired(sql`${owner}`, sql`author.key`)} then '退会ユーザー' else author.value end)
      from json_each(${selection}, '$.authorNames') author)))
    else ${selection} end`;
}

export function decodeSelection(value: string | null) {
  return value === null ? null : (JSON.parse(value) as QuestionSelection);
}

// The same expression protects reads, late result retries, and physical erasure.
// Database time also keeps the erasure guard and the proposed replacement aligned.
export function privateResultSQL(source: SQLWrapper): SQL {
  const owner = sql`json_extract(data, '$.owner')`;
  const expired = sql`json_extract(data, '$.result.finishedAt') <= cast(strftime('%s', 'now') as integer) * 1000 -
    (case when json_extract(data, '$.definition.original') then 30 else 365 end) * 86400000`;
  const oldGuest = sql`json_extract(data, '$.result.finishedAt') <= cast(strftime('%s', 'now') as integer) * 1000 - 30 * 86400000`;
  const playerName = sql`case
    when exists (select 1 from ${organizationAccounts}
      join ${instances} on ${instances.organizationId} = ${organizationAccounts.organizationId}
      where ${instances.owner} = ${owner}
        and ${organizationAccounts.actorId} = json_extract(player.value, '$.id')
        and ${organizationAccounts.withdrawnAt} is not null)
      then json_set(player.value, '$.name', '退会ユーザー')
    else player.value end`;
  const players = sql`(select json_group_array(json(case
    when ${oldGuest} and json_extract(player.value, '$.guest') then json_set(${playerName}, '$.name', 'ゲスト')
    else ${playerName} end)) from json_each(data, '$.players') player)`;
  const anonymousQuestion = sql`case when json_type(question.value, '$.authorName') is not null
      and ${retired(owner, sql`json_extract(question.value, '$.id')`, sql`coalesce(json_extract(question.value, '$.seriesId'), json_extract(question.value, '$.id'))`)}
      then json_set(question.value, '$.authorName', '退会ユーザー') else question.value end`;
  const questions = sql`(select json_group_array(json(case
    when exists(select 1 from ${federationDeletedInstances}
      where ${federationDeletedInstances.peerOrigin}=json_extract(question.value,'$.sharedSource.peerOrigin')
      and ${federationDeletedInstances.instanceId}=json_extract(question.value,'$.sharedSource.instanceId'))
      then json_set(${anonymousQuestion},'$.text','削除された共有元の問題です。','$.displayAnswer','','$.readings',json('[]'),'$.explanation','','$.source','')
    else ${anonymousQuestion} end)) from json_each(data, '$.completedQuestions') question)`;
  const authorNames = sql`(select json_group_object(author.key, case
    when ${retired(owner, sql`author.key`)} then '退会ユーザー' else author.value end)
    from json_each(data, '$.definition.selection.authorNames') author)`;
  // Keep each privacy projection once; SQLite flattening otherwise repeats it for each author/question.
  return sql`(with original as materialized (select ${source} as data),
    protected_players as materialized (select json_set(data, '$.players', json(${players})) as data from original),
    protected_questions as materialized (select case
      when ${expired} then json_remove(data, '$.completedQuestions')
      when json_type(data, '$.completedQuestions') = 'array' then json_set(data, '$.completedQuestions', json(${questions}))
      else data end as data from protected_players)
    select case when json_type(data, '$.definition.selection.authorNames') = 'object'
      then json_set(data, '$.definition.selection.authorNames', json(${authorNames}))
      else data end from protected_questions)`;
}

export async function privateResult(db: Database, record: ResultRecord) {
  const [row] = await db.all<{ payload: string }>(
    sql`select ${privateResultSQL(sql`${JSON.stringify(record)}`)} as payload`,
  );
  return JSON.parse(row.payload) as ResultRecord;
}
