GRANT SELECT ON quiz_game.question_submissions, quiz_game.question_versions TO quiz_erasure;
GRANT UPDATE (erased_at) ON quiz_game.account_withdrawals TO quiz_erasure;
CREATE POLICY erasure_service ON quiz_game.question_submissions FOR SELECT TO quiz_erasure USING (true);
CREATE POLICY erasure_service ON quiz_game.question_versions FOR SELECT TO quiz_erasure USING (true);
GRANT UPDATE (selection) ON quiz_game.question_sets TO quiz_privacy_internal;
--> statement-breakpoint
CREATE FUNCTION quiz_game.private_selection(owner_id text, selection_data jsonb) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,quiz_game AS $$
 SELECT quiz_game.private_result(jsonb_build_object('owner',owner_id,'definition',jsonb_build_object('selection',selection_data)))->'definition'->'selection'
$$;
ALTER FUNCTION quiz_game.private_selection(text,jsonb) OWNER TO quiz_privacy_internal;
REVOKE ALL ON FUNCTION quiz_game.private_selection(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quiz_game.private_selection(text,jsonb) TO quiz_game_reader,quiz_organization,quiz_erasure;
--> statement-breakpoint
CREATE FUNCTION quiz_game.protect_catalog_privacy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND quiz_game.instance_erasure_allowed(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
 IF TG_OP='UPDATE' AND current_user='quiz_privacy_internal' AND (to_jsonb(NEW)-'selection')=(to_jsonb(OLD)-'selection') AND NEW.selection IS NOT DISTINCT FROM quiz_game.private_selection(OLD.owner,OLD.selection) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'IMMUTABLE_VERSION';
END $$;
DROP TRIGGER immutable_set ON quiz_game.question_sets;
CREATE TRIGGER immutable_set BEFORE UPDATE OR DELETE ON quiz_game.question_sets FOR EACH ROW EXECUTE FUNCTION quiz_game.protect_catalog_privacy();
--> statement-breakpoint
CREATE FUNCTION quiz_game.erase_author_catalogs() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,quiz_game AS $$
 UPDATE quiz_game.question_sets SET selection=quiz_game.private_selection(owner,selection) WHERE selection IS DISTINCT FROM quiz_game.private_selection(owner,selection)
$$;
ALTER FUNCTION quiz_game.erase_author_catalogs() OWNER TO quiz_privacy_internal;
REVOKE ALL ON FUNCTION quiz_game.erase_author_catalogs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quiz_game.erase_author_catalogs() TO quiz_erasure;
