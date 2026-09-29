CREATE TABLE "quiz_game"."moderation_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"instance_id" uuid,
	"actor_id" text NOT NULL,
	"operator_id" text NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"request_hash" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "moderation_action" CHECK ("quiz_game"."moderation_events"."action" IN ('add','change','revoke','inspect'))
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."moderation_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."moderation_sanctions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"instance_id" uuid,
	"actor_id" text NOT NULL,
	"kind" text NOT NULL,
	"restrictions" jsonb NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sanction_kind" CHECK ("quiz_game"."moderation_sanctions"."kind" IN ('timeout','ban','partial')),
	CONSTRAINT "sanction_scope" CHECK ("quiz_game"."moderation_sanctions"."instance_id" IS NOT NULL OR "quiz_game"."moderation_sanctions"."kind" = 'ban'),
	CONSTRAINT "sanction_expiry" CHECK (("quiz_game"."moderation_sanctions"."kind" = 'timeout') = ("quiz_game"."moderation_sanctions"."expires_at" IS NOT NULL)),
	CONSTRAINT "sanction_revision" CHECK ("quiz_game"."moderation_sanctions"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."moderation_sanctions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quiz_game"."moderation_events" ADD CONSTRAINT "moderation_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "quiz_game"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."moderation_events" ADD CONSTRAINT "moderation_events_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "quiz_game"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."moderation_sanctions" ADD CONSTRAINT "moderation_sanctions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "quiz_game"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."moderation_sanctions" ADD CONSTRAINT "moderation_sanctions_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "quiz_game"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."moderation_sanctions" ADD CONSTRAINT "moderation_sanctions_actor_id_organization_accounts_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "quiz_game"."organization_accounts"("actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_events_actor_id_created_at_index" ON "quiz_game"."moderation_events" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_sanctions_actor_id_instance_id_index" ON "quiz_game"."moderation_sanctions" USING btree ("actor_id","instance_id");--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."moderation_events" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."moderation_sanctions" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);