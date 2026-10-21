CREATE TABLE "result_submission_artifacts" (
	"organization_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "result_submission_artifacts_submission_id_artifact_id_pk" PRIMARY KEY("submission_id","artifact_id"),
	CONSTRAINT "result_submission_artifacts_position_unique" UNIQUE("submission_id","position")
);
--> statement-breakpoint
CREATE TABLE "result_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "result_submissions_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"status" text NOT NULL,
	"submitted_by_agent_id" uuid NOT NULL,
	"submitted_by_run_id" uuid NOT NULL,
	"previous_submission_id" uuid,
	"summary" text NOT NULL,
	"goal" text NOT NULL,
	"completion_criteria" text NOT NULL,
	"decision_note" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "result_submissions_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "result_submissions_status_check" CHECK ("result_submissions"."status" in ('pending', 'changes_requested', 'completed')),
	CONSTRAINT "result_submissions_decided_check" CHECK (("result_submissions"."status" = 'pending') = ("result_submissions"."decided_at" is null))
);
--> statement-breakpoint
ALTER TABLE "wakes" DROP CONSTRAINT "wakes_kind_check";--> statement-breakpoint
ALTER TABLE "wakes" DROP CONSTRAINT "wakes_source_check";--> statement-breakpoint
ALTER TABLE "wakes" ADD COLUMN "result_submission_id" uuid;--> statement-breakpoint
ALTER TABLE "result_submission_artifacts" ADD CONSTRAINT "result_submission_artifacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_submission_artifacts" ADD CONSTRAINT "result_submission_artifacts_organization_id_submission_id_result_submissions_organization_id_id_fk" FOREIGN KEY ("organization_id","submission_id") REFERENCES "public"."result_submissions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_submission_artifacts" ADD CONSTRAINT "result_submission_artifacts_organization_id_artifact_id_artifacts_organization_id_id_fk" FOREIGN KEY ("organization_id","artifact_id") REFERENCES "public"."artifacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_organization_id_submitted_by_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","submitted_by_agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_organization_id_submitted_by_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","submitted_by_run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_organization_id_previous_submission_id_result_submissions_organization_id_id_fk" FOREIGN KEY ("organization_id","previous_submission_id") REFERENCES "public"."result_submissions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "result_submissions_one_pending_per_organization" ON "result_submissions" USING btree ("organization_id") WHERE "result_submissions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "result_submissions_organization_idx" ON "result_submissions" USING btree ("organization_id","seq");--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_organization_id_result_submission_id_result_submissions_organization_id_id_fk" FOREIGN KEY ("organization_id","result_submission_id") REFERENCES "public"."result_submissions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wakes_result_submission_unique" ON "wakes" USING btree ("result_submission_id");--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_kind_check" CHECK ("wakes"."kind" in ('owner_message', 'approval_decision', 'task_assigned', 'task_completed', 'task_comment', 'agent_to_agent_message', 'research_map_edit', 'result_changes_requested'));--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_source_check" CHECK (num_nonnulls("wakes"."message_id", "wakes"."approval_id", "wakes"."task_id", "wakes"."comment_id", "wakes"."agent_to_agent_message_id", "wakes"."map_edit_id", "wakes"."result_submission_id") = 1
        and (("kind" = 'owner_message' and "message_id" is not null) or ("kind" = 'approval_decision' and "approval_id" is not null) or ("kind" = 'task_assigned' and "task_id" is not null) or ("kind" = 'task_completed' and "task_id" is not null) or ("kind" = 'task_comment' and "comment_id" is not null) or ("kind" = 'agent_to_agent_message' and "agent_to_agent_message_id" is not null) or ("kind" = 'research_map_edit' and "map_edit_id" is not null) or ("kind" = 'result_changes_requested' and "result_submission_id" is not null)));