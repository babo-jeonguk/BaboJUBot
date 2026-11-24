# 코드 worker

구현·리뷰 수정의 제품 코드 수정을 worker에 맡기는 방법을 다룹니다. 언제 맡기는지는 [구현](implementation.md)·[리뷰 반영](review-fixes.md), 여러 agent 배치는 [개발 오케스트레이션](dev-orchestration.md)을 봅니다. **코드 worker**는 개발 도구이며 제품의 [작업자(Worker)](../../GLOSSARY.md)와 다릅니다.

## 1. 역할

| 모드 | 쓰는 때 | parent가 정하는 것 |
| --- | --- | --- |
| 구현 worker | parent가 시험을 커밋한 슬라이스의 제품 코드 | 요구·완료 동작·수정 범위·통과시킬 시험·검사 명령 |
| 리뷰 대응 worker | 검증된 리뷰 finding의 제품 코드 | finding 판정·원인·수정 방향·회귀 테스트 |

- parent는 설계·원인 분석·재현을 맡고, 시험·문서·의존성·검사 설정·개발 스크립트(`scripts/`)를 직접 고칩니다. 시험은 worker를 띄우기 전에 커밋합니다.
- worker는 brief가 허용한 제품 코드만 고치고 설계를 고르지 않습니다. 시험·lint·타입 검사를 직접 돌려 통과할 때까지 고칩니다. 반복은 brief의 패키지별 명령으로 하고, 보고 직전에 `pnpm verify:changed --base <시험 커밋>`을 한 번 통과시킵니다.
- worker는 시험·단언·검사 설정·검사 명령을 고치거나 끄지 않습니다. 시험이 틀려 보이거나 brief 밖 변경·설계 판단·허용되지 않은 명령이 필요하면 멈추고 보고합니다.
- 인수·커밋·push·PR과 추가 agent 생성은 parent만 합니다.

시험·검사 설정 수정 거부와 허용 명령은 [dev-worker](../../.opencode/agents/dev-worker.md) 권한이 강제하고, 실제 변경은 §6의 확인 스크립트가 다시 확인합니다. 거부하는 시험 파일은 시험 범위([test-files.mjs](../../scripts/test-files.mjs) `testFiles`) 전부이고 제품 코드는 막지 않습니다. 시험 도움 이름(`testing`·`*-support` 등)은 시험 범위가 가리키는 패키지·폴더에서만 거부해, 다른 곳의 같은 이름 제품 파일은 고칠 수 있습니다. 권한 파일은 그 범위를 가져올 수 없어 [권한 범위 검사](../../.agents/scripts/worker-permissions.test.ts)가 맞춥니다. 나머지는 이 계약과 parent의 diff 검토로 지킵니다.

## 2. 모델

순서는 [worker-models.json](../../.agents/worker-models.json)의 `primary` → `fallback` 순서입니다. 모델 ID는 이 JSON에만 두고 문서·brief에 복사하지 않습니다. 마지막 무료 모델은 계속 제공된다는 보장이 없어 마지막 수단으로만 씁니다.

## 3. brief

- 이슈/PR·회차, 시험을 커밋한 base SHA, 역할(구현/리뷰 대응). 리뷰 대응이면 finding ID·축
- 관찰 가능한 완료 동작, 통과시킬 시험과 시험·타입 검사(`pnpm --filter <패키지> run typecheck:src`)·lint 실행 명령(`pnpm exec eslint <파일>`), 보고 직전에 돌릴 `pnpm verify:changed --base <시험 커밋>`
- 고칠 파일 패턴·심볼과 지킬 구조 제약
- 확인된 원인과 `file:line`, 바꿀 구조, 지울 guard
- 보고 형식: 바꾼 파일, 실행한 명령과 결과, 실패·미검증 사항
- 멈춤 조건: 시험 결함, 설계 충돌, brief 밖 변경, 허용되지 않은 명령, 원인 불명

## 4. 실행

두 경로 모두 [dev-worker](../../.opencode/agents/dev-worker.md) agent로 돌며, 셸 허용 명령·단계 상한·agent 호출 금지는 이 파일이 정합니다. 경로에 상관없이 한 폴더에서 파일을 고치는 agent는 하나만 두고, 도는 동안 그 폴더에서 Git 작업을 하지 않습니다.

**스크립트:** checkout 루트에서 [run-worker.ts](../../.agents/scripts/run-worker.ts)를 background로 띄웁니다. Claude Code는 `run_in_background`·`timeout: 7200000`으로 띄우고 완료 알림으로만 깨어나며, Codex도 background로 띄우고 기다립니다. 스크립트는 최소 안전망 [opencode-worker.json](../../.agents/opencode-worker.json)을 함께 적용합니다.

```bash
node .agents/scripts/run-worker.ts --model <provider/model> --title "pr-<N> <원인>" \
  --out <출력>.jsonl (--brief <지침 파일> | --message "<메시지>") [--session <sessionID>] [--limit <분>]
```

출력 JSONL·stderr(`.err`)·brief는 Git 제외 로컬 폴더에 두고, 제품 런타임 데이터와 섞지 않습니다. 스크립트는 지침(`--brief` 파일 내용이나 `--message`)을 opencode의 명령 인수가 아니라 표준 입력으로 넘깁니다. Windows에서 `.cmd`로 깔린 opencode는 `cmd.exe`가 띄워 인수가 첫 줄바꿈에서 끊기므로, 여러 줄 지침도 그대로 닿게 합니다.

**Paseo:** parent가 `worker-deepseek` profile 값을 옮겨 `create_agent`로 subagent를 띄웁니다. 옮기는 방법은 [개발 오케스트레이션 §3](dev-orchestration.md#3-agent-띄우기)을 봅니다.

## 5. 멈춤과 재시도

| 종료 코드 | 뜻 | 다음 일 |
| --- | --- | --- |
| 0 | `error` 이벤트 없이 끝남 | 마지막 보고와 diff 검토(§6) |
| 2 | `error` 이벤트(rate limit·quota·429 등) | 그 회차에서 그 모델을 다시 쓰지 않고 다음 모델로. session이 있으면 `--session <id> --message "Continue the brief from where you stopped."`, 없으면 같은 brief |
| 3 | 3분(`--start-check`) 안에 session이 생기지 않아 한 번 다시 띄웠는데도 실패 | worker를 더 띄우지 않고 parent가 직접 수정 |
| 4 | `error` 이벤트 없이 OpenCode 실패, 띄우지 못함(감독 실행기를 쓸 수 없으면 worker를 띄우지 않음), 지침을 worker에 보내지 못함(상태 줄 `could not send the brief: <코드>`, worker가 읽기 전에 끝났거나 읽지 않은 채 멈춤. 모델 문제가 아니므로 다음 모델로 넘어가지 않음), 시간 한도(`--limit`, 기본 110분)에 닿아 멈춤, 또는 worker의 프로세스 트리가 끝난 것을 확인하지 못함. 한도는 다시 띄우기를 포함한 호출 전체 상한이다. worker는 제품의 공용 실행(`@babojubot/process` `launchTree`)으로 띄우고, 모든 시도는 그 트리의 끄기 결과로 끝난다(세션 확인·한도·runner가 받은 신호로 멈출 때도, worker가 스스로 끝나 남긴 명령을 끌 때도). 끄기를 확인하지 못하면 다시 띄우지 않고 이유를 상태에 남긴다(아직 보내던 지침은 기다리지 않고 접는다. 읽을 쪽이 남았을 수 있어 쓰기가 끝나지 않을 수 있다). 요약을 표준 출력에 다 쓰지 못한 때도 4다. runner가 신호로 멈췄으면 128+신호 번호로 끝난다 | `.err`·diff를 보고 판단. 트리를 확인하지 못했으면 남은 프로세스를 먼저 정리 |

모든 모델이 한도면 parent가 직접 고치고 이유를 보고에 남깁니다.

## 6. 검토·인수

- 스크립트 요약(`status`·`session`·`written`·`denied`·`errors`·마지막 보고, Paseo는 마지막 보고)으로 worker의 검사 결과와 미검증 사항을 확인합니다.
- 커밋 전에 [check-worker-change.ts](../../.agents/scripts/check-worker-change.ts)로 슬라이스의 핵심 시험과 `pnpm verify:changed --base <시험 커밋>`을 다시 돌립니다. `verify:changed`는 worker가 바꾼 파일로 lint 대상과 타입 검사할 패키지(그 패키지를 쓰는 패키지 포함)를 정해 돌리므로, brief에서 빠진 검사 범위도 여기서 잡힙니다. worker도 보고 직전에 같은 명령을 돌리지만, 인수는 parent가 다시 돌린 결과로 판단합니다. 이 스크립트는 판단 근거를 모을 뿐이고, 받아들일지는 parent가 정합니다. `--allow`·`--reported`·`--test`는 값마다 반복합니다. 이 스크립트는 HEAD가 base 그대로인지, 바뀐 파일이 brief 범위 안이고 worker가 보고한 목록과 같은지, 시험·검사 설정이 그대로인지 시험 전후로 확인합니다. 보호 파일은 base 커밋의 권한으로 판정하고, 성공하면 한 줄만 출력합니다. Git이 무시하는 파일은 보지 않습니다.

  ```bash
  node .agents/scripts/check-worker-change.ts --base <시험 커밋> --allow '<파일 패턴>' \
    --reported <worker가 보고한 파일> --test '<핵심 시험 명령>' --test 'pnpm verify:changed --base <시험 커밋>'
  ```

- `git diff`로 원인이 없어졌는지, 지정한 구조를 지켰는지 확인합니다. 추가 검사 범위는 [검증 기준](verification.md#실행-시점)을 따릅니다.
- 거절하면 같은 session(스크립트는 `--session`, Paseo는 같은 agent ID)에 구체적 이유를 보냅니다. 두 번 거절하면 parent가 직접 고칩니다.

## 7. 데이터 보호

- brief와 diff는 worker 모델 제공자로 전송됩니다. `.env*`, 자격 증명, 실제 연구 데이터는 넣지 않습니다.
- DeepSeek V4.1 Flash의 ZDR(보관 안 함) 약정은 2026-11-30까지로 확인했습니다(2026-11-05 회고). 그 전에 갱신을 확인하고, 만료되면 다른 모델로 바꾸거나 worker를 멈춥니다.
- DeepSeek을 쓰려면 OpenCode Go workspace의 region이 Global이어야 합니다.
