ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"delivery" text,
	"sent_by_run_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "messages_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "messages_author_check" CHECK ("messages"."author" in ('owner', 'agent')),
	CONSTRAINT "messages_delivery_check" CHECK ("messages"."delivery" in ('next_run')),
	CONSTRAINT "messages_origin_check" CHECK (("messages"."author" = 'owner' and "messages"."delivery" is not null and "messages"."sent_by_run_id" is null)
        or ("messages"."author" = 'agent' and "messages"."delivery" is null and "messages"."sent_by_run_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "runs_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" text NOT NULL,
	"token_digest" text NOT NULL,
	"instructions_bundle_version" text,
	"session_before" jsonb,
	"session_after" jsonb,
	"summary" text,
	"error" text,
	"usage" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runs_token_digest_unique" UNIQUE("token_digest"),
	CONSTRAINT "runs_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "runs_status_check" CHECK ("runs"."status" in ('running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "runs_finished_check" CHECK (("runs"."status" = 'running') = ("runs"."finished_at" is null))
);
--> statement-breakpoint
CREATE TABLE "wakes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "wakes_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"message_id" uuid,
	"run_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wakes_kind_check" CHECK ("wakes"."kind" in ('owner_message')),
	CONSTRAINT "wakes_message_check" CHECK ("wakes"."kind" <> 'owner_message' or "wakes"."message_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_sent_by_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","sent_by_run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_organization_id_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_organization_id_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_organization_id_message_id_messages_organization_id_id_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "public"."messages"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wakes" ADD CONSTRAINT "wakes_organization_id_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("organization_id","agent_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_running_per_agent" ON "runs" USING btree ("agent_id") WHERE "runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "runs_organization_agent_idx" ON "runs" USING btree ("organization_id","agent_id","seq");--> statement-breakpoint
CREATE INDEX "wakes_pending_idx" ON "wakes" USING btree ("agent_id","seq") WHERE "wakes"."run_id" is null;--> statement-breakpoint
CREATE INDEX "wakes_run_idx" ON "wakes" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wakes_message_unique" ON "wakes" USING btree ("message_id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_organization_id_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_organization_id_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_agent_idx" ON "events" USING btree ("organization_id","agent_id","id");--> statement-breakpoint
CREATE INDEX "events_run_idx" ON "events" USING btree ("run_id","id");