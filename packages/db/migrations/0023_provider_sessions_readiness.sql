CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_id" uuid,
	"provider" text NOT NULL,
	"instructions_bundle_version" text,
	"state" jsonb NOT NULL,
	"run_id" uuid NOT NULL,
	CONSTRAINT "agent_sessions_agent_task_unique" UNIQUE NULLS NOT DISTINCT("agent_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "provider_readiness" (
	"provider" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "provider_readiness_status_check" CHECK ("provider_readiness"."status" in ('ready', 'not_ready', 'unknown')),
	CONSTRAINT "provider_readiness_reason_check" CHECK ("provider_readiness"."reason" in ('program_missing', 'version_unsupported', 'product_login_missing', 'credentials_invalid', 'credentials_unverified', 'not_checked', 'check_failed', 'check_timeout')
        and ("provider_readiness"."status" = 'ready') = ("provider_readiness"."reason" is null))
);
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_delivery_check";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "session_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "session_task_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "session_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_organization_id_agent_id_agents_organization_id_id_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_organization_id_task_id_tasks_organization_id_id_fk" FOREIGN KEY ("organization_id","task_id") REFERENCES "public"."tasks"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_organization_id_run_id_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_delivery_check" CHECK ("messages"."delivery" in ('next_run', 'interrupt', 'steer'));--> statement-breakpoint
-- 이 표 전에는 에이전트의 마지막 실행 시도가 남긴 세션을 다음 실행 시도가 이어 갔다. 그 세션을 에이전트 세션으로 옮긴다.
-- 마지막 실행 시도가 아직 실행 중으로 남았으면 서버 시작의 복구가 그 실행 시도 전 세션을 저장한다.
INSERT INTO "agent_sessions" ("organization_id", "agent_id", "task_id", "provider", "instructions_bundle_version", "state", "run_id")
SELECT "organization_id", "agent_id", NULL, "provider", "instructions_bundle_version", "session_after", "id"
FROM (
	SELECT DISTINCT ON ("agent_id") * FROM "runs" ORDER BY "agent_id", "seq" DESC
) AS "latest"
WHERE "session_after" IS NOT NULL;
