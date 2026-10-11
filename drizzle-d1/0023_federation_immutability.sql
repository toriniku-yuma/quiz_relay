-- Custom SQL migration file, put your code below! --
CREATE TRIGGER federation_actor_identity_update BEFORE UPDATE ON quiz_federation_actors
WHEN NEW.actor_id IS NOT OLD.actor_id OR NEW.peer_origin IS NOT OLD.peer_origin OR NEW.source_actor_id IS NOT OLD.source_actor_id
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_IDENTITY'); END;
--> statement-breakpoint
CREATE TRIGGER federation_reservation_binding_update BEFORE UPDATE ON quiz_federation_reservations
WHEN NEW.id IS NOT OLD.id OR NEW.peer_origin IS NOT OLD.peer_origin OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.request_hash IS NOT OLD.request_hash OR NEW.source_instance_id IS NOT OLD.source_instance_id
  OR NEW.source_actor_id IS NOT OLD.source_actor_id OR NEW.actor_id IS NOT OLD.actor_id OR NEW.instance_id IS NOT OLD.instance_id OR NEW.mode IS NOT OLD.mode
  OR (OLD.match_id IS NOT NULL AND NEW.match_id IS NOT OLD.match_id)
  OR (OLD.room_id IS NOT NULL AND NEW.room_id IS NOT OLD.room_id)
  OR (OLD.state = 'closed' AND NEW.state <> 'closed')
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_PARTICIPATION_BINDING'); END;
--> statement-breakpoint
CREATE TRIGGER federation_result_delivery_original_update BEFORE UPDATE ON quiz_federation_result_deliveries
WHEN NEW.event_id IS NOT OLD.event_id OR NEW.result_id IS NOT OLD.result_id OR NEW.instance_id IS NOT OLD.instance_id OR NEW.peer_origin IS NOT OLD.peer_origin
  OR NEW.source_actor_id IS NOT OLD.source_actor_id OR NEW.payload IS NOT OLD.payload OR NEW.payload_hash IS NOT OLD.payload_hash
  OR (OLD.message IS NOT NULL AND NEW.message IS NOT OLD.message)
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_RESULT'); END;
--> statement-breakpoint
CREATE TRIGGER federation_result_delivery_original_delete BEFORE DELETE ON quiz_federation_result_deliveries
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_RESULT'); END;
--> statement-breakpoint
CREATE TRIGGER federation_result_inbox_original_update BEFORE UPDATE ON quiz_federation_result_inbox
WHEN NEW.peer_origin IS NOT OLD.peer_origin OR NEW.event_id IS NOT OLD.event_id OR NEW.actor_id IS NOT OLD.actor_id OR NEW.source_instance_id IS NOT OLD.source_instance_id
  OR NEW.payload IS NOT OLD.payload OR NEW.payload_hash IS NOT OLD.payload_hash OR NEW.message IS NOT OLD.message
  OR NEW.received_at IS NOT OLD.received_at OR NEW.finished_at IS NOT OLD.finished_at
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_RESULT'); END;
--> statement-breakpoint
CREATE TRIGGER federation_result_inbox_original_delete BEFORE DELETE ON quiz_federation_result_inbox
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_FEDERATION_RESULT'); END;
