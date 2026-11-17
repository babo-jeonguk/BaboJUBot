# relay-login-no-links 레퍼런스 조사: 링크를 만들 수 없는 컴퓨터의 격리 실행 로그인

조사일: 2026-11-17. 대상: GitHub Issue 없음(주제 조사). 구현 전 기술 권고이며 확정 계약이나 구현 결과가 아니다. 기준 코드는 main `e7f75a4`.

## Brief

- 구현할 문제: 파일 링크를 만들 수 없는 컴퓨터(예: vfat·exFAT·일부 SMB 저장소, 권한 없는 Windows)에서 `keepAtFallback`이 로그인 원본을 연결 폴더 자리로 옮긴다. 인증 중계는 로그인 전용 폴더의 원본만 읽으므로(`codex.ts currentLogin`, `antigravity.ts currentAccess`) 격리 실행이 모두 중계 실패로 끝난다. 준비 확인은 미리 알리지 않고, 실패 안내("로그인을 고친 뒤…")는 원인과 다르다.
- 동종 문제(메커니즘 하나): 파일 하나로 된 갱신되는 자격 증명을 여러 홈이 공유하는데 링크를 못 만들 때, 단일 원본을 지키며 그 자격 증명을 대신 주입하는 쪽이 갱신본을 읽는 법.
- 고정된 결정(다시 열지 않음): 원본은 컨테이너에 넣지 않는다. 컨테이너 밖 중계가 주입한다. 연결 폴더는 이 컴퓨터만 쓰고 mount하지 않는다. 링크를 못 만드는 컴퓨터에서 격리를 끈 실행이 연결 폴더로 도는 것은 유지한다. Windows는 Docker 격리를 지원하지 않는다([#146](issue-146-references.md), [#148](issue-148-references.md), [조직 제품 폴더](org-product-folders-references.md), `docs/providers.md`).

| ID | 조사 질문 | 전략 |
|---|---|---|
| Q1 | 링크가 없을 때 하나의 자격 증명 파일을 여러 홈이 공유하는 도구는 단일 원본을 어떻게 지키고 갱신본이 갈라지지 않게 하는가 | Source Recon + persistence/recovery |
| Q2 | 샌드박스 대리 주입자는 자격 증명을 고정 경로에서 찾는가, 소유 CLI가 지금 읽고 쓰는 자리에서 찾는가. CLI가 다른 자리에 갱신본을 쓰면 어떻게 하는가 | Source Recon + adversarial scenario |
| Q3 | 링크 가능 여부를 어떻게 판정하고(탐침 대 플랫폼) 실제 파일 시스템은 어떤 오류를 주는가 | Source Recon(커널·libuv·Node) + Behavioral Recon |
| Q4 | 주입 자격 증명을 읽지 못할 때 어떻게 알리고 복구하는가(매번 재독·래치·점검), 무엇을 하라고 알리는가 | Source Recon + runtime/failure |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [issue-146](issue-146-references.md) E03·E21 | Codex가 링크를 보존하는 저장, 링크 거절 오류 모의 | Codex는 새 SHA로 다시 읽음(E12). 나머지는 앵커 인용 |
| [org-product-folders](org-product-folders-references.md) E03·E18·E22 | Codex symlink 저장, Paperclip·OpenHands 공유 | Paperclip·OpenHands는 새 SHA로 다시 읽음(E13·E14) |
| [issue-148](issue-148-references.md) E01 | Paperclip copy-back | 인용만 |

## 레퍼런스

관점별 saturation: OSS agent 제품 — 3라운드, 마지막이 새 변형 없음(symlink 우선 뒤 강등 또는 포기). 라이브러리 — 3라운드(탐침, 단계 폴백, 디렉터리 전용 junction으로 수렴). 상용 CLI·클라우드 — 3라운드(명시 경로 env, helper 프로세스, 키링+평문 폴백). 컨테이너 대리 — 2라운드. 커널·OS — 2라운드(errno 셋). 한 명이 순서대로 돌렸고 worker는 쓰지 않았다.

| 레퍼런스 | 분류 | SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| openai/codex | 대상 CLI | `c656014177079dae2dcc5e1e70c03e3158383a27` | Apache-2.0 | 소스 | 저장 방식·hardlink 거부·symlink 해석 |
| paperclipai/paperclip | OSS agent | `6d117998c83b95fa612f3b252f6d3b68fc0f4f6b` | MIT | 소스+issue | Windows 사본 분기 실패 사례 |
| OpenHands/software-agent-sdk | OSS agent | `98c8cd30ddfa7282f29bb95eb1df62f1c28c39e1` | MIT | 소스 | 정본 저장소+되쓰기, 링크 실패 강등 |
| pnpm/symlink-dir, pnpm/pnpm | 라이브러리 | `bfbaef3fc07b8d8cd26ba565c594849c5e403b4e`, `809b630a5f22a3fdbabf12b0cc8f7583434dacc7` | MIT | 소스 | 런타임 폴백 사슬 |
| git/git | 도구 | `e1ec09b23c8e0deb21a0b95ac5996422277395d4` | NOASSERTION(GPL-2.0 추정, 미확인) | 소스 | 링크 탐침·사본 폴백 |
| torvalds/linux, tuxera/ntfs-3g, apple-oss-distributions/xnu, libuv/libuv, nodejs/node | 커널·런타임 | 근거 표 | 설계 참고만 | 소스 | 오류 코드 |
| googleapis/google-auth-library-nodejs, docker/cli, docker/docker-credential-helpers, kubernetes/client-go, cli/cli | 상용·클라우드 도구 | 근거 표 | Apache-2.0·MIT | 소스 | 자격 증명 위치·실패 처리 |
| VS Code dev containers, AWS CLI 문서 | 문서 | 확인일 2026-11-17 | - | 문서 | 호스트 helper 재사용, 명시 경로 env |

깊이: 목록 / 문서 / 소스 / 실행. 코드 재사용 없음(설계 참고만).

## 근거

BaboJUBot 코드는 main `e7f75a4`. 외부 소스는 40자 SHA 고정.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | `linkLogin`은 매번 임시 symlink로 판정하고 EPERM·ENOTSUP·EOPNOTSUPP이면 `keepAtFallback`으로 원본을 연결 폴더 자리로 `rename`한다. 연결 자리를 읽을 수 있으면 아무것도 옮기지 않는다 | `packages/runtime/src/providers/login-link.ts` L29, L36-52, L86-100 | 소스 확인 |
| <a id="E02"></a>E02 | 중계의 로그인 읽기는 `readFile(original)` 하나다. 못 읽으면 `fail("unreadable")`로 연결의 모든 권한을 거두고 래치한다. `recover()`는 읽히는 로그인이 있고 실패 때와 지문이 다를 때만 푼다(읽기 실패는 지문 null). 준비 확인의 실패 문구는 "로그인을 고친 뒤 준비 상태를 다시 확인하세요" | `codex.ts` L312-320, `antigravity.ts` L217-225, `credential-relay.ts` L261-300, `apps/server/src/isolation.ts` L35-40 | 소스 확인 |
| <a id="E03"></a>E03 | 부모가 실제 vfat loop mount(Linux 7.0, Node 24.21.0)에서 합성 토큰·실제 `IsolationGate`·가짜 docker·로컬 상류 대역으로 실행: `fs.symlink`·`fs.link` EPERM, rename·chmod·`wx` 쓰기·mkdir 성공. Codex·Antigravity 격리 실행은 중계 실패, 원본 칸 비어 있고 로그인은 연결 자리에 있음, 상류 요청 0건. 준비 확인·다시 로그인·격리 끈 실행·모델 목록 조회로 풀리지 않음. 서버 재시작은 메모리 실패만 지우고 다음 격리 실행이 다시 실패. ext4로 복사해 재시작하면 첫 준비 확인이 로그인을 원본 칸으로 되돌리고 격리 실행이 최신 토큰으로 성공. 준비 확인은 처음부터 ready/unknown이라 미리 알리지 않음 | 부모 실행 기록(이 조사에서 부모가 실행, 시험 원문은 로컬 캐시 보관). 환경: 실제 vfat | 실행 확인(부모) |
| <a id="E04"></a>E04 | 링크가 다시 가능해진 같은 프로세스(모의): 준비 확인만으로는 `credential_relay_failed`가 남고, `IsolationGate.readiness`가 연결 확인 앞에서 돌아가므로 모델 목록 조회나 격리 끈 실행이 로그인 준비를 지나야 풀림 | E03과 같은 기록 | 실행 확인(부모, 링크 거절은 `fs` 모의) |
| <a id="E05"></a>E05 | Linux VFS: `vfs_symlink`는 `dir->i_op->symlink`가 없으면 `-EPERM`, `vfs_link`도 `->link`가 없으면 `-EPERM`. vfat·exfat의 디렉터리 `inode_operations`에는 `.symlink`·`.link`가 없다 | [linux `fs/namei.c` L5801-5802, L5923-5924](https://github.com/torvalds/linux/blob/666539eecdf4db623f5e3c3e55cf9f2dfad24aa4/fs/namei.c#L5801-L5802), [`fs/fat/namei_vfat.c` L1190-1201](https://github.com/torvalds/linux/blob/666539eecdf4db623f5e3c3e55cf9f2dfad24aa4/fs/fat/namei_vfat.c#L1190-L1201), [`fs/exfat/namei.c` L1342-1352](https://github.com/torvalds/linux/blob/666539eecdf4db623f5e3c3e55cf9f2dfad24aa4/fs/exfat/namei.c#L1342-L1352) | 소스 확인 |
| <a id="E06"></a>E06 | CIFS: `cifs_symlink`은 `rc = -EOPNOTSUPP`로 시작해 마운트 옵션이 정한 종류(UNIX 확장, mfsymlinks, SFU, reparse)에서만 성공한다. 어느 옵션에도 안 걸리면 EOPNOTSUPP | [linux `fs/smb/client/link.c` L663-745](https://github.com/torvalds/linux/blob/666539eecdf4db623f5e3c3e55cf9f2dfad24aa4/fs/smb/client/link.c#L663-L745) | 소스 확인 |
| <a id="E07"></a>E07 | ntfs3는 `.symlink = ntfs_symlink`가 있고(L539, 읽은 앞부분은 손상 inode·강제 종료만 EINVAL·EIO로 거절), FUSE는 요청을 사용자 공간 FS로 넘기며 ntfs-3g는 `S_IFLNK` 생성으로 구현한다. ntfs-3g·ntfs3가 링크를 거절하는 실제 조건과 errno는 이번에 확인하지 못함 | [linux `fs/ntfs3/namei.c` L213-225, L539](https://github.com/torvalds/linux/blob/666539eecdf4db623f5e3c3e55cf9f2dfad24aa4/fs/ntfs3/namei.c#L213-L225), [`fs/fuse/dir.c` L1149-1161](https://github.com/torvalds/linux/blob/666539eecdf4db623f5e3c3e55cf9f2dfad24aa4/fs/fuse/dir.c#L1149-L1161), [ntfs-3g `src/ntfs-3g.c` L2347-2353](https://github.com/tuxera/ntfs-3g/blob/7f0f841fc52cf719106c5c93bafe465004e36816/src/ntfs-3g.c#L2347-L2353) | 소스 확인(거절 errno는 미확인) |
| <a id="E08"></a>E08 | XNU의 기본 `err_symlink`는 `ENOTSUP`을 돌려준다(그 vnop를 안 채운 FS). macOS 26.7의 msdosfs·exFAT(fskit)는 이를 쓰지 않고 링크를 지원한다(E25 실행 확인) | [xnu `bsd/vfs/vfs_support.c` L515-520](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/vfs/vfs_support.c#L515-L520) | 소스 확인(적용 FS는 미확인) |
| <a id="E09"></a>E09 | Windows libuv: `ERROR_PRIVILEGE_NOT_HELD`는 `UV_EPERM`. `fs__symlink`는 `ALLOW_UNPRIVILEGED_CREATE` 플래그로 만들어 보고 `ERROR_INVALID_PARAMETER`면 플래그를 빼고 다시 한다. 그래도 안 되면 Win32 오류를 그대로 돌려준다 | [libuv `src/win/error.c` L159](https://github.com/libuv/libuv/blob/e5dab8432177f43af97bbe032037d273234642ac/src/win/error.c#L159), [`src/win/fs.c` L2950-2985](https://github.com/libuv/libuv/blob/e5dab8432177f43af97bbe032037d273234642ac/src/win/fs.c#L2950-L2985) | 소스 확인 |
| <a id="E10"></a>E10 | Node 문서: `type`은 Windows에서만 쓰고 junction은 NTFS 디렉터리만 가리킬 수 있다 | [node `doc/api/fs.md` L2241-2247](https://github.com/nodejs/node/blob/bc6dd4081f28834ecd015b22ee085f48e6ca5400/doc/api/fs.md#L2241-L2247) | 문서 주장 |
| <a id="E11"></a>E11 | git은 저장소를 만들 때 임시 symlink를 만들어 보고 실패하면 `core.symlinks=false`로 기록한다. false면 링크를 링크 대상 문자열이 든 작은 보통 파일로 둔다(FAT 같은 FS용) | [git `setup.c` L2721-2733](https://github.com/git/git/blob/e1ec09b23c8e0deb21a0b95ac5996422277395d4/setup.c#L2721-L2733), [`Documentation/config/core.adoc` L244-253](https://github.com/git/git/blob/e1ec09b23c8e0deb21a0b95ac5996422277395d4/Documentation/config/core.adoc#L244-L253) | 소스 확인 / 문서 주장 |
| <a id="E12"></a>E12 | Codex: 저장은 symlink의 최종 대상을 풀어 그 옆 임시 파일에 쓰고 rename한다(링크 유지). hard-link된 파일(Unix)과 읽기 전용은 "정체성을 쪼개지 않도록" 저장을 거부한다. 저장 모드는 file·keyring·auto·ephemeral. 읽은 `auth/` 파일에서 인증 파일 경로를 따로 지정하는 옵션은 확인하지 못함(`CODEX_HOME`은 홈 전체) | [codex `storage_file.rs` L1-50](https://github.com/openai/codex/blob/c656014177079dae2dcc5e1e70c03e3158383a27/codex-rs/login/src/auth/storage_file.rs#L1-L50), [`storage.rs` L274-296, L698-730](https://github.com/openai/codex/blob/c656014177079dae2dcc5e1e70c03e3158383a27/codex-rs/login/src/auth/storage.rs#L274-L296) | 소스 확인 |
| <a id="E13"></a>E13 | Paperclip: `ensureSymlink`는 링크만 만들고 실패하면 던진다(사본 폴백 없음). 보통 파일이 있으면 지우고 링크로 바꾼다. 이유 주석: Codex refresh token은 한 번만 쓰이므로 낡은 사본은 `refresh_token_reused`로 실패. Issue #5028(Windows)은 제안으로 "링크 불가 시 실행 직전에 복사·동기화"와 "원인을 가리키는 안내"를 적었고, 수정 설명은 Windows 권한 없는 링크 불가가 흔한 원인이라 적었다. 수정은 링크만 유지 | [paperclip `codex-home.ts` L240-295](https://github.com/paperclipai/paperclip/blob/6d117998c83b95fa612f3b252f6d3b68fc0f4f6b/packages/adapters/codex-local/src/server/codex-home.ts#L240-L295), [issue #5028](https://github.com/paperclipai/paperclip/issues/5028) | 소스 확인 / 문서 주장(issue) |
| <a id="E14"></a>E14 | OpenHands: 정본은 버전이 붙은 저장소(binding)이고 CLI에는 임시 파일(또는 home 링크)로 투영한다. 감시 스레드가 CLI가 실제로 쓰는 파일을 0.1초 주기로 읽어 바뀌면 `replace(기대 버전, 값)`(compare-and-swap)으로 정본에 되쓴다. 충돌·삭제는 고정 오류로 래치한다. 링크 실패(`OSError`)는 경고 후 내구 home을 포기하고 임시 폴더로 강등한다(정본은 그대로) | [OpenHands `acp_file_credentials.py` L135-205, L295-420](https://github.com/OpenHands/software-agent-sdk/blob/98c8cd30ddfa7282f29bb95eb1df62f1c28c39e1/openhands-sdk/openhands/sdk/agent/acp_file_credentials.py#L135-L205) | 소스 확인 |
| <a id="E15"></a>E15 | Google ADC(Node): `GOOGLE_APPLICATION_CREDENTIALS` 경로가 있으면 그 파일(오류에 변수 이름을 붙임), 없으면 고정 well-known 경로(`~/.config/gcloud/application_default_credentials.json`, Windows `%APPDATA%`)를 본다. 읽기 전 `realpath`로 링크를 푼다. `CLOUDSDK_CONFIG`는 이 파일에서 확인하지 못함(gcloud가 다른 자리에 두면 라이브러리는 못 찾을 수 있음=추론) | [google-auth-library-nodejs `googleauth.ts` L559-584, L586-625, L630-650](https://github.com/googleapis/google-auth-library-nodejs/blob/a95b8272197f35453d1647eed85be475d51474c9/src/auth/googleauth.ts#L559-L650) | 소스 확인 |
| <a id="E16"></a>E16 | Docker CLI: 설정 폴더는 `DOCKER_CONFIG`(명시)가 기본(`~/.docker`)을 이긴다. 저장은 symlink를 풀어(끊긴 링크 포함) 그 대상에 rename한다. 자격 증명 helper가 "credentials not found in native keychain"을 답하면 오류가 아니라 재로그인을 묻고, 다른 오류는 올린다. 조회마다 `client.Get(programFunc, …)`로 helper를 부른다(캐시 없음은 읽은 범위에서) | [docker/cli `config.go` L23, L76-84](https://github.com/docker/cli/blob/fdd4b8e5da335e1d0d83d29af5045f57280cd694/cli/config/config.go#L76-L84), [`configfile/file.go` L229-242](https://github.com/docker/cli/blob/fdd4b8e5da335e1d0d83d29af5045f57280cd694/cli/config/configfile/file.go#L229-L242), [`native_store.go` L119-127](https://github.com/docker/cli/blob/fdd4b8e5da335e1d0d83d29af5045f57280cd694/cli/config/credentials/native_store.go#L119-L127), [credential-helpers `error.go` L11](https://github.com/docker/docker-credential-helpers/blob/e8a52cbcf9ee5e522780b1bbf111fd7503ccb749/credentials/error.go#L11) | 소스 확인 |
| <a id="E17"></a>E17 | client-go: 투영된 서비스 계정 토큰 파일을 최대 1분마다 다시 읽는다. 읽기가 실패하면 직전 캐시 토큰을 계속 쓰고 오류만 기록하며, 캐시가 없을 때만 오류를 돌려준다 | [client-go `transport/token_source.go` L66-80, L162-195](https://github.com/kubernetes/client-go/blob/f6880c418a03339e2e36b986633c79863ec0a2a4/transport/token_source.go#L162-L195) | 소스 확인 |
| <a id="E18"></a>E18 | GitHub CLI: 키링 저장이 실패하면 평문 설정 파일로 폴백하고 `insecureStorageUsed`를 돌려 호출한 쪽이 알릴 수 있게 한다 | [cli/cli `internal/config/config.go` L516-545](https://github.com/cli/cli/blob/0536d5e5288458c696ccbeac0e68d87128300069/internal/config/config.go#L516-L545) | 소스 확인 |
| <a id="E19"></a>E19 | pnpm `symlink-dir`: Windows에서 symlink가 EPERM이면 junction으로 바꾸고 선택을 기억한다(디렉터리 전용). pnpm 패키지 가져오기 `auto`: 단계 폴백(clone→hardlink→copy), 실패 때 런타임에 다음 단계로. 패키지 파일은 불변이라 사본이 갈라질 일이 없다(추론) | [symlink-dir `src/index.ts` L49-85](https://github.com/pnpm/symlink-dir/blob/bfbaef3fc07b8d8cd26ba565c594849c5e403b4e/src/index.ts#L49-L85), [pnpm `indexed-pkg-importer/src/index.ts` L41-45, L83-90](https://github.com/pnpm/pnpm/blob/809b630a5f22a3fdbabf12b0cc8f7583434dacc7/pnpm11/fs/indexed-pkg-importer/src/index.ts#L41-L90) | 소스 확인 |
| <a id="E20"></a>E20 | git credential-store: `--file=<path>`로 명시 경로, 없으면 `~/.git-credentials`·XDG 두 후보. 쓰기는 lock 파일을 만들어 commit(rename)한다 | [git `Documentation/git-credential-store.adoc` L32-41](https://github.com/git/git/blob/e1ec09b23c8e0deb21a0b95ac5996422277395d4/Documentation/git-credential-store.adoc#L32-L41), [`builtin/credential-store.c` L65-76](https://github.com/git/git/blob/e1ec09b23c8e0deb21a0b95ac5996422277395d4/builtin/credential-store.c#L65-L76) | 소스 확인 / 문서 주장 |
| <a id="E21"></a>E21 | 합성 파일 실행(Linux 7.0 arm64 ext4 임시 폴더, Node 24.21.0). Codex식 저장(최종 대상을 풀어 같은 폴더 임시 파일에 쓰고 rename)을 흉내 내 연결 자리에서 갱신하면: symlink는 원본이 갱신을 받음, hardlink와 사본은 원본이 낡은 채 남음(갈라짐). 저장 흉내는 시뮬레이션이며 실제 Codex가 아니다. 실제 Codex는 hard link 파일 저장을 거부(E12) | 이 조사에서 실행한 합성 파일 시험(캐시에 보관) | 실행 확인(저장은 시뮬레이션) |
| <a id="E22"></a>E22 | VS Code dev containers는 호스트의 자격 증명 helper를 컨테이너가 재사용하게 한다("로컬에서 입력한 자격 증명을 컨테이너에서 재사용"). helper 미설정 때 동작은 문서에 없고, devcontainers/cli에서 구현을 찾지 못함. AWS CLI는 `AWS_SHARED_CREDENTIALS_FILE`로 자격 증명 파일 위치를 명시 지정(기본 `~/.aws/credentials`) | [VS Code 문서](https://code.visualstudio.com/remote/advancedcontainers/sharing-git-credentials), [AWS CLI v1 환경 변수](https://docs.aws.amazon.com/cli/v1/userguide/cli-configure-envvars.html) | 문서 주장 |
| <a id="E23"></a>E23 | Codex `model_providers.<id>.auth` 명령 helper(`external_bearer`): 명령이 준 토큰을 `refresh_interval`마다 다시 받는다. API key 형태(`CodexAuth::from_api_key`)로만 쓰이며 ChatGPT 로그인 갱신 흐름과는 다름(후자는 추론) | [codex `external_bearer.rs` L33-62](https://github.com/openai/codex/blob/c656014177079dae2dcc5e1e70c03e3158383a27/codex-rs/login/src/auth/external_bearer.rs#L33-L62) | 소스 확인 / 추론 |
| <a id="E24"></a>E24 | 부모 실행: 실제 `loginLink`의 rename을 gate로 멈추고 방법 A식 읽기(원본 칸 → 연결 자리)를 끼워 넣음. 링크가 돌아올 때(연결 자리 → 원본 칸 rename, 이어서 임시 링크 → 연결 자리 rename) "원본 칸 읽기(첫 rename 전) → 첫 rename → 연결 자리 읽기(둘째 rename 전)" 순서면 두 자리 모두 못 읽음. 한 번에 이어 읽은 경우와 링크가 안 되게 될 때(원본 칸 → 연결 자리)는 모두 읽힘 | 부모 실행 기록(시험 원문은 로컬 캐시 보관). 2026-11-17, Linux, symlink EPERM 모의 | 실행 확인(부모) |
| <a id="E25"></a>E25 | 부모 실행: GitHub Actions macOS 26.7.2(Darwin 25.6.0 arm64, Node 24.22.2)에서 hdiutil로 만든 ExFAT·FAT32·FAT16(`exfat`/`msdos`, fskit)은 symlink 성공, 링크 판정·따라 읽기·O_TRUNC 따라 쓰기·대상 풀어 rename 뒤 링크 유지 모두 정상. 하드 링크만 ENOTSUP(-45). APFS 대조 정상 | 부모 실행 기록. [run 44003064063](https://github.com/babo-jeonguk/BaboJUBot/actions/runs/44003064063)·[44003180807](https://github.com/babo-jeonguk/BaboJUBot/actions/runs/44003180807)(임시 브랜치, 삭제) | 실행 확인(부모) |
| <a id="E26"></a>E26 | 부모 실행(사용자 승인): 실제 agy 1.5.9, 실제 로그인의 복사본을 vfat 임시 HOME에 보통 파일로 두고 만료만 과거로 바꿔 `agy models`(모델 호출 없음)를 strace. 같은 경로를 `O_WRONLY|O_CREAT|O_TRUNC`로 덮어써 갱신(inode 동일, rename 없음), 갱신 토큰은 바뀌지 않음 | 부모 실행 기록(2026-11-17, 복사본·이미지 삭제) | 실행 확인(부모) |

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 링크를 런타임 탐침으로 판정(플랫폼 이름으로 가정하지 않음) | E01, E11, E09, E19 | git은 만들 때 한 번, symlink-dir은 첫 실패 때 기억, 우리는 매번 | 같은 OS라도 FS에 따라 다름을 잡음(E05·E06) | 오류 코드가 FS마다 다르다(EPERM·EOPNOTSUPP·ENOTSUP). 우리 집합은 셋을 이미 포함(E01) |
| <a id="P02"></a>P02 | 링크 실패 시 단계 폴백이나 강등 | E11 사본, E19 junction·copy, E14 임시 폴더, E13 포기 | 불변 데이터(pnpm)는 copy가 안전, 회전 자격 증명(Paperclip #5028)은 copy가 갈라진다 | 기능을 유지 | 회전하는 파일에 사본은 `refresh_token_reused`(E13, E21) |
| <a id="P03"></a>P03 | 갱신본이 쓰이는 자리를 읽는 쪽이 따른다(소유 CLI가 쓰는 파일을 읽음) | E14 감시, E17 재독, E15·E16 명시 경로 우선 | OpenHands는 CLI 파일→정본으로 되씀, k8s는 파일이 정본 | 정본이 하나 | 두 자리가 동시에 있을 때 우선순위가 필요 |
| <a id="P04"></a>P04 | 읽기 실패의 종류를 나눠 알린다("없음"과 "오류", 사용자가 할 일) | E16, E18, E14 | Docker는 없음→재로그인 요청, 오류→표시. gh는 폴백 사실을 플래그로 | 원인이 사용자에게 맞게 전달 | 우리 문구는 모든 읽기 실패를 "로그인을 고쳐라"로 말한다(E02, E03) |
| <a id="P05"></a>P05 | 일시 읽기 실패에 직전 값을 유지(래치하지 않음) | E17 | k8s는 캐시 유지, 우리는 래치 | 일시 장애에 강함 | 영구 장애를 늦게 알림. 우리는 보안상 거두기를 택함(`providers.md` 5) |

## 결정 권고

핵심: **수정 방식은 제품 정책이 갈리므로 열린 결정이다.** 아래 셋 중 고른 뒤 구현한다. D01은 어느 쪽이든 유효하다.

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 채택 | 링크 불가 때 실패 원인을 구분해 알린다. 준비 확인과 실패 문구가 "이 컴퓨터는 파일 링크를 만들 수 없다"를 말하고, 실패를 "로그인을 고쳐라"로 뭉뚱그리지 않는다 | P04, E02, E03(부모가 문구가 원인과 다름을 확인) | 어느 옵션이든 필요. 문구는 사용자에게 할 일이 같지 않기 때문 | Q4 |
| <a id="D02"></a>D02 | 후속(옵션 무관) | 복구 경로 점검: 링크 가능으로 돌아와도 준비 확인만으로는 풀리지 않고(`IsolationGate.readiness`가 연결 확인 앞에서 반환), 링크 불가에서는 다시 로그인·재시작으로 풀리지 않는다 | E03, E04, P05 | 구현 위치만 말함. 어떤 옵션을 고르든 recover가 링크 불가 경로에서 의미 있어야 함 | Q4 |
| <a id="D03"></a>D03 | 열린 결정(사용자) | 옵션 A·B·C 중 선택 | 아래 표 | 아래 | Q1 Q2 |

### 선택지 (열린 결정, owner 사용자)

| 옵션 | 내용 | 근거 | 장점 | 비용·실패 모드 | 닿는 제품 불변 조건 |
|---|---|---|---|---|---|
| A. 중계가 "소유 CLI가 지금 읽는 자리"를 읽는다 | 로그인 읽는 자리를 한 함수(`fileLogin`이 정함)로 모은다. 원본 칸이 읽히면 그것, 아니면 연결 폴더 자리(`keepAtFallback`이 옮긴 곳). 갱신은 이미 연결 폴더의 CLI가 그 자리에 쓴다 | P03: E14(CLI가 쓰는 파일을 읽음), E17(파일 재독), E15·E16(명시 경로 우선→고정 경로 순서). 같은 모양의 「두 자리 순서 읽기」를 한 사례로 그대로 보지는 못함(추론) | 로그인이 계속 하나(E01 결정 유지). 격리 실행이 링크 불가 컴퓨터에서도 동작. 복사·동기화 없음 | 링크가 돌아올 때 `linkLogin`이 연결 자리 파일을 원본 칸으로 `rename`하는 순간 두 자리를 차례로 읽는 쪽이 둘 다 못 읽을 수 있다(추론: 원본 읽기 실패→rename→연결 자리 읽기 실패). 한 번 재시도 필요. `docs/providers.md`의 "중계는 원본만 읽는다" 서술 변경 | 원본 비마운트: 유지. 연결 폴더 비마운트: 유지(중계는 호스트에서 읽음). 단일 로그인: 유지. 조직 경계: 영향 없음 |
| B. 링크 불가 때는 격리 실행을 시작 전에 막고 원인을 알린다 | 링크 가능 판정을 준비 확인에 노출해 `준비안됨`(격리 실행 미지원: 이 컴퓨터는 파일 링크를 만들 수 없음)으로 알린다. 현재 이동 동작은 유지, 격리를 끈 실행은 그대로 | P01(판정+기록: git), P04(원인 구분: Docker·gh), 고정 결정(Windows 격리 미지원 선례). E03: 지금은 준비 확인이 ready여서 실패 뒤에야 알게 됨 | 가장 작은 변경. 불변 조건 변화 없음. 실패 전에 알림 | 영향 컴퓨터(링크 못 만드는 FS에 데이터 폴더를 둔 Linux·macOS)에서 격리 실행 기능이 없다. 그런 배치가 흔한지는 확인하지 못함 | 모두 유지. 기능 범위만 줄어듦 |
| C. 원본은 로그인 전용 폴더에 두고 연결 자리는 동기화되는 사본으로 둔다 | 호스트 실행 전 원본→연결 자리 복사, 후 연결 자리가 바뀌었으면 원본으로 compare-and-write-back(지문 비교) | E13(Paperclip copy-back과 issue #5028의 제안 "실행 직전 동기화"), E14(CAS 되쓰기), E21(사본·hardlink는 갈라짐 실행 확인), E12(Codex는 hard link 거부라 hardlink 대안 불가) | 중계가 지금 코드 그대로 원본만 읽음 | 사본이 둘이라 호스트 실행(격리 끈 실행·갱신)과 중계 읽기가 겹치면 갈라진다. `refresh_token_reused`류 실패(E13). #146에서 「복사하지 않으므로 로그인은 하나」로 정한 것과 상충 | 단일 로그인 상충(사용자 판단). 나머지 유지 |

권고 순서(추론): 구현량과 불변 조건 영향이 가장 작은 B를 먼저(D01 포함)하고, 링크 불가 컴퓨터의 격리 실행이 제품 요구면 A를 더한다. C는 단일 로그인 결정과 상충해 권하지 않는다. 이 순서는 근거 E가 아니라 비용 비교에서 나온 판단이다.

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| hardlink로 공유 | E21, E12, E05 | Codex는 Unix에서 hard link 저장을 거부하고, 우회하면 저장 때 쪼개진다(E21). vfat·exfat은 `.link`도 없어 EPERM(E05). Windows NTFS 하드링크 권한은 이번에 확인하지 못함 |
| junction | E10, E19 | 디렉터리 전용이라 `auth.json` 파일 하나를 가리킬 수 없다. 로그인 전용 폴더를 CODEX_HOME으로 쓰는 변형은 CLI 상태가 그 폴더에 들어가 비마운트·단일 위치 규칙과 맞지 않는다(추론) |
| 사본만 두고 동기화 없음 | E13, E21 | 회전 토큰이 갈라진다 |
| env var·설정으로 자격 증명 경로 지정 | E15, E16, E20, E22 | 다른 도구에는 흔하나, 읽은 Codex `auth/` 파일에는 인증 파일만 가리키는 옵션이 없다(E12). Antigravity는 확인하지 못함 |
| Codex `auth` 명령 helper로 주입 | E23 | API key 형태로만 확인됨. ChatGPT 구독 로그인에는 맞지 않을 것(추론) |
| 일시 실패에 직전 값 유지(P05) | E17 | 보안 정책(실패 때 권한을 먼저 거둠, `providers.md`)과 맞지 않아 이번 범위에서 배제. 변경하려면 사용자 결정 |

## 구현 참고

- 권고 요약: D01 공통, 선택 A·B·C는 사용자 결정. 구현 위치(참고): `login-link.ts`(`keepAtFallback` 결과를 알리는 값), `file-login.ts`(읽기 자리 함수), `codex.ts`·`antigravity.ts`(`currentLogin`·`currentAccess`), `apps/server/src/isolation.ts`(`relayRefusalText`·`readiness`). 구조 문서 `docs/architecture.md`·`docs/providers.md` 기준으로 서술을 함께 바꾼다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 링크 거절 FS(실제 vfat 또는 `fs` 모의)에서 Codex·Antigravity 격리 실행 → A: 상류에 연결 자리의 토큰이 닿고 성공. B: 시작 전 `준비안됨`에 링크 사유 문구, 컨테이너 미시작 | E03 |
| V02 | A: 링크가 되돌아오는 순간(연결 자리→원본 칸 rename) 중계 요청 → 실패 래치 없이 성공. 중계 읽기가 같은 원본의 링크 작업과 차례를 지킴 | 실행 확인(E24: 차례 없이 순서 읽기는 실패) |
| V03 | 링크 불가에서 연결 자리에 새 로그인(다시 로그인) → 준비 확인이 풀림(A) 또는 문구가 같은 이유를 유지(B) | E03 A4 |
| V04 | 링크 가능 복귀 뒤 준비 확인만으로 중계 실패가 풀리는지 | E04 |
| V05 | 다른 조직·다른 연결 격리 실행에 원본·연결 자리가 노출되지 않음(마운트 목록에 없음) | 고정 결정 |
| V06 | 격리를 끈 실행이 링크 불가 컴퓨터에서 계속 연결 폴더로 돎 | E03 A5 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 링크 불가 컴퓨터에서 격리 실행을 지원할 것인가, 안내만 하고 막을 것인가 | 사용자 | 지원=옵션 A(로그인 하나 유지, 읽기 자리 규칙 추가). 막기=옵션 B(변경 최소). 사본 동기화=옵션 C(#146 결정과 상충) |
| 링크 불가 컴퓨터에서 로그인 복구를 사용자에게 어떻게 안내할 것인가(문구) | 사용자 | D01. 문구 자체는 제품 판단 |
| 중계 실패 래치 정책(P05)을 바꿀 것인가 | 사용자 | 보안(즉시 거둠)과 가용성(직전 값 유지) 사이. 이번 조사 범위 밖 |
| 준비 확인의 복구 경로 점검(D02) | 후속 이슈(생성 필요) | 링크 복귀·링크 불가 모두 |

## 한계와 미확인

2026-11-17 부모 추가 확인으로 갱신: 방법 A의 경합(E24), macOS FAT·exFAT(E25), agy 1.5.9의 보통 파일 갱신 자리(E26)는 실행 확인으로 바뀌었다. 사용자 결정: 방법 A(2026-11-17).

- 링크 거절이 실행으로 확인된 곳은 Linux vfat(E03)이다. Linux exfat(E05)·옵션 없는 CIFS(E06)는 커널 소스, ntfs-3g·ntfs3 거절 조건(E07)은 일부 소스뿐이다. 다른 macOS 판·실제 외장 디스크·SMB, Windows(격리 실행 미지원)는 실행하지 않았다.
- 실제 Codex 프로그램·실제 Docker·실제 Codex 로그인으로의 같은 흐름은 실행하지 않았다(부모 시험은 합성 토큰·가짜 docker, Codex 저장 자리는 소스 E12). agy는 1.5.9 갱신 자리만 실제로 확인했다(E26).
- Syncthing의 symlink 지원 판정, aws-vault, Claude Code `apiKeyHelper` 문서, Antigravity의 자격 증명 경로 옵션은 읽지 못했다. 다른 서비스의 "읽을 수 없는 때" 사용자 메시지 문구(Q4 일부)는 Docker·Google·gh 소스에서만 보았다.
- 위 「권고 순서」(B 먼저)는 비용 비교에서 나온 추론이었고, 사용자는 방법 A를 골랐다.
- git·Linux·Node·xnu의 license는 GitHub가 NOASSERTION으로 표시해 열어 확인하지 않았다. 코드 재사용 권고가 없으므로 설계 참고에 그친다. 재확인: upstream 변경, 코드 재사용 시 라이선스·NOTICE.
