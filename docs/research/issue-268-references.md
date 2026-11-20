# issue-268 레퍼런스 조사

실행 시도별 감독 실행기의 배포·프로토콜·정리 경계를 다룹니다. 확정 계약과 완료 조건은 [#268](https://github.com/babo-jeonguk/BaboJUBot/issues/268)에 있습니다. 조사일은 2026-11-20, 저장소 기준은 #263 병합 커밋 `4b3cb6a140d01e5503c8fefa65cfd4a1511e6312`입니다.

## Brief

- 구현할 문제는 서버 사망 뒤 실행 시도 소유권을 잃고, 재시작 때 기록된 PID와 시작 시각을 대조한 후 숫자로 신호하는 경합입니다. Windows의 출력 닫힘 지연과 대시보드에 드러나지 않는 정리 실패도 범위에 포함합니다.
- 동종 문제는 **생성 시 확보한 관리 권한을 종료 확인까지 유지하는 것**입니다. 권고는 ① 따라 쓰기 나쁜 모양을 만들지 않음 ② 근본 원인 제거 ③ 업계 관행 순으로 비교합니다.
- 고정 결정은 B(세 OS 공용 감독 실행기), C(macOS 미확인 대상은 신호 없이 기록·안내, 공개 API만 사용), D(동시 사망 시 기록과 DB 폴더를 보존하고 안전하게 확인된 대상만 정리), A(필요한 정리 장치 없으면 실행 거부)입니다. #266의 패키지 분리 뒤 구현하며 #267의 시험 전체 이행, cgroup 백엔드와 컨테이너 격리 변경은 별도 범위입니다.

| ID | 조사 질문 | 출처 | 전략 |
| --- | --- | --- | --- |
| Q1 | 사전 빌드 optional 패키지, 설치 시 빌드, 소스 checkout·CI·Docker 설치는 어떻게 다른가? | #268 착수 전 조사·실행 파일 | 레지스트리 메타데이터, 배포 소스, 깨끗한 설치와 optional 생략 대조 |
| Q2 | 지원 OS·CPU·ABI와 서명·격리 정책을 어디서 검증하는가? | #268 착수 전 조사·준비 실패 | OS·패키지 관리자 공식 계약, 현재 CI·이미지 대조 |
| Q3 | C·Rust·Go와 현 C# 실행기는 무엇을 직접 소유할 수 있는가? | #268 실행 언어·Linux/macOS 실행기 | 생성→관찰→그룹 신호→회수의 소스 비교 |
| Q4 | Node와 감독 실행기 사이에서 제어·서버 사망·출력 닫힘을 어떻게 관찰하는가? | #268 제어 프로토콜·[#263 후속 댓글](https://github.com/babo-jeonguk/BaboJUBot/issues/268#issuecomment-7017314390) | Node/Win32 계약, 상속과 채널의 실패 경로 |
| Q5 | OS별 실행기 사망과 재시작에서 어디까지 안전하게 정리할 수 있는가? | #268 B·C·D, 정리 안내 | 커널 계약·소스, Linux 실행, 실패·이전 기록 대조 |
| Q6 | #219 일반 경로와 무엇이 달라지고 어디에 기록하는가? | #268 문서·범위, #266 패키지 경계 | 이슈·아키텍처·운영 계약 대조 |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
| --- | --- | --- |
| [#259 후속 F1–F4](https://github.com/babo-jeonguk/BaboJUBot/issues/259#issuecomment-7016234956) | macOS 앵커, 실행마다 감독, cgroup 선택, Job 미확보 시 거부 | #267 브랜치의 조사 원문을 읽고 Bazel·Buck2·XNU의 인용 소스를 다시 확인. 해당 조사 고정 버전의 관찰을 사용 |
| [하위 프로세스 정리 조사](orphan-process-cleanup-references.md#근거) | OS별 수명 및 표식 탐색의 범위 | E03/E10의 API 계약 재확인. E14–E19는 기존 버전의 사례와 한계로 사용 |
| [#219 구현 기록](issue-219-implementation.md#사용자-결정-2026-11-17), [프로바이더 운영](../providers.md#세션과-정리) | 기존 일반 경로, 표식 및 복구 기록 이행 | #219의 명시적 사용자 결정과 현재 브랜치의 실행기·설치 경로 대조 |

## 레퍼런스

배포는 npm 메타데이터에서 시작해 실행 파일·네이티브 모듈·설치 훅을 나눠 읽고, 마지막에 lockfile 이슈와 실제 optional 누락을 대조했습니다. 수명은 Bazel·Buck2의 실행별 감독, tini의 init, Go/Rust 표준 라이브러리에서 API의 회수 시점을 비교했습니다. IPC·플랫폼 정책은 기존 Windows 실행기에서 Node·Win32 계약과 Apple·Microsoft 공식 배포 지침으로 넓혔습니다. 마지막 비교에서 각각 패키지 누락, 그룹 밖 자손, 채널 상속과 시스템 실행 정책이라는 기존 실패 모드의 변형을 확인했습니다. 아래 비교에서 각 메커니즘을 대표하는 사례를 골랐습니다.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
| --- | --- | --- | --- | --- | --- |
| Biome·esbuild | Rust·Go 실행 파일 | 2.6.8·0.28.2, E01–E02 | MIT OR Apache-2.0·MIT | 실행·소스 | optional 패키지 선택과 다운로드 대안 |
| Turborepo·SWC·Rollup | 실행 파일·네이티브 모듈 | 2.11.13·1.16.22·4.68.7, E03–E05 | MIT·Apache-2.0·MIT | 소스, Rollup 실행 | 아키텍처 자동 대체·WASM·로더 오류 비교 |
| Bazel·Buck2·tini | C++·Rust·C 감독 | E09의 고정 SHA, tini는 [기존 E14](orphan-process-cleanup-references.md#E14) | Apache-2.0·MIT/Apache-2.0·MIT | 소스 | 회수 시점, 감독이 살아 있어야 하는 범위 |
| Go·Rust·Node | 런타임 API | E10–E11 | BSD-3-Clause·MIT/Apache-2.0·MIT | 공식 API·Node 고정 소스 | 언어별 자식 회수와 Node의 채널 계약 |
| Linux 커널·XNU·Windows Job | 커널 자원 | E09, E12–E15 | GPL-2.0·APSL/BSD 계열·공식 OS 문서 | 소스·문서, Linux 실행 | 번호 재사용 방지와 실행기 사망 후 소유권 |
| npm·pnpm·Docker·Apple·Microsoft | 설치·배포 계약 | E06–E08, E16 | 공식 문서 | 문서 | 타깃 설치, 출처 추적, 시스템 실행 정책 |

## 근거

| ID | 관찰 | 출처 | 수준 |
| --- | --- | --- | --- |
| <a id="E01"></a>E01 | Biome의 JS 진입점은 플랫폼별 Rust 실행 파일을 optional 패키지에서 해결합니다. Linux glibc/musl 변형을 구분하고 런타임 자체의 설치 훅은 없습니다. 배포 CI가 타깃을 만들고 정해진 manifest로 패키징합니다. | [manifest](https://github.com/biomejs/biome/blob/8b032240882efdb1f9c3d3c77392c11877b4d6bb/packages/%40biomejs/biome/package.json#L46-L60), [shim](https://github.com/biomejs/biome/blob/8b032240882efdb1f9c3d3c77392c11877b4d6bb/packages/%40biomejs/biome/bin/biome#L5-L56), [빌드 행렬](https://github.com/biomejs/biome/blob/8b032240882efdb1f9c3d3c77392c11877b4d6bb/.github/workflows/release_cli.yml#L42-L64) | 소스 확인 |
| <a id="E02"></a>E02 | esbuild는 optional 패키지부터 찾고 postinstall에서 누락 시 npm 재호출→직접 다운로드를 시도합니다. 선택한 바이너리의 버전을 실행해서 확인합니다. | [`checkAndPreparePackage`](https://github.com/evanw/esbuild/blob/609683d892977362a0f99026cb74b96263d728a9/lib/npm/node-install.ts#L265-L325) | 소스 확인 |
| <a id="E03"></a>E03 | Turbo는 optional 실행 파일을 해결하고 누락 시 보조 설치를 시도합니다. x64 Node와 arm64 하드웨어가 다른 상황도 별도 처리합니다. | [`turbo` shim](https://github.com/vercel/turborepo/blob/c5ec6b7daecd18283bd3a931ff297f4dafcf3b71/packages/turbo/bin/turbo#L116-L209) | 소스 확인 |
| <a id="E04"></a>E04 | SWC는 OS·CPU·libc에 맞는 Node 네이티브 바인딩을 로드하며 postinstall에서 바인딩 검증 실패 시 WASM 설치를 시도합니다. | [`requireNative`](https://github.com/swc-project/swc/blob/0cf74ca167e745b03ee65e6645b215a6dc4c690e/packages/core/binding.js#L195-L247), [postinstall](https://github.com/swc-project/swc/blob/0cf74ca167e745b03ee65e6645b215a6dc4c690e/packages/core/postinstall.js#L88-L149) | 소스 확인 |
| <a id="E05"></a>E05 | Rollup은 플랫폼별 `.node` 로더이며 Windows에서 VC++ 런타임 DLL 누락을 별도 안내합니다. npm의 타깃 변형 lockfile 누락 보고가 있습니다. | [`requireWithFriendlyError`](https://github.com/rollup/rollup/blob/dd75c77b718581406bd6886f84dfdf2ebf50c5e7/native.js#L95-L154), [npm #7961](https://github.com/npm/cli/issues/7961) | 소스 확인·문서 주장 |
| <a id="E06"></a>E06 | npm의 optional 설치 실패·생략은 상위 설치 성공과 양립합니다. manifest의 `os`·`cpu`·`libc`와 pnpm의 `supportedArchitectures`는 선택·보관 범위를 정합니다. | [npm manifest](https://docs.npmjs.com/cli/configuring-npm/package-json/#optionaldependencies), [pnpm 10 설정](https://pnpm.io/10.x/settings#supportedarchitectures) | 문서 주장 |
| <a id="E07"></a>E07 | macOS arm64는 유효한 코드 서명이 필요하고 로컬 빌드의 ad hoc 서명도 그 조건을 충족합니다. 배포 신뢰는 Developer ID와 공증의 별도 조건입니다. 독립 실행 파일도 공증 티켓을 얻지만 직접 staple할 수 없습니다. | [Apple silicon 서명](https://developer.apple.com/documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes), [공증](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [독립 실행 파일 티켓](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow), [Gatekeeper CLI 사례](https://developer.apple.com/forums/thread/706379) | 문서 주장 |
| <a id="E08"></a>E08 | Windows SmartScreen은 서명자와 파일 평판을 봅니다. 신뢰된 서명이 있어도 새 파일의 평판에 따라 경고가 나올 수 있습니다. Windows 11의 Smart App Control은 인터넷 표시가 없는 실행 파일에도 적용될 수 있습니다. Linux는 잘못된 실행 형식, ELF 로더 누락, 권한 및 `noexec` 실패를 구별합니다. | [Microsoft SmartScreen](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation), [Linux execve 오류](https://man7.org/linux/man-pages/man2/execve.2.html#ERRORS) | 문서 주장 |
| <a id="E09"></a>E09 | Bazel Darwin은 NOTE_EXIT 관찰 뒤 전용 그룹을 정지하고 대표를 회수합니다. Buck2는 `waitid(WNOWAIT)`와 `si_code`를 써서 회수 전 exit를 구별합니다. XNU는 좀비를 포함한 점유 PID와 기존 PGID/SID를 새 번호 할당에서 건너뜁니다. | [Bazel `process-wrapper-legacy`](https://github.com/bazelbuild/bazel/blob/8de4b46b6a2823b68d7ee704621e8a2441d1d879/src/main/tools/process-wrapper-legacy.cc#L99-L149), [Buck2 `waitid_exited`·그룹 정리](https://github.com/facebook/buck2/blob/296d874cfd8a78834129d2e25395463dbfb37a1c/app/buck2_process_kill/src/unix.rs#L14-L163), [XNU `forkproc`](https://github.com/apple-oss-distributions/xnu/blob/8d741a5de7ff4191bf97d57b9f54c2f6d4a15585/bsd/kern/kern_fork.c#L960-L980) | 소스 확인 |
| <a id="E10"></a>E10 | Rust `Child`는 drop만으로 wait하지 않으며 `try_wait`는 종료한 자식을 회수합니다. Go `Cmd.Wait`는 프로세스 및 I/O 자원을 회수합니다. 소유권을 유지하려면 관찰 단계와 최종 wait를 설계에 명시해야 합니다. | [Rust Child](https://doc.rust-lang.org/std/process/struct.Child.html), [Go Cmd.Wait](https://pkg.go.dev/os/exec#Cmd.Wait), [waitid](https://man7.org/linux/man-pages/man2/waitid.2.html) | 문서 주장 |
| <a id="E11"></a>E11 | Node v24의 spawn은 fd 3 이상에 제어 채널을 추가할 수 있습니다. `exit`와 stdio `close`는 다른 사건입니다. Node 전용 IPC와 별개로 일반 바이트 스트림을 넘길 수 있습니다. | [Node v24.21.0 stdio](https://github.com/nodejs/node/blob/955266bfdd854cd280dffd47548673914484e4c0/doc/api/child_process.md#L1000-L1057), [exit와 close](https://github.com/nodejs/node/blob/955266bfdd854cd280dffd47548673914484e4c0/doc/api/child_process.md#L1433-L1444) | 문서 주장 |
| <a id="E12"></a>E12 | Linux subreaper는 자신이 살아 있는 동안 고아를 입양·회수할 수 있습니다. PDEATHSIG는 설정한 자식에만 적용되고 fork 자식에 상속되지 않습니다. 부모 스레드가 설정 전에 끝나는 경합과 권한 변경 exec에서의 해제가 있습니다. | [subreaper](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html), [PDEATHSIG](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html), [기존 실행 F2e](https://github.com/babo-jeonguk/BaboJUBot/issues/259#issuecomment-7016234956) | 문서 주장·기존 관찰 |
| <a id="E13"></a>E13 | Linux에서 열린 `/proc/<pid>` 디렉터리 fd는 `pidfd_send_signal`의 대상으로 쓸 수 있습니다. 같은 fd 기준 `openat` 검증으로 숫자 PID를 다시 열 필요가 없습니다. 이 fd 자체는 poll이나 `waitid(P_PIDFD)`용이 아닙니다. | [API](https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html#NOTES), [pidfd_open 차이](https://man7.org/linux/man-pages/man2/pidfd_open.2.html#NOTES), [PID 재사용 시 열린 proc FD](https://docs.kernel.org/filesystems/proc.html#process-specific-subdirectories), [커널 fd 변환](https://github.com/torvalds/linux/blob/adc218676eef25575469234709c2d87185ca223a/fs/proc/base.c#L3428-L3440) | 소스 확인·문서 주장 |
| <a id="E14"></a>E14 | Windows는 마지막 Job 핸들이 닫히면 가입한 프로세스에 종료를 요청합니다. `JOB_LIST`는 생성할 때 가입시키고, 중단 상태로 생성한 뒤 가입시키는 방법에는 생성자 사망 창이 있습니다. 핸들 허용 목록은 전달 가능한 핸들을 제한합니다. | [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [프로세스 생성 속성](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute), [생성자 사망 창](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812) | 문서 주장 |
| <a id="E15"></a>E15 | 현재 Windows 실행기는 `SetHandleInformation`의 결과를 사용하지 않고 `ok` 뒤 표준 핸들을 닫습니다. `CloseHandle` 결과도 사용하지 않으며 자식 생성은 일반 핸들 상속을 켭니다. 이 소스에서 실패 가능 위치를 볼 수 있지만 CI에서 어떤 핸들이 남았는지는 확인되지 않았습니다. | [제어 채널](https://github.com/babo-jeonguk/BaboJUBot/blob/4b3cb6a140d01e5503c8fefa65cfd4a1511e6312/packages/runtime/src/providers/job-object-launcher.cs#L156-L169), [준비와 닫기](https://github.com/babo-jeonguk/BaboJUBot/blob/4b3cb6a140d01e5503c8fefa65cfd4a1511e6312/packages/runtime/src/providers/job-object-launcher.cs#L219-L277), [프로그램 생성](https://github.com/babo-jeonguk/BaboJUBot/blob/4b3cb6a140d01e5503c8fefa65cfd4a1511e6312/packages/runtime/src/providers/job-object-launcher.cs#L352-L388) | 소스 확인 |
| <a id="E16"></a>E16 | Docker는 빌드 호스트와 이미지 대상의 OS/CPU를 구별합니다. 릴리스의 출처 증명과 재현성은 다른 성질입니다. npm OIDC provenance로 게시 출처를 남길 수 있고, 재현성은 같은 입력의 산출물 비교로 검증합니다. | [Docker 멀티플랫폼](https://docs.docker.com/build/building/multi-platform/), [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [Reproducible Builds 정의](https://reproducible-builds.org/docs/definition/) | 문서 주장 |
| <a id="E17"></a>E17 | Linux arm64/glibc에서 Node 24.21.0·pnpm 10.33.0으로 Biome·esbuild·Rollup을 빈 환경에 `--ignore-scripts`로 설치하고 세 `--version`이 성공했습니다. 새 디렉터리에 `--ignore-scripts --no-optional --offline` 설치는 성공했으나 세 실행 모두 필요한 Linux arm64 패키지 누락으로 종료 1이었습니다. | E01·E02·E05의 공개 npm 버전. 임시 store, 빈 사용자 설정, 타 OS/CPU 항목을 포함한 lockfile. 깨끗한 디렉터리의 frozen offline 설치에서도 3개 CLI 실행 성공 | 실행 확인 |
| <a id="E18"></a>E18 | Linux 7.0.0-1013-oracle arm64·Python 3.12.3에서 소유한 합성 자식의 `O_RDONLY`, `O_DIRECTORY`, `O_CLOEXEC` 플래그로 연 procdirfd로 표식·시작 tick을 읽고 해당 fd에만 TERM을 보내 종료를 확인했습니다. argv에만 표식이 있던 자식은 생존했습니다. `O_PATH` fd는 `openat`은 됐으나 신호 호출은 EBADF. 회수 뒤 기존 fd의 신호 0과 stat 열기는 ESRCH였습니다. 별도 생성 시점 pidfd로 poll 및 `waitid(WNOWAIT)`를 확인했습니다. | E12–E13의 공개 계약을 작은 합성 프로세스로 대조 | 실행 확인 |
| <a id="E19"></a>E19 | Linux arm64에서 Node 24.21.0으로 상속 출력을 보유하는 합성 실행기를 시험했습니다. 정상 경로는 대표 exit 뒤 실행기와 fd 3이 살아 있을 때 stdout·stderr의 EOF와 개행 없는 마지막 바이트가 도착했습니다. 실행기가 출력 쓰기 사본을 고의 유지한 대조에서는 fd 3이 응답하는 동안 EOF가 없었고 실행기가 끝난 뒤 도착했습니다. | E11의 Node API를 사용한 합성 프로세스 | 실행 확인 |
| <a id="E20"></a>E20 | Node 24.21.0의 지원 표에서 Linux GNU x64/arm64의 커널 하한은 4.18, glibc는 2.28이며 macOS의 두 CPU 하한은 13.5입니다. Windows의 지원 등급과 최소 버전은 CPU별로 기록됩니다. macOS GitHub 호스팅 실행기는 Intel과 arm64가 별도 라벨입니다. | [Node 지원 표](https://github.com/nodejs/node/blob/955266bfdd854cd280dffd47548673914484e4c0/BUILDING.md#L100-L121), [GitHub 실행기](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories) | 문서 주장 |
| <a id="E21"></a>E21 | Go의 Linux 내부 관찰은 `WNOWAIT` 뒤 실제 Wait 호출을 준비하는 용도입니다. Go 소스가 Darwin의 정지 상태 반환을 명시하고, Buck2는 `si_code`로 실제 exit를 구별합니다. 설치 시 빌드의 예인 node-gyp는 Python과 대상 OS 빌드 도구를 요구합니다. | [Go `blockUntilWaitable`](https://github.com/golang/go/blob/6e676ab2b809d46623acb5988248d95d1eb7939c/src/os/wait_waitid.go#L5-L36), [Buck2 `is_exit`](https://github.com/facebook/buck2/blob/296d874cfd8a78834129d2e25395463dbfb37a1c/app/buck2_process_kill/src/unix.rs#L43-L81), [node-gyp 12.1.0](https://github.com/nodejs/node-gyp/blob/98307b03a1381cf6697d80081b6cd05a47e412bc/README.md#installation) | 소스 확인·문서 주장 |

## 패턴

| ID | 패턴 | 사례 | 차이·장점 | 비용·실패 모드 |
| --- | --- | --- | --- | --- |
| P01 | 고정 버전의 타깃별 사전 빌드 패키지 | E01–E06, E17 | 작은 shim이 이미 설치된 파일을 선택. 패키지 관리자와 CI가 무결성·타깃을 관리 | optional 생략, 대상 버전 미게시, 잘못된 lockfile·이미지 캐시 |
| P02 | 설치·서버 시작 시 소스 빌드 | 현 Windows C# 조립 | 대상에 맞춰 빌드하기 쉬우며 checkout 개발에 편리 | 시스템별 툴체인·SDK·lifecycle 정책, 배포 서명·재현성, 서버 시작 시 실패 |
| P03 | 상속된 제어 채널과 별도의 stdio | E11·E15·E19 | 서버의 채널 수명이 명령 대상과 함께 생성됨. 로컬 소켓은 재접속과 수명 독립을 제공 | 별도 포트/소켓은 접근 제어·인증·연결 전 경합·정리 사유 추가. 잘못된 상속은 EOF 지연 또는 채널 노출 |
| P04 | 자식 wait 앵커와 관리 단위의 종료 확인 | E09·E12·E14 | POSIX는 직접 자식 회수 순서, Windows는 Job 가입 및 활성 수 | POSIX 새 세션은 그룹 범위 밖. Windows에는 마지막 핸들 소유와 가입 전 경합이 중요 |
| P05 | 신원을 같은 객체에서 검증하고 신호 | E13·E18 | Linux procdirfd와 Windows 프로세스 HANDLE은 후보 번호를 다시 사용하지 않음 | 조회 권한·커널 능력 부족, macOS의 동등한 공개 신호 객체 부재, 트리 종료와 개별 종료의 차이 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
| --- | --- | --- | --- | --- | --- |
| <a id="D01"></a>D01 | 채택 | CI가 재현 가능한 빌드 절차로 타깃별 실행 파일을 만들어 정확히 같은 버전의 npm optional 패키지로 배포합니다. checkout에서는 명시적인 개발 빌드가 같은 진입점의 산출물을 만들게 합니다. 시작 시 협상·실제 무해한 프로그램 실행·정리까지 확인합니다. | P01–P02, E16–E17 | 설치와 실행 판정 분리. 자동 다운로드·컴파일이나 Node 직접 실행을 두면 누락과 약화가 숨습니다. | Q1 |
| <a id="D02"></a>D02 | 변형 채택 | 첫 배포 권고는 Linux glibc x64/arm64, macOS x64/arm64, Windows x64. 타깃 OS 최소판·Linux kernel/seccomp 능력은 실행 시험으로 고정합니다. Linux musl과 Windows arm64는 별도 네이티브 CI 및 제품 DB·프로바이더 설치 계약을 확보할 때 추가합니다. | E01·E06–E08·E13·E16·E20, 현 CI | 바이너리 지원과 제품 전체 지원 범위를 맞춥니다. | Q2 |
| <a id="D03"></a>D03 | 변형 채택 | POSIX는 작은 Rust 실행기를 권고합니다. 명시적인 wait·해제와 소유 fd를 사용하고 OS 호출 경계를 좁힙니다. Windows는 현재 C# Job 코드를 공용 프로토콜과 CI 빌드에 맞춰 유지합니다. | E09–E10·E14–E15·E21 | 현재 Windows 인수 전달과 Job 계약을 재사용합니다. POSIX 쪽은 바이트 파싱·fd 수명 오류의 표면을 줄이는 대신 Rust 도구·라이브러리 버전을 유지합니다. | Q3 |
| <a id="D04"></a>D04 | 채택 | fd 3의 전용 양방향 채널에 판·준비, 대표 exit, stop, 범위 종료 결과를 구분합니다. 서버가 유일한 상대 끝단 소유자임을 생성 단계에서 보장하고, 자식에게는 필요한 stdio만 넘깁니다. 제어 EOF는 정지 요청과 같은 정리 진입점입니다. | P03, E11·E14–E15·E19 | 프로바이더 입출력과 수명·정지 결과를 섞지 않습니다. 별도 소켓 리스너·복구 명령 채널의 운영 비용을 피합니다. | Q4 |
| <a id="D05"></a>D05 | 변형 채택 | POSIX는 대표 미회수 상태에서 전용 그룹에 마지막 신호를 보냅니다. Linux는 subreaper·직접 자식 PDEATHSIG와 표식에 대한 fd 기반 신호를 조합합니다. macOS는 NOTE_EXIT 및 그룹 앵커, 그룹 밖은 검증·안내를 사용합니다. Windows는 Job에 생성 시 가입시키고 마지막 비상속 Job 핸들과 활성 수를 확인합니다. | P04–P05, E09·E12–E15·E18 | 앵커와 Job의 보장은 각 관리 범위에 한정됩니다. Windows 가입 실패를 시작 실패로 처리하면 중단 상태 고아 창도 제거할 수 있습니다. | Q3–Q5 |
| <a id="D06"></a>D06 | 변형 채택 | 서버만 죽으면 실행기가 같은 정리를 수행하고 성공·미확인 결과를 실행 시도 기록에 남깁니다. 실행기가 함께 죽거나 완료 증거가 없으면 안정된 객체를 확보한 대상만 회수하며 기록·DB 폴더와 확인 상태를 남깁니다. 이전 포맷도 같은 규칙을 적용합니다. | P05, E12–E15·E18, #268 C·D | PID·시각 대조 후 숫자로 신호하는 모양을 없앱니다. 복구 증거 부족은 조직별 안내에 남습니다. | Q5 |
| <a id="D07"></a>D07 | 채택 | 구현 PR에서 ADR을 작성합니다. #219의 일반 설치 요구를 계속 적용하고, Node 직접 실행·숫자 신호 복구에서 플랫폼별 감독 실행기 및 보수적 복구로 바뀐 부분을 기록합니다. | #219 사용자 결정, #266, #268 | 필수 배포 자산과 정리 보장의 경계는 이후 설치·런타임·복구 설계에도 적용됩니다. | Q6 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
| --- | --- | --- |
| 런타임 자동 다운로드·설치 훅 재시도·약한 실행으로 전환 | esbuild/Turbo 보조 설치, SWC WASM 대체 | #268은 설치 오류가 드러나고 같은 보장으로만 실행되는 경로를 요구합니다. 다운로더를 제품 코드에 두면 lockfile 밖 입력과 오류 처리 경로도 늘어납니다. |
| stdio에 제어 행 끼우기, Node 전용 IPC 의존, 소켓 재접속을 기본으로 두기 | 기존 프로바이더 stdio, Node `ipc`, 일반 로컬 소켓 | 출력에 섞인 내용과 제어 결과를 구분하고, OS 간 하나의 명령·EOF 계약을 유지해야 합니다. |
| 기록을 읽고 숫자로 신호, macOS SPI, 시간 뒤 출력 강제 닫기 | 기존 복구, #259 F1의 SPI 후보, [#263 후속 댓글](https://github.com/babo-jeonguk/BaboJUBot/issues/268#issuecomment-7017314390) | 소유권 확인과 신호 사이가 다시 갈라지거나, 원인을 덮어 작성자가 남아 있어도 출력이 끝난 것처럼 보입니다. |
| 필수 systemd·cgroup 또는 PID namespace | Bazel linux-sandbox·systemd | #219 일반 경로와 #268 범위. 커널 관리 단위의 향후 도입은 실제 가입을 확인한 실행기 백엔드에서 검토합니다. |

## 구현 참고

#266 뒤 `@babojubot/process`가 설치된 실행 파일 선택·준비 확인과 시작/정지 계약을 소유합니다. 실행 시도와 조직을 연결하는 기록·복구는 runtime의 책임이고 대시보드에는 관찰된 정리 결과를 전달합니다. 실행기는 토큰이나 DB 자격 증명 없이 기록 ID로 종료 결과를 남길 수 있어야 합니다. 구조와 운영 동작은 [아키텍처](../architecture.md)와 [프로바이더 운영](../providers.md)에 갱신하고 코드 규칙과 lint는 이슈가 정한 경계에서 확인합니다.

### 배포 및 지원 범위

| 환경 | 권고 설치 경로와 확인 |
| --- | --- |
| 릴리스 | 타깃 manifest에 `os`·`cpu`와 필요한 `libc` 제약을 둡니다. 버전별 아티팩트를 먼저 게시·검증하고 공용 패키지가 정확한 버전을 참조하게 합니다. 소스 SHA, 고정 툴체인·SDK·의존성, 서명 전 SHA-256, 최종 패키지 해시를 기록합니다. 두 빌드의 지정 산출물을 비교하고, 서명·공증 및 타임스탬프는 별도 배포 단계로 검증합니다. |
| 개발 checkout | 명시적 개발 빌드를 제공하고 같은 경로 선택·판 협상·정리 준비 시험을 씁니다. pnpm 10.33.0의 기존 내장 Postgres 설치 훅은 그대로 필요합니다. 배포된 감독 실행기는 설치 훅 없이 동작하도록 확인합니다. 누락 시 어떤 패키지나 빌드가 필요한지 알려 줍니다. |
| CI | Linux x64/arm64, macOS Intel/Apple silicon, Windows x64에서 호스트 아키텍처·Node 아키텍처·실행 파일 종류를 기록합니다. `-latest` 이름 하나로 양쪽 CPU를 검증했다고 간주하지 않습니다. 깨끗한 설치와 frozen lockfile, optional 생략, 잘못된 바이너리/판, 실행 권한·정책 오류를 확인합니다. |
| 서버 Docker 이미지 | 지원할 경우 최종 이미지의 대상 CPU와 libc에 맞게 target 단계에서 설치하거나 대상 아티팩트만 복사합니다. 호스트의 `node_modules` 재사용을 피하고 최종 이미지에서 probe를 돌립니다. |
| 기존 격리 실행 이미지 | [runner Dockerfile](../../docker/runner/Dockerfile)은 Debian Bookworm slim의 amd64/arm64 프로바이더 이미지입니다. 감독기는 서버가 시작한 호스트의 Docker CLI를 관리합니다. 컨테이너 정리는 현 격리 경로가 맡으므로 이 이미지 안에 감독기를 또 설치할 근거가 없습니다. |

Linux glibc 바이너리는 실제 가장 오래된 지원 사용자 공간에서 로더·심볼 기준을 검사합니다. musl이 필요해지면 x64·arm64 각각 glibc/musl 패키지를 구분하는 안과 단일 정적 musl ELF를 배포하는 안을 비교할 수 있습니다. 정적 링크로 로더 의존성을 줄여도 둘의 커널·`/proc`·seccomp 시험은 각각 필요합니다. `pidfd_send_signal`은 Linux 5.1, `pidfd_open`은 5.3, `waitid(P_PIDFD)`는 5.4부터 문서화됐습니다. 5.4는 세 API를 사용하는 설계의 후보 하한이며, Node 자체의 GNU/Linux 하한인 4.18보다 높습니다. 지원 범위를 올리려면 ADR과 설치 안내에 드러내고, 커널 버전 문자열 대신 실제 기능으로 준비 여부를 판정합니다. [E08](#E08), [E13](#E13), [E20](#E20).

macOS는 둘로 나눈 Mach-O를 권고합니다. universal은 같은 패키지를 수동으로 배포할 때는 편하지만 각 npm 타깃이 양쪽 슬라이스를 내려받습니다. Apple silicon의 ad hoc 링크 서명은 개발용, 공개 배포의 Developer ID·Hardened Runtime·공증은 별도 배포 파이프라인으로 둡니다. 일반 npm 설치와 브라우저로 받은 격리 속성 있는 아카이브를 각각 시험하고, `com.apple.quarantine`이 어떻게 전파되는지는 설치 경로별로 기록합니다. 공증 티켓을 개별 바이너리에 staple할 수 없으므로 격리된 오프라인 배포가 필요하면 staple 가능한 배포 포맷을 따로 검토합니다. [E07](#E07).

Windows는 공개 릴리스의 Authenticode 서명·타임스탬프를 권고합니다. 일반 npm 설치와 인터넷 표시(Mark of the Web)가 붙은 다운로드의 실행을 따로 보며 SmartScreen·Smart App Control·Defender 결과를 구분합니다. 정책에 막히면 준비 실패로 보고합니다. 현재 fd 3 어댑터는 Node/libuv가 넘기는 CRT 핸들 슬롯을 읽습니다. 해당 ABI를 Windows 어댑터에만 두고 같은 비트수의 Node와 실행기로 검증합니다. Windows arm64는 [Microsoft의 .NET Framework Arm 조건](https://learn.microsoft.com/en-us/lifecycle/faq/dotnet-framework)과 전체 제품 설치를 확인한 뒤 추가할 수 있습니다. [E08](#E08), [Node/libuv 핸들 슬롯](https://github.com/nodejs/node/blob/955266bfdd854cd280dffd47548673914484e4c0/deps/uv/src/win/process-stdio.c#L32-L54).

### 언어와 제어 통로

C는 tini처럼 의존성이 적고 OS 호출과 빌드가 직접적입니다. 이번에는 프로토콜 및 표식 바이트 파싱, 생성·실패 경로의 fd 정리가 필요해 메모리 안전성과 소유 fd가 있는 Rust가 유리합니다. Go는 esbuild처럼 사전 빌드하기 좋지만 `os/exec.Wait`만으로 회수 전 종료를 보는 계약을 만들 수 없고, 저수준 대기와 생성 스레드 수명을 명시적으로 다뤄야 합니다. C#은 기존 Windows 구현과 운영 경험을 이어 갈 수 있고 CI에서 사전 빌드하면 사용자의 컴파일러 의존은 사라지고 .NET Framework CLR 의존은 남습니다. CI는 고정된 참조 어셈블리와 결정적 빌드를 검증합니다. 한 언어로 통일하는 Rust/Win32 구현은 상속·인수·중첩 Job 경로를 다시 검증하는 비용이 있습니다. 출처의 코드는 설계 비교에 사용했습니다. [E02](#E02), [E09](#E09), [E10](#E10), [E14](#E14), [E15](#E15), [E21](#E21), [C# 결정적 컴파일](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-options/code-generation#deterministic).

준비 응답에는 전용 그룹이나 Job과 제어 핸들 설정의 성공이 반영되어야 합니다. POSIX는 proc 생성 경계에서 close-on-exec와 허용 fd를 확인합니다. Windows는 `HANDLE_LIST`로 자식 상속을 stdin/stdout/stderr만 허용하고 실행기의 중복 표준 핸들을 준비 전에 닫습니다. 실제 프로바이더나 그 자손의 stdout/stderr 유지 여부, 실행기의 fd 3 종료, 대표 exit, 트리 종료는 별도 관찰값입니다. 시작 전 판 불일치, 손상 프레임, 중복 stop, EOF 중 부분 프레임, 끊긴 채널의 쓰기 오류에도 정리를 완료해야 합니다. 실행기 정리 중에는 결과 메시지를 보낼 상대가 남아 있다는 전제에 의존하지 않습니다. [E11](#E11), [E14](#E14), [E15](#E15).

### 재시작 복구

| 사건 | 소유권과 신호 | 기록·폴더 |
| --- | --- | --- |
| 정상 정지 또는 대표 먼저 exit | 같은 실행기가 전용 그룹이나 Job의 정지와 종료 확인을 끝냅니다. Linux 탈출 후보는 fd를 잡아 확인하고, macOS에서 신호할 권한을 안정적으로 확보할 수 없는 후보는 기록합니다. | 성공 기록과 미확인 기록을 다르게 남깁니다. |
| 서버만 강제 종료 | 상속된 제어 채널 EOF에서 실행기가 동일 정리를 수행합니다. 재시작 서버는 실행기가 끝냈다는 결과를 소비하며, 완료 전에는 중복 정리하지 않습니다. | 실행기는 서버/DB 연결 없이 자기 실행 시도 결과를 닫을 수 있어야 합니다. |
| 실행기만 강제 종료 | Windows는 마지막 Job 핸들이 닫혀 가입 프로세스를 종료합니다. Linux는 직접 자식 PDEATHSIG가 여전히 적용될 수 있으나 새 세션 손자와 재부모화 이후에는 별도 확인이 필요합니다. macOS NOTE_EXIT는 관찰만 합니다. | 성공 응답이 없는 상태와 폴더를 보존하고 운영자가 확인할 이유를 노출합니다. |
| 서버와 실행기 동시 사망, 또는 완료 결과 없음 | Linux는 같은 부팅인지 먼저 대조한 뒤, 같은 procdirfd로 시작 시각과 가능한 표식을 검증하고 TERM/KILL을 보냅니다. macOS는 표식·시각이 보이더라도 그룹 앵커나 공개 API의 안정된 신호 자원이 없으면 수동 안내합니다. Windows는 Job을 PID로 재구성하지 않으며, 개별 회수는 열린 HANDLE에서 소유 증거와 생성 시각을 대조할 수 있을 때에 한합니다. | 안전하게 회수한 것과 확인이 필요한 것을 같은 실행 시도 결과에 기록합니다. 이 경로에서는 기록과 DB 폴더를 남기고 사람이 확인 후 기록을 닫습니다. |
| 이전·부분·손상 기록 | 형식을 판별해 검증 가능한 증거만 읽습니다. Linux의 적합한 과거 boot ID/표식/시각은 같은 fd 확인에 사용할 수 있습니다. 대상·조직·실행 시도 연결이나 증거가 부족하면 신호 권한이 없습니다. | 원본을 보존하고 형식·누락 이유를 표시합니다. 반복 재시작은 같은 정리 결과와 안내를 재사용합니다. |

위 표의 Linux 부팅 ID는 시스템 식별로 별도 비교하고, 프로세스별 데이터는 열린 디렉터리 fd에서 읽습니다. 숫자는 후보 탐색에만 사용합니다. `O_RDONLY|O_DIRECTORY|O_CLOEXEC`로 열어 권한이 맞는 `stat`·`environ`을 확인하고 해당 fd로만 신호합니다. 전용 pidfd를 따로 쓸 때는 생성 때 받거나 같은 객체임을 보장해야 합니다. 디렉터리 fd 경로는 같은 객체의 `stat`에서 좀비 상태 또는 사라진 대상의 ESRCH를 확인할 수 있습니다. 권한·I/O·조회 실패는 미확인으로 남깁니다. 트리 확인에는 개별 프로세스의 종료 외에도 그룹과 관찰 가능한 후보의 범위를 포함합니다. [E13](#E13), [E18](#E18).

시작 전 버전 있는 실행 시도 기록을 먼저 내구성 있게 쓰고, 실행기가 자기 세대에 대한 정리 결과를 단일 작성자로 원자적으로 공개하는 방식을 권고합니다. 준비 전·실행 중·정리 완료 직전의 프로세스 사망을 각각 시험합니다. “진행 중”과 “완료 증거 없음”이 겹치는 재시작에서는 이전 실행기와 복구 작업이 동시에 같은 범위를 조작하지 않도록 소유권을 확인합니다. 모호하면 기록·폴더를 보존합니다. 대시보드는 조직·실행 시도 ID에 정리 대상, 실패 이유와 사용자 확인 상태를 묶고 사용자 확인 기록과 프로그램의 종료 확인을 별개로 다룹니다. [#268](https://github.com/babo-jeonguk/BaboJUBot/issues/268), [관찰 가능성과 조직 경계](../architecture.md#제품-불변-조건-강제-위치).

| ID | 검증할 경계 | 근거 |
| --- | --- | --- |
| V01 | 깨끗한 checkout·frozen lockfile·타깃 패키지 설치 → 실제 준비 probe → 설치 훅 없이 실행. 생략·타깃/판 불일치·권한 거절·손상 → 원인과 함께 실행 거부. Linux 대상 이미지에서도 probe | D01–D02 |
| V02 | Intel/Apple silicon 실제 macOS와 Windows x64에서 설치 경로별로 서명 검증 → 기본 정책 그대로 spawn. 격리 속성·인터넷 표시와 실행 오류를 기록. 최소 지원 환경과 서명된 최종 패키지를 확인 | D02 |
| V03 | 아무 자손 없이 마지막 개행이 없는 provider stdout·stderr 작성 → 대표 exit 뒤 실행기와 제어 통로가 살아 있는 상태에서 실제 EOF. 실행기나 자손이 각각 의도적으로 출력 핸들 하나 더 유지 → 닫기 전에는 EOF 없음, 닫으면 EOF. Windows에서 상속 허용·닫기 오류를 주입해 원인을 구분. 고정 대기 대신 사건과 실패 시한으로 검증 | D03–D04 |
| V04 | TERM 무시·대표 먼저 종료·setsid/동등한 탈출 fixture·다른 실행 및 무관한 프로그램 → POSIX 그룹 마지막 신호 후 reap, macOS 즉시 종료·STOP과 NOTE_EXIT 구분, Linux fd 표식 정리, macOS 미확인 신고, Windows Job 활성 수 0. 무관한 프로세스는 같은 객체의 응답으로 생존 확인 | D05 |
| V05 | 서버 단독·실행기 단독·둘 다 강제 종료 → 각각 EOF 정리, 커널 보장의 범위와 완료 증거 없는 기록 보존, 다음 시작의 보수적 복구. Windows 상위 libuv Job이 실행기도 같이 끄는 사례와 실제 EOF 정지를 독립 시험 | D04–D06 |
| V06 | 이전 포맷·확인 중 신원 교체·권한 거절·조직 불일치·두 번째 재시작 → 다른 실행이나 조직에 신호 없음, 폴더와 사유 유지, 대시보드 안내 하나, 사용자 확인 시 기록 닫힘. 최초 실패 및 세 OS의 실제 시험 수를 CI 로그로 확인 | D06–D07 |

| 열린 결정 | owner | 선택지와 근거 |
| --- | --- | --- |
| 첫 공개 릴리스 범위와 서명 자격 | 사용자 | 권고는 D02의 5개 타깃을 배포 단위로 삼고 macOS Developer ID·공증과 Windows Authenticode를 확보한 뒤 공개 지원. Linux 5.4를 최소판으로 삼는 조건도 포함합니다. 서명 자격 확보 전에는 같은 타깃에서 개발·CI 검증까지 진행하고 공개 지원 시점을 뒤로 둡니다. |
| macOS 새 세션 자손의 합격 기준 | #268 | 권고는 그룹 밖에서 안정된 신호 권한을 확보할 수 없는 실제 fixture를 C의 미확인으로 두고, 신호 0건·안내·기록 보존을 합격으로 확인하는 것입니다. 모든 새 세션 자손의 자동 종료까지 합격 조건으로 해석하면 공개 API와 현재 범위에서 근거가 부족합니다. |

## 한계와 미확인

- Linux에서 optional 설치, procdirfd 신호, 상속 출력 EOF의 정상·대조 경로를 실행했습니다. macOS·Windows 실제 실행, 코드 서명·공증, 격리 속성 전파, 실제 보안 정책과 #263 출력 보유 핸들은 이 조사에서 실행 확인하지 못했습니다. 제품 supervisor 통합·타깃별 ABI 하한·PID 번호의 실제 재사용 강제·Docker 이미지 설치는 구현 단계 검증입니다.
- macOS의 `ps -E`에서 표시되는 표식에는 환경 항목 경계 손실이 있습니다. 더 정확한 탐색을 확보해도 신호를 보내는 객체가 필요합니다. macOS 공개 API와 지원 판에서 둘을 함께 제공하는 경로는 조사 범위에서 확인하지 못했습니다.
- npm 레지스트리·Apple·Windows의 정책과 runner 이미지는 바뀔 수 있으므로 배포 전 고정된 패키지 및 깨끗한 대상 OS에서 재확인합니다. upstream 코드를 가져올 경우 해당 버전의 파일 헤더·LICENSE·NOTICE를 다시 검토합니다.
