ALTER TABLE "wakes" DROP CONSTRAINT "wakes_kind_check";--> statement-breakpoint
ALTER TABLE "wakes" DROP CONSTRAINT "wakes_source_check";--> statement-breakpoint
ALTER TABLE "tool_operations" DROP CONSTRAINT "tool_operations_agent_id_key_pk";--> statement-breakpoint
ALTER TABLE "tool_operations" ALTER COLUMN "key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_operations" ALTER COLUMN "result" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "recovery_state" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "recovery_reason" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "recovery_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tool_operations" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_operations" ADD COLUMN "request" text;--> statement-breakpoint
ALTER TABLE "tool_operations" ADD COLUMN "source" jsonb;--> statement-breakpoint
ALTER TABLE "tool_operations" ADD COLUMN "status" text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_operations" ADD COLUMN "refusal" text;--> statement-breakpoint
ALTER TABLE "tool_operations" ADD COLUMN "settle_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_operations" ADD COLUMN "settled_run_id" uuid;--> statement-breakpoint
ALTER TABLE "wakes" ADD COLUMN "interrupted_run_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_operations" ADD CONSTRAINT "tool_operations_organization_id_settled_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","settled_run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_organization_id_interrupted_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","interrupted_run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_operations_run_idx" ON "tool_operations" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wakes_one_intent_recovery_per_run" ON "wakes" USING btree ("interrupted_run_id") WHERE "wakes"."kind" = 'intent_recovery';--> statement-breakpoint
ALTER TABLE "tool_operations" ADD CONSTRAINT "tool_operations_agent_id_key_unique" UNIQUE("agent_id","key");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_recovery_check" CHECK (("agents"."recovery_state" is null and "agents"."recovery_reason" is null and "agents"."recovery_since" is null)
        or ("agents"."recovery_state" in ('blocked', 'retrying') and "agents"."recovery_reason" in ('missing_source', 'inconsistent_record', 'retry_exhausted') and "agents"."recovery_since" is not null));--> statement-breakpoint
ALTER TABLE "tool_operations" ADD CONSTRAINT "tool_operations_status_check" CHECK (("tool_operations"."status" = 'accepted' and "tool_operations"."result" is null and "tool_operations"."refusal" is null and "tool_operations"."request" is not null)
        or ("tool_operations"."status" = 'completed' and "tool_operations"."result" is not null and "tool_operations"."refusal" is null and "tool_operations"."source" is null)
        or ("tool_operations"."status" = 'refused' and "tool_operations"."result" is null and "tool_operations"."refusal" is not null and "tool_operations"."source" is null)
        or ("tool_operations"."status" = 'abandoned' and "tool_operations"."result" is null and "tool_operations"."refusal" is null and "tool_operations"."source" is null));--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_kind_check" CHECK ("wakes"."kind" in ('owner_message', 'approval_decision', 'task_assigned', 'task_completed', 'task_comment', 'agent_to_agent_message', 'research_map_edit', 'instruction_edit', 'result_changes_requested', 'intent_recovery', 'organization_created', 'heartbeat'));--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_source_check" CHECK (("wakes"."kind" in ('organization_created', 'heartbeat')
          and num_nonnulls("wakes"."message_id", "wakes"."approval_id", "wakes"."task_id", "wakes"."comment_id", "wakes"."agent_to_agent_message_id", "wakes"."map_edit_id", "wakes"."instruction_revision_id", "wakes"."result_submission_id", "wakes"."interrupted_run_id") = 0)
        or num_nonnulls("wakes"."message_id", "wakes"."approval_id", "wakes"."task_id", "wakes"."comment_id", "wakes"."agent_to_agent_message_id", "wakes"."map_edit_id", "wakes"."instruction_revision_id", "wakes"."result_submission_id", "wakes"."interrupted_run_id") = 1
        and (("kind" = 'owner_message' and "message_id" is not null) or ("kind" = 'approval_decision' and "approval_id" is not null) or ("kind" = 'task_assigned' and "task_id" is not null) or ("kind" = 'task_completed' and "task_id" is not null) or ("kind" = 'task_comment' and "comment_id" is not null) or ("kind" = 'agent_to_agent_message' and "agent_to_agent_message_id" is not null) or ("kind" = 'research_map_edit' and "map_edit_id" is not null) or ("kind" = 'instruction_edit' and "instruction_revision_id" is not null) or ("kind" = 'result_changes_requested' and "result_submission_id" is not null) or ("kind" = 'intent_recovery' and "interrupted_run_id" is not null)));