GRANT SELECT, DELETE ON quiz_game.instance_rooms, quiz_game.instance_grants, quiz_game.instances, quiz_game.question_authors, quiz_game.question_availability, quiz_game.question_categories, quiz_game.question_difficulty, quiz_game.question_imports, quiz_game.question_reports, quiz_game.question_review_cases, quiz_game.question_sets, quiz_game.question_set_items, quiz_game.question_settings, quiz_game.question_submissions, quiz_game.question_tags, quiz_game.question_versions, quiz_game.matchmaking_settings, quiz_game.competitions, quiz_game.ruleset_versions, quiz_game.catalog_operators, quiz_game.moderation_sanctions TO quiz_privacy_internal;
GRANT DELETE ON quiz_game.match_results, quiz_game.result_players, quiz_game.result_outbox TO quiz_privacy_internal;
GRANT SELECT, UPDATE (deleted_at) ON quiz_game.instance_deletions TO quiz_privacy_internal;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['instance_rooms','instance_grants','question_authors','question_availability','question_categories','question_difficulty','question_imports','question_reports','question_review_cases','question_sets','question_set_items','question_settings','question_tags','matchmaking_settings','competitions','ruleset_versions','catalog_operators','moderation_sanctions','instance_deletions'] LOOP
  EXECUTE format('CREATE POLICY privacy_internal ON quiz_game.%I TO quiz_privacy_internal USING (true) WITH CHECK (true)',t);
 END LOOP;
END $$;
CREATE POLICY privacy_delete ON quiz_game.instances FOR DELETE TO quiz_privacy_internal USING (true);
CREATE POLICY privacy_delete ON quiz_game.question_submissions FOR DELETE TO quiz_privacy_internal USING (true);
CREATE POLICY privacy_delete ON quiz_game.question_versions FOR DELETE TO quiz_privacy_internal USING (true);
--> statement-breakpoint
CREATE FUNCTION quiz_game.instance_erasure_allowed(table_name text, row_data jsonb) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,quiz_game AS $$
DECLARE job quiz_game.instance_deletions;
BEGIN
 IF current_user<>'quiz_privacy_internal' THEN RETURN false; END IF;
 SELECT * INTO job FROM quiz_game.instance_deletions WHERE id::text=current_setting('quiz.deletion_id',true);
 IF job.id IS NULL THEN RETURN false; END IF;
 IF table_name='instances' THEN RETURN row_data->>'id'=job.instance_id::text; END IF;
 IF row_data ? 'instance_id' THEN RETURN row_data->>'instance_id'=job.instance_id::text; END IF;
 IF row_data ? 'owner' THEN RETURN row_data->>'owner'=job.owner; END IF;
 IF table_name IN ('result_outbox','result_players') THEN RETURN EXISTS(SELECT 1 FROM quiz_game.match_results WHERE result_id::text=row_data->>'result_id' AND owner=job.owner); END IF;
 IF table_name='sanction_appeals' THEN RETURN EXISTS(SELECT 1 FROM quiz_game.moderation_sanctions WHERE id::text=row_data->>'sanction_id' AND instance_id=job.instance_id); END IF;
 IF table_name='moderation_requests' THEN RETURN (row_data->'details'->>'instanceId'=job.instance_id::text OR row_data->'details'->>'id'=job.instance_id::text) AND coalesce(row_data->'details'->>'organizationWide','false')<>'true'; END IF;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION quiz_game.instance_erasure_allowed(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quiz_game.instance_erasure_allowed(text,jsonb) TO quiz_privacy_internal,quiz_organization,quiz_game_results,quiz_game_catalog,quiz_game_config;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION quiz_game.protect_result_privacy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND quiz_game.instance_erasure_allowed(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
 IF TG_OP='UPDATE' AND current_user='quiz_privacy_internal' THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'result is immutable';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION quiz_game.reject_version_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND quiz_game.instance_erasure_allowed(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' AND current_user='quiz_privacy_internal' AND TG_TABLE_NAME IN ('organization_events','question_submission_events') THEN
  IF coalesce((to_jsonb(OLD)->>'occurred_at')::timestamptz,(to_jsonb(OLD)->>'created_at')::timestamptz) <= now()-interval '365 days' THEN RETURN OLD; END IF;
 END IF;
 RAISE EXCEPTION 'IMMUTABLE_VERSION';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION quiz_game.protect_moderation_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF quiz_game.instance_erasure_allowed(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
  IF current_user='quiz_privacy_internal' AND OLD.created_at <= now()-interval '365 days' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'immutable moderation event';
 END IF;
 IF (to_jsonb(NEW)-'read_at') IS DISTINCT FROM (to_jsonb(OLD)-'read_at') THEN RAISE EXCEPTION 'immutable moderation event'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION quiz_game.protect_moderation_workflow() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed text[];
BEGIN
 IF TG_OP='DELETE' THEN
  IF quiz_game.instance_erasure_allowed(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
  IF current_user='quiz_privacy_internal' AND OLD.created_at <= now()-interval '365 days' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'immutable moderation history';
 END IF;
 IF TG_TABLE_NAME='moderation_requests' THEN RAISE EXCEPTION 'immutable moderation request'; END IF;
 IF TG_TABLE_NAME='user_reports' THEN
  allowed:=ARRAY['resolved_at','operator_id','resolution'];
  IF OLD.resolved_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'resolved report'; END IF;
 ELSIF TG_TABLE_NAME='sanction_appeals' THEN
  allowed:=ARRAY['resolved_at','operator_id','resolution','decision','read_at'];
  IF OLD.resolved_at IS NOT NULL AND (to_jsonb(NEW)-'read_at') IS DISTINCT FROM (to_jsonb(OLD)-'read_at') THEN RAISE EXCEPTION 'resolved appeal'; END IF;
 ELSE
  allowed:=ARRAY['state','read_at'];
  IF OLD.state<>'pending' AND NEW.state IS DISTINCT FROM OLD.state THEN RAISE EXCEPTION 'completed transfer'; END IF;
 END IF;
 IF (to_jsonb(NEW)-allowed) IS DISTINCT FROM (to_jsonb(OLD)-allowed) THEN RAISE EXCEPTION 'immutable moderation evidence'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION quiz_game.erase_instance(operation_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,quiz_game AS $$
DECLARE job quiz_game.instance_deletions;
BEGIN
 SELECT * INTO STRICT job FROM quiz_game.instance_deletions WHERE id=operation_id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended('questions:'||job.instance_id::text,0));
 IF NOT (job.deleted_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM quiz_game.instances WHERE id=job.instance_id)) AND NOT EXISTS(SELECT 1 FROM quiz_game.instances WHERE id=job.instance_id AND organization_id=job.organization_id AND owner=job.owner AND name=job.name AND state='archived' AND room_inventory_complete) THEN RAISE EXCEPTION 'instance deletion conflict'; END IF;
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
ALTER FUNCTION quiz_game.erase_instance(uuid) OWNER TO quiz_privacy_internal;
REVOKE ALL ON FUNCTION quiz_game.erase_instance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quiz_game.erase_instance(uuid) TO quiz_erasure;
--> statement-breakpoint
CREATE FUNCTION quiz_game.prevent_deleted_instance_data() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,quiz_game AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM quiz_game.instance_deletions WHERE owner=to_jsonb(NEW)->>'owner' OR (TG_TABLE_NAME='instances' AND instance_id::text=to_jsonb(NEW)->>'id')) THEN RAISE EXCEPTION 'instance deletion recorded'; END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION quiz_game.prevent_deleted_instance_data() OWNER TO quiz_privacy_internal;
REVOKE ALL ON FUNCTION quiz_game.prevent_deleted_instance_data() FROM PUBLIC;
CREATE TRIGGER prevent_deleted_instance BEFORE INSERT ON quiz_game.instances FOR EACH ROW EXECUTE FUNCTION quiz_game.prevent_deleted_instance_data();
CREATE TRIGGER prevent_deleted_result BEFORE INSERT ON quiz_game.match_results FOR EACH ROW EXECUTE FUNCTION quiz_game.prevent_deleted_instance_data();
CREATE TRIGGER prevent_deleted_question BEFORE INSERT ON quiz_game.question_versions FOR EACH ROW EXECUTE FUNCTION quiz_game.prevent_deleted_instance_data();
CREATE TRIGGER prevent_deleted_catalog BEFORE INSERT ON quiz_game.question_sets FOR EACH ROW EXECUTE FUNCTION quiz_game.prevent_deleted_instance_data();
CREATE TRIGGER prevent_deleted_rules BEFORE INSERT ON quiz_game.ruleset_versions FOR EACH ROW EXECUTE FUNCTION quiz_game.prevent_deleted_instance_data();
CREATE TRIGGER prevent_deleted_competition BEFORE INSERT ON quiz_game.competitions FOR EACH ROW EXECUTE FUNCTION quiz_game.prevent_deleted_instance_data();
