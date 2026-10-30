# 자체 agent loop 대신 adapter 기반 control plane

BaboJUBot은 LLM을 직접 호출하는 자체 agent loop를 만들지 않고, Claude 계열·ACP 등 기존 프로바이더를 프로바이더 adapter로 구동하는 control plane으로 만든다. 연구에 필요한 코드·셸·웹 도구는 성숙한 프로바이더에 이미 있고, 우리가 만들 가치는 조직·승인·관찰·연구 하네스에 있다. Paperclip이 같은 방식으로 Claude·Codex·Hermes·Grok Build를 구동하며, 조직 범위를 실행 시도별 credential로 묶는 사례도 Paperclip뿐이었다([조사](../research/agent-runtime-models.md)).

## Consequences

- 실행 시도 입출력 계약을 프로바이더 선택보다 먼저 정하고 가짜 프로바이더로 검증한다.
- 프로바이더마다 지침 주입 지점이 다르고, 재개한 세션에는 지침을 다시 넣지 못하는 경우가 있다. 지침 bundle 버전이 바뀌면 새 세션으로 시작한다.
- 관찰 범위는 프로바이더가 내보내는 이벤트에 한정되고, 프로바이더 내부 셸 행동은 workspace 격리로 막아야 한다.
- 하네스 내용물은 프로바이더 사이에 공통인 `AGENTS.md`/`SOUL.md`/`SKILL.md` 관례를 따른다.
