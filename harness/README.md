# Research Harness

Role·Soul·Skill·연구 흐름 템플릿·연구 철학 내용물을 `AGENTS.md`/`SOUL.md`/`SKILL.md` 관례로 둡니다. 구조와 사본 규칙은 [전체 구조](../docs/architecture.md#research-harness--control-plane--agent-runtime)를 따릅니다.

이 디렉터리는 하네스 라이브러리입니다. 서버가 요청마다 읽어 그때 내용을 에이전트별 사본과 승인 대상으로 고정하므로, 여기를 고쳐도 이미 만든 사본과 제출된 승인 요청은 바뀌지 않습니다.

```text
roles/<name>/role.json     label, agent(lead|worker), skills(Skill 이름 목록)
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
