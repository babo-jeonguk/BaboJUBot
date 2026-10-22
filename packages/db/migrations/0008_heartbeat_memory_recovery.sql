CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "memories_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"agent_id" uuid,
	"content" text NOT NULL,
	"source_agent_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "memories_scope_check" CHECK ("memories"."scope" in ('organization', 'agent')
        and ("memories"."scope" = 'agent') = ("memories"."agent_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "run_wakes" (
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"wake_id" uuid NOT NULL,
	CONSTRAINT "run_wakes_run_id_wake_id_pk" PRIMARY KEY("run_id","wake_id")
);
--> statement-breakpoint
CREATE TABLE "tool_operations" (
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"key" text NOT NULL,
	"tool" text NOT NULL,
	"request_digest" text NOT NULL,
	"result" jsonb NOT NULL,
	"run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_operations_agent_id_key_pk" PRIMARY KEY("agent_id","key")
);
--> statement-breakpoint
-- run_wakes의 (조직, 깨우기) FK가 이 unique를 참조하므로 FK보다 먼저 만든다.
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_status_check";--> statement-breakpoint
ALTER TABLE "wakes" DROP CONSTRAINT "wakes_kind_check";--> statement-breakpoint
ALTER TABLE "wakes" DROP CONSTRAINT "wakes_source_check";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "heartbeat_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "heartbeat_interval_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "heartbeat_default_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "heartbeat_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_organization_id_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_organization_id_source_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","source_agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_organization_id_source_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","source_run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_wakes" ADD CONSTRAINT "run_wakes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_wakes" ADD CONSTRAINT "run_wakes_organization_id_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_wakes" ADD CONSTRAINT "run_wakes_organization_id_wake_id_wakes_organization_id_id_fk" FOREIGN KEY ("organization_id","wake_id") REFERENCES "public"."wakes"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_operations" ADD CONSTRAINT "tool_operations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_operations" ADD CONSTRAINT "tool_operations_organization_id_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_operations" ADD CONSTRAINT "tool_operations_organization_id_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_scope_idx" ON "memories" USING btree ("organization_id","agent_id","seq");--> statement-breakpoint
CREATE INDEX "run_wakes_wake_idx" ON "run_wakes" USING btree ("wake_id");--> statement-breakpoint
CREATE INDEX "agents_heartbeat_due_idx" ON "agents" USING btree ("heartbeat_next_at") WHERE "agents"."heartbeat_enabled";--> statement-breakpoint
CREATE UNIQUE INDEX "wakes_one_pending_heartbeat_per_agent" ON "wakes" USING btree ("agent_id") WHERE "wakes"."kind" = 'heartbeat' and "wakes"."run_id" is null;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_heartbeat_check" CHECK ("agents"."heartbeat_enabled" = ("agents"."heartbeat_next_at" is not null)
        and "agents"."heartbeat_interval_minutes" between 1 and 10080
        and "agents"."heartbeat_default_minutes" between 1 and 10080);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_status_check" CHECK ("runs"."status" in ('running', 'completed', 'failed', 'cancelled', 'server_restart'));--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_kind_check" CHECK ("wakes"."kind" in ('owner_message', 'approval_decision', 'task_assigned', 'task_completed', 'task_comment', 'agent_to_agent_message', 'research_map_edit', 'result_changes_requested', 'heartbeat'));--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_source_check" CHECK (("wakes"."kind" = 'heartbeat'
          and num_nonnulls("wakes"."message_id", "wakes"."approval_id", "wakes"."task_id", "wakes"."comment_id", "wakes"."agent_to_agent_message_id", "wakes"."map_edit_id", "wakes"."result_submission_id") = 0)
        or num_nonnulls("wakes"."message_id", "wakes"."approval_id", "wakes"."task_id", "wakes"."comment_id", "wakes"."agent_to_agent_message_id", "wakes"."map_edit_id", "wakes"."result_submission_id") = 1
        and (("kind" = 'owner_message' and "message_id" is not null) or ("kind" = 'approval_decision' and "approval_id" is not null) or ("kind" = 'task_assigned' and "task_id" is not null) or ("kind" = 'task_completed' and "task_id" is not null) or ("kind" = 'task_comment' and "comment_id" is not null) or ("kind" = 'agent_to_agent_message' and "agent_to_agent_message_id" is not null) or ("kind" = 'research_map_edit' and "map_edit_id" is not null) or ("kind" = 'result_changes_requested' and "result_submission_id" is not null)));--> statement-breakpoint
-- 지금까지 실행 시도가 받은 깨우기 기록을 옮긴다. 이 migration 전에는 깨우기 하나가 실행 시도 하나에만 묶였다.
INSERT INTO "run_wakes" ("organization_id", "run_id", "wake_id")
  SELECT "organization_id", "run_id", "id" FROM "wakes" WHERE "run_id" IS NOT NULL;
