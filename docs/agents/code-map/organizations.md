# 조직 생성·Event·공통 화면

통합 검증: [조직 API](../../../apps/server/test/organizations.test.ts), [생성·다른 탭 갱신 E2E](../../../apps/web/e2e/create-organization.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 생성 입력(이름·연구 목표·선택 완료 기준)·응답·생애주기 값 | [contracts/organization.ts](../../../packages/contracts/src/organization.ts); core·DB schema·웹 표시 | [계약](../../../packages/contracts/src/organization.test.ts) |
| 초기 상태(`계획 수립`·사용자 목표)·전용 Lead·생성 깨우기·생성 Event | [core/organization.ts](../../../packages/core/src/organization.ts) `planOrganizationCreation` → server/app.ts `POST /api/organizations`(commit 뒤 Lead `kick`) | [core](../../../packages/core/src/organization.test.ts), 조직 API |
| 생성 저장·rollback, 생성 깨우기 하나 | [db/organizations.ts](../../../packages/db/src/organizations.ts) `insertOrganizationCreation`; [schema](../../../packages/db/src/schema.ts)·[migrations](../../../packages/db/migrations)(`wakes` 조직 생성 부분 unique, 목표 없는 완료 기준 금지) | [DB 제약](../../../packages/db/src/organizations.test.ts) |
| 목표 없이 만든 예전 조직(`목표 설정`)의 검사 준비 | [db/testing.ts](../../../packages/db/src/testing.ts) `insertLegacyOrganization` | 승인·제어·재시작 복구 API |
| 생성·조회 API·입력 오류·404 | [server/app.ts](../../../apps/server/src/app.ts) `startServer` → 생성 서비스·DB·contracts | 조직 API |
| 조직별 구독·Event 혼입 | app.ts upgrade·attach → [EventHub](../../../apps/server/src/event-hub.ts); [event 계약](../../../packages/contracts/src/event.ts) | [라우팅](../../../apps/server/src/event-hub.test.ts), 조직 API `Event stream scopes` |
| 생성 후 탭·홈·사이드바 갱신 | [web/live-events.ts](../../../apps/web/src/live-events.ts) `useLiveEvents`; [api.ts](../../../apps/web/src/api.ts) query key·캐시; Event 발행 | 생성 E2E |
| Event가 몰릴 때 늦은 반영·겹친 재조회 | [web/live-refresh.ts](../../../apps/web/src/live-refresh.ts) `createLiveRefresh`(조회마다 진행 하나·그사이 신호는 끝난 뒤 한 번 더) | [단위 검사](../../../apps/web/src/live-refresh.test.ts), [느린 응답·재연결 다른 탭 E2E](../../../apps/web/e2e/live-refresh.spec.ts) |
| E2E가 Event stream 구독 성립 전에 상태를 바꿈·ready를 기다리다 멈춤 | [e2e/support/live-events.ts](../../../apps/web/e2e/support/live-events.ts) `openWithLiveEvents`(화면과 같은 frame 계약·제한 시간·listener 해제. `routeWebSocket` page 제외) | [helper 검사](../../../apps/web/e2e/support/live-events.spec.ts) |
| 주소는 바뀌었는데 화면·선택이 늦게 바뀜(이전 화면이 입력을 받음) | [main.tsx](../../../apps/web/src/main.tsx) `RouterProvider useTransitions={false}`(라우터 갱신을 startTransition으로 미루지 않음. 미루면 재조회 갱신에 밀려 최대 약 5초 늦음) | [연구 지도 E2E](../../../apps/web/e2e/research-map.spec.ts) `watchSelectionLag`(CPU 4배 감속에서 주소·패널 노드 불일치 구간) |
| 생성 dialog(이름·연구 목표 필수, 완료 기준 선택)·성공 이동·실패 안내 | [create-organization.tsx](../../../apps/web/src/create-organization.tsx), api.ts `useCreateOrganization`, 입력 계약 | 생성 E2E, 초기 승인 E2E(완료 기준 비움) |
| 주소·메뉴·홈·빈 상태 | [pages.tsx](../../../apps/web/src/pages.tsx), [home.tsx](../../../apps/web/src/home.tsx) `Home`·`NoOrganizations`, [shell.tsx](../../../apps/web/src/shell.tsx), [main.tsx](../../../apps/web/src/main.tsx) routes | 생성 E2E의 홈·메뉴, Lead 대화 E2E의 빈 화면 |
| 되돌릴 수 있는 행동 뒤의 되돌리기 토스트(아래 가운데 더미·새것이 맨 아래·토스트마다 10초·마우스/포커스가 있는 토스트만 멈춤·Esc·닫기·한 번에 셋, 넘치면 차례를 기다렸다가 나타난 때부터 10초), 아이콘 버튼 tooltip | [toast.tsx](../../../apps/web/src/toast.tsx) `ToastProvider`·`useToast`(main.tsx `Root`), 수명·한도 규칙은 [toast-stack.ts](../../../apps/web/src/toast-stack.ts), ui.tsx `Tip`. 쓰는 곳: 연구 지도 폐기, 줄 세운 메시지 실패 | [단위 검사](../../../apps/web/src/toast-stack.test.ts), 연구 지도 E2E의 폐기·폐기 취소·두 노드 연속 폐기 |
| 공용 UI·상태·반응형 | [ui.tsx](../../../apps/web/src/ui.tsx), [index.css](../../../apps/web/src/index.css), 해당 화면 | 생성 E2E만으로 모든 화면·폭을 검증하지는 않음 |
| 긴 글이 `#`·`**` 기호 그대로 보임·Markdown 링크·HTML 안전 | [markdown.tsx](../../../apps/web/src/markdown.tsx) `Markdown`(react-markdown·remark-gfm·remark-breaks. 원문 HTML은 글자로, 안전하지 않은 주소는 비움, 바깥 링크는 새 탭·`noopener noreferrer`, 이미지는 링크, 글 속 제목은 두 단계 내림, 맨 앞 frontmatter는 코드 블록, `~` 하나는 취소선 아님), [markdown.css](../../../apps/web/src/markdown.css). 쓰는 곳: 산출물(`format` markdown만)·작업 내용·자기 보고·댓글(tasks.tsx), Lead 대화(chat.tsx), 승인 계획·환경·사본 미리보기(approvals.tsx), 결과 요약(results.tsx), Inbox 상세 발췌·실행 요약(inbox-detail.tsx), 목표·완료 기준(pages.tsx와 위 상세), Role·Soul·Skill 사본·revision 보기·실행 시도 요약·깨우기 사유(agents.tsx), 연구 노드 본문(research-map.tsx). 편집 폼 textarea는 원문 그대로 | [단위 검사](../../../apps/web/src/markdown.test.tsx), 작업 화면·초기 승인 E2E의 제목 role |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
create-organization → api → POST /api/organizations(app)
  → harness loadHarnessLibrary·leadInstructionsOf(Lead Role·Soul)
  → core planOrganizationCreation(사용자 목표를 가진 조직·Lead·사본·생성 깨우기·Event)
  → db insertOrganizationCreation → EventHub → dispatcher.kick(Lead) → HTTP 응답 캐시
EventHub → WebSocket /api/events → live-events → live-refresh → 다른 탭 query 재조회
```

저장·알림 순서는 server/after-commit, Event 재연결 복구는 useLiveEvents에서 시작합니다.
