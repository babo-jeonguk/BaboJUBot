# issue-142 레퍼런스 조사: 공통 실행 의도 경로의 산출물 준비·정산 계약 강화

조사일: 2026-11-12. 대상: [#142](https://github.com/babo-jeonguk/BaboJUBot/issues/142). 현재 이슈 본문과 원격 main `983dbc5a4e9342c460f081a4888250e6634522c6`을 기준으로 재조사했다. 로컬 HEAD도 같다. 구현 전 참고 권고이며 확정 계약이나 구현 완료가 아니다. 이 문서는 #142 구현 변경과 함께 커밋한다.

## Brief

- 구현할 문제: 실제 파일 읽기는 이미 DB 잠금 밖에 있다. 남은 문제는 준비·수락·정산의 공통 책임, DB 저장의 비동기 reader 입력, 일반 준비 예외의 동시 의도 합류, 준비 전 작업 소속 검사와 경쟁 검증 공백이다.
- 동종 문제: 비싼 입력 준비를 잠금 밖에서 끝내고, 고정 자료를 먼저 영속 수락한 뒤 짧은 transaction에서 효과와 최초 결과를 함께 정산한다. 준비 실패도 현재 실행 신원·이미 수락된 동일 의도와 조정한다.
- 고정된 결정: 공통 실행 의도 module이 전체 순서를 소유한다(A). 산출물 준비에 작업 소속 확인·안전 reader를 위임하고 DB 저장은 자료만 받는다. 전송 adapter가 순서를 조립하지 않는다. 기존 의도·복구를 재사용하며 범용 프레임워크·산출물 전용 pending/lease·singleflight는 추가하지 않는다. 중복 읽기 허용, 효과 한 번이다.
- 고정된 정책: 유효 토큰·조직·에이전트 신원은 완료 조회에도 필요하다. 완료 결과는 현재 Role·단계 때문에 막지 않지만 미수행 쓰기는 현재 규칙을 따른다. 일반 실패는 같은 의도로 수렴하고, 준비 중 발견한 조직 신원 오류는 차단한다. snapshot은 기존 reader의 bytes이며 새 파일시스템 원자 snapshot을 요구하지 않는다.
- 제품 불변 조건: 조직 경계·초기 승인·사용자 최종 완료·기존 승인 정책·경로 격리를 유지한다. core에 DB/OS 의존성을 추가하지 않는다. parent API는 404, blocker 목록은 빈 배열이다. #150 계약과 PR #164의 기존 구현을 전제로 하며 #140·#141·#143–#146을 새 blocker로 만들지 않는다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 공통 module이 준비·수락·정산을 소유하면서 DB 저장에서 파일 I/O를 배제하는 interface는? | #142 Further Notes ①, 책임 배치, Stories 9·12 | Source Recon + API/Adapter 계약 + 격리 경계 |
| Q2 | 준비 실패·동시 수락·최초 결과·취소·조직 신원 오류를 어떻게 조정하는가? | Further Notes ②, 준비·재호출·제어, Stories 4–9 | Source Recon + runtime/failure + adversarial scenario |
| Q3 | reader gate·실제 DB 실패로 제어 효력과 두 commit의 원자성·복구를 어떻게 검증하는가? | Further Notes ③, 원자성·복구, Testing Decisions | Behavioral Recon + persistence/recovery + barrier 소스 |

### 질문별 기존 근거 재사용 판단

| 질문 | 기존 근거·권고 | 판단과 보강 |
|---|---|---|
| Q1 | 기존 E01–E03, D01의 등록 모듈 소유·두 tx | **권고 교체**. `tasks.ts`는 blob 동일하나 `tools.ts`·`tool-calls.ts`와 호출 사슬은 변경됐다. 과거 실제 잠금 지연(E03)은 현재 HTTP/MCP 지연의 증거가 아니다. 공통 의도 module 소유·prepared-only DB 경계로 갱신(E01–E03·E15) |
| Q1 | 기존 E08 Go 준비/확정 | **부분 재사용**. sql.go blob 동일. 준비 후 최신 유효성 확인만 쓰고 연결 수 예약은 채택하지 않음(E08) |
| Q2 | 기존 E09 Django 최초 조회·실패 뒤 승자 | **부분 재사용**. 파일 변경, 함수 본문 동일 재확인. Django는 IntegrityError 한정이므로 일반 throw·조직 오류 정책의 근거로 일반화하지 않음(E09·E14) |
| Q2 | 기존 D01 권한/단계→완료, D02 모든 예외 수렴 | **정정**. 실행 신원과 쓰기 규칙을 구별하고 완료 replay는 현재 Role·단계 gate 앞에 둔다. 조직 신원 오류를 일반 실패에서 제외(E02·E14, D02–D03) |
| Q3 | 기존 E04–E07 PG 최신행·원자성 | **메커니즘 재사용·범위 정정**. 변경 파일 재독. 정산 rollback이 앞서 commit된 수락 의도까지 지운다는 뜻이 아님. 두 commit probe 보강(E05–E07·E16) |
| Q3 | 기존 E11–E12 gate/isolation | **재사용**. 파일별 blob 동일 확인. singleflight 구현은 배제, 순서 신호와 실제 저장 경계 검증만 참고(E11–E12) |
| Q3 | 기존 E10·E13의 실행 | E10 Django 제한 probe는 **과거 기록만**. E13 파일 검사도 의도 경로 변경 탓에 최신 검증으로 승계하지 않고 파일·복구 19개를 재실행(E13). 신규 #142 완료 조건 검증은 아님 |

| 관련 기존 조사 | 재사용 범위·판단 |
|---|---|
| [조직 폴더 identity](workspace-identity-references.md#근거) | 논리 조직·표식과 OS 격리의 차이만 재사용. 현행 reader의 identity throw를 직접 재독(E14); 과거 실행은 승계하지 않음 |
| [경로 confinement](artifact-path-confinement.md#공통-결론) | 기존 경계를 유지할 회귀 범위만 재사용. workspace.ts 변경(Windows 이름·확장 UNC 처리, 확인한 파일 identity를 open까지 유지)을 재독. 새 경로 정책 없음 |
| [#140](issue-140-references.md), [#141](issue-141-references.md) | 다른 이슈와의 범위 구분만. 과거 SHA·실행·결론을 현행 호출 경로의 근거로 승계하지 않음 |
| [조직별 제품 폴더](org-product-folders-references.md) | 로그인 공유와 산출물 shared 용어만. 인증·CLI 실행 근거 재사용 안 함 |
| [#150](issue-150-references.md) | 호출 신원·입력 표기·고정 자료의 배경. 현행 계약은 #150 본문이며 과거 조사 속 ‘새 복구 설계 필요’·옛 Role/단계 우선 권고는 승계하지 않음. 현행 intents/toolWrite/settle 직접 확인 |

### 파일별 ref 재확인

제품 이전 기준 `c88a98b58284a38bdadf7eff7aafa0219005371c` → 위 main의 Git blob 비교: `tasks.ts`·`file-artifacts.test.ts` 동일; `tool-calls.ts`·`rows.ts`·`control.ts`·`schema.ts`·`tools.ts`·`workspace.ts` 변경. 후자의 원문을 새로 읽었고 새 `intents.ts`·`intent-recovery.test.ts`를 추가 조사했다. 파일이 같아도 호출 사슬과 의존 환경이 바뀌면 과거 실행 결과를 현재 결과로 쓰지 않았다.

외부 비교는 표의 고정 ref마다 contents blob을 대조했다. Go sql.go·LICENSE 동일, Django query.py 변경/함수 동일·LICENSE 동일, singleflight.go·singleflight_test.go·LICENSE 동일. PostgreSQL lock-update-delete.spec·isolation README 동일, nodeLockRows.c·mvcc.sgml 변경/관련 메커니즘 유지·COPYRIGHT 연도 변경이다. GitLab은 이번 소스 심화로 새 고정 ref를 확인했다.

## 레퍼런스

외부 후보는 기존 9개에 Stripe API v1·Temporal을 보탠 11개다. 제품은 기준 소스이며 후보 수에서 제외한다. 심층 대상은 Go·Django·PostgreSQL·singleflight·GitLab 5개다. 모두 설계 참고이며 외부 코드 복사를 권고하지 않는다. 라이선스 원문도 확인했다.

| 레퍼런스 | 분류·고정 SHA | 라이선스 | 깊이·실행 경로·선정 이유 |
|---|---|---|---|
| Go database/sql | 인접 연결 풀 `d5d0a0fb68e5958cd9440ceb3198c0c9f8742107` (이전 `077076a718170357d86084f16f87dda36fb127fd`) | BSD-3-Clause | 소스; self-host Go tests, 이번 미실행. 준비 밖·closed 우선의 작은 실제 분기 |
| Django QuerySet | ORM `a0f2e29e0a98ee14aa808ebe38ec5fb79c8af71f` (이전 `47fe39af56ecd0ad73b9c7562511015e96b91b80`) | BSD-3-Clause | 소스; self-host Python/SQLite, 이번 미실행. 완료 hit·오류 뒤 승자 재조회 |
| PostgreSQL | DB `b0496e30830b7cee6d17485404dd4c51d7aea286` (이전 `7885b94dd81b98bbab9ed878680d156df7bf857f`), 실행 18.6 | PostgreSQL | 소스·독립 실행; 기존 binary의 임시 cluster. 최신행·순서·두 commit rollback |
| Go x/sync | 동시성 `1f920df1e8fcf601d1aaf0f2ea500e1d2ccce105` (이전과 동일) | BSD-3-Clause | 소스; self-host Go tests, 미실행. TestForget 신호와 in-flight 반례 |
| GitLab Workhorse | 업로드 `d7b9a6176ab4e279465ba3ee09922cde2b74de47` | 조사 lib 경로 MIT; doc CC-BY-SA·ee 별도 | 소스; self-host GitLab stack, 이번 미실행. authorize/준비된 자료 입력의 타입 경계 |

관점별 마지막 확장과 saturation(조사 범위 안의 판단):

- 준비/interface: Go·Workhorse 문서 → GitLab uploads·project_import/WorkhorseFile 소스 → Temporal Activity history. 마지막 라운드는 준비/효과 분리와 저장 결과 재사용의 변형이며 새 책임 배치가 필요하지 않았다.
- 경쟁/실패: Go·Django → AWS Powertools 공식 idempotency → Stripe API v1 공식 idempotent requests. 마지막 라운드는 입력 충돌·기존 결과·실행 전 실패와 실행 뒤 결과의 구분을 반복했다. 조직 신원 오류 정책은 외부 사례로 다시 결정하지 않는다.
- 검증/복구: singleflight → PG isolation 문서·permutation → Temporal 공식 testing-suite. 마지막 라운드는 실제 저장 경계+외부 입력 대역+순서 신호의 조합으로 수렴했다. time-skipping은 실제 DB 잠금을 대신하지 않는다. 완전 동형 선행 구현을 찾았다는 주장은 하지 않는다.

Django update_or_create(Event/일부 Timer), Citus flaky tests(검색만·근거 제외), Go os.Root(기존 경로 배경 문서), GitLab, AWS는 기존 후보다. 실행 경로는 각각 self-host Django+PG, Citus+PG, Go toolchain, GitLab stack, mock persistence이며 이번 추가 실행은 없다. Stripe는 계정/API 필요로 실행 경로 없음, 공식 문서만 비교했다. Temporal은 로컬 server+SDK test environment로 실행 가능하나 설치·실행하지 않았다. 둘 다 심층 미선정이며 신규 엔진 도입 권고가 아니다.

## 근거

E ID는 기존 의미를 이어가되 아래 상태·수준을 따른다. 역사적 실행을 이번 실행으로 세지 않는다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 실제 서버는 sourceOf를 acceptIntent 호출 전 평가한다. 정산 handler는 fixed source를 async reader로 포장하지만 DB 공개 입력은 여전히 실제 reader도 받아 잠금 안 await 가능 | [dispatch/sourceOf](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/server/src/tools.ts#L574-L633), [handler](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/server/src/tools.ts#L378-L388), [recordArtifact](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/db/src/tasks.ts#L200-L242) | 소스 확인 |
| <a id="E02"></a>E02 | 수락은 조직→실행 시도 잠금 아래 input/source를 commit한다. 정산은 조직→실행 시도→의도 잠금, 신원 확인→replay→현재 gate→효과·최초 결과·활동 Event 순이다 | [acceptIntent](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/db/src/intents.ts#L99-L185), [toolWrite](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/db/src/tool-calls.ts#L151-L220) | 소스 확인 |
| <a id="E03"></a>E03 | 이전 reader 정지→제어 잠금 지연 2case는 c88a98b 당시 직접 DB API 관찰이다. 현재 서버 경로 지연을 증명하지 않으며 새 완료 조건의 결과로 사용하지 않음 | 이전 조사 기준 c88a98b, E01의 현행 호출 경로와 대조 | 과거 실행·현재 근거 제외 |
| <a id="E04"></a>E04 | READ COMMITTED는 문장별 snapshot, 잠금 대기 뒤 최신행 조건 재확인. 짧은 tx·일관된 잠금 순서 권고 | [격리](https://www.postgresql.org/docs/18/transaction-iso.html), [잠금](https://www.postgresql.org/docs/18/explicit-locking.html) | 문서 주장 |
| <a id="E05"></a>E05 | ExecLockRows가 FIND_LAST_VERSION/EPQ로 최신행을 재평가한다 | [ExecLockRows](https://github.com/postgres/postgres/blob/b0496e30830b7cee6d17485404dd4c51d7aea286/src/backend/executor/nodeLockRows.c#L181-L280) | 소스 확인 |
| <a id="E06"></a>E06 | 이전 독립 PG probe 5 assertion은 최신행·동일키 직렬화·단일 tx rollback의 메커니즘 기록. 현재 두 commit 의미는 E16으로 보강 | 이전 PG18.6 최소 table 실행, 제품 통합 아님 | 과거 실행·범위 제한 |
| <a id="E07"></a>E07 | ON CONFLICT DO NOTHING은 해당 문장 snapshot에 보이지 않는 경쟁 때문에 insert를 생략할 수 있다. 승자 조회를 하나의 CTE snapshot에만 의존하면 안 됨 | [Read Committed](https://github.com/postgres/postgres/blob/b0496e30830b7cee6d17485404dd4c51d7aea286/doc/src/sgml/mvcc.sgml#L318-L395) | 문서 주장 |
| <a id="E08"></a>E08 | openNewConnection은 Connect를 mutex 밖에서 수행하고 재획득 후 closed를 연결 오류보다 먼저 판정 | [openNewConnection](https://github.com/golang/go/blob/d5d0a0fb68e5958cd9440ceb3198c0c9f8742107/src/database/sql/sql.go#L1276-L1307) | 소스 확인 |
| <a id="E09"></a>E09 | get_or_create 최초 hit는 defaults 평가 전, atomic 바깥 IntegrityError 처리에서 승자 재조회, 없으면 원래 오류 | [get_or_create](https://github.com/django/django/blob/a0f2e29e0a98ee14aa808ebe38ec5fb79c8af71f/django/db/models/query.py#L1088-L1111) | 소스 확인 |
| <a id="E10"></a>E10 | 기존 Django+SQLite probe의 최초 miss 대역·unique 승자·NOT NULL rollback은 과거 제한 실행. 실제 다중 연결 경쟁도 최신 SHA 실행도 아님 | 이전 Django 5.2.8 조사 | 과거 실행·현재 근거 제외 |
| <a id="E11"></a>E11 | TestForget의 started/release/finished channel로 순서를 고정한다. Do의 in-flight 합류는 별도 정책 | [TestForget](https://github.com/golang/sync/blob/1f920df1e8fcf601d1aaf0f2ea500e1d2ccce105/singleflight/singleflight_test.go#L156-L197), [Do](https://github.com/golang/sync/blob/1f920df1e8fcf601d1aaf0f2ea500e1d2ccce105/singleflight/singleflight.go#L91-L114) | 소스 확인 |
| <a id="E12"></a>E12 | PG isolation은 advisory lock과 commit/rollback permutation을 분리한다. 기존 서버 동시 파일 검사는 두 read 진입→최초 정산→원본 삭제→다른 read를 신호로 제어 | [PG spec](https://github.com/postgres/postgres/blob/b0496e30830b7cee6d17485404dd4c51d7aea286/src/test/isolation/specs/lock-update-delete.spec#L14-L61), [기존 경쟁 검사](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/server/test/intent-recovery.test.ts#L916-L958) | 소스 확인 |
| <a id="E13"></a>E13 | 최신 main에서 파일 산출물·실행 의도 복구 2파일 19 tests PASS. 실제 일회용 PG와 가짜 프로바이더 사용 | `env -i HOME="$HOME" PATH="$PATH" pnpm --filter @babojubot/server exec vitest run test/file-artifacts.test.ts test/intent-recovery.test.ts`; Node24.21.0, PG18.6, 2026-11-12, 제품 미커밋 변경 없음 | 실행 확인 |
| <a id="E14"></a>E14 | reader는 identity를 WorkspaceIdentityError, 일반 예외를 reject, 알려진 거부를 값으로 구별한다. sourceOf throw는 현재 승자 재조회에 도달하지 않는다. 새 파일 준비 전 task 검사도 dispatch 조사 범위에서 확인하지 못함 | [reader](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/server/src/workspace.ts#L332-L345), E01·#142 | 소스 확인 및 계약 대비 추론 |
| <a id="E15"></a>E15 | GitLab import는 Workhorse authorize와 준비된 파일 metadata를 구분하고 UploadedFile 타입만 받는다. 이는 그 아래 DB tx의 I/O 부재 증명은 아님 | [project_import](https://github.com/gitlabhq/gitlabhq/blob/d7b9a6176ab4e279465ba3ee09922cde2b74de47/lib/api/project_import.rb#L70-L110), [WorkhorseFile](https://github.com/gitlabhq/gitlabhq/blob/d7b9a6176ab4e279465ba3ee09922cde2b74de47/lib/api/validations/types/workhorse_file.rb#L6-L16) | 소스 확인 |
| <a id="E16"></a>E16 | 독립 PG18.6 최소 table probe 5 PASS: 수락 commit 후 효과 없음; activity trigger P0001; 정산 rollback 뒤 accepted/source 유지·result null·artifact/event 0; 재정산·replay 후 artifact1/event2·최초 bytes 유지 | Node24.21.0·pg8.23.1·PG18.6, 합성 자료, 별도 임시 cluster, 메모리 상한2GiB·키 없는 셸, 종료 확인. 제품 복구 검증 아님 | 실행 확인 |
| <a id="E17"></a>E17 | 복구는 저장 input/source로 같은 handler를 사용하고 missing_source를 차단한다. 의도 schema는 agent/key unique·조직 복합 FK·상태별 제약을 둔다 | [settle](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/server/src/tools.ts#L635-L673), [schema](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/db/src/schema.ts#L1272-L1330) | 소스 확인 |

## 패턴

| ID | 패턴 | 사례·프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|
| <a id="P01"></a>P01 | 잠금 밖 준비, 자료를 받는 효과 경계 | E01·E08·E15; Go는 예약, GitLab은 경로 참조. 제품은 고정 bytes+기존 의도 | 호출자가 안전한 순서를 몰라도 됨 | callback을 남기면 잠금 안 I/O가 다시 가능 |
| <a id="P02"></a>P02 | 기존 의도 조회·실패 뒤 승자 조정 | E02·E09·E14; Django는 IntegrityError 한정, 제품은 일반 실패와 identity 차단 구분 | 최초 결과·고정 자료 유지 | identity 평탄화, 옛 토큰 조회, Role/단계로 완료 조회 차단 |
| <a id="P03"></a>P03 | 영속 수락과 원자 정산의 두 commit | E02·E05–E07·E16–E17 | 정산 실패 후 고정 자료로 복구 | 수락도 사라진다고 가정하거나 실패 준비 자료로 승자 source 교체 |
| <a id="P04"></a>P04 | 신호로 순서 고정 + 실제 저장 실패 | E11–E13·E16 | 지연 임계값 없이 경쟁·rollback 재현 | 대역만으로 실제 DB rollback 입증, time-skipping으로 DB 대기 대체 |

## 결정 권고

현재 #142의 확정 철학·책임·정책 안에서의 기술 권고다. 과거 D01–D05의 내용은 이 표로 갱신한다.

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | 기존 공통 실행 의도 module의 한 진입점이 사전 확인→잠금 밖 준비→수락 commit→정산을 소유. DB recordArtifact는 준비된 읽기 결과 또는 경로 없는 입력만 받고 async reader 입력 제거 | P01·P03, #142 책임 배치 | 안전한 현재 서버 호출만으로 unsafe DB interface가 해소되지는 않음. 범용 실행 framework는 불필요 | Q1 |
| <a id="D02"></a>D02 | 변형 채택 | 유효 실행 신원→같은 키 tool/digest 충돌→기존 의도 처리. 완료는 현재 Role/단계 gate 앞 replay, 미수행만 현재 규칙. 신규 준비 전 task 소속 확인, 정산에서도 확인 | P02·E17, #142 | 다른 조직/없는 task는 같은 거부·reader 진입 없음. 완료 hit에 새 task/파일 검사 추가 안 함 | Q1·Q2 |
| <a id="D03"></a>D03 | 변형 채택 | 일반 준비 성공/거부/throw 모두 신원·동일 의도와 조정. 승자 source 유지. 승자 없는 throw는 원래 오류·수락 없음. 알려진 거부값은 고정 자료로 기존 확정 거절. 준비 중 identity 오류는 수렴에서 제외 | P02, #142 준비·재호출·제어 | 예외 객체를 복구 source로 저장하거나 identity를 성공으로 우회하지 않음 | Q2 |
| <a id="D04"></a>D04 | 변형 채택 | 수락 tx와 정산 tx를 구별. 정산 tx 하나에 artifact·bytes·최초 결과·산출물/활동 Event. 실패 뒤 accepted/source는 남아 기존 복구 대상. gate와 실제 DB trigger로 두 경계 검증 | P03·P04 | 같은 의도 정산/replay를 기존 경로로 재사용. 최종 취소가 먼저면 새 효과 없음 | Q1·Q3 |
| <a id="D05"></a>D05 | 배제 | singleflight·산출물 전용 pending/lease·별도 복구·전체 준비 transaction·이전 LockedRun 재사용·경로 문자열만 확인 | E01·E08·E11, #142 | 중복 읽기 억제는 범위 밖. 장시간 잠금/취소 누락/기존 경로 경계 약화 방지 | Q1–Q3 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| INPROGRESS 예약·첫 reader 합류 | AWS Powertools·Go singleflight | 기존 실행 의도 외 산출물 예약을 추가하는 정책은 제외 |
| 일반 실패를 곧바로 최종 응답, 또는 identity도 승자 결과로 수렴 | 단순 try/catch 변형 | 각각 동시 의도 수렴과 조직 신원 차단 계약 위반 |
| 정산 실패 시 수락 기록까지 없어야 함 | 이전 단일 tx 결과를 두 commit에 일반화 | 별도 수락 commit과 #150 복구 계약 위반 |
| unique 충돌 후 실패한 PG tx 안에서 재조회 | Django atomic을 savepoint/rollback 없이 번역 | 실패 tx는 그대로 사용할 수 없음. 기존 조직 잠금/tx 경계를 유지 |
| 원본 path 재읽기·새 bytes로 source 교체 | 지연 참조/복구 변형 | 최초 고정 자료 보존 계약 위반 |

## 구현 참고

현재 연결은 HTTP/MCP→tools.dispatch/sourceOf→acceptIntent→handle→recordArtifact/toolWrite이며 복구도 settle→handle을 쓴다. 이 공통 순서를 기존 실행 의도 module 책임으로 모으고 transport에는 전송 해석·인증·응답을 남긴다. 구체 파일명·helper 수는 확정하지 않는다. 산출물 준비는 조직 task 사전 검사·기존 Workspaces.readArtifact를 맡고 DB 효과는 고정 자료만 받는다. 실제 reader·별도 프로세스·표식·경로 고정·파일 identity·digest의 JSON 표기를 유지한다. 기준은 [구조](../architecture.md)와 ADR-0002·0005다.

사전 검사 결과의 AfterCommit/거부 Event도 기존 의미로 보존한다. 완료 replay는 새 Event가 없고, 늦은 저장 거부에서 제어 자체의 Event와 기존 수락 기록은 ‘새 등록 효과’와 구별한다. 복구 실패 차단·제한 재시도·사용자 복구 재시도·모델 전 전달은 관련 #150 계약을 그대로 따른다. 이번 조사로 다시 설계하지 않는다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | reader entered→pause/stop 응답·DB 취소 commit 확인→reader 아직 미해제→해제 뒤 새 정산 효과 없음. 실행 중단/종료도 별도 case | D01·D04 |
| V02 | 같은 키 A/B read 진입→B 수락·정산→A 일반 거부/throw→유효 신원이면 최초 결과·source 불변. B 뒤 취소 commit이면 A 거부 | D02–D04 |
| V03 | V02의 A가 조직 표식 오류→B 승자와 무관하게 차단. 승자 없는 일반 throw→원래 오류·수락/효과 없음. 거부값은 기존 확정 거절 | D03 |
| V04 | 다른 조직 task/없는 task 신규 등록→같은 거부·reader 미진입. 정산 때 소속 재검사·조직 밖 효과 없음 | D02 |
| V05 | 완료 키+원본 삭제→HTTP↔MCP 재호출→최초 결과·reader 미호출. 현재 단계가 닫혀도 조회, 옛 토큰은 거부. tool/digest 다르면 충돌 | D02 |
| V06 | 중복 read 성공·bytes 다름→하나의 의도·최초 snapshot·효과. 다른 키 동일 내용→별개 효과. 키 간 승자 혼용 금지 | D02–D04 |
| V07 | 수락 commit 뒤 정산의 artifact/result/Event 저장 중 실제 constraint/trigger 실패→효과·결과·등록 Event rollback, accepted/source 보존 가능→재시작·기존 복구로 원본 재읽기 없이 한 번 정산 | D04 |
| V08 | 고정 bytes→원본 수정/삭제·재시작→최초 내용 유지. missing_source/모순/소진→#150 차단·사용자 재시도. 사용자 취소 의도 부활 없음 | D04 |
| V09 | 경로 바꿔치기/표식/파일 identity/다른 조직 파일→기존 거부. 경로 없는 등록 유지. 초기 승인·사용자 최종 완료·조직 분리 회귀 | D01·D05 |

주 경계는 기존 HTTP/MCP·사용자 제어 API·실제 일회용 PG·가짜 프로바이더다. entered/release/control-completed 신호로 순서를 정하고 runner timeout은 교착 탈출에만 쓴다. finally에서 gate 해제·진행 중 요청 수거를 보장한다. 구현 배치나 private 호출 횟수를 복제하는 테스트는 만들지 않는다.

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 새 제품 정책 | 해당 없음 | 현재 #142의 확정 정책 유지. 재인터뷰 불필요 |
| 공통 module의 내부 파일/helper·저장 실패 주입 위치 | #142 구현 | 기존 내부 진입점 정리 또는 작은 private helper. 안전한 순서·prepared-only 저장·기존 복구 동일 경로를 만족해야 함 |

## 한계와 미확인

- 이번 실행은 기존 서버 2파일 19개와 독립 PG 두 commit probe 5 assertion이다. 전자는 현행 기준선, 후자는 최소 table의 DB 메커니즘이다. 제품의 새 #142 완료 조건을 통과시킨 구현 결과가 아니다. 신규 pause/stop gate·throw/identity 경쟁·task 사전 거부·제품 정산 DB 실패·복구 조합은 미실행이다.
- Go·Django 새 SHA 원본 실행, upstream PG isolation suite, GitLab self-host, Temporal·AWS mock은 미실행이다. 과거 E03·E06·E10 실행을 최신 제품 검증으로 격상하지 않았다. 소스 upstream HEAD와 실행 PG18.6을 구별한다.
- 전체 제품 suite·E2E·macOS/Windows·실제 30초 reader timeout·실제 모델/프로바이더·SIGKILL은 미실행이다. 제품 코드·테스트·설정 변경과 모델 호출은 하지 않았다. 공개 자료만 사용했고 계정/API 실행 경로에 접근하지 않았다.
- 다른 작업의 미커밋 #146 조사와 #150 triage 초안은 수정하지 않았다. upstream 변경 시 파일별 ref를 다시 확인한다. 코드 복사 시 LICENSE/header/NOTICE/의존성 및 THIRD_PARTY_NOTICES를 별도 확인해야 한다.
