# issue-86 레퍼런스 조사: 조직 도구 목록과 Role·단계 허용 규칙의 자리

조사일: 2026-10-29. 대상: [#86](https://github.com/babo-jeonguk/BaboJUBot/issues/86) 3번(조직 도구 목록). 구현 전 기술 권고이며 확정 계약이나 구현 결과가 아니다. 5번·6번은 이 조사 범위 밖이다. 상세 자료: `.reference-cache/issue-86/`(git 무시).

## Brief

- 구현할 문제: 도구 하나의 사실(이름·설명·입력·출력·읽기/쓰기·열린 Role·단계)이 contracts의 표 4개, 서버 경로별 입력 import, core `toolRules`로 흩어져 있다. 판 2 실행기에 줄 "지금 쓸 수 있는 도구 목록"을 만들려면 한 줄에 모아야 한다.
- 동종 문제: 도구(operation) 목록과, 호출자·상태에 따라 그 목록을 거르고 호출을 거부하는 허용 규칙을 어디에 나눠 두는가.
- 고정된 결정: 승인·조직 경계는 제품 코드가 강제한다(`AGENTS.md`). 의존 방향은 contracts ← core ← db·server, runtime·web은 contracts만 본다([구조 문서](../architecture.md#패키지-구성)). 도구를 실행기에 어떤 방식(MCP 등)으로 노출할지는 판 2에서 정한다(#86 「순서와 범위」). 승인 정책은 조직별·사용자만 바꾼다([ADR-0003](../adr/0003-configurable-approval-policy.md)).

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 도구 목록(contracts)과 Role·단계 허용 규칙(core)을 어떻게 나누는가: (a) 허용 데이터까지 목록에, core는 판정 함수만 / (b) 허용 규칙은 core의 별도 표 / 다른 방식 | #86 해결 방향 3, AC 1·3 | Source Recon + 권한 우회 시나리오 |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [agent-runtime-models](agent-runtime-models.md) Paperclip 호출 수단 절 | "catalog presence does not grant authority" 인용 | `1b4c803` 인용 문장이 `def4726` runner ADR L185-L186에도 같음. 새 SHA로 다시 읽음 |
| [paperclip](paperclip.md) | 배경만 | 다시 인용하지 않음 |

## 레퍼런스

관점별 saturation: OSS control plane(Paperclip) — 가장 가까운 동종, 소스까지 / OSS agent(Hermes·OpenClaw) — "목록은 데이터, 선택은 설정"으로 수렴 / 표준·SDK(MCP·Claude Agent SDK·OpenAI Agents) — 마지막 라운드가 "노출과 허가는 다른 층" 변형만 더함 / 계약 우선 RPC(ts-rest·oRPC) — "계약에 metadata, 강제는 서버 middleware"로 수렴. 전체 후보: `.reference-cache/issue-86/candidates.md`.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| Paperclip runner·server | OSS control plane | `def4726bea0e3b340457100038d80ca55c2b7d4f` | MIT | 소스 | 외부 실행기에 실행 시도별 도구 목록을 투영하는 유일한 동종 |
| Hermes Agent | OSS agent | `4e58c721c8cf9b51c46636ea84ea6a5cb540880a` | MIT | 소스 | 중앙 tool registry와 toolset 선택 |
| OpenClaw | OSS agent | `1b93d1ea5dee6deaf91c28140571ba5eda00dd68` | MIT | 소스 | 순수 데이터 catalog와 층별 정책 pipeline 분리 |
| MCP 명세 2025-11-25 | 표준 | `9850cae8923b0ee3d19a4476f1010b97aa161a55` | MIT | 문서 | 판 2 후보 노출 방식의 도구 모양 |
| Claude Agent SDK permissions | 상용 SDK | 2026-10-29 문서 | — | 문서 | 실행기 쪽 노출·승인 층 |
| OpenAI Agents JS | 라이브러리 | `52fcb5769c74844b198affe377e75fe04b1732a3` | MIT | 소스 | 도구 정의에 붙은 실행별 노출 함수 |
| ts-rest | 계약 우선 RPC | `3d572e3336bd998b0c33a9d65b12292b158d0aec` | MIT | 문서 | 공유 계약의 role metadata |
| oRPC | 계약 우선 RPC | `82a7108d8ced7d7706190f1e164a6f2857eab5f9` | MIT | 문서 | 계약 metadata와 구현 middleware 분리 |

깊이: 목록 / 문서 / 소스 / 실행. 모두 설계 참고이며 코드를 복사하지 않는다.

## 근거

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | Paperclip runner ADR: 패키지가 operation catalog를 정의할 수 있지만 catalog에 있다고 권한이 생기지 않는다. 서버가 실행 시도마다 production binding이 있고 현재 actor가 볼 수 있는 operation만 discovery에 투영하며, 허가 안 된 operation은 discovery에 없다. 조직 범위·승인·예산 같은 불변 조건을 한곳(서버)에 둔다 | [runner ADR L138-L200](https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/doc/architecture/paperclip-runner.md#L138-L200) | 문서 주장 |
| <a id="E02"></a>E02 | Paperclip 도구 한 줄(`CapabilitySemanticToolDescriptor`)에 `operationId`·`description`·`inputSchema`·`outputSchema`와 함께 허용 조건 데이터 `requiredClaims`·`allowedRoles?`·`taskModes`·`sideEffectClass`가 있다. 누가 어떤 claim을 가졌는지·조직 정책(`deniedOperationIds` 등)은 도구 줄이 아니라 호출 맥락(`CapabilityToolAuthorizationContext`)에 있다 | [capability-semantic-tool-types.ts L66-L107](https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/packages/paperclip-runner/src/tools/capability-semantic-tool-types.ts#L66-L107), [create-task.ts L1-L34](https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/packages/paperclip-runner/src/protocol-actions/create-task.ts#L1-L34) | 소스 확인 |
| <a id="E03"></a>E03 | Paperclip `CapabilityToolAuthorizationEngine`은 판정 `#evaluate` 하나를 노출 목록(`computeVisibleTools`, 거른 결과 `exposed/absent` 기록)과 호출 허가(`authorizeInvocation`, `allowed/denied`)가 같이 쓴다. 판정 순서: 정책 거부 → 모드 → Role → claim | [capability-tool-authorization.ts L15-L136](https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/packages/paperclip-runner/src/tools/capability-tool-authorization.ts#L15-L136) | 소스 확인 |
| <a id="E04"></a>E04 | Paperclip live 서버도 같은 catalog의 `allowedModes`로 실행기에 줄 도구 정의를 거르고(`definitions()`), 호출 때 다시 같은 필드로 검사해 `paperclip_runner_tool_mode_denied`로 거부한다 | [paperclip-runner-tool-authority.ts L244-L281, L551-L561](https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/server/src/services/native-runtime/paperclip-runner-tool-authority.ts#L244-L281) | 소스 확인 |
| <a id="E05"></a>E05 | Paperclip 문서 생성기: grant group은 문서·노출 묶음일 뿐 추가 권한이 아니며 descriptor의 `requiredClaims`가 결정한다 | [operation-groups-doc.ts L359](https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/packages/paperclip-runner/src/catalog/operation-groups-doc.ts#L359) | 소스 확인 |
| <a id="E06"></a>E06 | Hermes: 도구 파일마다 `registry.register()`로 schema·handler·toolset 소속·가용성 검사를 한 entry에 선언하고 다른 곳은 병렬 표 없이 registry를 조회한다. 어떤 도구를 줄지는 entry 밖의 `enabled/disabled_toolsets` 설정으로 고른다. `check_fn`은 환경 가용성(Docker 등)이지 권한이 아니다 | [registry.py L1-L6, L214-L231](https://github.com/NousResearch/hermes-agent/blob/4e58c721c8cf9b51c46636ea84ea6a5cb540880a/tools/registry.py#L214-L231), [model_tools.py L316-L338](https://github.com/NousResearch/hermes-agent/blob/4e58c721c8cf9b51c46636ea84ea6a5cb540880a/model_tools.py#L316-L338) | 소스 확인 |
| <a id="E07"></a>E07 | OpenClaw: core tool catalog는 UI에도 번들되는 "pure data + tiny pure functions"이고 도구 줄에 기본 profile 소속(`profiles`)만 있다. agent·sender·provider별 허용은 설정 층을 순서대로 적용하는 pipeline이 목록을 거른다 | [tool-catalog.ts L1-L9, L52-L66](https://github.com/openclaw/openclaw/blob/1b93d1ea5dee6deaf91c28140571ba5eda00dd68/src/agents/tool-catalog.ts#L1-L66), [tool-policy-pipeline.ts L57-L115](https://github.com/openclaw/openclaw/blob/1b93d1ea5dee6deaf91c28140571ba5eda00dd68/src/agents/tool-policy-pipeline.ts#L57-L115) | 소스 확인 |
| <a id="E08"></a>E08 | MCP `Tool`에는 name·description·inputSchema·outputSchema·annotations(`readOnlyHint` 등)·`_meta`가 있고 호출 권한 필드는 없다. annotations는 신뢰된 서버가 아니면 untrusted로 본다. 서버는 접근 제어를 MUST 구현한다. `listChanged`를 선언한 서버는 목록이 바뀌면 `notifications/tools/list_changed`를 보낸다 | [tools.mdx L40-L51, L150-L215, L510-L516](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/9850cae8923b0ee3d19a4476f1010b97aa161a55/docs/specification/2025-11-25/server/tools.mdx#L150-L215), [schema.ts L1180-L1297](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/9850cae8923b0ee3d19a4476f1010b97aa161a55/schema/2025-11-25/schema.ts#L1180-L1297) | 문서 주장 |
| <a id="E09"></a>E09 | Claude Agent SDK: `disallowedTools`는 도구 정의를 요청에서 빼 모델이 보지 못하게 하고, `allowedTools`는 자동 승인일 뿐 목록에 없는 도구도 여전히 존재한다. 매 호출 검사는 hook으로 한다 — 노출과 허가가 다른 층이다 | [Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions) (2026-10-29 확인) | 문서 주장 |
| <a id="E10"></a>E10 | OpenAI Agents JS: 함수 도구 정의에 `isEnabled(runContext, agent)`가 붙고 `getAllTools`가 실행마다 이것으로 모델에 줄 목록을 거른다. 노출 결정이지 호출 거부 지점은 아니다 | [tool.ts L539-L542](https://github.com/openai/openai-agents-js/blob/52fcb5769c74844b198affe377e75fe04b1732a3/packages/agents-core/src/tool.ts#L539-L542), [agent.ts L1193-L1216](https://github.com/openai/openai-agents-js/blob/52fcb5769c74844b198affe377e75fe04b1732a3/packages/agents-core/src/agent.ts#L1193-L1216) | 소스 확인 |
| <a id="E11"></a>E11 | ts-rest: 클라이언트·서버가 함께 쓰는 계약 route에 `metadata: { role }`을 두고 서버 middleware가 읽어 RBAC에 쓴다. metadata는 클라이언트 번들에 들어가므로 민감 정보는 두지 말라고 경고한다. oRPC도 계약에 metadata를 선언하고 middleware·context는 구현 쪽에 둔다 | [ts-rest overview.mdx L859-L894](https://github.com/ts-rest/ts-rest/blob/3d572e3336bd998b0c33a9d65b12292b158d0aec/docs/content/docs/contract/overview.mdx#L859-L894), [oRPC contract-first.mdx L68, L119](https://github.com/middleapi/orpc/blob/82a7108d8ced7d7706190f1e164a6f2857eab5f9/apps/content/docs/contract-first.mdx#L68-L119) | 문서 주장 |
| <a id="E12"></a>E12 | 이 저장소: `AgentRole`·`LifecycleStage`·`OrgToolName`은 이미 contracts에 있고 core가 import한다. contracts에는 웹과 서버가 함께 쓰는 순수 판정 선례(`ownerActions`)가 있다. Role·단계 검사의 유일한 호출 지점은 db `checkOrRefuse` → core `checkToolCall`이고, 승인 정책(ADR-0003)은 core의 작업자 추가 계획 등 별도 경로에 있다 | `packages/contracts/src/organization.ts` L19·L41, `packages/contracts/src/owner-actions.ts` L98, `packages/db/src/tool-calls.ts` L37-L50, `packages/core/src/approval.ts` L39-L92 (`45b6709`) | 소스 확인 |

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 도구 줄에 **정적 허용 조건 데이터**(모드·Role·claim·부작용 종류)를 함께 두고, 판정 함수 하나가 노출 목록과 호출 거부에 같이 쓰인다. 동적 정책·부여(누가 claim을 가졌나, 조직 정책)는 줄 밖 맥락 | E02, E03, E04, E05, E11 | Paperclip은 protocol 패키지에 줄, 서버가 판정. ts-rest는 계약에 role, middleware가 강제 | 한 도구의 사실이 한 줄. 노출과 거부가 어긋날 수 없다 | 공유 계약이라 클라이언트 번들에 노출(E11 경고). 줄의 데이터를 권한 자체로 오해할 위험 → "목록에 있음 ≠ 권한" 명시(E01, E05) |
| <a id="P02"></a>P02 | 도구 줄은 설명·스키마·그룹 소속만, 누가 쓰나는 **별도 설정 층**이 목록을 거른다 | E06, E07 | Hermes는 toolset 설정, OpenClaw는 profile·agent·sender 층 pipeline | 사용자가 바꾸는 정책과 도구 정의를 떼어 바꿀 수 있다 | 둘 다 사용자·운영자 설정 정책이다. 제품이 고정한 규칙에 쓰면 표가 둘로 나뉘어 #86이 없애려는 분산이 남는다 |
| <a id="P03"></a>P03 | **노출과 허가는 다른 층**: 목록에서 빼는 것은 편의이고, 호출마다 서버(또는 hook)가 다시 검사한다. 상태가 바뀌면 목록 갱신을 알린다 | E01, E04, E08, E09, E10 | MCP는 서버 MUST 접근 제어 + list_changed. Claude SDK는 disallowedTools(숨김)와 hook(매 호출) 분리 | 실행기가 목록을 캐시하거나 무시해도 경계가 깨지지 않는다 | 노출 목록만으로 막았다고 믿으면 우회된다 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 (a) | 도구 줄(contracts)에 열린 Role·단계를 **정적 데이터**로 함께 둔다. core는 그 데이터를 읽는 판정 함수 하나(`checkToolCall`)와, 같은 함수로 거른 "Role·단계별 지금 쓸 수 있는 도구 목록"만 갖는다 | P01, AC 1·3, E12 | 한 줄 요구(AC 1)를 그대로 만족하고, 노출 목록과 호출 거부가 같은 판정에서 나와 어긋날 수 없다. Role·단계 타입이 이미 contracts에 있어 의존 방향이 바뀌지 않는다. 비용: 규칙이 웹 번들에도 실린다(비밀이 아니라 허용 가능, E11) | Q1 |
| <a id="D02"></a>D02 | 채택 | 판정은 core에만 둔다. contracts에는 판정 함수를 두지 않고 데이터만 둔다. 노출 목록 함수도 core가 `checkToolCall`로 거른다 | E03, E04, AGENTS.md 불변 조건 | 판정이 두 곳에 생기면 노출과 거부가 갈라진다. 강제 지점은 지금처럼 db `checkOrRefuse` → core 하나 | Q1 |
| <a id="D03"></a>D03 | 채택 | "목록에 있음·노출됨 ≠ 권한"을 목록 module 머리 주석과 검사로 못박는다. 서버는 노출 목록과 상관없이 호출마다 Role·단계를 다시 검사하고, 쓰기 도구의 잠금 아래 재검사·승인 정책·조직 범위는 목록 밖에 그대로 둔다 | P03, E01, E08, E09 | 판 2 실행기가 목록을 캐시하거나 단계가 바뀐 뒤 옛 목록으로 불러도 경계가 유지된다 | Q1 |
| <a id="D04"></a>D04 | 보류 | 조직별 승인 정책(ADR-0003)을 도구 줄로 옮기지 않는다. 정책은 사용자가 조직마다 바꾸는 동적 값이라 Paperclip의 맥락 정책(E02)처럼 줄 밖에 둔다 | P02, E02, ADR-0003 | 노출 목록에 "승인 필요"를 표시할지는 판 2 노출 방식과 함께 정한다 | Q1 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 노출 목록만으로 막기 | E10(`isEnabled`는 노출만) | 실행기 밖 HTTP·MCP 경계에서는 모델이 목록 밖 이름을 부를 수 있다. 서버 거부가 필요하다(E08 MUST) |
| MCP annotations(`readOnlyHint`)를 권한 근거로 쓰기 | E08 | 명세가 untrusted hint로 규정한다. 읽기/쓰기 칸은 설명·감사용이다 |

## 구현 참고

- 권고 요약: 도구 한 줄 = 이름·설명·입력(경로 변수 포함)·출력·읽기/쓰기·열린 Role·단계(데이터). 판정·노출 목록은 core 한 함수에서. 서버는 호출마다 재검사.
- 구현 위치: 줄은 `packages/contracts/src/tools.ts`(또는 그 옆 module), 판정은 `packages/core/src/approval.ts`의 `checkToolCall`, 강제는 `packages/db/src/tool-calls.ts`. 의존 방향 변경 없음([구조 문서](../architecture.md#패키지-구성)).

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 작업자·`계획 수립` → 노출 목록 → `add_worker`·쓰기 도구 없음, 조회 도구 있음 | D01, D02 |
| V02 | 작업자가 노출 목록에 없는 `add_worker`를 직접 HTTP로 호출 → 거부 `role`, `tool.refused` Event | D03 |
| V03 | Lead가 `연구 진행` 목록을 받은 뒤 조직이 `결과 검토 중`으로 바뀜 → 옛 목록의 쓰기 도구 호출 → 거부 `stage` | D03 |
| V04 | 모든 도구 × Role × 단계 → 노출 목록 포함 여부 = `checkToolCall` 결과 (표 전수 비교) | D02 |
| V05 | 조직 A 토큰으로 조직 B를 가리키는 입력 → 목록과 무관하게 거부(기존 조직 경계 검사 유지) | D03 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| Role·단계 규칙을 도구 줄 데이터로 옮길지(D01) | 사용자 (a') 줄에 데이터, core는 판정만 — P01, AC 1. 권고 / (b) core 별도 표 유지, 줄은 이름으로 참조 — 규칙 설명 주석이 core 문맥 옆에 남는 장점. 다만 P02 사례(Hermes·OpenClaw)는 사용자·운영자 설정이고 우리 규칙은 제품 고정 규칙이라 동종이 아니며, 표가 둘이면 AC 1(한 줄)을 못 채우고 분산이 남는다 |
| 노출 목록에 승인 정책 표시 여부, 목록 갱신 알림 방식(list_changed 등) | 판 2 연결 방식 결정 | D04, E08 |

## 한계와 미확인

- 실행하지 않았다. 모든 근거는 소스·문서 읽기다. Paperclip self-host로 discovery 투영을 관찰하지 않았다.
- Paperclip live 서버 `definitions()`에서는 `allowedModes`·binding 플래그 필터만 확인했고 `requiredClaims` 평가는 조사 범위에서 확인하지 못했다(claims 평가는 runner 패키지 엔진, E03).
- OpenClaw pipeline이 호출 시점에도 다시 거부하는지는 조사 범위(tool-catalog, tool-policy-pipeline)에서 확인하지 못했다.
- tRPC는 계약·구현 분리가 없어 심층 조사하지 않았다. OpenAI Agents의 MCP `toolFilter`는 확인하지 못했다.
- 코드 재사용은 권고하지 않는다. 설계 참고뿐이다.

---

## 2차 조사: 도구 설명·필드 설명·역할 문서의 분담과 필드별 언어 규칙

조사일: 2026-10-29. 대상: [#86](https://github.com/babo-jeonguk/BaboJUBot/issues/86) 3번의 "모델이 읽을 설명" 칸. 위 1차 조사(목록과 허용 규칙의 자리)와 질문이 다르며 ID는 이어서 매긴다(Q2–Q3, E13–, P04–, D05–). 구현 전 기술 권고이며 확정 계약이 아니다. 상세 자료: `.reference-cache/issue-86/`(`candidates.md` 2차 절, `main-verification.md` 2차 절).

### Brief

- 구현할 문제: 도구 줄의 영어 설명(도구·입력 필드별)을 새로 쓴다. 지금 Role 문서(`harness/roles/lead/AGENTS.md` L7·L20)는 일의 순서와 도구 사실을 섞어 적는다 — 예: "계획 수립에서 네 가지를 `request_initial_approval` 하나로 제출, 완료 기준이 없으면 `completionCriteria`로 제안". 이 중 "완료 기준이 있는데 내면 거부, 없는데 안 내면 거부"는 core가 강제하는 도구 사실이다(`packages/core/src/approval.ts` L134-L146, `completion_criteria_set`·`completion_criteria_required`).
- 동종 문제: 모델에게 주는 글을 도구 정의(설명·필드 설명)와 전역 지시(system prompt·역할 문서·skill·서버 instructions)로 나누는 방식, 그리고 "이 칸은 사람이 본다" 같은 칸별 출력 제약의 자리.
- 고정된 결정: 에이전트가 읽는 글(역할 문서·soul·skill·도구 설명·도구 오류)과 에이전트 간 메시지·기억은 영어. 소유자가 조직 기록에서 보는 글(Lead 대화 답변, 작업 제목·설명·댓글·보고, 산출물, 연구 노드, 결과, 초기 계획, 진행 활동 문구)은 한국어(사용자 결정, 2026-10-29). 역할 문서·프롬프트는 강제 수단이 아니다(`AGENTS.md`). 노출 방식(MCP 등)은 판 2에서 정한다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q2 | 도구 설명·필드 설명과 system prompt·역할 문서·skill이 무엇을 나눠 갖는가(하는 일, 입력의 뜻, 거부 조건, 언제·왜 쓰나, 도구 간 순서). 중복을 허용하는가 | #86 해결 방향 3 "설명", 사용자 요청 | 공식 문서 비교 + Source Recon(OSS prompt 조립 경로) |
| Q3 | 특정 필드에만 걸리는 출력 형식·언어 제약("이 칸은 소유자가 본다, X로 쓴다")을 필드 schema 설명·도구 설명·전역 지시 중 어디에 두는가 | 사용자 언어 규칙 | 같음 |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| 위 1차 조사 Paperclip `def4726`·Hermes `4e58c72`·OpenClaw `1b93d1e`·MCP `9850cae` checkout | 같은 SHA에서 다른 파일(prompt 조립·skill·설명 문구)을 새로 읽음 | 같은 SHA라 blob 비교 불필요 |

### 레퍼런스

관점별 saturation: 공식 문서(Anthropic·OpenAI·MCP) — "도구 고유 사실은 설명·필드, 도구 간 관계·순서는 전역 지시"로 수렴, "언제 쓰나"의 자리만 갈림 / OSS agent(Codex·Hermes·OpenClaw·Paperclip) — 마지막 라운드(OpenClaw, Paperclip connection 문구)는 "한 출처를 여러 표면에 렌더" 변형만 더함 / 언어 규칙 — Claude Code·Hermes 모두 "전역 한 번 + 그 출력을 만드는 지시 옆"으로 수렴. 스키마 필드에 언어를 직접 적은 사례는 조사 범위에서 찾지 못했다(청중 표시는 있음).

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| Anthropic Define tools | 상용 공식 문서 | 2026-10-29 확인 | — | 문서 | 도구 설명 권장 내용의 1차 출처 |
| Anthropic "Writing effective tools for agents" | 공식 엔지니어링 글 | 2025-09-11 게시, 2026-10-29 확인 | — | 문서 | 설명·오류 응답 설계 |
| OpenAI function calling | 상용 공식 문서 | 2026-10-29 확인 | — | 문서 | "언제 쓰나"를 system prompt에 두라는 반대 견해 |
| MCP schema·공식 블로그 server instructions | 표준 | `9850cae8923b0ee3d19a4476f1010b97aa161a55` | MIT | 문서 | 판 2 후보 노출 방식의 전역 지시 필드와 분담 지침 |
| Codex | OSS agent | `588a277b301c3994455885d7f771d7d9db5d82b8` | Apache-2.0 | 소스 | 판 2 대상 실행기의 도구 설명·prompt 분담 |
| Claude Code prompt 수집본 | 저신뢰 수집본(Piebald-AI) | `53c252d35963adced4ca68434c32da6f1cd5fff3`, ccVersion 2.1.84–2.1.286 | MIT(수집본) | 문서 | 판 2 대상 실행기. 공식 공개 아님 |
| Hermes Agent | OSS agent | `4e58c721c8cf9b51c46636ea84ea6a5cb540880a` | MIT | 소스 | 중복 제거 정책과 출력별 언어 규칙 |
| OpenClaw | OSS agent | `1b93d1ea5dee6deaf91c28140571ba5eda00dd68` | MIT | 소스 | system prompt 도구 요약과 AGENTS.md의 지위 |
| Paperclip | OSS control plane | `def4726bea0e3b340457100038d80ca55c2b7d4f` | MIT | 소스 | 같은 동종(외부 실행기에 조직 도구 제공)의 skill·설명 분담 |
| Agent Skills spec | 표준 | `69ef37e9424c0a7ea9dd2293b559e43ec8176379` | Apache-2.0 | 문서 | skill description의 역할 |

모두 설계 참고이며 문구·코드를 복사하지 않는다.

### 근거

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E13"></a>E13 | Anthropic: 도구 설명은 성능에 "by far the most important factor". 설명에 하는 일, 언제 쓰고 언제 쓰지 않나, 각 파라미터의 뜻과 동작 영향, 돌려주지 않는 정보 같은 caveat를 쓰고 도구당 3–4문장 이상. 좋은 예의 필드 설명은 형식 예시(`AAPL`)를 든다 | [Define tools — Best practices for tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) (2026-10-29 확인) | 문서 주장 |
| <a id="E14"></a>E14 | Anthropic: 설명은 에이전트 context에 실려 도구 호출을 이끈다. 새 팀원에게 설명하듯 암묵 맥락(전용 형식·용어 정의)을 드러내고 파라미터 이름을 모호하지 않게(`user_id`). 오류 응답은 불투명한 코드 대신 구체적으로 무엇을 고칠지 알려 준다 | [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) (2025-09-11) | 문서 주장 |
| <a id="E15"></a>E15 | OpenAI: 함수와 각 파라미터의 목적(과 형식), 출력의 뜻을 명시한다. 반면 "Use the system prompt to describe when (and when not) to use each function" | [Function calling — Best practices](https://developers.openai.com/api/docs/guides/function-calling) (2026-10-29 확인) | 문서 주장 |
| <a id="E16"></a>E16 | MCP: `Tool.description`은 모델 이해를 돕는 "hint". 서버 전체 사용법은 `InitializeResult.instructions`에 두며 client가 system prompt에 넣을 수 있다(MAY) | [schema.ts L287-L292](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/9850cae8923b0ee3d19a4476f1010b97aa161a55/schema/2025-11-25/schema.ts#L287-L292), [L1250-L1255](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/9850cae8923b0ee3d19a4476f1010b97aa161a55/schema/2025-11-25/schema.ts#L1250-L1255) | 문서 주장 |
| <a id="E17"></a>E17 | MCP 공식 블로그(maintainer, 2025-11-03): 전역 지시는 여러 도구 설명에 흩지 말고 system prompt에. instructions에는 도구가 전하지 못하는 것 — 도구 간 관계·순서, 운영 패턴, 제약 — 을 쓰고 "Don't repeat tool descriptions". host가 instructions를 넣는다는 보장이 없다. 지시는 "rolling dice"라 보안·필수 동작은 결정적 규칙·hook으로 | [using-server-instructions.md L36-L53, L110-L150, L181-L185](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/9850cae8923b0ee3d19a4476f1010b97aa161a55/blog/content/posts/2025-11-03-using-server-instructions.md#L110-L150) | 문서 주장 |
| <a id="E18"></a>E18 | Codex: `update_plan` 도구 설명은 3줄(하는 일, 입력 모양, "at most one step in_progress")이고 필드 설명은 "Task step text." 수준이다. 언제·왜 계획을 쓰나, 단계 길이(5–7단어), 사용자에게 렌더된다는 사실, 진행 순서는 system prompt에 있다. "한 단계만 in_progress"는 양쪽에 중복된다. 저장소 지시(AGENTS.md)는 도구 사실이 아니라 코드 규칙의 자리로 prompt가 정의한다 | [plan_spec.rs L7-L57](https://github.com/openai/codex/blob/588a277b301c3994455885d7f771d7d9db5d82b8/codex-rs/core/src/tools/handlers/plan_spec.rs#L7-L57), [gpt_5_2_prompt.md L17-L27, L38-L44, L290-L298](https://github.com/openai/codex/blob/588a277b301c3994455885d7f771d7d9db5d82b8/codex-rs/core/gpt_5_2_prompt.md#L290-L298) | 소스 확인 |
| <a id="E19"></a>E19 | Claude Code(저신뢰 수집본): 도구 설명이 "When to Use / When NOT to Use"와 여러 단계 workflow(Bash의 git commit 절차)까지 갖고, system prompt는 TodoWrite를 가리키는 한 문단뿐이며 "완료 즉시 표시"가 양쪽에 중복된다 | [tool-description-todowrite.md](https://github.com/Piebald-AI/claude-code-system-prompts/blob/53c252d35963adced4ca68434c32da6f1cd5fff3/system-prompts/tool-description-todowrite.md), [system-prompt-tool-usage-task-management.md](https://github.com/Piebald-AI/claude-code-system-prompts/blob/53c252d35963adced4ca68434c32da6f1cd5fff3/system-prompts/system-prompt-tool-usage-task-management.md), [tool-description-bash-git-commit-instructions.md](https://github.com/Piebald-AI/claude-code-system-prompts/blob/53c252d35963adced4ca68434c32da6f1cd5fff3/system-prompts/tool-description-bash-git-commit-instructions.md) | 문서 주장(저신뢰) |
| <a id="E20"></a>E20 | Claude Code: Bash의 `description` 입력 필드 설명이 그 칸의 독자와 형식을 직접 말한다 — "the user reads this description, often without seeing the command", 능동태, 5–10단어. TodoWrite는 `activeForm`이 "shown during execution"이라고 도구 설명 안에서 칸별로 말한다. 언어는 칸에 적지 않는다 | [tool-parameter-bash-command-description.md L6-L8](https://github.com/Piebald-AI/claude-code-system-prompts/blob/53c252d35963adced4ca68434c32da6f1cd5fff3/system-prompts/tool-parameter-bash-command-description.md#L6-L8), todowrite L156-L158. Bash 문장은 이 조사 세션의 Claude Code 도구 schema에도 같은 문장으로 있다 | 문서 주장(저신뢰) + 세션 관찰 |
| <a id="E21"></a>E21 | Claude Code 언어: system prompt의 "# Language" 절 하나가 "Always respond in ${LANGUAGE_NAME} … all explanations, comments, and communications with the user"로 전역 규칙을 둔다. 세션 제목 생성 prompt는 그 출력 옆에 "write the title in the language the user wrote in, not the language of these instructions"를 둔다 | [system-prompt-respond-in-configured-language.md](https://github.com/Piebald-AI/claude-code-system-prompts/blob/53c252d35963adced4ca68434c32da6f1cd5fff3/system-prompts/system-prompt-respond-in-configured-language.md), [agent-prompt-coding-session-title-generator.md L12](https://github.com/Piebald-AI/claude-code-system-prompts/blob/53c252d35963adced4ca68434c32da6f1cd5fff3/system-prompts/agent-prompt-coding-session-title-generator.md#L12) | 문서 주장(저신뢰) |
| <a id="E22"></a>E22 | Hermes: memory 도구 설명이 HOW·WHEN·IF FULL(거부와 회복)·TARGETS·SKIP을 모두 갖는다. system prompt 쪽 memory 지침은 "the memory tool's schema defines what belongs there"로 도구 설명에 미루고 도구 간 경계(작업 지식은 skill, 전역 사실만 memory)만 말한다. 이 지침들은 해당 도구가 실렸을 때만 넣는다. maintainer가 skill_manage schema·Skills 절과 중복된 지침을 걷어 내고 "nothing else teaches it"인 것만 남겼다(#95681) | [memory_tool.py L373-L397](https://github.com/NousResearch/hermes-agent/blob/4e58c721c8cf9b51c46636ea84ea6a5cb540880a/tools/memory_tool.py#L373-L397), [prompt_builder.py L192-L231, L243-L264](https://github.com/NousResearch/hermes-agent/blob/4e58c721c8cf9b51c46636ea84ea6a5cb540880a/agent/prompt_builder.py#L192-L264), [system_prompt.py L273-L298](https://github.com/NousResearch/hermes-agent/blob/4e58c721c8cf9b51c46636ea84ea6a5cb540880a/agent/system_prompt.py#L273-L298) | 소스 확인 |
| <a id="E23"></a>E23 | Hermes 언어: 제목 생성 prompt에 언어 규칙 자리(`__LANGUAGE_RULE__`)를 두고 설정이 있으면 "Write the title in {language}", 없으면 사용자 언어. 요약기는 "same language the user was using — do not translate or switch to English". delegate 도구 설명은 하위 에이전트가 대화를 모르므로 필요한 출력 언어를 `context`로 넘기라고 한다 | [title_generator.py L107-L116](https://github.com/NousResearch/hermes-agent/blob/4e58c721c8cf9b51c46636ea84ea6a5cb540880a/agent/title_generator.py#L107-L116), [context_compressor.py L2089-L2093](https://github.com/NousResearch/hermes-agent/blob/4e58c721c8cf9b51c46636ea84ea6a5cb540880a/agent/context_compressor.py#L2089-L2093), [delegate_tool.py L652-L654](https://github.com/NousResearch/hermes-agent/blob/4e58c721c8cf9b51c46636ea84ea6a5cb540880a/tools/delegate_tool.py#L652-L654) | 소스 확인 |
| <a id="E24"></a>E24 | OpenClaw: system prompt "## Tooling"에 노출된 도구만 한 줄 요약으로 다시 적고(도구 설명의 압축 중복), "The AGENTS.md Tools section guides usage; it never grants availability."를 박는다. MCP 서버 instructions는 별도 절로 붙인다 | [system-prompt-tool-list.ts L19-L141](https://github.com/openclaw/openclaw/blob/1b93d1ea5dee6deaf91c28140571ba5eda00dd68/src/agents/system-prompt-tool-list.ts#L19-L141) | 소스 확인 |
| <a id="E25"></a>E25 | Paperclip(구 MCP 도구): 설명이 한 줄("Create a new issue")이고 댓글 `body` 필드에 설명이 없다. 일의 순서, 승인 대기 시 행동, 댓글·설명 형식("Comment Style (Required)")은 skill에 있다 | [mcp-server tools.ts L515-L549](https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/packages/mcp-server/src/tools.ts#L515-L549), [validators/issue.ts L1114-L1125](https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/packages/shared/src/validators/issue.ts#L1114-L1125), [skills/paperclip/SKILL.md L471-L484, L619-L650](https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/skills/paperclip/SKILL.md#L619-L650) | 소스 확인 |
| <a id="E26"></a>E26 | Paperclip(새 도구): 도구 설명이 언제 먼저 쓰나·다른 도구 결과를 받는 순서·사람 승인 뒤 멈춤까지 담는다. 같은 지침은 한 상수로 두고 "prompts, adapter descriptors, CLI help, environment delivery, and MCP tool descriptions"에 재사용한다(렌더된 중복, 출처는 하나). runner descriptor 설명도 행동 사실("backlog tasks never wake an agent")을 갖는다 | [connection-intent-guidance.ts L1-L19](https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/packages/shared/src/connection-intent-guidance.ts#L1-L19), [run-preparation.ts L1287](https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/server/src/services/heartbeat/run-preparation.ts#L1287), [create-task.ts L29-L33](https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/packages/paperclip-runner/src/protocol-actions/create-task.ts#L29-L33) | 소스 확인 |
| <a id="E27"></a>E27 | Agent Skills: `description`은 무엇을 하고 언제 쓰나(≤1024자)이며 시작 때 항상 실리고, 본문은 skill이 켜질 때 실린다 | [specification.mdx L28, L91-L101, L216-L221](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx#L216-L221) | 문서 주장 |
| <a id="E28"></a>E28 | 이 저장소: contracts 입력 schema에 `.describe()`가 0개다. Lead 역할 문서 L7·L20이 core 거부 규칙(`completion_criteria_set`·`completion_criteria_required`)을 지침 문장으로 다시 적는다. harness 문서는 한국어다 | `packages/contracts/src/*.ts`, `harness/roles/lead/AGENTS.md`, `packages/core/src/approval.ts` L134-L146 (`45b6709`) | 소스 확인 |

### 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P04"></a>P04 | **도구 고유 사실은 도구 정의에**: 하는 일, 돌려주는 것, 쓰기 효과, 각 필드의 뜻·형식·선택 필드를 채우는 조건, 거부 조건과 회복 방법, 비슷한 도구와의 구분 | E13, E14, E15, E22, E26 | Codex·구 Paperclip은 최소한, Hermes·Claude Code·새 Paperclip은 길게 | 노출 방식(MCP·직접 함수)이 바뀌어도 도구와 함께 간다 | 길어지면 context 비용. 거부 문구가 core 규칙과 어긋날 수 있다 |
| <a id="P05"></a>P05 | **도구 사이·단계 사이의 흐름은 전역 지시에**: 순서, 단계별 할 일, 판단 기준. 도구는 이름으로만 가리키고 필드 규칙을 다시 쓰지 않는다 | E15, E16, E17, E18, E22, E25 | 자리: system prompt(Codex), 서버 instructions(MCP), skill(Paperclip), 도구가 있을 때만 넣는 guidance(Hermes) | 역할·단계마다 다른 흐름을 도구 정의 하나에 섞지 않는다 | host가 전역 지시를 빼면 사라진다(E17 L53) |
| <a id="P06"></a>P06 | **"언제 이 도구를 쓰나"의 자리는 갈린다**: 도구 설명(Anthropic, Claude Code, Hermes) vs system prompt(OpenAI, Codex) | E13, E15, E18, E19, E22 | 공통분모: 비슷한 도구 중 이것을 고르는 기준은 설명, 여러 도구를 잇는 순서는 전역 | — | — |
| <a id="P07"></a>P07 | **중복은 출처에서 없애고 렌더에서 허용**: 한 사실은 한 곳에서 쓰고, 다른 표면에는 생성·압축해 싣는다. 손으로 두 번 쓴 중복은 걷어 낸다 | E17, E22, E24, E26 | Paperclip 상수 재사용, OpenClaw 요약 생성, Hermes 중복 제거. Codex·Claude Code에는 손으로 쓴 작은 중복이 남아 있다(E18, E19) | 고칠 곳이 하나 | 생성 경로가 없으면 결국 손 중복이 된다 |
| <a id="P08"></a>P08 | **칸별 청중·형식은 그 칸의 필드 설명에**: "사용자가 이 칸을 읽는다", 길이·문체 | E20, E13 | Claude Code Bash `description`·TodoWrite `activeForm`. Codex는 같은 내용을 system prompt에 둔다(E18) | 칸과 규칙이 붙어 다닌다 | 칸마다 손으로 쓰면 문구가 갈린다 |
| <a id="P09"></a>P09 | **언어는 전역 규칙 한 번 + 그 출력을 만드는 자리**: 전역 응답 언어는 system prompt 한 절, 특정 출력(제목·요약)은 그 생성 지시 옆에 다시. 지시 언어와 출력 언어가 다르면 "지시의 언어가 아니라"를 명시한다. 다른 에이전트로 넘길 때는 언어를 명시적으로 넘긴다 | E21, E23 | 스키마 필드 설명에 언어를 적은 사례는 조사 범위에서 찾지 못함 | 지시는 영어로 두고 출력만 다른 언어로 고정할 수 있다 | 전역 규칙만 두면 도구 칸까지 닿는다는 보장이 없다 |

### 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D05"></a>D05 | 채택 | **도구 설명(영어, 도구 줄)**: 하는 일, 돌려주는 것, 남기는 기록, 비슷한 도구와의 구분, 보일 때도 걸릴 수 있는 거부 조건과 회복 방법. 열린 Role·단계는 노출 목록이 거르므로(D01) 설명에 Role·단계 표를 다시 쓰지 않는다. 도구 오류 메시지(영어)는 무엇을 고칠지 말한다 | P04, P06, E13, E14 | 실행기·노출 방식과 무관하게 도구와 함께 간다. 거부 조건은 core 규칙의 서술일 뿐 강제 수단이 아니다(`AGENTS.md`) | Q2 |
| <a id="D06"></a>D06 | 채택 | **필드 설명(영어, zod `.describe()` → JSON Schema `description`)**: 뜻, 형식, 선택 필드를 채우는 조건과 서버가 어떻게 다루나. 예: `completionCriteria` — "Required when the organization has no completion criteria; refused when it already has them. Becomes the organization's criteria once the owner approves." | P04, E15, E28 | 지금 Role 문서에만 있는 core 규칙(E28)이 그 칸 옆으로 온다 | Q2 |
| <a id="D07"></a>D07 | 변형 채택 | **Role 문서·skill·soul**: Role 문서(AGENTS.md)는 단계별 할 일, 도구를 잇는 순서, 제출물의 품질 기준만. 도구는 이름으로 가리키고 필드 규칙·거부 조건을 다시 쓰지 않는다. skill은 여러 도구를 잇는 절차(연구 노드 기록), soul은 태도만. 예: Lead 계획 수립 — "Read the org record and harness library, decide …, then submit them together with `request_initial_approval`; propose completion criteria in the same request if the organization has none." | P05, P07, E17, E22, E25 | "언제 쓰나"는 둘로 나눈다: 비슷한 도구 중 이것을 고르는 기준은 도구 설명, 단계 흐름은 Role 문서(P06의 공통분모). Lead·작업자가 같은 도구를 다른 흐름으로 쓰므로 흐름을 도구 설명에 넣지 않는다 | Q2 |
| <a id="D08"></a>D08 | 채택 | **중복 규칙**: 한 사실은 한 곳에서 쓴다. 다른 표면(노출 목록 요약, 판 2 서버 instructions 등)이 필요하면 도구 줄에서 생성한다. 손으로 쓴 두 번째 문장은 두지 않는다 | P07 | 31개 도구 × 여러 표면에서 문구가 갈라지는 것을 막는다 | Q2 |
| <a id="D09"></a>D09 | 채택 | **언어 규칙 두 겹**: (1) 모든 Role이 받는 공통 지침 머리(제품이 붙이는 한 문단, Role 문서마다 복사하지 않음)에 "Instructions are in English. Messages to other agents and memory are in English. Everything the owner sees in organization records is written in Korean, not in the language of these instructions." (2) 소유자가 보는 입력 필드는 도구 줄에서 칸 단위 표시(예: owner-facing)를 두고 필드 설명 끝에 "Shown to the owner. Write in Korean."을 **생성**해 붙인다 | P08, P09, E17, E20, E21, E23 | 전역 규칙만 두면 실행기·host가 지침을 빼거나 도구 칸에 닿지 않을 수 있다(E17 L53). 칸 표시를 데이터로 두면 손 중복 없이(D08) 칸과 규칙이 붙어 다닌다. 칸에 언어를 적은 직접 사례는 못 찾았으므로 P08(청중 표시)과 P09(출력 옆 언어)를 합친 변형이다 | Q3 |
| <a id="D10"></a>D10 | 보류 | 도구 입력이 아닌 소유자용 글(Lead 대화 답변, 진행 활동 문구)은 필드가 없으므로 D09(1) 공통 머리만 닿는다. 진행 활동 문구를 실행기가 만드는지 서버가 만드는지에 따라 자리가 달라진다 | P09 | 서버가 만드는 문구는 제품 코드의 한국어 문자열로 끝난다 | Q3 |

#### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 단계별 workflow를 도구 설명에 넣기 | E19(Claude Code git 절차) | 같은 도구를 Lead·작업자, 여러 단계가 쓴다. 흐름은 Role·단계마다 다르고 Role 문서에 이미 단계 절이 있다 |
| Role 문서에 도구 필드 규칙·거부 조건을 다시 적기(지금 모양) | E28, E17 "Don't repeat tool descriptions" | core 규칙과 두 곳에서 어긋난다. 필드 설명(D06)이 유일한 서술 자리 |
| 언어 규칙을 전역 지시에만 두기 | E17 L53 | 판 2 실행기·host가 지침을 어떻게 싣는지 미정. 칸 단위가 도구와 함께 간다 |
| 칸마다 언어 문장을 손으로 쓰기 | P07 | 31개 도구에서 문구가 갈린다. 칸 표시에서 생성(D09) |

### 구현 참고

- 권고 요약: 도구 줄 = 도구 설명(고유 사실·거부·구분) + 필드 설명(뜻·형식·조건) + 소유자 칸 표시. Role 문서 = 단계 흐름·품질 기준·도구 이름. skill = 여러 도구 절차. soul = 태도. 언어 = 공통 머리 한 문단 + 소유자 칸 설명에 생성 문장. 모두 영어로 쓰되 소유자 칸의 **값**은 한국어.
- 구현 위치: 설명·칸 표시는 1차 D01의 도구 줄(`packages/contracts`). 공통 언어 머리는 지침 묶음을 만드는 곳(`packages/core/src/harness.ts`·`apps/server/src/harness.ts` 쪽, 구조 문서 기준으로 확정). 역할 문서 영어 전환은 지침 bundle 버전을 바꾸므로 이전 세션을 잇지 않는다(실행기 계약 주석).

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V06 | 모든 도구 줄 → JSON Schema 생성 → 도구 설명·모든 입력 필드에 `description`이 있다 | D05, D06 |
| V07 | 소유자 칸 표시가 있는 필드 → 생성된 설명 → "Write in Korean" 문장 포함, 표시 없는 필드는 미포함 | D09 |
| V08 | 도구 설명·필드 설명·도구 오류 메시지·harness `.md` 문서 → 한글 검사 → 한글 없음(소유자에게 보이는 `role.json` label 등은 제외) | 고정된 결정 |
| V09 | harness 문서의 backtick 도구 이름 → 도구 목록과 대조 → 모두 존재(없는 도구를 가리키지 않음) | D07 |
| V10 | 조직에 완료 기준이 있는데 `completionCriteria`를 낸 요청 → 거부 → 오류 메시지가 그 필드를 빼라고 말한다(영어) | D05, D06 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 소유자 칸의 한국어를 서버가 검사할지 | 사용자 | (a) 지시만 — 언어는 `AGENTS.md`의 강제 대상(승인·정책·조직 경계)이 아니고 E17은 지시를 "rolling dice"로 본다. 권고 / (b) 한글 포함 여부를 서버가 거부 — 확실하지만 코드·수식·고유명만 든 칸을 막을 위험 |
| 도구 사이 흐름을 판 2에서 MCP `instructions`로도 낼지 | 판 2 연결 방식 결정 | E16, E17. 낸다면 Role 문서에서 생성(D08) |
| harness 문서 영어 전환을 #86에 넣을지 별도 이슈로 둘지 | 사용자 | #86 AC "동작은 바뀌지 않는다"와 bundle 버전 변경의 관계 |

### 한계와 미확인

- 실행하지 않았다. 실제 모델로 설명 배치의 효과를 비교하지 않았다(실제 모델 호출 범위 밖).
- Claude Code는 공식 공개 prompt가 아니라 수집본(저신뢰)이다. Bash `description` 필드 문장만 이 조사 세션의 도구 schema로 교차 확인했다.
- Anthropic 엔지니어링 글은 WebFetch 요약으로 읽어 원문 문장 인용이 제한적이다.
- 스키마 필드 설명에 출력 언어를 직접 적은 사례는 조사 범위(위 레퍼런스의 prompt·도구 정의)에서 찾지 못했다. D09(2)는 패턴을 합친 변형이다.
- Codex·Claude Code가 MCP `instructions`를 system prompt에 넣는지는 확인하지 못했다(MCP 블로그 L197 이후 지원 host 목록은 읽지 않음).
