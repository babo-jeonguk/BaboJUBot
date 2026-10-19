CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "approvals_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"requested_by_agent_id" uuid NOT NULL,
	"requested_by_run_id" uuid NOT NULL,
	"previous_approval_id" uuid,
	"proposal" jsonb NOT NULL,
	"decision_note" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approvals_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "approvals_kind_check" CHECK ("approvals"."kind" in ('initial_research')),
	CONSTRAINT "approvals_status_check" CHECK ("approvals"."status" in ('pending', 'approved', 'rejected', 'changes_requested')),
	CONSTRAINT "approvals_decided_check" CHECK (("approvals"."status" = 'pending') = ("approvals"."decided_at" is null))
);
--> statement-breakpoint
CREATE TABLE "flow_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"name" text NOT NULL,
	"label" text NOT NULL,
	"description" text NOT NULL,
	"node_kinds" jsonb NOT NULL,
	"link_kinds" jsonb NOT NULL,
	"source" text NOT NULL,
	"source_digest" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "flow_templates_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "instruction_copies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "instruction_copies_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"source" text NOT NULL,
	"source_digest" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "instruction_copies_kind_check" CHECK ("instruction_copies"."kind" in ('role', 'soul', 'skill'))
);
--> statement-breakpoint
ALTER TABLE "wakes" DROP CONSTRAINT "wakes_message_check";--> statement-breakpoint
ALTER TABLE "wakes" DROP CONSTRAINT "wakes_kind_check";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "goal" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "completion_criteria" text;--> statement-breakpoint
ALTER TABLE "wakes" ADD COLUMN "approval_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_organization_id_requested_by_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","requested_by_agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_organization_id_requested_by_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","requested_by_run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_organization_id_previous_approval_id_approvals_organization_id_id_fk" FOREIGN KEY ("organization_id","previous_approval_id") REFERENCES "public"."approvals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_templates" ADD CONSTRAINT "flow_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_templates" ADD CONSTRAINT "flow_templates_organization_id_approval_id_approvals_organization_id_id_fk" FOREIGN KEY ("organization_id","approval_id") REFERENCES "public"."approvals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_copies" ADD CONSTRAINT "instruction_copies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_copies" ADD CONSTRAINT "instruction_copies_organization_id_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_one_pending_per_organization" ON "approvals" USING btree ("organization_id") WHERE "approvals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "approvals_organization_idx" ON "approvals" USING btree ("organization_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "instruction_copies_agent_path_unique" ON "instruction_copies" USING btree ("agent_id","path");--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_organization_id_approval_id_approvals_organization_id_id_fk" FOREIGN KEY ("organization_id","approval_id") REFERENCES "public"."approvals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wakes_approval_unique" ON "wakes" USING btree ("approval_id");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_goal_check" CHECK (("organizations"."goal" is null) = ("organizations"."completion_criteria" is null));--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_source_check" CHECK (("wakes"."kind" = 'owner_message' and "wakes"."message_id" is not null and "wakes"."approval_id" is null)
        or ("wakes"."kind" = 'approval_decision' and "wakes"."approval_id" is not null and "wakes"."message_id" is null));--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_kind_check" CHECK ("wakes"."kind" in ('owner_message', 'approval_decision'));