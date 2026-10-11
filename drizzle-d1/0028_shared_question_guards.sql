DROP TRIGGER d1_privacy_permit;
--> statement-breakpoint
CREATE TRIGGER d1_privacy_permit BEFORE INSERT ON quiz_game_result_privacy_changes
    WHEN NOT EXISTS (
      SELECT 1 FROM "quiz_game_match_results" JOIN quiz_game_result_outbox outbox ON outbox.result_id = "quiz_game_match_results"."result_id"
      WHERE "quiz_game_match_results"."result_id" = NEW.result_id AND "quiz_game_match_results"."payload_hash" = NEW.previous_hash
        AND outbox.payload_hash = "quiz_game_match_results"."payload_hash" AND outbox.payload = "quiz_game_match_results"."payload"
        AND length(NEW.payload_hash) = 64 AND NEW.payload_hash NOT GLOB '*[^0-9a-f]*'
        AND NOT EXISTS (SELECT fullkey,type,atom FROM json_tree((with original as (select "quiz_game_match_results"."payload" as data),
    protected_players as (select json_set(data, '$.players', json((select json_group_array(json(case
    when json_extract(data, '$.result.finishedAt') <= cast(strftime('%s', 'now') as integer) * 1000 - 30 * 86400000 and json_extract(player.value, '$.guest') then json_set(case
    when exists (select 1 from "quiz_game_organization_accounts"
      join "quiz_game_instances" on "quiz_game_instances"."organization_id" = "quiz_game_organization_accounts"."organization_id"
      where "quiz_game_instances"."owner" = json_extract(data, '$.owner')
        and "quiz_game_organization_accounts"."actor_id" = json_extract(player.value, '$.id')
        and "quiz_game_organization_accounts"."withdrawn_at" is not null)
      then json_set(player.value, '$.name', '退会ユーザー')
    else player.value end, '$.name', 'ゲスト')
    else case
    when exists (select 1 from "quiz_game_organization_accounts"
      join "quiz_game_instances" on "quiz_game_instances"."organization_id" = "quiz_game_organization_accounts"."organization_id"
      where "quiz_game_instances"."owner" = json_extract(data, '$.owner')
        and "quiz_game_organization_accounts"."actor_id" = json_extract(player.value, '$.id')
        and "quiz_game_organization_accounts"."withdrawn_at" is not null)
      then json_set(player.value, '$.name', '退会ユーザー')
    else player.value end end)) from json_each(data, '$.players') player))) as data from original),
    protected_questions as (select case
      when json_extract(data, '$.result.finishedAt') <= cast(strftime('%s', 'now') as integer) * 1000 -
    (case when json_extract(data, '$.definition.original') then 30 else 365 end) * 86400000 then json_remove(data, '$.completedQuestions')
      when json_type(data, '$.completedQuestions') = 'array' then json_set(data, '$.completedQuestions', json((select json_group_array(json(case
    when exists(select 1 from "quiz_federation_deleted_instances"
      where "quiz_federation_deleted_instances"."peer_origin"=json_extract(question.value,'$.sharedSource.peerOrigin')
      and "quiz_federation_deleted_instances"."instance_id"=json_extract(question.value,'$.sharedSource.instanceId'))
      then json_set(case when json_type(question.value, '$.authorName') is not null
      and exists (
    select 1 from "quiz_game_question_submissions"
    join "quiz_game_instances" on "quiz_game_instances"."id" = "quiz_game_question_submissions"."instance_id"
    join "quiz_game_organization_accounts" on "quiz_game_organization_accounts"."actor_id" = "quiz_game_question_submissions"."author_id"
    where "quiz_game_instances"."owner" = json_extract(data, '$.owner')
      and "quiz_game_organization_accounts"."withdrawn_at" is not null
      and ("quiz_game_question_submissions"."provenance" is null or exists(select 1 from "quiz_federation_question_links" where "quiz_federation_question_links"."submission_id"="quiz_game_question_submissions"."id"))
      and ("quiz_game_question_submissions"."id" = json_extract(question.value, '$.id')
        or "quiz_game_question_submissions"."series_id" = coalesce(json_extract(question.value, '$.seriesId'), json_extract(question.value, '$.id'))
        or "quiz_game_question_submissions"."published_id" = json_extract(question.value, '$.id')
        or exists (select 1 from "quiz_game_question_versions"
          where "quiz_game_question_versions"."owner" = json_extract(data, '$.owner')
            and "quiz_game_question_versions"."question_id" = json_extract(question.value, '$.id')
            and json_extract("quiz_game_question_versions"."payload", '$.seriesId') = "quiz_game_question_submissions"."series_id"))
  )
      then json_set(question.value, '$.authorName', '退会ユーザー') else question.value end,'$.text','削除された共有元の問題です。','$.displayAnswer','','$.readings',json('[]'),'$.explanation','','$.source','')
    else case when json_type(question.value, '$.authorName') is not null
      and exists (
    select 1 from "quiz_game_question_submissions"
    join "quiz_game_instances" on "quiz_game_instances"."id" = "quiz_game_question_submissions"."instance_id"
    join "quiz_game_organization_accounts" on "quiz_game_organization_accounts"."actor_id" = "quiz_game_question_submissions"."author_id"
    where "quiz_game_instances"."owner" = json_extract(data, '$.owner')
      and "quiz_game_organization_accounts"."withdrawn_at" is not null
      and ("quiz_game_question_submissions"."provenance" is null or exists(select 1 from "quiz_federation_question_links" where "quiz_federation_question_links"."submission_id"="quiz_game_question_submissions"."id"))
      and ("quiz_game_question_submissions"."id" = json_extract(question.value, '$.id')
        or "quiz_game_question_submissions"."series_id" = coalesce(json_extract(question.value, '$.seriesId'), json_extract(question.value, '$.id'))
        or "quiz_game_question_submissions"."published_id" = json_extract(question.value, '$.id')
        or exists (select 1 from "quiz_game_question_versions"
          where "quiz_game_question_versions"."owner" = json_extract(data, '$.owner')
            and "quiz_game_question_versions"."question_id" = json_extract(question.value, '$.id')
            and json_extract("quiz_game_question_versions"."payload", '$.seriesId') = "quiz_game_question_submissions"."series_id"))
  )
      then json_set(question.value, '$.authorName', '退会ユーザー') else question.value end end)) from json_each(data, '$.completedQuestions') question)))
      else data end as data from protected_players)
    select case when json_type(data, '$.definition.selection.authorNames') = 'object'
      then json_set(data, '$.definition.selection.authorNames', json((select json_group_object(author.key, case
    when exists (
    select 1 from "quiz_game_question_submissions"
    join "quiz_game_instances" on "quiz_game_instances"."id" = "quiz_game_question_submissions"."instance_id"
    join "quiz_game_organization_accounts" on "quiz_game_organization_accounts"."actor_id" = "quiz_game_question_submissions"."author_id"
    where "quiz_game_instances"."owner" = json_extract(data, '$.owner')
      and "quiz_game_organization_accounts"."withdrawn_at" is not null
      and ("quiz_game_question_submissions"."provenance" is null or exists(select 1 from "quiz_federation_question_links" where "quiz_federation_question_links"."submission_id"="quiz_game_question_submissions"."id"))
      and ("quiz_game_question_submissions"."id" = author.key
        or "quiz_game_question_submissions"."series_id" = author.key
        or "quiz_game_question_submissions"."published_id" = author.key
        or exists (select 1 from "quiz_game_question_versions"
          where "quiz_game_question_versions"."owner" = json_extract(data, '$.owner')
            and "quiz_game_question_versions"."question_id" = author.key
            and json_extract("quiz_game_question_versions"."payload", '$.seriesId') = "quiz_game_question_submissions"."series_id"))
  ) then '退会ユーザー' else author.value end)
    from json_each(data, '$.definition.selection.authorNames') author)))
      else data end from protected_questions)) EXCEPT SELECT fullkey,type,atom FROM json_tree(NEW.payload))
        AND NOT EXISTS (SELECT fullkey,type,atom FROM json_tree(NEW.payload) EXCEPT SELECT fullkey,type,atom FROM json_tree((with original as (select "quiz_game_match_results"."payload" as data),
    protected_players as (select json_set(data, '$.players', json((select json_group_array(json(case
    when json_extract(data, '$.result.finishedAt') <= cast(strftime('%s', 'now') as integer) * 1000 - 30 * 86400000 and json_extract(player.value, '$.guest') then json_set(case
    when exists (select 1 from "quiz_game_organization_accounts"
      join "quiz_game_instances" on "quiz_game_instances"."organization_id" = "quiz_game_organization_accounts"."organization_id"
      where "quiz_game_instances"."owner" = json_extract(data, '$.owner')
        and "quiz_game_organization_accounts"."actor_id" = json_extract(player.value, '$.id')
        and "quiz_game_organization_accounts"."withdrawn_at" is not null)
      then json_set(player.value, '$.name', '退会ユーザー')
    else player.value end, '$.name', 'ゲスト')
    else case
    when exists (select 1 from "quiz_game_organization_accounts"
      join "quiz_game_instances" on "quiz_game_instances"."organization_id" = "quiz_game_organization_accounts"."organization_id"
      where "quiz_game_instances"."owner" = json_extract(data, '$.owner')
        and "quiz_game_organization_accounts"."actor_id" = json_extract(player.value, '$.id')
        and "quiz_game_organization_accounts"."withdrawn_at" is not null)
      then json_set(player.value, '$.name', '退会ユーザー')
    else player.value end end)) from json_each(data, '$.players') player))) as data from original),
    protected_questions as (select case
      when json_extract(data, '$.result.finishedAt') <= cast(strftime('%s', 'now') as integer) * 1000 -
    (case when json_extract(data, '$.definition.original') then 30 else 365 end) * 86400000 then json_remove(data, '$.completedQuestions')
      when json_type(data, '$.completedQuestions') = 'array' then json_set(data, '$.completedQuestions', json((select json_group_array(json(case
    when exists(select 1 from "quiz_federation_deleted_instances"
      where "quiz_federation_deleted_instances"."peer_origin"=json_extract(question.value,'$.sharedSource.peerOrigin')
      and "quiz_federation_deleted_instances"."instance_id"=json_extract(question.value,'$.sharedSource.instanceId'))
      then json_set(case when json_type(question.value, '$.authorName') is not null
      and exists (
    select 1 from "quiz_game_question_submissions"
    join "quiz_game_instances" on "quiz_game_instances"."id" = "quiz_game_question_submissions"."instance_id"
    join "quiz_game_organization_accounts" on "quiz_game_organization_accounts"."actor_id" = "quiz_game_question_submissions"."author_id"
    where "quiz_game_instances"."owner" = json_extract(data, '$.owner')
      and "quiz_game_organization_accounts"."withdrawn_at" is not null
      and ("quiz_game_question_submissions"."provenance" is null or exists(select 1 from "quiz_federation_question_links" where "quiz_federation_question_links"."submission_id"="quiz_game_question_submissions"."id"))
      and ("quiz_game_question_submissions"."id" = json_extract(question.value, '$.id')
        or "quiz_game_question_submissions"."series_id" = coalesce(json_extract(question.value, '$.seriesId'), json_extract(question.value, '$.id'))
        or "quiz_game_question_submissions"."published_id" = json_extract(question.value, '$.id')
        or exists (select 1 from "quiz_game_question_versions"
          where "quiz_game_question_versions"."owner" = json_extract(data, '$.owner')
            and "quiz_game_question_versions"."question_id" = json_extract(question.value, '$.id')
            and json_extract("quiz_game_question_versions"."payload", '$.seriesId') = "quiz_game_question_submissions"."series_id"))
  )
      then json_set(question.value, '$.authorName', '退会ユーザー') else question.value end,'$.text','削除された共有元の問題です。','$.displayAnswer','','$.readings',json('[]'),'$.explanation','','$.source','')
    else case when json_type(question.value, '$.authorName') is not null
      and exists (
    select 1 from "quiz_game_question_submissions"
    join "quiz_game_instances" on "quiz_game_instances"."id" = "quiz_game_question_submissions"."instance_id"
    join "quiz_game_organization_accounts" on "quiz_game_organization_accounts"."actor_id" = "quiz_game_question_submissions"."author_id"
    where "quiz_game_instances"."owner" = json_extract(data, '$.owner')
      and "quiz_game_organization_accounts"."withdrawn_at" is not null
      and ("quiz_game_question_submissions"."provenance" is null or exists(select 1 from "quiz_federation_question_links" where "quiz_federation_question_links"."submission_id"="quiz_game_question_submissions"."id"))
      and ("quiz_game_question_submissions"."id" = json_extract(question.value, '$.id')
        or "quiz_game_question_submissions"."series_id" = coalesce(json_extract(question.value, '$.seriesId'), json_extract(question.value, '$.id'))
        or "quiz_game_question_submissions"."published_id" = json_extract(question.value, '$.id')
        or exists (select 1 from "quiz_game_question_versions"
          where "quiz_game_question_versions"."owner" = json_extract(data, '$.owner')
            and "quiz_game_question_versions"."question_id" = json_extract(question.value, '$.id')
            and json_extract("quiz_game_question_versions"."payload", '$.seriesId') = "quiz_game_question_submissions"."series_id"))
  )
      then json_set(question.value, '$.authorName', '退会ユーザー') else question.value end end)) from json_each(data, '$.completedQuestions') question)))
      else data end as data from protected_players)
    select case when json_type(data, '$.definition.selection.authorNames') = 'object'
      then json_set(data, '$.definition.selection.authorNames', json((select json_group_object(author.key, case
    when exists (
    select 1 from "quiz_game_question_submissions"
    join "quiz_game_instances" on "quiz_game_instances"."id" = "quiz_game_question_submissions"."instance_id"
    join "quiz_game_organization_accounts" on "quiz_game_organization_accounts"."actor_id" = "quiz_game_question_submissions"."author_id"
    where "quiz_game_instances"."owner" = json_extract(data, '$.owner')
      and "quiz_game_organization_accounts"."withdrawn_at" is not null
      and ("quiz_game_question_submissions"."provenance" is null or exists(select 1 from "quiz_federation_question_links" where "quiz_federation_question_links"."submission_id"="quiz_game_question_submissions"."id"))
      and ("quiz_game_question_submissions"."id" = author.key
        or "quiz_game_question_submissions"."series_id" = author.key
        or "quiz_game_question_submissions"."published_id" = author.key
        or exists (select 1 from "quiz_game_question_versions"
          where "quiz_game_question_versions"."owner" = json_extract(data, '$.owner')
            and "quiz_game_question_versions"."question_id" = author.key
            and json_extract("quiz_game_question_versions"."payload", '$.seriesId') = "quiz_game_question_submissions"."series_id"))
  ) then '退会ユーザー' else author.value end)
    from json_each(data, '$.definition.selection.authorNames') author)))
      else data end from protected_questions)))
    ) BEGIN SELECT RAISE(ABORT, 'INVALID_PRIVACY_PROJECTION'); END;
--> statement-breakpoint
CREATE TRIGGER shared_question_identity BEFORE UPDATE ON quiz_federation_question_links
WHEN OLD.instance_id<>NEW.instance_id OR OLD.peer_origin<>NEW.peer_origin OR OLD.source_instance_id<>NEW.source_instance_id OR OLD.source_series_id<>NEW.source_series_id OR OLD.submission_id<>NEW.submission_id
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SHARED_IDENTITY'); END;
--> statement-breakpoint
CREATE TRIGGER shared_question_staging_update BEFORE UPDATE ON quiz_federation_question_staging
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SHARED_PAGE'); END;
