UPDATE quiz_game.instance_deletions SET accepted_at=coalesce(deleted_at,requested_at);
--> statement-breakpoint
GRANT UPDATE (room_cursor,last_attempt_at) ON quiz_game.account_withdrawals TO quiz_erasure;
GRANT UPDATE (review_attempted_at) ON quiz_game.instance_rooms TO quiz_erasure;
CREATE POLICY erasure_review_progress ON quiz_game.instance_rooms FOR UPDATE TO quiz_erasure USING (true) WITH CHECK (true);
GRANT UPDATE (accepted_at,check_cursor,room_cursor,inventory_pending,last_attempt_at) ON quiz_game.instance_deletions TO quiz_erasure;
CREATE POLICY erasure_deletion_progress ON quiz_game.instance_deletions FOR UPDATE TO quiz_erasure USING (true) WITH CHECK (true);
GRANT DELETE ON quiz_game.instance_deletions TO quiz_erasure;
CREATE POLICY erasure_rejected_check ON quiz_game.instance_deletions FOR DELETE TO quiz_erasure USING (accepted_at IS NULL AND deleted_at IS NULL);
GRANT SELECT,INSERT,UPDATE,DELETE ON quiz_game.room_inventory_scans TO quiz_erasure;
REVOKE ALL ON quiz_game.room_inventory_scans FROM PUBLIC,anon,authenticated;
CREATE POLICY erasure_inventory_progress ON quiz_game.room_inventory_scans TO quiz_erasure USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION quiz_game.erase_instance(operation_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,quiz_game AS $$
DECLARE job quiz_game.instance_deletions;
BEGIN
 SELECT * INTO STRICT job FROM quiz_game.instance_deletions WHERE id=operation_id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended('questions:'||job.instance_id::text,0));
 IF NOT (job.deleted_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM quiz_game.instances WHERE id=job.instance_id)) AND NOT EXISTS(SELECT 1 FROM quiz_game.instances WHERE id=job.instance_id AND organization_id=job.organization_id AND owner=job.owner AND name=job.name AND state='archived' AND room_inventory_complete) THEN RAISE EXCEPTION 'instance deletion conflict'; END IF;
 IF job.accepted_at IS NULL THEN RAISE EXCEPTION 'instance deletion not accepted'; END IF;
 PERFORM set_config('quiz.deletion_id',job.id::text,true);
 DELETE FROM quiz_game.sanction_appeals WHERE sanction_id IN (SELECT id FROM quiz_game.moderation_sanctions WHERE instance_id=job.instance_id);
 DELETE FROM quiz_game.moderation_sanctions WHERE instance_id=job.instance_id;
 DELETE FROM quiz_game.moderation_events WHERE instance_id=job.instance_id;
 DELETE FROM quiz_game.user_reports WHERE instance_id=job.instance_id;
 DELETE FROM quiz_game.moderation_requests WHERE (details->>'instanceId'=job.instance_id::text OR details->>'id'=job.instance_id::text) AND coalesce(details->>'organizationWide','false')<>'true';
 DELETE FROM quiz_game.organization_events WHERE instance_id=job.instance_id;
 DELETE FROM quiz_game.question_notifications WHERE instance_id=job.instance_id;
 DELETE FROM quiz_game.question_submission_events WHERE instance_id=job.instance_id;
 DELETE FROM quiz_game.question_imports WHERE instance_id=job.instance_id;
 DELETE FROM quiz_game.question_reports WHERE instance_id=job.instance_id;
 DELETE FROM quiz_game.question_review_cases WHERE instance_id=job.instance_id;
 DELETE FROM quiz_game.question_difficulty WHERE instance_id=job.instance_id;
 DELETE FROM quiz_game.question_submissions WHERE instance_id=job.instance_id;
 DELETE FROM quiz_game.question_authors WHERE instance_id=job.instance_id;
 DELETE FROM quiz_game.question_categories WHERE instance_id=job.instance_id;
 DELETE FROM quiz_game.question_tags WHERE instance_id=job.instance_id;
 DELETE FROM quiz_game.question_settings WHERE instance_id=job.instance_id;
 DELETE FROM quiz_game.result_outbox WHERE result_id IN (SELECT result_id FROM quiz_game.match_results WHERE owner=job.owner);
 DELETE FROM quiz_game.result_players WHERE result_id IN (SELECT result_id FROM quiz_game.match_results WHERE owner=job.owner);
 DELETE FROM quiz_game.match_results WHERE owner=job.owner;
 DELETE FROM quiz_game.matchmaking_settings WHERE owner=job.owner;
 DELETE FROM quiz_game.competitions WHERE owner=job.owner;
 DELETE FROM quiz_game.question_set_items WHERE owner=job.owner;
 DELETE FROM quiz_game.question_sets WHERE owner=job.owner;
 DELETE FROM quiz_game.question_availability WHERE owner=job.owner;
 DELETE FROM quiz_game.question_versions WHERE owner=job.owner;
 DELETE FROM quiz_game.ruleset_versions WHERE owner=job.owner;
 DELETE FROM quiz_game.catalog_operators WHERE owner=job.owner;
 DELETE FROM quiz_game.instance_grants WHERE instance_id=job.instance_id;
 DELETE FROM quiz_game.instance_rooms WHERE instance_id=job.instance_id;
 DELETE FROM quiz_game.instances WHERE id=job.instance_id;
 UPDATE quiz_game.instance_deletions SET deleted_at=coalesce(deleted_at,now()) WHERE id=job.id;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION quiz_game.prevent_deleted_instance_data() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,quiz_game AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM quiz_game.instance_deletions WHERE (owner=to_jsonb(NEW)->>'owner' OR (TG_TABLE_NAME='instances' AND instance_id::text=to_jsonb(NEW)->>'id')) AND (TG_TABLE_NAME<>'match_results' OR accepted_at IS NOT NULL OR deleted_at IS NOT NULL)) THEN RAISE EXCEPTION 'instance deletion recorded'; END IF;
 RETURN NEW;
END $$;
