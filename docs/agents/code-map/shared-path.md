# 공통 경로

저장은 transaction, 알림은 commit 뒤입니다. 계약·schema·웹 응답을 함께 바꾸면 각 경계를 확인합니다.

```text
사용자 HTTP → app.ts parseInput(422) → db 저장 함수(Stored: 값 + commit 뒤 할 일, 또는 거부 이유)
  → server/after-commit.ts completeStored → app.ts respond(거부는 problems.ts ownerRefusalResponses)
사용자 메시지·승인 결정·결과 검토 → app.ts 경로·channel-replies.ts channelInlet → server/user-actions.ts createUserActions → (승인 결정이면 providers.ts modelsFor) → db 저장
  → completeStored(commit마다) → app.ts respond·channel-replies.ts 응답
commit 뒤 할 일(applyAfterCommit) → Event·settings_changed 알리기 → 취소 → 재개한 조직의 깨우기 → 에이전트 촉진 → 프로바이더 자리 촉진
```

조직 도구 쪽(tools.ts `respondWrite`)과 heartbeat 확인, 실행 시도 종료(dispatcher.ts `#settle`)와 서버 시작 복구(dispatcher.ts `start`)도 `applyAfterCommit`을 씁니다([단위](../../../apps/server/src/after-commit.test.ts) `applyAfterCommit`·`applyAfterCommit when an effect fails`). 이 함수와 dispatcher 밖의 직접 `hub.publish`·`dispatcher.kick` 호출은 [eslint.config.js](../../../eslint.config.js)가 막습니다. 각 절 파일의 연결 경로에 나오는 `EventHub → kick`은 이 단계입니다.

주기 확인(heartbeat.ts `HeartbeatScheduler`, compaction.ts `CompactionScheduler`, notifications.ts `NotificationRelay`)은 한 번에 한 회차만 돌고 도는 중 온 요청을 재실행 하나로 모으는 일을 rerun-loop.ts `RerunLoop`에, 에이전트별 깨우기 처리(dispatcher.ts `kick`)는 같은 일을 에이전트마다 하고 처리가 끝난 에이전트를 잊는 `RerunLoops`에 맡깁니다([단위](../../../apps/server/src/rerun-loop.test.ts)). 시험이 부르는 `tick`은 `runNow`, `flush`·`handled`·`drain`은 `settled`·`settledAll`, `close`는 `close`로 기다립니다.
