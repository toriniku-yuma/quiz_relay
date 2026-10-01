ALTER TABLE "quiz_game"."question_reports" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_review_cases" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_review_cases" ADD COLUMN "resolved_at" timestamp with time zone;