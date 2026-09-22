REVOKE ALL ON quiz_game.catalog_operators FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON quiz_game.catalog_operators TO quiz_game_catalog;
--> statement-breakpoint
GRANT SELECT, INSERT ON quiz_game.question_availability, quiz_game.question_versions, quiz_game.question_sets, quiz_game.question_set_items, quiz_game.ruleset_versions, quiz_game.competitions, quiz_game.matchmaking_settings TO quiz_game_catalog;
--> statement-breakpoint
GRANT UPDATE (retired_at) ON quiz_game.question_availability TO quiz_game_catalog;
--> statement-breakpoint
GRANT UPDATE (competition_id, competition_version) ON quiz_game.matchmaking_settings TO quiz_game_catalog;
