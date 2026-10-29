# 연구 지도

통합 검증: [연구 지도 API](../../../apps/server/test/research-map.test.ts), [연구 지도 E2E](../../../apps/web/e2e/research-map.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 노드·보조 연결·편집 기록 모양, 입력, 사용자 편집 단계, 도구 이름·경로·오류 코드, 깨우기 사유·Event | [contracts/research-map.ts](../../../packages/contracts/src/research-map.ts), tools.ts, run.ts `research_map_edit`·`researchFlow`, event.ts `research_map.edited` | 연구 지도 API |
| 종류 선언·주 부모 지정/변경·순환·자기 연결·폐기/폐기 취소·작업 연결 0~1·같은 값 무변경·사용자 편집의 Lead 깨우기 | [core/research-map.ts](../../../packages/core/src/research-map.ts) `plan*`; 도구 단계 규칙은 contracts tools.ts `orgTools` | [core](../../../packages/core/src/research-map.test.ts) |
| 조직 잠금 아래 최신 지도 읽기·변경·편집 기록·깨우기·Event 한 transaction, 교차 조직 404 | [db/research-map.ts](../../../packages/db/src/research-map.ts) `writeResearchMap`(도구)·`editResearchMap`(사용자); 복합 FK·노드당 주 부모 열은 schema·migrations | 연구 지도 API의 교차 조직·동시 주 부모 변경 |
| 도구 HTTP·사용자 편집 API·거부 코드표·commit 뒤 Lead 촉진 | server/tools.ts 연구 지도 도구, app.ts `/research-*`, [server/problems.ts](../../../apps/server/src/problems.ts)(`problemResponses`를 `ownerRefusalResponses`가 가져다 씀) | 연구 지도 API |
| 지도 화면·배치·보조 연결 표시·상세 패널·편집 폼·드래그(보기 상태)·묻지 않는 폐기와 토스트의 폐기 취소 | [web/research-map.tsx](../../../apps/web/src/research-map.tsx) `DiscardControl`, api.ts `useResearchMap`·`useEditResearchMap`; 작업 상세의 연결 노드는 tasks.tsx | 연구 지도 E2E(390px·실패 시 입력 유지 포함) |
| 큰 지도의 화면 끌기·선택·노드 끌기 비용 | research-map.tsx `EdgeLayer`(연결 전체를 노드 아래 SVG로)·`focusCss`(강조 노드를 덮개 위로)·`reuse`(바뀐 노드·연결 객체만 새로); [web/research-map.css](../../../apps/web/src/research-map.css) 덮개·점선·합성 레이어. React Flow edge는 강조할 연결만 | [성능 측정](../../../apps/web/e2e/research-map-perf.spec.ts) `MAP_PERF=1`(프로덕션 빌드, 50/200/500노드·보조 0/20/100%·1280/390px). 연구 지도 E2E의 정적·강조 경로 일치 |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
scripted(작업자) → /api/tools/research-nodes·research-links·tasks/:id/research-node(server/tools)
  → writeResearchMap(toolWrite: 조직→실행 시도 잠금·취소·단계 재확인) → 최신 지도 읽기 → core plan*
  → 변경·편집 기록·Event 함께 저장(에이전트 편집은 아무도 깨우지 않음)
지도 패널 폼 → /api/organizations/:id/research-*(app)
  → editResearchMap(조직 잠금·편집 단계·최신 지도·core plan*) → 변경·편집 기록·Lead 깨우기·Event
  → EventHub → kick(Lead) → 지도·노드 상세 재조회
```

거부 코드는 core/research-map.ts, 순환·동시 편집은 db/research-map.ts의 잠금 뒤 `loadMap`에서 시작합니다.
