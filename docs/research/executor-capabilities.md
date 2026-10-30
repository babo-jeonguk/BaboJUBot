# 프로바이더 기능 비교: Claude Code·Codex·OpenCode·Antigravity CLI를 한 실행 시도 계약에 붙일 수 있는가

조사일: 2026-10-30. 질문: 판 2에서 실행 시도 계약(`packages/contracts/src/run.ts`의 `RunRequest`·`RuntimeActivity`·`RunResult`·`RunCancel`, 공통 검사 `packages/runtime/src/runtime-contract.ts`)에 붙일 프로바이더 네 개가 각각 무엇을 할 수 있고 무엇을 못 하는가. 12개 축(비대화 실행, 출력 stream, 도구 주입, 지침 주입, 세션, 취소, 사용량, 인증, 권한·sandbox, 모델 선택, 실행 중 메시지, ACP)을 나란히 비교한다.

범위: 기능 사실과 공통 설계에 주는 시사점까지. 어떤 프로바이더를 먼저 붙일지, 어떤 경로(CLI·서버·ACP)를 쓸지는 결정하지 않는다. [실행 모델 조사](agent-runtime-models.md)가 정리한 "외부 프로바이더를 adapter로 구동하는 방식"과 "ACP가 공통 기반 후보"라는 결론은 반복하지 않고, 그 결론을 실제 네 도구의 현재 버전에 대어 본다. 도구 설명 문구 처리는 [issue-86 조사](issue-86-references.md)를 따른다.

근거 수준 표기: **[실행]** 이 컴퓨터에서 `--help` 등 모델을 부르지 않는 명령으로 확인, **[소스]** 고정 SHA 코드를 읽음, **[문서]** 공식 문서·내장 changelog, **[바이너리]** 닫힌 바이너리의 문자열(약한 근거), **[추론]** 위 근거에서 끌어낸 판단, **[미확인]** 확인하지 못함.

## 기준 버전

| 대상 | 설치·기준 | 공개 소스·문서 | 라이선스 |
|---|---|---|---|
| Claude Code | 2.1.312 (네이티브 바이너리 `~/.local/share/claude/versions/2.1.312`) | 소스 비공개. [code.claude.com/docs](https://code.claude.com/docs/en/cli-reference) 2026-10-30 열람 | 상용 |
| Codex CLI | codex-cli 0.165.0 | [openai/codex `rust-v0.165.0` = `360319d8dee62d87e2d59fc0c21805d79519cfed`](https://github.com/openai/codex/tree/360319d8dee62d87e2d59fc0c21805d79519cfed). 문서 `developers.openai.com/codex/*`는 `learn.chatgpt.com/docs/*`로 308 이동 | Apache-2.0 |
| OpenCode | 1.18.23 | [anomalyco/opencode `v1.18.23` = `ef2880f379129aa048be9e9353e30aa168d42c17`](https://github.com/anomalyco/opencode/tree/ef2880f379129aa048be9e9353e30aa168d42c17) (sst/opencode가 이리로 이동). 문서 opencode.ai/docs = 저장소 `packages/web/src/content/docs/*.mdx` | MIT |
| Antigravity CLI (`agy`) | 1.4.10 (Go 정적 바이너리, 약 232 MB) | 소스 비공개. [antigravity.google/docs](https://antigravity.google/docs/cli/headless) 2026-10-30 열람, `agy changelog` 내장 기록 | 상용 |
| ACP 명세 | [agentclientprotocol/agent-client-protocol `abc8a31b16fc4eb6e3578ced562088e8e26d959a`](https://github.com/agentclientprotocol/agent-client-protocol/tree/abc8a31b16fc4eb6e3578ced562088e8e26d959a) (최신 release `schema-v1.27.0`) | [agentclientprotocol.com](https://agentclientprotocol.com/protocol/overview) | Apache-2.0 |
| Claude ACP adapter | `@agentclientprotocol/claude-agent-acp` 0.99.1, [`2fd46c866d4ff2939fe1b1245b15a536d6de7c0b`](https://github.com/agentclientprotocol/claude-agent-acp/tree/2fd46c866d4ff2939fe1b1245b15a536d6de7c0b) (`@zed-industries/claude-code-acp` 후속) | Agent SDK 0.3.312·ACP SDK 2.1.0 의존 | Apache-2.0 |
| Codex ACP adapter | `@agentclientprotocol/codex-acp` 2.5.0, [`ac8d9251de43ab8648a89eb0520e0c606ad78be5`](https://github.com/agentclientprotocol/codex-acp/tree/ac8d9251de43ab8648a89eb0520e0c606ad78be5) (`zed-industries/codex-acp`는 v0.16.0에서 보관) | `@openai/codex ^0.165.0` 의존 | Apache-2.0 |
| Antigravity ACP 서버 | ACP registry의 `antigravity-acp` 1.4.5 (`agy_acp_server.par`) | [registry.json](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) 2026-10-30 조회. 내려받지 않음 | proprietary |

아래 링크 약어: **CX** = `https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/`, **OC** = `https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/`, **AG** = `https://antigravity.google/docs/`, **CC** = `https://code.claude.com/docs/en/`.

## 한눈 비교

| 축 | Claude Code | Codex | OpenCode | Antigravity |
|---|---|---|---|---|
| 1. 비대화 실행 | `claude -p`, prompt는 인자·stdin. 성공 0, 실패 비0 | `codex exec`, 인자·stdin. 실패·중단 시 1 | `opencode run`, 인자·stdin. `session.error`면 1. 별도 `opencode serve`(HTTP+SSE) | `agy -p`. 0·1·2·3 구분, 시간 초과도 0 |
| 2. 출력 stream | `stream-json`(+`--verbose`): `system/init`·`assistant`·`user`(tool_result)·`result` | `--json` JSONL: `thread.started`·`turn.*`·`item.*` | `--format json`: `text`·`tool_use`·`step_start/finish`·`error`. **최종 result 없음** | `stream-json`: `init`·`step_update`·`result` |
| 최종 성공/실패 판정 | `result.subtype`·`is_error` | `turn.completed` / `turn.failed`·`error` + 종료 코드 | 종료 코드 + `error` 이벤트 유무 | `result.status`(SUCCESS·ERROR·CANCELED·INTERRUPTED…) |
| 3. 도구 주입 | `--mcp-config` + `--strict-mcp-config`(전역 무시). stdio·http·sse·ws | `-c mcp_servers.*`(실행 미확인). stdio·Streamable HTTP, bearer는 env 이름으로 | `OPENCODE_CONFIG_CONTENT` env. local(stdio)·remote(HTTP→SSE) | 실행별 flag 없음. workspace `.agents/mcp_config.json`·custom agent 파일. stdio·Streamable HTTP |
| 기본 도구 제한 | `--tools`·`--disallowedTools`·`--restricted` | `--disable shell_tool` 등 feature, 서버별 `enabled_tools` | `permission` 규칙 allow/ask/deny | custom agent `tools:`, 권한 규칙 |
| 4. 지침 주입 | `--system-prompt[-file]` 교체, `--append-system-prompt[-file]` 추가 | `developer_instructions`(추가), `model_instructions_file`(교체, 비권장) | agent `prompt`(교체, config로), HTTP `system`(메시지별 추가) | flag 없음. custom agent 본문·rules 파일(누적) |
| 개인 전역 지침 피하기 | `--setting-sources project,local` (구독 로그인 유지) | `~/.codex/AGENTS.md` 끌 방법 없음, `CODEX_HOME` 분리만 | `XDG_CONFIG_HOME` 분리 + `OPENCODE_DISABLE_CLAUDE_CODE` | agent `inherit_user: false`(문법 미확인) |
| 5. 세션 | `--session-id`로 새 ID 지정, `--resume <id>`. 재개 시 system prompt 고정(snapshot) | `exec resume <id>`. rollout JSONL | `-s <id>`. SQLite. 지침은 매 단계 다시 읽음 | `--conversation <id>`. 대화별 SQLite, cwd 범위 |
| 6. 취소 | SIGINT·stdin `interrupt` = 턴 정리, SIGTERM = 143, result 없음 | SIGINT만 정리(exit 1), SIGTERM 즉시 종료 | `run`에는 signal 처리 없음(즉시 종료). 서버 `POST /session/:id/abort`는 정리 | SIGINT = `INTERRUPTED`. SIGTERM 미확인 |
| 7. 사용량 | 토큰 + `total_cost_usd`(로컬 가격표 추정) | 토큰만(cache·reasoning 포함), 비용 없음 | 토큰 + `cost`(ChatGPT 로그인 시 0) | 토큰만, 구독은 credits 별도 |
| 8. 구독 자동화 공식 문구 | 본인 구독으로 수정 안 한 바이너리 로그인은 허용, 한도는 "ordinary, individual usage" 가정 | 자동화는 API key 권장, 동시 작업은 `auth.json` 분리 | 제공자 약관을 따름(Anthropic 구독 연결 기능 없음) | 소비자 요금제에서 third-party 앱 안에 감싸 쓰기 "not supported" |
| 9. 권한·sandbox | permission mode 6종. bubblewrap(Bash만), 네트워크 proxy allowlist. WSL2 지원 | `-s` 3종, exec는 승인 never. bubblewrap+seccomp, 네트워크 기본 차단. WSL2 지원 | 규칙 기반만, **OS sandbox 없음** | mode 4종 + skip. Linux namespace sandbox(terminal), 네트워크 기본 차단. WSL 언급 없음 |
| 10. 모델 | `--model`, `--effort` | `-m`, `-c model=` | `-m provider/model`, `--variant` | `--model`, `--effort` |
| 11. 실행 중 메시지 | 있음: stdin stream-json `priority` now/next/later | app-server `turn/steer`만(exec 없음) | 서버에서 busy 세션에 prompt → 다음 단계 경계에 합류 | 비대화 모드 없음 |
| 12. ACP | adapter 패키지(Agent SDK 경유) | adapter 패키지(app-server 경유) | 내장 `opencode acp` | 별도 비공개 ACP 서버 1.4.5 |

## 축별 근거

### 1. 비대화 실행

- **Claude Code** [실행] `claude -p/--print [prompt]`. prompt는 위치 인자 또는 stdin. `--max-turns`·`--max-budget-usd`·`--json-schema`·`--no-session-persistence`가 있다. [문서] 성공 0·실패 비0, 실행 중 실패(인증 없음 등)도 stdout result로 나온다. `-p`는 workspace trust 대화를 건너뛰고 잘못된 설정 파일을 조용히 무시한다. `--bare`는 "scripted and SDK calls"에 권장되며 "will become the default for -p in a future release"다. [CC headless](https://code.claude.com/docs/en/headless), [cli-reference](https://code.claude.com/docs/en/cli-reference)
- **Codex** [실행] `codex exec [PROMPT]`, prompt가 없거나 `-`면 stdin. `-C`·`--skip-git-repo-check`·`--ephemeral`·`--json`·`-o FILE`·`--output-schema`·`--ignore-user-config`·`-c key=value`·`--enable/--disable FEATURE`. [소스] exec는 내부적으로 in-process app-server 클라이언트를 띄워 `turn/start`·`turn/interrupt`로 구동한다([exec/src/lib.rs L22-24, L1022](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/exec/src/lib.rs#L22-L24)). 턴이 Failed·Interrupted이거나 재시도 아닌 `error`면 1로 끝난다(L1302-1365, L1400-1406). [문서] `required = true` MCP 서버가 뜨지 않으면 exec가 오류로 끝난다. `codex app-server`(stdio JSONL, `unix://`·`ws://`)는 "experimental and aren't supported for production workloads"다([learn.chatgpt.com non-interactive-mode](https://learn.chatgpt.com/docs/non-interactive-mode)).
- **OpenCode** [실행·소스] `opencode run [message..]`, `-m`·`--agent`·`-f`·`--format`·`--auto`·`-s/-c/--fork`·`--attach <url>`·`--dir`·`--pure`([OC cli/cmd/run.ts L136-260](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/cli/cmd/run.ts#L136-L260)). `--attach`가 없으면 서버를 포트 없이 프로세스 안에 띄우고(L946-961), 세션 상태가 `idle`이 되면 끝난다(L793-799). `session.error`가 왔거나 prompt가 오류면 1(L834-875). `opencode serve`는 HTTP+SSE 서버이고 `OPENCODE_SERVER_PASSWORD` basic auth다.
- **Antigravity** [실행·문서] `agy -p/--print "<prompt>"`, `--output-format`, `--input-format stream-json`, `--json-schema`, `--print-timeout`. [문서 changelog] 종료 코드 0 성공, 1 잘못된 `--model`·`--agent`·schema·입력, 2 print 사용 오류(stream-json 입력의 control_request 포함), 3 모델 API 실패로 턴이 끝남(stderr에 `AGY_ERROR: {...}` 한 줄). 도구 오류·권한 거부는 실패로 치지 않는다. `--print-timeout` 기본값은 help·[reference](https://antigravity.google/docs/cli/reference/)가 0(무제한), [headless 문서](https://antigravity.google/docs/cli/headless)는 아직 5분이라 적는다. 시간 초과 시 부분 출력과 **종료 0**을 내므로 종료 코드만 믿으면 안 된다[추론].

### 2. 출력 stream과 최종 판정

- **Claude Code** [실행·문서] `--output-format stream-json`은 `--verbose`가 필요하고 `--include-partial-messages`가 `stream_event` delta를 더한다. `system/init`(session_id·model·tools·`mcp_servers[{name,status}]`·`mcp_server_errors`·permissionMode·`capabilities[]`), 다른 `system` subtype(`api_retry`·`compact_boundary`·`permission_denied` 등), `assistant`(text·thinking·tool_use 블록), `user`(tool_result), 마지막 `result`. `result.subtype`은 `success | error_max_turns | error_max_budget_usd | error_during_execution | error_max_structured_output_retries`이고 `is_error`·`errors[]`·`num_turns`·`session_id`·`total_cost_usd`·`usage`·`modelUsage`·`permission_denials`가 있다. `result` 뒤에 `prompt_suggestion` 같은 이벤트가 더 올 수 있다. [Agent SDK agent-loop](https://code.claude.com/docs/en/agent-sdk/agent-loop), [typescript](https://code.claude.com/docs/en/agent-sdk/typescript)
- **Codex** [소스] `thread.started{thread_id}`·`turn.started`·`turn.completed{usage}`·`turn.failed{error}`·`error{message}`·`item.started/updated/completed`([exec_events.rs L11-36](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/exec/src/exec_events.rs#L11-L36)). item 종류는 `agent_message`·`reasoning`·`command_execution{command, aggregated_output, exit_code, status}`·`file_change`·`mcp_tool_call{server, tool, arguments, result, error, status}`·`collab_tool_call`·`web_search`·`todo_list`·`error`(L107-132). app-server 알림은 더 잘다(`item/agentMessage/delta`, `thread/tokenUsage/updated`, `account/rateLimits/updated`; [app-server-protocol common.rs L1975-2061](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server-protocol/src/protocol/common.rs#L1975-L2061)).
- **OpenCode** [소스] `--format json`은 `{type, timestamp, sessionID, ...}` 한 줄씩. `tool_use`(완료·오류일 때만, 시작은 안 냄), `step_start`, `step_finish{reason, tokens, cost}`, `text`(part가 끝났을 때만), `reasoning`(`--thinking`), `error`([OC run.ts L678-790](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/cli/cmd/run.ts#L678-L790)). **최종 result 이벤트가 없다** — 마지막 `text`가 답이고 성공은 종료 0 + `error` 없음으로 판정한다[추론]. 서버 `GET /event`는 `message.part.updated`·`session.status`·`session.idle`·`session.error`·`permission.asked` 등 전체 bus를 준다.
- **Antigravity** [문서] `event` 키 NDJSON 세 종류. `init`(cwd·tools·permission_mode), `step_update`(conversation_id·step_index·state ACTIVE/DONE·step_type `user_input|agent_response|tool|checkpoint`·`tool_info{name, parameters, output, error}`·`subagent_info`·단계별 usage), 턴마다 한 번 `result`(status·response·num_turns·usage·error·structured_output). status는 SUCCESS·ERROR·CANCELED·INTERRUPTED·INVALID·WAITING·RUNNING. thinking 이벤트는 없고 `thinking_tokens` 수만 있다. [AG cli/headless](https://antigravity.google/docs/cli/headless)

### 3. 도구 주입과 기본 도구 제한

- **Claude Code** [실행·문서] `--mcp-config <file-or-json...>` + `--strict-mcp-config`면 `~/.claude.json`·`.mcp.json`·claude.ai connector를 모두 무시한다. transport는 stdio·http(권장)·sse(deprecated)·ws. `-p`에서 시작 시 서버를 `MCP_TIMEOUT`(30초)까지 기다리고, 잘못된 항목은 조용히 빠져 `init.mcp_server_errors`에만 남는다. 도구 이름은 `mcp__<server>__<tool>`. `--tools "Read,Edit"`는 기본 도구 집합만 제한하고(`""`는 없음), `--disallowedTools`의 맨 이름은 도구를 맥락에서 빼며, `--allowedTools`는 자동 승인일 뿐이다. `--restricted`는 코드 프로바이더·WebFetch를 빼고 파일 도구를 작업 디렉터리로 묶고 user·project·local 설정 파일을 무시한다. `--permission-prompt-tool mcp__srv__tool`로 권한 질문을 우리 MCP 도구에 넘길 수 있다. [CC mcp](https://code.claude.com/docs/en/mcp)
- **Codex** [소스] `mcp_servers.<name>`: stdio(`command`·`args`·`env`·`env_vars`·`cwd`)와 Streamable HTTP(`url`·`bearer_token_env_var`·`http_headers`·`env_http_headers`). 값 그대로의 `bearer_token`은 거부하고 SSE는 없다. 서버별 `enabled_tools`·`disabled_tools`·`required`·`startup_timeout_sec`·`tool_timeout_sec`([config/src/mcp_types.rs L391-450, L517-543](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/config/src/mcp_types.rs#L391-L450)). 실행별로는 `-c 'mcp_servers.babo.url="…"' -c 'mcp_servers.babo.bearer_token_env_var="BABO_TOKEN"'`이 dotted TOML 경로 규칙상 될 것이나 실행하지 않았다[추론]. `codex mcp add`는 전역 config에 쓴다. `--ignore-user-config`는 `$CODEX_HOME/config.toml`만 건너뛴다([loader/mod.rs L515-535](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/config/src/loader/mod.rs#L515-L535)). [실행] `--disable shell_tool`·`apps`(ChatGPT connector, 기본 켬)·`plugins`·`multi_agent`·`browser_use` 등으로 기본 도구를 끈다. web search는 `--search` 없으면 꺼져 있다. app-server 전용 `thread/start.dynamicTools`(experimental)는 MCP 없이 클라이언트가 도구를 실행하게 하지만 exec는 거부한다.
- **OpenCode** [소스·문서] local `{type:"local", command:[…], environment}`(stdio), remote `{type:"remote", url, headers, oauth}`(Streamable HTTP, 실패 시 SSE). 실행별 주입은 `OPENCODE_CONFIG=<file>` 또는 `OPENCODE_CONFIG_CONTENT=<json>`이고 `{env:VAR}`·`{file:path}` 치환이 되어 토큰을 env로 넘길 수 있다([OC config/config.ts L401-404, L468-476](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/config/config.ts#L401-L404)). 기본 도구 제한은 `permission`(read·edit·glob·grep·bash·task·skill·webfetch·websearch·external_directory 등, glob 패턴별 allow/ask/deny)이고 옛 `tools: {x:false}`는 deny로 바뀐다. `OPENCODE_PERMISSION` env가 마지막에 합쳐진다. 기본값은 대부분 allow다([permissions.mdx L168-175](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/web/src/content/docs/permissions.mdx#L168-L175)). **전역 `~/.config/opencode`는 항상 합쳐지고 끄는 flag가 없다** — `XDG_CONFIG_HOME`을 실행별 디렉터리로 돌려야 한다([config/paths.ts L23-40](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/config/paths.ts#L23-L40)).
- **Antigravity** [문서] MCP 설정은 settings.json과 다른 파일이다: 전역 `~/.gemini/config/mcp_config.json`, workspace `<workspace>/.agents/mcp_config.json`, plugin `mcp.json`. `{"mcpServers":{…}}`에 stdio(`command/args/env/cwd`) 또는 `serverUrl`+`headers`(Streamable HTTP만, SSE 불가), `enabledTools`·`disabledTools`([AG mcp](https://antigravity.google/docs/mcp)). `agy mcp add`는 사용자 전역 파일에 쓴다[실행]. **실행별 MCP flag가 없고** `--settings`가 mcpServers를 받는지 문서에 없다[미확인]. 전역을 건드리지 않는 길은 workspace `.agents/mcp_config.json` 또는 frontmatter에 `mcpServers`·`tools`를 둔 custom agent `.agents/agents/<name>.md` + `--agent <name>`이다([AG subagents](https://antigravity.google/docs/subagents?tab=cli)). 둘 다 연구 workspace에 파일을 쓴다. MCP 도구는 기본 Ask라 비대화에서는 `mcp(server/*)` allow 규칙이 필요하다[추론]. [changelog] MCP `tools/call`에 `_meta["antigravity.google/root_conversation_id"]`가 붙는다.

### 4. 지침 주입과 개인 전역 지침

- **Claude Code** [문서] `--system-prompt[-file]` 교체, `--append-system-prompt[-file]` 추가, 함께 쓸 수 있다. `--setting-sources`에서 `user`를 빼면 `~/.claude/CLAUDE.md`·`~/.claude/rules`·사용자 skill·hook·설정을 읽지 않는다. 그래도 읽는 것: managed policy, `~/.claude.json`, auto memory(`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`로 끔), claude.ai connector(`--strict-mcp-config`로 끔). [실행] **`--bare`는 CLAUDE.md 자동 탐색까지 끄지만 "OAuth and keychain are never read"라 구독 로그인으로 쓸 수 없다.** `--safe-mode`는 CLAUDE.md·skill·MCP 등 사용자 설정을 모두 끄고 인증은 그대로라는 help 설명이 있으나, 문제 해결용이라 설명되어 있고 `--mcp-config`까지 끄는지 미확인. `CLAUDE_CONFIG_DIR`로 인스턴스별 설정·대화 기록을 나눌 수 있다. 프로젝트 CLAUDE.md는 cwd와 상위에서 읽는다. [CC settings](https://code.claude.com/docs/en/settings)
- **Codex** [소스] `instructions`, `developer_instructions`("inserted as a `developer` role message", 추가), `model_instructions_file`(기본 지침 교체, 코드 주석이 "STRONGLY DISCOURAGED"), `include_permissions_instructions`·`include_environment_context`([config_toml.rs L251-277](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/config/src/config_toml.rs#L251-L277)). 프로젝트 `AGENTS.override.md`/`AGENTS.md`를 저장소 root에서 cwd까지 읽고 `project_doc_max_bytes`(기본 32 KiB, 0이면 끔)로 제한한다([core/src/agents_md.rs](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/core/src/agents_md.rs#L1-L20)). **전역 `$CODEX_HOME/AGENTS.md`는 항상 읽고 `--ignore-user-config`도 막지 못한다**([codex-home/src/instructions/mod.rs L41-50](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/codex-home/src/instructions/mod.rs#L41-L50)). 막으려면 `CODEX_HOME`을 나눠야 하고, 그러면 로그인 파일도 그쪽에 있어야 한다(8번 동시 사용 경고와 충돌).
- **OpenCode** [소스] system prompt = agent `prompt`가 있으면 그것, 없으면 제공자 기본 prompt. 뒤에 환경 정보·지침 파일·MCP instructions·skill 목록·메시지별 `system`을 붙인다([session/llm/request.ts L56-66](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/session/llm/request.ts#L56-L66)). 교체는 `OPENCODE_CONFIG_CONTENT`에 agent를 정의하고 `--agent`로 고른다. 메시지별 `system` 추가는 HTTP/SDK에서만 되고 `run` flag는 없다. 지침 파일은 매 단계 다시 읽는다: 전역은 `$XDG_CONFIG_HOME/opencode/AGENTS.md`, 없으면 `~/.claude/CLAUDE.md`. 프로젝트는 cwd에서 위로 처음 만난 AGENTS.md/CLAUDE.md/CONTEXT.md, 그리고 config `instructions`([session/instruction.ts L59-67, L113-152](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/session/instruction.ts#L59-L67)). `OPENCODE_DISABLE_CLAUDE_CODE`는 `~/.claude`를, `OPENCODE_DISABLE_PROJECT_CONFIG`는 프로젝트 설정을 끈다. 전역 `~/.config/opencode/AGENTS.md`는 `XDG_CONFIG_HOME`을 돌려야만 피한다.
- **Antigravity** [실행·문서] system prompt 교체·추가 flag가 없다. rules는 "cumulative rather than replacement-based": 전역 `~/.gemini/AGENTS.md`·`~/.gemini/GEMINI.md`·`~/.gemini/config/rules/*.md`·`~/.gemini/antigravity-cli/rules/*.md`, workspace `AGENTS.md`·`GEMINI.md`·`.agents/rules/*.md`(repo root까지 위로), plugin rules([AG rules](https://antigravity.google/docs/rules)). 실행별로 가장 강한 수단은 custom agent 파일이며 frontmatter 뒤 본문이 "defines the subagent's system prompt"다(교체인지 추가인지 미확인). [changelog·바이너리] custom agent가 `rules/skills/agents/plugins/hooks/mcp`별 `inherit_user: false`로 개인 설정을 뺄 수 있고, `excludeDefaultComponents: true`가 기본 prompt 절과 기본 도구를 뺀다. 정확한 frontmatter 문법은 미확인.

### 5. 세션

- **Claude Code** [실행·문서] `--session-id <uuid>`로 새 세션 ID를 **호출자가 정할 수 있다**. `-r/--resume <id|name|.jsonl>`, `-c`, `--fork-session`. 기록은 `~/.claude/projects/<cwd>/<id>.jsonl`, 30일 보관(`cleanupPeriodDays`). 재개 시 `--mcp-config`·`--settings`·`--add-dir`는 복원되지 않아 다시 넘긴다. **`--system-prompt-snapshot on`(기본)이면 첫 요청의 system prompt를 기록해 재개 때 그대로 쓰며, flag가 바뀌어도 compaction 전까지 유지된다**(`off`면 매 요청 재구성). 두 프로세스가 같은 세션을 재개하면 한 기록에 섞여 쓴다. [CC sessions](https://code.claude.com/docs/en/sessions)
- **Codex** [소스·실행] `thread.started.thread_id`가 세션 ID(호출자가 정하지 못함). `codex exec resume <id|name> [PROMPT]`·`--last`·`codex exec fork <id>`·`--ephemeral`(저장 안 함). 저장은 `$CODEX_HOME/sessions` rollout JSONL([rollout/src/lib.rs L86-87](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/rollout/src/lib.rs#L86-L87))와 sqlite 색인. app-server `thread/resume`은 base·developer instructions·model·sandbox를 다시 받는다. 기록과 어떻게 합쳐지는지는 미확인.
- **OpenCode** [실행·소스] 기본은 새 세션, `-s <id>`·`-c`·`--fork`. 저장은 `$XDG_DATA_HOME/opencode/opencode.db`(SQLite WAL), `OPENCODE_DB`로 바꾼다([packages/core/src/database/database.ts L27-55](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/core/src/database/database.ts#L27-L55)). 지침을 매 단계 다시 만들고 agent·model·`system`이 prompt마다 달라도 되므로 **재개 시 지침 변경이 반영된다**[추론].
- **Antigravity** [문서·실행] 비대화 실행은 `-c`·`--conversation <id>`가 없으면 이어 가지 않는다. `conversation_id`가 init·step_update·result에 있다. 저장은 `~/.gemini/antigravity-cli/conversations/<uuid>.db` + `brain/<uuid>/`, 기록은 cwd 범위([AG cli/conversations](https://antigravity.google/docs/cli/conversations)). `--input-format stream-json`은 한 프로세스에서 한 대화를 이어 stdin 한 줄마다 한 턴을 돈다. 재개 시 다른 `--agent`로 system prompt가 바뀌는지는 미확인.

### 6. 취소

- **Claude Code** [문서] SIGTERM은 종료 코드 143, 턴을 끝내지 않고 result도 기록하지 않는다. Bash 프로세스 트리는 죽이고 `SessionEnd` hook은 돈다. 문서: "To end the turn instead, send SIGINT, or call the Agent SDK's interrupt()". stream-json stdin의 `{"type":"control_request","request":{"subtype":"interrupt"}}`가 프로토콜 안 취소다. SIGINT 때 result 줄과 종료 코드가 정확히 무엇인지는 미확인.
- **Codex** [소스] exec는 SIGINT만 잡아 `turn/interrupt`를 보내고 Interrupted로 끝나 1을 낸다([exec/src/lib.rs L1190-1196, L1308-1335](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/exec/src/lib.rs#L1190-L1196)). **SIGTERM 처리기가 없어 즉시 죽는다.** shell 명령은 별도 process group에서 돌고 취소 시 TERM → 유예 → KILL([core/src/exec.rs L1043-1070](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/core/src/exec.rs#L1043-L1070)), Linux에서는 `PR_SET_PDEATHSIG(SIGTERM)`도 건다. app-server는 SIGINT·SIGTERM을 강제 종료로, SIGHUP만 정상 종료로 다룬다.
- **OpenCode** [소스] 비대화 `run`에는 SIGINT/SIGTERM 처리기가 없다(대화형 mini 모드에만 있음) → signal은 즉시 종료. shell 도구 명령은 `detached: true` process group이고 프로토콜 안 abort 때 SIGTERM, 3초 뒤 강제 종료한다([tool/shell.ts L293-309, L533-554](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/tool/shell.ts#L293-L309)). opencode 자신이 signal로 죽으면 그 group이 고아가 될 수 있다[추론]. 서버 `POST /session/:id/abort`는 정리 후 idle, 메시지는 `MessageAbortedError`. 중단된 도구 호출은 재개 때 orphaned로 표시하고 넘어간다.
- **Antigravity** [문서·changelog] SIGINT는 `result.status` INTERRUPTED와 비0 종료. 종료 시 stream 연결을 바로 끊고, signal로 죽은 명령은 canceled로 기록하며, 최신 changelog는 실행이 끝날 때 daemon 백그라운드 프로세스를 죽인다고 한다. stream-json 입력의 control_request는 종료 2로 거부되어 **프로토콜 안 취소가 없다**. SIGTERM·process group·MCP 자식 정리는 미확인.

### 7. 사용량

- **Claude Code** [문서] `result.usage`(input·output·cache_creation·cache_read tokens, 주 루프만), `modelUsage`(모델별, subagent 포함, costUSD), `total_cost_usd`. 모두 **동봉 가격표로 계산한 클라이언트 추정치**이며 청구 자료가 아니다. 재개하면 이전 사용량이 합산된다(v2.1.277부터). [CC agent-sdk/cost-tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking) 구독 로그인에서 `total_cost_usd`가 채워지는지·구독 잔여 한도는 문서에 없다[미확인]. [추론] 로컬 계산이라 구독에서도 API 가격 환산값이 나올 가능성이 높다.
- **Codex** [소스] `turn.completed.usage`: `input_tokens`·`cached_input_tokens`·`cache_write_input_tokens`·`output_tokens`·`reasoning_output_tokens`, 비용 없음([exec_events.rs L61-73](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/exec/src/exec_events.rs#L61-L73)). ChatGPT 요금제에서는 app-server `account/rateLimits`가 사용률(`used_percent`)·창 길이·reset 시각·credits·plan을 준다([v2/account.rs L671-763](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L671-L763)). API key·구독 모두 토큰은 나온다.
- **OpenCode** [소스] 각 `step_finish`에 `cost`와 `tokens{input, output, reasoning, cache{read, write}}`, models.dev 가격표로 로컬 계산([session/session.ts L363-400](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/session/session.ts#L363-L400)). **ChatGPT Plus/Pro 로그인이면 cost를 0으로 강제**하고 토큰은 그대로 보고한다([plugin/openai/codex.ts L303-312](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/plugin/openai/codex.ts#L303-L312)).
- **Antigravity** [문서] `usage{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}`가 result와 단계마다 있고 stream-json 입력 모드에서는 세션 누계다. 비용 칸은 없다. 구독은 "AI credits"·요금제 한도로 재고 statusline·`/credits`·`/usage`로 본다([AG cli/credits](https://antigravity.google/docs/cli/credits/)). 소비자 OAuth에서 토큰 수가 채워지는지는 미확인.

### 8. 인증, 동시 실행, 구독 자동화 약관

- **Claude Code** [문서] 우선순위: 클라우드 제공자 env > `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY`(`-p`에서 있으면 항상 사용) > `apiKeyHelper` > `CLAUDE_CODE_OAUTH_TOKEN` > `/login` OAuth. `claude setup-token`이 1년짜리 OAuth 토큰을 만든다(Pro/Max/Team/Enterprise). 병렬 세션은 문서화된 기능이고 로그인당 프로세스 상한은 문서에 없다. 공식 문구([CC legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance), [agent-sdk overview](https://code.claude.com/docs/en/agent-sdk/overview)):
  - "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
  - "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users" … "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription."
  - "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."
  - [추론] 자가 호스팅에서 소유자가 자기 로그인으로 수정하지 않은 바이너리를 돌리는 형태는 마지막 예외에 가깝다. 다만 여러 에이전트를 계속 돌리는 사용이 "ordinary, individual usage"에 드는지는 문서가 정하지 않는다 — 사용자가 판단할 문제다. ACP adapter는 Agent SDK를 거치므로 위 SDK 문구의 적용을 받는다.
- **Codex** [문서] exec는 "reuses saved CLI authentication by default"(`$CODEX_HOME/auth.json` 또는 keyring, 자동 갱신). `CODEX_API_KEY`·`OPENAI_API_KEY`도 읽는다. [learn.chatgpt.com auth](https://learn.chatgpt.com/docs/auth): "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs." [ci-cd-auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth): "Use one `auth.json` per runner or per serialized workflow stream." "Do not share the same file across concurrent jobs or multiple machines." 갱신은 "another machine or concurrent job rotated the token first"면 깨진다. OpenAI 이용약관 원문은 openai.com이 403을 돌려 확인하지 못했다[미확인].
- **OpenCode** [소스·문서] 자격 증명은 `$XDG_DATA_HOME/opencode/auth.json`. 내장 구독 로그인은 ChatGPT Plus/Pro·GitHub Copilot·GitLab Duo·SuperGrok 등. 1.3.0부터 Claude Pro/Max 로그인이 없다. OpenCode 문서: "There are plugins that allow you to use your Claude Pro/Max models with OpenCode. Anthropic explicitly prohibits this."([providers.mdx L356-368](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/web/src/content/docs/providers.mdx#L356-L368), OpenCode 쪽 문구). ChatGPT 토큰 갱신 중복 제거는 프로세스 안에서만 하고 프로세스 간 잠금이 없어, 여러 인스턴스가 같은 `auth.json`으로 갱신 경쟁을 할 수 있다[소스·추론]. 약관은 각 제공자(OpenAI·GitHub·GitLab) 것을 따르며 조사하지 않았다.
- **Antigravity** [문서] 인증: `oauth-personal`(Free·AI Plus·Pro·Ultra), `oauth-business`(Gemini Enterprise), `gemini-api-key`, `agent-platform`. 비대화는 한 번 대화형 로그인한 자격 증명을 재사용한다. [AG faq](https://antigravity.google/docs/faq/):
  - "Antigravity CLI headless mode (`agy -p`) is intended for direct scripting and CI workflows."
  - "Wrapping `agy` inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans."
  - "Using third-party software, tools, or services to access Antigravity is a violation of our Terms of Service … can result in suspension or termination of your account." 대안으로 "a Gemini Enterprise or Google AI Studio API key"를 권한다.
  - [약관 §6](https://antigravity.google/terms)은 non-Google 제품·third-party 도구를 통한 사용을 남용 예로 들고 계정 정지를 경고한다.
  - [추론] BaboJUBot이 소비자 Google AI Pro/Ultra 로그인으로 `agy`를 구동하는 것은 공식 문구상 "not supported"다. API key·Enterprise·Agent Platform 인증이 문서가 허용하는 경로다.

### 9. 권한·sandbox

- **Claude Code** [실행·문서] `--permission-mode acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`. v2.1.302부터 `-p` 기본은 manual: 승인이 필요한 호출은 hook이나 `--permission-prompt-tool`이 허가하지 않으면 거부된다. `--permission-prompts none`은 묻지 않고 거부한다. `bypassPermissions`는 root에서 거부. OS sandbox는 Linux·WSL2에서 bubblewrap+socat(WSL1 불가), 기본 꺼짐, 실행별로 `--settings '{"sandbox":{"enabled":true,"allowUnsandboxedCommands":false,"failIfUnavailable":true}}'`. **Bash 계열과 그 자식만 덮고** 파일 도구·WebFetch·MCP는 권한 규칙이 맡는다. 쓰기는 cwd·임시·`--add-dir`, 네트워크는 빈 `allowedDomains`로 시작하는 proxy. `failIfUnavailable` 없이 sandbox가 못 뜨면 조용히 sandbox 없이 돈다. [CC sandboxing](https://code.claude.com/docs/en/sandboxing)
- **Codex** [실행·소스] `-s read-only|workspace-write|danger-full-access`, exec 기본 read-only. exec는 승인 정책을 never로 고정하고([exec/src/lib.rs L591](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/exec/src/lib.rs#L591)) 명령·파일 변경·사용자 입력 승인 요청을 "not supported in exec mode"로 거부, MCP elicitation은 자동 취소한다(L2095-2160). `--approve-for-me`(자동 검토), `--dangerously-bypass-approvals-and-sandbox`, `--add-dir`. `sandbox_workspace_write.writable_roots`·`network_access`(기본 false). Linux sandbox는 bubblewrap+seccomp, root 읽기 전용 mount 후 쓰기 root를 bind, "WSL2 uses the normal Linux bubblewrap path", WSL1 불가([linux-sandbox/README.md](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/linux-sandbox/README.md)).
- **OpenCode** [문서·소스] 비대화 승인은 권한 규칙, `--auto`(명시 deny 외 모두 승인), 또는 `run` 기본값(ask를 자동 거부). 쓰기 제한은 `edit` 패턴과 `external_directory`(기본 ask → `run`에서 거부). shell 명령의 경로 검사는 파싱 기반 추정이지 강제가 아니다. 네트워크 제어는 `webfetch`·`websearch` 권한뿐이라 shell은 네트워크에 닿는다. **OS sandbox 코드(bwrap·landlock·seatbelt)가 없다** — 격리는 컨테이너·OS 사용자로 우리가 맡아야 한다[소스·추론].
- **Antigravity** [문서] 기본 `request-review`, `--mode accept-edits`(workspace 안 편집 자동 승인), `--mode auto`(Preview, Linux는 sandbox 필요, sandbox 밖 명령은 별도 검토 agent에, 업무 계정 불가), `--mode plan`, `--dangerously-skip-permissions`(`always-proceed`). 비대화 기본 모드에서 workspace 파일 읽기·쓰기는 자동 허용, shell은 soft-deny(계속 돌고 0으로 끝남). 규칙은 `permissions.{allow, ask, deny}`에 `action(target)`(read_file·write_file·read_url·command·mcp(server/tool) 등), Deny > Ask > Allow, 전역 settings.json에 있고 `--settings`로 세션별 덮어쓰기([AG permissions](https://antigravity.google/docs/permissions)). Linux sandbox는 kernel namespace: workspace·임시·빌드 cache 쓰기, 나머지 숨김, `~/.ssh`·`.env` 차단, 네트워크 기본 차단에 `read_url` 도메인 allowlist. unprivileged user namespace가 막힌 환경에서는 `--sandbox`가 아무것도 하지 않는다([AG sandbox](https://antigravity.google/docs/sandbox)). WSL은 문서에 없다.

### 10. 모델 선택

- **Claude Code** [실행] `--model <alias|full>`(fable·opus·sonnet·haiku), `--fallback-model`, `--effort low..max`. stdin `set_model` control request로 실행 중 변경.
- **Codex** [실행] `-m/--model` 또는 `-c model=…`, `--oss`·`--local-provider`. app-server `turn/start`는 턴별 모델 지정.
- **OpenCode** [실행] `-m provider/model`, `--variant`(reasoning effort). agent별 `model`, prompt별 `model{providerID, modelID}`, ACP `unstable_setSessionModel`. 제공자가 여럿이라 모델 문자열이 로그인 종류에 묶인다.
- **Antigravity** [실행·문서] `--model <slug>`, `--effort`. 모르는 모델은 종료 1, fallback 없음. Gemini·Claude·GPT-OSS 계열이 요금제별로 열린다([AG models](https://antigravity.google/docs/models/)). `agy models`는 네트워크를 탈 수 있어 실행하지 않았다.

### 11. 실행 중 메시지(steer)

- **Claude Code** [문서] `--input-format stream-json`(+ stream-json 출력)에서 턴 도중 사용자 메시지를 보낼 수 있고 `priority`가 시점을 정한다: `next`(기본, 진행 중 도구 호출이 끝나면 같은 턴에서 읽음), `later`(턴이 끝난 뒤 새 턴), `now`(턴 중단). 턴마다 `result`가 나오고 프로세스는 턴 사이에 살아 있다. `--replay-user-messages`가 받은 입력을 되돌려 확인을 준다. [CC agent-sdk/streaming-vs-single-mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- **Codex** [소스·문서] app-server `turn/steer{threadId, input, expectedTurnId}`가 "append[s] user input to the active in-flight turn"이고 활성 턴이 없으면 실패한다([v2/turn.rs L317-344](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L317-L344)). 메서드 자체는 experimental 표시가 없지만 app-server 모드가 production 비지원이다. exec에는 수단이 없다.
- **OpenCode** [소스] busy 세션에 `POST /session/:id/prompt_async`(또는 `prompt`)를 보내면 메시지를 저장하고 진행 중인 실행에 합류한다([session/prompt.ts L1052-1071](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/session/prompt.ts#L1052-L1071)). 루프는 마지막 답이 최신 사용자 메시지에 대한 것일 때만 멈추므로 다음 단계 경계에서 읽힌다[추론]. `serve`/`--attach`/SDK에서만 가능.
- **Antigravity** [문서·changelog] 비대화에서는 없다. 문서는 `result`를 기다린 뒤 다음 stdin 줄을 쓰라고 한다. 대화형에만 `queuedMessages: "send-immediately"`가 있다.

### 12. ACP

ACP 명세 [문서]: `session/new{cwd, mcpServers}`(stdio 필수, http·sse는 agent가 `mcpCapabilities`로 알림), `session/load`(기록을 `session/update`로 재생), `session/resume`(재생 없음), `session/close`, `session/prompt` → `stopReason`(`end_turn`·`max_tokens`·`max_turn_requests`·`refusal`·`cancelled`), `session/cancel` 알림(agent는 오류 대신 `cancelled`로 응답해야 함, 남은 권한 요청은 클라이언트가 `cancelled`로 답함), `session/request_permission`, 선택적 `usage_update`(context `used`·`size`, 선택 `cost`). 표준에 system prompt 칸은 없다. [prompt-turn](https://agentclientprotocol.com/protocol/prompt-turn), [session-setup](https://agentclientprotocol.com/protocol/session-setup)

- **Claude Code** [실행·소스] 내장 ACP 없음. `claude-agent-acp`가 Agent SDK(다시 바이너리)를 감싼다. `loadSession`·resume·list·fork·close, MCP http·sse, `_meta.steering.supported`와 `_session/steering`(턴 중 주입), `session/cancel` → `query.interrupt()` → `cancelled`, `usage_update`. **기본 `settingSources`가 `["user","project","local"]`이라 사용자 전역 CLAUDE.md를 읽는다** — `_meta.claudeCode.options`로 `settingSources`·`systemPrompt`·`tools`·`strictMcpConfig`·`sandbox`를 덮어써야 한다.
- **Codex** [소스] 내장 ACP 없음. `codex-acp`가 app-server를 감싼다. `loadSession`, MCP `{http: true, sse: false}`([src/CodexAcpServer.ts L811-820](https://github.com/agentclientprotocol/codex-acp/blob/ac8d9251de43ab8648a89eb0520e0c606ad78be5/src/CodexAcpServer.ts#L811-L820)), resume·fork·close·cancel, ACP `systemPrompt`(append, text)를 `developerInstructions`로, 토큰만 `usage_update`로, `_session/steering`("pre-standard ACP extension also shipped by claude-agent-acp"). `INITIAL_AGENT_MODE`·`CODEX_CONFIG` env로 sandbox·config를 준다.
- **OpenCode** [실행·소스] 내장 `opencode acp [--cwd]`(stdio NDJSON, 내부 localhost HTTP 서버도 띄움). `loadSession`, MCP http·sse(+stdio), close·fork·list·resume, `unstable_setSessionModel`, prompt 결과에 `stopReason`+`usage`, `usage_update`에 context 사용량과 누적 USD cost([acp/service.ts L114-131, L653-662](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/acp/service.ts#L114-L131)). **`session/new`의 MCP 서버를 그 세션이 아니라 cwd 전체에 등록**하므로 한 `acp` 프로세스 안 같은 cwd의 세션들이 공유한다(L958-1026).
- **Antigravity** [실행·바이너리] `agy`에 ACP 모드가 없다(help·문자열에 `session/new` 없음). Google이 ACP registry에 별도 비공개 서버 `antigravity-acp` 1.4.5를 올렸고 Zed 문서가 이를 안내한다([AG ide/extensions/zed](https://antigravity.google/docs/ide/extensions/zed/)). CLI(1.4.10)보다 버전이 뒤처지고, capability는 내려받지 않아 미확인. 8번의 소비자 요금제 문구는 이 경로에도 해당한다[추론].
- [추론] ACP가 덮는 것: 세션 시작·재개, prompt, 갱신 stream(도구 호출·결과), 권한 질문 왕복, 실행별 MCP 목록(http 포함), 취소와 `cancelled` 응답 의무, 토큰 사용량. **덮지 않는 것**: system prompt 교체(표준 칸 없음, adapter별 `_meta`·확장), 개인 전역 지침 차단, 기본 도구 제한·권한 규칙 기본값, OS sandbox·네트워크, 인증과 약관, 비용(선택 칸이고 도구마다 다름), steer(표준 전 확장 `_session/steering`), 프로세스 수준 정리(adapter 프로세스를 죽였을 때 자식 정리). 그리고 Claude·Codex는 adapter 패키지 하나가 의존성으로 더 붙는다.

## 공통 설계에 주는 시사점

설계 제안이며 결정이 아니다. 모두 [추론]이다.

### 네 도구가 같은 것

- 한 번 실행하고 끝나는 비대화 실행이 있고 한 줄 JSON 이벤트를 stdout으로 낸다. 실행 시도 하나 = 프로세스 하나로 감쌀 수 있다.
- 세션 ID가 출력에 나오고 그 ID로 재개한다. `RunResult.nextSession`에 `{sessionId}`(+ OpenCode·Claude는 저장 위치 env)를 넣는 모양으로 수렴한다.
- 도구 호출 이벤트에 도구 이름·입력·결과가 있다. `RuntimeActivity.tool_use{tool, summary}`는 네 도구 모두에서 만들 수 있다. 단 OpenCode `run`은 도구가 끝난 뒤에만 낸다.
- 네 도구 모두 **Streamable HTTP MCP + header**를 받는다. 조직 도구를 `access.toolsBaseUrl` 위 HTTP MCP 하나로 내고 실행 시도 토큰을 header로 주는 방식이 공통 바닥이다.
- 프로젝트 지침 파일(AGENTS.md 계열)을 workspace에서 읽는다. 다만 이것은 연구 workspace에 이미 있는 파일을 프로바이더가 읽는다는 뜻이기도 하다.
- 토큰 수는 네 도구 모두 낸다. `--model` 계열 flag가 있다.

### 갈리는 것

1. **최종 판정 신호가 다르다.** Claude `result.subtype`, Codex `turn.completed/failed`+종료 코드, OpenCode 종료 코드+`error` 유무, Antigravity `result.status`(시간 초과도 종료 0). 종료 사유 판정은 adapter 안의 규칙이고 공통 계약 밖이다.
2. **취소 방법이 다르다.** 정상 정리 신호가 Claude·Codex·Antigravity는 SIGINT(+Claude는 stdin interrupt), OpenCode `run`은 없음(서버 abort만). SIGTERM은 Claude 143·Codex 즉시 종료·OpenCode 즉시 종료·Antigravity 미확인. 공통 adapter 규칙은 "도구별 정상 신호 → 유예 시간 → process group SIGKILL"이고, 공통 검사의 "취소를 받으면 곧 `cancelled`"는 강제 종료 경로에서도 지켜야 한다.
3. **비용.** Claude만 USD를 내고(추정), OpenCode는 내지만 ChatGPT 로그인이면 0, Codex·Antigravity는 없다. `usage.costUsd`가 이미 nullable이라 맞지만, 0(구독)과 null(모름)을 구분해야 하고, 구독 한도(Codex rateLimits·Antigravity credits)는 지금 계약에 자리가 없다. cache·reasoning 토큰도 계약에 없다.
4. **지침 주입 강도.** 교체: Claude flag, OpenCode config agent, Codex 비권장 file, Antigravity custom agent 본문(교체 여부 미확인). 추가: Claude flag, Codex `developer_instructions`, OpenCode 메시지별 `system`(서버), Antigravity 파일만. `RunRequest.instructions`를 "프로바이더가 자기 방식으로 주입"으로 둔 현재 계약은 맞는 방향이다.
5. **개인 전역 지침 차단.** Claude는 구독 로그인을 유지하며 가능(`--setting-sources project,local`, `--bare`는 API key 전용). OpenCode는 `XDG_CONFIG_HOME` 분리로 가능. Codex는 `CODEX_HOME` 분리 외에 방법이 없고 그러면 로그인 파일 사본이 필요하다(OpenAI가 동시 공유를 경고). Antigravity는 `inherit_user: false` 문법 미확인. 조직 경계 불변 조건(사용자 개인 지침이 조직 실행에 섞이지 않음)을 강제하려면 이 차이가 핵심이다.
6. **실행별 도구 주입이 전역·workspace를 건드리는가.** Claude(flag)·OpenCode(env)는 안 건드림. Codex는 `-c`로 가능할 것(미실행). Antigravity는 workspace에 파일을 써야 하고, 토큰 header가 파일에 들어가면 그 workspace의 다른 실행·에이전트가 읽을 수 있다. 반대로 Claude `--mcp-config '<json>'`에 토큰을 바로 넣으면 프로세스 인자로 보인다 — 권한 0600 임시 파일이나 env 참조(Codex `bearer_token_env_var`, OpenCode `{env:}`)를 써야 한다.
7. **재개 시 지침.** Claude는 기본으로 첫 system prompt를 고정한다(snapshot). OpenCode는 매 단계 다시 읽는다. 지침 bundle 버전이 바뀌면 admission이 `previousSession`을 비우는 현재 계약은 Claude의 고정 동작과 잘 맞고 나머지에도 해가 없다.
8. **OS 격리.** Claude·Codex·Antigravity는 Linux sandbox가 있지만 덮는 범위(Claude는 Bash만, Antigravity는 terminal만)와 실패 시 동작(Claude는 조용히 sandbox 없이 진행 가능)이 다르고, OpenCode는 없다. 연구 환경 격리는 프로바이더 sandbox에 기대지 말고 Agent Runtime이 바깥(컨테이너·OS 사용자)에서 정하는 편이 공통이다.
9. **실행 중 메시지.** Claude CLI stdin, Codex app-server(production 비지원), OpenCode 서버, Antigravity 없음. 지금 계약은 실행 중 입력 채널이 없고 `owner_interrupt` 취소만 있다.
10. **구독 자동화 약관.** Claude는 "수정 안 한 바이너리 + 본인 구독"을 허용하되 사용량은 "ordinary, individual"을 가정한다. Codex는 자동화에 API key를 권하고 동시 작업의 로그인 파일 공유를 경고한다. Antigravity는 소비자 요금제에서 third-party 앱 안 구동을 "not supported"라 적는다. OpenCode는 연결한 제공자의 약관을 따른다. 기술 문제가 아니라 사용자가 결정할 인증 방식 문제다.

### 공통 계약이 프로바이더별 capability로 드러내야 할 것

| capability(가칭) | 뜻 | Claude | Codex | OpenCode | Antigravity |
|---|---|---|---|---|---|
| 정상 취소 | 턴을 정리하고 끝내는 신호가 있다 | 있음(SIGINT·stdin) | 있음(SIGINT) | 서버 경로만 | 있음(SIGINT) |
| 비용 보고 | USD 비용 값의 출처 | 추정 | 없음 | 추정(ChatGPT 0) | 없음 |
| 구독 한도 보고 | 남은 구독 한도 | 없음 | app-server만 | 없음 | `/usage`(별도 호출) |
| 지침 교체 | 기본 system prompt를 바꿀 수 있다 | 있음 | 비권장 | 있음 | 미확인 |
| 개인 지침 차단 | 사용자 전역 지침 없이 돌 수 있다 | 있음 | 로그인 분리 필요 | 있음(env) | 미확인 |
| 실행별 도구 주입 | 전역·workspace 파일 없이 MCP를 준다 | 있음 | 있음(미실행) | 있음 | 없음(workspace 파일) |
| 재개 시 지침 반영 | 재개한 세션에 새 지침이 들어간다 | 기본 아님 | 미확인 | 있음 | 미확인 |
| OS sandbox | 프로바이더 자체 격리 | Bash만 | shell | 없음 | terminal |
| 실행 중 메시지 | 진행 중인 턴에 사용자 메시지를 넣는다 | 있음 | app-server만 | 서버만 | 없음 |
| 세션 ID 지정 | 새 세션 ID를 호출자가 정한다 | 있음 | 없음 | 없음 | 없음 |

이 표는 공통 검사(`describeRuntimeContract`)가 capability별로 갈라 확인할 항목 후보다. 특히 "개인 지침 차단"과 "실행별 도구 주입"이 없는 프로바이더는 조직 경계 불변 조건을 adapter가 바깥(HOME·설정 디렉터리 분리)에서 만들어야 하므로, 붙이기 전에 그 방법을 실행으로 확인해야 한다.

### ACP를 공통 기반으로 쓸 때

- 얻는 것: 시작·재개·prompt·갱신 stream·취소(`cancelled` 응답 의무)·권한 왕복·실행별 MCP 목록이 한 모양이 된다. 취소 의미가 계약의 "정리 후 `cancelled` 한 번"과 같다.
- 남는 것: 위 표의 지침 교체·개인 지침 차단·sandbox·인증·비용·steer는 ACP 밖이라 프로바이더별 설정으로 여전히 다뤄야 한다. Claude·Codex는 adapter 패키지 하나, Antigravity는 비공개·버전이 뒤처진 별도 서버가 더 붙고, OpenCode ACP는 MCP 서버를 cwd 단위로 공유하므로 실행 시도마다 `acp` 프로세스를 따로 띄워야 토큰이 섞이지 않는다.

## 검증 결과와 한계

실행한 것(모두 모델 호출 없음, 자격 증명 파일 미열람):

- `claude --help`, `claude mcp add --help`, `claude auth --help`, 바이너리 `strings`로 control request subtype 확인.
- `codex --help`, `codex exec --help`, `codex mcp/app-server/mcp-server/sandbox --help`, `ls ~/.codex`(파일 이름만).
- `opencode --help`와 `run`·`serve`·`acp`·`mcp`·`session`·`agent`·`providers --help`.
- `agy --help`, `agy help <sub>`, `agy mcp --help`, `agy changelog`, `ls ~/.gemini`(이름만), settings.json 키 이름(`jq keys`), 바이너리 `strings` 일부, ACP registry JSON 조회.
- 위 고정 SHA의 Codex·OpenCode·ACP adapter 소스를 `/tmp`에 shallow clone해 읽음. 공식 문서는 2026-10-30 열람.
- 네 도구별 사실 수집은 탐색 보조 agent 네 개가 나눠 했고, 이 문서를 쓰며 Claude Code·Codex·OpenCode의 핵심 flag(`--bare`·`--restricted`·`--permission-prompts`·`--system-prompt-snapshot`·`--ignore-user-config`·`--approve-for-me`·`--auto` 등)는 help를 다시 열어 확인했다. 소스 줄 번호는 보조 agent가 읽은 것을 다시 열지 않았다.

실행하지 않아 미확인인 것:

- 실제 이벤트 줄, SIGINT/SIGTERM 때 실제 출력·종료 코드(특히 Claude SIGINT, Antigravity SIGTERM), MCP 자식 프로세스가 부모와 함께 죽는지.
- Codex `-c mcp_servers.*` 실행별 주입, Claude `--mcp-config`의 `${VAR}` 확장, `--setting-sources` 빈 값, `--safe-mode`가 `--mcp-config`도 끄는지.
- 구독 로그인에서 Claude `total_cost_usd`·Antigravity 토큰 수가 채워지는지.
- Antigravity: `--settings`가 MCP·권한 규칙을 받는지, custom agent `inherit_user`·`excludeDefaultComponents` 문법, agent 본문이 교체인지, WSL sandbox 동작, ACP 서버 capability.
- 로그인 하나로 여러 인스턴스를 동시에 돌릴 때의 공식 상한과 토큰 갱신 경쟁(Codex 문서 경고 외).
- OpenAI 이용약관 원문(openai.com 403), OpenCode가 연결하는 OpenAI·GitHub·GitLab 구독의 자동화 약관.
