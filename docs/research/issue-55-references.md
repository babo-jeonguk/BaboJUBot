# issue-55 레퍼런스 조사: 판 1 · 작업과 작업자 실행 시도

조사일: 2026-10-19(KST). 대상: [#55](https://github.com/babo-jeonguk/BaboJUBot/issues/55), 부모 [#49](https://github.com/babo-jeonguk/BaboJUBot/issues/49), 완료된 선행 [#54](https://github.com/babo-jeonguk/BaboJUBot/issues/54). **구현 전 권고이며 확정 계약이나 구현 완료가 아니다.** 상세 자료는 `.reference-cache/issue-55/`(Git 무시)에 둔다.

## Brief

- 구현할 문제: `연구 진행` 단계에서 Lead가 작업(담당·부모)을 만들고 담당 작업자의 실행 시도가 산출물·자기 보고 요약·완료를 남기며, 완료는 부모 담당자(부모 없으면 생성자)를 깨운다. 같은 조직 메시지와 사용자 작업 댓글도 수신자/담당자를 깨운다. 목록·작업 상세 페이지·산출물 단건 페이지를 실시간 갱신한다.
- 동종 문제: 조직 범위의 영속 업무 기록 변경을 수신자별 후속 실행으로 연결하면서 산출물 출처와 자기 보고를 보존하는 메커니즘.
- 고정된 결정: ADR-0001 자체 모델 loop 없음, 가짜 실행기; ADR-0002 영속 기록+깨우기, 실행 중 입력은 다음 실행 시도; ADR-0003 기본 꺼진 승인 정책, 초기 승인은 필수; ADR-0004 기존 TS/Postgres 스택. 도구 범위는 실행 시도 토큰에서만 결정. 사용자는 Lead 대화 또는 작업 댓글. 상세는 별도 경로. 작업은 연구 노드 0~1개. 연구 지도 자체는 후속 #56 범위 확인 예정.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 작업 상태·완료의 원자성·중복 완료·부모/생성자 깨우기를 어떻게 보존하는가? | #55 What to build 1–3, AC 1–2; ADR-0002 | Source Recon + runtime/failure + persistence/recovery |
| Q2 | 할당·메시지·댓글을 기록과 묶고 실행 중 수신을 다음 실행 시도에 어떻게 전달하는가? | #55 도구·깨우기, AC 1–3; #53 기존 계약 | Source Recon + runtime/failure |
| Q3 | 담당·부모·수신자·산출물의 교차 조직 참조와 종료 토큰·비담당 완료를 어디서 거부하는가? | #55 AC 4; AGENTS 제품 불변 조건 | Source Recon + adversarial scenario |
| Q4 | 산출물 최소 저장 형식·작업/작성자/실행 시도 출처·자기 보고와 검증 결과 구분은? | #55 도구·화면; GLOSSARY 산출물/연구 기록 | Source Recon + persistence/recovery; protocol contract |
| Q5 | 목록→작업 상세→산출물 단건과 댓글 thread의 상태·좁은 폭·실시간 갱신은? | #55 화면·AC 5; features 화면 지도 | Surface Capture + Behavioral Recon |
| Q6 | 기존 가짜 실행기·도구 경계에 협력 시나리오를 어떤 최소 계약으로 붙일까? | #55 AC 1–4; #54 댓글 501·Lead-only | Source Recon + protocol/contract + 음성 대조군 |


부모 #49 본문의 옛 `목록만`·`에이전트 보기만` 범위보다 #55 본문·2026-10-14 범위 갱신 댓글과 현재 [화면 지도](../features.md#웹-대시보드-화면-지도)를 우선한다. #54 댓글의 `create_task`는 아직 501이며 작업자 기본 시나리오도 없다. 확인한 현재 구현 기준은 `f81921b15bec200445c99b7e01cff54b4f5995be`다. 이 조사는 제품 코드·테스트·설정을 바꾸지 않는다.

| 재사용한 조사 | 쓰는 범위 | 재확인·판단 |
|---|---|---|
| [#53](issue-53-references.md#brief)·[#54](issue-54-references.md#brief) | 실행 토큰·깨우기 묶음·종료와 쓰기의 직렬화, 승인 후 작업자·하네스 사본 | 현재 contracts/run·tools·message, core/approval, db/runs·approvals, server/tools, runtime/scripted·tools-client·testing를 읽어 연결 위치 확인. 과거 실험을 이번 제품 API 검사로 세지 않음 |
| [#52](issue-52-references.md#brief)·[#1](issue-1-references.md#brief) | 원자적 조직 기록, fake 실행기·계약 검증, 기존 임시 PG 설치 | 확정 스택과 구현을 기준으로 사용. 옛 저장 엔진·backlog·승인 정책 권고는 재채택하지 않음 |
| [#50](issue-50-references.md#brief)·[Paperclip 화면](paperclip-dashboard.md#22-작업task계획-화면)·[기타 화면](dashboard-references.md#62-관찰-실행-시도-작업자-외부-job) | 작업 상세·댓글·산출물 진입과 scope별 캐시의 질문 출발점 | 화면 지도와 #55의 별도 상세 경로 우선. 과거 캡처를 새 UI 실행으로 세지 않음 |
| [협력](agent-interaction-models.md#paperclip)·[실행 모델](agent-runtime-models.md#기준-버전과-조사-방식)·[Paperclip](paperclip.md#핵심-판단)·[코드 구조](reference-code-structure.md#프로젝트별-구조와-참고-지점) | 영속 업무 기록·부모 깨우기·자기 보고 경고의 소스 후보 | 결정에 쓰는 Paperclip 파일은 새 SHA로 재독하고 옛 ref와 파일별 blob 비교. 세션 간 직접 메시지는 ADR-0002의 대체 근거로 삼지 않음 |
| [#51](issue-51-references.md#brief)·[비교 목록](comparative-survey.md#비교-대상의-분류) | 연구 노드 연결·출처 UI의 범위, 후보 목록 | 그래프·템플릿 쓰기와 작업-노드 연결의 실제 검증은 후속 #56. 이번에 그래프 라이브러리를 재선정하지 않음 |

기존 `.reference-cache/issue-{1,50,51,52,53,54}/`는 소스·실행 도구 위치에 재사용한다. 기존 Evidence ID는 위 문서 anchor로 인용하고 신규 근거와 혼합하지 않는다.

## 레퍼런스

관점별 후보 **25항목**(작업10·산출물9·화면5·메인 PostgreSQL1, 중복 포함)을 기록했다. 전체 목록과 실행 경로는 `candidates.md`, 검색 기록은 `notes/{work,artifacts,surface}.md`에 있다. 생태계 전수조사가 아닌 아래 질문 집합의 패턴 포화다.

| 관점 | 마지막 라운드와 saturation 근거 |
|---|---|
| 작업·협력 | 4라운드. agent→PG queue→인접 언어 큐→실패 issue/PR로 확장. 마지막 parent wake 누락/과잉·paused 수신자·source/recipient 혼동은 기록과 수신자 연결·후속 실행·중복 처리의 기존 실패 유형으로 수렴 |
| 산출물·격리 | 4라운드. A2A/MLflow/Dify→작업·실행 출처→PROV/OpenLineage→Dagster materialization으로 확장. 마지막 관찰은 산출물/통신 분리·실행 출처·권한의 기존 변형만 추가 |
| 작업·산출물 화면 | 3라운드. Paperclip→Plane/Prefect/MLflow→Query·실패 테스트. 마지막은 별도 route·출처 표시·pending/rollback·연결 공백 후 재조회 외 새 패턴을 더하지 않음 |

| 심층 대상 | 분류·버전·고정 SHA | 라이선스 | 깊이·선정 이유 |
|---|---|---|---|
| Paperclip | agent control plane; `023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92` | MIT, root 직접 확인 | 소스·제한 함수·원본 첨부 패널 실행. 전체 작업 상세는 소스 확인. 같은 스택의 task/parent/comment/wake와 계약 불일치 반례 |
| A2A | 공개 프로토콜; `1205f45951ca97c209634ce6046180e38c5dfb30` | Apache-2.0, root 직접 확인 | 명세·proto. 통신과 산출물 및 task/context의 의미 구분 |
| a2a-python | SDK; `01da00b0951ba6201af860d17b4c088be7902d43` | Apache-2.0, root 직접 확인 | 소스·테스트 읽기. owner 범위·event ID 검사와 helper 종료 guard의 한계 |
| PostgreSQL18 | 공식 18 문서; 실행 PG18.1 | PostgreSQL License | 명세·독립 SQL 실행. 조건부 완료·rollback·관계 격리·종료 잠금 |
| Graphile Worker·pg-boss | 공식 문서 2026-10-19 확인, 문서 배포 SHA 미확인 | OSS MIT는 후보 metadata; 문서 자산 재사용 검토 안 함 | 문서. 업무 쓰기와 enqueue를 같은 transaction에 넣는 인접 사례. 신규 엔진 도입 대상 아님 |

**설계 참고만 권고한다.** 제품에 코드를 복사하거나 A2A SDK·새 queue 엔진을 추가하지 않는다. 복사하려면 해당 SHA의 파일 header·NOTICE·의존성을 다시 확인하고 출처 저장소·SHA·경로와 루트 `THIRD_PARTY_NOTICES.md` 고지를 남겨야 한다.

## 근거

확인일은 모두 2026-10-19다. 메인이 결정에 사용한 원문을 다시 열었고 대조 기록은 `main-verification.md`에 있다. 테스트는 별도 실행 표시가 없으면 **읽기만** 했다. Paperclip은 과거 `78b833c`와 파일별 blob을 비교했다. 작업 service·댓글 helper·schema·일부 tests는 같고 routes·auth·heartbeat·queue는 변경되어 새 원문을 읽었다. UI 파일 비교는 `recon/surface.md`에 둔다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | Read Committed의 경합 UPDATE는 대기 후 WHERE를 재검사한다. 행 잠금·여러 행의 불변 조건·복합 FK는 각각의 보장이다. | [isolation](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED) · [locks](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS) · [FK](https://www.postgresql.org/docs/18/ddl-constraints.html#DDL-CONSTRAINTS-FK) | 문서 주장 |
| <a id="E02"></a>E02 | 독립 PG 실험 8시나리오·32 assertions PASS. 생성/완료와 wake/Event rollback, 부모 없는 생성자·형제가 미완료인 부모 담당자 wake, CAS 중복 완료, 복합 FK 교차 조직 거부, 다음 묶음 입력, 종료와 쓰기의 잠금 충돌을 확인했다. | `probes/postgres-task.mjs`, `postgres-task-log.txt`; Node24.21.0·PG18.1·pg8.16.3. 제품·upstream API/schema 실행 아님 | 실행 확인 |
| <a id="E03"></a>E03 | 부모를 깨우려면 모든 직접 자식이 done/cancelled여야 한다. 자식 요약은 최신 댓글 또는 전달받은 텍스트이며 개수 제한이 있다. 부모 없는 작업의 생성자 fallback은 이 경로에서 확인되지 않는다. | [getWakeableParentAfterChildCompletion](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/server/src/services/issues.ts#L9248-L9344) | 소스 확인 |
| <a id="E04"></a>E04 | update service의 행 잠금·쓰기 transaction과 route의 terminal 감지·부모 wake 호출은 분리되어 있다. assignment helper도 wake 오류를 기본 warn/null로 처리한다. 전체 시스템의 복구 보장은 이 경로만으로 입증되지 않는다. | [update tx](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/server/src/services/issues.ts#L11553-L11558) · [terminal wake](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/server/src/routes/issues.ts#L15745-L15849) · [assignment](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/server/src/services/issue-assignment-wakeup.ts#L27-L100) | 소스 확인 |
| <a id="E05"></a>E05 | checkout은 상태·담당·run을 UPDATE predicate에 넣는다. 일반 update는 행 잠금 후 같은 tx에서 run 쓰기 권한을 재검사한다. checkout의 CAS를 완료의 멱등성으로 일반화할 수는 없다. | [checkout](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/server/src/services/issues.ts#L11723-L11765) · [update lock](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/server/src/services/issues.ts#L11086-L11145) | 소스 확인 |
| <a id="E06"></a>E06 | 댓글 helper는 자기 댓글의 재귀 wake를 억제하고, 명시 reopen 없이 done/cancelled인 작업의 댓글도 억제한다. | [shouldWakeAssigneeForIssueComment](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/server/src/services/issue-comment-wakeup.ts#L1-L28) | 소스 확인 |
| <a id="E07"></a>E07 | 위 원본 module을 변경·stub 없이 직접 import해 8사례 PASS. 자기 댓글·resume·완료/취소 작업·누락 상태를 대조했다. 실제 HTTP 작성자 판별·인가·저장은 실행하지 않았다. | `probes/paperclip-comment.mjs`, `paperclip-comment-log.txt`; Node24.21.0, E06 고정 SHA | 실행 확인(제한) |
| <a id="E08"></a>E08 | batching 테스트는 실행 중 댓글2/3을 deferred ID 목록으로 남기고 다음 run의 순서 있는 입력으로 전달함을 assert한다. 테스트는 이번에 실행하지 않았다. | [heartbeat-comment-wake-batching.test](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/server/src/__tests__/heartbeat-comment-wake-batching.test.ts#L647-L721) | 소스 확인 |
| <a id="E09"></a>E09 | 생성 route는 부모의 company/접근을 확인해 404로 거부한다. 담당 agent의 company 불일치는 service에서 422로 거부한다. cancellation helper는 cancelled/requested만 검사하며 모든 종료 상태를 검사하는 allowlist가 아니다. | [parent guard](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/server/src/routes/issues.ts#L12359-L12372) · [assignee guard](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/server/src/services/agent-assignability.ts#L104-L118) · [run guard](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/server/src/agent-run-cancellation.ts#L5-L33) | 소스 확인 |
| <a id="E10"></a>E10 | A2A Task는 status·artifacts·history를 구분한다. Artifact ID는 task 안에서 고유하고 parts/metadata를 담지만 작성자·실행 시도 ID는 고유 필드가 아니다. Part는 text/raw/url/data를 구별한다. | [Task](https://github.com/a2aproject/A2A/blob/1205f45951ca97c209634ce6046180e38c5dfb30/specification/a2a.proto#L167-L184) · [Part](https://github.com/a2aproject/A2A/blob/1205f45951ca97c209634ce6046180e38c5dfb30/specification/a2a.proto#L224-L242) · [Artifact](https://github.com/a2aproject/A2A/blob/1205f45951ca97c209634ce6046180e38c5dfb30/specification/a2a.proto#L280-L292) | 소스 확인(명세 선언) |
| <a id="E11"></a>E11 | A2A는 task output을 Artifact로, 통신을 Message로 구분한다. 모든 Message의 history 보존과 재연결 후 전달은 보장하지 않는다. 이 전달 수준은 ADR-0002의 영속 협력보다 약하다. | [Messages and Artifacts](https://github.com/a2aproject/A2A/blob/1205f45951ca97c209634ce6046180e38c5dfb30/docs/specification.md#L747-L764) | 문서 주장; 마지막 비교는 추론 |
| <a id="E12"></a>E12 | SDK InMemory store는 필수 context에서 owner를 구해 owner→task ID로 저장한다. 기본 owner는 user_name이며, 교차 owner 읽기·삭제 테스트가 있다. 이는 조직/실행 토큰 검사 자체가 아니다. | [owner](https://github.com/a2aproject/a2a-python/blob/01da00b0951ba6201af860d17b4c088be7902d43/src/a2a/server/owner_resolver.py#L1-L13) · [store](https://github.com/a2aproject/a2a-python/blob/01da00b0951ba6201af860d17b4c088be7902d43/src/a2a/server/tasks/inmemory_task_store.py#L43-L118) · [tests](https://github.com/a2aproject/a2a-python/blob/01da00b0951ba6201af860d17b4c088be7902d43/tests/server/tasks/test_inmemory_task_store.py#L462-L523) | 소스 확인 |
| <a id="E13"></a>E13 | TaskManager는 task/context ID 불일치와 존재하지 않는 artifact ID의 append를 명시 오류로 거부한다. context 일치와 caller 권한은 서로 다른 검사다. | [event guard](https://github.com/a2aproject/a2a-python/blob/01da00b0951ba6201af860d17b4c088be7902d43/src/a2a/server/tasks/task_manager.py#L208-L275) · [append guard](https://github.com/a2aproject/a2a-python/blob/01da00b0951ba6201af860d17b4c088be7902d43/src/a2a/server/tasks/task_manager.py#L31-L96) | 소스 확인 |
| <a id="E14"></a>E14 | TaskUpdater의 terminal flag/lock은 status 변경을 막지만 add_artifact에서는 그 flag를 읽지 않는다. DB store는 조회에 owner 조건을 쓰지만 save는 id PK 모델을 merge한다. 이 코드만으로 전역 종료·교차 owner 쓰기 차단을 입증할 수 없다. | [updater](https://github.com/a2aproject/a2a-python/blob/01da00b0951ba6201af860d17b4c088be7902d43/src/a2a/server/tasks/task_updater.py#L66-L160) · [DB save/get](https://github.com/a2aproject/a2a-python/blob/01da00b0951ba6201af860d17b4c088be7902d43/src/a2a/server/tasks/database_task_store.py#L197-L224) · [PK](https://github.com/a2aproject/a2a-python/blob/01da00b0951ba6201af860d17b4c088be7902d43/src/a2a/server/models.py#L44-L60) | 소스 확인; 보장 범위 판단은 추론 |
| <a id="E15"></a>E15 | Graphile은 업무 SQL/trigger에서 add_job을 호출하는 경로를, pg-boss는 기존 ORM transaction에 enqueue를 넣어 함께 rollback하는 방식을 설명한다. | [Graphile SQL](https://worker.graphile.org/docs/sql-add-job) · [pg-boss transaction adapters](https://pgboss.io/api/adapters) | 문서 주장 |
| <a id="E16"></a>E16 | 작업 row는 별도 상세 route로 이동한다. placeholder header가 보여도 요청 ID·조직·canonical route 일치 전 쓰기 대상을 확정하지 않는다. 산출물 목록의 task 묶음은 query 이동이고 모바일 상세는 side panel을 Sheet로 옮긴다. | [IssueRow](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/ui/src/components/IssueRow.tsx#L217-L244) · [loaded task guard](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/ui/src/pages/IssueDetail.tsx#L3184-L3233) · [artifacts query](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/ui/src/pages/Artifacts.tsx#L152-L168) · [mobile](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/ui/src/pages/IssueDetail.tsx#L8440-L8486) | 소스 확인 |
| <a id="E17"></a>E17 | 댓글은 임시 pending/queued echo와 서버 기록을 구별한다. 성공 때 서버 댓글로 교체하고 실패 때 임시 항목을 제거·이전 snapshot 복구·실패/저장 미확인 toast를 구별한다. | [onMutate](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/ui/src/pages/IssueDetail.tsx#L5171-L5218) · [success/error](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/ui/src/pages/IssueDetail.tsx#L5266-L5315) | 소스 확인 |
| <a id="E18"></a>E18 | 작업·댓글·산출물 변경은 연관 query를 재조회한다. 최초 socket 연결 전 read/subscribe 공백을 메우고 끊김 때 fallback polling하는 테스트가 있다. 이번에는 그 테스트를 실행하지 않았다. | [invalidation](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/ui/src/context/LiveUpdatesProvider.tsx#L1318-L1403) · [recovery tests](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/ui/src/context/LiveUpdatesProvider.recovery.test.tsx#L71-L118) | 소스 확인 |
| <a id="E19"></a>E19 | 원본 첨부 패널을 공식 fixture 데이터로 분리 실행했다. Raw/Rendered 전환·390px·빈 파일·누락 ID·과대 metadata의 상태와 fixture 다운로드 event를 관찰했다. 메인도 모드 전환/다운로드를 직접 조작하고 7개 캡처를 전부 재열람했다. | [TaskAttachmentPanel](https://github.com/paperclipai/paperclip/blob/023f4a5d0cd452c540ddd0deb4a0b81ef5e2ff92/ui/src/components/task-side-panel/TaskAttachmentPanel.tsx#L42-L106); `captures.md`, `probes/surface-capture-resume-log.json`, `ui-main-capture-log.json`, `ui-main-download-log.txt`. 고정 SHA 파일 blob 일치 확인 | 실행 확인(제한) |

근거19개: **실행3·소스13·문서3**. UI는 원본 production 모듈과 provider를 쓰되 Query cache·본문·다운로드는 fixture다. 성공한 실화면 근거는 산출물 내부 viewer에만 적용한다. 작업 목록/전체 상세·댓글 전송·실시간 backend·산출물 단건 route·실제 파일 읽기 권한/스트리밍은 이 실행으로 검증하지 않았다. Storybook ready와 초기 timeout·빈 앱은 성공 캡처에서 제외했다. 메인 capture script의 `Wrap lines` 버튼 탐색 실패는 하네스 선택 오류이며, 그 전에 성공한 2개 캡처 및 별도 다운로드 확인과 구분했다.


## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 업무 변경·입력·Event의 같은 transaction 저장 | E01–E05,E15 | Paperclip의 완료 뒤 wake보다 PG transactional enqueue가 #55에 직접 대응 | 완료/할당만 남고 담당자가 깨어나지 않는 상태 방지 | commit 뒤 실행 촉진 실패는 별도 문제; 메모리 kick은 영속 입력을 대신 못 함 |
| <a id="P02"></a>P02 | 받는 agent와 원인 기록의 명시 연결 | E03,E06–E08 | Paperclip은 all-child fan-in·terminal 댓글 억제. #55는 개별 완료·사용자 댓글 wake | 부모 담당자와 생성자 fallback의 정확한 전달 | task ID 하나로 dedupe하면 여러 댓글·형제 완료가 사라짐; 자기 댓글 반복 깨우기 |
| <a id="P03"></a>P03 | scope·작성자·현재 실행 권한과 관계 검사를 분리 | E02,E05,E09,E12–E14 | protocol context/owner는 BaboJUBot 조직과 다름. cancelled-only 검사도 running allowlist보다 약함 | 임의 ID/metadata로 권한이 넓어지지 않음 | 정상 조회만 검사하고 assignee/parent/recipient/artifact 참조를 빠뜨림; 인증 후 종료 경쟁 |
| <a id="P04"></a>P04 | 작업 상태·자기 보고·산출물·실행 시도 출처의 별도 필드 | E03,E10–E14; GLOSSARY | A2A Artifact는 task-local ID이고 작성 run 필드가 없음. 연구에서는 조직·작성자·실행 출처 추가 필요 | 완료 작업을 검증된 결과/최종 완료로 오인하지 않음 | 성공한 run=완료 task라는 추측, 출력 없는 완료를 검증 성공으로 표시 |
| <a id="P05"></a>P05 | 별도 상세 경로와 재조회 가능한 영속 본문 | E16–E19 | Paperclip 산출물 패널은 별도 단건 페이지 규칙에 맞게 변형 | deep link·출처 이동·댓글 피드백을 유지 | panel을 그대로 복사, stale route의 ID로 전송, 실패 후 draft 유실·중복 댓글 |

## 결정 권고

아래 채택/배제는 **조사에서의 권고 분류**다. 기존 Issue·ADR의 계약을 바꾸지 않는다.

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 채택 | 생성+담당 할당 wake+Event, 완료+자기 보고+후속 wake+Event, 메시지/사용자 댓글+wake+Event를 각각 같은 PG transaction에 저장. 실행 촉진·WS 알림은 commit 뒤 수행 | P01,E02,E15; ADR-0002 | 완료와 wake 이중 기록의 실패 창을 줄임. 기존 db/runs·approvals 방식 확장; 새 큐 엔진 불필요 | Q1,Q2,Q6 |
| <a id="D02"></a>D02 | 변형 채택 | **각 작업 완료마다** 부모가 있으면 부모 작업 담당자, 없으면 작업 생성자를 깨움. 원인 task/transition과 수신자를 보존하고 완료 상태 조건부 갱신의 승자만 효과 생성 | P01–P02,E02–E05; #55 | 모든 형제를 기다리거나 무조건 Lead에게 보내지 않음. 같은 수신자 여러 입력의 실행 시도 병합과 원인 기록 중복 제거를 구분 | Q1,Q2,Q6 |
| <a id="D03"></a>D03 | 변형 채택 | 할당·완료·같은 조직 메시지·작업 댓글의 깨우기 종류와 source record ID를 명시. admission에서 pending membership 고정, 실행 중 입력은 다음 시도로 전달. 완료된 작업의 사용자 댓글도 담당자를 깨우되 댓글 자체로 작업 상태를 자동 재개하지 않는 안을 권고 | P02,E06–E08; #53·#55 | upstream terminal 댓글 억제를 그대로 쓰면 요구 누락. 자기 보고 댓글로 자기 자신을 계속 깨우는 가짜 시나리오를 피함 | Q1,Q2,Q6 |
| <a id="D04"></a>D04 | 채택 | 조직·작성자·실행 시도는 토큰에서만 얻고 모든 조회/쓰기에 scope를 적용. 담당·부모·수신자·연결 작업·산출물의 같은 조직 관계도 검사. 가능한 참조는 복합 FK로 방어; 다른 조직/없는 ID는 같은404. 쓰기 때 running run/단계를 잠금 아래 재확인 | P03,E01–E02,E05,E09,E12–E14; AGENTS | 공개 프로토콜 metadata·owner 문자열·ID 일치·TTL만으로 제품 권한이 강제되지 않음. 기존 run→조직 잠금 순서를 따라 deadlock 위험 줄임 | Q1,Q3,Q4,Q6 |
| <a id="D05"></a>D05 | 변형 채택 | 사용자 Lead 답장, 같은 조직 agent 메시지, task 댓글을 명시 대상별 계약으로 나눔. 현재 Lead 전용 send_message를 무조건 worker에게 열지 않음. 분리 도구 또는 strict discriminator로 target별 Role/단계·수신자를 검사 | P02–P03,E09,E12–E13; 현재 tools·message·toolRules | 작업자가 동료에게 직접 협력하면서 사용자와는 작업 댓글로 이어지는 기존 제품 규칙 보존. 도구 이름/HTTP 경로는 #55 구현에서 확정 | Q2,Q3,Q6 |
| <a id="D06"></a>D06 | 변형 채택 | 작업 완료 요약은 `자기 보고`로 표시. 산출물은 별도 ID·제목/형식/본문 또는 저장 참조·조직/작업/작성 agent/run/생성 시각을 보존하고 단건 조회. 이 출처는 server가 부여하며 형식 검증·산출물 존재를 연구 검증 완료로 표시하지 않음 | P04,E10–E14; #49 story25/27, GLOSSARY | A2A의 통신/출력 구별만 참고. 단건 주소용 제품 ID와 task-local protocol ID를 구분. 내용 저장 방식은 열린 결정 | Q3,Q4,Q6 |
| <a id="D07"></a>D07 | 변형 채택 | 목록→작업 상세→산출물 단건은 조직이 포함된 별도 경로. 작업 상세에 제목/상태/담당·자기 보고·댓글·산출물·연결 노드 영역, 산출물에 본문과 원 작업·작성 출처. 댓글 전송 실패/미확인 때 초안·다시 확인 경로 유지. 기존 org 하위 query key와 ready/reconnect invalidation 확장 | P05,E16–E19; #55·features | Paperclip 패널/탭 대신 확정 상세 페이지 규칙 적용. 임시 echo·클라이언트 상태는 저장/수신/실행 완료와 구분 | Q2,Q4,Q5 |
| <a id="D08"></a>D08 | 채택 | 기존 Script의 일반 call·gate·동일 HTTP 경로를 써서 Lead→worker→parent/creator 흐름 구성. 승인·할당·메시지·댓글·완료 사유를 구별하고 이미 끝난 작업은 다시 완료하지 않음. 부모가 Lead가 아닌 시나리오와 교차 조직 음성 대조군 포함 | P01–P04,E02,E07–E09,E13; #49 Testing Decisions·현재 runtime | 연구 정책을 fake 모델 판단으로 숨기지 않고 실제 제품 경계를 검증. 실제 모델·새 SDK·자체 agent loop는 필요하지 않음 | Q1,Q2,Q3,Q6 |
| <a id="D09"></a>D09 | 보류 | 최소 task 상태 이름, 중복 완료 응답 코드, Lead의 비담당 완료 권한, 산출물 첫 형식/용량을 아래 owner가 결정 | E02,E05,E09–E14; #55 미정 범위 | 참고 프로젝트의 정책을 확정 계약으로 둔갑시키지 않음. 모든 선택에서 효과 중복 없음·조직 격리는 공통 | Q1,Q3,Q4,Q6 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 모든 자식이 끝나야 부모 wake, 부모 없으면 통지 없음 | E03 | #55의 완료마다 부모 담당자/생성자 통지와 다름 |
| 완료를 commit한 뒤 best-effort wake만 호출 | E04 | 원인과 입력의 원자성을 보장 못 함. process crash 실증은 미수행이며 위험은 구조에서 도출한 추론 |
| 완료/취소 작업의 사용자 댓글 wake를 일괄 억제 | E06–E07 | #55는 사용자의 작업 댓글이 담당자를 깨워야 함. wake와 task reopen을 구분 |
| contextId/owner 자유 문자열·작성자 metadata·취소 상태만으로 조직/실행 권한 판단 | E09,E12–E14 | 현재 토큰 신원·단계·관계 검사·종료 경계가 필요 |
| 상태 전이=검증 성공, run 성공=task 완료=조직 최종 완료 | E03,E10–E11; GLOSSARY·#57 | 자기 보고·보존된 출력·검증·사용자 결정의 의미가 다름 |
| A2A streaming append/revision, Redis/workflow 플랫폼, 직접 세션 간 대화를 이번 뼈대에 도입 | E10–E15; ADR-0001/2/4 | 첫 판의 문제를 넘는 transport·복구·인프라 비용. 필요한 형식은 별도 결정 |
| 작업/산출물을 Paperclip 패널·탭만으로 표시 | E16–E19; features | 별도 상세 페이지 규칙과 상충. 칸반·갤러리·문서 revision은 #55 범위 밖 |

## 구현 참고

권고 요약은 **영속 기록과 깨우기의 원자성, 수신자 선택의 명시화, 토큰에서 정한 조직/작성 출처, 자기 보고와 산출물의 구별**이다. 연구 수행 판단은 하네스/에이전트가 맡고, 승인·범위·전이는 Control Plane에서 강제한다.

| 책임·구현 위치 | 참고할 연결 |
|---|---|
| 계약 — `packages/contracts` | 작업·산출물·대상별 메시지 입력/조회, wake reason·Event·도구 목록 확장. 조직/author/run을 입력에서 고를 수 없게 함. `create_task`의 unknown 출력과 기존 body-only Lead 메시지는 현재 미완성 지점 |
| 순수 규칙 — `packages/core` | 완료 wake 대상·허용 전이·대상별 도구 규칙. core→contracts, DB/Express/React에 의존하지 않는 방향 유지 |
| 저장 — `packages/db` | task/artifact/comment/message schema·migration과 scope 조회, run→조직 잠금 뒤 쓰기·Event/wake transaction. existing db/approvals의 toolWrite는 파일 내부 함수이므로 재사용/추출 범위는 구현에서 결정 |
| 서버 — `apps/server` | 조직 도구/Owner 댓글 API·조회, commit 뒤 hub publish와 수신자별 dispatcher.kick 연결. 저장 성공 뒤 publish 실패가 중복 쓰기 재시도를 유도하지 않도록 기존 응답 계약 유지 |
| 실행기 — `packages/runtime` | 기존 `ScriptStep.call`·calls output·createGate로 승인 후 Lead·worker·후속 깨우기 시나리오. 작업자 user 답장은 task 댓글로 제한 |
| 화면 — `apps/web` | 별도 task/artifact 상세 route·API query, 목록/댓글/산출물 재조회, 빈/로딩/404/실패·390px 상태. 캐시는 existing org 하위 key를 확장하며 화면에 업무 규칙을 새로 두지 않음 |

| ID | 검증할 경계 — 입력 → 행동 → 기대 | 근거 |
|---|---|---|
| V01 | 승인 전/후 같은 작업 생성 호출 → 전에는409+거부 Event, 후에는 할당 → worker가 산출물·자기 보고 완료 → 생성자 Lead가 해당 task 완료 사유로 실행 | D01,D02,D04,D08; #55 AC1 |
| V02 | 부모 담당자가 Lead가 아닌 작업의 자식 완료, 형제는 미완료 → 바로 그 부모 담당자 wake. 부모 없는 경우는 생성자. 동시에 두 자식 완료 → 원인 둘 보존·같은 agent 실행 병합 가능 | D02,D03; AC2 |
| V03 | 담당자 실행 중 사용자 댓글 여러 개 → 각각 저장, 현재 run 입력에는 주입하지 않고 다음 run에 포함. 완료 작업 댓글도 wake, 상태 자동 재개 없음(권고안) | D01,D03,D07; AC3 |
| V04 | worker A→같은 조직 worker B 메시지 → B wake. worker가 사용자 Lead 채팅 대상으로 보내려 함 → 대상별 규칙 거부; 작업 댓글 답변은 허용 정책대로 처리 | D04,D05; AC4·features |
| V05 | 다른 조직의 담당/부모/수신자/task/artifact ID를 조회·생성·완료·연결 입력에 넣음 → 없는 ID와 같은404, 다른 조직 변경/wake 없음. organization/author/run 위조 필드도 거부 | D04–D06; AC4 |
| V06 | 같은 task 완료 동시/재시도·중간 저장 실패 → 효과가 한 번만 남거나 전체 rollback. 산출물을 먼저 별도 저장한 뒤 완료가 실패한 경우는 각 도구 transaction 경계대로 기록되고 task는 미완료 | D01,D02,D06 |
| V07 | 실행 시도 종료 뒤 새 도구 읽기/쓰기 또는 인증과 쓰기 사이 종료 → 기존 running 검사·잠금으로 거부. 단계가 닫히면 새 연구 쓰기도 거부하고 Event로 관찰 | D04; 기존 #53/#54 계약 |
| V08 | 성공한 실행 시도·완료 task·산출물 조회 → 요약은 자기 보고, 산출물은 작성 run/task로 이동, 조직 최종 완료는 바뀌지 않음. 완료 도구 commit 뒤 run이 실패해도 각 기록을 구별해 표시하며 이미 저장된 업무 효과를 run 종료 처리에서 임의로 되돌리지 않는 안을 검증 | D06,D08; #57 경계 |
| V09 | 작업 목록→상세→산출물 단건 직접 주소/새로고침·뒤로가기, 빈/로딩/404/실패, 긴 한국어 본문·390px → 읽기·댓글·원 작업 복귀 가능. 전송 실패/저장 미확인에 입력과 다시 확인 경로 유지 | D07; AC5 |
| V10 | 다른 탭에서 task/comment/artifact 생성·완료, 최초 WS 연결 전 변경·재연결·조직 전환 → 해당 목록/상세가 재조회되고 다른 조직의 화면/전송 대상에 섞이지 않음 | D04,D07; AC5 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 최소 작업 상태와 중복 완료 응답 | #55 구현 | 예: assigned→completed만 우선 vs 실제 업무 착수 상태도 추가. 실행 시도 running을 task 상태로 자동 복사하지 않음. 중복 완료는409 거부 vs 같은 기록200 재응답; 어느 쪽이든 wake/Event는 재생성하지 않음(E02,E05) |
| 비담당 완료 예외 | 사용자 / #55 | 담당자만 완료 권고 vs Lead의 조정 완료 허용. #49 story25는 맡은 작업 완료이고 #55에 Lead override 정책은 명시되지 않음. upstream의 넓은 management 권한을 자동 채택하지 않음 |
| 산출물의 첫 저장 형식·크기 | 사용자 / #55 | DB inline text/Markdown: 원자적 보존과 단건 보기가 단순. 파일 저장+DB metadata: 파일/데이터 지원 폭은 넓지만 경로·크기·실패 정리가 필요. 첫 판 형식과 상한은 구현 전에 확정; protocol multipart/revision은 필요 근거 없음(E10,E13) |
| 연구 노드 연결·산출물 진입 경로의 후속 완성 | #56 / #57 | #55 상세는 연결 노드가 없음을 보여줄 수 있어야 함. 실제 노드 연결 도구·조회와 지도 패널은 #56, 결과 검토에서 산출물 열기는 #57. 이 조사에서 가짜 연구 노드나 결과 검토 UI를 구현하지 않음 |
| 실행 재처리·제어·알림 | #59 / #60 / #61 / #63 | 일시정지/취소 #59, 서버 재시작 시 기존 run 입력 재처리 #60, 채널 outbox #61, 전 흐름 데모/E2E #63. #55의 durable wake를 후속 계약에 연결하되 이번 조사로 복구·전달 보장을 완료했다고 하지 않음 |

## 한계와 미확인

- 독립 SQL·순수 함수 실행은 BaboJUBot의 #55 API·스키마·승인·조직 격리가 구현됐다는 근거가 아니다. 제품 테스트/E2E, upstream 전체 테스트, 실제 모델·유료 API·계정·자격 증명을 쓰는 경로는 실행하지 않았다.
- Paperclip task/wake의 post-commit 실패 창, A2A helper/store의 guard 범위에서 도출한 위험은 소스에 근거한 추론이다. 실제 프로세스 crash·외부 API 우회·교차 owner exploit을 재현하지 않았다. 현재 저장소의 후속 복구 계약은 #60이 소유한다.
- A2A SDK의 source recon은 기본 helper/store까지만이다. opt-in multi-replica versioned store, 전체 transport 인가·streaming 재접속은 미확인이다. 최초 산출물 형식·비담당 완료 예외·중복 완료 응답은 위 owner의 열린 결정이다.
- 원본 첨부 패널은 실제 조작했지만 전체 작업 상세·댓글 전송·전송 실패/권한 없음/조직 전환의 실화면과 live event는 미확인이다. 의도적으로 빈 본문·미등록 ID·과대 metadata를 주입한 상태 관찰이며 실제 HTTP404·서버 파일 용량 제한·파일 권한 검증의 근거가 아니다.
- Plane의 공개 업무 view URL을 확보하지 못했고, Prefect/MLflow의 실제 UI는 실행하지 않았다. 도움말 그림은 실화면 근거로 세지 않았다. Paperclip의 산출물 단건 별도 페이지와 BaboJUBot 연구 노드 UI의 직접 동종 실화면은 확인되지 않았다.
- 기존 Paperclip Storybook은 두 설정 모두 iframe navigation timeout으로 실패했다. manager의 ready 메시지나 빈/오류 화면을 성공 캡처로 사용하지 않았다. 사용자 재개 때 `/tmp` 설치가 소실되어 같은 고정 SHA를 복구했으며 세부 재설치·실행·정리는 `selfhost/paperclip-ui.md`에 남긴다. 이전 SQL 로그는 보존됐지만 재개 후 다시 실행했다고 세지 않는다.
- 소스 재사용을 결정하면 upstream 변경, root/개별 파일 LICENSE·NOTICE·의존성을 다시 확인해야 한다. 이번 결과 문서와 문서 지도만 남기고 커밋하지 않는다. 확정 계약을 바꾸거나 제품 구현을 시작하지 않았다.
