CREATE TABLE "instruction_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"copy_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"editor_author" text NOT NULL,
	"editor_agent_id" uuid,
	"editor_run_id" uuid,
	"content" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "instruction_revisions_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "instruction_revisions_number_check" CHECK ("instruction_revisions"."number" >= 1),
	CONSTRAINT "instruction_revisions_editor_check" CHECK (("instruction_revisions"."editor_author" in ('copy', 'owner') and "instruction_revisions"."editor_agent_id" is null and "instruction_revisions"."editor_run_id" is null)
      or ("instruction_revisions"."editor_author" = 'agent' and "instruction_revisions"."editor_agent_id" is not null and "instruction_revisions"."editor_run_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "wakes" DROP CONSTRAINT "wakes_kind_check";--> statement-breakpoint
ALTER TABLE "wakes" DROP CONSTRAINT "wakes_source_check";--> statement-breakpoint
ALTER TABLE "instruction_copies" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "wakes" ADD COLUMN "instruction_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "instruction_copies" ADD CONSTRAINT "instruction_copies_organization_id_agent_id_id_unique" UNIQUE("organization_id","agent_id","id");--> statement-breakpoint
ALTER TABLE "instruction_revisions" ADD CONSTRAINT "instruction_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_revisions" ADD CONSTRAINT "instruction_revisions_organization_id_agent_id_copy_id_instruction_copies_organization_id_agent_id_id_fk" FOREIGN KEY ("organization_id","agent_id","copy_id") REFERENCES "public"."instruction_copies"("organization_id","agent_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_revisions" ADD CONSTRAINT "instruction_revisions_organization_id_editor_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","editor_agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction_revisions" ADD CONSTRAINT "instruction_revisions_organization_id_editor_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","editor_run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "instruction_revisions_copy_number_unique" ON "instruction_revisions" USING btree ("copy_id","number");--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_organization_id_instruction_revision_id_instruction_revisions_organization_id_id_fk" FOREIGN KEY ("organization_id","instruction_revision_id") REFERENCES "public"."instruction_revisions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wakes_instruction_revision_unique" ON "wakes" USING btree ("instruction_revision_id");--> statement-breakpoint
ALTER TABLE "instruction_copies" ADD CONSTRAINT "instruction_copies_revision_check" CHECK ("instruction_copies"."revision" >= 1);--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_kind_check" CHECK ("wakes"."kind" in ('owner_message', 'approval_decision', 'task_assigned', 'task_completed', 'task_comment', 'agent_to_agent_message', 'research_map_edit', 'instruction_edit', 'result_changes_requested', 'heartbeat'));--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_source_check" CHECK (("wakes"."kind" = 'heartbeat'
          and num_nonnulls("wakes"."message_id", "wakes"."approval_id", "wakes"."task_id", "wakes"."comment_id", "wakes"."agent_to_agent_message_id", "wakes"."map_edit_id", "wakes"."instruction_revision_id", "wakes"."result_submission_id") = 0)
        or num_nonnulls("wakes"."message_id", "wakes"."approval_id", "wakes"."task_id", "wakes"."comment_id", "wakes"."agent_to_agent_message_id", "wakes"."map_edit_id", "wakes"."instruction_revision_id", "wakes"."result_submission_id") = 1
        and (("kind" = 'owner_message' and "message_id" is not null) or ("kind" = 'approval_decision' and "approval_id" is not null) or ("kind" = 'task_assigned' and "task_id" is not null) or ("kind" = 'task_completed' and "task_id" is not null) or ("kind" = 'task_comment' and "comment_id" is not null) or ("kind" = 'agent_to_agent_message' and "agent_to_agent_message_id" is not null) or ("kind" = 'research_map_edit' and "map_edit_id" is not null) or ("kind" = 'instruction_edit' and "instruction_revision_id" is not null) or ("kind" = 'result_changes_requested' and "result_submission_id" is not null)));--> statement-breakpoint
-- 이미 있는 사본의 처음 내용을 revision 1로 남긴다. 편집자는 복사(copy), 시각은 사본을 만든 때다.
INSERT INTO "instruction_revisions" ("organization_id", "agent_id", "copy_id", "number", "editor_author", "content", "created_at")
SELECT "organization_id", "agent_id", "id", 1, 'copy', "content", "created_at" FROM "instruction_copies";
