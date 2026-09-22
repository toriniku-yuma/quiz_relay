CREATE ROLE quiz_organization LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
--> statement-breakpoint
GRANT USAGE ON SCHEMA quiz_game TO quiz_organization;
