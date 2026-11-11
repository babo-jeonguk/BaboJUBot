# 프로바이더 연결·모델·동시 실행 상한

통합 검증: [프로바이더 API](../../../apps/server/test/providers.test.ts), [넓힌 계약 API](../../../apps/server/test/provider-contract.test.ts), [프로바이더 E2E](../../../apps/web/e2e/providers.spec.ts), [넓힌 계약 E2E](../../../apps/web/e2e/provider-contract.spec.ts). 실제 연결의 운영 방식은 [실제 프로바이더 연결](../../providers.md)을 따릅니다.

| 작업·증상 | 진입점 | 테스트 |
| --- | --- | --- |
| 연결·모델·선택·전역 설정·상한 계약, Event `agent.provider_changed`, frame `settings_changed` | [contracts/provider.ts](../../../packages/contracts/src/provider.ts), run.ts `ProviderConnection`·`runRequestSchema`, organization.ts `agentSchema`, event.ts | 프로바이더 API |
| 지원하는 일 선언·준비 상태·사용량·끼워 넣기 계약, adapter의 `capabilities`·`steer`·`checkReadiness`·`loginCommand` | contracts/provider.ts, run.ts `RuntimeAdapter`·`runResultSchema` | contracts |
| 사용량 숫자 규칙·이상값 격리(합산·차감·진단), 종료 결과의 사용량 숫자 격리 | [contracts/usage.ts](../../../packages/contracts/src/usage.ts) `usageSchema`·`usageAmount`·`addUsage`·`subtractUsage`·`settleUsage`·`isolateUsageNumbers`; runtime/src/providers/usage.ts `providerUsage`; server/dispatcher.ts `isolateRunUsage` | [contracts](../../../packages/contracts/src/usage.test.ts), providers 폴더의 adapter 테스트, 넓힌 계약 API `usage numbers outside the contract` |
| 상한 판정·에이전트별 변경 계획, 실행 시도의 연결·모델 고정, Lead·작업자의 기본값 | [core/provider.ts](../../../packages/core/src/provider.ts) `admitsProviderRun`·`planAgentProviderChange`·`checkProviderChoices`, run.ts `planRunStart`, organization.ts `planOrganizationCreation`, worker.ts `planAddWorker`, approval.ts `buildInitialResearchProposal`·`planApprovalDecision`, contracts `resolveProposedChoice` | [core](../../../packages/core/src/provider.test.ts), [run](../../../packages/core/src/run.test.ts) |
| 기본값·상한 저장, 에이전트 변경, admission의 연결 자리, 연결을 기다리는 에이전트 | [db/providers.ts](../../../packages/db/src/providers.ts) `updateProviderDefaults`·`updateProviderLimit`·`lockProviderSlot`·`updateAgentProvider`, runs.ts `claimNextRun`·`listAgentsWithPendingWakes`; migration 0021 | [DB](../../../packages/db/src/runs.test.ts) `provider connection admission`, 프로바이더 API `concurrent global settings writes` |
| (에이전트, 작업) 세션 자리·이어 가기·저장, 프로바이더 변경 때 세션 비우기 | core/run.ts `sessionTaskOf`·`planSessionWriteBack`; [db/sessions.ts](../../../packages/db/src/sessions.ts) `readSession`·`writeBackSession`·`resetAgentSessions`; migration 0023 | core run, [DB](../../../packages/db/src/sessions.test.ts) |
| 등록부·선택 확인(`unknown_provider`·`unknown_model`), 설정 API, Lead 도구 `list_providers` | [server/providers.ts](../../../apps/server/src/providers.ts) `createProviderRegistry`, app.ts `/api/providers*`·`…/agents/:agentId/provider`, main.ts `BABOJUBOT_PROVIDERS`·`BABOJUBOT_FAKE_PROVIDERS`, problems.ts | 프로바이더 API |
| 연결의 adapter로 실행, 자리가 빈 연결의 에이전트 촉진 | server/dispatcher.ts `#execute`·`kickProvider`, after-commit.ts `providersFreed`·`settingsChanged`, event-hub.ts `publishSettingsChanged` | 프로바이더 API, [after-commit 단위](../../../apps/server/src/after-commit.test.ts) |
| 준비 확인 시점·시한·저장 | [server/readiness.ts](../../../apps/server/src/readiness.ts) `ReadinessMonitor`, dispatcher.ts `onLoginRequired`, db/providers.ts `saveProviderReadiness` | 넓힌 계약 API, [단위](../../../apps/server/src/readiness.test.ts) |
| 가짜 연결·모델 목록 조회 | [runtime/providers.ts](../../../packages/runtime/src/providers.ts) `createFakeProviders`·`listProviderModels` | [runtime](../../../packages/runtime/src/providers.test.ts) |
| 선언과 동작의 공통 검사, 가짜 프로바이더 설정(`BABOJUBOT_FAKE_PROVIDER_SETTINGS`) | runtime/runtime-contract.ts `describeRuntimeContract`, scripted.ts `createScriptedRuntime`, testing.ts | [공통 검사](../../../packages/runtime/src/scripted.contract.test.ts) |
| 실제 연결 생성·프로토콜·로그인·모델 목록·세션·사용량 | runtime/src/index.ts `createConnection`, `runtime/src/providers/{claude,codex,opencode,antigravity}.ts`, claude-models.ts, claude-transcript.ts `claudeSessionCost`·`claudeSessionFacts`, antigravity-config.ts | providers 폴더의 `claude.test.ts`·`claude-models.test.ts`·`antigravity-config.test.ts`·`antigravity-cleanup.test.ts`, [연결 검사](../../../packages/runtime/src/other-providers.contract.test.ts) |
| OpenCode 실패 이유(요청 거부·인증 거부) | runtime/src/providers/opencode.ts `failedExecution` | providers 폴더의 `opencode.test.ts` `failed executions (#147)`, [실제 CLI + 가짜 모델](../../../apps/server/test/opencode-real-cli.test.ts)(test/local-model.ts, test/fixtures/opencode-local-model.mjs) |
| 같은 제품 폴더의 OpenCode 서버 시작 차례 | runtime/src/providers/opencode.ts `startupTurn` | providers 폴더의 `opencode.test.ts` `one organization folder (#147)`, 실제 CLI + 가짜 모델 |
| 프로세스 실행·종료·재시작 정리 | runtime/src/providers/process.ts `startProcess`, recovery.ts | providers 폴더의 `recovery.test.ts`·`recovery-save.test.ts`·`process-record.test.ts` |
| 제품 로그인·숨긴 토큰 입력 | runtime/src/providers/login.ts `readHiddenLine`, scripts/provider-login.mjs | [로그인](../../../packages/runtime/src/providers/login.test.ts) |
| 조직별 제품 폴더·로그인 공유 | runtime/src/providers/folders.ts `connectionFolders`, login-link.ts `loginLink`, claude.ts `withLogin`, codex.ts `shareLogin`, opencode.ts `copyLogin`, antigravity.ts | [조직 폴더](../../../packages/runtime/src/providers/organization-folders.test.ts), [Codex 로그인 링크](../../../packages/runtime/src/providers/codex-login-link.test.ts) |
| 격리 실행: 스위치·배치·안전 확인·Docker 환경 | db/providers.ts `updateIsolation`; runtime/src/providers/container.ts; server/isolation.ts `IsolationGate`, run-request.ts, app.ts `toolsApp`, main.ts `BABOJUBOT_DOCKER_COMMAND`; docker/runner; web global-settings.tsx `IsolationSwitch`; migration 0030·0031 | [서버](../../../apps/server/test/isolation.test.ts), [관문](../../../apps/server/src/isolation.test.ts), [runtime](../../../packages/runtime/src/providers/container.test.ts), [Docker 전용](../../../packages/runtime/src/providers/container.docker.test.ts) |
| 미리 압축: 예약·세션 정비 claim | server/compaction.ts, db/compaction.ts, `RuntimeAdapter.precompact`; migration 0025~0027 | [서버](../../../apps/server/test/compaction.test.ts), [E2E](../../../apps/web/e2e/compaction.spec.ts) |
| 전역 설정·Lead 칸·에이전트 프로바이더·준비 상태 배지·사용량 표 | [global-settings.tsx](../../../apps/web/src/global-settings.tsx) `Readiness`, [provider-choice.tsx](../../../apps/web/src/provider-choice.tsx) `ProviderChoiceFields`·`ReadinessBadge`, create-organization.tsx, agents.tsx `AgentProviderSettings`·`UsageTable`, api.ts `useProviderSettings`·`useCheckAllReadiness` | 프로바이더 E2E, 넓힌 계약 E2E |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
전역 설정 → PUT /api/providers/defaults·/:providerId/limit(app) → db updateProviderDefaults·updateProviderLimit
  → settings_changed → 다른 탭 재조회; 상한 변경은 dispatcher.kickProvider
에이전트 상세 → PUT …/agents/:agentId/provider → db updateAgentProvider(core planAgentProviderChange) → agent.provider_changed → kick
claimNextRun → lockProviderSlot(core admitsProviderRun·planRunStart) → dispatcher가 run.provider의 adapter 실행
  → finishRun(providersFreed) → applyAfterCommit → kickProvider; 로그인 필요 실패면 ReadinessMonitor.check
ReadinessMonitor.check → (격리 켜짐) IsolationGate → adapter.checkReadiness → saveProviderReadiness
격리 켜짐 → run-request place → adapter의 startProcess({ container })
```

상한을 넘은 실행 시도는 `lockProviderSlot`, 시작하지 않는 깨우기는 `kickProvider`·`listAgentsWithPendingWakes`, 다른 탭 미갱신은 `settings_changed` 처리에서 시작합니다.
