# issue-50 레퍼런스 조사: 판 1 대시보드 배치

조사일: 2026-10-14 (Asia/Seoul). 대상: [#50](https://github.com/babo-jeonguk/BaboJUBot/issues/50), parent [#49](https://github.com/babo-jeonguk/BaboJUBot/issues/49). 구현 전 권고이며 확정 계약이나 구현 결과가 아니다. 상세 자료·캡처·실행 로그는 `.reference-cache/issue-50/`에 두며 Git에서 제외한다.

권고의 중심은 전역 홈·Inbox와 조직 화면의 범위를 명확히 표시하고, 읽음·보관과 승인·최종 완료를 분리하는 것이다. 실제 배치는 #50 프로토타입을 사용자가 보고 고른다.

## Brief

- 구현할 문제: 공통 셸의 연구 조직 목록·상태 사이드바, 조직 탭, Inbox, 홈을 비교 가능한 배치로 만든다. #50은 선택한 코드를 `prototype/dashboard-layout` 브랜치에 남기고 사용자 선택·이유를 이슈에 기록해야 한다. 이번에는 조사만 수행한다.
- 동종 문제: 여러 독립 작업 공간의 관찰·개입 대상을 탐색하면서 현재 범위와 쓰기 대상을 잃지 않는 운영 대시보드.
- 고정된 결정: 목표 하나당 독립 조직·전용 Lead, 단일 사용자, [용어](../../GLOSSARY.md), [구조](../architecture.md), [ADR-0004](../adr/0004-paperclip-aligned-stack.md)의 React·Vite·Tailwind·Radix/shadcn·TanStack Query. 초기 연구 승인과 최종 완료는 사용자 결정이며 승인 정책은 조직별 기본 꺼짐이다. UI는 규칙 강제 위치가 아니다.
- 첫 판의 Inbox는 #49/#61의 승인 요청·결과 제출·실패 실행 시도다. [화면 지도](../features.md#웹-대시보드-화면-지도)에 있는 사용자 할 일·예산 경보는 이후 판이다. 외부 job·비용·기억 화면, 다중 사용자 UI, 실험 플래그는 첫 판에서 제외한다. 연구 지도 배치·라이브러리는 후속 #51이다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 조직 목록·생애주기·현재 조직을 어떻게 보이며 전역/조직 탐색을 나누나? | #50 공통 셸, #49 story 4, 화면 지도 | Surface Capture + Source Recon + 교차 조직 전환 |
| Q2 | 조직 탭·상세 화면은 좁은 폭과 깊은 링크에서 범위를 어떻게 유지하나? | #50 탭, 화면 지도 | Surface Capture + Source Recon + 키보드/좁은 폭 |
| Q3 | Inbox에서 주의 필요·안 읽음·작업 중, 읽음·보관·도메인 결정을 어떻게 구분하나? | #49 stories 13/39, #61 | Source Recon + Surface Capture + 빈/실패/결정 후 전이 |
| Q4 | 전체 홈의 조직 개요와 실행 중 수를 조직 대시보드와 어떻게 구분하나? | #50 홈, #49 story 5, #62 | Source Recon + Surface Capture + 집계 범위 |
| Q5 | 사용자 선택을 위해 어떤 비교·검증 시나리오가 필요한가? | #50 AC 1–3, AGENTS 불변 조건 | 공식 예시·인접 운영 UI + 시나리오 종합 |

| 기존 조사 | 재사용 범위 | 재확인·판단 |
|---|---|---|
| [Paperclip 대시보드](paperclip-dashboard.md#조사-방법과-표기) | 셸·Inbox·Dashboard 파일 위치와 기능 분류 | 같은 SHA의 핵심 9개 파일 blob이 기존/이번/worktree에서 같음. 원문 재열람. 기존 정적 조사를 실행 확인으로 올리지 않음 |
| [기타 대시보드](dashboard-references.md#6-babojubot이-고려할-기능--설계-제안-결정-아님) | OpenClaw/Hermes 후보와 scope 문제 | Hermes 고정 소스 재열람; OpenClaw Home은 active agent 범위이므로 전체 홈 사례에서 제외 |
| [#1 조사](issue-1-references.md#brief)·[코드 구조](reference-code-structure.md#전제와-확인-범위) | 스택·module 경계 맥락 | 화면 배치 근거로 사용하지 않음 |
| [비교 목록](comparative-survey.md#23개-후보) | 후보 발견의 출발점 | 이름만으로 관련도를 판단하지 않음 |
| [Paperclip](paperclip.md#확인한-구조와-실제-실행-계약)·[실행 모델](agent-runtime-models.md#핵심-판단)·[상호작용](agent-interaction-models.md#조사-방법과-표기) | 영속 기록·조직·실행 시도 용어 배경 | 새 배치 근거로 재사용하지 않음 |

## 레퍼런스

전체 후보는 34개다(복합 후보 두 개를 분리 계수). 후보별 공개 데모/self-host/없음 경로와 선정·제외 이유는 `candidates.md`에 보존했다. 심층 소스·문서 대상은 아래 7개이며, 공개 UI와 고정 소스의 버전 일치가 확인되지 않은 경우 각각의 근거로 구분했다.

| 관점 | Saturation 근거 |
|---|---|
| 공개 agent 운영 UI | 7개 후보, 3라운드. 마지막 라운드의 새 제품 0개; scope 유지·목록 갱신·자동 펼침 변형과 Home 범위 정정을 재확인했으며 새 패턴 축 없음 |
| 인접 Inbox·운영 UI | 12개 후보, 6라운드. 마지막 tenant/count/filter 검색은 읽음·보관·도메인 상태, 필터 조합, 집계·실시간 범위, 결정 후 전이, 실패 재등장만 재확인 |
| 부품·명세·공식 예시 | 15개 후보, 5라운드. dependency·사용처·issue 확장에서 mobile Sheet, focus/selection, Picker/scroll, URL scope, 실제 콘텐츠 overflow 외 새 해법 없음 |

검색한 관점의 포화를 뜻하며 인터넷 전체 후보 소진을 주장하지 않는다. Q4의 **전체 연구 조직 개요 홈과 정확히 일치하는 공개 실화면 레퍼런스는 조사 범위에서 찾지 못했다**. 아래 홈 권고는 #49 요구와 범위별 집계 사례를 결합한 추론이다.

| 레퍼런스 | 분류 | 고정 SHA·확인일 | 라이선스 | 깊이·선정 이유 |
|---|---|---|---|---|
| Paperclip | OSS agent 운영 | `1b4c803816e82b0265c8422e1a804327a7ed8c54`, 10/14 | MIT | 소스·공식 Storybook 실행. 같은 스택, 셸/Inbox/조직 집계와 반례 |
| Hermes Agent | OSS agent 운영 | `3569e8461ea721623fa16e6f01fb636157989fe6`, 10/14 | MIT | 소스. scope 소실 방지와 행동 대상 배너 |
| shadcn/ui | 부품·공식 block | `30a58d4498f270af1c1e981a7d78a15cf5740841`, 10/14 | MIT | 소스·공개 UI 실행. 확정 스택의 desktop/mobile 분리 |
| Radix Primitives | 부품 | `1d181dce3457e55cb3a64f0901416cf2bde8908d`, 10/14 | MIT | 소스·공개 UI 실행. focus/activation과 테스트 계약 |
| WAI APG | 접근성 안내·예시 | `0f765e4dc33e966026114ac12a8380db1de3b787`, 10/14 | W3C Software and Document License | 고정 안내 원문·공개 manual 예제 실행 |
| Novu / Inbox playground | 알림 부품·공개 예시 | SDK `271d93ecc8da693d91cb0729971f243757482054`, demo `71f3f2a31eb2ae4571b66f3432abf7b9ac5bb6d1`, 10/14 | MIT 범위/enterprise 별도 고지, demo MIT | 소스·공개 필터 메뉴 실행. 상태 분리와 action 오류 반례 |
| Knock / PagerDuty | 상용 인접 운영 | 10/14 공식 문서; 고정 소스 미조사 | 서비스/SDK 재사용 라이선스 미확인 | 문서. tenant별 집계 일치와 작업 중·미해결 구분 |

설계 참고만이며 SDK 도입·코드 복사를 권고하지 않는다. 코드 재사용 시 해당 SHA의 파일 header·NOTICE·함께 들어오는 의존성을 다시 확인하고 AGENTS의 출처/루트 고지 규칙을 적용해야 한다.

## 근거

소스 확인은 구현이 그렇게 쓰였다는 뜻이며 실행 확인과 구분한다. 기존 문서의 Evidence ID를 복제하지 않고 이번 재열람·조작에 번호를 부여했다. 메인 원문 대조는 `main-verification.md`, 캡처 URL·시각·폭·조작은 `captures/captures.md`에 남긴다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | Paperclip 루트는 선택 회사 Dashboard로 이동한다. 전체 조직 개요 홈 사례가 아니다. | [CompanyRootRedirect](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/App.tsx#L681-L703) | 소스 확인 |
| <a id="E02"></a>E02 | Sidebar는 현재 조직 이름을 기준점으로 두고 회사별 liveRuns 길이를 실행 중 수로 표시한다. | [liveRunCount](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/Sidebar.tsx#L69-L90) · [Sidebar](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/Sidebar.tsx#L137-L187) | 소스 확인 |
| <a id="E03"></a>E03 | 회사 선택 목록은 archived 회사를 제외한다. 읽은 메뉴 구간에는 연구 조직의 생애주기 텍스트가 없다. | [sidebarCompanies/selectCompany](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/SidebarCompanyMenu.tsx#L175-L226) | 소스 확인 |
| <a id="E04"></a>E04 | 조직 목록 실패와 정상 0건을 구분하고 실패에는 retry를 제공한다. | [companyListUnavailable](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/SidebarCompanyMenu.tsx#L336-L357) | 소스 확인 |
| <a id="E05"></a>E05 | 회사별 마지막 경로 복원은 route_sync 때 생략한다. URL의 조직을 저장 owner로 삼는다. | [useCompanyPageMemory](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/hooks/useCompanyPageMemory.ts#L29-L78) | 소스 확인 |
| <a id="E06"></a>E06 | 보관 회사로 cold deep link 진입 시 활성 회사로 자동 이동하는 정책이 있다. 완료 연구를 다시 보는 정책과는 별도 판단이 필요하다. | [resolveArchivedCompanyBounce](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/Layout.tsx#L285-L332) | 소스 확인 |
| <a id="E07"></a>E07 | 실패 목록은 agent별 최신 실행 시도를 먼저 고른다. 이후 성공하면 이전 실패가 이 목록에서 제외되는 구조다. 이 전이의 실행 재현은 하지 않았다. | [getLatestFailedRunsByAgent](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/lib/inbox.ts#L738-L750) | 소스 확인 |
| <a id="E08"></a>E08 | 승인 Unread는 pending/revision_requested로 필터하고, badge는 actionable 승인·가입 요청·실패·unread 작업 수를 합친다. | [getApprovalsForTab](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/lib/inbox.ts#L783-L805) · [computeInboxBadgeData](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/lib/inbox.ts#L1271-L1325) | 소스 확인 |
| <a id="E09"></a>E09 | 보관은 companyId별 query에 낙관적으로 반영하며 오류 때 snapshot 복원, 목록과 badge 재조회를 수행한다. | [useInboxDismissals](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/hooks/useInboxBadge.ts#L57-L106) | 소스 확인 |
| <a id="E10"></a>E10 | Hermes는 bare nav에서 scope가 소실되는 문제를 설명하고 explicit URL scope를 우선한다. 다른 profile에 쓰는 상태를 배너로 표시한다. profile은 연구 조직 경계와 다르다. | [ProfileProvider](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/web/src/contexts/ProfileProvider.tsx#L17-L87) · [ProfileScopeBanner](https://github.com/NousResearch/hermes-agent/blob/3569e8461ea721623fa16e6f01fb636157989fe6/web/src/components/ProfileScopeBanner.tsx#L5-L26) | 소스 확인 |
| <a id="E11"></a>E11 | shadcn은 desktop open/mobile openMobile을 분리하고 모바일은 Sheet로 렌더한다. TeamSwitcher는 로컬 선택값만 바꾼다. | [SidebarProvider](https://github.com/shadcn-ui/ui/blob/30a58d4498f270af1c1e981a7d78a15cf5740841/apps/v4/registry/bases/radix/ui/sidebar.tsx#L68-L109) · [mobile Sheet](https://github.com/shadcn-ui/ui/blob/30a58d4498f270af1c1e981a7d78a15cf5740841/apps/v4/registry/bases/radix/ui/sidebar.tsx#L181-L203) · [TeamSwitcher](https://github.com/shadcn-ui/ui/blob/30a58d4498f270af1c1e981a7d78a15cf5740841/apps/v4/registry/bases/radix/blocks/sidebar-07/components/team-switcher.tsx#L31-L84) | 소스 확인 |
| <a id="E12"></a>E12 | Radix Tabs는 focus와 selection, automatic/manual activation을 구분한다. trigger 본인에게서 온 Enter/Space만 처리한다. 관련 upstream 테스트는 읽었으며 실행하지 않았다. | [TabsTrigger](https://github.com/radix-ui/primitives/blob/1d181dce3457e55cb3a64f0901416cf2bde8908d/packages/react/tabs/src/tabs.tsx#L176-L225) · [tabs tests](https://github.com/radix-ui/primitives/blob/1d181dce3457e55cb3a64f0901416cf2bde8908d/packages/react/tabs/src/tabs.test.tsx#L9-L122) | 소스 확인 |
| <a id="E13"></a>E13 | Novu의 isRead/isSeen/isArchived와 custom action completion은 별도 속성·동작이다. | [Notification](https://github.com/novuhq/novu/blob/271d93ecc8da693d91cb0729971f243757482054/packages/js/src/notifications/notification.ts#L21-L44) · [handleClick/handleActionClick](https://github.com/novuhq/novu/blob/271d93ecc8da693d91cb0729971f243757482054/packages/js/src/ui/core/item/controller.ts#L49-L82) | 소스 확인 |
| <a id="E14"></a>E14 | Novu completeAction은 실패를 {error}로 반환한다. controller는 반환 결과 확인 없이 host callback/navigation을 호출한다. 도메인 승인 성공 계약으로 사용하면 안 된다는 권고 근거이며 오류 실행 재현은 하지 않았다. | [completeAction](https://github.com/novuhq/novu/blob/271d93ecc8da693d91cb0729971f243757482054/packages/js/src/notifications/helpers.ts#L323-L368) · [handleActionClick](https://github.com/novuhq/novu/blob/271d93ecc8da693d91cb0729971f243757482054/packages/js/src/ui/core/item/controller.ts#L67-L82) | 소스 확인 |
| <a id="E15"></a>E15 | Paperclip PageTabBar는 모바일이고 value/onValueChange가 있으면 select로 대체한다. 최신 shadcn Radix wrapper는 orientation을 data attribute에만 쓰고 primitive prop으로 전달하지 않는다. | [PageTabBar](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/components/PageTabBar.tsx#L17-L48) · [Tabs wrapper](https://github.com/shadcn-ui/ui/blob/30a58d4498f270af1c1e981a7d78a15cf5740841/apps/v4/registry/bases/radix/ui/tabs.tsx#L8-L22) | 소스 확인 |
| <a id="E16"></a>E16 | 공식 sidebar-07에서 팀 메뉴 열기·다른 팀 표시·desktop 접기·390px Sheet 열기/Escape 닫기를 조작했다. 좁은 폭 전환 때 예제의 팀 표시가 초기값으로 돌아왔다. 제품 조직 전환·영속화 근거가 아니다. | [shadcn 공개 block](https://ui.shadcn.com/view/new-york-v4/sidebar-07); captures/shadcn-*.png, probes/public-capture-log.json | 실행 확인 |
| <a id="E17"></a>E17 | Radix 공식 예제의 Account에 focus 후 ArrowRight로 Password가 선택되고 해당 panel과 focus 테두리가 보였다. | [Radix Tabs 공식 예제](https://www.radix-ui.com/primitives/docs/components/tabs); captures/radix-password.png | 실행 확인 |
| <a id="E18"></a>E18 | APG manual 예제에서 Right는 focus만 이동하고 panel을 유지했다. Space 후 Carl Andersen panel로 바뀌었다. | [APG manual 예제](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/examples/tabs-manual/); captures/apg-manual.png, probes/apg.txt | 실행 확인 |
| <a id="E19"></a>E19 | Paperclip 공식 BlockedInboxView Storybook fixture에서 Tab 키로 승인 판단 행에 focus를 옮기고 1440px 행과 390px 여러 줄 배치를 확인했다. 제목·사유·담당·경과 시간 배치 참고이며 승인 상세/결정 동작은 확인하지 않았다. 예제 query key만 아래처럼 보정했다. | [공식 fixture](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/storybook/stories/blocked-inbox.stories.tsx#L163-L209); captures/paperclip-blocked.png, paperclip-mobile.png | 실행 확인 |
| <a id="E20"></a>E20 | 공식 Storybook empty 상태의 안내를 선택해 확인했다. 정상 0건 안내이며 API 실패/권한 없음의 실화면 근거가 아니다. | [BlockedTabEmptyState](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/storybook/stories/blocked-inbox.stories.tsx#L254-L267); captures/paperclip-empty.png | 실행 확인 |
| <a id="E21"></a>E21 | Novu 공개 playground에서 Inbox 필터 메뉴를 열었다. Unread & read/Unread only/Snoozed/Archived가 보인다. 목록은 loading/empty 표시가 함께 있어 정상 빈 상태 확정 근거에서는 제외했다. | [Novu playground](https://inbox.novu.co/); captures/novu-inbox-empty.png, probes/novu-empty.txt | 실행 확인 |
| <a id="E22"></a>E22 | Knock 공식 문서는 같은 tenant를 목록·badge·실시간에 적용한다고 명시한다. BaboJUBot UI 범위 검증 시나리오의 참고이며 서버 격리 증거가 아니다. | [Knock tenant scoping](https://docs.knock.app/multi-tenancy/tenant-scoping) | 문서 주장 |
| <a id="E23"></a>E23 | PagerDuty의 acknowledged는 작업 중이지만 미해결 상태다. 읽음과 처리 상태를 구분하는 인접 도메인 사례다. | [PagerDuty incidents](https://support.pagerduty.com/main/docs/incidents) | 문서 주장 |
| <a id="E24"></a>E24 | Novu playground의 Send Notification은 실제 cloud API 요청이다. 로컬 mock으로 간주하지 않았으며 전송 버튼을 누르지 않았다. | [POST trigger](https://github.com/novuhq/inbox-playground/blob/71f3f2a31eb2ae4571b66f3432abf7b9ac5bb6d1/src/app/api/trigger/route.ts#L5-L34) · [useNotificationForm](https://github.com/novuhq/inbox-playground/blob/71f3f2a31eb2ae4571b66f3432abf7b9ac5bb6d1/src/app/hooks/useNotificationForm.ts#L29-L45) | 소스 확인 |
| <a id="E25"></a>E25 | Paperclip Dashboard 조회/활동은 선택 companyId별 query다. 조직 미선택·0건·loading·error 분기가 있다. 전체 조직 합계는 이 컴포넌트가 제공하는 사실이 아니다. | [dashboardQueryKey](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/Dashboard.tsx#L161-L187) · [상태 분기](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/ui/src/pages/Dashboard.tsx#L294-L325) | 소스 확인 |

### 실행 조건과 보정

Node 24.21.0, pnpm 10.33.0에서 Paperclip 자체 packageManager가 pnpm 9.15.4를 사용했다. 고정 SHA를 `/tmp/reference-selfhost/issue-50-paperclip/`에 받아 UI 의존성을 `--ignore-scripts --frozen-lockfile`로 설치했다. 설치·서버·브라우저는 키 없는 `env -i`와 각각 `MemoryMax=2G` scope에서 실행했다. 모델 API·제품 서버·DB는 실행하지 않았다.

공식 Storybook 10.6.0의 story 목록을 navigation/blocked/persona 세 파일로 제한했고, Blocked story의 `PrimeBlockedFixtures` 주입 키에 현재 컴포넌트와 같은 `live-descendant-summary`를 추가했다. 실제 `BlockedInboxView`와 `IssueRow`는 수정하지 않았다. 보정 전에는 정상 empty 화면이 나타났다. 초기 브라우저 버전 경로 오류, Storybook config-dir 누락, Vite 최적화 중 timeout도 실행 로그에 보존했으며 동작 부재의 근거에서 제외했다. E19는 보정된 공식 mock 데이터의 배치 관찰이다.

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| P01 | 현재 scope 표시 + scope별 탐색/집계 | E01–E06, E10, E22, E25 | Paperclip company, Hermes profile, Knock tenant. BaboJUBot은 독립 연구 조직 | 쓰기 대상과 숫자의 범위가 명확 | 전환 첫 render의 stale 데이터·늦게 온 응답·범위 없는 링크 |
| P02 | 넓은 화면의 지속 탐색 + 좁은 화면의 drawer/section 선택 | E11, E15–E18 | shadcn Sheet, Paperclip 모바일 select, Radix/APG focus/activation | 내용 폭을 확보하고 키보드 이동 가능 | 아이콘 접기에서 이름·단계 숨김, 많은 탭 넘침, draft 유실, orientation 전달 누락 |
| P03 | 알림 정리·관찰·도메인 결정의 별도 차원 | E07–E09, E13–E14, E21, E23 | Paperclip actionable/unread 혼합, Novu notification completion, PagerDuty acknowledged | 읽음이 승인/최종 완료로 오인되지 않음 | 미결 항목 보관으로 숨김, badge 의미 불일치, 오류 후 성공 이동 |
| P04 | 행의 제목·사유·담당·시간을 폭에 맞게 배치 | E19–E20 | Paperclip desktop columns → mobile 여러 줄. BaboJUBot 전역 행은 조직명 추가 필요 | 다양한 사건을 한 큐에서 비교 | 상세 검토 없이 행 버튼으로 결정, 빈 상태와 실패 혼동 |
| P05 | 전체 운영 개요와 조직의 연구 진행 화면 분리 | E01–E02, E22, E25, #49/#62 | 읽은 agent 제품의 Home은 대개 선택 조직/agent. 전체 홈은 요구에서 도출 | 전체 조직 개요와 실행 중 수의 의미 유지 | 작업 중 task 수를 run 수로 표시, 한 조직 값만 전체 합계처럼 표시 |

## 결정 권고

아래의 채택은 조사 권고이며 #50의 사용자 선택이나 구현 계약 확정을 대신하지 않는다.

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| D01 | 변형 채택 | 전역 홈·Inbox·전역 설정과 연구 조직 목록을 구분. 조직 행에 이름과 생애주기 텍스트, 선택 상태를 표시. 배치 A/B는 사용자 비교 | P01, E02–E03, #49 | 단계는 색만으로 알 수 없어야 함. 항상 보이는 목록은 공간 비용, switcher는 여러 조직 관찰 비용 | Q1,Q5 |
| D02 | 채택 | 조직 화면·상세·쓰기 대상에 같은 조직 ID와 이름을 유지. 직접 링크가 저장 선택보다 우선하며 stale 응답은 새 조직 화면에 붙이지 않음 | P01, E05,E10,E22 | URL/cache/event 범위를 맞추되 서버 격리·승인은 Control Plane이 강제 | Q1,Q2,Q5 |
| D03 | 변형 채택 | 조직 상위 목적지 8개: 대시보드·Lead 대화·활동·작업·연구 지도·에이전트·결과 검토·설정. 실행 시도 상세는 활동/에이전트에서 들어가는 상세 경로. 8탭 scroll과 모바일 section select를 비교 | P02, E15–E18, 화면 지도 | 작은 폭과 긴 한국어 제목을 실제 자료로 비교. route 탐색은 링크 의미를 유지하고, panel tab은 Radix/APG 동작으로 검증 | Q2,Q5 |
| D04 | 변형 채택 | Inbox 항목 하나에 조직·종류·관련 기록·읽음·보관·도메인 처리 상태를 구분. 주의 필요/안 읽음/작업 중은 동일 항목의 필터로 비교 | P03, E13,E23, #61 | 필터 겹침 여부와 작업 중 정의는 #61 소유. 읽음과 결정은 항상 구별 | Q3,Q5 |
| D05 | 배제 | Paperclip의 agent별 latest 실패만 남기기와 actionable을 Unread라고 부르는 분류를 그대로 복사하지 않음 | E07–E08, #49/#61 | 새 성공이 실패 기록을 없애는 것처럼 보이지 않게 할 필요. 실패 항목 유지/자동 해소 정책은 #61에서 결정 | Q3 |
| D06 | 채택 | 도메인 결정의 요청 중·성공·실패를 표시. 승인 실패면 성공 이동/완료 표시 금지. 보관 실패는 원상태·재시도 가능 상태로 복원 | E09,E14, AGENTS | 알림 CTA completion은 승인 엔진이 아님. 상세에서 대상 계획·팀·환경 또는 완료 기준·산출물을 확인 | Q3,Q5 |
| D07 | 변형 채택 | 전체 홈에는 조직 개요와 **실행 중 실행 시도 수**. 조직 대시보드는 그 조직 지표·14일 차트·에이전트·최근 활동. 프로토타입에서 A=2/B=1이면 홈=3을 보임 | P05, E02,E25, #49/#62 | 전체 홈 정확 동종 실화면 없음. 요구를 충족하는 집계·배치 제안으로 명시 | Q4,Q5 |
| D08 | 채택 | 정상 0건·loading·조회 실패·찾을 수 없는 조직/기록을 구분. 실패를 조직 없음/실행 중 0으로 표시하지 않음 | E04,E20,E25 | 마지막 정상 자료를 유지한다면 갱신 실패를 함께 표시. 상태별 실제 UI 검증 필요 | Q1–Q5 |
| D09 | 보류 | 최종 셸·탭 순서·Inbox 상세 배치·badge 기준·전환 시 복원·완료 조직 표시 | P01–P05, #50 AC | 선택지는 아래 표. 사용자가 실제 프로토타입을 확인하고 고른 뒤 #50 댓글에 이유 기록 | Q1–Q5 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 회사 Dashboard를 전체 조직 홈으로 간주 | E01,E25 | 집계 범위가 다름 |
| 로컬 TeamSwitcher 선택 표시만으로 조직 전환 완료 판단 | E11,E16 | 본문·URL·데이터 범위가 연결되지 않음 |
| 읽음·알림 CTA 완료를 연구 승인/최종 완료로 간주 | E08,E13–E14 | 제품 불변 조건은 도메인 경로가 강제 |
| 보관/최종 완료 조직 deep link를 다른 조직으로 자동 이동 | E06 | 완료 연구 열람 정책이 없으며 다른 조직의 쓰기 문맥을 만들 위험 |
| Placeholder 셸만으로 배치 검증 완료 | E16, P02 | 실자료·긴 한국어·실제 table/map/실패 상태의 폭을 검증하지 않음 |
| 예산·사용자 할 일·다중 사용자·Paperclip 실험 화면을 첫 판에 추가 | #49 Out of Scope | #50은 첫 판의 공통 배치가 범위 |

## 구현 참고

권고안의 기준 배치는 **A: 전역 탐색 + 조직 목록·단계 사이드바 + 조직 헤더·탭 + 본문**이다. 사용자 선택 전 기본 비교 출발점이며 확정 배치가 아니다. 아래 B를 같은 자료로 비교한다.

| 열린 결정 | owner | 비교 선택지·근거 |
|---|---|---|
| 셸·조직 탐색 | 사용자/#50 | A 항상 보이는 조직 이름·단계 목록: 여러 조직 관찰에 유리, 세로 공간 필요. B 조직 switcher + 선택 조직 화면: 본문 폭/밀도에 유리, 다른 조직 상태는 메뉴/홈을 열어야 함(E02,E11,E16) |
| 조직 탭과 좁은 폭 | 사용자/#50 | 8개 전체 가로 탭+scroll: 목적지를 드러내지만 overflow. 가로 탭+모바일 select: 폭 확보, 목적지 한눈 비교 감소(E15,P02). 탭 순서는 Lead 대화/지도/활동의 실제 방문 작업으로 선택 |
| Inbox 상세 | 사용자/#50 | 별도 상세 화면: 계획·환경/완료 기준·산출물 검토 공간 큼. 목록+오른쪽 상세 패널: 큐 문맥 유지, 390px에서는 전체 상세로 전환 필요(P03–P04). 행의 승인 버튼만으로 복합 제안을 처리하는 안은 권고하지 않음 |
| 배지 숫자 | 사용자/#61 | 주의 필요 수(개입 판단), 안 읽음 수(확인), 두 수를 라벨과 분리 표시. 필터 겹침·중복 계수·보관된 미결 표시 정책을 #61에서 확정(E08,E13,E23) |
| 작업 중 의미 | #61 | 도메인 후속 처리 진행인지 사용자 처리 중인지, 실패 재시도와 미결 항목 보관 허용을 확정. 신규 claim 상태는 이번 조사로 추가하지 않음 |
| 조직 전환 경로·완료 조직 | 사용자/#50 | 조직 대시보드로 시작 vs 마지막 방문 복원. 직접 링크 우선은 공통. 완료 조직은 목록 유지 vs 접은 완료 묶음으로 비교(E05–E06) |

구현 위치는 [구조](../architecture.md#패키지-구성)의 Surface인 `apps/web`이 기준이다. #50의 버려도 되는 코드는 이슈가 지정한 `prototype/dashboard-layout` 브랜치에 둔다. 이번에는 브랜치나 프로토타입을 만들지 않았다. 화면 조회/구독/사용자 제어 명령 seam만 연결하고 `packages/core`의 승인·생애주기·조직 규칙을 UI에 복제하지 않는다.

| ID | 프로토타입에서 검증할 경계: 입력 → 행동 → 기대 | 근거 |
|---|---|---|
| V01 | 조직 0/1/12개, 긴 이름, 각 생애주기 → 홈/목록/전환 → 현재 조직과 단계 텍스트 확인, 완료 조직에 다시 접근 | D01,D09 |
| V02 | A 상세를 보던 중 B 선택, A의 지연 응답/이벤트 도착 → B 헤더·본문·쓰기 대상 일치, A 상세 ID를 B로 복제하지 않음 | D02 |
| V03 | B 상세 직접 링크·새로고침·뒤로가기, 존재하지 않는 조직/다른 조직 기록 ID → 명시 범위 유지 또는 찾을 수 없음, 다른 조직으로 자동 쓰기 이동 금지 | D02,D08 |
| V04 | 1440/768/767/390px + 8개 한국어 목적지 → 탭/Sheet/select 및 Tab·화살표·Enter·Escape 조작 → 현재 목적지/조직 노출, 전역 가로 overflow 없음, draft 보존 정책 확인 | D03 |
| V05 | 초기 승인 열기·읽음/보관 → 아직 도메인 미결. 상세에서 계획·팀·환경 함께 검토 → 승인/반려/수정 요청 이후 결과 표시 | D04,D06 |
| V06 | 결과 제출 열기·읽음 → 최종 완료 아님. 완료 기준/산출물 검토 → 사용자 수정 요청 또는 최종 완료 결과 표시 | D04,D06 |
| V07 | 승인/보관 요청 pending·중복 클릭·오류 → 이중 결정/성공 이동 없음, 실패와 재시도 표시. 이미 결정한 요청은 재결정 UI를 표시하지 않음 | D06 |
| V08 | 실패 뒤 같은 agent 성공/재시도 → 원 실패 실행 시도 상세 접근 유지, 알림 정리와 실행 이력을 구분 | D05 |
| V09 | A 실행 중 2/B 1, 작업 상태는 별도 → 전체 홈 3/조직 A 2. loading/실패에서는 확정 0으로 오인시키지 않음 | D07–D08 |
| V10 | 승인 대기·결과 검토·일시정지·중단·최종 완료 자료 → 이름/단계/가능한 제어 구분, 초기 승인과 최종 완료를 끄는 UI 없음 | D01,D06, AGENTS |

이 표는 #50 배치 평가용 시나리오다. 승인 중복·조직 분리·생애주기 **제품 강제 검증**은 #53–#60 API, 실시간·집계는 #61/#62, 흐름 전체 E2E는 #63에서 수행한다. 프로토타입의 disabled 버튼만으로 불변 조건을 검증했다고 보고하지 않는다.

## 한계와 미확인

- 이번에 실행한 범위: 공개 shadcn Sidebar, Radix 자동/ APG 수동 탭, Novu 필터 메뉴, 보정된 Paperclip Storybook 목록·빈 상태의 표면 관찰. 캡처는 메인이 직접 열어 확인했으며 타사 이미지를 Git/이슈에 올리지 않는다.
- 미실행: 제품/프로토타입 코드, 제품 테스트, upstream 테스트 실행, Paperclip 실제 backend/DB/승인 결정/영속 read/archive, 실제 조직 전환·권한 없음·오류 실화면, 전체 홈 실화면, 화면 reader 검증, Firefox/WebKit, 767/768px 경계, 실제 모델/API 호출. UI 실패 경로는 주로 소스 확인과 검증 제안이다.
- Novu Send Notification은 cloud 전송이므로 미클릭. 로그인·계정이 필요한 Linear/GitHub/GitLab/Asana/Sentry/PagerDuty와 credential SDK는 문서만 봤다. shadcn 현재 radix-nova 공개 경로는 메뉴를 찾지 못해 캡처 근거에서 제외했고, 실행은 명시한 new-york-v4 공개 block에 한정했다.
- Paperclip 일부 Storybook fixture에는 skills/routines 404, 전체 페이지 story 로딩 불안정이 있었다. 보정된 Blocked 목록 외 셸 전체·Dashboard의 시각 동작을 실행 확인으로 올리지 않는다. 소스와 실제 화면을 구분한다.
- 기존 자료와 같은 Paperclip SHA를 사용했다. 새 upstream 버전의 동작은 보증하지 않는다. 공개 demo 배포 SHA와 고정 소스 SHA의 일치는 미확인이다. 코드 복사 전 파일·의존성 라이선스/NOTICE 확인이 필요하다.
- 사용자 배치 선택·이유 기록·prototype primary source는 미완료다. #50을 닫거나 acceptance criterion을 완료 표시하지 않는다.
