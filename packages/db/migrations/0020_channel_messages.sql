CREATE TABLE "channel_messages" (
	"channel" text NOT NULL,
	"app_message_id" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_messages_channel_app_message_id_pk" PRIMARY KEY("channel","app_message_id")
);
--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_organization_id_notification_id_notification_outbox_organization_id_id_fk" FOREIGN KEY ("organization_id","notification_id") REFERENCES "public"."notification_outbox"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- 이미 받은 가짜 채널 기록은 그 기록 ID가 앱 메시지 번호다.
INSERT INTO "channel_messages" ("channel", "app_message_id", "organization_id", "notification_id", "created_at")
SELECT 'fake', "id"::text, "organization_id", "notification_id", "delivered_at" FROM "fake_channel_messages";
