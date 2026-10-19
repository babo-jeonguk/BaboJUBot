# 이슈 운영: GitHub

저장소는 `babo-jeonguk/BaboJUBot`이며 `gh`를 씁니다. clone 안에서는 remote로 저장소를 추론합니다. skill 흐름 밖의 이슈 생성·게시는 사용자에게 먼저 확인하며, 이미 받은 작업 권한은 따릅니다.

## 조회·수정·연결

| 작업 | 명령 |
| --- | --- |
| 조회 | `gh issue view <n> --comments`; label은 `--json labels` |
| 목록 | `gh issue list --state open --json number,title,body,labels,comments`; `--label`·`--state`·`--jq`로 필요한 범위만 조회 |
| 생성·댓글 | `gh issue create --title "..." --body-file <file>` / `gh issue comment <n> --body-file <file>`; 여러 줄은 파일로 전달 |
| label·닫기 | `gh issue edit <n> --add-label "..." --remove-label "..."` / `gh issue close <n> --comment "..."`; label 의미는 [triage 표](triage-labels.md) |
| 숫자 database ID | `gh api repos/<owner>/<repo>/issues/<n> --jq .id` |
| 선행 조건 | `gh api --method POST repos/<owner>/<repo>/issues/<blocked>/dependencies/blocked_by -F issue_id=<blocker-db-id>` |
| parent/sub-issue | `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>` |

skill의 “publish to the issue tracker”는 이슈 생성과 blocker 연결, “fetch the relevant ticket”은 댓글 포함 조회입니다.

## PR 구분

**PRs as a request surface: no.** `/triage`가 읽는 설정이며 외부 PR을 기능 요청으로 triage하지 않습니다.
번호만 주어지면 `gh pr view <n>`으로 PR 여부를 확인하고 아니면 `gh issue view <n>`으로 조회합니다. PR 조회·diff는 `gh pr view <n> --comments`·`gh pr diff <n>`, 댓글·label·닫기는 `gh pr comment`·`gh pr edit`·`gh pr close`를 씁니다.

## Wayfinder 사용 시

1. **Map:** `wayfinder:map` 이슈에 Notes / Decisions-so-far / Fog를 둡니다. 하위 이슈는 native sub-issue로 연결하고 `wayfinder:<type>`(`research`/`prototype`/`grilling`/`task`) label을 붙입니다. API 미지원이면 map의 task list와 하위 본문 첫 줄 `Part of #<map>`으로 연결합니다.
2. **Frontier:** map 순서로 열린 하위 이슈 중 미할당·열린 blocker 0개인 첫 항목을 고릅니다. native `issue_dependencies_summary.blocked_by`는 열린 blocker 수입니다. 미지원이면 본문 첫 줄 `Blocked by: #<n>, #<n>`의 이슈가 모두 닫혔는지 확인합니다.
3. **Claim:** 세션의 첫 쓰기로 `gh issue edit <n> --add-assignee @me`를 실행해 담당자를 지정합니다.
4. **Resolve:** 답을 댓글로 남기고 이슈를 닫은 뒤 map의 Decisions-so-far에 요지·링크를 추가합니다.
