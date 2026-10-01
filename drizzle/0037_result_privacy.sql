CREATE ROLE quiz_privacy_internal NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
--> statement-breakpoint
GRANT USAGE ON SCHEMA quiz_game TO quiz_privacy_internal;
GRANT SELECT ON quiz_game.organization_accounts, quiz_game.instances, quiz_game.question_submissions, quiz_game.question_versions, quiz_game.match_results, quiz_game.result_outbox, quiz_game.result_players TO quiz_privacy_internal;
GRANT UPDATE (payload, payload_hash) ON quiz_game.match_results, quiz_game.result_outbox TO quiz_privacy_internal;
GRANT UPDATE (name) ON quiz_game.result_players TO quiz_privacy_internal;
CREATE POLICY privacy_internal ON quiz_game.organization_accounts FOR SELECT TO quiz_privacy_internal USING (true);
CREATE POLICY privacy_internal ON quiz_game.instances FOR SELECT TO quiz_privacy_internal USING (true);
CREATE POLICY privacy_internal ON quiz_game.question_submissions FOR SELECT TO quiz_privacy_internal USING (true);
CREATE POLICY privacy_internal ON quiz_game.question_versions FOR SELECT TO quiz_privacy_internal USING (true);
CREATE POLICY privacy_internal ON quiz_game.match_results TO quiz_privacy_internal USING (true) WITH CHECK (true);
CREATE POLICY privacy_internal ON quiz_game.result_outbox TO quiz_privacy_internal USING (true) WITH CHECK (true);
CREATE POLICY privacy_internal ON quiz_game.result_players TO quiz_privacy_internal USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION quiz_game.retired_question(owner_id text, question_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, quiz_game AS $$
 SELECT EXISTS (
  SELECT 1 FROM quiz_game.question_submissions s
  JOIN quiz_game.instances i ON i.id=s.instance_id
  JOIN quiz_game.organization_accounts a ON a.actor_id=s.author_id
  WHERE i.owner=owner_id AND a.withdrawn_at IS NOT NULL AND s.provenance IS NULL
  AND (s.id::text=question_id OR s.series_id::text=question_id OR s.published_id::text=question_id
   OR EXISTS (SELECT 1 FROM quiz_game.question_versions v WHERE v.owner=owner_id AND v.question_id=question_id AND v.payload->>'seriesId'=s.series_id::text))
 )
$$;
ALTER FUNCTION quiz_game.retired_question(text,text) OWNER TO quiz_privacy_internal;
REVOKE ALL ON FUNCTION quiz_game.retired_question(text,text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION quiz_game.private_result(source jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, quiz_game AS $$
DECLARE output jsonb := source; replacements jsonb;
BEGIN
 SELECT jsonb_agg(CASE WHEN EXISTS (
  SELECT 1 FROM quiz_game.organization_accounts a JOIN quiz_game.instances i ON i.organization_id=a.organization_id
  WHERE a.actor_id=p.value->>'id' AND a.withdrawn_at IS NOT NULL AND i.owner=source->>'owner'
 ) THEN jsonb_set(p.value,'{name}','"退会ユーザー"') ELSE p.value END ORDER BY p.ordinality)
 INTO replacements FROM jsonb_array_elements(source->'players') WITH ORDINALITY p;
 IF replacements IS NOT NULL THEN output := jsonb_set(output,'{players}',replacements); END IF;
 IF source ? 'completedQuestions' THEN
  IF (source->'result'->>'finishedAt')::numeric <= extract(epoch FROM now() - interval '365 days')*1000 THEN
   output := output - 'completedQuestions';
  ELSE
   SELECT coalesce(jsonb_agg(CASE WHEN quiz_game.retired_question(source->>'owner', coalesce(q.value->>'seriesId',q.value->>'id')) AND q.value ? 'authorName'
    THEN jsonb_set(q.value,'{authorName}','"退会ユーザー"') ELSE q.value END ORDER BY q.ordinality),'[]'::jsonb)
   INTO replacements FROM jsonb_array_elements(source->'completedQuestions') WITH ORDINALITY q;
   output := jsonb_set(output,'{completedQuestions}',replacements);
  END IF;
 END IF;
 IF source->'definition'->'selection' ? 'authorNames' THEN
  SELECT coalesce(jsonb_object_agg(n.key, CASE WHEN quiz_game.retired_question(source->>'owner',n.key) THEN '"退会ユーザー"'::jsonb ELSE n.value END),'{}'::jsonb)
  INTO replacements FROM jsonb_each(source->'definition'->'selection'->'authorNames') n;
  output := jsonb_set(output,'{definition,selection,authorNames}',replacements);
 END IF;
 RETURN output;
END $$;
ALTER FUNCTION quiz_game.private_result(jsonb) OWNER TO quiz_privacy_internal;
REVOKE ALL ON FUNCTION quiz_game.private_result(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quiz_game.private_result(jsonb) TO quiz_game_results, quiz_game_reader, quiz_erasure;
--> statement-breakpoint
CREATE FUNCTION quiz_game.protect_result_privacy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND current_user='quiz_privacy_internal' THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'result is immutable';
END $$;
DROP TRIGGER immutable_result ON quiz_game.match_results;
DROP TRIGGER immutable_result_outbox ON quiz_game.result_outbox;
DROP TRIGGER immutable_result_player ON quiz_game.result_players;
CREATE TRIGGER immutable_result BEFORE UPDATE OR DELETE ON quiz_game.match_results FOR EACH ROW EXECUTE FUNCTION quiz_game.protect_result_privacy();
CREATE TRIGGER immutable_result_outbox BEFORE UPDATE OR DELETE ON quiz_game.result_outbox FOR EACH ROW EXECUTE FUNCTION quiz_game.protect_result_privacy();
CREATE TRIGGER immutable_result_player BEFORE UPDATE OR DELETE ON quiz_game.result_players FOR EACH ROW EXECUTE FUNCTION quiz_game.protect_result_privacy();
--> statement-breakpoint
CREATE FUNCTION quiz_game.erase_result_names(target uuid, replacement jsonb, replacement_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, quiz_game AS $$
DECLARE original jsonb;
BEGIN
 SELECT payload INTO STRICT original FROM quiz_game.match_results WHERE result_id=target FOR UPDATE;
 IF replacement IS DISTINCT FROM quiz_game.private_result(original) OR replacement_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid privacy projection'; END IF;
 IF EXISTS (SELECT 1 FROM quiz_game.result_outbox WHERE result_id=target AND quiz_game.private_result(payload) IS DISTINCT FROM replacement) THEN RAISE EXCEPTION 'outbox conflict'; END IF;
 UPDATE quiz_game.match_results SET payload=replacement,payload_hash=replacement_hash WHERE result_id=target;
 UPDATE quiz_game.result_outbox SET payload=replacement,payload_hash=replacement_hash WHERE result_id=target;
 UPDATE quiz_game.result_players p SET name=j.value->>'name' FROM jsonb_array_elements(replacement->'players') j WHERE p.result_id=target AND p.actor_id=j.value->>'id';
END $$;
ALTER FUNCTION quiz_game.erase_result_names(uuid,jsonb,text) OWNER TO quiz_privacy_internal;
REVOKE ALL ON FUNCTION quiz_game.erase_result_names(uuid,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quiz_game.erase_result_names(uuid,jsonb,text) TO quiz_erasure;
GRANT SELECT ON quiz_game.match_results TO quiz_erasure;
CREATE POLICY erasure_service ON quiz_game.match_results FOR SELECT TO quiz_erasure USING (true);
