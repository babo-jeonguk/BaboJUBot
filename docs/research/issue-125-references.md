# #125 백그라운드 명령과 실행 시도의 끝 — 조사와 결정

조사일 2026-11-09. 근거는 직접 열어 확인했다. 실제 모델 호출은 하지 않았다(비용 승인 전).

## Brief

- 문제: 작업자가 Claude Code의 `run_in_background`로 45초 명령을 띄우고 턴을 끝내자, 제품이 프로세스를 닫아 명령이 함께 죽고 작업이 멈췄다(#103 시연).
- 동종 문제(메커니즘): 비대화형 에이전트 프로세스가 턴을 끝낸 뒤에도 자기가 띄운 백그라운드 일을 기다리는가, 그리고 호스트는 언제 프로세스를 닫는가.
- 질문: Q1 Claude에 백그라운드를 끄거나 끝까지 기다리는 공식 방법이 있는가. Q2 Codex·OpenCode·Antigravity도 같은가. Q3 어떤 방식을 고르고 다른 프로바이더에 무슨 영향이 있는가.
- 재사용: [provider-connection-references](provider-connection-references.md) L112·L173·L270(백그라운드 일은 프로세스와 함께 사라진다는 이전 판단, OpenClaw가 `Bash(run_in_background:true)`를 막는 사례).

## 근거

| ID | 출처 | 확인한 내용 | 수준 |
| --- | --- | --- | --- |
| E01 | [Claude headless — Background tasks at exit](https://code.claude.com/docs/en/headless.md#background-tasks-at-exit) | 턴이 끝나고 stdin이 닫힌 뒤 `claude -p`는 메인 대화가 띄운 백그라운드 명령이 끝나거나 시간 한도에 닿을 때까지 열려 있고, 그 결과로 한 턴 더 한다. 그동안 10분 대기 상한은 적용되지 않는다 | 문서 |
| E02 | [Claude tools reference — When a background command stops / Time limit](https://code.claude.com/docs/en/tools-reference.md#time-limit-for-background-commands) | 무인 세션의 백그라운드 명령 한도: 기본 30분, `timeout`으로 최대 2시간(`--input-format stream-json`이면 30분). 한도에 닿으면 멈추고 Claude에게 알린다 | 문서 |
| E03 | [Claude env vars — `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`](https://code.claude.com/docs/en/env-vars) | `run_in_background`를 없애고, 시간 초과한 foreground 명령의 자동 백그라운드도 끈다(초과하면 멈춤) | 문서 |
| E04 | [Agent SDK cost tracking — streaming input mode](https://code.claude.com/docs/en/agent-sdk/cost-tracking.md#track-costs-in-streaming-input-mode) | 스트리밍 입력에서는 턴마다 `result`가 나오고 `usage`는 그 턴만, `total_cost_usd`는 누계다 | 문서 |
| E05 | [Agent SDK TypeScript — `SDKTaskStartedMessage`·`SDKTaskNotificationMessage`](https://code.claude.com/docs/en/agent-sdk/typescript.md#sdktaskstartedmessage) | 백그라운드 Bash·Monitor·subagent의 시작·끝 frame. `ambient: true`는 세션 일이 아니므로 활동 표시에서 뺀다 | 문서 |
| E06 | 우리 코드 `packages/runtime/src/providers/claude.ts`(base cf272dd) | 첫 `result`에서 `process.end()`(stdin 닫기 → 2초 뒤 그룹 SIGTERM → 2초 뒤 SIGKILL), 이후 frame 무시 | 소스 |
| E07 | OpenCode 2.2.5 `packages/core/src/tool/plugin/shell.ts` L43·L57, `session/runner/llm.ts` L172-180 | shell `background: true`는 즉시 돌아오고 끝나면 알림으로 세션을 다시 돌린다. 우리 adapter는 첫 `session.execution.succeeded`에서 서버를 닫는다 | 소스 |
| E08 | Codex `codex-rs/core/src/session/handlers.rs` L65·L523(openai-codex@a098129) | 백그라운드 터미널을 정리하는 명령이 있고, 끝났다고 턴을 다시 시작하지 않는다. 우리 adapter는 턴 완료에서 프로세스를 닫는다 | 소스 |

## 결정

| ID | 판정 | 내용 | 이유 |
| --- | --- | --- | --- |
| D01 | 채택 | Claude adapter는 첫 결과에서 입력만 닫고 프로세스가 스스로 끝날 때 실행 시도를 끝낸다. 마지막 결과가 실행 결과, 토큰은 턴 합, 비용은 마지막 누계 | 끝을 아는 쪽은 프로그램이다(E01). 제품이 "첫 결과 = 끝"으로 추측해 죽인 것이 원인(E06). 한도는 Claude가 지킨다(E02) |
| D02 | 채택 | `task_started`(ambient 제외)·`task_notification`으로 열린 백그라운드 일을 세고, 결과 때 남아 있으면 진행 활동 `백그라운드 작업이 끝나기를 기다립니다.` | 이슈 완료 조건: 끝내지 못하면 활동에 보인다(E05) |
| D03 | 배제 | `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` | 긴 실험을 막고, 시간 초과한 foreground 명령도 멈춘다(E03). 연구 작업과 맞지 않는다 |
| D04 | 채택 | 작업자 지침(researcher AGENTS.md)에 결과가 필요한 명령은 같은 실행 시도에서 기다리라고 적는다 | 프로바이더와 상관없이 맞는 규칙. Codex·OpenCode·Antigravity는 D01이 없다 |
| D05 | 후속 | OpenCode의 백그라운드 알림 재실행을 기다리는 것, 실행 시도보다 긴 일(외부 job·깨우기) | OpenCode 서버 API에 job 상태를 읽는 길을 아직 확인하지 못했다(E07). 실행 시도 밖의 긴 일은 판 범위 밖 |

## 다른 프로바이더 영향

- Codex·OpenCode·Antigravity adapter는 바뀌지 않는다. 첫 턴의 끝에서 프로그램을 닫으므로 백그라운드로 남긴 명령은 함께 끝나고 깨우지 않는다. 지침(D04)만 적용된다.
- 공통 `process.ts`는 바뀌지 않는다. 취소는 그대로 프로토콜 중단 → TERM → KILL이라 기다리는 Claude도 끝낸다.

## 한계와 미확인

- 실제 Claude(2.1.317)로 45초 명령 실행을 시험하지 않았다. 합성 녹화(`claude-background.synthetic.json`)로 frame 순서를 재생했다. `task_started`·`task_notification`이 stream-json 출력에 실제로 나오는지는 문서(E05)와 binary 문자열로만 확인했다.
- 결과 뒤 입력을 닫아도 끝나지 않는 Claude는 이제 취소될 때까지 실행 시도를 붙든다. Claude는 백그라운드 일이 없으면 끝나고, 있어도 시간 한도가 있다(E01·E02).
