CREATE INDEX "instance_grants_actor_id_index" ON "quiz_game"."instance_grants" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "instances_organization_id_index" ON "quiz_game"."instances" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "quiz_game"."instances" ADD CONSTRAINT "instance_name_length" CHECK (char_length(btrim("quiz_game"."instances"."name")) BETWEEN 1 AND 80);--> statement-breakpoint
ALTER TABLE "quiz_game"."instances" ADD CONSTRAINT "instance_owner_length" CHECK (char_length(btrim("quiz_game"."instances"."owner")) BETWEEN 1 AND 256);--> statement-breakpoint
ALTER TABLE "quiz_game"."organization_accounts" ADD CONSTRAINT "account_subject_length" CHECK (char_length(btrim("quiz_game"."organization_accounts"."subject")) BETWEEN 1 AND 256);--> statement-breakpoint
ALTER TABLE "quiz_game"."organization_accounts" ADD CONSTRAINT "account_actor_hash" CHECK ("quiz_game"."organization_accounts"."actor_id" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "quiz_game"."organizations" ADD CONSTRAINT "organization_name_length" CHECK (char_length(btrim("quiz_game"."organizations"."name")) BETWEEN 1 AND 80);--> statement-breakpoint
ALTER TABLE "quiz_game"."organizations" ADD CONSTRAINT "organization_namespace_length" CHECK (char_length(btrim("quiz_game"."organizations"."identity_namespace")) BETWEEN 1 AND 256);