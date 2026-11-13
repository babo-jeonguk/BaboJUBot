# 이슈 운영: GitHub

저장소는 `babo-jeonguk/BaboJUBot`이며 `gh`를 씁니다. clone 안에서는 remote로 저장소를 추론합니다. skill 흐름 밖의 이슈 생성·게시는 사용자에게 먼저 확인하며, 이미 받은 작업 권한은 따릅니다.

## 조회·수정·연결

| 작업 | 명령 |
| --- | --- |
| 조회 | `gh issue view <n> --comments`; label은 `--json labels` |
| 목록 | `gh issue list --state open --json number,title,body,labels,comments`; `--label`·`--state`·`--jq`로 필요한 범위만 조회 |
| 생성·댓글 | `node scripts/gh-post.mjs issue create --title "..." --body-file <file>` / `node scripts/gh-post.mjs issue comment <n> --body-file <file>`; 여러 줄은 파일로 전달 |
| label·닫기 | `gh issue edit <n> --add-label "..." --remove-label "..."` / `node scripts/gh-post.mjs issue comment <n> --body "..."` 후 `gh issue close <n>`; label 의미는 [triage 표](triage-labels.md) |
| 숫자 database ID | `gh api repos/<owner>/<repo>/issues/<n> --jq .id` |
| 선행 조건 | `gh api --method POST repos/<owner>/<repo>/issues/<blocked>/dependencies/blocked_by -F issue_id=<blocker-db-id>` |
| parent/sub-issue | `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>` |

새 이슈 본문은 [이슈 양식](../../.github/ISSUE_TEMPLATE/)에서 종류(명세·티켓·버그)에 맞는 파일을 뼈대로 쓰고, 양식 머리말의 label을 `--label`로 붙입니다. skill이 상태 label을 따로 정하면 그것을 씁니다. label이 없다는 오류가 나면 [label 표](triage-labels.md)대로 만든 뒤 다시 실행합니다.

skill의 “publish to the issue tracker”는 이슈 생성과 blocker 연결, “fetch the relevant ticket”은 댓글 포함 조회입니다.

## 게시문에 쓰는 경로

이슈·PR의 제목·본문·댓글에는 독자가 저장소에서 열 수 있는 자료만 가리킵니다. 근거는 게시문 안에 요약하거나 커밋된 문서를 GitHub 파일 주소(`https://github.com/<owner>/<repo>/blob/<branch-or-SHA>/<path>`)로 링크합니다. 상대 링크는 이슈·PR 화면에서 열리지 않습니다.

- Git 제외 폴더 안을 경로로 가리키지 않습니다. 제품 런타임 위치는 `BABOJUBOT_HOME` 같은 설정 이름으로 씁니다. `auth.json`처럼 파일 이름만 쓰는 설명은 괜찮습니다.
- 실행 산출물 위치를 지정하는 요구는 경로 대신 “저장소 밖 임시 폴더”나 설정 이름으로 표현합니다.
- 제목·본문·댓글을 쓰는 `gh issue …`·`gh pr …`(생성·댓글·본문 수정·리뷰·닫기 댓글·병합 메시지)은 `gh` 대신 `node scripts/gh-post.mjs`로 같은 인수를 넘겨 실행합니다. 이 명령은 글을 검사한 뒤 `gh`를 부르고, 걸리면 아무것도 게시하지 않고 종료 코드 1과 해당 줄을 냅니다.
- 검사는 두 가지를 봅니다. 링크(마크다운 링크·이 저장소의 GitHub 파일 주소)는 `.gitignore` 전체 기준으로, 문장·코드 표기 속 경로는 `.gitignore`의 점 폴더로 시작하는 경로만 거부합니다. 이 컴퓨터의 저장소 절대 경로는 떼고 판정합니다. 검사가 못 잡는 표현도 위 규칙을 따릅니다.
- `--body-file`에 넘기는 로컬 파일의 위치는 게시되지 않으므로 상관없습니다. 그 내용만 검사합니다.

이슈는 사용자 저장소에만 만듭니다. fork나 clone에서 `gh`가 upstream parent를 기본 대상으로 잡을 수 있으므로, 세션의 첫 `gh issue create` 전에 `gh repo view --json nameWithOwner`로 대상을 확인하고 사용자 저장소가 아니면 사용자에게 확인합니다. 이미 닫힌 이슈에서는 `gh issue close --comment`가 댓글을 버리고 종료 코드 0을 내므로, 댓글은 먼저 `gh issue comment`로 남깁니다.

## PR 구분

**PRs as a request surface: no.** `/triage`가 읽는 설정이며 외부 PR을 기능 요청으로 triage하지 않습니다.
번호만 주어지면 `gh pr view <n>`으로 PR 여부를 확인하고 아니면 `gh issue view <n>`으로 조회합니다. PR 본문은 `gh pr view <n>`, 댓글은 `gh pr view <n> --comments`(비TTY에서는 댓글만 출력), diff는 `gh pr diff <n>`로 읽고, 댓글·label·닫기는 `gh pr comment`·`gh pr edit`·`gh pr close`를 쓰고, 글을 쓰는 명령은 [게시문 검사](#게시문에-쓰는-경로)를 거칩니다.

## Wayfinder 사용 시

1. **Map:** `wayfinder:map` 이슈에 Notes / Decisions-so-far / Fog를 둡니다. 하위 이슈는 native sub-issue로 연결하고 `wayfinder:<type>`(`research`/`prototype`/`grilling`/`task`) label을 붙입니다. API 미지원이면 map의 task list와 하위 본문 첫 줄 `Part of #<map>`으로 연결합니다.
2. **Frontier:** map 순서로 열린 하위 이슈 중 미할당·열린 blocker 0개인 첫 항목을 고릅니다. native `issue_dependencies_summary.blocked_by`는 열린 blocker 수입니다. 미지원이면 본문 첫 줄 `Blocked by: #<n>, #<n>`의 이슈가 모두 닫혔는지 확인합니다.
3. **Claim:** 세션의 첫 쓰기로 `gh issue edit <n> --add-assignee @me`를 실행해 담당자를 지정합니다.
4. **Resolve:** 답을 댓글로 남기고 이슈를 닫은 뒤 map의 Decisions-so-far에 요지·링크를 추가합니다.
