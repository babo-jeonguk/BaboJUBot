# 연구 지도

통합 검증: [연구 지도 API](../../../apps/server/test/research-map.test.ts), [연구 지도 E2E](../../../apps/web/e2e/research-map.spec.ts).

| 작업·증상 | 진입점 | 테스트 |
| --- | --- | --- |
| 노드·보조 연결·편집 기록, 깨우기 사유·Event `research_map.edited` | [contracts/research-map.ts](../../../packages/contracts/src/research-map.ts), tools.ts, run.ts `research_map_edit`, event.ts | 연구 지도 API |
| 주 부모·순환·폐기·작업 연결 규칙, 사용자 편집의 Lead 깨우기 | [core/research-map.ts](../../../packages/core/src/research-map.ts) `plan*` | [core](../../../packages/core/src/research-map.test.ts) |
| 지도 저장·동시 편집 | [db/research-map.ts](../../../packages/db/src/research-map.ts) `writeResearchMap`·`editResearchMap`·`loadMap` | 연구 지도 API |
| 도구 HTTP·사용자 편집 API·거부 코드표 | server/tools.ts, app.ts `/research-*`, [server/problems.ts](../../../apps/server/src/problems.ts) | 연구 지도 API |
| 지도 화면·상세 패널·편집 폼·폐기 | [web/research-map.tsx](../../../apps/web/src/research-map.tsx) `DiscardControl`, api.ts `useResearchMap`·`useEditResearchMap`; 작업 상세의 연결 노드는 tasks.tsx | 연구 지도 E2E |
| 큰 지도의 끌기·선택 비용 | research-map.tsx `EdgeLayer`·`focusCss`·`reuse`, [research-map.css](../../../apps/web/src/research-map.css) | [성능 측정](../../../apps/web/e2e/research-map-perf.spec.ts) `MAP_PERF=1` |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
scripted(작업자) → /api/tools/research-nodes·research-links·tasks/:id/research-node(server/tools)
  → writeResearchMap(toolWrite) → core plan* → 변경·편집 기록·Event
지도 패널 폼 → /api/organizations/:id/research-*(app) → editResearchMap(core plan*) → Lead 깨우기·Event
  → EventHub → kick(Lead) → 재조회
```

거부 코드는 core/research-map.ts, 순환·동시 편집은 db/research-map.ts의 잠금 뒤 `loadMap`에서 시작합니다.
