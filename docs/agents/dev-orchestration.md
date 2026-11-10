# 개발 오케스트레이션

Paseo로 여러 agent를 배치·감독하는 방법을 다룹니다. 단계별 할 일은 [구현](implementation.md)·[리뷰 반영](review-fixes.md)·[PR 병합](pr-merge.md), worker 한 명의 계약은 [코드 worker](worker.md)를 봅니다. parent·worker·auditor는 개발 도구 역할이며 제품의 [Lead·작업자](../../GLOSSARY.md)와 다릅니다.

## 1. 세션 구성

한 이슈의 상위 대화는 같은 workspace(같은 폴더)에서 진행합니다. 조사 기록과 최종 head가 이어져야 하기 때문입니다.

| 상위 세션 | 역할 | 모델 | subagent |
| --- | --- | --- | --- |
| research | `/reference-first` 조사·이슈 댓글. 제품 코드는 고치지 않음 | Codex GPT-6.1-Sol | 없음 |
| implement | `/implement`, 테스트, 커밋, PR | Claude Opus 5.5 | 슬라이스마다 `dev-worker` |
| review-fix | finding 판정과 근본 원인 수정 | Claude Opus 5.5 | fix brief마다 새 `dev-worker` |
| merge | merge 전 문서·이슈 감사와 merge | Claude Opus 5.5 | auditor 2개, `dev-doc-worker` |

- worker·auditor·문서 worker는 상위 대화가 아니라 **subagent**로, parent의 현재 workspace에 만듭니다.
- 다른 작업이 같은 폴더를 쓰면 Paseo로 worktree workspace를 새로 만듭니다. 파일을 고치는 agent는 폴더당 하나입니다.
- research mode는 로컬 조사 캐시와 `docs/research`에 쓸 수 있어야 합니다.
- worktree는 base branch에서 만들어지므로 `.opencode/agents/`와 [paseo.json](../../paseo.json)이 base에 커밋돼 있어야 worker mode와 setup(`pnpm install --frozen-lockfile`)이 적용됩니다.

## 2. profile

앱에서 고르는 preset입니다.

| profile | provider/model | mode | 용도 |
| --- | --- | --- | --- |
| `research-codex-main` / `-sub` | `codex` / `codex-sub`, `gpt-6.1-sol` | `auto-review` | research |
| `parent-claude-main` / `-sub` | `claude-main` / `claude-sub`, `claude-opus-5-5` | `auto` | implement·review-fix·merge |
| `worker-deepseek` | `opencode`, `opencode-go/deepseek-v4.1-flash` | `dev-worker` | 슬라이스·fix worker |
| `doc-worker-deepseek` | `opencode`, `opencode-go/deepseek-v4.1-flash` | `dev-doc-worker` | 승인된 문서 수정 |
| `auditor-codex-main` / `-sub` | `codex` / `codex-sub`, `gpt-6.1-sol` | `full-access` | docs·issue 감사 |

## 3. agent 띄우기

`create_agent`와 `paseo run`에는 profile 인자가 없으므로 parent가 아래 값을 직접 넘깁니다. 피드백은 같은 agent ID에 `send_agent_prompt`로 보냅니다.

| 띄울 agent | `create_agent` 값 |
| --- | --- |
| 슬라이스·fix worker | provider `opencode/opencode-go/deepseek-v4.1-flash`, `settings.modeId: dev-worker`, `settings.features.auto_accept: false` |
| 문서 worker | provider `opencode/opencode-go/deepseek-v4.1-flash`, `settings.modeId: dev-doc-worker`, `settings.features.auto_accept: false` |
| auditor | provider `codex/gpt-6.1-sol` 또는 `codex-sub/gpt-6.1-sol`, `settings.modeId: full-access`, `settings.thinkingOptionId: high`, prompt에 “파일을 고치지 않는다” 포함 |

worker 권한은 [dev-worker](../../.opencode/agents/dev-worker.md)와 [dev-doc-worker](../../.opencode/agents/dev-doc-worker.md)가 정합니다.

## 4. auditor 쓰기

merge 전 감사에 docs auditor와 issue auditor를 띄웁니다. 계정(main/sub)은 사용자가 merge를 요청할 때 정합니다.

- 이 개발 PC(Ubuntu 24.04)에서는 AppArmor 때문에 Codex 격리가 시작되지 않아, 다른 mode는 명령마다 승인 요청이 생깁니다. 그래서 `full-access`로 띄우고 “파일을 고치지 않는다”는 지침과 사후 확인으로 지킵니다.
- 감사가 끝나면 `git status --short`로 감사 전과 달라진 파일이 없는지 확인하고, finding을 **갱신 / 유지 / 후속 처리**로 분류합니다.
- 승인된 문서 수정만 `dev-doc-worker`에 맡기고, parent가 문서 diff와 `pnpm check`를 확인합니다.
- auditor 결과는 merge 판단의 근거이며 **CI·테스트를 대신하지 않습니다.**

## 5. Paseo MCP 정책

Paseo MCP는 **Claude parent에게만** 허용합니다. `~/.paseo/config.json`에서 전역 주입을 켜고 나머지 provider는 차단합니다. `claude-main`·`claude-sub`에는 `paseoTools`를 넣지 않으며, `paseo reload` 뒤 새 세션부터 적용됩니다.

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

brief·diff를 넘길 때의 데이터 보호는 [코드 worker §7](worker.md#7-데이터-보호)을 따르며, Claude·Codex로 보내는 내용에도 같은 기준을 씁니다.
