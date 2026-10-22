ALTER TABLE "approvals" DROP CONSTRAINT "approvals_kind_check";--> statement-breakpoint
DROP INDEX "approvals_one_pending_per_organization";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "add_worker_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_one_pending_initial_per_organization" ON "approvals" USING btree ("organization_id") WHERE "approvals"."status" = 'pending' and "approvals"."kind" = 'initial_research';--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_kind_check" CHECK ("approvals"."kind" in ('initial_research', 'add_worker'));