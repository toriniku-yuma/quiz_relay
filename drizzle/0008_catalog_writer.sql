-- 管理CLI専用。資格情報と開催元の対応は別途登録する。
CREATE ROLE quiz_game_catalog LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
--> statement-breakpoint
GRANT USAGE ON SCHEMA quiz_game TO quiz_game_catalog;
