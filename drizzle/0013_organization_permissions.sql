REVOKE ALL ON quiz_game.organizations, quiz_game.organization_accounts, quiz_game.instances, quiz_game.instance_grants FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON quiz_game.organizations, quiz_game.organization_accounts, quiz_game.instances, quiz_game.instance_grants TO quiz_organization;
--> statement-breakpoint
GRANT UPDATE (name) ON quiz_game.organizations TO quiz_organization;
GRANT UPDATE (name, state) ON quiz_game.instances TO quiz_organization;
GRANT DELETE ON quiz_game.instance_grants TO quiz_organization;
--> statement-breakpoint
CREATE FUNCTION quiz_game.protect_organization_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'organizations' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.identity_namespace IS DISTINCT FROM OLD.identity_namespace THEN RAISE EXCEPTION 'organization identity is immutable'; END IF;
  ELSIF TG_TABLE_NAME = 'instances' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner IS DISTINCT FROM OLD.owner OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN RAISE EXCEPTION 'instance identity is immutable'; END IF;
  ELSIF TG_TABLE_NAME = 'organization_accounts' THEN
    IF NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.subject IS DISTINCT FROM OLD.subject OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN RAISE EXCEPTION 'account identity is immutable'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER immutable_organization_identity BEFORE UPDATE ON quiz_game.organizations FOR EACH ROW EXECUTE FUNCTION quiz_game.protect_organization_identity();
CREATE TRIGGER immutable_instance_identity BEFORE UPDATE ON quiz_game.instances FOR EACH ROW EXECUTE FUNCTION quiz_game.protect_organization_identity();
CREATE TRIGGER immutable_account_identity BEFORE UPDATE ON quiz_game.organization_accounts FOR EACH ROW EXECUTE FUNCTION quiz_game.protect_organization_identity();

--> statement-breakpoint
REVOKE ALL ON FUNCTION quiz_game.protect_organization_identity() FROM PUBLIC, anon, authenticated;
