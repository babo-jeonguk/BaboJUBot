CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"role" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agents_role_check" CHECK ("agents"."role" in ('lead', 'worker'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"stage" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "organizations_stage_check" CHECK ("organizations"."stage" in ('goal_setting', 'planning', 'awaiting_approval', 'researching', 'paused', 'result_review', 'completed', 'stopped'))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_organization_idx" ON "agents" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_one_lead_per_organization" ON "agents" USING btree ("organization_id") WHERE "agents"."role" = 'lead';--> statement-breakpoint
CREATE INDEX "events_organization_idx" ON "events" USING btree ("organization_id","id");