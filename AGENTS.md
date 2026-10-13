# BaboJUBot

연구 목표마다 독립 AI 연구 조직(Research Lead + 작업자 팀)을 운영하는 범용 연구 운영 프로젝트입니다. 현재는 요구사항·용어·조사 문서와 전체 구조 설계만 있고, 제품 기능 코드는 아직 없습니다. 도메인 용어는 [`GLOSSARY.md`](GLOSSARY.md)를 따릅니다.

## 제품 불변 조건

- 상위 연구 목표 하나가 독립 조직 하나입니다. 조직 ID를 작업·실행·기억·보고와 연결하고 조직 간 공유는 사용자 지정 내용으로 제한합니다.
- 초기 연구 계획·팀·연구 환경 명세의 사용자 승인 후 연구를 실행하고, 최종 완료는 사용자가 결정합니다. 그 밖의 행동은 사용자가 조직별 승인 정책(기본 꺼짐)으로 승인 대상을 정합니다. 승인·승인 정책·조직 경계는 제품 코드가 강제하며, 역할 문서나 agent 프롬프트는 그 강제 수단이 아닙니다.
- 대시보드에서 관찰 가능한 상태·활동·결과를 제공합니다. 비공개 모델 내부 추론을 공개 로그로 가정하지 않습니다.
- 기본 연구 흐름은 문제 → 가설/아이디어 → 검증 방법 → 실험/검증 → 결과입니다. 연구 템플릿으로 다른 절차를 표현합니다.
- 기억 기법과 저장 엔진은 관련 이슈에서 조사·결정합니다. 초기 구조 작업에서 특정 메모리 제품을 채택하지 않습니다.
- 실제 모델 호출을 작업 범위에 포함할 때 계정·자격 증명·비용 권한을 먼저 확인합니다. 자격 증명과 실제 연구 데이터는 Git에 포함하지 않습니다.
- 이슈의 핵심 상태·승인·조직 분리 시나리오를 검증하고, 완료 보고에서 실행한 검사와 미실행 범위를 구분합니다.

## Routing

작업을 시작하기 전에 아래 항목 중 현재 작업에 해당하는 문서만 모두 읽습니다.

- 기능 구현·변경 → 해당 GitHub 이슈의 조사·결정·완료 조건과 [`docs/features.md`](docs/features.md)의 확정 범위
- module 경계·seam·불변 조건 강제 위치 → [`docs/architecture.md`](docs/architecture.md)와 [`docs/adr/`](docs/adr/)
- 도메인 용어, 용어 충돌, 설계 결정 기록 → [`docs/agents/domain.md`](docs/agents/domain.md)
- 이슈 조회·작성·댓글·label·triage → [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)와 [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)
- 사용자 요구의 배경·의도 → [`docs/project-intent.md`](docs/project-intent.md)
- 설치·검증 명령 → [`README.md`](README.md)의 개발 시작
- 커밋 메시지 작성 → [`docs/agents/commit-messages.md`](docs/agents/commit-messages.md)
- 구현 직전 선행 사례·레퍼런스 조사 → [`reference-first`](.agents/skills/reference-first/SKILL.md) skill (`/reference-first #<n>`)
