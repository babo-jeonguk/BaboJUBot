# 코드 지도

작업에 해당하는 절 파일 하나를 열어 진입점·테스트부터 읽고 검색으로 호출·계약을 따라갑니다. 표에 없으면 가까운 진입점에서 검색합니다.
현재 구현은 [현재 구현 현황](../current-implementation.md), 요구는 [features](../features.md)·이슈, 목표 책임은 [architecture](../architecture.md), 용어·결정은 [domain](domain.md)을 따릅니다. 검사 실행 명령은 [CONTRIBUTING](../../CONTRIBUTING.md#개발-시작)이 맡습니다.

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
| 프로바이더 연결·에이전트별 프로바이더·모델·전역 기본값·동시 실행 상한 | [providers](code-map/providers.md) |
| 일시정지·재개·중단과 실행 중단·중단하고 보내기·줄 세운 메시지 | [control](code-map/control.md) |
| Heartbeat·기억·서버 재시작 복구 | [heartbeat-and-recovery](code-map/heartbeat-and-recovery.md) |
| 알림 outbox·가짜 채널·Inbox | [notifications](code-map/notifications.md) |
| 대시보드 지표·홈 개요 | [dashboard](code-map/dashboard.md) |
| 에이전트 조직도·이름·얼굴 | [agent-chart](code-map/agent-chart.md) |
| 개발 환경: 서버 시작·임시 Postgres·scripts·CI·hook·코드 worker | [dev-environment](code-map/dev-environment.md) |
| 계약·schema·저장·Event·응답을 함께 바꿈: 사용자 HTTP 경로와 commit 뒤 처리의 공통 순서 | [shared-path](code-map/shared-path.md) |

## 지도 갱신

지도는 **위치**만 담습니다: 행마다 작업·증상, 파일·함수 이름, 테스트 파일·`describe` 이름입니다. 동작·규칙·예외·미검증 범위는 [현재 구현 현황](../current-implementation.md)과 테스트 이름이 맡습니다.
- 파일·함수·테스트가 생기거나 옮겨지거나 사라지면 같은 PR에서 해당 행·연결 경로를 갱신합니다. 기존 위치의 동작만 바뀐 PR은 지도를 그대로 둡니다.
- `pnpm check:docs`가 코드 블록 밖의 줄마다 파일 표기·코드 표기 이름·`테스트` 열의 시험 이름이 그 줄이 가리키는 파일에 있는지, 패키지 지정자(`@babojubot/<패키지>/<입구>`)가 그 패키지의 exports에 있는지, pnpm 명령의 스크립트가 대상 패키지의 scripts에 있는지 확인합니다([규칙](../../scripts/check-code-map.mjs)). 이름은 그 파일이 정의해야 합니다(선언·멤버·문자열 리터럴·시험 제목, 주석과 가져오기·부르기는 제외). 쓰는 곳만 적은 줄에는 정의한 파일을 함께 적습니다. 파일을 가리키지 않는 줄의 이름은 소스 코드에서만 찾으므로 설정·데이터 파일(JSON·YAML)의 이름은 그 파일과 같은 줄에 적습니다. 파일·폴더·패키지·pnpm 명령·이름·시험 이름 어디에도 맞지 않고 제외 규칙(문구, HTTP 경로, 무늬, 점·대시로 시작, 기호만)에도 맞지 않는 코드 표기는 실패하므로, 바깥 이름이나 실행 중에 생기는 이름은 일반 글로 적습니다. 파일 표기는 `core/run.ts`처럼 파일 하나로 풀리게 적고, 이름은 그 이름이 있는 파일과 같은 줄에 적습니다. 다른 시험 파일의 시험 이름은 그 파일을 링크해 적습니다. 연결 경로(코드 블록)는 검사하지 않으므로 이름을 바꿀 때 직접 고칩니다.
- 한 행에 작업이 여럿 쌓이면 작업별 행으로 나눕니다.
- 새 영역은 절 파일을 만들어 이 목차에 한 줄로 연결하며, 미구현 영역의 빈 문서는 만들지 않습니다.
