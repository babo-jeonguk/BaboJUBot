# 에이전트 실행 모델 조사: 실행 시도 하나를 어떻게 돌리고 역할·skill·도구를 어떻게 주입하는가

확인일: 2026-10-13. 질문은 네 가지다. (1) 프로젝트가 LLM 도구 루프를 직접 소유하는가, 외부 실행 도구(Claude Code, Codex 등)를 adapter로 구동하는가. (2) 역할·성격·skill·기억을 어디에 저장하고 실행 맥락에 어떻게 조립하는가. (3) 에이전트가 오케스트레이터를 어떻게 다시 호출하며, 조직 범위를 credential로 묶는가 에이전트가 고르는가. (4) 실행 시도를 어떻게 시작·중단·일시정지·취소하며, 실행 시도 사이의 세션을 어떻게 이어 가는가.

용어는 [공통 용어](../../GLOSSARY.md)를 따른다. 이 문서에서 Claude Code, Codex CLI, Hermes, Grok Build처럼 모델 호출과 도구 루프를 실제로 수행하는 프로그램은 **실행 도구(executor)**, 그 프로그램의 대화 기록은 **실행 도구 세션**이라고 부른다. GLOSSARY는 실행 도구의 프로세스·세션을 「에이전트」라고 부르지 않도록 정하고 있다. 기존 조사인 [Paperclip 1차 조사](paperclip.md), [초기 구조 참고 조사](reference-code-structure.md), [비교 후보 목록](comparative-survey.md)의 결론은 반복하지 않고 실행 경계만 깊게 본다.

## 기준 버전과 조사 방식

| 대상 | 기준 | 비고 |
|---|---|---|
| Paperclip | [`1b4c803816e82b0265c8422e1a804327a7ed8c54`](https://github.com/paperclipai/paperclip/tree/1b4c803816e82b0265c8422e1a804327a7ed8c54) | 기존 조사와 같은 SHA, MIT |
| Hermes Agent | [`3569e8461ea721623fa16e6f01fb636157989fe6`](https://github.com/NousResearch/hermes-agent/tree/3569e8461ea721623fa16e6f01fb636157989fe6) | 기존 조사와 같은 SHA, MIT |
| OpenClaw | [`80f170ea263a21187384cb67d5aead87b1d01fc2`](https://github.com/openclaw/openclaw/tree/80f170ea263a21187384cb67d5aead87b1d01fc2) | 기존 조사와 같은 SHA, MIT |
| Grok Build (`xai-org/grok-build`) | [`2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8) | 2026-09-29 commit, GitHub metadata상 Apache-2.0. README에 따르면 사내 monorepo에서 주기적으로 동기화된다 |
| Grok Bot, Grok Multi Agent API | docs.x.ai 공식 문서 (2026-10-13 열람) | 공개 소스 없음 |
| Claude Agent SDK, OpenAI Agents SDK, ACP | 공식 문서 (2026-10-13 열람) | 설계 공간을 보여 주려고 추가했다 |

조사 방식: 공개 저장소를 `/tmp/agentrt/<name>`에 고정 SHA로 shallow fetch해 정적으로만 읽었다. 설치, 빌드, 실행, 실제 모델 호출은 하지 않았다. Paperclip·Hermes·OpenClaw는 저장소별 읽기 전용 탐색 보조 agent가 후보 위치를 찾았다. 아래 결론에 쓴 핵심 줄은 메인 조사자가 원문을 다시 열어 확인했다. 재확인 범위는 [검증 결과와 한계](#검증-결과와-한계)에 적었다.

근거 수준 표기: **[소스]** 고정 SHA 코드를 읽은 사실, **[문서]** 공식 문서·README·설계 문서의 주장, **[추론]** 위 근거에서 끌어낸 판단, **[미확인]** 공개 자료로 확인할 수 없는 것.

## 핵심 판단

| 대상 | 1. 루프 소유 | 2. 역할·skill 주입 | 3. 오케스트레이터 회귀와 범위 결합 | 4. 실행 제어와 세션 |
|---|---|---|---|---|
| Paperclip | **루프 없음.** 모든 실행을 외부 실행 도구에 맡기는 control plane이다(CLI 프로세스, HTTP/WS gateway, 실험적 native runner의 ACP/app-server 드라이버) | DB가 관리하는 instructions bundle(`AGENTS.md` 진입)을 실행 시도마다 복사한다. 실행 도구의 고유 경로로 주입한다(`--append-system-prompt-file`, skills symlink, env overlay) | 실행 시도별 JWT(agent·company·run claim)를 `PAPERCLIP_API_KEY`로 넘긴다. 서버가 회사 일치를 강제한다. REST 외에 MCP도 제공한다 | wake queue → 실행 시도. 취소는 AbortController 후 SIGTERM→SIGKILL. 세션은 (company, agent, adapter, task) 키로 저장하고 조건부로 재개한다 |
| Hermes Agent | **자체 루프.** `AIAgent`가 OpenAI 호환·Anthropic·Bedrock 등을 직접 호출한다. ACP 서버로 자신을 외부에 노출한다 | `SOUL.md`(HERMES_HOME) → 지침 → 맥락 파일(AGENTS.md 등) → skill 목록 → 기억 snapshot을 3단으로 조립하고 세션 동안 고정한다 | 오케스트레이터 개념이 없다. 외부에서 HTTP API(`/v1/runs`, 인스턴스 단위 Bearer key)나 CLI로 구동한다. 범위는 profile(=HERMES_HOME) 단위다 | interrupt/stop API, SQLite 세션과 `--resume`, 압축 시 세션 분할 |
| OpenClaw | **자체 루프가 기본이다.** `packages/agent-core`의 루프가 모델을 직접 호출한다. 부차 경로로 CLI backend(claude-cli 등), Codex app-server harness, ACP(acpx)를 구동한다 | agent별 workspace의 `AGENTS.md`·`SOUL.md`·`IDENTITY.md`·`USER.md`·`MEMORY.md`를 크기 제한을 두고 system prompt에 삽입한다. skill은 목록만 넣는다. 실험적 `CLAW.md` 역할 패키지가 있다 | 같은 프로세스 안 gateway 도구(`sessions_spawn`, `sessions_send`)를 쓴다. 범위는 credential이 아니라 **config 정책**(allowAgents, visibility, agentToAgent)으로 정한다 | session lane 큐, `/stop` abort, SQLite 세션, compaction, reset 정책, 30분 heartbeat |
| Grok Build | **자체 루프**(Rust, chat/completions 직접 호출). headless `-p`와 ACP 서버 모드를 제공해 다른 오케스트레이터에 구동된다 | AGENTS.md/CLAUDE.md 계열과 rules 디렉토리, `SKILL.md` skill, agent 정의·persona 파일 | 자체 오케스트레이터 회귀 개념은 없다. ACP 클라이언트(예: Paperclip)가 MCP를 붙여 회귀 경로를 제공한다 | ACP `session/cancel`, `--resume`/`--fork-session`, `~/.grok/sessions` |
| Grok Bot | **[미확인]** 호스팅 제품. 지속 클라우드 컴퓨터에서 Bot이 일한다고 문서가 설명한다 | Bot 프로필의 description, 대화, 계정 공용 skill 라이브러리, Bot별 기억 | API·MCP 노출이 문서에 없다. 권한은 소유 사용자를 넘지 못하며 Bot들은 컴퓨터를 공유한다 | 메시지로 시작하고 "Stop now" 메시지로 멈춘다. routine을 일시정지할 수 있다 |

## 1. Paperclip: 루프 없는 control plane과 adapter 계약

### 1.1 실행 모델

- **[소스]** 내장 adapter는 `registerBuiltInAdapters`에서 등록한다. `claude_local`, `codex_local`, `cursor`, `gemini_local`, `grok_local`, `kimi_local`, `opencode_local`, `pi_local`, `hermes_local`(로컬 CLI 프로세스), `hermes_gateway`(HTTP/SSE), `openclaw_gateway`(WebSocket), `cursor_cloud`(호스팅), 범용 `process`·`http`, 실험적 `paperclip_runner`가 있다. [registry](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/adapters/registry.ts#L892-L913)
- **[문서]** runner ADR은 경계를 이렇게 적는다. "Paperclip is a control plane. It owns companies, agents, issues, budgets, approvals, and durable workflow state. Agent providers remain execution services." 기존 direct adapter는 runner를 거치지 않는다. [paperclip-runner ADR](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/doc/architecture/paperclip-runner.md#L10-L35)
- **[소스/문서]** 기존 노트가 말한 "native runtime"은 자체 LLM 루프가 아니다. Rust `paperclip-runnerd`가 Codex app-server, OpenCode server, ACPX(ACP 에이전트), Claude Managed Agents, AWS AgentCore 같은 외부 실행 도구를 감독하고, 그 이벤트를 공급자 중립 프로토콜(PRP)로 번역한다. OpenCode 드라이버의 `/chat/completions` 코드는 credential을 보관하는 프록시다. [ADR topology](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/doc/architecture/paperclip-runner.md#L60-L76), [native MCP binding](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/paperclip-runner/src/drivers/native-mcp.ts#L1-L40)
- **[추론]** 조사 범위(registry, adapters, paperclip-runner의 drivers/backends)에서 Paperclip이 모델 API를 직접 호출하며 도구 루프를 돌리는 경로는 확인하지 못했다. 에이전트의 "지능"은 전부 실행 도구가 맡고, Paperclip은 맥락 주입·권한·기록·수명 주기를 맡는다.

### 1.2 adapter 계약 (`packages/adapter-utils/src/types.ts`)

- **[소스]** `ServerAdapterModule`의 필수 멤버는 `type`, `execute(ctx)`, `testEnvironment`다. 선택 멤버로 `sessionCodec`, `listSkills`/`syncSkills`, `supportsLocalAgentJwt`, `supportsInstructionsBundle`, `runtimeToolDelivery`(`native_mcp`/`environment`/`invocation_context`), 모델 목록, quota 조회 등이 있다. [ServerAdapterModule](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapter-utils/src/types.ts#L503-L597)
- **[소스] 입력 `AdapterExecutionContext`:**
  - 식별: `runId`, `agent{id, companyId, name, adapterType, adapterConfig}`, `agentIdentity`(Ed25519 키쌍)
  - 세션: `runtime{sessionId, sessionParams, sessionDisplayId, taskKey}`
  - 설정과 맥락: `config`, `context`(wake 이유, task, workspace)
  - 제어: `signal: AbortSignal`, `onSpawn({pid, processGroupId})`
  - 회귀 경로: `authToken`, `runtimeMcp.getServers()`, `runtimeTools`
  - 관찰 콜백: `onLog`, `onEvent`, `onUsage`, `onMeta`

  [AdapterExecutionContext](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapter-utils/src/types.ts#L237-L294)
- **[소스] 출력 `AdapterExecutionResult`:**
  - 종료: `exitCode`, `signal`, `timedOut`, `errorCode`/`errorFamily`/`retryNotBefore`
  - 사용량·비용: `usage`/`usageByModel`, `costUsd`/`costStatus`, `provider`/`model`/`billingType`
  - 세션: `sessionParams`/`sessionDisplayId`, `clearSession`
  - 결과: `summary`, `resultJson`, `question`

  세션 직렬화는 `AdapterSessionCodec{serialize, deserialize, getDisplayId}`가 맡는다. [AdapterExecutionResult](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapter-utils/src/types.ts#L102-L181)

### 1.3 역할·지침·skill·기억의 주입

- **[소스]** 에이전트 지침은 "instructions bundle"이다. 기본 진입 파일은 `AGENTS.md`이고 `managed`/`external` 모드, `promptTemplate`이 있다. 예전의 `bootstrapPromptTemplate`은 deprecated다. [agent-instructions](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/agent-instructions.ts#L10-L17) CEO 기본 bundle에는 `SOUL.md`·`HEARTBEAT.md`·`TOOLS.md`도 들어 있다. [default instructions](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/default-agent-instructions.ts#L3-L27)
- **[소스]** heartbeat는 실행 시도마다 bundle의 작업 사본을 만들고 그 경로를 `instructionsFilePath`로 넘긴다. [heartbeat](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/heartbeat.ts#L4414) 기본 prompt template은 `"You are agent {{agent.id}} ({{agent.name}})."`에 연결 안내를 붙인 정도다. 코드 주석은 "operational procedures live in the harness-delivered Paperclip skill"이라고 적는다. 운영 절차는 prompt가 아니라 skill로 전달한다는 뜻이다. [server-utils](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapter-utils/src/server-utils.ts#L212-L221)
- **[소스] 실행 도구별 주입 방식은 각 도구의 고유 경로를 따른다.**
  - `claude_local`: 새 세션일 때만 `--append-system-prompt-file`을 붙인다. 재개 시에는 "instructions are already in the session cache"라 생략한다. skill은 bundle 디렉토리의 `.claude/skills/`에 symlink하고 `--add-dir`로 노출한다. Paperclip MCP 서버는 `--mcp-config … --strict-mcp-config`로 붙인다. [claude execute](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapters/claude-local/src/server/execute.ts#L850-L883)
  - `hermes_local`: 지침과 API 안내를 env `HERMES_EPHEMERAL_SYSTEM_PROMPT`로 넘긴다. 코드 주석에 따르면 Hermes가 이 overlay를 매 API 호출에 적용하고 대화 기록에는 저장하지 않는다. task는 `hermes chat -q`로 넘기고 `--yolo`, `--resume`을 붙인다. [hermes overlay](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapters/hermes/src/server/execute.ts#L94-L96), [args·env](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapters/hermes/src/server/execute.ts#L441-L508)
  - `grok_local`: `grok --cwd … --output-format streaming-json [--resume id] [--rules @지침] --single <prompt>`로 Grok Build CLI를 실행한다. skill은 workspace `.claude/skills`에 복사한다. [grok args](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapters/grok-local/src/server/execute.ts#L555-L570)
- **[소스/추론]** 기억은 별도 서브시스템이 아니다. `skills/para-memory-files` 같은 skill과 파일 규칙으로 제공된다(탐색 보조 보고, 메인은 디렉토리 존재만 재확인). 기억은 실행 도구 세션과 파일에 의존한다.

### 1.4 오케스트레이터 회귀와 범위 결합

- **[소스]** 실행 시도마다 HS256 JWT를 발급한다. claim은 `sub`=agentId, `company_id`, `adapter_type`, `run_id`, `responsible_user_id`이고 기본 수명은 48시간이다. 서명 키는 instance·company별로 파생한다(`jwt:${instanceId}:${companyId}`). [agent-auth-jwt](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/agent-auth-jwt.ts#L51), [키 파생](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/agent-auth-jwt.ts#L90-L92), [발급 조건](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/heartbeat/runtime-execution.ts#L236-L250)
- **[소스]** 토큰은 env `PAPERCLIP_API_KEY`로만 전달한다. adapter 설정으로 이 값을 덮어쓸 수 없다. 함께 넘기는 값은 `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`다. Hermes adapter 주석: "PAPERCLIP_API_KEY is never accepted from config — the harness-minted run token is the only source of Paperclip API identity." [hermes env](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapters/hermes/src/server/execute.ts#L503-L508), [buildPaperclipEnv](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapter-utils/src/server-utils.ts#L3216-L3246)
- **[소스] 범위는 credential로 묶인다.** 인증 middleware는 다음 요청을 거부한다.
  - 토큰의 `run_id`와 다른 `X-Paperclip-Run-Id` 헤더(`agent_jwt_run_id_mismatch`)
  - 취소된 실행 시도의 쓰기(`agent_run_cancelled`)

  인증이 끝나면 `req.actor.companyId`는 claim에서 온다. [auth middleware](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/middleware/auth.ts#L382-L411) route의 `assertCompanyAccess`는 `req.actor.companyId !== companyId`이면 "Agent key cannot access another company"를 던진다. [authz](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/routes/authz.ts#L75-L79) 따라서 에이전트가 path나 body에 다른 회사 ID를 넣어도 이 검사를 호출하는 route에서는 거부된다. 모든 route가 이 검사를 호출하는지는 전수 감사하지 않았다.
- **[소스/문서]** 호출 수단은 세 가지다. (1) `skills/paperclip/SKILL.md`가 가르치는 curl+Bearer REST. (2) 실행 시도별 MCP 서버. `packages/mcp-server`는 "thin MCP wrapper over the existing Paperclip REST API"다. [mcp-server README](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/mcp-server/README.md) (3) native runner의 semantic tools. runner ADR에 따르면 runnerd는 company·agent·issue·run·session·turn에 묶인 일회용 bootstrap ticket만 받고 "never receives a broad Paperclip API key"다. 서버는 그 실행 시도에 허가된 operation만 discovery에 노출한다("catalog presence does not grant authority"). [trust boundary](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/doc/architecture/paperclip-runner.md#L157-L163), [semantic actions](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/doc/architecture/paperclip-runner.md#L184-L200)
- **[소스] 한계:** 로컬 CLI adapter는 `--dangerously-skip-permissions`(claude), `--yolo`(hermes), `--always-approve`(grok)처럼 실행 도구의 도구 승인을 끈다. 이때 실행 도구 안의 shell·파일 접근은 실행 환경 격리에만 기대고, Paperclip이 강제하는 것은 Paperclip API 호출뿐이다. [hermes `--yolo` 주석](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapters/hermes/src/server/execute.ts#L470-L475)

### 1.5 시작·중단·세션

- **[소스]** 시작: `enqueueWakeup`으로 wake queue에 넣고 claim한 뒤 adapter를 호출한다(queue.ts). 일시정지: `POST /agents/:id/pause`가 `pauseAgent` 후 `cancelActiveForAgent`를 호출한다. 이후 paused 에이전트는 invokable이 아니다. 취소: `POST /heartbeat-runs/:runId/cancel` → `cancelRunInternal`이 AbortController, native 세션 취소, 프로세스 그룹 종료 순으로 진행한다. timeout은 SIGTERM을 보내고 `graceSec` 뒤 SIGKILL을 보낸다. [pause route](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/routes/agents.ts#L5401-L5425), [cancel route](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/routes/agents.ts#L6791-L6801), [cancelRunInternal](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/heartbeat/run-control.ts#L874), [timeout](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapter-utils/src/server-utils.ts#L4862-L4875)
- **[소스] 세션 연속성:**
  - 저장: `agent_task_sessions`가 (company, agent, adapterType, taskKey)마다 codec이 직렬화한 세션 값을 보관한다. [schema](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/db/src/schema/agent_task_sessions.ts#L16-L45)
  - 새 세션 강제: `forceFreshSession`, 담당 변경 같은 wake 이유. [run-state](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/heartbeat/run-state.ts#L770-L788)
  - 회전 기준: 기본 200회·2M 입력 토큰·72시간에 세션을 바꾼다. 문맥을 스스로 관리하는 실행 도구는 예외다. [session-compaction](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapter-utils/src/session-compaction.ts#L23-L37)
  - Claude 재개 조건: prompt bundle key, cwd, 실행 대상이 같을 때만 `--resume`한다. 알 수 없거나 손상된 세션이면 새 세션으로 재시도하고 `clearSession`을 반환한다. [claude resume 조건](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/adapters/claude-local/src/server/execute.ts#L776-L797)

## 2. Hermes Agent: 자체 루프를 가진 단일 에이전트 실행 도구

- **[소스] 루프:** `AIAgent.run_conversation`이 `conversation_loop.py`의 반복을 돈다. 반복 조건은 `api_call_count < max_iterations and iteration_budget.remaining > 0`이다. 매 반복은 요청 조립 → API 재시도 루프 → 응답 정규화 → 도구 호출이 있으면 tool round, 없으면 종료 순서다. [loop](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/agent/conversation_loop.py#L1648-L1696) API 방식은 `chat_completions`, `codex_responses`, `anthropic_messages`, `bedrock_converse`, `codex_app_server`다. 마지막 방식만 Codex 하위 프로세스에 턴 전체를 맡긴다. [api modes](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/agent/agent_init.py#L379-L433)
- **[소스] 외부 노출:** `acp_adapter`는 Hermes를 ACP 서버로 노출한다("ACP Agent implementation wrapping Hermes AIAgent"). 다른 ACP 에이전트를 소비하는 쪽이 아니다. [acp server](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/acp_adapter/server.py#L233-L234) Claude Code·Codex 구동은 bundled skill이 `terminal` 도구로 `claude -p …`를 실행하라고 가르치는 정도이며, 전용 adapter는 없다(탐색 보조 보고).
- **[소스] system prompt 조립:** 세션당 한 번 만들고 context 압축 때만 다시 만든다. 세 단으로 나뉜다.
  - stable: SOUL.md 또는 기본 identity, 지침, coding brief
  - context: 호출자 system message, 맥락 파일
  - volatile: skill 목록, 기억, USER.md, 날짜

  [system_prompt.py](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/agent/system_prompt.py#L1-L8) 세부:
  - SOUL.md는 `get_hermes_home()/SOUL.md`에서 읽는다. [load_soul_md](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/agent/prompt_builder.py#L1653-L1697)
  - 맥락 파일은 `.hermes.md` → `AGENTS.md` 체인 → `CLAUDE.md` → `.cursorrules` 중 처음 찾은 한 종류만 쓴다. [build_context_files_prompt](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/agent/prompt_builder.py#L1857-L1883)
  - skill은 목록만 넣고 본문은 `skill_view` 도구로 연다. [skills prompt](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/agent/prompt_builder.py#L1361-L1389)
  - 기억(`MEMORY.md`, `USER.md`)은 세션 시작 시점의 고정 snapshot이다. 세션 중 쓰기는 디스크에만 반영된다. [memory_tool](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/tools/memory_tool.py#L1-L5)
  - `ephemeral_system_prompt`는 API 호출 때만 주입되고 캐시나 기록에 남지 않는다. Paperclip의 overlay가 이 경로를 쓴다.
- **[소스] 하위 작업자:** `delegate_task`는 새 `AIAgent`를 만든다. 자식은 `skip_context_files=True`, `skip_memory=True`이고 별도 session_db·예산을 받으며, 부모의 toolset에서 차단 도구를 뺀 것만 쓴다. 기본 깊이 1, 동시 10, 반복 250이다. 부모는 요약만 받는다. [delegate_tool](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/tools/delegate_tool.py#L1-L11), [child 생성](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/tools/delegate_tool.py#L273-L285)
- **[소스] 외부 구동과 범위:** API server는 `POST /v1/runs`, `GET …/events`(SSE), `POST …/approval|steer|stop`을 제공한다. [runs routes](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/gateway/platforms/api_server_runs.py#L234-L240) 인증은 인스턴스 단일 `API_SERVER_KEY` Bearer다. [_check_auth](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/gateway/platforms/api_server.py#L1559-L1578) 격리 단위는 profile이다. profile마다 `HERMES_HOME`이 달라 memories·sessions·skills·cron이 분리된다. [profiles](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/hermes_cli/profiles.py#L1-L40) **[추론]** Hermes 자체에는 조직이나 실행 시도 단위 권한 개념이 없다. 연구 조직별 격리를 Hermes로 하려면 조직마다 profile이나 프로세스를 나누고, 조직 범위 강제는 바깥의 control plane이 맡아야 한다.
- **[소스] 세션:** SQLite `state.db`(FTS5 검색). context 압축 때 `parent_session_id`로 세션을 나눈다. `--resume`/`-c`로 재개하며, 재개 시 저장된 system prompt를 복원한다. [hermes_state](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/hermes_state.py#L1-L5)

## 3. OpenClaw: 자체 루프와 gateway, config 기반 다중 에이전트

- **[소스] 루프:** `runAgentLoop`이 모델 응답 stream → 도구 실행 → steering·대기 메시지 주입을 반복한다. [agent-loop](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/packages/agent-core/src/agent-loop.ts#L87-L120), [main loop](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/packages/agent-core/src/agent-loop.ts#L221-L330) 모델 호출은 `llmRuntime.streamSimple`로 직접 한다. [sdk.ts](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/agents/sessions/sdk.ts#L220-L240)
- **[문서/소스] 외부 실행 도구:** 공식 문서는 두 계열을 구분한다. "Embedded harnesses"(openclaw, 플러그인 codex·copilot)와 "CLI backends"(claude-cli 등)다. [agent-runtimes](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/concepts/agent-runtimes.md#L31-L40) embedded 경로에서 CLI backend로 자동 전환하는 조건은 좁다. `cliBackendDispatch === "subscription-auth"`이고 이름이 지정된 도구 allowlist가 있어야 한다. [cli-backend-dispatch](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/agents/embedded-agent-runner/cli-backend-dispatch.ts#L21-L51) ACP 에이전트는 `extensions/acpx`가 구동한다.
- **[소스] runner 계약:**
  - 입력: `workspaceDir`, `agentDir`, `prompt`, `extraSystemPrompt`, `skillsSnapshot`, `sessionId/sessionKey`, `agentId`, `runId`, `timeoutMs`, `abortSignal`, 모델 옵션, `toolsAllow`
  - 출력: `payloads[]`와 `meta`(usage, costUsd, stopReason, `executionTrace.runner: "embedded"|"cli"`)

  [shared-types](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/agents/command/shared-types.ts#L136-L213), [result types](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/agents/embedded-agent-runner/types.ts#L44-L118)
- **[소스] 역할·기억 파일:** workspace bootstrap 파일은 `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`, `MEMORY.md`다. 기존 조사에 있던 `TOOLS.md`·`HEARTBEAT.md`는 이 SHA에서 retired 상태다. 템플릿 문서가 retired를 명시하고, doctor가 각각 AGENTS.md와 cron scratch로 옮긴다. [bootstrap policy](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/agents/workspace-bootstrap-policy.ts#L20-L36), [TOOLS 템플릿](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/reference/templates/TOOLS.md) 세션 종류별로 파일을 거른다. subagent는 `AGENTS.md`만, cron은 AGENTS·SOUL·IDENTITY·USER만 받는다. [workspace.ts](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/agents/workspace.ts#L961-L1019) 파일당 20,000자, 합계 60,000자로 자르고 `# Project Context` 아래에 삽입한다(탐색 보조 보고, bootstrap.ts·system-prompt.ts).
- **[소스] skill:** system prompt에는 `<available_skills>`의 name·description·location만 들어간다. 본문은 모델이 `read`로 연다. 자격 조건(OS, bin, env, config)을 맞추지 못한 skill은 빠진다. [skill-contract](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/skills/loading/skill-contract.ts#L98-L127)
- **[문서] 역할 패키지:** 실험적 `CLAW.md`는 YAML frontmatter(agent id·이름·설명·identity·bootstrap 파일)와 SOUL 본문으로 한 에이전트를 버전 관리 가능한 패키지로 묶는다. 저장소에는 coordinator·researcher·writer·reviewer 역할과 `team.json` preset 예시가 있다. [claws CLI](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/cli/claws.md#L10-L20), [researcher 역할](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/reference/templates/roles/researcher/CLAW.md), [team preset](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/reference/templates/roles/presets/team.json)
- **[소스] 범위 결합은 config 정책이다.** 에이전트별 workspace와 agentDir가 분리된다. 에이전트 간 접근은 다음 config 값이 정한다.
  - `tools.sessions.visibility`: 기본 `"all"`
  - `tools.agentToAgent`: 빈 `allow`는 제한 없음
  - `subagents.allowAgents`: 기본은 자기 자신만 spawn

  [visibility 기본값](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/plugin-sdk/session-visibility.ts#L132-L138), [agentToAgent](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/plugin-sdk/session-visibility.ts#L242-L263), [spawn 대상 정책](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/agents/subagents/spawn/subagent-target-policy.ts#L21-L80) **[추론]** 같은 gateway 프로세스 안의 도구 호출이므로 에이전트별 credential로 경계를 증명하지 않는다. 기본값이 넓게 열려 있어, OpenClaw 한 인스턴스에 여러 연구 조직을 넣으면 조직 격리를 config에 의존하게 된다.
- **[소스] 수명 주기:**
  - 실행: `session:<key>` lane마다 동시 1회로 큐잉한다. `/stop`이 실행 시도를 abort하고 큐를 비운다. timeout 기본값은 48시간이다.
  - heartbeat: 기본 30분마다 cron scratch를 맥락으로 한 턴을 돈다. 할 일이 없으면 `NO_REPLY`로 응답한다. [heartbeat](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/auto-reply/heartbeat.ts#L10-L26)
  - 세션 저장: agent별 SQLite `<stateDir>/agents/<id>/agent/openclaw-agent.sqlite`. [db path](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/state/openclaw-agent-db.paths.ts#L53)
  - 세션 관리: compaction과 reset 정책(none/daily/idle)은 탐색 보조 보고에서 확인했다.

## 4. xAI: Grok Bot, Grok Build, Grok API는 서로 다른 것

사용자가 말하는 "Grok Bot"은 정식 제품 Grok Bot이다([비교 후보 목록](comparative-survey.md)). 실행 모델은 세 가지를 따로 봐야 한다.

### 4.1 Grok Bot (호스팅 제품, 내부 비공개)

- **[문서] 정의:** Bot은 "a durable AI teammate with a name, a job, its own conversation, and working context that develops over time"이다. 프로필은 name·label·description·avatar로 구성된다. 지속 규칙은 description에, 작업 지시는 대화에 둔다. 기억은 안정적 선호, 중요한 사실, 작업 요약이다. [Bots](https://docs.x.ai/grok-bot/bots)
- **[문서] 실행 환경과 skill:**
  - 실행 환경: 각 Bot은 브라우저·파일시스템·터미널이 있는 지속 클라우드 컴퓨터에서 일한다. "All of your Bots use the same cloud computer, sharing its files, browser sessions, and app logins." [개요](https://docs.x.ai/grok-bot/overview)
  - skill: "a reusable set of instructions for how to do a task"다. "Private skills are one library shared by all your Bots." 파일 형식은 문서에 없다. routine은 일정이나 이벤트로 Bot 하나의 workflow를 시작하며 일시정지할 수 있다. [Skills](https://docs.x.ai/grok-bot/skills-routines-and-automations)
- **[문서] 개입·권한:**
  - 개입: Bot 간 비동기 메시지, group, handoff가 있다. 사용자의 직접 메시지는 백그라운드 작업보다 우선한다. "Stop now" 메시지로 멈출 수 있지만 이미 한 행동을 되돌리지는 않는다. [Chat and collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration)
  - 권한: "A Bot can never hold more access than the person it belongs to." 연결 도구 token은 백엔드에 두고 Bot 컴퓨터에 저장하지 않는다. 행동별 승인(Allow once/Deny)이 있고 Auto Review는 별도 모델이 위험한 행동을 검토한다. [Security](https://docs.x.ai/grok-bot/security)
- **[미확인]** 다음은 공개 문서로 확인할 수 없다.
  - Bot이 어떤 모델과 루프로 동작하는지
  - Grok Build 런타임을 쓰는지
  - 역할·skill이 내부적으로 어떻게 prompt에 조립되는지
  - 외부 API·MCP 서버로 Bot을 구동할 수 있는지(조사한 문서에는 언급이 없음)

  공식 문서는 요금과 보존 조건을 Cursor 계정 조건과 연결해 설명한다. 어떤 운영 구조인지는 추정하지 않는다.

### 4.2 Grok Build (공개 소스 CLI/런타임)

- **[소스] 루프:** README는 "This repository contains the Rust source for the `grok` CLI/TUI and its agent runtime"이라고 적는다. `xai-grok-agent`가 도구·system prompt·compaction·모델 설정을 `Agent` 객체로 묶고, `xai-grok-sampler`가 `chat/completions`를 직접 호출한다. [README](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/README.md#L13-L32), [agent lib](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-agent/src/lib.rs#L1-L3), [sampler client](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sampler/src/client.rs#L6)
- **[문서] 주입:**
  - 지침: `AGENTS.md`/`CLAUDE.md` 계열을 repo root부터 cwd까지 모두 누적한다. `.grok/rules/*.md`와 Claude·Cursor 호환 경로도 읽는다. [Project rules](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/12-project-rules.md#L15-L26)
  - skill: `SKILL.md` 디렉토리이고 "activates a skill only when it applies"다. `.agents/skills/`와 `.claude/skills/`도 읽는다. [Skills](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/08-skills.md#L9-L11)
  - 세션 단위 역할: agent 정의(`.grok/agents/*.md`)가 모델·도구·prompt를 정한다.
  - 하위 작업자 성격: persona가 하위 작업자에게 어조·출력 계약을 덧씌운다. 하위 작업자는 `spawn_subagent` 도구로 시작한다. [Subagents and Personas](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/16-subagents.md#L9-L20)
- **[문서] 외부 구동 경로:**
  - headless `grok -p … --output-format streaming-json`. 종료 이벤트에 `sessionId`와 `usage`가 담긴다. 재개는 `-r/--resume`, `--fork-session`. [Headless](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md#L25-L28)
  - ACP 서버 `grok agent stdio|serve`. `session/new`·`session/prompt`·`session/update`를 쓰고 권한 요청을 보낸다. [Agent mode](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md#L60-L104)
- **[소스/문서] Paperclip 연결:** Paperclip은 두 경로를 모두 쓴다. 기존 `grok_local`은 CLI를 `--single`로 실행하고, native runner는 `grok agent --no-leader stdio`를 ACPX로 소유하면서 "the authenticated Paperclip MCP bridge"를 붙인다. 같은 문서는 "Full auto does not bypass Paperclip's company permissions, governed approvals, or execution-environment boundaries"라고 적는다. [Grok native runner](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/doc/grok-native-runner.md#L13-L23) 이것은 Grok Build 연동이며 Grok Bot 연동이 아니다.

### 4.3 Grok Multi Agent API

- **[문서]** `grok-4.20-multi-agent`(beta)는 서버 측에서 4개 또는 16개 agent를 띄우고 leader가 결과를 종합한다. 서버 측 내장 도구(web/x search, code execution 등)와 원격 MCP만 쓸 수 있다. "Client-side tools (function calling) and custom tools are not currently supported." sub-agent 상태는 암호화되어 기본으로 노출되지 않는다. [Multi Agent](https://docs.x.ai/developers/model-capabilities/text/multi-agent)
- **[추론]** 이 API는 하나의 모델 호출처럼 동작하는 서버 측 협력이다. 사용자 정의 도구로 조직 API를 호출할 수 없고, 내부 협력 과정을 관찰할 수 없다. 그래서 BaboJUBot의 Lead·작업자 실행 단위로는 맞지 않는다. 하나의 조사 도구로 쓸 수는 있다.

## 5. 설계 공간을 보여 주는 추가 사례

| 사례 | 루프 소유 | 역할·skill 주입 | 회귀·범위 | 수명 주기·세션 |
|---|---|---|---|---|
| [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) | 라이브러리가 Claude Code 바이너리를 실행한다. "the same tools, agent loop, and context management that power Claude Code"를 코드에서 쓴다 | `systemPrompt`(preset+append 또는 custom), `settingSources`로 CLAUDE.md·skill을 읽는다. 프로그램에서 `agents{description, prompt, tools, skills, mcpServers}`를 정의한다. custom prompt면 Claude Code 기본 지침이 빠진다 [system prompt](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts), [subagents](https://code.claude.com/docs/en/agent-sdk/subagents) | in-process MCP 도구나 원격 MCP를 쓴다. 범위는 호스트 앱이 도구 구현에 고정한다 | `session_id`를 받고 `resume`/`forkSession`. transcript는 로컬 JSONL이며 `SessionStore` adapter로 외부 저장할 수 있다. `maxBudgetUsd`, 하위 작업자 깊이·동시성 상한 [sessions](https://code.claude.com/docs/en/agent-sdk/sessions) |
| [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) | 라이브러리가 루프를 소유한다. 최종 출력이 나오거나 `max_turns`에 닿을 때까지 LLM 호출·handoff·도구 실행을 반복한다 [running agents](https://openai.github.io/openai-agents-python/running_agents/) | `Agent(name, instructions, tools, handoffs, mcp_servers)`. instructions는 실행 맥락을 받는 함수일 수 있다 [agents](https://openai.github.io/openai-agents-python/agents/) | 도구에 주입되는 context 객체가 범위를 운반한다. "The context object is **not** sent to the LLM." [context](https://openai.github.io/openai-agents-python/context/) | session, `previous_response_id`, `conversation_id` 중 하나를 고른다. `cancel(mode="after_turn")` 후 `RunState`로 재개한다 |
| [ACP](https://agentclientprotocol.com/protocol/overview) | 프로토콜이다. 클라이언트(편집기·오케스트레이터)가 에이전트 프로세스를 JSON-RPC로 구동한다 | `session/new`에 cwd·MCP 서버를 넣는다. 지침은 에이전트 고유 방식을 따른다 | 에이전트가 `session/request_permission`, `fs/*`, `terminal/*`로 클라이언트에 되묻는다 | `session/prompt`, `session/cancel`, `session/load`, `session/update` 알림 |

**[추론]** ACP는 이미 Hermes(서버), Grok Build(서버), OpenClaw(acpx 클라이언트), Paperclip(native runner의 ACPX)에 공통으로 등장한다. 외부 실행 도구를 여러 개 지원하는 adapter 계층을 만든다면 CLI별 flag 파싱보다 ACP가 공통 기반에 가깝다. 다만 도구마다 지원 capability(세션 load, 권한 요청, usage 보고)가 다르다. Paperclip도 "qualified" 버전만 허용하고 있다.

## 6. 질문별 비교 정리

1. **루프 소유:** 실행 도구 제품(Hermes, OpenClaw, Grok Build)은 모두 자체 루프를 갖는다. 동시에 headless CLI, HTTP API, ACP 서버처럼 외부에서 구동되는 면을 제공한다. 조직 운영 도구인 Paperclip만 루프 없이 adapter로 구동한다. OpenClaw는 자체 루프가 기본이지만 Claude CLI·Codex·ACP 에이전트도 구동하는 "둘 다" 사례다.
2. **역할·skill 주입:** 공통 패턴은 셋이다. (a) 파일 기반 지침(AGENTS.md 계열, SOUL.md)을 system prompt 또는 그에 준하는 위치에 넣는다. (b) skill은 목록만 넣고 본문은 필요할 때 읽는다(Hermes, OpenClaw, Grok Build, Claude Code). (c) 기억은 세션 시작 snapshot이나 도구로 접근한다. 외부 실행 도구를 구동하는 쪽(Paperclip)은 실행 도구마다 다른 주입 지점에 맞춰야 한다. 재개한 세션에는 지침을 다시 넣지 않는다는 제약도 생긴다. Claude 재개 시 `--append-system-prompt-file`을 생략하는 것이 그 예다.
3. **회귀와 범위:** 범위를 credential로 묶는 것은 Paperclip뿐이다. 실행 시도별 JWT와 서버 검사, native runner의 실행 시도 결속 ticket을 쓴다. Hermes는 인스턴스 key와 profile, OpenClaw는 config 정책, Grok Bot은 사용자 계정 단위다. 에이전트가 조직을 고르는 구조는 조사 대상 어디에도 없다. 다만 OpenClaw의 기본 visibility "all"처럼 경계가 정책 기본값에 달린 경우가 있다.
4. **실행 제어와 세션:** 실행 시도 취소는 어디서나 abort signal과 프로세스 종료다(Paperclip은 SIGTERM→SIGKILL, ACP는 `session/cancel`). 에이전트 일시정지는 오케스트레이터 상태다. Paperclip의 `paused`는 새 wake를 막는 상태이고, 실행 중인 루프를 그 자리에서 얼리지는 않는다. 세션 연속성은 실행 도구가 저장한 세션 ID를 오케스트레이터가 보관했다가 재개 조건(같은 cwd·지침 버전 등)이 맞으면 넘기는 방식이 공통이다.

## BaboJUBot에 주는 시사점 — 설계 제안, 결정 아님

아래는 위 근거에서 끌어낸 **설계 제안**이다. 선택은 해당 기능 이슈와 사용자 판단으로 결정한다. 실제 모델 호출을 범위에 넣을 때는 AGENTS.md에 따라 계정·자격 증명·비용 권한을 먼저 확인해야 한다.

| 선택지 | 장점 | 단점·위험 |
|---|---|---|
| (a) 자체 에이전트 루프 (Hermes·OpenClaw·Grok Build·OpenAI Agents SDK 방식) | 조직 도구를 in-process 함수로 노출하고 범위를 코드 context에 고정하기 쉽다. 모든 도구 호출·턴을 관찰 이벤트로 남길 수 있다. 일시정지·중단을 턴 경계에서 정확히 걸 수 있다. 비용·usage를 직접 계측한다 | 파일 편집·shell·검색·compaction·provider별 차이 같은 범용 실행 도구 기능을 직접 만들고 유지해야 한다. 성숙한 실행 도구(Claude Code, Codex)의 도구 품질을 따라가기 어렵다. 모델 provider 계정과 비용 관리가 처음부터 필요하다 |
| (b) 기존 실행 도구 위 adapter (Paperclip 방식) | 범용 실행 능력을 바로 얻는다. 실행 도구를 바꿔도 조직 계약을 유지한다. control plane에 집중할 수 있다 | 주입 지점이 도구마다 다르다(system prompt flag, env overlay, skills 디렉토리, 재개 시 재주입 불가). 관찰은 도구가 내보내는 stream에 한정된다. 도구 안의 shell·파일 행동은 승인 우회 flag와 실행 환경 격리에 의존한다. Paperclip의 CLI adapter 수와 runner ADR이 보여 주듯 도구별 호환 작업이 계속 늘어난다 |
| (c) 둘 다 (OpenClaw 방식) | 가벼운 Lead 대화·조정은 자체 루프로, 무거운 실험·코딩 작업은 외부 실행 도구로 나눌 수 있다 | 두 경로의 관찰 이벤트, 비용 계측, 세션, 취소 의미를 하나의 실행 시도 계약으로 맞춰야 한다. 범위가 두 배가 된다 |

선택과 무관하게 지켜야 할 불변 조건 후보는 다음과 같다(**[추론]**).

- **조직 범위는 credential이나 코드 context로 묶는다.** 에이전트가 조직 ID를 인자로 고르지 않게 한다. Paperclip의 실행 시도별 토큰+서버 검사, OpenAI SDK의 LLM에 보내지 않는 context 객체가 참고 사례다. prompt나 역할 문서는 강제 수단이 아니다([제품 불변 조건](../../AGENTS.md)).
- **조직 도구는 실행 경로와 무관한 한 계약으로 노출한다.** 예: 조직 API를 MCP 서버로 노출하고 실행 시도별 토큰을 쓴다. 그러면 (a)의 in-process 도구, (b)의 MCP 주입, ACP의 `session/new` MCP 목록이 같은 서버 검사를 거친다.
- **실행 시도 계약을 먼저 정한다.** 입력은 에이전트·조직·실행 시도 식별, 지침 bundle 버전, workspace, 세션 handle, 취소 signal이다. 출력은 관찰 이벤트 stream, usage·비용(미확정 상태 포함), 새 세션 handle, 요약·질문이다. 이 계약은 (a)/(b)/(c) 어느 쪽이든 그대로 쓸 수 있다. 처음에는 실행 도구 하나 또는 가짜 프로바이더로 계약만 검증하고, 실제 실행 도구 선택은 뒤로 미루는 순서가 하향식 개발에 맞는다.
- **역할·성격·skill은 버전 있는 파일 bundle로 두고, 실행 시도마다 그 버전을 기록한다.** 재개한 세션에 지침 변경이 반영되지 않는 문제가 Paperclip, Hermes, Claude Agent SDK에 공통으로 있다. 따라서 지침 버전이 바뀌면 새 세션을 시작할지 결정하는 규칙이 필요하다.
- **일시정지는 "새 실행 시도 금지"와 "진행 중 실행 시도 취소"로 나눠 정의한다.** 조사한 구현은 진행 중인 루프를 얼리는 대신 취소하고 나중에 재개한다.

## 검증 결과와 한계

- 고정 SHA 네 개를 shallow fetch했고 `git rev-parse HEAD`가 각 SHA와 일치했다. 설치·빌드·실행·실제 모델 호출은 하지 않았다. 모든 결론은 정적 열람 결과이며 실제 동작 검증이 아니다.
- 메인 조사자가 원문을 다시 열어 확인한 줄:
  - Paperclip: registry L892, `ServerAdapterModule`·context·result·codec 선언부, claude 실행 인자 L870-L883, instructions 키 L10-L17, heartbeat L4414, 기본 prompt template, JWT 수명·키 파생, 발급 조건, auth middleware L382-L411, `assertCompanyAccess`, pause·cancel route 진입부, timeout SIGTERM, wake 기반 세션 초기화, compaction 기본값, Hermes·Grok adapter 인자·env, runner ADR·Grok native runner 문서, MCP server README
  - Hermes: 루프 조건, system prompt 3단 header, SOUL 경로, skills·context 함수 진입부, delegate header와 child 생성, ACP class, memory header, runs route, `_check_auth`
  - OpenClaw: `runAgentLoop`, main loop, bootstrap 목록, CLI dispatch 조건, skill 목록 형식, visibility 기본값, agentToAgent 정책, spawn 정책 진입부, runtimes 문서, workspace 필터, heartbeat 기본값, SQLite 경로, `new Agent`/`streamSimple`, retired 템플릿, CLAW 역할 예시
- 위 목록 밖의 줄 범위와 세부 기본값은 탐색 보조 agent가 보고한 위치다. 예: Hermes 압축 임계값, OpenClaw lane·compaction·reset 세부, Paperclip skill별 디렉토리 구조. 채택 결정에 쓰기 전에 다시 열어 확인해야 한다.
- Paperclip의 `assertCompanyAccess` 사용 route(탐색 보고상 56개 파일)는 전수 감사하지 않았다. 「모든 API가 회사 범위를 강제한다」고는 주장하지 않는다.
- Hermes 반복 상한 기본값은 소스 안에서 서로 다르다. 설정 기본값은 무제한이고 CLI fallback은 500이다(탐색 보고). 이 문서는 값을 확정하지 않는다.
- Grok Bot 내부와 Grok Bot·Grok Build의 관계는 공개 자료로 확인할 수 없다. Grok Bot, Grok Multi Agent API, Claude Agent SDK, OpenAI Agents SDK, ACP는 2026-10-13에 공식 문서를 열람한 결과다. 고정 버전이 아니므로 바뀔 수 있다.
- 기존 [초기 구조 참고 조사](reference-code-structure.md)가 OpenClaw 템플릿으로 적은 `HEARTBEAT.md`·`TOOLS.md`는 같은 SHA에서 retired 안내 문서로 남아 있다. 런타임 bootstrap 목록에서는 빠져 있다. 기존 문서는 템플릿 디렉토리의 존재를 적은 것이라 사실과 충돌하지는 않는다. 다만 "현재 쓰이는 역할 파일"로 읽으면 틀린다.
- 라이선스: 코드 재사용은 권고하지 않는다. 모두 설계 참고다. 재사용할 때는 해당 파일과 의존성의 라이선스를 다시 확인한다.
