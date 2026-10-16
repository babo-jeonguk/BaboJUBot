# issue-51 레퍼런스 조사: 연구 지도 그래프

조사일: 2026-10-16 (Asia/Seoul). 대상: [#51](https://github.com/babo-jeonguk/BaboJUBot/issues/51), parent [#49](https://github.com/babo-jeonguk/BaboJUBot/issues/49), 구현 후속 [#56](https://github.com/babo-jeonguk/BaboJUBot/issues/56). 구현 전 권고이며 확정 계약이나 구현 결과가 아니다. 상세 원문·실행 로그·캡처는 `.reference-cache/issue-51/`에 보존하고 Git에서 제외한다.

결과(2026-10-16): 프로토타입 비교 후 사용자가 React Flow + Dagre(A)를 골랐습니다. 결정과 #56이 따를 배치·편집 규칙은 [#51 결정 댓글](https://github.com/babo-jeonguk/BaboJUBot/issues/51#issuecomment-6209365865), 프로토타입 원본은 `prototype/research-map` 브랜치에 있습니다. 아래 본문은 결정 전 조사 기록입니다.

## Brief

- 구현할 문제: 주 연결 트리와 연한 보조 연결을 보며 노드 선택·상세·추가·수정·주 부모 변경·보조 연결 추가·폐기를 시험하고, 수십~수백 노드에서 읽을 만한지 사용자가 판단한다. #51의 최종 라이브러리 선택과 `prototype/research-map` 브랜치 산출물은 후속 프로토타입 작업이며 이번 조사는 그 완료를 뜻하지 않는다.
- 동종 문제: 최대 한 주 부모를 갖는 비순환 forest를 뼈대로 배치하고 별도 의미 관계를 중첩하는 편집 가능한 탐색 화면.
- 고정된 결정: [용어](../../GLOSSARY.md), [기능](../features.md), [구조](../architecture.md), [ADR-0001~0004](../adr/). React·Vite·TypeScript·Tailwind·Radix/shadcn·TanStack Query. 조직별 독립 기록, 템플릿의 노드·연결 종류, 주 부모 최대 하나·주 연결 순환 금지·부모 없는 노드 허용·보조 연결 개수 무제한·삭제 대신 `폐기`. 작업은 연구 노드 0~1개에 연결한다. 사용자 편집은 편집자 기록과 Lead 깨우기를 만든다. UI는 조직 경계·승인·구조 규칙의 강제 위치가 아니다. 초기 연구 승인과 최종 완료는 사용자 결정이다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 주 연결만으로 forest를 배치하고 보조 연결을 겹칠 때 어떤 렌더러·배치 엔진 조합과 제약이 있는가? | #51 배치, #49 stories 53/58, 구조의 연구 지도 | Source Recon + 공식 예시 Surface Capture + 배치 probe |
| Q2 | 선택·상세·추가·제목/상태 수정·주 부모 변경·보조 연결·폐기를 어떤 상호작용으로 연결하고 오조작을 막는가? | #51 간단 편집, #49 stories 54–57, #56 | Source Recon + Behavioral Recon + 정상/거부 대조 |
| Q3 | 수십~수백 노드·긴 제목·다중 root·보조 연결 밀도에서 탐색·배치 안정성·접근성·좁은 화면을 어떻게 검증할까? | #51 규모·AC 3 | 실화면 조작 + 성능 문서/소스 + 배치 측정 |
| Q4 | 후보 비교와 사용자 선택에 어떤 축과 프로토타입 자료가 필요한가? | #51 AC 1–3, #56 AC, AGENTS 불변 조건 | registry metadata + 라이선스 + 사례 비교 + 시나리오 종합 |

| 기존 조사 | 재사용 범위 | 재확인·판단 |
|---|---|---|
| [#50](issue-50-references.md#brief) | 셸·조직 범위·좁은 화면과 상세 진입 맥락 | 그래프 배치·성능 근거는 없어 전이하지 않음 |
| [기타 대시보드](dashboard-references.md#4-자동-연구-시스템의-연구-진행-시각화) | AI Scientist-v2의 노드별 근거·산출물 상세라는 질문 출발점 | 기존 anchor로만 인용; 정적 tree export를 편집·다중 관계 지원 근거로 쓰지 않음 |
| [Paperclip 대시보드](paperclip-dashboard.md)·[비교 목록](comparative-survey.md) | 후보 발견과 제품 범위 | 연구 지도 편집의 직접 근거 없음; 새 소스 근거로 재사용하지 않음 |
| [#1](issue-1-references.md#brief)·[코드 구조](reference-code-structure.md) | 스택·책임 경계 배경 | 과거 #1은 백로그 초기화 전 이슈. 최신 ADR·#49/#51/#56 우선; 예전 storage 명칭·스택 후보를 되살리지 않음 |
| [Paperclip](paperclip.md)·[실행 모델](agent-runtime-models.md)·[상호작용](agent-interaction-models.md) | 영속 연구 기록·조직 경계의 배경 | 그래프 라이브러리 근거로 재사용하지 않음 |

기존 `.reference-cache/issue-1/`, `issue-50/`, `wayfinder-foundation/`은 조사·이슈 맥락만 재사용했다. 연구 지도 라이브러리 실행 근거는 찾지 못했다. 과거 고정 소스의 동작 주장을 이번 근거로 복제하지 않아 두 ref 간 blob 비교 대상은 없다.


## 레퍼런스

세 관점의 후보는 **21개**다. 후보별 실행 경로·질문·선정/제외 이유·검색어는 `candidates.md`, 관점별 원문은 `notes/`에 있다. 공개 데모 접근과 실제 조작을 구분했다. 일부 후보는 공개 실행 경로를 찾지 못해 self-host 경로 또는 「없음·미확인」으로 남겼다.

| 관점 | Saturation 근거 |
|---|---|
| React 편집기·OSS 사용처 | 7개, 4라운드. 마지막 공식 예시·Pro·사용처 확인은 외부 배치/ELK 통합/pipe/MVC, 중복 연결·삭제·선택·렌더 비용 외 새 패턴을 더하지 않음 |
| 범용 그래프 렌더러 | 7개, 3라운드. 마지막 의존성·registry·라이선스·예시 확장은 부분 배치/behavior/WebGL/조작 callback과 전역 그래프 누출·과거 benchmark 전이 외 새 유형 없음 |
| 배치 엔진·인접 mind-map | 7개, 3라운드. 마지막 DOT·인접 tree 편집·history는 layered/tidy tree/가변 크기/별도 arrows와 forest·worker 실패 외 새 유형 없음 |

검색 범위의 패턴 포화이며 생태계 전체를 소진했다는 뜻은 아니다. 아래 6개를 소스 심층 대상으로 삼았다. 확인일은 모두 2026-10-16이다.

| 레퍼런스 | 버전·고정 SHA | 라이선스 | 깊이·선정 이유 |
|---|---|---|---|
| React Flow / xyflow | `@xyflow/react` 12.12.0 · `3d35b57317576b0916c0bfeaaedd573aaacc2839` | MIT | 소스·원본 helper 실행. React 노드·선택·연결·접근성·controlled view. 공개 공식 예시 UI도 별도 관찰 |
| Cytoscape.js | 3.34.3 · `716a1cb6c6015d57b674abe626deaeb5e817ee30` | MIT | 소스·배포 dist headless 실행·공개 UI. Canvas/graph model과 subset layout의 반례 |
| @dagrejs/dagre | 3.1.1 · `c3ed0802cd98de74c21cff1f754689ebbb0f8dae` | MIT | 소스·npm 실행. 단순 layered 배치 기준선 |
| elkjs | 0.12.0 · `ff5771d7165445c42c408bb8a090c8035272218c` | package/header `EPL-2.0 OR GPL-3.0-or-later`, root EPL-2.0 | 소스·npm bundled 실행. ports/route·비동기·Worker 조합의 대안 |
| d3-hierarchy | 3.1.2 · `c4ae7066d5a52e8aeaab24b3f7113e25c38183f2` | ISC | 소스·stratify 실행. 단일 root tree 입력과 forest 변환 비교 |
| d3-flextree | 2.1.2 · `af196220927218bbe7ac6cad8e059f56430befb6` | WTFPL | 소스·npm 실행. 가변 크기 tidy tree 비교. 오래된 의존성·TS 통합은 추가 확인 필요 |

설계 참고와 라이브러리 API 평가다. 제품 코드 복사는 없고 채택을 확정하지 않는다. 재사용 때 해당 SHA의 LICENSE·header·NOTICE·함께 들어오는 의존성을 다시 확인하고 출처 header·루트 `THIRD_PARTY_NOTICES.md` 규칙을 따른다. 공개 웹 예시의 배포 SHA는 확인하지 못했으므로 고정 소스 실행과 같은 버전이라고 가정하지 않는다.

### 프로토타입 비교안

| 조합 | 먼저 확인할 이점 | 비용·미확인 |
|---|---|---|
| React Flow + Dagre | React 상세·폼과 결합, 가로/세로 기준선, 단순 node box→좌표 계약 | 정적 예시 이후 재배치 정책은 직접 구성. 주/보조 중복·삭제·ID 보존은 별도 처리 |
| React Flow + ELK | 같은 편집기에서 배치만 교체, ports/edge sections를 활용할 여지 | 옵션·bundle·Worker 구성이 복잡해짐. 이번에는 실제 Worker·브라우저 통합 미검증 |
| Cytoscape + 독립 forest 배치 | Canvas·graph 탐색/선택·headless 조작 계약을 비교 가능 | 실제 React 카드·키보드/상세 폼 연결 비용 미검증. 내장 subset layout의 전역 참조 주의 |

비교 근거는 아래 E01–E24다. renderer와 배치 엔진을 따로 평가하며 완성된 연구 지도 프로토타입을 세 개 만들었다는 뜻은 아니다.

## 근거

소스 확인은 구현을 읽었다는 뜻이다. upstream 테스트를 읽은 사실과 이번 probe 실행을 구분한다. 메인은 결정에 쓴 원문을 다시 읽고 `main-verification.md`에 일치·정정을 남겼다. 캡처는 메인이 모두 열어 상태를 확인했고 Git·이슈에 첨부하지 않았다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | React Flow는 외부 Dagre/ELK/D3와 조합한다. 무료 Dagre 예시는 정적 배치이며 편집 때 자동 재계산하지 않는다. | [배치 안내](https://reactflow.dev/learn/layouting/layouting), [Dagre 예시](https://reactflow.dev/examples/layout/dagre) | 문서 주장 |
| <a id="E02"></a>E02 | edge style/data/type과 시각 parentId가 있다. parentId는 부모 기준 위치를 계산하는 containment이므로 연구의 주 부모와 의미가 다르다. | [Edge](https://github.com/xyflow/xyflow/blob/3d35b57317576b0916c0bfeaaedd573aaacc2839/packages/react/src/types/edges.ts#L54-L79), [updateChildNode](https://github.com/xyflow/xyflow/blob/3d35b57317576b0916c0bfeaaedd573aaacc2839/packages/system/src/utils/store.ts#L214-L264) | 소스 확인 |
| <a id="E03"></a>E03 | addEdge는 endpoint/handle tuple로 중복 판정한다. 관계 종류·ID는 비교하지 않는다. reconnectEdge 기본은 ID를 바꾼다. | [connectionExists/addEdge](https://github.com/xyflow/xyflow/blob/3d35b57317576b0916c0bfeaaedd573aaacc2839/packages/system/src/utils/edges/general.ts#L102-L174), [reconnectEdge](https://github.com/xyflow/xyflow/blob/3d35b57317576b0916c0bfeaaedd573aaacc2839/packages/system/src/utils/edges/general.ts#L209-L244) | 소스 확인 |
| <a id="E04"></a>E04 | 원본 helper 추출·타입 제거 실행에서 서로 다른 주/보조 의미·ID도 같은 tuple이면 하나만 유지했다. distinct handle은 둘 다 유지. cycle·두 번째 부모는 허용, reconnect ID 변경/보존 대조 통과. | `probes/xyflow-edge-contracts.mjs`, `.log`; Node 24.21.0, 6 assert | 실행 확인 |
| <a id="E05"></a>E05 | deleteElements는 remove change를 발행하고 연결 edge도 삭제 후보에 포함한다. 폐기 상태 전환과 별개다. upstream 선택·삭제 테스트는 읽었으나 실행하지 않았다. | [deleteElements](https://github.com/xyflow/xyflow/blob/3d35b57317576b0916c0bfeaaedd573aaacc2839/packages/react/src/hooks/useReactFlow.ts#L163-L203), [getElementsToRemove](https://github.com/xyflow/xyflow/blob/3d35b57317576b0916c0bfeaaedd573aaacc2839/packages/system/src/utils/graph.ts#L499-L544), [upstream test](https://github.com/xyflow/xyflow/blob/3d35b57317576b0916c0bfeaaedd573aaacc2839/tests/playwright/e2e/nodes.spec.ts#L171-L196) | 소스 확인 |
| <a id="E06"></a>E06 | 선택 ID 변화 callback, keyboard 선택·해제·이동·focus autopan·ARIA를 구현한다. 상세 패널은 앱이 붙여야 한다. | [SelectionListener](https://github.com/xyflow/xyflow/blob/3d35b57317576b0916c0bfeaaedd573aaacc2839/packages/react/src/components/SelectionListener/index.tsx#L17-L58), [NodeWrapper](https://github.com/xyflow/xyflow/blob/3d35b57317576b0916c0bfeaaedd573aaacc2839/packages/react/src/components/NodeWrapper/index.tsx#L128-L225) | 소스 확인 |
| <a id="E07"></a>E07 | NodeRenderer는 visible ID를 구독해 개별 갱신을 분리한다. visible edge 계산은 전체 edge 순회가 있어 culling 자체의 비용도 있다. | [NodeRenderer](https://github.com/xyflow/xyflow/blob/3d35b57317576b0916c0bfeaaedd573aaacc2839/packages/react/src/container/NodeRenderer/index.tsx#L38-L68), [useVisibleEdgeIds](https://github.com/xyflow/xyflow/blob/3d35b57317576b0916c0bfeaaedd573aaacc2839/packages/react/src/hooks/useVisibleEdgeIds.ts#L15-L54) | 소스 확인 |
| <a id="E08"></a>E08 | 공식 Dagre 실화면에서 가로 전환·node 2 선택·세로 전환. 11 nodes/9 edges의 다중 root 구조를 확인했다. | [공개 예시](https://example-apps.xyflow.com/react/examples/layout/dagre/index.html); `captures/dagre-{horizontal-selected,vertical}.png`, `public-capture-retry.json` | 실행 확인 |
| <a id="E09"></a>E09 | cycle 예시에서 B→C 연결은 edge 1→2, C→A 연결 시도는 2를 유지했다. 이는 해당 예시 validator 동작이며 라이브러리 기본 보장이 아니다. | [공개 예시](https://example-apps.xyflow.com/react/examples/interaction/prevent-cycles/index.html); `captures/cycles-rejected.png`, 동일 로그 | 실행 확인 |
| <a id="E10"></a>E10 | Label에 한국어 입력 시 화면 반영, 390px resize 후 긴 제목에서는 기존 viewport의 노드가 잘렸다. 우클릭 메뉴는 duplicate/delete만 보였다. 연구 상세·폼 설계를 그대로 제공하는 예시가 아니다. | [update](https://example-apps.xyflow.com/react/examples/nodes/update-node/index.html), [context](https://example-apps.xyflow.com/react/examples/interaction/context-menu/index.html); `captures/update-{title,mobile}.png`, `context-menu.png` | 실행 확인 |
| <a id="E11"></a>E11 | Stress 실화면에서 450 nodes/449 edges, Fit View·Zoom In·change pos·Node 200 선택은 동작했다. 랜덤 위치의 전체 화면은 제목·연결이 겹쳤다. FPS나 연구 데이터 가독성 통과 근거는 아니다. | [공개 stress](https://example-apps.xyflow.com/react/examples/nodes/stress/index.html); `captures/stress-450.png`, 동일 로그 | 실행 확인 |
| <a id="E12"></a>E12 | Cytoscape breadthfirst의 BFS는 edge subset을 검사하지만 root 자동 추론은 전역 connectedEdges, 기본 depthSort는 전역 neighborhood를 읽는다. | [roots](https://github.com/cytoscape/cytoscape.js/blob/716a1cb6c6015d57b674abe626deaeb5e817ee30/src/extensions/layout/breadthfirst.mjs#L43-L86), [defineDagExtremity](https://github.com/cytoscape/cytoscape.js/blob/716a1cb6c6015d57b674abe626deaeb5e817ee30/src/collection/traversing.mjs#L9-L42), [BFS](https://github.com/cytoscape/cytoscape.js/blob/716a1cb6c6015d57b674abe626deaeb5e817ee30/src/collection/algorithms/bfs-dfs.mjs#L81-L100), [depthSort](https://github.com/cytoscape/cytoscape.js/blob/716a1cb6c6015d57b674abe626deaeb5e817ee30/src/extensions/layout/breadthfirst.mjs#L230-L304) | 소스 확인 |
| <a id="E13"></a>E13 | stable 배포 headless에서 보조 cycle이 root 추론을 바꾸고, roots를 명시해도 다른 보조 edge가 형제 순서를 바꿨다. roots+독립 comparator 대조는 해당 fixture에서 같았다. multi-parent/cycle 수용·missing endpoint 거부·상태 갱신 보존·remove 관계 삭제도 확인했다. | `probes/cytoscape-{3.34.3-run-log,order-overlay-run-log}.txt`, 2개 probe; 8+2 check, Node 24.21.0 | 실행 확인 |
| <a id="E14"></a>E14 | Cytoscape move는 존재하는 endpoint만 바꾸며 remove는 연결 edge와 compound descendants도 수집한다. layout/renderer의 parent와 연구 주 부모는 구별해야 한다. | [move](https://github.com/cytoscape/cytoscape.js/blob/716a1cb6c6015d57b674abe626deaeb5e817ee30/src/collection/index.mjs#L748-L797), [remove](https://github.com/cytoscape/cytoscape.js/blob/716a1cb6c6015d57b674abe626deaeb5e817ee30/src/collection/index.mjs#L586-L633) | 소스 확인 |
| <a id="E15"></a>E15 | 공식 Cytoscape Dagre demo(브라우저 버전 3.34.3, 17 nodes/13 edges)에서 n0를 drag해 (147,235)→(237,295) 이동. 이 demo는 autounselectify이므로 선택·상세 동작 근거로 쓰지 않는다. | [공개 demo](https://js.cytoscape.org/demos/dagre-layout/), [demo 설정](https://github.com/cytoscape/cytoscape.js/blob/716a1cb6c6015d57b674abe626deaeb5e817ee30/documentation/demos/dagre-layout/code.js#L1-L12); `captures/cytoscape-dragged.png`, `cyto-demo-browser.json` | 실행 확인 |
| <a id="E16"></a>E16 | Dagre는 입력 graph별 이전 배치를 보관한다. acyclic.run은 cycle edge를 내부 역전하고 undo는 복원한다. cycle 거부 validator가 아니다. | [layout](https://github.com/dagrejs/dagre/blob/c3ed0802cd98de74c21cff1f754689ebbb0f8dae/lib/layout.ts#L37-L49), [acyclic run](https://github.com/dagrejs/dagre/blob/c3ed0802cd98de74c21cff1f754689ebbb0f8dae/lib/acyclic.ts#L8-L25), [undo](https://github.com/dagrejs/dagre/blob/c3ed0802cd98de74c21cff1f754689ebbb0f8dae/lib/acyclic.ts#L77-L89) | 소스 확인 |
| <a id="E17"></a>E17 | ELK layout은 Promise 메시지 API. workerFactory/URL을 받지만 Node 기본은 fake worker fallback이어서 비동기 API만으로 별도 thread를 보장하지 않는다. | [ELK API](https://github.com/kieler/elkjs/blob/ff5771d7165445c42c408bb8a090c8035272218c/src/js/elk-api.js#L17-L83), [ELKNode](https://github.com/kieler/elkjs/blob/ff5771d7165445c42c408bb8a090c8035272218c/src/js/main-node.js#L18-L48) | 소스 확인 |
| <a id="E18"></a>E18 | 50/200/500 가변 크기 노드·3 roots에서 primary-only 배치와 전체 edge 배치를 비교했다. 보조를 넣으면 위치가 바뀌며, 뺀 입력의 재계산은 같았다. Dagre/ELK 모두 cycle 입력을 수용했다. | `probes/layout-engines.mjs`, `layout-run-log.txt`; Node 24.21.0, Dagre 3.1.1/ELK 0.12.0, 2GiB scope | 실행 확인 |
| <a id="E19"></a>E19 | D3 stratify는 여러 root·없는 parent·cycle을 거부한다. forest를 직접 통과시키지 않으므로 virtual root 또는 component별 변환이 필요하다. | [stratify](https://github.com/d3/d3-hierarchy/blob/c4ae7066d5a52e8aeaab24b3f7113e25c38183f2/src/stratify.js#L62-L95) | 소스 확인 |
| <a id="E20"></a>E20 | flextree는 node별 size accessor를 쓰는 hierarchy 배치다. 렌더러·보조 연결·연구 편집 규칙을 제공하는 API가 아니다. | [flextree](https://github.com/Klortho/d3-flextree/blob/af196220927218bbe7ac6cad8e059f56430befb6/src/flextree.js#L1-L46) | 소스 확인 |
| <a id="E21"></a>E21 | D3의 multiple roots/cycle/dangling 거부와, flextree의 virtual root로 50/200/500 가변 크기 배치·겹침 0을 확인했다. 노드 box의 겹침이며 edge·label 충돌이나 UI 가독성 측정이 아니다. | `probes/layout-run-log.txt`; D3 3.1.2·flextree 2.1.2 | 실행 확인 |
| <a id="E22"></a>E22 | xyflow/Cytoscape/Dagre root MIT, ELK package/header의 SPDX와 root EPL2를 확인했다. 자동으로 모두 같은 배포 조건이라고 볼 수 없다. | [xyflow LICENSE](https://github.com/xyflow/xyflow/blob/3d35b57317576b0916c0bfeaaedd573aaacc2839/LICENSE#L1-L21), [Cytoscape LICENSE](https://github.com/cytoscape/cytoscape.js/blob/716a1cb6c6015d57b674abe626deaeb5e817ee30/LICENSE#L1-L19), [Dagre LICENSE](https://github.com/dagrejs/dagre/blob/c3ed0802cd98de74c21cff1f754689ebbb0f8dae/LICENSE#L1-L19), [ELK manifest](https://github.com/kieler/elkjs/blob/ff5771d7165445c42c408bb8a090c8035272218c/package.json#L24-L28), [ELK header](https://github.com/kieler/elkjs/blob/ff5771d7165445c42c408bb8a090c8035272218c/src/js/elk-api.js#L1-L14) | 소스 확인 |
| <a id="E23"></a>E23 | 자동 배치·펼침/접기 중 일부 공식 예시는 Pro이며 auto-layout 페이지의 라이선스는 xyflow Pro License다. OSS 본체의 MIT와 구분한다. | [Auto Layout Pro](https://reactflow.dev/examples/layout/auto-layout) | 문서 주장 |
| <a id="E24"></a>E24 | 공식 가이드는 전체 nodes 구독·불안정 callback·무거운 스타일을 피하고, 큰 tree 숨김/단순화를 제안한다. Cytoscape도 라벨·곡선·반투명 비용을 설명한다. | [React Flow 성능](https://reactflow.dev/learn/advanced-use/performance), [접근성](https://reactflow.dev/learn/advanced-use/accessibility), [Cytoscape 성능](https://github.com/cytoscape/cytoscape.js/blob/716a1cb6c6015d57b674abe626deaeb5e817ee30/documentation/md/performance.md#L5-L37) | 문서 주장 |

### 배치 실행 수치의 해석

`layout-run-log.txt`의 정상 종료 재실행 값을 사용한다. 한 fixture, 1회 warm-up 후 3회 중앙값, Node에서 배치 호출부터 완료까지의 경과 시간이며 렌더링·React commit·FPS·사용자 탐색 시간은 포함하지 않는다. 배치 중 다른 조사 작업의 부하가 있어 순위나 SLA로 일반화하지 않는다. 가변 box는 폭 140–260, 높이 44–92px이며 보조 연결은 약 20% 추가했다(E18/E21). 실제 브라우저 Worker 성능은 미측정이다.

| 엔진 | 50 nodes 주/전체(ms) | 200 nodes 주/전체(ms) | 500 nodes 주/전체(ms) |
|---|---:|---:|---:|
| Dagre 3.1.1 | 50.46 / 81.00 | 162.77 / 474.61 | 299.67 / 1775.82 |
| ELK 0.12.0 | 121.64 / 116.17 | 144.44 / 399.84 | 310.06 / 1151.25 |
| flextree 2.1.2 | 1.92 / 미측정 | 5.89 / 미측정 | 10.85 / 미측정 |

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 주 구조 좌표 계산과 전체 관계 렌더링 분리 | E01/E12/E13/E18 | React Flow는 외부 엔진, Cytoscape는 graph 내부 layout | 보조 연결 추가로 주 배치가 변하지 않는 경계 | subset API도 helper의 전역 참조까지 차단하지 않을 수 있음 |
| <a id="P02"></a>P02 | 연구 기록을 renderer의 임시 node/edge로 투영 | E02–E05/E14 | React parentId·Cytoscape parent는 시각 containment | domain 모델과 renderer 교체를 분리 | 기본 dedup·ID 재생성·물리 삭제를 그대로 적용하면 의미 손실 |
| <a id="P03"></a>P03 | 선택 ID → 최신 기록 상세·명시 편집 폼 | E06/E08/E10 | callback과 input 예시는 있으나 연구 상세는 직접 구성 | 읽기/수정 대상을 명확히 표시 | 우클릭·handle drag만 있으면 좁은 폭·키보드 경로 부족 |
| <a id="P04"></a>P04 | 배치는 명시 trigger, 탐색 viewport는 별도 상태 | E01/E08/E16–E18 | static Dagre, 상태를 기억하는 Dagre graph, async ELK | 수정마다 화면이 튀는 일을 줄임 | 이전 async 결과 역전·측정 전 box·긴 제목에서 재배치 필요 |
| <a id="P05"></a>P05 | 렌더 가능성·읽기·편집 성공을 별도 평가 | E07/E10/E11/E18/E21/E24 | 단순 HTML 노드와 Canvas의 비용·접근 경로가 다름 | 같은 연구 fixture로 비교 가능 | 작은 layout 시간이나 노드 수 데모가 읽기 쉬움을 보장하지 않음 |
| <a id="P06"></a>P06 | 라이브러리 guard는 UX, 제품 경계는 서버 규칙 | E04/E09/E13/E16/E19, #49/#56 | cycle 수용/거부가 알고리즘 목적마다 다름 | 우회 호출·동시 수정에도 연구 구조 유지 | 전체 관계 DAG 제한·compound 부모 검사를 연구 규칙으로 오인 가능 |

## 결정 권고

다음은 조사자의 권고다. 라이브러리·편집 UX를 고르는 #51 사용자 결정을 대신하지 않는다.

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | React Flow + Dagre를 첫 비교 기준선, React Flow + ELK를 배치 대안, Cytoscape를 Canvas 비교 후보로 둔다. 동일 fixture로 평가 후 사용자가 고른다. | P01/P03/P05, E01/E06/E17/E22 | 확정 React 스택에 맞는 편집 구성부터 비교. Dagre가 최종 답이라는 뜻은 아니며 Canvas도 실제 카드/폼 구현 비용 검증 필요 | Q1/Q3/Q4 |
| <a id="D02"></a>D02 | 채택 | 주 연결만 가진 별도 layout 입력을 만들고 모든 domain node의 크기·root를 포함한다. 보조 연결은 계산 결과에 겹쳐 그린다. 보조 추가만으로 좌표가 변하지 않는 대조를 둔다. | P01, E12/E13/E18 | edge subset·physics:false·roots 지정만으로 독립을 가정하지 않음. 보조 route와 노드 충돌 회피는 별도 평가 | Q1/Q3 |
| <a id="D03"></a>D03 | 변형 채택 | 고유 관계 ID를 투영하고 주/보조의 선 모양·굵기·선택 강조를 구별한다. addEdge의 동일 tuple 중복 제거를 domain 중복 정책으로 쓰지 않는다. parentId는 주 부모에 매핑하지 않는다. | P02, E02–E05/E14 | 같은 endpoint의 여러 관계 허용 여부는 #56이 결정. renderer helper에 묻혀 관계가 사라지는 일을 막음 | Q1/Q2 |
| <a id="D04"></a>D04 | 변형 채택 | 기본 후보는 노드 선택→상세, 추가·제목/상태·주 부모 선택·보조 대상/종류 선택을 명시 폼으로 제공. handle drag는 비교용 선택지로 남긴다. | P03/P06, E06/E08–E10 | 폼은 대상을 명료하게 보이며 키보드 경로 구성에 유리. drag는 빠를 수 있으나 주/보조 구분·실수 취소 검증 필요 | Q2/Q4 |
| <a id="D05"></a>D05 | 배제 | 라이브러리 delete/remove의 연구 기록 삭제 직결, reconnect의 기본 ID 변경을 원본 기록 변경으로 간주하는 방식은 배제. 폐기는 상태 명령으로 보존한다. | P02, E03–E05/E13/E14, #56 | 기록·관계 보존은 확정 요구. 화면에서 숨기기와 원본 상태 전환을 구별 | Q2 |
| <a id="D06"></a>D06 | 변형 채택 | 구조 변경 후 재배치와 수동 재정렬을 비교하고 선택/viewport를 보존한다. 스타일·보조 연결·상세 선택만으로 재배치하지 않는 기준선을 둔다. async 결과는 해당 조직·입력 revision과 일치할 때만 반영한다. | P04, E01/E08/E17/E18 | 입력 revision 검사는 이번 실행에서 검증한 기능이 아닌 실패 예방 설계 추론. 자동/수동 기본값은 사용자 선택 | Q1/Q2/Q3 |
| <a id="D07"></a>D07 | 변형 채택 | 50/200/500 연구 fixture로 초기 화면·pan/zoom·선택·편집·관계 탐색을 별도 평가. 긴 한국어 제목, 다중 root, 폐기, 보조 0/20/100%를 포함하고 1280/390px에서 본다. | P05, E07/E10/E11/E18/E21/E24 | FPS·p95 지연과 찾기/편집 성공률을 기록. 접기·관계 강조·보조 표시 토글은 비교 수단이며 기본 숨김 정책은 미확정 | Q3/Q4 |
| <a id="D08"></a>D08 | 채택 | #56에서 조직 경계·주 부모 최대 하나·주 연결 cycle·템플릿 종류·작업 연결 제한을 서버 경계로 검증하고 사용자 편집 기록과 Lead 깨우기를 확인한다. | P06, E04/E09/E13/E16/E19, #49/#56 | UI 연결 검사는 빠른 피드백용. 보조까지 DAG로 강제하는 새 정책을 넣지 않음. 초기 연구 승인·최종 완료 흐름을 그래프 편집기로 대체하지 않음 | Q1/Q2/Q4 |

### 배제·보류한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 모든 관계를 배치/DAG 검사에 투입 | E12/E13/E18, 공식 prevent-cycle 예시 | 보조가 주 구조를 흔들고 보조 cycle까지 막는다. 주 구조와 관계 종류를 먼저 나눈다 |
| force simulation을 기본 트리 배치로 사용 | D3-force·VivaGraph·Sigma 사용처 | 확정된 주 연결 트리와 안정된 편집 위치가 우선. 네트워크 탐색 대안으로만 보류 |
| Pro 자동 배치 소스를 MIT 본체처럼 복사 | E23 | 공개 설명과 유료 예제 소스 계약을 구분. 무료 API로 별도 구성 가능 여부를 먼저 평가 |
| 특정 노드 수·과거 benchmark로 성능 승자 확정 | E11/E18/E24, graph-lib-comparison | 동일 데이터·현재 버전·실제 노드 UI로 다시 평가해야 함 |
| flextree의 짧은 배치 시간만으로 최종 채택 | E20/E21 | 가변 크기 tree 대안은 유효하나 typed integration·의존성·편집 UI 비용 미검증 |

## 구현 참고

- 다음 작업은 #51의 버려도 되는 프로토타입에서 같은 연구 기록 fixture와 시나리오를 비교하고, 사용자가 고른 코드·이유를 `prototype/research-map` 브랜치와 이슈 댓글에 남기는 것이다. 이번에는 해당 브랜치·제품 코드·테스트·설정을 만들거나 변경하지 않았다.
- #56 구현 때 `apps/web`은 선택·폼·viewport·좌표 투영을 담당한다. `packages/contracts`는 교환 형식, `packages/core`는 연구 구조·조직 규칙, `packages/db`는 영속 기록, `apps/server`는 사용자 편집/도구의 공통 경로·감사·깨우기를 조립한다. graph 라이브러리를 core/contracts에 의존시키지 않는다. 하네스의 흐름 템플릿은 종류를 선언하며 강제 수단을 대신하지 않는다.
- 그래프가 보여 주는 것은 연구 기록과 연결 작업·산출물이다. 노드를 실제 모델 내부 추론이나 실행 시도 자체로 취급하지 않는다. 실제 모델·비밀값·실제 연구 데이터 없이 합성 fixture로 비교한다.

| ID | 검증할 경계: 입력 → 행동 → 기대 | 근거·시점 |
|---|---|---|
| V01 | 3 roots·부모 없는 노드·긴 제목 → 주 연결만 배치 후 보조 추가/종류 변경 → 좌표·선택·viewport 유지, 보조 관계는 남음 | D02/D06, #51 |
| V02 | 같은 두 endpoint의 서로 다른 관계 ID·종류 → 렌더/추가 → 정책상 허용한 관계가 helper dedup으로 없어지지 않음 | D03, #51 비교·#56 계약 |
| V03 | 주 부모 A→B 변경 → 한 편집 요청 → 성공 시 최대 한 부모, 실패 시 원래 부모 유지. 자기/후손을 부모로 지정하면 거부 | D04/D08, #56 API |
| V04 | 노드 폐기 → 상태 명령 → 원본 노드·기존 관계·작업/산출물 참조 보존, 화면은 선택한 표시 정책 적용 | D05, #51 감각·#56 API |
| V05 | 다른 조직 node ID·미존재·템플릿 밖 종류·작업 두 번째 연결 → 쓰기/조회 → 조직 규칙에 맞게 거부하고 부분 변경 없음 | D08, #56 API |
| V06 | keyboard/touch로 노드 선택·주 부모/보조 종류 변경·폐기 취소 → 포커스/오류 사유·대상 제목 확인 → drag/우클릭 없이도 수행 | D04/D07, #51 |
| V07 | 50/200/500 nodes·보조 0/20/100% → pan/zoom·지정 결과 찾기·관련 근거 열기 → CPU/프레임/선택 지연과 과업 성공을 별도 기록 | D07, #51 |
| V08 | 조직 전환 또는 연속 편집 중 늦은 layout 결과/쓰기 실패 도착 → 최신 입력과 비교 → 다른 조직·이전 상태에 좌표/저장 성공 표시 덮어쓰지 않음 | D06/D08, #51 mock·#56 통합 |
| V09 | 사용자 편집 성공/거부, 초기 승인 전 도구 호출, 승인·최종 완료 → 서버 경로 → 편집자·Event·Lead 깨우기는 성공과 일치하고 기존 승인/조직 경계 유지 | D08, #49/#56 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 최종 렌더러·배치 엔진 | 사용자 / #51 | React Flow+Dagre 기준선 / React Flow+ELK / Cytoscape 비교. E01–E24로 장단점은 있으나 완성된 연구 지도 UX 비교는 미실행 |
| 배치 방향·편집 제스처·재정렬 trigger | 사용자 / #51 | 좌→우 또는 위→아래; 명시 폼 또는 handle drag 병행; 수동 재정렬 또는 구조 변경 후 자동. E08/E10/P04, 실제 프로토타입을 보고 선택 |
| 보조 연결 밀도·폐기 노드 표시 | 사용자 / #51 | 전체 연하게+선택 강조 / 선택 주변 강조·토글 병행; 폐기 유지 표시 / 기본 필터·개수 표시. 관계 기록은 어떤 선택에서도 보존 |
| 같은 endpoint의 관계 중복·보조 self-link·허용 연결 종류 | #56 (정책 판단 필요 시 사용자) | 템플릿의 종류 선언과 중복/정체성 규칙을 별도로 정한다. 이번 조사로 새 금지 정책을 확정하지 않음 |
| 지연·읽기 평가의 통과 기준 | 사용자 / #51 | 측정 환경·목표 지연·과업 성공 기준은 실제 fixture 비교 전에 기록. 이번 배치 수치를 제품 상한으로 채택하지 않음 |

## 한계와 미확인

- 제품 프로토타입·서버 API·upstream 전체 테스트는 실행하지 않았다. #51 AC의 최종 선택·브랜치 primary source·편집 결정은 미완료이며 이슈를 닫지 않는다. 승인·조직 분리·영속 저장·깨우기는 #49/#56에서 검증할 항목이다.
- 실제 연구 카드와 상세 패널을 갖춘 500노드 브라우저 성능, 긴 제목 재측정, 화면 읽기 도구·실제 터치·Worker offload·worker 취소·async 역전, loading/실패/권한 없음 전이는 미확인이다. 공식 예시에서 이런 제품 상태를 재현할 경로를 찾지 못했다. 빈 화면·로딩·오류 캡처를 배치 근거로 쓰지 않았다.
- 공개 서비스의 배포 commit은 미확인이다. Cytoscape demo의 오래된 Dagre plugin 조합은 현재 Dagre 3.1.1 통합 검증이 아니다. G6·REAFLOW·Rete·mind-map 도구는 문서 후보이며 UI를 직접 조작하지 않았다. 일부 demo 접근 실패·timeout·404는 후보 부재 근거로 쓰지 않았다. 로그인·Pro 유료 소스·실제 모델 API에 접근하지 않았다.
- 첫 browser 설치는 env-i 안의 systemd bus 연결이 실패해 scope manager 밖에서 key 없는 npm을 실행하는 방식으로 재시도했다. Label selector 첫 시도는 type 속성 생략으로 timeout, 수정 후 7개 상태 캡처 성공. Cytoscape docs의 offscreen graph와 선택 비활성 demo의 클릭은 선택 근거에서 제외하고 실제 drag로 재확인했다.
- Cytoscape HEAD source/dist 버전 불일치는 stable registry 3.34.3과 gitHead로 맞춰 재실행했다(결정용 소스 10파일 bytes 일치). 초기 error-message matcher 실패는 입력 수용으로 해석하지 않았다. ELK bundled pseudo-worker 종료 호출의 첫 예외는 cleanup 코드 정정 후 재실행했다. 실패 전 로그도 보존했다.
- 라이선스·API·배포 상태는 확인일/고정 SHA 기준이다. 실제 채택 시 dependency와 NOTICE를 다시 확인한다. 모든 원본은 공개 OSS·공식 문서이며 실제 계정·모델 호출·연구 데이터는 쓰지 않았다.
