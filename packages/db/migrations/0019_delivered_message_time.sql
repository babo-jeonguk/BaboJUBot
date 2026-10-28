ALTER TABLE "messages" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
-- 이미 받은 사용자 메시지의 받은 시각: 그 메시지를 받은 실행 시도가 시작한 시각, 실행 시도를 찾지 못하면 보낸 시각.
UPDATE "messages" AS m SET "delivered_at" = coalesce(
  (SELECT r."started_at" FROM "wakes" w JOIN "runs" r ON r."id" = w."run_id" WHERE w."message_id" = m."id" LIMIT 1),
  m."created_at"
)
WHERE m."delivered_seq" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_delivered_at_check" CHECK (("messages"."delivered_seq" is null) = ("messages"."delivered_at" is null));
