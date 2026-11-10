# issue-142 레퍼런스 조사: 산출물 파일 준비를 조직 쓰기 잠금 밖으로 분리

#142의 확정 계약을 구현할 잠금·재호출·검증 근거를 다룬다. 현재 동작은 [구현 현황](../current-implementation.md), 요구사항은 [#142](https://github.com/babo-jeonguk/BaboJUBot/issues/142)가 기준이다.

조사일: 2026-11-10. 구현 전 기술 권고이며 확정 계약이나 구현 결과가 아니다. 제품 기준 SHA: `c88a98b58284a38bdadf7eff7aafa0219005371c`. 상세 후보·원문·실행 로그는 로컬 조사 캐시에 보존한다. 문서는 커밋하지 않고 구현 변경과 함께 커밋되게 둔다.

## Brief

- 구현할 문제: 파일 읽기를 기다리는 동안 조직·실행 시도 잠금을 붙잡아 pause/stop이 늦어지는 경로를 분리한다.
- 동종 문제: 비싼 준비는 임계 구역 밖에서 수행하고, 짧은 최종 임계 구역에서 최신 유효성·동일 요청의 완료 결과를 조정한 뒤 원자적으로 저장한다.
- 고정된 결정: 중복 읽기 허용·저장 효과 한 번, pending/키별 in-flight 잠금/lease 미도입. 사전 확인 → 파일 준비 → 최종 확정을 등록 모듈이 소유한다. 최신 실행 권한이 완료 기록보다 우선한다. reader 성공·거부·예외 모두 최종 확정으로 가져간다. snapshot은 기존 reader의 bytes이며 작성 중 파일의 원자 snapshot 보장을 추가하지 않는다.
- 불변 조건: 초기 연구 승인·사용자 최종 완료·조직 경계는 코드가 강제한다. 표식·경로 고정·파일 identity 검사와 경로 없는 등록을 유지한다. 공개 OSS·합성 데이터만 사용하며 실제 모델 호출은 없다.
- 관계: parent API는 404(No parent), blocker API는 빈 목록. #140·#141은 독립 명세이며 구현 선행 조건으로 추가하지 않는다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 잠금 밖 준비 뒤 최신 권한·취소·조직 상태는 어떤 순서로 재검증하는가? | #142 구현 전 조사 1, Implementation Decisions | Source Recon + runtime/failure + 권한 경쟁 |
| Q2 | 완료 결과의 선조회와 읽기 성공·거부·예외/동시 완료를 어떻게 조정하는가? | #142 구현 전 조사 2, User Stories 5–7·10 | Source Recon + persistence/recovery |
| Q3 | reader 정지 중 제어 완료·늦은 등록 거부·롤백을 시간 임계값 없이 어떻게 재현하는가? | #142 구현 전 조사 3, Testing Decisions | Behavioral Recon + DB failure + barrier 테스트 소스 |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [조직 폴더 identity](workspace-identity-references.md#근거) | 논리 조직·경로·OS 격리의 구분, 기존 E03–E04의 호출 경로 | 이전 `9efe7f3…`와 현재 SHA의 파일별 blob 비교: tool-calls.ts 동일; workspace.ts/tasks.ts/schema.ts 변경. 현재 원문을 새로 읽어 E01–E02로 기록. 과거 실행 결과는 이번 결과로 옮기지 않음 |
| [경로 confinement](artifact-path-confinement.md#공통-결론) | 이름 선거부 + 고정 폴더 내부 실제 걷기를 유지할 회귀 범위 | Go 공식 [os.Root 설명](https://go.dev/blog/osroot)과 현재 reader 원문 대조. 과거 branch URL은 고정 소스 근거로 재사용하지 않음 |
| [#140](issue-140-references.md), [#141](issue-141-references.md) | 시작·종료 책임과 이번 파일 준비의 범위 구분만 | 결론·외부 SHA·실행 결과는 재사용하지 않음. 공통 toolWrite와 현재 제어 경로를 직접 확인 |
| [조직별 CLI 제품 폴더](org-product-folders-references.md) | 로그인 공유와 산출물용 shared의 용어 구분만 | 이번 변경 대상 아님. 인증·CLI 실제 실행 근거는 재사용하지 않음 |

## 레퍼런스

관점별 포화는 조사 범위 안의 판단이다.

- DB/명세: READ COMMITTED → lock 순서·실패 문서 → isolation permutation으로 확장. 마지막 라운드는 최신행·별도 조회·원자 롤백의 검증 변형으로 수렴했다.
- OSS 준비/확정: 연결 풀의 느린 연결 → ORM의 경합 뒤 재조회 → GitLab 업로드·AWS Powertools 문서로 확장. 최종 라운드는 준비/확정 분할 또는 진행 중 예약의 변형으로 수렴했다. 업로드의 분할만으로 실행 권한·완료 결과 우선순위를 설명하지 못해 부분 패턴을 조합했다. 완전 동형 구현을 찾았다고 주장하지 않는다.
- 경쟁 검증: singleflight channel → PostgreSQL permutation → ORM Event·flaky test 실패 보고. 마지막 라운드는 시작·해제·완료 신호 또는 실제 잠금 대기 관찰을 반복했다.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| PostgreSQL | DB·공식 명세·isolation test | 소스 17.6 `7885b94dd81b98bbab9ed878680d156df7bf857f`; 실행 18.6 | PostgreSQL | 소스·독립 실행 | 최신행 재검증·잠금 순서·저장 원자성 |
| Go database/sql | 인접 연결 풀 | `077076a718170357d86084f16f87dda36fb127fd` | BSD-3-Clause | 소스 | 잠금 밖 준비 후 닫힘을 오류보다 먼저 재검증 |
| Django QuerySet | ORM | 5.2.8 `47fe39af56ecd0ad73b9c7562511015e96b91b80` | BSD-3-Clause | 소스·제한 실행 | 완료 결과 선조회, 경합 오류 뒤 승자 재조회 |
| Go x/sync singleflight | 동시성 라이브러리 | `1f920df1e8fcf601d1aaf0f2ea500e1d2ccce105` | BSD-3-Clause | 소스 | sleep 없는 TestForget과 in-flight 합류의 정책 반례 |
| BaboJUBot | 현행 경계 | 위 기준 SHA | MIT | 소스·독립 실행 | 실제 등록·제어 잠금 지연과 기존 파일 계약 |

Go·PostgreSQL 소스 캐시는 선택 파일 snapshot이고, Django는 기존 고정 SHA checkout을 재사용했다. 모두 설계 참고이며 외부 코드 복사를 권고하지 않는다.

## 근거

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | recordArtifact가 task 소속 확인 후 reader를 toolWrite 안에서 await한다. toolWrite는 조직→실행 시도 잠금, 권한→완료 기록→쓰기→호출 기록·활동 Event 순서다 | [recordArtifact](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/db/src/tasks.ts#L200-L243), [toolWrite](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/db/src/tool-calls.ts#L117-L169), [row locks](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/db/src/rows.ts#L156-L197) | 소스 확인 |
| <a id="E02"></a>E02 | controlOrganization도 조직 잠금 후 취소를 저장한다. reader는 조직 표식·고정 경로·identity를 검사하고 bytes를 snapshot으로 변환한다. 키 PK는 agentId+key이며 조직 복합 FK가 있다 | [제어](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/db/src/control.ts#L29-L69), [reader](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/apps/server/src/workspace.ts#L135-L287), [snapshot](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/apps/server/src/workspace.ts#L426-L489), [key](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/db/src/schema.ts#L1234-L1270) | 소스 확인 |
| <a id="E03"></a>E03 | 실제 recordArtifact의 reader 대역을 barrier로 정지시키면 pause/stop이 pg_blocking_pids에 잡힌다. reader 해제 뒤에야 제어가 완료됨(2 case) | 로컬 probe; Node 24.21.0·PostgreSQL 18.6, 독립 임시 DB·합성 조직 | 실행 확인 |
| <a id="E04"></a>E04 | READ COMMITTED는 문장별 snapshot이며 대기한 행 잠금은 갱신된 행과 조건을 다시 검사한다. 일관된 잠금 순서와 짧은 transaction이 필요하다 | [격리 공식 문서](https://www.postgresql.org/docs/18/transaction-iso.html), [잠금 공식 문서](https://www.postgresql.org/docs/18/explicit-locking.html) | 문서 주장 |
| <a id="E05"></a>E05 | ExecLockRows는 FIND_LAST_VERSION/EPQ로 갱신 후 행을 재평가하고 조건 불일치 행을 제외한다 | [ExecLockRows](https://github.com/postgres/postgres/blob/7885b94dd81b98bbab9ed878680d156df7bf857f/src/backend/executor/nodeLockRows.c#L181-L221), [EPQ](https://github.com/postgres/postgres/blob/7885b94dd81b98bbab9ed878680d156df7bf857f/src/backend/executor/nodeLockRows.c#L254-L280) | 소스 확인 |
| <a id="E06"></a>E06 | 독립 PG probe: 잠금 대기 관찰→갱신 commit→최신 inactive 반환. 조직 잠금 뒤 별도 완료 조회로 동일키 결과·artifact/receipt/event 각 1행. 실제 Event unique 위반 후 artifact/receipt 0행으로 롤백 | 로컬 probe; Node pg 8.23.1·PG18.6, 5개 PASS assertion | 실행 확인 |
| <a id="E07"></a>E07 | ON CONFLICT DO NOTHING은 문장 snapshot에 안 보이는 경쟁 때문에 삽입을 생략할 수 있다 | [MVCC 명세](https://github.com/postgres/postgres/blob/7885b94dd81b98bbab9ed878680d156df7bf857f/doc/src/sgml/mvcc.sgml#L370-L375) | 문서 주장 |
| <a id="E08"></a>E08 | Go openNewConnection은 Connect를 mutex 밖에서 호출하고 재획득 후 db.closed를 연결 오류보다 먼저 처리한다 | [openNewConnection](https://github.com/golang/go/blob/077076a718170357d86084f16f87dda36fb127fd/src/database/sql/sql.go#L1276-L1307) | 소스 확인 |
| <a id="E09"></a>E09 | Django get_or_create는 최초 조회로 defaults 실행을 건너뛰며 IntegrityError 뒤 재조회에서 승자가 있으면 반환, 없으면 원래 오류를 다시 던진다 | [get_or_create](https://github.com/django/django/blob/47fe39af56ecd0ad73b9c7562511015e96b91b80/django/db/models/query.py#L938-L961) | 소스 확인 |
| <a id="E10"></a>E10 | 원본 Django+SQLite에서 완료 조회 시 defaults 미평가, 최초 miss 주입 뒤 실제 unique 오류에서 승자 반환, 승자 없는 NOT NULL 실패·rollback을 확인했다 | 로컬 probe; 최초 조회만 대역, 동시 스레드 경쟁 아님 | 실행 확인 |
| <a id="E11"></a>E11 | Go TestForget은 firstStarted/unblockFirst/firstFinished/unblockSecond 채널로 순서를 강제한다. Do는 진행 중 호출에 합류한다 | [TestForget](https://github.com/golang/sync/blob/1f920df1e8fcf601d1aaf0f2ea500e1d2ccce105/singleflight/singleflight_test.go#L156-L197), [Do](https://github.com/golang/sync/blob/1f920df1e8fcf601d1aaf0f2ea500e1d2ccce105/singleflight/singleflight.go#L91-L114) | 소스 확인 |
| <a id="E12"></a>E12 | PG isolation test는 advisory lock으로 snapshot/갱신 순서를 정하고 commit·rollback permutation을 분리한다 | [lock-update-delete.spec](https://github.com/postgres/postgres/blob/7885b94dd81b98bbab9ed878680d156df7bf857f/src/test/isolation/specs/lock-update-delete.spec#L14-L61) | 소스 확인(테스트 미실행) |
| <a id="E13"></a>E13 | 기존 파일 통합·서버 경로 접근 검사의 2파일 6 tests 통과. 원본 수정·삭제·재시작 보존 및 HTTP→MCP 재호출 포함 | `pnpm --filter @babojubot/server exec vitest run test/file-artifacts.test.ts test/workspace-resolve.test.ts`; 기존 테스트 원문 [파일 통합](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/apps/server/test/file-artifacts.test.ts#L28-L278) | 실행 확인 |
| <a id="E14"></a>E14 | 잠금 밖 준비 후 최신 유효성(E08), 오류 후 승자 재조회(E09), DB 직렬화(E04–E06)를 조합하면 #142의 우선순위를 구현할 수 있다. 어느 단일 OSS도 조직 권한·reader 실패 전체 계약의 근거는 아니다 | #142 + E01–E12 | 추론 |

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 준비를 잠금 밖으로 이동, 최신 상태 재확인 | E04–E05·E08 | Go는 closed와 연결 수 예약, 우리는 실행 권한·조직·task; Go의 예약은 채택 안 함 | 느린 I/O와 제어 잠금 분리 | 사전 허용을 권한 증표로 쓰면 취소 후 쓰기 |
| <a id="P02"></a>P02 | 완료 선조회 + 최종 승자 재조회 | E01·E06·E09 | Django는 IntegrityError 한정, 우리는 읽기 성공·거부·예외 전부 | 재호출에 파일 불필요, 실패한 호출도 승자에 수렴 | 오류 즉시 반환·권한보다 완료 우선이면 계약 위반 |
| <a id="P03"></a>P03 | 짧은 직렬 최종 tx에 저장 효과 결합 | E01–E02·E06–E07 | 조직 잠금이 중복 저장 직렬화, key PK 보조 | bytes·기록·Event 원자성 | 단일 CTE의 snapshot 가정, 정상 반환으로 오류를 삼키는 tx |
| <a id="P04"></a>P04 | 명시적 순서 신호 + 실제 DB 오류 | E03·E06·E11–E13 | Go 채널, PG SQL 단계, 우리 reader 대역 | 시간 측정 없이 경쟁 분기 강제 | timeout을 성공 판정으로 쓰면 flaky; 대역만으로 DB 롤백 검증 불가 |

## 결정 권고

아래는 #142 확정 계약의 구현 권고다. 새로운 제품 정책을 결정하지 않는다.

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 채택 | 짧은 사전 tx → 잠금 없는 준비 → 짧은 최종 tx. 두 tx 모두 기존 조직→실행 시도 순서·권한/단계→완료 키→task 소속 확인 | P01·P02, #142 | 사전 tx는 예약하지 않으므로 중복 읽기가 생김. 최신 판정이 최종 권한 | Q1·Q2 |
| <a id="D02"></a>D02 | 변형 채택 | 준비 결과를 success/refusal/exception으로 보관. 최종 잠금 뒤 권한 거부 우선, 같은 키 tool/digest 충돌 또는 완료 결과 처리, 완료 없을 때 task 확인 후 준비 결과 적용 | P02, E14 | 다른 호출 완료를 놓치지 않고 기존 예외 의미 유지. 실패를 성공으로 일반 변환하지 않음 | Q2 |
| <a id="D03"></a>D03 | 채택 | 최종 tx에 산출물 행·bytes·호출 결과·산출물 Event·활동 Event를 함께 저장. 잠금 획득 뒤 별도 완료 SELECT 유지 | P03 | 준비된 bytes만 저장; 원본을 재독하지 않음. 저장 오류는 전부 롤백 | Q1·Q2·Q3 |
| <a id="D04"></a>D04 | 변형 채택 | reader별 entered/release와 제어 응답/commit을 이용해 순서 지정. DB 실제 constraint/trigger 실패로 부분 저장 없음 확인 | P04 | 테스트 runner timeout은 교착 탈출 장치, 지연 임계값은 성공 근거 아님 | Q3 |
| <a id="D05"></a>D05 | 배제 | singleflight·pending 예약·lease, 전체 준비를 감싼 transaction, 경로 문자열만 사전 검증 | E01–E03·E11, #142 | 중복 읽기 억제는 범위 밖. 긴 잠금은 원인 유지. 문자열 검사는 기존 파일 경계 약화 | Q1·Q2 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 진행 중 첫 reader 결과에 합류 | Go singleflight | 한 번만 읽기를 위한 in-flight 상태가 필요하고 #142에서 명시 제외 |
| unique 충돌이 난 뒤 같은 실패 transaction에서 바로 조회 | Django를 savepoint 없이 번역 | PostgreSQL의 실패 tx는 rollback 전 사용 불가. 기존 조직 잠금으로 선조회를 직렬화하는 경로 유지 |
| 파일 저장·해시만 분리하고 이전 LockedRun 재사용 | 준비만 이동한 변형 | 최종 취소·단계·조직 검사가 사라짐 |
| 원본 path를 저장하고 나중에 내용 읽기 | 지연 참조 변형 | 등록 당시 bytes 보존·원본 없는 재호출 계약 위반 |

## 구현 참고

등록 모듈이 단계 순서를 소유한다. `packages/db/src/tasks.ts`의 recordArtifact와 `tool-calls.ts`의 공통 검사·완료 조회를 함께 살피되, 외부 호출자에 prepare/commit 순서 조립 책임을 넘기지 않는다. 공통 검사 분리 시 다른 쓰기 도구의 동작을 바꾸지 않는다. `apps/server/src/tools.ts`는 기존 readFile 주입·HTTP/MCP 공통 도구 경로를 유지한다. `workspace.ts`의 실제 reader·표식·경로 걷기는 유지한다. core에 DB/OS 의존성을 추가하지 않는다([구조](../architecture.md#패키지-구성), ADR-0002·0005).

읽기 동안 열린 tx 자체가 없어야 한다. 사전 tx의 AfterCommit/거부 이벤트를 버리거나 최종 재호출에 활동 Event를 더 만들지 않도록 반환 결과도 보존한다. 명세의 ‘새 Event 없음’은 취소/종료 후 늦은 저장 시나리오다. 기존 단계/Role 거부가 남기는 tool.refused 정책은 임의로 없애지 않는다. 파일 hash를 계산하는 경로가 있다면 준비 구간에 두며, 기존 키의 request digest를 mutable 파일 내용 digest로 바꾸지 않는다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | reader entered 대기 → pause/stop 응답·DB 취소 확인 → reader를 아직 열지 않았음 → 해제 후 새 산출물/호출 결과/산출물·활동 Event 없음 | D01·D04 |
| V02 | reader 정지 → 실행 중단/정상 실행 종료 commit → reader 해제 → 뒤늦은 저장 거부 | D01·D04 |
| V03 | 동일키 A/B reader 진입 → B 성공 commit → A 거부 또는 예외 해제 → 권한 유효면 B의 ID·결과, 저장 효과 각 한 번 | D02–D04 |
| V04 | V03의 B commit 후 pause/stop 취소 commit → A 해제 → 완료 기록 대신 최신 권한 거부 | D01·D02 |
| V05 | 완료 키·원본 삭제 → HTTP↔MCP 재호출 → 원본 결과, reader 호출 없음. tool/digest 다르면 충돌 | D02·D03 |
| V06 | 두 reader 모두 성공·bytes 다름 → 두 최종 tx → 먼저 저장한 한 snapshot/결과로 수렴 | D02·D03 |
| V07 | artifact/receipt 저장 이후 Event insert 실제 실패 주입 → rollback → artifact·bytes·receipt·두 Event 모두 증가 없음 | D03·D04 |
| V08 | 다른 조직 task·파일/표식 불일치·경로 바꿔치기 → 등록 → 기존 거부·외부 bytes 미등록. 원본 변경/삭제·재시작 후 bytes 유지; path 없는 입력도 성공 | D01·D03·D05 |
| V09 | 승자 없는 reader 거부·예외 → 최종 확인 → 기존 실패 의미·쓰기 없음. 사전 권한 거부/교차조직 task면 reader 진입 없음 | D01·D02 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 제품 정책 | 해당 없음 | #142의 사용자 확정 유지. 재인터뷰 불필요 |
| 내부 helper 모양·실제 저장 실패 주입 위치 | #142 구현 | 공통 검사/완료 조회 private helper 또는 등록 전용 내부 조립. 외부 계약과 단일 단계 소유 유지(D01–D04) |

## 한계와 미확인

- 실행은 현행 지연 2case, 독립 PG 메커니즘 5 assertion, Django SQLite 제한 probe, 기존 파일 관련 6 tests다. #142 구현과 신규 경쟁 회귀 검사는 하지 않았다. 지연 probe는 실제 recordArtifact/제어 DB API + reader 대역이며 실제 30초 reader timeout이나 HTTP 제어 지연 측정은 아니다.
- Go toolchain이 없어 database/sql·singleflight 원본 테스트 실행은 미확인이다. TestForget의 채널 방식만 인용하며 sleep이 있는 다른 테스트를 시간 독립 검증으로 일반화하지 않는다. PostgreSQL upstream isolation suite도 실행하지 않았다.
- PostgreSQL 소스 17.6과 실행 18.6을 구별한다. 독립 DB의 최소 table probe는 제품 FK·Event·승인·조직 격리 전체 검증이 아니다. Django의 최초 miss 주입은 실제 다중 연결 경쟁이 아니다.
- 기존 file-artifacts 테스트의 고장 폴더 case는 예상된 EEXIST 진단을 출력했지만 검사 종료는 성공했다. 전체 DB/server suite, workspace-race 전체, macOS/Windows, E2E, 실제 모델·프로바이더는 미실행이다.
- 공개 자료만 사용했고 로그인·유료 API가 필요한 경로에 접근하지 않았다. 현재 실패한 샌드박스 대신 승인된 로컬 실행으로 캐시·독립 임시 DB만 썼으며 서버는 정리했다.
- upstream 변경 시 새 SHA를 읽는다. 외부 코드 복사 시 LICENSE/header/NOTICE/의존성과 THIRD_PARTY_NOTICES 규칙을 별도 확인한다.
