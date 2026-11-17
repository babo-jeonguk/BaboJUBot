# orphan-process-cleanup 레퍼런스 조사: 부모가 먼저 죽은 뒤 자손 회수

Node.js 호스트가 띄운 프로바이더의 비정상 종료 뒤 자손을 회수하는 수단을 비교한다. 정상 종료 순서는 [기존 조사](graceful-shutdown-references.md), 현재 구현 계약은 [현재 구현 현황](../current-implementation.md)이 맡는다.

조사일: 2026-11-17. 대상: 사용자 의뢰 Q1–Q5, GitHub 이슈 없음. 구현 전 권고이며 확정 계약이나 구현 결과가 아니다. 제품 코드·설정·테스트 변경, 커밋, GitHub 게시를 하지 않았다.

## Brief

- 구현할 문제: Claude Code·Codex·OpenCode·Antigravity·Pi 같은 외부 프로그램이 먼저 죽으면 새 세션의 셸·서버가 남는다. 이후 PID 트리 탐색만으로는 실행 시도의 자손임을 복원할 수 없다.
- 동종 문제: 직계 자식이 사라져도 실행 단위의 모든 자손을 감독하고 종료하는 외부 supervisor.
- 고정된 결정: 사용자가 제공한 Linux arm64 재현, Codex PDEATHSIG·OpenCode PTY 수명 관리, subreaper·환경 표식 실측은 재조사하지 않는다. BaboJUBot Windows #205의 Job Object + C# 헬퍼 결정도 재결정하지 않는다.
- 용어: 이 문서의 프로바이더는 외부 에이전트 프로그램이다. 연구 조직의 에이전트와 구별한다. 회수 범위는 실행 시도별이며 별도 수명을 승인받은 외부 job은 별도 경계에서 실행해야 한다.
- 결론: **세 OS의 임의 네이티브 자손을 Node 24 표준 API만으로 완전히 회수하는 공통 해법은 없다.** Linux cgroup·Windows Job은 생성 시 귀속을 묶을 수 있지만, macOS 표식 탐색은 관측·상속에 의존한다. 아래의 강한 보장도 OS 정상 작동, 종료 권한, 경계 탈출 불허를 전제로 한다.

| ID | 조사 질문 | 출처 | 전략 |
| --- | --- | --- | --- |
| Q1 | 실제 프로젝트는 무엇을 사용하는가 | 사용자 Q1 | CI·빌드·init·터미널 인접 도메인 Discovery + Source Recon |
| Q2 | OS별 수단과 실패 조건 | 사용자 Q2 | 커널·공식 API 계약 + 실패 분기 소스 |
| Q3 | Node만으로 가능한 범위·헬퍼 배포 | 사용자 Q3 | Node 버전별 API + 의존·배포 경로 |
| Q4 | 호스트까지 강제 종료 | 사용자 Q4 | supervisor 바깥 소유자·커널 수명 계약 |
| Q5 | 무관한 프로세스 오종료 방지 | 사용자 Q5 | PID 재사용·표식 오염·다른 조직 음성 시나리오 |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
| --- | --- | --- |
| 사용자 제공 Linux 실측·Paseo 0.16.0·#8712 | 문제·이미 검증한 메커니즘의 전제 | 이번 실행 확인으로 세지 않음. Pi·macOS·Windows로 일반화하지 않음 |
| 기존 정상 종료·내장 Postgres 조사 | 내부 exit hook으로 SIGKILL을 처리할 수 없다는 문제 분리 | 기존 외부 Evidence를 옮기지 않고 이번에 공식 API·새 고정 소스 확인 |
| BaboJUBot process.ts·recovery.ts | 적용 위치와 기존 보장 범위 | 로컬 소스 읽기: 표식은 Linux에서 기존 PGID 멤버 인증에만 사용. 전역 표식 검색이 아니므로 setsid 자손을 찾는다고 볼 수 없음. macOS는 PID 시작 시각, Windows는 taskkill 경로 |

## 레퍼런스

깊이의 소스는 고정 SHA를 직접 읽었다는 뜻이며 실행 성공을 뜻하지 않는다. 모두 설계 참고이며 코드 복사를 권고하지 않는다. 심층 후보와 추가 후보·실행 경로는 아래 표 및 후보 부록에 기록한다.

| 레퍼런스 | 분류·선정 이유 | 버전·SHA | 라이선스 | 깊이·실행 경로 |
| --- | --- | --- | --- | --- |
| GitHub Actions runner | CI의 트리 밖 표식 회수 | `af09a511a0869abf002daef236c66c5b146d683a` | MIT | 소스; 실제 job은 계정 필요, 이번 미실행 |
| Jenkins | Unix 환경·Windows winp 비교 | `15a63e49d3a61f886693ee21f6eb7b5a298ec46b` | MIT | 소스; 로컬 Jenkins 가능, 미실행 |
| Bazel | 외부 subreaper와 PID namespace의 차이 | `b79b03da6fb39ceac554987dfd51457806519e31` | Apache-2.0 | 소스; wrapper 단독 빌드 가능, 미실행 |
| Codex Windows PTY | Job 제어·실패 fallback | `a3fc418fb29d15fff9df779575aee3a5ca1ea73d` | Apache-2.0 | 소스; Windows 로컬 무모델 프로세스 시험 가능, 미실행 |
| libuv | Node 내부 Job을 충분한 감독으로 오인하는 반례 | `e5dab8432177f43af97bbe032037d273234642ac` | MIT | 소스; Windows spawn 시험 가능, 미실행 |
| Cargo | 호스트 종료 시 Job 정리 선례 | `8ca2d0b260a7072fcecb2666d3e9516c00379aab` | MIT/Apache-2.0 | 소스; Windows cargo build 가능, 미실행 |
| Linux·Microsoft·Apple·Node 공식 계약 | 메커니즘 보장 범위 | 문서 또는 아래 고정 소스 | 각 출처 | 문서·소스; Linux Node 환경 확인만 실행 |

## 근거

수준: 실행 확인 / 소스 확인 / 문서 주장 / 추론. 사용자 제공 관찰은 별도 전제다.

| ID | 관찰 | 출처 | 수준 |
| --- | --- | --- | --- |
| <a id="E01"></a>E01 | cgroup 멤버십은 fork 때 상속된다. 부모 이동은 기존 자손을 소급 이동시키지 않는다. 따라서 호스트가 spawn한 다음 PID만 옮기면 이미 fork한 자손을 놓칠 수 있다 | [커널 cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html#processes) | 문서 주장 |
| <a id="E02"></a>E02 | cgroup.kill=1은 하위 cgroup까지 SIGKILL하며 동시 fork·migration을 처리한다. cgroup 자체는 호스트 사망 때 자동 소멸·자동 kill되지 않는다 | [커널 cgroup.kill](https://docs.kernel.org/admin-guide/cgroup-v2.html#core-interface-files) | 문서 주장; 자동 수명 부재의 적용 판단은 추론 |
| <a id="E03"></a>E03 | subreaper는 고아를 가장 가까운 살아 있는 조상 subreaper로 재부모화한다. kill 기능은 별개다. PDEATHSIG는 fork 자식에 상속되지 않고 설정 전 부모 사망 race도 있다 | [subreaper](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html), [PDEATHSIG](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html) | 문서 주장 |
| <a id="E04"></a>E04 | Bazel 외부 wrapper는 subreaper를 켜고 메인 명령이 끝난 뒤 TerminateAndWaitForAll을 호출한다. Linux 구현은 그룹 kill 뒤 /proc/thread-self/children의 입양된 자식을 반복 kill/wait한다. proc 파일을 못 열면 조기 반환한다 | [wrapper](https://github.com/bazelbuild/bazel/blob/b79b03da6fb39ceac554987dfd51457806519e31/src/main/tools/process-wrapper-legacy.cc#L54-L61), [호출](https://github.com/bazelbuild/bazel/blob/b79b03da6fb39ceac554987dfd51457806519e31/src/main/tools/process-wrapper-legacy.cc#L139-L149), [반복 회수](https://github.com/bazelbuild/bazel/blob/b79b03da6fb39ceac554987dfd51457806519e31/src/main/tools/process-tools-linux.cc#L25-L58) | 소스 확인 |
| <a id="E05"></a>E05 | runner는 GUID 기반 RUNNER_TRACKING_ID를 주입하고 종료 때 snapshot에서 표식이 같은 프로세스에 Kill한다. 단일 snapshot이며 조회 실패는 건너뛴다. supervisor 전체 사망에 대한 자동 회수 근거가 아니다 | [준비](https://github.com/actions/runner/blob/af09a511a0869abf002daef236c66c5b146d683a/src/Runner.Worker/JobExtension.cs#L588-L603), [회수](https://github.com/actions/runner/blob/af09a511a0869abf002daef236c66c5b146d683a/src/Runner.Worker/JobExtension.cs#L891-L939) | 소스 확인 |
| <a id="E06"></a>E06 | Jenkins는 트리 재귀와 별개로 환경 일치 프로세스를 전역 탐색한다. 빈 표식은 거부한다. Darwin은 sysctl KERN_PROCARGS2, Windows는 WinProcess 환경 읽기를 쓴다 | [killAll](https://github.com/jenkinsci/jenkins/blob/15a63e49d3a61f886693ee21f6eb7b5a298ec46b/core/src/main/java/hudson/util/ProcessTree.java#L150-L184), [Windows](https://github.com/jenkinsci/jenkins/blob/15a63e49d3a61f886693ee21f6eb7b5a298ec46b/core/src/main/java/hudson/util/ProcessTree.java#L694-L718), [Darwin](https://github.com/jenkinsci/jenkins/blob/15a63e49d3a61f886693ee21f6eb7b5a298ec46b/core/src/main/java/hudson/util/ProcessTree.java#L1680-L1765) | 소스 확인 |
| <a id="E07"></a>E07 | /proc/PID/environ은 현재 exec의 초기 환경이며 NUL 구분, ptrace 읽기 권한 검사를 받는다. putenv 변경을 전부 반영하는 실시간 API가 아니다 | [proc_pid_environ](https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html) | 문서 주장 |
| <a id="E08"></a>E08 | Node detached는 POSIX에서 새 세션·그룹을 만든다. child.kill은 전체 자손 종료 계약이 아니다. 현재 저장소 엔진은 >=24 <25, 로컬 Node 24.21.0 Linux arm64에서 node:ffi 내장 모듈 없음·self environ/boot ID 읽기 가능 | [Node 24 child_process](https://nodejs.org/docs/latest-v24.x/api/child_process.html#optionsdetached), 로컬 package.json 및 기능 probe | 문서 주장 + 실행 확인(로컬 기능만) |
| <a id="E09"></a>E09 | 내장 node:ffi는 Node 26.1.0 추가 experimental이다. 이를 사용하면 별도 애드온 없이 시스템 라이브러리 호출 가능성이 있지만 Node 24 공통 해법이 아니며 안전성·OS 구현을 직접 책임져야 한다 | [Node FFI](https://nodejs.org/api/ffi.html) | 문서 주장; 감독 API 연결 가능성은 추론·미실행 |
| <a id="E10"></a>E10 | Windows Job은 보통 자손을 자동 포함하며 KILL_ON_JOB_CLOSE는 마지막 Job handle 닫힘에 반응한다. Windows 8+ nested Job과 breakaway 정책을 구별해야 한다 | [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs) | 문서 주장 |
| <a id="E11"></a>E11 | libuv global Job은 KILL_ON_JOB_CLOSE와 SILENT_BREAKAWAY_OK·BREAKAWAY_OK를 함께 설정해 명시 추가한 프로세스만 대상으로 한다. detached spawn은 추가하지 않는다. 이것만으로 모든 손자 회수를 보장할 수 없다 | [Job 초기화](https://github.com/libuv/libuv/blob/e5dab8432177f43af97bbe032037d273234642ac/src/win/process.c#L69-L120), [spawn](https://github.com/libuv/libuv/blob/e5dab8432177f43af97bbe032037d273234642ac/src/win/process.c#L1117-L1166) | 소스 확인 |
| <a id="E12"></a>E12 | Codex Job 기본 create는 explicit breakaway 허용, create_without_breakaway는 금지. running process 사후 assign은 소급되지 않는다고 명시한다. suspended assign 실패 때 비격리 resume fallback도 있어 Job 사용 사실만으로 강한 보장이라 부를 수 없다 | [JobObject](https://github.com/openai/codex/blob/a3fc418fb29d15fff9df779575aee3a5ca1ea73d/codex-rs/utils/pty/src/win/job.rs#L70-L171) | 소스 확인 |

| <a id="E13"></a>E13 | systemd stop은 control-group 전체에 TERM→시한 뒤 KILL. ExitType=main은 대표 종료에 반응하지만 cgroup은 멤버가 남으면 계속 실행 상태 | [kill](https://github.com/systemd/systemd/blob/ef7936e42e3d714a6560bb4e0d5a99fd6fcdacce/man/systemd.kill.xml#L63-L101), [ExitType](https://github.com/systemd/systemd/blob/ef7936e42e3d714a6560bb4e0d5a99fd6fcdacce/man/systemd.service.xml#L319-L340) | 문서 주장(고정 man 소스) |
| <a id="E14"></a>E14 | tini는 subreaper 등록·waitpid 수거를 하지만 main 종료 시 반환한다. -g도 그룹 전달이다. dumb-init도 main 종료 때 자식 그룹 TERM 뒤 종료한다 | [tini](https://github.com/krallin/tini/blob/369448a167e8b3da4ca5bca0b3307500c3371828/src/tini.c#L675-L686), [dumb-init](https://github.com/Yelp/dumb-init/blob/85035d96dd6b8908ea0e0902a368fd8a0d350f44/dumb-init.c#L100-L116) | 소스 확인 |
| <a id="E15"></a>E15 | PID namespace의 init 사망은 전체 멤버 SIGKILL. Bazel linux-sandbox는 내부 PID1에 PDEATHSIG와 부모 handshake를 설정하고 메인 종료 뒤 PID1이 반환 | [커널 계약](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html), [SetupSelfDestruction](https://github.com/bazelbuild/bazel/blob/b79b03da6fb39ceac554987dfd51457806519e31/src/main/tools/linux-sandbox-pid1.cc#L213-L239), [반환](https://github.com/bazelbuild/bazel/blob/b79b03da6fb39ceac554987dfd51457806519e31/src/main/tools/linux-sandbox-pid1.cc#L962-L972) | 문서 주장 + 소스 확인 |
| <a id="E16"></a>E16 | macOS KERN_PROCARGS2는 같은 UID/root 조회 경로가 있지만 restricted 프로세스 환경을 생략할 수 있다. root라는 사실만으로 SIP 관련 예외가 되지 않는다 | [XNU 제한](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_sysctl.c#L1387-L1455) | 소스 확인 |
| <a id="E17"></a>E17 | ps는 KERN_PROCARGS2를 호출하고 NUL을 공백으로 바꾼다. runner의 macOS 환경 스캔도 ps 출력의 공백/등호 비escape 한계를 명시 | [Apple ps](https://github.com/apple-oss-distributions/adv_cmds/blob/6bed8737a34dbb54782a18f47dccf933a9967a12/ps/print.c#L189-L280), [runner fallback](https://github.com/actions/runner/blob/af09a511a0869abf002daef236c66c5b146d683a/src/Runner.Common/ProcessExtensions.cs#L291-L391) | 소스 확인 |
| <a id="E18"></a>E18 | macOS NOTE_TRACK·NOTE_CHILD는 10.5부터 미지원. NOTE_EXIT는 종료 관측일 뿐 자손 귀속이 아니다. Bazel Darwin도 대표 reap 전 PGID를 보존해 그룹을 정리하는 방식 | [event.h](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/event.h#L363-L369), [Bazel Darwin](https://github.com/bazelbuild/bazel/blob/b79b03da6fb39ceac554987dfd51457806519e31/src/main/tools/process-tools-darwin.cc#L32-L147) | 소스 확인; containment 비교는 추론 |
| <a id="E19"></a>E19 | launchd AbandonProcessGroup 기본 정리는 같은 그룹 대상이다. 새 세션 이탈의 해법이 아니다. 공개 man은 오래된 snapshot이라 현행 Mac 실행 계약 추가 검증 필요 | [launchd man](https://github.com/apple-oss-distributions/launchd/blob/d448a1c8f70a61202f8705f94337f686b87c30c4/man/launchd.plist.5#L364-L369) | 문서 주장 + 추론 |
| <a id="E20"></a>E20 | Windows suspended→assign→resume은 실행 전 fork race를 막지만 assign 전 launcher 사망 때 suspended 고아가 남는다. Windows 10 JOB_LIST 생성 속성은 생성 시 Job 연결 가능 | [Microsoft 설명](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812) | 문서 주장 |
| <a id="E21"></a>E21 | Cargo는 자신을 Job에 넣지만 explicit breakaway 허용·실패 무시, 정상 Drop 때 kill-on-close를 해제한다. process-wrap도 KillOnDrop을 별도 켜야 kill-on-close 설정 | [Cargo](https://github.com/rust-lang/cargo/blob/8ca2d0b260a7072fcecb2666d3e9516c00379aab/src/util/job.rs#L83-L149), [process-wrap](https://github.com/watchexec/process-wrap/blob/2f4bc393d8bd03b4b1c81fee2e13ce82dd42906e/src/std/job_object.rs#L81-L138), [Job 설정](https://github.com/watchexec/process-wrap/blob/2f4bc393d8bd03b4b1c81fee2e13ce82dd42906e/src/windows.rs#L207-L262) | 소스 확인 |
| <a id="E22"></a>E22 | winp는 JNI C++로 PEB와 process parameters의 환경 메모리를 읽는다. bitness 분기와 권한 실패가 있어 같은 사용자 모든 프로세스 환경 읽기 보장이 아니다 | [PEB 조회](https://github.com/jenkinsci/winp/blob/fb882de4425187d1d74c19005bf18445c3a7cd25/native/envvar-cmdline.cpp#L125-L220), [환경](https://github.com/jenkinsci/winp/blob/fb882de4425187d1d74c19005bf18445c3a7cd25/native/envvar-cmdline.cpp#L245-L310), [지원 범위](https://github.com/jenkinsci/winp/blob/fb882de4425187d1d74c19005bf18445c3a7cd25/README.md#L30-L43) | 소스 확인 |
| <a id="E23"></a>E23 | Buck2는 pidfd를 연 뒤 starttime을 다시 확인해 signal한다. ENOSYS fallback에는 check/kill race가 남는다. detached 목록 수집은 leader가 나가기 전에 해야 한다고 명시 | [pidfd](https://github.com/facebook/buck2/blob/296d874cfd8a78834129d2e25395463dbfb37a1c/app/buck2_process_kill/src/linux.rs#L47-L99), [사전 수집 요구](https://github.com/facebook/buck2/blob/296d874cfd8a78834129d2e25395463dbfb37a1c/app/buck2_execute_local/src/kill_on_drop.rs#L94-L104) | 소스 확인 |
| <a id="E24"></a>E24 | node-pty는 prebuilds를 npm에 포함하고 설치 시 prebuild 실패면 node-gyp로 빌드한다. Codex는 OS/arch npm 패키지를 optionalDependencies로 연결 | [node-pty files](https://github.com/microsoft/node-pty/blob/35c28c7d68a192699e70b1e6a142908bdccd9212/package.json#L14-L24), [설치](https://github.com/microsoft/node-pty/blob/35c28c7d68a192699e70b1e6a142908bdccd9212/package.json#L50-L56), [Codex npm](https://github.com/openai/codex/blob/a3fc418fb29d15fff9df779575aee3a5ca1ea73d/codex-cli/scripts/build_npm_package.py#L290-L310) | 소스 확인 |

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
| --- | --- | --- | --- | --- | --- |
| P01 | 생성부터 OS 컨테이너에 귀속 | cgroup, Job, PID namespace | cgroup은 외부 종료 주체 필요, Job은 handle close, pidns는 PID1 사망 | setsid·재부모화 영향 작음 | 권한·지원 OS·생성 race·경계 이탈 |
| P02 | 실행 시도별 외부 subreaper | Bazel wrapper | tini의 입양/좀비 수거와 달리 살아 있는 자식 kill 루프 포함 | Linux 비특권 배포에 유리 | helper 사망·proc 접근 실패·더 가까운 subreaper 처리 |
| P03 | 상속 표식으로 전체 사용자 프로세스 탐색 | runner, Jenkins | runner 1회 snapshot, Jenkins OS별 native 조회 | 트리·세션 독립, 재시작 회수 가능 | env 정화·권한·동시 fork·파싱·위조 |
| P04 | 부모 PID/PGID 트리 종료 | tree-kill, taskkill, terminal wrappers | 메인 사망 전에만 계보 보존 | 간단하고 정상 취소에 유효 | 먼저 죽은 부모·setsid에 취약 |
| P05 | 사망 감지와 독립 회수자 | systemd, 별도 watchdog | NOTE_EXIT·IPC EOF는 트리 발견 자체를 제공하지 않음 | 호스트 종료도 관측 가능 | 감지자까지 사망하면 커널 경계 또는 다음 시작 복구 필요 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
| --- | --- | --- | --- | --- | --- |
| D01 | 변형 채택 | Linux 1안: 실행 시도별 cgroup v2 + systemd transient service. 프로바이더를 MainPID로, ExitType=main, KillMode=control-group, 유한 TimeoutStopSec. 호스트 service와 BindsTo/After 등 수명 관계 설정 | P01, E01–E04 | 프로바이더 SIGKILL 뒤 setsid 자손 회수. cgroup을 만들기만 하거나 scope에 넣기만 해서는 호스트 사망 자동 회수가 안 됨 | Q1,Q2,Q4,Q5 |
| D02 | 변형 채택 | Linux 대안: 실행 시도마다 외부 native subreaper helper, 부모 생존 IPC/pipe 감시, agent 종료 때 입양 자손 반복 TERM→KILL→wait. 환경 표식 복구 보완 | P02,P03 | systemd가 없는 일반 사용자 설치. helper 자체 SIGKILL에는 별도 pidns/cgroup 또는 재시작 표식 회수 필요 | Q2,Q3,Q4 |
| D03 | 변형 채택 | macOS 네이티브 1안: 실행 시도별 랜덤 표식 + 같은 UID 전역 스캔 + PID 시작 신원 재확인, TERM→기한→KILL 반복. 가능하면 KERN_PROCARGS2 직접 helper, 무네이티브 배포는 ps eww fallback | P03,P05,E06 | 세션 이탈 자손도 찾지만 best effort. **임의 자손 완전 회수 요구는 미충족**. 확실성이 필수면 Linux VM/컨테이너 경계로 실행을 옮김 | Q1–Q5 |
| D04 | 채택 | Windows 1안: 실행 시도별 no-breakaway Job + KILL_ON_JOB_CLOSE. 생성 시 atomic Job 연결 권장. 호스트 생존 중 프로바이더 종료면 명시 TerminateJobObject, 호스트 사망이면 마지막 handle close | P01,E10–E12 | 부모 PID 없이 커널 멤버십 유지. Job handle을 자손에 상속·복제하지 않음. #205의 C# helper 결정 유지 | Q1–Q5 |
| D05 | 변형 채택 | Paseo 네이티브 의존성 최소 대안: Linux /proc 전역 표식 검색, macOS ps eww 검색, 기존 그룹 kill 병행·재시작 recovery. Windows는 Job helper를 선택 기능으로 도입하거나 보장 약화를 명시 | P03,P04,E07–E09 | Node 24만으로 완전 보장을 약속하지 않고 무네이티브 개선을 별도 PR 범위로 검토 가능 | Q3,Q4 |
| D06 | 채택 | 식별·종료 실패를 실행 시도 상태/활동에 남기고 회수 미완료를 성공으로 기록하지 않음. 조직·실행 시도 ID에 경계와 표식을 연결 | P01–P05 | 제품 조직 경계·관찰 가능성 준수. 초기 승인·최종 완료 규칙 변경 없음 | Q5 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
| --- | --- | --- |
| PGID/session만으로 완전 회수 | tree-kill, process group, launchd 그룹 정리 | setsid·setpgid로 분리, 이미 죽은 부모 계보 유실 |
| init/subreaper만 설치하면 종료도 해결 | tini -s, dumb-init, Docker --init | 입양·reap과 살아 있는 모든 자손 kill을 혼동. 컨테이너 종료의 namespace 정리와도 구별 |
| PDEATHSIG만으로 전체 트리 보호 | Codex Linux 직접 명령 | fork 비상속·설정 race·Linux 전용. 외부 호스트가 임의 손자에게 소급 적용 못 함 |
| 프로세스 이름·명령줄·포트로 찾기 | node/python 서버 일괄 종료 | 다른 조직·사용자 프로그램 오종료 |
| PID 목록 영구 저장만으로 복구 | 단순 pidfile | 재사용·재부팅·정리 중 fork 놓침 |
| Win32 PEB 전역 스캔을 기본 경계로 사용 | winp 같은 환경 조회 | 권한·bitness·보호 프로세스·race 부담, Job보다 약함 |

## 구현 참고

### Node.js만으로 가능한 범위

| 범위 | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Node 24 표준 API만 | fs로 /proc 전체 스캔·표식 파싱·process.kill. 기존 그룹과 별도 세션 프로세스에 개별 신호 가능 | kill·spawn·IPC는 가능. 임의 PID 환경을 읽는 표준 Node API 확인 못 함 | spawn/kill 가능. Job 생성·할당·PEB 읽기 표준 API 확인 못 함 |
| OS 기본 명령 실행 허용, 추가 설치 바이너리 없음 | ps, 권한 있으면 cgroup fs. systemd-run은 systemd 설치·사용자 manager 필요 | /bin/ps eww. 환경+명령줄 텍스트라 NUL 환경 API보다 안전한 파싱이 어렵고 인자 위장 가능 | taskkill /T는 생존 계보에만 유효. PowerShell Add-Type/PInvoke는 JS-only가 아닌 native 상호운용 경로 |
| 네이티브 helper/애드온 허용 | prctl, pidfd, namespace, spawn 전 귀속 | sysctl 환경 읽기·kqueue 감시 개선. 그래도 커널 containment와 동일하지 않음 | Job + CreateProcess. C#/C++/Rust 또는 prebuilt helper |
| Node 26+ 내장 FFI | libc 호출 가능성 | libSystem 호출 가능성 | kernel32 호출 가능성 |

마지막 행은 experimental API에 근거한 구현 가능성 추론이며 실행 검증하지 않았다. 외부 바이너리·애드온 없이도 OS API 연결 여지가 생기므로 “모든 Node 버전에서 원천 불가능”이라고 단정하지 않는다. 현재 저장소 Node 24의 도입 대안은 아니다. child_process.spawn 옵션만으로 Job·subreaper·pid namespace를 설정하는 계약은 확인하지 못했다.

Linux에서 이미 위임받은 writable cgroup v2가 있다면 Node fs만으로 디렉터리·cgroup.procs·cgroup.kill을 다룰 수 있다. 별도 Node bootstrap이 자기 자신을 귀속시킨 뒤 프로바이더를 spawn하는 설계도 가능하다(추론·미실행). 따라서 cgroup이 항상 새 native binary를 요구하는 것은 아니다. 다만 사후 부모 PID 이동으로는 이미 태어난 자손을 묶지 못하며, 호스트 강제 종료 시 정리를 수행할 외부 소유자는 여전히 필요하다.

### 호스트 강제 종료와 두 겹 고아

- Linux: 실행별 transient service를 만든 호스트 client가 죽었다고 service가 저절로 종료되지는 않는다. 호스트 자체가 systemd service라면 실행 unit과 수명 의존 관계를 둔다. 그 외에는 별도 wrapper가 호스트 pipe EOF를 받아 systemd stop/cgroup kill을 수행해야 한다. scope 기본 수명은 모든 멤버가 나갈 때까지라 문제의 자손을 계속 살려둘 수 있다. ExitType=cgroup도 이번 목적에서는 main 종료 뒤 자손을 살리는 선택이다.
- subreaper helper가 살아 있으면 호스트 IPC 상실 후 회수할 수 있다. helper까지 SIGKILL되면 고아는 다음 살아 있는 subreaper/init로 넘어간다. helper가 PID namespace의 PID1이면 그 사망은 namespace 멤버의 커널 SIGKILL로 연결된다. namespace 밖 프로세스나 외부 daemon에게 위임한 작업까지 포함하지 않는다.
- Windows: 마지막 handle을 호스트가 소유하면 host hard terminate 때 커널이 닫는다. helper가 handle을 소유한다면 host 사망에 EOF를 받아 닫아야 한다. helper가 강제 종료되어도 handle close는 적용된다. 다른 프로세스에 handle이 상속·복제되면 이 보장이 지연된다.
- macOS: 별도 Node watchdog이 host EOF를 받고 표식 스캔할 수 있지만 watchdog까지 죽는 경우 즉시 회수 보장 없음. durable lease로 다음 시작 때 다시 찾는 것은 지연 복구다. launchd의 재시작이나 NOTE_EXIT는 소유 멤버십을 복원하지 않는다. VM 안에서 도는 Linux 프로세스라면 그 경계의 수명 정책을 별도로 관리한다.

### 오탐 방지와 상속 경계

1. 조직 ID만 표식으로 쓰지 말고 조직·실행 시도별 고엔트로피 토큰을 만든다. host 전역 환경을 바꾸지 말고 해당 spawn 환경에만 넣는다. 동시 실행과 helper·정상 외부 job에 섞이지 않게 한다.
2. Linux 환경은 NUL로 나눈 항목 전체의 key=value가 정확히 일치해야 한다. 뒤 NUL만 붙인 substring 검색은 다른 변수 값 안의 문자열을 맞힐 수 있다. 환경 전체를 로그에 남기지 않는다. macOS ps는 인자와 환경의 엄밀한 경계가 없으므로 오탐에 보수적이어야 한다.
3. UID·실행 시도 토큰·부팅 신원·시작 시각을 함께 확인하고 kill 직전에 재확인한다. PID 숫자만 저장하지 않는다. Linux starttime/boot ID, macOS 고해상도 시작 신원, Windows process handle을 선호한다. ps lstart의 초 단위 시각은 완전한 신원 증명이 아니다.
4. 검사 직후 PID가 재사용되는 TOCTOU는 숫자 PID+재검사로 완전히 제거되지 않는다. Linux pidfd_send_signal, Windows process handle 또는 커널 경계 종료가 더 강하다. pidfd도 잘못된 PID를 이미 연 뒤 표식 검사 없이 쓰면 안전하지 않다.
5. env -i/sudo·서비스 매니저·공용 PTY daemon·IPC로 넘긴 실행은 표식·cgroup·Job 상속이 끊길 수 있다. 이미 돌던 외부 서비스가 대신 생성한 프로세스는 호스트의 자손 경계 밖이다. provider별 실제 생성 경로를 검증해야 한다.
6. 같은 UID의 악의적 프로세스는 토큰을 읽고 위조하거나 실행 환경을 정화할 수 있다. 표식은 실수 방지용 소유 힌트이며 보안 인증이 아니다. 권한 있는 프로세스의 cgroup 이동, Job breakaway, Docker socket 등 외부 실행 권한도 경계 탈출 수단이 된다.
7. 스캔·kill·재스캔은 유한 시간 반복하고 마지막 재검사까지 실행한다. 읽기 거부·미분류·시한 만료는 회수 미확인으로 기록한다. PID/이름 기반 대량 kill fallback은 하지 않는다.

### 적용 위치와 검증할 경계

네이티브 배포는 E24처럼 OS/arch별 prebuilt helper를 앱 bundle 또는 npm optional dependency로 제공하는 방법이 유력하다. 작은 C/Rust 실행기는 Node ABI와 분리할 수 있고, tini/dumb-init도 C 바이너리 릴리스·배포판 패키지 선례다([tini 배포](https://github.com/krallin/tini/blob/369448a167e8b3da4ca5bca0b3307500c3371828/README.md#L52-L131), [dumb-init 배포](https://github.com/Yelp/dumb-init/blob/85035d96dd6b8908ea0e0902a368fd8a0d350f44/README.md#L141-L202)). #205의 C# 런타임 컴파일은 기존 결정을 유지하되 compiler 유무·아키텍처·cache hash·파일 소유·서명/백신에 따른 실패를 검사한다. 이번 외부 선례 조사에서 동일한 .NET 런타임 컴파일 방식이 널리 쓰인다고 확인한 것은 아니다. PowerShell Add-Type도 native API를 호출하는 배포 선택이며 Node-only로 분류하지 않는다.

Paseo는 provider spawn 바깥에 실행 소유자를 두고 tree-kill은 보조 취소 수단으로 유지한다. managed-process 기록은 알려진 helper 복구에 재사용할 수 있지만 모든 자손을 안다는 근거는 아니다. BaboJUBot은 process.ts의 생성 경계와 recovery.ts의 복구 경계에 적용을 검토하며 이번 조사에서는 수정하지 않았다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
| --- | --- | --- |
| V01 | 프로바이더 SIGKILL·crash → setsid·double-fork 서버 회수, 포트 해제 확인 | D01–D04 |
| V02 | host만 SIGKILL / host+helper 동시 강제 종료 → 즉시 회수 또는 명시한 지연 복구 | Q4 |
| V03 | PID 재사용·이전 boot lease·명령줄 위장·다른 변수 값에 표식 삽입 → 무관 프로세스 유지 | Q5 |
| V04 | 두 조직·실행 시도 동시 실행 → 한 시도 종료가 다른 시도·host·외부 job에 영향 없음 | D06 |
| V05 | env -i·SIP restricted 자손·권한 거부·공용 daemon 위임 → 누락을 성공으로 표시하지 않음 | D03,D05 |
| V06 | 초기 spawn 직후 supervisor 사망·Job assign 실패·기존 nested Job·breakaway 시도 → 경계 밖 실행을 허용하지 않거나 약화 표시 | D01,D04 |
| V07 | cleanup 중 계속 fork·TERM 무시·오래 걸리는 종료 → 유한 시한·최종 잔존 검사·관찰 가능한 실패 | P01–P05 |

| 열린 결정 | owner | 선택지와 근거 |
| --- | --- | --- |
| macOS 네이티브 best effort 허용 여부 | 사용자/Paseo maintainer | 표식 스캔으로 현실적 개선 / 강한 보장 필요 시 VM 경계 |
| Paseo native helper 도입과 지원 OS 최소 버전 | Paseo maintainer | 무네이티브 fallback / prebuilt helper + 기능 검사. #8712의 책임 위치 결정은 미확정 전제로 유지 |
| #205 C# helper 생성 방식 | #205 구현 담당 | suspended+assign은 일반 fork race를 막지만 helper가 assign 직전 죽는 틈 존재. 지원 Windows에서는 atomic Job list 고려 |

## 한계와 미확인

- 이번 프로세스 실행은 로컬 Node 내장 기능·self proc 읽기 probe뿐이다. 사용자가 제공한 실측은 재실행하지 않았다. 외부 OSS·모델 API·프로바이더·실제 서버를 실행하지 않았다.
- macOS·Windows 장비 실행, 모든 프로바이더의 환경 상속, Pi의 생성 경로, nested Job 실제 조합, macOS ps 출력·SIP 대상 차이, cgroup delegation·systemd 사용자 manager 배포 환경은 미확인이다.
- 문서·소스가 말하는 회수 경로는 실행 검증 통과가 아니다. D01–D06은 도입 권고이며 “Paseo/BaboJUBot에서 해결됐다”는 보고가 아니다.
- 공식 문서·HEAD는 변경될 수 있다. 고정 소스의 라이선스는 설계 참고용이며 복사 시 파일 header·NOTICE·의존성 라이선스와 AGENTS의 출처 고지 규칙을 다시 확인한다.
- libuv 근거는 upstream 고정 SHA다. 실제 Node 24 번들 libuv와 파일 blob 동일 여부는 미확인이다. Apple XNU·adv_cmds는 파일 헤더에서 APSL/BSD를 확인했지만 root LICENSE 경로 조회는 실패했다. launchd root 라이선스도 미확인으로 코드 재사용 대상에서 제외한다.
- 문서 검사: 근거 24행·중복 ID 없음, 고정 SHA 소스 링크 37개 형식·상대 링크 대상·표 열 수 확인. git diff --check 통과, git status는 요청한 미추적 조사 문서 하나뿐이다. 제품 테스트·macOS/Windows 통합 테스트는 실행하지 않았다.

## 후보 부록과 탐색 종료 근거

후보 24개(아래 번호 기준, watchexec/process-wrap은 한 계열로 묶음). 본문 소스 프로젝트 6개와 추가 후보 18개다. 새로운 API를 제공하는 후보와 기존 패턴의 제한을 보여주는 반례를 함께 남긴다. 공개 웹 서비스에서 프로세스 회수를 직접 조작하는 데모는 확보하지 못했다. 실행 경로는 모두 이번 미실행이다.

| 번호·후보 | 분류·확인 깊이·라이선스 | 선정·배제 판단과 공개 근거 | 실행 경로 |
| --- | --- | --- | --- |
| 1–6 runner/Jenkins/Bazel/Codex/libuv/Cargo | 본문 레퍼런스 표 | 고정 SHA·라이선스·선정 이유는 본문 참조 | 본문 참조 |
| 7 systemd | 서비스·고정 man, LGPL-2.1+ | E13; `ef7936e42e3d714a6560bb4e0d5a99fd6fcdacce` | systemd-run --user, user manager 필요 |
| 8 tini | init·소스, MIT | E14; `369448a167e8b3da4ca5bca0b3307500c3371828` | release C binary+shell fixture |
| 9 dumb-init | init·소스, MIT | E14; `85035d96dd6b8908ea0e0902a368fd8a0d350f44` | release static binary/make |
| 10 Apple XNU | 커널·소스, APSL/BSD 헤더 | E16/E18; `f6217f891ac0bb64f3d375211650a4c1ff8ca1ea` | Mac sysctl C fixture |
| 11 Apple ps | CLI·소스, BSD 헤더 | E17; `6bed8737a34dbb54782a18f47dccf933a9967a12` | Mac ps eww |
| 12 launchd | 서비스·공식 man, root 라이선스 미확인 | E19; `d448a1c8f70a61202f8705f94337f686b87c30c4` | Mac LaunchAgent fixture |
| 13 Docker --init | 컨테이너·문서,버전/라이선스 미고정 | [공식 설명](https://docs.docker.com/reference/cli/docker/container/run/#specify-an-init-process); init과 namespace 종료 구별 | 로컬 Docker image fixture |
| 14 Buck2 | 빌드·소스, MIT/Apache-2.0 | E23; `296d874cfd8a78834129d2e25395463dbfb37a1c`; leader 사전 수집 제한으로 완전 해법 배제 | 로컬 CLI build/test |
| 15 watchexec/process-wrap | 감독·소스, Apache-2.0 / MIT·Apache-2.0 | E21; process-wrap `2f4bc393d8bd03b4b1c81fee2e13ce82dd42906e`; Unix group/Windows Job 부품 | Windows cargo tests |
| 16 winp | Windows JNI·소스, MIT | E22; `fb882de4425187d1d74c19005bf18445c3a7cd25` | Java+Windows Maven fixture |
| 17 node-pty | 터미널 addon·소스, MIT | E24; `35c28c7d68a192699e70b1e6a142908bdccd9212`; 배포 참고 | 로컬 npm addon fixture |
| 18 nodemon | Node 감독·소스, 라이선스 미열람 | [kill 함수](https://github.com/remy/nodemon/blob/df00a4e463547383a4c1c5eaab280f395d439c23/lib/monitor/run.js#L338-L437); taskkill/psTree는 이미 재부모화된 자손 복구 근거 아님 | CLI+로컬 서버 |
| 19 PM2 | Node 감독·문서, 버전/라이선스 미고정 | [treekill/kill_timeout](https://pm2.keymetrics.io/docs/usage/application-declaration/); 먼저 죽은 root+setsid 보장 확인 못함 | CLI+로컬 앱 |
| 20 VS Code | 터미널·문서, 버전/라이선스 미고정 | [지속 터미널](https://code.visualstudio.com/docs/terminal/advanced); reconnect/revive가 고아 회수 증명은 아님 | 로컬 IDE |
| 21 JetBrains | 터미널·문서, 상용/버전 미고정 | [탭 종료](https://www.jetbrains.com/help/idea/terminal-emulator.html); main crash 자손 containment 확인 못함 | 설치 IDE |
| 22 Jupyter ipykernel | 커널·문서, 버전/라이선스 미고정 | [parentpoller](https://ipykernel.readthedocs.io/en/latest/api/ipykernel.html#module-ipykernel.parentpoller); 협력 커널 자기 종료이며 임의 셸 자손 회수 아님 | 로컬 Python kernel |
| 23 Mitogen | 자동화·문서, 버전/라이선스 미고정 | [부모 연결 단절](https://moreati.github.io/mitogen/howitworks.html); 협력 broker EOF watchdog 선례 | 로컬 Python |
| 24 Microsoft Job 계약 | OS 공식 문서 | E10/E20; 커널 수명 계약 확인용, OSS 저장소 아님 | Windows 최소 launcher |

관점별 saturation(전수 검색을 뜻하지 않음):

- UNIX: seed의 init/systemd/Bazel → Apple 커널·ps·launchd → pidfd/delegation/service-scope 경로. 마지막 라운드는 새 containment 수단 없이 기존 패턴의 권한·race·소유자 수명 제한을 추가했다.
- Windows: Job/nesting → libuv/Cargo/Codex 실패·breakaway → watchexec 의존성 process-wrap·winp·node-pty 배포. 마지막 라운드가 추가한 것은 옵션·bitness·배포 비용이며 기본 수단은 Job/표식으로 수렴했다.
- 인접 도메인: CI → 빌드/Buck2·오종료 식별 → IDE·커널·Node 감독·컨테이너·자동화. 마지막 라운드는 tree walk·협력 watchdog·namespace 패턴을 반복했고 macOS 임의 자손을 가두는 새 경계는 찾지 못했다.
