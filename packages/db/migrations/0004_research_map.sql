CREATE TABLE "research_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "research_links_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"source_node_id" uuid NOT NULL,
	"target_node_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_by_author" text NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "research_links_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "research_links_endpoints_check" CHECK ("research_links"."source_node_id" <> "research_links"."target_node_id"),
	CONSTRAINT "research_links_author_check" CHECK (("research_links"."created_by_author" = 'owner' and "research_links"."created_by_agent_id" is null and "research_links"."created_by_run_id" is null)
      or ("research_links"."created_by_author" = 'agent' and "research_links"."created_by_agent_id" is not null and "research_links"."created_by_run_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "research_map_edits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "research_map_edits_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"editor_author" text NOT NULL,
	"editor_agent_id" uuid,
	"editor_run_id" uuid,
	"operation" text NOT NULL,
	"node_id" uuid,
	"link_id" uuid,
	"task_id" uuid,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "research_map_edits_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "research_map_edits_operation_check" CHECK ("research_map_edits"."operation" in ('create_node', 'update_node', 'assign_parent', 'change_parent', 'add_link', 'discard_node', 'restore_node', 'link_task', 'relink_task', 'unlink_task')),
	CONSTRAINT "research_map_edits_editor_check" CHECK (("research_map_edits"."editor_author" = 'owner' and "research_map_edits"."editor_agent_id" is null and "research_map_edits"."editor_run_id" is null)
      or ("research_map_edits"."editor_author" = 'agent' and "research_map_edits"."editor_agent_id" is not null and "research_map_edits"."editor_run_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "research_nodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "research_nodes_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"status_before_discard" text,
	"parent_node_id" uuid,
	"created_by_author" text NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "research_nodes_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "research_nodes_status_check" CHECK ("research_nodes"."status" in ('proposed', 'in_progress', 'done', 'rejected', 'discarded')
        and ("research_nodes"."status_before_discard" is null or "research_nodes"."status_before_discard" in ('proposed', 'in_progress', 'done', 'rejected'))
        and ("research_nodes"."status" = 'discarded') = ("research_nodes"."status_before_discard" is not null)),
	CONSTRAINT "research_nodes_parent_check" CHECK ("research_nodes"."parent_node_id" is null or "research_nodes"."parent_node_id" <> "research_nodes"."id"),
	CONSTRAINT "research_nodes_author_check" CHECK (("research_nodes"."created_by_author" = 'owner' and "research_nodes"."created_by_agent_id" is null and "research_nodes"."created_by_run_id" is null)
      or ("research_nodes"."created_by_author" = 'agent' and "research_nodes"."created_by_agent_id" is not null and "research_nodes"."created_by_run_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "wakes" DROP CONSTRAINT "wakes_kind_check";--> statement-breakpoint
ALTER TABLE "wakes" DROP CONSTRAINT "wakes_source_check";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "research_node_id" uuid;--> statement-breakpoint
ALTER TABLE "wakes" ADD COLUMN "map_edit_id" uuid;--> statement-breakpoint
ALTER TABLE "research_links" ADD CONSTRAINT "research_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_links" ADD CONSTRAINT "research_links_organization_id_source_node_id_research_nodes_organization_id_id_fk" FOREIGN KEY ("organization_id","source_node_id") REFERENCES "public"."research_nodes"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_links" ADD CONSTRAINT "research_links_organization_id_target_node_id_research_nodes_organization_id_id_fk" FOREIGN KEY ("organization_id","target_node_id") REFERENCES "public"."research_nodes"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_links" ADD CONSTRAINT "research_links_organization_id_created_by_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_links" ADD CONSTRAINT "research_links_organization_id_created_by_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_map_edits" ADD CONSTRAINT "research_map_edits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_map_edits" ADD CONSTRAINT "research_map_edits_organization_id_editor_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","editor_agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_map_edits" ADD CONSTRAINT "research_map_edits_organization_id_editor_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","editor_run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_map_edits" ADD CONSTRAINT "research_map_edits_organization_id_node_id_research_nodes_organization_id_id_fk" FOREIGN KEY ("organization_id","node_id") REFERENCES "public"."research_nodes"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_map_edits" ADD CONSTRAINT "research_map_edits_organization_id_link_id_research_links_organization_id_id_fk" FOREIGN KEY ("organization_id","link_id") REFERENCES "public"."research_links"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_map_edits" ADD CONSTRAINT "research_map_edits_organization_id_task_id_tasks_organization_id_id_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "public"."tasks"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_nodes" ADD CONSTRAINT "research_nodes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_nodes" ADD CONSTRAINT "research_nodes_organization_id_parent_node_id_research_nodes_organization_id_id_fk" FOREIGN KEY ("organization_id","parent_node_id") REFERENCES "public"."research_nodes"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_nodes" ADD CONSTRAINT "research_nodes_organization_id_created_by_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_nodes" ADD CONSTRAINT "research_nodes_organization_id_created_by_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_links_organization_idx" ON "research_links" USING btree ("organization_id","seq");--> statement-breakpoint
CREATE INDEX "research_map_edits_node_idx" ON "research_map_edits" USING btree ("organization_id","node_id","seq");--> statement-breakpoint
CREATE INDEX "research_nodes_organization_idx" ON "research_nodes" USING btree ("organization_id","seq");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_research_node_id_research_nodes_organization_id_id_fk" FOREIGN KEY ("organization_id","research_node_id") REFERENCES "public"."research_nodes"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_organization_id_map_edit_id_research_map_edits_organization_id_id_fk" FOREIGN KEY ("organization_id","map_edit_id") REFERENCES "public"."research_map_edits"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_research_node_idx" ON "tasks" USING btree ("organization_id","research_node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wakes_map_edit_unique" ON "wakes" USING btree ("map_edit_id");--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_kind_check" CHECK ("wakes"."kind" in ('owner_message', 'approval_decision', 'task_assigned', 'task_completed', 'task_comment', 'agent_to_agent_message', 'research_map_edit'));--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_source_check" CHECK (num_nonnulls("wakes"."message_id", "wakes"."approval_id", "wakes"."task_id", "wakes"."comment_id", "wakes"."agent_to_agent_message_id", "wakes"."map_edit_id") = 1
        and (("kind" = 'owner_message' and "message_id" is not null) or ("kind" = 'approval_decision' and "approval_id" is not null) or ("kind" = 'task_assigned' and "task_id" is not null) or ("kind" = 'task_completed' and "task_id" is not null) or ("kind" = 'task_comment' and "comment_id" is not null) or ("kind" = 'agent_to_agent_message' and "agent_to_agent_message_id" is not null) or ("kind" = 'research_map_edit' and "map_edit_id" is not null)));