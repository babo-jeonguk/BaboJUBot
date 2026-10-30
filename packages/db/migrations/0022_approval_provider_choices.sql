-- 이 열 전에 승인한 요청에는 결정한 작업자별 프로바이더·모델 기록이 없다. 지금 값으로 채우지 않는다.
ALTER TABLE "approvals" ADD COLUMN "decided_workers" jsonb;--> statement-breakpoint
-- 승인 정책 `GitHub에 올리기`는 모든 조직에서 꺼진 채 시작한다.
ALTER TABLE "organizations" ADD COLUMN "publish_to_github_approval" boolean DEFAULT false NOT NULL;