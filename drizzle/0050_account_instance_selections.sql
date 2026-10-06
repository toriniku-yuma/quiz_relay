CREATE TABLE "quiz_game"."account_instance_selections" (
	"actor_id" text NOT NULL,
	"instance_id" uuid NOT NULL,
	CONSTRAINT "account_instance_selections_actor_id_instance_id_pk" PRIMARY KEY("actor_id","instance_id")
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."account_instance_selections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quiz_game"."account_instance_selections" ADD CONSTRAINT "account_instance_selections_actor_id_organization_accounts_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "quiz_game"."organization_accounts"("actor_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."account_instance_selections" ADD CONSTRAINT "account_instance_selections_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "quiz_game"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_instance_selections_instance_id_index" ON "quiz_game"."account_instance_selections" USING btree ("instance_id");--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."account_instance_selections" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);