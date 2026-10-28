ALTER TABLE "messages" ADD COLUMN "delivered_seq" bigint;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_delivered_check" CHECK ("messages"."delivered_seq" is null or "messages"."author" = 'owner');--> statement-breakpoint
-- 이미 받은 사용자 메시지의 위치: 그 Lead의 실행 시도가 이 실행 시도까지 받은 사용자 메시지(자기 포함)와
-- 이 실행 시도가 시작할 때까지 그 Lead가 쓴 메시지 중 가장 뒤의 `seq`. 같은 실행 시도가 받은 메시지는 같은 위치가 되고,
-- 그 안의 순서는 조회의 동순위 규칙(Lead 메시지, 중단하고 보내기, 보낸 순서)이 정한다.
UPDATE "messages" AS m SET "delivered_seq" = b."position"
FROM (
  SELECT o."id", greatest(
    (SELECT max(p."seq") FROM "messages" p
      JOIN "wakes" pw ON pw."message_id" = p."id"
      JOIN "runs" pr ON pr."id" = pw."run_id"
      WHERE p."agent_id" = o."agent_id" AND p."author" = 'owner' AND pr."seq" <= r."seq"),
    (SELECT max(a."seq") FROM "messages" a
      WHERE a."agent_id" = o."agent_id" AND a."author" = 'agent' AND a."created_at" <= r."started_at")
  ) AS "position"
  FROM "messages" o
  JOIN "wakes" w ON w."message_id" = o."id"
  JOIN "runs" r ON r."id" = w."run_id"
  WHERE o."author" = 'owner'
) AS b
WHERE m."id" = b."id";
