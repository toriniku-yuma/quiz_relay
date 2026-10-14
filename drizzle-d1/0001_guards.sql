INSERT INTO `quiz_database_revision` (`id`, `revision`) VALUES (1, 0);
--> statement-breakpoint
CREATE TRIGGER "d1_account_identity" before UPDATE on "quiz_game_organization_accounts" when not (NEW."organization_id" is OLD."organization_id" and NEW."subject" is OLD."subject" and NEW."actor_id" is OLD."actor_id" and (OLD.withdrawn_at is null or (NEW.withdrawn_at is OLD.withdrawn_at and NEW.display_name is null and not NEW.administrator))) BEGIN select raise(abort, 'ACCOUNT_IDENTITY_CONFLICT'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_appeal_delete" before DELETE on "quiz_game_sanction_appeals" when not (OLD."created_at" <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days') or exists(select 1 from "quiz_game_instance_deletions" job where job.owner = (select owner from "quiz_game_instances" join "quiz_game_moderation_sanctions" sanction on sanction.instance_id="quiz_game_instances"."id" where sanction.id=OLD.sanction_id) and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_appeal_update" before UPDATE on "quiz_game_sanction_appeals" when not ((NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."actor_id" is OLD."actor_id" and NEW."sanction_id" is OLD."sanction_id" and NEW."sanction_revision" is OLD."sanction_revision" and NEW."reason" is OLD."reason" and NEW."created_at" is OLD."created_at" and (OLD.resolved_at is null or NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."actor_id" is OLD."actor_id" and NEW."sanction_id" is OLD."sanction_id" and NEW."sanction_revision" is OLD."sanction_revision" and NEW."reason" is OLD."reason" and NEW."created_at" is OLD."created_at" and NEW."resolved_at" is OLD."resolved_at" and NEW."operator_id" is OLD."operator_id" and NEW."resolution" is OLD."resolution" and NEW."decision" is OLD."decision")) or (exists(select 1 from "quiz_game_organization_accounts" where "quiz_game_organization_accounts"."withdrawn_at" is not null and ("quiz_game_organization_accounts"."actor_id" = OLD."actor_id" or "quiz_game_organization_accounts"."actor_id" = OLD."operator_id")) and NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."actor_id" is OLD."actor_id" and NEW."sanction_id" is OLD."sanction_id" and NEW."sanction_revision" is OLD."sanction_revision" and NEW."created_at" is OLD."created_at" and NEW."resolved_at" is OLD."resolved_at" and NEW."operator_id" is OLD."operator_id" and NEW."decision" is OLD."decision" and NEW."read_at" is OLD."read_at" and NEW."reason" is case when OLD."reason" is null then null else '退会に伴い削除' end and NEW."resolution" is case when OLD."resolution" is null then null else '退会に伴い削除' end)) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_competition_delete" before DELETE on "quiz_game_competitions" when not (exists(select 1 from "quiz_game_instance_deletions" job where job.owner = OLD."owner" and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
CREATE TRIGGER d1_competition_update BEFORE UPDATE ON quiz_game_competitions
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_deleted_availability" before INSERT on "quiz_game_question_availability" when not (not exists(select 1 from "quiz_game_instance_deletions" where owner=NEW."owner" )) BEGIN select raise(abort, 'INSTANCE_DELETION_RECORDED'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_deleted_competition" before INSERT on "quiz_game_competitions" when not (not exists(select 1 from "quiz_game_instance_deletions" where owner=NEW."owner" )) BEGIN select raise(abort, 'INSTANCE_DELETION_RECORDED'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_deleted_instance" before INSERT on "quiz_game_instances" when not (not exists(select 1 from "quiz_game_instance_deletions" where instance_id=NEW.id or owner=NEW.owner)) BEGIN select raise(abort, 'INSTANCE_DELETION_RECORDED'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_deleted_matchmaking" before INSERT on "quiz_game_matchmaking_settings" when not (not exists(select 1 from "quiz_game_instance_deletions" where owner=NEW."owner" )) BEGIN select raise(abort, 'INSTANCE_DELETION_RECORDED'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_deleted_result" before INSERT on "quiz_game_match_results" when not (not exists(select 1 from "quiz_game_instance_deletions" where owner=NEW."owner" and (accepted_at is not null or deleted_at is not null))) BEGIN select raise(abort, 'INSTANCE_DELETION_RECORDED'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_deleted_ruleset" before INSERT on "quiz_game_ruleset_versions" when not (not exists(select 1 from "quiz_game_instance_deletions" where owner=NEW."owner" )) BEGIN select raise(abort, 'INSTANCE_DELETION_RECORDED'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_deleted_set" before INSERT on "quiz_game_question_sets" when not (not exists(select 1 from "quiz_game_instance_deletions" where owner=NEW."owner" )) BEGIN select raise(abort, 'INSTANCE_DELETION_RECORDED'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_deleted_set_item" before INSERT on "quiz_game_question_set_items" when not (not exists(select 1 from "quiz_game_instance_deletions" where owner=NEW."owner" )) BEGIN select raise(abort, 'INSTANCE_DELETION_RECORDED'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_deleted_version" before INSERT on "quiz_game_question_versions" when not (not exists(select 1 from "quiz_game_instance_deletions" where owner=NEW."owner" )) BEGIN select raise(abort, 'INSTANCE_DELETION_RECORDED'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_deletion_receipt" before UPDATE on "quiz_game_instance_deletions" when not (NEW."id" is OLD."id" and NEW."instance_id" is OLD."instance_id" and NEW."organization_id" is OLD."organization_id" and NEW."owner" is OLD."owner" and NEW."name" is OLD."name" and NEW."operator_id" is OLD."operator_id" and NEW."requested_at" is OLD."requested_at" and (OLD.deleted_at is null or NEW.deleted_at is OLD.deleted_at) and (OLD.accepted_at is null or NEW.accepted_at is OLD.accepted_at)) BEGIN select raise(abort, 'DELETION_RECEIPT_CONFLICT'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_deletion_receipt_delete" before DELETE on "quiz_game_instance_deletions" when not (OLD.accepted_at is null and OLD.deleted_at is null) BEGIN select raise(abort, 'DELETION_RECEIPT_CONFLICT'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_moderation_event_delete" before DELETE on "quiz_game_moderation_events" when not (OLD."created_at" <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days') or exists(select 1 from "quiz_game_instance_deletions" job where job.owner = (select owner from "quiz_game_instances" where id=OLD.instance_id) and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_moderation_event_update" before UPDATE on "quiz_game_moderation_events" when not ((NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."instance_id" is OLD."instance_id" and NEW."actor_id" is OLD."actor_id" and NEW."operator_id" is OLD."operator_id" and NEW."action" is OLD."action" and NEW."reason" is OLD."reason" and NEW."request_hash" is OLD."request_hash" and NEW."before" is OLD."before" and NEW."after" is OLD."after" and NEW."created_at" is OLD."created_at" ) or (exists(select 1 from "quiz_game_organization_accounts" where "quiz_game_organization_accounts"."withdrawn_at" is not null and ("quiz_game_organization_accounts"."actor_id" = OLD."actor_id" or "quiz_game_organization_accounts"."actor_id" = OLD."operator_id")) and NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."instance_id" is OLD."instance_id" and NEW."actor_id" is OLD."actor_id" and NEW."operator_id" is OLD."operator_id" and NEW."action" is OLD."action" and NEW."request_hash" is OLD."request_hash" and NEW."created_at" is OLD."created_at" and NEW."read_at" is OLD."read_at" and NEW."reason" is case when OLD."reason" is null then null else '退会に伴い削除' end and NEW."before" is case when json_type(OLD."before", '$.reason') is not null then json_set(OLD."before", '$.reason', '退会に伴い削除') else OLD."before" end and NEW."after" is case when json_type(OLD."after", '$.reason') is not null then json_set(OLD."after", '$.reason', '退会に伴い削除') else OLD."after" end)) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_moderation_request_delete" before DELETE on "quiz_game_moderation_requests" when not (OLD."created_at" <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days') or exists(select 1 from "quiz_game_instance_deletions" job where job.owner = (select owner from "quiz_game_instances" where id=coalesce(json_extract(OLD.details,'$.instanceId'),json_extract(OLD.details,'$.id')) and coalesce(json_extract(OLD.details,'$.organizationWide'),0)<>1) and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_moderation_request_update" before UPDATE on "quiz_game_moderation_requests" when not ((NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."operator_id" is OLD."operator_id" and NEW."request_hash" is OLD."request_hash" and NEW."details" is OLD."details" and NEW."created_at" is OLD."created_at" ) or (exists(select 1 from "quiz_game_organization_accounts" where "quiz_game_organization_accounts"."withdrawn_at" is not null and ("quiz_game_organization_accounts"."actor_id" = OLD."operator_id" or json_extract(OLD."details", '$.actorId') = "quiz_game_organization_accounts"."actor_id" or exists(select 1 from json_each(OLD."details", '$.targets') target where target.value = "quiz_game_organization_accounts"."actor_id" or json_extract(case when target.type = 'object' then target.value else '{}' end, '$.actorId') = "quiz_game_organization_accounts"."actor_id"))) and NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."operator_id" is OLD."operator_id" and NEW."request_hash" is OLD."request_hash" and NEW."created_at" is OLD."created_at" and NEW."details" is json_object('action', json_extract(OLD."details", '$.action'), 'redacted', json('true')))) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_organization_event_delete" before DELETE on "quiz_game_organization_events" when not (OLD."occurred_at" <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days') or exists(select 1 from "quiz_game_instance_deletions" job where job.owner = (select owner from "quiz_game_instances" where id=OLD.instance_id) and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_organization_event_update" before UPDATE on "quiz_game_organization_events" when not ((NEW."id" is OLD."id" and NEW."actor_id" is OLD."actor_id" and NEW."instance_id" is OLD."instance_id" and NEW."action" is OLD."action" and NEW."occurred_at" is OLD."occurred_at" and NEW."details" is OLD."details" ) or (exists(select 1 from "quiz_game_organization_accounts" where "quiz_game_organization_accounts"."withdrawn_at" is not null and ("quiz_game_organization_accounts"."actor_id" = OLD."actor_id" or json_extract(OLD."details", '$.actorId') = "quiz_game_organization_accounts"."actor_id" or exists(select 1 from json_each(OLD."details", '$.targets') target where target.value = "quiz_game_organization_accounts"."actor_id" or json_extract(case when target.type = 'object' then target.value else '{}' end, '$.actorId') = "quiz_game_organization_accounts"."actor_id"))) and NEW."id" is OLD."id" and NEW."actor_id" is OLD."actor_id" and NEW."instance_id" is OLD."instance_id" and NEW."action" is OLD."action" and NEW."occurred_at" is OLD."occurred_at" and NEW."details" is json_object('action', json_extract(OLD."details", '$.action'), 'redacted', json('true')))) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_outbox_delete" before DELETE on "quiz_game_result_outbox" when not (exists(select 1 from "quiz_game_instance_deletions" job where job.owner = (select owner from "quiz_game_match_results" where result_id=OLD.result_id) and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_OUTBOX'); END;
--> statement-breakpoint
CREATE TRIGGER d1_outbox_identity BEFORE INSERT ON quiz_game_result_outbox
WHEN NOT EXISTS (
  SELECT 1 FROM quiz_game_match_results AS result
  WHERE result.result_id = NEW.result_id AND result.payload_hash = NEW.payload_hash AND result.payload = NEW.payload
)
BEGIN SELECT RAISE(ABORT, 'INVALID_RESULT_OUTBOX'); END;
--> statement-breakpoint
CREATE TRIGGER d1_outbox_update BEFORE UPDATE ON quiz_game_result_outbox
    WHEN NOT (
      NEW.result_id = OLD.result_id AND EXISTS (SELECT 1 FROM quiz_game_result_privacy_changes permit
        WHERE permit.result_id = OLD.result_id AND permit.previous_hash = OLD.payload_hash
          AND permit.payload_hash = NEW.payload_hash AND permit.payload = NEW.payload)
    ) BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_OUTBOX'); END;
--> statement-breakpoint
CREATE TRIGGER d1_privacy_permit BEFORE INSERT ON quiz_game_result_privacy_changes
    WHEN NOT EXISTS (
      SELECT 1 FROM "quiz_game_match_results" JOIN quiz_game_result_outbox outbox ON outbox.result_id = "quiz_game_match_results"."result_id"
      WHERE "quiz_game_match_results"."result_id" = NEW.result_id AND "quiz_game_match_results"."payload_hash" = NEW.previous_hash
        AND outbox.payload_hash = "quiz_game_match_results"."payload_hash" AND outbox.payload = "quiz_game_match_results"."payload"
        AND length(NEW.payload_hash) = 64 AND NEW.payload_hash NOT GLOB '*[^0-9a-f]*'
        AND NOT EXISTS (SELECT fullkey,type,atom FROM json_tree((with original as materialized (select "quiz_game_match_results"."payload" as data),
    protected_players as materialized (select json_set(data, '$.players', json((select json_group_array(json(case
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
    protected_questions as materialized (select case
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
        AND NOT EXISTS (SELECT fullkey,type,atom FROM json_tree(NEW.payload) EXCEPT SELECT fullkey,type,atom FROM json_tree((with original as materialized (select "quiz_game_match_results"."payload" as data),
    protected_players as materialized (select json_set(data, '$.players', json((select json_group_array(json(case
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
    protected_questions as materialized (select case
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
CREATE TRIGGER d1_privacy_permit_update BEFORE UPDATE ON quiz_game_result_privacy_changes
    BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_PRIVACY_PERMIT'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_question_set_delete" before DELETE on "quiz_game_question_sets" when not (exists(select 1 from "quiz_game_instance_deletions" job where job.owner = OLD."owner" and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_question_set_item_delete" before DELETE on "quiz_game_question_set_items" when not (exists(select 1 from "quiz_game_instance_deletions" job where job.owner = OLD."owner" and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
CREATE TRIGGER d1_question_set_item_update BEFORE UPDATE ON quiz_game_question_set_items
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_question_set_update" before UPDATE on "quiz_game_question_sets" when not (NEW."owner" is OLD."owner" and NEW."set_id" is OLD."set_id" and NEW."version" is OLD."version" and NEW."manifest_hash" is OLD."manifest_hash" and (NEW.selection is case when json_type(OLD."selection", '$.authorNames') = 'object'
    then json_set(OLD."selection", '$.authorNames', json((select json_group_object(author.key, case
      when exists (
    select 1 from "quiz_game_question_submissions"
    join "quiz_game_instances" on "quiz_game_instances"."id" = "quiz_game_question_submissions"."instance_id"
    join "quiz_game_organization_accounts" on "quiz_game_organization_accounts"."actor_id" = "quiz_game_question_submissions"."author_id"
    where "quiz_game_instances"."owner" = OLD."owner"
      and "quiz_game_organization_accounts"."withdrawn_at" is not null
      and "quiz_game_question_submissions"."provenance" is null
      and ("quiz_game_question_submissions"."id" = author.key
        or "quiz_game_question_submissions"."series_id" = author.key
        or "quiz_game_question_submissions"."published_id" = author.key
        or exists (select 1 from "quiz_game_question_versions"
          where "quiz_game_question_versions"."owner" = OLD."owner"
            and "quiz_game_question_versions"."question_id" = author.key
            and json_extract("quiz_game_question_versions"."payload", '$.seriesId') = "quiz_game_question_submissions"."series_id"))
  ) then '退会ユーザー' else author.value end)
      from json_each(OLD."selection", '$.authorNames') author)))
    else OLD."selection" end or (not exists(select fullkey,type,atom from json_tree(NEW.selection) except select fullkey,type,atom from json_tree(case when json_type(OLD."selection", '$.authorNames') = 'object'
    then json_set(OLD."selection", '$.authorNames', json((select json_group_object(author.key, case
      when exists (
    select 1 from "quiz_game_question_submissions"
    join "quiz_game_instances" on "quiz_game_instances"."id" = "quiz_game_question_submissions"."instance_id"
    join "quiz_game_organization_accounts" on "quiz_game_organization_accounts"."actor_id" = "quiz_game_question_submissions"."author_id"
    where "quiz_game_instances"."owner" = OLD."owner"
      and "quiz_game_organization_accounts"."withdrawn_at" is not null
      and "quiz_game_question_submissions"."provenance" is null
      and ("quiz_game_question_submissions"."id" = author.key
        or "quiz_game_question_submissions"."series_id" = author.key
        or "quiz_game_question_submissions"."published_id" = author.key
        or exists (select 1 from "quiz_game_question_versions"
          where "quiz_game_question_versions"."owner" = OLD."owner"
            and "quiz_game_question_versions"."question_id" = author.key
            and json_extract("quiz_game_question_versions"."payload", '$.seriesId') = "quiz_game_question_submissions"."series_id"))
  ) then '退会ユーザー' else author.value end)
      from json_each(OLD."selection", '$.authorNames') author)))
    else OLD."selection" end)) and not exists(select fullkey,type,atom from json_tree(case when json_type(OLD."selection", '$.authorNames') = 'object'
    then json_set(OLD."selection", '$.authorNames', json((select json_group_object(author.key, case
      when exists (
    select 1 from "quiz_game_question_submissions"
    join "quiz_game_instances" on "quiz_game_instances"."id" = "quiz_game_question_submissions"."instance_id"
    join "quiz_game_organization_accounts" on "quiz_game_organization_accounts"."actor_id" = "quiz_game_question_submissions"."author_id"
    where "quiz_game_instances"."owner" = OLD."owner"
      and "quiz_game_organization_accounts"."withdrawn_at" is not null
      and "quiz_game_question_submissions"."provenance" is null
      and ("quiz_game_question_submissions"."id" = author.key
        or "quiz_game_question_submissions"."series_id" = author.key
        or "quiz_game_question_submissions"."published_id" = author.key
        or exists (select 1 from "quiz_game_question_versions"
          where "quiz_game_question_versions"."owner" = OLD."owner"
            and "quiz_game_question_versions"."question_id" = author.key
            and json_extract("quiz_game_question_versions"."payload", '$.seriesId') = "quiz_game_question_submissions"."series_id"))
  ) then '退会ユーザー' else author.value end)
      from json_each(OLD."selection", '$.authorNames') author)))
    else OLD."selection" end) except select fullkey,type,atom from json_tree(NEW.selection))))) BEGIN select raise(abort, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_question_version_delete" before DELETE on "quiz_game_question_versions" when not (exists(select 1 from "quiz_game_instance_deletions" job where job.owner = OLD."owner" and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
CREATE TRIGGER d1_question_version_update BEFORE UPDATE ON quiz_game_question_versions
WHEN NOT (
 NEW.owner=OLD.owner AND NEW.question_id=OLD.question_id AND NEW.version=OLD.version
 AND NEW.payload=json_remove(OLD.payload,'$.text','$.answer','$.displayAnswer','$.readings','$.traps','$.explanation','$.source','$.distractors')
 AND EXISTS (
  SELECT 1 FROM quiz_federation_question_links link
  JOIN quiz_federation_question_imports job ON job.id=link.import_id
  JOIN quiz_game_question_submissions submission ON submission.id=link.submission_id
  JOIN quiz_game_instances instance ON instance.id=link.instance_id
  WHERE instance.owner=OLD.owner AND submission.series_id=json_extract(OLD.payload,'$.seriesId')
   AND link.cache_purged_at IS NULL AND job.attempt_id IS NULL
   AND max(link.last_available_at,case when link.seen_snapshot=job.active_snapshot then job.last_success_at else 0 end)
     <=cast(strftime('%s','now') as integer)*1000-30*86400000
 ))
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
CREATE TRIGGER d1_result_conflict BEFORE INSERT ON quiz_game_match_results
WHEN EXISTS (
  SELECT 1 FROM quiz_game_match_results AS stored
  WHERE (stored.result_id = NEW.result_id OR (stored.owner = NEW.owner AND stored.match_id = NEW.match_id))
    AND (stored.result_id <> NEW.result_id OR stored.owner <> NEW.owner OR stored.match_id <> NEW.match_id OR stored.payload_hash <> NEW.payload_hash)
)
BEGIN SELECT RAISE(ABORT, 'RESULT_CONFLICT'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_result_delete" before DELETE on "quiz_game_match_results" when not (exists(select 1 from "quiz_game_instance_deletions" job where job.owner = OLD."owner" and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_RESULT'); END;
--> statement-breakpoint
CREATE TRIGGER d1_result_identity BEFORE INSERT ON quiz_game_match_results
WHEN json_extract(NEW.payload, '$.owner') IS NOT NEW.owner
  OR json_extract(NEW.payload, '$.matchId') IS NOT NEW.match_id
  OR json_extract(NEW.payload, '$.result.id') IS NOT NEW.result_id
BEGIN SELECT RAISE(ABORT, 'INVALID_RESULT_IDENTITY'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_result_player_delete" before DELETE on "quiz_game_result_players" when not (exists(select 1 from "quiz_game_instance_deletions" job where job.owner = (select owner from "quiz_game_match_results" where result_id=OLD.result_id) and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_RESULT_PLAYER'); END;
--> statement-breakpoint
CREATE TRIGGER d1_result_player_membership BEFORE INSERT ON quiz_game_result_players
WHEN NOT EXISTS (
  SELECT 1 FROM quiz_game_match_results AS result, json_each(result.payload, '$.players') AS player
  WHERE result.result_id = NEW.result_id
    AND json_extract(player.value, '$.id') = NEW.actor_id
    AND json_extract(player.value, '$.name') = NEW.name
    AND json_extract(player.value, '$.ratingDelta') = NEW.rating_delta
)
BEGIN SELECT RAISE(ABORT, 'INVALID_RESULT_PLAYER'); END;
--> statement-breakpoint
CREATE TRIGGER d1_result_player_update BEFORE UPDATE ON quiz_game_result_players
    WHEN NOT (
      NEW.result_id = OLD.result_id AND NEW.actor_id = OLD.actor_id AND NEW.rating_delta = OLD.rating_delta
      AND EXISTS (SELECT 1 FROM quiz_game_result_privacy_changes permit, json_each(permit.payload, '$.players') player
        WHERE permit.result_id = OLD.result_id AND json_extract(player.value, '$.id') = OLD.actor_id
          AND json_extract(player.value, '$.name') = NEW.name)
    ) BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_RESULT_PLAYER'); END;
--> statement-breakpoint
CREATE TRIGGER d1_result_update BEFORE UPDATE ON quiz_game_match_results
    WHEN NOT (
      NEW.result_id = OLD.result_id AND NEW.owner = OLD.owner AND NEW.match_id = OLD.match_id AND NEW.finished_at = OLD.finished_at
      AND EXISTS (SELECT 1 FROM quiz_game_result_privacy_changes permit
        WHERE permit.result_id = OLD.result_id AND permit.previous_hash = OLD.payload_hash
          AND permit.payload_hash = NEW.payload_hash AND permit.payload = NEW.payload)
    ) BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_RESULT'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_ruleset_delete" before DELETE on "quiz_game_ruleset_versions" when not (exists(select 1 from "quiz_game_instance_deletions" job where job.owner = OLD."owner" and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
CREATE TRIGGER d1_ruleset_update BEFORE UPDATE ON quiz_game_ruleset_versions
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_submission_event_delete" before DELETE on "quiz_game_question_submission_events" when not (OLD."created_at" <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days') or exists(select 1 from "quiz_game_instance_deletions" job where job.owner = (select owner from "quiz_game_instances" where id=OLD.instance_id) and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_submission_event_update" before UPDATE on "quiz_game_question_submission_events" when not ((NEW."id" is OLD."id" and NEW."submission_id" is OLD."submission_id" and NEW."instance_id" is OLD."instance_id" and NEW."revision" is OLD."revision" and NEW."actor_id" is OLD."actor_id" and NEW."action" is OLD."action" and NEW."input" is OLD."input" and NEW."reason" is OLD."reason" and NEW."created_at" is OLD."created_at" ) or (exists(select 1 from "quiz_game_organization_accounts" where "quiz_game_organization_accounts"."withdrawn_at" is not null and ("quiz_game_organization_accounts"."actor_id" = OLD."actor_id")) and NEW."id" is OLD."id" and NEW."submission_id" is OLD."submission_id" and NEW."instance_id" is OLD."instance_id" and NEW."revision" is OLD."revision" and NEW."actor_id" is OLD."actor_id" and NEW."action" is OLD."action" and NEW."input" is OLD."input" and NEW."created_at" is OLD."created_at" and NEW."reason" is case when OLD."reason" is null then null else '退会に伴い削除' end)) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_transfer_delete" before DELETE on "quiz_game_administrator_transfers" when not (OLD."created_at" <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days')) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_transfer_update" before UPDATE on "quiz_game_administrator_transfers" when not (NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."sender_id" is OLD."sender_id" and NEW."target_id" is OLD."target_id" and NEW."keep_sender" is OLD."keep_sender" and NEW."created_at" is OLD."created_at" and NEW."expires_at" is OLD."expires_at" and (OLD.state='pending' or NEW.state=OLD.state)) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_user_report_delete" before DELETE on "quiz_game_user_reports" when not (OLD."created_at" <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days') or exists(select 1 from "quiz_game_instance_deletions" job where job.owner = (select owner from "quiz_game_instances" where id=OLD.instance_id) and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
CREATE TRIGGER "d1_user_report_update" before UPDATE on "quiz_game_user_reports" when not ((NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."instance_id" is OLD."instance_id" and NEW."actor_id" is OLD."actor_id" and NEW."reporter_id" is OLD."reporter_id" and NEW."result_id" is OLD."result_id" and NEW."reason" is OLD."reason" and NEW."created_at" is OLD."created_at" and (OLD.resolved_at is null or NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."instance_id" is OLD."instance_id" and NEW."actor_id" is OLD."actor_id" and NEW."reporter_id" is OLD."reporter_id" and NEW."result_id" is OLD."result_id" and NEW."reason" is OLD."reason" and NEW."created_at" is OLD."created_at" and NEW."resolved_at" is OLD."resolved_at" and NEW."operator_id" is OLD."operator_id" and NEW."resolution" is OLD."resolution")) or (exists(select 1 from "quiz_game_organization_accounts" where "quiz_game_organization_accounts"."withdrawn_at" is not null and ("quiz_game_organization_accounts"."actor_id" = OLD."actor_id" or "quiz_game_organization_accounts"."actor_id" = OLD."reporter_id" or "quiz_game_organization_accounts"."actor_id" = OLD."operator_id")) and NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."instance_id" is OLD."instance_id" and NEW."actor_id" is OLD."actor_id" and NEW."reporter_id" is OLD."reporter_id" and NEW."result_id" is OLD."result_id" and NEW."created_at" is OLD."created_at" and NEW."resolved_at" is OLD."resolved_at" and NEW."operator_id" is OLD."operator_id" and NEW."reason" is case when OLD."reason" is null then null else '退会に伴い削除' end and NEW."resolution" is case when OLD."resolution" is null then null else '退会に伴い削除' end)) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
CREATE TRIGGER difficulty_trial_append AFTER INSERT ON quiz_game_difficulty_trials BEGIN
  INSERT INTO quiz_game_difficulty_samples(owner,generation,band,players,rules_hash,band_revision,trials,correct)
    VALUES(NEW.owner,NEW.generation,NEW.band,NEW.players,NEW.rules_hash,NEW.band_revision,1,NEW.correct)
    ON CONFLICT(owner,generation,band,players,rules_hash,band_revision) DO UPDATE SET trials=trials+1,correct=correct+NEW.correct;
  INSERT INTO quiz_game_difficulty_actors(owner,generation,band,players,rules_hash,band_revision,actor_id)
    SELECT NEW.owner,NEW.generation,NEW.band,NEW.players,NEW.rules_hash,NEW.band_revision,value FROM json_each(NEW.actors) WHERE 1
    ON CONFLICT DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER difficulty_trial_immutable BEFORE UPDATE ON quiz_game_difficulty_trials BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DIFFICULTY_TRIAL'); END;
--> statement-breakpoint
CREATE TRIGGER federation_actor_identity_update BEFORE UPDATE ON quiz_federation_actors
WHEN NEW.actor_id IS NOT OLD.actor_id OR NEW.peer_origin IS NOT OLD.peer_origin OR NEW.source_actor_id IS NOT OLD.source_actor_id
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_IDENTITY'); END;
--> statement-breakpoint
CREATE TRIGGER federation_control_delivery_keep BEFORE DELETE ON quiz_federation_control_deliveries
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_CONTROL'); END;
--> statement-breakpoint
CREATE TRIGGER federation_control_delivery_original BEFORE UPDATE ON quiz_federation_control_deliveries
WHEN NEW.event_id IS NOT OLD.event_id OR NEW.peer_origin IS NOT OLD.peer_origin OR NEW.payload IS NOT OLD.payload OR NEW.payload_hash IS NOT OLD.payload_hash OR (OLD.message IS NOT NULL AND NEW.message IS NOT OLD.message)
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_CONTROL'); END;
--> statement-breakpoint
CREATE TRIGGER federation_control_inbox_keep BEFORE DELETE ON quiz_federation_control_inbox
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_CONTROL'); END;
--> statement-breakpoint
CREATE TRIGGER federation_control_inbox_original BEFORE UPDATE ON quiz_federation_control_inbox
WHEN NEW.event_id IS NOT OLD.event_id OR NEW.peer_origin IS NOT OLD.peer_origin OR NEW.payload IS NOT OLD.payload OR NEW.payload_hash IS NOT OLD.payload_hash OR NEW.message IS NOT OLD.message OR NEW.received_at IS NOT OLD.received_at
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_CONTROL'); END;
--> statement-breakpoint
CREATE TRIGGER federation_deleted_instance_keep BEFORE DELETE ON quiz_federation_deleted_instances
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_RETIREMENT'); END;
--> statement-breakpoint
CREATE TRIGGER federation_deleted_instance_original BEFORE UPDATE ON quiz_federation_deleted_instances
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_RETIREMENT'); END;
--> statement-breakpoint
CREATE TRIGGER federation_peer_key_delete before delete on quiz_federation_peer_keys BEGIN select raise(abort, 'IMMUTABLE_PEER_KEY'); END;
--> statement-breakpoint
CREATE TRIGGER federation_peer_key_update before update on quiz_federation_peer_keys BEGIN select raise(abort, 'IMMUTABLE_PEER_KEY'); END;
--> statement-breakpoint
CREATE TRIGGER federation_reservation_binding_update BEFORE UPDATE ON quiz_federation_reservations
WHEN NEW.id IS NOT OLD.id OR NEW.peer_origin IS NOT OLD.peer_origin OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.request_hash IS NOT OLD.request_hash OR NEW.source_organization_id IS NOT OLD.source_organization_id
  OR NEW.source_actor_id IS NOT OLD.source_actor_id OR NEW.actor_id IS NOT OLD.actor_id OR NEW.instance_id IS NOT OLD.instance_id OR NEW.mode IS NOT OLD.mode
  OR (OLD.match_id IS NOT NULL AND NEW.match_id IS NOT OLD.match_id)
  OR (OLD.room_id IS NOT NULL AND NEW.room_id IS NOT OLD.room_id)
  OR (OLD.state = 'closed' AND NEW.state <> 'closed')
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_PARTICIPATION_BINDING'); END;
--> statement-breakpoint
CREATE TRIGGER federation_result_delivery_original_delete BEFORE DELETE ON quiz_federation_result_deliveries
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_RESULT'); END;
--> statement-breakpoint
CREATE TRIGGER federation_result_delivery_original_update BEFORE UPDATE ON quiz_federation_result_deliveries
WHEN NEW.event_id IS NOT OLD.event_id OR NEW.result_id IS NOT OLD.result_id OR NEW.instance_id IS NOT OLD.instance_id OR NEW.peer_origin IS NOT OLD.peer_origin
  OR NEW.source_actor_id IS NOT OLD.source_actor_id OR NEW.payload IS NOT OLD.payload OR NEW.payload_hash IS NOT OLD.payload_hash
  OR (OLD.message IS NOT NULL AND NEW.message IS NOT OLD.message)
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_RESULT'); END;
--> statement-breakpoint
CREATE TRIGGER federation_result_inbox_original_delete BEFORE DELETE ON quiz_federation_result_inbox
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_RESULT'); END;
--> statement-breakpoint
CREATE TRIGGER federation_result_inbox_original_update BEFORE UPDATE ON quiz_federation_result_inbox
WHEN NEW.peer_origin IS NOT OLD.peer_origin OR NEW.event_id IS NOT OLD.event_id OR NEW.actor_id IS NOT OLD.actor_id OR NEW.source_organization_id IS NOT OLD.source_organization_id
  OR NEW.payload IS NOT OLD.payload OR NEW.payload_hash IS NOT OLD.payload_hash OR NEW.message IS NOT OLD.message
  OR NEW.received_at IS NOT OLD.received_at OR NEW.finished_at IS NOT OLD.finished_at
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_RESULT'); END;
--> statement-breakpoint
CREATE TRIGGER federation_retired_identity_keep BEFORE DELETE ON quiz_federation_retired_identities
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_RETIREMENT'); END;
--> statement-breakpoint
CREATE TRIGGER federation_retired_identity_original BEFORE UPDATE ON quiz_federation_retired_identities
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_RETIREMENT'); END;
--> statement-breakpoint
CREATE TRIGGER `quiz_database_revision_guard`
BEFORE UPDATE ON `quiz_database_revision`
WHEN NEW.id <> OLD.id OR NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'STALE_D1_SNAPSHOT');
END;
--> statement-breakpoint
CREATE TRIGGER result_privacy_schedule AFTER INSERT ON quiz_game_match_results
WHEN json_type(NEW.payload,'$.completedQuestions')='array' OR EXISTS(SELECT 1 FROM json_each(NEW.payload,'$.players') WHERE json_extract(value,'$.guest')=1)
BEGIN
 INSERT INTO quiz_game_result_privacy_jobs(result_id,due_at) VALUES(NEW.result_id,
 strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(NEW.payload,'$.result.finishedAt')/1000.0,'unixepoch',
 CASE WHEN json_extract(NEW.payload,'$.definition.original')=1 OR EXISTS(SELECT 1 FROM json_each(NEW.payload,'$.players') WHERE json_extract(value,'$.guest')=1) THEN '+30 days' ELSE '+365 days' END));
END;
--> statement-breakpoint
CREATE TRIGGER shared_question_identity BEFORE UPDATE ON quiz_federation_question_links
WHEN OLD.instance_id<>NEW.instance_id OR OLD.peer_origin<>NEW.peer_origin OR OLD.source_instance_id<>NEW.source_instance_id OR OLD.source_series_id<>NEW.source_series_id OR OLD.submission_id<>NEW.submission_id
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SHARED_IDENTITY'); END;
--> statement-breakpoint
CREATE TRIGGER shared_question_staging_update BEFORE UPDATE ON quiz_federation_question_staging
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SHARED_PAGE'); END;
--> statement-breakpoint
CREATE TRIGGER withdrawal_receipt_completion BEFORE UPDATE ON quiz_game_account_withdrawals
WHEN ((OLD.auth_deleted_at IS NOT NULL AND NEW.auth_deleted_at IS NOT OLD.auth_deleted_at) OR (OLD.erased_at IS NOT NULL AND NEW.erased_at IS NOT OLD.erased_at))
AND NOT (NEW.auth_deleted_at IS NULL AND NEW.erased_at IS NULL AND NEW.audit_erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM quiz_game_instances WHERE organization_id=OLD.organization_id AND (state='published' OR room_inventory_complete=1)))
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_WITHDRAWAL_COMPLETION'); END;
--> statement-breakpoint
CREATE TRIGGER withdrawal_receipt_delete BEFORE DELETE ON quiz_game_account_withdrawals BEGIN SELECT RAISE(ABORT,'IMMUTABLE_WITHDRAWAL_RECEIPT'); END;
--> statement-breakpoint
CREATE TRIGGER withdrawal_receipt_identity BEFORE UPDATE ON quiz_game_account_withdrawals
WHEN NEW.id IS NOT OLD.id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.actor_id IS NOT OLD.actor_id OR NEW.requested_at IS NOT OLD.requested_at
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_WITHDRAWAL_RECEIPT'); END;
