-- Custom SQL migration file, put your code below! --
-- The seven catalogs approved for server-side publication. RLS requires the authenticated organization scope.
GRANT SELECT, INSERT ON quiz_game.question_versions, quiz_game.question_sets, quiz_game.question_set_items, quiz_game.ruleset_versions, quiz_game.competitions, quiz_game.question_availability, quiz_game.matchmaking_settings TO quiz_organization;
--> statement-breakpoint
GRANT UPDATE (retired_at) ON quiz_game.question_availability TO quiz_organization;
--> statement-breakpoint
GRANT UPDATE (competition_id, competition_version) ON quiz_game.matchmaking_settings TO quiz_organization;
