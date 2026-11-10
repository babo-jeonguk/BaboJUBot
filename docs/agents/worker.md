# 코드 worker

구현·리뷰 수정의 제품 코드 수정을 worker에 맡기는 방법을 다룹니다. 언제 맡기는지는 [구현](implementation.md)·[리뷰 반영](review-fixes.md), 여러 agent 배치는 [개발 오케스트레이션](dev-orchestration.md)을 봅니다. **코드 worker**는 개발 도구이며 제품의 [작업자(Worker)](../../GLOSSARY.md)와 다릅니다.

## 1. 역할

| 모드 | 쓰는 때 | parent가 정하는 것 |
| --- | --- | --- |
| 구현 worker | 확정된 구현 슬라이스의 제품 코드 | 요구·완료 동작·수정 범위·검증 |
| 리뷰 대응 worker | 검증된 리뷰 finding의 제품 코드 | finding 판정·원인·수정 방향·회귀 테스트 |

- parent는 설계·원인 분석·재현·테스트·문서·의존성 변경 여부를 정하고 brief에 적습니다. worker가 테스트·문서를 고쳐야 하면 대상 파일과 이유를 brief에 넣습니다.
- worker는 brief에 적힌 파일만 고치고 설계를 고르지 않습니다. brief가 모호하거나 허용되지 않은 명령이 필요하면 멈추고 보고합니다.
- worker의 보고와 테스트 실행은 증거의 일부입니다. 최종 검토·검사·커밋·PR은 parent가 합니다.

## 2. 모델

순서는 [worker-models.json](../../.agents/worker-models.json)의 `primary` → `fallback` 순서입니다. 모델 ID는 이 JSON에만 두고 문서·brief에 복사하지 않습니다. 마지막 무료 모델은 계속 제공된다는 보장이 없어 마지막 수단으로만 씁니다.

## 3. brief

- 이슈/PR·회차, base SHA, 역할(구현/리뷰 대응). 리뷰 대응이면 finding ID·축
- 관찰 가능한 완료 동작, 통과시킬 테스트와 실행 명령
- 고칠 파일·심볼과 고치면 안 되는 파일
- 확인된 원인과 `file:line`, 바꿀 구조, 지울 guard
- 테스트·문서·의존성 변경이 필요하면 그 파일과 이유
- 보고 형식: 바꾼 파일, 실행한 명령과 출력 끝, 실행하지 못한 명령
- 멈춤 조건: brief 밖 변경, 허용되지 않은 명령, 원인 불명

## 4. 실행

두 경로 모두 [dev-worker](../../.opencode/agents/dev-worker.md) agent로 돌며, 셸 허용 명령·단계 상한·agent 호출 금지는 이 파일이 정합니다. 경로에 상관없이 한 폴더에서 파일을 고치는 agent는 하나만 두고, 도는 동안 그 폴더에서 Git 작업을 하지 않습니다.

**스크립트:** checkout 루트에서 [run-worker.mjs](../../.agents/scripts/run-worker.mjs)를 background로 띄웁니다. Claude Code는 `run_in_background`·`timeout: 7200000`으로 띄우고 완료 알림으로만 깨어나며, Codex도 background로 띄우고 기다립니다. 스크립트는 최소 안전망 [opencode-worker.json](../../.agents/opencode-worker.json)을 함께 적용합니다.

```bash
node .agents/scripts/run-worker.mjs --model <provider/model> --title "pr-<N> <원인>" \
  --out <출력>.jsonl (--brief <지침 파일> | --message "<메시지>") [--session <sessionID>]
```

출력 JSONL·stderr(`.err`)·brief는 Git 제외 로컬 폴더에 두고, 제품 런타임 데이터와 섞지 않습니다.

**Paseo:** parent가 `dev-worker` mode의 subagent로 띄웁니다. 넘길 값은 [개발 오케스트레이션 §3](dev-orchestration.md#3-agent-띄우기)에 있습니다.

## 5. 멈춤과 재시도

| 종료 코드 | 뜻 | 다음 일 |
| --- | --- | --- |
| 0 | `error` 이벤트 없이 끝남 | 마지막 보고와 diff 검토(§6) |
| 2 | `error` 이벤트(rate limit·quota·429 등) | 그 회차에서 그 모델을 다시 쓰지 않고 다음 모델로. session이 있으면 `--session <id> --message "Continue the brief from where you stopped."`, 없으면 같은 brief |
| 3 | 3분(`--start-check`) 안에 session이 생기지 않아 한 번 다시 띄웠는데도 실패 | worker를 더 띄우지 않고 parent가 직접 수정 |
| 4 | `error` 이벤트 없이 OpenCode 실패 | `.err`·diff를 보고 판단 |

모든 모델이 한도면 parent가 직접 고치고 이유를 보고에 남깁니다.

## 6. 검토·인수

- 스크립트 요약(`status`·`session`·`written`·`denied`·`errors`·마지막 보고, Paseo는 마지막 보고)과 `git diff`로 brief 밖 변경이 없는지 확인합니다. brief에 없는 테스트·문서 변경은 거절합니다.
- 원인이 없어졌는지 확인하고, 회귀·영향 범위 검사를 [검증 기준](verification.md)에 따라 parent가 직접 실행합니다.
- 거절하면 같은 session(스크립트는 `--session`, Paseo는 같은 agent ID)에 구체적 이유를 보냅니다. 두 번 거절하면 parent가 직접 고칩니다.

## 7. 데이터 보호

- brief와 diff는 worker 모델 제공자로 전송됩니다. `.env*`, 자격 증명, 실제 연구 데이터는 넣지 않습니다.
- DeepSeek V4.1 Flash의 ZDR(보관 안 함) 약정은 2026-11-30까지로 확인했습니다(2026-11-05 회고). 그 전에 갱신을 확인하고, 만료되면 다른 모델로 바꾸거나 worker를 멈춥니다.
- DeepSeek을 쓰려면 OpenCode Go workspace의 region이 Global이어야 합니다.
