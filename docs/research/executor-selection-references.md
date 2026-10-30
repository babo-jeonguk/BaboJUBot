# 프로바이더 선택 레퍼런스 조사: 에이전트마다 프로바이더를 어디에 두고, 어떤 모양으로, 바꾸고 확인하는가

조사일: 2026-10-30. 대상: [판 2](../architecture.md#구현-순서)에서 Claude Code·Codex·OpenCode·Antigravity를 공통 실행 시도 계약에 붙일 때 생기는 **프로바이더 선택**이다. 구현 전 기술 권고이며 확정 계약이나 구현 결과가 아니다.

사용자가 정한 전제: 프로바이더는 **에이전트마다** 고르고, 전역 설정에 기본값을 둔다(예: Lead는 Claude Code, 코딩 작업자는 Codex). 이 문서는 이 전제를 바꾸지 않고, 그 설정을 어디에 어떤 모양으로 두는지와 바꿀 때·없을 때의 동작을 레퍼런스로 정한다.

용어는 [공통 용어](../../GLOSSARY.md)를 따른다. **프로바이더**는 [전체 구조](../architecture.md)가 쓰는 말로, 모델 호출과 도구 루프를 실제로 수행하는 외부 프로그램(Claude Code CLI 등)이다. [에이전트 실행 모델 조사](agent-runtime-models.md)의 "실행 도구"와 같다. 레퍼런스마다 adapter·harness·provider·runtime·executor·agent server라고 부르지만 여기서는 모두 프로바이더라고 쓴다.

기존 조사와의 경계:

| 재사용한 조사 | 이미 답한 것 | 이 문서가 더하는 것 |
|---|---|---|
| [paperclip.md](paperclip.md) | Paperclip이 adapter로 여러 프로바이더를 구동한다 | 프로바이더 선택 자리·변경·환경 확인 |
| [agent-runtime-models.md](agent-runtime-models.md) | `ServerAdapterModule`·실행 맥락·결과 모양, 지침 주입, 세션 키, ACP가 공통 기반 후보라는 점 | 같은 계약 위에서 **누가 언제 어느 프로바이더를 고르는가**, capability 표시, 변경 시 세션 처리 |

근거 수준 표기: **[소스]** 고정 SHA 코드를 읽은 사실, **[문서]** 저장소 문서·README의 주장, **[추론]** 위 근거에서 끌어낸 판단, **[미확인]** 공개 자료로 확인하지 못한 것.

## 기준 버전과 조사 방식

후보 16개를 `/tmp/execsel/<이름>`에 아래 SHA로 shallow clone해 정적으로 읽었다(Zed는 sparse checkout). 설치·빌드·실행·실제 모델 호출은 하지 않았다. 경로·줄 번호는 모두 표의 SHA 기준이다.

| 대상 | 저장소 | SHA | 라이선스 | 읽은 깊이 | 판정 |
|---|---|---|---|---|---|
| Paperclip | [paperclipai/paperclip](https://github.com/paperclipai/paperclip/tree/2badf8a4a5a7fb07329d99d355cf0f9875de3b80) | `2badf8a4a5a7fb07329d99d355cf0f9875de3b80` | MIT | 소스(agent 스키마·생성/수정 route·세션 준비·adapter 타입·Claude 환경 확인) + 운영 문서 | 포함, 가장 가까운 동종 |
| Multica | [multica-ai/multica](https://github.com/multica-ai/multica/tree/c066f7ea61eecdfc7c227b20a45330eacc7cf352) | `c066f7ea61eecdfc7c227b20a45330eacc7cf352` | Multica License(Apache-2.0 + 추가 조건) | 소스(migration·agent handler·daemon) | 포함, 에이전트=팀원 모델 |
| Composio agent-orchestrator(AO) | [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator/tree/9b95d754f5d4fcbad31ff8d6422b37c8703c6206) | `9b95d754f5d4fcbad31ff8d6422b37c8703c6206` | Apache-2.0 | 소스(domain·ports·session_manager) | 포함, orchestrator/worker 역할별 기본값 |
| Vibe Kanban | [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban/tree/7c3807084daad0d9d315064f60fa869de254f027) | `7c3807084daad0d9d315064f60fa869de254f027` | Apache-2.0 | 소스(executors crate·session route·UI hook) | 포함 |
| Emdash | [generalaction/emdash](https://github.com/generalaction/emdash/tree/85dfa910ac92e69b09ed5df70ea60ee625a83f07) | `85dfa910ac92e69b09ed5df70ea60ee625a83f07` | Apache-2.0 | 소스(plugin capability·provider 선택) | 포함 |
| Sculptor | [imbue-ai/sculptor](https://github.com/imbue-ai/sculptor/tree/ea2a9dffea1327c48504936ad67776fab40e49ce) | `ea2a9dffea1327c48504936ad67776fab40e49ce` | MIT | 소스(harness 인터페이스·user config·dependency 관리) | 포함 |
| Nimbalyst(Crystal 후속) | [Nimbalyst/nimbalyst](https://github.com/Nimbalyst/nimbalyst/tree/031a6e6de0b7817bbdcd16e6e5e758e45dfdcdc7) | `031a6e6de0b7817bbdcd16e6e5e758e45dfdcdc7` | MIT | 소스, provider·capability·전환·가용성 위주 선택 열람 | 포함 |
| Crystal | [stravu/crystal](https://github.com/stravu/crystal/tree/1e18e0bc981225f75b5226f82a300fa741970c6f) | `1e18e0bc981225f75b5226f82a300fa741970c6f` | MIT | 소스 | 포함(보조). README상 2026-02 Nimbalyst로 대체 |
| Zed(ACP client) | [zed-industries/zed](https://github.com/zed-industries/zed/tree/d4014230735e4265d98066420b9271df2324ccab) | `d4014230735e4265d98066420b9271df2324ccab` | 해당 crate GPL-3.0 | 소스(`agent_servers`·`acp_thread`·`agent_ui`·`project/agent_server_store.rs`) + docs | 포함. 코드 복사 불가, 설계만 참고 |
| ACP registry | [agentclientprotocol/registry](https://github.com/agentclientprotocol/registry/tree/34559b906273a72edf3d89b8831adede059802d7) | `34559b906273a72edf3d89b8831adede059802d7` | Apache-2.0 | 스키마·항목·CONTRIBUTING | 포함(보조) |
| OpenClaw | [openclaw/openclaw](https://github.com/openclaw/openclaw/tree/43af01b15c96785d1e69bbd14eafa7a56938cf7f) | `43af01b15c96785d1e69bbd14eafa7a56938cf7f` | MIT | config schema·acp-core·acpx + docs | 포함(보조) |
| Claude Squad | [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad/tree/ce1ffb4392b01f38e2c4599c7c84d2a93973b138) | `ce1ffb4392b01f38e2c4599c7c84d2a93973b138` | AGPL-3.0 | 소스 | 포함(대비 사례). 코드 복사 불가 |
| coder/agentapi | [coder/agentapi](https://github.com/coder/agentapi/tree/7c468d5b25ec9d3d76c41313cf4e08904ff5968d) | `7c468d5b25ec9d3d76c41313cf4e08904ff5968d` | MIT | 소스 | 포함(대비 사례) |
| Hermes Agent | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent/tree/088f657ecf77674c7b8e2ededf4e3576d82e042c) | `088f657ecf77674c7b8e2ededf4e3576d82e042c` | MIT | 소스 | **제외**(아래) |
| coder/mux | [coder/mux](https://github.com/coder/mux/tree/23ef46d01ee9e3370177f134a615062bf6ad113e) | `23ef46d01ee9e3370177f134a615062bf6ad113e` | AGPL-3.0 | 소스 | **제외**(아래) |

Paperclip SHA는 기존 조사(`1b4c803`)보다 새 것이다. 프로바이더 변경·환경 확인 코드가 그사이 크게 늘어 새 SHA로 다시 읽었다.

### 제외한 후보

- **Hermes Agent: 에이전트마다 프로바이더를 고르는 모델이 없다.** 자체 루프가 주인이다. ACP CLI(Copilot 등)는 `auth_type="external_process"` **모델 provider**로 쓰여, 대화 전체를 prompt 하나로 보내고 도구 호출을 텍스트에서 다시 읽는다(`agent/acp_client.py` L54-58, L428-526). 프로바이더 권한 요청에는 항상 `cancelled`로 답한다(L548-549). 실제 프로바이더 위임은 opt-in `model.openai_runtime: codex_app_server` 하나다(`hermes_cli/runtime_provider.py` L338-350). Claude Code·OpenCode는 `claude -p`를 terminal 도구로 부르는 skill 문서로만 다룬다. [소스]
- **coder/mux: 외부 프로바이더를 구동하지 않는다.** README가 "custom agent loop"라고 하고 `@ai-sdk/*`로 모델 provider를 직접 부른다(`src/common/constants/providers.ts` L20-34). `src/node/acp/`는 반대로 mux 자신을 ACP agent로 노출한다. Codex 지원은 ChatGPT 구독 OAuth를 OpenAI endpoint에 쓰는 것이지 Codex CLI가 아니다. [소스]
- 후보로 검토했지만 열지 않은 것: Toad(`batrachianai/toad`, ACP client로 Zed와 같은 범주), Conductor·Superset 등 비공개 앱.

## 핵심 판단

| 대상 | 1. 선택 자리 | 2. 설정 모양 | 3. 없는 기능 표시 | 4. 프로바이더 변경 | 4. 미설치·미로그인 |
|---|---|---|---|---|---|
| Paperclip | **에이전트 행**(`adapter_type`·`adapter_config`). 전역 기본값 없음, 새 에이전트 폼 기본값 `claude_local` | 자유 JSON + adapter가 주는 선언형 form schema(`getConfigSchema`) | adapter module의 선택 멤버·boolean | 허용. 프로바이더별 키는 비우고 공통 키만 유지, 세션은 새로 시작하고 작업 댓글로 인계문 생성 | `testEnvironment` 필수. pass/warn/fail + check 목록. Claude는 실제 hello 호출까지 |
| Multica | **에이전트 → runtime(기기 하나의 CLI 하나)** FK. 기본값 없음 | 모델·args·env·MCP가 에이전트 행의 자유 열, provider별 검증 | 모델 catalog·ACP 응답으로 숨김 | 허용. 맞지 않는 모델 초기화, CLI 세션은 같은 runtime일 때만 재개, 대화 기록 유지 | daemon이 PATH를 2분마다 탐지해 runtime 등록. 로그인은 실패 문구로 사후 분류 |
| AO | 세션 명시값 > 프로젝트의 **orchestrator/worker 역할별** 값 > 오류 | 프로바이더 중립 typed `AgentConfig{Model,Effort,Mode,Permissions}` + adapter별 `ConfigSpec` | 선택 interface(type assertion) + UI capability enum | 같은 세션에서 전환 허용. 새 native thread를 인계문으로 시작 | 설치·인증 관찰 → ready/not_ready/unknown. unknown은 막지 않음 |
| Vibe Kanban | 전역 기본 profile(`config.json`) + 실행 시도마다 선택 | **프로바이더별 typed struct**(Rust enum) → JSON schema 생성 → UI 폼 자동 생성 | 정적 capability 목록으로 UI 요소 숨김 | 세션 안 프로바이더 변경은 409 `ExecutorMismatch`. 새 세션만 | `LoginDetected/InstallationFound/NotFound`. 다른 프로바이더로 대체하지 않음 |
| Emdash | 전역 `defaultAgent` + 대화마다 선택 | 대화별 versioned 판별 union + 프로바이더별 자유 `extraArgs`·`env` | capability마다 `supported/none` 같은 typed 서술자 | 변경 기능 없음, 새 대화 | 설치 여부로 생성 버튼 비활성. 인증 3상태 |
| Sculptor | 에이전트마다 생성 때 선택. 기본값은 최근 사용 | 판별 union `AgentConfigTypes`. 생성 때 값 고정 | 기본값 없는 boolean 15개, 빠짐없이 선언 강제 | 변경 API 없음 | `claude auth status` 확인, 앱 안 로그인 |
| Nimbalyst | 전역 `defaultProvider` > 프로젝트 > 세션 | 모든 provider에 같은 모양 | 빠짐없는 `Record<provider, capability>`, 기본값 없음 | 메시지가 있는 세션은 프로바이더 전환 차단 | "설치 + 로그인" 탐지는 `enabled` 기본값에만 사용 |
| Zed | 기본 설정 없음. 최근 사용 → workspace 선택 → 스레드 고유 | 프로바이더마다 typed `agent_servers.<id>`. 모델은 ACP config option | ACP `initialize` 응답에서 capability, 없으면 selector를 그리지 않음 | 빈 초안만 교체, 메시지가 있는 스레드는 프로바이더 고정 | registry 자동 설치, ACP 인증 요구 시 로그인 화면. 대체 없음 |
| OpenClaw | 우선순위 binding > agent > 전역 `acp.*` | strict zod. 권한 모드 enum | `getCapabilities` + 미지원 제어는 오류 코드 | ACP 세션은 backend 유지. 시작 후 실패를 다른 runtime으로 재실행하지 않음 | `/acp doctor`, `installed/missing/unverified` |
| Claude Squad·agentapi | 실행 명령 문자열 하나(전역 `default_program`, `--type`) | 자유 명령 문자열 | 없음. 지원 안 하면 조용히 없음 | 시작 뒤 변경 없음 | 확인 없음 |

[추론] 고르는 자리는 셋으로 수렴한다. (1) **오래 사는 에이전트**가 프로바이더를 가진다(Paperclip·Multica·Sculptor). (2) **세션·대화**가 가진다(Vibe Kanban·Emdash·Zed·Nimbalyst). (3) **역할 기본값**이 그 사이를 채운다(AO). 오래 사는 에이전트를 운영하는 제품(Paperclip·Multica)은 (1)을 쓴다. BaboJUBot의 에이전트도 실행 시도 사이에 이어지는 구성원이라 (1)에 해당한다.

## 1. 선택 자리와 정하는 시점

### Paperclip

- **[소스]** 프로바이더는 에이전트 행의 열이다. `adapterType`(기본 `"process"`), 자유 JSON `adapterConfig`·`runtimeConfig`. [agents 스키마 L36-L38](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/packages/db/src/schema/agents.ts#L36-L38)
- **[소스]** 회사나 instance 단위 기본 프로바이더 열은 없다. instance가 할 수 있는 것은 adapter **끄기**다. 끈 adapter로 만들거나 바꾸면 "Adapter … is not available on this instance. Available adapters: …"로 거부한다. [agents route L1905-L1914](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/server/src/routes/agents.ts#L1905-L1914)
- **[소스]** 기본값은 쓰는 자리마다 따로 있다.
  - 새 에이전트 폼: `adapterType: "claude_local"`. [agent-config-defaults](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/ui/src/components/agent-config-defaults.ts#L3-L14)
  - 내장 에이전트 정의: `defaultAdapterType`·`allowedAdapterTypes`가 있다. 정의에 기본값이 없으면 그 회사에서 이미 가장 많이 쓰는 허용 adapter를 고른다. [built-in-agents L667-L692](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/server/src/services/built-in-agents.ts#L667-L692)
  - 팀 catalog 가져오기: catalog 에이전트의 `AGENTS.md` frontmatter에는 adapter가 없다. 가져올 때 `PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE`(없으면 `claude_local`)을 에이전트마다 넣고, 호출자가 준 override가 이긴다. [teams-catalog L682-L711](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/server/src/services/teams-catalog.ts#L682-L711)
- **[문서]** 상위 에이전트가 하위 에이전트 채용을 요청하면 `hire_agent` 승인 요청이 생기고, 그 안에 "the proposed agent's name, role, capabilities, adapter config, and budget"이 들어간다. 즉 **채용 제안에 프로바이더 설정이 같이 실려** 사람이 함께 승인한다. [approvals 문서 L14](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/docs/guides/board-operator/approvals.md#L14)
- **[소스]** 작업(issue) 단위 override `assigneeAdapterOverrides`는 `adapterConfig`(모델 등)만 바꾸고 `adapterType`은 바꾸지 못한다. 프로바이더 홈 위치(`homeMode`)는 작업에서 바꿀 수 없다고 schema가 막는다. [issue validator L307-L315](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/packages/shared/src/validators/issue.ts#L307-L315)

### 나머지

- **Multica [소스]** runtime은 "기기 하나의 CLI 하나"다. `agent_runtime(workspace_id, daemon_id, provider, …)`에 `UNIQUE (workspace_id, daemon_id, provider)`이고 에이전트는 `agent.runtime_id`로 그 행을 가리킨다(`server/migrations/004_agent_runtime_loop.up.sql` L1-18). 생성 때 필수(`handler/agent.go` "runtime_id is required")이고 나중에 수정할 수 있다. 전역·workspace 기본 runtime은 없다.
- **AO [소스]** `effectiveHarness`: 세션 명시값 → 프로젝트의 역할 override(`orchestrator`/`worker`) → 빈 값이면 spawn이 `ErrMissingHarness`("configure project <role>.agent or pass --harness")로 거부한다(`backend/internal/session_manager/manager.go` L2296-2304, L1026-1031). 사용자 예시인 "Lead는 Claude Code, 작업자는 Codex"와 가장 비슷한 모양이다.
- **Vibe Kanban [소스]** 전역 `Config.executor_profile`(`<data_dir>/config.json`). 첫 실행에서 설치·최근 로그인 순으로 추천값을 고른다(`crates/executors/src/profile.rs` L497-557). UI 선택 우선순위는 사용자 선택 → 초안 → 이 세션 최근값 → 전역 기본 → 처음 가능한 것이다(`packages/web-core/src/shared/hooks/useExecutorConfig.ts` L28).
- **Emdash [소스]** 전역 `defaultAgent`(기본 `claude`). 대화를 만들 때 고른다. 기본값이 설치되지 않았으면 처음 설치된 것을 고르고, 고른 프로바이더가 설치되지 않았으면 생성 버튼을 끈다(`apps/emdash-desktop/src/core/features/conversations/browser/provider-selection.ts` L15-40).
- **Sculptor [소스]** 에이전트를 만들 때 고른다. 기본값은 최근 사용값(`last_used_agent_type`)이고 없으면 Claude다(`config/user_config.py` L333-341). 실행 인자는 "stamped at creation … self-describing even if the registration file later changes"이다(`interfaces/agents/agent.py` L618-631). **생성 때 값을 복사해 원본 변경과 끊는다.**
- **Zed [소스]** 기본 프로바이더 설정이 없다(`default_agent` 등 검색 결과 없음). 새 스레드의 프로바이더는 최근 사용값(`LAST_USED_AGENT_KEY`, `agent_ui/src/agent_panel.rs` L109)이다. 설치되지 않은 프로바이더는 복원 후보에서 거른다.
- **OpenClaw [소스/문서]** 우선순위는 `bindings[].acp.*` > `agents.entries.*.runtime.acp.*` > 전역 `acp.*`이다(`docs/tools/acp-agents/bindings.md` L112-126). 전역에 `acp.defaultAgent`·`acp.allowedAgents` allowlist가 있다.

## 2. 모델·프로바이더별 옵션과 설정 모양

| 모양 | 사례 | 장점 | 비용 |
|---|---|---|---|
| 자유 JSON + 선언형 form schema | Paperclip `adapterConfig` + `getConfigSchema(): {fields: [{key,label,type,options,default,…}]}` ([types L455-L477](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/packages/adapter-utils/src/types.ts#L455-L477), [L551-L556](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/packages/adapter-utils/src/types.ts#L551-L556)) | plugin adapter를 더하기 쉽다 | 프로바이더를 바꿀 때 남길 키를 따로 목록으로 관리해야 한다(아래 4절). 비밀값 가리기·복원 코드가 수정 route에 들어간다 |
| 자유 열 + provider별 검증 | Multica `model`·`custom_args`(JSONB 배열)·`custom_env`(JSONB map)·`mcp_config`·`thinking_level` | 단순하다 | 자유 args가 제품이 고정한 권한 모드를 덮을 수 있다. 그래서 provider별 blocklist가 생겼다. Claude는 `--permission-mode`를 막는다. 제품이 `bypassPermissions`를 강제하기 때문이다(`pkg/agent/launch.go` L476, `claude.go` L1116, L1133) [소스] |
| 프로바이더별 typed struct → schema → 자동 폼 | Vibe Kanban `enum CodingAgent { ClaudeCode(ClaudeCode), Codex(Codex), … }`. 각 struct에 `CmdOverrides { base_command_override, additional_params, env }`를 flatten한다(`crates/executors/src/command.rs` L44-63). schemars로 `shared/schemas/<executor>.json`을 만들어 RJSF로 그린다(`crates/server/src/bin/generate_types.rs` L296-352) [소스] | 저장·API·UI가 한 정의에서 나온다 | 프로바이더마다 struct를 유지한다 |
| 프로바이더 중립 typed 공통 칸 + adapter별 spec | AO `AgentConfig{Model, Effort, Mode, Permissions}`, `PermissionMode` = default/acceptEdits/auto/bypassPermissions(`ports/agent.go` L833-842). adapter는 `GetConfigSpec()`로 자기 키를 알린다 [소스] | 공통 칸으로 프로바이더 간 비교가 쉽다 | 모델 이름은 프로바이더 고유라 중립 칸이어도 프로바이더가 바뀌면 무효가 된다. AO는 역할 기본 프로바이더와 같을 때만 모델·mode를 물려받는다(`manager.go` L2313-2337) |
| 판별 union, 생성 때 고정 | Sculptor `AgentConfigTypes`, Emdash 대화별 `pty{autoApprove, model}` / `acp{options}` [소스] | 기록이 스스로 설명된다 | 변경 경로가 없다 |

공통 관찰:

- **[소스] 모델은 어디서나 프로바이더에 종속된다.** Multica는 프로바이더를 바꾸며 모델을 따로 고르지 않으면 "known incompatible" 모델을 비운다. 주석 예가 "Claude Code -> Codex"다(`handler/agent.go` L2221-2230). AO도 프로바이더가 다르면 모델을 물려받지 않는다. Zed는 외부 프로바이더의 모델을 ACP session config option으로만 다룬다.
- **[소스] 모델 목록은 프로바이더가 알려 준다.** Paperclip `listModels`/`detectModel`, `/adapters/:type/models` route. Vibe Kanban `discover_options`. Zed·Emdash는 ACP가 알려 준 option catalog를 쓴다.
- **[소스] 권한 모드는 대부분 "전부 허용"이 기본이다.** Vibe Kanban `default_profiles.json`은 프로바이더마다 `dangerously_skip_permissions`·`danger-full-access`·`yolo` 등을 켠다. Paperclip 새 에이전트 기본도 `dangerouslySkipPermissions: true`다. 권한 모드를 사용자 설정으로 두는 곳(AO·OpenClaw `approve-all|approve-reads|deny-all`)도 있지만, 제품이 강제하는 경계는 아니다.

## 3. adapter 추상화와 capability

### 공통 인터페이스

| 대상 | 인터페이스 | 필수 | 선택 기능을 알리는 방식 |
|---|---|---|---|
| Paperclip | `ServerAdapterModule` | `type`, `execute`, `testEnvironment` | 선택 멤버(`sessionCodec`, `listModels`, `getQuotaWindows`, `loginCapability`, `getRuntimeCommandSpec`…)와 boolean(`supportsLocalAgentJwt`, `supportsInstructionsBundle`, `supportsToolRefreshOnResume`). [types L505-L599](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/packages/adapter-utils/src/types.ts#L505-L599) [소스] |
| Vibe Kanban | `trait StandardCodingAgentExecutor` | `spawn`, `spawn_follow_up`, `normalize_logs`, 취소 token | `enum BaseAgentCapability { SessionFork, SetupHelper, ContextUsage }`, 프로바이더별 하드코딩 표(`crates/executors/src/executors/mod.rs` L58-64, L177-200). Amp·Copilot·Droid는 빈 목록 [소스] |
| AO | `ports.Agent` | launch·prompt 전달·hook | 선택 Go interface(`AgentAuthChecker`, `ActiveTurnSteerer` 등)를 type assertion으로 감지. UI용 enum(`interface.chat`, `session.resume` 등, `backend/pkg/contract/agent.go` L3-15) [소스] |
| Emdash | `definePlugin(metadata, capabilities)` | — | capability마다 zod 서술자. 예: `sessions: {kind: 'resumable' \| 'stateless'}`, `auth` 상태 `authenticated/unauthenticated/unknown`(`packages/core/src/services/agent-plugins/api/plugins/capabilities/sessions.ts` L9-14, `auth.ts` L40-53) [소스] |
| Sculptor | `Harness` ABC | — | `HarnessCapabilities` boolean 15개. "Fields have **no Python defaults** — every constructor must list every field"(`interfaces/agents/harness.py` L59-95) [소스] |
| Nimbalyst | `AIProvider` | — | `AgentCapabilities`에 선택 멤버가 없고 `BUILTIN_AGENT_CAPABILITIES`가 provider 전체를 빠짐없이 덮는 `Record`다. "There is no partial-with-defaults helper on purpose — a permissive default is exactly the hole this closes."(`packages/runtime/src/ai/server/agentCapabilities.ts` L1-30) [소스] |
| Zed | `AgentConnection` | `prompt`, `cancel`, `auth_methods` | `supports_load_session`·`supports_resume_session`·`supports_close_session` 등 기본 `false`. ACP `initialize` 응답으로 채운다(`acp_thread/src/connection.rs` L117-190, `agent_servers/src/acp/v1.rs` L1474-1490) [소스] |
| OpenClaw | `AcpRuntime` | `ensureSession`, `runTurn` | `getCapabilities(): {controls: [...]}`. 지원하지 않는 제어는 `ACP_BACKEND_UNSUPPORTED_CONTROL` 오류 [소스] |

### 없는 기능을 화면에 드러내는 방식

- **숨김이 기본이다. [소스]**
  - Vibe Kanban은 `ContextUsage`가 없으면 context 사용량 gauge를, `SessionFork`가 없으면 fork 동작을 숨긴다(`SessionChatBoxContainer.tsx` L463-467, `DisplayConversationEntry.tsx` L314-319).
  - Zed는 selector가 `None`이면 그리지 않는다. 스레드를 다시 열 때 load → resume 순으로 시도하고, 둘 다 없으면 "Loading or resuming sessions is not supported by this agent."를 보인다(`agent_ui/src/conversation_view.rs` L1410-1437).
- **"없음"과 "0"을 구분한다. [소스]** Nimbalyst는 사용량 신호가 없으면 0%를 그리지 않고 표시 자체를 숨긴다("no usage signal must hide the indicator rather than render a lying 0%").
- **선언을 빠뜨리지 못하게 한다. [소스]** Sculptor·Nimbalyst는 capability에 기본값을 두지 않는다. 새 capability나 새 프로바이더를 더하면 모든 자리를 고치기 전에는 검증·타입 검사가 실패한다. Nimbalyst 주석은 optional 메서드로 감지하던 시절 capability가 조용히 사라진 사고(#1251-#1254)를 이유로 든다. Crystal은 반대 사례다. `CliToolCapabilities`를 선언했지만 아무도 읽지 않는다(`main/src/services/cliToolRegistry.ts` L36-63).
- **[추론]** capability는 "프로바이더 종류의 정적 선언"과 "실행 중 받은 동적 응답(ACP `initialize`)" 두 층이다. 화면 결정(설정 폼에서 steer를 보일지)은 실행 전에 해야 하므로 정적 선언이 필요하다. 동적 응답은 실행 중 세부 조정(MCP 서버를 넘길지 등, Multica `filterACPMcpServersByCapability`)에 쓰인다.

## 4. 프로바이더 변경과 미설치·미로그인

### 이미 있는 에이전트·세션의 프로바이더를 바꿀 때

| 대상 | 허용 | 설정 | 프로바이더 세션 | 제품 기록 |
|---|---|---|---|---|
| Paperclip | 허용(에이전트 PATCH) | 프로바이더별 키는 `{}`로 비운다. `ADAPTER_AGNOSTIC_KEYS`(`env`, `promptTemplate`, `instructionsFilePath`, `cwd`, `timeoutSec`, `graceSec`, `bootstrapPromptTemplate`, `paperclipSkillSync`)와 지침 bundle 키는 남긴다 [소스] | 세션 저장 키에 `adapterType`이 들어 있어 다른 프로바이더 세션을 이어받지 않는다. 설정 fingerprint가 다르면 "Skipping saved session resume because …"로 새로 시작한다. 새 세션에는 작업 댓글로 만든 인계문(`paperclipFreshSessionHandoffMarkdown`)을 넣는다 [소스] | 작업·댓글 유지 |
| Multica | 허용 | 맞지 않는 모델 초기화. 새 프로바이더에 맞지 않는 `thinking_level`은 400 | `PriorSessionID`는 저장 세션의 `RuntimeID`가 지금 작업의 것과 같을 때만 넘긴다(`handler/daemon.go` L3644-3655, L3466-3478). 프로바이더가 바뀐 뒤 아직 전달 전인 작업은 `error_agent_runtime_changed`(409)로 거부 [소스] | 대화 기록 유지 |
| AO | 같은 세션에서 허용 | 대상이 못 쓰는 권한 모드는 대상의 가장 엄격한 모드로 | "starts a fresh native thread seeded with the handoff note: native histories cannot be merged across harnesses"(`session_manager/provider_switch_tui.go` L14-16). 인계문은 서버가 만들고 client에게 받지 않는다(`domain/provider_switch.go` L34-37) [소스] | 유지 |
| Vibe Kanban | 세션 안에서는 거부 | variant·모델은 턴마다 바꿀 수 있음 | 409 `ExecutorMismatch`(`crates/server/src/routes/sessions/mod.rs` L146-161). 같은 workspace에 새 세션을 열어야 한다 [소스] | worktree는 유지, 대화는 새로 |
| Nimbalyst·Zed·Emdash·Sculptor | 메시지가 생긴 뒤 거부 또는 변경 기능 없음 | — | 새 세션·대화·스레드 [소스] | — |

[추론] 프로바이더 세션을 다른 프로바이더로 옮기는 사례는 없다. 갈림은 **바꾸기를 허용하느냐**뿐이다. 세션이 곧 기억인 도구(Vibe Kanban·Zed·Nimbalyst)는 막는다. 제품이 대화·작업 기록을 따로 가진 도구(Paperclip·Multica·AO)는 허용하고 새 세션에 제품 기록을 다시 넣는다.

변경 권한도 좁힌다. Paperclip은 프로바이더 설정을 바꾸는 요청에 별도 관리 권한 검사를 하고, 에이전트가 자기 프로바이더 홈 설정(`homeMode`)을 바꾸면 "Only an operator can configure Runner homeMode."로 거부한다. [agents route L5531-L5590](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/server/src/routes/agents.ts#L5531-L5590) [소스]

### 설치·로그인이 안 됐을 때

- **Paperclip [소스/문서]**
  - `testEnvironment`는 adapter 필수 멤버다. 결과는 `{status: "pass"|"warn"|"fail", checks: [{code, level: info|warn|error, message, detail, hint}]}`이다. [types L303-L320](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/packages/adapter-utils/src/types.ts#L303-L320)
  - route는 `POST /companies/:companyId/adapters/:type/test-environment`다. [agents route L3253-L3256](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/server/src/routes/agents.ts#L3253-L3256)
  - 운영 문서는 "Use the 'Test Environment' button to validate that the agent's adapter config is correct before running"이라고 안내한다. [managing-agents L75](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/docs/guides/board-operator/managing-agents.md#L75)
  - Claude 확인은 cwd·명령 경로·버전·인증 방식(`ANTHROPIC_API_KEY`가 구독 로그인을 덮는다는 경고 포함)을 본 뒤 **실제 모델을 부르는 hello probe**까지 실행한다(45초 기본). 로그인이 필요하면 `claude_hello_probe_auth_required`로 알리고, 화면은 문구가 아니라 고정 code로 로그인 버튼을 판단한다. [claude test L370-L445](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/packages/adapters/claude-local/src/server/test.ts#L370-L445)
- **AO [소스]** `AgentReadinessSnapshot{Installation, Authentication, EffectiveReadiness: ready|not_ready|unknown}`. 주석은 "A credential AO could not verify must not read as ready, and must not block a launch either — unknown does both"이다(`domain/agent_readiness.go` L265-300). 마지막 확인은 실제 실행이다. 설치·업데이트 흐름과 `doctor` 명령이 있다.
- **Emdash [소스]** 설치 상태로 대화 생성을 막고 OS별 설치 명령을 보인다. 로그인은 프로바이더 자신의 login 명령을 터미널에서 실행한다.
- **Vibe Kanban [소스]** `AvailabilityInfo { LoginDetected{last_auth_timestamp}, InstallationFound, NotFound }`(`mod.rs` L205-218). Claude는 `~/.claude.json` 존재로 로그인을 추정한다. `GET /api/agents/check-availability?executor=`.
- **Multica [소스]** daemon이 `exec.LookPath`로 CLI를 찾고 2분마다 다시 찾아 runtime online/offline을 갱신한다(`internal/daemon/agents_refresh.go` L15). 로그인은 미리 확인하지 않는다. 실패 문구("not logged in")로 사후 분류한다(`pkg/taskfailure/classify.go` L161-175).
- **Zed [소스]** 실패를 `LoadError::{Unsupported, FailedToInstall, Exited, Other}`로 나누고, ACP 인증 요구는 프로바이더가 알린 `auth_methods`로 로그인 화면을 띄운다.
- **다른 프로바이더로 자동 대체하는 곳은 없다. [소스/문서]** Zed·Vibe Kanban은 대체 경로가 없다. OpenClaw는 명시한 runtime이 없으면 실행을 거부하고, 시작한 뒤의 실패를 다른 runtime으로 재실행하지 않는다(`docs/concepts/agent-runtimes.md` L188-194). Emdash의 대체는 **새 대화 생성 화면의 기본값**에만 적용된다.

## 5. workspace와 격리

- **[소스/문서] 작업·세션마다 git worktree가 다수다.** Vibe Kanban(작업 workspace), Emdash, AO, Claude Squad, Crystal, Multica의 local worktree mode가 그렇다. Paperclip은 기본이 프로젝트 주 workspace(`workspaceStrategyType: "project_primary"`)이고 격리 실행 workspace를 고를 수 있다. Sculptor는 여러 에이전트가 workspace 하나를 공유할 수 있다.
- **프로바이더 선택은 workspace 모델과 독립이다. [추론]** 어느 레퍼런스도 프로바이더에 따라 workspace 종류를 바꾸지 않는다.
- **프로바이더별 홈 디렉터리 격리가 있다. [소스/문서]** Multica는 작업마다 `CODEX_HOME`을 따로 두고 `~/.codex`의 인증만 symlink한다(`execenv/codex_home.go` L17). OpenClaw도 Codex ACP에 안전한 설정만 복사한 별도 `CODEX_HOME`을 준다. 사용자 개인 설정·기록이 조직 실행에 섞이지 않게 하는 장치다.
- **외부 프로바이더를 OS sandbox로 감싸는 곳은 드물다. [소스/문서]** Zed 문서는 sandbox가 "not External Agents"에 적용된다고 적는다. OpenClaw sandbox는 ACP 실행을 감싸지 않는다. Vibe Kanban에서는 bwrap·landlock·seatbelt를 찾지 못했다. 격리는 프로바이더 자신의 sandbox flag(Codex `sandbox`)나 원격 컨테이너(Nimbalyst Cloudflare, Paperclip runner 환경, mux Docker)에 맡긴다.

## 6. 인증

- **[소스/문서] 기본은 사용자가 이미 로그인한 CLI 계정을 재사용하는 것이다.** 조사한 모든 포함 대상이 그렇다. ACP registry는 항목에 인증 칸을 두지 않는 대신, 등재 CI가 프로바이더의 `initialize` 응답에서 `agent`(프로바이더가 직접 OAuth) 또는 `terminal`(터미널에서 대화형 로그인) 방식을 하나 이상 요구한다(`AUTHENTICATION.md` L7-14).
- **[소스] API key는 env로 넘기는 보조 경로다.** AO는 `ANTHROPIC_API_KEY`가 있으면 `configured`(있지만 검증 안 함)로 보인다. Emdash는 `provider_accounts`+`app_secrets`에 credential 참조를 저장한다. Nimbalyst는 Electron `safeStorage`를 쓴다.
- **[소스] 어느 계정으로 과금되는지가 문제가 된다.**
  - Paperclip 환경 확인은 `ANTHROPIC_API_KEY`가 구독 로그인을 덮는다고 경고한다(`claude_anthropic_api_key_overrides_subscription`).
  - Vibe Kanban은 자식 env에서 `ANTHROPIC_API_KEY`를 빼는 `disable_api_key`를 둔다(`claude.rs` L644-647).
  - Nimbalyst는 API key 경로(`claude-code`)와 구독 CLI 경로(`claude-code-cli`)를 아예 다른 provider ID로 나눠, 세션마다 과금 방식을 고정한다.
- **[소스] 계정 여러 개.** AO `AgentAccountProvider`는 "an account is a config folder of the provider's own CLI"로 Claude·Codex 구독 계정을 여럿 두고 세션을 계정에 묶는다(`domain/agent_account.go` L8-30).
- **[문서] 대상 프로바이더 네 개는 모두 ACP registry에 있다:** `claude-acp`(npx), `codex-acp`(npx), `opencode`(binary), `antigravity-acp`(binary, proprietary). Paperclip의 Antigravity 연동은 아직 pending이다. 공식 ACP server 1.4.3과 고정 패치를 쓰고, macOS ARM64에서만 설치를 확인했으며, admission은 기본으로 닫혀 있다. [DEVELOPING L2187-L2196](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/doc/DEVELOPING.md#L2187-L2196)

## BaboJUBot에 주는 시사점

현재 상태: `RuntimeAdapter`는 `execute` 하나이고 서버는 adapter를 하나만 가진다(`packages/contracts/src/run.ts`). 에이전트에는 프로바이더 설정이 없다. 전역 설정 화면에는 "프로바이더 adapter" 자리만 있다([features](../features.md)). 초기 연구 승인 요청의 팀 구성은 Role 이름·인원이고, 승인하면 snapshot에서 에이전트별 Role·Soul·Skill 사본과 heartbeat 간격을 만든다(`packages/contracts/src/approval.ts`). 지침 bundle 버전이 바뀌면 admission이 `previousSession`을 비운다.

### 권고 1. 프로바이더 설정은 에이전트가 가지고, 생성 때 전역 기본값에서 복사한다 — 채택 후보

- 에이전트마다 `프로바이더 설정`(종류 + 모델 등)을 저장한다. 실행 시도 admission은 이 값으로 adapter를 고른다.
- 전역 설정에는 **Lead용 기본 프로바이더와 작업자용 기본 프로바이더** 두 값을 둔다. 사용자 예시와 같은 모양이고, AO의 `orchestrator`/`worker` 역할 override가 같은 구조다.
- 에이전트를 만들 때 기본값을 **복사**한다. 나중에 전역 기본값을 바꿔도 이미 있는 에이전트는 바뀌지 않는다. 하네스 라이브러리를 바꿔도 이미 있는 사본은 바뀌지 않는 규칙([harness/README](../../harness/README.md))과 같다. 근거는 Paperclip·Multica의 에이전트 열과 Sculptor의 "stamped at creation"이다.
- 배제한 대안: 에이전트 값을 비워 두면 전역 기본값을 실시간으로 따르게 하는 방식. 사용자가 기본값 하나를 바꾸면 모든 에이전트의 세션이 끊기고 과금 계정이 바뀌는데, 에이전트 화면에서는 그 변화가 보이지 않는다.
- 배제한 대안: 작업마다 프로바이더를 고르는 방식. 사용자 결정(에이전트마다)과 다르다. 프로바이더 세션이 작업마다 갈려 에이전트의 연속성이 깨진다. Paperclip도 작업 override로 프로바이더 종류는 바꾸지 못하게 한다.

### 권고 2. Role(`role.json`)에는 프로바이더를 두지 않는다 — 배제. Role 이름별 기본값은 전역 설정 쪽에 — 보류

- [전체 구조](../architecture.md)는 하네스 라이브러리가 "프로바이더와 독립적"이라고 정한다. 프로바이더는 그 기기에 무엇이 설치·로그인돼 있는지에 달린 운영 환경 값이다.
- Paperclip도 이식 가능한 catalog 에이전트(`AGENTS.md`)에는 adapter를 적지 않고, 가져오는 쪽 설정에서 넣는다.
- "코딩 작업자는 Codex"처럼 Role 단위 기본값이 필요해지면 전역 설정에 `Role 이름 → 프로바이더` 표를 더한다. Paperclip 내장 에이전트의 `allowedAdapterTypes`/`defaultAdapterType`, AO 역할 override와 같은 자리다. 지금 Role은 `researcher` 하나라 Lead/작업자 두 값으로 충분하다.

### 권고 3. 초기 연구 승인에서는 사용자가 Role 줄마다 프로바이더를 확인·변경하고, Lead는 고르지 않는다 — 채택 후보

- Lead의 팀 구성 입력(`role`, `count`)은 바꾸지 않는다. Lead가 프로바이더를 제안하는 방식은 **보류**한다. Paperclip `hire_agent`는 에이전트가 제안한 adapter 설정을 사람이 승인하지만, BaboJUBot에서는 프로바이더가 과금 계정과 로그인 상태에 직결되고 그 판단은 사용자 몫이다. Lead가 이유를 들어 특정 프로바이더를 권하고 싶으면 계획 본문에 쓰면 된다.
- 승인 화면에는 Role 줄마다 **적용할 프로바이더**를 보인다. 기본은 전역 작업자 기본값이고 사용자가 줄마다 바꿀 수 있다. 각 줄 옆에는 그 프로바이더의 환경 확인 상태를 둔다.
- 사용자가 고른 값은 승인 결정과 함께 기록한다. 승인 직후 생기는 작업자는 첫 실행 시도부터 그 프로바이더로 돈다. 승인 뒤 에이전트 설정에서 바꾸는 방법만 두면, 첫 작업 할당과 경쟁해 기본 프로바이더로 한 번 돌 수 있다. [추론]
- Lead 자신은 조직 생성 때 전역 Lead 기본값으로 만든다. 조직 생성 폼에서 바꿀 수 있게 하는 것은 같은 원리다.
- 연구 중 작업자 추가(승인 정책이 꺼져 있으면 승인 없이 생성)는 전역 작업자 기본값을 복사하고, 이후 에이전트 설정에서 바꾼다.

### 권고 4. 설정 모양은 프로바이더 종류별 판별 union으로 contracts에 둔다 — 채택 후보. 자유 args·env는 배제(첫 판)

- `executor: { kind: "claude_code" | "codex" | "opencode" | "antigravity", model: string | null, … }`. zod `discriminatedUnion("kind")`로 종류마다 필요한 칸만 typed로 더한다. `model: null`은 프로바이더 기본 모델이다.
- 근거:
  - Vibe Kanban·Sculptor·Emdash·Zed는 typed union이다.
  - Paperclip은 자유 JSON이라 프로바이더를 바꿀 때 남길 키 목록(`ADAPTER_AGNOSTIC_KEYS`)과 비밀값 가리기·복원 코드가 수정 route에 쌓였다.
  - web은 contracts만 보므로 같은 schema로 폼을 그릴 수 있다.
- **자유 `extraArgs`·`env` 칸은 첫 판에서 배제한다.** Multica가 자유 args로 제품이 고정한 권한 모드가 덮이는 것을 막으려고 provider별 blocklist를 둔 것이 그 비용이다. 승인·조직 경계를 제품 코드가 강제한다는 불변 조건상, 프로바이더 권한 flag는 adapter가 정하고 사용자 설정으로 열지 않는다.
- 권한 모드(프로바이더 자신의 도구 승인)를 사용자 설정으로 여는 것은 **보류**한다. 실행 환경 격리와 함께 정할 일이다([구조 문서 강제 표](../architecture.md)). 모델 목록을 프로바이더에서 받아 오기(Paperclip `listModels`)도 **보류**하고, 첫 판은 adapter가 아는 정적 목록 + 직접 입력으로 둔다.

### 권고 5. capability는 adapter마다 빠짐없이 정적으로 선언하고, 없는 기능은 화면에서 숨긴다 — 채택 후보

- contracts에 프로바이더 종류별 capability 표를 둔다. 기본값 없이 모든 칸을 적게 한다(Sculptor·Nimbalyst). 프로바이더를 더하거나 칸을 더하면 타입 검사가 실패해 빠뜨린 자리가 드러난다.
- 지금 계약에서 프로바이더마다 달라질 칸:
  - 세션 재개(`previousSession`을 쓸 수 있는가)
  - steer(구조 문서의 "프로바이더 지원 시")
  - 사용량 보고(`토큰과 비용` / `토큰만` / `없음`, 계약의 `costUsd: nullable`과 대응)
  - 재개 세션에 지침을 다시 넣을 수 있는가
- **취소는 capability가 아니라 필수 약속이다.** 이미 공통 검사(`describeRuntimeContract`)가 adapter마다 확인한다. Paperclip의 `execute`·`testEnvironment`도 필수다.
- 화면 규칙:
  - steer를 지원하지 않으면 그 전달 방식을 보이지 않는다(Vibe Kanban·Zed).
  - 사용량을 보고하지 않으면 0이 아니라 "보고하지 않음"으로 보인다(Nimbalyst).
- 실행 중 받은 ACP `initialize` 응답으로 capability를 고치는 동적 층은 **보류**한다. 프로바이더 연결 방식(전용 adapter·ACP)을 정할 때 함께 본다.

### 권고 6. 프로바이더를 바꾸면 다음 실행 시도부터 새 세션으로 시작하고, 조직 기록은 그대로 맥락에 들어간다 — 채택 후보

- 프로바이더 변경은 사용자만 한다. 에이전트·Lead의 조직 도구로는 바꿀 수 없다(Paperclip의 운영자 전용 검사). 저장하면 Event를 남긴다.
- 진행 중인 실행 시도는 끊지 않는다. 다음 실행 시도부터 새 프로바이더를 쓴다. Role·Soul·Skill 사본 편집이 "다음 실행 시도가 새 내용을 받는" 것과 같은 규칙이다. 즉시 바꾸고 싶으면 사용자가 `실행 중단`을 함께 쓴다.
- 세션 상태에 그것을 만든 프로바이더 종류를 함께 저장한다. 종류가 다르면 admission이 `previousSession`을 비운다. 지침 bundle 버전 규칙과 같은 자리이고, 근거는 Paperclip 세션 키의 `adapterType`과 Multica `RuntimeID` 비교다.
- 모델을 따로 고르지 않았으면 `model`을 프로바이더 기본값(`null`)으로 되돌린다(Multica "Claude Code -> Codex").
- 별도 인계문은 만들지 않는다. Paperclip·AO는 프로바이더 세션이 사실상 유일한 기억이라 인계문이 필요했다. BaboJUBot은 대화·작업·연구 기록을 실행 맥락(`RunContext`)으로 매번 넣으므로 새 세션도 그 기록을 받는다. 맥락 묶음에 무엇이 빠지는지는 기억 설계(판 4)에서 다시 본다. [추론]
- 배제한 대안: Vibe Kanban·Nimbalyst처럼 시작한 에이전트의 프로바이더 변경을 막는 방식. 그 도구들은 세션이 곧 대화라 막는 것이고, BaboJUBot 에이전트는 조직 기록을 가진 오래 사는 구성원이라 막을 이유가 약하다. 사용자 결정(에이전트마다 선택)에도 맞지 않는다.

### 권고 7. 환경 확인은 adapter 필수 기능으로 두고, 모델을 부르지 않는 확인과 부르는 확인을 나눈다 — 채택 후보. 다른 프로바이더로 자동 대체는 배제

- adapter에 `execute`와 함께 `checkEnvironment()`를 필수로 둔다(Paperclip). 결과는 `준비됨 / 준비 안 됨 / 알 수 없음`과 확인 항목 목록(고정 code, 수준, 한국어 문구, 해결 방법)이다. 화면은 문구가 아니라 code로 판단한다(Paperclip `ADAPTER_AUTH_MISSING_CHECK_CODE`).
- 확인 단계를 나눈다.
  1. 설치·버전·로그인 상태처럼 **모델을 부르지 않는 확인**. 전역 설정 프로바이더 목록, 승인 화면, 에이전트 설정에서 자동으로 보인다.
  2. **실제 모델 호출 확인**(Paperclip hello probe). 비용·구독 한도를 쓰므로 사용자가 누르는 `시험 실행` 버튼으로만 한다. 이 구분은 "실제 모델 호출 전 계정·자격 증명·비용 권한을 확인"하는 불변 조건을 따른다.
- `알 수 없음`은 막지 않는다(AO). `준비 안 됨`인 프로바이더도 저장은 허용하되 승인 화면·에이전트 설정에서 경고한다. 그 상태로 실행 시도가 시작되면 프로바이더 오류로 실패하고, 실패 사유가 Inbox의 실패한 실행 시도로 온다. 이미 있는 경로다.
- **다른 프로바이더로 자동 대체는 배제한다.** 레퍼런스 어디에도 실행 시점 대체가 없다(Zed·Vibe Kanban·OpenClaw). 대체하면 사용자가 모르는 사이 과금 계정과 세션이 바뀐다. Emdash식 "생성 화면의 기본값을 설치된 것으로 바꿔 제안"은 승인 화면 기본값에 한해 **보류**한다.
- 설치 자동화(Zed registry 자동 설치, `paperclipai runtime setup`)는 **보류**한다. 첫 판은 설치·로그인 방법을 안내만 한다. 로그인 같은 일은 이미 있는 개념인 사용자 할 일이 될 수 있다.

### 권고 8. 인증은 호스트에 로그인된 CLI를 재사용하고, 어느 계정으로 과금되는지 환경 확인에 보인다 — 채택 후보. API key 저장은 보류

- 모든 레퍼런스의 기본이 CLI 로그인 재사용이다. 첫 판은 API key를 저장하지 않는다. 전역 설정의 `비밀값` 자리가 생길 때 다시 본다.
- 프로바이더 자식 프로세스에 넘기는 env는 adapter가 허용 목록으로 만든다. 공급자 API key 변수(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` 등)가 호스트 env에 있으면 환경 확인이 "구독 로그인 대신 API key로 과금됨"을 경고한다(Paperclip). 기본으로 뺄지(Vibe Kanban `disable_api_key`)는 첫 실제 adapter에서 정한다.
- 프로바이더 홈 디렉터리를 조직·실행 시도마다 나누는 것(Multica·OpenClaw의 `CODEX_HOME`)은 **보류**한다. 조직 간 프로바이더 세션·기억이 섞이지 않는지와 함께 판 2 프로바이더 연결 조사에서 정한다.

### 권고 9. workspace와 OS 격리는 프로바이더 선택과 따로 정한다 — 보류

- 레퍼런스는 프로바이더와 무관하게 workspace를 정한다. BaboJUBot도 지금처럼 연구 환경 workspace(`workspace.cwd`)를 프로바이더와 독립으로 둔다.
- 외부 프로바이더를 OS sandbox로 감싸는 레퍼런스가 거의 없다. 그래서 프로바이더 선택 화면이 격리를 약속하면 안 된다. 격리는 [구조 문서](../architecture.md)가 남긴 "실행 환경 격리와 함께 다시 정합니다"의 범위다.

### 부수 관찰 — 판 2 연결 방식 조사에 넘김

- 대상 프로바이더 네 개가 모두 ACP registry에 등재돼 있다. Antigravity는 ACP 경로가 사실상 유일한 공개 연결 후보로 보인다(Paperclip도 ACP server로 연동 중). [문서/추론]
- [GLOSSARY](../../GLOSSARY.md)에 "프로바이더"와 "프로바이더 설정" 정의가 없다. 구현 전에 [도메인 규칙](../agents/domain.md)에 따라 더할 후보다.

## 검증 결과와 한계

- **메인 조사자가 원문을 직접 열어 확인한 것:**
  - Paperclip 인용 전부: agent 스키마, instance 비활성 adapter, 기본값 세 자리, issue override schema, `ServerAdapterModule`·환경 확인·form schema 타입, 수정 route의 프로바이더 변경 분기, `ADAPTER_AGNOSTIC_KEYS`, 세션 준비의 reset·인계문, 세션 키, Claude 환경 확인의 hello probe와 인증 code, 운영 문서, Antigravity 문서
  - Vibe Kanban `ExecutorMismatch`·capability 표·`AvailabilityInfo`
  - Multica 모델 초기화와 `RuntimeID` 비교 재개, runtime 표
  - AO `effectiveHarness`·`effectiveAgentConfig`·`SwitchTUIProvider` 주석·`ProviderSwitchRequest`·`EffectiveAgentReadiness`
  - Emdash provider 선택·`sessions`/`auth` 서술자
  - Zed capability 메서드 위치·`LAST_USED_AGENT_KEY`·미지원 문구
  - Sculptor `HarnessCapabilities`, Nimbalyst 전환 차단과 capability 주석, ACP registry 항목 목록
- **저장소별 읽기 전용 탐색 보조 agent가 찾고 메인이 다시 열지 않은 것:**
  - Claude Squad·agentapi·Crystal 세부
  - OpenClaw config·acpx·문서 줄 번호
  - Hermes·mux 제외 근거의 줄 번호
  - Multica daemon 탐지 주기·실패 분류·`CODEX_HOME`
  - AO 계정·doctor
  - Emdash 설정 schema·`provider_accounts`
  - Sculptor 인증·최근 사용 기본값
  - Nimbalyst 인증·가용성
  - Vibe Kanban UI 숨김 위치·schema 생성·`disable_api_key`
  - Zed 설정 schema·registry 설치·오류 종류
  - 위 항목은 [소스]로 표기했지만 메인 재확인 범위 밖이다.
- **실행하지 않았다.** 설치·빌드·실행·실제 모델 호출·환경 확인 실행은 하지 않았다. "확인 단계가 존재한다"는 코드 판단이고 실제 동작은 확인하지 않았다. 특히 Paperclip Claude hello probe가 쓰는 비용·구독 한도는 [미확인]이다.
- **화면 동작은 코드에서 추론했다.** Emdash·AO의 capability가 실제로 어떤 화면 요소를 숨기는지는 추적하지 않았다. [미확인]
- **실행 시점 대체.** OpenClaw `acp.fallbacks`(backend 수준 UNAVAILABLE 대체)는 help 문구만 읽었고 실행 경로는 보지 않았다. [미확인]
- **문서와 소스가 어긋난 곳.** Vibe Kanban 문서는 PLAN 등 variant를 보이지만 이 SHA의 `default_profiles.json`에는 `DEFAULT`만 있다.
- **라이선스.** Zed 해당 crate(GPL-3.0)·Claude Squad·mux(AGPL-3.0)는 코드 복사 대상이 아니다. Multica는 Apache-2.0에 추가 조건이 붙어 있어 복사 전 확인이 필요하다. 이 문서는 코드를 복사하지 않았다.
- **이 문서의 범위 밖.** 프로바이더 연결 방식(전용 adapter·ACP), 지침·조직 도구 주입, 프로바이더별 세션 재개 세부, 실행 환경 격리 설계.
- **문서 지도.** 지시 범위상 [문서 지도](../README.md)의 조사 기록 표에 이 문서를 더하지 않았다. 채택 시 함께 갱신해야 한다.
