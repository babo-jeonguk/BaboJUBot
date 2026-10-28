# Lead의 작업 피드백과 조직 하네스 개선 레퍼런스

## 목적

실수·피드백을 지침·skill·기억으로 바꾸는 공개 구현을 비교해 [판 4의 검토 질문](../architecture.md#lead의-작업-피드백과-조직-하네스-개선)을 남긴다. 확인일: 2026-10-28(KST); 채택·승인 절차·저장 엔진의 결정 문서가 아니다.

## 요약 표

**소스**는 고정 SHA의 정적 열람, **문서**는 공식 설명, **논문**은 저자 실험 보고다. 실행 검증과 구분한다. ‘승인 없음’은 해당 학습 경로에 별도 사람 승인이 없다는 뜻이며 전체 도구 권한이 무제한이라는 뜻은 아니다. ‘Git 가능’은 운영자가 추적할 수 있다는 뜻이고 자동 이력 보장은 아니다. 미확인은 아래 출처 범위에서 확인하지 못했다는 뜻이다.

| 프로젝트 | 누가 고치나 | 사람 승인 | 계기 | 저장 형태·범위 | 이력·되돌리기 | 출처 |
| --- | --- | --- | --- | --- | --- | --- |
| Rakazo | bot이 자기 지침·skill·기억 변경 제안/수행 | 지침은 원칙상 명시 승인; `never` 예외 있음. 기억·skill은 다른 gate | 대화·사용자 교정·재사용할 절차; 매 작업 회고는 미확인 | DB의 bot 지침·Markdown 기억; skill은 space/user 공유 | 지침 최근 20개·충돌 검사·restore; 기억 revision; skill 이력 미확인 | [공식 식별](https://rakazo.com/about/), [승인 코드](https://github.com/elie222/rakazo/blob/f89fe06a20d4545df4acb5efb179b96ccf5d5638/packages/core/src/action-approval.ts) |
| Hermes Agent | 본 agent + 별도 background review + curator | 기억·skill gate 기본 꺼짐; 무인 기억의 파괴적 변경은 별도 staging | 사용자 교정·시행착오; 주기 review·idle 정리 | 작은 기억 항목 + `SKILL.md` 패키지; 기본 profile | skill ledger·blob·snapshot rollback·archive restore | [skills](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/features/skills.md), [curator](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/features/curator.md) |
| OpenClaw | 본 agent + 제한된 background reviewer; 기억 dreaming 별도 | skill 기본 `auto`; `propose`면 초안 검토 | 교정·어려운 절차·누적 10 model iterations·`/learn` | agent별 learned skill; workspace Markdown 기억 + 검색 index | skill 이전 10버전·Undo·변경 feed; 기억 rewrite 전 이미지 보존 | [Workshop](https://github.com/openclaw/openclaw/blob/b4b328b903ecec99179255bbe6f6c95fac885f45/docs/tools/skill-workshop.md), [self-learning](https://github.com/openclaw/openclaw/blob/b4b328b903ecec99179255bbe6f6c95fac885f45/docs/tools/self-learning.md) |
| mattpocock/skills `retro` | 회고 agent가 개선 후보 제시; reviewer 책임도 검토 | 사용자 호출 후 후보 제시까지; 자동 적용 규정 없음 | 명시적 회고 요청, 기본 현재 세션 | 탐색 포인터·검사·standards·skill 등 repo/사용자 환경 | 파일/Git 가능; 자체 rollback 없음 | [전체 SKILL.md](https://github.com/mattpocock/skills/blob/59db609eb1e18aaf59b63284d0e52255aff0c63c/skills/engineering/retro/SKILL.md) |
| Claude Code | 사람이 `CLAUDE.md`; Claude가 auto memory | local session 기본 켜짐·개별 사전 승인 없음 | 교정·선호·재사용 맥락을 작업 중 선별 | repo별 Markdown 색인·주제 파일; 사용자/프로젝트 지침 별도 | `/memory` 편집·삭제; 자동 revision rollback 미확인 | [Memory](https://code.claude.com/docs/en/memory) |
| OpenAI Codex | 사람/작업 agent의 `AGENTS.md`; 별도 extraction/consolidation | memories 기본 꺼짐; 켠 뒤 consolidation은 승인 없이 제한된 쓰기 | 새 root session에서 idle 과거 세션 처리 | 사용자 로컬 handbook·rollout 요약·선택적 skills; 적용 cwd 기록 | 내부 Git은 diff baseline; 사용자 복원 이력 아님 | [공식 memories](https://learn.chatgpt.com/docs/customization/memories), [구현 README](https://github.com/openai/codex/blob/479f7046ebbb5039c587b72a33af4e3776eac281/codex-rs/memories/README.md) |
| Cline Memory Bank | custom instructions를 받은 Cline | 일반 파일 편집 승인/Auto Approve | 패턴·큰 변경·`update memory bank` | 프로젝트 `memory-bank/*.md` | Git 가능·프로젝트 checkpoints; 기억 전용 아님 | [Memory Bank](https://docs.cline.bot/best-practices/memory-bank) |
| Roo Code | 사람 또는 파일 편집을 요청받은 agent | 일반 Auto Approve·보호 경로 설정 | 명시적 지침 편집; 자동 회고 미확인 | 사용자·workspace·mode별 rule 파일 | Git 가능·task checkpoints; 기억 전용 아님 | [고정 지침 문서](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/apps/docs/docs/features/custom-instructions.md) |
| Aider conventions | 사람이 규약 작성 | 자동 규약 변경 경로 없음 | 명시적 파일 작성·로드 | 읽기 전용 `CONVENTIONS.md`; repo/실행 범위 | Git 가능; 일반 코드 auto commit·`/undo`와 구분 | [Conventions](https://aider.chat/docs/usage/conventions.html) |
| Goose | 요청을 받은 agent가 memory 도구 사용 | 일반 도구 permission; 교훈별 검토 미확인 | remember/save/forget·저장 제안 | category별 텍스트·tags; 사용자/프로젝트 | 삭제·clear; revision rollback 미확인 | [고정 memory 문서](https://github.com/aaif-goose/goose/blob/398165c9376e61157ba9cfdd487ca9622d716955/documentation/docs/mcp/memory-mcp.md) |
| OpenHands | 사람/개선용 model이 평가를 모아 skill 개선 | 설치 검토 권고; 적용의 강제 승인 gate 미확인 | task/PR 평가 집계·명시적 개선 workflow | repo·사용자·조직 `SKILL.md`; legacy microagents | Git 가능; 새 conversation에서 목록 재구축 | [Skills](https://docs.openhands.dev/overview/skills), [개선 workflow](https://docs.openhands.dev/overview/skills/monitoring) |
| Letta | 본 agent·sleep-time agent·선택적 두 번째 검토 agent | agent review는 사람 승인 아님 | 영속 지식·`/remember`·step 수·compaction | 기존 DB memory blocks; 현재 agent별 Git MemFS | commit·동기화·정리 전 backup; `/doctor` | [Dreaming](https://docs.letta.com/configuration/memory), [MemFS](https://docs.letta.com/concepts/memfs) |
| Agent Zero | 종료 hook의 utility model; 행동 지침 수정 도구 | 자동 기억 기본 켜짐; 해당 경로의 개별 승인 없음 | monologue 종료·성공한 solution·행동 교정 | FAISS 문서/metadata + `behaviour.md`; project 격리 설정 | 편집·삭제·export; revision rollback 미확인 | [고정 memory guide](https://github.com/agent0ai/agent-zero/blob/ff2a5b9c9c4e490ba38dd7c313e779510bb2071a/docs/guides/memory.md) |
| SWE-agent | 사람이 좋은 trajectory를 골라 demonstration 생성 | 사람이 선택·편집·설정 | 좋은 실행을 명시적으로 재사용 | JSON/YAML demonstration; agent/environment config | 파일/Git 가능; 자동 lesson rollback 없음 | [고정 demonstrations 문서](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/docs/config/demonstrations.md) |
| Devin Knowledge / Memory | 과거에는 agent 제안+사람 저장; 현재 본 agent+Dreaming | 과거 Knowledge는 저장/기각; 현재 Memory는 개별 사전 승인 없음 | 교정·재사용 교훈; 현재 약 하루 한 번 Dreaming | 과거 조직 Knowledge; 현재 조직 안 개인별 Git Markdown drive | commit/merge·변경 카드; 사용자 rollback UI 미확인 | [Knowledge](https://docs.devin.ai/product-guides/knowledge), [현재 Memory](https://docs.devin.ai/product-guides/memory) |
| Paperclip | 기억 skill을 받은 실행 도구의 agent | skill에 교훈별 승인 규정 없음; 제품 권한과 별개 | 실수 즉시 기록·heartbeat 추출·주간 종합 | `$AGENT_HOME`의 PARA·YAML facts·daily notes·지침 | 사실을 supersede·archive; 일반 Git 복원은 운영 선택 | [고정 PARA skill](https://github.com/paperclipai/paperclip/blob/3be54534c24fc279533ff421e62a77ad15b72954/skills/para-memory-files/SKILL.md) |
| DSPy / GEPA | reflection LLM 제안 + metric/Pareto 탐색 선택 | 후보별 없음; 실행·배포는 통합자 결정 | 명시적 optimization job의 rollout·평가 feedback | 구성요소별 prompt 문자열 후보; 프로그램·데이터셋 범위 | 후보·부모·점수·checkpoint; 배포 rollback은 앱 책임 | [논문](https://arxiv.org/abs/2507.19457), [고정 README](https://github.com/gepa-ai/gepa/blob/d7918ba2f382d5d0652c10814bb278c1c7ffa7c3/README.md) |
| ACE | Generator → Reflector → Curator; 코드가 delta 병합 | 논문 자동 적응에 없음 | 성공·실패 trajectory + 실행 feedback | ID·helpful/harmful counter가 있는 bullet playbook; 도메인 범위 | initial/best/final·중간 playbook·usage log | [논문 v1](https://arxiv.org/html/2510.04618v1), [고정 README](https://github.com/ace-agent/ace/blob/82709de050e1db6e6ef2f07bcb0393560b94992a/README.md) |
| Voyager | program 생성 agent + 완료 critic + SkillManager | 연구 loop에 없음 | 환경 feedback·오류·self-verification | 실행 JS·자연어 설명·Chroma; Minecraft skill library | checkpoint; 이전 code/설명 파일 보존; 통합 rollback 미확인 | [저자 사이트](https://voyager.minedojo.org/), [고정 SkillManager](https://github.com/MineDojo/Voyager/blob/55e45a880755d0c8c66ca7fb5fe7962ac8974f89/voyager/agents/skill.py) |
| Reflexion | Actor·Evaluator·Self-Reflection | 실험 loop에 없음 | 실패/평가 후 다음 trial | 자연어 episodic buffer; 주로 같은 문제 재시도 | bounded sliding window; 제품형 rollback 없음 | [논문 v4](https://arxiv.org/html/2303.11366v4) |
| MetaGPT | 사람이 SOP 정의; 역할 agent가 중간 결과 검토 | SOP 자동 개정 loop 미확인 | 작업 중 review·실행 feedback | 역할 prompt·절차·산출물; 누적 lesson과 구분 | 저장소/실행 기록; lesson 승격·복원 미확인 | [원 논문 v7](https://arxiv.org/abs/2308.00352v7) |
| CrewAI CLI training | 사람 feedback → agent별 LLM evaluator | 매 iteration human feedback; 최종 suggestions 별도 승인 미확인 | 명시적 `crewai train` | raw iteration `.pkl` + role별 suggestions `.pkl` | load/clear; 자동 revision rollback 미확인 | [버전 고정 training 문서](https://docs.crewai.com/v1.15.30/en/concepts/training) |
| LangMem | 본 agent의 memory 도구·background manager·prompt optimizer | 필수 gate 없음; 앱 책임 | 대화 이후·선택적 hot path·명시적 optimization | schema profile·문서 collection·prompt 문자열; namespace | insert/update/delete; 기본 revision rollback 미확인 | [개념](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/), [prompt 최적화](https://langchain-ai.github.io/langmem/guides/optimize_memory_prompt/) |
| Karpathy 관련 주장 | ‘system prompt learning’ 원글 귀속 미검증 | 구현 계약 미확인 | 미확인 | 구현체로 비교하지 않음 | 해당 없음 | [원글 후보·직접 열람 실패](https://x.com/karpathy/status/1921368644069765486) |

## 프로젝트별 짧은 메모

### Rakazo: 자기 지침 제안과 공유 skill의 경계가 다르다

- **식별·소스:** 공식 [About](https://rakazo.com/about/)가 연결한 `elie222/rakazo`다. Inbox Zero Inc.가 유지하는 Apache-2.0의 지속 bot 제품이며 Grok Bot 대안을 표방한다. 기준 SHA는 `f89fe06a20d4545df4acb5efb179b96ccf5d5638`; 동명이인 후보를 남길 정도의 식별 불확실성은 없다.
- **승인:** `propose_instructions_update`는 자기 지침 전체와 이유를 제안한다. 도구 설명은 항상 명시 승인을 요구한다고 쓰지만 실제 [gate](https://github.com/elie222/rakazo/blob/f89fe06a20d4545df4acb5efb179b96ccf5d5638/packages/core/src/action-approval.ts#L463)에는 예외가 있다. `never` 모드에서 Owner가 시작했고 외부 내용에 오염되지 않은 실행은 허용하고, 그렇지 않으면 거부한다. [호출부](https://github.com/elie222/rakazo/blob/f89fe06a20d4545df4acb5efb179b96ccf5d5638/packages/adapters/src/run-tool-gate.ts#L268)도 이 조건을 전달한다. 따라서 도구 설명만으로 ‘항상 사람 승인’이라 결론 내릴 수 없다.
- **저장·복원:** [지침 writer](https://github.com/elie222/rakazo/blob/f89fe06a20d4545df4acb5efb179b96ccf5d5638/packages/db/src/bot-instructions.ts)는 외부 기원 실행의 제안을 제한하고 bot별 진행 중 제안을 직렬화한다. 변경 전 지침 최근 20개를 보존하며 현재 내용 불일치 시 restore를 거부한다. [기억](https://github.com/elie222/rakazo/blob/f89fe06a20d4545df4acb5efb179b96ccf5d5638/packages/memory/src/index.ts)은 Markdown 내용을 Postgres에 저장하고 revision·원본 run/thread를 원자적으로 남긴다. `remember`는 bot 기억에 중복을 피하며 추가하고 shared memory는 문서 전체를 교체한다.
- **범위·한계:** [skill 도구](https://github.com/elie222/rakazo/blob/f89fe06a20d4545df4acb5efb179b96ccf5d5638/packages/adapters/src/skill-tools.ts)는 `spaceId + userId`의 사용자 skill을 수정한다. bot별 사적 교훈과 달리 같은 범위의 다른 bot에도 쓰이는 자산이다. builtin/plugin은 읽기 전용, 본문은 100,000자 제한이다. [도구 정의](https://github.com/elie222/rakazo/blob/f89fe06a20d4545df4acb5efb179b96ccf5d5638/packages/adapters/src/builtin-tools.ts#L1171)는 재사용할 다단계 작업을 skill로 저장하게 하지만 매 작업의 독립 reviewer·skill revision/자동 정리·학습 효과 평가는 확인하지 못했다.

### Hermes Agent: 사실 기억과 절차 skill, 검토와 정리를 나눈다

- **소스·루프:** Nous Research `hermes-agent`, SHA `e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6`. [skill 규약](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/features/skills.md#L606)은 교정·오류 끝에 찾은 방법·재사용할 절차를 저장하게 한다. 본 agent가 수정하고, 응답 뒤 별도 fork가 놓친 기억/skill을 검토한다. [초기값](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/agent/agent_init.py#L1210)은 memory nudge와 skill creation nudge 모두 10이며, skill은 [누적 iteration](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/agent/turn_finalizer.py#L830)을 센다. 매 작업 완료마다 반드시 교훈을 쓰는 방식은 아니다.
- **승인·도구:** [memory/skill write gate](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/features/memory.md#L329)는 각각 기본 `false`. 켜면 memory는 CLI inline 또는 pending, skill은 항상 pending/diff/approve로 처리한다. gate가 꺼져도 무인 review의 기억 patch/remove는 staging하며 승인 시 대상 entry가 바뀌었으면 거부한다. [review whitelist](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/agent/background_review.py#L1092)는 memory/skill 도구와 읽기 도구를 허용하고 terminal·일반 파일 쓰기를 막는다. 지침 문구와 별개인 dispatch 제어다.
- **형태·크기·범위:** profile의 `memories/MEMORY.md`·`USER.md`는 `§`로 나눈 항목이며 기본 2,200자·1,375자. 초과 시 축약/삭제와 추가를 한 batch로 재시도한다. `skills/<name>/SKILL.md`와 topic별 references는 필요할 때 로드한다. incident log를 그대로 늘리지 않고 절차 단계에 원인과 교훈을 붙이는 방침이다. 약 24k자 skill 본문·60개 초과 references에는 advisory 경고가 있다. [외부 skill 경로](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/features/skills.md#L407)도 쓰기 가능하면 제자리 수정하므로 profile만으로 공유 파일의 보호를 보장하지 않는다.
- **이력·정리:** [curator](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/features/curator.md)는 기본 7일 간격·2시간 idle 이후 확인하고, 대상 skill은 14일 stale·30일 archive한다. LLM 병합은 기본 꺼짐이고 pinned/cron 참조는 보호한다. foreground `/learn` 생성과 background 생성의 소유 표지도 구분한다. mutation ledger의 actor·출처·before/after hash와 content-addressed blob으로 단일 변경 rollback, 전체 snapshot rollback, archive restore를 지원한다. 기본 snapshot 2개·ledger 5MiB이며 ledger 실패는 변경을 막지 않는다. 보존 한도·설정에 따라 복원 가능 범위가 달라진다.
- **실패 근거:** 공식 [문제 해결](https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/features/memory.md#L67)은 ‘기억했다’고 답하고 도구를 호출하지 않는 모델, 잘못된 profile, 승인 대기, 긴 세션의 frozen snapshot을 열거한다. review 소스는 읽기 도구 차단이 read-before-write 거부를 반복시켜 실제 수정이 거의 안 된 사례를 기록한다. 이는 유지보수자의 사례이며 대조 평가 수치는 아니다.

### OpenClaw: learned skill의 제한된 자동 변경과 Undo

- **버전:** Clawdbot/Moltbot의 후속인 `openclaw/openclaw`, SHA `b4b328b903ecec99179255bbe6f6c95fac885f45`. [config 코드](https://github.com/openclaw/openclaw/blob/b4b328b903ecec99179255bbe6f6c95fac885f45/src/skills/workshop/config.ts)에서 학습 기본값은 `auto`다. 과거 proposal-only/off 설명이나 갱신이 늦은 번역 문서를 이 버전과 섞지 않는다.
- **계기·review:** [self-learning](https://github.com/openclaw/openclaw/blob/b4b328b903ecec99179255bbe6f6c95fac885f45/docs/tools/self-learning.md)은 본 agent의 오도한 skill 수정, 어려운 절차 저장, 누적 10 model iterations 후 idle 30초 background review를 나눈다. reviewer는 최근 최대 64 transcript events·32KiB와 Workshop 도구만 받으며 한 번에 최대 한 변경을 만든다. cron/heartbeat/subagent/incognito 등은 제외하고, 중단 전 확인된 성공 단계만 남긴다. 추측·미해결 실패·일시적 환경 오류를 보편 지침으로 저장하지 않는 규약이다.
- **승인·범위·복원:** [Workshop](https://github.com/openclaw/openclaw/blob/b4b328b903ecec99179255bbe6f6c95fac885f45/docs/tools/skill-workshop.md)은 agent별 `workshop-skills/`만 관리하며 수동/공유 skill 원본과 구분한다. `propose`에서는 background 도구를 list/view/draft로 제한해 최대 50개 초안을 검토하게 한다. `off`/`propose`라도 사용자가 요청한 foreground 수정까지 금지하지는 않는다. 이전 버전 snapshot을 먼저 저장하고 Undo/restore를 제공한다. [버전 코드](https://github.com/openclaw/openclaw/blob/b4b328b903ecec99179255bbe6f6c95fac885f45/src/skills/workshop/skill-versions.ts)는 최근 10개, 문서상 변경 feed는 agent별 최근 500개를 보존한다.
- **크기·정리·적용 시점:** `SKILL.md` 기본 40,000 bytes, 보조 파일당 256KiB, path traversal/symlink·critical scanner finding을 거부한다. 30일 미사용을 archive하되 최소 하루 간격으로 확인한다. Codex harness처럼 native shell의 skill 사용을 계측하지 못하면 잘못 archive하지 않도록 이 정리를 끈다. 새 세션이 변경된 skill을 로드하고 실행 중 세션은 시작 snapshot을 유지한다. 문서의 즉시 변경은 저장 시점이며 기존 모든 세션의 재주입을 뜻하지 않는다.
- **기억과 자기 수정:** [기억](https://github.com/openclaw/openclaw/blob/b4b328b903ecec99179255bbe6f6c95fac885f45/docs/concepts/memory.md)은 `USER.md`·`MEMORY.md`·daily notes와 SQLite 검색 index를 사용하고 compaction 전 flush한다. [dreaming](https://github.com/openclaw/openclaw/blob/b4b328b903ecec99179255bbe6f6c95fac885f45/docs/concepts/dreaming.md)은 기본 야간 통합, 출처·상충 처리, rewrite 전 이미지·이전 entry 손실 제한을 둔다. 읽기 위한 `DREAMS.md`를 다시 사실의 원천으로 승격하지 않는다. workspace 지침 파일을 바꾸는 능력, Workshop의 절차 학습, 실행 도구 자체 소스 개정은 서로 다르며 마지막의 자동 학습 loop는 여기서 입증하지 않았다.

### mattpocock/skills `retro`: 반복 실수를 환경 개선 후보로 바꾼다

- **전체 원문 확인:** `skills/engineering/retro/SKILL.md`, SHA **`59db609eb1e18aaf59b63284d0e52255aff0c63c`**(commit 2026-10-27). [frontmatter부터 마지막 Files 절까지 전부 읽었다](https://github.com/mattpocock/skills/blob/59db609eb1e18aaf59b63284d0e52255aff0c63c/skills/engineering/retro/SKILL.md). `disable-model-invocation: true`이며 사용자의 회고 요청을 전제한다. 지정 세션의 1차 자료를 읽고, 지정이 없으면 현재 세션을 본다. 이 skill을 이번 작업에서 실행한 것은 아니다.
- **무엇을 제안하나:** 탐색 난도, 기존 자동 검사의 연결/고장, reviewer가 놓친 규약, 비대한 global `AGENTS.md`, 도구 비용, 행동을 바꾸지 않는 지침, 정보 접근을 살핀 뒤 심각도 순으로 사용자에게 후보를 제시한다. 기계적으로 판별되는 위반은 lint/hook/CI로, 판단이 필요한 규약은 reviewer의 `CODING_STANDARDS.md`로 보내는 방침이다.
- **범위·정리·한계:** `AGENTS.md`/`CLAUDE.md`는 주로 탐색 포인터로 작게 유지하고, docs는 링크로, skill은 필요할 때 불러온다. standards 1,000줄 초과 시 docs 포인터 분리를 권한다. 자동 적용·별도 memory DB·용량 강제·rollback·효과 실험은 정의하지 않는다. ‘사용자에게 제시’는 확인했지만 실제 파일 적용을 강제하는 승인 API가 있다는 뜻은 아니다.

### Claude Code: 수동 지침과 자동 교훈 파일

- **문서:** [`CLAUDE.md`와 auto memory](https://code.claude.com/docs/en/memory)는 지속 context이며 강제 설정이 아니다. 차단은 hook으로 구현하라고 명시한다. 사람/요청받은 Claude가 지침을 고치고, auto memory는 교정·선호·코드에서 재발견하기 어려운 맥락을 선별 저장한다. local session에서 기본 켜짐, 개별 사전 승인 없이 저장한다.
- **형태·정리:** repo별 `~/.claude/projects/<project>/memory/`; 같은 repo의 worktree가 공유한다. `MEMORY.md` 색인과 `user/feedback/project/reference` 유형 Markdown을 쓰며 색인 첫 200줄 또는 25KB까지만 자동 로드한다. 상세 파일은 필요 시 읽고 `/memory`로 편집·삭제한다. 자동 버전 복원은 미확인이다.
- **한계:** 긴 파일·모호함·상충은 지침 준수율을 낮춘다고 경고한다. 파일에 교훈이 있다는 사실과 실제 다음 작업에서 준수한다는 사실은 다르며, 반복 실수 감소의 대조 수치는 제시하지 않는다.

### OpenAI Codex: 과거 세션 추출과 통합을 별도 실행으로 처리

- **문서·소스:** [`AGENTS.md`](https://learn.chatgpt.com/docs/agent-configuration/agents-md)는 지속 지침이며 기본 합계 32KiB. [memories](https://learn.chatgpt.com/docs/customization/memories)는 기본 꺼짐이고 읽기/향후 생성 입력 허용을 `/memories`로 구분한다. SHA `479f7046ebbb5039c587b72a33af4e3776eac281`의 [pipeline](https://github.com/openai/codex/blob/479f7046ebbb5039c587b72a33af4e3776eac281/codex-rs/memories/README.md)은 새 root session에서 idle 세션별 추출 → 별도 consolidation agent를 실행한다. consolidation은 승인 요청·네트워크 없이 로컬 쓰기만 허용한다.
- **형태·범위·정리:** 사용자 로컬 `~/.codex/memories/`의 `memory_summary.md`, `MEMORY.md`, `rollout_summaries/`, 선택적 `skills/*/SKILL.md`. repo별 격리 저장이 아니라 cwd/`applies_to`로 관련성을 기록한다. 전역 lock/lease, 사용 횟수·최근 사용·`max_unused_days`·top-N 선택과 stale 자료 정리를 둔다. 전체 기억의 고정 용량 상한은 읽은 문서에서 미확인이다.
- **이력·품질:** 내부 `.git`는 이전 성공 baseline과 diff를 만들기 위한 것이고 성공 후 baseline을 reset한다. 삭제 자료가 Git object로 남지 않도록 하므로 사용자용 영구 복원 이력으로 취급할 수 없다. [통합 prompt](https://github.com/openai/codex/blob/479f7046ebbb5039c587b72a33af4e3776eac281/codex-rs/memories/write/templates/memories/consolidation.md)는 원증거·출처, 증상→원인→해결·검증·중단 조건, 교훈이 없으면 no-op를 요구한다. 이는 품질 지침이며 효과 실험 결과는 아니다.

### Cline Memory Bank: 파일 기반 운영 방법론

- [공식 Memory Bank](https://docs.cline.bot/best-practices/memory-bank)는 custom instructions로 설치하는 방법이다. Cline이 프로젝트의 `projectbrief`, `productContext`, `activeContext`, `systemPatterns`, `techContext`, `progress` Markdown을 읽고 패턴·큰 변경·명시적 갱신 요청을 반영한다. 매 task 읽기는 prompt 규칙이며 독립 학습 scheduler가 아니다.
- 파일 변경은 [일반 승인/Auto Approve](https://docs.cline.bot/features/auto-approve)를 따른다. [Checkpoints](https://docs.cline.bot/core-workflows/checkpoints)는 프로젝트 shadow Git snapshot을 복원하지만 Memory Bank 전용 의미 검토·이력은 아니다. 고정 크기·자동 만료·학습 효과 수치는 미확인이다. 전체 파일 반복 로드는 문맥 비용을 늘릴 수 있다(구조에서의 추론).

### Roo Code: 범위별 rules와 checkpoints

- SHA `b867ec9145750d0ae1ff7f02d35406e9bf2a0b16`의 [지침 문서](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/apps/docs/docs/features/custom-instructions.md)는 `~/.roo/rules/`, `.roo/rules/`, mode별 rules, fallback `.roorules`, `AGENTS.md`를 조합한다. 사람 또는 편집을 요청받은 agent가 바꾸며 공식 자동 회고 loop는 미확인이다. 커뮤니티 Memory Bank와 구분한다.
- [Auto Approve](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/apps/docs/docs/features/auto-approving-actions.mdx)에는 보호 경로/외부 경로 쓰기 설정이 있고, [checkpoints](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/apps/docs/docs/features/checkpoints.mdx)는 task별 shadow Git을 사용한다. 기억 전용 용량·정리·효과 수치는 미확인. 조사 시 공식 저장소는 2026-05-15 archive 상태로 표시되므로 유지 중인 제품과 동일하게 취급하지 않는다.

### Aider conventions: 사람이 고른 지침을 읽기 전용 주입

- [Conventions](https://aider.chat/docs/usage/conventions.html)는 작은 `CONVENTIONS.md`를 `/read`·`--read`·config의 `read:`로 로드하는 방법이다. 규약 자체를 자동 학습·개정하지 않는다. 범위는 운영자가 지정한 파일과 프로젝트다.
- 일반 수정에는 [auto commit·`/undo`](https://aider.chat/docs/git.html)가 있지만 읽기 전용 규약까지 자동 변경·버전 관리한다는 뜻은 아니다. 규약의 Git 추적은 운영 선택이며 자동 정리·고정 상한·장기 학습 평가는 이 문서에서 확인하지 못했다.

### Goose: category별 기억 도구

- SHA `398165c9376e61157ba9cfdd487ca9622d716955`의 [memory 문서](https://github.com/aaif-goose/goose/blob/398165c9376e61157ba9cfdd487ca9622d716955/documentation/docs/mcp/memory-mcp.md)는 remember/save/forget 요청 또는 저장 제안을 agent가 도구로 처리하게 한다. `.goose/memory/`와 `~/.config/goose/memory/`에 category별 `.txt`·tags를 둔다. 별도 교훈 승인 대신 일반 permission을 따른다.
- [구현](https://github.com/aaif-goose/goose/blob/398165c9376e61157ba9cfdd487ca9622d716955/crates/goose-mcp/src/memory/mod.rs)의 server instructions에는 global 기억이 들어가고 local 기억은 working directory를 받는 도구로 접근한다. 모든 local 기억의 자동 주입까지 단정하지 않는다. 삭제·clear는 있으나 자동 회고·expiry·revision rollback·고정 상한·효과 대조 수치는 미확인이다.

### OpenHands: 실행 평가를 모아 skill 개선

- [현재 skills](https://docs.openhands.dev/overview/skills)는 `.agents/skills/<name>/SKILL.md`와 자원을 사용하고 legacy `.openhands/skills/`·`microagents/`를 지원한다. repo·사용자·조직 범위, metadata부터 필요한 본문만 읽는 방식이다. Git 변경/복원이 가능하고 새 conversation에서 목록을 다시 만든다.
- [개선 문서](https://docs.openhands.dev/overview/skills/monitoring)는 task/PR 평가 → 결과 집계 → reasoning model의 기존 skill 개선 → 제안 검토 흐름이다. 제안 자동 배포나 사람 승인 강제 API의 증거로 쓰지 않는다. 리뷰 반영률·triage 정확도·해결 시간을 지표로 권하며 제안 수·코드 줄 수를 품질로 삼지 않는다. 문서 예시의 15%는 실험 성과가 아니다. 고정 용량·자동 expiry는 미확인이다.

### Letta: sleep-time 편집자와 현재 MemFS를 구분

- **기존 구조:** [2025-04-21 저자 글](https://www.letta.com/blog/sleep-time-compute/)은 primary와 sleep-time agent를 분리하고 후자에 core-memory 편집 도구를 주어 shared blocks를 정리한다. [memory blocks SDK](https://docs.letta.com/v1-sdk/memory/memory-blocks)의 label/description/value/크기 제한·read-only block과 현재 파일 시스템을 같은 버전의 구현처럼 섞지 않는다.
- **현재 문서:** [MemFS](https://docs.letta.com/concepts/memfs)는 agent별 Git 기억 저장소, root 상시 context·하위 색인 지연 로딩·agent 소유 skill을 설명한다. [dreaming](https://docs.letta.com/configuration/memory)은 step 수/compaction 후 별도 agent가 검토하며, 두 번째 agent review 옵션도 사람 승인 없이 적용한다.
- **관리·한계:** commit/동기화·정리 전 backup, `/doctor`의 중복·배치·토큰 감사가 있다. 현재 공개 cloud 한도는 repository당 Free 5MiB·Pro 50MiB이며 history가 아닌 branch/tag 최신 snapshot의 파일을 센다. 공유 기억은 별도 기능이다. 과거 blocks와 MemFS의 전체 호환 계약·반복 오류 감소 수치는 미확인이다.
- **효과 범위:** [Sleep-time Compute 논문 v1](https://arxiv.org/abs/2504.13171v1)은 Stateful GSM-Symbolic/AIME에서 같은 정확도에 필요한 test-time compute 약 5배 절감을 보고한다. 질의 전 context 계산의 실험이며 현재 MemFS의 실수 교정 효과나 background 비용까지 포함한 5배 절감을 뜻하지 않는다.

### Agent Zero: 자동 solution 기억과 행동 지침 수정

- SHA `ff2a5b9c9c4e490ba38dd7c313e779510bb2071a`의 [종료 hook](https://github.com/agent0ai/agent-zero/blob/ff2a5b9c9c4e490ba38dd7c313e779510bb2071a/plugins/_memory/extensions/python/monologue_end/_51_memorize_solutions.py)은 utility model로 성공한 problem/solution을 background 추출한다. [행동 수정 도구](https://github.com/agent0ai/agent-zero/blob/ff2a5b9c9c4e490ba38dd7c313e779510bb2071a/plugins/_memory/tools/behaviour_adjustment.py)는 기존 규칙과 교정을 병합해 `behaviour.md`에 쓴다. 해당 경로에 개별 human approval 분기는 없다.
- [기억 가이드](https://github.com/agent0ai/agent-zero/blob/ff2a5b9c9c4e490ba38dd7c313e779510bb2071a/docs/guides/memory.md)·[설정](https://github.com/agent0ai/agent-zero/blob/ff2a5b9c9c4e490ba38dd7c313e779510bb2071a/plugins/_memory/default_config.yaml)·[저장 구현](https://github.com/agent0ai/agent-zero/blob/ff2a5b9c9c4e490ba38dd7c313e779510bb2071a/plugins/_memory/helpers/memory.py): FAISS 문서/metadata, main/fragments/solutions/skills 영역, 기본 project memory isolation. 유사 기억을 통합/대체하고 solution 추출 입력을 최근 80,000자로 제한한다. 검색·편집·삭제·export는 있으나 revision rollback은 미확인이다.
- 공식 가이드가 낡은 지침·실패한 추측의 사실화·프로젝트 혼합·잘못된 선호·실행하지 않은 시험의 기억을 실패 형태로 열거하고 사람의 정리를 요구한다. 정량 효과 수치는 확인하지 못했다.

### SWE-agent: 좋은 실행 예시 재사용은 지속 회고와 다르다

- SHA `3ea751c087f32b16e039a2233dd6eefecef325d5`의 [demonstrations](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/docs/config/demonstrations.md)는 사람이 trajectory를 골라 `traj-to-demo`로 변환·편집하고 선택적으로 replay 검증한 뒤 config에 넣는 방식이다. JSON/YAML 예시가 특정 agent/environment의 few-shot context가 된다.
- 파일/Git 관리 외에 자동 lesson 승격·정리·rollback·크기 정책은 미확인이다. 문서에는 1.0 반영 중이라는 경고가 있다. SWE-bench 점수를 이 demonstration 또는 지속 기억의 독립 효과로 해석하지 않는다.

### Devin: 과거 Knowledge와 현재 개인 Memory/Dreaming

- [Knowledge](https://docs.devin.ai/product-guides/knowledge)는 feedback에서 항목/수정안을 제안하고 사람이 편집·저장·기각하는 방식이었다. trigger description·짧은 항목·repo/조직 범위를 갖지만 [현재 onboarding](https://docs.devin.ai/onboard-devin/knowledge-onboarding)은 deprecated 및 Skills in Plugins로 이관 중이라고 설명한다.
- [현재 Memory](https://docs.devin.ai/product-guides/memory)는 조직 안의 **개인별** 자산이다. 작업 중 교정·선호·교훈을 `MEMORY.md` 색인과 주제 파일의 한 줄 bullet·출처 세션·날짜로 저장한다. 기본 켜짐, 항목별 사전 승인 없이 Git commit/merge하며 stale write를 거부·재시도한다. 새 세션부터 반영한다.
- 약 하루 한 번 별도 Dreaming이 중복·일시적/미사용 stale 항목을 정리하고 놓친 교훈을 추가한다. 변경 카드·dream 이력이 있고 UI에서 직접 쓰는 대신 채팅으로 수정/삭제한다. 자동화 세션은 memory 읽기/쓰기에서 제외한다. 사용자 rollback UI·고정 크기·효과 대조 수치는 미확인이다.

### Paperclip: control plane의 학습 엔진보다 실행 도구에 주는 파일 규약

- SHA `3be54534c24fc279533ff421e62a77ad15b72954`의 [`para-memory-files`](https://github.com/paperclipai/paperclip/blob/3be54534c24fc279533ff421e62a77ad15b72954/skills/para-memory-files/SKILL.md)는 실수·교훈을 `AGENTS.md`·`TOOLS.md`·관련 skill에 쓰도록 한다. 실행 도구의 agent가 따르는 지침이며 이 파일만으로 서버의 자동 reviewer·승인 gate를 입증하지 않는다. 실행 도구와 control plane 구분은 [기존 조사](agent-runtime-models.md#1-paperclip-루프-없는-control-plane과-adapter-계약)를 참고한다.
- `$AGENT_HOME` 아래 entity별 `summary.md`·`items.yaml`, daily notes, 사용자 운영 패턴 `MEMORY.md`를 나눈다. heartbeat 추출·주간 요약, qmd 회수를 권한다. [schema](https://github.com/paperclipai/paperclip/blob/3be54534c24fc279533ff421e62a77ad15b72954/skills/para-memory-files/references/schemas.md)는 ID·출처·active/superseded·대체 항목·접근 횟수/시각을 둔다.
- 사실은 삭제보다 supersede하고 7일/30일 기준으로 요약 우선순위만 낮춘다. 이는 원문 보존과 context 정리를 분리한 사례다. 경로 규약 자체의 조직 접근 통제·지침 revision rollback·고정 용량·학습 효과는 이 skill에서 확인하지 못했다.

### DSPy / GEPA: 반성으로 후보를 만들고 평가로 고른다

- [논문](https://arxiv.org/abs/2507.19457)은 reflection LLM이 trace·자연어 feedback에서 prompt 변이를 제안하고 validation의 여러 예제에 강한 후보를 Pareto frontier로 유지한다. 사람이 optimization job과 metric/데이터 구분을 설계하지만 후보별 승인은 없다. lesson은 주로 프로그램 구성요소의 prompt에 흡수된다.
- SHA `d7918ba2f382d5d0652c10814bb278c1c7ffa7c3`의 [README](https://github.com/gepa-ai/gepa/blob/d7918ba2f382d5d0652c10814bb278c1c7ffa7c3/README.md)는 DSPy `compile`·`max_metric_calls`를, [result](https://github.com/gepa-ai/gepa/blob/d7918ba2f382d5d0652c10814bb278c1c7ffa7c3/src/gepa/core/result.py)·[state](https://github.com/gepa-ai/gepa/blob/d7918ba2f382d5d0652c10814bb278c1c7ffa7c3/src/gepa/core/state.py)는 후보·부모 계보·validation 점수·저장/재개를 제공한다. 이전 후보 선택과 배포 rollback은 구분한다. 저장소 전역 만료보다 평가 호출 예산이 핵심 제한이다.
- 저자 보고는 6개 task에서 GRPO 대비 평균 6%, 최대 20% 개선·최대 35배 적은 rollout, MIPROv2 대비 10% 이상 개선이다. 논문 조건의 수치이며 조직의 모든 후속 작업에 대한 자동 적용 효과나 승인·격리를 입증하지 않는다.

### ACE: Reflector와 Curator, 항목별 delta

- [논문 v1 §3](https://arxiv.org/html/2510.04618v1)은 Generator의 성공/실패 → Reflector의 원인·교훈 → Curator의 bullet delta → 비-LLM merge를 구분한다. playbook bullet마다 ID·helpful/harmful counter가 있다. 매번 전체를 재요약하면 세부 지식이 사라지는 brevity bias/context collapse를 핵심 문제로 제시하고 점진적 갱신·중복 제거를 사용한다.
- SHA `82709de050e1db6e6ef2f07bcb0393560b94992a`의 [README](https://github.com/ace-agent/ace/blob/82709de050e1db6e6ef2f07bcb0393560b94992a/README.md)는 기본 playbook 예산 80,000 tokens·50 step마다 저장, initial/best/final·intermediate playbooks·bullet usage log를 설명한다. dedup analyzer는 기본 꺼짐이므로 논문의 알고리즘 설명을 현재 코드 기본 동작과 같다고 쓰지 않는다. checkpoint와 운영 중 rollback 보장은 별개다.
- 저자 보고 평균 agent benchmark +10.6%, finance +8.6%. online 평가는 각 sample에 먼저 답한 뒤 그 sample로 갱신한다. 성공과 실패를 모두 쓰는 실험이며 사람 승인이나 연구 조직 간 격리 기능의 검증은 아니다.

### Voyager: 검증된 실행 skill을 쌓는 환경 특화 사례

- [저자 사이트](https://voyager.minedojo.org/)는 환경 feedback·실행 오류·완료 critic으로 JS를 반복 개선하고 성공한 절차를 자연어 설명과 함께 축적한다. 설명 embedding으로 top-5 skill을 검색하며 사람 개입 없는 Minecraft 연구 loop다.
- SHA `55e45a880755d0c8c66ca7fb5fe7962ac8974f89`의 [SkillManager](https://github.com/MineDojo/Voyager/blob/55e45a880755d0c8c66ca7fb5fe7962ac8974f89/voyager/agents/skill.py)는 code/설명·`skills.json`·Chroma·checkpoint를 사용한다. 같은 이름의 과거 파일은 V2/V3로 보존하지만 현재 JSON/vector 항목은 교체한다. 통합 rollback·전역 pruning/크기 상한은 미확인이다.
- 저자 보고 unique items 3.3배·이동 거리 2.3배, 주요 milestone에 최대 15.3배 빠르게 도달했다. 실행 가능한 환경 skill의 결과이므로 일반 텍스트 지침의 학습 효과로 직접 환산하지 않는다.

### Reflexion: 자연어 feedback을 다음 trial에 넣는다

- [논문 v4 §3](https://arxiv.org/html/2303.11366v4)의 Actor·Evaluator·Self-Reflection은 점수·성공실패·테스트 결과를 자연어 교훈으로 만들어 다음 시도 prompt에 넣는다. 가중치 학습이 아니며 실험 buffer는 보통 최근 1–3개 경험의 sliding window다.
- 주된 범위는 같은 문제의 반복 시도다. 조직의 여러 후속 작업에 지속되는 기억과 동일하지 않다. 별도 사람 승인·제품형 버전 복원은 없다. [공개 구현](https://github.com/noahshinn/reflexion/blob/218cf0ef1df84b05ce379dd4a8e47f17766733a0/hotpotqa_runs/agents.py)도 prompt에 reflection을 다시 넣는다.
- 저자 보고 HumanEval 91% 대 baseline GPT-4 80%지만 내부 feedback을 받는 반복 trial이 있으므로 단일 호출 성과로 쓰지 않는다. 논문은 self-evaluation 의존·local minima·테스트 품질의 한계를 다룬다.

### MetaGPT: SOP 적용과 SOP 학습은 별도 주장

- [원 논문 v7](https://arxiv.org/abs/2308.00352v7)은 사람이 정한 SOP를 역할별 prompt sequence로 인코딩하고 중간 산출물 검증으로 cascading hallucinations를 줄인다. 이것만으로 agent가 자기 SOP를 회고해 영속 개정한다고 주장할 수 없다.
- [기준 저장소](https://github.com/FoundationAgents/MetaGPT/tree/11cdf466d042aece04fc6cfd13b28e1a70341b1f)의 모든 후속 기능을 전수 감사하지 않았다. 자동 lesson 승격·승인·용량/정리·rollback·지속 학습만의 효과는 미확인이다.

### CrewAI CLI training: 사람 feedback을 role별 지침으로 정제

- [v1.15.30 training 문서](https://docs.crewai.com/v1.15.30/en/concepts/training)는 명시적 `crewai train -n …`의 매 iteration마다 사람 feedback을 받아 최초/개선 결과와 함께 저장한다. LLM evaluator가 최종 `suggestions[]`, quality, summary를 만들며 별도 최종 승인 단계는 명시하지 않는다. 일반 실행이 매번 training하는 구조는 아니다.
- SHA `3adab2895836ddde6a2150867e2b998a0a1f5334`의 [evaluator](https://github.com/crewAIInc/crewAI/blob/3adab2895836ddde6a2150867e2b998a0a1f5334/lib/crewai/src/crewai/utilities/evaluators/task_evaluator.py)·[handler](https://github.com/crewAIInc/crewAI/blob/3adab2895836ddde6a2150867e2b998a0a1f5334/lib/crewai/src/crewai/utilities/training_handler.py)는 raw agent ID×iteration 및 최종 role별 `.pkl`을 저장/load/clear한다. 원래 YAML/Python 정의 대신 실행 prompt에 suggestions를 붙인다. role 이름·파일 공유로 적용 범위가 넓어질 가능성은 구조상 추론이다.
- 자동 revision rollback·expiry·고정 용량은 미확인. 문서는 작은 모델의 JSON·평가·지침 준수 불안정을 경고한다. evaluator quality는 독립 일반화 평가가 아니다. AMP auto-train과 CLI 사람 피드백 경로를 섞지 않는다.

### LangMem: 저장과 prompt 개선을 제공하는 부품

- [개념 문서](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)는 semantic facts·episodic experiences·procedural instructions를 구분한다. 본 agent의 도구 또는 background manager가 기존 기억과 대화에서 항목을 추출·통합한다. profile/collection과 namespace는 범위를 표현하지만 사용자 인증·조직 권한은 앱이 강제해야 한다.
- SHA `48e3c11f5bb527282c7d5339c6a87a0b35abccfc`의 [background guide](https://github.com/langchain-ai/langmem/blob/48e3c11f5bb527282c7d5339c6a87a0b35abccfc/docs/docs/background_quickstart.md)는 `ReflectionExecutor`·debounce를 제공한다. [prompt optimizer](https://langchain-ai.github.io/langmem/guides/optimize_memory_prompt/)는 대화·score/comment·수정 결과로 새 문자열을 반환하며 `gradient`는 제안/적용을 두 호출로 나눈다. `max_reflection_steps`로 반복을 제한한다.
- 실제 적용·사람 승인·revision rollback·보존 기간은 앱 책임이다. `InMemoryStore`를 영속 DB로 오해하면 안 된다. 공식 설명은 과잉 추출의 precision 저하와 부족한 추출의 recall 저하를 지적한다. 저장 엔진만으로 학습 품질을 보장하지 않는다.

### Karpathy의 ‘system prompt learning’: 원문 귀속 보류

- 검색에서 [원글 후보](https://x.com/karpathy/status/1921368644069765486)는 찾았지만 직접 열람이 403으로 실패했다. 정확한 문구·날짜·구현 계약을 검증하지 못했으므로 인용·확정 귀속·기능 비교를 보류한다.
- [Letta의 고정 prompt](https://github.com/letta-ai/letta-code/blob/4c78cbe420d00beac1be5d63c4f7b99e7cd9554b/src/agent/prompts/letta.md)에 같은 표현이 쓰이는 것은 Letta의 지침 근거이지 Karpathy의 원문을 대신하지 않는다.

### 추가 평가 근거: 교훈 저장이 항상 개선을 뜻하지 않는다

- [EvoClawBench v1](https://arxiv.org/abs/2607.09711v1)은 100 tasks·502 sub-problems에서 직접 실행/사전 skill/첫 실행 후 skill을 비교한다. 저자 보고 nanobot MiniMax-M2.7은 PostSkill로 90.97%→94.50%지만 DeepSeek-V4-Pro는 77.77%→0.99%로 하락했다. 모델·실행 도구·fixture·authoring 비용 의존이며 현재 Hermes/OpenClaw의 학습 loop를 그대로 시험한 결과로 일반화하지 않는다.
- [WhisperBench/MemGhost v1](https://arxiv.org/abs/2607.05189v1)은 외부 이메일에서 오염된 기억을 쓰고 후속 행동에 사용하는 경로를 평가했다. 56 held-out 사례에서 저자 보고 end-to-end 성공률은 OpenClaw/GPT-5.4 87.5%, Claude Code SDK/Sonnet 4.6 71.4%. 특정 공격 실험이며 현재 고정 SHA의 방어를 재검증한 결과는 아니다. 사실/선호/절차 승격의 출처를 살필 근거다.

## 공통 패턴

1. **학습 대상이 다르다.** Aider/Roo의 사람이 관리하는 지침, Reflexion의 같은 문제 재시도, Hermes/OpenClaw의 후속 세션 skill, GEPA의 평가 기반 prompt 후보는 다른 메커니즘이다. 모델 가중치 갱신 없이도 ‘학습’이라 부르므로 저장물과 다음 적용 경로를 함께 봐야 한다.
2. **제안자·평가자·적용자가 분리될 수 있다.** ACE·GEPA·Voyager는 별도 역할의 평가를 쓰고 Hermes/OpenClaw/Letta/Devin은 foreground와 background를 나눈다. 별도 agent 검토가 사람 승인을 뜻하지 않으며, verifier가 모델뿐이면 잘못된 일반화를 다시 승인할 수 있다(구조에서의 추론).
3. **근거와 재사용 규칙을 구분한다.** Codex의 rollout 출처, Devin의 source session, Paperclip의 atomic fact, ACE의 bullet ID는 변경을 원래 사건과 연결한다. Hermes는 incident log를 skill에 계속 붙이지 않고 일반화한 규칙만 남긴다. 원본을 보존하면서 주입 context는 작게 유지하려는 공통 방향이다.
4. **권고와 강제를 구분해야 한다.** `retro`의 후보 제시·Paperclip skill은 문서 규약이다. Hermes의 dispatch whitelist, OpenClaw의 draft-only 도구 제한, Rakazo의 실제 approval gate는 코드다. Rakazo처럼 도구 설명과 `never` 모드의 실제 예외가 달라질 수도 있다.
5. **버전·범위·적용 시점은 별도 계약이다.** profile·repo·개인·agent·role·shared skill의 범위는 서로 다르다. namespace/폴더명만으로 권한 격리를 입증할 수 없다. 디스크 저장 즉시와 새 세션 재주입도 다르다. Git 가능·Git baseline·Git 이력·복원 UI를 같은 것으로 비교하면 안 된다.
6. **정리 자체도 실패할 수 있다.** 긴 문서·중복 skill·stale facts를 줄이되 ACE는 압축 중 지식 붕괴를 경고한다. OpenClaw는 사용을 계측하지 못하는 실행 도구에서 자동 archive를 끄고, Hermes는 pinned/cron 참조·복원 가능한 archive를 둔다. 사용 빈도가 낮다는 사실만으로 틀린 지식은 아니다.
7. **효과는 읽기/재사용까지 측정해야 한다.** 논문의 개선 수치는 task·모델·예산에 묶여 있고 제품 문서 대부분은 대조 수치를 주지 않는다. EvoClawBench의 악화 사례는 ‘더 많이 저장’과 ‘더 잘 수행’을 구분한다. prompt 비용·review 비용·재시도·잘못된 교훈의 후속 피해도 평가 범위다.

## 우리 제품(판 4)에 주는 시사점: 열린 질문

현행 [제품 불변 조건](../../AGENTS.md)·[공통 용어](../../GLOSSARY.md)·[목표 구조](../architecture.md)를 전제로 한다. 연구 목표 하나가 독립 조직 하나이고, 조직 간 자동 공유는 없으며 사용자가 지정한 내용만 공유한다. 초기 연구 승인과 사용자 최종 완료는 유지한다. 그 밖의 승인 대상은 조직별 정책(기본 꺼짐)으로 사용자가 정하고 제품 코드가 강제한다. 아래는 이 전제를 바꾸는 제안이나 판 4의 결정이 아니다.

| 판단할 질문 | 비교 근거 |
| --- | --- |
| Lead가 완료 산출물·검증 결과·작업자 보고 중 무엇을 근거로 실수를 판정할까? 작업자의 자기평가와 독립 검증을 어떻게 구분할까? | Voyager critic·ACE Reflector·Hermes의 미해결 실패 저장 금지 |
| Lead가 직접 수정할까, 같은 조직의 별도 검토/정리 역할에 맡길까? 불필요한 교훈을 만들지 않는 no-op 기준은 무엇일까? | `retro` 후보 제시·background review·Curator 분리 |
| 실패만 볼까, 시행착오 끝의 성공·사용자 교정도 볼까? 매 작업·iteration 누적·종료·idle·명시 요청 중 어떤 계기를 지원할까? | Hermes/OpenClaw의 주기·Devin/Letta의 background·CrewAI의 명시 training |
| 같은 작업의 다음 실행 시도에만 쓸 교훈과 여러 후속 작업의 조직 자산으로 승격할 교훈을 어떻게 나눌까? | Reflexion buffer와 장기 skill library의 차이 |
| 사실·선호·절차·도구 사용법·자동 검사 중 어디에 무엇을 둘까? 항목별 delta, 자유 문서, skill 중 단위는 무엇일까? | Hermes의 저장물 분리·ACE bullet·`retro` 검사 우선 |
| 교훈마다 근거 작업/실행 시도·산출물·검증 결과·제안자·적용 범위·반례를 어떻게 연결할까? 모델 내부 추론 대신 어떤 관찰 가능한 근거를 표시할까? | source session/rollout·fact ID·변경 feed |
| 에이전트 기억에서 조직 기억/지침으로 승격하는 권한은 누구에게 줄까? 같은 조직의 역할/작업 유형 범위를 표현하면서 다른 조직 접근과 사용자 지정 공유를 코드가 어떻게 강제할까? | repo/profile/user/agent/role 범위의 차이·공유 외부 skill 쓰기 |
| 조직별 승인 정책을 켠 변경만 Owner 결정 대기로 만들 때, 제안·agent 검토·사용자 승인·적용을 어떤 상태와 API로 구분할까? 정책 변경/조직 일시정지 뒤 늦은 background 적용은 어떻게 막을까? | draft-only 도구·whitelist·원래 권한 재검사 |
| 새 교훈의 반복 실수 감소를 어떤 재현 과제·후속 작업·반례로 검증할까? 검증 비용과 기대 절감 중 무엇을 기록할까? | GEPA validation·EvoClawBench의 악화·OpenHands 결과 지표 |
| 변경 전 버전·동시 편집 충돌·적용 시점은 어떻게 다룰까? 진행 중 작업자는 어떤 하네스 버전을 쓰며 재시작/재개 때 어떤 버전을 받을까? | Rakazo expected content·Devin stale write·frozen snapshot |
| 잘못된 교훈을 되돌릴 때 그 교훈에서 파생한 다른 기억/skill도 어떻게 찾을까? 원본 연구 기록은 보존하면서 파생 기억을 무효화할 수 있을까? | revision/ledger·source lineage·superseded facts |
| 크기·중복·상충·유효기간·오래된 환경 정보는 누가 정리할까? 낮은 사용 빈도와 무효화를 어떻게 구분하고 정리 실수는 어디까지 복원할까? | archive/restore·context collapse·계측 불가 시 정리 중단 |
| 사용자에게 변경 이유·diff·대기/적용 여부·후속 효과·rollback을 어떻게 보여 줄까? background 검토의 토큰/비용을 어느 작업·조직에 귀속할까? | Workshop/Devin 변경 카드·Hermes review usage |

## 확인하지 못한 것

- Rakazo는 공식 사이트↔저장소 연결로 식별했다. 반면 Karpathy 원글 후보는 직접 열람하지 못해 정확한 귀속·문구·날짜를 확정하지 않았다.
- 공식 문서와 고정 SHA 소스를 정적으로 읽었다. 설치·실제 모델 호출·제품 UI 조작·자동 학습/승인 우회·조직 격리·rollback의 실행 실험은 하지 않았다. 논문 수치도 재현하지 않았다. 비공개 내부 추론을 검토 로그로 사용한다고 가정하지 않았다.
- 제품 문서의 기능과 코드의 일부 경로를 확인한 것이며 전체 접근 통제 감사는 아니다. 특히 외부 경로/공유 저장소/직접 shell 쓰기가 각 제품의 학습 gate를 우회할 수 있는지 전수 검증하지 않았다.
- MetaGPT 후속 기능 전체의 SOP 자동 개정, Goose의 모든 local 기억 자동 주입, SWE-agent의 현재 모든 버전에서의 지속 학습은 확인하지 못했다. 확인된 경로에서 없다는 사실을 프로젝트 전체의 불가능으로 일반화하지 않는다.
- Claude Code·Cline·Roo·Aider·Goose·OpenHands·Agent Zero·SWE-agent·Devin·LangMem·CrewAI의 모든 용량/보존/복원 정책은 공개 자료가 충분하지 않았다. 개별 절에 미확인 범위를 표시했다. Letta 기존 memory blocks와 현재 MemFS의 전체 migration 계약도 미확인이다.
- 다수 제품의 ‘self-improving’ 설명은 장기적 반복 실수 감소의 대조 증거가 아니다. 연구 benchmark의 효과·공격 성공률은 해당 버전·모델·데이터 조건으로 한정했다. 현재 고정 SHA가 과거 논문과 같은 성능/취약성을 갖는지는 재검증하지 않았다.
