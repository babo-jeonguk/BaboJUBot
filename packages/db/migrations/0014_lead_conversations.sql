CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "conversations_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"read_message_seq" bigint,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "conversations_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_one_default_per_organization" ON "conversations" USING btree ("organization_id") WHERE "conversations"."is_default";--> statement-breakpoint
-- 조직마다 기본 대화를 만들고 기존 Lead 대화 메시지를 모두 그 대화로 옮긴다. 기존 메시지는 이미 본 것으로 둔다.
INSERT INTO "conversations" ("id", "organization_id", "title", "is_default", "read_message_seq", "created_at")
SELECT gen_random_uuid(), "o"."id", '기본 대화', true,
  (SELECT max("m"."seq") FROM "messages" "m" WHERE "m"."organization_id" = "o"."id"),
  "o"."created_at"
FROM "organizations" "o";--> statement-breakpoint
UPDATE "messages" SET "conversation_id" = "c"."id"
FROM "conversations" "c"
WHERE "c"."organization_id" = "messages"."organization_id" AND "c"."is_default";--> statement-breakpoint
-- 메시지 Event와 같은 호출 키로 저장한 답장 결과도 계약대로 대화를 가리키게 한다.
UPDATE "events" SET "payload" = "events"."payload" || jsonb_build_object('conversationId', "c"."id")
FROM "conversations" "c"
WHERE "events"."type" = 'message.created' AND "c"."organization_id" = "events"."organization_id" AND "c"."is_default";--> statement-breakpoint
UPDATE "tool_operations" SET "result" = "tool_operations"."result" || jsonb_build_object('conversationId', "c"."id")
FROM "conversations" "c"
WHERE "tool_operations"."tool" = 'send_message' AND "c"."organization_id" = "tool_operations"."organization_id" AND "c"."is_default";--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "conversation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_conversation_id_conversations_organization_id_id_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_conversation_id_idx" ON "messages" USING btree ("conversation_id","seq");
