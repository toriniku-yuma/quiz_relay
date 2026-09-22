CREATE TABLE "quiz_game"."instance_grants" (
	"instance_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "instance_grants_instance_id_actor_id_permission_pk" PRIMARY KEY("instance_id","actor_id","permission"),
	CONSTRAINT "instance_permission" CHECK ("quiz_game"."instance_grants"."permission" IN ('questions', 'authors', 'users'))
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."instance_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"state" text DEFAULT 'preparing' NOT NULL,
	CONSTRAINT "instances_owner_unique" UNIQUE("owner"),
	CONSTRAINT "instance_state" CHECK ("quiz_game"."instances"."state" IN ('preparing', 'published'))
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."instances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."organization_accounts" (
	"organization_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"actor_id" text PRIMARY KEY NOT NULL,
	"administrator" boolean DEFAULT false NOT NULL,
	CONSTRAINT "organization_accounts_organization_id_subject_unique" UNIQUE("organization_id","subject")
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."organization_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_game"."organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"name" text NOT NULL,
	"identity_namespace" text NOT NULL,
	CONSTRAINT "organizations_singleton_unique" UNIQUE("singleton"),
	CONSTRAINT "organizations_identity_namespace_unique" UNIQUE("identity_namespace"),
	CONSTRAINT "one_organization" CHECK ("quiz_game"."organizations"."singleton" = true)
);
--> statement-breakpoint
ALTER TABLE "quiz_game"."organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quiz_game"."instance_grants" ADD CONSTRAINT "instance_grants_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "quiz_game"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."instance_grants" ADD CONSTRAINT "instance_grants_actor_id_organization_accounts_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "quiz_game"."organization_accounts"("actor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."instances" ADD CONSTRAINT "instances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "quiz_game"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_game"."organization_accounts" ADD CONSTRAINT "organization_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "quiz_game"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."instance_grants" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."instances" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."organization_accounts" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "organization_service" ON "quiz_game"."organizations" AS PERMISSIVE FOR ALL TO "quiz_organization" USING (true) WITH CHECK (true);