# issue-56 레퍼런스 조사: 연구 지도 기록과 편집 경계

조사일: 2026-10-19 (Asia/Seoul). 대상: [#56](https://github.com/babo-jeonguk/BaboJUBot/issues/56), parent [#49](https://github.com/babo-jeonguk/BaboJUBot/issues/49), 선행 [#51](https://github.com/babo-jeonguk/BaboJUBot/issues/51)·[#55](https://github.com/babo-jeonguk/BaboJUBot/issues/55). 구현 전 권고이며 확정 계약이나 구현 결과가 아니다. 상세 자료는 `.reference-cache/issue-56/`에 보존하고 Git에서 제외한다. 이 문서는 구현 변경과 함께 검토·커밋하도록 미커밋으로 남긴다.

## Brief

- 구현할 문제: 에이전트 도구와 사용자 편집이 같은 조직 연구 지도를 만들고 바꾼다. 노드·주/보조 연결·작업 연결과 편집 출처를 보존하며, 사용자 편집은 Lead 깨우기와 실시간 조회에 연결한다.
- 동종 문제: 조직 범위의 타입 있는 관계 기록에서 **주 연결 forest만 비순환으로 강제하고 보조 관계는 별도로 유지하는 동시 편집**.
- 고정된 결정: `AGENTS.md`, `GLOSSARY.md`, `docs/features.md`, `docs/architecture.md`, ADR-0001~0004와 [#51 사용자 결정](https://github.com/babo-jeonguk/BaboJUBot/issues/51#issuecomment-6209365865). React Flow 12 + Dagre 3, 보이는 노드와 주 연결만 배치, 기본 좌→우/선택적 위→아래, 명시 폼과 오른쪽 상세 패널(1024px 미만 아래 배치), 관계 ID 그대로 edge ID, renderer parentId·delete·reconnect를 연구 기록에 연결하지 않음. 노드 위치 이동은 보기 상태이며 편집·깨우기를 만들지 않는다. 주 부모 최대 하나·주 연결 순환 금지·부모 없는 노드 허용·보조 연결 개수 무제한, 종류는 조직 사본 템플릿 선언을 따른다. 삭제는 폐기이며 자손·연결·작업은 남고 폐기 취소도 제공한다. 작업은 노드 0~1개. 조직·작성자·실행 시도는 토큰에서 정하고 승인·격리·전이는 제품이 강제한다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 주 부모 최대 하나·주 연결 순환 금지를 재부모화와 동시 요청에도 어떻게 강제하며 보조 순환과 구분하는가? | #56 규칙·AC2, #51 강제 위치 | Source Recon + persistence/concurrency + 정상/음성 SQL probe |
| Q2 | 조직 사본의 종류 선언을 어느 경계에서 검사하고 전역 라이브러리·승인 snapshot과 어떻게 구분하는가? | #56 규칙·AC2, #49 story59, 구조 Harness seam | Source Recon + adversarial scenario |
| Q3 | 폐기·복원 때 자손·관계·연결 작업을 어떻게 보존하고 편집자 기록·Lead 깨우기를 원자적으로 남기는가? | #56 AC3, #51 폐기 폼 결정, ADR-0002 | Source Recon + persistence/recovery + 실패 주입 |
| Q4 | 작업당 노드0~1, 교차 조직 참조, 종료된 실행 시도의 쓰기를 API·DB에서 어떻게 막는가? | #56 AC1/2/4, #49 stories20/41–43/60, AGENTS | Source Recon + adversarial scenario + SQL probe |
| Q5 | 서버 기록을 그래프·상세·작업/산출물 링크로 투영하면서 실시간 재조회·오래된 폼·실패·390px를 어떻게 다루는가? | #56 화면·AC5, #51 배치/편집 결정, #49 story72 | 기존 조사 재사용 + Source Recon + Surface Capture/Behavioral Recon |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [#51](issue-51-references.md#brief) | 렌더러·배치 비교, renderer helper가 제품 검증을 대체하지 못하는 근거 | 사용자 결정 댓글을 재독했다. 라이브러리를 재선정하지 않는다. 새 source ref를 쓰면 파일별 blob을 비교한다. |
| [#55](issue-55-references.md#구현-참고) | 작업/산출물 출처·조직 scope, 기록과 wake/Event의 원자성 | #55는 #69로 병합됨을 이슈 댓글에서 확인. 과거 미구현 설명 대신 현재 toolWrite·tasks·schema를 직접 읽는다. |
| [#54](issue-54-references.md#brief)·[#53](issue-53-references.md#brief) | 초기 승인 snapshot·조직 사본, 토큰·종료/쓰기 잠금·pending wake | 구현의 해당 경계를 다시 읽고 연결한다. 이 문서의 새 E로 기존 근거를 복제하지 않는다. |
| [#52](issue-52-references.md#brief)·[#50](issue-50-references.md#brief)·[#1](issue-1-references.md#brief) | 확정 스택·화면 지도·조직 범위 저장 책임 | 기준선으로만 사용. 기술·셸·Control Plane을 재선정하지 않는다. |
| [구조 비교](reference-code-structure.md)·[상호작용](agent-interaction-models.md)·[프로바이더](agent-runtime-models.md)·[비교 목록](comparative-survey.md)·[대시보드](dashboard-references.md)·[Paperclip](paperclip.md)·[Paperclip 대시보드](paperclip-dashboard.md) | 후보 출발점 | 연구 지도의 주/보조 관계 불변 조건을 직접 입증하지 않아 신규 결정 근거로 승격하지 않는다. 기존 캐시는 checkout·실행 도구 위치만 재사용한다. |

## 레퍼런스

후보는 **31항목**(구조11·템플릿/격리8·화면9·PostgreSQL3, 관점 간 중복 포함)이다. 전체 후보와 실행 경로는 `candidates.md`, 검색 기록은 `notes/{structure,scope-template,surface,postgres}.md`에 있다. 표의 SHA는 소스 조사 ref이며 공개 데모의 배포 SHA와 일치한다는 뜻이 아니다.

| 관점 | 마지막 라운드와 saturation 근거 |
|---|---|
| 구조·폐기 | 4라운드: tree 라이브러리→ORM 복합 adjacency→삭제 전파·지식 관계 명세→related work·잠금 테스트. 마지막 후보는 단일 parent·nested set·명시적 삭제 정책과 잠금 범위/수명을 반복했다. 보조 관계까지 forest로 제한하는 일반화는 배제한다. |
| 템플릿·격리 | 3라운드: workflow 제품→automation·공식 advisory→Node-RED revision·OWASP object authorization. 마지막은 종류 검사/저장 경로의 차이, server-owned scope, 참조별 검사의 기존 실패 유형으로 수렴했다. |
| 화면·갱신 | 4라운드: 확정 React Flow→Query·운영 editor→인접 diagram·소형 editor→selection/state 심볼·실패 이슈 재검색. 마지막은 선택 ID·정본/초안·보기 상태·pending 구독이라는 기존 경계를 반복했다. |
| 저장·동시성 | 3라운드: PG 제약/CTE→잠금/격리→ltree·SERIALIZABLE·tree 저장법 대조. 마지막은 이동 비용·잠금 범위·재시도 변형이며 새 실패 유형을 더하지 않았다. 생태계 전수조사가 아닌 Q1–Q5의 패턴 포화다. |

| 심층 대상 | 분류·버전·고정 SHA | 라이선스 | 깊이·선정 이유 |
|---|---|---|---|
| django-treebeard | tree 라이브러리; `c7c2b70f625bc7e55fd560d0bc5fb3fb7fbb1622` | [Apache-2.0](https://github.com/django-treebeard/django-treebeard/blob/c7c2b70f625bc7e55fd560d0bc5fb3fb7fbb1622/LICENSE#L1-L17), root 확인 | 소스·테스트 읽기. 단일 부모·자기/후손 거부·transaction의 동시성 한계와 subtree delete 반례를 함께 확인할 수 있음 |
| Dify | 공개 소스 workflow 제품; `823f40e71fc9e045a9ff2aa903a74b5b001dff33` | [modified Apache-2.0](https://github.com/langgenius/dify/blob/823f40e71fc9e045a9ff2aa903a74b5b001dff33/LICENSE#L1-L20), 추가 조건 직접 확인 | 소스·테스트 읽기. tenant/참조 scope·draft lock/hash·검사와 저장의 차이. 해당 라이선스를 단순 Apache-2.0 또는 무조건적 OSS로 표기하지 않음 |
| React Flow | 확정 렌더러; package12.12.0, `654ba5a5e04f3404bc4db2eee88bfa15866d203d` | [MIT](https://github.com/xyflow/xyflow/blob/654ba5a5e04f3404bc4db2eee88bfa15866d203d/LICENSE#L1-L21), root 확인 | 소스·공개 공식 예시 실행. 선택/정본/보기 경계를 확인. #51의 `3d35b57317576b0916c0bfeaaedd573aaacc2839`와 조사한11파일 blob이 모두 같음 |
| PostgreSQL18 | 공식18 문서; 실행18.4, embedded18.4.0-beta.17·pg8.23.1 | PostgreSQL License | 명세·독립 SQL 실행. 확정 스택에서 동시 cycle 반례·복합FK·원자성·폐기를 싸게 검증 |

나머지 후보는 목록/문서 또는 보조 소스 수준이다. ClosureTree의 잠금 수명은 후보로 기록했지만 이 문서 결정 근거로 승격하지 않았다. **외부 코드 복사·새 tree/workflow 엔진 도입은 권고하지 않는다.** 복사를 택하면 파일 header·NOTICE·의존성과 해당 SHA의 라이선스를 다시 확인하고 출처 및 `THIRD_PARTY_NOTICES.md` 고지를 남긴다.

## 근거

확인일은 모두 2026-10-19. 결정에 쓴 원문과4개 캡처를 메인이 직접 다시 열었으며 대조 결과는 `main-verification.md`에 있다. 테스트는 별도 실행 표시가 없으면 읽기만 했다. BaboJUBot 소스의 기준 HEAD는 `2982406dd79f29e73441662b267f3f750d1c9590`이다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 단일 행 CHECK는 다른 행의 구조를 보장하지 않는다. partial unique와 복합FK는 각각 주 부모 cardinality와 같은 조직 관계를 표현하는 수단이다. | [PG18 constraints](https://www.postgresql.org/docs/18/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS)·[partial index](https://www.postgresql.org/docs/18/indexes-partial.html) | 문서 주장 |
| <a id="E02"></a>E02 | 충돌하는 행 잠금은 transaction 끝까지 유지된다. Read Committed는 statement마다 snapshot을 정하므로 잠금 뒤 별도 조회와 잠금 전에 읽어 둔 구조를 구분해야 한다. | [row locks](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS)·[Read Committed](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED) | 문서 주장 |
| <a id="E03"></a>E03 | recursive CTE는 관계를 탐색한다. UNION의 전체 행 중복 제거와 CYCLE/방문 경로 검사는 종료 전략이며, 자체가 저장 전 제약은 아니다. | [recursive queries/cycle](https://www.postgresql.org/docs/18/queries-with.html#QUERIES-WITH-CYCLE) | 문서 주장 |
| <a id="E04"></a>E04 | 독립 SQL8시나리오·37 assertions PASS. 잠금 없는 두 read/check→서로 다른 edge 쓰기로 cycle이 저장되는 음성 대조와, 조직 잠금 뒤 최신 재검사로 후속을 거부하는 대조를 실행했다. 복합FK·주 부모 unique·task 두 번째 연결 거부·폐기 보존·효과 rollback·stale revision 거부도 확인했다. | `probes/postgres-map.mjs`, `postgres-map-log.txt`; Node24.21.0·PG18.4·pg8.23.1. 제품/upstream API·스키마 실행 아님 | 실행 확인 |
| <a id="E05"></a>E05 | AL move는 self/descendant guard 후 parent를 저장하고 부모 없는 root를 허용한다. 테스트도 자기/후손 이동 거부를 assert한다. | [AL move/root](https://github.com/django-treebeard/django-treebeard/blob/c7c2b70f625bc7e55fd560d0bc5fb3fb7fbb1622/treebeard/al_tree.py#L108-L157)·[tests](https://github.com/django-treebeard/django-treebeard/blob/c7c2b70f625bc7e55fd560d0bc5fb3fb7fbb1622/tests/test_treebeard.py#L1887-L1903) | 소스 확인 |
| <a id="E06"></a>E06 | treebeard는 transaction이 있어도 동시 쓰기로 구조 불일치가 가능하며 추가 잠금에 성능 비용이 있다고 명시한다. | [caveats](https://github.com/django-treebeard/django-treebeard/blob/c7c2b70f625bc7e55fd560d0bc5fb3fb7fbb1622/docs/source/caveats.rst#L15-L29) | 문서 주장 |
| <a id="E07"></a>E07 | MP delete는 자손까지 실제 삭제한다. 실패 시 관련 count/구조도 rollback해야 하는 회귀 테스트가 있다. 이는 제품의 단건 폐기와 의미가 다르다. | [delete](https://github.com/django-treebeard/django-treebeard/blob/c7c2b70f625bc7e55fd560d0bc5fb3fb7fbb1622/treebeard/mp_tree.py#L32-L82)·[rollback tests](https://github.com/django-treebeard/django-treebeard/blob/c7c2b70f625bc7e55fd560d0bc5fb3fb7fbb1622/tests/test_treebeard.py#L1848-L1877) | 소스 확인 |
| <a id="E08"></a>E08 | Dify는 current tenant+app ID로 app를 조회해 없으면 거부하며, agent binding에서도 tenant/app/workflow/node와 agent/snapshot 소유 범위를 검사한다. | [app scope](https://github.com/langgenius/dify/blob/823f40e71fc9e045a9ff2aa903a74b5b001dff33/api/controllers/console/app/wraps.py#L30-L40)·[not found](https://github.com/langgenius/dify/blob/823f40e71fc9e045a9ff2aa903a74b5b001dff33/api/controllers/console/app/wraps.py#L100-L115)·[binding](https://github.com/langgenius/dify/blob/823f40e71fc9e045a9ff2aa903a74b5b001dff33/api/core/workflow/nodes/agent_v2/validators.py#L95-L195) | 소스 확인 |
| <a id="E09"></a>E09 | Dify save의 lightweight validator는 start/trigger 공존·human-input 중심이다. 별도 inspector가 unknown kind·없는 endpoint를 보고하고 그 테스트가 있다. inspector의 존재를 모든 save 경로의 강제 검증으로 볼 수 없다. | [save validator](https://github.com/langgenius/dify/blob/823f40e71fc9e045a9ff2aa903a74b5b001dff33/api/services/workflow_service.py#L1836-L1866)·[kind](https://github.com/langgenius/dify/blob/823f40e71fc9e045a9ff2aa903a74b5b001dff33/api/services/workflow/graph_check.py#L140-L151)·[endpoint](https://github.com/langgenius/dify/blob/823f40e71fc9e045a9ff2aa903a74b5b001dff33/api/services/workflow/graph_check.py#L188-L198)·[tests](https://github.com/langgenius/dify/blob/823f40e71fc9e045a9ff2aa903a74b5b001dff33/api/tests/unit_tests/services/workflow/test_graph_check.py#L92-L103) | 소스 확인 |
| <a id="E10"></a>E10 | Dify는 기존 draft를 tenant/app/version 조건으로 잠근 뒤 hash mismatch를 거부하고 graph·편집자를 저장한다. graph hash와 draft/published version은 별개다. 신규 draft 동시 생성 보장은 이 관찰에 포함하지 않는다. | [lock](https://github.com/langgenius/dify/blob/823f40e71fc9e045a9ff2aa903a74b5b001dff33/api/services/workflow_service.py#L267-L278)·[sync](https://github.com/langgenius/dify/blob/823f40e71fc9e045a9ff2aa903a74b5b001dff33/api/services/workflow_service.py#L439-L480)·[version](https://github.com/langgenius/dify/blob/823f40e71fc9e045a9ff2aa903a74b5b001dff33/api/models/workflow.py#L213-L235)·[hash](https://github.com/langgenius/dify/blob/823f40e71fc9e045a9ff2aa903a74b5b001dff33/api/models/workflow.py#L547-L555) | 소스 확인 |
| <a id="E11"></a>E11 | React Flow selection listener의 equality는 선택 node/edge의 ID 배열만 비교한다. 같은 선택 ID에서 제목/상태가 바뀌어도 선택 변경 callback만을 최신 데이터 전달 경로로 삼으면 안 된다는 판단은 추론이다. | [SelectionListener selector/areEqual/effect](https://github.com/xyflow/xyflow/blob/654ba5a5e04f3404bc4db2eee88bfa15866d203d/packages/react/src/components/SelectionListener/index.tsx#L17-L58) | 소스 확인 |
| <a id="E12"></a>E12 | renderer의 remove change는 배열에서 항목을 빼고 toObject는 nodes/edges뿐 아니라 viewport도 반환한다. 공식 SaveRestore는 이 객체를 localforage에 저장한다. 연구 기록 저장 API와 별개다. | [changes](https://github.com/xyflow/xyflow/blob/654ba5a5e04f3404bc4db2eee88bfa15866d203d/packages/react/src/utils/changes.ts#L55-L85)·[toObject](https://github.com/xyflow/xyflow/blob/654ba5a5e04f3404bc4db2eee88bfa15866d203d/packages/react/src/hooks/useReactFlow.ts#L150-L162)·[SaveRestore](https://github.com/xyflow/xyflow/blob/654ba5a5e04f3404bc4db2eee88bfa15866d203d/examples/react/src/examples/SaveRestore/Controls.tsx#L21-L43) | 소스 확인 |
| <a id="E13"></a>E13 | 공개 Update Node에서 제목 입력→선택→hidden→복원→다른 노드 선택을1280/390px에서 실행했다.4개 캡처를 재열람했고 페이지 오류0, 문서 폭은 각각1280/390이었다. narrow input은 긴 제목 일부만 보이며 노드 제목은 줄바꿈된다. | [공식 실행 예시](https://example-apps.xyflow.com/react/examples/nodes/update-node/index.html); `captures/surface-captures.md`, `selfhost/surface-public-log.json` | 실행 확인 |
| <a id="E14"></a>E14 | 현재 toolWrite는 running run→조직 잠금→단계 재검사→쓰기를 transaction 안에서 실행한다. 조직 사본 템플릿은 조직 ID로 조회하며 종류는 JSON에 저장한다. | [toolWrite](https://github.com/babo-jeonguk/BaboJUBot/blob/2982406dd79f29e73441662b267f3f750d1c9590/packages/db/src/tool-calls.ts#L86-L117)·[조직 잠금](https://github.com/babo-jeonguk/BaboJUBot/blob/2982406dd79f29e73441662b267f3f750d1c9590/packages/db/src/rows.ts#L81-L91)·[사본 조회](https://github.com/babo-jeonguk/BaboJUBot/blob/2982406dd79f29e73441662b267f3f750d1c9590/packages/db/src/harness.ts#L40-L50)·[schema](https://github.com/babo-jeonguk/BaboJUBot/blob/2982406dd79f29e73441662b267f3f750d1c9590/packages/db/src/schema.ts#L267-L293) | 소스 확인 |
| <a id="E15"></a>E15 | 현재 작업/산출물 계약에는 연구 노드 필드가 없고 산출물은 task에 속한다. live events는 조직 하위 query를 invalidate하고 ready/reconnect 시 재조회한다. 노드 연결·상세 query는 #56 확장 지점이다. | [task/artifact 계약](https://github.com/babo-jeonguk/BaboJUBot/blob/2982406dd79f29e73441662b267f3f750d1c9590/packages/contracts/src/task.ts#L108-L167)·[live events](https://github.com/babo-jeonguk/BaboJUBot/blob/2982406dd79f29e73441662b267f3f750d1c9590/apps/web/src/live-events.ts#L29-L47) | 소스 확인 |

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 단일 주 부모 표현 + 주 관계만 탐색 + 변경 직렬화 | E01–E06 | treebeard nullable parent, PG 실험 partial unique edge. 보조 관계는 제품 고유 규칙 | forest와 자유 관계의 공존 | cardinality/cycle/조직 FK는 서로 다른 보장. transaction만 둘러도 write skew 가능 |
| <a id="P02"></a>P02 | 종류·조직·토폴로지를 저장 경계에서 검사 | E08–E10,E14 | Dify registry/inspector와 달리 제품은 승인된 조직 템플릿 사본 기준 | UI·agent·직접 HTTP가 같은 규칙 사용 | 요청 shape 검사·검사 전용 endpoint만 있으면 쓰기 우회 가능 |
| <a id="P03"></a>P03 | 편집·출처·Event·수신자 입력의 한 transaction | E02,E04,E07,E14; [#55](issue-55-references.md#D01) | tree 삭제 rollback은 보조 사례이며 제품 wake를 구현하지 않음 | 부분 편집·누락된 Lead 입력 방지 | commit 후 publish/kick 실패는 저장 rollback이 아님. 재처리와 응답 유실 정책 별도 |
| <a id="P04"></a>P04 | 정본·선택 ID·폼 초안·보기 상태 분리 | E10–E13,E15; [#51](issue-51-references.md#패턴) | Dify 전체 graph hash, React Flow selection/viewport; 제품은 개별 편집 명령 | 실시간 갱신과 초안 보존을 함께 다룸 | 객체 snapshot 선택은 stale, 정본 재조회마다 폼 reset은 입력 손실 |
| <a id="P05"></a>P05 | 폐기는 단일 기록 전이, 관계와 연구 의미 보존 | E04,E07; #51 결정 | 외부 tree 라이브러리는 cascade delete, 제품은 기록 보존 | 복원·출처 추적과 숨김 투영 가능 | 표시에서 숨긴 parent는 layout root 처리하되 서버 구조에서 제거하면 cycle 누락 |

## 결정 권고

모든 행은 조사 권고다. 이미 확정된 #51 UI·제품 불변 조건을 재승인하거나 새 계약으로 바꾸지 않는다.

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | 주 연결에 안정적인 관계 ID를 부여하고 같은 조직 child당 최대1개를 DB로 방어한다. 관계 테이블+partial unique가 한 안이며, nullable parent 표현도 관계 ID 계약을 충족해야 함. `추가`는 두 번째 부모를 거부하고 `주 부모 변경`은 명시적으로 기존 관계를 교체/갱신한다. | P01,E04,E05; #56 AC2·#51 | 단순한 parent scalar도 가능하지만 화면 관계 ID·이력과 중복 정본을 고려. 관계와 parent 필드를 둘 다 원본으로 유지하지 않음 | Q1,Q4 |
| <a id="D02"></a>D02 | 채택 | 사용자·agent의 모든 구조 쓰기를 같은 조직 잠금에 직렬화하고, 획득 뒤 별도 statement로 최신 전체 주 구조를 읽어 자기/후손 부모를 거부한다. agent는 기존 run→org 잠금 순서를 유지. 폐기/숨김 노드도 검증 그래프에 포함하고 secondary는 제외. | P01–P02,E02–E06,E14; #56 | 보이는 노드만 검증하거나 개별 child 행만 잠그면 cycle을 놓칠 수 있음. 지금 규모에는 existing 조직 잠금 재사용이 단순; 추가 분산 lock/graph DB 불필요 | Q1,Q3,Q4 |
| <a id="D03"></a>D03 | 채택 | 모든 node/link mutation에서 조직 사본의 nodeKinds/linkKinds membership와 참조 양 끝을 검사한다. 신원은 토큰/Owner 경로에서 정하고 body organization/editor/run 필드는 허용하지 않는다. 교차 조직과 없는 ID는 같은404, 끝난 run과 승인 전 연구 쓰기도 기존 경계로 거부한다. | P02,E08–E10,E14; AGENTS·#49 | 조직 사본 JSON을 transaction 안에서 읽어 검증하면 됨. 실험의 정규화 kind FK를 제품에 그대로 도입하라는 뜻은 아님. 새로운 종류나 단계별 연결 허용표를 임의 추가하지 않음 | Q2,Q4 |
| <a id="D04"></a>D04 | 변형 채택 | 사용자 편집 성공마다 편집 ID·actor=Owner·대상/operation·변경 내용·시각과 지도 Event·Lead wake를 같은 transaction에 남긴다. agent 편집은 agent/run 출처를 남기되 사용자 편집 wake로 취급하지 않음. commit 뒤 기존 hub/dispatcher를 호출. 실패·거부·동일 값 재전송의 효과 중복은 따로 검증한다. | P03,E04,E07,E14; ADR-0002·#51 | latest updatedBy만으로 이전 변경/원인 추적 불가. mutation ID나 revision은 응답 유실 재시도·동시 수정 정책에 맞춰 정함; Event envelope와 별도 편집 테이블 중 저장 형식은 구현 선택 | Q1,Q3,Q4 |
| <a id="D05"></a>D05 | 채택 | 폐기/복원은 노드 상태 변경이다. 자손·주/보조 관계·task/artifact를 그대로 보존하고 기본 표시·숨김 토글, 폐기 영향 수와 취소 폼은 #51대로 제공한다. 숨긴 parent의 자식은 표시에서 root로 배치한다. | P05,E04,E07; #51 결정 | CASCADE·자동 rootify·자손 상태 전이는 기존 결정과 상충. 복원할 업무 상태와 폐기 노드의 새 연결 허용은 아래 열린 결정 | Q3,Q5 |
| <a id="D06"></a>D06 | 변형 채택 | task의 nullable node ID 또는 task별 unique 관계로0~1을 방어하고 두 번째 다른 노드 추가는 거부한다. 생성 시 선택 연결도 허용한다. node 상세는 같은 조직 연결 task와 그 산출물을 조회하고 원 task/artifact 경로로 이동한다. | P02,P05,E01,E04,E08,E15; #49 story20·#56 | task 링크를 array append로 만들지 않음. 첫 판에는 task를 통한 산출물 조회가 기존 모델과 맞으며 별도 artifact→node 정본 도입은 필요 근거 없음. 재연결/해제는 명시 정책이 필요 | Q4,Q5 |
| <a id="D07"></a>D07 | 채택 | 선택 ID로 최신 query record를 찾아 상세를 렌더링한다. 폼 초안·오류·pending과 위치/viewport를 별도 유지하고 성공 응답 뒤 정본 갱신/무효화한다. 오래된 expected revision/hash는 서버 잠금 아래 검사해 충돌을 알려 주는 안을 권고한다. | P04,E04,E10–E13,E15; #51 | 구조 잠금은 cycle을 막지만 오래된 의도를 덮어쓰는 문제까지 해결하지 않음. dirty 폼은 재조회로 지우지 말고 새 버전 안내/재적용 경로를 둠. 공동 CRDT·전체 graph autosave는 필요하지 않음 | Q1,Q5 |
| <a id="D08"></a>D08 | 채택 | React Flow+Dagre와 #51 배치·폼·드래그 결정을 그대로 구현한다. map/node/task query는 기존 organization key 하위에 두고 관련 Event·ready/reconnect 재조회에 연결한다. 배치 trigger는 보이는 node 집합/주 부모/방향 변경이며 제목·상태만 변경됐을 때는 좌표를 유지한다. | P04–P05,E11–E15; #51 | 폐기 숨김 토글로 node 집합이 바뀌는 경우는 상태 라벨 수정과 구분. 서버 mutation을 drag/selection/delete에 자동 연결하지 않음. 현재 공개 데모가 제품의 realtime·패널 성공을 입증하지는 않음 | Q3,Q5 |
| <a id="D09"></a>D09 | 보류 | 보조 중복/자기 연결·주 연결의 의미 종류·상태/복원·편집 가능 단계·위치 저장/겹침·수치 성능 목표를 아래 owner에게 남긴다. | E04,E09–E13; #51 미결·#56 | 선행 제품의 취향을 제품 정책으로 확정하지 않음. 무제한 보조 연결과 주 연결만 비순환이라는 기존 계약은 모든 안에서 보존 | Q1–Q5 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| FK/unique·단순 transaction·UI 후손 제외만으로 cycle 보장 | E01–E06 | 교차 행 동시 변경의 음성 대조가 실제로 cycle을 저장했음 |
| 전체 graph를 DAG로 제한하거나 숨김/폐기 노드를 구조 검증에서 제거 | E03–E05; #51·#56 | 보조 순환 허용과 원본 관계 보존을 위반 |
| 글로벌 node registry·검사 전용 API·모델/폼 clean만 검증 | E09 | 조직 사본 기준·모든 쓰기 강제를 만족하지 못함 |
| subtree 실제 삭제·자동 자손 폐기/재부모화 | E07; #51 | 폐기와 자손·연결 유지 결정에 상충 |
| renderer remove/parentId/addEdge/toObject를 연구 기록 계약으로 사용 | E12; [#51](issue-51-references.md#D03) | 물리 삭제·시각 containment·관계 중복 소실·보기 상태 혼합 위험 |
| Dify 전체 graph 교체/발행 단계, CRDT·graph DB·새 tree ORM 도입 | E09–E12 | 개별 기록 편집·현재 Postgres/Control Plane 범위를 넘어감 |

## 구현 참고

핵심은 **주 구조 검증과 쓰기의 같은 직렬화 범위, 조직 사본의 종류 검사, 편집·Lead 입력의 원자성, 정본과 보기/초안의 분리**다. core는 contracts에만 의존하고 DB·Express·React에 의존하지 않는다. UI는 규칙을 투영하고 Control Plane이 강제한다.

| 책임·구현 위치 | 연결할 기존 경계 |
|---|---|
| 계약 — `packages/contracts` | map/node/link 조회·변경, actor/출처·revision·wake reason/Event, task의 선택 node 연결. relation role(primary/secondary)와 템플릿 semantic kind의 의미를 구분 |
| 규칙 — `packages/core` | kind membership·주 연결 cycle·명시 부모 변경·task cardinality·폐기/복원·사용자 편집 효과. 연구 단계 진행이나 가설 정답 판단을 서버 규칙으로 추가하지 않음 |
| 저장 — `packages/db` | 지도 schema/migration·복합FK/primary unique·조직 scope 조회, `toolWrite`와 같은 org lock을 쓰는 Owner 변경, 변경·편집 출처·Event/wake 한 transaction. agent의 run→org 잠금 순서 유지 |
| 서버 — `apps/server` | 기존 토큰/gate·조회 scope·strict input·거부 코드, Owner/agent 공통 규칙, commit 뒤 EventHub/dispatcher. 인증·기록 출처·승인 전 쓰기를 새 route가 우회하지 않는지 확인 |
| 프로바이더 — `packages/runtime` | 기존 Script 일반 call/gate로 worker 노드→주/보조 연결→task 연결을 실제 HTTP 경로로 호출. 사용자 편집 wake가 실행 중 입력에 섞이지 않고 다음 run에 전달되는 시나리오 |
| 화면 — `apps/web` | map route·React Flow projection/Dagre, 선택 ID→최신 상세, 폼·실패 초안·충돌 안내, node→task/artifact와 task→node 이동, 조직 query·WS 재조회·390px 하단 패널 |

| ID | 검증할 경계 — 입력 → 행동 → 기대 | 근거 |
|---|---|---|
| V01 | 승인 전/후 worker의 같은 노드 생성 → 전 거부+Event, 후 노드/primary/secondary/task link 생성. 부모 없는 root·여러 root 허용 | D01–D03,D06; #56 AC1 |
| V02 | 이미 parent 있는 child에 두 번째 추가·self/후손 재부모화 → 거부. 명시 변경/부모 없음 → 최대1 유지. secondary cycle·동일 endpoint 다른 종류 관계는 별개 ID로 유지 | D01–D03; AC2 |
| V03 | 독립된 A/B를 동시에 서로의 parent로 바꾸는 Owner/agent 요청 → 하나만 허용, 최종 forest. 숨긴/폐기된 중간 노드를 지나는 cycle도 거부 | D02; E04 |
| V04 | 라이브러리 변경 뒤 이미 승인된 조직 사본으로 쓰기, 없는 node/link kind, 위조 actor/org/run 입력 → 사본만 기준·거부. 기본 흐름 순서와 다른 조합을 추가 금지 규칙 없이 다룸 | D03; AC2 |
| V05 | 다른 조직의 node·parent·secondary source/target·task ID를 조회/연결 → 없는 ID와 같은404, 타 조직 기록·편집·wake 없음. 유효/종료 token과 인증 후 종료 경합도 검사 | D02–D04,D06; AC4 |
| V06 | 사용자 제목/상태/부모/보조/생성/폐기·복원 성공 → actor=Owner·변경 원인·Lead wake/Event 한 번. 실패 주입 시 전체 rollback. 단순 drag/selection·실패·거부는 편집 효과 없음 | D04–D05,D08; AC3 |
| V07 | 자손·관계·task·artifact가 있는 parent 폐기/복원 → 모두 보존·자손 상태 불변. 숨김 표시에서 자식은 root지만 원본 parent 유지. 상세·원 task/artifact 이동 가능 | D05–D06; AC3/5 |
| V08 | task 첫 연결/두 번째 다른 노드/동시 연결 →0~1, 두 번째 암묵 덮어쓰기 없음. node 상세와 task 상세 양쪽에서 같은 관계와 관련 산출물을 조회 | D06; AC2/5 |
| V09 | 다른 탭 수정·최초 WS 연결 전 변경·재연결·조직 전환 → graph와 선택 상세/task가 재조회. dirty 폼은 보존하고 stale 저장은 충돌 안내. 진행 중 Lead는 다음 run에 사용자 편집 원인 수신 | D04,D07–D08; AC5 |
| V10 | 빈/로딩/404/전송 실패·응답 유실·긴 한국어 제목·1280/390px → 읽기/폼 재시도 가능. 제목·보조 추가 후 좌표/viewport 유지, node/주 부모 변경은 재배치, drag는 보기 상태만 변경 | D07–D08; #51 결정 |
| V11 | #51 fixture50/200/500·보조0/20/100%에서 선택·검색·편집·pan 측정 → 구현 전에 합의한 환경/목표와 대조. 대규모 렌더 성능은 이번 공개2노드 demo로 통과 처리하지 않음 | D08–D09; #51 성능 요구 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 보조 exact duplicate·self link | 사용자 / #56 | 서로 다른 종류의 같은 endpoint 관계는 보존. 동일(source,target,kind)은 거부/동일 기록 반환 vs 별도 의미 기록 허용; 자기 연결은 거부 vs 허용. 개수 무제한·보조 cycle 허용에서 어느 쪽도 자동 도출되지 않음(E04·#51 미결) |
| primary/secondary와 의미 kind의 관계 | 사용자 / #56 | primary는 구조 역할로 두고 semantic kind는 보조에만 요구 vs primary에도 선언 kind를 요구. 프로토타입은 parent 필드와 typed secondary를 분리했고 현 linkKinds는 supports/refutes/relates다. 모든 의미 kind는 사본 선언만 사용하되 임의 `primary` kind를 새 선언처럼 취급하지 않음 |
| node 업무 상태·복원·폐기 후 신규 편집 | 사용자 / #56 | active/discarded 최소 상태 vs #51 프로토타입의 제안/진행/완료/기각/폐기. 복원은 이전 상태 보관 vs 명시 상태 선택. 기존 관계 보존/복원 제공은 확정; 폐기 노드에 신규 link/task·제목 변경 허용 범위는 미정 |
| task 연결 변경/해제와 artifact 의미 | #56 | 첫 연결만 허용 vs 명시 reassign/unlink 추가. 어떤 안이든 두 번째 추가는 거부하고0~1 유지. task 재연결 시 산출물을 현재 task 경로로 보여 주는 안 vs 기록 당시 node 귀속 고정은 사용자 의미 선택; 후자는 별도 출처 모델 필요(E15) |
| Owner 편집 단계와 무변경/재시도 응답 | 사용자 / #56; 제어 후속 #59 | researching에서만 편집 vs paused/review에서도 편집+대기 wake. 사본 없는 승인 전·최종 완료·중단에서 허용할 조회/편집을 명시. 동일 값은 no-op 권고, 응답 유실은 mutation ID 재응답 vs revision 충돌 후 재조회. 재시도가 새 편집/wake로 중복 처리되지 않아야 함 |
| 보기 위치 저장·고정 충돌 | 사용자 / #56, #51 미결 | 세션 메모리/브라우저 사용자 설정/조직 공용 보기 저장. 고정 충돌은 되돌리기/구조 변경 시 해제/겹침 회피. 어느 안이든 연구 기록·Lead wake로 저장하지 않음 |
| 성능 목표·최적화 범위 | 사용자 / #56 | #51 측정은 근거이고 SLA가 아님. 측정 환경과 선택 지연/프레임 목표를 먼저 정한 뒤 필요한 memoization·보이는 요소 렌더·보조 단순화·찾기/접기를 고름. Worker 전환은 필요성 측정 후 별도 선택 |

후속 범위: 결과 검토에서 근거 산출물 진입은 #57, 조직/agent 제어는 #59, 서버 crash 재처리는 #60, 채널 outbox는 #61, 전 흐름 데모/E2E는 #63이다. #56은 기존 durable wake/Event에 편집을 연결하며 이 조사로 후속의 전달·복구 보장을 완료했다고 하지 않는다.

## 한계와 미확인

- 독립 SQL은 메커니즘 실험이며 제품 #56 API·migration·승인·격리 구현 완료 근거가 아니다. 종류 FK 정규화, relation kind가 비어 있는 실험 primary, 단순 active/discarded 상태, task 첫 연결 정책은 실험 fixture이며 제품 결정을 확정하지 않는다.
- SQL 첫 실행은 파라미터가 있는 복수 statement 사용으로, 두 번째는 최종 버전 출력의 package exports 접근으로 실패했다. probe를 수정한 세 번째 실행은8시나리오·37 assertions와 종료 코드0을 확인했다. 이전 실패 로그도 보존한다. 설치는 하지 않았고 기존 의존성만 키 없는 셸·MemoryMax2G에서 사용했다. 임시 cluster는 finally에서 정지·정리했다.
- treebeard/Dify의 테스트는 읽었고 실행하지 않았다. 실제 API 우회·교차 tenant exploit·신규 draft 동시 생성·upstream 전체 write 경로·crash 복구·성능 보장은 미확인이다. 근거는 해당 파일·경로의 거부/검사 위치에 한정한다.
- 정확히 조직별 승인된 template whitelist와 연구 task0~1을 함께 구현하는 외부 사례는 조사 범위에서 확인하지 못했다. 이 권고는 제품 확정 요구와 부분 동형 사례·실패 반례의 종합이며 외부 제품의 동작을 그대로 이식한 것이 아니다.
- 공개 React Flow 예시는2노드의 제목·선택·숨김만 실행했다. 배포 SHA는 미확인이다. hidden은 제품 폐기가 아니며 서버 저장·오류·권한·Event·dirty 폼·전체 상세 패널·실제 터치/화면 읽기·50/200/500 성능은 실행하지 않았다. 다른 회사 캡처는 캐시에만 두고 이슈/저장소에 첨부하지 않는다.
- Typebot 등 계정이 필요한 editor는 열지 않았고 Pro 소스·실제 모델·유료 API·자격 증명·실제 연구 데이터를 사용하지 않았다. 후보의 metadata/검색 결과는 실행/소스 근거로 승격하지 않았다.
- 이번 변경은 조사 문서와 문서 지도뿐이며 제품 코드·테스트·설정과 기존 확정 계약은 그대로다. 제품 전체 테스트·E2E·upstream 전체 테스트는 미실행이다. 문서 로컬 링크와 diff 형식 검사 결과는 receipt에 따로 기록한다.
