CREATE TABLE "quiz_game"."organization_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"instance_id" uuid,
	"action" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb NOT NULL,
	CONSTRAINT "organization_event_actor_hash" CHECK ("quiz_game"."organization_events"."actor_id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "organization_event_action" CHECK ("quiz_game"."organization_events"."action" IN ('setup', 'add', 'publish', 'rename', 'grants'))
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."organization_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "organization_events_occurred_at_index" ON "quiz_game"."organization_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."organization_events" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);