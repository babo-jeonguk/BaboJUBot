-- 결정한 승인 요청·결과 제출도 보관할 수 있다. 보관할 수 있는가는 원본의 결정 상태에 달려 있어 열 제약 대신 서버가 지킨다.
ALTER TABLE "inbox_states" DROP CONSTRAINT "inbox_states_archive_check";