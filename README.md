# BaboJUBot

연구 목표마다 독립적인 AI 조직을 구성하고, Research Lead와 작업자들이 협력하는 범용 연구 운영 프로젝트입니다. 초기 계획·팀 승인, 진행 관찰, 사용자 개입, 조직별 기억, 사용자 최종 검토를 지원하는 방향으로 개발합니다.

현재 상태는 **전체 구조 설계 완료, 구현 전**입니다. 요구사항·용어·조사 문서와 [전체 구조](docs/architecture.md)가 있고 서버·대시보드·실제 agent 실행은 아직 구현되지 않았습니다.

## 개발 시작

Node.js 24.x, pnpm 10.33.0 및 Git을 사용합니다. GitHub 이슈 작업에는 인증된 `gh`가 필요합니다.

```bash
pnpm install --ignore-scripts
pnpm check
```

`pnpm check`는 Markdown 문서의 로컬 링크를 검사합니다. 제품 기능 테스트나 타입 검사를 대신하지 않습니다. 스택은 [ADR-0004](docs/adr/0004-paperclip-aligned-stack.md)로 정했고, 개발 서버·테스트 명령은 첫 walking skeleton 구현에서 추가합니다.

## 문서

- [기능 범위](docs/features.md)
- [전체 구조](docs/architecture.md)와 [ADR](docs/adr/)
- [인터뷰 기록](docs/project-intent.md)
- [공통 용어](GLOSSARY.md)
- [6개 참고 프로젝트 코드 구조](docs/research/reference-code-structure.md)
- [23개 비교 대상](docs/research/comparative-survey.md)

실제 실행 인스턴스의 파일·기억·실험 결과는 Git에서 제외하는 `.babojubot/` 아래 또는 설정된 외부 저장소에 둡니다. 최종 저장 방식은 후속 이슈에서 결정합니다.

상위 프로젝트의 구조를 참고해 독립적으로 작성합니다. 코드 재사용 시 해당 버전·파일·의존성의 라이선스를 확인합니다. BaboJUBot 자체의 배포 라이선스는 아직 선택하지 않았습니다.
