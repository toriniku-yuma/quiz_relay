-- Result originals remain immutable. Controlled privacy erasure must be ported
-- and verified before production cutover; the current runtime still uses PostgreSQL.
CREATE TRIGGER d1_result_conflict BEFORE INSERT ON quiz_game_match_results
WHEN EXISTS (
  SELECT 1 FROM quiz_game_match_results AS stored
  WHERE (stored.result_id = NEW.result_id OR (stored.owner = NEW.owner AND stored.match_id = NEW.match_id))
    AND (stored.result_id <> NEW.result_id OR stored.owner <> NEW.owner OR stored.match_id <> NEW.match_id OR stored.payload_hash <> NEW.payload_hash)
)
BEGIN SELECT RAISE(ABORT, 'RESULT_CONFLICT'); END;
--> statement-breakpoint
CREATE TRIGGER d1_result_identity BEFORE INSERT ON quiz_game_match_results
WHEN json_extract(NEW.payload, '$.owner') IS NOT NEW.owner
  OR json_extract(NEW.payload, '$.matchId') IS NOT NEW.match_id
  OR json_extract(NEW.payload, '$.result.id') IS NOT NEW.result_id
BEGIN SELECT RAISE(ABORT, 'INVALID_RESULT_IDENTITY'); END;
--> statement-breakpoint
CREATE TRIGGER d1_result_player_membership BEFORE INSERT ON quiz_game_result_players
WHEN NOT EXISTS (
  SELECT 1 FROM quiz_game_match_results AS result, json_each(result.payload, '$.players') AS player
  WHERE result.result_id = NEW.result_id
    AND json_extract(player.value, '$.id') = NEW.actor_id
    AND json_extract(player.value, '$.name') = NEW.name
    AND json_extract(player.value, '$.ratingDelta') = NEW.rating_delta
)
BEGIN SELECT RAISE(ABORT, 'INVALID_RESULT_PLAYER'); END;
--> statement-breakpoint
CREATE TRIGGER d1_outbox_identity BEFORE INSERT ON quiz_game_result_outbox
WHEN NOT EXISTS (
  SELECT 1 FROM quiz_game_match_results AS result
  WHERE result.result_id = NEW.result_id AND result.payload_hash = NEW.payload_hash AND result.payload = NEW.payload
)
BEGIN SELECT RAISE(ABORT, 'INVALID_RESULT_OUTBOX'); END;
--> statement-breakpoint
CREATE TRIGGER d1_result_update BEFORE UPDATE ON quiz_game_match_results
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_RESULT'); END;
--> statement-breakpoint
CREATE TRIGGER d1_result_delete BEFORE DELETE ON quiz_game_match_results
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_RESULT'); END;
--> statement-breakpoint
CREATE TRIGGER d1_result_player_update BEFORE UPDATE ON quiz_game_result_players
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_RESULT_PLAYER'); END;
--> statement-breakpoint
CREATE TRIGGER d1_result_player_delete BEFORE DELETE ON quiz_game_result_players
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_RESULT_PLAYER'); END;
--> statement-breakpoint
CREATE TRIGGER d1_outbox_update BEFORE UPDATE ON quiz_game_result_outbox
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_OUTBOX'); END;
--> statement-breakpoint
CREATE TRIGGER d1_outbox_delete BEFORE DELETE ON quiz_game_result_outbox
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_OUTBOX'); END;
