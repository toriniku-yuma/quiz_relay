-- Worker専用。資格情報は別途設定し、migrationへ含めない。
CREATE ROLE quiz_game_results LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
--> statement-breakpoint
GRANT USAGE ON SCHEMA quiz_game TO quiz_game_results;
