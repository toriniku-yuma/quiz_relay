CREATE POLICY "config_read" ON "quiz_game"."competitions" AS PERMISSIVE FOR SELECT TO "quiz_game_config" USING (true);--> statement-breakpoint
CREATE POLICY "config_insert" ON "quiz_game"."competitions" AS PERMISSIVE FOR INSERT TO "quiz_game_config" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "config_read" ON "quiz_game"."matchmaking_settings" AS PERMISSIVE FOR SELECT TO "quiz_game_config" USING (true);--> statement-breakpoint
CREATE POLICY "config_insert" ON "quiz_game"."matchmaking_settings" AS PERMISSIVE FOR INSERT TO "quiz_game_config" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "config_update" ON "quiz_game"."matchmaking_settings" AS PERMISSIVE FOR UPDATE TO "quiz_game_config" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "config_read" ON "quiz_game"."question_availability" AS PERMISSIVE FOR SELECT TO "quiz_game_config" USING (true);--> statement-breakpoint
CREATE POLICY "config_read" ON "quiz_game"."question_set_items" AS PERMISSIVE FOR SELECT TO "quiz_game_config" USING (true);--> statement-breakpoint
CREATE POLICY "config_read" ON "quiz_game"."question_sets" AS PERMISSIVE FOR SELECT TO "quiz_game_config" USING (true);--> statement-breakpoint
CREATE POLICY "config_read" ON "quiz_game"."question_versions" AS PERMISSIVE FOR SELECT TO "quiz_game_config" USING (true);--> statement-breakpoint
CREATE POLICY "config_read" ON "quiz_game"."ruleset_versions" AS PERMISSIVE FOR SELECT TO "quiz_game_config" USING (true);--> statement-breakpoint
CREATE POLICY "config_insert" ON "quiz_game"."ruleset_versions" AS PERMISSIVE FOR INSERT TO "quiz_game_config" WITH CHECK (true);