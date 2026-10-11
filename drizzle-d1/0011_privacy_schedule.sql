CREATE TRIGGER result_privacy_schedule AFTER INSERT ON quiz_game_match_results
WHEN json_type(NEW.payload,'$.completedQuestions')='array' OR EXISTS(SELECT 1 FROM json_each(NEW.payload,'$.players') WHERE json_extract(value,'$.guest')=1)
BEGIN
 INSERT INTO quiz_game_result_privacy_jobs(result_id,due_at) VALUES(NEW.result_id,
 strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(NEW.payload,'$.result.finishedAt')/1000.0,'unixepoch',
 CASE WHEN json_extract(NEW.payload,'$.definition.original')=1 OR EXISTS(SELECT 1 FROM json_each(NEW.payload,'$.players') WHERE json_extract(value,'$.guest')=1) THEN '+30 days' ELSE '+365 days' END));
END;
--> statement-breakpoint
INSERT INTO quiz_game_result_privacy_jobs(result_id,due_at) SELECT result_id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM quiz_game_match_results WHERE 1 ON CONFLICT DO NOTHING;
