# issue-95 레퍼런스 조사: Lead 제안과 승인 결정의 프로바이더·모델

조사일: 2026-10-30. 대상: [#95](https://github.com/babo-jeonguk/BaboJUBot/issues/95), 부모 [#91](https://github.com/babo-jeonguk/BaboJUBot/issues/91), 완료된 선행 [#94](https://github.com/babo-jeonguk/BaboJUBot/issues/94). 구현 전 기술 권고이며 확정 계약이나 구현 결과가 아니다. 상세 자료: `.reference-cache/issue-95/`(git 무시). 제품 코드·테스트·설정은 변경하지 않았으며, 이 문서는 구현 변경과 함께 커밋하도록 남긴다.

## Brief

- 구현할 문제: Lead가 연결·모델 목록으로 작업자를 제안하고, 사용자가 승인 상세에서 바꾼 값으로 생성한다. Lead 제안과 사용자 결정은 따로 보존한다. 조직 설정에는 `GitHub에 올리기` 정책을 더하고 Lead는 작업물 관리 방식을 묻는다.
- 동종 문제: **불변 검토 대상에 검토자 변경을 결합하고, 그 결정으로 부작용을 한 번 생성하는 흐름**.
- 고정된 결정: 초기 연구 승인·최종 완료·조직 경계는 코드 강제. 정책 값은 사용자만 변경. `GitHub에 올리기` 행동은 [ADR-0005](../adr/0005-approval-policy-enforcement-scope.md)에 따라 지침으로 지킨다. #94 연결 ID·nullable 모델·생성 때 기본값 복사·목록 fallback을 재사용한다. 준비 상태는 후속 #96. 실제 모델 호출·로그인·유료 API는 사용하지 않는다.
- 화면 계약: 설명문·경고문 없이 Select·배지·컨트롤로 표현, 변경 줄의 되돌리기, 닫기 후 초안 보존, 결정 뒤 읽기 전용 비교. 이는 #95의 결정이며 외부 사례로 재결정하지 않는다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | Lead에게 어느 목록을 노출하고 명시·생략·null을 어떻게 다루는가? | #95 AC1–2, #94 목록 계약 | API 계약 + Source Recon + 목록 failure probe |
| Q2 | 제안·결정 분리와 초기 팀/추가/정책 꺼짐 생성, 중복·교차 조직 결정을 어떻게 일관되게 처리하는가? | #95 AC2–5·8, 초기 승인 불변 조건 | Source Recon + persistence/failure |
| Q3 | 행별 변경·되돌리기·초안과 결정 후 비교, 즉시 저장 switch를 어떻게 표현하는가? | #95 화면 조건·패턴·E2E | Surface Capture + Behavioral Recon + 소스 |
| Q4 | 사용자 전용 정책 저장과 Lead 영어 지침·한국어 질문·선호 변경을 어디서 나누는가? | #95 AC6–7, ADR-0005 | 문서·Source Recon + 우회 시나리오 |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [프로바이더 선택](executor-selection-references.md#핵심-판단) | 에이전트 선택 자리, catalog와 실행 설정 구분 | 과거 SHA 주장을 새 근거로 복제하지 않고 연결. 심층 upstream은 새 SHA로 읽음 |
| [#54](issue-54-references.md#패턴) | 불변 snapshot·한 번 결정·사본·wake | 현재 `db/approvals.ts`를 독립 확인(E02). pending agent 사전 생성은 여전히 배제 |
| [#58](issue-58-references.md#brief) | 정책 분기·조직 잠금·정책 변경은 사용자만 | 현재 `db/workers.ts` 독립 확인(E03), 강제 범위는 이후 ADR-0005가 우선 |
| [판 2 화면 지침](design-guidelines-pan2.md) | 다섯 가이드 원칙, D 승인 상세·E 조직 설정 | 기존 지침 해석을 재사용. 이번 공개 상호작용 관찰과 구분 |
| [#94](issue-94-references.md#패턴) | 연결 ID·catalog fallback·폼 초안 분리 | 현재 c4a0aa9 소스와 완료 이슈 댓글 확인. 과거 열린 결정 중 cap=0·전역 변경 알림 등은 완료 이슈의 결정이 우선 |

## 레퍼런스

후보와 관점별 검색 라운드·실행 경로는 `.reference-cache/issue-95/candidates.md`에 기록한다. saturation은 이번 질문에 새 패턴이 더해지지 않은 범위를 뜻하며 생태계 전수조사를 뜻하지 않는다.

| 관점 | 마지막 라운드·saturation |
|---|---|
| 승인 제품·워크플로 | 3라운드: 조직 채용→HITL/Temporal→실패·배포 승인. 조건부 전이·검증·결정 payload·중복 방지로 수렴 |
| UI·디자인 시스템 | 3라운드: 기존 지침→SEED/React/Carbon→행 동작·상태 계약. 행별 컨트롤·제어 상태·즉시/제출 반영으로 수렴 |
| 정책·온보딩 | 3라운드: 공개 지침→권한 엔진→실패·관련 문서. 지침 사전확인과 코드 permission 두 축 반복 |

후보는 13행(Apple/M3/One UI/TDS는 기존 가이드 묶음 1행)이다. 심층 대상 3개는 현재 소스·라이선스와 질문 관련성이 분명하고, 각각 원자 승인·입력 상호작용·지침 주입을 보여준다.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| Paperclip | 조직 운영 OSS | `ac4f13d205ce7783856a673497b2c01be7781ce7` | MIT | 소스·테스트 읽기 | 조직 잠금·승인 payload 기반 생성·중복 부작용 방지, override 직접 사례는 아님 |
| SEED | 디자인 시스템 | `99efaf5561de6e18557ffeb57fe95428ce066eb3` | Apache-2.0 | 소스·공개 실행 | Select/Switch controlled 상태·공개 데모·좁은 화면 |
| OpenClaw | 에이전트 OSS | `03ba6b4720287fe483d338116830b34cb2029dcd` | MIT | 소스·지침 | 최초 대화와 선호 변경 지침, prompt context 조립 |

모두 설계 참고이며 코드 복사 없음. Paperclip의 기존 선택 조사 SHA와 비교한 approvals service/route·registry·approval validator 4파일은 blob hash가 같았다(`recon/approval.md`). #54의 다른 SHA 근거는 해당 문서 링크로만 참조하고 새 실행 근거로 세지 않았다. SEED는 기존 #94와 40자 SHA가 같다. OpenClaw는 새 SHA로 독립 열람했다.

## 근거

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 등록부는 연결 ID 중복을 거부하고 모델 null을 허용한다. 목록은 같은 runtime 함수를 쓰며 오류·시간 초과·빈 응답이면 고정 목록으로 돌아간다 | 자체 c4a0aa92da6eaea26b8f1e9f8d054832ae88ac80: [registry `checkChoice/settings`](https://github.com/babo-jeonguk/BaboJUBot/blob/c4a0aa92da6eaea26b8f1e9f8d054832ae88ac80/apps/server/src/providers.ts#L33-L66), [`listProviderModels`](https://github.com/babo-jeonguk/BaboJUBot/blob/c4a0aa92da6eaea26b8f1e9f8d054832ae88ac80/packages/runtime/src/providers.ts#L48-L78) | 소스 확인 |
| <a id="E02"></a>E02 | 현재 결정은 조직 잠금→조직+승인 ID 조회→pending/단계 검사→조건부 갱신→작업자·사본·조직·wake·Event를 같은 transaction에 넣는다. workerDefault는 결정 때 읽는다 | 자체 [`decideApproval`](https://github.com/babo-jeonguk/BaboJUBot/blob/c4a0aa92da6eaea26b8f1e9f8d054832ae88ac80/packages/db/src/approvals.ts#L155-L239) | 소스 확인 |
| <a id="E03"></a>E03 | 작업자 추가는 toolWrite 안 최신 정책으로 분기하고, 꺼짐이면 작업자·사본·Event, 켜짐이면 승인 요청·Event를 저장한다. 현재 입력 팀은 개별 작업자가 아닌 role/count이며 같은 Role 중복을 거부한다 | 자체 [`addWorker`](https://github.com/babo-jeonguk/BaboJUBot/blob/c4a0aa92da6eaea26b8f1e9f8d054832ae88ac80/packages/db/src/workers.ts#L43-L89), [팀 입력](https://github.com/babo-jeonguk/BaboJUBot/blob/c4a0aa92da6eaea26b8f1e9f8d054832ae88ac80/packages/contracts/src/approval.ts#L29-L46) | 소스 확인 |
| <a id="E04"></a>E04 | 현재 원본 `listProviderModels`에 fixed/dynamic/empty/error/timeout와 abort 음성 대조를 실행, 6 assertions 통과. 모델 adapter는 부르지 않았다 | E01 SHA, Node v24.21.0; `probes/catalog.mjs`, `probes/catalog-run-log.txt`; `env -i HOME="$HOME" PATH="$PATH" node .reference-cache/issue-95/probes/catalog.mjs` | 실행 확인 |
| <a id="E05"></a>E05 | Paperclip 채용 승인은 회사 행 잠금 transaction에서 resolve한 뒤 applied일 때만 payload로 agent를 활성화/생성한다. 동일 결정 재전송은 applied=false, 반대 결정은 오류 | [hireApprovalService.decide](https://github.com/paperclipai/paperclip/blob/ac4f13d205ce7783856a673497b2c01be7781ce7/server/src/modules/agent-lifecycle/adapters/approvals.ts#L21-L93), [회사 잠금](https://github.com/paperclipai/paperclip/blob/ac4f13d205ce7783856a673497b2c01be7781ce7/server/src/services/accounting-transaction.ts#L11-L21), [resolveApproval](https://github.com/paperclipai/paperclip/blob/ac4f13d205ce7783856a673497b2c01be7781ce7/server/src/lib/approval-records.ts#L24-L68) | 소스 확인 |
| <a id="E06"></a>E06 | Paperclip approve schema는 note만 받고, resubmit은 기존 payload를 덮는다. 읽은 테스트는 pending 설정 변경 거부/변조 후 snapshot 복원과 중복 부작용·교차회사 거부를 assert한다 | [resolve schema](https://github.com/paperclipai/paperclip/blob/ac4f13d205ce7783856a673497b2c01be7781ce7/packages/shared/src/validators/approval.ts#L14-L18), [resubmit](https://github.com/paperclipai/paperclip/blob/ac4f13d205ce7783856a673497b2c01be7781ce7/server/src/services/approvals.ts#L108-L127), [snapshot test](https://github.com/paperclipai/paperclip/blob/ac4f13d205ce7783856a673497b2c01be7781ce7/server/src/__tests__/agents-pending-approval-config.test.ts#L92-L188), [route test](https://github.com/paperclipai/paperclip/blob/ac4f13d205ce7783856a673497b2c01be7781ce7/server/src/__tests__/approval-routes-idempotency.test.ts#L146-L219) | 소스 확인(테스트 미실행) |
| <a id="E07"></a>E07 | SEED Select는 open과 value를 따로 제어, disabled/readOnly는 열기·선택을 거부, 단일 선택 뒤 닫는다. Switch는 checked callback과 native disabled를 제공한다. API 저장과 앱 초안 수명은 이 함수 밖이다 | [useSelect](https://github.com/daangn/seed-design/blob/99efaf5561de6e18557ffeb57fe95428ce066eb3/packages/react-headless/select/src/useSelect.ts#L107-L180), [useSwitch state](https://github.com/daangn/seed-design/blob/99efaf5561de6e18557ffeb57fe95428ce066eb3/packages/react-headless/switch/src/useSwitch.ts#L13-L26), [native input](https://github.com/daangn/seed-design/blob/99efaf5561de6e18557ffeb57fe95428ce066eb3/packages/react-headless/switch/src/useSwitch.ts#L121-L135) | 소스 확인 |
| <a id="E08"></a>E08 | SEED 가이드는 한 행에 4개 이상 상호작용 요소를 피하고, switch는 별도 제출 없이 즉시 효과가 있을 때 쓰도록 한다 | [List](https://github.com/daangn/seed-design/blob/99efaf5561de6e18557ffeb57fe95428ce066eb3/docs/content/components/list.mdx#L116-L125), [Switch](https://github.com/daangn/seed-design/blob/99efaf5561de6e18557ffeb57fe95428ce066eb3/docs/content/components/switch.mdx#L75-L90) | 문서 주장 |
| <a id="E09"></a>E09 | 공개 SEED Switch의 label 클릭으로 true→false 전환, Select 열기·사과 선택·390px 재열기 선택 체크 확인. 메인이 캡처 3개 직접 재열람 | [Switch demo](https://seed-design.io/react/components/switch), [Select demo](https://seed-design.io/react/components/select). Playwright1.58.2/Chromium1208, Node24.21.0, 1280×900/390×844; cache captures/captures.md, probes/ui-success-log.txt | 실행 확인 |
| <a id="E10"></a>E10 | OpenClaw AGENTS는 요청하지 않은 외부행동에 사전 확인 지침, 변경 선호는 이전 것을 superseded로 표시. BOOTSTRAP은 최초 대화 관례이며 hard gate가 아니라고 명시한다 | [AGENTS External vs Internal](https://github.com/openclaw/openclaw/blob/03ba6b4720287fe483d338116830b34cb2029dcd/docs/reference/templates/AGENTS.md#L19-L23), [선호 변경](https://github.com/openclaw/openclaw/blob/03ba6b4720287fe483d338116830b34cb2029dcd/docs/reference/templates/AGENTS.md#L59-L63), [BOOTSTRAP](https://github.com/openclaw/openclaw/blob/03ba6b4720287fe483d338116830b34cb2029dcd/docs/reference/templates/BOOTSTRAP.md#L10-L21) | 문서 주장(에이전트 지침) |
| <a id="E11"></a>E11 | OpenClaw buildProjectContextSection은 파일 본문을 Project Context 문자열로 조립한다. 이 함수는 GitHub 네트워크 차단의 근거가 아니다 | [buildProjectContextSection](https://github.com/openclaw/openclaw/blob/03ba6b4720287fe483d338116830b34cb2029dcd/src/agents/system-prompt-context-files.ts#L72-L96) | 소스 확인 |

근거 11행: 실행 확인 2·소스 확인 7·문서 주장 2. 패턴·결정은 위 관찰과 제품 요구에서 도출한 **추론**이다. worker는 탐색을 나누었고 메인은 결정에 쓴 원문·라이선스·캡처를 재열람했다(`main-verification.md`).

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | catalog와 실행 선택의 단일 출처 | E01·E04, 프로바이더 선택 조사 | 연결 ID와 adapter 종류는 다르며 null은 기본 모델 | UI와 Lead의 서로 다른 모델 목록 방지 | 목록 변동·nullable와 생략 혼동 |
| <a id="P02"></a>P02 | 원본 제안 + 결정 snapshot + 원자 생성 | E02–E03, E05–E06 | 외부 도구 인자 편집과 조직 팀 승인은 단위가 다름 | 누가 무엇을 골랐는지 재현 | 원본 덮어쓰기·부분 팀·중복 결정·default drift |
| <a id="P03"></a>P03 | 제어된 입력과 폼 초안의 별도 수명 | E07–E09, 판2 D/E | 컴포넌트는 Select/switch 상태만 담당, 앱은 approval별 초안 담당 | 닫기·조회 갱신에도 입력 보존 | unmount·refetch가 편집을 소실, 다른 승인에 초안 혼입 |
| <a id="P04"></a>P04 | 사용자 설정 권한과 행동 지침을 분리 | E10–E11, ADR-0005 | OpenClaw 일반 외부행동 정책과 우리 조직별 GitHub 정책은 다름 | 코드로 강제할 불변 조건과 지침 책임을 명료화 | prompt 문구를 네트워크 강제라고 오인 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | Lead 읽기 도구에 등록 연결 ID·표시명·모델 ID/표시명만 제공. UI와 같은 목록 함수를 쓰고 planning부터 조회 허용. 조직 실행 토큰·Role 검사 유지. 사용자 설정 쓰기 API를 대행 노출하지 않음 | P01, E01, #95 AC1 | 전역 catalog는 제공 가능한 연결 정보이며 다른 조직 연구 기록이 아님. 준비 상태·로그인 값·명령줄 자유 입력을 섞지 않음 | Q1 |
| <a id="D02"></a>D02 | 변형 채택 | provider 미지정은 작업자 기본 선택, provider 명시+model null은 해당 연결 기본 모델. 모델 ID는 연결과 짝으로 확인. 요청 원문과 해소된 제안 기준값을 구분하고, 사용자 결정에는 실제 생성에 쓴 전체 provider/model snapshot 보존 | E01–E04, P01–P02 | sparse override만 저장하면 나중의 전역 기본값·catalog 변화로 당시 결정을 재현 못 함. 기본값 해소 시점은 아래 열린 결정 | Q1,Q2 |
| <a id="D03"></a>D03 | 채택 | 원본 proposal은 수정하지 않는다. override는 해당 approval의 실제 팀 행만 대상으로 검증하고, provider/model 외 role/count/files/template 등 변경은 거부. 결정 snapshot·작업자·사본·wake·Event는 기존 한 transaction에서 저장 | E02–E03, P02, #95 AC3–4 | 승인 전에 기존 agent 설정 PUT 호출로 구현하면 부분 적용. 원본 변경 후 승인도 AC 위반. 없는/중복 행·타 조직 ID·미등록 연결은 쓰기 전 거부 | Q2 |
| <a id="D04"></a>D04 | 채택 | 초기 팀과 add_worker 승인, 정책 꺼짐 즉시 생성이 같은 선택 해소·검증 규칙을 사용. 정책 분기는 조직 잠금 아래 최신 값, 이미 pending인 요청은 정책 변경만으로 실행하지 않음. 반려/수정 요청에는 override 효과 없음 | E02–E03, #58 재사용, #95 AC5 | 즉시 생성 경로가 새 입력을 무시하고 전역 기본값만 복사하는 누락 방지. 정책 off가 초기 승인을 생략하지 못함 | Q1,Q2 |
| <a id="D05"></a>D05 | 채택 | #94의 Select 쌍 재사용. provider 바꾸면 model을 기본 모델로 초기화. dirty 행에 `변경`+되돌리기, 결정 중 공통 잠금. 초안은 organizationId+approvalId 소유자가 유지하고 `닫기`/실패/재조회에도 보존. 성공한 결정 뒤 서버 snapshot을 표시 | P03, #95 화면 계약 | 두 Select+되돌리기 총 3개 조작, 설명 배너 없이 처리. 결정 후는 읽기 전용 `Lead 제안`/`결정`, 실제 다른 칸만 표시 | Q3 |
| <a id="D06"></a>D06 | 채택 | 조직별 GitHub 정책 기본 false. 사용자 API의 잠금·변경 Event·commit 뒤 갱신을 기존 addWorker 정책과 함께 확장. switch 즉시 저장·진행 중 중복 입력 방지·실패 시 서버값 유지, 조직 도구 정책 변경 없음 | P04, ADR-0005, #95 AC6 | GitHub push 차단기·새 GitHub 승인 kind/자동 게시 도구를 추가할 근거가 아님 | Q4,Q3 |
| <a id="D07"></a>D07 | 변형 채택 | Lead Role 영어 지침에 첫 대화의 작업물 관리 한국어 질문, GitHub 선택 시 private/public 질문, 이후 대화 변경 수용, 작업자 제안 전 catalog 조회를 명시. GitHub 정책이 켜져 있으면 올리기 전 Owner 확인을 받게 함. 최신 정책이 실행 맥락/읽기 경로로 전달되는지 함께 점검 | P04, #95 AC7 | 관리 방식은 대화의 선호이며 제품 hard gate나 새 저장 엔진·기억 방식 채택으로 확대하지 않음. 지침 효과를 실제 모델 실험으로 확인한 것은 아님 | Q4 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 승인 입력을 원본 proposal에 덮어쓰기 | 일반 도구 edit/resume을 그대로 이식 | #95는 Lead 원본 보존·결정 분리 명시 |
| pending agent부터 만들고 승인 때 활성화 | Paperclip 채용 흐름 | 초기 승인 전 작업자 생성 금지와 다름 |
| approve 후 agent 설정을 따로 PUT | 가능한 UI 우회 | 승인/생성/변경 사이 실패·경쟁으로 일부만 적용 |
| 무제한 JSON merge·tool 이름까지 편집 | 일반 도구 호출 편집 | #95는 provider/model만 사용자 변경, snapshot의 나머지는 승인 대상 그대로 |
| GitHub CLI 차단·자격 증명 회수·게시 전용 조직 도구 강제 | 강제 정책 대안 | ADR-0005와 #91 범위 밖 결정에 상충 |
| OpenClaw 개인 USER/MEMORY·bootstrap 삭제 관례 도입 | 외부 온보딩 사례 전체 | 조직 기억 방식 미정, 우리 Role 사본·revision 책임과 다름 |

## 구현 참고

권고 요약: catalog 조회 → Lead 제안 고정 → approval별 폼 초안 → 사용자 결정의 해소된 선택 → 기존 transaction에서 생성 → 서버 결정 snapshot 비교. 즉시 생성도 같은 선택 해소를 통과한다.

구현 책임은 [전체 구조](../architecture.md)를 따른다. contracts는 도구 목록·제안/결정·정책 입출력, core는 선택 해소와 순수 승인 효과, db는 불변 원본·결정·생성의 원자 저장, runtime은 기존 catalog, server는 registry 검증·조직 토큰 gate·commit 뒤 갱신, web은 Select·초안·비교·switch, harness는 영어 Lead 지침을 소유한다. 외부 SDK나 UI 상태를 core에 넣지 않는다. 구체 진입점은 [초기 승인](../agents/code-map/initial-approval.md), [승인 정책](../agents/code-map/approval-policy.md), [프로바이더](../agents/code-map/providers.md) 코드 지도를 따른다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | planning Lead catalog 조회·worker/종료 토큰 직접 호출 → 공통 도구 gate → 허용 범위만 조회, 타 조직·인증 값 미노출 | D01 |
| V02 | 생략·provider+null·유효 model·다른 provider model → 제안/결정/정책off → 같은 선택 규칙, 잘못된 짝은 무효·효과 0 | D02,D04 |
| V03 | 초기 팀 두 줄 중 하나 변경, 작업자 추가 변경 → 승인 → 원본 보존·결정값/작업자 일치·다른 칸만 변경 표시 | D02–D05 |
| V04 | 동시 approve/다른 값 재승인·교차 조직 승인ID·없는/중복 팀행 → 저장 → 한 번만 생성·미허용 입력 효과 0, 부분 사본/Event/wake 없음 | D03 |
| V05 | 제안 뒤 전역 기본 변경·모델 목록 변동·라이브러리 변경 → 승인 → 정한 해소 시점 계약과 결정 snapshot 일치 | D02–D03 |
| V06 | 정책 on/off 경합·pending 뒤 off·반려/수정·일시정지/종료 조직 → 기존 승인 흐름 → 초기 승인 항상 필요·최종완료 유지·기존 단계/재개 규칙 보존 | D03–D04 |
| V07 | provider 변경·되돌리기·닫기/재열기·다른 승인 전환·재조회·결정 실패 → 폼 → 종속 모델 초기화·초안 보존/격리, 서버 결정 전 성공 표시 없음 | D05 |
| V08 | 390px/키보드·긴 모델명 → 표와 Select·되돌리기·결정후 비교 → 접근 가능한 label/이름·조작/값 확인. 초기/추가 승인 E2E와 판1 데모 유지 | D05 |
| V09 | 사용자 GitHub switch 변경·실패·다른 탭·에이전트 직접 정책 쓰기 → 기본false·즉시 저장·조직 Event·재조회·거부, 기존 addWorker 값 소실 없음 | D06 |
| V10 | 첫 대화·GitHub private/public·나중 선호 변경·정책 on으로 게시 요청 → 하네스 내용/주입 확인 → 영어 지침에 한국어 질문·변경 수용·사전 확인 존재. 실제 모델 준수는 별도 시험 | D07 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| team Role×count와 개별 작업자 행의 관계 | #95 (개별 선택 제품 의미는 사용자) | A: 요청의 Role/count 줄마다 동일 선택 적용(변경 작음). B: 승인용 snapshot에서 안정 ID의 개별 작업자 행으로 펼쳐 각자 선택(화면의 역할·이름 표에 자연스러움). C: 입력부터 개별 행 허용(같은 Role 중복 거부 계약까지 변경). E03상 현재 개별 행이 아니므로 외부 표 패턴만으로 확정하지 않음 |
| 생략된 provider 기본값을 해소하는 시점 | #95 (화면과 생성 의미가 달라지면 사용자) | A: 제안 저장 때 해소해 원본과 별도 기준값 snapshot을 보존(권고: 화면과 생성 일치). B: 결정 때 현재 작업자 기본값 해소(#94 기존 생성 복사에 가까움; 표시·동시 기본값 변경 계약 추가 필요). 둘 다 결정에 전체 선택값 보존. 모델 null은 실제 모델 추론 없이 provider 기본 의미 유지 |
| 오래된 요청/결정의 새 필드 호환 | #95 | 기존 행은 필드 없음. pending은 정한 default 규칙으로 해소, 이미 결정된 기록은 확인 가능한 생성 agent 연결로만 보강하거나 미기록 표시. 현재 전역값으로 과거 사용자 선택을 꾸미지 않음 |

후속 #96: 준비 상태·실행 맥락·세션에서 최신 정책 전달과 bundle 갱신 연결 점검. 실제 adapter catalog는 #98/#100/#101, OS 격리는 #102. 비용·기억 기법은 판4이며 이번 권고에 포함하지 않는다.

## 한계와 미확인

- 검증 표 V01–V10은 구현 때의 항목이다. 이번에 #95 제품 API/서버 검사/E2E를 만들거나 실행하지 않았다.
- 모델 목록 원본 함수의 stub probe만으로 실제 프로바이더 API 비용·로그인·목록 정확성을 증명하지 않는다. 실제 모델·구독 자격 증명 사용 없음.
- 공개 컴포넌트 상호작용은 완성된 승인 화면의 행별 초안·되돌리기·결정후 diff·서버 실패를 검증한 것이 아니다. 해당 전체 화면은 미확인이다.
- Paperclip·OpenClaw 서비스와 upstream 전체 suite는 실행하지 않았다. 소스가 쓰인 사실과 실제 동작을 구분한다. 핵심 소스의 git history/연결 PR에서 변경 이유를 추적하지 못했다. 정확한 사용자 override 감사 보존 전체 사례는 읽은 범위에서 확인하지 못해 제품 요구와 기존 transaction을 바탕으로 권고했다.
- 외부 사례는 설계 참고이며 코드 복사 없음. 재사용 시 고정 SHA root LICENSE·파일 header·NOTICE·전이 의존성을 다시 확인한다.

## 조사 완료 기록

Brief·Discovery·Recon·Synthesis·Receipt 완료. [Issue receipt](https://github.com/babo-jeonguk/BaboJUBot/issues/95#issuecomment-6524565529)를 사용자 게시 승인 후 게시하고 재조회하여 로컬 `.reference-cache/issue-95/receipt.md` 전문과 일치함을 확인했다.

`node scripts/check-project.mjs`로 Markdown 90개 로컬 링크 검사 및 `git diff --check` 통과. 제품 코드·테스트·설정 변경 없음, 문서와 문서 지도만 미커밋 상태로 남겼다.
