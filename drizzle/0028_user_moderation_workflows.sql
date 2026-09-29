CREATE TABLE "quiz_game"."administrator_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"sender_id" text NOT NULL,
	"target_id" text NOT NULL,
	"keep_sender" boolean NOT NULL,
	"read_at" timestamp with time zone,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."administrator_transfers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."moderation_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"operator_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."moderation_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."sanction_appeals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"sanction_id" uuid NOT NULL,
	"sanction_revision" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"operator_id" text,
	"resolution" text,
	"decision" text,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."sanction_appeals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."user_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"reporter_id" text NOT NULL,
	"result_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"operator_id" text,
	"resolution" text,
	CONSTRAINT "user_report_reason" CHECK (char_length(btrim("quiz_game"."user_reports"."reason")) BETWEEN 1 AND 1000)
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."user_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quiz_game"."administrator_transfers" ADD CONSTRAINT "administrator_transfers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "quiz_game"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."administrator_transfers" ADD CONSTRAINT "administrator_transfers_sender_id_organization_accounts_actor_id_fk" FOREIGN KEY ("sender_id") REFERENCES "quiz_game"."organization_accounts"("actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."administrator_transfers" ADD CONSTRAINT "administrator_transfers_target_id_organization_accounts_actor_id_fk" FOREIGN KEY ("target_id") REFERENCES "quiz_game"."organization_accounts"("actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."moderation_requests" ADD CONSTRAINT "moderation_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "quiz_game"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."sanction_appeals" ADD CONSTRAINT "sanction_appeals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "quiz_game"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."sanction_appeals" ADD CONSTRAINT "sanction_appeals_actor_id_organization_accounts_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "quiz_game"."organization_accounts"("actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."sanction_appeals" ADD CONSTRAINT "sanction_appeals_sanction_id_moderation_sanctions_id_fk" FOREIGN KEY ("sanction_id") REFERENCES "quiz_game"."moderation_sanctions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."user_reports" ADD CONSTRAINT "user_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "quiz_game"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."user_reports" ADD CONSTRAINT "user_reports_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "quiz_game"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."user_reports" ADD CONSTRAINT "user_reports_actor_id_organization_accounts_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "quiz_game"."organization_accounts"("actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."user_reports" ADD CONSTRAINT "user_reports_reporter_id_organization_accounts_actor_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "quiz_game"."organization_accounts"("actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "administrator_transfers_target_id_state_index" ON "quiz_game"."administrator_transfers" USING btree ("target_id","state");--> statement-breakpoint
CREATE INDEX "sanction_appeals_actor_id_resolved_at_index" ON "quiz_game"."sanction_appeals" USING btree ("actor_id","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sanction_appeals_sanction_id_index" ON "quiz_game"."sanction_appeals" USING btree ("sanction_id") WHERE "quiz_game"."sanction_appeals"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "user_reports_instance_id_actor_id_resolved_at_index" ON "quiz_game"."user_reports" USING btree ("instance_id","actor_id","resolved_at");--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."administrator_transfers" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."moderation_requests" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."sanction_appeals" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."user_reports" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);