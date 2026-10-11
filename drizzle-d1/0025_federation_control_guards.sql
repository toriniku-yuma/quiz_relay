CREATE TRIGGER federation_control_delivery_original BEFORE UPDATE ON quiz_federation_control_deliveries
WHEN NEW.event_id IS NOT OLD.event_id OR NEW.peer_origin IS NOT OLD.peer_origin OR NEW.payload IS NOT OLD.payload OR NEW.payload_hash IS NOT OLD.payload_hash OR (OLD.message IS NOT NULL AND NEW.message IS NOT OLD.message)
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_CONTROL'); END;
--> statement-breakpoint
CREATE TRIGGER federation_control_delivery_keep BEFORE DELETE ON quiz_federation_control_deliveries
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_CONTROL'); END;
--> statement-breakpoint
CREATE TRIGGER federation_control_inbox_original BEFORE UPDATE ON quiz_federation_control_inbox
WHEN NEW.event_id IS NOT OLD.event_id OR NEW.peer_origin IS NOT OLD.peer_origin OR NEW.payload IS NOT OLD.payload OR NEW.payload_hash IS NOT OLD.payload_hash OR NEW.message IS NOT OLD.message OR NEW.received_at IS NOT OLD.received_at
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_CONTROL'); END;
--> statement-breakpoint
CREATE TRIGGER federation_control_inbox_keep BEFORE DELETE ON quiz_federation_control_inbox
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_CONTROL'); END;
--> statement-breakpoint
CREATE TRIGGER federation_retired_identity_original BEFORE UPDATE ON quiz_federation_retired_identities
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_RETIREMENT'); END;
--> statement-breakpoint
CREATE TRIGGER federation_retired_identity_keep BEFORE DELETE ON quiz_federation_retired_identities
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_RETIREMENT'); END;
--> statement-breakpoint
CREATE TRIGGER federation_deleted_instance_original BEFORE UPDATE ON quiz_federation_deleted_instances
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_RETIREMENT'); END;
--> statement-breakpoint
CREATE TRIGGER federation_deleted_instance_keep BEFORE DELETE ON quiz_federation_deleted_instances
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_RETIREMENT'); END;
