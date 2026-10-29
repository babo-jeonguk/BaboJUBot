# CODING_STANDARDS.md 레퍼런스 조사: mattpocock/skills가 기대하는 저장소 표준 파일

조사일: 2026-10-30. 대상: 로컬 `code-review` skill과 외부 리뷰 요청이 Standards 축의 근거로 찾는 `CODING_STANDARDS.md`(이 저장소에 없음). 1차 출처(mattpocock/skills 저장소와 그 저장소가 링크하는 Matt Pocock의 공개 저장소)만 읽었다. 결정 문서가 아니며, 권고는 맨 끝 「BaboJUBot에 대한 함의」에만 둔다. 클론: `/tmp/research-mp-skills/`, `/tmp/research-mp-sandcastle/`, `/tmp/research-mp-mise/`(git 밖, 스크립트 미실행).

결정(2026-10-30, [PR #90](https://github.com/babo-jeonguk/BaboJUBot/pull/90)): 사용자가 이 조사를 보고 `CODING_STANDARDS.md`를 만들지 않기로 했다. 맨 끝 「BaboJUBot에 대한 함의」는 채택되지 않은 권고다.

## Brief

- 문제: 외부 리뷰는 "mattpocock-skills v1.3.1 code-review"를 기준으로 Standards·Spec 두 축을 본다([리뷰 반영](../agents/review-fixes.md#외부-리뷰-요청-형식)). Standards 축은 저장소의 문서화된 표준을 읽는데, 이 저장소에는 `CODING_STANDARDS.md`가 없다. 로컬 `~/.claude-sub/skills/code-review/SKILL.md`는 v1.3.1과 글자 단위로 같고, `~/.claude-sub/skills/retro/SKILL.md`는 main과 같다(v1.3.1과도 같음).
- 질문: (1) 어느 skill이 이 파일을 읽고·만들고·언급하나, 누가 언제 읽나 (2) 형식 규정이 있나 (3) 예시 파일이 있나 (4) v1.3.1과 main의 차이 (5) 문서화된 표준과 기본 smell을 reviewer가 어떻게 다르게 다루나.

## 레퍼런스

| 레퍼런스 | 분류 | 버전·SHA | 깊이 | 선정 이유 |
|---|---|---|---|---|
| mattpocock/skills `v1.3.1` | skill 모음(1차) | tag object `0b6cee1`, commit `24fe0ef7737efae15c87225755e9f6f5965e4888` (2026-10-04) | 소스 | 외부 리뷰가 인용하는 버전 |
| mattpocock/skills main | skill 모음(1차) | `a496f5513d4a4cf889bc48e189e579f4b0bdf6aa` (2026-10-29). `v1.3.2` = `d1478fc` | 소스 | 최신 문구 |
| mattpocock/sandcastle | Matt Pocock 저장소. skills의 [implement-spec 문서 L64](https://github.com/mattpocock/skills/blob/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/docs/engineering/implement-spec.md#L64)가 링크 | `a53e227250fb51df0ad54155b85fecc1c090c937` (2026-10-19) | 소스 | 실제로 쓰는 `CODING_STANDARDS.md`와 템플릿 보유 |
| mattpocock/mise-en-place | Matt Pocock 저장소. skills가 링크하지 않음(코드 검색으로 발견) | `2c1b7838d599af8af3c6e95e663855cb11ec5ed1` | 문서 | sandcastle 템플릿을 그대로 둔 사례 확인용 |
| skills 이슈 #1065·#1284, PR #1208 | 저장소 이슈(작성자는 외부 사용자, PR은 Matt Pocock) | 2026-10-30 `gh` 확인 | 문서 | v1.3.1 → main 변경의 이유 |

이하 링크의 `v1.3.1`은 `24fe0ef`, `main`은 `a496f55`, `sc`는 sandcastle `a53e227`을 뜻한다.

## 근거

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | `code-review` 3단계(v1.3.1): "Anything in the repo that documents how code should be written, such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`." 표준 출처 목록은 Standards 하위 에이전트 prompt에 들어간다 | [v1.3.1 code-review SKILL L34-L36, L60-L64](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/code-review/SKILL.md#L34-L64) | 소스 확인 |
| <a id="E02"></a>E02 | 같은 3단계(main): "Search the repo for every file that documents how code should be written. When `CODING_STANDARDS.md` or `CONTRIBUTING.md` exists, it must be on the list." 4단계에 "Issue both sub-agent calls together, in the foreground", 머리에 "Start every sub-agent with a fresh context window." 추가 | [main code-review SKILL L11, L36, L60](https://github.com/mattpocock/skills/blob/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/skills/engineering/code-review/SKILL.md#L36) | 소스 확인 |
| <a id="E03"></a>E03 | 변경 이유: 이슈 #1065(tibbe) — 에이전트가 표준 파일을 검색하지 않고 기억으로 나열해 루트 `CODING_STANDARDS.md`가 Standards 하위 에이전트에 전달되지 않았다("nothing in `AGENTS.md` links to it"). PR #1208(Matt Pocock, `3da8c01`, 2026-10-07)이 "search is the instruction, and the two canonical files are a *must*"로 고침. v1.3.2 CHANGELOG에 수록 | [CHANGELOG L11](https://github.com/mattpocock/skills/blob/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/CHANGELOG.md#L11), [#1065](https://github.com/mattpocock/skills/issues/1065), [#1208](https://github.com/mattpocock/skills/pull/1208) | 문서 주장 |
| <a id="E04"></a>E04 | 미해결 이슈 #1284(tarurar, open): main 문구에서도 에이전트가 `git ls-files`로만 찾아, Git ignore된 symlink `CODING_STANDARDS.md`를 놓쳤다 | [#1284](https://github.com/mattpocock/skills/issues/1284) | 문서 주장(사용자 보고) |
| <a id="E05"></a>E05 | Standards 하위 에이전트 brief(두 버전 같음): "(a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell … Distinguish hard violations from judgement calls: documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words." | [v1.3.1 L64](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/code-review/SKILL.md#L64), [main L66](https://github.com/mattpocock/skills/blob/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/skills/engineering/code-review/SKILL.md#L66) | 소스 확인 |
| <a id="E06"></a>E06 | smell baseline 규칙(두 버전 같음): "**The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell." / "**Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Like any standard here, skip anything tooling already enforces." Fowler smell 12개를 "*what it is* → *how to fix*" 형식으로 적는다 | [v1.3.1 L38-L56](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/code-review/SKILL.md#L38-L56) | 소스 확인 |
| <a id="E07"></a>E07 | `code-review` 문서: "The Standards axis needs nothing. It reads whatever the repo documents (`CODING_STANDARDS.md`, `CONTRIBUTING.md`, and the like) and falls back on a built-in baseline when the repo documents nothing." 표: Standards의 "Every finding cites | The standards file and the rule, or the named smell plus the hunk". 저장소 문서가 Standards 축의 primary source이고 "**the repo always overrides**" | [main docs/engineering/code-review.md L24, L40-L46](https://github.com/mattpocock/skills/blob/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/docs/engineering/code-review.md#L24-L46) | 문서 주장 |
| <a id="E08"></a>E08 | 같은 문서: Standards 축의 판단 절반은 실행마다 결과가 달라 수렴 보장이 없다. "Treat a pass as a list of leads. Act on the ones with a cited rule behind them, then stop." | [main code-review.md L77](https://github.com/mattpocock/skills/blob/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/docs/engineering/code-review.md#L77) | 문서 주장 |
| <a id="E09"></a>E09 | `retro` 범주(두 버전 같음): "**Coding standards**: should the **reviewer agent** be given a new rule to enforce? Should an existing rule be removed or clarified? Classify the violation first: a **mechanical** one (a fixed syntactic pattern, a banned API, an import shape, a file-location rule) gets a deterministic check, full stop … Default to building the check over writing the rule. Reserve `CODING_STANDARDS.md` for genuine **judgement calls** (cross-file consistency, "matches the surrounding style," anything no guardrail could ever substitute for). _Use when_ the reviewer agent failed to catch a mistake." 다음 범주: AGENTS.md가 크면 steering을 "coding standards (or automated checks)"로 옮길지 본다 | [retro SKILL L19-L20](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/retro/SKILL.md#L19-L20) | 소스 확인 |
| <a id="E10"></a>E10 | `retro` 참고 절: "the review agent should be responsible for imposing coding standards, not the implementation agent." / "`CLAUDE.md`/`AGENTS.md` … should be used incredibly sparingly, usually only for **navigation pointers** to other files." / "`CODING_STANDARDS.md`: this file is read during review, not implementation. Add **navigation pointers** to docs folders if the standards file gets more than 1,000 lines long." | [retro SKILL L29-L42](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/retro/SKILL.md#L29-L42) | 소스 확인 |
| <a id="E11"></a>E11 | `retro` 문서: 범주→수정 위치 표에 "The reviewer missed a judgement-call mistake → A rule in `CODING_STANDARDS.md` for the reviewer agent". "a check can fail and a sentence in a standards file can't". `CLAUDE.md`에 한 줄 더하기는 "Usually not … `AGENTS.md` and `CLAUDE.md` are for navigation pointers and little else." 파일 출처: "No skill ships the file. The first time a session finds a judgement-call rule for the reviewer, `retro` proposes to create it. After you accept, code-review reads it. Any other standards doc you already keep, such as `CONTRIBUTING.md`, works the same way." | [main docs/engineering/retro.md L21, L27-L29, L51, L55](https://github.com/mattpocock/skills/blob/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/docs/engineering/retro.md#L21-L55) | 문서 주장 |
| <a id="E12"></a>E12 | `retro` 1단계는 `writing-for-agents`를 불러 글쓰기 기준으로 쓴다. 그 skill은 "any document an agent consumes"에 적용되며 "all reference (a review's rules, this skill)"를 예로 들고, 금지형보다 긍정형("Prompt the **positive**"), 한 의미 한 곳(single source of truth), 환경이 이미 말하는 것은 다시 적지 않기(cache), sprawl 방지(pointer 뒤로 disclose)를 요구한다. `CODING_STANDARDS.md`를 이름으로 언급하지는 않는다 | [retro SKILL L11](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/retro/SKILL.md#L11), [writing-for-agents SKILL L6, L31, L43, L74, L78-L79](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/productivity/writing-for-agents/SKILL.md#L74-L79) (main과 같음) | 소스 확인 |
| <a id="E13"></a>E13 | 구현 쪽 skill: `implement`는 끝나면 `code-review`를 부른다. `implement-spec`은 통합 브랜치에 `code-review`를 돌리고 지적을 implementer 하위 에이전트가 고친다. `tdd`: "Refactoring … belongs to the review stage (see the `code-review` skill)". 어느 구현 skill도 표준 파일을 읽으라고 하지 않는다 | [v1.3.1 implement L13](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/implement/SKILL.md#L13), [implement-spec L36](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/implement-spec/SKILL.md#L36), [tdd L38](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/tdd/SKILL.md#L38) | 소스 확인 |
| <a id="E14"></a>E14 | `ask-matt`(라우터): "Mechanical mistakes become deterministic checks; judgement calls become coding standards." main에만 있는 `in-progress/chief-of-staff`(2026-10-05 추가, 배포 대상 아님): "CODING_STANDARDS.md files which let code reviewers enforce best practices" | [v1.3.1 ask-matt L32](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/ask-matt/SKILL.md#L32), [main chief-of-staff L55](https://github.com/mattpocock/skills/blob/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/skills/in-progress/chief-of-staff/SKILL.md#L55) | 소스 확인 |
| <a id="E15"></a>E15 | skills 저장소 자체에는 `CODING_STANDARDS.md`가 없고(이력에도 추가된 적 없음), 루트 `CONTRIBUTING.md`는 이슈 제출 안내다. 저장소 규칙(em-dash 금지 등)은 `AGENTS.md`/`CLAUDE.md`에 있다 | `git ls-tree`·`git log --diff-filter=A` (`a496f55`), [CONTRIBUTING.md](https://github.com/mattpocock/skills/blob/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/CONTRIBUTING.md), [AGENTS.md L25](https://github.com/mattpocock/skills/blob/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa/AGENTS.md#L25) | 소스 확인 |
| <a id="E16"></a>E16 | sandcastle 템플릿 `CODING_STANDARDS.md`(27줄, 두 템플릿에 같은 파일): `# Coding Standards` 아래 HTML 주석 "The reviewer agent loads it during code review via @.sandcastle/CODING_STANDARDS.md so these standards are enforced during review without costing tokens during implementation." 그리고 `## Style`·`## Testing`·`## Architecture` 세 절, 각 절은 주석 속 예시 bullet 2–3개뿐. 템플릿의 review prompt만 "Follow the coding standards defined in @.sandcastle/CODING_STANDARDS.md"로 읽는다. 템플릿 간 중복은 ADR-0009가 의도한 모양 | [sc template CODING_STANDARDS.md](https://github.com/mattpocock/sandcastle/blob/a53e227250fb51df0ad54155b85fecc1c090c937/src/templates/sequential-reviewer/CODING_STANDARDS.md), [review-prompt.md L41](https://github.com/mattpocock/sandcastle/blob/a53e227250fb51df0ad54155b85fecc1c090c937/src/templates/sequential-reviewer/review-prompt.md#L41), [ADR-0009](https://github.com/mattpocock/sandcastle/blob/a53e227250fb51df0ad54155b85fecc1c090c937/docs/adr/0009-templates-no-shared-code.md) | 소스 확인 |
| <a id="E17"></a>E17 | sandcastle 자체 `.sandcastle/CODING_STANDARDS.md`(186줄, 2026-03-26 시작, 2026-06-18까지 갱신): 앞 95줄은 제목 없는 규칙 12개를 `---`로 나눈 산문. 각 규칙은 지시 + 이유 + 범위·예외, 일부는 `// BAD`/`// GOOD` 코드 예시. 예: "Never use `new Error()` inside an Effect closure … Raw `Error` widens the inferred error channel …", "Optional parameters … are a huge source of bugs (by omission).", path 비교 규칙은 "invisible on Linux/macOS CI"라 테스트로 안 잡힌다는 이유까지 적는다. 뒤 90줄은 `## Testing`(Good/Bad Tests, Mocking, TDD)·`## Interface Design`(Deep Modules, Design for Testability) | [sc .sandcastle/CODING_STANDARDS.md L1-L95, L97-L186](https://github.com/mattpocock/sandcastle/blob/a53e227250fb51df0ad54155b85fecc1c090c937/.sandcastle/CODING_STANDARDS.md) | 소스 확인 |
| <a id="E18"></a>E18 | sandcastle은 같은 주제를 자동 검사로도 강제한다: `scripts/check-public-types-effect-free.mjs`가 `postbuild`에서 공개 `.d.ts`에 effect가 새면 실패하고 머리 주석이 "See CODING_STANDARDS.md."로 문서 규칙("Effect should not leak out into the user-facing API")을 가리킨다 | [check-public-types-effect-free.mjs L1-L8](https://github.com/mattpocock/sandcastle/blob/a53e227250fb51df0ad54155b85fecc1c090c937/scripts/check-public-types-effect-free.mjs#L1-L8), [package.json L39](https://github.com/mattpocock/sandcastle/blob/a53e227250fb51df0ad54155b85fecc1c090c937/package.json#L39) | 소스 확인 |
| <a id="E19"></a>E19 | 반례: sandcastle 내부 GitHub workflow는 review prompt뿐 아니라 implement prompt도 `.sandcastle/CODING_STANDARDS.md`를 읽게 한다 | [sc agent-workflows/implement/prompt.md L13-L17](https://github.com/mattpocock/sandcastle/blob/a53e227250fb51df0ad54155b85fecc1c090c937/.sandcastle/agent-workflows/implement/prompt.md#L13-L17), [review/prompt.md L37](https://github.com/mattpocock/sandcastle/blob/a53e227250fb51df0ad54155b85fecc1c090c937/.sandcastle/agent-workflows/review/prompt.md#L37) | 소스 확인 |
| <a id="E20"></a>E20 | mise-en-place `.sandcastle/CODING_STANDARDS.md`는 sandcastle 템플릿과 같은 27줄을 고치지 않은 상태 | [mise-en-place `2c1b783` .sandcastle/CODING_STANDARDS.md](https://github.com/mattpocock/mise-en-place/blob/2c1b7838d599af8af3c6e95e663855cb11ec5ed1/.sandcastle/CODING_STANDARDS.md) | 소스 확인 |

## 질문별 답

### 1. 이 파일을 다루는 skill과 읽는 주체·시점

| skill | 하는 일 | 읽는 주체·시점 | 근거 |
|---|---|---|---|
| `code-review` (engineering) | **읽는다.** 표준 출처로 찾아 Standards 하위 에이전트 prompt에 목록으로 넘긴다 | reviewer(Standards 하위 에이전트), diff 리뷰 때 | E01, E02, E05 |
| `retro` (engineering, 사용자 호출) | **만들기·고치기를 제안한다.** reviewer가 놓친 판단형 실수를 규칙으로 넣거나 기존 규칙 삭제·명확화를 제안. 사용자가 고른 뒤에만 바뀐다 | 세션 회고 때. 파일 자체는 "read during review, not implementation" | E09, E10, E11 |
| `ask-matt` (라우터) | **언급만.** 판단형 실수는 coding standards로 간다고 안내 | — | E14 |
| `chief-of-staff` (in-progress, main만) | **언급만.** 환경 개선 목록의 한 항목 | — | E14 |
| `implement`·`implement-spec`·`tdd` | 언급 없음. 구현 끝에 `code-review`를 부르고 그 지적을 고칠 뿐 | implementer는 표준 파일을 읽지 않는다 | E13 |

파일을 만들어 주는 skill은 없다("No skill ships the file", E11). `CONTRIBUTING.md` 등 다른 표준 문서도 같은 자리로 취급된다(E01, E07, E11).

### 2. 형식 규정

조사 범위에서 **전용 형식 규정은 찾지 못했다**. 필수 절, 규칙 번호, 문장 형식, 작성 언어를 정한 문장은 없다. 있는 것은 아래뿐이다.

| 항목 | 출처의 문구 | 근거 |
|---|---|---|
| 길이 | "Add **navigation pointers** to docs folders if the standards file gets more than 1,000 lines long." 상한이 아니라 1,000줄을 넘으면 docs 폴더로 가리키라는 기준 | E10 |
| 들어갈 것 | "Reserve `CODING_STANDARDS.md` for genuine **judgement calls** (cross-file consistency, "matches the surrounding style," anything no guardrail could ever substitute for)." | E09 |
| 빼서 자동 검사로 | "a **mechanical** one (a fixed syntactic pattern, a banned API, an import shape, a file-location rule) gets a deterministic check, full stop … Default to building the check over writing the rule." 이유: "a check can fail and a sentence in a standards file can't" | E09, E11 |
| AGENTS.md/CLAUDE.md와의 차이 | AGENTS.md/CLAUDE.md는 모든 에이전트 context에 실리므로 "incredibly sparingly, usually only for **navigation pointers**". `CODING_STANDARDS.md`는 리뷰 때만 읽는다. 큰 AGENTS.md의 steering은 standards나 check로 옮긴다 | E09, E10, E11 |
| 인용 단위 | reviewer는 위반마다 "cite the standard (file + the rule)". 규칙이 따로 가리킬 수 있어야 한다는 뜻이지만 ID 형식은 정하지 않는다 | E05, E07 |
| 문장 쓰기 | `retro`가 부르는 `writing-for-agents`의 일반 기준: 긍정형으로 쓰기("Prompt the **positive**"), 한 의미 한 곳, 환경(설정·스크립트)이 말하는 것은 다시 적지 않기, 너무 길면 pointer 뒤로. 표준 파일을 직접 지목하지는 않는다 | E12 |

### 3. 예시 파일

- **skills 저장소**: 예시 없음. 저장소 자체에도 `CODING_STANDARDS.md`가 없다(E15).
- **sandcastle 템플릿**(skills 문서가 링크하는 저장소): 27줄 뼈대. `# Coding Standards` → 용도 주석(리뷰 때만 로드, 구현 때 토큰 비용 없음) → `## Style`·`## Testing`·`## Architecture`, 각 절은 주석 속 예시 bullet("Prefer named exports over default exports" 등) 2–3개(E16). 예시 bullet에는 이름 규칙처럼 retro 기준으로는 lint 대상인 것도 섞여 있다.
- **sandcastle 실사용본**: 186줄. 앞부분은 절 제목 없이 `---`로 나눈 규칙 12개, 각 규칙은 지시 한두 문장 + 왜 위험한지 + 범위·예외 + 필요하면 BAD/GOOD 코드. 뒷부분은 Testing·Interface Design 원칙 절(E17). 규칙 일부는 별도 스크립트가 build에서 강제하고 스크립트가 표준 파일을 가리킨다(E18). 금지형 문장("Never use", "Do not use")이 여러 개라 E12의 긍정형 기준과 완전히 일치하지는 않는다.
- **mise-en-place**: 템플릿을 고치지 않은 상태(E20). skills가 링크하지 않는다.

### 4. v1.3.1과 main의 차이

| 항목 | v1.3.1 (`24fe0ef`) | main (`a496f55`) | 근거 |
|---|---|---|---|
| 표준 출처 찾기 | "Anything … such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`" — 예시일 뿐, 검색 지시 없음 | "Search the repo for every file …" + 두 파일은 "must be on the list" | E01, E02 |
| 하위 에이전트 실행 | parallel | parallel + foreground, 새 context window | E02 |
| 이슈 추적 문서 | `docs/agents/issue-tracker.md` 고정 경로 | "the tracker doc" | [#1208](https://github.com/mattpocock/skills/pull/1208) |
| Standards brief·smell baseline·우선순위 | 같음 | 같음 | E05, E06 |
| `retro` SKILL·`writing-for-agents` | 같음 | 같음(문서 페이지는 문장 다듬기만) | E09, E12 |

변경은 v1.3.2(`d1478fc`)에 들어갔다. v1.3.1에서는 에이전트가 검색하지 않고 루트 `CODING_STANDARDS.md`를 빠뜨린 사례가 보고됐다(E03). main에서도 Git 추적 파일만 검색해 ignore된 파일을 놓친 사례가 열려 있다(E04).

### 5. 문서화된 표준과 기본 smell의 차이 (규칙 한 줄이 실제로 바꾸는 것)

| | 문서화된 표준(`CODING_STANDARDS.md` 등) | smell baseline(Fowler 12개) |
|---|---|---|
| 판정 세기 | "can be hard" — 확정 위반으로 보고될 수 있다 | "always judgement calls", "possible …" 라벨 |
| 충돌 시 | 이긴다. 표준이 허용하는 것을 baseline이 지적하면 smell을 지운다 | 진다 |
| 인용 | 파일 + 규칙 | smell 이름 + hunk 인용 |
| 도구가 강제하는 것 | 둘 다 건너뛴다("Skip anything tooling enforces") | 같음 |

근거: E05, E06, E07. 따라서 규칙 한 줄은 (a) 그 위반을 판단 권고가 아니라 확정 위반으로 올릴 근거가 되고, (b) 저장소가 의도한 모양을 smell 지적에서 빼 주며, (c) lint·검사가 이미 막는 내용이면 리뷰에서 아무 효과가 없다. 문서는 인용된 규칙이 있는 지적만 고치고 멈추라고 한다(E08). 표준은 Spec 축에 영향을 주지 않는다. Spec 축은 커밋 메시지의 이슈 참조·인자 경로·`docs/`·`specs/` 파일에서 찾은 명세만 읽고 명세 줄을 인용한다([v1.3.1 L25-L32, L66-L70](https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/code-review/SKILL.md#L25-L70)).

## 한계와 미확인

- skill을 실행하지 않았다. 모든 근거는 소스·문서 읽기와 `gh` 이슈 조회다.
- aihero.dev의 Matt Pocock 글(사전 항목 등)은 skills 문서가 링크하지만 표준 파일 형식을 다룬다는 단서가 없어 읽지 않았다.
- Matt Pocock의 다른 저장소는 `gh search code`로 `CODING_STANDARDS`가 나온 sandcastle·mise-en-place만 확인했다. 검색 색인에 없는 저장소는 확인하지 못했다.
- 작성 언어(한국어 표준 파일을 reviewer가 어떻게 다루나)에 대한 언급은 찾지 못했다.

---

## BaboJUBot에 대한 함의

아래는 위 근거에서 끌어낸 이 조사자의 제안이며 출처의 문장이 아니다.

- **파일 위치·발견**: 외부 리뷰가 v1.3.1을 쓰면 3단계가 검색을 강제하지 않는다(E01, E03). 루트에 Git 추적 파일로 두고, 외부 리뷰 요청의 "저장소 표준" 칸에 링크를 넣으면 v1.3.1·main 모두에서 빠질 여지가 줄어든다(E04). AGENTS.md에는 규칙 본문이 아니라 pointer 한 줄만 둔다(E10, E11).
- **최근 지적 네 가지의 분류**(retro 기준 E09 적용):
  - 오래된 주석을 코드와 함께 옮기기 — lint로 잡을 수 없는 판단형. 표준 규칙 후보.
  - 시작·중지 실패 경로의 정리 누락 — 판단형 규칙 후보. 다만 실패 주입 테스트로 고정할 수 있는 경로는 자동 검사 쪽이 우선이다.
  - 상태 전이 누락 — 전이 표를 타입으로 두고 exhaustiveness 검사(TypeScript `never`, lint 규칙)로 막을 수 있는 부분은 기계적 검사, "새 상태를 추가하면 모든 전이 경로를 확인" 같은 나머지만 규칙.
  - 명세 결정 누락 — Standards가 아니라 Spec 축 문제다(5절). 표준 파일로 고치지 않고, 결정 댓글을 커밋의 이슈 참조나 리뷰 요청의 Spec 칸에서 찾을 수 있게 하는 쪽이다.
- **모양**: 출처에 정해진 형식은 없다. sandcastle 실사용본(E17)처럼 규칙마다 지시 + 이유 + 범위를 짧게 쓰고, reviewer가 "파일 + 규칙"으로 인용할 수 있게 규칙마다 짧은 제목을 다는 정도가 근거와 맞는다. 템플릿의 Style 예시 같은 이름 규칙은 lint로 보낸다.
- 이 파일은 `docs/README.md` 연구 문서 표에 아직 등록하지 않았다(작업 범위 밖).
