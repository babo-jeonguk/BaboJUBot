# 코드 지도

작업에 해당하는 절 파일 하나를 열어 진입점·테스트부터 읽고 `rg`로 호출·계약을 따라갑니다. 표에 없으면 가까운 진입점에서 검색합니다.
현재 구현은 [README](../../README.md), 요구는 [features](../features.md)·이슈, 목표 책임은 [architecture](../architecture.md), 용어·결정은 [domain](domain.md)을 따릅니다. 검사 실행 기준은 README가 맡습니다.

## 목차

절 파일마다 작업·증상별 진입점 표가 있고, 사용자 행동이 여러 경계를 지나는 영역은 끝에 연결 경로가 있습니다.

| 작업 영역 | 절 파일 |
| --- | --- |
| 조직 생성·Event·공통 화면 | [organizations](code-map/organizations.md) |
| 실행 시도·조직 도구·대화 | [runs-and-conversations](code-map/runs-and-conversations.md) |
| 초기 연구 승인·하네스 | [initial-approval](code-map/initial-approval.md) |
| Role·Soul·Skill 사본 편집 | [instruction-copies](code-map/instruction-copies.md) |
| 작업·작업자 실행 시도·산출물 | [tasks](code-map/tasks.md) |
| 연구 지도 | [research-map](code-map/research-map.md) |
| 결과 제출·최종 완료 | [results](code-map/results.md) |
| 승인 정책·작업자 추가 | [approval-policy](code-map/approval-policy.md) |
| 일시정지·재개·중단과 실행 중단·중단하고 보내기·줄 세운 메시지 | [control](code-map/control.md) |
| Heartbeat·기억·서버 재시작 복구 | [heartbeat-and-recovery](code-map/heartbeat-and-recovery.md) |
| 알림 outbox·가짜 채널·Inbox | [notifications](code-map/notifications.md) |
| 대시보드 지표·홈 개요 | [dashboard](code-map/dashboard.md) |
| 에이전트 조직도·이름·얼굴 | [agent-chart](code-map/agent-chart.md) |
| 개발 환경: 서버 시작·임시 Postgres·scripts·CI·hook | [dev-environment](code-map/dev-environment.md) |
| 계약·schema·저장·Event·응답을 함께 바꿈: 사용자 HTTP 경로와 commit 뒤 처리의 공통 순서 | [shared-path](code-map/shared-path.md) |

## 지도 갱신

진입점·책임·테스트 또는 구현 범위가 바뀌면 같은 PR에서 해당 절 파일의 행·연결 경로를 갱신합니다. 실제 테스트 범위와 미검증을 구분합니다.
새 영역은 절 파일을 만들어 이 목차에 한 줄로 연결하며, 미구현 영역의 빈 문서는 만들지 않습니다.
