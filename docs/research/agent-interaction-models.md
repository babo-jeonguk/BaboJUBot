# Agent 상호작용 모델 조사: 협력 매체·전달 의미·사용자 개입·관찰

확인일: 2026-10-13. 이 문서의 질문은 하나입니다. **agent끼리, agent와 사용자는 무엇을 매개로 소통하며, 사용자는 실행 중인 agent를 어떻게 멈추거나 방향을 바꾸는가?** 질문은 네 가지로 나눴습니다.

1. **협력 매체:** 프로세스 간 실시간 대화(그룹 채팅, 메시지 전달), DB의 영속 기록(task·issue·comment)과 이벤트 기반 깨우기, 공유 파일·blackboard, 계층 위임(하위 agent 호출이 결과를 반환), 고정 파이프라인 중 무엇을 쓰는가.
2. **전달 의미:** B가 실행 중일 때 A의 메시지가 오면 무엇이 일어나는가. 다음 실행으로 대기하는가, 턴 경계에서 주입되는가, 중단시키는가. 병합·중복 제거가 있는가. 부모는 자식의 종료를 어떻게 아는가.
3. **사용자 개입:** 웹 UI와 Telegram·Slack·Discord 메시지가 agent에 닿는 경로, 제어 행동(일시정지·중단·승인)과 대화 입력의 차이, 사용자가 실행 중인 턴을 끊을 수 있는지와 그 방법.
4. **관찰성:** 무엇이 기록되고 UI로 스트리밍되는가(이벤트, transcript, 도구 호출).

agent 실행 방식·adapter·맥락 주입은 별도 문서(`agent-runtime-models.md`, 작성 중)의 범위입니다. 이 문서는 위 네 질문만 다룹니다.

## 조사 방법과 표기

- **공개 코드:** 아래 고정 commit을 `/tmp/aim-research`에 clone하고 정적으로 읽었습니다. 설치, 빌드, 실행, 실제 agent 호출은 하지 않았습니다. Paperclip·Hermes·OpenClaw는 [Paperclip 조사](paperclip.md)와 [구조 조사](reference-code-structure.md)와 같은 commit을 사용합니다.

  | 프로젝트 | 고정 commit | commit 시각 |
  |---|---|---|
  | [Paperclip](https://github.com/paperclipai/paperclip/tree/1b4c803816e82b0265c8422e1a804327a7ed8c54) | `1b4c803816e82b0265c8422e1a804327a7ed8c54` | 2026-10-11 22:48 -07:00 |
  | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/3569e8461ea721623fa16e6f01fb636157989fe6) | `3569e8461ea721623fa16e6f01fb636157989fe6` | 2026-10-12 01:15 -07:00 |
  | [OpenClaw](https://github.com/openclaw/openclaw/tree/80f170ea263a21187384cb67d5aead87b1d01fc2) | `80f170ea263a21187384cb67d5aead87b1d01fc2` | 2026-10-12 09:16 +00:00 |

- **상용 제품(xAI):** docs.x.ai 공식 문서만 사용했습니다. 문서에 게시·수정일이 없어 열람일(2026-10-13)을 기준으로 합니다.
- **AI-scientist 계열:** 공개 저장소의 고정 commit과 논문을 사용했습니다. 고정 SHA는 해당 절에 적었습니다.
- **근거 표기:**
  - **[소스]** 고정 commit의 코드를 직접 읽었습니다.
  - **[문서]** 공식 문서·README·논문에만 근거합니다. 실제 코드의 강제 여부는 확인하지 않았습니다.
  - **[추론]** 위 근거에서 해석한 내용입니다.
- 코드가 존재한다는 확인은 실제 환경에서 정상 동작한다는 확인이 아닙니다.

## 요약 비교

| 대상 | 협력 매체 | 실행 중 도착한 입력 | 사용자 중단 | 관찰 |
|---|---|---|---|---|
| Paperclip | DB의 issue·comment·할당·wake 요청. agent 간 실시간 대화 없음 | 같은 agent의 실행이 `running`이면 comment는 **다음 실행으로 지연**하고, 지연된 wake끼리 병합. 예외는 OpenAI Dot runner의 실행 중 전달 | board 사용자의 `interrupt` comment, agent pause, Slack stop이 실행을 취소하고 프로세스에 신호 | `heartbeat_runs`, `heartbeat_run_events`, `activity_log`, wake 기록. company 단위 WebSocket |
| Hermes Agent | 프로세스 내 위임 도구(자식은 요약만 반환), 프로필 간 공유 SQLite Kanban 보드 | 사용자 설정 `busy_input_mode`: `interrupt`(기본) / `queue` / `steer`. 백그라운드 자식 결과는 **턴 사이에만** 새 턴으로 전달 | `/stop`이 실행 트리 전체를 중단. `redirect`는 진행 중인 모델 요청만 취소 | SQLite 세션·메시지(도구 호출 포함), 자식별 live transcript, 채팅 도구 진행 표시 |
| OpenClaw | gateway 세션: 하위 agent 생성과 결과 announce, `sessions_send`로 세션 간 메시지 | 세션별 queue mode: `steer`(기본, 도구 batch 경계 주입) / `followup` / `collect`(병합) / `interrupt` | `/stop`이 세션 작업·대기열·자식 트리를 중단. 실행 승인은 도구 호출 안에서 대기 | gateway WebSocket의 `agent`·`chat`·`session.tool`·승인 이벤트, agent별 SQLite transcript |
| xAI Grok Bot | Bot 간 비동기 메시지·handoff, 2~6개 Bot 그룹 채팅, 계정 공유 컴퓨터 | 수신 Bot이 "깨어나" 처리. busy 시 대기 규칙 비공개 | 사용자의 직접 메시지가 현재 턴을 redirect할 수 있고, "Stop now" 메시지로 중단 | transcript의 도구 활동·질문·승인 요청. Enterprise 감사·행동 기록 |
| AI-scientist 계열 | 고정 파이프라인, 대화형 역할 쌍, supervisor와 비동기 작업 queue, 공유 world model | 대부분 동기 호출 또는 내부 queue. 실행 중 사용자 메시지 주입 경로는 확인되지 않음 | 단계 사이 checkpoint 승인이나 피드백이 중심 | 단계별 산출물·로그·tree 시각화, 근거 연결 보고서 |

## Paperclip

### 1. 협력 매체: 영속 업무 기록과 wake 요청

- **[문서]** agent 간 주된 소통 수단은 issue comment입니다. 상태 갱신, 질문, 발견, 인계가 모두 comment로 이루어집니다. [comments-and-communication](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/docs/guides/agent-developer/comments-and-communication.md)
- **[문서·소스] @-mention은 맥락 표시일 뿐입니다.** mention된 agent를 깨우지 않고, 할당하거나 comment를 전달하지도 않습니다. 다른 agent에게 일을 맡기려면 할당, 하위 task, 명시적 review 요청을 써야 합니다. [문서 L53](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/docs/guides/agent-developer/comments-and-communication.md#L53)
  - wakeup 함수도 `issue_comment_mentioned` 이유의 wake를 실행이나 지연 요청을 만들기 전에 버립니다. [queue.ts L2127-L2130](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/heartbeat/queue.ts#L2127-L2130)
- **[소스] wake는 DB 행입니다.** `agent_wakeup_requests`에 `reason`, `source`, `payload`, `status`, `coalescedCount`, `idempotencyKey`, 요청자, 연결된 run이 저장됩니다. [schema](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/db/src/schema/agent_wakeup_requests.ts#L15)
  - 확인한 상태 값: `queued`, `coalesced`, `deferred_issue_execution`, `skipped` 등.
  - 확인한 wake 이유: `issue_assigned`, `issue_commented`, `approval_approved`, `issue_children_completed`, `issue_blockers_resolved` 등.
- **[소스] 부모는 이벤트로 자식 종료를 압니다.** 자식 issue가 끝나 부모가 재개 조건을 충족하면, 부모 담당자를 `issue_children_completed` 이유로 깨웁니다. payload에 완료된 자식 ID와 자식 요약이 들어갑니다. [issues route L15707-L15730](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/routes/issues.ts#L15707-L15730)
- **[추론]** 이번 범위에서 agent 실행끼리 직접 메시지를 주고받는 경로는 찾지 못했습니다. 코드에서 "chat"은 사람과 agent의 대화를 뜻합니다. 전수 검색 결론은 아닙니다.
  - 사람과의 대화 기능 "Agent Chat"은 실험 기능이며 기본값은 꺼짐(`enableAgentChat: false`)입니다. [instance validator L63](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/shared/src/validators/instance.ts#L63)

### 2. 전달 의미: 실행 경계를 지키는 지연과 병합

wake가 들어올 때 같은 issue의 실행 잠금을 가진 run이 있으면, 순수 함수 `decideWakeAdmission`이 세 결과 중 하나를 고릅니다. **[소스]** [policy.ts L44-L61](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/modules/wake-queue/domain/policy.ts#L44-L61)

- **`coalesce`:** 같은 실행 agent이고 follow-up이 강제되지 않으며 살아 있는 실행이 있을 때. 새 wake의 맥락을 그 실행의 `contextSnapshot`에 병합하고, 기록용 행을 `coalesced` 상태로 남깁니다.
- **`defer`:** 실행이 있지만 병합 조건이 맞지 않을 때. 실행 뒤에 `deferred_issue_execution` wake를 둡니다.
  - 같은 agent·issue의 지연된 wake가 이미 있으면 새로 만들지 않고 그 행에 병합해 `coalescedCount`를 올립니다. [use-cases.ts L783-L943](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/modules/wake-queue/application/use-cases.ts#L783-L943)
- **`proceed`:** 실행이 없어 일반 wake로 대기열에 넣을 때.

어떤 입력이 지연되는지:

- **[소스]** 같은 agent의 실행이 `running`일 때 comment wake나 새 세션 요청은 "새 실행 경계"가 필요하므로 지연됩니다.
- **[소스]** 다음 wake도 실행 중인 턴에 섞지 않고 follow-up으로 둡니다: comment, 구조화된 사용자 응답(interaction), 승인 결과(`approval_approved`), blocker 해소, 채팅 완료. [queue.ts L235-L240, L298-L335](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/heartbeat/queue.ts#L235-L335)
- **[소스]** 지연된 wake는 실행이 issue 잠금을 놓을 때 새 실행으로 승격되거나, pause hold 등 조건에 따라 취소됩니다. [use-cases.ts `promoteDeferredWake`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/modules/wake-queue/application/use-cases.ts#L320), [policy.ts L184-L195](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/modules/wake-queue/domain/policy.ts#L184-L195)

예외와 추론:

- **[소스] 예외: OpenAI Dot runner.** adapter가 `paperclip_runner`이고 provider가 `openai_dot`이면, `issue_commented`를 실행 중인 Dot에 바로 전달합니다. 그래도 그 comment를 읽을 때까지는 지연 wake를 영속 상태로 유지합니다. [queue.ts L3649-L3690](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/heartbeat/queue.ts#L3649-L3690)
- **[추론]** 병합은 실제로 `queued` 또는 재시도 대기 상태의 run에 주로 의미가 있습니다. 이미 실행 중인 프로세스가 갱신된 snapshot을 다시 읽는다는 근거는 찾지 못했습니다. 일반 adapter에는 실행 중 주입 경로가 없고, comment는 다음 실행으로 넘어갑니다.

### 3. 사용자 개입

**대화 입력은 comment가 되고, 그 comment가 wake가 됩니다.**

- **[소스] 웹:** board 사용자의 comment는 담당 agent를 `issue_commented`로 깨웁니다. 위 지연 규칙이 그대로 적용됩니다.
- **[소스] 메신저:** Slack·Discord·Telegram·Teams·GitHub 등 채팅 provider가 core에 있습니다. [CHAT_PROVIDERS](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/shared/src/types/chat-channels.ts#L2-L11)
  - 외부 메시지는 대화 issue에 comment로 저장됩니다. [chat-channels.ts L16265](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/chat-channels.ts#L16265)
  - 사용자 응답은 `allowRunCoalescing: false`인 `issue_commented` wake가 됩니다. [chat-channels.ts L20150-L20200](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/chat-channels.ts#L20150-L20200)
  - 개별 provider의 전체 흐름은 추적하지 않았습니다.
- **[소스] Board Concierge Chat:** `claude` CLI를 board skill로 띄워 SSE로 응답을 스트리밍하고, 대화를 상설 "Board Operations" issue에 저장하는 별도 경로가 있습니다. [board-chat.ts L22-L36](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/routes/board-chat.ts#L22-L36)

**제어 행동은 별도 API이며, 실행 중인 프로세스를 실제로 끊습니다.**

- **[소스] interrupt comment:** comment에 `interrupt: true`를 붙이면 board 사용자만 허용합니다(agent는 403). 현재 실행에 `cancelRun("Interrupted by board comment")`를 호출하고, `operator_interrupted`로 activity를 기록합니다. [issues.ts L374-L376](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/routes/issues.ts#L374-L376), [L13883-L13925](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/routes/issues.ts#L13883-L13925)
  - 즉 사용자는 "대기(기본)"와 "끊고 다시 시작" 중 하나를 고릅니다.
- **[소스] 대기 중 comment 큐:** 큐 항목을 편집할 수 있고, 대기 메시지를 보내기 위해 현재 실행을 중단하는 route도 있습니다. 대화 issue에서는 그 대화의 소유자만 실행할 수 있습니다. [issues.ts L16249-L16300](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/routes/issues.ts#L16249-L16300)
- **[소스] 취소의 실제 동작:** native run 취소를 요청한 뒤 프로세스 그룹에 종료 신호를 보내고, 유예 시간을 둡니다. 기본은 SIGTERM이고 `codex_local`은 SIGINT입니다. [run-control.ts L1028-L1050](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/heartbeat/run-control.ts#L1028-L1050)
- **[소스] agent pause:** board 전용 route가 상태를 바꾼 뒤 `cancelActiveForAgent`로 진행 중인 실행까지 취소합니다. [agents.ts L5401-L5413](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/routes/agents.ts#L5401-L5413)
- **[소스] Slack stop:** "stop" 동작을 `chat_actions` 행으로 영속 처리한 뒤 같은 `cancelRun`을 호출합니다. [chat-channels.ts L26770-L26815](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/chat-channels.ts#L26770-L26815)
- **[소스] 승인:** `approve`, `reject`, `request-revision`, `resubmit`과 승인별 comment route가 있습니다. 승인 결과는 `approval_approved` wake로 담당 agent의 follow-up 실행을 만듭니다. [approvals.ts L296-L517](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/routes/approvals.ts#L296-L517)
- **[문서]** 예·아니오 결정은 자유 comment가 아니라 구조화 카드(`request_confirmation` 등)로 받으라고 agent에게 지시합니다. [comments-and-communication](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/docs/guides/agent-developer/comments-and-communication.md)

### 4. 관찰성

- **[소스] 영속 기록:**
  - `heartbeat_runs`: 로그 저장 위치, stdout 발췌, context snapshot, wake 연결.
  - `heartbeat_run_events`: 실행별 `seq`, `eventType`, `stream`, `level`, `message`, `payload`, 출처 중복 제거 필드. [schema L15-L36](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/db/src/schema/heartbeat_run_events.ts#L15-L36)
  - `activity_log`.
  - 병합·생략된 wake 행 자체도 감사 기록 역할을 합니다.
- **[소스] 실시간 전달:** 프로세스 내 `EventEmitter` 버스가 company 단위 WebSocket(`/api/companies/{companyId}/events/ws`)으로 UI에 push합니다. [live-events.ts](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/live-events.ts), [live-events-ws.ts](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/realtime/live-events-ws.ts)
  - 이벤트 종류: `heartbeat.run.queued/status/progress/event/log`, `agent.status`, `activity.logged` 등. [LIVE_EVENT_TYPES](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/shared/src/constants.ts#L942-L955)
- **[추론]** 실시간 버스가 단일 프로세스 메모리이므로, 진실의 원천은 DB이고 WebSocket은 갱신 알림입니다.
- adapter 출력에서 transcript와 도구 호출을 해석하는 경로는 이번에 따라가지 않았습니다(`agent-runtime-models.md` 범위).

## Hermes Agent

### 1. 협력 매체: 프로세스 내 위임과 공유 Kanban 보드

**위임 도구 `delegate_task`**

- **[소스] 자식 구성:** 자식은 새 대화, 자신의 task_id·터미널 세션, 부모 도구에서 금지 도구를 뺀 도구 집합을 가진 별도 `AIAgent`입니다.
- **[소스] 부모가 보는 것:** 위임 호출과 요약 결과뿐이고, 자식의 중간 도구 호출이나 추론은 보지 않습니다. [delegate_tool.py L1-L11](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/tools/delegate_tool.py#L1-L11)
- **[소스] 금지 도구:** 재귀 위임, 사용자 질문(`clarify`), 공유 memory 쓰기, `send_message`, 예약 작업 생성. [delegate_tool_toolsets.py L14-L23](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/tools/delegate_tool_toolsets.py#L14-L23)
- **[소스] 자식 사이에는 직접 대화가 없습니다.** 부모는 자신의 자식 트리에 `list`, `steer`, `stop` 제어만 할 수 있습니다.
- **[소스] 자기 보고 경고:** 도구 설명은 자식 요약이 검증된 사실이 아닌 자기 보고이므로 외부 side effect는 부모가 직접 확인하라고 지시합니다. [delegate_tool.py L616-L639](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/tools/delegate_tool.py#L616-L639)

**Kanban 보드**

- **[소스] 프로필 간 공유 SQLite 보드:** 이 보드가 프로필 간 협력 수단입니다. 테이블은 task, link, comment, event, run, 첨부, 알림 구독이고, `tasks.status`·`claim_lock` compare-and-swap으로 한 claimer만 이깁니다. [kanban_db.py L1-L12](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/hermes_cli/kanban_db.py#L1-L12)
- **[소스] 작업자 프로세스:** dispatcher가 담당 프로필로 `hermes -p <profile> chat -q ...` OS 프로세스를 띄웁니다. 작업자는 claim한 보드에 고정되어 다른 보드를 볼 수 없습니다. 완료는 작업자 자신의 `complete`·`block` 전이로 관찰합니다. [kanban_db_dispatch.py L2831-L2846](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/hermes_cli/kanban_db_dispatch.py#L2831-L2846)
- **[문서]** Kanban 문서는 연구 분류(병렬 조사자 + 분석가 + 작성자, 사람 개입) 같은 다중 프로필 협력을 사용 예로 듭니다. [kanban 문서](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/kanban.md)

### 2. 전달 의미

**사용자 입력이 실행 중인 턴에 도착할 때** — `busy_input_mode` 설정에 따라 달라지며 기본값은 `interrupt`입니다. **[소스]** [config_defaults.py L830](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/hermes_cli/config_defaults.py#L830)

- **`queue`:** 현재 턴 뒤로 대기합니다. 세션별 상한은 32개입니다. [run.py L3967-L3969](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/gateway/run.py#L3967-L3969)
- **`steer`:** 중단하지 않고 버퍼에 쌓습니다. 여러 번 들어오면 줄바꿈으로 이어 붙이고, 현재 도구 batch가 끝난 뒤 새 `user` 행으로 넣습니다. [interrupt_control.py L267-L278](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/agent/interrupt_control.py#L267-L278)
- **`interrupt`:** gateway는 가능하면 `redirect`를 호출합니다. [interrupt_control.py L280-L341](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/agent/interrupt_control.py#L280-L341)
  - 모델 요청 중이면 그 요청만 취소하고, 완료된 메시지는 유지하며, 정정을 user 메시지로 붙여 재시도합니다.
  - 도구 실행 중이면 `steer`로 낮춥니다.
- **gateway의 강등 규칙:** 자식 agent가 실행 중이거나 맥락 압축 중이면 `interrupt`를 `queue`로 강등합니다. steer가 불가능하면 queue로 처리해 메시지를 잃지 않습니다. [run_busy.py L583-L635](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/gateway/run_busy.py#L583-L635)
- **재시작 시:** `queue`·`steer` 메시지는 gateway 재시작 후에도 남고, `interrupt` 메시지는 버려집니다. [run_busy.py L90-L98](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/gateway/run_busy.py#L90-L98)
- **`interrupt()` 자체:** 진행 중인 API 요청 중단, 도구 중단 신호, 자식 전파를 수행합니다. [interrupt_control.py L128-L236](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/agent/interrupt_control.py#L128-L236)

**자식 결과가 부모에 돌아올 때**

- **동기 위임:** 자식 결과가 도구 결과 JSON으로 그대로 돌아옵니다.
- **백그라운드 위임:** 완료 시 `async_delegation` 이벤트를 공유 completion queue에 넣고, CLI·gateway가 idle일 때 꺼내 **새 턴으로만** 전달합니다(턴 중간에는 넣지 않음). 중복 제거와 crash recovery를 공유합니다. [async_delegation.py L1-L8](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/tools/async_delegation.py#L1-L8)
- **[문서]** 도구 설명은 모델에게 결과를 기다리거나 polling하지 말고 턴을 끝내라고 지시합니다.

### 3. 사용자 개입

- **[소스] 세션 키:** gateway는 플랫폼, 채팅 종류, chat_id, thread, 사용자로 세션 키를 만듭니다. DM은 채팅별로 분리되고, 그룹의 사용자별 분리는 설정에 따릅니다. [session.py L685-L700](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/gateway/session.py#L685-L700)
- **[소스] 승인:** agent 스레드가 대기 승인을 등록하면 gateway가 사용자에게 알립니다. 스레드는 `/approve`·`/deny` 또는 시간 초과까지 `threading.Event`에서 막힙니다. 병렬 자식도 각자 대기할 수 있고, `/approve all`이 모두 해소합니다. [approval_gateway_wait.py L1-L11](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/tools/approval_gateway_wait.py#L1-L11)
- **[소스·문서] 제어와 대화의 구분:**
  - `/stop`(hard interrupt)은 대기 중인 steer까지 버리고, `/stop`·`/new`·프로세스 종료는 자식 트리 전체를 멈춥니다. 중단된 자식은 부분 출력과 함께 `interrupted`로 완료됩니다.
  - 일반 메시지는 위 `busy_input_mode`를 따릅니다.
  - 자식은 사용자에게 질문할 수 없습니다(`clarify_callback=None`).

### 4. 관찰성

- **[소스] 세션 DB:** SQLite `messages` 테이블에 역할, 내용, `tool_calls`, 도구 이름, 토큰, finish reason, provider가 반환한 reasoning 필드가 저장됩니다. [hermes_state_common.py L449](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/hermes_state_common.py#L449)
  - steer도 실제 user 행으로 저장됩니다.
- **[소스] 자식 transcript와 진행 표시:** 백그라운드 위임은 자식별 live transcript 경로를 반환합니다. 채팅 플랫폼에는 도구 진행 메시지를 하나의 말풍선 갱신 또는 별도 메시지로 표시합니다. [display_config.py](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/gateway/display_config.py)
- **[소스] 대시보드:** 웹 dashboard가 있고 Kanban 보드를 보여줍니다. 세션 화면의 세부는 확인하지 않았습니다.

## OpenClaw

### 1. 협력 매체: gateway 세션 간 위임과 메시지

- **[문서] 다중 agent:** 하나의 Gateway에 여러 agent를 두고 각자 workspace와 세션 기록을 가집니다. 채널 메시지는 `bindings`로 agent에 배정됩니다. [multi-agent](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/concepts/multi-agent.md)
- **[문서] 하위 agent:** 별도 세션(`agent:<id>:subagent:<uuid>`)의 백그라운드 실행이며, 기본적으로 결과를 요청자에게 **announce**합니다.
  - 맥락은 기본 격리이고, `context: "fork"`로 부모 transcript를 복사할 수 있습니다.
  - 기본 도구 집합에 세션·메시지 도구가 없습니다. [subagents L10-L32](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/tools/subagents.md#L10-L32)
- **[문서] `sessions_send`:** 같은 Gateway의 다른 세션을 실행하고 선택적으로 응답을 기다립니다. 상대의 응답은 요청자에게 한 번만, inline 또는 이후 입력으로 돌아옵니다. [session-tool L202](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/concepts/session-tool.md#L202)
  - 송수신 권한은 agent별 `tools.agentToAgent.send` 허용 목록과 세션별 Always/Ask/Never로 제한합니다. **Ask이면 Control UI의 사람에게 질문한 뒤에야** 상대 입력을 받아들입니다.
  - agent는 이 설정을 바꿀 수 없습니다. [session-tool L180-L212](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/concepts/session-tool.md#L180-L212)
- **[소스]** 예전의 agent 간 자동 왕복 설정 `session.agentToAgent.maxPingPongTurns`는 은퇴한 설정 키 목록에 있습니다. [legacy migration L166](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/commands/doctor/shared/legacy-config-migrations.runtime.retired-media.ts#L166)
  - **[추론]** 자동 왕복 대화를 "응답 한 번 반환"으로 대체한 것으로 보입니다.

### 2. 전달 의미: 네 가지 queue mode

세션에 실행이 있을 때 새 입력의 처리 방식은 `steer | followup | collect | interrupt` 중 하나입니다. **[소스]** [zod schema L34-L39](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/config/zod-schema.messages.ts#L34-L39)

- **기본값과 우선순위:** 기본은 `steer`, debounce 500ms, cap 20, 넘칠 때 `summarize`입니다. [state.ts L47-L49](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/auto-reply/reply/queue/state.ts#L47-L49)
  - 우선순위: inline `/queue` > 세션 저장값 > 채널별 설정 > 전역 설정 > `steer`. [settings.ts L15-L30](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/auto-reply/reply/queue/settings.ts#L15-L30)
- **`steer`:** 실행 중인 턴에 주입합니다. **[소스]** [agent-loop.ts L584-L590, L748-L755](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/packages/agent-core/src/agent-loop.ts#L584-L755)
  - 도구 batch가 끝난 뒤, 다음 모델 결정 전에 steering을 확인합니다.
  - 순차 실행이면 시작하지 않은 뒤쪽 도구 호출을 "Skipped to process an incoming message."로 건너뜁니다.
  - 실행 중인 도구는 끝까지 실행하고, 병렬 batch는 건너뛰지 않습니다. [queue 문서 L36-L50](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/concepts/queue.md#L36-L50)
  - steering을 받을 수 없는 runtime이면 실행 종료를 기다립니다.
- **`followup`:** 메시지마다 별도의 후속 턴을 만듭니다.
- **`collect`:** 조용한 시간 뒤 호환되는 메시지를 하나의 후속 턴으로 합칩니다. **[문서]** Discord·Telegram처럼 영속 수신(durable ingress)을 쓰는 채널에서는 `followup`처럼 동작합니다.
- **`interrupt`:** 세션 lane의 대기 명령을 비우고 실행을 중단한 뒤 최신 메시지를 실행합니다. **[소스]** [admission L387-L403](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/auto-reply/reply/get-reply-run-admission.ts#L387-L403)
- **[소스] heartbeat 입력:** 세션이 바쁘면 버립니다. [queue-policy.ts L15-L17](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/auto-reply/reply/queue-policy.ts#L15-L17)
- **[문서] lane과 영속 저장:** 세션마다 FIFO lane이 있고, 실행 중인 턴은 선점되지 않습니다. 수신 메시지는 lane에 들어가기 전에 저장될 수 있습니다. [queue 문서 L20-L24](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/concepts/queue.md#L20-L24)

**부모가 자식 종료를 아는 방식(announce)** — **[소스]** push 방식이며 polling하지 않습니다. 전달 경로는 `steered | direct | queued | none` 중 하나입니다. [announce-dispatch L116-L162](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/agents/subagents/announce/subagent-announce-dispatch.ts#L116-L162)

- 완료 메시지가 필요 없으면 부모 실행에 steer를 먼저 시도합니다.
- 필요하면 요청자 세션에 직접 후속 `agent` 호출을 먼저 시도하고, 실패 시 steer로 대체합니다.
- **[문서]** 중첩된 orchestrator는 내부 주입으로 받아 결과를 종합합니다. 기록된 전달 사실로 중복을 막습니다. [announce L17-L23](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/tools/subagents/announce.md#L17-L23)

### 3. 사용자 개입

- **[문서] 메시지 경로:** 채널 메시지 → `bindings`로 agent·세션 결정 → 세션 lane → queue mode 처리.
- **[문서] 제어 명령:** `/queue <mode>`는 세션별 override를 저장하고, `/steer <msg>`도 있습니다.
- **[문서] `/stop`:** 요청자 세션의 작업과 대기열을 비우고 활성 자식 트리를 취소합니다. `runId` 없는 `chat.abort`는 자식에게 전파되지 않습니다. [operations L205-L213](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/tools/subagents/operations.md#L205-L213)
- **[소스·문서] 실행 승인:** gateway가 `exec.approval.requested`·`exec.approval.resolved` 이벤트를 방송합니다. [server-methods-list.ts L85](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/gateway/server-methods-list.ts#L85)
  - 채팅 승인은 `/approve ...` 메시지로 받고, Matrix는 reaction 단축도 제공합니다.
  - 명령은 원래 도구 호출 안에서 결정을 기다리고, 턴이 닫히면 승인 권한도 무효가 됩니다(늦은 승인으로 재시작하지 않음).
  - 승인 UI가 없으면 기본은 deny입니다. [exec-approvals L92-L106](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/tools/exec-approvals.md#L92-L106)

### 4. 관찰성

- **[소스] gateway WebSocket 이벤트:** `agent`, `chat`, `session.message`, `session.tool`, `heartbeat`, 승인 이벤트 등. [server-methods-list.ts L33-L86](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/gateway/server-methods-list.ts#L33-L86)
- **[문서] `agent` 이벤트의 stream:** `tool`, `assistant` delta, `lifecycle`(`start|finishing|end|error`)로 나뉩니다. [agent-loop L23](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/concepts/agent-loop.md#L23)
- **[문서] 저장:** transcript는 agent별 SQLite에 있고, JSONL은 보관 형식입니다. [session 문서](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/concepts/session.md)
- **[문서] Control UI:** Subagents 패널이 실행 중·종료된 자식 실행과 읽기 전용 transcript를 보여줍니다. [subagents L39-L45](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/tools/subagents.md#L39-L45)
  - 대기 중인 입력도 턴 시작 전에 다른 client에 보입니다.

## xAI Grok 제품군

세 제품은 서로 다른 제품입니다. 모두 내부 구현이 공개되지 않았으므로 아래 내용은 전부 **[문서]**입니다. 특히 Grok Bot의 큐잉·전달 보장은 공개되지 않았습니다. 문서 열람일은 2026-10-13입니다.

### Grok Bot (사용자가 지칭한 정식 제품)

**협력 매체**

- Bot은 다른 Bot에게 비동기 메시지를 보낼 수 있습니다. 받은 Bot은 깨어나 요청을 처리하고 나중에 답할 수 있으며, handoff는 대화에서 보입니다.
- 2~6개 Bot의 그룹 채팅이 있습니다. 일반 메시지는 Bot들이 누가 답할지 정하고, `@`는 한 Bot을 지정합니다. [chat-and-collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration)
- 모든 Bot이 같은 클라우드 컴퓨터(파일·브라우저 세션·로그인)를 공유합니다. 대화와 학습 맥락만 Bot별로 분리됩니다. [overview](https://docs.x.ai/grok-bot/overview)
- 강제되는 leader 구조는 없고, 한 Bot에 결과 소유권을 주라는 권고만 있습니다. [bots](https://docs.x.ai/grok-bot/bots)

**전달 의미**

- Bot당 화면에서 한 번에 하나의 computer-use 작업만 실행합니다. 이미 실행 중이면 끝나거나 redirect되어야 다음 작업이 시작될 수 있습니다. [troubleshooting](https://docs.x.ai/grok-bot/troubleshooting)
- 다른 Bot·routine·trigger가 일으킨 승인 요청은 약 10분 뒤 만료되고, 그 동작은 실행되지 않습니다. [approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- 바쁜 Bot에 Bot 메시지가 도착했을 때의 대기·순서·중복 처리는 공개되지 않았습니다. 병렬 handoff가 많으면 중복 작업이 생길 수 있다는 경고만 있습니다.

**사용자 개입**

- 접점: 데스크톱·모바일 앱, X 태그, Team Bot의 Slack 앱. Telegram은 문서에 없습니다. [team-bots](https://docs.x.ai/grok-bot/team-bots), [tag-on-x](https://docs.x.ai/grok-bot/tag-on-x)
- 사용자의 직접 메시지는 백그라운드 작업보다 우선하며 현재 턴을 redirect할 수 있습니다.
- 중단은 별도 버튼이 아니라 "Stop now" 메시지로 문서화되어 있으며, 이미 완료한 행동은 되돌리지 않습니다. [chat-and-collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration)
- 승인 카드는 Allow once / Always allow / Deny입니다. 승인·로그인·초안 요청은 그룹 채팅에 나타나지 않고 1:1 대화에서 처리합니다.
- Bot별 완료·입력 필요 알림이 있고, 사이드바에 "Needs attention" 상태가 있습니다. [settings-and-notifications](https://docs.x.ai/grok-bot/settings-and-notifications)

**관찰성**

- transcript에 도구 활동, computer use, 생성 파일, 질문, 승인 요청이 일반 메시지와 함께 표시됩니다.
- Enterprise에는 감사 로그와 기본 꺼짐인 Action Recording, OpenTelemetry 내보내기가 있습니다. [security](https://docs.x.ai/grok-bot/security)
- 모델 추론 표시 여부는 문서에 없습니다.

### Grok multi-agent API (`grok-4.20-multi-agent`)

- **협력 매체:** 한 서버 측 요청 안에서 4개 또는 16개 agent가 토론하고, 지정된 leader가 종합해 최종 답을 냅니다. 내부 프로토콜은 공개되지 않았습니다. 문서는 beta로 표시합니다. [multi-agent](https://docs.x.ai/developers/model-capabilities/text/multi-agent)
- **전달 의미:** 동기(또는 스트리밍) 응답 하나입니다. 다음 턴은 `previous_response_id`로 이어갑니다.
- **사용자 개입:** client 측 함수 호출을 지원하지 않으므로, 호출자가 실행 중에 승인 단계를 넣을 수 없습니다.
- **관찰성:** leader의 도구 호출과 최종 응답만 반환됩니다. 하위 agent의 추론·도구 호출·출력은 `use_encrypted_content` 설정 시에만 **암호화된 상태**로 포함되며 사용자는 읽을 수 없습니다.
- 공식 SDK에는 `agent_count` 매개변수만 공개되어 있습니다. [xai-sdk chat.py L69-L72](https://github.com/xai-org/xai-sdk-python/blob/1d9e1dffc9a0521ede0e6bc7f2b906177b940d34/src/xai_sdk/chat.py#L69-L72)

### Grok Build (보조 비교)

- **[문서]** 하위 agent는 독립 맥락의 자식 세션이며, 끝나면 부모에게 요약을 반환합니다. [subagents](https://docs.x.ai/build/features/subagents)
- **[문서]** 실행 중 제출한 prompt는 버려지지 않고 대기합니다. dashboard에서 보내면 idle agent는 즉시 받고, busy agent는 대기열에 넣습니다. [background-tasks](https://docs.x.ai/build/features/background-tasks), [dashboard](https://docs.x.ai/build/features/dashboard)
- **[문서]** 계획 검토는 자동 승인 모드에서도 생략되지 않습니다. [permissions](https://docs.x.ai/build/features/permissions)

## AI-scientist 계열

자동 연구 시스템 다섯 개를 비교했습니다.

| 대상 | 근거 | 고정 버전 |
|---|---|---|
| Sakana AI Scientist-v2 | 코드 | [`96bd516`](https://github.com/SakanaAI/AI-Scientist-v2/tree/96bd51617cfdbb494a9fc283af00fe090edfae48) |
| Agent Laboratory | 코드 | [`d9017d9`](https://github.com/SamuelSchmidgall/AgentLaboratory/tree/d9017d90e329112d2a80b7712f37ee9094d2cd27) |
| HKUDS AI-Researcher | 코드 | [`f9a6f84`](https://github.com/HKUDS/AI-Researcher/tree/f9a6f8480860c193afff600eeffe3defcee8a978) |
| Google AI co-scientist | 논문 | [arXiv 2502.18864v1](https://arxiv.org/abs/2502.18864v1) |
| Kosmos (FutureHouse/Edison) | 논문 | [arXiv 2511.02824v2](https://arxiv.org/abs/2511.02824v2) |

### Sakana AI Scientist-v2: 고정 파이프라인 + 단계별 병렬 tree search

- **[소스] 협력 매체:**
  - 바깥 흐름은 실험(tree search) → 그림 집계 → 논문 작성 → LLM 리뷰의 고정 순서입니다. [launch_scientist_bfts.py L256-L281](https://github.com/SakanaAI/AI-Scientist-v2/blob/96bd51617cfdbb494a9fc283af00fe090edfae48/launch_scientist_bfts.py#L256-L281)
  - 실험 안에서는 `AgentManager`가 네 단계(초기 구현, baseline 조정, 창의적 연구, ablation)를 순서대로 진행합니다. [agent_manager.py L143-L147](https://github.com/SakanaAI/AI-Scientist-v2/blob/96bd51617cfdbb494a9fc283af00fe090edfae48/ai_scientist/treesearch/agent_manager.py#L143-L147)
  - 공유 매체는 node tree인 `Journal`입니다. 코드 주석이 Journal을 부모 node를 찾는 "database"로 부릅니다.
- **[소스] 전달 의미:**
  - 단계마다 `ProcessPoolExecutor`로 여러 node를 실행하고, `future.result(timeout)`으로 순서대로 기다린 뒤 결과를 journal에 자식 node로 붙입니다. [parallel_agent.py L2147-L2160](https://github.com/SakanaAI/AI-Scientist-v2/blob/96bd51617cfdbb494a9fc283af00fe090edfae48/ai_scientist/treesearch/parallel_agent.py#L2147-L2160)
  - 즉 coordinator는 future 반환·시간 초과·예외로 종료를 압니다.
  - 단계 완료 여부는 LLM의 구조화 판단으로 정합니다.
- **사용자 개입:**
  - **[소스]** 실행 전 아이디어 입력 검증(Title, Hypothesis 등 필수 항목)만 있습니다.
  - **[추론]** 실행 중 입력이나 승인 경로는 찾지 못했습니다. 중단은 프로세스 종료이며, 단계 checkpoint pickle이 남습니다.
- **[소스] 관찰성:** 단계별 `journal.json`, `stage_progress.json`, HTML tree 시각화(`tree_plot.html`).

### Agent Laboratory: 고정 단계 + 역할 쌍 대화 + co-pilot checkpoint

- **[소스] 협력 매체:**
  - 단계는 문헌 조사 → 계획 → 실험(데이터 준비, 실행) → 결과 해석·보고서 작성·보고서 개선 순서로 고정입니다. [ai_lab_repo.py L60-L65](https://github.com/SamuelSchmidgall/AgentLaboratory/blob/d9017d90e329112d2a80b7712f37ee9094d2cd27/ai_lab_repo.py#L60-L65)
  - 각 단계 안에서는 Postdoc ↔ PhD 같은 역할 쌍이 번갈아 호출됩니다. 상대 응답의 `DIALOGUE` 블록을 다음 호출의 `feedback`으로 넘기고, `PLAN` 같은 구조화 블록이 나오면 단계가 끝납니다. [L420-L436](https://github.com/SamuelSchmidgall/AgentLaboratory/blob/d9017d90e329112d2a80b7712f37ee9094d2cd27/ai_lab_repo.py#L420-L436)
  - 여러 lab 사이에는 AgentRxiv 논문 저장소를 공유 blackboard로 씁니다.
- **[소스] 전달 의미:** 모든 호출이 동기 함수 호출입니다. 병렬 lab은 thread로 실행합니다.
- **[소스] 사용자 개입:**
  - co-pilot 모드에서는 각 단계 끝에 결과를 출력하고 stdin으로 Y/N을 묻습니다.
  - N이면 메모를 받아 agent 상태를 초기화하고, 메모를 notes에 추가한 뒤 단계를 다시 실행합니다. [L547-L570](https://github.com/SamuelSchmidgall/AgentLaboratory/blob/d9017d90e329112d2a80b7712f37ee9094d2cd27/ai_lab_repo.py#L547-L570)
  - 실행 중 끼어드는 경로는 없고, 단계 경계의 차단형 승인·재작업 gate입니다.
  - 보고서 개선 단계의 사람 분기는 `input()`의 답을 변수에 저장하지 않아 답과 무관하게 완료로 진행되는 것으로 읽힙니다. [L210-L218](https://github.com/SamuelSchmidgall/AgentLaboratory/blob/d9017d90e329112d2a80b7712f37ee9094d2cd27/ai_lab_repo.py#L210-L218)
- **[소스] 관찰성:** 단계별 lab 객체 pickle, console log, lab별 시간 기록.

### HKUDS AI-Researcher: 스크립트 파이프라인 + 도구 반환형 handoff

- **[소스] 협력 매체:**
  - Python 스크립트가 준비 → 아이디어 생성·선택 → code survey → 구현 계획 → 구현 → judge ↔ 구현 반복을 순서대로 `await`합니다. [run_infer_idea.py](https://github.com/HKUDS/AI-Researcher/blob/f9a6f8480860c193afff600eeffe3defcee8a978/research_agent/run_infer_idea.py)
  - 한 단계 안에서는 도구 함수가 다른 `Agent`를 반환하면 활성 agent가 바뀌는 Swarm식 handoff를 씁니다. [core.py](https://github.com/HKUDS/AI-Researcher/blob/f9a6f8480860c193afff600eeffe3defcee8a978/research_agent/inno/core.py)
  - 공유 상태는 메시지 목록과 `context_variables`입니다.
- **[소스] 전달 의미:**
  - 단계별 순차 대기입니다.
  - judge 반복은 응답 문자열에 `"fully_correct": true`가 나오거나 최대 반복 수에 도달하면 끝납니다.
- **[소스] 사용자 개입:** agent cache가 있을 때 터미널에서 Yes/Resume/No를 고르는 것뿐입니다. [flowcache.py L54-L60](https://github.com/HKUDS/AI-Researcher/blob/f9a6f8480860c193afff600eeffe3defcee8a978/research_agent/inno/workflow/flowcache.py#L54-L60)
- **[소스] 관찰성:** agent·반복별 JSON cache가 재개 checkpoint를 겸하고, logger가 있습니다.

### Google AI co-scientist: supervisor + 비동기 작업 queue + context memory

- **[문서] 협력 매체:**
  - 전문 agent(Generation, Reflection, Ranking, Proximity, Evolution, Meta-review)가 "비동기·연속·설정 가능한 작업 실행 프레임워크"의 worker process로 동작합니다.
  - Supervisor agent가 worker task queue를 관리하고 agent 배정과 자원 할당을 맡습니다.
  - 상태는 persistent context memory에 저장·조회하며, 실패 시 재시작에도 쓰입니다(논문 §3.1-3.2).
- **[문서] 전달 의미:** Supervisor는 요약 통계로 자원 배분과 종료 여부를 판단합니다. 메시지 형식과 worker 수는 공개되지 않았습니다.
- **[문서] 사용자 개입 (scientist-in-the-loop):** 과학자는 목표를 언제든 수정하고, 가설에 피드백을 주고, 자신의 가설을 토너먼트에 넣을 수 있습니다.
  - **[추론]** 고정 승인 gate보다 연속적인 방향 조정에 가깝습니다.
- **[문서] 관찰성:** 상위 가설과 리뷰를 종합한 research overview, Elo 순위, 문헌 인용.

### Kosmos: 구조화된 world model을 중심으로 한 주기형 병렬 실행

- **[문서] 협력 매체:** 데이터 분석 agent와 문헌 검색 agent가 구조화된 world model로 정보를 공유합니다.
- **[문서] 전달 의미:** 각 주기마다 최대 10개의 문헌·분석 작업을 실행하고, 결과 요약으로 world model을 갱신한 뒤, world model에 질의해 다음 주기 작업을 정합니다(§2.1).
  - **[추론]** world model이 주기 사이의 병합 지점이자 동기화 장벽입니다.
- **[문서·추론] 사용자 개입:** 목표와 데이터셋을 처음에 지정할 뿐, 실행 중 개입·승인은 논문에 서술되지 않았습니다.
- **[문서] 관찰성:** 보고서의 각 문장·그림이 문헌 또는 분석 agent가 만든 Jupyter notebook을 인용합니다. 과학자 평가에서 보고서 문장의 79.4%가 정확했습니다.

### AI-scientist 계열에서 얻은 관찰 — 추론

- 코드가 공개된 세 시스템은 모두 단일 프로세스 안의 동기 호출 또는 future 대기로 조정합니다. 사용자 개입은 stdin 기반 단계 gate뿐이며, 제품 수준의 영속 승인이나 실행 중 중단 API는 없습니다.
- 장시간·대규모 병렬을 다루는 시스템(co-scientist, Kosmos)은 공유 상태 저장소(context memory, world model)를 조정의 중심에 둡니다.
- 근거 추적은 Kosmos의 문장별 notebook·문헌 인용이 가장 강합니다. BaboJUBot의 연구 지도와 결과 근거 연결에 참고할 지점입니다.

## 비교에서 드러난 차이

1. **영속 업무 기록과 실시간 세션 메시지는 다른 축입니다.** Paperclip은 모든 협력을 issue·comment·wake 행으로 남기고, 실행 중인 턴에는 거의 주입하지 않습니다. OpenClaw와 Hermes는 세션 안 주입(steer)을 기본 또는 선택지로 두고 지연을 줄입니다. Grok Bot은 사용자 경험으로는 실시간 handoff를 보여주지만 보장은 공개하지 않습니다.
2. **중단의 의미가 제품마다 다릅니다.**
   - Paperclip의 interrupt는 프로세스 종료 후 새 실행입니다.
   - Hermes의 `redirect`는 진행 중인 모델 요청만 취소합니다.
   - OpenClaw의 `interrupt`는 실행 중단과 대기열 비우기입니다.
   - Grok Bot은 채팅 메시지로 redirect·stop합니다.
   - 어느 쪽도 이미 실행된 외부 side effect를 되돌리지 않습니다(Grok Bot 문서는 이를 명시).
3. **자식 종료 통지는 모두 push 방식입니다.** Paperclip은 `issue_children_completed` wake, Hermes는 completion queue의 새 턴, OpenClaw는 announce를 씁니다. 종합의 품질은 부모 agent의 일입니다.
4. **사람 승인의 대기 방식이 다릅니다.**
   - Hermes·OpenClaw는 도구 호출 안에서 막혀 기다리며, 턴이 닫히면 승인도 무효입니다.
   - Paperclip은 승인을 별도 영속 객체로 두고, 결정 시 follow-up wake를 만듭니다.
   - Grok Bot은 Bot 간 요청에서 생긴 승인을 약 10분 뒤 만료시킵니다.
5. **agent 간 메시지 권한을 사람이 정할 수 있는 곳이 있습니다.** OpenClaw의 송수신 Ask 설정은 agent 간 입력을 사람 승인 뒤에만 받아들입니다. Hermes의 Kanban 작업자는 보드에 고정되어 다른 보드를 볼 수 없습니다. 둘 다 조직 경계 강제와 유사한 장치입니다.

## 한계

- 세 공개 저장소 모두 대형이며 핵심 경로만 부분적으로 읽었습니다. Paperclip의 provider별 채팅 흐름, OpenClaw의 announce runtime 전체와 agent 간 응답 코드, Hermes의 CLI busy 처리·플랫폼 adapter·cron 결과 전달은 확인하지 않았습니다.
- 모든 판단은 정적 열람에 근거합니다. 실행 중 주입, 중단 신호, 병합의 실제 동작과 경쟁 조건은 실행 검증하지 않았습니다.
- xAI 제품의 내부 구현은 공개되지 않았습니다. 문서에 없는 동작(Bot 간 메시지 대기열, 전달 보장)을 없다고 단정하지 않습니다.
- AI-scientist 계열은 논문·저장소의 공개 범위만 비교했고, 실험을 재현하지 않았습니다.
- 조사 일부는 대상별 병렬 하위 조사로 수행했습니다. 문서에 쓴 핵심 주장(Paperclip 지연·interrupt·pause·live event, Hermes busy mode·steer·redirect·위임·Kanban·승인 대기, OpenClaw queue mode·steer 경계·announce 순서·interrupt·승인 문서, Grok Bot 채팅 문서)은 고정 commit 소스나 공식 문서에서 다시 확인했습니다.

## BaboJUBot에 주는 시사점 — 설계 제안, 결정 아님

아래는 "영속적이고 관찰 가능하며, 조직 경계와 승인을 제품 코드가 강제한다"는 [제품 불변 조건](../../AGENTS.md)에 맞춘 제안입니다. 채택은 해당 기능 이슈에서 결정합니다.

1. **협력의 진실은 조직 ID가 붙은 영속 기록에 둡니다.** Lead와 작업자의 질문·결과 공유·인계를 작업·comment·메시지 행으로 저장하고, 깨우기는 그 기록에 대한 wake 요청으로 만듭니다(Paperclip형).
   - 세션 메모리 안의 직접 대화(Grok Bot handoff, `sessions_send`)만으로는 조직 경계 검사, 재시작 복구, 대시보드 관찰을 보장하기 어렵습니다.
   - 작업자 간 직접 질문도 영속 메시지와 wake로 표현하면, 조직 ID 검사를 한 곳에서 강제할 수 있습니다.
2. **실행 중 도착 입력은 기본 "대기 + 병합"으로 하고, 주입은 선택적 최적화로 둡니다.**
   - 기본은 `deferred` wake와 병합 횟수 기록입니다. 실행 경계를 지키므로 승인·감사가 단순합니다.
   - runtime이 지원하면 도구 batch 경계 주입(steer)을 추가합니다. 주입한 입력도 user 행으로 기록합니다(Hermes, OpenClaw).
   - 승인 결과·사용자 결정은 실행 중인 턴에 섞지 말고 새 실행으로 전달합니다(Paperclip의 follow-up 강제 목록).
3. **제어 행동과 대화 입력을 API에서 분리합니다.**
   - 일시정지·중단·조직 전체 중단은 board 권한만 가능한 제어 API로 둡니다. 실제 프로세스 취소, 대기 wake 취소, 감사 기록을 함께 수행합니다.
   - 채팅의 "stop"도 같은 제어 API를 호출하는 영속 action으로 변환합니다(Paperclip Slack stop).
   - 사용자의 comment에는 "대기(기본) / 중단 후 반영" 선택을 둡니다. 중단으로 외부 side effect가 되돌려지지 않는다는 점은 UI에 표시합니다.
4. **승인은 도구 호출 안의 차단 대기가 아니라 영속 승인 객체로 둡니다.** 사용자가 늦게 답해도 결정을 잃지 않고, 결정은 follow-up wake로 Lead를 다시 깨웁니다.
   - 신규 작업자 추가, 큰 목표 변경, 추가 예산은 이 경로를 강제합니다.
   - 실행 중 위험 도구 승인처럼 짧은 대기가 필요하면 만료 시간과 무효 규칙을 명시합니다(OpenClaw, Grok Bot).
5. **자식·작업자 종료는 push 이벤트로 Lead를 깨우고, 자기 보고를 검증 대상으로 표시합니다.** 결과 요약은 산출물·근거 링크와 함께 저장하고, 자식 보고를 확인된 결과로 취급하지 않습니다(Hermes 도구 설명의 경고 참고).
6. **agent 간 메시지 권한을 사용자 설정 가능한 제품 규칙으로 둡니다.** 같은 조직 안은 허용, 조직 간은 금지, 명시적 공유만 예외로 합니다. 필요하면 OpenClaw의 Ask처럼 사람 승인 뒤에 받아들이는 모드를 두고, agent 스스로 이 설정을 바꿀 수 없게 합니다.
7. **관찰은 DB 기록 + 실시간 알림 2계층으로 둡니다.**
   - 실행별 순번 이벤트(상태, 도구 호출, 출력 발췌), wake·병합·취소 기록, 활동 로그를 저장합니다.
   - 조직 단위 WebSocket/SSE는 변경 알림으로만 씁니다.
   - 모델 내부 추론은 provider가 공개 반환한 경우에만 표시하고, 공개 로그로 가정하지 않습니다(Grok multi-agent API의 암호화된 하위 agent 상태 참고).
