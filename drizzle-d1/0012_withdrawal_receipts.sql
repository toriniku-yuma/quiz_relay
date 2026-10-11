CREATE TRIGGER withdrawal_receipt_identity BEFORE UPDATE ON quiz_game_account_withdrawals
WHEN NEW.id IS NOT OLD.id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.actor_id IS NOT OLD.actor_id OR NEW.requested_at IS NOT OLD.requested_at
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_WITHDRAWAL_RECEIPT'); END;
--> statement-breakpoint
CREATE TRIGGER withdrawal_receipt_completion BEFORE UPDATE ON quiz_game_account_withdrawals
WHEN ((OLD.auth_deleted_at IS NOT NULL AND NEW.auth_deleted_at IS NOT OLD.auth_deleted_at) OR (OLD.erased_at IS NOT NULL AND NEW.erased_at IS NOT OLD.erased_at))
AND NOT (NEW.auth_deleted_at IS NULL AND NEW.erased_at IS NULL AND NEW.audit_erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM quiz_game_instances WHERE organization_id=OLD.organization_id AND (state='published' OR room_inventory_complete=1)))
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_WITHDRAWAL_COMPLETION'); END;
--> statement-breakpoint
CREATE TRIGGER withdrawal_receipt_delete BEFORE DELETE ON quiz_game_account_withdrawals BEGIN SELECT RAISE(ABORT,'IMMUTABLE_WITHDRAWAL_RECEIPT'); END;
