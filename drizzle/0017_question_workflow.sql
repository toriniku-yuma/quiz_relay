CREATE TABLE "quiz_game"."question_authors" (
	"instance_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"retry_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "question_authors_instance_id_actor_id_pk" PRIMARY KEY("instance_id","actor_id"),
	CONSTRAINT "question_author_status" CHECK ("quiz_game"."question_authors"."status" IN ('pending','qualified','rejected','revoked'))
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."question_authors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."question_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"instance_id" uuid NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "question_categories_instance_id_name_unique" UNIQUE("instance_id","name"),
	CONSTRAINT "question_categories_instance_id_id_unique" UNIQUE("instance_id","id")
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."question_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."question_imports" (
	"instance_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"ids" jsonb NOT NULL,
	CONSTRAINT "question_imports_instance_id_actor_id_request_id_pk" PRIMARY KEY("instance_id","actor_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."question_imports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."question_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"instance_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"message" text NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."question_notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."question_settings" (
	"instance_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"config" jsonb NOT NULL,
	CONSTRAINT "question_settings_revision" CHECK ("quiz_game"."question_settings"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."question_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."question_submission_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"submission_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"input" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."question_submission_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."question_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"instance_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"input" jsonb NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"published_id" uuid,
	"stopped" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_submission_revision" CHECK ("quiz_game"."question_submissions"."revision" > 0),
	CONSTRAINT "question_submission_status" CHECK ("quiz_game"."question_submissions"."status" IN ('draft','pending','returned','approved','rejected','ended'))
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."question_submissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."question_tags" (
	"instance_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "question_tags_instance_id_key_pk" PRIMARY KEY("instance_id","key")
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."question_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_authors" ADD CONSTRAINT "question_authors_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "quiz_game"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_authors" ADD CONSTRAINT "question_authors_actor_id_organization_accounts_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "quiz_game"."organization_accounts"("actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_categories" ADD CONSTRAINT "question_categories_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "quiz_game"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_imports" ADD CONSTRAINT "question_imports_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "quiz_game"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_imports" ADD CONSTRAINT "question_imports_actor_id_organization_accounts_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "quiz_game"."organization_accounts"("actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_notifications" ADD CONSTRAINT "question_notifications_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "quiz_game"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_notifications" ADD CONSTRAINT "question_notifications_actor_id_organization_accounts_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "quiz_game"."organization_accounts"("actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_settings" ADD CONSTRAINT "question_settings_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "quiz_game"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_submission_events" ADD CONSTRAINT "question_submission_events_submission_id_question_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "quiz_game"."question_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_submission_events" ADD CONSTRAINT "question_submission_events_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "quiz_game"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_submissions" ADD CONSTRAINT "question_submissions_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "quiz_game"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_submissions" ADD CONSTRAINT "question_submissions_author_id_organization_accounts_actor_id_fk" FOREIGN KEY ("author_id") REFERENCES "quiz_game"."organization_accounts"("actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_tags" ADD CONSTRAINT "question_tags_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "quiz_game"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_notifications_instance_id_actor_id_index" ON "quiz_game"."question_notifications" USING btree ("instance_id","actor_id");--> statement-breakpoint
CREATE INDEX "question_submission_events_submission_id_revision_index" ON "quiz_game"."question_submission_events" USING btree ("submission_id","revision");--> statement-breakpoint
CREATE INDEX "question_submissions_instance_id_author_id_index" ON "quiz_game"."question_submissions" USING btree ("instance_id","author_id");--> statement-breakpoint
CREATE INDEX "question_submissions_instance_id_status_index" ON "quiz_game"."question_submissions" USING btree ("instance_id","status");--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."question_authors" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."question_categories" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."question_imports" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."question_notifications" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."question_settings" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."question_submission_events" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."question_submissions" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."question_tags" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);