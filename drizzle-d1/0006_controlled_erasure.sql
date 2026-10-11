-- Controlled privacy changes preserve result, catalog, and audit originals.
drop trigger "d1_result_delete";
--> statement-breakpoint
create trigger "d1_result_delete" before DELETE on "quiz_game_match_results" when not (exists(select 1 from "quiz_game_instance_deletions" job where job.owner = OLD."owner" and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_RESULT'); END;
--> statement-breakpoint
drop trigger "d1_outbox_delete";
--> statement-breakpoint
create trigger "d1_outbox_delete" before DELETE on "quiz_game_result_outbox" when not (exists(select 1 from "quiz_game_instance_deletions" job where job.owner = (select owner from "quiz_game_match_results" where result_id=OLD.result_id) and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_OUTBOX'); END;
--> statement-breakpoint
drop trigger "d1_result_player_delete";
--> statement-breakpoint
create trigger "d1_result_player_delete" before DELETE on "quiz_game_result_players" when not (exists(select 1 from "quiz_game_instance_deletions" job where job.owner = (select owner from "quiz_game_match_results" where result_id=OLD.result_id) and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_RESULT_PLAYER'); END;
--> statement-breakpoint
drop trigger "d1_question_version_delete";
--> statement-breakpoint
create trigger "d1_question_version_delete" before DELETE on "quiz_game_question_versions" when not (exists(select 1 from "quiz_game_instance_deletions" job where job.owner = OLD."owner" and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
drop trigger "d1_question_set_delete";
--> statement-breakpoint
create trigger "d1_question_set_delete" before DELETE on "quiz_game_question_sets" when not (exists(select 1 from "quiz_game_instance_deletions" job where job.owner = OLD."owner" and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
drop trigger "d1_question_set_item_delete";
--> statement-breakpoint
create trigger "d1_question_set_item_delete" before DELETE on "quiz_game_question_set_items" when not (exists(select 1 from "quiz_game_instance_deletions" job where job.owner = OLD."owner" and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
drop trigger "d1_ruleset_delete";
--> statement-breakpoint
create trigger "d1_ruleset_delete" before DELETE on "quiz_game_ruleset_versions" when not (exists(select 1 from "quiz_game_instance_deletions" job where job.owner = OLD."owner" and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
drop trigger "d1_competition_delete";
--> statement-breakpoint
create trigger "d1_competition_delete" before DELETE on "quiz_game_competitions" when not (exists(select 1 from "quiz_game_instance_deletions" job where job.owner = OLD."owner" and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_CATALOG'); END;
--> statement-breakpoint
drop trigger d1_question_set_update;
--> statement-breakpoint
create trigger "d1_question_set_update" before UPDATE on "quiz_game_question_sets" when not (NEW."owner" is OLD."owner" and NEW."set_id" is OLD."set_id" and NEW."version" is OLD."version" and NEW."manifest_hash" is OLD."manifest_hash" and (NEW.selection is case when json_type(OLD."selection", '$.authorNames') = 'object'
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
create trigger "d1_deleted_result" before INSERT on "quiz_game_match_results" when not (not exists(select 1 from "quiz_game_instance_deletions" where owner=NEW."owner" and (accepted_at is not null or deleted_at is not null))) BEGIN select raise(abort, 'INSTANCE_DELETION_RECORDED'); END;
--> statement-breakpoint
create trigger "d1_deleted_version" before INSERT on "quiz_game_question_versions" when not (not exists(select 1 from "quiz_game_instance_deletions" where owner=NEW."owner" )) BEGIN select raise(abort, 'INSTANCE_DELETION_RECORDED'); END;
--> statement-breakpoint
create trigger "d1_deleted_set" before INSERT on "quiz_game_question_sets" when not (not exists(select 1 from "quiz_game_instance_deletions" where owner=NEW."owner" )) BEGIN select raise(abort, 'INSTANCE_DELETION_RECORDED'); END;
--> statement-breakpoint
create trigger "d1_deleted_set_item" before INSERT on "quiz_game_question_set_items" when not (not exists(select 1 from "quiz_game_instance_deletions" where owner=NEW."owner" )) BEGIN select raise(abort, 'INSTANCE_DELETION_RECORDED'); END;
--> statement-breakpoint
create trigger "d1_deleted_ruleset" before INSERT on "quiz_game_ruleset_versions" when not (not exists(select 1 from "quiz_game_instance_deletions" where owner=NEW."owner" )) BEGIN select raise(abort, 'INSTANCE_DELETION_RECORDED'); END;
--> statement-breakpoint
create trigger "d1_deleted_competition" before INSERT on "quiz_game_competitions" when not (not exists(select 1 from "quiz_game_instance_deletions" where owner=NEW."owner" )) BEGIN select raise(abort, 'INSTANCE_DELETION_RECORDED'); END;
--> statement-breakpoint
create trigger "d1_deleted_availability" before INSERT on "quiz_game_question_availability" when not (not exists(select 1 from "quiz_game_instance_deletions" where owner=NEW."owner" )) BEGIN select raise(abort, 'INSTANCE_DELETION_RECORDED'); END;
--> statement-breakpoint
create trigger "d1_deleted_matchmaking" before INSERT on "quiz_game_matchmaking_settings" when not (not exists(select 1 from "quiz_game_instance_deletions" where owner=NEW."owner" )) BEGIN select raise(abort, 'INSTANCE_DELETION_RECORDED'); END;
--> statement-breakpoint
create trigger "d1_deleted_instance" before INSERT on "quiz_game_instances" when not (not exists(select 1 from "quiz_game_instance_deletions" where instance_id=NEW.id or owner=NEW.owner)) BEGIN select raise(abort, 'INSTANCE_DELETION_RECORDED'); END;
--> statement-breakpoint
create trigger "d1_account_identity" before UPDATE on "quiz_game_organization_accounts" when not (NEW."organization_id" is OLD."organization_id" and NEW."subject" is OLD."subject" and NEW."actor_id" is OLD."actor_id" and (OLD.withdrawn_at is null or (NEW.withdrawn_at is OLD.withdrawn_at and NEW.display_name is null and not NEW.administrator))) BEGIN select raise(abort, 'ACCOUNT_IDENTITY_CONFLICT'); END;
--> statement-breakpoint
create trigger "d1_deletion_receipt" before UPDATE on "quiz_game_instance_deletions" when not (NEW."id" is OLD."id" and NEW."instance_id" is OLD."instance_id" and NEW."organization_id" is OLD."organization_id" and NEW."owner" is OLD."owner" and NEW."name" is OLD."name" and NEW."operator_id" is OLD."operator_id" and NEW."requested_at" is OLD."requested_at" and (OLD.deleted_at is null or NEW.deleted_at is OLD.deleted_at) and (OLD.accepted_at is null or NEW.accepted_at is OLD.accepted_at)) BEGIN select raise(abort, 'DELETION_RECEIPT_CONFLICT'); END;
--> statement-breakpoint
create trigger "d1_deletion_receipt_delete" before DELETE on "quiz_game_instance_deletions" when not (OLD.accepted_at is null and OLD.deleted_at is null) BEGIN select raise(abort, 'DELETION_RECEIPT_CONFLICT'); END;
--> statement-breakpoint
create trigger "d1_moderation_event_update" before UPDATE on "quiz_game_moderation_events" when not ((NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."instance_id" is OLD."instance_id" and NEW."actor_id" is OLD."actor_id" and NEW."operator_id" is OLD."operator_id" and NEW."action" is OLD."action" and NEW."reason" is OLD."reason" and NEW."request_hash" is OLD."request_hash" and NEW."before" is OLD."before" and NEW."after" is OLD."after" and NEW."created_at" is OLD."created_at" ) or (exists(select 1 from "quiz_game_organization_accounts" where "quiz_game_organization_accounts"."withdrawn_at" is not null and ("quiz_game_organization_accounts"."actor_id" = OLD."actor_id" or "quiz_game_organization_accounts"."actor_id" = OLD."operator_id")) and NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."instance_id" is OLD."instance_id" and NEW."actor_id" is OLD."actor_id" and NEW."operator_id" is OLD."operator_id" and NEW."action" is OLD."action" and NEW."request_hash" is OLD."request_hash" and NEW."created_at" is OLD."created_at" and NEW."read_at" is OLD."read_at" and NEW."reason" is case when OLD."reason" is null then null else '退会に伴い削除' end and NEW."before" is case when json_type(OLD."before", '$.reason') is not null then json_set(OLD."before", '$.reason', '退会に伴い削除') else OLD."before" end and NEW."after" is case when json_type(OLD."after", '$.reason') is not null then json_set(OLD."after", '$.reason', '退会に伴い削除') else OLD."after" end)) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
create trigger "d1_moderation_event_delete" before DELETE on "quiz_game_moderation_events" when not (OLD."created_at" <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days') or exists(select 1 from "quiz_game_instance_deletions" job where job.owner = (select owner from "quiz_game_instances" where id=OLD.instance_id) and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
create trigger "d1_organization_event_update" before UPDATE on "quiz_game_organization_events" when not ((NEW."id" is OLD."id" and NEW."actor_id" is OLD."actor_id" and NEW."instance_id" is OLD."instance_id" and NEW."action" is OLD."action" and NEW."occurred_at" is OLD."occurred_at" and NEW."details" is OLD."details" ) or (exists(select 1 from "quiz_game_organization_accounts" where "quiz_game_organization_accounts"."withdrawn_at" is not null and ("quiz_game_organization_accounts"."actor_id" = OLD."actor_id" or json_extract(OLD."details", '$.actorId') = "quiz_game_organization_accounts"."actor_id" or exists(select 1 from json_each(OLD."details", '$.targets') target where target.value = "quiz_game_organization_accounts"."actor_id" or json_extract(case when target.type = 'object' then target.value else '{}' end, '$.actorId') = "quiz_game_organization_accounts"."actor_id"))) and NEW."id" is OLD."id" and NEW."actor_id" is OLD."actor_id" and NEW."instance_id" is OLD."instance_id" and NEW."action" is OLD."action" and NEW."occurred_at" is OLD."occurred_at" and NEW."details" is json_object('action', json_extract(OLD."details", '$.action'), 'redacted', json('true')))) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
create trigger "d1_organization_event_delete" before DELETE on "quiz_game_organization_events" when not (OLD."occurred_at" <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days') or exists(select 1 from "quiz_game_instance_deletions" job where job.owner = (select owner from "quiz_game_instances" where id=OLD.instance_id) and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
create trigger "d1_submission_event_update" before UPDATE on "quiz_game_question_submission_events" when not ((NEW."id" is OLD."id" and NEW."submission_id" is OLD."submission_id" and NEW."instance_id" is OLD."instance_id" and NEW."revision" is OLD."revision" and NEW."actor_id" is OLD."actor_id" and NEW."action" is OLD."action" and NEW."input" is OLD."input" and NEW."reason" is OLD."reason" and NEW."created_at" is OLD."created_at" ) or (exists(select 1 from "quiz_game_organization_accounts" where "quiz_game_organization_accounts"."withdrawn_at" is not null and ("quiz_game_organization_accounts"."actor_id" = OLD."actor_id")) and NEW."id" is OLD."id" and NEW."submission_id" is OLD."submission_id" and NEW."instance_id" is OLD."instance_id" and NEW."revision" is OLD."revision" and NEW."actor_id" is OLD."actor_id" and NEW."action" is OLD."action" and NEW."input" is OLD."input" and NEW."created_at" is OLD."created_at" and NEW."reason" is case when OLD."reason" is null then null else '退会に伴い削除' end)) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
create trigger "d1_submission_event_delete" before DELETE on "quiz_game_question_submission_events" when not (OLD."created_at" <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days') or exists(select 1 from "quiz_game_instance_deletions" job where job.owner = (select owner from "quiz_game_instances" where id=OLD.instance_id) and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
create trigger "d1_moderation_request_update" before UPDATE on "quiz_game_moderation_requests" when not ((NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."operator_id" is OLD."operator_id" and NEW."request_hash" is OLD."request_hash" and NEW."details" is OLD."details" and NEW."created_at" is OLD."created_at" ) or (exists(select 1 from "quiz_game_organization_accounts" where "quiz_game_organization_accounts"."withdrawn_at" is not null and ("quiz_game_organization_accounts"."actor_id" = OLD."operator_id" or json_extract(OLD."details", '$.actorId') = "quiz_game_organization_accounts"."actor_id" or exists(select 1 from json_each(OLD."details", '$.targets') target where target.value = "quiz_game_organization_accounts"."actor_id" or json_extract(case when target.type = 'object' then target.value else '{}' end, '$.actorId') = "quiz_game_organization_accounts"."actor_id"))) and NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."operator_id" is OLD."operator_id" and NEW."request_hash" is OLD."request_hash" and NEW."created_at" is OLD."created_at" and NEW."details" is json_object('action', json_extract(OLD."details", '$.action'), 'redacted', json('true')))) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
create trigger "d1_moderation_request_delete" before DELETE on "quiz_game_moderation_requests" when not (OLD."created_at" <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days') or exists(select 1 from "quiz_game_instance_deletions" job where job.owner = (select owner from "quiz_game_instances" where id=coalesce(json_extract(OLD.details,'$.instanceId'),json_extract(OLD.details,'$.id')) and coalesce(json_extract(OLD.details,'$.organizationWide'),0)<>1) and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
create trigger "d1_user_report_update" before UPDATE on "quiz_game_user_reports" when not ((NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."instance_id" is OLD."instance_id" and NEW."actor_id" is OLD."actor_id" and NEW."reporter_id" is OLD."reporter_id" and NEW."result_id" is OLD."result_id" and NEW."reason" is OLD."reason" and NEW."created_at" is OLD."created_at" and (OLD.resolved_at is null or NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."instance_id" is OLD."instance_id" and NEW."actor_id" is OLD."actor_id" and NEW."reporter_id" is OLD."reporter_id" and NEW."result_id" is OLD."result_id" and NEW."reason" is OLD."reason" and NEW."created_at" is OLD."created_at" and NEW."resolved_at" is OLD."resolved_at" and NEW."operator_id" is OLD."operator_id" and NEW."resolution" is OLD."resolution")) or (exists(select 1 from "quiz_game_organization_accounts" where "quiz_game_organization_accounts"."withdrawn_at" is not null and ("quiz_game_organization_accounts"."actor_id" = OLD."actor_id" or "quiz_game_organization_accounts"."actor_id" = OLD."reporter_id" or "quiz_game_organization_accounts"."actor_id" = OLD."operator_id")) and NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."instance_id" is OLD."instance_id" and NEW."actor_id" is OLD."actor_id" and NEW."reporter_id" is OLD."reporter_id" and NEW."result_id" is OLD."result_id" and NEW."created_at" is OLD."created_at" and NEW."resolved_at" is OLD."resolved_at" and NEW."operator_id" is OLD."operator_id" and NEW."reason" is case when OLD."reason" is null then null else '退会に伴い削除' end and NEW."resolution" is case when OLD."resolution" is null then null else '退会に伴い削除' end)) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
create trigger "d1_user_report_delete" before DELETE on "quiz_game_user_reports" when not (OLD."created_at" <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days') or exists(select 1 from "quiz_game_instance_deletions" job where job.owner = (select owner from "quiz_game_instances" where id=OLD.instance_id) and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
create trigger "d1_appeal_update" before UPDATE on "quiz_game_sanction_appeals" when not ((NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."actor_id" is OLD."actor_id" and NEW."sanction_id" is OLD."sanction_id" and NEW."sanction_revision" is OLD."sanction_revision" and NEW."reason" is OLD."reason" and NEW."created_at" is OLD."created_at" and (OLD.resolved_at is null or NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."actor_id" is OLD."actor_id" and NEW."sanction_id" is OLD."sanction_id" and NEW."sanction_revision" is OLD."sanction_revision" and NEW."reason" is OLD."reason" and NEW."created_at" is OLD."created_at" and NEW."resolved_at" is OLD."resolved_at" and NEW."operator_id" is OLD."operator_id" and NEW."resolution" is OLD."resolution" and NEW."decision" is OLD."decision")) or (exists(select 1 from "quiz_game_organization_accounts" where "quiz_game_organization_accounts"."withdrawn_at" is not null and ("quiz_game_organization_accounts"."actor_id" = OLD."actor_id" or "quiz_game_organization_accounts"."actor_id" = OLD."operator_id")) and NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."actor_id" is OLD."actor_id" and NEW."sanction_id" is OLD."sanction_id" and NEW."sanction_revision" is OLD."sanction_revision" and NEW."created_at" is OLD."created_at" and NEW."resolved_at" is OLD."resolved_at" and NEW."operator_id" is OLD."operator_id" and NEW."decision" is OLD."decision" and NEW."read_at" is OLD."read_at" and NEW."reason" is case when OLD."reason" is null then null else '退会に伴い削除' end and NEW."resolution" is case when OLD."resolution" is null then null else '退会に伴い削除' end)) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
create trigger "d1_appeal_delete" before DELETE on "quiz_game_sanction_appeals" when not (OLD."created_at" <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days') or exists(select 1 from "quiz_game_instance_deletions" job where job.owner = (select owner from "quiz_game_instances" join "quiz_game_moderation_sanctions" sanction on sanction.instance_id="quiz_game_instances"."id" where sanction.id=OLD.sanction_id) and job.accepted_at is not null and ((job.deleted_at is not null and not exists(select 1 from "quiz_game_instances" where id = job.instance_id)) or exists(select 1 from "quiz_game_instances" where id=job.instance_id and organization_id=job.organization_id and owner=job.owner and name=job.name and state='archived' and room_inventory_complete)))) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
create trigger "d1_transfer_update" before UPDATE on "quiz_game_administrator_transfers" when not (NEW."id" is OLD."id" and NEW."organization_id" is OLD."organization_id" and NEW."sender_id" is OLD."sender_id" and NEW."target_id" is OLD."target_id" and NEW."keep_sender" is OLD."keep_sender" and NEW."created_at" is OLD."created_at" and NEW."expires_at" is OLD."expires_at" and (OLD.state='pending' or NEW.state=OLD.state)) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
--> statement-breakpoint
create trigger "d1_transfer_delete" before DELETE on "quiz_game_administrator_transfers" when not (OLD."created_at" <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days')) BEGIN select raise(abort, 'IMMUTABLE_AUDIT'); END;
