# PROTOTYPE — #50 대시보드 배치 (버려도 되는 코드)

질문: 판 1 대시보드의 공통 셸·조직 탭·Inbox·홈을 **어떤 배치**로 만들까?
세 배치를 같은 mock 자료로 한 route 위에서 `?variant=A|B|C`로 바꿔 본다.

```bash
pnpm install --ignore-scripts
pnpm prototype:layout   # http://127.0.0.1:5180
```

- 하단 막대 ◀ ▶ 또는 키보드 ←/→: 배치 전환. 자료 시나리오: `?data=normal|many|one|empty|loading|error`. 결정 실패 흉내: `?fail=1`.
- 2차(C만): 섹션 묶음과 이후 판 메뉴(`?later=0`이면 숨김), 에이전트 상세(`/orgs/:id/agents/:agentId[/instructions]`), 작업 상세(`/orgs/:id/tasks/:taskId`), 산출물 보기(`/orgs/:id/artifacts/:artifactId`), 조직 생성 dialog(레일 ＋·홈).
- 자료는 메모리에만 있다(새로고침하면 초기화). 서버·DB·모델 호출 없음.
- 버튼의 결정·제어는 stub이다. 승인·조직 경계·최종 완료의 강제는 제품 코드(#53–#60)가 맡는다. 여기 disabled 버튼은 그 검증이 아니다.
- 이 폴더는 `prototype/dashboard-layout` 브랜치에만 둔다. main에는 고른 배치의 결정만 옮긴다.

## #51 연구 지도 (같은 앱, `prototype/research-map` 브랜치)

질문: 연구 지도를 **어떤 렌더러·배치 엔진·편집 방식**으로 만들까? 고른 #50 셸 C의 `조직 › 연구 지도` 위에서 세 안을 `?map=A|B|C`로 바꿔 본다.

```bash
pnpm install --ignore-scripts
pnpm prototype:map   # http://127.0.0.1:5180/orgs/llm-eval/map
```

| 키 | 조합 | 주 조작 |
|---|---|---|
| A | React Flow + Dagre (동기) | 좌→우 트리. 노드 선택 → 오른쪽 상세 패널, 모든 편집은 명시 폼. 기본 자동 재배치 |
| B | React Flow + ELK layered (브라우저 Worker, 비동기) | 위→아래. 왼쪽 개요 트리, 선택 노드 도구 막대, 핸들 드래그 → "주 연결/보조(종류)" 선택, 빈 곳에 놓으면 하위 노드. 기본 수동 재배치, 노드 끌어 옮기기 |
| C | Cytoscape(Canvas) + d3-flextree (가상 root forest) | 찾기 중심, 하단 서랍, "지도에서 고르기"(p/l) 모드, 키보드 트리 이동(↑↓←→), 우클릭 메뉴. 항상 자동 재배치(애니메이션) |

- 지도 화면에서 하단 막대 ◀ ▶(←/→)는 `?map=`을 바꾼다. `노드` `seed|50|200|500`(`?n=`), `보조%` `0|20|100`(`?sec=`). 막대 초록 줄에 엔진·노드/주/보조 수·배치 ms·횟수·늦은 결과 폐기 수·선택 노드가 보인다.
- seed: 2 roots + 주 부모 없는 노드, 긴 한국어 제목, `폐기` 노드, 보조 순환(H4⇄M3), 같은 endpoint의 다른 관계(R1→H2 지지/참고). 50/200/500은 seed 고정 생성(3 roots, 약 3% 주 부모 없음, 약 7% 폐기).
- 편집은 메모리 store에 쌓이고 변형을 바꿔도 유지된다(새로고침하면 초기화). `?fail=1`이면 편집 거부·원상태 유지. "편집자 기록·Lead 깨우기"는 toast stub이다.
- 배치 입력은 **주 연결만**이다. 보조 연결·제목·상태 변경은 재배치를 일으키지 않는다. 관계 ID를 edge ID로 보존하고 React Flow `parentId`·라이브러리 delete를 쓰지 않는다. 폐기는 상태 변경이다.
- 순환·self-link 거부는 화면 피드백일 뿐이다. 제품 규칙 강제는 #56 서버 경계가 맡는다.
