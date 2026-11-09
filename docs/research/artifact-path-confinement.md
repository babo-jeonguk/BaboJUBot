# 산출물 파일 경로를 폴더 안에 가두는 방법 (PR #131 리뷰 5회차)

`record_artifact`가 에이전트가 준 경로를 공유 폴더 안에서만 풀 때, Linux·macOS·Windows에서 모두 맞는 규칙을 기존 오픈소스에서 찾았다. 리뷰마다 직접 만든 경로 풀기의 경계 사례(링크 뒤 `..`, 끝의 구분자, Windows 끝 구분자, Windows 드라이브 상대 경로)가 하나씩 나와서 조사했다.

- 조사: Antigravity CLI(Gemini 3.8 Flash)가 웹으로 1차 조사를 했다. 아래 인용은 parent가 원본 페이지에서 다시 확인한 것만 적었다.
- 날짜: 2026-11-09

## 공통 결론

여러 프로젝트가 두 겹으로 막는다.

1. 이상한 표기는 파일 시스템에 닿기 전에 거부한다. 운영체제의 해석을 흉내 내지 않는다.
2. 남은 경로는 고정한 폴더 안에서 한 칸씩 실제로 푼다. 링크는 대상 폴더 기준으로 펼친다.

우리 읽기 프로세스(`pinnedReader`)는 2번을 이미 하고 있었다. 빠진 것은 Windows에서 이름 하나가 다른 것을 뜻하는 경우를 1번처럼 먼저 거부하는 일이었다.

## 근거

### Go `path/filepath.IsLocal`·`os.Root`

- `IsLocal`: "using lexical analysis only … is within the subtree … is not an absolute path … on Windows, is not a reserved name such as "NUL"" ([문서](https://pkg.go.dev/path/filepath#IsLocal)).
- `os.Root` 블로그: "`Root` permits relative path components and symlinks that do not escape the root", "`Root` prevents access to reserved Windows device names such as `NUL` and `COM1`", "on Windows `filepath.IsAbs(\foo)` reports `false`, because the path "\foo" is relative to the current drive" ([Go blog](https://go.dev/blog/osroot)).
- `os.Root` 문서 요약: 링크는 root 밖을 가리킬 수 없고 절대 링크는 허용하지 않는다(문서 본문 인용은 직접 확인하지 못함, [문서](https://pkg.go.dev/os#Root)).

### Rust `cap-std`(`cap-primitives`)

- 경로나 링크 대상에 드라이브·루트 접두가 나오면 탈출 시도로 거부한다: `CowComponent::PrefixOrRootDir => return Err(errors::escape_attempt()),`
- Windows에서는 끝이 구분자·`\.`·`\..`인 링크 대상을 거부한다: "Windows appears to disallow symlinks to paths with trailing slashes, slashdots, or slashdotdots." ([open.rs](https://github.com/bytecodealliance/cap-std/blob/main/cap-primitives/src/fs/manually/open.rs))

### node-tar CVE-2021-37713

- "a path that was not an absolute path, but specified a drive letter different from the extraction target, such as `C:some\path` … would resolve against the current working directory on the `C:` drive"
- 수정: "strip path roots from all paths prior to being resolved … even if such paths are not "absolute"" ([GHSA-5955-9wpr-37jh](https://github.com/advisories/GHSA-5955-9wpr-37jh), [strip-absolute-path.ts](https://github.com/isaacs/node-tar/blob/main/src/strip-absolute-path.ts)).

## 우리 규칙

Windows에서만, 걷기가 이름 하나를 파일 시스템에 넘기기 직전에 본다(입력 경로·절대 경로의 나머지·링크 대상 모두 이 한 곳을 지난다). Linux·macOS에서는 모두 보통 파일 이름이다.

| 이름 | Windows가 읽는 뜻 | 거부 | 근거 |
| --- | --- | --- | --- |
| `D:outside.md`, `C:..` | 그 드라이브의 현재 폴더 기준 | `path_outside_folder` | Go `IsLocal`·cap-std·node-tar |
| `NUL`, `con.txt`, `COM1`, `COM¹`, `CONIN$` | 장치 | `not_regular_file` | Go `os.Root` |
| `report.md:stream` | NTFS 스트림 | `not_regular_file` | Go `filepath.Localize` |
| `report.md.`, `report.md `, `.. ` | 끝의 점·공백을 뗀 이름(`.. `는 위 폴더) | `not_regular_file` | Go `io/fs.ValidPath` |

이미 있던 규칙은 그대로 둔다. Windows의 `..` 글자 정리(Win32와 같은 `path.normalize`), 절대 경로의 작업 폴더 부분 대조, 고정한 폴더 안에서 한 칸씩 풀기(dev/ino 확인, `O_NOFOLLOW`)다. 절대 링크 대상은 작업 폴더 안을 가리키면 따라간다. Go·cap-std와 다르지만, 절대 경로 입력을 받기로 한 #124 결정과 맞춘 것이다.

## 확인하지 못한 것

- Windows 8.3 짧은 이름(`FILENA~1.TXT`): 같은 파일로 열리므로 고정 걷기의 dev/ino 확인을 그대로 통과한다. 경계 문제는 아니라고 보았고 시험하지 않았다.
- `os.Root` 문서의 절대 링크 문장은 요약으로만 확인했다.
