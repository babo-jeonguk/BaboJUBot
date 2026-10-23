CREATE TABLE "fake_channel_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "fake_channel_messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"organization_name" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_states" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inbox_states_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"approval_id" uuid,
	"result_submission_id" uuid,
	"run_id" uuid,
	"read" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_states_kind_check" CHECK ("inbox_states"."kind" in ('approval', 'result_submission', 'run_failure')),
	CONSTRAINT "inbox_states_source_check" CHECK (num_nonnulls("inbox_states"."approval_id", "inbox_states"."result_submission_id", "inbox_states"."run_id") = 1
        and (("inbox_states"."kind" = 'approval' and "inbox_states"."approval_id" is not null)
          or ("inbox_states"."kind" = 'result_submission' and "inbox_states"."result_submission_id" is not null)
          or ("inbox_states"."kind" = 'run_failure' and "inbox_states"."run_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "notification_outbox_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"event_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_outbox_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "notification_outbox_kind_check" CHECK ("notification_outbox"."kind" in ('lead_message', 'approval_request', 'result_submission', 'run_failure')),
	CONSTRAINT "notification_outbox_claim_check" CHECK (("notification_outbox"."claim_token" is null) = ("notification_outbox"."claim_expires_at" is null)
        and ("notification_outbox"."sent_at" is null or "notification_outbox"."claim_token" is null))
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "fake_channel_messages" ADD CONSTRAINT "fake_channel_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fake_channel_messages" ADD CONSTRAINT "fake_channel_messages_organization_id_notification_id_notification_outbox_organization_id_id_fk" FOREIGN KEY ("organization_id","notification_id") REFERENCES "public"."notification_outbox"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_states" ADD CONSTRAINT "inbox_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_states" ADD CONSTRAINT "inbox_states_organization_id_approval_id_approvals_organization_id_id_fk" FOREIGN KEY ("organization_id","approval_id") REFERENCES "public"."approvals"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_states" ADD CONSTRAINT "inbox_states_organization_id_result_submission_id_result_submissions_organization_id_id_fk" FOREIGN KEY ("organization_id","result_submission_id") REFERENCES "public"."result_submissions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_states" ADD CONSTRAINT "inbox_states_organization_id_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_organization_id_event_id_events_organization_id_id_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."events"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fake_channel_messages_notification_unique" ON "fake_channel_messages" USING btree ("notification_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_states_approval_unique" ON "inbox_states" USING btree ("approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_states_result_submission_unique" ON "inbox_states" USING btree ("result_submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_states_run_unique" ON "inbox_states" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_event_unique" ON "notification_outbox" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "notification_outbox_due_idx" ON "notification_outbox" USING btree ("seq") WHERE "notification_outbox"."sent_at" is null;--> statement-breakpoint
-- 이 판 전에 실패한 실행 시도는 Inbox에 읽음으로 남긴다(주의 수를 늘리지 않음). 지난 사건의 알림은 소급해 보내지 않는다.
INSERT INTO "inbox_states" ("organization_id", "kind", "run_id", "read")
SELECT "organization_id", 'run_failure', "id", true FROM "runs" WHERE "status" = 'failed';
