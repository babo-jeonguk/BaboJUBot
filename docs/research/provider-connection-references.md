# 프로바이더 연결 방식 레퍼런스 조사: 실행 시도 하나를 어떤 연결로 돌리고, 조직 도구·세션·취소·사용량을 어떻게 다루는가

조사일: 2026-10-30. 대상: [판 2](../architecture.md#구현-순서)에서 Claude Code·Codex·OpenCode·Antigravity를 공통 실행 시도 계약(`packages/contracts/src/run.ts`의 `RuntimeAdapter`, 공통 검사 `packages/runtime/src/runtime-contract.ts`)에 붙일 때의 **연결 방식**이다. 구현 전 기술 권고이며 확정 계약이나 구현 결과가 아니다.

사용자가 정한 전제: 네 프로바이더를 함께 설계한다(공통 방향 먼저, 그다음 프로바이더별 경로). 로그인은 사용자의 구독 계정이며 API key를 쓰지 않는다. 프로바이더는 에이전트마다 고른다([프로바이더 선택 조사](executor-selection-references.md)).

이 문서가 답하는 질문:

- **D1. 연결 방식.** 실행 시도마다 한 번 실행하고 끝나는 프로세스(`claude -p`·`codex exec`·`opencode run`·`agy -p`)와, 오래 사는 세션(Claude Agent SDK·`codex app-server`·`opencode serve`·Antigravity stream-json) 중 무엇을 쓰는가. 각각 실행 중 메시지(steer)·프로토콜 안 중단·권한·사용량·재개에서 무엇을 주는가. 프로세스 수명과 우리 실행 시도(에이전트 호출 한 번, 결과로 끝남)는 어떻게 맞는가. 프로세스가 죽거나 서버가 재시작하면 어떻게 되는가. ACP는 세 번째 선택지가 되는가.
- **D2. 조직 도구 노출.** 실행 시도 토큰을 쓰는 HTTP MCP 서버 하나인가, 프로바이더별 고유 도구 수단인가. 토큰을 argv·workspace 파일·env 중 어디로 넘기면 새지 않는가. 무인 실행에서 기본 도구를 제한하고 우리 도구만 미리 승인하는 방법.
- **D3. 세션 연속성.** 같은 에이전트의 실행 시도 사이에서 세션을 ID로 재개하는 조건과 새로 시작하는 조건(지침·프로바이더·모델 변경), 세션 상태가 저장되는 위치.
- **D4. 취소.** signal과 프로토콜 안 중단, 유예 시간, 프로세스 트리 정리, `cancelled` 확인 방법.
- **D5. 사용량 표시.** 실행 시도별 토큰·비용과 계정 단위 요금제 사용량(한도 창)을 구독 로그인에서 어떻게 보이는가.

기존 조사와의 경계:

| 재사용한 조사 | 이미 답한 것 | 이 문서가 더하는 것 |
|---|---|---|
| [executor-capabilities.md](executor-capabilities.md) | 네 프로바이더 현재 버전의 12개 축 사실(비대화 실행, stream, 도구 주입, 지침, 세션, 취소, 사용량, 약관, sandbox, 모델, steer, ACP) | 그 사실을 **연결 방식별로** 다시 묶고, 레퍼런스가 실제로 어느 방식을 골랐는지와 그 이유·실패 사례 |
| [executor-selection-references.md](executor-selection-references.md) | 프로바이더 설정 자리, capability 정적 선언, 프로바이더 변경 시 새 세션, 환경 확인 | capability 칸의 구체 목록, steer 불가 시 대체 동작, 세션 재개 조건의 프로바이더별 세부 |
| [issue-86-references.md](issue-86-references.md) | 도구 목록 한 줄의 모양, "노출 ≠ 권한", 서버의 호출마다 재검사 | 그 목록을 프로바이더에 **어떤 통로로** 내는가와 미리 승인 |

근거 수준 표기: **[소스]** 고정 SHA 코드를 읽은 사실, **[문서]** 저장소 문서·공식 문서의 주장, **[추론]** 위 근거에서 끌어낸 판단, **[미확인]** 확인하지 못한 것. 레퍼런스가 adapter·provider·harness·runtime이라 부르는 것은 모두 **프로바이더**로 쓰고, 레퍼런스의 turn은 "턴"으로 쓴다. 우리 계약의 "실행 시도"와 레퍼런스의 "턴"이 같은지는 D1에서 따로 본다.

## 기준 버전과 조사 방식

모두 정적으로 읽었다. 설치·빌드·실행·실제 모델 호출은 하지 않았고 자격 증명 파일을 열지 않았다. 경로·줄 번호는 표의 SHA 기준이다.

| 대상 | 저장소 | SHA | 라이선스 | 읽은 범위 |
|---|---|---|---|---|
| **Paseo**(주 레퍼런스) | [getpaseo/paseo](https://github.com/getpaseo/paseo/tree/75f58c4fe7d3180e3ff74e10480bf0dc1111f37d) | `75f58c4fe7d3180e3ff74e10480bf0dc1111f37d` | Apache-2.0(제3자 구성요소는 각 라이선스, `LICENSE` 머리) | `docs/providers.md`·`custom-providers.md`·`glossary.md`·`agent-lifecycle.md`·`hub.md`, `public-docs/supported-providers.md`·`plugins/reference.md`, `agent-sdk-types.ts`·`agent-manager.ts`·`runtime-mcp-config.ts`·`provider-registry.ts`, `providers/claude/`·`codex-app-server-agent.ts`·`codex/`·`opencode/`(v2 포함)·`acp-agent.ts`, `plugins/antigravity-provider/`·`claude-usage-source/`·`codex-usage-source/`, `utils/tree-kill.ts` |
| Vibe Kanban | [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban/tree/7c3807084daad0d9d315064f60fa869de254f027) | `7c3807084daad0d9d315064f60fa869de254f027` | Apache-2.0 | executors crate(Claude·Codex·OpenCode), container 취소·재시작 |
| Emdash | [generalaction/emdash](https://github.com/generalaction/emdash/tree/85dfa910ac92e69b09ed5df70ea60ee625a83f07) | `85dfa910ac92e69b09ed5df70ea60ee625a83f07` | Apache-2.0 | agent plugin 4종(Antigravity 포함), ACP runtime, loopback 토큰 전달 |
| Sculptor | [imbue-ai/sculptor](https://github.com/imbue-ai/sculptor/tree/ea2a9dffea1327c48504936ad67776fab40e49ce) | `ea2a9dffea1327c48504936ad67776fab40e49ce` | MIT | Claude process manager(Claude만 지원) |
| Nimbalyst | [Nimbalyst/nimbalyst](https://github.com/Nimbalyst/nimbalyst/tree/031a6e6de0b7817bbdcd16e6e5e758e45dfdcdc7) | `031a6e6de0b7817bbdcd16e6e5e758e45dfdcdc7` | MIT | Claude SDK·Codex app-server·OpenCode SDK protocol, MCP 토큰, 사용량 서비스 |
| Zed | [zed-industries/zed](https://github.com/zed-industries/zed/tree/d4014230735e4265d98066420b9271df2324ccab) | `d4014230735e4265d98066420b9271df2324ccab` | 인용 crate(`agent_servers`·`acp_thread`·`project`) GPL-3.0-or-later | ACP client(sparse checkout) |
| Paperclip | [paperclipai/paperclip](https://github.com/paperclipai/paperclip/tree/2badf8a4a5a7fb07329d99d355cf0f9875de3b80) | `2badf8a4a5a7fb07329d99d355cf0f9875de3b80` | MIT | `*-local` adapter(Claude·Codex·OpenCode), native runner(`packages/paperclip-runner`), heartbeat 취소·복구, quota windows |
| Multica | [multica-ai/multica](https://github.com/multica-ai/multica/tree/c066f7ea61eecdfc7c227b20a45330eacc7cf352) | `c066f7ea61eecdfc7c227b20a45330eacc7cf352` | Multica License(Apache-2.0 + 추가 조건) | `server/pkg/agent`(4종 모두), daemon 취소·보충 메시지 |
| Composio agent-orchestrator(AO) | [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator/tree/9b95d754f5d4fcbad31ff8d6422b37c8703c6206) | `9b95d754f5d4fcbad31ff8d6422b37c8703c6206` | Apache-2.0 | chat driver(ACP·Codex app-server), steer, persistenthost, agentaccount |
| OpenClaw | [openclaw/openclaw](https://github.com/openclaw/openclaw/tree/43af01b15c96785d1e69bbd14eafa7a56938cf7f) | `43af01b15c96785d1e69bbd14eafa7a56938cf7f` | MIT | Claude CLI backend, Codex app-server extension, loopback MCP, 세션 재사용 판단, 사용량 |

공식 문서(2026-10-30 열람): [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Claude Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript). 네 프로바이더 자체의 버전·소스는 [executor-capabilities.md](executor-capabilities.md#기준-버전)를 따른다(Claude Code 2.1.312, Codex 0.165.0, OpenCode 1.18.23, Antigravity 1.4.10).

Paseo 저장소는 sparse checkout이어서 `packages/server/src/utils/` 등 일부 경로는 같은 SHA의 전체 사본에서 읽었다(파일 내용이 `git show HEAD:`와 같음을 비교로 확인).

## 핵심 판단

| 질문 | 레퍼런스가 수렴한 답 | 갈리는 곳 |
|---|---|---|
| D1 연결 방식 | 한 번 실행 headless(`-p`·`exec`·`run`)는 **Paperclip의 기존 adapter만** 쓴다. 그 Paperclip도 새 native runner는 양방향이고, 나머지는 모두 양방향 프로토콜(Claude stream-json 입력+control, `codex app-server`, `opencode serve`, ACP)이다 [소스] | 그 프로세스를 **턴(작업) 하나만** 살리느냐(Vibe Kanban·Sculptor·Multica) **세션 동안** 살리느냐(Paseo·Nimbalyst·Zed·Emdash·AO·OpenClaw·Paperclip native runner) |
| D1 steer | Codex `turn/steer`는 Paseo·Paperclip native runner·Multica·AO·OpenClaw가 쓴다. Claude는 Paseo(SDK 입력 push)·OpenClaw(stream-json 입력 추가)·Multica(SDK hook, 턴 경계). OpenCode는 Paseo만 [소스] | steer가 안 될 때 Paseo·Zed는 중단 후 교체·재전송, Paperclip·Vibe Kanban·Emdash·Sculptor·AO는 다음 턴 대기열, Multica·AO는 "지원 안 함"을 typed 응답으로 돌려준다 |
| D2 도구 노출 | 제품 도구는 **loopback HTTP MCP + Bearer header**(Paseo·Nimbalyst·OpenClaw·Paperclip Claude) 또는 env 토큰을 읽는 제품 CLI(Multica·AO·Paperclip) [소스] | 토큰 범위: **실행(작업)별**(Paperclip JWT·Multica task 토큰·OpenClaw grant) vs 데몬 기동마다 하나(Paseo·Nimbalyst) vs 없음(Vibe Kanban·AO) |
| D2 무인 승인 | Paseo는 "주입한 MCP 서버의 정확한 도구 이름만" 미리 승인하고 못 하는 프로바이더는 무인 실행을 거부한다(fail closed). OpenClaw도 Claude에 `mcp__openclaw__*`만 미리 승인 [소스] | Paperclip·Emdash·Sculptor·Multica는 전체 허용. Paperclip 주석: "A tool allowlist is not equivalent to full bypass" |
| D3 세션 | 세션 ID를 제품 DB에 저장하고 다음 턴에 resume [소스] | 재개 실패 시 **실패로 드러냄**(Paseo·Emdash·AO "proof the conversation never started"일 때만 새로) vs **같은 실행에서 새 세션으로 재시도**(Paperclip·OpenClaw). 재개를 fork로 하는 곳(Vibe Kanban) |
| D4 취소 | 프로토콜 안 중단 → 유예 → process group SIGTERM → SIGKILL. 유예는 1–5초(Paperclip Claude만 20초) [소스] | "취소됨"을 프로바이더 종료 이벤트로 확인(Paseo·Zed·OpenClaw Codex) vs 시간 초과 후 제품이 강제 기록(Sculptor·Paseo 일부·Paperclip) |
| D5 사용량 | 턴별 토큰 + context 사용량 gauge는 공통. 계정 한도 창은 Codex `account/rateLimits/read`(Nimbalyst·Emdash·AO·Paperclip·OpenClaw)와 Claude 사용량 API(자격 증명 직접 읽기, Paseo·Nimbalyst·Paperclip·OpenClaw) [소스] | Claude를 프로세스 안 수단으로 읽는 곳: AO `get_usage` control request, Emdash SDK experimental API. Agent SDK 문서의 `/usage` `usage_report`(experimental)를 쓰는 곳은 찾지 못함 |

## D1. 연결 방식

### 세 가지 모양

레퍼런스를 읽으면 선택지는 둘이 아니라 셋이다. [추론]

| 모양 | 프로세스 수명 | 예 | 우리 실행 시도와의 관계 |
|---|---|---|---|
| (가) 한 번 실행 headless | 턴 하나, 입력은 시작 인자뿐 | `claude -p "<prompt>"`, `codex exec`, `opencode run`, `agy -p` | 실행 시도 = 프로세스 하나. 실행 중 입력 채널 없음 |
| (나) **턴 범위 양방향** | 턴 하나, 그동안 stdin·HTTP로 제어 | Vibe Kanban: Claude `-p --input-format=stream-json`, 턴마다 `codex app-server`·`opencode serve`. Sculptor: 메시지마다 Claude stream-json 프로세스 | 실행 시도 = 프로세스 하나. 실행 중 steer·프로토콜 안 중단 가능 |
| (다) 세션 범위 상주 | 여러 턴, 유휴 시 회수 | Paseo(유휴 1시간 뒤 회수), Nimbalyst(Codex 세션당 app-server 하나), Zed(ACP 연결 하나에 여러 세션) | 실행 시도 = 상주 세션의 턴 하나. 프로세스가 실행 시도보다 오래 산다 |

근거 [소스]:

- **Vibe Kanban (나).** Claude를 `claude -p --input-format=stream-json --output-format=stream-json`과 control protocol로 턴마다 띄우고, `initialize`·`set_permission_mode` 뒤 prompt를 stdin user message로 보낸 다음 `Result`에서 읽기를 끝낸다(`crates/executors/src/executors/claude.rs` L157-194, L684-703, `claude/protocol.rs` L90-92). Codex는 턴마다 `npx @openai/codex@0.124.0 app-server`(`codex.rs` L447-459), OpenCode는 턴마다 `opencode serve --hostname 127.0.0.1 --port 0`(`opencode.rs` L91-95). 읽기가 끝나면 process group을 죽인다. 주석: "Some coding agent processes do not automatically exit"(`local-deployment/src/container.rs` L504-515), "native kill_on_drop doesn't work reliably causing orphaned processes"(`opencode.rs` L77-84).
- **Sculptor (나).** `exec claude --permission-prompt-tool stdio --output-format=stream-json --input-format stream-json …`를 메시지마다 띄운다. 주석: "every new message you receive is via a new CLI invocation"(`sculptor/agents/default/claude_code_sdk/process_manager_utils.py` L83-127, L172). 턴이 끝나면 stdin을 닫고 5초 → SIGTERM → 5초 → SIGKILL, "matches the official claude-agent-sdk"(`process_manager.py` L799-846).
- **Paseo (다).** Claude는 Agent SDK `query()`에 계속 열린 입력 stream을 주고(`providers/claude/agent.ts`의 `this.input`), 한 프로세스가 여러 턴을 처리한다. Codex는 세션마다 `codex app-server`를 하나 띄운다(`codex-app-server-agent.ts` L7310-7333). OpenCode는 `opencode serve`를 공유하되 사용자 env·MCP가 있으면 전용 서버를 띄운다([`docs/providers.md` L106](https://github.com/getpaseo/paseo/blob/75f58c4fe7d3180e3ff74e10480bf0dc1111f37d/docs/providers.md#L106)). Antigravity는 `agy --input-format stream-json --output-format stream-json`을 세션 동안 띄운다(`plugins/antigravity-provider/server/internal/process.ts` L31-48). 유휴 runtime은 1시간 뒤 회수하고 다음 prompt에서 세션을 재개한다([`docs/agent-lifecycle.md` L48-52](https://github.com/getpaseo/paseo/blob/75f58c4fe7d3180e3ff74e10480bf0dc1111f37d/docs/agent-lifecycle.md#L48-L52)).
- **Nimbalyst (다).** Claude Agent SDK `query()`에 "persistent AsyncIterable … prevents the SDK from closing the binary's stdin pipe on `type: 'result'`"(`packages/runtime/src/ai/server/providers/claudeCode/sdkOptionsBuilder.ts` L588-591). Codex: "One codex app-server child process per session … Multiple turns reuse the same process"(`protocols/CodexAppServerProtocol.ts` L18-19). OpenCode는 참조 수를 센 공유 `opencode serve` 하나(`protocols/OpenCodeSDKProtocol.ts` L123-161).
- **Zed·Emdash (다, ACP).** Zed는 에이전트 연결마다 ACP stdio 자식 하나에 여러 세션(`crates/agent_servers/src/acp/v1.rs` L556-611). Emdash는 Claude `claude-agent-acp`, Codex `codex-acp`, OpenCode `opencode acp`를 오래 띄우고(`packages/plugins/src/agents/impl/{claude,codex,opencode}/index.ts`), Antigravity만 PTY 대화형 CLI(`agy -i … --conversation=`)로 돌린다(`antigravity/index.ts` L101-116).
- **Paperclip (가) + 상주 runner.** 기존 adapter는 heartbeat 실행마다 `claude --print --output-format stream-json --verbose [--resume id]`(`packages/adapters/claude-local/src/server/execute.ts` L846-876), `codex exec --json … [resume <id>] -`(`codex-local/src/server/codex-args.ts` L47-74), `opencode run --format json [--session id]`(`opencode-local/src/server/execute.ts` L623-625). 새 native runner(`packages/paperclip-runner`)는 Codex app-server(`turn/steer` `drivers/codex/codex-harness-session.ts` L363, `turn/interrupt` L433)와 `opencode serve`(`prompt_async`·`/abort`, `drivers/opencode/opencode-server-driver.ts` L709, L749, L2505)를 상주시킨다. Antigravity는 runner의 ACP(`agy_acp_server.par`)로만, `qualification:"pending"`(`acpx/capability-profiles.ts` L22-27).
- **Multica (나).** 작업마다 새 프로세스. Claude `-p --output-format stream-json --input-format stream-json --permission-mode bypassPermissions`(stdin을 control_request용으로 열어 둠, `server/pkg/agent/claude.go` L1127-1167, L182-186), Codex `codex app-server --listen stdio://`(`codex.go` L375-383), OpenCode는 버전이 확인되면 `opencode acp` 아니면 `opencode run`(`opencode_acp.go` L40-63), Antigravity `agy -p … --dangerously-skip-permissions --output-format stream-json`(conversation ID를 log 파일에서 읽음, `antigravity.go` L17-38, L833-857).
- **AO (다).** chat 모드에서 Claude는 `claude-agent-acp`, Codex는 `codex app-server`, OpenCode는 `opencode acp`, Antigravity는 별도 `agy_acp_server`("The agy CLI has no ACP mode", `backend/internal/adapters/chatdriver/agyacp/driver.go` L1-12). 데몬이 교체돼도 프로바이더 stdio 프로세스를 살려 두는 `persistenthost`(`persistenthost/host.go` L1-4).
- **OpenClaw (다).** Claude `-p --output-format stream-json --include-partial-messages`, stdin 입력의 `liveSession:"claude-stdio"`. 유휴 10분 뒤 닫는다(`extensions/anthropic/cli-backend.ts` L44-56, `cli.runtime.ts` L21, L345). Codex는 공유 app-server client 하나(`extensions/codex/src/app-server/client-runtime.ts` L55-63).

### 프로바이더별로 각 모양이 주는 것

[executor-capabilities.md](executor-capabilities.md)의 사실과 위 레퍼런스를 합친 표다. "있음"은 그 모양에서 쓸 수 있는 수단이다.

| 프로바이더 | (가) 한 번 실행 | (나)·(다) 양방향 수단 | 양방향에서 더 얻는 것 | 양방향의 비용·위험 |
|---|---|---|---|---|
| Claude Code | `claude -p`. 취소는 SIGINT만, steer 없음 | `claude -p --input-format stream-json`(CLI 직접, Vibe Kanban·Sculptor) 또는 Agent SDK `query()`(같은 바이너리를 같은 방식으로 띄움, Paseo·Nimbalyst) | steer(`priority: "next"`), `interrupt` control request, `canUseTool`/`--permission-prompt-tool`로 권한 질문 왕복, `set_model`·`set_permission_mode`, 미시작 메시지 철회(`cancelAsyncMessage`) [소스·문서] | SDK는 npm 의존성 하나. SDK 경유도 [약관 문구](executor-capabilities.md#8-인증-동시-실행-구독-자동화-약관)의 "Agent SDK" 범위다 [문서]. Paseo 주석: `--no-session-persistence`는 `--print` 밖에서 무시돼 stream-json에서 조용히 빠진다(`agent.ts` L3040 부근) [소스] |
| Codex | `codex exec --json`. 공식이 자동화에 권하는 경로(Codex SDK도 exec를 띄움) | `codex app-server`(stdio JSON-RPC) | `turn/steer`, `turn/interrupt`(성공 시 턴이 `interrupted`로 끝남), `thread/start`의 config로 MCP·권한을 **argv 밖에서** 전달, `thread/tokenUsage/updated`, `account/rateLimits` [소스·문서] | 공식 문서: "The app-server command and WebSocket transport are experimental and aren’t supported for production workloads." "If you are automating jobs or running Codex in CI, use the Codex SDK instead." [문서]. 다만 exec 자체도 내부에서 in-process app-server를 쓴다([executor-capabilities.md](executor-capabilities.md#1-비대화-실행)) |
| OpenCode | `opencode run`. **signal 처리기가 없어** 정상 취소 불가, 최종 result 이벤트 없음 | `opencode serve`(HTTP+SSE, `OPENCODE_SERVER_PASSWORD`) 또는 `opencode acp` | busy 세션에 prompt를 넣으면 다음 단계 경계에 합류(v1 `prompt_async`, v2 `delivery: "steer"`), `POST /session/:id/abort`, `session.idle`·`session.error`로 완료 판정, step별 usage [소스] | 서버의 MCP 설정은 세션이 아니라 위치(cwd) 범위라 실행 시도 토큰이 섞이지 않게 서버를 나눠야 함(Paseo 문서 L106). Paseo는 v1.14.46·v2.0.10을 따로 구현했고 설치본은 1.18.23(v1 계열) [소스] |
| Antigravity | `agy -p`. 시간 초과도 종료 0 | `agy --input-format stream-json --output-format stream-json`(Paseo) | 한 프로세스에서 여러 턴. **steer는 없음**: 턴 중 두 번째 prompt는 별도 턴으로 줄 선다(Paseo fixture `stdin-mid-turn`) [소스] | 권한 질문을 밖으로 못 내서 Paseo는 `--dangerously-skip-permissions`만 쓴다. 프로토콜 안 취소 없음(SIGINT = 프로세스 종료). 소비자 요금제 약관상 third-party 앱 안 구동 "not supported" [문서] |

Paseo의 Antigravity 공개 문서: "Full access is the only permission mode. Antigravity cannot ask for permission when another app drives it, so Paseo starts `agy` with `--dangerously-skip-permissions`." "Paseo MCP tools and steering are unavailable." "This integration uses your installed CLI and sign-in. It is not endorsed by Google."([`public-docs/supported-providers.md` L24-41](https://github.com/getpaseo/paseo/blob/75f58c4fe7d3180e3ff74e10480bf0dc1111f37d/public-docs/supported-providers.md#L24-L41)) [문서]

### Paseo의 steer 계약과 대체 동작

- **capability가 아니라 선택 메서드 + 결과값이다.** `AgentSession.steerActiveTurn?(prompt, {expectedTurnId, clearPendingPermissions})`는 `{status: "accepted"} | {status: "unavailable"}`를 돌려준다(`agent-sdk-types.ts` L206-215). 메서드가 없거나 `unavailable`이면 manager가 "interrupt-and-replace"로 넘어간다(`agent-manager.ts` L3043-3090 `steerOrReplaceActiveTurn`). [소스]
- **대상 턴을 고정한다.** `expectedTurnId`가 지금 활성 턴과 다르면 `unavailable`. 주석: "An unavailable answer is only safe to fall back from while this admission still owns the active turn. Never let an A admission replace a later B."(L3035-3040). 아직 ID가 없는 시작 중 턴은 교체하지 않고 시작을 기다린 뒤 steer한다(L3048-3050). [소스]
- **오류는 대체하지 않는다.** "An adapter error leaves the steer's fate ambiguous and must surface without an interrupt or retry."([`docs/providers.md` L112](https://github.com/getpaseo/paseo/blob/75f58c4fe7d3180e3ff74e10480bf0dc1111f37d/docs/providers.md#L112)) — 대체는 프로바이더가 명시적으로 `unavailable`이라 할 때만. [문서]
- **중단은 읽히지 않은 steer를 버려야 한다.** "stopping a turn must discard the steers the provider has not read yet, or one of them resumes the turn the user just stopped." Codex는 중단 시 대기 입력을 지우지만 Claude는 아니라서 adapter가 `query.interrupt()` 전에 미시작 메시지를 철회한다(L114, `providers/claude/agent.ts` L4472-4530). [문서·소스]
- **프로바이더별 수단**(L112): Codex `turn/steer`(native turn id + client message id), Claude 활성 SDK 입력에 `priority: "next"` 메시지 push(`agent.ts` L2599-2630), OpenCode v2 `session.prompt({delivery: "steer"})`(`opencode/v2/turns.ts` L334-348), Pi `steer` RPC. 슬래시 명령·압축 중·세션 없음은 `unavailable`. Antigravity·ACP는 메서드가 없다. [소스]
- **용어.** Paseo 용어집은 steer를 "A follow-up admitted into an agent's already-running turn instead of interrupting it"로 정의하고, 턴이 끝날 때까지 클라이언트가 들고 있는 **Queue track**과 구분한다(`docs/glossary.md` L57). [문서]

다른 레퍼런스의 대체 동작 [소스]: Zed는 턴 중 보내면 먼저 취소한다(`RequestPermissionOutcome::InterruptedByFollowUp`, `crates/acp_thread/src/acp_thread.rs` L7331-7360). Vibe Kanban은 성공한 턴 뒤에만 비우는 대기열(`services/queued_message.rs`, `container.rs` L620-635). Emdash ACP 기본 `auto`는 "delivers if idle and queues while a turn is active"(`runtimes/acp/node/runtime/types.ts` L52). Sculptor는 턴 중 새 메시지를 `IllegalOperationError`로 거부하고 화면이 줄 세우기와 interrupt-and-send를 준다(`process_manager.py` L224-258). Nimbalyst는 "Send-now" = 중단 후 대기열 비우기(`clearStuckRunningState.ts` L1-27). Paperclip은 기존 adapter 실행이면 "unsupported"로 다음 깨우기까지 댓글을 줄 세우고, native runner면 살아 있는 runner에 steer를 시도해 `steering_unsupported`·`steering_timeout`을 받는다(`server/src/services/issue-queued-comment-queue.ts` L133-168). Multica는 steer 불가 시 `task_supplement_unsupported`를 돌려주고(`handler/task_supplement.go` L351), Claude는 "Claude has no conditional, current-turn-only user input request. SDK hooks instead insert context … at a turn boundary"(`claude_supplement.go` L20-28). OpenClaw는 Claude에 stream-json user frame을 더 쓰고(`injectInput`, `cli.runtime.ts` L267-300), Codex는 steer 대기열로 묶어 `turn/steer`를 순서대로 보낸다(`attempt-steering.ts` L116-117, L365-369).

AO는 steer를 중단 후 재전송으로 대체하지 않는 이유를 적는다 [소스]: "Why this is not "interrupt, then send again". An interrupt destroys the turn — its reasoning, its half-applied edits, the command it has running — and the resend starts from nothing. A steer adds the correction to the SAME turn and leaves the work in place … Measured against codex-cli 0.146.0, the steered turn kept its id and settled `completed` … Optional and feature-detected … a provider that cannot steer gets a typed refusal a client renders as an absent control rather than as a failed request."(`backend/internal/service/chat/steer.go` L14-26) 지원 안 하는 프로바이더에는 대기열에 묶어 다음 턴으로 보낸다(`SteerOrSend`, `batch.go` L43-107).

### 프로세스가 죽을 때와 서버 재시작

| 레퍼런스 | 턴 중 프로세스 사망 | 턴 사이 사망 | 서버(데몬) 재시작 |
|---|---|---|---|
| Paseo | 턴 실패로 보고(Codex `handleUnexpectedTermination` → `turn_failed`, `codex-app-server-agent.ts` L3721-3737; Antigravity `onExit` → `failTurn`) | Claude·OMP는 턴 사이 종료도 턴 실패로 보고. 이유: Claude의 background Bash·Monitor는 CLI 프로세스 안에 있어 같이 죽는데 "between turns nothing is watching"(`agent-lifecycle.md` L97-104) | 실행 중이던 에이전트를 기본으로 재개하고 `Resume working.`을 보낸다. "best-effort … no recovery retry loop or exactly-once turn guarantee"(L15-33) |
| Vibe Kanban | 실행이 실패로 끝남 | 해당 없음(턴 범위) | 시작 시 실행 중이던 execution을 Failed로 표시(`services/container.rs` L272-323) |
| Sculptor | — | 해당 없음 | RUNNING 작업을 QUEUED로 되돌리고 "Please pick up where you left off" 메시지로 재실행(`concurrent_implementation.py` L204-215, `run_agent/v1.py` L630-661) |
| Emdash | `process-exited`로 세션 중지(`session-manager.ts` L660-678) | 같음 | worker 재시작 시 intent를 suspended로, 뒤에 `loadSession`으로 복원(L896-905) |
| Zed | 모든 세션에 `LoadError::Exited`, 자동 재기동 없음(`v1.rs` L652-662) | 같음 | — |
| Nimbalyst | Claude 바이너리 crash는 아무것도 stream되기 전이면 한 번 재시도(`ClaudeCodeProvider.ts` L246-251) | — | — |
| Paperclip | reaper가 "Process lost -- …"로 표시하고 재시도 실행을 만든다(`services/heartbeat/recovery.ts` L298-314, L400-411) | 해당 없음(adapter) | 같음 |
| Multica | 고아 작업을 실패로 끝내고 자동 재시도(`handler/task_lifecycle.go` L20-27) | 해당 없음 | daemon이 고아를 보고, sweeper가 뒷받침(`cmd/server/runtime_sweeper.go` L599) |
| AO | — | — | `persistenthost`가 프로바이더 프로세스를 살려 두고 ACP 상태를 이어 준다 |
| OpenClaw | 시간 예산 안에서 새 세션으로 재시도(`src/agents/cli-runner/cli-run-recovery.ts` L45-75) | 유휴 10분 뒤 닫음 | — |

[추론] 상주 모양(다)은 "턴 사이 사망"이라는 새 실패 지점과 회수(idle collection) 규칙을 만든다. 턴 범위 모양(나)·(가)는 프로세스가 실행 시도와 함께 끝나므로 이 문제가 없고, 서버 재시작은 지금 계약의 `server_restart`(깨우기를 다시 대기시켜 다음 실행 시도가 받음)와 그대로 맞는다.

### ACP를 세 번째 선택지로 볼 때

- ACP 연결은 본질적으로 모양 (다)다. 한 ACP 프로세스가 `session/new`·`session/load`로 여러 세션을 가진다(Zed). 실행 시도마다 ACP 프로세스를 띄우면 (나)처럼 쓸 수도 있다. [소스·추론]
- Paseo는 ACP를 새 프로바이더의 "recommended" 경로로 두지만(`docs/providers.md` L45-49) **Claude·Codex·OpenCode는 직접 adapter로 구현했다**(L62-66). 직접 구현에서만 steer(Claude 입력 push, Codex `turn/steer`)·정확한 MCP 미리 승인·사용량 세부를 쓴다. Paseo의 ACP client에는 `steerActiveTurn`이 없다(`acp-agent.ts`에 steer 없음, 취소는 `connection.cancel` L2526) [소스]. Paseo 무인 실행의 정확한 MCP 미리 승인도 "custom ACP providers remain unsupported"다([`docs/hub.md` L103](https://github.com/getpaseo/paseo/blob/75f58c4fe7d3180e3ff74e10480bf0dc1111f37d/docs/hub.md#L103)) [문서].
- ACP를 주 경로로 쓰는 Zed·Emdash는 steer가 없고 대체는 중단 후 재전송·줄 세우기다 [소스].
- [추론] ACP는 Claude·Codex에서 adapter 패키지 하나(내부에서 Agent SDK·app-server를 다시 씀)를 더 거치고 steer·지침 교체·권한 기본값은 여전히 `_meta`·확장이다([executor-capabilities.md](executor-capabilities.md#acp를-공통-기반으로-쓸-때)). 네 프로바이더에 공통으로 얻는 것이 취소·세션 모양 정도라서, 네 개를 함께 설계하는 지금은 주 경로로 이득이 작다.

## D2. 조직 도구 노출

### 통로와 토큰

| 레퍼런스 | 제품 도구 통로 | 토큰 범위 | 토큰 전달 |
|---|---|---|---|
| Paseo | 기본은 loopback HTTP MCP `/mcp/agents`. "Paseo tools are not implemented as MCP tools internally … MCP is only the fallback adapter"(`docs/providers.md` L72). 프로바이더가 도구를 직접 등록할 수 있으면 `supportsNativePaseoTools: true`로 같은 목록을 고유 수단으로 주고 MCP 서버를 빼서 두 번 받지 않게 한다(L74) | **데몬 기동마다 하나**(`bootstrap.ts` L710 `randomUUID()`). 호출자 에이전트는 URL query `?callerAgentId=`로 전한다(`runtime-mcp-config.ts` L29-57) | MCP 설정의 `headers.Authorization: Bearer`. Claude는 SDK가 `--mcp-config`를 **inline JSON 인자**로 넘긴다(`providers/claude/query.ts` L88-91 주석) → 토큰이 argv에 들어감[추론]. Codex는 `thread/start`의 `config.mcp_servers.<name>.http_headers`로 stdin JSON-RPC에 실음(`codex-app-server-agent.ts` L887-910, L5398-5413). OpenCode는 고유 plugin bridge(아래). 저장 설정에서는 이 서버를 빼고 실행 때만 붙인다(`stripInternalPaseoMcpServer`) |
| Paseo OpenCode bridge | `OPENCODE_CONFIG_CONTENT`에 Paseo plugin(.mjs)을 넣고 plugin이 데몬의 private loopback bridge를 부른다. "Bridge context lives only in daemon memory and is removed when the Paseo session closes. The content-addressed plugin artifacts contain no session data or secrets."(`docs/providers.md` L104) | bridge 프로세스마다 `randomBytes(32)`(`opencode/bridge.ts` L57) | plugin 옵션으로 `OPENCODE_CONFIG_CONTENT` env 안에. 세션 귀속은 OpenCode session ID로 데몬 메모리에서 찾음 |
| Nimbalyst | loopback HTTP/SSE MCP(`127.0.0.1:<port>/mcp/core` 등). 주석 "localhost MCP servers require a per-launch bearer token"(`packages/runtime/src/ai/server/services/McpConfigService.ts` L125-130) | 앱 기동마다 하나(`randomBytes(32)`, `electron/src/main/mcp/mcpAuth.ts` L28) | MCP 설정 `headers`. OpenCode에는 실행 중 `POST /mcp`로 등록(`OpenCodeSDKProtocol.ts` L767-785) |
| Sculptor | Claude SDK MCP(`--mcp-config {"type":"sdk"}`): 도구 호출이 stdin/stdout `control_request mcp_message`로 온다. 네트워크·토큰 없음(`process_manager_utils.py` L94-100, `mcp_server.py` L1-9) | 해당 없음 | 해당 없음 |
| Vibe Kanban | stdio MCP `npx vibe-kanban@latest --mcp`를 사용자가 프로바이더 **전역 설정**에 넣음(`crates/executors/default_mcp.json`). `VIBE_BACKEND_URL`·port 파일로 서버를 찾고 **인증 없음**(`crates/mcp/src/bin/vibe_kanban_mcp.rs` L101-131) | 없음 | — |
| Emdash | 제품 MCP 없음. 제품으로 돌아오는 통로는 lifecycle hook(`curl` → `127.0.0.1:$EMDASH_HOOK_PORT/hook`) | hook nonce env | "The `X-Emdash-Token` header never enters a process's argv, which other local users can read (`/proc/<pid>/cmdline`)": `printf`로 curl 설정을 fd 3에 씀(`packages/core/src/primitives/exec/api/loopback-curl.ts` L1-24) |
| Zed | 자기 도구는 ACP client capability(fs·terminal)로, MCP 아님(`v1.rs` L505-510) | — | 프로젝트 MCP 서버는 ACP `session/new`의 HTTP header로 전달(L1204-1227) |
| Paperclip | env의 실행 범위 JWT(`PAPERCLIP_API_KEY`, `sub`=agent, `run_id`, `exp`)를 읽는 REST API + stdio MCP wrapper(`packages/mcp-server`). 주석: "never accepted from config — the harness-minted run token is the only source"(`claude-local/src/server/execute.ts` L305, `server/src/agent-auth-jwt.ts` L123-148) | **실행마다** | Claude: 실행별 HTTP MCP 설정을 `<stateDir>/runs/<runId>/mcp/mcp-config.json`에 **mode 0o600**으로 쓰고 `--mcp-config <path> --strict-mcp-config`(`claude-config.ts` L157-184, `execute.ts` L869-871). Codex: 에이전트별 `CODEX_HOME/config.toml`의 관리 블록 `http_headers = { Authorization = "Bearer …" }`(`codex-home.ts` L355-360) |
| Multica | 제품 CLI `multica` + env `MULTICA_TOKEN`. 주석: "MULTICA_TOKEN is bound to (agent, task) by the server. Never fall back to the daemon's own credential"(`internal/daemon/daemon.go` L8562-8564) | **작업마다** | env. 사용자 MCP는 Claude 임시 파일 `--mcp-config`, Codex 작업별 `$CODEX_HOME/config.toml`(0o600) |
| AO | 제품 CLI `ao` + env `AO_SESSION_ID`. loopback HTTP는 "Unauthenticated: safe only because nothing off-box can reach it"(`CONTEXT.md` L9) | 없음 | — |
| OpenClaw | loopback HTTP MCP `openclaw`(`http://127.0.0.1:<port>/mcp`) | **실행마다** grant | env `OPENCLAW_MCP_TOKEN`, MCP 설정 header는 env 확장 template `"Bearer ${OPENCLAW_MCP_TOKEN}"`(`src/gateway/mcp-http.loopback-runtime.ts` L331-345). 설정 파일은 `mkdtemp` 임시 디렉터리 → `--strict-mcp-config --mcp-config`. Claude OAuth 토큰은 fd 3으로(`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, `cli-backend.ts` L106-171). Codex에는 MCP 대신 app-server `dynamicTools`(`attempt-startup.ts` L451) |

[추론] **실행(작업) 범위 토큰은 Paperclip·Multica·OpenClaw가 쓰고, 모두 프로세스가 그 실행과 함께 끝나거나(Paperclip adapter·Multica) 실행마다 MCP 설정을 다시 넘긴다(OpenClaw).** 데몬 하나 토큰 + 호출자 ID를 query로 받는 Paseo 방식은 호출자 ID가 인증되지 않는다(같은 토큰을 가진 어떤 프로세스든 다른 `callerAgentId`를 댈 수 있음). BaboJUBot은 조직 경계를 토큰에서만 정하므로([구조 문서](../architecture.md#agent--control-plane-조직-도구)) 실행 시도 토큰을 유지하는 쪽이 Paperclip·Multica와 같다. 실행 시도 토큰은 실행 시도가 끝나면 무효라서, MCP 설정이 세션 시작 때 고정되는 상주 모양(다)과는 맞지 않는다 — 상주 프로세스가 다음 실행 시도에서 새 토큰을 받으려면 MCP 재연결이나 프로세스 재시작이 필요하다.

### 토큰이 어디에 보이는가

| 전달 위치 | 누가 읽을 수 있나 | 사례 |
|---|---|---|
| argv | 같은 기기의 다른 사용자도 `/proc/<pid>/cmdline`·`ps`로 [문서: Emdash 주석] | Paseo Claude(SDK inline `--mcp-config`)[추론], `claude --mcp-config '<json>'`를 그대로 쓰는 경우 |
| env | 같은 사용자와 root(`/proc/<pid>/environ`은 소유자 전용)[추론]. 자식 프로세스(모델이 돌리는 shell 명령 포함)에 상속됨 | Paseo OpenCode bridge(`OPENCODE_CONFIG_CONTENT`), Codex `bearer_token_env_var`, OpenCode `{env:VAR}`, Emdash hook nonce |
| workspace 파일 | 그 workspace를 읽는 모든 실행·에이전트·모델이 쓰는 파일 도구 | Antigravity `.agents/mcp_config.json`(실행별 flag 없음) |
| stdin 프로토콜 | 부모 프로세스만 | Codex app-server `thread/start` config(Paseo), Claude SDK MCP(Sculptor), ACP `session/new.mcpServers` |
| 0600 임시 파일 | 같은 사용자 | Paperclip Claude(`runs/<runId>/mcp/mcp-config.json`), Multica Codex `config.toml`, OpenClaw `mkdtemp` 설정(토큰은 env 확장) |
| 파일 기술자(fd 3) | 부모와 그 자식 | OpenClaw Claude OAuth 토큰, Emdash hook header |

[추론] env는 프로바이더가 돌리는 shell 명령에도 상속되므로 모델이 `env`를 출력해 토큰을 볼 수 있다. 다만 그 토큰은 같은 실행 시도의 권한만 가지므로 모델이 이미 MCP로 쓸 수 있는 권한 이상을 주지 않는다. argv는 다른 OS 사용자에게도 보여 더 넓다. 프로바이더 env를 허용 목록으로 만들고 토큰 변수를 shell 도구 자식에게서 지울 수 있는지는 프로바이더마다 미확인이다.

### 기본 도구 제한과 미리 승인(무인 실행)

- **Paseo "Exact MCP preapproval".** "A new provider must fail closed for Hub unattended execution until it can approve one exact injected MCP server and tool identity without approving native tools."([`docs/providers.md` L39-41](https://github.com/getpaseo/paseo/blob/75f58c4fe7d3180e3ff74e10480bf0dc1111f37d/docs/providers.md#L39-L41)) `PROVIDER_CONTRACTS`가 Claude·Codex·OpenCode만 `supportsExactMcpPreapproval: true`이고 나머지는 생성 시 오류(`provider-registry.ts` L148-161, `agent-manager.ts` L5462-5478). 미리 승인한 도구의 서버가 같은 요청에 없으면 거부한다. 프로바이더별 대응 [소스]:
  - Claude: `allowedTools`에 `mcp__<server>__<tool>`를 더함(`providers/claude/options.ts` L93-103).
  - Codex: 서버별 `enabled_tools: [tools]`, `default_tools_approval_mode: "prompt"`, `tools.<tool>.approval_mode: "approve"`(`providers/codex/options.ts` L63-83).
  - OpenCode v2: permission rule `{action: "<server>_<tool>", resource: "*", effect: "allow"}`(`opencode/v2/configuration.ts` L24-42).
- **주의: Claude `allowedTools`는 제한이 아니다.** 공식 문서: "Tools to auto-approve without prompting … This does not restrict Claude to only these tools. … Use `disallowedTools` to block tools." `tools`가 기본 도구 집합을 정하고, `strictMcpConfig`는 "Use only the servers passed in `mcpServers` and ignore project `.mcp.json`, user settings, plugin-provided MCP servers, and claude.ai connectors."([Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript)) [문서]
- **Paseo는 사용자 설정을 그대로 읽는다.** Claude `settingSources: ["user","project","local"]`(`providers/claude/agent.ts` L156-160), 프리셋 system prompt에 append. 개인 도구라서다. 우리 조직 경계 요구와 반대다 [소스·추론].
- **OpenClaw**는 Claude에 `--allowedTools mcp__openclaw__*`만 미리 승인하고 `ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor`를 막는다(`extensions/anthropic/cli-backend.ts` L52-55) — 실행 밖으로 이어지는 백그라운드 일을 막는 목록이다 [소스].
- **Paperclip은 반대 판단을 적는다.** Claude 기본 `--dangerously-skip-permissions`, 주석: "A tool allowlist is not equivalent to full bypass: it misses MCP tools and tools added by later provider releases"(`claude-local/src/server/permissions.ts` L7-13). Codex `--dangerously-bypass-approvals-and-sandbox`, OpenCode는 임시 `XDG_CONFIG_HOME`에 `permission:"allow"` + `OPENCODE_DISABLE_PROJECT_CONFIG=true` [소스]. 즉 "목록 방식은 새 버전 도구를 놓친다"는 위험을 전체 허용으로 피했다.
- **다른 레퍼런스도 대부분 전체 허용이다** [소스]. Multica: Claude `bypassPermissions`, Codex 승인 자동 수락 + Linux `danger-full-access`. Emdash: Claude `--dangerously-skip-permissions`, Codex `-c approval_policy=never -c sandbox_mode=danger-full-access`, OpenCode `OPENCODE_PERMISSION={"*":"allow"}`, agy `--dangerously-skip-permissions`. Nimbalyst: 내부 MCP 도구 자동 허용(`claudeCode/toolPolicy.ts` L11-17), Codex workspace-write + approval never. Sculptor: `--dangerously-skip-permissions` + `AskUserQuestion,ExitPlanMode`를 막고 `mcp__sculptor__*`로 대체(L101). Vibe Kanban: 승인 모드에서 `--permission-prompt-tool=stdio` + PreToolUse hook.
- **Antigravity는 우리 MCP를 실행별로 줄 수 없다** [소스]. Paseo fixture(agy 1.2.13): workspace `.agents/mcp_config.json`은 발견됨(`mcp-project`). 실행 소유 디렉터리를 두 번째 `--add-dir`로 주면 MCP는 발견되지만 shell 기본 디렉터리가 그 소유 디렉터리로 바뀌고 쓰기가 두 곳에 생긴다(`mcp-second-add-dir`, `mcp-owned-first-add-dir`). custom agent 파일에 넣은 `mcpServers`는 발견되지 않았다(`mcp-agent-definition`·`mcp-agent-discovered`). 그리고 strict schema MCP 서버에 대한 호출이 `arguments`를 문자열로 보내 실패했다(`mcp-http.requests.ndjson`). 출처: `plugins/antigravity-provider/test/fixtures/README.md`. 1.4.10에서 같은지는 미확인.

## D3. 세션 연속성

| 레퍼런스 | 저장하는 것 | 재개 | 새로 시작하는 조건 | 세션이 없을 때 |
|---|---|---|---|---|
| Paseo | `AgentPersistenceHandle{provider, sessionId, nativeHandle, metadata}`(`agent-sdk-types.ts` L184-190). Antigravity는 `{version:1, data:{conversationId}}` | Claude `resume: sessionId`(새 세션은 `sessionId`로 ID를 정해 시작, `agent.ts` L3663-3668), Codex `thread/resume`(L4102), OpenCode 세션 ID, Antigravity `--conversation <id>` | 에이전트는 프로바이더에 묶여 있음(handle에 provider). 모델·모드 변경은 같은 세션에서 `setModel`·`setMode`, Antigravity는 `[model, mode]`가 바뀌면 프로세스를 다시 띄우되 같은 conversation(`antigravity process.ts` `selection`, `session.ts` L202-206). Claude rewind는 새 세션 ID로 | "OpenCode owns storage migration; a missing native session must fail resume rather than create a replacement"(`docs/providers.md` L98). Antigravity는 init의 conversation_id가 다르면 `INVALID_RESUME`(`session.ts` L219-224). Claude resume은 원래 cwd 필요(`agent.ts` L1663) |
| Vibe Kanban | 턴별 `agent_session_id`(`crates/db/src/models/coding_agent_turn.rs`) | Claude `--resume`, **Codex는 `thread/fork`로 매 턴 새 thread**, OpenCode `POST /session/{id}/fork` | 세션 안 프로바이더 변경은 `ExecutorMismatch` | — |
| Emdash | `conversations.provider_session_id` | ACP `loadSession` | — | 한 번도 쓰지 않았고 프로바이더가 not-found를 알릴 때만 새 세션, 아니면 오류(`session-materializer.ts` L93-185). agy: "passing an unknown id makes agy warn and mint a fresh session, so only pass the hook-captured native id"(`antigravity/index.ts` L107-110) |
| Sculptor | `session_id`·`validated_session_id` 상태 파일 | `--resume` | — | `.claude/projects` 기록으로 ID를 확인하고, 틀리면 마지막으로 확인된 ID로 경고와 함께 되돌림(`process_manager.py` L665-683) |
| Nimbalyst | `provider_session_id` | Claude `options.resume`(분기는 `forkSession`), Codex 새로 띄운 자식에 `thread/resume` | — | — |
| Zed | thread metadata의 session ID | agent가 알리면 `session/load` → `session/resume` | — | 둘 다 없으면 "not supported" 문구 |
| Paperclip | 실행의 `sessionParams`에 세션 ID + `cwd`·`promptBundleKey`·`mcpServerIdentity`·실행 대상(`claude-local/execute.ts` L763-789) | Claude `--resume`, Codex `exec resume` | cwd·prompt bundle·실행 대상이 바뀌면 새로(L790-821). MCP 서버 변경은 재개 유지: "Each CLI invocation loads --mcp-config, including --resume invocations" | **같은 실행에서 새 세션으로 재시도**(L1371-1401) |
| Multica | (에이전트, 이슈)별 마지막 작업 세션, 오염·폐기 세션은 건너뜀(`pkg/db/queries/agent.sql` L1016-1030) | 각 CLI 재개 | 저장 세션의 `RuntimeID`가 지금 작업과 같을 때만 재개(`handler/daemon.go` L3474) | — |
| AO | 프로바이더 대화 ID | ACP `session/load`·Codex `thread/resume` | 프로바이더 변경: "a fresh native thread seeded with the handoff note: native histories cannot be merged across harnesses" | `FreshIfMissing`은 대화가 시작된 적 없다는 증거가 있을 때만(`acp/driver.go` L425-440) |
| OpenClaw | `cliSessionBindings[provider]` | Claude `--resume` | 인증 profile·인증 epoch·메시지 도구 정책·cwd·MCP 설정 hash·prompt 도구 이름이 바뀌면 새로. 이유: "The loopback bridge cannot notify a resumed CLI to refresh its cached tool catalog"(`src/agents/cli-session.ts` L201-285). system prompt 변경은 `reuse-with-drift`(유지하고 기록) | 시간 예산 안에서 새 세션 재시도 |

프로바이더 세션 상태 위치 [executor-capabilities.md](executor-capabilities.md#5-세션) + 이번 확인:

| 프로바이더 | 저장 위치 | 호출자가 새 ID를 정함 | 재개 시 지침 |
|---|---|---|---|
| Claude | `$CLAUDE_CONFIG_DIR`(기본 `~/.claude`)`/projects/<cwd>/<id>.jsonl` | 있음(`--session-id`·SDK `sessionId`) | 첫 system prompt 고정(snapshot, 기본) |
| Codex | `$CODEX_HOME/sessions` rollout JSONL | 없음 | app-server `thread/resume`이 지침·모델을 다시 받음(결합 방식 미확인) |
| OpenCode | `$XDG_DATA_HOME/opencode/opencode.db` | 없음 | 매 단계 다시 읽음 |
| Antigravity | `~/.gemini/antigravity-cli/conversations/<uuid>.db`. 대화 기록은 재생하지 않음("Antigravity remembers the conversation, but Paseo's transcript starts fresh because `agy` does not replay its history", `supported-providers.md` L35-36) | 없음 | 미확인. Paseo는 system prompt를 **첫 메시지 앞에 붙여** 넣는다(`antigravity session.ts` L117-120) |

프로바이더 홈 분리 [소스]: Paperclip은 에이전트별 `CLAUDE_CONFIG_DIR`(`companies/<c>/agents/<a>/claude-runtime`, `claude-config.ts` L144-155)와 에이전트·회사별 `CODEX_HOME`, Multica는 작업별 `CODEX_HOME`에 공유 `auth.json`을 symlink(`execenv/codex_home.go` L194-229), AO는 계정별 `CLAUDE_CONFIG_DIR`+`CLAUDE_SECURESTORAGE_CONFIG_DIR`·`CODEX_HOME`, OpenClaw Codex `homeScope` 기본 `"agent"`.

[추론] 분리하지 않으면 세션 상태는 모두 프로바이더 홈 디렉터리(사용자 로그인과 같은 곳)에 쌓인다. 조직마다 홈을 나누면 로그인 파일도 나눠야 하고(Codex·OpenCode), 나누지 않으면 여러 조직의 세션 기록이 한 디렉터리에 섞인다. 섞여도 다른 조직 세션 ID를 알아야 재개할 수 있으므로 경계는 우리 DB의 세션 상태가 지킨다. 다만 Codex `--last`·Claude `-c`처럼 "최근 세션"을 고르는 flag는 쓰면 안 된다.

## D4. 취소

| 레퍼런스·프로바이더 | 1단계(프로토콜 안) | 2단계 signal | 유예 | 트리 정리 | 취소 확인 |
|---|---|---|---|---|---|
| Paseo 공통 | `session.interrupt()`를 2초 기다림(`INTERRUPT_SESSION_TIMEOUT_MS`, `agent-manager.ts` L105, L3332-3380) | — | 확인되면 턴 정리를 다시 2초 기다리고, 넘으면 `turn_canceled`를 강제로 보냄 | — | 중단이 확인되지 않으면 `refused`: "if the cancel never succeeded you never proved the run stopped, so refuse new runs until the next Stop"(`docs/providers.md` L581) |
| Paseo Claude | 미시작 메시지 철회 → `query.interrupt()`(메인 턴이 진행 중일 때만) | 세션 close 시 SIGTERM → 2초 → SIGKILL, `tree-kill`로 트리 전체("The SDK's internal cleanup may only kill the direct child process", `agent.ts` L3031-3045) | 2초+2초 | 있음 | 턴의 `result` |
| Paseo Codex | `turn/interrupt`(2초 제한, 이미 idle이면 성공 처리) | dispose 시 stdin 닫기 → SIGTERM → 2초 → SIGKILL(`codex/app-server-transport.ts` L281-303) | 2초+1초 | `detached` process group | 턴 `interrupted` |
| Paseo OpenCode v2 | `session.interrupt` 후 실행 이벤트로 재조정, 턴 완료 대기(`v2/turns.ts` L350-370). "Session-scoped cancellation needs a stop boundary": 세션 범위 취소가 다음 실행을 죽이지 않게 `stopping` 상태로 막음(`docs/providers.md` L576-582) | 서버 종료 시 SIGTERM → 5초 → SIGKILL(`v2/runtime.ts` L198-203) | 5초+1초 | 있음 + 관리 프로세스 장부 | 실행 이벤트 |
| Paseo Antigravity | 없음 | **SIGINT를 process group에** → 1초 → SIGTERM → 2초 → SIGKILL, 끝난 뒤에도 group SIGKILL("A tool can keep running after its CLI leader exits", `antigravity process.ts` L160-180) | 1초·2초 | `process.kill(-pid)` | `result.status: ERROR`, `error: "interrupted"`(`session.ts` L262-270). fixture: SIGINT·SIGTERM 모두 interrupted result + 종료 1(`sigint-mid-text`·`sigint-mid-tool`·`sigterm`) |
| Vibe Kanban | Claude `control interrupt` 후 result까지 읽음(`claude/protocol.rs` L63-69). **Codex는 `turn/interrupt`를 쓰지 않음**, OpenCode `POST /session/{id}/abort` | killpg SIGINT → SIGTERM → SIGKILL, 2초 간격(`crates/utils/src/process.rs` L5-30) | 취소 후 5초 대기 뒤 group kill(`container.rs` L1426-1450) | 있음 | — |
| Sculptor(Claude) | stdin `control_request {"subtype":"interrupt"}`, 5초 | SIGTERM group 2초 → SIGKILL 2초 | 5+2+2초 | 있음 | 그래도 안 끝나면 thread를 버리고 `RequestSuccess(interrupted=True)`(`process_manager.py` L320-468) |
| Nimbalyst | Claude `query.interrupt()`("graceful … doesn't kill the SDK subprocess"), Codex `turn/interrupt`, OpenCode `session.abort` | cleanup 때 트리 kill | — | 있음 | — |
| Emdash | ACP `session/cancel` | SIGTERM `-pid` → 1초 → SIGKILL, Windows `taskkill /T` | 1초 | 있음 | — |
| Zed | ACP `CancelNotification` 후 idle 대기 | Drop 시 자식 kill | — | 미확인 | "Agent connection lost before cancellation was confirmed"(`acp_thread.rs` L7511-7580) |
| Paperclip | 없음(adapter) | process group SIGTERM → `graceSec` → SIGKILL(`adapter-utils/src/server-utils.ts` L124-146). **Codex는 SIGINT**: "Codex handles Ctrl-C by cancelling its tool sessions. SIGTERM can leave commands in their separate process groups alive"(`heartbeat/run-control.ts` L1393) | Claude 기본 20초 | 있음 | 실행 행을 `cancelled`로 |
| Multica | Claude: stdin 닫기. Codex: `turn/interrupt` 2초 → 정상 종료 10초. OpenCode ACP `session/cancel` 5초 | Claude group SIGTERM → 5초 → SIGKILL. 기본은 `cmd.Cancel` = group SIGKILL(`launch.go` L120-141) | 2–10초 | 있음 | daemon이 5초마다 작업 상태를 보고 `TaskCancelAck`로 기록 |
| AO | ACP `session/cancel`·Codex `turn/interrupt` | stdin 닫기 1초 → SIGTERM → 3초 기한 kill. group SIGTERM → 2초 → SIGKILL(`process/tree_unix.go` L32-39) | 1–3초 | 있음 | — |
| OpenClaw | Codex `turn/interrupt` 후 `turn/completed` 대기 | Claude: stdin EOF → SIGTERM → 1초 → SIGKILL(`anthropic/cli-transport.ts` L14, L69-100). Codex group SIGKILL | 1초 | 있음 | Codex 종료 이벤트 |

[추론] 공통 순서는 "프로토콜 안 중단 → 확인 대기(2–5초) → process group SIGTERM → 유예(1–5초) → SIGKILL"이다. 프로바이더 자식(MCP 서버·shell 명령)이 부모보다 오래 사는 것을 막으려고 모든 구현이 `detached`로 새 process group을 만들고 group 전체에 signal을 보낸다. 확인은 프로바이더 종료 이벤트(Claude `result`, Codex 턴 `interrupted`, Antigravity `result.status`)로 하고, 시간 안에 오지 않으면 강제 종료 후 "취소됨"을 제품이 기록한다.

## D5. 사용량 표시

### 실행 시도(턴)별

| 레퍼런스 | 토큰 | 비용 | context 사용량 |
|---|---|---|---|
| Paseo | `AgentUsage{inputTokens, cachedInputTokens, outputTokens, totalCostUsd, contextWindowMaxTokens, contextWindowUsedTokens}`(`agent-sdk-types.ts` L217-224), 턴 완료·`usage_updated` 이벤트 | Claude `total_cost_usd`만(`claude/agent.ts` L2210). Codex는 토큰만(`toAgentUsage`, `codex-app-server-agent.ts` L1055-1072). 화면은 값이 있을 때만 비용 표시(`app/src/components/context-window-meter.tsx` L184) | Claude `modelUsage[model].contextWindow`, Codex `model_context_window`·`last.total_tokens`, OpenCode step 토큰 합 + 모델 목록의 context 한도(`opencode/v2/usage.ts`) |
| Vibe Kanban | — | 기록 없음 | Claude `message_delta` + `result.modelUsage.contextWindow`, Codex `thread/tokenUsage/updated` |
| Sculptor | — | 턴별 `result.total_cost_usd` 기록(`output_processor.py` L1361) | 턴 끝 `get_context_usage` control request |
| Zed·Emdash | ACP `usage_update`(used, size, cost) | ACP cost가 있을 때 `SessionCost` | gauge, Zed는 0.8에서 경고 |

Claude 공식 문서는 `usage`가 "main agent loop only … and is per-turn in streaming-input sessions. Prefer `modelUsage` for token/cost accounting"이고 `total_cost_usd`는 "cumulative … A call that resumes a session also counts the totals restored from the session's earlier calls … an estimate, not a billing statement"라 적는다([Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript)) [문서]. 즉 재개 세션에서 `total_cost_usd`를 그대로 실행 시도 비용으로 쓰면 이전 실행 시도 비용이 겹친다 [추론].

### 계정 단위 요금제 사용량

- **Paseo Usage source.** 플러그인이 `discover(scope)`·`fetch(input)`로 계정별 `UsageReport{status, planLabel, windows[], balances[]}`를 낸다. 세션 scope는 "only the login that agent runs on"이고 그 세션 launch env(`CLAUDE_CONFIG_DIR`·`CODEX_HOME`)에서 로그인 저장소를 찾는다. 규칙: "Inputs name credential stores; never put credentials in inputs or reports." "Re-read the selected store in `fetch()` … Never redeem refresh tokens or write credential stores: refreshing elsewhere can invalidate the CLI's copy." 창 이름은 "must come from provider data"이고 모르면 "Primary limit" 같은 중립 이름. 5분 cache, 로그인당 20초 제한([`public-docs/plugins/reference.md` L441-560](https://github.com/getpaseo/paseo/blob/75f58c4fe7d3180e3ff74e10480bf0dc1111f37d/public-docs/plugins/reference.md#L441)). 화면은 사이드바의 고정한 창 %, Usage modal, 에이전트 context 상세의 그 에이전트 계정 카드(`docs/glossary.md` L38-41) [문서].
- **그 구현은 비공개 endpoint와 자격 증명 직접 읽기다** [소스]. Claude source는 로그인 저장소의 OAuth 토큰으로 `https://api.anthropic.com/api/oauth/usage`를 부르고 `five_hour`·`seven_day`·모델별 주간 창을 읽는다(`plugins/claude-usage-source/server/usage.ts` L45-135, L537). Codex source는 `https://chatgpt.com/backend-api/wham/usage`(`plugins/codex-usage-source/server/usage.ts` L207). Nimbalyst도 Claude는 Keychain·`.credentials.json`을 읽어 같은 사용량 API를 부르고(`ClaudeUsageService.ts` L1-20), Codex는 `account/rateLimits/read`(`CodexUsageService.ts` L168).
- **공식 경로가 있다.**
  - Codex: app-server `account/rateLimits/read`와 `account/rateLimits/updated` 알림(사용률·창 길이·reset·credits·plan, [executor-capabilities.md](executor-capabilities.md#7-사용량)). Emdash는 이것을 위해 `codex app-server`를 따로 띄워 `account/read`·`account/rateLimits/read`를 부른다(`plugins/src/agents/impl/codex/usage.ts` L14-31) [소스]. Vibe Kanban은 `/status` 슬래시 명령에서만 보인다 [소스].
  - Claude: Agent SDK에 `SDKUsageReport{session{total_cost_usd, model_usage, …}, rate_limits{limits[{kind, group, percent, resets_at, severity, is_active}], extra_usage}}`가 있다. "When you send `/usage` as a prompt, Claude Code delivers the report as an `SDKAssistantMessage` … It attaches `usage_report` … only if the session uses a claude.ai credential …" "The type is marked experimental."([Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript)) [문서]. Emdash는 SDK의 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`을 쓴다(`claude/usage.ts` L106-145) [소스]. SDK `SDKMessage`에 `SDKRateLimitEvent`도 있으나 필드 정의는 읽지 못했다 [미확인]. Vibe Kanban은 `rate_limit_event`를 파싱하고 버리며(`claude.rs` L1954), Sculptor는 한도 거부 때 `rate_limit_info.resetsAt`을 보인다(`output_processor.py` L198-206) [소스].
  - OpenCode: 계정 한도 수단 없음. ChatGPT 로그인이면 cost 0 [executor-capabilities.md].
  - Antigravity: 대화형 `/credits`·`/usage`만. 비대화 수단 미확인.
- **나머지 레퍼런스** [소스]:
  - Paperclip: 실행별 `usage`·`costUsd`·`usageByModel`을 `usageBasis:"per_run"`으로 기록(`claude-local/execute.ts` L1123-1135). 계정 창은 adapter 선택 멤버 `getQuotaWindows`(`server/src/services/quota-windows.ts` L152-160): Claude `api/oauth/usage`(대체로 PTY에서 CLI `/usage`), Codex `wham/usage` + `account/rateLimits/read`.
  - Multica: 작업별 토큰(`ReportTaskUsage`), 비용은 서버 가격표로 추정(`internal/metrics/pricing.go`). 계정 창 없음.
  - AO: 대화별 토큰·비용·rate limit 칸 저장. Codex `account/rateLimits/read`와 `/updated` 알림. **Claude는 stream-json control request `get_usage`**(`{"subtype":"get_usage","skip_behaviors":true}`)로 five_hour·seven_day·opus·sonnet 창을 읽는다(`backend/internal/adapters/agentaccount/claude.go` L120-167). 자격 증명을 읽지 않고 Claude 프로세스에 묻는 방식이다. 이 subtype은 Agent SDK 공개 문서에서 확인하지 못했다 [미확인].
  - OpenClaw: 실행별 `usage`. Claude `api/oauth/usage`(대체 claude.ai web API), Codex `wham/usage`·`account/rateLimits/read`.

## BaboJUBot에 주는 시사점

설계 제안이며 결정이 아니다. 근거 표시가 없는 판단은 [추론]이다.

### 권고 1. 공통 방향: "실행 시도 범위 양방향 연결" — 실행 시도마다 프로바이더 프로세스를 하나 띄우고, 프로토콜로 제어하고, 실행 시도가 끝나면 닫는다 — 채택 후보

- 모양 (나)다. 한 번 실행 headless(가)는 쓰지 않는다. 상주(다)는 보류한다.
- 실행 시도와의 대응: 실행 시도 시작 = 프로세스 시작(+ 세션 재개), 실행 시도의 첫 입력 = 깨우기 묶음, 실행 시도 종료 = 프로바이더의 턴 종료 이벤트 → `RunResult` → 프로세스 정상 종료(stdin 닫기 → 유예 → group kill). 지금 `RuntimeAdapter.execute(request, {signal, emit}) → RunResult` 계약을 바꾸지 않는다.
- 이유:
  - (가)에 없는 것을 얻는다: steer, 프로토콜 안 중단(Claude `interrupt`, Codex `turn/interrupt`, OpenCode `abort`), 명확한 종료 이벤트(OpenCode `run`에는 없음), 권한 질문 왕복. "steer가 Claude만"이라는 첫 조사의 인상은 (가)를 전제해서 생긴 것이고, (나)에서는 Claude·Codex·OpenCode 세 개가 steer를 가진다 [소스: Paseo].
  - (다)가 만드는 문제를 피한다: 실행 시도 토큰이 실행 시도와 함께 끝나므로 MCP 설정이 세션 시작 때 고정돼도 맞다. "턴 사이 사망"·유휴 회수·관리 프로세스 장부(Paseo `agent-lifecycle.md` L48-104, `providers.md` L128-134)가 필요 없다. 서버 재시작은 지금의 `server_restart` 규칙(취소 → 깨우기 재대기 → 다음 실행 시도)이 그대로 맞는다.
  - 레퍼런스 근거: Multica가 네 프로바이더 모두(Claude stream-json 입력, Codex app-server, OpenCode acp, agy stream-json), Vibe Kanban이 세 프로바이더에서 이 모양이고, Sculptor가 Claude에서 같다 [소스]. 셋 모두 작업·턴 범위 토큰 또는 토큰 없음과 짝을 이룬다.
  - 반대 근거: Paperclip은 한 번 실행 adapter에서 상주 native runner로 옮겨 가는 중이고(steer를 위해), AO·OpenClaw·Paseo도 상주다. 상주의 이점(시작 비용 없음, 백그라운드 일 유지, OpenClaw Claude 10분 유휴 유지)은 실재한다 [소스·추론].
- 비용·위험:
  - 실행 시도마다 시작 비용(프로세스 기동, MCP 연결, Codex `initialize`·`thread/resume`, OpenCode 서버 준비 최대 30초 제한, Paseo 기준)이 든다. Lead처럼 자주 깨는 에이전트에서 체감될 수 있다 → 상주는 측정 후 보류 항목으로.
  - Claude background Bash·Monitor처럼 프로세스 안에 사는 일은 실행 시도가 끝나면 사라진다. 실행 시도는 "결과로 끝난다"는 계약상 맞지만, 역할 문서에 "실행 시도 밖으로 이어지는 백그라운드 작업은 외부 job으로"를 적어야 한다.

### 권고 2. 프로바이더별 경로 — Claude·OpenCode 채택 후보, Codex 조건부 채택 후보, Antigravity 보류

| 프로바이더 | 경로 | 실행 시도에 대응 | 판정 |
|---|---|---|---|
| Claude Code | `claude -p --input-format stream-json --output-format stream-json --verbose` + control protocol. CLI를 직접 쓰거나 Agent SDK `query()`(같은 바이너리를 같은 방식으로 띄움) | 깨우기 묶음을 첫 user message로 → `result` 한 번 → stdin 닫기 | **채택 후보.** SDK와 CLI 직접의 선택은 구현 때(SDK는 `cancelAsyncMessage`·`interrupt` 응답 형식을 대신 맞춰 주지만 npm 의존성이 늘고, `--mcp-config`를 inline argv로 넘긴다 — 권고 4) |
| Codex | `codex app-server`(stdio) → `initialize` → `thread/start`·`thread/resume` → `turn/start` → `turn/completed` → 종료 | 실행 시도 = `turn/start` 하나 | **조건부 채택 후보.** steer·argv 밖 MCP 설정·한도 조회를 얻지만 OpenAI는 app-server를 "experimental … not supported for production workloads"라 하고 자동화에는 SDK(exec)를 권한다 [문서]. 조건: CLI 버전 고정 + 공통 검사로 확인 + 같은 이벤트 매핑의 `codex exec --json` 대체 adapter를 남겨 둠(잃는 것은 steer). Paseo·Nimbalyst·Vibe Kanban·codex-acp 모두 app-server를 쓴다 [소스] |
| OpenCode | 실행 시도마다 `opencode serve --hostname 127.0.0.1 --port 0`(`OPENCODE_SERVER_PASSWORD` 무작위, `XDG_CONFIG_HOME` 실행별, `OPENCODE_CONFIG_CONTENT`로 MCP·permission) → prompt → `session.idle`/`session.error` → abort/종료 | 실행 시도 = prompt 하나 | **채택 후보.** `opencode run`은 signal 처리가 없어 계약의 "정리 후 `cancelled`"를 못 지킨다. 서버의 MCP가 위치 범위라 실행 시도마다 서버를 나누는 것이 토큰 분리에도 맞다(Paseo `providers.md` L106). Paseo는 v1·v2 API를 따로 구현했으므로 adapter는 설치 버전(1.18.23)을 고정하고 확인한다 |
| Antigravity | `agy --input-format stream-json --output-format stream-json`을 실행 시도마다(또는 `agy -p`, steer가 없으므로 차이가 작다) | 실행 시도 = 턴 하나 | **보류.** 소비자 요금제 약관 "not supported"(사용자 결정), 권한 질문을 못 내서 전체 허용만 가능(Paseo), 실행별 MCP 주입이 없고 우회(`--add-dir`)는 shell 기본 디렉터리를 바꾸며 strict MCP 호출이 실패한 기록이 있다(Paseo fixture, 1.2.13) |

- ACP를 주 경로로 쓰는 것은 **배제**(첫 판). 직접 adapter 셋이 steer·미리 승인을 가지는데 ACP 경유는 그것을 잃는다(Paseo가 Claude·Codex·OpenCode를 직접 구현한 것과 같은 판단). Antigravity를 열게 되면 그때 공개 ACP 서버를 다시 본다.

### 권고 3. 공통 계약에 더할 capability 칸 — 채택 후보

[프로바이더 선택 조사 권고 5](executor-selection-references.md#권고-5-capability는-adapter마다-빠짐없이-정적으로-선언하고-없는-기능은-화면에서-숨긴다--채택-후보)의 "기본값 없이 빠짐없이 선언"을 따르고, 칸은 이번 조사로 다음처럼 정한다.

| 칸(가칭) | 값 | Claude | Codex(app-server) | OpenCode(serve) | Antigravity |
|---|---|---|---|---|---|
| `steer` | `none` / `next_step`(진행 중 실행 시도의 다음 단계 경계에서 읽힘) | `next_step` | `next_step` | `next_step` | `none` |
| `gracefulCancel` | `protocol` / `signal` | `protocol` | `protocol` | `protocol` | `signal`(SIGINT) |
| `orgToolsTransport` | `mcp_http`(실행별 설정) / `workspace_file` / `none` | `mcp_http` | `mcp_http` | `mcp_http` | `workspace_file` 또는 `none` |
| `exactToolPreapproval` | 우리 MCP 서버의 정확한 도구만 자동 승인하고 기본 도구는 따로 제한할 수 있다 | 있음 | 있음 | 있음 | 없음 |
| `sessionResume` | `by_id` / `none` | `by_id`(호출자가 새 ID 지정 가능) | `by_id` | `by_id` | `by_id` |
| `instructionsOnResume` | `fixed_at_start` / `reapplied` / `unknown` | `fixed_at_start` | `unknown` | `reapplied` | `unknown` |
| `runUsage` | `tokens_and_cost` / `tokens` / `none` | `tokens_and_cost`(추정) | `tokens` | `tokens_and_cost`(ChatGPT 로그인 0) | `tokens` |
| `accountUsage` | `native`(문서화된 수단) / `none` | `native`(experimental `/usage` 보고) | `native`(`account/rateLimits/read`) | `none` | `none` |

- Paseo는 steer를 정적 flag가 아니라 선택 메서드로 두고 실행 시점 `unavailable`을 받는다. 우리는 화면이 실행 전에 "steer" 전달 방식을 보일지 정해야 하므로 **정적 칸 + 실행 시점 `unavailable` 둘 다** 둔다.
- 취소는 칸이 아니라 지금처럼 필수 약속이다. `gracefulCancel`은 공통 검사의 `cancelWithinMs`를 프로바이더별로 바꿀지에만 쓴다.

### 권고 4. 조직 도구는 실행 시도 토큰을 header로 받는 HTTP MCP 하나로 내고, 토큰은 argv에 두지 않는다 — 채택 후보. 프로바이더 고유 도구 등록은 보류

- 서버: `access.toolsBaseUrl` 아래 Streamable HTTP MCP endpoint 하나. 노출 목록은 core `checkToolCall`로 거른 목록, 서버는 호출마다 다시 검사(issue-86 D01-D03 그대로).
- 토큰 범위는 지금처럼 **실행 시도별**로 둔다. Paseo의 "데몬 토큰 + `callerAgentId` query"는 배제: 호출자가 인증되지 않아 조직 경계를 토큰에서만 정한다는 구조 원칙과 충돌한다.
- 전달 위치(프로바이더별):
  - Claude: `--mcp-config <0600 임시 파일 경로>` + `--strict-mcp-config`. Paperclip이 정확히 이 모양이다(`runs/<runId>/mcp/mcp-config.json`, mode 0o600) [소스]. 토큰을 파일에 직접 쓰거나, OpenClaw처럼 header를 `"Bearer ${BABO_RUN_TOKEN}"` env 확장 template로 두고 값은 env로 준다 [소스: OpenClaw, 직접 실행은 미확인]. 파일은 실행 시도가 끝나면 지운다. Agent SDK를 쓰면 SDK가 inline JSON을 argv로 넘기므로(Paseo `query.ts` 주석) 토큰이 argv에 보인다 → SDK를 쓸 때는 이 점을 해결한 뒤에만.
  - Codex: `thread/start`·`thread/resume`의 `config.mcp_servers.<name>`(`url`, `http_headers`)를 stdin JSON-RPC로. argv·파일에 남지 않는다(Paseo와 같음).
  - OpenCode: `OPENCODE_CONFIG_CONTENT`의 remote MCP `headers`에 `{env:BABO_RUN_TOKEN}`. 실행 시도마다 서버가 다르므로 섞이지 않는다.
  - Antigravity(보류 해제 시): workspace 파일만 가능 → 토큰이 workspace에 남는다. 이것이 보류 사유 중 하나.
- 미리 승인(무인 실행): Paseo "exact MCP preapproval"을 따른다. 우리 서버의 정확한 도구 이름만 자동 승인(Claude `allowedTools: mcp__babo__*` 아닌 도구별 이름, Codex `enabled_tools`+`approval_mode: "approve"`, OpenCode `permission` allow)하고, **그것을 못 하는 프로바이더는 실행을 거부**한다. 기본 도구 제한은 따로 한다(Claude `tools`·`disallowedTools`, Codex feature 끄기, OpenCode `permission` deny) — Claude `allowedTools`는 제한이 아니다([문서]).
- 고유 도구 등록(Paseo `supportsNativePaseoTools`, OpenCode plugin bridge, Claude SDK MCP)은 **보류**. HTTP MCP 하나로 네 프로바이더 중 셋이 되고, 고유 등록은 프로바이더마다 다른 코드가 서버 바깥에 생긴다.
- 위험: Paperclip 주석대로 "A tool allowlist … misses MCP tools and tools added by later provider releases". 우리는 반대로 "우리 도구만 자동 승인, 기본 도구는 명시 목록으로 제한"이라서 새 버전이 더한 도구는 **승인 없이 막히는** 쪽으로 실패한다(fail closed, 실행은 덜 되지만 경계는 유지). 프로바이더 버전을 고정하고 환경 확인에서 Claude `system/init.tools`처럼 보이는 도구 목록을 기록해 바뀌면 경고한다.
- 위험: env로 넘긴 토큰은 모델이 돌리는 shell 명령에 상속된다. 같은 실행 시도 권한이라 권한 상승은 아니지만 공개 활동·오류에 실리면 안 된다(지금 계약이 이미 금지). 프로바이더 env를 허용 목록으로 만드는 것은 [프로바이더 선택 조사 권고 8](executor-selection-references.md#권고-8-인증은-호스트에-로그인된-cli를-재사용하고-어느-계정으로-과금되는지-환경-확인에-보인다--채택-후보-api-key-저장은-보류)과 같다.

### 권고 5. 세션은 지금 계약대로 이어 가고, 재개에 실패하면 같은 실행 시도에서 새 세션으로 다시 시작하되 그 사실을 공개 활동에 남긴다 — 채택 후보

- `RunResult.nextSession`에 `{providerKind, sessionId}`(+ Claude는 cwd)를 넣는다. 새로 시작하는 조건: 지침 bundle 버전 변경(지금 계약), 프로바이더 종류 변경([선택 조사 권고 6](executor-selection-references.md#권고-6-프로바이더를-바꾸면-다음-실행-시도부터-새-세션으로-시작하고-조직-기록은-그대로-맥락에-들어간다--채택-후보)), workspace cwd 변경(Claude 기록이 cwd 범위, Paperclip·OpenClaw도 cwd를 조건으로 씀). **모델 변경은 같은 세션을 유지**한다(Paseo `setModel`, Antigravity는 같은 conversation으로 다시 띄움).
- **노출 도구 목록 변경(단계·Role 변경)은 새 세션 조건이 아니다.** 실행 시도마다 프로세스가 MCP에 새로 연결해 `tools/list`를 다시 받기 때문이다. Paperclip: "Each CLI invocation loads --mcp-config, including --resume invocations". OpenClaw가 도구 목록 변경을 새 세션 조건으로 두는 것은 상주 bridge가 "cannot notify a resumed CLI to refresh its cached tool catalog"이기 때문이다 [소스]. 서버는 어차피 호출마다 다시 검사한다(issue-86 D03).
- 재개 실패의 처리는 레퍼런스가 갈린다. 프로바이더 세션이 곧 기억인 Paseo·Emdash·AO는 실패로 드러내고, 제품 기록을 따로 가진 Paperclip·OpenClaw는 같은 실행 안에서 새 세션으로 재시도한다 [소스]. BaboJUBot은 맥락 묶음을 매 실행 시도에 넣으므로 후자에 가깝다. 다만 조용히 바꾸지 않고 `progress` 활동("이전 세션을 이어 가지 못해 새로 시작했습니다")을 남긴다. 다른 세션이 열린 경우(Antigravity `INVALID_RESUME` 같은 불일치)도 같게 다룬다.
- "최근 세션" flag(`-c`·`--last`)는 쓰지 않는다. Claude는 새 세션 ID를 우리가 정해(`--session-id`) 첫 실행 시도가 중간에 죽어도 ID를 잃지 않는다.
- 프로바이더 홈(`CLAUDE_CONFIG_DIR`·`CODEX_HOME`·`XDG_*`)을 조직마다 나누는 것은 계속 **보류**. 로그인 파일 사본 문제(Codex 공유 경고)가 그대로다.

### 권고 6. 취소는 "프로토콜 안 중단 → 확인 대기 → process group SIGTERM → SIGKILL"로 하고, 확인은 프로바이더 종료 이벤트로 한다 — 채택 후보

- 모든 프로바이더 프로세스를 새 process group(`detached`)으로 띄운다. 끝날 때(정상 종료 포함) group 전체를 정리한다(Paseo Antigravity "A tool can keep running after its CLI leader exits").
- 시간: 프로토콜 중단 확인 2초(Paseo) → group SIGTERM → 2초 → SIGKILL. 합계가 공통 검사 `cancelWithinMs`(기본 5초) 안에 들어간다. OpenCode 서버는 Paseo가 5초 유예를 주므로 실제 측정 후 조정. 프로토콜 안 중단이 없는 경로(Antigravity, Codex `exec` 대체 adapter)는 첫 signal을 SIGINT로 한다: Paperclip "Codex handles Ctrl-C by cancelling its tool sessions. SIGTERM can leave commands in their separate process groups alive", Paseo Antigravity도 SIGINT부터 [소스].
- 확인: Claude `result`, Codex 턴 `interrupted`, OpenCode `session.idle`/중단 오류, Antigravity `result.status` INTERRUPTED·`error: "interrupted"`. 유예 안에 오지 않으면 강제 종료하고 adapter가 `cancelled`를 돌려준다(계약: "취소를 받으면 곧 `cancelled`"). 지금 계약은 실행 시도가 끝나면 프로세스도 끝나므로 Paseo의 "확인 못 하면 다음 실행 거부"(상주 세션용)는 필요 없다.
- steer를 주는 프로바이더는 중단 때 **읽히지 않은 steer 메시지를 버린다**(Paseo L114). 버려진 메시지는 우리 쪽에서 "전달되지 않음"으로 되돌려 다음 실행 시도가 받게 한다(아래 권고 7).

### 권고 7. steer가 없거나 실행 시점에 거절되면 `줄 세우기`로 되돌린다. 자동으로 중단하지 않는다 — 채택 후보

- 화면: `steer: none`인 프로바이더의 Lead 대화에는 steer 전달 방식을 보이지 않는다(선택 조사 권고 5). 사용자는 `줄 세우기`·`중단하고 보내기`만 고른다.
- 실행 시점 거절(`unavailable`: 실행 시도가 막 끝남, 압축 중, 턴 ID 불일치): 메시지를 `줄 세우기`로 바꿔 남기고 Event에 기록한다. Paseo·Zed는 거절 시 **중단 후 교체**로 넘어가지만, BaboJUBot에서는 진행 중 작업을 버리는 일이 별도 사용자 명령(`중단하고 보내기`)이라서 자동으로 하지 않는다. AO·Paperclip·Multica도 같은 판단이다: AO "An interrupt destroys the turn … A steer adds the correction to the SAME turn", 불가하면 typed 거절 + 다음 턴 대기열, Paperclip `steering_unsupported` → 줄 세우기, Multica `task_supplement_unsupported` [소스].
- 대상 고정: steer 요청은 받는 실행 시도 ID를 함께 가진다(Paseo `expectedTurnId`). 그 실행 시도가 이미 끝났으면 `unavailable` → 줄 세우기.
- 오류(성공·거절이 불명확)는 재시도·중단하지 않고 드러낸다(Paseo L112). 메시지는 "전달 확인 안 됨"으로 남고, 실행 시도가 끝날 때 프로바이더 기록에 그 메시지가 있었는지로 정리한다 — 세부는 구현 때.
- 메시지 귀속: 받아들여진 steer 메시지의 `deliveredToRunId`는 진행 중 실행 시도다. 지금 `messageDeliveries`에 `steer`를 더한다(`message.ts` 주석의 판 2 예고).

### 권고 8. 사용량은 실행 시도별 토큰·비용을 계약대로 받고, 계정 한도는 문서화된 프로바이더 수단만 쓴다 — 실행 시도별은 채택 후보, 계정 한도는 보류

- 실행 시도별: `usage`에 cache·reasoning 토큰과 context 사용량을 선택 칸으로 더할지 검토. 비용은 0(구독, OpenCode ChatGPT)과 `null`(보고 안 함)을 구분한다. Claude 재개 세션의 `total_cost_usd`는 누적이므로 실행 시도 비용은 직전 값과의 차이 또는 `modelUsage` 합으로 계산한다([문서]).
- 계정 한도: Paseo·Nimbalyst·Paperclip·OpenClaw처럼 **자격 증명 저장소를 직접 읽어 비공개 endpoint(`api/oauth/usage`, `wham/usage`)를 부르는 방식은 배제**. 자격 증명은 프로바이더 CLI만 다루게 하고 제품이 열지 않는 편이 계정·자격 증명 불변 조건에 맞으며, endpoint가 문서화되지 않았다. 프로바이더 프로세스에 묻는 수단은 **보류**로 남긴다: Codex `account/rateLimits/read`(app-server, 실행 시도 중 `account/rateLimits/updated` 알림도 받음), Claude Agent SDK `/usage`의 `usage_report`(문서화, experimental) 또는 AO가 쓰는 `get_usage` control request(공개 문서 미확인). 화면 자리(전역 설정의 프로바이더 목록, Paseo처럼 계정 카드)와 함께 판 4 예산에서 다시 본다. Claude `/usage`·`get_usage`가 모델 호출·사용량 없이 끝나는지는 [미확인]이라 쓰기 전에 확인해야 한다.
- 창 이름은 프로바이더 값에서만 만들고(Paseo 규칙), 값이 없으면 0%가 아니라 "보고하지 않음"(Nimbalyst, 선택 조사 권고 5).

### 배제한 대안

| 대안 | 사례 | 이유 |
|---|---|---|
| 한 번 실행 headless(가)를 공통 바닥으로 | 첫 조사의 가정 | steer·프로토콜 안 취소·OpenCode 종료 판정을 잃는다. 레퍼런스가 쓰지 않는다 |
| 상주 세션(다)을 첫 판에 | Paseo·Nimbalyst·Zed | 실행 시도 토큰과 충돌, 턴 사이 사망·회수·장부가 추가된다. 시작 비용이 문제로 측정되면 보류 항목으로 다시 본다 |
| 데몬 하나 토큰 + 호출자 ID 인자 | Paseo | 호출자를 인증하지 않는다 |
| 전체 허용 모드로 무인 실행 | Emdash·Sculptor·Paseo Antigravity | 승인 정책·조직 경계를 프로바이더 권한에서 지키지 못한다. 정확한 미리 승인이 되는 셋에는 필요 없다 |
| steer 거절 시 자동 중단 후 교체 | Paseo·Zed | 진행 중 작업 버림은 사용자의 명시 명령(`중단하고 보내기`)이어야 한다 |
| 재개 실패 시 **조용히** 새 세션 | Emdash가 경고하는 agy 동작("mint a fresh session") | 사용자가 모르는 사이 맥락이 바뀐다. 새로 시작하되 공개 활동에 남긴다(권고 5) |
| "최근 세션"으로 재개(`-c`·`--last`) | — | 여러 조직이 한 프로바이더 홈을 쓰면 다른 조직 세션을 이어받을 수 있다 |

## 검증 결과와 한계

- **메인 조사자가 원문을 직접 열어 확인한 것:** Paseo의 위에 인용한 문서 전부(`providers.md`·`agent-lifecycle.md`·`glossary.md` Steer·Usage 항목·`supported-providers.md` Antigravity·`plugins/reference.md` Usage sources·`hub.md`), `agent-sdk-types.ts` capability·steer·usage·session 타입, `agent-manager.ts` `steerOrReplaceActiveTurn`·`cancelAgentRun`·시간 상수·`prepareSessionConfig`, `runtime-mcp-config.ts`, `bootstrap.ts` 토큰 생성, `provider-registry.ts` 미리 승인 계약, Claude `buildOptions`·`steerActiveTurn`·`interrupt`·`close`·`query.ts`, Codex `turn/steer`·`turn/interrupt`·종료 처리·spawn·MCP 변환·tool policy, OpenCode `server-manager`·v2 `runtime`·`turns`·`usage`·`configuration`·`bridge`, Antigravity plugin `provider`·`process`·`session`·`signals`·fixture README, Claude·Codex usage source의 endpoint, `tree-kill.ts`, `LICENSE` 머리. Vibe Kanban `kill_process_group`, Emdash `loopback-curl.ts` 주석, Nimbalyst MCP 토큰 주석·Codex 프로세스 주석, Vibe Kanban Codex app-server 버전. 공식 문서 두 쪽(Codex App Server, Claude Agent SDK TypeScript)은 WebFetch 요약으로 읽었다.
- **읽기 전용 탐색 보조 agent가 찾고 메인이 다시 열지 않은 것:** Vibe Kanban·Emdash·Sculptor·Nimbalyst·Zed·Paperclip·Multica·AO·OpenClaw의 나머지 줄 번호(위 표의 D1 근거·재시작·D3·D4·D5 세부). 메인이 다시 연 것은 Paperclip `claude-config.ts`(0o600 실행별 MCP 파일)·`execute.ts` L305 주석·`run-control.ts` L1393 Codex SIGINT 주석, AO `steer.go` 근거 주석·`agentaccount/claude.go` `get_usage`, OpenClaw MCP header template·`cli-session.ts` 도구 목록 주석뿐이다. 나머지는 [소스]로 표기했지만 메인 재확인 범위 밖이다. 보조 agent가 낸 Paperclip `permissions.ts` 주석, Multica `MULTICA_TOKEN` 주석, OpenClaw `--allowedTools` 목록·fd 3 OAuth도 다시 열지 않았다.
- **실행하지 않았다.** 어떤 프로바이더도 띄우지 않았고 모델을 부르지 않았다. 시작 비용(권고 1 위험), 실제 취소 시간, OpenCode 1.18.23 서버의 steer 합류 동작, Codex 0.165.0 app-server의 `thread/start` config로 MCP header가 들어가는지, Claude `--mcp-config` 파일의 env 확장은 모두 [미확인]이다.
- **Paseo와 우리 설치 버전 차이.** Paseo는 OpenCode v1.14.46·v2.0.10, Antigravity fixture는 agy 1.2.13, Vibe Kanban은 Codex 0.124.0을 쓴다. 설치본(OpenCode 1.18.23, agy 1.4.10, Codex 0.165.0)에서 같은 동작인지 확인하지 않았다.
- **공식 문서 미확인.** Claude `SDKRateLimitEvent` 필드, Claude `/usage`가 모델 호출·사용량을 쓰는지, Codex app-server 문서 뒤쪽(Events 절)은 읽지 못했다. OpenAI가 app-server를 production 지원으로 바꿀 계획은 확인하지 못했다.
- **약관.** Paseo는 Antigravity에 "not endorsed by Google"만 적는다. 구독 자동화 약관 판단은 [executor-capabilities.md](executor-capabilities.md#8-인증-동시-실행-구독-자동화-약관)를 따르고 새로 확인하지 않았다.
- **라이선스.** Paseo(Apache-2.0)·Vibe Kanban·Emdash(Apache-2.0)·Sculptor·Nimbalyst(MIT)는 복사 시 출처·고지가 필요하고, Zed 인용 crate(GPL-3.0-or-later)는 복사 대상이 아니다. 이 문서는 코드를 복사하지 않았다.
- **문서 지도.** 지시 범위상 [문서 지도](../README.md)의 조사 기록 표에 이 문서를 더하지 않았다. 채택 시 함께 갱신해야 한다.
