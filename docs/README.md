# 문서 지도와 작성 기준

문서는 아래 질문별로 기준 위치를 하나씩 둡니다. 다른 문서에서 같은 내용을 소개할 때는 요약과 링크로 연결합니다.
문서 목록은 이 파일, 코드·테스트의 탐색은 [코드 지도](agents/code-map.md)가 담당합니다.

## 현재 기준 문서

| 질문 | 기준 위치 | 담당 내용과 경계 |
| --- | --- | --- |
| 무엇을 실행할 수 있고 어떻게 설치·실행하는가? | [루트 README](../README.md) | 현재 구현 현황 요약, 환경·설정·실행·검사 명령. 기능별 완료 근거는 이슈와 PR |
| 제품이 제공할 기능과 제외할 범위는 무엇인가? | [features.md](features.md) | 확정 기능 범위와 화면별 제공 범위. 구현 완료 여부와 기술 선택은 별도 기준 참조 |
| 도메인 개념은 무엇을 뜻하는가? | [GLOSSARY.md](../GLOSSARY.md) | 공통 용어의 정의와 구분. 저장·실행 방식은 architecture와 ADR |
| module과 seam은 어떤 책임·계약을 갖는가? | [architecture.md](architecture.md) | 목표 구조, 패키지 책임, 상호작용·상태 전이, 불변 조건 강제 위치. 실제 파일·테스트 탐색은 코드 지도 |
| 왜 그 기술·구조를 선택했는가? | [ADR](adr/) | 확정한 결정의 맥락·대안·이유·결과. 현재 구조 전체는 architecture |
| 개별 작업의 요구·결정·완료 조건과 결과는 무엇인가? | [GitHub Issues](https://github.com/babo-jeonguk/BaboJUBot/issues)와 [PRs](https://github.com/babo-jeonguk/BaboJUBot/pulls) | 이슈별 계약·결정·상태, PR별 구현·검증 근거. 공통 규칙을 작업마다 재정의하지 않음 |

## 개발 에이전트 운영 문서

| 질문 | 기준 위치 | 담당 내용과 경계 |
| --- | --- | --- |
| 작업할 때 어떤 규칙과 문서를 읽는가? | [AGENTS.md](../AGENTS.md) | 공통 작업 규칙, 제품 불변 조건 요약, 조건별 Routing. [CLAUDE.md](../CLAUDE.md)는 이 파일 참조만 유지 |
| 어떤 문서에 기록하고 어떻게 분리하는가? | 이 문서 | 문서별 책임·작성·갱신 기준. 용어와 ADR의 상세 작성 규칙은 domain |
| 용어 충돌을 어떻게 해결하고 ADR은 언제 쓰는가? | [domain.md](agents/domain.md) | 도메인 언어 적용, 충돌 처리, 컨텍스트와 ADR 작성 조건 |
| 이 작업의 코드·테스트는 어디서 찾는가? | [code-map.md](agents/code-map.md) | 작업·증상별 진입점, 연결 경로, 현재 테스트 위치. 검증 실행 절차는 병합 문서와 README |
| 구현은 어디서 시작해 언제 완료하는가? | [implementation.md](agents/implementation.md) | 작업 브랜치·구현·로컬 리뷰·검증·커밋·push·PR 생성과 외부 리뷰 인계 |
| 리뷰 지적을 어떻게 검증·수정하고 재검토하는가? | [review-fixes.md](agents/review-fixes.md) | finding별 판정·실패 유형 검증·수정·재검토 수렴, 외부 리뷰 요청 자료 형식 |
| PR 병합은 어떤 순서와 조건으로 완료하는가? | [pr-merge.md](agents/pr-merge.md) | 병합 판단·기록 동기화·검증 선택·병합·후처리·보고. 이슈 API와 label 정의는 아래 문서 |
| GitHub 이슈를 어떻게 조회·수정·연결하는가? | [issue-tracker.md](agents/issue-tracker.md) | `gh` 사용, 게시 규칙, 의존성·parent 연결과 skill의 tracker 작업 매핑 |
| triage 역할에 어떤 label을 쓰는가? | [triage-labels.md](agents/triage-labels.md) | 역할과 실제 label의 대응. API 사용법은 issue-tracker |
| commit 메시지는 어떻게 쓰는가? | [commit-messages.md](agents/commit-messages.md) | 메시지 형식·언어·예시. 병합 순서는 pr-merge |

## 배경과 조사 기록

다음은 작성 당시의 요구·관찰·권고를 보존합니다. 기록의 날짜·기준 버전·미확인 범위를 함께 읽고,
현재 제품 요구나 채택 결정은 위 기준 문서와 해당 이슈에서 확인합니다.

| 기록 | 답하는 질문 |
| --- | --- |
| [project-intent.md](project-intent.md) | 사용자가 어떤 배경에서 요구했고 인터뷰를 거치며 무엇을 바꿨는가? |
| [comparative-survey.md](research/comparative-survey.md) | 어떤 서비스·프로젝트를 후속 조사 후보로 찾았는가? |
| [paperclip.md](research/paperclip.md) | Paperclip 1차 조사에서 어떤 구조와 실행 계약을 확인했는가? |
| [reference-code-structure.md](research/reference-code-structure.md) | 여섯 프로젝트가 코드를 어떤 책임으로 나눴는가? |
| [agent-runtime-models.md](research/agent-runtime-models.md) | 실행 시도 하나와 지침·도구 주입을 어떻게 구성하는가? |
| [agent-interaction-models.md](research/agent-interaction-models.md) | 에이전트 간 협력과 사용자 개입을 어떻게 전달하는가? |
| [paperclip-dashboard.md](research/paperclip-dashboard.md) | Paperclip의 운영자 화면·기능에는 무엇이 있는가? |
| [dashboard-references.md](research/dashboard-references.md) | 다른 제품의 운영자 UI에서 무엇을 추가로 참고할 수 있는가? |
| [issue-1](research/issue-1-references.md)·[issue-50](research/issue-50-references.md)·[issue-51](research/issue-51-references.md)·[issue-52](research/issue-52-references.md)·[issue-53](research/issue-53-references.md)·[issue-54](research/issue-54-references.md) | 각 이슈의 구현 전 조사에서 어떤 근거와 권고를 얻었는가? |

[harness/README.md](../harness/README.md)는 연구 하네스 디렉터리의 안내입니다.
각 Role·Soul·Skill·템플릿이 해당 연구 절차를 소유하고, 개발 에이전트의 운영 규칙과 구분합니다.

## 작성·갱신 기준

1. 문서 하나는 하나의 주된 질문을 맡고, 절마다 하위 질문·단계·비교 축 중 하나의 기준으로 나눕니다.
   절의 담당 범위와 완료 조건이 서로 겹치면 합치거나 경계를 다시 나눕니다.
2. 새 사실·규칙은 위 표의 기준 위치에 기록합니다. 다른 위치에는 필요한 요약과 링크만 둡니다.
   파일 경로·명령·설정은 코드·manifest·config를 원본으로 삼고, 탐색 비용을 줄이는 정보만 문서에 둡니다.
3. 서로 다른 관점의 문서가 같은 개념을 참조하는 것은 허용합니다. 기능 문서는 사용자에게 제공할 것,
   구조 문서는 이를 강제할 경계, 코드 지도는 수정 위치를 설명하며 같은 규칙을 각각 재정의하지 않습니다.
4. 목차·표에서 상세 절을 안내할 때는 링크를 쓰고 본문을 반복하지 않습니다. 절차는 실행 순서와 완료 조건,
   참고 정보는 해당 단계에서 필요한 위치에 둡니다.
5. 현재 기준을 바꾸면 그 내용을 소유한 문서와 영향을 받는 링크·요약을 같은 변경에서 갱신합니다.
   인터뷰·조사의 과거 본문은 보존하고, 현재와 다른 전제를 가진 기록에는 후속 기준으로 가는 안내를 붙입니다.
6. 새 문서가 기존 질문을 나눠 맡으면 먼저 내용을 이동하고 링크를 바꿉니다. 새 질문이면 이 지도에 위치와 경계를 추가하고,
   작업 시 읽어야 하는 문서는 AGENTS.md Routing에도 연결합니다. 빈 영역을 채우기 위한 문서를 미리 만들지 않습니다.
7. 문서 변경은 역할 중복·누락, 현재 사실과 과거 기록의 구분, 링크를 확인합니다. 확정 문서 사이에 의미 충돌이 있으면
   [domain.md의 충돌 처리](agents/domain.md#모호성과-충돌-보고)에 따라 근거를 드러내고 해결합니다.
