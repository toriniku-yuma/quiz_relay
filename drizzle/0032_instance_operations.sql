ALTER TABLE "quiz_game"."instances" ADD COLUMN "operation_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quiz_game"."instances" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "quiz_game"."instances" ADD COLUMN "ranked_pause_reason" text;--> statement-breakpoint
ALTER TABLE "quiz_game"."instances" ADD COLUMN "casual_pause_reason" text;