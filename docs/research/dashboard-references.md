# 대시보드·운영자 UI 참고 조사: OpenClaw, Hermes Agent, Grok Bot, 자동 연구 시스템

확인일: 2026-10-13. 질문은 하나다. **연구 조직 대시보드가 참고할 만한 운영자 UI 기능은 무엇이며, 그중 Paperclip에서는 흔하지 않은 기능은 무엇인가?**

- 대상: OpenClaw Control UI, Hermes Agent의 웹 dashboard·Kanban plugin·Desktop 앱, xAI Grok Bot(공식 문서만), 연구 진행을 화면에 보여 주는 자동 연구 시스템 세 개(Sakana AI Scientist-v2, Microsoft R&D-Agent, HKUDS AI-Researcher)와 Google AI co-scientist 논문.
- 각 대상마다 화면·패널, 보여 주는 데이터, 사용자 행동, 실시간 동작, 눈에 띄는 UX를 정리했다. 대화창, transcript 보기, 승인, cron·heartbeat 설정, skill·persona 편집, 기억 보기, 비용·사용량, 채널 설정, 로그를 축으로 삼았다.
- Paperclip 대시보드는 별도 조사(`docs/research/paperclip-dashboard.md`, 작성 중)의 범위라서 다루지 않는다. 6절의 "Paperclip에서 흔하지 않은 기능"은 [Paperclip 1차 조사](paperclip.md)와 [상호작용 모델 조사](agent-interaction-models.md)에 기록된 Paperclip 기능(작업·승인·비용·활동 로그·실행 기록·routine)을 기준으로 골랐다. 별도 조사와 대조하지는 않았다.

용어는 [공통 용어](../../GLOSSARY.md)를 따른다. Claude Code, Hermes, OpenClaw처럼 모델 호출과 도구 루프를 실제로 수행하는 프로그램은 [실행 모델 조사](agent-runtime-models.md)처럼 **실행 도구(executor)** 라고 부른다. 각 제품 고유의 "agent", "session", "profile", "Bot"은 제품 용어 그대로 쓰며 BaboJUBot의 에이전트와 같은 뜻이 아니다.

## 기준 버전과 조사 방식

| 대상 | 기준 | 비고 |
|---|---|---|
| OpenClaw | [`80f170ea263a21187384cb67d5aead87b1d01fc2`](https://github.com/openclaw/openclaw/tree/80f170ea263a21187384cb67d5aead87b1d01fc2) | 기존 조사와 같은 SHA, MIT. clone remote는 `github.com/openclaw/openclaw` |
| Hermes Agent | [`3569e8461ea721623fa16e6f01fb636157989fe6`](https://github.com/NousResearch/hermes-agent/tree/3569e8461ea721623fa16e6f01fb636157989fe6) | 기존 조사와 같은 SHA, MIT. clone remote는 `github.com/NousResearch/hermes-agent` |
| Sakana AI Scientist-v2 | [`96bd516`](https://github.com/SakanaAI/AI-Scientist-v2/tree/96bd51617cfdbb494a9fc283af00fe090edfae48) | 기존 조사와 같은 SHA |
| HKUDS AI-Researcher | [`f9a6f84`](https://github.com/HKUDS/AI-Researcher/tree/f9a6f8480860c193afff600eeffe3defcee8a978) | 기존 조사와 같은 SHA |
| Agent Laboratory | [`d9017d9`](https://github.com/SamuelSchmidgall/AgentLaboratory/tree/d9017d90e329112d2a80b7712f37ee9094d2cd27) | 기존 조사와 같은 SHA |
| Microsoft R&D-Agent | [`484776c`](https://github.com/microsoft/RD-Agent/tree/484776c211e4fbbeef03e0ec00d6bbee7362a4f4) | 2026-09-23 commit, MIT. 이번에 새로 추가 |
| xAI Grok Bot | [docs.x.ai/grok-bot](https://docs.x.ai/grok-bot/overview) (2026-10-13 열람) | 공개 소스 없음. 문서에 게시·수정일 없음 |
| Google AI co-scientist | [arXiv 2502.18864v1](https://arxiv.org/abs/2502.18864v1) | 논문만 |

- 공개 저장소는 고정 SHA로 shallow clone한 뒤 정적으로만 읽었다. 설치, 빌드, 실행, 화면 캡처, 실제 모델 호출은 하지 않았다. 따라서 화면 묘사는 **공식 문서와 UI 소스에서 읽은 것**이며, 실제 렌더링을 보고 확인한 것이 아니다.
- 근거 표기:
  - **[소스]** 고정 commit의 코드를 직접 읽었다.
  - **[문서]** 저장소 안의 공식 문서나 공식 웹 문서에만 근거한다. 코드가 그렇게 동작하는지는 확인하지 않았다.
  - **[추론]** 위 근거에서 해석한 내용이다.
- OpenClaw와 Hermes는 문서가 매우 상세하고 UI 코드가 크다. 화면 목록은 라우트·내비게이션 소스로 확인했고, 화면별 세부 동작은 주로 저장소 문서에서 읽었다.

## 핵심 판단

1. **OpenClaw Control UI가 가장 넓은 운영자 UI다.** 대화, 하위 실행 패널, 백그라운드 프로세스 패널, 자동화(cron) 표와 실행 이력, 승인 이력, 사용량 분석, 로그·디버그, agent별 파일·skill·기억 탭이 한 앱에 있다. 단일 사용자 도구보다 "여러 agent를 가진 한 gateway의 관리 화면"에 가깝다.
2. **Hermes 웹 dashboard는 관리 화면, 대화는 TUI 그대로다.** 대화 탭은 브라우저 안에서 실제 TUI를 PTY로 띄운다. 웹에는 세션 목록·검색, 분석, cron, profile, skill, 채널, 시스템 작업 화면이 있다. 다중 작업자 관찰은 Kanban plugin과 Desktop 앱이 맡는다.
3. **Grok Bot은 "주의가 필요한 것"을 중심으로 화면을 짠다.** 사이드바가 `Needs attention`(질문·승인·handoff), 읽지 않은 결과, 작업 중을 구분하고, 승인·질문·초안이 transcript 안 카드로 나타난다. 내부 구현은 공개되지 않았다.
4. **자동 연구 시스템의 UI는 대부분 실행 후 열람용이다.** AI Scientist-v2는 실험 tree를 HTML로 내보내고, R&D-Agent는 루프별 가설·실험·피드백과 지표 추이를 보여 준다. R&D-Agent에는 사람이 가설 후보를 고르거나 고쳐 쓰는 별도 화면이 있다. 이 화면이 이번 대상 중 **연구 노드 단위 사용자 개입**에 가장 가깝다.
5. **[추론] Paperclip에서 흔하지 않으면서 BaboJUBot에 쓸모가 큰 것**은 다음 다섯 가지다. 주의 필요 상태의 분리, 실행 시도 요약(recap)과 근거 상태 표시, 외부 job·하위 실행 패널, 조직 범위를 항상 드러내는 쓰기 대상 표시, 연구 지도 노드에 실험 시도·지표·실패를 붙인 상세 패널. 자세한 제안은 [6절](#6-babojubot이-고려할-기능--설계-제안-결정-아님)에 있다.

## 1. OpenClaw Control UI

Gateway가 직접 제공하는 Vite + Lit SPA이며, 같은 포트의 gateway WebSocket과만 통신한다. 문서는 이 화면을 공개하면 안 되는 **관리자 화면**(대화, 설정, 실행 승인)으로 규정한다. **[문서]** [control-ui.md L11-L23](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui.md#L11-L23), [dashboard.md](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/dashboard.md)

### 1.1 화면 목록

**[소스]** 라우트 트리에는 40개 안팎의 페이지가 있다. 사이드바 기본 항목은 `agents-home`, `dashboards`, `usage`, `cron`, `sessions`, `systems`, `activity`, `meetings`, `plugins`, `apps`, `portals`이다. 설정 화면은 Connections, Agents & Tools, Security(`security`, `secrets`, `approvals`), System(`logs`, `debug` 등)으로 묶인다. [app-routes.ts L27-L127](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/ui/src/app-routes.ts#L27-L127), [app-navigation.ts L20-L32, L159-L187](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/ui/src/app-navigation.ts#L20-L187)

| 화면 | 보여 주는 것 | 사용자 행동 | 근거 |
|---|---|---|---|
| Agents home (`/agents`) | agent별 카드: 정체성, 모델, 현재 작업 상태, 마지막 활동, 주 대화 미리보기. 작업 중인 agent가 먼저 | Open chat, Manage agents, New agent | **[문서]** [control-ui.md L286-L296](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui.md#L286-L296) |
| New agent(custodian 대화) | chief of staff, researcher, writer, reviewer 또는 네 명 팀을 추천 | 역할 선택이나 직접 서술. **생성은 운영자 승인을 기다린다.** 팀 생성이 중간에 멈추면 이미 만든 agent를 보고한다 | **[문서]** [control-ui.md L195-L217](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui.md#L195-L217) |
| Chat | 스트리밍 답변, 도구 호출 카드(명령·diff·연산 개수 요약), 실패·차단 강조, 실행 오류 배너와 Details | 전송, 중단(`chat.abort`), 모델·thinking 변경, 제안된 후속 작업 시작 | **[문서]** [feature-reference.md L18-L37](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui/feature-reference.md#L18-L37) |
| Subagents 패널 | 실행 중·종료된 자식 실행, 경과 시간, 공개 도구 진행, 호출 수, 집계 진행(swarm) | 자식의 읽기 전용 transcript를 부모 옆에 연다 | **[문서]** [control-ui.md L147-L167](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui.md#L147-L167) |
| Processes 패널 | 대화가 띄운 백그라운드 exec 명령의 상태·경과 시간·최근 출력 | **그 프로세스만** Stop | **[문서]** [control-ui.md L169-L176](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui.md#L169-L176) |
| Sessions(Threads) | agent별 세션 목록, 그룹(직접 지정·채널·종류·agent·날짜) | 고정, 이름 변경, 보관·복원, snooze, 세션별 모델·thinking·trace 설정 | **[문서]** [feature-reference.md L43-L45](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui/feature-reference.md#L43-L45) |
| Activity | 일별 세션 피드, 시간대별 막대(pulse), **세션별 1~3문장 recap**, Live activity(실행·대기 세션과 도구 스트림), Run inspector | 검색, 시간·사람 필터, Retry recap, Inspect run | **[문서]** [settings.md L646-L686](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui/settings.md#L646-L686) |
| Automations(`cron`) | 상단 통계(자동화 수, 실패 수, scheduler 상태, 다음 깨우기), 자동화 표, 전체 실행 이력 | 생성(시작 예시 prefill), 일시정지·재개, Run now, 복제, 삭제, 실행별 transcript 열기 | **[문서]** [feature-reference.md L53, L131-L151](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui/feature-reference.md#L53-L151), [chat.md L941-L955](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui/chat.md#L941-L955) |
| Approvals(설정) | 실행 허용 목록과 ask 정책, 최근 30일 해결된 승인 이력(결정, 사유, 출처 세션, 결정자) | 정책 편집, 종류별 필터 | **[문서]** [feature-reference.md L59, L68](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui/feature-reference.md#L59-L68) |
| 단독 승인·질문 페이지 | 승인 하나 또는 대기 질문 하나 | Allow once / Always allow / Deny. 다른 곳에서 이미 결정했으면 "resolved elsewhere" 표시 | **[소스]** [approval-page.tsx L22-L48](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/ui/src/pages/approval/approval-page.tsx#L22-L48), [question-page.tsx](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/ui/src/pages/question/question-page.tsx) |
| Settings → Agents | agent 기본값과 agent별 탭(Overview, Files, Tools, Skills, Channels, Automations, Memory) | 이름·아이콘·모델·fallback 순서 편집. Files 탭은 workspace 파일을 편집 | **[문서]** [feature-reference.md L76](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui/feature-reference.md#L76) |
| Memory 탭 | dreaming 상태, Dream Diary. `memory-wiki` plugin을 켜면 종합·개체·개념 페이지와 **주장, 열린 질문, 모순** | 켜기·끄기, 다른 도구의 기억 가져오기(plan → apply) | **[문서]** [feature-reference.md L46-L48](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui/feature-reference.md#L46-L48) |
| Usage | 세션 기반 토큰·추정 비용(provider 청구와 분리), 일별·시간별 차트, 세션 타임라인 구간 선택, system prompt 구성 분석, provider 카드(요금제·한도·잔액) | provider·모델·채널·도구 필터, CSV·JSON 내보내기 | **[문서]** [feature-reference.md L95-L116](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui/feature-reference.md#L95-L116) |
| Channels | 내장·plugin 채널 상태, QR 로그인, 채널별 설정 | 설정 저장 후 카드 자동 갱신 | **[문서]** [feature-reference.md L41-L42](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui/feature-reference.md#L41-L42) |
| Logs, Debug, Systems | gateway 로그 live tail, 상태·health 스냅샷, 명령 lane과 heartbeat, 이벤트 로그, 호스트 CPU·메모리·디스크 그래프 | 필터·내보내기, 수동 RPC 호출, Update | **[문서]** [feature-reference.md L119-L128](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui/feature-reference.md#L119-L128) |
| Session dashboards | 대화(thread)마다 agent가 만드는 위젯 격자. 텍스트·지표·표·차트의 native report 또는 sandbox HTML | 위젯 고정·이동·크기 조절, 탭, 위젯 권한 승인 | **[문서]** [dashboards.md L92-L130, L361-L400](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/dashboards.md#L92-L400) |
| Workboard(선택 plugin) | Kanban 카드(`triage`~`done`), 카드와 task·실행·세션의 연결, 규칙 기반 Sessions board | 카드 생성·이동, 준비된 카드를 하위 실행으로 dispatch | **[문서]** [plugins/workboard.md L12-L20](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/plugins/workboard.md#L12-L20), [cli/workboard.md](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/cli/workboard.md) |

이 밖에 Terminal, Browser, 원격 Desktop 보기(PiP), Meetings(회의 기록·요약), Plugins·Skills 설치, Secrets, Devices 페어링이 있다. 연구 조직 대시보드와 관련이 적어 표에서 뺐다.

### 1.2 실시간 동작

- **[소스·문서]** 모든 데이터는 gateway WebSocket의 RPC와 이벤트로 온다. 이벤트 종류는 [상호작용 모델 조사](agent-interaction-models.md#4-관찰성-2)에 정리했다.
- **[문서]** 목록 갱신은 이벤트를 바로 반영하지 않고 4~5초의 무작위 창으로 모은 뒤 읽는다. 다음 자동 읽기는 직전 소요 시간의 3배(5~15초)를 기다린다. 숨은 탭에서는 멈췄다가 돌아오면 따라잡는다. [control-ui.md L347-L360](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui.md#L347-L360)
- **[소스]** 단독 승인 페이지는 2초 간격으로 상태를 다시 읽고, `operator.approvals` 범위가 있어야 결정할 수 있다. [approval-page.tsx L22-L24](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/ui/src/pages/approval/approval-page.tsx#L22-L24)
- **[문서]** Live activity는 페이지를 열어 둔 동안 받은 도구 이벤트만 보여 주며, 도구 인자 값은 저장하지 않고 개수만 기록한다. [settings.md L655, L672-L674](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui/settings.md#L655-L674)

### 1.3 눈에 띄는 UX

- **[문서] 실행 결과 접기:** 끝난 턴의 서술과 도구 활동을 "Worked for 2 minutes, 3 seconds · 2 failed"처럼 접는다. 실패는 접힌 상태에서도 보인다. 실행 중 도착한 메시지 때문에 건너뛴 도구 호출은 다시 불러와도 **Skipped**로 남는다. 다른 세션에서 온 메시지는 말풍선이 아니라 "updates from" 행으로 묶는다. [control-ui.md L107-L145](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui.md#L107-L145)
- **[문서] 자식 실패의 전파:** 읽지 않은 자식 실패는 조상 세션의 사이드바 행에 경고로 남는다. 부모가 이미 끝났어도 남고, 선택하면 자식을 열고 확인 처리한다. [control-ui.md L190-L193](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui.md#L190-L193)
- **[문서] 도구 진행 문구의 공개 범위:** 사이드바 진행 문구는 gateway가 공개로 표시한 진행 텍스트만 쓰고, 인자나 원시 명령 출력은 쓰지 않는다. [control-ui.md L78](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui.md#L78)
- **[문서] Run inspector의 근거 상태:** 실행 하나의 호출자, 대리 주체, 적용된 권한, lineage, 결정 영수증을 보여 준다. 모든 항목에 **absent / unattributed / unknown / unsupported** 같은 근거 상태를 붙인다. 문서는 감사 기록이 best-effort이며 기록이 없다고 행동이 없었다는 증거는 아니라고 명시한다. [settings.md L656, L676-L686](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui/settings.md#L656-L686)
- **[문서] Recap:** 세션마다 utility model로 "무엇을 했고 어디까지 왔는지"를 1~3문장으로 갱신한다. 동시 호출 두 개, 재시도 세 번으로 제한하고, idle 세션에는 반복 호출하지 않는다. [settings.md L652, L660-L662](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui/settings.md#L652-L662)
- **[문서] 승인 링크:** 알림의 승인 링크는 승인을 **식별할 뿐 허가하지 않는다**. 여는 데 일반 gateway 인증이 필요하고, URL에 자격 증명을 넣지 않는다. [security-model.md L165-L172](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui/security-model.md#L165-L172)
- **[소스] agent 파일 편집의 충돌 검사:** Files 탭이 편집할 수 있는 파일은 `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`, `MEMORY.md`로 한정된다. 저장 때 `expectedHash`가 현재 파일 hash와 다르면 충돌로 거부한다. [workspace-bootstrap-policy.ts L29-L36](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/agents/workspace-bootstrap-policy.ts#L29-L36), [agents-files.ts L52, L410-L426](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/src/gateway/server-methods/agents-files.ts#L52-L426)
- **[문서] 설정 쓰기 보호:** 설정 저장에 base-hash guard가 있다. 검증에 실패하면 "Settings not applied"와 사유를 보여 주고, 초안은 그대로 남긴다. [feature-reference.md L84-L86](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/control-ui/feature-reference.md#L84-L86)
- **[문서] agent가 만드는 대시보드와 권한:** 렌더링만 하는 위젯은 승인 없이 뜨고 네트워크가 막힌다. 네트워크, gateway 데이터 읽기, cron 실행, 대화로 메시지 보내기를 원하는 위젯은 권한을 선언해야 한다. 승인은 **승인한 위젯 바이트에 묶이며**, 내용이 바뀌면 다시 결정한다. [dashboards.md L361-L400](https://github.com/openclaw/openclaw/blob/80f170ea263a21187384cb67d5aead87b1d01fc2/docs/web/dashboards.md#L361-L400)

## 2. Hermes Agent

Hermes에는 운영자 화면이 셋 있다. 웹 dashboard(`hermes dashboard`, FastAPI + React), 터미널 TUI, Electron Desktop 앱이다. Kanban 보드는 dashboard plugin으로 들어간다. **[문서]** [web/README.md](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/web/README.md), [web-dashboard.md](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/web-dashboard.md)

### 2.1 웹 dashboard

**[소스]** 내장 라우트는 `/chat`, `/sessions`, `/files`, `/analytics`, `/models`, `/logs`, `/cron`, `/skills`, `/plugins`, `/mcp`, `/pairing`, `/channels`, `/webhooks`, `/system`, `/profiles`, `/config`, `/env`, `/docs`이다. `/`는 `/sessions`로 보낸다. [App.tsx L129-L178](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/web/src/App.tsx#L129-L178)

| 화면 | 보여 주는 것 | 사용자 행동 | 근거 |
|---|---|---|---|
| 상태 개요 | 버전, gateway 실행 상태·PID·연결 플랫폼, 최근 5분 활성 세션 수, 최근 세션 20개(모델·메시지 수·토큰) | 5초마다 자동 갱신 | **[문서]** [web-dashboard.md L109-L118](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/web-dashboard.md#L109-L118) |
| 자원 압박 배너 | 메모리·디스크 부족, 메모리 부족으로 인한 예기치 않은 재시작 의심 | 닫기(gateway 재기동이나 심각도 상승 시 다시 표시) | **[문서]** [web-dashboard.md L120-L138](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/web-dashboard.md#L120-L138) |
| Chat | 실제 `hermes --tui`를 PTY로 띄워 xterm.js로 그린다. 승인·질문 prompt도 TUI 그대로. 오른쪽 rail에 세션 목록·모델·workspace 선택 | 세션 재개(`/chat?resume=<id>`) | **[문서]** [web-dashboard.md L140-L166](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/web-dashboard.md#L140-L166) |
| Sessions | 제목, 출처 플랫폼(CLI·Telegram·cron 등), 모델, 메시지·도구 호출 수, 진행 중 표시, 통계 막대. 펼치면 역할별 메시지와 접힌 도구 호출(JSON 인자) | Chats / Automation / All 필터, **FTS5 전문 검색**, 이름 변경, JSON 내보내기, 오래된 세션 정리, 삭제 | **[문서]** [web-dashboard.md L276-L290](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/web-dashboard.md#L276-L290) |
| Logs | agent·errors·gateway 로그, 수준·구성 요소 필터 | 5초 polling tail 켜기·끄기 | **[문서]** [web-dashboard.md L292-L301](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/web-dashboard.md#L292-L301), **[소스]** [LogsPage.tsx L156](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/web/src/pages/LogsPage.tsx#L156) |
| Analytics | 7·30·90일 토큰(입력·출력), cache hit 비율, 추정 또는 실제 비용, 일별 차트와 표, 모델별 분해 | 기간 선택 | **[문서]** [web-dashboard.md L303-L310](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/web-dashboard.md#L303-L310) |
| Cron | 작업별 이름, prompt 미리보기, cron 식, 상태(enabled/paused/error), 전달 대상, 마지막·다음 실행 | 생성, 일시정지·재개, 편집, Trigger now, 삭제 | **[문서]** [web-dashboard.md L312-L321](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/web-dashboard.md#L312-L321) |
| Profiles | 격리된 Hermes 인스턴스별 모델·skill 수·gateway 상태·설명 | 생성(복제 옵션), **SOUL 인라인 편집**, 모델·설명 편집, 기본 profile 지정 | **[문서]** [web-dashboard.md L323-L332](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/web-dashboard.md#L323-L332) |
| Skills | 설치된 skill·toolset, 범주 | 켜기·끄기(다음 세션부터), hub 검색·설치(설치 로그 실시간) | **[문서]** [web-dashboard.md L334-L344](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/web-dashboard.md#L334-L344) |
| Config, API Keys | `config.yaml`의 150개 이상 필드를 스키마에서 자동 생성한 form. 승인 모드(smart/manual/off) 포함. `.env` 키는 설정 여부와 가린 값 | 저장, 기본값 복원, JSON 내보내기·가져오기 | **[문서]** [web-dashboard.md L229-L274](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/web-dashboard.md#L229-L274) |
| Channels, Pairing, Webhooks | 메신저별 연결 상태와 설정 form, 대기 중인 사용자 페어링 요청 | 설정, 켜기·끄기, **Test**, gateway 재시작, 페어링 승인·취소 | **[문서]** [web-dashboard.md L366-L404](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/web-dashboard.md#L366-L404) |
| System | 호스트 상태, skill curator, gateway 시작·중지, 기억 provider 선택과 `MEMORY.md`·`USER.md` 초기화, 운영 작업(doctor, 백업, system prompt 크기 분해) | 각 작업을 백그라운드로 실행하고 로그를 실시간으로 본다 | **[문서]** [web-dashboard.md L406-L425](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/web-dashboard.md#L406-L425) |

**[문서] 쓰기 대상의 명시:** dashboard 하나가 기계의 모든 profile을 관리한다. 사이드바의 profile 선택이 Config·Keys·Skills·Chat의 대상을 정한다. 대시보드 자신이 아닌 profile을 고르면 **호박색 배너가 쓰기 대상 profile을 표시**한다. 선택은 URL(`?profile=`)에 남는다. [web-dashboard.md L44-L90](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/web-dashboard.md#L44-L90)

**[소스·문서] 문서와 코드의 차이:** 문서와 `web/README.md`는 `StatusPage`를 첫 화면으로 설명한다. 고정 commit에는 `StatusPage.tsx`가 없고 `/`가 `/sessions`로 이동한다. Sessions 화면이 `getStatus()`를 5초마다 읽는다. **[추론]** 상태 개요가 Sessions 화면으로 합쳐진 것으로 보인다. [SessionsPage.tsx L1058-L1086](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/web/src/pages/SessionsPage.tsx#L1058-L1086)

### 2.2 Kanban plugin

**[문서]** dashboard plugin(`plugins/kanban/`)이 Kanban 탭을 추가한다. [kanban.md L767-L800](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/kanban.md#L767-L800), [plugin_api.py](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/plugins/kanban/dashboard/plugin_api.py)

- **열과 카드:** 상태별 열(`triage`, `todo`, `ready`, `running`, `blocked`, `done`)이 있다. 카드에는 우선순위, 담당 profile, 댓글·연결 수, 하위 작업 진행(`N/M`)이 붙는다. Running 열은 담당자별 lane으로 나눌 수 있다.
- **실시간:** 서버가 append-only `task_events` 테이블을 짧은 주기로 읽어 WebSocket으로 보낸다. 몰린 이벤트는 한 번의 다시 읽기로 합친다.
- **행동:** drag-drop 상태 변경(`done`·`archived`·`blocked`는 확인), 다중 선택과 일괄 변경, 작업 생성(skill, workspace, goal mode, 부모 작업 지정). Nudge dispatcher 버튼은 60초 tick을 기다리지 않게 한다.
- **카드 상세 drawer:** 제목·담당자·우선순위·설명 편집, 부모·자식 의존성 편집(순환은 서버가 거부), 결과, 댓글, 최근 이벤트 20개를 보여 준다. Triage 카드에는 LLM 기반 **Decompose**(하위 작업 그래프로 분해)와 **Specify**(작업 명세 재작성)가 있다.
- **Orchestration: Auto/Manual 토글:** Auto이면 dispatcher가 triage 작업을 자동 분해한다. Manual이면 사람이 버튼을 눌러야 한다. 문서는 Manual이 profile 스스로의 작업 생성까지 막지는 않는다고 경계를 밝힌다. [kanban.md L802-L820](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/kanban.md#L802-L820)
- **goal mode:** 작업자가 매 턴 뒤 judge의 완료 판정을 받는다. Worker log에 `turn N/M verdict=…` 줄이 남고, 예산이 끝나면 카드를 **blocked로 돌려 사람 검토**에 넘긴다. [kanban.md L718-L732](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/kanban.md#L718-L732)

### 2.3 Desktop 앱과 TUI 중 운영자 기능

- **[문서] 상태 표시줄:** 세션별 YOLO(위험 명령 승인 우회) 토글, 컨텍스트 사용률. 사용률을 누르면 system prompt·도구 정의·skill·기억·대화별 토큰 분해가 나온다. cache hit 비율, 초당 토큰도 있다. [desktop.md L63-L72](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/desktop.md#L63-L72)
- **[문서] Live subagents:** composer 위에 위임된 작업자 수, 작업 이름, 경과 시간, 최근 활동을 띄운다. 작업자를 고르면 **Steer / Stop**이 나온다. Steer는 "checkpoint에서 반영되도록 대기열에 넣었다"는 뜻일 뿐 자식이 이미 읽었다는 뜻이 아니라고 문서가 밝힌다. [desktop.md L163-L165](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/desktop.md#L163-L165)
- **[문서] Artifacts 보기:** 세션들이 만든 이미지·파일·링크를 한 갤러리에 모은다. 각 항목에서 만든 세션으로 이동할 수 있다. [desktop.md L116-L122](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/desktop.md#L116-L122)
- **[문서] 기억 보기(Memory Graph·Learning Journey):** 학습한 skill과 기억을 시간축 node graph로 보여 주고 재생할 수 있다. 패널에서 node를 고치거나 지운다(skill은 보관, 기억은 삭제). [desktop.md L174-L176](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/desktop.md#L174-L176), [memory.md L245-L260](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/memory.md#L245-L260)
- **[문서] Bot Mode:** profile마다 avatar가 있는 bot 하나로 보여 주고, bot별 대화와 Routines(cron)를 둔다. 여러 bot의 그룹 대화방에는 "needs you" 배지가 붙는다. [desktop.md L286-L340](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/desktop.md#L286-L340)
- **[문서] Heartbeat와 cron의 구분:** `/heartbeat`는 현재 세션이 idle일 때 같은 대화에 정해진 prompt를 넣는다(세션당 하나, 턴 사이에만). cron은 매번 새 격리 세션이다. 문서가 둘을 표로 비교한다. [heartbeat.md L7-L28](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/website/docs/user-guide/features/heartbeat.md#L7-L28)

## 3. xAI Grok Bot (공식 문서만, 내부 비공개)

모든 내용이 **[문서]** 이다. 화면을 직접 보지 않았고, 문서에 없는 기능을 없다고 단정하지 않는다. 기존 [상호작용 모델 조사](agent-interaction-models.md#grok-bot-사용자가-지칭한-정식-제품)에 정리한 대화·전달 의미는 반복하지 않는다.

| 영역 | 관찰 가능한 기능 | 근거 |
|---|---|---|
| 사이드바 | Bot 목록, 고정(Pin), 숨기기(숨겨도 Bot과 routine은 멈추지 않음), Marketplace. 상태는 **Needs attention**(질문·승인·handoff), **Unread activity**(새 결과), 작업 중·입력 중으로 나뉜다 | [bots](https://docs.x.ai/grok-bot/bots), [settings-and-notifications](https://docs.x.ai/grok-bot/settings-and-notifications) |
| 대화 transcript | 도구 활동, computer use, 생성 파일, 질문, 승인 요청, 음성 메모를 일반 메시지와 함께 표시. 이메일·Slack 초안은 편집 가능한 카드(Send / Discard). Bot 간 handoff도 대화에 보인다. "Stop now"는 즉시 멈추지만 끝난 행동을 되돌리지 않는다 | [chat-and-collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration) |
| 승인 | 승인 카드가 제안된 작업과 입력(로컬 실행이면 정확한 명령)을 보여 준다. Allow once / Always allow(규칙 저장) / Deny. 독립 검토 모델인 **Auto Review**가 위험한 행동을 통과·승인 요구·거부로 나눈다. 사용자 규칙은 "Ask first"가 "Allow automatically"보다 우선한다 | [security](https://docs.x.ai/grok-bot/security) |
| 컴퓨터 보기 | 대화에서 공유 데스크톱을 열면 클릭·입력·이동과 현재 상태를 보여 준다. 비밀번호·2FA·CAPTCHA는 사용자가 **제어를 넘겨받아 그 단계만** 하고 계속하라고 Bot에 알린다 | [computer-and-apps](https://docs.x.ai/grok-bot/computer-and-apps) |
| Skill·Routine | 작업을 녹화해 skill 초안을 만드는 "Teach a task"(최대 10분, 사용자가 초안 검토). Routine은 Bot에게 말로 만들게 하고, Bot이 다음 실행 시각을 보여 준다. 대화 상세 → Routines에서 routine별 최근 실행 20개의 성공·실패, 켜기·일시정지, **Test run**, 일정·지시 편집, 삭제. 오래 응답하지 않으면 무인 routine이 일시정지될 수 있다 | [skills-routines-and-automations](https://docs.x.ai/grok-bot/skills-routines-and-automations) |
| Bot 설정 | 이름, label, 설명, avatar, Bot별 알림 토글. 별도 persona·모델 필드는 문서에 없고, 지켜야 할 규칙은 설명란에 쓰라고 권한다. 기억은 유지되지만 **기억을 보거나 편집하는 화면은 문서에 없다** | [bots](https://docs.x.ai/grok-bot/bots), [settings-and-notifications](https://docs.x.ai/grok-bot/settings-and-notifications) |
| 사용량·감사 | Usage & Billing에 주간 포함 사용량과 on-demand 사용량. Enterprise 관리 콘솔에 감사 로그, Action Recording(기본 꺼짐, 90일), OpenTelemetry 내보내기, 네트워크 정책, Auto Review 강제가 있다 | [settings-and-notifications](https://docs.x.ai/grok-bot/settings-and-notifications), [security](https://docs.x.ai/grok-bot/security) |

## 4. 자동 연구 시스템의 연구 진행 시각화

### 4.1 Sakana AI Scientist-v2: 실험 tree의 HTML 내보내기

- **[소스]** 단계마다 `Journal`의 node tree를 `tree_data.json`과 p5.js HTML로 내보내고, 완료된 단계들을 탭으로 묶은 `unified_tree_viz.html`도 만든다. [tree_export.py L76-L360, L414-L460](https://github.com/SakanaAI/AI-Scientist-v2/blob/96bd51617cfdbb494a9fc283af00fe090edfae48/ai_scientist/treesearch/utils/tree_export.py#L76-L460)
- **[소스]** node마다 내보내는 데이터는 plan, code, 지표(이름, 최소화·최대화, 데이터셋별 값), 예외 종류·stack, 그림과 그림 분석, VLM 피드백 요약, 실행 시간, ablation·hyperparameter 이름, seed node 여부, best node 여부다.
- **[소스]** 화면에서 node를 누르면 오른쪽 패널에 위 데이터가 구문 강조와 지표 표로 나온다. 단계 탭 이름은 Preliminary Investigation, Baseline Tuning, Research Agenda Execution, Ablation Studies이다. [template.js L330-L340, L363-L371, L478-L583](https://github.com/SakanaAI/AI-Scientist-v2/blob/96bd51617cfdbb494a9fc283af00fe090edfae48/ai_scientist/treesearch/utils/viz_templates/template.js#L330-L583)
- **[추론]** 정적 파일이라 실시간 갱신이나 사용자 행동은 없다. "가설 하나에 여러 시도가 가지를 치고, 시도마다 계획·코드·지표·실패가 붙는다"는 구조가 연구 지도의 실험 노드 상세에 그대로 대응한다.

### 4.2 Microsoft R&D-Agent: 루프 추적 UI와 사용자 개입 portal

- **[소스] Streamlit 추적 화면(`rdagent ui`):**
  - 상단 Summary에 루프별 지표 추이 차트가 있다. **가설 표**는 가설, 근거, 관찰, 얻은 지식 열을 가지며, 결정(성공·실패)에 따라 행 색을 바꾼다. "successful hypotheses"만 보는 토글이 있다. [app.py L327-L360, L424-L470](https://github.com/microsoft/RD-Agent/blob/484776c211e4fbbeef03e0ec00d6bbee7362a4f4/rdagent/log/ui/app.py#L327-L470)
  - 루프를 고르면 Research(가설·이유), Development(코딩 반복별 피드백), Feedback(실행 결과, 설정, 결정) 절이 이어진다. 사이드바 Control Panel에는 로그 폴더 선택, All Loops, Next Loop, Next Step, debug 토글이 있다. **[추론]** 이 버튼들은 기록된 로그를 단계별로 재생하는 것으로 읽힌다. [app.py L550-L640, L746-L800](https://github.com/microsoft/RD-Agent/blob/484776c211e4fbbeef03e0ec00d6bbee7362a4f4/rdagent/log/ui/app.py#L550-L800)
  - data science 화면은 루프마다 Exp Gen(가설, 대기 작업, workspace), Coding, Running, Feedback, SOTA Experiment, LLM 호출 기록을 보여 준다. LLM 호출은 렌더링된 prompt, template, 맥락 탭으로 나뉜다. [ds_trace.py L395-L603](https://github.com/microsoft/RD-Agent/blob/484776c211e4fbbeef03e0ec00d6bbee7362a4f4/rdagent/log/ui/ds_trace.py#L395-L603)
- **[소스] User Interaction Portal(`ds_user_interact`):** 실행 중인 연구가 결정을 기다리면 화면에 대기 세션이 나타난다. 화면은 1초마다 갱신된다. [ds_user_interact.py L20-L168](https://github.com/microsoft/RD-Agent/blob/484776c211e4fbbeef03e0ec00d6bbee7362a4f4/rdagent/log/ui/ds_user_interact.py#L20-L168)
  - 사용자가 보는 것: 시나리오 설명, 이전 시도 요약, 현재 SOTA 코드, 가설 후보 탭(선택된 후보에 ✅).
  - 사용자 행동: 목표 가설과 작업 설명을 고쳐 쓰고, 이전 사용자 지시를 수정·삭제하거나 새 지시를 더한 뒤 Submit한다. 또는 **Approve without changes**를 누른다. 바뀐 내용이 있으면 `rewrite`, 없으면 `confirm`으로 기록된다.
  - 세션마다 만료 시각이 있고 "Extend expiration by 60s" 버튼이 있다. 만료된 세션 파일은 삭제된다. **[추론]** 사용자가 늦으면 결정 기회가 사라지는 구조다. 영속 승인 객체와는 반대다.
- **[문서]** 별도 Vue 웹 UI(`rdagent server_ui`)도 있다. README는 실시간 상호작용과 추적 보기를 제공하며 data science 시나리오는 아직 지원하지 않는다고 적는다. 컴포넌트 이름(`research.vue`, `development.vue`, `feedback.vue`, `loop-component.vue`)이 같은 루프 구조를 따른다. 내용은 읽지 않았다. [README.md](https://github.com/microsoft/RD-Agent/blob/484776c211e4fbbeef03e0ec00d6bbee7362a4f4/README.md), [web/src/components](https://github.com/microsoft/RD-Agent/tree/484776c211e4fbbeef03e0ec00d6bbee7362a4f4/web/src/components)

### 4.3 HKUDS AI-Researcher와 Agent Laboratory: 로그 보기와 논문 저장소

- **[소스] AI-Researcher Gradio GUI:** 질문·참고 자료·모드를 입력하고 실행한다. "Conversation Record" 탭은 **로그 파일을 줄 단위로 파싱해** 대화 말풍선으로 만들며, 허용된 도구(`execute_command`, `run_python` 등)의 호출만 보여 준다. 3초 자동 갱신 토글, 연구 로그·논문 내려받기 버튼, 환경 변수(API key) 관리 탭이 있다. [web_ai_researcher.py L191-L260, L1403-L1524, L1627-L1631](https://github.com/HKUDS/AI-Researcher/blob/f9a6f8480860c193afff600eeffe3defcee8a978/web_ai_researcher.py#L191-L1631)
- **[소스] Agent Laboratory `app.py`:** 연구 진행 화면이 아니라 AgentRxiv용 Flask 논문 저장소다. 업로드, 검색, PDF 보기 기능이 있다. [app.py L64-L156](https://github.com/SamuelSchmidgall/AgentLaboratory/blob/d9017d90e329112d2a80b7712f37ee9094d2cd27/app.py#L64-L156)
- **[추론]** 둘 다 구조화된 이벤트가 아니라 로그나 결과 파일을 사후에 보여 준다. 참고할 UI 패턴은 적다.

### 4.4 Google AI co-scientist: UI는 비공개, 데이터 모델만 참고

- **[문서]** 논문은 과학자가 "designated user interface"에서 자연어로 목표·제약·피드백을 주고 자기 가설을 넣을 수 있다고만 말한다. 화면 구성은 공개하지 않았다.
- **[문서]** 화면에 올릴 만한 산출물로 다음을 서술한다. Elo tournament 순위, 비슷한 가설을 묶고 중복을 줄이는 **proximity graph**, 상위 가설과 리뷰를 종합한 research overview(§3). [arXiv 2502.18864v1](https://arxiv.org/abs/2502.18864v1)

## 5. 관심 축별 비교

| 축 | OpenClaw | Hermes | Grok Bot | 자동 연구 시스템 |
|---|---|---|---|---|
| agent와 대화 | 웹 대화, 스트리밍 도구 카드, 제안 작업 카드 | 웹은 TUI over PTY, Desktop은 네이티브 대화 | 앱 대화, 음성, 그룹 대화 | co-scientist 자연어 입력(문서). 나머지는 실행 전 입력만 |
| transcript 보기 | 세션별, 자동화 실행별 정확한 transcript, 자식 transcript 읽기 전용 | Sessions에서 펼쳐 보기, FTS 검색, JSON 내보내기 | 대화 안 도구·컴퓨터 활동 | 로그 파싱(AI-Researcher), LLM 호출 기록(R&D-Agent) |
| 승인 | 단독 승인 페이지, 30일 이력(결정자·사유), 정책 편집 | TUI prompt, 설정의 승인 모드, YOLO 토글 | 카드 3지선다, Auto Review, 규칙 | R&D-Agent의 가설 확인·재작성(만료 있음) |
| cron·heartbeat | 자동화 표, 통계, 실행 이력, 시작 예시 | Cron 페이지, `/heartbeat`는 대화 명령 | Routine 상세, 최근 20회, Test run | 없음 |
| skill·persona 편집 | agent Files 탭(`SOUL.md` 등, hash 충돌 검사), Skills 설치 | Profiles의 SOUL 편집, Skills 토글·hub | Bot 설명, Teach a task | 없음 |
| 기억 보기 | Memory 탭, Memory Wiki(주장·열린 질문·모순) | Memory Graph·Learning Journey(편집·삭제), 기억 초기화 | 보기 화면 없음(문서상) | Journal tree(실험 기억에 해당) |
| 비용·사용량 | 세션 기반 추정과 provider 청구 분리, 구간 분석, system prompt 분해 | Analytics, 컨텍스트 분해, cache hit | 주간 포함·on-demand 사용량 | 없음 |
| 채널 설정 | 채널 카드, QR 로그인 | Channels(Test·재시작), Pairing | Slack Team Bot, X 태그 | 없음 |
| 로그·진단 | Logs tail, Debug 이벤트, Run inspector | Logs, System 운영 작업, 자원 배너 | Enterprise 감사 로그 | 콘솔 로그 |
| 연구 진행 시각화 | 범용 위젯 대시보드 | Kanban 진행 `N/M` | 없음 | 실험 tree(AI Scientist-v2), 가설 표·지표 추이(R&D-Agent) |

## 6. BaboJUBot이 고려할 기능 — 설계 제안, 결정 아님

아래는 Paperclip 기준([Paperclip 1차 조사](paperclip.md)의 작업·승인·비용·활동 로그·실행 기록·routine)에서 **흔하지 않은** 기능만 골랐다. [제품 불변 조건](../../AGENTS.md)(조직 경계, 사용자 승인의 제품 강제, 관찰 가능한 상태만 공개)에 비추어 채택·변형·생략을 제안한다. 채택 여부는 해당 기능 이슈에서 정한다. 표의 판단은 모두 **[추론]** 이다.

### 6.1 주의·승인·사용자 할 일

| 기능 | 출처 | 제안 | 이유 |
|---|---|---|---|
| 사이드바에서 "주의 필요 / 읽지 않은 결과 / 작업 중"을 따로 표시 | Grok Bot, Hermes "needs you" | **채택** | 단일 사용자가 여러 조직을 볼 때 가장 먼저 필요한 정보다. 승인 요청과 사용자 할 일, Lead의 질문을 "주의 필요"로 모으고 조직 단위로 합산한다. |
| 승인 하나·질문 하나를 여는 고정 링크(식별만 하고 허가하지 않음), "다른 곳에서 이미 결정됨" 표시 | OpenClaw 단독 승인·질문 페이지 | **채택** | 다음 단계의 메신저 알림이 이 링크를 그대로 쓸 수 있다. 결정 권한은 일반 인증과 제품 규칙이 강제한다. |
| 승인 이력에 결정, 사유, 출처 실행 시도, 결정자를 남김 | OpenClaw Approvals 이력 | **채택** | 승인 요청은 연구 기록에 속한다. 사용자가 한 명이어도 결정 경로(대시보드·메신저)를 남긴다. |
| "Always allow"가 규칙을 만드는 3지선다 카드 | Grok Bot, OpenClaw | **변형** | "항상 허용"은 승인 정책 변경 제안으로 보여 주고 사용자가 확인한다. 정책은 사용자만 바꾼다는 GLOSSARY 규칙을 지킨다. |
| 독립 검토 모델의 자동 판정(Auto Review) | Grok Bot | **생략(초기)** | 조직별 승인 정책과 제품 강제가 먼저다. 자동 판정은 승인을 대신하지 않으며, 도입하더라도 판정 근거를 연구 기록에 남겨야 한다. |
| 만료되는 결정 세션 | R&D-Agent portal, Grok Bot의 Bot 간 승인 만료 | **생략** | 승인 요청은 영속 객체로 둔다는 [기존 제안](agent-interaction-models.md#babojubot에-주는-시사점--설계-제안-결정-아님)과 충돌한다. |
| 비밀번호·2FA 같은 단계를 사용자가 넘겨받아 처리 | Grok Bot 컴퓨터 보기 | **변형(후속)** | 사용자 할 일의 한 종류로 기록한다. 원격 화면 제어 자체는 연구 환경 설계 뒤에 판단한다. |

### 6.2 관찰: 실행 시도, 작업자, 외부 job

| 기능 | 출처 | 제안 | 이유 |
|---|---|---|---|
| 작업자 실행 패널: 실행 중·끝난 실행 시도, 경과 시간, 공개 진행 문구, 호출 수, 읽기 전용 transcript | OpenClaw Subagents, Hermes Live subagents | **채택** | Lead와 작업자의 실행 시도를 조직 화면에서 묶어 본다. 진행 문구는 실행 도구가 공개로 내보낸 값만 쓴다. |
| 하위 실패를 상위 행에 "읽지 않은 실패"로 남김 | OpenClaw | **채택** | 작업자 실패가 Lead 요약에 묻히지 않는다. 연구 노드·작업·조직 단위로 올린다. |
| 백그라운드 프로세스 패널: 상태, 경과 시간, 최근 출력, **그 job만** 중지 | OpenClaw Processes | **변형** | 외부 job 목록으로 바꾼다. 상태·비용·결과 링크와 시작한 에이전트를 함께 보여 준다. 중지는 제어 명령으로 기록한다. |
| 실행 결과 접기("Worked for … · N failed"), 건너뛴 호출 표시, 다른 에이전트 메시지는 별도 행 | OpenClaw | **채택** | transcript가 길어져도 실패와 주입 입력이 보인다. 실행 중 도착 입력의 처리 결과를 기록과 일치시킨다. |
| 실행 시도·작업별 1~3문장 recap | OpenClaw Activity | **변형** | 조직 개요와 메신저 요약에 유용하다. 다만 생성 요약이라 비용이 들고 오류가 있을 수 있다. "생성 요약" 표시, 갱신 시각, 원 기록 링크를 붙이고 결과로 취급하지 않는다. |
| 근거 상태를 표시하는 실행 검사기(absent / unknown / unsupported 구분) | OpenClaw Run inspector | **변형** | 연구 기록에 "값 없음"과 "기록 못 함"을 구분하는 습관이 필요하다. 처음에는 실행 시도 상세의 누락 표시 정도로 시작한다. |
| 컨텍스트 구성 분해(system prompt, 역할, skill, 기억, 대화별 토큰) | Hermes 상태 표시줄, OpenClaw Usage | **채택(실행 시도 상세)** | 실행 맥락 조립은 BaboJUBot 제품 코드의 책임이다. 무엇을 넣었는지 보여 주면 맥락 선택 문제를 진단할 수 있다. |
| 추정 비용과 provider 청구를 분리해 표시 | OpenClaw Usage | **채택** | [Paperclip 조사](paperclip.md#6-비용-제한은-기록가격실행-중-작업의-영향을-받는다)가 지적한 "추정은 청구 상한이 아니다"를 화면에서도 드러낸다. |
| 호스트 자원 압박 배너(메모리·디스크, 비정상 재시작 의심) | Hermes | **채택** | self-host 단일 기계에서 장시간 연구와 외부 job을 돌리면 자원 문제가 흔하다. |
| 전문 검색(FTS)으로 모든 메시지·기록 검색 | Hermes Sessions | **채택** | 조직 범위 안에서만 검색한다. 조직 간 검색은 명시적 공유 대상만 허용한다. |

### 6.3 조직 범위, 구성원, 설정

| 기능 | 출처 | 제안 | 이유 |
|---|---|---|---|
| 현재 쓰기 대상 범위를 항상 표시하고 URL에 남김(다른 범위면 경고 배너) | Hermes profile 선택과 호박색 배너 | **채택** | 조직 경계 불변 조건을 UI에서도 지킨다. 모든 쓰기 화면에 조직 ID를 드러내고, 서버가 같은 범위를 다시 검사한다. |
| 역할·성격 파일 편집기(허용 파일 목록, hash 충돌 검사) | OpenClaw Files 탭, Hermes SOUL 편집 | **변형** | ROLE.md/SOUL.md 형식이 정해지면 쓴다. 사용자 편집은 깨우기를 만들고 revision을 남긴다. 변경 권한은 해당 이슈에서 정한다. |
| 역할 템플릿으로 팀을 제안하고 운영자 승인 뒤 생성. 중간 실패 시 이미 만든 구성원을 보고 | OpenClaw custodian | **변형** | 팀 구성 승인 화면의 참고로 쓴다. 생성 주체는 Lead이고, 승인 객체가 강제한다. |
| 설정 form을 스키마에서 생성, base-hash guard, 적용 실패 사유와 초안 보존 | OpenClaw Settings, Hermes Config | **채택** | 승인 정책과 예산 편집은 사용자만 한다. 동시 편집과 검증 실패를 명확히 보여 줘야 한다. |
| 채널 설정 카드의 연결 상태·Test·재시작 | Hermes Channels, OpenClaw Channels | **변형(메신저 단계)** | 메신저가 들어오는 후속 단계에서 쓴다. 지금은 화면 자리만 고려한다. |
| 단순·고급 화면 모드 | Hermes Desktop | **생략(초기)** | 대상 사용자가 한 명이고 화면 수가 아직 적다. |

### 6.4 일정 실행

| 기능 | 출처 | 제안 | 이유 |
|---|---|---|---|
| heartbeat와 일정 작업의 구분을 화면에 표시 | Hermes 문서 비교표 | **채택** | GLOSSARY의 Heartbeat는 에이전트별 주기적 깨우기다. 정기 연구 감시 같은 일정 작업이 생기면 둘을 섞지 않는다. |
| 일정마다 최근 실행 기록과 **정확한 실행 시도의 transcript**, Test run, 다음 실행 시각 | Grok Bot Routines, OpenClaw Automations | **채택** | Heartbeat가 만든 실행 시도도 이력에서 바로 연다. "켜기 전 시험 실행"은 비용이 드는 정기 실행에 유용하다. |
| 오래 응답이 없으면 무인 일정 작업을 일시정지 | Grok Bot | **변형** | 승인 대기가 쌓이거나 예산 경고가 오래 무시되면 해당 조직의 heartbeat를 멈추는 정책 후보다. 정책 기본값은 사용자가 정한다. |

### 6.5 연구 진행 시각화

| 기능 | 출처 | 제안 | 이유 |
|---|---|---|---|
| 노드를 누르면 계획·코드·지표·실패·그림을 보여 주는 상세 패널, best node 강조, 단계 탭 | AI Scientist-v2 tree | **채택(연구 지도)** | 실험·검증 노드에 실행 시도와 산출물을 연결해 보여 준다. 단계 탭 대신 연구 흐름 템플릿의 노드 종류를 쓴다. |
| 가설 표: 가설, 근거, 관찰, 얻은 지식, 결정(성공·실패), "확인된 것만" 필터 | R&D-Agent | **변형** | 연구 지도의 가설 노드 목록 보기로 쓴다. 결정은 Lead의 평가이며 사용자 최종 완료와 구분해 표시한다. |
| 반복(루프)별 지표 추이 차트 | R&D-Agent | **채택** | 같은 가설·문제 아래 실험들의 지표 변화를 본다. 지표 정의는 연구마다 다르므로 노드 메타데이터에서 읽는다. |
| 가설 후보를 사람이 고르거나 고쳐 쓰는 결정 화면(그대로 승인 / 재작성 / 지시 추가) | R&D-Agent portal | **변형** | 승인 정책이 "가설 선택 승인"을 요구하는 조직에서 쓰는 선택적 승인 요청 형태로 둔다. 만료는 두지 않는다. 사용자 메시지(피드백)와 승인 결정을 구분한다. |
| Decompose / Specify 버튼과 Auto/Manual 분해 토글 | Hermes Kanban | **변형** | 작업 분해는 Lead의 판단이다. 사용자 쪽에는 "이 작업의 분해를 Lead에게 요청"하는 사용자 메시지 정도만 두고, 자동 분해 여부는 승인 정책 항목 후보로 검토한다. |
| judge의 턴별 완료 판정 줄을 작업 로그에 남김 | Hermes goal mode | **변형** | 결과 검토·연구 반복에서 평가 결과와 근거를 기록하는 형식으로 참고한다. 판정은 확인된 결과가 아니다. |
| 기억 보기의 "주장 / 열린 질문 / 모순" 구분, 학습 기록 시간축과 수정·삭제 | OpenClaw Memory Wiki, Hermes Learning Journey | **보류** | 기억 기법·저장소는 별도 이슈에서 정한다. 화면 요구로만 기록한다. |
| 가설 순위(Elo)와 유사 가설 묶음(proximity graph) | co-scientist | **보류** | 연구 흐름 템플릿이 순위·군집을 요구할 때 보조 연결의 시각화로 검토한다. |
| agent가 만드는 위젯 대시보드(native report 우선, HTML은 sandbox와 바이트 단위 권한) | OpenClaw Session dashboards | **변형(후속)** | Lead가 조직 개요에 지표·표·차트 보고를 고정하는 기능으로 축소한다. 임의 HTML과 데이터 접근 권한은 초기에 두지 않는다. |
| 산출물 갤러리(만든 실행 시도·작업으로 이동) | Hermes Artifacts | **채택** | 산출물은 연구별로 보존·참조된다. 갤러리에서 결과가 아닌 산출물임을 구분해 표시한다. |
| 로그 파일을 파싱한 대화 보기 | AI-Researcher | **생략** | BaboJUBot은 구조화된 이벤트를 저장하므로 로그 파싱이 필요 없다. |
| 회의 기록, 원격 데스크톱 PiP, 사람별 접속 표시 | OpenClaw | **생략** | 단일 사용자 연구 대시보드의 우선순위가 아니다. |

## 한계

- 화면을 실행해 보지 않았다. OpenClaw와 Hermes의 화면 설명은 대부분 저장소 문서에서 왔고, UI 소스로는 라우트·내비게이션·승인 페이지·agent 파일 편집·Hermes 일부 polling만 확인했다. 문서와 코드가 다를 수 있으며, Hermes 상태 페이지에서 한 건을 확인했다.
- OpenClaw는 문서 기준으로 매우 넓은 화면을 가진다. Plugins, Meetings, Terminal, Browser, Devices, Workboard의 세부는 연구 조직 대시보드와 관련이 적다고 보고 깊게 읽지 않았다.
- Hermes Desktop 앱의 소스(`apps/desktop`)와 TUI(`ui-tui`) 코드는 읽지 않았다. Desktop 내용은 문서만 근거다.
- Grok Bot은 공식 문서만 근거다. 문서에 날짜가 없고, 화면의 실제 배치와 실시간 갱신 방식은 확인할 수 없다.
- R&D-Agent는 Streamlit 화면 소스만 읽었다. Vue 웹 UI는 파일 이름만 확인했다. co-scientist의 UI는 공개되지 않았다.
- Paperclip 대시보드와의 대조는 기존 조사 문서 수준이다. 6절의 "Paperclip에서 흔하지 않음" 판단은 별도 Paperclip 대시보드 조사가 끝나면 다시 확인해야 한다.
