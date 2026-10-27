# 문서 지도와 작성 기준

질문마다 기준 문서를 하나만 둡니다. 다른 문서는 필요한 요약·링크로 연결합니다.

## 제품 기준

| 질문 | 기준 문서·책임 |
| --- | --- |
| 지금 무엇이 실행되며 어떻게 설치·검증하는가? | [README](../README.md): 현재 구현 요약·환경·명령·검증 기준 |
| 무엇을 제공하고 제외하는가? | [features](features.md): 확정 기능·화면 범위. 완료 근거는 이슈/PR |
| 개념은 무엇을 뜻하는가? | [GLOSSARY](../GLOSSARY.md): 공통 용어 정의 |
| 책임·계약·상태·불변 조건은 어디서 강제하는가? | [architecture](architecture.md): 목표 구조·module·seam. 실제 파일은 코드 지도 |
| 왜 이 기술·구조를 선택했는가? | [ADR](adr/): 확정 결정의 맥락·대안·이유·결과 |
| 이 작업의 요구·결정·완료 조건·결과는 무엇인가? | [Issues](https://github.com/babo-jeonguk/BaboJUBot/issues): 작업별 계약·상태. [PRs](https://github.com/babo-jeonguk/BaboJUBot/pulls): 구현·검증 근거 |

## 개발 운영

| 질문 | 기준 문서·책임 |
| --- | --- |
| 어떤 규칙·문서를 읽는가? | [AGENTS](../AGENTS.md): 공통 규칙·제품 불변 조건 요약·Routing. [CLAUDE](../CLAUDE.md)는 참조만 유지 |
| 어디에 어떻게 기록하는가? | 이 문서: 문서 책임·작성·갱신 기준 |
| 용어 충돌·컨텍스트·ADR을 어떻게 다루는가? | [domain](agents/domain.md): 의미 확정·작성 조건 |
| 수정할 코드·테스트는 어디인가? | [code-map](agents/code-map.md): 작업별 진입점·연결 경로·현재 검증 위치 |
| 구현은 언제 시작·완료하는가? | [implementation](agents/implementation.md): 브랜치→구현→리뷰→커밋→push→PR·외부 리뷰 인계 |
| 리뷰 결과를 어떻게 처리하는가? | [review-fixes](agents/review-fixes.md): finding 판정→실패 유형 검증·수정→재검토·외부 요청 형식 |
| 병합은 언제·어떻게 완료하는가? | [pr-merge](agents/pr-merge.md): 병합 판단→기록 정합성·최종 검증 확인→병합→후처리·보고 |
| 이슈·의존성·parent를 어떻게 조작하는가? | [issue-tracker](agents/issue-tracker.md): gh·게시 규칙·skill 작업 매핑 |
| triage 역할은 어떤 label인가? | [triage-labels](agents/triage-labels.md): 역할·label 대응 |
| 커밋 메시지는 어떻게 쓰는가? | [commit-messages](agents/commit-messages.md): 형식·언어 |

## 배경과 조사 기록

작성 당시 요구·관찰·권고를 날짜·버전·미확인 범위와 함께 보존합니다. 현재 요구·채택 결정은 위 기준 문서와 이슈에서 확인합니다.

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
| [issue-1](research/issue-1-references.md)·[issue-50](research/issue-50-references.md)·[issue-51](research/issue-51-references.md)·[issue-52](research/issue-52-references.md)·[issue-53](research/issue-53-references.md)·[issue-54](research/issue-54-references.md)·[issue-55](research/issue-55-references.md)·[issue-56](research/issue-56-references.md)·[issue-57](research/issue-57-references.md)·[issue-58](research/issue-58-references.md)·[issue-59](research/issue-59-references.md)·[issue-60](research/issue-60-references.md)·[issue-61](research/issue-61-references.md)·[issue-62](research/issue-62-references.md)·[issue-63](research/issue-63-references.md)·[issue-64](research/issue-64-references.md)·[issue-77](research/issue-77-references.md)·[inbox-detail](research/inbox-detail-references.md) | 각 이슈·주제의 구현 전 조사에서 어떤 근거와 권고를 얻었는가? |

[harness/README.md](../harness/README.md)는 연구 하네스 디렉터리의 안내입니다.
각 Role·Soul·Skill·템플릿이 해당 연구 절차를 소유하고, 개발 에이전트의 운영 규칙과 구분합니다.

## 작성·갱신 기준

1. **책임:** 한 문서는 한 주된 질문, 한 절은 같은 기준의 하위 질문·단계·비교 축을 맡습니다. 중복 책임은 합치거나 경계를 나눕니다.
2. **원본:** 사실·규칙은 위 기준 위치에만 정의합니다. 파일·명령·설정의 원본은 코드·manifest·config이며 문서에는 탐색에 필요한 정보만 둡니다. 기능 범위·강제 구조·수정 위치는 각각 features·architecture·code-map이 맡습니다.
3. **구성:** 절차는 순서·완료 조건, 참고 정보는 필요한 단계에 둡니다. 목차는 링크로 연결합니다. 새 문서는 기존 내용을 이동하거나 새 질문의 책임을 명시한 뒤 이 지도에 추가하고, 작업 시 필수인 문서는 AGENTS Routing에 연결합니다. 빈 문서는 미리 만들지 않습니다.
4. **갱신:** 기준 변경과 영향받는 링크·요약은 같은 변경에 반영합니다. 인터뷰·조사 원문은 보존하고 달라진 전제에는 현행 기준 링크를 붙입니다.
5. **검토:** 책임 중복·누락, 현재/과거 구분, 링크를 확인합니다. 확정 문서의 의미 충돌은 [도메인 규칙](agents/domain.md#모호성과-충돌-보고)에 따라 근거와 함께 보고합니다.
