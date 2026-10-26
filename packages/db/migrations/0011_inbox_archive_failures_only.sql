-- 보관은 실패한 실행 시도에만 있다. 앞서 보관한 결정 대기 항목은 보관을 풀어 다시 주의 필요로 돌린다.
UPDATE "inbox_states" SET "archived" = false WHERE "archived" AND "kind" <> 'run_failure';--> statement-breakpoint
ALTER TABLE "inbox_states" ADD CONSTRAINT "inbox_states_archive_check" CHECK ("inbox_states"."archived" = false or "inbox_states"."kind" = 'run_failure');
