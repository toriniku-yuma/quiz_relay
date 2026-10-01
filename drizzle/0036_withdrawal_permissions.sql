REVOKE ALL ON quiz_game.account_withdrawals FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON quiz_game.account_withdrawals TO quiz_organization;
--> statement-breakpoint
GRANT UPDATE (withdrawn_at) ON quiz_game.organization_accounts TO quiz_organization;
--> statement-breakpoint
CREATE FUNCTION quiz_game.protect_withdrawn_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.withdrawn_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'withdrawn account cannot be restored';
 END IF;
 IF NEW.withdrawn_at IS NOT NULL AND (NEW.display_name IS NOT NULL OR NEW.administrator) THEN
  RAISE EXCEPTION 'withdrawn account must be anonymous without administrator privileges';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER protect_withdrawn_account BEFORE UPDATE ON quiz_game.organization_accounts FOR EACH ROW EXECUTE FUNCTION quiz_game.protect_withdrawn_account();
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='quiz_erasure') THEN CREATE ROLE quiz_erasure NOLOGIN; END IF; END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA quiz_game TO quiz_erasure;
GRANT SELECT ON quiz_game.account_withdrawals TO quiz_erasure;
GRANT SELECT (actor_id, subject, withdrawn_at) ON quiz_game.organization_accounts TO quiz_erasure;
GRANT UPDATE (auth_deleted_at, retry_at, attempts) ON quiz_game.account_withdrawals TO quiz_erasure;
--> statement-breakpoint
CREATE POLICY erasure_service ON quiz_game.account_withdrawals TO quiz_erasure USING (true) WITH CHECK (true);
CREATE POLICY erasure_service ON quiz_game.organization_accounts FOR SELECT TO quiz_erasure USING (withdrawn_at IS NOT NULL);
