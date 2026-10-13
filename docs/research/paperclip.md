# PaperclipAI 1차 조사: 연구 자동화 조직에 가져올 설계

확인일: 2026-10-12. 공식 공개 저장소의 `master`를 읽었으며 분석 기준을 commit [`1b4c803816e82b0265c8422e1a804327a7ed8c54`](https://github.com/paperclipai/paperclip/commit/1b4c803816e82b0265c8422e1a804327a7ed8c54)에 고정했다. 이 commit의 작성 시각은 2026-10-11 22:48:29 -07:00이다. 아래 소스 링크도 이 commit에 고정한다. 배포된 npm 안정 버전과 동일하다고 확인한 것은 아니다.

조사 방식: 공식 사이트/저장소 확인, `/tmp/babojubot-paperclip-research`에 공개 소스 clone 후 문서·스키마·주요 실행 경로 정적 열람. 설치, 서비스 실행, 실제 agent 호출, smoke test는 수행하지 않았다. 따라서 구현이 존재한다는 판단과 실제 환경에서 정상 동작한다는 판단을 구분한다. 모든 파일에 대한 전수 감사가 아닌, 첫 요구사항 인터뷰를 위한 조사다.

## 사용자 목표와 현재 범위

사용자는 AI agent들로 이루어진 조직이 협력하여 research를 자동화하는 orchestration bot을 만들고 싶다. PaperclipAI, Hermes Agent 등의 필요한 기능을 선별하고, xAI Grok Bot, Meta Muse, OpenAI dots 등 상용 서비스와 유명 개인 프로젝트의 공개 구현 및 관찰 가능한 동작을 비교 조사한 뒤 기능을 단계적으로 구현하려 한다. 현재 Paperclip 1차 조사와 기본 운영 요구사항 인터뷰를 정리하고 비교 대상 목록을 조사하고 있다.

사용자는 **연구 전반에 폭넓게 사용할 수 있는 범용 조직 운영 도구**를 원한다. TeamFight Manager 2 밴픽의 강화학습 모델과 NTIRE Image/Video compression 모델은 활용 예시이며, 제품 범위를 ML 연구로 제한하거나 첫 시범 과제를 정하라는 뜻이 아니다. 사용자는 요청과 예산을 주고 조직이 계획부터 완료까지 자율 수행하기를 원하며, Research Lead가 중간 보고와 필요한 질문을 맡는다. 사용자는 feedback과 새 task를 수시로 전달할 수 있어야 한다. Lead는 현재 연구와의 관계·우선순위를 판단해 반영하고, 큰 목표 변경이나 추가 예산이 필요하면 질문한다. 보고서는 Top-Down/MECE 형식이며 모델 개발 예시에서는 모델 결과도 산출물이다. 다음 행동 제안은 선택 사항이다. 특정 연구의 자원·환경·지표는 현재 개발의 선행 결정 사항으로 요구하지 않는다. 이전의 ‘ML 연구 조직으로 범위 확정’ 해석은 사용자 정정에 따라 철회했다.

3차~6차 인터뷰에서 기본 운영 방식도 구체화되었다. 상위 연구 목표 하나마다 Paperclip의 organization에 대응하는 독립 연구 조직을 만들며 전용 Research Lead와 작업자 팀을 둔다. 초기 연구 계획과 최초 팀 구성을 함께 사용자에게 승인받은 뒤 연구를 시작하며, 진행 중 신규 작업자 추가도 사용자 승인을 받는다. 연구 특성에 따른 다른 운영 방식과 자율성도 지원해야 한다. Lead가 분담·조정하되 같은 조직의 작업자 간 직접 질문·결과 공유를 허용한다. 사용자 접점은 웹 대시보드와 메신저 봇이 후보이며, 사용자는 아직 구체적인 메신저를 정하지 않았다. 첫 버전에 두 접점을 동시에 구현하는 것을 필수로 고정하지 않는다. 기억은 조직별로 분리하고 사용자가 지정한 내용만 다른 조직에 공유한다. 주요 진행·문제·결정 또는 사용자 요청에 따라 보고한다. 목표 설정 때 사용자와 Lead가 완료 기준을 정하고, 기준 충족 후 결과를 제출하되 사용자가 검토해 최종 완료를 결정한다. 구체적인 공유 방식과 검토·수정의 세부 절차는 미정이다.

## 핵심 판단

Paperclip은 agent의 추론이나 검색 알고리즘을 정의하기보다 **여러 agent의 업무, 실행, 권한, 비용, 결과물을 관리하는 control plane**이다. 현재 공개 코드는 Node.js/TypeScript 서버, React UI, PostgreSQL 기반 데이터 모델, 런타임별 adapter로 구성된다. 초기의 회사/CEO 비유만 보고 복제 범위를 정하면 현재의 상당한 복잡성을 놓치게 된다. 연구 자동화용으로는 조직도 자체보다 **영속적인 task와 산출물, 중복 실행 방지, 이벤트 기반 위임, 검토와 재작업, 비용 및 재시도 제한**이 우선 참고 대상이다. [공식 README](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/README.md), [서버 패키지](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/package.json), [DB 스키마](https://github.com/paperclipai/paperclip/tree/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/db/src/schema)

이는 연구 특화 제품을 만들기 위한 해석이다. Paperclip이 연구에 사용 불가능하다는 뜻은 아니다. 공식 README도 research를 사용 분야로 포함하지만, 아래에서 확인한 core 모델은 범용 업무 관리 모델이다.

## 확인한 구조와 실제 실행 계약

| 구성 | 확인한 기능 | 연구 자동화에 적용할 의미 |
|---|---|---|
| Company / Agent | 조직 경계, 역할, 보고 관계, 권한, adapter 설정 | 연구 프로젝트와 작업자 경계를 정할 수 있다. CEO라는 역할 이름은 필수가 아니다. |
| Goal / Project / Issue | 목표·프로젝트·부모 task·담당자·우선순위·상태 연결 | 한 연구 질문을 하위 조사로 분해하고 결과를 합치는 영속 작업 구조다. |
| Heartbeat / Wake queue | 일정, 할당, 댓글, 수동 호출 등으로 실행 시작 | 작업이 생길 때 agent를 깨우고 실행 기록을 남긴다. |
| Adapter / Session | 런타임 호출, 로그와 usage 수집, 지원 런타임 세션 재개 | agent별 도구나 모델을 바꾸면서 orchestration 계약을 유지한다. |
| Review / Approval | 상태 전이를 통한 검토자 배정, 반려 후 재작업, 판단 기록 | 수집자와 검증자를 분리하고 검증 없는 완료를 막을 수 있다. |
| Documents / Work products | task 문서, 문서 revision, 첨부와 결과물 메타데이터 | 결과를 agent 대화에만 남기지 않고 후속 작업과 사람이 열람한다. |
| Budget / Recovery | 비용 기록, 범위별 정책, 실행 admission, 제한된 recovery | 비용이나 반복 실패를 관찰하고 작업 확장을 제한한다. |
| Routines | cron, webhook, API trigger, 실행 이력과 중복 정책 | 정기 literature watch나 변경 추적에 활용할 수 있다. |

표의 기능 근거는 다음 절의 고정 소스 링크에 있으며, 연구 적용 열은 설계 제안이다.

### 1. 업무는 issue를 중심으로 협력한다

`issues`에는 `companyId`, `projectId`, `goalId`, `parentId`, 담당 agent/사람, 상태, review/execution policy, 실행 잠금, 실행 workspace가 있다. agent의 대화 기록만으로 조직이 움직이는 구조가 아니다. issue 상태와 run 상태도 별개다. 작업은 계속 `in_progress`인데 한 번의 agent 실행은 끝날 수 있다. [issue 스키마](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/db/src/schema/issues.ts), [heartbeat protocol](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/docs/guides/agent-developer/heartbeat-protocol.md)

문서상 heartbeat 계약은 identity 확인 → 승인 후속 처리 → 할당 목록 확인 → 작업 선택 → checkout → task/댓글/상위 맥락 확인 → 작업 → 상태와 진행 설명 기록 → 필요 시 하위 task 위임 순서다. 하위 task에는 `parentId`, `goalId`를 연결하도록 지시한다. 이 순서의 일부는 agent가 따라야 하는 운영 규칙이며, 전부를 서버가 자동으로 대신 수행하는 것은 아니다. [heartbeat protocol](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/docs/guides/agent-developer/heartbeat-protocol.md)

### 2. Checkout은 프롬프트 규칙 이상의 실제 동시성 제어다

`checkout()`은 예상 상태, 담당자, `checkoutRunId`, `executionRunId` 조건을 가진 DB update로 소유권을 획득한다. 같은 run의 재호출은 수용할 수 있지만 다른 실행과 충돌하면 conflict를 반환한다. unresolved blocker와 subtree pause도 확인하며, 종료된 run의 낡은 잠금을 정리·인수하는 경로가 있다. 문서는 409를 무작정 재시도하지 말라고 지시한다. [issue service의 checkout](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/issues.ts#L11715), [protocol](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/docs/guides/agent-developer/heartbeat-protocol.md)

연구 조직에서도 검색 API 호출이나 실험을 같은 task에 중복 실행하지 않도록 할 실행 소유권이 중요하다. 다만 task의 중복 실행 제어가 외부 side effect의 정확히 한 번 실행까지 보장하지는 않는다. 이후 구현 시 외부 호출 idempotency는 별도로 판단해야 한다.

### 3. Heartbeat는 이벤트로 시작되는 작업 실행이다

Paperclip은 agent adapter를 호출하고 결과·usage·비용·session state를 기록한다. 실행 때 agent/company/run/task identity와 wake reason 등을 전달한다. heartbeat라는 이름이 계속 돌아가는 한 개의 LLM 대화를 뜻하지는 않는다. 최신 소스에는 native runtime, warm session 등도 있어서 모든 실행을 단순한 짧은 child process로만 설명하면 부정확하다. [agent lifecycle 문서](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/docs/guides/agent-developer/how-agents-work.md), [heartbeat service](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/heartbeat.ts), [adapter registry](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/adapters/registry.ts)

DB 기반 wake queue에는 coalescing과 실행 admission이 있다. 자식 issue들이 모두 `done` 또는 `cancelled`이면, 조건에 맞는 부모의 담당자를 `issue_children_completed` 이유로 다시 깨우는 경로도 있다. 즉, 부모 agent가 매번 다른 agent의 실행을 polling하는 대신 작업 완료 이벤트로 결과 통합을 재개할 수 있다. 부모를 깨우는 것과 결과를 자동으로 올바르게 종합하는 것은 별개다. 종합은 agent의 업무다. [wake queue](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/heartbeat/queue.ts), [부모 재개 조건](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/issues.ts#L9299), [완료 후 wake route](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/routes/issues.ts#L15707)

### 4. 세션 재개와 공유 지식은 구분해야 한다

`agent_task_sessions`는 company·agent·adapter·task 조합으로 session params와 최근 run을 보관한다. heartbeat service는 adapter session codec을 통해 state를 복원하고, 설정·identity 호환성을 확인하며, 필요하면 reset이나 compaction을 수행한다. 이는 지원 런타임 대화의 연속성을 위한 장치다. 모든 agent가 하나의 지식 그래프를 공유하거나 근거를 검증한다는 의미는 아니다. [세션 스키마](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/db/src/schema/agent_task_sessions.ts), [heartbeat의 session 처리](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/heartbeat.ts)

roadmap은 Memory / Knowledge를 부분적·실험적 상태로 표시한다. Mem0, Zep, Supermemory, Cognee, Honcho 연결과 선택적 LLM Wiki plugin을 언급하지만 더 넓은 조직 지식 모델은 발전 방향으로 남긴다. [roadmap](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ROADMAP.md)

### 5. 검토와 승인 일부는 runtime이 강제한다

issue의 execution policy에 agent 또는 사람의 review/approval stage를 설정하면, executor의 `done` 전이를 실제 완료 대신 `in_review` 및 검토자 배정으로 바꾸는 모델이 있다. 수정 요청 후 원 executor로 되돌리고 같은 stage에서 재검토하며 판단 댓글과 decision을 기록한다. 소스에는 기본 검토 반복 제한 3회와 사람에게 escalation하는 규칙도 있다. [execution policy 문서](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/docs/guides/execution-policy.md), [policy service](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/issue-execution-policy.ts), [decision 스키마](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/db/src/schema/issue_execution_decisions.ts)

연구용으로는 reviewer 역할에 근거 확인·반례 탐색·citation 확인 등을 부여할 수 있다. 다만 검토 단계가 존재하는 것만으로 연구 결과의 진실성이나 독립성을 보장하지 않는다. 품질 기준과 검증 입력을 따로 설계해야 한다.

### 6. 비용 제한은 기록·가격·실행 중 작업의 영향을 받는다

최신 코드에는 company/agent/project별 budget policy와 warning/hard stop, 미가격 usage 및 회계 상태 처리, 실행 전 budget reservation이 있다. reservation은 DB accounting transaction에서 기존 지출과 미완료 실행의 예약액을 고려해 실행 진입을 제한한다. 소스도 추정액이 provider의 실제 청구액을 상한으로 제한할 수 없다고 명시한다. 따라서 비용 hard stop을 정확한 절대 지출 상한으로 이해하면 안 된다. [budget service](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/budgets.ts), [reservation](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/budget-reservations.ts), [README의 비용 제한 설명](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/README.md)

research 봇에는 금액 외에 요청별 실행 시간, 검색 횟수, 하위 task 수, 검토 반복, 재시도 횟수도 종료 조건 후보가 된다. 이들은 인터뷰 후 정할 요구사항이며 Paperclip에 동일 규칙이 모두 있다는 주장은 아니다.

### 7. 산출물과 정기 실행은 이미 별도 모델이다

issue document는 task와 document를 key로 연결하고, document revision 모델을 둔다. work product에는 task, type, provider, URL, 상태, review state, metadata, 생성 run이 있다. 연구 보고서·검색 결과·실험 결과도 이 구조에 담을 수 있지만, 이 테이블 자체가 논문 bibliographic record나 주장별 인용 검증 모델은 아니다. [issue document 스키마](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/db/src/schema/issue_documents.ts), [document revisions](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/db/src/schema/document_revisions.ts), [work product 스키마](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/db/src/schema/issue_work_products.ts)

routines는 cron/webhook/API trigger와 실행 이력을 갖고, 실행 중 재호출에 coalesce/skip/always enqueue 정책, 누락된 일정에 skip/capped enqueue 정책을 제공한다. agent는 자신에게 할당된 routine만 생성·수정하도록 문서화되어 있다. 정기 연구 모니터링 요구가 확정되면 참고할 만하다. [routines API](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/docs/api/routines.md), [routine service](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/routines.ts)

## Hermes와 Grok 연결의 확인 범위

**Hermes 지원은 홍보 문구만 있는 상태가 아니다.** `@paperclipai/hermes-paperclip-adapter` package가 있고 서버 registry가 `hermes_local`, `hermes_gateway`를 등록한다. local은 Hermes CLI를 실행해 session resume, instruction overlay, usage/cost 파싱을 처리한다. gateway는 이미 실행 중인 Hermes API server에 HTTP로 작업을 만들고 SSE 및 필요 시 polling으로 결과를 수집한다. 둘은 Hermes를 사용하는 호출 방식의 차이이고, Hermes의 memory/tool 내부 설계를 이번에 조사한 것은 아니다. [adapter overview](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/docs/adapters/overview.md), [Hermes package](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapters/hermes/package.json), [local execute](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapters/hermes/src/server/execute.ts), [gateway execute](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapters/hermes/src/gateway/server/execute.ts)

구형 `@paperclipai/adapter-hermes-gateway`는 deprecated compatibility shim으로 남아 있으며 새 unified package를 re-export한다. [adapter overview](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/docs/adapters/overview.md), [compatibility package](https://github.com/paperclipai/paperclip/tree/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapters/hermes-gateway)

`grok_local` adapter도 실제 package와 registry에 있다. 이것은 Paperclip의 Grok CLI 연결 구현이라는 확인이다. 사용자는 후속 답변에서 별도의 상용 제품 **xAI Grok Bot**을 지칭한다고 명확히 했다. Grok CLI adapter가 Grok Bot의 내부 구현이나 직접 연동을 제공한다는 뜻은 아니다. 공식 Grok Bot 설명은 지속적인 클라우드 컴퓨터에서 일하는 AI 동료 제품을 소개한다. [registry](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/adapters/registry.ts), [Grok adapter](https://github.com/paperclipai/paperclip/tree/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapters/grok-local), [공식 Grok Bot 문서](https://docs.x.ai/grok-bot/overview)

## 제품 설명, 문서, 코드의 차이

1. **채용 승인은 조건부다.** 일부 `core-concepts`, `approvals`, `delegation` 문서는 채용에 board 승인이 필요하다고 일반화한다. 실제 agent hire route는 `company.requireBoardApprovalForNewAgents`가 true일 때 approval 및 `pending_approval` 상태를 만들고, DB 기본값은 false다. 초기 버전 설명을 현행 필수 정책으로 가져오지 않는다. [core concepts](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/docs/start/core-concepts.md), [approvals 문서](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/docs/guides/board-operator/approvals.md), [company default](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/db/src/schema/companies.ts#L19), [hire route](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/routes/agents.ts#L4347)

   **BaboJUBot 적용 판단:** 사용자가 확정한 승인 대상은 ‘초기 연구 계획과 최초 팀 구성의 동시 승인’과 ‘연구 진행 중 신규 작업자 추가’이다. 초기 제안을 함께 승인하는 과정과 이후의 개별 추가 승인 과정을 어떻게 표현할지 비교 조사할 필요가 있다. 완료 기준 충족·결과 제출과 사용자 최종 완료 결정도 구분해야 한다. 작업자 간 직접 협의가 승인 요구를 우회하는 권한을 뜻하지는 않는다. 이는 설계 해석이며 Paperclip 기능의 실행 검증 결과가 아니다.
2. **CEO의 계획·분해 능력은 orchestration만으로 보장되지 않는다.** delegation 문서의 CEO 자동 조직화는 agent 행동의 운영 모델이다. 저장소에서 확인한 확실한 기반은 API, 역할/업무 모델, wakeup, 잠금, 검토 정책이다. CEO strategy approval에 관한 오래된 문서 서술을 모든 issue 실행에 강제되는 공통 gate로 확인한 것은 아니며, 실제 보장할 계획 승인 범위는 별도 execution policy와 인터뷰로 정해야 한다. [delegation 문서](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/docs/guides/board-operator/delegation.md), [execution policy](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/docs/guides/execution-policy.md)
3. **예산의 80%/100% 요약은 전체 구현 설명이 아니다.** 비용 문서는 이 임계값을 요약하지만 현행 budget 정책은 scope, warning 설정, 가격 미확정 상태, reservation까지 포함한다. 기본 임계값과 runtime 강제 범위를 구분해야 한다. [비용 문서](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/docs/guides/board-operator/costs-and-budgets.md), [budget service](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/budgets.ts)
4. **로드맵의 상태도 나뉜다.** memory/knowledge, agent chat, pipelines 같은 영역은 실험적이거나 일부 구현이며, 더 높은 자율성·self organization·automatic learning 등의 방향은 확정 기능으로 간주하지 않는다. README와 roadmap도 배포/설정/adapter별 가용성 차이를 인정한다. [README](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/README.md), [roadmap](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ROADMAP.md)

## 연구 자동화에 따로 필요한 것: 현재의 설계 가설

다음은 조사한 issue/session/work-product 모델과 roadmap에 비춰 본 **추론과 요구사항 후보**다. 저장소 전체에 어떤 plugin이나 skill도 존재하지 않는다는 전수 검색 결론은 아니다.

- **연구 계약:** 질문, 범위, 기한, 검색 종료 조건, 제외 조건, 성공 기준. 조직 목표 하나만으로 연구의 완료 여부를 판단하기 어렵다.
- **근거 모델:** 주장 ↔ 원문/URL/DOI ↔ 발췌 위치 ↔ 확인 시점 ↔ 출처 품질. PDF 및 웹 원문의 snapshot과 중복 문헌 식별도 필요할 수 있다.
- **검증 절차:** 인용이 실제 주장을 지지하는지, 상충 결과·반례를 찾았는지, 사실/추론/불확실성을 구분했는지 확인하는 역할과 평가 기준.
- **연구 실행 재현성:** 검색 query, corpus 범위, 코드·환경·data 버전, 실험 조건과 실패 결과 기록. “산출물 URL 있음”보다 엄격한 완료 기준이 필요하다.
- **장시간 외부 작업 연동:** agent 실행과 별도로 오래 진행되는 작업의 ID·상태·결과를 추적하고 완료/실패 이벤트로 후속 작업을 재개하는 공통 계약이 후보이다. ML 연구에서 GPU 작업, 학습 중간 저장본(checkpoint), 실험 기록, 비교 기준 모델(baseline), 평가 및 재현성 도구를 연결하는 것은 이 계약의 한 활용 예시이다. ML 전용 스케줄러나 특정 실험 도구를 공통 엔진의 필수 기능으로 확정하지 않는다. 이번 정적 조사에서 완성된 ML 실험 운영 기능을 확인하지 않았으며, 필요할 때 별도 조사·연동할 대상이다.
- **지식 누적:** 세션 재개와 별도로 같은 조직에서 확인된 지식, 미해결 질문, 폐기된 가설을 후속 작업에 재사용하는 방식. 다른 조직으로 전달할 때는 아래 명시적 공유 요구를 적용한다.
- **조직 경계와 명시적 공유:** 조직별로 기억을 분리하고 사용자가 지정한 내용만 다른 조직에 공유한다는 요구가 확정되었다. Paperclip의 company-scoped 구조는 참고 대상이지만, 사용자 지정 내용의 공유·회수 방식은 별도 설계·검증 대상이다. 작업자 간 직접 협력과 조직 간 정보 공유를 구분해야 한다.
- **중단·개입:** 자료 부족, 모순, 예산 부족, 사람의 결정이 필요한 상황에서 언제 멈추고 무엇을 물을지.

현재 인터뷰는 조직의 지속성, 역할·위임, 작업자 간 협력, 기억, 보고와 사용자 개입 등 공통 운영 요구사항을 중심으로 진행한다. 연구별 자원·데이터·평가 기준은 연구 요청에서 지정하거나 보완하는 설정으로 다루는 것이 설계 후보이다. 특정 연구 예시를 공통 엔진의 절차나 데이터 모델로 곧바로 고정하지 않는다.

## 기능을 선별할 때의 우선순위 후보

| 후보 순위 | 기능 | 판단 이유 |
|---|---|---|
| 우선 검토 | 다수 연구 조직과 정보 격리, 영속 작업 계층, 실행 소유권, 산출물과 출처, 초기 계획·팀 승인, 최종 완료 검토, 로그, 비용·시간·재시도 제한, Lead의 피드백/새 요청 반영 | 독립 조직 운영과 사용자 개입은 확정 요구이며, 나머지는 협력과 검증의 공통 기반 후보이다. |
| 요구에 따라 | session resume, provider별 adapter, 정기 routine, 검색/논문/브라우저 도구, 저장소형 memory, 외부 실험 도구 | 조직 운영 요구사항과 연구별 도구에 따라 효용이 달라진다. |
| 초기에 생략 가능 | 복잡한 CEO/임원 계층, 승인 없는 agent 자동 채용, 조직 marketplace/import-export, 다중 사용자/SSO, 일반 목적 plugin platform | 다수 독립 연구 조직과 기억 분리는 필수 요구이다. 그 밖의 기업 관리·배포 기능은 필요성을 따로 확인한다. |

이는 확정된 첫 구현 범위가 아니다. “Paperclip을 확장할지”, “필요 부분을 참고해 별도 bot을 만들지”, “Hermes 등을 작업자로 붙일지” 역시 공통 운영 요구사항 인터뷰와 기능 검증 후 결정할 사항이다. 비교 조사도 기능별 질문을 먼저 정하고 실제 공개 소스의 구현, 공식 설명, 관찰한 행동, 확인 불가능한 내부를 나눠 기록하는 것이 적합하다.

## 라이선스와 후속 조사

확인 commit의 Paperclip 루트 라이선스는 **MIT**다. 코드나 상당 부분을 가져오는 경우 원 저작권 고지와 라이선스 고지를 포함하는 조건이 명시되어 있다. 이후 실제 재사용할 파일과 의존성·별도 프로젝트는 각 라이선스를 따로 확인한다. 상용 서비스의 비공개 내부 구현은 이번 조사 범위에 없으며 구현 사실로 단정하지 않는다. [LICENSE](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/LICENSE)

다음 조사 질문은 인터뷰 답변으로 좁힌다. 예를 들어 “작업을 어떻게 분해하고 언제 병렬화하나”, “주장별 citation을 어떻게 검증하나”, “worker session과 shared memory를 어떻게 분리하나”, “부모가 실패한 자식 결과를 어떻게 처리하나”처럼 각 질문마다 Paperclip/Hermes/상용 서비스/개인 프로젝트를 비교한다. 이번 노트는 이 후속 조사 및 기능 구현을 시작하기 위한 첫 기준점이다.
