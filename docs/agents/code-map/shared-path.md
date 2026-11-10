# 공통 경로

저장은 transaction, 알림은 commit 뒤입니다. 계약·schema·웹 응답을 함께 바꾸면 각 경계를 확인합니다.

```text
사용자 HTTP → app.ts parseInput(422) → db 저장 함수(Stored: 값 + commit 뒤 할 일, 또는 거부 이유)
  → server/after-commit.ts completeStored → app.ts respond(거부는 problems.ts ownerRefusalResponses)
commit 뒤 할 일(applyAfterCommit) → Event·settings_changed 알리기 → 취소 → 재개한 조직의 깨우기 → 에이전트 촉진 → 프로바이더 자리 촉진
```

조직 도구 쪽(tools.ts `respondWrite`)과 heartbeat 확인도 `completeStored`를 씁니다([단위](../../../apps/server/src/after-commit.test.ts)). 이 함수와 dispatcher 밖의 직접 `hub.publish`·`dispatcher.kick` 호출은 [eslint.config.js](../../../eslint.config.js)가 막습니다. 각 절 파일의 연결 경로에 나오는 `EventHub → kick`은 이 단계입니다.
