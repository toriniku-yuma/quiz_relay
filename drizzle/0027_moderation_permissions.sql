-- Custom SQL migration file, put your code below! --
REVOKE ALL ON quiz_game.moderation_sanctions, quiz_game.moderation_events FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON quiz_game.moderation_sanctions TO quiz_organization;
--> statement-breakpoint
GRANT SELECT, INSERT ON quiz_game.moderation_events TO quiz_organization;
--> statement-breakpoint
GRANT UPDATE (read_at) ON quiz_game.moderation_events TO quiz_organization;
--> statement-breakpoint
CREATE FUNCTION quiz_game.protect_moderation_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'immutable moderation event'; END IF;
  IF (to_jsonb(NEW) - 'read_at') IS DISTINCT FROM (to_jsonb(OLD) - 'read_at') THEN RAISE EXCEPTION 'immutable moderation event'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER immutable_moderation_event BEFORE UPDATE OR DELETE ON quiz_game.moderation_events FOR EACH ROW EXECUTE FUNCTION quiz_game.protect_moderation_event();
