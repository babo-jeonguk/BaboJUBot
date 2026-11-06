# 코드 worker

구현·리뷰 수정의 제품 코드 수정을 OpenCode에 맡길 때 적용합니다. 이 문서의 **코드 worker**는 제품의 [작업자(Worker)](../../GLOSSARY.md)와 다른 개발 도구입니다. 제품 용어는 GLOSSARY를 따릅니다.

## 1. 역할

코드 worker는 한 번에 한 가지 일을 합니다.

| 모드 | 쓰는 때 | parent가 정하는 것 | worker가 하는 것 |
| --- | --- | --- | --- |
| 구현 worker | 확정된 구현 슬라이스의 제품 코드를 쓸 때 | 요구·완료 동작·수정 범위·검증 | brief에 적힌 파일 수정과 보고 |
| 리뷰 대응 worker | 검증된 리뷰 finding의 제품 코드를 고칠 때 | finding 판정·원인·수정 방향·회귀 테스트 | brief에 적힌 파일 수정과 보고 |

- parent는 설계·원인 판단·테스트·문서·의존성 변경 여부를 정하고 brief에 적습니다. 테스트나 문서를 worker가 고쳐야 하면 대상 파일과 이유를 brief에 포함합니다.
- worker는 brief에 없는 파일을 고치거나 설계를 고르지 않습니다. brief가 모호하거나 허용되지 않은 명령이 필요하면 멈추고 보고합니다.
- worker의 보고와 테스트 실행은 증거의 일부일 뿐입니다. 최종 검토·검사·커밋·PR은 parent가 합니다.

## 2. 모델

모델 우선순위는 [`.agents/worker-models.json`](../../.agents/worker-models.json)을 기준으로 합니다.

1. `primary`: `opencode-go/deepseek-v4.1-flash`
2. `fallback`: `opencode-go/glm-5.3-flash`
3. 마지막: `opencode/deepseek-v4.1-flash-free`

OpenCode Go 한도가 소진되면 무료 모델까지 내려갑니다. 무료 모델은 지속 제공이 보장되지 않으므로 마지막 수단으로만 씁니다. `run-worker.mjs`는 한 번에 한 모델만 받으므로, parent가 위 순서대로 `--model`을 넘깁니다.

- 종료 코드 2(`error` 이벤트: rate limit·quota·429 등)이면 그 회차에서는 그 모델을 다시 쓰지 않고 다음 모델로 넘어갑니다. session이 있으면 `--session <sessionID> --message "Continue the brief from where you stopped."`로, 없으면 같은 brief로 다음 모델을 띄웁니다.
- 세 모델이 모두 한도면 worker를 더 띄우지 않고 parent가 직접 고치며, 이유를 보고에 남깁니다.
- 모델 ID가 바뀌면 이 JSON만 고칩니다. 문서·handoff에 ID를 복사하지 않습니다.

## 3. brief

brief에는 worker가 설계를 고르지 않도록 다음을 적습니다.

- 이슈/PR·회차, base SHA, 역할(구현/리뷰 대응)
- 관찰 가능한 완료 동작과 통과시킬 테스트·실행 명령
- 고칠 파일·심볼, 고치면 안 되는 파일
- 확인된 원인과 `file:line`, 바꿀 구조, 지울 guard
- 테스트·문서·의존성 변경이 필요하면 그 파일과 이유
- 보고 형식: 바꾼 파일, 실행한 명령과 출력 끝, 실행 못 한 명령
- 멈춤 조건: brief 밖 변경, 허용되지 않은 명령, 원인 불명

## 4. 실행

checkout 루트에서 [run-worker.mjs](../../.agents/scripts/run-worker.mjs)를 background로 띄웁니다. 스크립트가 `OPENCODE_CONFIG`를 [opencode-worker.json](../../.agents/opencode-worker.json)으로 고정하고 `opencode run --standalone --auto --format json`을 실행합니다. 출력 JSONL은 `--out`에, stderr는 같은 이름의 `.err`에 남습니다.

```bash
node .agents/scripts/run-worker.mjs --model <provider/model> --title "pr-<N> <원인>" \
  --out <출력>.jsonl (--brief <지침 파일> | --message "<메시지>") [--session <sessionID>]
```

- 권한은 `opencode-worker.json`이 정합니다. `.env*`·git·웹·checkout 밖은 거절하고, 셸은 대상 패키지 vitest·typecheck만 허용합니다.
- Claude Code는 `run_in_background`와 `timeout: 7200000`으로 실행하고 완료 알림으로만 깨어납니다. Codex도 background로 띄우고 완료를 기다립니다.
- 한 checkout에서는 worker를 하나씩 띄우고, 도는 동안 Git 작업을 하지 않습니다.
- 출력은 `.babojubot/` 아래에 두며 Git에 넣지 않습니다.

## 5. 멈춤과 재시도

스크립트가 3분(`--start-check`) 안에 session이 생기지 않으면 process group을 멈추고 같은 인자로 한 번 다시 띄웁니다. 두 번 다 session이 없으면 종료 코드 3으로 끝나며, worker를 더 띄우지 않고 parent가 같은 brief로 직접 고칩니다. OpenCode가 `error` 이벤트 없이 실패하면 종료 코드 4이며 `.err`와 diff를 보고 판단합니다.

| 종료 코드 | 뜻 | 다음 일 |
| --- | --- | --- |
| 0 | `error` 이벤트 없이 끝남 | 요약의 마지막 보고와 diff를 검토 |
| 2 | `error` 이벤트 | 다음 모델로 이어서 실행 |
| 3 | 두 번 다 session이 생기지 않음 | parent가 직접 수정 |
| 4 | `error` 이벤트 없이 OpenCode 실패 | `.err`·diff 확인 후 판단 |

## 6. 검토·인수

- 스크립트 요약(`status`·`session`·`written`·`denied`·`errors`·마지막 보고)과 `git diff`로 brief 밖 파일 변경이 없는지 확인합니다.
- 허용한 테스트·문서 변경은 brief와 대조합니다. brief에 없는 테스트·문서 변경은 거절합니다.
- 원인이 없어졌는지 확인하고 회귀·영향 범위 검사를 parent가 직접 실행합니다.
- 거절하면 요약의 `session:` 값을 `--session`으로 넘겨 같은 session에 구체적 이유를 보냅니다. 두 번 거절하면 parent가 직접 고칩니다.

## 7. 데이터 보호

- brief와 코드 diff는 OpenCode Go와 그 모델 제공자(DeepSeek·GLM)로 전송됩니다. `.env*`, 자격 증명, 실제 연구 데이터는 넣지 않습니다.
- DeepSeek V4.1 Flash의 ZDR(보관 안 함) 약정은 2026-11-05 회고에서 2026-11-30까지로 확인했습니다. 그 전에 갱신을 확인하고, 만료되면 GLM/무료 모델로 바꾸거나 worker를 멈춥니다.
- DeepSeek을 쓰려면 OpenCode Go workspace의 region이 Global이어야 합니다. 콘솔에서 확인합니다.
