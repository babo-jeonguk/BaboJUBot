# 문서 지도와 작성 기준

질문마다 기준 문서를 하나만 둡니다. 다른 문서는 필요한 요약·링크로 연결합니다.

## 제품 기준

| 질문 | 기준 문서·책임 |
| --- | --- |
| 제품의 가치·핵심 기능·사용자 시작 방법은 무엇인가? | [README](../README.md): 제품 가치 제안·핵심 기능·실행법·프로바이더 연결 |
| 지금 무엇이 구현돼 동작하는가? | [현재 구현 현황](current-implementation.md): 구현된 동작·규칙·응답 코드 |
| 무엇을 제공하고 제외하는가? | [features](features.md): 확정 기능·화면 범위. 완료 근거는 이슈/PR |
| 개념은 무엇을 뜻하는가? | [GLOSSARY](../GLOSSARY.md): 공통 용어 정의 |
| 책임·계약·상태·불변 조건은 어디서 강제하는가? | [architecture](architecture.md): 목표 구조·module·seam. 실제 파일은 코드 지도 |
| 왜 이 기술·구조를 선택했는가? | [ADR](adr/): 확정 결정의 맥락·대안·이유·결과 |
| 이 작업의 요구·결정·완료 조건·결과는 무엇인가? | [Issues](https://github.com/babo-jeonguk/BaboJUBot/issues): 작업별 계약·상태. [PRs](https://github.com/babo-jeonguk/BaboJUBot/pulls): 구현·검증 근거 |

## 개발 운영

작업할 때 읽을 문서는 [AGENTS](../AGENTS.md)의 Routing이 정합니다([CLAUDE](../CLAUDE.md)는 참조만 유지). 개발 문서는 세 층으로 나누고 층마다 맡는 질문이 다릅니다.

| 층 | 맡는 질문 | 문서 |
| --- | --- | --- |
| 단계 | 무엇을, 어떤 순서로, 언제 끝났다고 보는가 | [issue-tracker](agents/issue-tracker.md)(+[triage-labels](agents/triage-labels.md)) → [implementation](agents/implementation.md) → [review-fixes](agents/review-fixes.md) → [pr-merge](agents/pr-merge.md) |
| 도구 | 어떻게 하는가 | [verification](agents/verification.md), [worker](agents/worker.md), [dev-orchestration](agents/dev-orchestration.md), [commit-messages](agents/commit-messages.md), [domain](agents/domain.md), [code-map](agents/code-map.md) |
| 양식 | 어떤 모양으로 쓰는가 | [PR 양식](../.github/PULL_REQUEST_TEMPLATE.md), [이슈 양식](../.github/ISSUE_TEMPLATE/), [외부 리뷰 요청](agents/review-fixes.md#외부-리뷰-요청-형식), [worker brief](agents/worker.md#3-brief) |

사람용 설치·명령·데모·DB·CI는 [CONTRIBUTING](../CONTRIBUTING.md)이 맡습니다.

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
| [issue-1](research/issue-1-references.md)·[issue-50](research/issue-50-references.md)·[issue-51](research/issue-51-references.md)·[issue-52](research/issue-52-references.md)·[issue-53](research/issue-53-references.md)·[issue-54](research/issue-54-references.md)·[issue-55](research/issue-55-references.md)·[issue-56](research/issue-56-references.md)·[issue-57](research/issue-57-references.md)·[issue-58](research/issue-58-references.md)·[issue-59](research/issue-59-references.md)·[issue-60](research/issue-60-references.md)·[issue-61](research/issue-61-references.md)·[issue-62](research/issue-62-references.md)·[issue-63](research/issue-63-references.md)·[issue-64](research/issue-64-references.md)·[issue-77](research/issue-77-references.md)·[issue-84](research/issue-84-references.md)·[issue-86](research/issue-86-references.md)·[issue-94](research/issue-94-references.md)·[issue-95](research/issue-95-references.md)·[issue-96](research/issue-96-references.md)·[issue-97](research/issue-97-references.md)·[issue-98–101](research/issue-98-101-references.md)·[issue-125](research/issue-125-references.md)·[inbox-detail](research/inbox-detail-references.md)·[home](research/home-references.md) | 각 이슈·주제의 구현 전 조사에서 어떤 근거와 권고를 얻었는가? |
| [executor-capabilities.md](research/executor-capabilities.md) | 네 프로바이더(Claude Code·Codex·OpenCode·Antigravity)는 실행·출력·도구·지침·세션·취소·사용량·권한에서 무엇을 지원하는가? |
| [executor-selection-references.md](research/executor-selection-references.md) | 여러 프로바이더를 쓰는 프로젝트는 에이전트별 프로바이더 선택·변경·준비 확인을 어떻게 다루는가? |
| [executor-isolation-references.md](research/executor-isolation-references.md) | 프로바이더 실행을 어떻게 격리하고 개인 설정·로그인을 분리하는가? |
| [issue-102-references.md](research/issue-102-references.md) | 선택형 Docker 실행에서 폴더·네트워크 경계, 안전 확인, 컨테이너 정리와 기존 프로바이더 연결을 어떻게 구성하는가? |
| [provider-connection-references.md](research/provider-connection-references.md) | 프로바이더를 어떤 방식으로 띄워 도구·세션·취소·사용량을 다루는가(Paseo 중심)? |
| [provider-prompt-caching.md](research/provider-prompt-caching.md) | 프로바이더별 프롬프트 캐시·압축은 세션 이어가기 비용에 어떻게 작용하는가? |
| [design-guidelines-pan2.md](research/design-guidelines-pan2.md) | 판 2 화면은 Apple HIG·One UI·Material 3·SEED·토스 가이드의 어떤 패턴을 따르고, 설명문 없이 상태를 어떻게 보이는가? |
| [artifact-path-confinement.md](research/artifact-path-confinement.md) | 에이전트가 준 파일 경로를 Linux·macOS·Windows에서 공유 폴더 안에 가두려면 어떤 표기를 먼저 거부하고 어떻게 푸는가? |
| [coding-standards-references.md](research/coding-standards-references.md) | mattpocock-skills의 code-review는 `CODING_STANDARDS.md`를 누가·언제 읽고 어떤 모양을 기대하는가? |

[harness/README.md](../harness/README.md)는 연구 하네스 디렉터리의 안내입니다.
각 Role·Soul·Skill·템플릿이 해당 연구 절차를 소유하고, 개발 에이전트의 운영 규칙과 구분합니다.

- [프로바이더 운영 안내](providers.md): 연결 설정, 제품 로그인, 정리, 압축, 수동 실제 시험.
- [#98–101 구현 근거](research/issue-98-101-implementation.md): 원문 재확인, 확정 결정, 검증 범위.
- [OpenCode 2.x 지침 주입 조사](research/opencode-2-instructions.md): 기본 지침 보존과 세션 지침 API 추가.
- [서버 종료 순서 조사](research/graceful-shutdown-references.md): 종료 신호를 누가 받고 DB를 언제 닫는지, embedded-postgres 종료 hook 처리.
- [내장 Postgres 수명 조사](research/embedded-postgres-lifecycle-references.md): 강제 종료 뒤 남은 DB 정리, pg_ctl로 켜고 끄기, Windows 정지와 관리자 계정.

## 작성·갱신 기준

1. **책임:** 한 문서는 한 주된 질문, 한 절은 같은 기준의 하위 질문·단계·비교 축을 맡습니다. 중복 책임은 합치거나 경계를 나눕니다.
2. **원본:** 사실·규칙은 위 기준 위치에만 정의합니다. 파일·명령·설정의 원본은 코드·manifest·config이며 문서에는 탐색에 필요한 정보만 둡니다. 기능 범위·강제 구조·수정 위치는 각각 features·architecture·code-map이 맡습니다.
3. **구성:** 문서 첫 줄에 다루는 범위와 다루지 않는 것의 위치를 적습니다. 단계 문서는 순서·완료 조건만 쓰고 도구 사용법은 도구 문서로 링크하며, 도구 문서는 단계 순서를 쓰지 않습니다. 양식 파일은 모양만 담습니다. 참고 정보는 필요한 단계에 둡니다. 목차는 링크로 연결합니다. 새 문서는 기존 내용을 이동하거나 새 질문의 책임을 명시한 뒤 이 지도에 추가하고, 작업 시 필수인 문서는 AGENTS Routing에 연결합니다. 빈 문서는 미리 만들지 않습니다.
4. **갱신:** 기준 변경과 영향받는 링크·요약은 같은 변경에 반영합니다. 인터뷰·조사 원문은 보존하고 달라진 전제에는 현행 기준 링크를 붙입니다.
5. **검토:** 책임 중복·누락, 현재/과거 구분, 링크를 확인합니다. Git이 추적하지 않는 파일·폴더를 링크하거나 경로로 가리키지 않습니다. 확정 문서의 의미 충돌은 [도메인 규칙](agents/domain.md#모호성과-충돌-보고)에 따라 근거와 함께 보고합니다.
