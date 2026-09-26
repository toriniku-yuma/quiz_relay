CREATE TABLE "quiz_game"."question_difficulty" (
	"instance_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"generation" uuid NOT NULL,
	"current" integer NOT NULL,
	"fixed" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"last_day" text,
	"cursor" text,
	"stats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text DEFAULT '自己申告' NOT NULL,
	CONSTRAINT "question_difficulty_instance_id_series_id_pk" PRIMARY KEY("instance_id","series_id"),
	CONSTRAINT "question_difficulty_range" CHECK ("quiz_game"."question_difficulty"."current" BETWEEN 0 AND 2)
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."question_difficulty" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."question_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"instance_id" uuid NOT NULL,
	"question_id" text NOT NULL,
	"kind" text NOT NULL,
	"round" integer NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text NOT NULL,
	"suggested_category" text DEFAULT '' NOT NULL,
	CONSTRAINT "question_reports_instance_id_question_id_kind_round_actor_id_unique" UNIQUE("instance_id","question_id","kind","round","actor_id"),
	CONSTRAINT "question_report_kind" CHECK ("quiz_game"."question_reports"."kind" IN ('defect','category'))
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."question_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."question_review_cases" (
	"instance_id" uuid NOT NULL,
	"question_id" text NOT NULL,
	"kind" text NOT NULL,
	"round" integer NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	CONSTRAINT "question_review_cases_instance_id_question_id_kind_round_pk" PRIMARY KEY("instance_id","question_id","kind","round"),
	CONSTRAINT "review_case_kind" CHECK ("quiz_game"."question_review_cases"."kind" IN ('defect','category'))
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."question_review_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_sets" ADD COLUMN "selection" jsonb;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_difficulty" ADD CONSTRAINT "question_difficulty_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "quiz_game"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_reports" ADD CONSTRAINT "question_reports_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "quiz_game"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_reports" ADD CONSTRAINT "question_reports_actor_id_organization_accounts_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "quiz_game"."organization_accounts"("actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."question_review_cases" ADD CONSTRAINT "question_review_cases_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "quiz_game"."instances"("id") ON DELETE no action ON UPDATE no action;