-- 사용자가 고른 에이전트 얼굴. 없으면 화면은 ID에서 정한 기본 얼굴을 보이므로 기존 에이전트를 채우지 않는다.
ALTER TABLE "agents" ADD COLUMN "appearance" jsonb;