-- Drizzle-generated tables and policies; role LOGIN options require PostgreSQL DDL.
CREATE ROLE quiz_game_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
--> statement-breakpoint
CREATE ROLE quiz_probe LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
--> statement-breakpoint
CREATE SCHEMA "quiz_game";
--> statement-breakpoint
CREATE SCHEMA "quiz_probe";
--> statement-breakpoint
CREATE TABLE "quiz_game"."competitions" (
	"owner" text NOT NULL,
	"competition_id" text NOT NULL,
	"version" integer NOT NULL,
	"players_per_match" integer NOT NULL,
	"ruleset_id" text NOT NULL,
	"ruleset_version" integer NOT NULL,
	"set_id" text NOT NULL,
	"set_version" integer NOT NULL,
	CONSTRAINT "competitions_pkey" PRIMARY KEY("owner","competition_id","version"),
	CONSTRAINT "competitions_competition_id_check" CHECK (competition_id ~ '^[a-zA-Z0-9_-]{1,64}$'::text),
	CONSTRAINT "competitions_players_per_match_check" CHECK ((players_per_match >= 2) AND (players_per_match <= 4)),
	CONSTRAINT "competitions_version_check" CHECK (version > 0)
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."competitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."matchmaking_settings" (
	"owner" text NOT NULL,
	"profile" text NOT NULL,
	"competition_id" text NOT NULL,
	"competition_version" integer NOT NULL,
	CONSTRAINT "matchmaking_settings_pkey" PRIMARY KEY("owner","profile"),
	CONSTRAINT "matchmaking_settings_profile_check" CHECK (profile ~ '^[a-zA-Z0-9_-]{1,64}$'::text)
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."matchmaking_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_probe"."runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quiz_probe"."runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."question_availability" (
	"owner" text NOT NULL,
	"question_id" text NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "question_availability_pkey" PRIMARY KEY("owner","question_id"),
	CONSTRAINT "question_availability_owner_check" CHECK ((length(owner) >= 1) AND (length(owner) <= 256)),
	CONSTRAINT "question_availability_question_id_check" CHECK (question_id ~ '^[a-zA-Z0-9_-]{1,64}$'::text)
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."question_availability" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."question_set_items" (
	"owner" text NOT NULL,
	"set_id" text NOT NULL,
	"set_version" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"question_id" text NOT NULL,
	"question_version" integer NOT NULL,
	CONSTRAINT "question_set_items_pkey" PRIMARY KEY("owner","set_id","set_version","ordinal"),
	CONSTRAINT "question_set_items_owner_set_id_set_version_question_id_key" UNIQUE("owner","set_id","set_version","question_id"),
	CONSTRAINT "question_set_items_ordinal_check" CHECK ((ordinal >= 1) AND (ordinal <= 100))
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."question_set_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."question_sets" (
	"owner" text NOT NULL,
	"set_id" text NOT NULL,
	"version" integer NOT NULL,
	"manifest_hash" text NOT NULL,
	CONSTRAINT "question_sets_pkey" PRIMARY KEY("owner","set_id","version"),
	CONSTRAINT "question_sets_manifest_hash_check" CHECK (manifest_hash ~ '^[0-9a-f]{64}$'::text),
	CONSTRAINT "question_sets_owner_check" CHECK ((length(owner) >= 1) AND (length(owner) <= 256)),
	CONSTRAINT "question_sets_set_id_check" CHECK (set_id ~ '^[a-zA-Z0-9_-]{1,64}$'::text),
	CONSTRAINT "question_sets_version_check" CHECK (version > 0)
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."question_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."question_versions" (
	"owner" text NOT NULL,
	"question_id" text NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "question_versions_pkey" PRIMARY KEY("owner","question_id","version"),
	CONSTRAINT "question_versions_check" CHECK ((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 16384) AND ((payload ->> 'id'::text) = question_id) AND (((payload ->> 'version'::text))::integer = version) AND (payload ? 'id'::text) AND (payload ? 'version'::text)),
	CONSTRAINT "question_versions_owner_check" CHECK ((length(owner) >= 1) AND (length(owner) <= 256)),
	CONSTRAINT "question_versions_question_id_check" CHECK (question_id ~ '^[a-zA-Z0-9_-]{1,64}$'::text),
	CONSTRAINT "question_versions_version_check" CHECK (version = 1)
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."question_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."ruleset_versions" (
	"owner" text NOT NULL,
	"ruleset_id" text NOT NULL,
	"version" integer NOT NULL,
	"rules_hash" text NOT NULL,
	"config" jsonb NOT NULL,
	CONSTRAINT "ruleset_versions_pkey" PRIMARY KEY("owner","ruleset_id","version"),
	CONSTRAINT "ruleset_versions_config_check" CHECK ((jsonb_typeof(config) = 'object'::text) AND (octet_length((config)::text) <= 4096)),
	CONSTRAINT "ruleset_versions_owner_check" CHECK ((length(owner) >= 1) AND (length(owner) <= 256)),
	CONSTRAINT "ruleset_versions_rules_hash_check" CHECK (rules_hash ~ '^[0-9a-f]{64}$'::text),
	CONSTRAINT "ruleset_versions_ruleset_id_check" CHECK (ruleset_id ~ '^[a-zA-Z0-9_-]{1,64}$'::text),
	CONSTRAINT "ruleset_versions_version_check" CHECK (version > 0)
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."ruleset_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quiz_game"."competitions" ADD CONSTRAINT "competitions_owner_ruleset_id_ruleset_version_fkey" FOREIGN KEY ("owner","ruleset_id","ruleset_version") REFERENCES "quiz_game"."ruleset_versions"("owner","ruleset_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."competitions" ADD CONSTRAINT "competitions_owner_set_id_set_version_fkey" FOREIGN KEY ("owner","set_id","set_version") REFERENCES "quiz_game"."question_sets"("owner","set_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."matchmaking_settings" ADD CONSTRAINT "matchmaking_settings_owner_competition_id_competition_vers_fkey" FOREIGN KEY ("owner","competition_id","competition_version") REFERENCES "quiz_game"."competitions"("owner","competition_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_set_items" ADD CONSTRAINT "question_set_items_owner_question_id_question_version_fkey" FOREIGN KEY ("owner","question_id","question_version") REFERENCES "quiz_game"."question_versions"("owner","question_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_set_items" ADD CONSTRAINT "question_set_items_owner_set_id_set_version_fkey" FOREIGN KEY ("owner","set_id","set_version") REFERENCES "quiz_game"."question_sets"("owner","set_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "reader" ON "quiz_game"."competitions" AS PERMISSIVE FOR SELECT TO "quiz_game_reader" USING (true);--> statement-breakpoint
CREATE POLICY "reader" ON "quiz_game"."matchmaking_settings" AS PERMISSIVE FOR SELECT TO "quiz_game_reader" USING (true);--> statement-breakpoint
CREATE POLICY "probe_access" ON "quiz_probe"."runs" AS PERMISSIVE FOR ALL TO "quiz_probe" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "reader" ON "quiz_game"."question_availability" AS PERMISSIVE FOR SELECT TO "quiz_game_reader" USING (true);--> statement-breakpoint
CREATE POLICY "reader" ON "quiz_game"."question_set_items" AS PERMISSIVE FOR SELECT TO "quiz_game_reader" USING (true);--> statement-breakpoint
CREATE POLICY "reader" ON "quiz_game"."question_sets" AS PERMISSIVE FOR SELECT TO "quiz_game_reader" USING (true);--> statement-breakpoint
CREATE POLICY "reader" ON "quiz_game"."question_versions" AS PERMISSIVE FOR SELECT TO "quiz_game_reader" USING (true);--> statement-breakpoint
CREATE POLICY "reader" ON "quiz_game"."ruleset_versions" AS PERMISSIVE FOR SELECT TO "quiz_game_reader" USING (true);