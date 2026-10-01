CREATE TABLE "quiz_game"."instance_deletions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"instance_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"operator_id" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "instance_deletions_instance_id_unique" UNIQUE("instance_id")
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."instance_deletions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."instance_rooms" (
	"room_id" text PRIMARY KEY NOT NULL,
	"instance_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."instance_rooms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quiz_game"."instances" ADD COLUMN "room_inventory_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quiz_game"."instance_deletions" ADD CONSTRAINT "instance_deletions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "quiz_game"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."instance_rooms" ADD CONSTRAINT "instance_rooms_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "quiz_game"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."instance_deletions" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."instance_rooms" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);