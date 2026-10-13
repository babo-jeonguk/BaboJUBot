# PaperclipAI 웹 대시보드 기능 전수 목록과 BaboJUBot 대응 제안

확인일: 2026-10-13. 사용자는 BaboJUBot 웹 대시보드에 PaperclipAI 대시보드 기능의 대부분을 가져오기를 원합니다. 이 문서는 Paperclip 웹 UI의 화면·패널·대화상자를 전수 목록으로 정리하고, 각 기능을 BaboJUBot [용어](../../GLOSSARY.md)와 [기능 범위](../features.md)에 맞춰 채택·조정·생략으로 분류합니다. 분류는 **설계 제안이며 결정이 아닙니다.**

[Paperclip 1차 조사](paperclip.md), [상호작용 모델 조사](agent-interaction-models.md)와 같은 commit [`1b4c803816e82b0265c8422e1a804327a7ed8c54`](https://github.com/paperclipai/paperclip/tree/1b4c803816e82b0265c8422e1a804327a7ed8c54)(2026-10-11 22:48 -07:00)에 고정했습니다. 아래 링크도 모두 이 commit을 가리킵니다.

## 조사 방법과 표기

- `/tmp/aim-research/paperclip`의 고정 commit clone을 정적으로 읽었습니다. 설치, 빌드, 실행, 화면 캡처는 하지 않았습니다.
- 읽은 순서:
  1. 라우터: [`ui/src/App.tsx`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/App.tsx)
  2. 셸과 사이드바: [`Layout.tsx`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/Layout.tsx), [`Sidebar.tsx`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/Sidebar.tsx)
  3. 페이지 디렉터리 [`ui/src/pages`](https://github.com/paperclipai/paperclip/tree/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages)
  4. UI가 호출하는 `ui/src/api/*` → `server/src/routes/*` → `packages/db/src/schema/*`
  5. 운영자 문서 [`docs/guides/board-operator`](https://github.com/paperclipai/paperclip/tree/1b4c803816e82b0265c8422e1a804327a7ed8c54/docs/guides/board-operator)
- 페이지가 154개, 컴포넌트가 548개라서 화면군 다섯 묶음을 병렬 하위 조사로 나눠 읽었습니다. 핵심 주장은 직접 다시 확인했습니다. 다시 확인한 항목은 라우트, 사이드바, 단축키, command palette, live event 종류, 승인 종류와 wake, 예산 incident, 에이전트 상세 탭, 실행 상세, 온보딩 단계, chat provider 목록입니다.
- 근거 표기:
  - **[소스]** 고정 commit 코드를 직접 읽었습니다.
  - **[문서]** 공식 문서에만 근거합니다.
  - **[추론]** 위 근거에서 해석했습니다.
  - 표의 사실 열은 [소스]이고, 별도 표기가 있는 곳만 다릅니다.
- 코드가 존재한다는 확인은 실제 화면이 그렇게 보이고 정상 동작한다는 확인이 아닙니다.

## 먼저 알아야 할 구조

**두 개의 셸.** 기본 셸은 "streamlined" [`Layout`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/Layout.tsx)입니다. 일부 페이지에는 legacy 셸용 `*.production.tsx` 변형이 있습니다. `enableStreamlinedUi`가 명시적으로 `false`일 때만 legacy 셸을 씁니다([`useStreamlinedUiEnabled`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/hooks/useStreamlinedUiEnabled.ts)). 이 문서는 streamlined 셸을 기준으로 하고, legacy에만 있는 화면은 따로 표시합니다.

**실험 플래그.** 많은 화면이 인스턴스 실험 설정 뒤에 숨어 있습니다([`InstanceExperimentalSettings`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/shared/src/types/instance.ts#L42)).
- 예: Agent Chat, Combined Inbox+Tasks, Decisions, Status cards, Cases, Pipelines, Conference Room, Chat connectors, Isolated workspaces, Built-in agents
- 공식 문서는 실험 기능에 호환성 보장이 없다고 적습니다([실험 기능 문서](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/docs/guides/board-operator/experimental-features.md)) [문서].
- 아래 표에는 플래그를 `⚑플래그명`으로 적습니다.

**URL과 회사 경계.** 모든 보드 라우트는 `/:companyPrefix/...` 아래에 있고, prefix가 없는 URL은 선택된 회사로 redirect됩니다([`App.tsx#L898`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/App.tsx#L898)). Paperclip의 company가 BaboJUBot의 연구 조직에 대응합니다.

**실시간 갱신**([`LiveUpdatesProvider`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/context/LiveUpdatesProvider.tsx), [서버 WebSocket](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/realtime/live-events-ws.ts#L99)):
- 회사마다 WebSocket 하나(`/api/companies/:id/events/ws`)를 엽니다.
- 이벤트 종류는 [`LIVE_EVENT_TYPES`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/shared/src/constants.ts#L942)로 정해져 있습니다.
  - `heartbeat.run.queued|status|progress|event|log`
  - `agent.status`
  - `activity.logged`
  - `agent.session.goal.changed`, `external_object.updated`
  - plugin 이벤트 3종
- 이벤트는 대부분 React Query 캐시를 무효화하는 신호로만 씁니다. 실행 로그와 이벤트 스트림은 실행 화면이 직접 소비합니다.
- 연결이 끊기면 15초 간격으로 전체를 다시 읽습니다. 재연결하거나 탭이 다시 보이면 활성 query를 모두 무효화합니다. 이벤트를 replay하지는 않습니다.
- 브라우저 탭 여러 개가 열려 있으면 탭 하나만 leader로 polling하고 결과를 나머지 탭에 broadcast합니다([`useSharedPolling`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/hooks/useSharedPolling.ts)).
- 토스트는 작업 생성·수정·댓글, 실행 상태, 에이전트 상태, 가입 요청에만 띄웁니다. 승인·예산·routine에는 토스트가 없습니다.

## 1. 전역 셸과 공통 UX

| 요소 | 내용 | 근거 |
|---|---|---|
| 사이드바 상단 | 회사 전환 메뉴(드래그 정렬, 조직 생성, 초대, 로그아웃) → New Task → Search → Dashboard(실행 중 run 수) → Inbox(unread 수, 실패 run이 있으면 빨간 배지). 플래그에 따라 Chat·Decisions·Status·Conference Room이 추가됩니다. | [`Sidebar.tsx#L130-205`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/Sidebar.tsx#L130-L205), [`SidebarCompanyMenu`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/SidebarCompanyMenu.tsx) |
| 사이드바 Work 묶음 | Tasks, Projects와 별표 프로젝트, Routines, Artifacts. 플래그에 따라 Cases·Pipelines·Goals·Workspaces가 추가됩니다. plugin slot도 있습니다. | [`Sidebar.tsx#L207-266`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/Sidebar.tsx#L207-L266) |
| 사이드바 Org 묶음 | Agents, Skills, Connectors, Audit. 그 아래 에이전트 목록(행에서 바로 일시정지·재개)과 Recent Tasks가 있습니다. legacy 셸에는 Org, Timeline, Costs, Activity, Settings가 있습니다. | [`Sidebar.tsx#L268-304`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/Sidebar.tsx#L268-L304), [`SidebarAgents`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/SidebarAgents.tsx) |
| Recent Tasks | 최근 작업 목록에서 이름 변경, inbox 보관, 하위 트리 일시정지(tree hold)를 할 수 있습니다. 재시작하면 hold를 풀고 담당 에이전트에 wakeup을 보냅니다. | [`SidebarRecentTasks.tsx#L140-240`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/SidebarRecentTasks.tsx#L140-L240) |
| 문맥 사이드바 | 에이전트·routine·skill·설정·앱 화면에서는 두 번째 사이드바가 열립니다. | [`Layout.tsx#L180-220`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/Layout.tsx#L180-L220) |
| 오른쪽 속성 패널 | 상세 화면의 속성 패널입니다. 크기 조절과 `]` 토글이 됩니다. | [`PropertiesPanel`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/PropertiesPanel.tsx) |
| Command palette | Cmd/Ctrl+K로 엽니다. 묶음: 전체 검색 바로가기, 빠른 필터(`assignee:me`, `is:open`, `updated:>7d`), 작업 생성·에이전트 생성·파일 열기, 페이지 이동, 작업·에이전트·프로젝트 결과 | [`CommandPalette.tsx#L112`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/CommandPalette.tsx#L112), [`search-query-parser.ts#L40-50`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/lib/search-query-parser.ts#L40-L50) |
| 단축키 | 아래 목록 참고. `?`로 단축키 표를 엽니다. | [`useKeyboardShortcuts`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/hooks/useKeyboardShortcuts.ts), [`KeyboardShortcutsCheatsheet`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/KeyboardShortcutsCheatsheet.tsx) |
| 생성 대화상자 | New Task(초안 자동 저장, 담당자·모델·검토자·승인자·감시자·프로젝트·워크스페이스·비공개·첨부), New Project, New Goal, New Agent | [`Layout.tsx#L748-751`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/Layout.tsx#L748-L751), [`NewIssueDialog`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/NewIssueDialog.tsx) |
| 토스트·공지·배너 | 토스트는 tone별로 표시 시간이 다르고 중복 키로 묶입니다. 그 밖에 서버 공지(AnnouncementWell), worktree/dev 재시작 배너, 보관된 회사 접근 시 자동 전환 토스트가 있습니다. | [`ToastContext`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/context/ToastContext.tsx), [`Layout.tsx#L300-320`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/Layout.tsx#L300-L320) |
| 모바일 | 하단 nav(Home·Tasks·New Task·Agents·Inbox 또는 Chat), 가장자리 swipe로 사이드바 열기 | [`MobileBottomNav`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/MobileBottomNav.tsx) |
| 계정 메뉴·언어 | 계정 메뉴: 프로필, Settings, Invite, 문서, 테마 전환, 로그아웃, 피드백. UI 언어 파일은 40개입니다. | [`SidebarAccountMenu`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/SidebarAccountMenu.tsx), [`i18n/locales`](https://github.com/paperclipai/paperclip/tree/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/i18n/locales) |

단축키:
- 전역: `/`(페이지 검색, 없으면 빠른 검색), `c`(새 작업), `[`/`]`(사이드바·패널 토글), `?`(단축키 표)
- 이동 chord: `g i`(inbox), `g c`(댓글 입력), `g f`(파일 뷰어)
- 목록: `j`/`k` 이동, `←`/`→` 그룹 접기·펴기, `a`/`y` 보관, `r`/`U` 읽음·안읽음
- Decisions: Enter 열기·닫기, `x` 무시

## 2. 화면별 목록

표 열은 경로 / 목적·표시 데이터 / 사용자 행동 / 실시간 / 도메인 객체입니다. 실시간 열에서 "이벤트"는 위 WebSocket 신호에 따른 무효화를 뜻합니다.

### 2.1 홈·주의 화면

| 화면 | 경로 | 목적·표시 데이터 | 사용자 행동 | 실시간 | 도메인 객체 |
|---|---|---|---|---|---|
| Dashboard | `/dashboard` | 아래 목록 참고 | 지표·incident에서 해당 화면으로 이동, 가져온 에이전트 일괄 재개, 에이전트가 없으면 온보딩 열기 | 이벤트(dashboard·activity·agents·live-runs), 따로 polling 없음 | dashboard summary, heartbeat run, activity, issue |
| Live runs | `/dashboard/live` | 실행 중·최근 run 카드 최대 50개 | run과 작업으로 이동 | live-runs 이벤트 | heartbeat run |
| Inbox | `/inbox/mine\|recent\|unread\|blocked\|all` | 탭별로 작업, 대기 승인, 에이전트별 최근 실패 run, 가입 요청, 경보(에이전트 오류·예산 80%)를 섞어 보여 줍니다. | 아래 목록 참고 | 이벤트, 탭 간 공유 polling, 행 순서 고정(polling 중 재정렬 억제) | issue read state·inbox archive, approval, heartbeat run, join request, inbox dismissal |
| Tasks 통합 보기 ⚑enableCombinedInboxTasks | `/issues?view=` | Inbox를 Tasks의 보기로 합칩니다. 내 작업: mine·unread·blocked·recent·everything. 조직: all·active·backlog·done | 보기 전환, 마지막 보기 기억 | 위와 같음 | issue |
| Decisions ⚑enableDecisions | `/decisions`, `/decisions/queues/:key` | 결정 필요 항목(attention feed)을 모아 보여 줍니다. 아래 목록 참고 | 무시, 미루기(snooze), 복원, 그룹·정렬, queue seed 규칙 토글, queue에서 제거 | 배지 60초 polling | attention item, decision, decision queue |
| 가입 요청 대기열 | `/inbox/requests` | 사람·에이전트 가입 요청 | 상태·종류 필터, 승인·거절 | 이벤트 | join request |
| Status cards ⚑enableStatusCards | `/status` | 감시 query를 지정 에이전트가 요약하는 카드 | 생성, 새로고침, 재컴파일, 보관, 삭제, 요약 에이전트 지정 | summary 이벤트 | status card, summary slot |
| Timeline | `/activity/timeline`(legacy `/timeline`) | run 구간, 위임 연결, 자동화를 보여 주는 Gantt. 요약: run 수, 에이전트 수, 실행 시간, token | 기간 preset(오늘·7일·30일·사용자 지정), 확대·축소, 미니맵 brush, 막대를 누르면 작업 열기, `?projectId=` 범위 | 없음 | heartbeat run, issue 관계 |
| 사용자 프로필 | `/u/:slug` | 사용자별 token·비용·작업·활동, 에이전트·provider 구성 | 본인이면 편집 링크 | 없음 | user profile |

Dashboard가 보여 주는 것:
- 지표 4개: 활성 에이전트, 진행 중 작업, 월 지출과 예산 대비 %, 대기 승인
- 차트 3개(14일): run 활동, 상태별 작업, 성공률
- 일시정지·예산 incident 배너
- 실행 중 에이전트 패널
- 최근 활동 10개, 최근 작업 10개
- plugin widget

Inbox에서 할 수 있는 일:
- 읽음·안읽음 표시, 보관(5초 실행 취소, swipe)
- 실패 run 재시도, 승인·거절, 가입 승인
- 필터, 그룹, 열 선택, 하위 작업 nesting, 모두 읽음 처리
- 그룹 안에 새 작업 만들기

Decisions가 모으는 항목: 승인, 계획 승인, 확인 요청, 질문, 작업 제안, 실패 run, blocker, 예산, 에이전트 오류.

근거:
- Dashboard: [`Dashboard.tsx#L377-472`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/Dashboard.tsx#L377-L472), [`ActiveAgentsPanel`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/ActiveAgentsPanel.tsx), [`dashboard route`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/routes/dashboard.ts#L27), [대시보드 문서](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/docs/guides/board-operator/dashboard.md)
- Inbox: [`Inbox.tsx`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/Inbox.tsx), [`lib/inbox.ts`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/lib/inbox.ts), [`useInboxBadge`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/hooks/useInboxBadge.ts)
- Tasks 통합 보기: [`task-views.ts`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/lib/task-views.ts)
- Decisions: [`WhatNeedsMe.tsx`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/WhatNeedsMe.tsx), [`attention.ts`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/shared/src/types/attention.ts#L8-L35)
- Timeline: [`Timeline.tsx`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/Timeline.tsx)
- Status cards: [`StatusCards`](https://github.com/paperclipai/paperclip/tree/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/StatusCards)

Inbox 배지 숫자는 다음 넷의 합입니다. 회사 경보는 배지에 포함하지 않습니다.
- 처리 가능한 승인
- 가입 요청
- 나에게 보이는 실패 run(에이전트별 최신 run이 `failed`나 `timed_out`인 경우)
- 안 읽은 내 작업

### 2.2 작업(Task)·계획 화면

| 화면 | 경로 | 목적·표시 데이터 | 사용자 행동 | 실시간 | 도메인 객체 |
|---|---|---|---|---|---|
| Tasks 목록·칸반 | `/issues` | 목록 또는 칸반 보기. 정렬, 그룹(상태·우선순위·담당·프로젝트·워크스페이스·부모), 부모-자식 nesting, 하위 작업 진행·비용 띠 | 아래 목록 참고 | live-runs 이벤트, 작업 이벤트 | issue, label |
| 작업 상세 | `/issues/:id` | 기본은 채팅 셸입니다. 대화 thread와 오른쪽 패널(속성·산출물·파일·하위 작업)로 구성됩니다. 클래식 셸 ⚑enableClassicTaskInterface에서는 Chat·Activity·Related work 탭과 본문 섹션이 나옵니다. | 아래 목록 참고 | 작업·댓글·문서·첨부·work product·interaction·tree hold 이벤트. live run은 1~3초 polling | issue, comment, document·revision·annotation, attachment, work product, thread interaction, approval link, tree hold, recovery action, heartbeat run |
| 작업 속성 패널 | 상세 오른쪽 | 상태, 담당, 모델, 프로젝트, 라벨, 부모, blocked by·blocking, 하위 작업, 참조, PR, 승인, 실행 정책(검토자·승인자), 실행 워크스페이스·브랜치, 예약 재시도, monitor·watchdog, 생성·완료 시각, 깊이 | 각 속성 수정, blocker 검색·추가 | 위와 같음 | issue, issue relation, execution policy |
| Projects | `/projects`, `/projects/:id/{overview,issues,workspaces,configuration,budget}` | 프로젝트 목록과 상세(아이콘·색, 작업, 워크스페이스, 설정, 예산 카드), plugin 탭 | 생성, 수정, 이미지, 예산 정책 설정 | 예산 30초 polling, 이벤트 | project, project workspace, budget policy |
| Goals (사이드바 링크 ⚑enableGoalsSidebarLink) | `/goals`, `/goals/:id` | 목표 트리(하위 목표), 연결된 프로젝트 | 생성, 하위 목표 생성, 수정 | 이벤트 | goal |
| Artifacts | `/artifacts` | 회사 전체 산출물(이미지·영상·문서·텍스트·파일) | 종류 필터, 작업·부모 작업별 그룹, 검색 | 없음 | artifact(작업 첨부·work product) |
| Workspaces ⚑enableIsolatedWorkspaces | `/workspaces`, `/execution-workspaces/:id/{services,configuration,runtime-logs,issues,routines}` | 작업별 격리 git worktree와 runtime service, 실행 로그 | 서비스 시작·중지, 설정, 닫기(준비 상태 확인), routine 즉시 실행 | 작업 이벤트 | execution workspace, runtime service, workspace operation |
| Cases ⚑enableCases / Pipelines ⚑enablePipelines | `/cases`, `/pipelines`, `/review-queue`, `/learnings` | case 문서와 이벤트, pipeline item·검토 대기열·학습 기록 | 상태 변경, 문서 잠금·복원, 일괄 처리 | 일부 polling | case, pipeline |

Tasks 목록·칸반에서 할 수 있는 일:
- 필터: 상태, 우선순위, 담당, 생성자, 프로젝트, 라벨, 실행 중만 보기
- 열 선택, 검색(250ms debounce)
- 칸반 drag로 상태 변경
- 그룹 안에 새 작업 만들기
- 키보드 `j`/`k`/Enter

작업 상세에서 할 수 있는 일:
- 제목·상태 바로 수정
- 댓글 쓰기. 실행 중인 run이 있으면 queue에 쌓이고, queue 항목을 수정·순서 변경·steer·폐기하거나 최신 항목으로 interrupt할 수 있습니다.
- run 취소, 실패 run 재시도, 에이전트 재개
- 하위 트리 일시정지·재개·취소(tree hold, 재개 시 wake 선택)
- interaction 응답: 질문 답변, 확인, 계획 수락(하위 작업 생성), 판정 제출
- 연결된 승인을 승인·거절
- 첨부 drag-drop. markdown 파일을 올리면 문서가 됩니다.
- 하위·후속 작업 생성, 형제 작업으로 이동
- 공개 범위·공유 설정, 피드백 투표

이 표의 사실 근거:
- 목록·칸반: [`Issues.tsx`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/Issues.tsx), [`IssuesList.tsx#L156-180`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/IssuesList.tsx#L156-L180), [`KanbanBoard.tsx#L438-459`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/KanbanBoard.tsx#L438-L459)
- 작업 상세: [`IssueDetail.tsx#L7911-7945`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/IssueDetail.tsx#L7911-L7945)
- 속성 패널: [`IssueProperties`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/issue-properties/IssueProperties.tsx)
- queue·steer: [`api/issues.ts#L389-410`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/api/issues.ts#L389-L410)
- interaction 종류: [`ISSUE_THREAD_INTERACTION_KINDS`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/shared/src/constants.ts#L259-L266)
- 나머지 화면: [`ProjectDetail`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/ProjectDetail.tsx), [`GoalDetail`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/GoalDetail.tsx), [`Artifacts`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/Artifacts.tsx), [`ExecutionWorkspaceDetail`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/ExecutionWorkspaceDetail.tsx)

작업 목록에서 bulk action은 찾지 못했습니다. 보기 상태는 서버의 저장된 보기가 아니라 브라우저 localStorage에 저장됩니다.

### 2.3 에이전트·실행 화면

| 화면 | 경로 | 목적·표시 데이터 | 사용자 행동 | 실시간 | 도메인 객체 |
|---|---|---|---|---|---|
| Agents 목록·조직도 | `/agents/{all,active,paused,error,builtin}` | 목록과 조직도(reportsTo 트리, 확대·이동) 전환. 행마다 live run 표시 | 새 에이전트, 채팅 열기, 실행 중 run으로 이동 | live-runs 15초 공유 polling과 이벤트 | agent, org tree |
| 에이전트 상세 | `/agents/:id/:view` | 세 묶음의 view. 아래 목록 참고 | 아래 목록 참고 | 지시문 5초 polling, agent.status 이벤트 | agent, runtime state, config revision, API key, instructions bundle |
| 지시문(Instructions) | `.../instructions` | managed·external 지시문 묶음. 기본 entry는 `AGENTS.md`이고 그 밖의 파일은 자유 형식입니다. | 파일 추가·삭제·편집(낙관적 동시성), 다운로드, 실행이 남긴 수정 후보 검토, revision 이력·diff·복원 | 5초 polling | instructions bundle, revision |
| 실행 설정(Harness/Runtime) | `.../runtime` | 아래 목록 참고 | 저장·취소(변경 중 이탈 방지) | — | agent config |
| 권한(Permissions/Trust) | `.../permissions` | 신뢰 preset(standard, low_trust_review), "새 에이전트 생성", "skill 생성·가져오기", "작업 할당" 토글 | 수정 | — | agent permissions |
| 실행 상세·transcript | `/agents/:id/runs/:runId` | 아래 목록 참고 | 취소, 재개(process lost), 재시도, provider trace로 재실행, 세션 정리 | WebSocket `heartbeat.run.log/event/progress`. 끊기면 2초 polling. 상세는 5초(대기)·15초(실행) polling | heartbeat run, run event, run log store, workspace operation |
| 새 에이전트 | `/agents/new`, 대화상자 | 연결 → 구성 → 확인 단계. 외부 에이전트 초대도 됩니다. | 생성, 또는 hire(승인 필요 시 `pending_approval`) | — | agent, approval(hire_agent) |
| Agent Chat ⚑enableAgentChat | `/chats`, `/chats/:agent` | 에이전트별 대화. 대화 자체도 작업 하나로 저장됩니다. | 대화 상대 선택, 메시지 전송 | 작업 thread와 같음 | issue(대화) |
| Conference Room ⚑enableConferenceRoomChat | `/board-chat` | 보드 전용 작업 하나의 댓글을 채팅처럼 보여 줍니다. | 메시지, 피드백 투표 | 댓글 3초 polling | issue, comment |
| Skills | `/skills/*`, `/skills/sources`, `/skills/studio` | 회사 skill 목록·상세(파일, 버전 diff), catalog 설치, GitHub 저장소에서 가져오기, Skill Studio(초안·fork, 파일 편집, 테스트 입력·템플릿·테스트 실행) | 설치, 업데이트, 별표, fork, 테스트 실행·취소 | 테스트 실행 상태에 따라 polling | company skill, skill source, skill test run |

에이전트 상세의 view 묶음:
- Agent: Overview, Instructions, Skills
- Runtime: Harness/Runtime, Secrets, Tools, Channels
- Governance: Permissions/Trust, API Keys, Revisions

Overview에는 최근 run 카드, 신원(역할·보고 대상·공개 키), adapter·모델·세션, 역량, skill, 최근 작업, 감사 링크가 있습니다.

에이전트 상세의 행동:
- 지금 실행(invoke), 일시정지·재개, 오류 해제
- 복제, ID 복사, 세션 초기화, 종료(terminate)
- 승인 대기 중인 에이전트 승인
- 설정 저장, revision으로 되돌리기, API key 발급·폐기
- skill 동기화, 도구 연결 설치

실행 설정 화면의 항목:
- adapter와 모델 목록, 환경 테스트, 환경 변수, adapter 로그인
- heartbeat 주기 on/off(기본 300초)
- 실행 timeout, 중단 grace, wake on demand, cooldown, 최대 동시 실행
- max-turn 이후 이어 실행, 월 예산

실행 상세가 보여 주는 것:
- 상태, 연결된 작업, 호출 출처(timer·assignment·on_demand)
- adapter·모델, token(입력·출력·cache)·비용, exit code
- 호출 정보(cwd·command·prompt·redacted env), worktree 작업 로그
- transcript: nice·raw 모드. 항목 종류는 message, thinking, tool, command·diff group, stdout, event, provider activity입니다.

이 표의 사실 근거:
- [`agent-detail-navigation.ts#L3-47`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/agent-detail-navigation.ts#L3-L47)
- [`AgentActionButtons.tsx#L270-280`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/AgentActionButtons.tsx#L270-L280)
- [`AgentDetail.tsx`의 RunDetail·LogViewer](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/AgentDetail.tsx#L3399)
- [`RunTranscriptView.tsx#L837-860`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/transcript/RunTranscriptView.tsx#L837-L860)
- [`agent-config-primitives.tsx#L52-66`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/agent-config-primitives.tsx#L52-L66)
- [`OrgChart`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/OrgChart.tsx), [org route와 SVG·PNG export](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/routes/agents.ts#L3827-L3847)
- [`CompanySkills`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/CompanySkills.tsx), [`SkillStudio`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/SkillStudio.tsx)

transcript의 `thinking` 항목은 adapter가 반환한 내용을 그대로 보여 주는 것입니다 [추론]. BaboJUBot은 provider가 공개로 반환한 경우에만 표시해야 합니다(AGENTS.md 불변 조건).

라우트가 없는 페이지:
- `TeamCatalog`(팀 템플릿 설치 마법사)는 `App.tsx`에서 참조하지 않습니다.
- `Org.tsx`, `MyIssues.tsx`, `OnboardingChat.tsx`도 import하는 곳이 없습니다 [소스].

### 2.4 승인·비용·감사·routine 화면

| 화면 | 경로 | 목적·표시 데이터 | 사용자 행동 | 실시간 | 도메인 객체 |
|---|---|---|---|---|---|
| Approvals | `/approvals/pending\|all` | 승인 카드: 종류, 요청 에이전트, 제목, payload 요약, 상태. 대기 탭에는 `pending`과 `revision_requested`가 함께 나옵니다. | 승인, 거절(예산 승인은 버튼 대신 비용 화면으로 안내) | `approval` 활동 이벤트로 목록 갱신 | approval |
| 승인 상세 | `/approvals/:id` | 종류별 payload 렌더링(아래 참고), 원본 JSON, 결정 메모, 연결된 작업, 댓글 thread | 승인, 거절, 수정 요청, 재제출 표시, 댓글, 거절된 채용의 에이전트 삭제 | 상세는 이벤트 갱신 없음 [추론] | approval, approval comment, issue_approvals |
| Audit 허브 | `/activity`, `/activity/{runs,costs,budgets,timeline}` | Activity 탭: 변경 기록 feed(행위자, 동사, 대상 링크, run 링크, 대리 사용자). 범위를 에이전트·run·대상으로 고정할 수 있습니다. | 아래 목록 참고 | Runs 15초 polling | activity_log, heartbeat run, routine run |
| Costs | `/activity/costs`(legacy `/costs`) | 탭: Overview, Budgets, Providers, Billers, Finance, Decisions, Fast responses. 아래 목록 참고 | 기간 preset(월초부터·7일·30일·연초부터·전체·사용자 지정), 구독 가격 수정, 회계 재시도 | 30초 polling, cost 이벤트 | cost event, finance event, AI subscription, quota window |
| Budgets | `/activity/budgets` | 아래 목록 참고 | 예산 설정, run당 예약액, 가격 없는 사용 차단, incident 해소(예산 증액 후 재개 / 정지 유지) | 30초 polling | budget policy, budget incident, approval(budget_override_required) |
| Routines | `/routines`, `/routines/:id/{overview,triggers,variables,secrets,delivery,runs,activity,history}` | routine 목록(폴더·프로젝트·담당별 그룹, 내장 routine 구역), 상세 섹션 | 생성, 일시정지·활성화, 변수 입력 후 즉시 실행, trigger 추가(schedule·webhook·API, 서명 secret 교체), 동시성·누락 정책, revision 복원 | 이벤트 | routine, trigger, routine run, revision |

승인 상세의 payload 렌더링:
- 채용: 역할, 역량, adapter, skill
- 전략: 계획 본문
- 예산 초과: 범위, 한도와 관측값
- 일반 보드 승인: 요약, 권고 행동, 승인 시 다음 행동, 위험, 제안 댓글

Audit Activity 탭에서 할 수 있는 일:
- 필터: 에이전트, 책임 사용자, 행동 영역, 대상 종류, 기간
- CSV 내보내기(full 등급만)
- Runs 탭: 에이전트·상태 필터

Costs의 표시 데이터:
- 에이전트별 비용을 provider·모델·biller로 펼쳐 보기
- 사용자별·프로젝트별 비용
- provider quota·rolling window, 월말 초과 예상, 재무 원장
- 가격 없는 사용 경고

Budgets의 표시 데이터:
- 지표: 진행 중 incident, 대기 예산 승인, 일시정지된 에이전트·프로젝트
- incident 카드
- 범위별 정책 카드: 조직 월간, 에이전트 월간, 프로젝트 누적

이 표의 사실 근거:
- 승인: [`APPROVAL_TYPES`·상태](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/shared/src/constants.ts#L689-L703), [`ApprovalDetail`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/ApprovalDetail.tsx), [`ApprovalPayload#L5-10`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/ApprovalPayload.tsx#L5-L10), [승인 시 요청자 wake](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/routes/approvals.ts#L329-L394)
- 감사: [`audit-navigation.ts#L8-12`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/audit/audit-navigation.ts#L8-L12), [`AuditFeed`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/audit/AuditFeed.tsx)
- 비용·예산: [`Costs.tsx#L724-737`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/Costs.tsx#L724-L737), [`BudgetPolicyCard`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/BudgetPolicyCard.tsx), [`BudgetIncidentCard`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/BudgetIncidentCard.tsx), [hard incident의 승인 생성](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/budgets.ts#L441-L453), [예산 상수](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/shared/src/constants.ts#L875-L894)
- routine: [routine 정책 상수](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/shared/src/constants.ts#L636-L640), [`RoutineDetail`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/RoutineDetail.tsx)

승인 결정이 요청자에게 전달되는 방식:
- 요청 에이전트는 **승인될 때만** `approval_approved` 이유로 wake됩니다.
- 거절이나 수정 요청은 이 route에서 요청자를 깨우지 않습니다. 대신 연결 작업의 검토 경로가 멈춰 있으면 담당자를 깨우는 별도 경로가 있습니다.
- UI 목록의 승인·거절 버튼은 결정 메모를 보내지 않습니다.

예산 정책 카드의 수정 범위: 경고 %, hard stop, 알림 설정은 API로는 받지만 UI에서는 수정할 수 없습니다.

### 2.5 온보딩·설정·확장 화면

| 화면 | 경로 | 목적·표시 데이터 | 사용자 행동 | 도메인 객체 |
|---|---|---|---|---|
| 온보딩 마법사 | `/onboarding`(회사가 없거나 에이전트가 없는 대시보드에서 자동으로 열림) | 아래 목록 참고 | 위 단계 진행, 초안을 localStorage에 저장 | company, agent, project, issue |
| 조직 목록 | `/companies` | 회사별 에이전트 수, 작업 수, 월 지출과 예산 %, 생성일 | 이름 변경, 삭제, 보관 해제, 새 조직 | company |
| 설정 General | `/company/settings` | 아래 목록 참고 | 수정, 조직 보관 | company, instance settings |
| Members·Invites·Access | `/company/settings/members`, `.../instance/access` | 구성원·역할, 초대, 가입 요청, 인스턴스 관리자 | 역할 변경, 구성원 보관(작업 재할당), 관리자 승격·강등 | membership, invite |
| Secrets | `/company/settings/secrets` | 조직 secret과 사용자별 secret, 외부 vault provider, 에이전트의 secret 제안 | 생성, 교체, 활성·비활성, 사용처·접근 기록, 에이전트별 접근 권한 | secret, provider config |
| Environments | `.../instance/environments` | 실행 환경(local, ssh, sandbox)과 custom image | 생성, probe, 기본 환경 지정, 삭제(영향 범위 확인) | environment |
| Export·Import | `/company/export`, `/company/import` | 조직 묶음(에이전트·프로젝트) 내보내기와 충실도 보고, GitHub·파일에서 가져오기 | 미리보기, 비동기 job, 가져온 에이전트 재개 | company bundle |
| Experimental | `.../instance/experimental` | 실험 플래그 토글 약 30개 | on/off | instance settings |
| Adapters | `.../instance/adapters` | 내장·외부 adapter | 설치, 제거, 활성·비활성, reload | adapter registry |
| Plugins | `.../instance/plugins`, `/plugins/:id`, `/:pluginRoute/*` | 설치·사용 가능한 plugin, 설정 schema form, health·로그 | 설치, 제거, 활성·비활성, 설정 테스트 | plugin |
| Connectors(Apps) | `/apps`, `/apps/:id/:tab`, `/apps/review`, `/apps/gateways`, `/apps/advanced/*` | 도구 연결 catalog(OAuth, Composio 등), 에이전트별 접근, 도구 행동 검토 대기열, MCP gateway, 외부 assistant 연결 | 연결, 권한 부여, 검토, token 발급 | tool connection, grant, gateway |
| Chat connectors ⚑enableChatConnectors | `/apps/chat/connect`, `/apps/chat/:id/{settings,access,reviews,conversations,activity}` | 아래 목록 참고 | 연결 테스트, 일시정지, 재개, 제거 | chat endpoint, identity link, conversation |
| 인증 | `/auth`, `/board-claim/:token`, `/invite/:token`, `/cli-auth/:id`, `/mcp-connect/:id` | 로그인·가입, 최초 보드 소유권 확보, 초대 수락, CLI·MCP 접근 승인 | 승인, 취소 | session, invite |

온보딩 마법사의 단계:
1. 조직 이름
2. 첫 에이전트 이름(기본 "Chief of staff")
3. 모델 연결(Claude Code·Codex, 구독 로그인 또는 API key)과 환경 테스트
4. 검토 → Launch

Launch하면 "Onboarding" 프로젝트와 첫 작업을 만들고 그 작업 화면으로 이동합니다. 사명(mission)은 마법사에서 받지 않고 첫 에이전트와의 대화에서 수집합니다.

설정 General의 항목:
- 이름, 설명, 로고
- **"Require board approval for new hires" 토글**
- interaction 유형별 기본 정책·상한
- 결정 모델
- 인스턴스 일반 설정: 로그에서 사용자 이름 가림, 백업 보존

Chat connectors의 provider: Slack, GitHub, Discord, Microsoft Teams, Telegram, Speko, AgentMail, iMessage. 엔드포인트마다 연결할 에이전트를 하나 고르고, 다음을 설정합니다.
- 허용 채널, DM, @mention 필수 여부, 그룹 대화
- 연결된 사용자와 손님 접근
- 대화와 활동 replay

이 표의 사실 근거:
- 온보딩: [`OnboardingWizard.tsx#L1974-2040`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/OnboardingWizard.tsx#L1974-L2040), [Launch](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/OnboardingWizard.tsx#L1697-L1773), [`Stepper.tsx#L37-42`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/onboarding/Stepper.tsx#L37-L42)
- 설정: [`CompanySettings.tsx#L351`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/CompanySettings.tsx#L351), [`CompanySettingsNav.tsx#L10-21`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/access/CompanySettingsNav.tsx#L10-L21), [`InstanceExperimentalSettings`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/InstanceExperimentalSettings.tsx)
- 확장: [plugin slot 종류](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/shared/src/constants.ts#L1477-L1495), [`CHAT_PROVIDERS`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/shared/src/types/chat-channels.ts#L2-L11), [`ChatEndpointDetail`](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/apps/chat/ChatEndpointDetail.tsx)

plugin UI slot은 17종입니다. 페이지, 상세 탭, 대시보드 widget, 사이드바, toolbar 버튼, 컨텍스트 메뉴, 댓글 주석, 설정 페이지, 회사 전환기 등을 확장할 수 있습니다.

## 3. Paperclip에 없거나 약한 BaboJUBot 화면 [추론]

BaboJUBot의 확정 범위에는 있지만 Paperclip UI에 그대로 대응하는 화면이 없는 것입니다. 새로 설계해야 합니다.

- **연구 지도.** 연구 노드 그래프(주 연결 트리 + 보조 연결)와 노드별 상태·근거·연결 작업을 보여 주는 화면이 필요합니다.
  - Paperclip에서 가장 가까운 것은 Goal 트리, 작업의 부모-자식 nesting, blocked-by 관계입니다.
  - 이것들은 작업 관리 구조이고, 문제→가설→검증→결과의 연구 의미를 표현하지 않습니다.
- **초기 연구 승인 화면.** 연구 계획, 최초 팀 구성, 완료 기준, 연구 환경 명세를 한 번에 검토하는 화면입니다.
  - Paperclip은 채용과 CEO 전략을 서로 다른 승인 객체로 처리합니다.
  - 온보딩도 승인 없이 첫 에이전트를 바로 만들고, 승인이 생기면 자동 승인합니다.
- **결과 제출 검토와 최종 완료.** Paperclip에는 회사 단위 완료 개념이 없습니다. 작업 단위의 `in_review`와 실행 정책 검토만 있습니다.
- **외부 job.** 장시간 job의 상태·비용·결과·종료 시 wake를 보여 주는 목록·상세가 필요합니다.
  - 가까운 것은 실행 워크스페이스의 runtime service·로그, 작업 속성의 monitor·watchdog·예약 재시도입니다.
  - 이것들은 git worktree와 서비스 중심입니다.
- **사용자 할 일.** Paperclip은 사용자에게 묻는 질문·확인을 thread interaction으로, secret을 에이전트 제안(Proposals)으로 처리합니다. 사용자가 해야 하는 일 자체를 독립 객체로 두지는 않습니다.
- **명시적 공유.** Paperclip은 회사 간 공유 UI가 없습니다. Export/Import는 조직 전체를 복제하는 기능입니다.
- **조직 기억과 에이전트 기억.** 이 세대의 대시보드에서는 기억 화면을 확인하지 못했습니다. 실험 플래그 `enableMemoryConnectors`만 있습니다.

## 4. BaboJUBot 대응 제안 — 설계 제안, 결정 아님

분류 기준:
- 단일 사용자(Owner) self-host
- 연구 목표마다 독립 연구 조직
- 제어 명령과 사용자 메시지 분리
- 승인 정책은 조직별 체크박스(기본 off). 초기 연구 승인과 최종 완료만 항상 요구합니다.
- 메신저 채널은 나중 pass로 미룹니다.

| Paperclip 기능 | 제안 | BaboJUBot에서의 형태 |
|---|---|---|
| 회사 전환기·조직 목록 | 조정 | 연구 조직 목록을 홈 수준으로 올리고, 조직별 상태(계획 중·승인 대기·진행·일시정지·결과 제출·최종 완료)를 표시합니다. 드래그 정렬은 채택합니다. |
| Dashboard 지표·차트·최근 활동 | 조정 | 조직별 대시보드: 에이전트 상태, 작업 상태, 예산 사용, 대기 승인 요청·사용자 할 일, 진행 중 외부 job, 연구 지도 요약. 여러 조직을 모아 보는 개요도 추가합니다. |
| Live runs 패널·`/dashboard/live` | 채택 | 실행 중인 실행 시도 카드. 외부 job은 별도 카드로 구분합니다. |
| Inbox(탭, 읽음, 보관, 실패 run 재시도) | 조정 | 사용자 대기열: 승인 요청, 사용자 할 일, 결과 제출, 실패 실행 시도, 예산 경보, Lead 질문. 가입 요청은 뺍니다. |
| Decisions·attention feed | 조정 | 위 대기열의 정렬·미루기·무시 기능으로 흡수합니다. decision queue와 seed 규칙은 생략합니다. |
| Command palette·검색 연산자·단축키 | 채택 | 연산자에 `org:`, `node:`, `agent:`를 추가하고, 검색 범위에 연구 노드·산출물·메시지를 추가합니다. |
| 토스트·실시간 WebSocket 무효화·끊김 시 polling 대체 | 채택 | 조직 단위 채널을 쓰고, 이벤트는 변경 알림으로만 씁니다([상호작용 조사 제안 7](agent-interaction-models.md)). 승인 요청·예산 incident·외부 job 종료에도 토스트를 띄웁니다. |
| 탭 간 leader polling | 채택(후순위) | 성능 최적화 단계에서 적용합니다. |
| Tasks 목록·칸반·그룹·필터 | 채택 | 작업 목록. 그룹 기준에 연구 노드와 담당 에이전트를 추가합니다. |
| 작업 상세 채팅 셸·thread | 조정 | 작업 thread = 연구 기록의 메시지·산출물·실행 시도 보기. 연결된 연구 노드를 표시합니다. |
| 댓글 queue·steer·interrupt | 채택 | 사용자 메시지는 기본적으로 대기 후 병합하고, "중단 후 반영"을 선택할 수 있게 합니다. 중단은 제어 명령 기록을 남깁니다. |
| Thread interaction(질문·확인·계획 수락·판정) | 조정 | Lead 질문과 확인 요청으로 씁니다. 승인 정책 대상 행동은 interaction이 아니라 승인 요청으로 강제합니다. |
| Tree hold(하위 트리 일시정지) | 조정 | 제어 명령은 에이전트·조직 단위가 기본입니다. 작업 subtree 일시정지는 선택 기능으로 둡니다. |
| 속성 패널(상태·담당·blocker·하위 작업 등) | 조정 | PR·브랜치·모델 lane은 빼고 연구 노드 링크, 산출물, 외부 job을 추가합니다. |
| 실행 정책(검토자·승인자 단계) | 조정 | 에이전트 간 검토로 표시합니다. 승인 요청과 혼동하지 않습니다(GLOSSARY Avoid). |
| 문서·revision·첨부·work product·Artifacts | 채택 | 산출물 목록·상세. "산출물 ≠ 결과" 표시를 둡니다. |
| Goals 트리 | 조정 | 연구 목표는 조직당 하나이므로 Goals 대신 연구 지도로 대체합니다. |
| Projects | 생략(초기) | 조직 안의 분류는 연구 지도가 맡습니다. 필요하면 나중에 다시 봅니다. |
| Execution workspaces·worktree·runtime services | 조정 | 연구 환경 화면(compute·저장소·데이터·외부 계정 명세)과 외부 job 화면으로 재구성합니다. git 중심 기능은 생략합니다. |
| Agents 목록·조직도 | 조정 | Lead와 작업자 팀의 2단 구조 보기. 다단계 reportsTo·CEO 개념은 생략합니다. |
| 에이전트 상세 Overview·실행 제어(실행, 일시정지·재개, 오류 해제, 종료) | 채택 | 일시정지·재개·중단은 제어 명령으로 기록합니다. 지금 실행은 수동 깨우기입니다. |
| 지시문 묶음 편집·revision·실행이 남긴 수정 후보 | 조정 | ROLE.md/SOUL.md 등 역할·성격·행동 원칙 파일. 수정 후보는 사용자 검토를 거친 뒤 반영합니다. |
| 실행 설정(adapter·모델·heartbeat 주기·timeout·동시성) | 채택 | Heartbeat on/off와 주기는 GLOSSARY 정의를 따릅니다. |
| 권한 토글("Require board approval for new hires" 포함) | 조정 | 조직별 승인 정책 체크박스(작업자 추가, 큰 목표 변경, 추가 예산 등, 기본 off). 초기 연구 승인·최종 완료는 체크박스 없이 항상 요구합니다. 사용자만 바꿀 수 있게 합니다. |
| 에이전트 API keys·Channels 탭 | 생략(초기) | 에이전트 자격 증명은 내부 처리합니다. 채널은 메신저 pass에서 다룹니다. |
| 실행 상세·transcript·로그 스트림·비용·재시도 | 채택 | provider가 공개 반환한 추론만 표시합니다. provider trace는 개발자 모드로만 둡니다. |
| 새 에이전트·hire 흐름 | 조정 | Lead 제안 → 팀 구성 승인. 승인 정책이 꺼져 있으면 즉시 추가하고 활동에 기록합니다. |
| Agent Chat·Conference Room | 조정 | 웹 Lead 채팅 = 사용자 메시지 채널. 작업자 대화는 읽기 전용으로 관찰합니다. |
| Skills·Skill sources·Skill Studio | 조정 | 연구 역할·skills 조합 화면. catalog·GitHub 가져오기·테스트 실행은 후순위입니다. |
| Team catalog | 생략 | 라우트가 없는 기능이고 marketplace 성격입니다. 나중에 연구 흐름 템플릿 선택으로 대체를 검토합니다. |
| Approvals 목록·상세(payload, 댓글, 수정 요청, 재제출) | 채택 | 승인 요청 종류: 초기 연구 승인, 팀 구성 승인, 추가 예산, 큰 목표 변경. 결정 메모를 받고, 모든 결정(거절·수정 요청 포함)이 Lead를 깨우게 합니다. |
| Audit feed·CSV·Runs 탭 | 채택 | 단일 사용자이므로 Enterprise 접근 등급을 없애고 제어 명령을 필터로 추가합니다. |
| Timeline Gantt | 채택 | 실행 시도와 외부 job 구간을 함께 표시합니다. |
| Costs(에이전트·모델·provider별) | 조정 | 조직·에이전트·외부 job별 비용. Billers·Finance·구독·quota 탭은 후순위입니다. |
| 예산 정책·incident(증액 후 재개 / 정지 유지) | 채택 | 범위는 조직·에이전트. 증액 후 재개는 추가 예산 결정이므로 사용자 판단을 거칩니다. |
| Routines(trigger, 동시성·누락 정책, 즉시 실행) | 조정 | 정기 연구 작업(문헌 감시 등). webhook trigger는 후순위입니다. |
| Status cards(LLM 요약) | 생략(초기) | Lead 보고가 같은 역할을 합니다. |
| Cases·Pipelines | 생략 | 실험 기능이고 영업·지원 업무 흐름에 맞춰져 있습니다. |
| 온보딩 마법사 | 조정 | 연구 목표·완료 기준 입력 → Lead 생성·모델 연결·환경 테스트 → Lead의 계획·팀 제안 → 초기 연구 승인 → 시작. 실제 모델 호출 전에 자격 증명과 비용을 확인합니다. |
| 설정 General·보관 | 조정 | 조직 이름·설명·승인 정책·예산. 보관은 최종 완료 이후 상태로 둡니다. |
| Members·Invites·Join requests·Instance access·Board claim·CLI auth | 생략 | 다중 사용자 권한이 필요 없습니다. 단일 Owner 로그인만 둡니다. |
| Secrets | 조정 | Owner 자격 증명 저장. 에이전트의 secret 요청은 사용자 할 일로 바꿉니다. vault provider는 후순위입니다. |
| Environments | 조정 | 연구 환경 등록·probe. custom image는 후순위입니다. |
| Adapters 관리 | 조정 | 외부 에이전트 executor adapter 목록·활성화. 설치 marketplace는 생략합니다. |
| Export·Import | 생략(초기) | 조직 간 이동은 명시적 공유로 대체합니다. 백업은 별도로 다룹니다. |
| Experimental 플래그 화면 | 생략 | 내부 개발 장치이므로 개발자 설정으로 충분합니다. |
| Plugins·UI slot | 생략(초기) | 일반 plugin platform은 [Paperclip 1차 조사](paperclip.md)에서 초기 생략 후보로 분류했습니다. |
| Connectors(도구 OAuth·MCP gateway) | 조정(후순위) | 연구 도구·API 연결과 에이전트별 접근 허용. Composio 같은 aggregator는 생략합니다. |
| Chat connectors(Slack·Telegram·Discord 등) | 후속 pass | 메신저 채널 pass에서 엔드포인트 → Lead 연결, 허용 채널, 일시정지 모델을 참고합니다. |
| 프로필·테마·i18n·모바일 nav | 조정 | 한국어·영어, 테마는 채택합니다. 모바일은 후순위입니다. |
| Design guide·UX lab·storybook | 생략 | 개발용 화면입니다. |

## 한계

- 정적 열람만 했습니다. 실제 화면 배치, 스타일, 동작, 오류 상태는 보지 않았습니다. reference-first 절차가 요구하는 live 화면 확인과 mock self-host는 이 조사에 포함하지 않았습니다.
- 파일이 너무 커서 다섯 갈래 병렬 하위 조사로 나눠 읽었습니다.
  - 일부 화면은 query·행동·제목 grep 수준으로만 확인했습니다: Decisions, Search, Status cards, Skill Studio, Connectors, Secrets, Pipelines·Cases, Telegram·Teams 설정.
  - 본문 각 화면 설명의 핵심 근거는 고정 commit 소스에서 다시 확인했지만, 모든 행 번호와 세부 항목을 다시 대조하지는 않았습니다.
- `.production.tsx` legacy 셸의 차이는 라우팅 수준에서만 확인했습니다. 두 셸의 화면별 세부 차이는 대조하지 않았습니다.
- storybook(`ui/storybook/stories`, 수십 개)은 이름만 훑었습니다. 라우트가 없는 시안 기능이 있을 수 있습니다.
- 서버 권한 판정(누가 무엇을 볼 수 있는가)은 UI가 소비하는 범위에서만 기록했습니다.
- 4절의 채택·조정·생략은 이 commit의 기능을 BaboJUBot 용어에 대응시킨 제안입니다. 채택 여부와 우선순위는 웹 대시보드 기능 이슈에서 결정합니다.
- 라이선스는 MIT입니다([Paperclip 1차 조사](paperclip.md)). UI 코드를 재사용하려면 해당 파일과 의존성의 라이선스를 따로 확인해야 합니다.
