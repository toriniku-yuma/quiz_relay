ALTER TABLE "quiz_game"."organization_accounts" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "quiz_game"."organization_accounts" ADD COLUMN "profile_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quiz_game"."organization_accounts" ADD CONSTRAINT "organization_display_name_unique" UNIQUE("organization_id","display_name");--> statement-breakpoint
ALTER TABLE "quiz_game"."organization_accounts" ADD CONSTRAINT "profile_revision_valid" CHECK ("quiz_game"."organization_accounts"."profile_revision" >= 0);