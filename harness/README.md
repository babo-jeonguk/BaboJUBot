# Research Harness

Role·Soul·Skill·연구 흐름 템플릿·연구 철학 내용물을 `AGENTS.md`/`SOUL.md`/`SKILL.md` 관례로 둡니다. 구조와 사본 규칙은 [전체 구조](../docs/architecture.md#research-harness--control-plane--agent-runtime)를 따릅니다.

이 디렉터리는 하네스 라이브러리입니다. 서버가 요청마다 읽으며, 사본과 승인 대상이 이 내용을 언제 고정하는지는 [전체 구조](../docs/architecture.md#research-harness--control-plane--agent-runtime)에 있습니다.

```text
roles/<name>/role.json     label, agent(lead|worker), skills(Skill 이름 목록), heartbeatMinutes(기본 heartbeat 간격·분, 없으면 60)
roles/<name>/AGENTS.md     Role 지침 → 에이전트 사본의 AGENTS.md
roles/<name>/SOUL.md       Soul → 에이전트 사본의 SOUL.md
skills/<name>/SKILL.md     Agent Skills 형식(frontmatter name·description) → 사본의 skills/<name>/SKILL.md
templates/<name>/template.json  연구 흐름 템플릿: label, description, nodeKinds, linkKinds
```

- 이름은 소문자·숫자·하이픈이고, SKILL.md의 `name`은 디렉터리 이름과 같아야 합니다. 파일은 UTF-8, 1 MiB 이하입니다.
- `roles/lead`는 새 조직의 Lead가 받는 Role입니다. 팀 구성에는 `agent`가 `worker`인 Role만 쓸 수 있습니다.
- 지침은 에이전트의 판단을 돕는 내용입니다. 도구 사용 범위와 승인은 제품 코드가 강제하므로 여기에 적은 금지문이 그 강제 수단이 아닙니다.

| 내용물 | 쓰임 |
| --- | --- |
| `roles/lead` | Research Lead. 목표 합의·계획·초기 연구 승인 요청 |
| `roles/researcher` | 작업자 연구원. `record-research-node` Skill을 받음 |
| `skills/record-research-node` | 연구 노드와 연결 기록 절차 |
| `templates/basic-research` | 기본 연구 흐름: 연구 문제 → 가설·아이디어 → 검증 방법 → 실험·검증 → 결과 |

## 언어와 쓰는 자리

- 에이전트가 읽는 지침(역할 문서·Soul·Skill)은 영어로 씁니다. 영어 지침은 [GLOSSARY](../GLOSSARY.md)의 영어 표기를 씁니다(예: 사용자는 the Owner).
- 사용자가 보는 조직 기록(Lead 대화 답장, 작업 제목·설명·댓글·완료 보고, 산출물, 연구 노드, 결과 제출, 초기 연구 계획, 진행 문장)은 한국어입니다. 그래서 역할 문서마다 "사용자와의 대화와 작업물은 한국어로 쓴다"는 지시를 둡니다. 새 Role을 더할 때도 그 역할 문서에 이 지시를 넣습니다.
- `role.json`의 `label`과 템플릿의 `label`·`description`은 사용자에게 보이므로 한국어로 둡니다. 이름(식별자)은 영어입니다.
- 도구의 사실(하는 일, 남기는 기록, 거부 조건, 입력 칸의 규칙)은 도구 목록(`packages/contracts/src/tools.ts`)의 설명에만 씁니다. 역할 문서는 단계별 흐름·도구를 쓰는 순서·제출물 품질 기준을 쓰고 도구는 이름으로만 가리키며, Skill은 여러 도구를 잇는 절차, Soul은 태도만 씁니다.
- 라이브러리를 바꿔도 이미 있는 조직의 사본은 바뀌지 않습니다. 새 조직과 새 작업자만 바뀐 내용을 받습니다.
