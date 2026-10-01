CREATE TABLE "quiz_game"."guest_sessions" (
	"actor_id" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "guest_actor_hash" CHECK ("quiz_game"."guest_sessions"."actor_id" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."guest_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."personal_question_sets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"name" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"questions" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_set_revision" CHECK ("quiz_game"."personal_question_sets"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."personal_question_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."room_directory" (
	"id" uuid PRIMARY KEY NOT NULL,
	"instance_id" uuid NOT NULL,
	"public" boolean NOT NULL,
	"closed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."room_directory" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_reports" DROP CONSTRAINT "question_reports_actor_id_organization_accounts_actor_id_fk";
--> statement-breakpoint
ALTER TABLE "quiz_game"."user_reports" DROP CONSTRAINT "user_reports_reporter_id_organization_accounts_actor_id_fk";
--> statement-breakpoint
ALTER TABLE "quiz_game"."instances" ADD COLUMN "casual_config" jsonb DEFAULT '{"enabled":true,"players":4,"casualGuests":false,"roomGuests":false}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "quiz_game"."guest_sessions" ADD CONSTRAINT "guest_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "quiz_game"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."personal_question_sets" ADD CONSTRAINT "personal_question_sets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "quiz_game"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."personal_question_sets" ADD CONSTRAINT "personal_question_sets_author_id_organization_accounts_actor_id_fk" FOREIGN KEY ("author_id") REFERENCES "quiz_game"."organization_accounts"("actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."room_directory" ADD CONSTRAINT "room_directory_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "quiz_game"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guest_sessions_expires_at_index" ON "quiz_game"."guest_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "personal_question_sets_organization_id_author_id_index" ON "quiz_game"."personal_question_sets" USING btree ("organization_id","author_id");--> statement-breakpoint
CREATE INDEX "room_directory_instance_id_public_closed_index" ON "quiz_game"."room_directory" USING btree ("instance_id","public","closed");--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."guest_sessions" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."personal_question_sets" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."room_directory" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);