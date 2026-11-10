# 개발 오케스트레이션

개발 workflow에서 Paseo로 여러 agent를 배치·감독할 때 적용합니다. 이 문서의 parent·worker·auditor는 개발 도구 역할이며 제품의 [Lead·작업자](../../GLOSSARY.md)와 다릅니다. worker 한 명의 계약은 [코드 worker](worker.md), 검증은 [검증](verification.md), finding 처리는 [리뷰 반영](review-fixes.md), merge는 [PR 병합](pr-merge.md)을 따릅니다.

## 1. 세션 구성

한 이슈의 상위 대화 네 개는 같은 workspace(같은 폴더)에서 진행합니다. 조사 문서와 `.reference-cache`, 최종 head가 이어져야 하기 때문입니다.

| 상위 세션 | 역할 | 모델 | subagent |
| --- | --- | --- | --- |
| research | `/reference-first` 조사와 이슈 댓글 | Codex GPT-6.1-Sol | 없음 |
| implement | `/implement`, 테스트, 커밋, PR | Claude Opus 5.5 | 슬라이스별 `dev-worker` |
| review-fix | 외부 리뷰 finding 판정과 근본 원인 수정 | Claude Opus 5.5 | `dev-worker` |
| merge | merge 전 문서·이슈 감사와 merge | Claude Opus 5.5 | `dev-doc-worker`, Codex auditor 2개 |

- 슬라이스 worker, fix worker, auditor, 문서 worker는 상위 대화가 아니라 **subagent**입니다.
- 다른 작업이 같은 폴더를 쓰고 있으면 Paseo로 worktree workspace를 새로 만들어 진행합니다. 한 폴더에서 파일을 고치는 agent는 동시에 하나만 둡니다.
- research는 Codex 한 세션으로 진행합니다.

Paseo worktree를 만들면 [paseo.json](../../paseo.json)의 setup이 `pnpm install --frozen-lockfile`을 실행합니다. worktree는 base branch에서 만들어지므로 `.opencode/agents/`와 `paseo.json`이 base에 커밋돼 있어야 worker mode와 setup이 적용됩니다.

## 2. profile

| profile | provider/model | mode | 용도 |
| --- | --- | --- | --- |
| `research-codex-main` | `codex` / `gpt-6.1-sol` | `auto-review` | `/reference-first`, 이슈 댓글 |
| `research-codex-sub` | `codex-sub` / `gpt-6.1-sol` | `auto-review` | 보조 계정 research |
| `parent-claude-main` | `claude-main` / `claude-opus-5-5` | `auto` | implement·review-fix·merge |
| `parent-claude-sub` | `claude-sub` / `claude-opus-5-5` | `auto` | 보조 계정 parent |
| `worker-deepseek` | `opencode` / `opencode-go/deepseek-v4.1-flash` | `dev-worker` | 슬라이스·fix worker |
| `doc-worker-deepseek` | `opencode` / `opencode-go/deepseek-v4.1-flash` | `dev-doc-worker` | 승인된 문서 수정 |
| `auditor-codex-main` | `codex` / `gpt-6.1-sol` | `full-access` | docs/issue 감사 |
| `auditor-codex-sub` | `codex-sub` / `gpt-6.1-sol` | `full-access` | 보조 계정 감사 |

auditor를 `full-access`로 띄우는 이유: 이 개발 PC(Ubuntu 24.04)는 AppArmor 때문에 Codex 격리가 시작되지 않아, 다른 mode에서는 명령마다 승인 요청이 생깁니다. 파일을 고치지 않는다는 것은 지침과 사후 확인으로 지킵니다.

profile은 앱에서 고르는 preset입니다. Paseo 도구 `create_agent`와 CLI `paseo run`에는 profile 인자가 없으므로, parent는 아래 값을 직접 넘기고 subagent를 parent의 현재 workspace에 만듭니다.

| 띄울 agent | `create_agent` 값 |
| --- | --- |
| 슬라이스·fix worker | provider `opencode/opencode-go/deepseek-v4.1-flash`, `settings.modeId: dev-worker`, `settings.features.auto_accept: false` |
| 문서 worker | provider `opencode/opencode-go/deepseek-v4.1-flash`, `settings.modeId: dev-doc-worker`, `settings.features.auto_accept: false` |
| auditor | provider `codex/gpt-6.1-sol` 또는 `codex-sub/gpt-6.1-sol`, `settings.modeId: full-access`, `settings.thinkingOptionId: high`, prompt에 “파일을 고치지 않는다” 포함 |

피드백은 같은 agent ID에 `send_agent_prompt`로 보냅니다. worker 권한은 [dev-worker](../../.opencode/agents/dev-worker.md)와 [dev-doc-worker](../../.opencode/agents/dev-doc-worker.md)가 정합니다.

## 3. research

1. Codex가 `/reference-first #<n>`으로 조사하고 이슈 댓글을 씁니다.
2. 조사는 `.reference-cache/`와 `docs/research/`에 남깁니다.
3. 제품 코드는 고치지 않습니다.

research agent의 mode는 `.reference-cache`와 `docs/research`에 쓸 수 있어야 합니다.

## 4. implement

1. Claude가 `/implement #<n>`을 따르고, 이슈 workspace에서 branch와 테스트를 준비합니다.
2. 확정된 슬라이스마다 parent가 brief를 쓰고 `dev-worker` subagent에 맡깁니다.
3. worker가 끝나면 parent가 diff와 테스트를 확인하고, 필요하면 같은 worker session에 피드백을 보냅니다.
4. parent가 커밋하고 PR을 만듭니다.
5. 외부 리뷰 요청문 출력은 기존 [구현 절차](implementation.md)를 그대로 유지합니다.

worker에는 설계·테스트·문서·의존성 변경 여부를 고르게 하지 않습니다. parent가 brief에 그 범위를 정합니다.

## 5. review-fix

1. 외부 리뷰 결과를 review-fix Claude에게 전달합니다.
2. Claude가 finding별로 이번 회차 수정 여부와 근본 원인을 판정합니다.
3. parent가 fix brief를 쓰고 **새 `dev-worker` subagent**를 띄웁니다.
4. worker 수정 뒤 parent가 diff와 테스트를 확인합니다.
5. 두 번 거절하면 parent가 직접 고칩니다.

fix brief에는 finding ID·축·회차, 확인된 원인과 `file:line`, 바꿀 구조, 지울 guard, 통과시킬 테스트, 고칠 파일, 보고 형식을 적습니다.

## 6. merge

merge Claude는 같은 workspace에서 아래 순서로 진행합니다.

1. `docs` auditor와 `issue` auditor를 subagent로 띄웁니다. 둘 다 prompt에 “파일을 고치지 않는다”를 넣습니다. auditor 계정(main/sub)은 사용자가 merge를 요청할 때 정합니다.
2. auditor가 끝나면 parent가 `git status --short`로 감사 전과 달라진 파일이 없는지 확인하고, finding을 **갱신 / 유지 / 후속 처리**로 분류합니다.
3. 승인된 문서 수정만 `dev-doc-worker` subagent에 맡깁니다.
4. parent가 문서 diff와 `pnpm check`를 확인합니다.
5. 연결 이슈·parent/epic·후속 이슈를 parent가 갱신합니다. 이슈 close는 merge 뒤에 합니다.
6. 최종 head 검증과 merge는 [PR 병합 §3·§4](pr-merge.md#3-최종-head-검증)를 따릅니다.
7. merge 결과를 이슈에 남깁니다. 이 이슈용으로 Paseo가 만든 worktree workspace이면 `paseo workspace archive <workspace-id>`로 정리합니다. 원래 checkout 폴더의 workspace는 archive하지 않습니다. archive는 그 workspace의 대화를 모두 보관 처리하므로 다른 작업의 대화까지 닫힙니다.
8. 다른 workspace가 쓰는 branch를 보존하고, merge한 branch만 삭제합니다.

auditor 결과는 **CI·테스트를 대신하지 않습니다.** Paseo 감사는 merge 판단의 근거이고, 최종 gate는 CI와 parent입니다.

## 7. Paseo MCP 정책

Paseo MCP는 **Claude parent에게만** 허용합니다. 전역 주입을 켜고, 나머지 provider는 차단합니다.

```json
{
  "daemon": { "mcp": { "injectIntoAgents": true } },
  "agents": {
    "providers": {
      "codex": { "paseoTools": { "enabled": false } },
      "codex-sub": { "paseoTools": { "enabled": false } },
      "codex-reserve": { "paseoTools": { "enabled": false } },
      "opencode": { "paseoTools": { "enabled": false } },
      "kiro": { "paseoTools": { "enabled": false } }
    }
  }
}
```

`claude-main`과 `claude-sub`에는 `paseoTools`를 넣지 않습니다. worker·auditor는 Paseo 도구를 받지 않습니다. provider별 정책은 `~/.paseo/config.json`에서 정하고 `paseo reload` 뒤 새 세션에서 적용됩니다.

## 8. 데이터와 안전

- brief와 diff는 OpenCode Go·DeepSeek·Claude·Codex로 전송됩니다. `.env`, 자격 증명, 실제 연구 데이터는 넣지 않습니다.
- worker와 doc worker는 `.env`를 읽거나 쓰지 않습니다.
- auditor는 파일을 고치지 않는다는 지침으로 띄우고, 끝난 뒤 parent가 `git status --short`로 확인합니다.
- E2E는 고정 포트(`3199`/`5199`)를 쓰므로 worktree 간 동시에 실행하지 않습니다.
