# 프로바이더 연결·모델·동시 실행 상한

통합 검증: [프로바이더 API](../../../apps/server/test/providers.test.ts)(가짜 연결 둘), [프로바이더 E2E](../../../apps/web/e2e/providers.spec.ts)(전역 설정·새 연구 조직 창·에이전트 설정, 다른 탭·390px).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 연결 ID·모델·선택(`ProviderChoice`)·전역 설정 응답·상한(0 무제한, 기본 2), 에이전트·실행 시도 요약의 `provider`·`model`, 요청의 `model`, Event `agent.provider_changed`, stream frame `settings_changed` | [contracts/provider.ts](../../../packages/contracts/src/provider.ts), run.ts `ProviderConnection`·`runRequestSchema`·`runSummarySchema`·`agentDetailSchema`, organization.ts `agentSchema`·`createOrganizationInputSchema.lead`, event.ts | 프로바이더 API |
| 상한 판정·에이전트 변경 계획(끝난 조직 거부·같은 값 무변경), 실행 시도에 연결·모델 고정·연결이 바뀌면 새 세션, 생성 때 기본값 복사 | [core/provider.ts](../../../packages/core/src/provider.ts) `admitsProviderRun`·`planAgentProviderChange`, run.ts `planRunStart`, organization.ts `planOrganizationCreation`, worker.ts `planWorker`·`planAddWorker`, approval.ts `planApprovalDecision`(`workerDefault`) | [core](../../../packages/core/src/provider.test.ts), [run](../../../packages/core/src/run.test.ts) |
| 기본값·상한 저장, 에이전트 변경(조직 → 에이전트 잠금), admission의 연결 자리(상한 행 `FOR UPDATE` 뒤 진행 중 수), 작업자 생성 때 작업자 기본값 읽기, 연결을 기다리는 에이전트 목록 | [db/providers.ts](../../../packages/db/src/providers.ts) `readProviderDefaults`·`updateProviderDefaults`·`updateProviderLimit`·`lockProviderSlot`·`updateAgentProvider`, runs.ts `claimNextRun`·`listAgentsWithPendingWakes({ provider })`, approvals.ts·workers.ts; schema `provider_defaults`·`provider_limits`·`agents.provider/model`·`runs.provider/model`·migration 0021(가짜 프로바이더 backfill·기본값 행) | [DB](../../../packages/db/src/runs.test.ts) `provider connection admission`(조직을 가로지른 동시 claim·상한 감소·무제한·세션), [migration](../../../packages/db/src/organizations.test.ts) |
| 가짜 연결(`fake`, `fake-2`…)과 고정 모델 목록, 모델 목록 조회(실패·시간 초과·빈 목록이면 고정 목록) | [runtime/providers.ts](../../../packages/runtime/src/providers.ts) `createFakeProvider`·`createFakeProviders`·`listProviderModels` | [runtime](../../../packages/runtime/src/providers.test.ts) |
| 등록부(연결 ID 겹침·없음은 시작 오류), 선택 확인(`unknown_provider`·`unknown_model` 422), 설정 API `GET /api/providers`·`PUT /api/providers/defaults`·`PUT /api/providers/:providerId/limit`, `PUT …/agents/:agentId/provider`, 조직 생성의 `lead` | [server/providers.ts](../../../apps/server/src/providers.ts) `createProviderRegistry`, app.ts `startServer({ providers })`(`runtime`은 기본 가짜 연결의 adapter만 바꿈), main.ts `BABOJUBOT_FAKE_PROVIDERS`, problems.ts | 프로바이더 API |
| 연결의 adapter로 실행, 없는 연결은 실패로 끝냄, 종료 저장 뒤·상한 변경 뒤 기다리는 에이전트 촉진, 설정 변경 신호 | server/dispatcher.ts `#execute`·`#settle`·`kickProvider`, after-commit.ts(`settingsChanged`·`providersFreed`), event-hub.ts `publishSettingsChanged`, app.ts `attach` | 프로바이더 API, [after-commit 단위](../../../apps/server/src/after-commit.test.ts) |
| 전역 설정의 기본값 Select 쌍·`저장`(바뀐 값만, 실패해도 초안)·연결별 stepper(−·숫자 칸·＋, 0은 `무제한`), 새 연구 조직 창의 Lead 칸(Lead 기본값으로 채움, `닫기`·초안 유지, 768px 미만 아래 시트), 에이전트 상세 `프로바이더`, 실행 시도 행·상세의 `프로바이더 · 모델`, 활동의 변경 문장, `settings_changed` 재조회 | [global-settings.tsx](../../../apps/web/src/global-settings.tsx), [provider-choice.tsx](../../../apps/web/src/provider-choice.tsx) `ProviderChoiceFields`·`useChoiceLabel`, create-organization.tsx, agents.tsx `ProviderSettings`·`RunRow`·`RunDetailPage`, activity.tsx, api.ts `useProviderSettings`·`useUpdateProviderDefaults`·`useUpdateProviderLimit`·`useUpdateAgentProvider`, live-events.ts | 프로바이더 E2E |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
전역 설정 → PUT /api/providers/defaults·/:providerId/limit(app, 등록부 확인) → db updateProviderDefaults·updateProviderLimit
  → settings_changed 신호(조직 Event 없음) → 다른 탭 providers 재조회; 상한 변경은 dispatcher.kickProvider
에이전트 상세 → PUT …/agents/:agentId/provider → db updateAgentProvider(조직 → 에이전트 잠금, core planAgentProviderChange)
  → agent.provider_changed → 그 에이전트 kick
claimNextRun(조직 → 에이전트 → lockProviderSlot, core admitsProviderRun·planRunStart가 연결·모델 고정)
  → dispatcher가 run.provider의 adapter 실행(요청 model) → 종료 저장 → kickProvider(같은 연결을 기다리는 에이전트)
```

상한을 넘었는데 시작한 실행 시도는 `lockProviderSlot`, 기다리는 깨우기가 시작하지 않으면 `kickProvider`·`listAgentsWithPendingWakes`, 다른 탭이 갱신되지 않으면 `settings_changed` 처리에서 시작합니다.
