REVOKE ALL ON quiz_game.organization_events FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON quiz_game.organization_events TO quiz_organization;
--> statement-breakpoint
CREATE TRIGGER immutable_organization_event BEFORE UPDATE OR DELETE ON quiz_game.organization_events FOR EACH ROW EXECUTE FUNCTION quiz_game.reject_version_change();
