REVOKE ALL ON quiz_game.instance_rooms, quiz_game.instance_deletions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON quiz_game.instance_rooms, quiz_game.instance_deletions TO quiz_organization;
GRANT SELECT ON quiz_game.instance_rooms, quiz_game.instance_deletions, quiz_game.instances TO quiz_erasure;
CREATE POLICY erasure_service ON quiz_game.instance_rooms FOR SELECT TO quiz_erasure USING (true);
CREATE POLICY erasure_service ON quiz_game.instance_deletions FOR SELECT TO quiz_erasure USING (true);
CREATE POLICY erasure_service ON quiz_game.instances FOR SELECT TO quiz_erasure USING (true);
--> statement-breakpoint
GRANT UPDATE (room_inventory_complete) ON quiz_game.instances TO quiz_privacy_internal;
CREATE POLICY privacy_inventory ON quiz_game.instances FOR UPDATE TO quiz_privacy_internal USING (true) WITH CHECK (true);
CREATE FUNCTION quiz_game.confirm_room_inventory(target uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,quiz_game AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('questions:'||target::text,0));
 IF NOT EXISTS(SELECT 1 FROM quiz_game.instances WHERE id=target AND state<>'published') THEN RAISE EXCEPTION 'inventory requires pause'; END IF;
 UPDATE quiz_game.instances SET room_inventory_complete=true WHERE id=target;
END $$;
ALTER FUNCTION quiz_game.confirm_room_inventory(uuid) OWNER TO quiz_privacy_internal;
REVOKE ALL ON FUNCTION quiz_game.confirm_room_inventory(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quiz_game.confirm_room_inventory(uuid) TO quiz_erasure;
