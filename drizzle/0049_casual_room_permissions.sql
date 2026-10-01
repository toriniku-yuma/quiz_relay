-- Custom SQL migration file, put your code below! --
GRANT SELECT,INSERT,UPDATE,DELETE ON quiz_game.guest_sessions,quiz_game.personal_question_sets,quiz_game.room_directory TO quiz_organization;
GRANT UPDATE (casual_config) ON quiz_game.instances TO quiz_organization;
REVOKE ALL ON quiz_game.guest_sessions,quiz_game.personal_question_sets,quiz_game.room_directory FROM PUBLIC,anon,authenticated;
GRANT SELECT,DELETE ON quiz_game.guest_sessions TO quiz_erasure;
CREATE POLICY erasure_guest_read ON quiz_game.guest_sessions FOR SELECT TO quiz_erasure USING (true);
CREATE POLICY erasure_guest_expire ON quiz_game.guest_sessions FOR DELETE TO quiz_erasure USING (expires_at <= now());
GRANT SELECT,DELETE ON quiz_game.personal_question_sets TO quiz_privacy_internal;
CREATE POLICY privacy_personal_sets ON quiz_game.personal_question_sets TO quiz_privacy_internal USING (true) WITH CHECK (true);
GRANT SELECT,DELETE ON quiz_game.room_directory TO quiz_privacy_internal;
CREATE POLICY privacy_directory ON quiz_game.room_directory TO quiz_privacy_internal USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION quiz_game.erase_room_directory() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,quiz_game AS $$
BEGIN
 DELETE FROM quiz_game.room_directory WHERE instance_id=OLD.id;
 RETURN OLD;
END $$;
ALTER FUNCTION quiz_game.erase_room_directory() OWNER TO quiz_privacy_internal;
REVOKE ALL ON FUNCTION quiz_game.erase_room_directory() FROM PUBLIC;
CREATE TRIGGER erase_room_directory BEFORE DELETE ON quiz_game.instances FOR EACH ROW EXECUTE FUNCTION quiz_game.erase_room_directory();
--> statement-breakpoint
CREATE FUNCTION quiz_game.erase_personal_sets() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,quiz_game AS $$
 DELETE FROM quiz_game.personal_question_sets p USING quiz_game.account_withdrawals w WHERE p.organization_id=w.organization_id AND p.author_id=w.actor_id;
$$;
ALTER FUNCTION quiz_game.erase_personal_sets() OWNER TO quiz_privacy_internal;
REVOKE ALL ON FUNCTION quiz_game.erase_personal_sets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quiz_game.erase_personal_sets() TO quiz_erasure;
--> statement-breakpoint
ALTER FUNCTION quiz_game.private_result(jsonb) RENAME TO private_result_registered;
REVOKE ALL ON FUNCTION quiz_game.private_result_registered(jsonb) FROM quiz_game_reader,quiz_game_results,quiz_erasure;
CREATE FUNCTION quiz_game.private_result(source jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,quiz_game AS $$
DECLARE output jsonb := quiz_game.private_result_registered(source); replacements jsonb;
BEGIN
 IF (source->'result'->>'finishedAt')::numeric <= extract(epoch FROM now()-interval '30 days')*1000 THEN
  IF coalesce((source->'definition'->>'original')::boolean,false) THEN output:=output-'completedQuestions'; END IF;
  SELECT jsonb_agg(CASE WHEN coalesce((p.value->>'guest')::boolean,false) THEN jsonb_set(p.value,'{name}','"ゲスト"') ELSE p.value END ORDER BY p.ordinality)
  INTO replacements FROM jsonb_array_elements(output->'players') WITH ORDINALITY p;
  IF replacements IS NOT NULL THEN output:=jsonb_set(output,'{players}',replacements); END IF;
 END IF;
 RETURN output;
END $$;
ALTER FUNCTION quiz_game.private_result(jsonb) OWNER TO quiz_privacy_internal;
REVOKE ALL ON FUNCTION quiz_game.private_result(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quiz_game.private_result(jsonb) TO quiz_game_results,quiz_game_reader,quiz_erasure;
