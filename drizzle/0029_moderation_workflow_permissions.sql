REVOKE ALL ON quiz_game.user_reports, quiz_game.sanction_appeals, quiz_game.moderation_requests, quiz_game.administrator_transfers FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON quiz_game.user_reports, quiz_game.sanction_appeals, quiz_game.moderation_requests, quiz_game.administrator_transfers TO quiz_organization;
--> statement-breakpoint
GRANT UPDATE (resolved_at, operator_id, resolution) ON quiz_game.user_reports TO quiz_organization;
--> statement-breakpoint
GRANT UPDATE (resolved_at, operator_id, resolution, decision, read_at) ON quiz_game.sanction_appeals TO quiz_organization;
--> statement-breakpoint
GRANT UPDATE (state, read_at) ON quiz_game.administrator_transfers TO quiz_organization;
--> statement-breakpoint
GRANT UPDATE (administrator) ON quiz_game.organization_accounts TO quiz_organization;
--> statement-breakpoint
CREATE FUNCTION quiz_game.protect_moderation_workflow() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed text[];
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable moderation history'; END IF;
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
CREATE TRIGGER protect_user_report BEFORE UPDATE OR DELETE ON quiz_game.user_reports FOR EACH ROW EXECUTE FUNCTION quiz_game.protect_moderation_workflow();
--> statement-breakpoint
CREATE TRIGGER protect_sanction_appeal BEFORE UPDATE OR DELETE ON quiz_game.sanction_appeals FOR EACH ROW EXECUTE FUNCTION quiz_game.protect_moderation_workflow();
--> statement-breakpoint
CREATE TRIGGER protect_admin_transfer BEFORE UPDATE OR DELETE ON quiz_game.administrator_transfers FOR EACH ROW EXECUTE FUNCTION quiz_game.protect_moderation_workflow();
--> statement-breakpoint
CREATE TRIGGER protect_moderation_request BEFORE UPDATE OR DELETE ON quiz_game.moderation_requests FOR EACH ROW EXECUTE FUNCTION quiz_game.protect_moderation_workflow();
