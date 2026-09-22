REVOKE ALL ON quiz_game.match_results, quiz_game.result_players, quiz_game.result_outbox FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON quiz_game.match_results, quiz_game.result_players, quiz_game.result_outbox TO quiz_game_results;
--> statement-breakpoint
GRANT SELECT ON quiz_game.match_results, quiz_game.result_players TO quiz_game_reader;
--> statement-breakpoint
CREATE TRIGGER immutable_result BEFORE UPDATE OR DELETE ON quiz_game.match_results FOR EACH ROW EXECUTE FUNCTION quiz_game.reject_version_change();
--> statement-breakpoint
CREATE TRIGGER immutable_result_player BEFORE UPDATE OR DELETE ON quiz_game.result_players FOR EACH ROW EXECUTE FUNCTION quiz_game.reject_version_change();
--> statement-breakpoint
CREATE TRIGGER immutable_result_outbox BEFORE UPDATE OR DELETE ON quiz_game.result_outbox FOR EACH ROW EXECUTE FUNCTION quiz_game.reject_version_change();
