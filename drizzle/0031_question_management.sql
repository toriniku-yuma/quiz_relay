ALTER TABLE "quiz_game"."question_submissions" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_submissions" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_submissions" ADD COLUMN "review_hold" boolean DEFAULT false NOT NULL;