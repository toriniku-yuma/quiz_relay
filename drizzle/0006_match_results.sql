CREATE TABLE "quiz_game"."match_results" (
	"result_id" uuid PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"match_id" uuid NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "match_results_owner_match_id_unique" UNIQUE("owner","match_id"),
	CONSTRAINT "match_results_hash" CHECK ("quiz_game"."match_results"."payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."match_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."result_outbox" (
	"result_id" uuid PRIMARY KEY NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."result_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."result_players" (
	"result_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"name" text NOT NULL,
	"rating_delta" integer NOT NULL,
	CONSTRAINT "result_players_result_id_actor_id_pk" PRIMARY KEY("result_id","actor_id"),
	CONSTRAINT "result_players_delta" CHECK ("quiz_game"."result_players"."rating_delta" IN (-20, 0, 20))
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."result_players" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quiz_game"."result_outbox" ADD CONSTRAINT "result_outbox_result_id_match_results_result_id_fk" FOREIGN KEY ("result_id") REFERENCES "quiz_game"."match_results"("result_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."result_players" ADD CONSTRAINT "result_players_result_id_match_results_result_id_fk" FOREIGN KEY ("result_id") REFERENCES "quiz_game"."match_results"("result_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "match_results_owner_finished_at_index" ON "quiz_game"."match_results" USING btree ("owner","finished_at");--> statement-breakpoint
CREATE INDEX "result_players_actor_id_index" ON "quiz_game"."result_players" USING btree ("actor_id");--> statement-breakpoint
CREATE POLICY "reader" ON "quiz_game"."match_results" AS PERMISSIVE FOR SELECT TO "quiz_game_reader" USING (true);--> statement-breakpoint
CREATE POLICY "result_read" ON "quiz_game"."match_results" AS PERMISSIVE FOR SELECT TO "quiz_game_results" USING (true);--> statement-breakpoint
CREATE POLICY "result_insert" ON "quiz_game"."match_results" AS PERMISSIVE FOR INSERT TO "quiz_game_results" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "result_read" ON "quiz_game"."result_outbox" AS PERMISSIVE FOR SELECT TO "quiz_game_results" USING (true);--> statement-breakpoint
CREATE POLICY "result_insert" ON "quiz_game"."result_outbox" AS PERMISSIVE FOR INSERT TO "quiz_game_results" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "reader" ON "quiz_game"."result_players" AS PERMISSIVE FOR SELECT TO "quiz_game_reader" USING (true);--> statement-breakpoint
CREATE POLICY "result_read" ON "quiz_game"."result_players" AS PERMISSIVE FOR SELECT TO "quiz_game_results" USING (true);--> statement-breakpoint
CREATE POLICY "result_insert" ON "quiz_game"."result_players" AS PERMISSIVE FOR INSERT TO "quiz_game_results" WITH CHECK (true);