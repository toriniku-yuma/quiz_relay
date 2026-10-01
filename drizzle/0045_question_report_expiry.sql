-- Existing report/case dates start at migration time. Resolved legacy cases use that same date.
UPDATE quiz_game.question_review_cases SET resolved_at=created_at WHERE resolved;
--> statement-breakpoint
GRANT SELECT, DELETE ON quiz_game.question_reports, quiz_game.question_review_cases TO quiz_privacy_internal;
GRANT UPDATE (count) ON quiz_game.question_review_cases TO quiz_privacy_internal;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION quiz_game.expire_records() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,quiz_game AS $$
DECLARE scope uuid;
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
 FOR scope IN SELECT id FROM quiz_game.instances ORDER BY id LOOP
  -- Serialize report insertion/resolution and aggregation with normal question mutations.
  PERFORM pg_advisory_xact_lock(hashtextextended('questions:'||scope::text,0));
  DELETE FROM quiz_game.question_reports WHERE instance_id=scope AND created_at<=now()-interval '365 days';
  UPDATE quiz_game.question_review_cases c SET count=(SELECT count(*) FROM quiz_game.question_reports r WHERE r.instance_id=c.instance_id AND r.question_id=c.question_id AND r.kind=c.kind AND r.round=c.round)
   WHERE c.instance_id=scope;
  DELETE FROM quiz_game.question_review_cases c WHERE c.instance_id=scope AND c.count=0
   AND coalesce(c.resolved_at,c.created_at)<=now()-interval '365 days';
 END LOOP;
END $$;
