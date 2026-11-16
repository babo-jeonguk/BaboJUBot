# issue-144 레퍼런스 조사: 승인·결과 검토의 결정 표시와 캐시 갱신 공통화

조사 범위는 같은 결정 원본을 상세와 Inbox에서 다룰 때의 표시·포커스·캐시 수렴과 검증 방법이다. 종류별 제품 규칙은 [#144](https://github.com/babo-jeonguk/BaboJUBot/issues/144), 강제 위치는 [구조](../architecture.md)와 [ADR-0005](../adr/0005-approval-policy-enforcement-scope.md)가 기준이다.

최초 조사: 2026-11-10. 재확인·보완: 2026-11-12. 구현 전 기술 권고이며 확정 계약이나 구현 결과가 아니다. 조사 문서는 구현 변경과 함께 커밋했으며 적용 결과는 [구현 기록](issue-144-implementation.md)에 있다. 상세 조사와 실행 로그는 Git 제외 로컬 캐시에 보관했다.

## Brief

- 구현할 문제: 승인·결과 검토의 중복된 결정 표시와 캐시 정책을 모으면서, 각 폼의 허용 결정·사유·작업자 선택·최종 완료 재확인을 보존한다.
- 동종 문제: 여러 화면이 같은 결정 원본을 조작할 때, 저장된 상태와 이번 화면의 요청 성공 출처를 구분하여 폼을 기록으로 바꾸고 관련 조회를 수렴시키는 메커니즘.
- 고정된 결정: #144 Implementation Decisions 전부. 로컬 성공만 기록에 포커스를 옮긴다. 일반 실패는 초안을 보존한다. 성공 단건 응답 반영 후 조직/Inbox를 무효화하고 `already_decided`도 재조회한다. Inbox variant는 스타일만 고른다. 범용 mutation/폼은 만들지 않는다. 초기 승인·최종 완료·조직 경계는 서버가 강제한다.
- 현재 기준: 원격 main과 로컬 HEAD 모두 `983dbc5a4e9342c460f081a4888250e6634522c6`(2026-11-12 조회). 현재 #144 본문과 기존 receipt 댓글 1개를 다시 읽었다. 현재 parent 없음(404), blocker 빈 배열도 재확인했다. 과거 기준은 `c88a98b58284a38bdadf7eff7aafa0219005371c`이며 아래 E01–E12의 최초 관찰과 실행 날짜는 2026-11-10이다. 현재 관찰은 E13–E18로 분리한다. #142·143·145·146은 선행 blocker로 추가하지 않는다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 로컬 성공과 외부 갱신·already_decided를 구분하여 포커스와 비간섭을 어떻게 구현하는가? | #144 구현 전 조사 1, 사용자 이야기 1–4 | Source Recon + Behavioral Recon + 접근성 문서 |
| Q2 | 단건 응답 반영·조직/Inbox 무효화·경쟁 재조회를 공유하면서 도메인 폼/API를 유지하는 패턴은? | #144 구현 전 조사 2, 캐시 정책 결정 | Source Recon + API 계약 + runtime/failure probe |
| Q3 | 기존 인라인 Escape/취소·필드 오류·첫 오류·셸/Inbox 포커스의 책임을 보존하며 두 화면에서 어떻게 검증하는가? | #144 구현 전 조사 3, Testing Decisions | Source Recon + 기존 E2E 실행 + 공개 데모 Surface Capture |

| 기존 조사·자산 | 재사용 범위 | 재확인·제외 판단 |
|---|---|---|
| [Inbox 상세 조사](inbox-detail-references.md#근거) | Airflow/OpenClaw/APG 후보와 경쟁 시나리오 | 요약만으로 채택하지 않고 원문 재열람. 과거 Airflow 실행·캡처는 이번 실행 수에 포함하지 않음 |
| [대시보드 조사](dashboard-references.md), [Paperclip 화면](paperclip-dashboard.md) | 운영 화면 맥락 | 전역 배치가 범위 밖이므로 배치 권고 재채택 안 함 |
| [판 2 디자인 가이드](design-guidelines-pan2.md) | 작업자 선택과 초안의 배경 | 기존 선택 정책 유지. 새 화면 배치 근거로 확대하지 않음 |
| [#58](issue-58-references.md#D08), [#61](issue-61-references.md#P07) | 경쟁 재조회·결정과 정리 분리 | 과거 E ID를 새 근거로 옮기지 않음. 현재 범위는 #144와 E01 기준 |
| 기존 결정·작업자 선택 E2E | 실제 API/Event·실패 주입 검사 | 과거 E08 두 실행은 역사 기록. 현행 기존 8개·추가 6개는 E17–E18. 승인 비간섭·늦은 응답은 여전히 미확인 |
| #140–143 조사 | 서버 수명·잠금·사용자 행동 조립 | 서버 공통화는 이번 범위 밖. 문서·결정 수정 안 함 |

## 이번 재확인과 재사용 판단

현재 권고는 D01–D09다. 공통 결정 경험과 종류별 의미를 분리한다는 철학·범위를 유지하며 확정 계약과 충돌하는 새 권고는 없다. 과거 D06의 취소 복귀는 이제 선택적 보강이 아니라 현재 계약과 기존 기능 보존 요구다. 서버·환경 점검·승인 차단 조건을 추가하지 않는다.

- [x] 1 Brief
- [x] 2 Discovery — 기존 후보 16개를 출발점으로 부족한 현행 책임만 추적
- [x] 3 Recon — 현재 제품과 기존 고정 외부 원문 대조, 브라우저 조작
- [x] 4 Synthesis
- [x] 5 Receipt — [기존 댓글](https://github.com/babo-jeonguk/BaboJUBot/issues/144#issuecomment-6765416643) 수정 후 재조회·본문 일치 확인

| 질문 | 기존 근거 재사용 | 이번 보강·종료 판단 |
|---|---|---|
| Q1 | E02–E03 출처/요청 identity와 경쟁 검사 구조, E06 callback 수명 재사용. OpenClaw의 외부 terminal focus는 계속 배제 | E13·E17·E18로 현재 로컬 성공, 외부 Event, 결과 stale 409를 구분. 외부 최신 버전 탐색 대신 동일 고정 사례를 재열람했다. 현재 계약을 바꾸는 새 패턴이 없어 종료 |
| Q2 | E04–E06·E11–E12 재사용. 설치 Query 5.104.3 핵심 세 파일은 기존 고정 SHA와 byte 동일. E07 과거 5 PASS는 신규 실행으로 세지 않음 | E14로 단건→무효화, 항목 key, 초안 정리·mutation observer 수명 재확인. 라이브러리 교체/전역 mutation은 범위 밖이며 추가 후보 불필요 |
| Q3 | E10 모달 지침은 논리적 복귀의 보조 근거만, E11 identity·E12 DOM assertion 재사용. E09 APG 캡처는 과거 모달 관찰 | E15–E17의 현재 인라인·오류·셸/Inbox로 보강. 호출 경로와 기존 E2E를 따라가니 새 폼/모달 프레임워크 없이 기존 담당으로 설명 가능하여 종료 |

제품의 `approvals.tsx`·`results.tsx`·`api.ts`·`inbox-detail.tsx`·`ui.tsx`·`shell.tsx`·`inbox.tsx`·`provider-choice.tsx`는 이전 기준과 blob이 달라 현재 원문을 다시 읽었다. `choice-problems.ts`, `shell-focus.spec.ts`, `keyboard-a11y.spec.ts`는 이후 추가되었다. 기존 결과/Inbox 결정 E2E 두 파일은 blob 변경 없음이지만 주변 구현 변경 때문에 새로 실행했다. 외부 사례는 아래 고정 ref를 유지해 재열람했으며 upstream 최신과 동일하다는 주장은 하지 않는다.

## 레퍼런스

관점별 saturation은 조사한 범위의 포화이며 전수조사가 아니다. OSS 관점은 기존 후보에서 시작해 stale/409 검색, 인접 도구의 invalidate·초안으로 확장했다. 마지막 라운드의 react-admin·Hermes·revu는 부분 invalidate·만료·초안이라는 기존 축만 더했다. 캐시 관점은 현재 라이브러리의 응답 반영/무효화에서 callback 수명·공유 mutation 대안으로 확장했다. 접근성 관점은 APG/WCAG에서 React identity·Playwright 검증으로 확장했다. 마지막 라운드가 추가한 사례는 이미 발견한 출처·상태 수명·최종 DOM 검증 축의 반복이었다. 후보별 검색·실행 경로는 로컬 후보 기록에 남겼다.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이·선정 이유 |
|---|---|---|---|---|
| OpenClaw | 승인 OSS | `1b93d1ea5dee6deaf91c28140571ba5eda00dd68` | MIT | 소스: 출처 구분과 외부 포커스 반례, 두 화면 경쟁 E2E |
| Apache Airflow | HITL OSS | `8bdb287f7ee587a5ca6d642e59979bf4576c4a3e` | Apache-2.0 | 소스: 공유 mutation·요청 identity·stale 거부 |
| Paperclip | 승인 OSS | `def4726bea0e3b340457100038d80ca55c2b7d4f` | MIT | 얕은 소스: callback 표시 seam. 필수 사유/재확인 근거로 부적합 |
| TanStack Query | 사용 중인 캐시 라이브러리 | 5.104.3, `ee47993724e5b71e65d9f38ae416367d2dd18395` | MIT | 소스·실행: 실제 설치 버전의 callback·재조회 동작 |
| W3C APG/WCAG | 접근성 공식 예제·지침 | APG `0f765e4dc33e966026114ac12a8380db1de3b787`, 공개 예제 2026-11-10 확인 | W3C Software and Document License | 문서·공개 실행: 확인 취소와 포커스, 상태 안내 |
| React / Playwright | UI identity / 동작 검사 | React 문서 `7594a2b008489121bdf25f97320d11ac0422510e`, Playwright 문서 `ce480a952553175eae75342aad2c5e86cdf2cbba` (실행 1.64.1) | CC-BY-4.0 / Apache-2.0 | 문서: key 수명, 사용자 관점 assertion |

설계 참고만 한다. OSS 코드 복사나 새 의존성 도입은 권고하지 않는다. Airflow는 기존 조사와 같은 ref를 재열람했다. OpenClaw는 구 ref의 `approval-page.tsx` blob `f87a94208ecc84820b27a2287918a0f78d7ca609`에서 새 ref의 `ca887bf6c7d5dd0c3d621c50bf112a9595a3a11e`로 변경되어 새 원문을 읽었다. 과거 문서의 변경 없음 주장을 승계하지 않는다.

## 근거

E01–E12는 2026-11-10 최초 조사 기록이다. 소스 재사용 여부는 위 표를 따르며 E07–E09의 PASS·캡처는 과거 실행이다. 현재 실행은 E17–E18이다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 현행 두 결정 컴포넌트는 로컬 성공 callback으로 decidedHere를 세우고 기록의 effect에서 focus한다. 단건 응답을 setQueryData한 뒤 org prefix/Inbox를 void invalidate한다. 의견은 로컬, 작업자 초안은 org/approval Map, Inbox Summary는 org/source key로 분리한다 | 기준 SHA의 [승인](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/apps/web/src/approvals.tsx), [결과](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/apps/web/src/results.tsx), [API 908–989](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/apps/web/src/api.ts#L908-L989), [Inbox 57–72](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/apps/web/src/inbox-detail.tsx#L57-L72) | 소스 확인 |
| <a id="E02"></a>E02 | OpenClaw는 observed/here/elsewhere와 operation generation을 분리하지만, 외부 poll의 terminal 전환과 applied=false 응답에도 terminal focus를 실행한다. 출처 분리와 포커스 정책은 별개의 선택이다 | [loadApproval·resolveApproval](https://github.com/openclaw/openclaw/blob/1b93d1ea5dee6deaf91c28140571ba5eda00dd68/ui/src/pages/approval/approval-page.tsx#L220-L352) | 소스 확인 |
| <a id="E03"></a>E03 | OpenClaw 경쟁 E2E는 mobile/desktop 두 context에서 반대 입력을 보내고 응답을 보류한 뒤 canonical winner를 두 화면에 준다. 버튼 제거와 winner focus/viewport를 검사한다. 읽은 구간은 loser의 비간섭 focus를 assert하지 않는다 | [keeps one canonical winner…](https://github.com/openclaw/openclaw/blob/1b93d1ea5dee6deaf91c28140571ba5eda00dd68/ui/src/e2e/approval-page.e2e.test.ts#L253-L337) | 소스 확인(미실행) |
| <a id="E04"></a>E04 | Airflow 공유 mutation은 성공 후 관련 key 무효화 완료를 기다려 callback을 호출하고 오류에도 stale HITL을 재조회한다. #144와 달리 단건 응답 반영 경로는 여기서 확인하지 못했다 | [useUpdateHITLDetail](https://github.com/apache/airflow/blob/8bdb287f7ee587a5ca6d642e59979bf4576c4a3e/airflow-core/src/airflow/ui/src/queries/useUpdateHITLDetail.ts#L44-L106) | 소스 확인 |
| <a id="E05"></a>E05 | Airflow는 새 요청 identity에 key를 바꾸고 최초 created_at을 ref로 전송한다. 반면 폼 isSubmitting은 mutate 호출 직후 false가 되고 비동기 isPending을 소비하지 않는다. 이 경로만으로 네트워크 중복 방지 보장은 할 수 없다 | [폼 key](https://github.com/apache/airflow/blob/8bdb287f7ee587a5ca6d642e59979bf4576c4a3e/airflow-core/src/airflow/ui/src/components/HITLReview/HITLReviewDetail.tsx#L47-L59), [폼 제출](https://github.com/apache/airflow/blob/8bdb287f7ee587a5ca6d642e59979bf4576c4a3e/airflow-core/src/airflow/ui/src/pages/HITLTaskInstances/HITLResponseForm.tsx#L62-L108) | 소스 확인, 중복 위험은 추론(미재현) |
| <a id="E06"></a>E06 | Query의 invalidate는 일치 key를 stale로 만들고 기본 active만 refetch한다. mutation 공통 callback과 observer의 per-call callback은 다른 수명이다. per-call callback은 listener가 남아 있을 때 실행한다 | [queryClient](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/packages/query-core/src/queryClient.ts#L494-L514), [mutationObserver](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/packages/query-core/src/mutationObserver.ts#L250-L310), [mutation](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/packages/query-core/src/mutation.ts#L360-L440) | 소스 확인 |
| <a id="E07"></a>E07 | 설치 5.104.3 query-core probe 5개: 성공 단건→org/Inbox 무효화, 외부 setQueryData의 로컬 성공 없음, already_decided의 로컬 성공 없음, unsubscribe 뒤 공통 callback만 실행, active/inactive 및 invalidate Promise 대기 확인 | 키 없는 셸, 합성 QueryClient/MutationObserver 로컬 probe(Node v24.21.0), 5 PASS. probe·결과는 로컬 실행 로그. React DOM·Event 순서는 검사하지 않음 | 실행 확인 |
| <a id="E08"></a>E08 | 기존 승인 stale Inbox 경쟁과 결과 검토 E2E 두 개를 수정 없이 실행: 2 passed(19.0s), exit 0. 결과 실패 의견 유지, 재제출, 390px 버튼, 다른 화면의 최종 완료와 로컬 성공 focus, 승인 409 canonical 기록을 확인 | Playwright 1.64.1, Chromium, 임시 embedded Postgres, fake providers 2. [inbox.spec](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/apps/web/e2e/inbox.spec.ts#L475-L509), [result-review.spec](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/apps/web/e2e/result-review.spec.ts#L81-L150) | 실행 확인 |
| <a id="E09"></a>E09 | APG 공식 Alert Dialog 데모: 합성 초안 입력→Discard로 확인 단계. No 초기 focus, Enter 취소/재열기/Escape에서 초안 유지·notes textarea 복귀, Tab은 Yes, Yes에서 초안 제거. 1280/390px 확인 단계 직접 캡처·메인 재열람, 390px scrollWidth=390 | [공식 공개 예제](https://www.w3.org/WAI/ARIA/apg/patterns/alertdialog/examples/alertdialog/), Playwright 1.64.1 Chromium. 실행은 이 예제의 모달 동작에 한정 | 실행 확인 |
| <a id="E10"></a>E10 | APG는 되돌리기 어려운 결정에서 덜 파괴적인 행동의 초기 focus와, 닫을 때 작업 흐름상 논리적인 복귀점을 설명한다. WCAG 상태 메시지는 focus 이동 없이도 보조기술이 인지하도록 프로그램적으로 표현하도록 한다 | [APG Dialog 원문](https://github.com/w3c/aria-practices/blob/0f765e4dc33e966026114ac12a8380db1de3b787/content/patterns/dialog-modal/dialog-modal-pattern.html#L79-L113), [WCAG Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) | 문서 주장. 외부 갱신 비간섭은 #144 제품 규칙 |
| <a id="E11"></a>E11 | React는 key 변경으로 컴포넌트 상태를 초기화하며, 사라진 하위 트리의 state는 별도 저장하지 않으면 유지되지 않는다고 설명한다 | [Preserving and Resetting State 원문](https://github.com/reactjs/react.dev/blob/7594a2b008489121bdf25f97320d11ac0422510e/src/content/learn/preserving-and-resetting-state.md#L1120-L1235) | 문서 주장 |
| <a id="E12"></a>E12 | Query 공식 문서는 mutation 응답의 setQueryData와 성공 후 invalidate를 설명한다. Playwright는 사용자 관점 locator·재시도 assertion을 제공한다 | [응답 반영](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/docs/framework/react/guides/updates-from-mutation-responses.md#L6-L58), [무효화](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/docs/framework/react/guides/invalidations-from-mutations.md#L18-L45), [Playwright 검사](https://github.com/microsoft/playwright/blob/ce480a952553175eae75342aad2c5e86cdf2cbba/docs/src/test-assertions-js.md#L14-L56) | 문서 주장 |

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E13"></a>E13 | 승인·결과의 per-call onSuccess만 decidedHere를 세우고 기록 mount effect가 focus한다. 외부 Event의 query 갱신·already_decided 오류에는 이 신호가 없다 | [ApprovalDecision·DecisionForm·DecisionReceipt](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/web/src/approvals.tsx#L315-L746), [ResultDecision·DecisionForm·DecisionReceipt](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/web/src/results.tsx#L225-L397) | 현재 소스 확인 |
| <a id="E14"></a>E14 | 두 hook 모두 단건 setQueryData 뒤 org prefix/Inbox를 void invalidate. already_decided만 같은 refresh. 의견·확인·decidedHere는 항목 로컬, 작업자 Map은 org/approval별이며 로컬 성공 callback에서 정리. 상세 item id와 Inbox org/source key는 유지 | [useDecideApproval·useDecideResult](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/web/src/api.ts#L937-L1018), [초안·성공 정리](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/web/src/approvals.tsx#L344-L700), [Inbox key](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/web/src/inbox-detail.tsx#L53-L72) | 현재 소스 확인. 언마운트 후 draft 정리를 새로 보장한다는 뜻 아님 |
| <a id="E15"></a>E15 | useInlineConfirm은 cancel 때만 cancelled=true로 트리거 ref 복귀, locked면 취소 무시. 결과 폼이 group/Escape·취소 autofocus·isPending 잠금을 연결한다. 성공은 폼이 기록으로 교체되며 cancel을 호출하지 않음. 필드 오류는 승인 폼이 변경한 선택만 검사하고 서버 선택 거부 때 목록 재조회 후 첫 오류 focus, ProviderChoiceFields가 aria-invalid/describedby를 생성 | [useInlineConfirm](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/web/src/ui.tsx#L379-L422), [결과 폼](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/web/src/results.tsx#L265-L373), [승인 오류](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/web/src/approvals.tsx#L644-L719), [choice-problems](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/web/src/choice-problems.ts), [ProviderChoiceFields](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/web/src/provider-choice.tsx#L136-L215) | 현재 소스 확인 |
| <a id="E16"></a>E16 | 경로 이동은 useRouteFocus, 도킹 패널은 heading focus/열었던 trigger 복귀, 좁은 drawer는 Radix dialog와 onCloseAutoFocus/focusLost가 담당. 결정 표시가 이들을 소유하지 않는다 | [useRouteFocus](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/web/src/shell.tsx#L215-L260), [InboxPanel·DockedPanel·focusOpener](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/web/src/inbox.tsx#L180-L253) | 현재 소스 확인 |
| <a id="E17"></a>E17 | 현행 기존 E2E 8개를 캐시 복사본에서 실행해 8 passed(37.6s). 추가 조사 probe는 상세/Inbox × 1280/390px에서 완료 인라인 확인을 조작·캡처, Escape/취소 후 트리거 focus·POST 0, 전송 보류 중 취소 disabled/Escape 무효, 해제 후 POST 1·주소 유지·기록 focus를 확인(2 passed). 모델 오류 캡처 포함 새 캡처 7장을 메인이 직접 열람 | 기존 [shell-focus](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/web/e2e/shell-focus.spec.ts), [keyboard-a11y 필드 오류](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/web/e2e/keyboard-a11y.spec.ts#L440-L518), [결과](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/web/e2e/result-review.spec.ts#L7-L150), [승인 stale](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/web/e2e/inbox.spec.ts#L475-L509). 추가 probe는 제품 E2E에 편입하지 않은 임시 조사 시나리오 | 2026-11-12 실행·실화면 확인. 기존 field error 검사는 모델/목록/오류 응답을 route로 합성 |
| <a id="E18"></a>E18 | 상세/Inbox에서 실제 API 선행 complete 뒤 stale request_changes가 실제 409를 받고 canonical 기록으로 수렴, 갱신 전부터 focus한 생존 홈 링크 유지. 별도 Event 구독 화면도 API complete 후 같은 생존 링크 focus·주소 유지. 4 passed | 현재 SHA의 제품 + 조사용 브라우저 probe. WS 차단한 409와 실제 Event 구독을 분리. 최초 409 probe 두 실패는 focus 불가능한 h1 선택 오류였고 링크 focus 사전 단언을 추가해 재실행 | 2026-11-12 실행 확인. 승인 외부 비간섭 전체를 검증한 것으로 확대하지 않음 |

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 도메인 상태와 로컬 요청 성공 출처 분리 | E01–E03,E06–E07 | OpenClaw는 elsewhere도 focus, #144는 금지 | 재조회가 성공으로 오인되지 않음 | status→decidedHere effect는 외부 focus 탈취 |
| <a id="P02"></a>P02 | 개별 mutation 계약 + 작은 캐시 정책 | E01,E04,E06,E12 | Airflow는 await invalidate, 현행은 void | 중복 제거와 종류별 입력 보존 | 반환 Promise 추가로 pending/언마운트 시점이 달라짐 |
| <a id="P03"></a>P03 | 로컬 상태의 identity와 보존 초안의 수명 분리 | E01,E05,E11 | 여기서는 org/approval draft, Airflow는 task/request | 항목 간 입력·확인 누수 방지 | status를 key로 넣으면 실패/조회 때 초안 소실 가능 |
| <a id="P04"></a>P04 | 실제 결과·포커스·전송값을 함께 검사 | E03,E08,E12 | OSS mock gateway와 이 프로젝트 실제 API/Event를 구분 | 경쟁·비간섭을 사용자 관점에서 검증 | 기록 텍스트만 검사하면 focus·요청 중복은 빠짐 |
| <a id="P05"></a>P05 | 확인의 초기 focus·취소 복귀·상태 안내를 각각 검사 | E09–E10 | APG 모달과 현행 inline group은 다름 | 실수 방지와 키보드 흐름 보존 | 모달 focus trap/Escape를 inline 확인에 무조건 이식하면 범위 확대 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | 공통 표시 모듈은 자기 항목의 로컬 성공 신호만 받아 기록 mount 후 focus. 외부 query 변경·409에는 신호를 세우지 않는다 | P01, #144 | 출처 분리만 채택. 도메인 status 자체는 성공 출처가 아님 | Q1 |
| <a id="D02"></a>D02 | 채택 | 각 API hook의 schema/경로/입력은 남기고 단건 응답 반영 뒤 org/Inbox invalidation 정책만 공유. already_decided도 같은 영역 재조회 | P02, #144 | 새 mutation 프레임워크 필요 없음. 일반 오류에 일괄 refetch/clear하지 않음 | Q2 |
| <a id="D03"></a>D03 | 채택 | 캐시 공통화에서도 현행 void invalidate 의미 유지. 저장 성공과 재조회 완료를 동일 성공 조건으로 바꾸지 않는다 | E01,E04,E06–E07 | await는 가능한 다른 정책이지만 이번 추출에 섞으면 UI 수명·focus callback 시점이 달라짐 | Q1,Q2 |
| <a id="D04"></a>D04 | 채택 | 항목 identity key와 작업자 org/approval 초안 저장을 유지. 의견·confirming·decidedHere는 항목 로컬, 작업자 draft는 명시적 보존 및 로컬 성공 시 정리 | P03 | 공통 외곽이 form 초안·readiness를 소유하면 종류별 수명이 섞임 | Q3 |
| <a id="D05"></a>D05 | 변형 채택 | 두 화면/지연 응답 경쟁 검사에 winner 기록과 loser 비간섭·원래 주소·실제 POST 수/값을 추가 | P04 | OpenClaw 검사의 구조만 참고. 서버 API와 Event는 기존 프로젝트 검증 경계 사용 | Q1,Q2,Q3 |
| <a id="D06"></a>D06 | 채택 | 결과 폼은 기존 useInlineConfirm을 재사용. Escape/취소 때만 트리거 복귀, pending 중 취소 잠금, 성공 때 기록 focus를 덮지 않음. 공통 외곽은 status·폼 전체 alert·기록 focus 담당 | E15,E17, #144 | APG 모달로 교체하거나 공통 외곽에서 취소 복귀를 재구현하지 않음 | Q1,Q3 |
| <a id="D07"></a>D07 | 채택 | pause/stop 문구·허용 여부는 각 폼이 정하고 외곽은 표시만. 상세/Inbox Block variant는 간격·padding·텍스트·줄바꿈만 선택 | E01, #144, ADR-0005 | 초기 승인/작업자 추가/결과의 서로 다른 효과를 공통 boolean으로 뭉치지 않음 | Q3 |

| <a id="D08"></a>D08 | 채택 | 필드 오류 판정·첫 오류 focus는 각 폼/choice-problems, 연결 DOM은 ProviderChoiceFields에 남긴다. 선택 거부 후 목록 갱신을 유지. 통신·일반 서버·already_decided는 폼 전체 안내 | E15,E17 | 공통 표시가 오류를 임의 필드에 매핑하거나 무조건 focus하지 않음 | Q3 |
| <a id="D09"></a>D09 | 채택 | 셸 경로 focus와 도킹/drawer의 열기·닫기 복귀는 기존 담당 유지. 결정 성공은 현재 mount된 자기 기록 안에서만 처리 | E13,E16–E18 | key·observer 수명을 보존하고 늦은 응답의 다른 항목·경로 침범은 별도 E2E로 검사 | Q1,Q2,Q3 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 모든 terminal 전환에 focus | OpenClaw E02 | 외부 갱신·409 비간섭이라는 확정 규칙과 상충 |
| 제출 handler 반환 시 pending 해제 | Airflow E05 | 실제 네트워크 완료를 추적하지 않아 중복 방지 근거가 안 됨 |
| invalidate 완료까지 기다린 뒤 로컬 성공 | Airflow E04 | 현행 callback 수명을 바꾸는 별도 정책. 이번 범위에서는 보존 |
| 범용 결정 폼·API/schema까지 매개변수화 | 일반 프레임워크 대안 | #144 범위 밖이며 종류별 확인·readiness·허용 규칙을 숨김 |
| 모달 focus trap을 inline 재확인에 추가 | APG 모달 예제의 무조건 이식 | 예제와 현행 상호작용 구조가 다름 |

## 구현 참고

권고는 `apps/web` Surface 내부 추출이다. `approvals.tsx`·`results.tsx`의 결정 표시 외곽/기록 focus, `api.ts`의 두 mutation 갱신 정책, `inbox-detail.tsx`의 Block variant와 key 경계를 대조한다. endpoint·contracts·서버 결정 트랜잭션은 유지한다. 서버 불변 조건을 UI 표시로 대체하지 않는다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 상세/Inbox의 승인·결과 로컬 결정 → 기록 교체 → 주소 유지·기록 focus·관련 목록/조직/Inbox 수렴 | D01–D03 |
| V02 | 외부 API 결정+Event 도착 → 기록 갱신 → 미리 선택한 생존 요소에 focus 유지, 강제 기록 focus 없음 | D01,D05 |
| V03 | WS 차단한 stale 승인/결과 화면 → 타 화면 선행 결정 뒤 다른 결정 제출 → 409 실제 응답·canonical 기록, 로컬 성공 처리 없음 | D01,D02,D05 |
| V04 | 500 실패 → 의견/작업자 초안 유지 → 재시도 성공. 응답 지연 중 모든 결정 버튼 비활성·추가 POST 없음 | D04,D05 |
| V05 | 완료 버튼→취소→재확인→완료를 키보드로 수행 → 최초 단계 POST 0, 취소 focus 복귀, 확정 때만 한 번 전송 | D06 |
| V06 | 기본값 응답 지연/프로바이더 변경/기본모델/되돌리기/이탈 복귀 → 보이는 선택과 실제 승인 payload 동일 | D04,D05 |
| V07 | 상세·Inbox 항목 A↔B 전환 → 의견·confirming·decidedHere 누수 없음, 작업자 초안은 올바른 org/approval로 보존 | D04 |
| V08 | paused 초기 승인/작업자 추가/결과 → 확정 안내와 버튼 → 실제 재개/유지/종료 효과 일치 | D07 |
| V09 | stopped 초기 승인/결과는 차단, 작업자 추가는 기존 허용 → 종류별 서버 회귀와 일치, 교차 조직 원본 접근 거부 보존 | D07 |
| V10 | 상세/Inbox variant를 390px·키보드로 사용 → 읽기 순서·라벨 유지, textarea/긴 오류/선택/기록 가로 넘침 없음 | D06,D07 |

| V11 | 상세/Inbox의 모델 거부·목록 갱신→오류 필드 aria-invalid/describedby 및 첫 오류 focus. 미수정 재제출 POST 0; 500/통신/409에는 필드 오류·첫 오류 focus 없음 | D08 |
| V12 | 1280 도킹 열기→heading→닫기→실제 opener; 390 drawer Tab/Shift+Tab 가두기·Escape→opener, 항목 경로 이동→새 h1. 로컬 결정·취소·외부 Event 각각과 조합 | D09 |
| V13 | 항목 A POST 응답을 gate→B 또는 다른 경로 이동 후 새 focus 사전 단언→응답 해제→A 캐시는 수렴하되 B 초안/확인/focus 불변. 동일 항목 재진입과 선택 거부의 refetch 대기 중 이탈도 검사 | D04,D08,D09 |
| V14 | 자기 성공 응답 전 Event가 먼저 도착하는 순서를 gate→현재 기록 focus 계약과 observer unmount 영향 확인. canonical 텍스트만으로 통과시키지 않음 | D01,D05,D09 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 새 제품 선택 없음 | #144 구현자 | 확정 범위 유지. 공통 모듈의 파일명·내부 callback 모양은 위 수명 경계를 만족하는 구현 선택 |

## 한계와 미확인

- 신규 실행은 Node v24.21.0, Playwright 1.64.1 Chromium, 기존 production Vite 빌드, 임시 embedded Postgres, fake providers 2, 키 없는 셸에서 수행했다. 기존 E2E 8개와 추가 probe 6개가 최종 통과했다. 복사본은 helper 절대 경로와 캡처만 추가했고 제품 코드·테스트·설정은 변경하지 않았다. 최초 실행의 캐시 의존성 해석 실패와 409 probe의 focus 대상 구성 실패는 통과로 집계하지 않았다. 이전 2026-11-10 query-core 5 PASS·제품 2 PASS·APG 조작은 과거 결과다.
- 새 실화면은 로컬 제품의 인라인 확인(상세/Inbox 1280·390px)과 상세 승인 모델 오류다. 오류 목록·응답은 합성 주입했다. 스크린샷으로 ARIA·포커스·POST를 추정하지 않고 브라우저 assertion과 분리했다. APG·OSS 실화면은 이번 새로 실행하지 않았다.
- 결과의 Event/실제 409 비간섭은 양쪽 화면에서 확인했다. 승인 stale E2E는 canonical 기록을 확인하지만 비간섭 focus assertion은 없다. 승인 외부 Event 비간섭, V13 늦은 응답/비동기 필드 refetch 이탈, V14 Event 선행 경쟁은 실행 미확인이다. 라이브러리의 unmount callback 근거만으로 이를 통과로 취급하지 않는다.
- 전체 웹/서버·DB 회귀·조직 경계·종류별 pause/stop 효과·작업자 기본값 지연/초안 전체 조합은 미실행이다. 확정 pause 안내와 현재 문구 차이는 기존 #144의 구현 대상이며 새 정책 결정이 아니다. 작업자 초안 정리는 현재 per-call 성공 callback 위치를 보존한다. 화면을 떠난 뒤에도 반드시 정리된다는 새 보장은 하지 않는다.
- 실제 스크린 리더·Firefox/WebKit·모바일 실기·200% zoom은 미실행이다. drawer 검사는 기존 assertion 범위이며 모든 Tab 순환 조합을 추가 검증한 것은 아니다. 모델 호출·계정 로그인·유료 API·실제 연구 데이터는 사용하지 않았다.
- 외부 소스는 고정 사례 재사용이며 최신 upstream 보증이 아니다. 코드 복사·의존성 도입을 권고하지 않는다. 새 제품 선택·ADR·상충으로 사용자 판단을 요구할 항목은 없다.
