CREATE TABLE "quiz_game"."account_withdrawals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"auth_deleted_at" timestamp with time zone,
	"erased_at" timestamp with time zone,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "account_withdrawals_actor_id_unique" UNIQUE("actor_id")
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."account_withdrawals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quiz_game"."organization_accounts" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quiz_game"."account_withdrawals" ADD CONSTRAINT "account_withdrawals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "quiz_game"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."account_withdrawals" ADD CONSTRAINT "account_withdrawals_actor_id_organization_accounts_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "quiz_game"."organization_accounts"("actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."account_withdrawals" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);