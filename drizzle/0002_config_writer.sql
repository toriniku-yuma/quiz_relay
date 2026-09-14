-- CLI-only role. Its password is provisioned separately, never in migrations.
CREATE ROLE quiz_game_config LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
--> statement-breakpoint
GRANT USAGE ON SCHEMA quiz_game TO quiz_game_config;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA quiz_game TO quiz_game_config;
--> statement-breakpoint
GRANT INSERT ON quiz_game.ruleset_versions, quiz_game.competitions, quiz_game.matchmaking_settings TO quiz_game_config;
--> statement-breakpoint
GRANT UPDATE ON quiz_game.matchmaking_settings TO quiz_game_config;
