# inbox-detail 레퍼런스 조사: Inbox 상세(요약에서 결정 → 원래 화면으로 이어가기)

조사일: 2026-10-26 (Asia/Seoul). 대상: [#61](https://github.com/babo-jeonguk/BaboJUBot/issues/61) 리뷰 P1([PR #79](https://github.com/babo-jeonguk/BaboJUBot/pull/79#issuecomment-6407816434))과 [#50 확정 결정](https://github.com/babo-jeonguk/BaboJUBot/issues/50#issuecomment-6161637737)의 `/inbox/:id`. 구현 전 권고이며 확정 계약이나 구현 결과가 아니다. 상세 자료: `.reference-cache/inbox-detail/`(git 무시).

## Brief

- 구현할 문제: Inbox 패널의 항목을 누르면 Inbox 전용 상세(`/inbox/...`, 본문 폭 1024px)가 열린다. 승인 요청·결과 제출은 짧은 요약과 그 자리의 결정(승인·수정 요청·반려 / 최종 완료·수정 요청)을, 실패한 실행 시도는 실패 요약을 보인다. "원래 화면에서 자세히 보기"로 기존 도메인 상세(`/orgs/:id/approvals|results|runs/:id`)에 가서 전체 내용을 보고 거기서도 결정할 수 있다.
- 동종 문제: 알림·승인 대기열 항목의 2단 상세 — 요약 미리보기 + 그 자리의 빠른 결정 + 전체 상세로 이어가기(triage view / peek).
- 고정된 결정: #50 배치 C(Inbox 패널 하나, ≥1280px 붙음·좁으면 drawer, `/inbox/:id`, Inbox 상세 1024px). 사용자 결정(2026-10-26): 초기 연구 계획 승인과 결과 최종 완료도 요약에서 결정한다. 결정은 기존 HTTP 명령 그대로(한 번만, 이미 결정이면 409 `already_decided`), 반려·수정 요청은 사유 필수, 최종 완료는 2단 확인. 읽음·보관은 업무 결정과 분리. 단일 사용자·로컬 신뢰, 항목은 조직 ID에 묶임.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 전용 상세 주소의 항목 식별(조직 포함 여부), 결정 뒤·보관 뒤·없는/다른 조직 항목 deep link의 화면 | #50 `/inbox/:id`, 리뷰 P1 | Source Recon |
| Q2 | 복합 제안을 결정 가능한 요약으로 줄일 때 보일 것·접을 것, 큰·되돌릴 수 없는 결정을 요약에서 받을 때의 안전장치 | 사용자 결정, [#50 D09](issue-50-references.md) | Surface Capture + Source Recon |
| Q3 | 요약에서 결정한 뒤의 전이(결정 기록·다음 항목·목록에서 빠짐·포커스), 다른 곳에서 먼저 결정된 경우 | #61 AC2, [#58 D08](issue-58-references.md#D08) | Behavioral Recon + Source |
| Q4 | 상세를 열면 읽음으로 바꾸나 | #61 읽음·보관 | Source Recon |
| Q5 | 요약 ↔ 원래 상세 이동, 두 곳의 결정 폼이 같은 명령·상태를 공유하나 | 사용자 요구 | Source Recon |
| Q6 | 1280px 패널이 붙은 상태와 390px drawer에서의 배치 | #50 | Surface Capture |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [#50 조사](issue-50-references.md) D09·Inbox 상세 선택지 | "행의 승인 버튼만으로 복합 제안을 처리하는 안은 권고하지 않음" | 이번 SLDS·Paperclip 근거로 보강 |
| [#61 조사](issue-61-references.md#P07) P07·D08 | 원본 상세 링크·명시적 mutation·결정/정리 분리 | 변경 없음, 그대로 인용 |
| [#58 조사](issue-58-references.md#D08) D08 | 작업자 추가 결정의 409 재조회·receipt 포커스 | 변경 없음 |
| Paperclip 로컬 체크아웃 `def4726` | ApprovalCard | 메인이 원문 재열람 |

## 레퍼런스

관점별 saturation:
- agent 운영·승인 OSS — 26개 후보, 8라운드. 마지막 라운드의 새 후보·패턴 0개.
- 인접 업무 도구 Inbox·승인 — 17개 항목(약 22개 제품), 3라운드. 마지막 후보(Spinnaker)는 새 패턴을 더하지 않음.
- 디자인 시스템·가이드·명세 — 29개, 5라운드. 마지막 라운드는 기존 축의 사례만 더함.

전체 후보: `.reference-cache/inbox-detail/notes/`(agent-oss·adjacent-inbox·design-systems). 검색한 관점의 포화이며 전수조사가 아니다.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| Apache Airflow HITL Required Actions | OSS 오케스트레이터 HITL | `8bdb287` (실행: PyPI 3.3.2, tag `aa19d2d`) | Apache-2.0 | 소스·실행 | 목록+요약·응답+원래 상세 링크, 같은 응답 폼 공유, 409 세 갈래. 구조가 가장 가깝다 |
| OpenClaw 승인 페이지 | OSS agent 게이트웨이 | `ea5d12e` | MIT | 소스 | 단독 deep link 승인 화면의 상태 구분(여기서 결정/다른 곳에서 결정/없음/연결 끊김) |
| Plane 알림 + Intake | OSS 업무 도구 | `d9726d5` | AGPL-3.0 | 소스 | 같은 결정 화면을 알림 맥락과 대기열 맥락에 함께 쓰고 전이만 바꿈 |
| Paperclip ApprovalCard | OSS agent 운영 | `def4726` | MIT | 소스 | 요청한 설계와 같은 모양(요약 카드+Approve/Reject+View details)과 반례(사유 없는 Reject) |
| k8s-breakglass 승인 화면 | OSS 운영 승인 | `90e15d5` | Apache-2.0 | 소스 | deep link 상태 분기, 409 문구, 늦은 응답 무시, 메모 필수 |
| Frappe workflow action | OSS 업무 프레임워크 | `c14c5b8` | MIT | 소스 | 링크 결정 전 상태 비교, "누가 어떤 상태로" 만료 안내, 확인 페이지 2단 |
| GitLab Pajamas Duo agents and flows | 디자인 시스템 | `1178dfa4` | (디자인 문서) | 문서 | agent가 사람 입력을 기다릴 때 알림/패널/실패별 내용을 정한 유일한 디자인 가이드 |
| GOV.UK Check answers, APG Dialog, SLDS Split View, Teams Up-to-date views | 가이드·명세 | 아래 근거 | 각 문서 | 문서 | 요약 뒤 결정, 되돌릴 수 없는 결정의 포커스, 목록 행의 단일 행동, 결정 기록으로 교체 |
| Paseo attention, anthropic-cli 승인 가드 | OSS agent 도구 | `16fe075`, `16d9c14` | Apache-2.0 | 소스 | 결정 대기 주의는 열람으로 지우지 않음, 자동 전진의 오답 방지 |

깊이: 목록 / 문서 / 소스 / 실행.

## 근거

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | Airflow Required Actions는 한 모달 안에 대기(·완료) 목록과 요약·응답 상세를 두고, 상세의 task 링크(`onOpenTask`)는 모달을 닫고 원래 Task Instance 화면으로, 응답 성공(`onResponded`)은 다음 항목 선택으로 잇는다 | [HITLReviewModal.tsx](https://github.com/apache/airflow/blob/8bdb287f7ee587a5ca6d642e59979bf4576c4a3e/airflow-core/src/airflow/ui/src/components/HITLReview/HITLReviewModal.tsx#L121-L151) | 소스 확인 |
| <a id="E02"></a>E02 | Airflow 응답 API는 실행 시도가 현재가 아님·이미 응답·불러온 뒤 요청 교체를 각각 409로, 없음을 404로 거절한다 | [hitl.py](https://github.com/apache/airflow/blob/8bdb287f7ee587a5ca6d642e59979bf4576c4a3e/airflow-core/src/airflow/api_fastapi/core_api/routes/public/hitl.py#L196-L238) | 소스 확인 |
| <a id="E03"></a>E03 | Airflow 3.3.2 실화면(1440px): 목록 옆 요약에서 Approve를 누르면 확인 단계 없이 저장되고, 그 행이 빠지며 다음 행이 선택된다(4→3). 다른 탭에서 먼저 응답한 항목에 응답하면 "Response failed / Conflict" 알림만 뜨고 누가 무엇을 골랐는지는 보이지 않는다. 응답한 항목의 원래 화면 주소를 열면 "Response received at … from …" 한 줄과 비활성 버튼이 보인다. 열람만으로 바뀌는 상태는 없다(GET 외 요청 0건). 응답 뒤 포커스는 BODY로 떨어진다 | self-host `apache-airflow==3.3.2` `airflow standalone`, 캡처 `captures/airflow-p2-modal-1440.png`·`p3-after-approve-3s`·`p4-A-409-0.5s`·`p6a-responded-ti-deeplink-1440`, `recon/airflow.md` | 실행 확인 |
| <a id="E04"></a>E04 | OpenClaw 단독 승인 페이지는 불러오기 결과를 없음/연결 끊김으로 나누고, 보고 있는 동안 대기→결정으로 바뀌면 "Resolved elsewhere"로 표시하고 결과 영역으로 포커스를 옮긴다. 대기 중 안내는 "The first answer from any surface wins", 결정 뒤 "safe to close"와 "Open Control UI" | [approval-page.tsx](https://github.com/openclaw/openclaw/blob/ea5d12e1c97ad781617a6518103a2dc78ba54d21/ui/src/pages/approval/approval-page.tsx#L265-L320), [en-approvals.ts](https://github.com/openclaw/openclaw/blob/ea5d12e1c97ad781617a6518103a2dc78ba54d21/ui/src/i18n/locales/en-approvals.ts#L51-L99) | 소스 확인 |
| <a id="E05"></a>E05 | Plane 알림 화면은 Intake(승인 대기열) 항목이면 Intake 상세 컴포넌트를 `isNotificationEmbed`로 그대로 넣는다 | [workspace-notifications/root.tsx](https://github.com/makeplane/plane/blob/d9726d5c9615756135f3d6cd512ece8e2dd42902/apps/web/components/workspace-notifications/root.tsx#L93-L113) | 소스 확인 |
| <a id="E06"></a>E06 | Plane은 수락·거절 뒤 원래 Intake에서는 다음(없으면 이전) 항목으로 이동하지만 알림 embed에서는 이동하지 않는다. 결정된 항목은 결정 버튼 대신 Copy link·Open을 보인다 | [inbox-issue-header.tsx](https://github.com/makeplane/plane/blob/d9726d5c9615756135f3d6cd512ece8e2dd42902/apps/web/components/inbox/content/inbox-issue-header.tsx#L120-L160), [같은 파일](https://github.com/makeplane/plane/blob/d9726d5c9615756135f3d6cd512ece8e2dd42902/apps/web/components/inbox/content/inbox-issue-header.tsx#L376-L398) | 소스 확인 |
| <a id="E07"></a>E07 | Paperclip ApprovalCard는 종류·요청자·제목·payload 요약과, 대기 중일 때 Approve/Reject, View details 링크를 한 카드에 둔다. Reject에 사유 입력은 없다 | [ApprovalCard.tsx](https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/ui/src/components/ApprovalCard.tsx#L27-L146) | 소스 확인 |
| <a id="E08"></a>E08 | k8s-breakglass 승인 deep link는 대기가 아니면 "Only pending sessions can be approved", 404·403을 따로 보이고, 결정 409에 "already approved or rejected by another approver", 늦게 온 응답은 요청 번호로 버린다. 승인자 메모 필수 | [SessionApprovalView.vue](https://github.com/telekom/k8s-breakglass/blob/90e15d593dcf15809d620dde3a87525463281aa0/frontend/src/views/SessionApprovalView.vue#L188-L270) | 소스 확인 |
| <a id="E09"></a>E09 | Frappe 이메일 승인 링크는 보낼 때의 상태와 지금 상태를 비교해 다르면 "Document X has been set to state Y by Z"(만료), 같으면 확인 페이지를 거쳐 적용한다 | [workflow_action.py](https://github.com/frappe/frappe/blob/c14c5b81070be4fe45613ee2db16c16b3514fd50/frappe/workflow/doctype/workflow_action/workflow_action.py#L132-L218) | 소스 확인 |
| <a id="E10"></a>E10 | GitLab Pajamas: agent가 입력을 기다리면 알림은 "Action required"·요청 첫 줄·링크, 세션 패널은 결정이 필요한 이유·맥락 링크(plan 등)·Approve/Deny/Modify. 실패는 알림에 짧은 오류와 상세 링크, 패널에 오류·시각·완료한 작업·로그 | [duo-agents-and-flows.md](https://gitlab.com/gitlab-org/gitlab-services/design.gitlab.com/-/blob/1178dfa4d36e3b0731ecab699932398d263a63d9/contents/patterns/duo-agents-and-flows.md#L302-L353), [실패](https://gitlab.com/gitlab-org/gitlab-services/design.gitlab.com/-/blob/1178dfa4d36e3b0731ecab699932398d263a63d9/contents/patterns/duo-agents-and-flows.md#L506-L563) | 문서 주장 |
| <a id="E11"></a>E11 | GOV.UK Check answers: 제출 전 요약을 구역으로 나누고 구역마다 Change 링크로 원래 입력 화면에 갔다가 요약으로 돌아온다. 답하지 않은 것은 "Not provided", 제출 버튼은 수행할 행동을 그대로 말한다 | [check-answers/index.md](https://github.com/alphagov/govuk-design-system/blob/83ef3622ff74d47170d642ea7811e4ea4a440ef9/src/patterns/check-answers/index.md#L17-L66) | 문서 주장 |
| <a id="E12"></a>E12 | APG: 되돌리기 어려운 마지막 단계는 가장 덜 파괴적인 행동에 초기 포커스를 둘 수 있고, 연 요소가 사라지면 논리적으로 다음인 요소로 포커스를 옮긴다 | [dialog-modal-pattern.html](https://github.com/w3c/aria-practices/blob/0f765e4dc33e966026114ac12a8380db1de3b787/content/patterns/dialog-modal/dialog-modal-pattern.html#L79-L113) | 문서 주장 |
| <a id="E13"></a>E13 | SLDS Split View 목록의 각 항목은 하나의 행동만 갖고 자식 행동을 두지 않는다 | [split-view/docs.mdx](https://github.com/salesforce-ux/design-system/blob/9bc6a4046d10d95b4f3fb9cee7c7dc036bf43ad2/ui/components/split-view/docs.mdx#L21-L25) | 문서 주장 |
| <a id="E14"></a>E14 | Teams 승인 카드는 결정되면 "X가 승인함"으로 고쳐지고, 결정한 사람에게서 버튼이 사라진다 | [Up-To-Date-Views.md](https://github.com/MicrosoftDocs/msteams-docs/blob/30b6191ed5b2dab9657d691d27fba0ddf06b3ae6/msteams-platform/task-modules-and-cards/cards/Universal-actions-for-adaptive-cards/Up-To-Date-Views.md#L110-L126) | 문서 주장 |
| <a id="E15"></a>E15 | Paseo는 주의 이유가 결정 대기(permission)이면 화면을 봐도 주의 표시를 지우지 않는다 | [agent-attention.ts](https://github.com/getpaseo/paseo/blob/16fe07560f58ae0b35ccedaf40d04f426833b2b3/packages/app/src/utils/agent-attention.ts#L63-L81) | 소스 확인 |
| <a id="E16"></a>E16 | anthropic-cli는 새로 뜨거나 대상이 바뀐 승인 프롬프트가 600ms 동안 결정 키를 무시해, 앞 입력이 다음 항목에 답하는 것을 막는다 | [input.go](https://github.com/anthropics/anthropic-cli/blob/16d9c14b5bd6fd3d1f9871c934f2ddc8be506a05/internal/sessions/tui/input.go#L18-L31) | 소스 확인 |

worker 보고에만 있고 메인이 원문을 끝까지 열지 않은 보조 사례(Cordum 상세의 "If approved / If denied"·blast radius 확인, Hermes "Always allow"만 확인, HumanLayer 승인 행 dismiss 불가, Plane·Novu·Huly 열람 시 자동 읽음, SAP Fiori FCL 다음 항목/닫기, Carbon·Primer danger 확인의 취소 포커스)는 `notes/`에 있고 결정 근거로 쓰지 않았다.

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 요약 화면과 원래 상세가 **같은 결정 컴포넌트·같은 명령**을 쓴다 | E01, E05, E08 | Airflow는 같은 폼·hook, Plane은 같은 컴포넌트를 embed, breakglass는 모달과 deep link가 같은 내용 컴포넌트 | 결정 규칙(사유 필수·확인·409 처리)이 한 곳 | 맥락별 전이(다음 항목 여부)는 따로 정해야 함(E06) |
| <a id="P02"></a>P02 | 요약은 "무엇을 왜 결정하나 + 맥락 링크 + 결정 버튼", 전체 내용은 원래 화면 링크 | E07, E10, E11 | Paperclip은 payload 요약 카드, GitLab은 이유·plan 링크, GOV.UK는 구역별 Change 링크 | 빠른 결정과 깊은 검토를 둘 다 | 요약이 빠뜨린 내용을 모른 채 결정할 위험 → 생략 표시·원래 화면 링크를 구역마다 |
| <a id="P03"></a>P03 | 결정하면 같은 자리에 **결정 기록**으로 바뀌고 결정 버튼이 사라진다 | E06, E14, E04, E03 | Plane은 Open·Copy link, Teams는 "X가 승인함", OpenClaw는 "Approved here"/"Resolved elsewhere" | 무슨 일이 일어났는지 그 자리에서 확인 | 다음 항목으로 자동 이동하면 기록을 못 봄 |
| <a id="P04"></a>P04 | 대기열 맥락에서는 결정 뒤 **다음 항목으로** 자동 이동 | E01, E06 | Airflow·Plane Intake는 이동, Plane 알림 embed는 이동 안 함 | 많이 처리할 때 빠름 | 앞 입력이 다음 항목에 답할 위험(E16의 가드가 필요한 이유), 결과 확인 누락 |
| <a id="P05"></a>P05 | deep link 상세는 상태별로 다른 화면: 대기·이미 결정(누가·언제·무엇)·없음 | E04, E08, E09 | OpenClaw는 없음/권한 없음 합침, breakglass는 분리 | 결정 뒤에도 링크가 깨지지 않음 | 상태를 하나로 뭉치면("No action required") 무엇이 일어났는지 모름 |
| <a id="P06"></a>P06 | 결정 대기 항목의 주의는 열람으로 지우지 않는다 | E15 | HumanLayer는 승인 행 dismiss 불가 | 열어만 보고 잊는 결정을 막음 | — |
| <a id="P07"></a>P07 | 목록 행에는 하나의 행동(열기)만, 결정은 상세에서 | E13, [#50 D09](issue-50-references.md) | Paperclip은 반례로 행·카드에서 바로 결정(E07) | 오클릭·복합 제안 오판 방지 | 한 번 더 눌러야 함 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | 주소는 `/inbox/:orgId/:kind/:sourceId`(`kind`는 Inbox 항목 종류 `approval`·`result_submission`·`run_failure`). 결정 뒤·보관 뒤에도 같은 주소가 그 항목을 보인다 | P05, E08, E09, 리뷰 P1 | #50의 `/inbox/:id` 자리. 항목 ID는 종류 안에서만 유일하고 원본 조회 API가 조직 범위라 조직·종류를 주소에 둔다(Windmill·Trigger.dev처럼 범위를 주소에). Inbox 목록에서 빠진(결정된) 항목도 원본으로 다시 열 수 있어야 한다 | Q1 |
| <a id="D02"></a>D02 | 채택 | Inbox 상세와 원래 상세는 **같은 결정 폼**(같은 HTTP 명령·사유 필수·최종 완료 2단 확인·409 처리)을 쓴다 | P01, E01, E05 | 결정 규칙을 한 곳에서. 두 화면에 결정 버튼이 있어도 결과가 같다 | Q5, Q2 |
| <a id="D03"></a>D03 | 채택 | 요약 내용: 종류·조직·요청자·시각, **무엇을 결정하나와 결정의 효과**, 핵심 사실(초기 연구: 목표·완료 기준·팀 구성 인원·연구 환경·템플릿 이름, 계획은 앞부분만 / 작업자 추가: Role·사본 수 / 결과: 결과 요약·완료 기준·근거 산출물 제목). 줄인 부분은 "전문은 원래 화면에서"로 알린다 | P02, E07, E10, E11 | 사용자가 요약에서도 큰 결정을 하기로 했으므로(고정 결정) 결정에 필요한 사실은 요약에 남기고, 생략을 숨기지 않는다 | Q2 |
| <a id="D04"></a>D04 | 채택 | 결정 뒤에는 **제자리에서 결정 기록**으로 바꾸고 결정 버튼을 없앤다. 다음 항목으로 자동 이동하지 않는다. 다른 곳에서 먼저 결정됐으면(409) 최신 상태를 다시 불러와 결정 기록(무엇으로·언제)을 보인다 | P03, E03, E04, E06, E14, [#58 D08](issue-58-references.md#D08) | Airflow는 409에 "Conflict"만 보여 무엇이 결정됐는지 모른다(E03 반례). Inbox 상세는 알림 맥락(Plane embed와 같음). 패널은 그대로 있어 다음 항목은 사용자가 고른다. 자동 이동은 오답 위험(E16) | Q3 |
| <a id="D05"></a>D05 | 채택 | 상세를 열어도 읽음으로 바꾸지 않는다(현 #61 계약 유지). 읽음·보관 버튼을 상세에도 둔다(패널 행과 같은 명령) | P06, E15, [#61 P07](issue-61-references.md#P07) | 결정 대기 항목의 주의는 읽음과 무관하다. 실패 항목의 자동 읽음은 열린 결정으로 남긴다 | Q4 |
| <a id="D06"></a>D06 | 채택 | 실패한 실행 시도 상세: 에이전트·실패 사유·끝난 시각과 "실행 기록 보기". 결정 버튼 없음 | E10 | 실패에는 결정할 것이 없다. 재시도 버튼은 현재 제품에 없는 명령이라 만들지 않는다 | Q2 |
| <a id="D07"></a>D07 | 채택 | 패널 행은 지금처럼 열기 하나(+정리 버튼)이며 결정 버튼을 두지 않는다. 지금 연 항목을 패널에서 표시한다(`aria-current`) | P07, E13 | #50 D09와 같다. Paperclip 카드 결정(E07)은 배제 | Q6 |
| <a id="D08"></a>D08 | 채택 | 배치: 본문 폭 1024px(`standard`), 머리에 종류·상태·조직·시각과 "원래 화면에서 자세히 보기", 요약 블록, 맨 아래 결정. 390px에서는 세로로 쌓이고 drawer는 항목을 고르면 닫힌다(#50) | E01, #50 | 결정 기록·버튼이 요약 아래에 있어 요약을 읽은 뒤 결정한다(GOV.UK E11) | Q6 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 목록 행·카드에서 바로 결정 | Paperclip ApprovalCard(E07) | 복합 제안 오판, 사유 필수와 충돌(#50 D09, E13) |
| 결정 뒤 다음 항목 자동 이동 | Airflow(E01, E03), Plane Intake(E06) | 결과 확인 누락·오답 위험(E16). Inbox 상세는 알림 맥락 |
| 열람 시점의 상태를 결정 요청에 실어 비교(`current_state`·`request_created_at`) | Frappe(E09), Airflow(E02) | 우리 승인·결과 제출은 요청 때 고정한 snapshot이고 다시 제출하면 새 ID가 생겨 "불러온 뒤 내용이 바뀐" 경우가 없다. 이미 결정된 경우는 기존 409가 막는다 |
| 이름 입력·체크박스 확인 | PatternFly WarningModal(notes D14) | 단일 사용자 로컬 도구에 과함. 최종 완료는 기존 2단 확인 유지 |

## 구현 참고

- 권고 요약: `/inbox/:orgId/:kind/:sourceId` Inbox 상세를 만들고, 기존 승인·결과 화면의 결정 폼·결정 기록을 그대로 재사용한다. 요약은 결정에 필요한 사실과 생략 안내, 원래 화면 링크를 둔다. 결정 뒤 제자리 결정 기록, 자동 이동 없음, 열람은 읽음을 바꾸지 않음.
- 구현 위치: `apps/web`(새 화면·route, 패널 행 링크). 서버·계약 변경 없음 — 결정·정리 명령과 조회 API는 기존 그대로([architecture](../architecture.md)의 웹 대시보드 경계).

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 패널 항목 클릭 → `/inbox/:orgId/:kind/:sourceId` → 요약·결정 폼·"원래 화면에서 자세히 보기" | D01, D03, D08 |
| V02 | Inbox 상세에서 반려(사유 없이) → 버튼 비활성, 사유 입력 후 반려 → 결정 기록·버튼 사라짐·패널에서 빠짐, 원래 화면도 같은 결정 기록 | D02, D04 |
| V03 | 결과 제출 Inbox 상세에서 최종 완료 → 확인 단계 → 결정 기록 | D02 |
| V04 | 다른 탭에서 먼저 결정 → 이 화면에서 결정 → 409 안내 뒤 최신 결정 기록 | D04 |
| V05 | 결정된 항목·없는 항목·다른 조직 ID의 Inbox 주소 직접 열기 → 결정 기록 / 없음 안내 | D01 |
| V06 | 실패 항목 Inbox 상세 → 실패 사유·실행 기록 링크, 결정 버튼 없음. 열어도 안 읽음 유지, 상세의 읽음 버튼으로 읽음 | D05, D06 |
| V07 | 1280px 패널 붙은 상태·390px drawer에서 상세 열기, 가로 넘침 없음, 패널의 현재 항목 표시 | D07, D08 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 실패한 실행 시도 상세를 열면 자동으로 읽음 처리할지 | 사용자 | (a) 지금처럼 명시적 읽음만(E15, #61 계약) (b) 실패 항목만 열면 읽음(Plane·Novu·Huly 알림의 기본 — notes, 메인 미확인) |

## 한계와 미확인

- 상용 서비스(Linear, GitHub, GitLab, Teams, Slack, SAP, Knock, Novu cloud 등)의 실제 화면은 로그인 벽으로 열지 않았고 문서 주장만 있다. SAP Fiori 새 포털은 403이라 보관본만 worker가 읽었다(결정 근거에서 제외).
- Airflow는 3.3.2로 실행했다. 고정 SHA에만 있는 409 두 갈래(요청 교체·실행 시도 교체)와 실패 뒤 즉시 재조회는 소스만 읽었다. 메모리 상한은 `systemd-run`이 bus 연결에 실패해 프로세스별 `ulimit -v 3G`로 대신했다. 응답자 이름은 all-admins 모드라 "Anonymous"로만 보였다.
- OpenClaw·Plane·breakglass·Frappe는 실행하지 않았다. 390px 실화면은 Airflow만 확인했다(목록·상세가 세로로 쌓이고 결정 버튼이 스크롤 아래, 일부 열이 화면 밖 — `captures/airflow-p2-modal-390*.png`). 1280px에 패널이 붙은 상태와 같은 배치의 레퍼런스 실화면은 없다.
- 설계 참고만 하며 코드를 복사하지 않는다(Cordum BSL, n8n SUL, Plane AGPL, Windmill AGPL 포함).
