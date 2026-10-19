CREATE TABLE "agent_to_agent_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "agent_to_agent_messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"sender_agent_id" uuid NOT NULL,
	"sender_run_id" uuid NOT NULL,
	"recipient_agent_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_to_agent_messages_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "agent_to_agent_messages_recipient_check" CHECK ("agent_to_agent_messages"."sender_agent_id" <> "agent_to_agent_messages"."recipient_agent_id")
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "artifacts_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"title" text NOT NULL,
	"format" text NOT NULL,
	"content" text NOT NULL,
	"created_by_agent_id" uuid NOT NULL,
	"created_by_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "artifacts_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "artifacts_format_check" CHECK ("artifacts"."format" in ('markdown', 'text'))
);
--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "task_comments_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"author" text NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "task_comments_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "task_comments_author_check" CHECK (("task_comments"."author" = 'owner' and "task_comments"."agent_id" is null and "task_comments"."run_id" is null)
        or ("task_comments"."author" = 'agent' and "task_comments"."agent_id" is not null and "task_comments"."run_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "tasks_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" text NOT NULL,
	"assignee_agent_id" uuid NOT NULL,
	"parent_task_id" uuid,
	"created_by_agent_id" uuid NOT NULL,
	"created_by_run_id" uuid NOT NULL,
	"started_at" timestamp with time zone,
	"report_summary" text,
	"completed_by_agent_id" uuid,
	"completed_by_run_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tasks_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" in ('open', 'in_progress', 'completed')),
	CONSTRAINT "tasks_report_check" CHECK (("tasks"."status" = 'completed') = ("tasks"."completed_at" is not null)
        and num_nulls("tasks"."completed_at", "tasks"."report_summary", "tasks"."completed_by_agent_id", "tasks"."completed_by_run_id") in (0, 4)),
	CONSTRAINT "tasks_started_check" CHECK (("tasks"."status" <> 'open' or "tasks"."started_at" is null)
        and ("tasks"."status" <> 'in_progress' or "tasks"."started_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "wakes" DROP CONSTRAINT "wakes_kind_check";--> statement-breakpoint
ALTER TABLE "wakes" DROP CONSTRAINT "wakes_source_check";--> statement-breakpoint
ALTER TABLE "wakes" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "wakes" ADD COLUMN "comment_id" uuid;--> statement-breakpoint
ALTER TABLE "wakes" ADD COLUMN "agent_to_agent_message_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_to_agent_messages" ADD CONSTRAINT "agent_to_agent_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_to_agent_messages" ADD CONSTRAINT "agent_to_agent_messages_organization_id_sender_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","sender_agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_to_agent_messages" ADD CONSTRAINT "agent_to_agent_messages_organization_id_sender_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","sender_run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_to_agent_messages" ADD CONSTRAINT "agent_to_agent_messages_organization_id_recipient_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","recipient_agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_organization_id_task_id_tasks_organization_id_id_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "public"."tasks"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_organization_id_created_by_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_organization_id_created_by_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_organization_id_task_id_tasks_organization_id_id_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "public"."tasks"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_organization_id_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_organization_id_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_assignee_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","assignee_agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_parent_task_id_tasks_organization_id_id_fk" FOREIGN KEY ("organization_id","parent_task_id") REFERENCES "public"."tasks"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_created_by_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_created_by_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","created_by_run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_completed_by_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","completed_by_agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_completed_by_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","completed_by_run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_task_idx" ON "artifacts" USING btree ("organization_id","task_id","seq");--> statement-breakpoint
CREATE INDEX "task_comments_task_idx" ON "task_comments" USING btree ("organization_id","task_id","seq");--> statement-breakpoint
CREATE INDEX "tasks_organization_idx" ON "tasks" USING btree ("organization_id","seq");--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_organization_id_task_id_tasks_organization_id_id_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "public"."tasks"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_organization_id_comment_id_task_comments_organization_id_id_fk" FOREIGN KEY ("organization_id","comment_id") REFERENCES "public"."task_comments"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_organization_id_agent_to_agent_message_id_agent_to_agent_messages_organization_id_id_fk" FOREIGN KEY ("organization_id","agent_to_agent_message_id") REFERENCES "public"."agent_to_agent_messages"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wakes_task_kind_unique" ON "wakes" USING btree ("task_id","kind") WHERE "wakes"."task_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "wakes_comment_unique" ON "wakes" USING btree ("comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wakes_agent_to_agent_message_unique" ON "wakes" USING btree ("agent_to_agent_message_id");--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_kind_check" CHECK ("wakes"."kind" in ('owner_message', 'approval_decision', 'task_assigned', 'task_completed', 'task_comment', 'agent_to_agent_message'));--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_source_check" CHECK (num_nonnulls("wakes"."message_id", "wakes"."approval_id", "wakes"."task_id", "wakes"."comment_id", "wakes"."agent_to_agent_message_id") = 1
        and (("kind" = 'owner_message' and "message_id" is not null) or ("kind" = 'approval_decision' and "approval_id" is not null) or ("kind" = 'task_assigned' and "task_id" is not null) or ("kind" = 'task_completed' and "task_id" is not null) or ("kind" = 'task_comment' and "comment_id" is not null) or ("kind" = 'agent_to_agent_message' and "agent_to_agent_message_id" is not null)));