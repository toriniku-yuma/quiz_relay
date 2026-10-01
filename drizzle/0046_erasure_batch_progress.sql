CREATE TABLE "quiz_game"."room_inventory_scans" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_ids" jsonb NOT NULL,
	"cursor" text,
	"complete" boolean DEFAULT false NOT NULL,
	"local_hash" text
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."room_inventory_scans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quiz_game"."account_withdrawals" ADD COLUMN "room_cursor" text;--> statement-breakpoint
ALTER TABLE "quiz_game"."account_withdrawals" ADD COLUMN "last_attempt_at" timestamp with time zone DEFAULT 'epoch'::timestamptz NOT NULL;--> statement-breakpoint
ALTER TABLE "quiz_game"."instance_deletions" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quiz_game"."instance_deletions" ADD COLUMN "check_cursor" text;--> statement-breakpoint
ALTER TABLE "quiz_game"."instance_deletions" ADD COLUMN "room_cursor" text;--> statement-breakpoint
ALTER TABLE "quiz_game"."instance_deletions" ADD COLUMN "inventory_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quiz_game"."instance_deletions" ADD COLUMN "last_attempt_at" timestamp with time zone DEFAULT 'epoch'::timestamptz NOT NULL;--> statement-breakpoint
ALTER TABLE "quiz_game"."instance_rooms" ADD COLUMN "review_attempted_at" timestamp with time zone DEFAULT 'epoch'::timestamptz NOT NULL;--> statement-breakpoint
CREATE INDEX "instance_rooms_review_attempted_at_room_id_index" ON "quiz_game"."instance_rooms" USING btree ("review_attempted_at","room_id");