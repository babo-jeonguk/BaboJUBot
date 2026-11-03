CREATE TABLE "session_maintenance_leases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_id" uuid,
	"provider" text NOT NULL,
	"generation" integer NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "maintenance" jsonb;--> statement-breakpoint
ALTER TABLE "session_maintenance_leases" ADD CONSTRAINT "session_maintenance_leases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_maintenance_leases" ADD CONSTRAINT "session_maintenance_leases_organization_id_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;