DROP TRIGGER d1_question_version_update;
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
