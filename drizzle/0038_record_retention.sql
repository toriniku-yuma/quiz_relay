GRANT SELECT, DELETE ON quiz_game.question_notifications, quiz_game.question_submission_events, quiz_game.organization_events, quiz_game.moderation_events, quiz_game.user_reports, quiz_game.sanction_appeals, quiz_game.administrator_transfers, quiz_game.moderation_requests TO quiz_privacy_internal;
GRANT USAGE ON SCHEMA quiz_probe TO quiz_privacy_internal;
GRANT SELECT, DELETE ON quiz_probe.runs TO quiz_privacy_internal;
CREATE POLICY privacy_internal ON quiz_game.question_notifications TO quiz_privacy_internal USING (true);
CREATE POLICY privacy_internal ON quiz_game.question_submission_events TO quiz_privacy_internal USING (true);
CREATE POLICY privacy_internal ON quiz_game.organization_events TO quiz_privacy_internal USING (true);
CREATE POLICY privacy_internal ON quiz_game.moderation_events TO quiz_privacy_internal USING (true);
CREATE POLICY privacy_internal ON quiz_game.user_reports TO quiz_privacy_internal USING (true);
CREATE POLICY privacy_internal ON quiz_game.sanction_appeals TO quiz_privacy_internal USING (true);
CREATE POLICY privacy_internal ON quiz_game.administrator_transfers TO quiz_privacy_internal USING (true);
CREATE POLICY privacy_internal ON quiz_game.moderation_requests TO quiz_privacy_internal USING (true);
CREATE POLICY privacy_internal ON quiz_probe.runs TO quiz_privacy_internal USING (true);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION quiz_game.reject_version_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND current_user='quiz_privacy_internal' AND TG_TABLE_NAME IN ('organization_events','question_submission_events') THEN
  IF coalesce((to_jsonb(OLD)->>'occurred_at')::timestamptz,(to_jsonb(OLD)->>'created_at')::timestamptz) <= now()-interval '365 days' THEN RETURN OLD; END IF;
 END IF;
 RAISE EXCEPTION 'IMMUTABLE_VERSION';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION quiz_game.protect_moderation_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
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
CREATE FUNCTION quiz_game.expire_records() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,quiz_game AS $$
BEGIN
 DELETE FROM quiz_game.question_notifications WHERE created_at<=now()-interval '90 days';
 DELETE FROM quiz_game.question_submission_events WHERE created_at<=now()-interval '365 days';
 DELETE FROM quiz_game.organization_events WHERE occurred_at<=now()-interval '365 days';
 DELETE FROM quiz_game.moderation_events WHERE created_at<=now()-interval '365 days';
 DELETE FROM quiz_game.user_reports WHERE created_at<=now()-interval '365 days';
 DELETE FROM quiz_game.sanction_appeals WHERE created_at<=now()-interval '365 days';
 DELETE FROM quiz_game.administrator_transfers WHERE created_at<=now()-interval '365 days';
 DELETE FROM quiz_game.moderation_requests WHERE created_at<=now()-interval '365 days';
 DELETE FROM quiz_probe.runs WHERE created_at<=now()-interval '30 days';
END $$;
ALTER FUNCTION quiz_game.expire_records() OWNER TO quiz_privacy_internal;
REVOKE ALL ON FUNCTION quiz_game.expire_records() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quiz_game.expire_records() TO quiz_erasure;
