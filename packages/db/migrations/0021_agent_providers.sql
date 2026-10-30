CREATE TABLE "provider_defaults" (
	"role" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	CONSTRAINT "provider_defaults_role_check" CHECK ("provider_defaults"."role" in ('lead', 'worker'))
);
--> statement-breakpoint
CREATE TABLE "provider_limits" (
	"provider" text PRIMARY KEY NOT NULL,
	"max_concurrent_runs" integer NOT NULL,
	CONSTRAINT "provider_limits_max_concurrent_runs_check" CHECK ("provider_limits"."max_concurrent_runs" >= 0)
);
--> statement-breakpoint
-- 이 열 전에 생긴 에이전트·실행 시도는 가짜 프로바이더다. 채운 뒤 기본값을 없애 새 행은 프로바이더를 직접 정한다.
ALTER TABLE "agents" ADD COLUMN "provider" text NOT NULL DEFAULT 'fake';--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "provider" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "provider" text NOT NULL DEFAULT 'fake';--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "provider" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "model" text;--> statement-breakpoint
CREATE INDEX "runs_running_provider_idx" ON "runs" USING btree ("provider") WHERE "runs"."status" = 'running';--> statement-breakpoint
-- 전역 Lead·작업자 기본값은 가짜 프로바이더·기본 모델로 시작한다.
INSERT INTO "provider_defaults" ("role", "provider", "model") VALUES ('lead', 'fake', NULL), ('worker', 'fake', NULL);
