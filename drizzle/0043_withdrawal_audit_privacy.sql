GRANT SELECT ON quiz_game.account_withdrawals TO quiz_privacy_internal;
CREATE POLICY privacy_internal ON quiz_game.account_withdrawals FOR SELECT TO quiz_privacy_internal USING (true);
GRANT UPDATE (reason, before, after) ON quiz_game.moderation_events TO quiz_privacy_internal;
GRANT UPDATE (reason, resolution) ON quiz_game.user_reports, quiz_game.sanction_appeals TO quiz_privacy_internal;
GRANT UPDATE (details) ON quiz_game.moderation_requests, quiz_game.organization_events TO quiz_privacy_internal;
GRANT UPDATE (reason) ON quiz_game.question_submission_events TO quiz_privacy_internal;
GRANT UPDATE (reason) ON quiz_game.moderation_sanctions, quiz_game.question_authors, quiz_game.question_reports TO quiz_privacy_internal;
GRANT UPDATE (author_name) ON quiz_game.question_submissions TO quiz_privacy_internal;
CREATE POLICY privacy_update ON quiz_game.question_submissions FOR UPDATE TO quiz_privacy_internal USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION quiz_game.private_audit(table_name text, row_data jsonb, actor text) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,quiz_game AS $$
DECLARE output jsonb:=row_data; involved boolean;
BEGIN
 involved:=row_data->>'actor_id'=actor OR row_data->>'operator_id'=actor OR row_data->>'reporter_id'=actor OR row_data->'details'->>'actorId'=actor OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(row_data->'details'->'targets')='array' THEN row_data->'details'->'targets' ELSE '[]'::jsonb END) t WHERE t.value->>'actorId'=actor);
 IF NOT coalesce(involved,false) THEN RETURN output; END IF;
 IF table_name IN ('moderation_requests','organization_events') THEN
  RETURN jsonb_set(output,'{details}',jsonb_build_object('action',row_data->'details'->'action','redacted',true));
 END IF;
 IF table_name IN ('moderation_events','user_reports','sanction_appeals','question_submission_events') THEN
  output:=jsonb_set(output,'{reason}','"退会に伴い削除"');
 END IF;
 IF table_name IN ('user_reports','sanction_appeals') AND row_data->>'resolution' IS NOT NULL THEN output:=jsonb_set(output,'{resolution}','"退会に伴い削除"'); END IF;
 IF table_name='moderation_events' THEN
  IF row_data->'before'->>'reason' IS NOT NULL THEN output:=jsonb_set(output,'{before,reason}','"退会に伴い削除"'); END IF;
  IF row_data->'after'->>'reason' IS NOT NULL THEN output:=jsonb_set(output,'{after,reason}','"退会に伴い削除"'); END IF;
 END IF;
 RETURN output;
END $$;
REVOKE ALL ON FUNCTION quiz_game.private_audit(text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quiz_game.private_audit(text,jsonb,text) TO quiz_privacy_internal;
--> statement-breakpoint
CREATE FUNCTION quiz_game.withdrawal_redaction_allowed(table_name text, old_row jsonb, new_row jsonb) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,quiz_game AS $$
DECLARE actor text:=current_setting('quiz.anonymizing_actor',true);
BEGIN
 IF current_user<>'quiz_privacy_internal' OR actor IS NULL THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM quiz_game.organization_accounts WHERE actor_id=actor AND withdrawn_at IS NOT NULL) THEN RETURN false; END IF;
 RETURN new_row=quiz_game.private_audit(table_name,old_row,actor);
END $$;
REVOKE ALL ON FUNCTION quiz_game.withdrawal_redaction_allowed(text,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quiz_game.withdrawal_redaction_allowed(text,jsonb,jsonb) TO quiz_privacy_internal,quiz_organization,quiz_game_catalog,quiz_game_results,quiz_game_config;
--> statement-breakpoint
CREATE FUNCTION quiz_game.erase_withdrawal_audit(operation_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,quiz_game AS $$
DECLARE actor text;
BEGIN
 SELECT w.actor_id INTO STRICT actor FROM quiz_game.account_withdrawals w JOIN quiz_game.organization_accounts a ON a.actor_id=w.actor_id WHERE w.id=operation_id AND a.withdrawn_at IS NOT NULL;
 PERFORM set_config('quiz.anonymizing_actor',actor,true);
 UPDATE quiz_game.moderation_events r SET reason=quiz_game.private_audit('moderation_events',to_jsonb(r),actor)->>'reason',before=quiz_game.private_audit('moderation_events',to_jsonb(r),actor)->'before',after=quiz_game.private_audit('moderation_events',to_jsonb(r),actor)->'after' WHERE actor_id=actor OR operator_id=actor;
 UPDATE quiz_game.user_reports r SET reason=quiz_game.private_audit('user_reports',to_jsonb(r),actor)->>'reason',resolution=quiz_game.private_audit('user_reports',to_jsonb(r),actor)->>'resolution' WHERE actor_id=actor OR reporter_id=actor OR operator_id=actor;
 UPDATE quiz_game.sanction_appeals r SET reason=quiz_game.private_audit('sanction_appeals',to_jsonb(r),actor)->>'reason',resolution=quiz_game.private_audit('sanction_appeals',to_jsonb(r),actor)->>'resolution' WHERE actor_id=actor OR operator_id=actor;
 UPDATE quiz_game.organization_events r SET details=quiz_game.private_audit('organization_events',to_jsonb(r),actor)->'details' WHERE to_jsonb(r) IS DISTINCT FROM quiz_game.private_audit('organization_events',to_jsonb(r),actor);
 UPDATE quiz_game.moderation_requests r SET details=quiz_game.private_audit('moderation_requests',to_jsonb(r),actor)->'details' WHERE to_jsonb(r) IS DISTINCT FROM quiz_game.private_audit('moderation_requests',to_jsonb(r),actor);
 UPDATE quiz_game.question_submission_events SET reason='退会に伴い削除' WHERE actor_id=actor;
 DELETE FROM quiz_game.question_notifications WHERE actor_id=actor;
 UPDATE quiz_game.moderation_sanctions SET reason='退会に伴い削除' WHERE actor_id=actor;
 UPDATE quiz_game.question_authors SET reason='退会に伴い削除' WHERE actor_id=actor;
 UPDATE quiz_game.question_reports SET reason='退会に伴い削除' WHERE actor_id=actor;
 UPDATE quiz_game.question_submissions SET author_name='退会ユーザー' WHERE author_id=actor;
END $$;
ALTER FUNCTION quiz_game.erase_withdrawal_audit(uuid) OWNER TO quiz_privacy_internal;
REVOKE ALL ON FUNCTION quiz_game.erase_withdrawal_audit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quiz_game.erase_withdrawal_audit(uuid) TO quiz_erasure;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION quiz_game.reject_version_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='UPDATE' AND quiz_game.withdrawal_redaction_allowed(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' AND quiz_game.instance_erasure_allowed(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' AND current_user='quiz_privacy_internal' AND TG_TABLE_NAME IN ('organization_events','question_submission_events') THEN
  IF coalesce((to_jsonb(OLD)->>'occurred_at')::timestamptz,(to_jsonb(OLD)->>'created_at')::timestamptz) <= now()-interval '365 days' THEN RETURN OLD; END IF;
 END IF;
 RAISE EXCEPTION 'IMMUTABLE_VERSION';
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION quiz_game.protect_moderation_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND quiz_game.withdrawal_redaction_allowed(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
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
 IF TG_OP='UPDATE' AND quiz_game.withdrawal_redaction_allowed(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
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
