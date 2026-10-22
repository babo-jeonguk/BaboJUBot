ALTER TABLE "messages" DROP CONSTRAINT "messages_delivery_check";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "paused_from" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_delivery_check" CHECK ("messages"."delivery" in ('next_run', 'interrupt'));--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_paused_from_check" CHECK (("organizations"."stage" = 'paused') = ("organizations"."paused_from" is not null)
        and "organizations"."paused_from" not in ('paused', 'completed', 'stopped'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_cancel_reason_check" CHECK ("runs"."cancel_reason" in ('organization_paused', 'organization_stopped', 'agent_paused', 'owner_interrupt')
        and ("runs"."cancel_reason" is null or "runs"."status" in ('running', 'cancelled')));