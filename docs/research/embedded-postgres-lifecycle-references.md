# embedded-postgres-lifecycle 레퍼런스 조사: 내장 Postgres의 수명

조사일: 2026-11-05. 대상: 사용자 조사 의뢰, GitHub Issue 없음. 구현 전 권고이며 확정 계약이나 구현 결과가 아니다.

## Brief

- 구현할 문제: 강제 종료 뒤 남는 detached Postgres와 임시 폴더, Windows의 상시 강제 정지, 관리자 CI·콘솔·exit 비상 정지·부모 사망 회수의 연결을 조사한다.
- 동종 문제: 앱이 띄운 데몬을 앱의 비정상 사망 뒤 회수하고 운영체제별 정상 정지를 제공하는 방법.
- 고정된 결정: PR #116의 신호 소유권·종료 순서·시한·exact patch는 재분석하지 않는다. 개발용 영구 DB와 테스트용 임시 DB, 외부 DB를 구분한다. 제품 코드·테스트·설정·patch·git은 변경하지 않는다. 공개 자료만 사용한다. Linux 실측만 허용하며 Windows/macOS는 소스·문서만 확인한다. 코드 복사를 권고하지 않는다.

| ID | 조사 질문 | 출처 | 전략 |
| --- | --- | --- | --- |
| Q1 | 남은 데몬의 다음 시작 정지·재사용·즉시 회수·수동 안내 | 의뢰 Q1/문제 1 | Source Recon + runtime/failure + persistence/recovery |
| Q2 | dataDir·PID·시작 시각·사용자·stale lock의 안전한 식별 | 의뢰 Q2 | Source Recon + adversarial scenario + persistence/recovery |
| Q3 | 정지 모드·시한·실패, 재사용 호환성 | 의뢰 Q3 | 공식 프로토콜·계약 + runtime/failure + Linux Behavioral Recon |
| Q4 | Windows fast stop 및 다언어 라이브러리 | 의뢰 Q4/문제 2 | Source Recon + OS 계약·호환성 검증 |
| Q5 | 직접 spawn와 pg_ctl start의 차이 | 의뢰 Q5/문제 3a–c | 개발 도구·의존성 + Source Recon + runtime/failure |
| Q6 | OS 자동 회수·감시 프로세스와 Node 비용 | 의뢰 Q6/문제 3d | 인접 도메인 Source Recon + runtime/failure |
| Q7 | 임시 프로세스·폴더 회수 | 의뢰 Q7 | Source Recon + persistence/recovery + adversarial scenario |
| Q8 | Windows 관리자·macOS CI 검증 | 의뢰 Q8/문제 3a | 공식 OS 계약 + Source Recon + 호환성 검증 |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
| --- | --- | --- |
| [graceful-shutdown](graceful-shutdown-references.md#E08) E08·E09 | JS stop·이슈의 출발점 | 기존 ID를 그대로 인용; 추가 근거는 별도 고정 SHA로 확인 예정 |
| [E26](graceful-shutdown-references.md#E26) | Paperclip Windows 사례·미병합 PR | 적용된 제품 사실로 쓰지 않음; 새 원문 확인 예정 |
| [E31](graceful-shutdown-references.md#E31)·[E32](graceful-shutdown-references.md#E32), 구현 참고 5·6 | pg_ctl·OS 계약·외부 회수 | 이번 조사는 수명·Windows 세부를 보완하며 기존 종료 순서는 유지 |

## 레퍼런스

**권고의 중심은 소유권을 검증한 다음 시작 회수와 공통 fast stop이다.** `pg_ctl start`는 Windows 관리자 문제를 풀 근거가 있지만 잔존 DB 회수는 별도다. 즉시 회수가 필수인지와 남은 영구 DB를 멈출지 재사용할지는 사용자 결정으로 남긴다.

Discovery는 세 관점으로 분담했다. 엔진·Windows는 3라운드에서 token/console/pipe/Job의 반복, 라이브러리·제품은 4라운드에서 회수/재사용/marker/감독자 변형의 반복, 인접 데몬·OS는 4라운드에서 polling/연결 lease/native 회수의 반복을 확인했다. 이는 읽은 범위의 saturation이며 생태계 전수 조사를 뜻하지 않는다. 메인은 마지막으로 Postgres.app 충돌 안내를 열어 수동 해결의 사례를 보완했다.

아래 SHA는 공개 소스 snapshot이며 설치 배포판과 같다는 뜻은 아니다. checkout 캐시는 필요한 원문만 가진 부분 snapshot도 포함한다. 설계 참고만 권고하며 upstream 코드를 복사하거나 새 라이브러리를 설치하지 않았다. 라이선스 본문 미독은 그대로 표시했다.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
| --- | --- | --- | --- | --- | --- |
| PostgreSQL 18 | 엔진 | 41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf | PostgreSQL License | 소스·Linux 실행 | 정지/권한/잠금의 기준 |
| Node 24 / bundled libuv | 런타임 | f7f273a9bb6445f6f7fb6349105e7532972045fb | MIT·포함 고지 | 소스·설치 Node 실행 | 콘솔/Job/exit 계약; 실측 Node는 24.21.0 |
| leinelissen/embedded-postgres | JS | 배포 728b862543732f5a8d7d51e49cfca96f6b2ee98a; HEAD 54b2f9a183e1c68b041f87a1ed1e64bcbc7799c8 | MIT(기존 조사) | 소스·issue | 현재 adapter와 직접 연결 |
| zonkyio/embedded-postgres | Java | 44f6301c33a9255c98af648966a3b3f48a2ca15b | Apache-2.0 | 소스 | 다음 실행 청소·fast stop |
| paperclipai/paperclip | 제품 | beb73381ca086eb87bcb08e12364993fc15bbf9c | MIT(기존 조사) | 소스·issue | 실제 남은 DB 재사용 |
| orm011/pgserver | Python | 3b227607a6c94590ba7c16ae827cef9fb7e3920b | Apache-2.0 | 소스 | 공유 handle·재사용의 한계 |
| fergusstrange/embedded-postgres v2 | Go | b505714f34b4ce90788630c5bbcbf9f25b0ce83f | MIT | 소스 | pipe supervisor·Windows token/Job; alpha 참고 |
| theseus-rs/postgresql-embedded | Rust | efb7b2452f5380555d79a788f189cb2c2c49af38 | MIT/Apache-2.0(README; 본문 미독) | 소스 | pg_ctl·Win/mac CI |
| faokunega/pg-embed | Rust | e2d0722cd1e34a1f534939c0dd0a82b623fc6bb0 | LICENSE 존재; 본문 미독 | 소스 | pg_ctl·Drop 변형 |
| opentable/otj-pg-embedded | Java | 920adf09d8805108068c05f112ca1f805464c533 | Apache-2.0 계열; 본문 미독 | 소스 | 현행 Docker 경로라는 반례 |
| tk0miya/testing.postgresql | Python | c81ded434d00ec8424de0f9e1f4063c778c6aaa8 | Apache-2.0 | 소스 | 직접 spawn·기반 클래스 종료 위임 |
| mysticmind/mysticmind-postgresembed | .NET | 517fa01e35c97d9656bc785a31ace40e06385fc6 | MIT | 소스 | pg_ctl fast/5초 |
| eradman/ephemeralpg | shell | 33bcceacb23c23a78150e618ed9238f161e468be | ISC-style | 소스 | DB 유휴 watcher·tmp 삭제 |
| SmushyTaco/embedded-postgres | Java fork | 6d4db51637d312f982c1ee6ad8e79b32d268ceb4 | 미독 | 소스 | sidecar 소유 marker·삭제 경쟁 반례 |
| patroni/patroni | 운영 supervisor | b3563098b4d25f7f79e03d5224137b8a0e68ed0e | MIT 계열; 본문 미독 | 소스 | 시작시각/exe/cwd 신원 heuristic |
| typegoose/mongodb-memory-server | 인접 DB | 9be9129dbe0767e3e7ea674a8bf232157f35f17c | MIT | 소스 | 작은 killer와 한계 |
| testcontainers/moby-ryuk | 회수자 | 0509b379b7c4a572c918d54079f9ede176045714 | MIT | 소스 | 연결 수명·자원 label |
| microsoft/vscode | 앱 | d1a91b3af8869c37d4757aa959f0859b59c33265 | MIT | 소스 | JS polling/native thread 비교 |
| Chromium | native launcher | def0a08abab2964675731106e2f6ea6ffd6f38f3 | BSD 계열 | 소스 | PDEATHSIG의 실제 사용 |
| Win32·Linux man-pages·Apple·GitHub runners·Postgres.app·EDB | 명세·제품 문서 | 2026-11-05 열람 | 설계 참고 | 문서 | OS 계약·실패/수동 안내 |

기존 조사 재확인: JS `index.ts`의 배포 ref와 HEAD의 blob은 동일했다. Paperclip의 기존/새 ref `embedded-postgres-supervisor.ts`도 동일하며 앱 내부 재시작 helper라는 기존 관찰을 유지한다. 재사용 E26의 미병합 PR patch는 동일 PR SHA로 재열람했으며 현재 적용 사실로 사용하지 않았다. Node 기존 E32와 Ryuk 기존 E29는 같은 SHA를 재열람했다.

## 근거

소스 확인은 코드에 쓰인 사실이다. Windows/macOS에서 실행된 사실을 뜻하지 않는다. issue의 수치와 추정은 이번 실측과 구분했다. `pg_ctl stop -D`만으로 타 인스턴스를 절대 건드리지 않는다는 JS #41의 표현은 E02·E34 때문에 채택하지 않았다.

| ID | 관찰 | 출처 | 수준 |
| --- | --- | --- | --- |
| <a id="E01"></a>E01 | `postmaster.pid`는 PID, dataDir, epoch 초 단위 시작시각, port, socket, listen address, 공유메모리, 상태의 8행이다. 단독 backend PID는 음수다. 뒤쪽 행은 순서대로 완성된다고 가정할 수 없다. | [pidfile.h](https://github.com/postgres/postgres/blob/41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf/src/include/utils/pidfile.h#L16-L55) | 소스 확인 |
| <a id="E02"></a>E02 | `pg_ctl status`는 첫 PID를 읽어 `kill(pid,0)`를 확인한다. `stop`도 그 PID에 신호를 보낸다. 시작시각·exe·실제 dataDir를 인증하지 않는다. POSIX는 같은 uid의 무관한 PID도 양성일 수 있다. Windows는 PG 신호 pipe로 확인하므로 일반 프로세스는 보통 배제되지만 다른 PG까지 구별하는 것은 아니다. | [get_pgpid](https://github.com/postgres/postgres/blob/41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf/src/bin/pg_ctl/pg_ctl.c#L249-L306), [postmaster_is_alive/status](https://github.com/postgres/postgres/blob/41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf/src/bin/pg_ctl/pg_ctl.c#L1323-L1400), [do_stop](https://github.com/postgres/postgres/blob/41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf/src/bin/pg_ctl/pg_ctl.c#L1026-L1078) | 소스 확인 |
| <a id="E03"></a>E03 | Postgres는 O_EXCL lock 생성 후 기존 PID가 없으면 공유메모리 사용 여부도 확인하고 안전한 stale 파일을 스스로 지운다. 살아 있는 PID면 거절하며, 이 경로는 시작시각으로 PID 재사용을 구별하지 않는다. EPERM은 다른 uid라서 경쟁 postmaster가 아니라는 전제 아래 처리한다. 깨진·빈 파일과 살아 있는 후손의 공유메모리는 별도 실패다. | [CreateLockFile](https://github.com/postgres/postgres/blob/41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf/src/backend/utils/init/miscinit.c#L1225-L1426) | 소스 확인 |
| <a id="E04"></a>E04 | fast 기본 신호는 INT, smart는 TERM, immediate는 QUIT. `-w` stop은 100ms 간격으로 PID 파일 소멸을 확인하며 기본 시한은 60초다. `-t` 만료는 오류 반환이며 보낸 정지 요청을 철회하거나 자동 KILL하지 않는다. `pg_ctl kill INT pid`는 전달만 한다. | [defaults](https://github.com/postgres/postgres/blob/41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf/src/bin/pg_ctl/pg_ctl.c#L69-L82), [wait_for_postmaster_stop](https://github.com/postgres/postgres/blob/41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf/src/bin/pg_ctl/pg_ctl.c#L709-L748), [set_mode](https://github.com/postgres/postgres/blob/41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf/src/bin/pg_ctl/pg_ctl.c#L2046-L2092), [do_kill](https://github.com/postgres/postgres/blob/41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf/src/bin/pg_ctl/pg_ctl.c#L1405-L1413); [PG18 정지 설명](https://www.postgresql.org/docs/18/server-shutdown.html) | 소스 확인 |
| <a id="E05"></a>E05 | Windows `pgkill`은 `\\.\pipe\pgsignal_<pid>`에 신호 byte를 보내고 응답을 확인한다. SIGKILL만 TerminateProcess다. 1000ms pipe 대기 인자를 전체 DB 정지 1초 보장으로 해석하면 안 된다. 받는 thread는 신호를 queue한 뒤 응답한다. | [pgkill](https://github.com/postgres/postgres/blob/41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf/src/port/kill.c#L20-L94), [pg_signal_thread](https://github.com/postgres/postgres/blob/41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf/src/backend/port/win32/signal.c#L272-L341) | 소스 확인 |
| <a id="E06"></a>E06 | Postgres Windows 콘솔 handler도 Ctrl+C/BREAK/CLOSE/SHUTDOWN을 받으면 SIGINT를 queue한다. 따라서 같은 콘솔에 붙은 DB가 앱 drain 전에 정지를 시작할 수 있다. Node `child.kill("SIGINT")`가 PG pipe 프로토콜을 대신하지는 않는다. | [pg_console_handler](https://github.com/postgres/postgres/blob/41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf/src/backend/port/win32/signal.c#L374-L389); [Node 플랫폼 신호](graceful-shutdown-references.md#E32) | 소스 확인 |
| <a id="E07"></a>E07 | 관리자 거부는 직접 실행한 postgres의 검사다. Windows initdb는 `get_restricted_token()`으로 자신을 낮춘 token에서 재실행한다. pg_ctl start도 Administrators/Power Users SID와 privilege를 제한한 token으로 CMD/Postgres를 시작한다. 별도 비관리자 계정을 만드는 방식이 아니다. | [check_root](https://github.com/postgres/postgres/blob/41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf/src/backend/main/main.c#L444-L484), [initdb main](https://github.com/postgres/postgres/blob/41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf/src/bin/initdb/initdb.c#L3461-L3472), [restricted token/re-exec](https://github.com/postgres/postgres/blob/41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf/src/common/restricted_token.c#L44-L174), [CreateRestrictedProcess](https://github.com/postgres/postgres/blob/41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf/src/bin/pg_ctl/pg_ctl.c#L1760-L1851) | 소스 확인 |
| <a id="E08"></a>E08 | pg_ctl start는 POSIX에서 fork/setsid 후 실행한다. Windows는 CMD /C와 CreateRestrictedProcess를 쓰며 반환 PID는 shell PID일 수 있다. start 대기는 새 pidfile 시작시각과 ready 상태를 본다. pg_ctl 자신이 정상 exit한 것은 DB exit가 아니다. 이 구조에 앱 부모 사망 회수 계약은 없다. | [start_postmaster](https://github.com/postgres/postgres/blob/41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf/src/bin/pg_ctl/pg_ctl.c#L428-L576), [wait_for_postmaster_start](https://github.com/postgres/postgres/blob/41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf/src/bin/pg_ctl/pg_ctl.c#L600-L644), [제한용 Job flags](https://github.com/postgres/postgres/blob/41b4b8e8bf1a07ce4fbfa86b8e544299e1a706cf/src/bin/pg_ctl/pg_ctl.c#L1851-L1901) | 소스 확인 |
| <a id="E09"></a>E09 | Node 문서는 Windows detached를 자체 console 가능성으로 설명하지만, 이 고정 libuv 구현은 DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP를 쓴다. 부모 콘솔 미상속과 새 창 강제 생성은 다르다. windowsHide는 SW_HIDE 및 stdio 조건부 CREATE_NO_WINDOW다. pg_ctl가 띄우는 손자 창까지 숨김을 보장하지 않는다. | [spawn flags](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/deps/uv/src/win/process.c#L1034-L1065); [detached 문서](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/doc/api/child_process.md#L923-L953); [Win32 creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags) | 소스 확인 |
| <a id="E10"></a>E10 | libuv는 non-detached 직접 자식을 부모만 handle을 가진 KILL_ON_JOB_CLOSE Job에 넣는다. detached는 건너뛴다. SILENT_BREAKAWAY_OK라 손자는 자동 포함되지 않으며, Job 배정 ACCESS_DENIED도 무시할 수 있다. pg_ctl만 non-detached로 바꿔도 postgres 트리 회수가 보장되지 않는다. | [global Job](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/deps/uv/src/win/process.c#L69-L119), [배정/실패 경로](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/deps/uv/src/win/process.c#L1082-L1105) | 소스 확인 |
| <a id="E11"></a>E11 | Windows exit에서 `void cluster.stop()`은 첫 await 전에 taskkill spawn까지 진행할 수 있다. 그러나 callback·정지 완료를 기다릴 수 없고, 기본 non-detached taskkill 자신이 libuv Job에 들어가 부모 exit 때 잘릴 수도 있다. “spawn했으니 DB가 반드시 죽었다”는 결론은 성립하지 않는다. | [CreateProcessW/Job](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/deps/uv/src/win/process.c#L1067-L1105); [기존 Node exit 계약](graceful-shutdown-references.md#E01), [라이브러리 stop](graceful-shutdown-references.md#E09) | 추론 |
| <a id="E12"></a>E12 | JS #28은 detached/shared DB, #35는 supervisor 소유권·hook opt-out, #32는 이미 끝난 child의 미래 exit 대기 문제다. #38은 Windows 다음 시작의 약 4초 recovery, #41은 강제 tree kill 뒤 forkchild 잔존과 pg_ctl fast 약 250ms 회피를 보고한다. 모두 타인의 보고이며 이 PC 측정이 아니다. 읽은 README·이 이슈들에서 직접 spawn을 고른 명시 이유는 찾지 못했다. | [#28](https://github.com/leinelissen/embedded-postgres/issues/28), [#32](https://github.com/leinelissen/embedded-postgres/issues/32), [#35](https://github.com/leinelissen/embedded-postgres/issues/35), [#38](https://github.com/leinelissen/embedded-postgres/issues/38), [#41](https://github.com/leinelissen/embedded-postgres/issues/41) | 문서 주장 |
| <a id="E13"></a>E13 | Zonky는 pg_ctl start와 `stop -m fast -t 5 -w`를 쓴다. 다음 시작의 cleanOldDataDirectories는 epg-lock 존재·10분 경과·tryLock을 보고 orphan stop→삭제를 시도한다. stop 실패를 catch한 뒤에도 삭제하는 부분은 안전한 삭제 계약으로 가져오면 안 된다. | [startPostmaster](https://github.com/zonkyio/embedded-postgres/blob/44f6301c33a9255c98af648966a3b3f48a2ca15b/src/main/java/io/zonky/test/db/postgres/embedded/EmbeddedPostgres.java#L267-L301), [pgCtl/cleanOldDataDirectories](https://github.com/zonkyio/embedded-postgres/blob/44f6301c33a9255c98af648966a3b3f48a2ca15b/src/main/java/io/zonky/test/db/postgres/embedded/EmbeddedPostgres.java#L431-L482) | 소스 확인 |
| <a id="E14"></a>E14 | Zonky PR #39는 직접 postgres 실행의 이유로 자식 트리 유지·orphan 방지를 들었다. #66은 그 변경의 Windows 관리자 문제를 보고하며 logging 이유도 토론한다. 현행 E13은 pg_ctl이다. 다른 라이브러리의 설계 의도를 JS의 이유로 옮길 수 없다. | [PR #39](https://github.com/zonkyio/embedded-postgres/pull/39), [#66](https://github.com/zonkyio/embedded-postgres/issues/66) | 문서 주장 |
| <a id="E15"></a>E15 | Paperclip은 살아 있는 PID가 있으면 pid/dataDir/실제 port를 helper로 검사하고 SQL data_directory를 대조해 DB를 재사용한다. 이 경로에서 OS 생성 식별자·실행 중 버전·설정 일치까지 검사하지는 않는다. 재사용의 실제 선례이지 완성된 소유권 계약은 아니다. | [startup reuse](https://github.com/paperclipai/paperclip/blob/beb73381ca086eb87bcb08e12364993fc15bbf9c/server/src/index.ts#L574-L604), [owner helper](https://github.com/paperclipai/paperclip/blob/beb73381ca086eb87bcb08e12364993fc15bbf9c/server/src/embedded-postgres-owner.ts#L5-L11) | 소스 확인 |
| <a id="E16"></a>E16 | Python pgserver는 lock 아래 살아 있는 PostmasterInfo면 재사용하고 새 기동은 pg_ctl -w -l을 쓴다. PostmasterInfo의 OS start-time 비교는 주석 처리돼 있다. 이 생존 검사 자체는 process name도 검사하지 않는다. 마지막 handle cleanup은 pg_ctl stop 후 실패시 terminate/kill 및 선택적 삭제다. | [ensure/cleanup](https://github.com/orm011/pgserver/blob/3b227607a6c94590ba7c16ae827cef9fb7e3920b/src/pgserver/postgres_server.py#L133-L241), [identity 검사 한계](https://github.com/orm011/pgserver/blob/3b227607a6c94590ba7c16ae827cef9fb7e3920b/src/pgserver/utils.py#L64-L80) | 소스 확인 |
| <a id="E17"></a>E17 | Go v2 supervisor는 Postgres에 상속되지 않는 전용 입력 pipe EOF로 부모 사망을 감지한다. `pg_ctl stop -m fast -w -t` 후 실패·만료시 플랫폼 Kill을 쓰고, DB 선종료도 감지한다. 추가 프로세스가 수명을 소유하는 구체적 PG 사례다. | [Run](https://github.com/fergusstrange/embedded-postgres/blob/b505714f34b4ce90788630c5bbcbf9f25b0ce83f/internal/supervisor/supervisor.go#L33-L110) | 소스 확인 |
| <a id="E18"></a>E18 | Go v2는 Windows restricted token/새 그룹/HideWindow를 직접 구현한다. supervisor 자신을 KILL_ON_JOB_CLOSE Job에 넣고 자식을 생성하며 handle을 exit까지 보유한다. Node core 옵션 하나로 같은 strict tree containment가 생기는 것은 아니다. | [configureWindows/Guard](https://github.com/fergusstrange/embedded-postgres/blob/b505714f34b4ce90788630c5bbcbf9f25b0ce83f/internal/platform/process_windows.go#L112-L195) | 소스 확인 |
| <a id="E19"></a>E19 | Rust postgresql-embedded는 pg_ctl start -l/-w, stop Fast/-w를 쓴다. stop 주석의 smart와 실제 Fast가 다르다. Drop은 stop 결과를 무시하고 temporary 폴더 삭제도 시도한다. Drop은 SIGKILL 이후 실행 보장이 아니다. | [start/stop](https://github.com/theseus-rs/postgresql-embedded/blob/efb7b2452f5380555d79a788f189cb2c2c49af38/postgresql_embedded/src/postgresql.rs#L318-L383), [Drop](https://github.com/theseus-rs/postgresql-embedded/blob/efb7b2452f5380555d79a788f189cb2c2c49af38/postgresql_embedded/src/postgresql.rs#L520-L540) | 소스 확인 |
| <a id="E20"></a>E20 | 현행 otj-pg-embedded는 Docker PostgreSQLContainer wrapper여서 과거 native runner와 구별해야 한다. .NET MysticMind는 pg_ctl fast/5초, Python testing.postgresql는 POSIX INT/Windows None을 기반 클래스 terminate에 넘긴다. 후자의 Windows 정상 PG 정지는 이 파일만으로 확인되지 않는다. | [otj constructor](https://github.com/opentable/otj-pg-embedded/blob/920adf09d8805108068c05f112ca1f805464c533/src/main/java/com/opentable/db/postgres/embedded/EmbeddedPostgres.java#L46-L99), [PgCtl stop](https://github.com/mysticmind/mysticmind-postgresembed/blob/517fa01e35c97d9656bc785a31ace40e06385fc6/src/MysticMind.PostgresEmbed/PgServer.cs#L485-L501), [commandline/terminate](https://github.com/tk0miya/testing.postgresql/blob/c81ded434d00ec8424de0f9e1f4063c778c6aaa8/src/testing/postgresql.py#L91-L117) | 소스 확인 |
| <a id="E21"></a>E21 | pg_tmp는 별도 background stop 작업을 미리 띄운다. SQL 활동 세션이 없어질 때 pg_ctl -W stop 후 trap으로 tmp를 지운다. 부모 사망 감시가 아니라 DB 유휴 정책이며 -W 뒤 sleep 1초를 충분한 종료 확인으로 가정하면 안 된다. | [start/stop](https://github.com/eradman/ephemeralpg/blob/33bcceacb23c23a78150e618ed9238f161e468be/pg_tmp.sh#L85-L145) | 소스 확인 |
| <a id="E22"></a>E22 | Smushy fork는 sidecar ownership marker가 가리키는 경로를 부모의 직접 자식으로 제한한다. 그러나 normalize는 symlink 실경로 검사가 아니며, tryLock 블록이 실제 stop/delete 전에 끝나고 stop 실패 뒤에도 삭제를 시도한다. 표식 범위 제한만 설계 참고로 쓴다. | [cleanOldDataDirectories](https://github.com/SmushyTaco/embedded-postgres/blob/6d4db51637d312f982c1ee6ad8e79b32d268ceb4/src/main/java/com/smushytaco/postgres/embedded/EmbeddedPostgres.java#L442-L520) | 소스 확인 |
| <a id="E23"></a>E23 | Patroni는 PID 파일 시각과 OS 생성시각, exe, cwd를 사용한다. 다만 시각이 3초 안이면 먼저 true가 되고 cwd를 못 읽어도 허용하는 경로가 있다. 엄격한 앱 소유 증명으로 그대로 복사하지 않는다. | [_is_postmaster_process](https://github.com/patroni/patroni/blob/b3563098b4d25f7f79e03d5224137b8a0e68ed0e/patroni/postgresql/postmaster.py#L70-L152) | 소스 확인 |
| <a id="E24"></a>E24 | MongoDB memory server는 별도 detached Node killer에서 부모/DB PID를 2초마다 확인한다. 부모가 없으면 기본 TERM을 한 번 보내고 즉시 exit한다. 이 파일에는 시작 식별자·tree 종료 확인·tmp 삭제가 없다. 정상 stop/cleanup은 별도다. | [isAlive/check](https://github.com/typegoose/mongodb-memory-server/blob/9be9129dbe0767e3e7ea674a8bf232157f35f17c/packages/mongodb-memory-server-core/scripts/mongo_killer.js#L22-L68), [_launchKiller](https://github.com/typegoose/mongodb-memory-server/blob/9be9129dbe0767e3e7ea674a8bf232157f35f17c/packages/mongodb-memory-server-core/src/util/MongoInstance.ts#L538-L557), [normal cleanup](https://github.com/typegoose/mongodb-memory-server/blob/9be9129dbe0767e3e7ea674a8bf232157f35f17c/packages/mongodb-memory-server-core/src/MongoMemoryServer.ts#L570-L665) | 소스 확인 |
| <a id="E25"></a>E25 | Ryuk는 session filter를 연결에서 등록받고 마지막 연결 소멸 뒤 재접속 유예를 거쳐 자원을 회수한다. 새 연결과 자원 변화를 고려한다. PID polling 대신 연결 수명으로 회수하는 선례지만 Docker 권한과 독립 회수자 생존이 필요하다. | [handle](https://github.com/testcontainers/moby-ryuk/blob/0509b379b7c4a572c918d54079f9ede176045714/reaper.go#L234-L275), [pruneWait](https://github.com/testcontainers/moby-ryuk/blob/0509b379b7c4a572c918d54079f9ede176045714/reaper.go#L302-L375); [기존 E29](graceful-shutdown-references.md#E29) | 소스 확인 |
| <a id="E26"></a>E26 | VS Code extension host는 JS 부모 PID polling 외에 native-watchdog thread를 둔다. JS event loop가 멈추면 polling도 멈추기 때문이다. native addon은 빌드/배포 경계를 늘린다. | [watchdog start](https://github.com/microsoft/vscode/blob/d1a91b3af8869c37d4757aa959f0859b59c33265/src/vs/workbench/api/node/extensionHostProcess.ts#L351-L383) | 소스 확인 |
| <a id="E27"></a>E27 | Chromium Linux 계열은 pre-exec에서 선택적으로 PR_SET_PDEATHSIG/SIGKILL을 설정한다. 이는 OS별 native launch 경로이며 Postgres의 정상 정지 프로토콜이나 모든 OS 공통 옵션이 아니다. | [kill_on_parent_death](https://github.com/chromium/chromium/blob/def0a08abab2964675731106e2f6ea6ffd6f38f3/base/process/launch_posix.cc#L496-L516) | 소스 확인 |
| <a id="E28"></a>E28 | Linux PDEATHSIG는 자식 자신이 설정하며 생성 thread 사망·설정 전 race·fork/권한 변경으로 지워짐을 고려해야 한다. Windows Job은 마지막 handle 종료 시 강제 종료하며 상속·breakaway·nested Job의 영향을 받는다. Node core spawn의 공개 옵션에서 이 두 strict 제어 API는 확인하지 못했다. | [Linux man-pages](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html), [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs), [Node 옵션](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/doc/api/child_process.md#L657-L742) | 문서 주장 |
| <a id="E29"></a>E29 | macOS kqueue EVFILT_PROC/NOTE_EXIT는 사망 알림이다. 살아 있는 watcher가 정지를 수행해야 하며 부모 사망시 OS 자동 kill과 같지 않다. 표준 pipe EOF watcher는 macOS에서도 검증할 수 있는 공통 후보다. | [Apple kevent man page](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kevent.2.html) | 문서 주장 |
| <a id="E30"></a>E30 | theseus CI는 Windows/macOS에서 cargo test, Go v2는 Windows/macOS 및 restricted-token/Node launch 회귀 명령을 실행하도록 정의한다. workflow를 읽은 것으로 통과 이력을 확인했다고 할 수 없다. GitHub 공식 문서는 Windows hosted runner를 관리자/UAC off로 설명한다. | [Rust CI](https://github.com/theseus-rs/postgresql-embedded/blob/efb7b2452f5380555d79a788f189cb2c2c49af38/.github/workflows/ci.yml#L20-L89), [Go CI](https://github.com/fergusstrange/embedded-postgres/blob/b505714f34b4ce90788630c5bbcbf9f25b0ce83f/.github/workflows/v2.yml#L10-L100); [runner 권한](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#administrative-privileges) | 소스 확인 |
| <a id="E31"></a>E31 | Postgres.app 공식 문제 해결 문서는 살아 있는 다른 서버의 port/dataDir 충돌은 사용자가 그 서버를 멈추거나 port를 바꾸도록 안내한다. stale pidfile 자동 삭제 설명도 따로 있다. 제품 전체가 아무 정리도 하지 않는다는 사례가 아니라 소유가 불명확한 충돌을 수동 해결하는 사례다. | [Postgres.app troubleshooting](https://postgresapp.com/documentation/troubleshooting.html) | 문서 주장 |
| <a id="E32"></a>E32 | Node 24.21.0 + 설치된 PostgreSQL 18.6 Linux에서 detached postgres 부모 Node를 SIGKILL했다. postgres는 살아 있었고 같은 dataDir 새 start는 rc=1이었다. 소유 dataDir의 pg_ctl status는 rc=0, fast stop은 103.3ms/rc=0, pidfile 제거를 확인했다. | 로컬 probe·실행 기록(postgres 로그 포함) | 실행 확인 |
| <a id="E33"></a>E33 | 정상 정지 후 남겨 둔 pidfile 복사본 첫 줄을 존재하지 않는 PID 2147483647로 바꾸자 start 성공·새 PID 기록을 확인했다. 이는 합성 stale 파일 대조군이며 실제 postmaster SIGKILL/OOM·남은 공유메모리 사례의 재현은 아니다. | 로컬 실행 기록 | 실행 확인 |
| <a id="E34"></a>E34 | 제가 만든 무관한 sleep PID를 pidfile 첫 줄에 넣자 pg_ctl status는 rc=0과 이전 postmaster.opts를 출력했고, 새 start는 rc=1이었다. sleep을 PG로 오인해 stop하지 않았다. 별도 -t 0 stop 실험은 rc=1을 반환했지만 DB 정지는 뒤에서 완료됐다. | 로컬 실행 기록 | 실행 확인 |
| <a id="E35"></a>E35 | 독립 Node watcher의 stdin pipe를 부모만 보유하게 하고 부모를 SIGKILL했다. EOF 감지 후 watcher가 pg_ctl fast stop을 212ms에 완료했고 pidfile 제거·dataDir 보존을 확인했다. Linux 단일 성공 경로의 실현 가능성 실험이며 완성된 supervisor 구현/성능 보장은 아니다. | 로컬 probe·실행 기록(정리 결과 포함) | 실행 확인 |

### Q1–Q8을 적용해서 읽기

Q1의 네 방식은 모두 선택지가 된다. 다음 실행 회수는 Zonky(E13), 재사용은 Paperclip·pgserver(E15·E16), 즉시 회수는 Go supervisor·Mongo killer·Ryuk(E17·E24·E25), 소유 불명 충돌의 수동 안내는 Postgres.app(E31)이 대표다. 마지막 사례를 “강제 종료 뒤 아무 정리도 없는 제품”으로 일반화하지 않는다. Rust Drop·Python atexit 같은 정상 cleanup만 읽고 다음 실행 회수나 사망 감시가 전혀 없다고 단정하지도 않는다.

Q2에서는 **앱 소유 기록, 실제 프로세스 신원, DB 경로의 일치가 함께 필요하다**. pidfile은 Postgres가 쓴 상태 정보이지 BaboJUBot 소유 증명이 아니다. port 54329 또는 PG_VERSION 존재만으로도 부족하다. SQL `data_directory`는 재사용 전 보조 확인이 될 수 있지만 연결 실패는 “프로세스 없음”의 증명이 아니다. OS 신원 조회의 권한 거부도 죽음으로 취급하지 않는다(E01–E03·E15·E23·E34).

권고할 최소 기록은 dataDir의 정규 경로, 앱 인스턴스/lease, 영구·임시 구분, 이전 앱 owner의 PID와 생성 식별자, postmaster의 PID와 생성 식별자, 묶음 바이너리 버전·경로다. Linux에서는 기존 recovery처럼 boot id와 `/proc` start ticks를 쓸 수 있다. Windows는 생성 FILETIME/PowerShell StartTime, macOS는 별도 생성시각 조회가 필요하다. pidfile의 초 단위 시각을 OS 정밀 시각과 무조건 완전 동일 비교하면 안 된다. 동일 프로세스의 저장/현재 생성 식별자를 우선 비교하고 pidfile 시간은 보조로 쓴다(설계 추론). OS 확인 직후 PID가 재사용되는 경쟁도 완전히 사라지지 않으므로, 신호 직전에 재검사하고 불일치·모호함은 중단한다. 엄격한 원자적 대상 고정은 pidfd/Windows handle 같은 별도 OS 경계가 필요하며 이번 기본안에 넣지 않는다.

시작·회수·삭제에는 같은 dataDir에 대한 **프로세스 간 단일 실행권**이 필요하다. 이전 앱이 살아 있으면 두 번째 앱은 회수하지 않는다. 단순 파일 존재나 한 프로세스 내부 mutex만으로 이 계약이 생기지 않는다. 이 장치를 어떤 가벼운 파일/디렉터리 lease로 만들지는 구현 설계에서 정하되, 획득 전 사망·stale 해제·다중 시작 경쟁을 검증해야 한다. 같은 사용자 권한을 가진 악의적 프로세스까지 방어한다는 주장은 하지 않는다.

Q3의 일반 경로는 소유 확인 → `pg_ctl stop -D <절대경로> -m fast -w -t <남은 초>` → 완료 확인 → 필요시 재기동이다. 시작 회수의 fast 예산은 우선 10초를 제안하되 측정 전 설계값이다. 정상 앱 종료에서는 기존 30초 전체 시한의 **남은 시간 안에서** 정하고 60초 기본값을 그대로 쓰지 않는다. 제어 프로세스 외부 timeout도 두어 정지 명령 자체의 hang과 초 단위 반올림이 전체 예산을 늘리지 않게 한다. timeout이면 요청이 계속 진행할 수 있으므로 다시 상태를 확인한다(E04·E34).

영구 DB는 fast 실패시 기본으로 기동을 중단하고 dataDir·확인한 PID·실패 단계·로그 위치·같은 pg_ctl의 수동 정지 명령을 알릴 것을 권고한다. immediate는 정상 정지가 아니며 다음 시작 recovery가 필요하다. 임시 DB의 fast→immediate→최후 강제 tree 종료는 소유 신원을 다시 확인한 뒤 별도 예산 안에서만 허용할 정책 후보다. SIGKILL로 postmaster만 죽이면 후손·공유메모리 정리를 놓칠 수 있다. 어느 실패 경로에서도 “정지 명령 실패니까 폴더부터 삭제”하지 않는다(E03–E05·E13·E22).

재사용을 고른다면 pidfile의 **실제 port**, SQL data_directory, `server_version_num`/기대 major, 필요한 listen/auth/서버 설정, migration 호환성, 새 앱의 stop 권한을 확인해야 한다. major나 필수 설정이 다르면 조용히 채택하거나 데이터 폴더를 새로 만들지 않고 실패시킨다. exact 패키지 버전과 실행 중 서버 버전을 혼동하지 않는다. 재사용시 마지막 소비자가 누구인지와 어느 앱이 stop하는지도 계약이 된다(E15·E16에서의 설계 추론).

Q4·Q5의 핵심은 **정지 방식과 시작 방식을 독립적으로 바꿀 수 있다**는 점이다. postgres를 직접 spawn해도 bundled pg_ctl로 정상 stop할 수 있다. 반대로 pg_ctl start를 써도 부모 사망 후 orphan은 남을 수 있다. Windows `pg_ctl kill INT <pid>`도 PG pipe를 쓰지만 완료 대기가 없어 일반 close에는 stop -w가 낫다. Windows fast의 실제 소요 시간은 미확인이다. E12의 약 250ms와 Linux의 약 100–200ms는 작은 다른 조건의 결과이며 보장 시간이 아니다.

| 시작 방식 | 얻는 것 | Q1·Windows·관찰 비용 |
| --- | --- | --- |
| 직접 postgres spawn | 실제 child 참조·stdout/stderr·exit를 직접 관찰 | detached만으로 사망 회수 없음. Windows 관리자 token을 별도로 낮춰야 함. POSIX와 Windows signal 의미가 다름(E05–E10) |
| pg_ctl start -D … -w -t … -l … | PG 표준 readiness/로그·Windows restricted token | 앱↔pg_ctl↔shell/PG 수명 분리. 실제 postmaster PID는 pidfile/OS에서 다시 수집. pg_ctl 종료를 DB 종료로 오인 금지. 앱 사망 회수는 별도(E07·E08) |

`pg_ctl start`는 내부적으로 shell을 쓰므로 Node 바깥 호출을 `shell:false`/인자 배열로 해도 `-o` 문자열의 인용 문제는 남는다. 현재 settings 인자를 shell 문자열로 단순 연결하지 않도록 공백·따옴표·한글 경로를 검증해야 한다. `-l`은 명시적 파일에 기록하고 서버 진입점이 필요한 끝부분만 진단하게 한다. Windows에서는 pg_ctl가 만드는 CMD 창까지 숨겨지는지 별도 시험이 필요하다. 공개 [pgsql-bugs 콘솔 창 보고](https://www.postgresql.org/message-id/18bbefccd530e218.a6bdbcf84d30dc08.260dd5df653405e8%40NBK11-64-T5J)는 실패 사례의 문서 주장으로만 사용한다.

언어별 구현이 모두 같은 것은 아니다. Java Zonky·Rust theseus·Python pgserver·.NET MysticMind는 pg_ctl 경로가 있고, Go v2는 직접 token/Job을 가진 supervisor로 차별화한다. 현행 otj는 Docker다. testing.postgresql의 Windows 종료는 dependency까지 추적하지 못했으므로 정상 fast의 선례로 쓰지 않는다. pg-embed의 pg_ctl/Drop 경로는 로컬 조사 메모에서 비교하되 Windows 실동작 근거로 승격하지 않는다(E13·E16–E20).

Q6의 비용과 보장은 다음과 같다. **“부모가 어떤 이유로 죽어도 정상 정지를 끝낸다”는 사용자 공간 장치의 무조건 보장은 없다.** OS 전원 상실·전체 Job/cgroup 종료·watcher도 함께 OOM되는 경우는 다음 시작 recovery가 필요하다.

| 방식 | Node 적용·비용 | 주요 실패 모드 |
| --- | --- | --- |
| 다음 시작 회수 | 추가 상주 프로세스 없음. 파일 기록·신원 검사·경합 제어 | 다음 실행 전까지 DB와 tmp가 남음. 기록 전 사망/권한 거부는 수동 진단(E02·E13) |
| 작은 독립 Node watcher + pipe/IPC EOF | 추가 Node 프로세스 1개와 RSS·IPC handshake·배포/로그 경계. Linux 최소 실험 성공 | watcher 동시 사망, PG가 pipe handle 상속하여 EOF 지연, 등록 전 사망. watcher가 먼저 소유권을 확보하고 DB를 띄우는 쪽이 낫다(E17·E24·E25·E35) |
| Linux PDEATHSIG | 자식 pre-exec를 제어할 작은 native launcher/addon 필요. 부모 Node 자신에게 prctl만 걸면 해결 안 됨 | 설정 전 부모 사망, 생성 thread, 권한 변경, pg_ctl 단명 부모와의 관계. INT/QUIT면 정지 기회는 주지만 완료 감시는 별도; KILL이면 crash 경로(E27·E28) |
| Windows strict Job KILL_ON_JOB_CLOSE | 마지막 handle 소유·비상속, suspended→assign→resume과 nested Job을 관리할 native/helper 경계 | 강제 종료이며 fast 아님. descendant breakaway·다른 holder·배정 실패·pg_ctl 제한 Job 상호작용. libuv 기본 Job만으로 전체 트리 보장 불가(E10·E18·E28) |
| macOS watcher/kqueue 또는 별도 서비스 | pipe watcher는 공통 JS 후보. kqueue 직접 사용은 native 경계; 서비스는 설치·운영 비용 | kqueue는 사망 알림일 뿐. Linux prctl와 동등한 공통 spawn 옵션을 확인하지 못함. macOS 실행 미확인(E29) |
| Linux systemd/Docker 등 외부 감독 | 이미 쓰는 배포 환경에서는 상주 자원 경계에 포함 가능 | 로컬 pnpm dev 공통 해법으로 설치를 강제하지 않음. 정상 종료 예산과 최종 강제 종료를 구분([기존 조사](graceful-shutdown-references.md#E24)) |

Q7은 프로세스 정지와 폴더 삭제를 따로 다룬다. 이름이 `babojubot-pg-*`라는 이유나 오래됐다는 이유만으로 tmp 전체를 지우지 않는다. 생성 직후 앱 전용 표식/등록부에 실제 경로·임시 구분·lease·owner를 남기고, 다음 embedded 초기화에서 그 목록만 확인하는 안을 권고한다. 부모가 살아 있는 병렬 테스트와 영구 DB, symlink/부모 경로 밖 대상은 제외한다. initdb 완료 전 사망한 폴더도 식별할 수 있어야 한다. 소유와 무활동을 확인한 뒤 정지→종료 확인→삭제→등록 제거 순서를 지킨다. 삭제 실패는 기록을 남겨 재시도하며 DB를 멈춘 사실과 폴더를 지운 사실을 별도로 보고한다(E13·E21·E22·E24).

Q8은 “Windows 관리자라 내장 DB는 검증할 수 없다”로 고정할 문제가 아니다. 표준 pg_ctl/initdb의 제한 token 경로가 있으므로 bundled 바이너리로 Windows embedded smoke를 먼저 추가할 근거가 있다. 실패하면 사용자 프로필·ACL·COMSPEC·signal pipe 권한을 분리 진단하고, 별도 비관리자 계정/전용 runner는 그 다음 선택지다. 외부 Postgres boot-check는 연결 경로만 검증하므로 내장 DB 검증을 대체하지 않는다. macOS는 일반 사용자로 native 기동·fast stop·부모 사망·회수 경로를 추가할 수 있다. 이번에는 workflow 파일만 읽었고 실제 Windows/macOS CI를 실행하지 않았다(E07·E30).

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
| --- | --- | --- | --- | --- | --- |
| <a id="P01"></a>P01 | 다음 시작에서 소유 검증 후 정지·청소 | E13·E22·E32 | 임시/영구 분리·삭제 전 정지 성공 필수 | 추가 상주 비용 작음 | 다음 시작 전 잔존, PID/경합·기록 전 사망 |
| <a id="P02"></a>P02 | 살아 있는 DB 재사용 | E15·E16 | SQL 경로·버전·설정과 stop 권한 보강 | 재기동 비용·기존 연결 중단 감소 | 소유 불명 DB 접속·구버전/설정 드리프트·다중 앱 수명 |
| <a id="P03"></a>P03 | 공통 pg_ctl fast stop와 별도 시작 계약 | E04–E08·E13·E19 | 직접 spawn에도 stop만 적용 가능 | Windows도 PG 정상 정지 | timeout이 취소는 아님·신원 검사 별도 |
| <a id="P04"></a>P04 | 독립 회수자의 EOF/연결 수명 | E17·E24·E25·E35 | PG-specific fast를 쓰고 등록 확인 | 앱 SIGKILL에도 정지 기회 | 추가 프로세스·watcher 동시 사망·handle 상속 |
| <a id="P05"></a>P05 | OS native containment | E10·E18·E27–E29 | 플랫폼별 token/Job/prctl; macOS는 watcher | 부모 사망과 결합된 강제 회수 | 정상 정지 아님·native 배포·tree/race 제약 |
| <a id="P06"></a>P06 | 소유 불명 충돌은 기동 중단·수동 안내 | E02·E23·E31·E34 | 앱 소유 확인된 orphan과 구별 | 무관한 사용자/앱 DB 보존 | 진단/사용자 개입 필요 |
| <a id="P07"></a>P07 | 소유 표식 목록에서만 tmp 회수 | E13·E21·E22·E24 | 이름/나이가 아닌 identity·실경로·활성 owner | 다른 테스트와 영구 데이터 보호 | 표식 전 사망·동시 청소·삭제 실패 재시도 |

## 결정 권고

아래 채택은 구현 권고이며 정책 확정이나 동작 검증 완료가 아니다. 사용자 선택이 남는 D01·D06은 잠정 기본안을 명시했다. 특히 Windows/macOS 실행은 모두 미확인이다.

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
| --- | --- | --- | --- | --- | --- |
| <a id="D01"></a>D01 | 변형 채택 | 문제 1: 다음 시작에서 앱 소유 orphan을 확인해 fast stop 후 같은 영구 dataDir로 새로 시작. 임시 것은 정지 확인 후 삭제. 살아 있는 이전 앱은 충돌로 처리 | P01·P06·P07; E32–E34 | 기존 앱 소유 DB 수명과 맞고 추가 상주 비용 작음. 다음 시작 전 누적은 남으므로 정지/재사용 정책은 O01에 열어 둠 | Q1·Q2·Q3·Q7 |
| <a id="D02"></a>D02 | 채택 | 문제 2: Windows 정상 stop을 bundled pg_ctl stop -m fast -w -t로 교체. 공통 정지 경로로 사용하고 taskkill /f /t는 정상 stop에서 제외 | P03; E04–E06·E12 | PG pipe가 graceful fast 제공. 성공 확인 뒤만 임시 폴더 삭제. 실제 Windows 성공/시간은 CI 필요 | Q3·Q4 |
| <a id="D03"></a>D03 | 변형 채택 | 문제 3a: 공통 lifecycle 제어 객체를 두고 pg_ctl start -w -t -l 전환을 권고. Windows는 내장 restricted token을 활용; 실제 PG PID/로그/부분 시작 정리를 다시 연결 | E07·E08·E14·E19·E30 | native token addon 없이 관리자 CI를 풀 근거. pg_ctl child 참조가 PG 참조를 대체하지 않음. stop 전환은 start 전환과 독립적으로 검증 가능 | Q5·Q8 |
| <a id="D04"></a>D04 | 변형 채택 | 문제 3b: 콘솔 격리를 OS별로 검증. 직접 spawn을 유지하는 동안 POSIX session 분리는 유지하고 Windows detached/windowsHide를 같다고 취급하지 않음. pg_ctl 전환시 자손까지 시험 | E06·E09·E10 | Windows detached는 콘솔 미상속과 기본 Job 우회를 함께 일으킴. windowsHide 단독이나 non-detached만으로 그룹 격리·tree 회수를 보장할 수 없음 | Q5·Q6 |
| <a id="D05"></a>D05 | 변형 채택 | 문제 3c: exit 비상 경로는 이미 확보한 소유 정보로 동기 제어만 수행. Windows void stop 대신 짧은 spawnSync 비상 정지 시도를 별도 계약으로. 정상 경로의 async close와 분리 | E05·E10·E11; 기존 권고 5 | exit에서 새 신원 조회/삭제를 하지 않음. 기본안은 소유 PID에 pg_ctl kill QUIT를 제한시간 내 전달; pipe가 안 되면 이미 확인된 tree에 짧은 동기 taskkill fallback을 정책에 따라 사용. 완료 보장·SIGKILL 대응으로 표시 금지 | Q4·Q5·Q6 |
| <a id="D06"></a>D06 | 보류 | 문제 3d: OS별 native 자동 kill은 기본 도입 보류. 즉시 회수가 필수라면 독립 Node watcher를 변형 채택 후보로 두고 O02에서 범위를 결정 | P04·P05; E17·E18·E24–E29·E35 | 작은 Node watcher가 가장 가벼운 공통 대안. 그래도 별도 RSS/IPC와 동시 사망 한계가 있어 다음 시작 회수는 유지. native Job/prctl은 강제 회수 요구가 더 강할 때 재검토 | Q1·Q6 |
| <a id="D07"></a>D07 | 변형 채택 | 임시 DB는 앱 전용 소유 목록에서 다음 실행 청소. initdb 전후 사망·정지 실패·삭제 실패를 구별 | P07; E13·E21·E22 | glob/나이만의 tmp 삭제 배제. 활성 병렬 테스트·외부/영구 DB를 보호. 감시 프로세스가 DB를 멈춰도 폴더 청소는 따로 필요 | Q7 |
| <a id="D08"></a>D08 | 채택 | pidfile·pg_ctl status를 소유 증명으로 쓰지 않고 앱 lease + OS 생성 신원 + 경로를 함께 확인. 불명확하면 자동 정지/삭제 중단 | E01–E03·E15·E23·E34 | PID 재사용 음성 대조가 직접 재현됨. 기존 기록 없는 DB의 자동 회수는 안전하게 보장할 수 없어 명시 진단 필요 | Q2·Q3 |
| <a id="D09"></a>D09 | 채택 | Windows 관리자 CI에서 bundled initdb→pg_ctl start→연결→fast stop→재시작을 검증; macOS에도 수명 경계 추가 | E07·E30 | 외부 Postgres boot-check와 다른 경로. 별도 계정은 표준 token 경로 실패가 확인될 때의 대안. workflow 존재는 통과 증거가 아님 | Q4·Q5·Q8 |

D03은 일반 경로를 먼저 갖춘다는 프로젝트 원칙을 따른다. 시작 전환의 폭을 줄여야 한다면 공통 제어 객체·stop을 먼저 만들고 Windows start만 pg_ctl로 연결하는 중간 단계도 가능하다. 어느 순서든 SIGINT/SIGTERM/SIGHUP 소유권과 서버 정리→DB 닫기 순서는 기존 main.ts에 둔다. D05의 sync timeout은 기존 shutdown 절대 시한의 비상 여유 안에 배치해야 하며, 예산 뒤에 새 대기를 더하지 않는다. 갑자기 발생한 일반 `process.exit`에는 짧은 최대 동기 지연을 별도로 명시한다. Windows 콘솔 닫기의 더 짧은 OS 제한도 실제 시험한다.

### 배제한 패턴

| 패턴 | 사례 | 이유 |
| --- | --- | --- |
| port 또는 pidfile 첫 줄만 보고 자동 kill | E02·E15·E16·E34 | 무관한 PID/다른 DB 오인 |
| stale pidfile를 먼저 unlink하고 시작 | E03·E31 | PG 자체 stale 처리와 공유메모리 보호를 우회. PID 재사용이라도 근거 없이 강제 해제 금지 |
| 정지 실패 뒤 dataDir 삭제 | E13·E19·E22 | 살아 있는 DB/후손 데이터 손실·Windows handle 경합 |
| Mongo killer를 그대로 복사 | E24 | PID 재사용·EPERM·one-shot TERM·tmp 미정리·Windows PG fast 아님 |
| detached나 pg_ctl start만으로 사망 회수 완료 | E08–E10·E32 | 수명 분리는 회수자 생성이 아님 |
| 정상 Windows 종료를 계속 taskkill /f /t로 처리 | E05·E12 | crash recovery·후손 잔존 보고; PG fast 경로 존재 |
| 외부 DB CI를 내장 DB 검증으로 간주 | E07·E30 | token·콘솔·pipe·수명 경로 미통과 |

## 구현 참고

권고 요약은 **소유권 확인 → fast 정지 → 완료 확인 → 임시만 삭제**다. 재사용/즉시 watcher를 선택하면 그 부분의 계약을 명시적으로 추가한다. 아래는 구현 위치 후보이며 이번에 변경하지 않았다.

| 위치 | 책임·주의 |
| --- | --- |
| `packages/db/src/client.ts`의 startEmbeddedCluster/startCluster/ephemeralCluster/close | 공통 lifecycle adapter 진입점. 시작/회수/정지/삭제를 묶고 실제 postmaster identity·부분 기동 실패·동일 stop Promise를 관리. pg_ctl start 전환시 private cluster.process/exit 의존을 그대로 유지하지 않음 |
| DB 패키지 내부 별도 lifecycle 모듈(필요시) | bundled pg_ctl 해석·소유 기록·프로세스 간 실행권·tmp 목록·OS identity를 감춤. public handle은 기존 close 의미 유지. 구현할 파일명·세부 형식은 미정 |
| `patches/embedded-postgres@18.6.0-beta.19.patch` | 계속 library start/stop을 쓰면 Windows pg_ctl/삭제 순서를 patch할지 검토. adapter가 직접 제어하면 기존 stop을 다시 호출해 taskkill/자동 삭제가 발생하지 않게 함. hook 제거/exact-version은 유지 |
| `apps/server/src/main.ts` | 기존 신호 소유권·서버→DB 순서·전체 deadline 유지. DB 복구 실패를 startup 실패로 드러내며 독자적인 DB 신호 listener는 추가하지 않음 |
| `packages/runtime/src/providers/recovery.ts`, `process.ts` | boot/start identity 기록의 설계 참고. provider group TERM→KILL 회수를 DB에 그대로 호출하지 않음(TERM은 PG smart). db에서 runtime을 의존하게 만들지 않고 작은 공통 유틸 추출 필요성만 검토 |
| `.github/workflows/scaffold.yml`, `scripts/boot-check.mjs`, DB 수명 관련 테스트 | 후속 구현 검증 위치. Windows embedded와 기존 외부 연결 경로를 각각 확인. 이번에는 설정·테스트도 변경하지 않음 |

조직 경계·초기 연구 승인·최종 완료 규칙과 충돌하는 권고는 없다. 내장 DB의 로컬 프로세스 소유 기록은 조직별 연구 기억·보고와 별개이며 자격 증명/실제 연구 데이터를 Git에 넣지 않는다. 외부 DATABASE_URL이면 서버 프로세스 정지·dataDir 청소를 호출하지 않는 계약을 유지한다. 환경 전용 native 코드는 공통 경로로 해결되지 않는 요구가 확인된 뒤 추가한다(AGENTS·구조 문서와 대조).

### Linux에서 자동 검증할 경계

다음 표의 “기대”는 후속 구현의 테스트 목표다. **이번 실행 완료는 E32–E35의 두 probe에 한정**된다.

| ID | 검증할 경계: 입력 → 행동 → 기대 | 근거 |
| --- | --- | --- |
| V01 | 서버 Node만 SIGKILL → 다음 시작 소유 확인/fast stop → 기존 영구 데이터 보존·재기동 성공 | D01·D08; 현상/stop만 E32 실행 |
| V02 | 실제와 다른 PID/start/boot/lease, 무관한 sleep/다른 PG, 조회 EPERM → 모호함 진단 → 타 프로세스 정지/삭제 없음 | D08; sleep status 오인 E34 실행 |
| V03 | dead PID stale 파일 → PG에 시작 맡김 → 안전한 파일은 자동 회수, 공유메모리 사용·깨진 파일은 명시 실패 | E03·E33; 합성 dead PID만 실행 |
| V04 | 두 앱 동시 시작/cleanup, 이전 앱 또는 watcher가 살아 있음 → dataDir 단일 실행권 → 한쪽이 임의 회수하지 않음 | D01·D06·D08 |
| V05 | fast timeout/명령 spawn 실패·pg_ctl 비정상 exit → 재관찰/정해진 실패 → 추가 DB 기동·폴더 삭제 금지 | D02; -t 0 진행 지속 E34 실행 |
| V06 | initdb 도중·PG 시작 직후·identity 저장 전 앱 사망 → 부분 기동 기록/복구 → 소유 불명 대상을 kill하지 않음 | D01·D07·D08 |
| V07 | 임시 생성/정지/삭제 중 SIGKILL, 오래된 marker, symlink, 다른 사용자의 폴더, 활성 병렬 테스트 → 목록 기반 회수 → 임시 소유 대상만 삭제 | D07 |
| V08 | 영구·외부 DATABASE_URL, 버전/설정/port 불일치 재사용 후보 → 검증/실패 → 영구 보존·외부 DB 정지 없음 | D01·D08; 재사용 선택시 Q3 계약 |
| V09 | watcher 선택시 부모 SIGKILL·등록 ACK 전 사망·EOF·정상 close·watcher 자체 사망 → bounded stop/다음 시작 fallback → 중복 정지·pipe 상속 누락 없음 | D06; 단일 Linux EOF 성공만 E35 실행 |
| V10 | 중복 close/DB 먼저 exit/앱 시한 만료 → 같은 정리 완료 또는 유한 실패 → 미래 exit 무한 대기/예산 뒤 추가 대기 없음 | D02·D05; 기존 #32 경계 |

### Windows/macOS CI에서 확인할 경계 — 이번에는 모두 미확인

| ID | OS·입력 → 행동 → 기대 | 근거 |
| --- | --- | --- |
| V11 | Windows 관리자 runner + exact packaged pg_ctl/initdb → init/start/SQL/fast stop/restart → token 성공·정상 shutdown·강제 종료 유래 recovery 불필요 | D02·D03·D09 |
| V12 | Windows 콘솔 Ctrl+C/닫기·IDE 종료·taskkill 부모만 종료 → 앱 순서/감시 경로 → PG 선종료/예기치 않은 새 창·후손 잔존 여부 확인 | D04·D06 |
| V13 | Windows process.exit 즉시 종료·pipe 접근 거부·taskkill 실패 → sync 비상 경로 → 전달 결과/시한/원 exit code 확인; PG 정지 완료로 오인 금지 | D05 |
| V14 | Windows 여러 cluster 병렬 생성/정지, Job 안/밖·restricted token·손자 CMD/PG → fast/최후 fallback → 후손 0 확인 뒤 임시 폴더 삭제 | E10·E12·E18 |
| V15 | Windows/macOS 공백·한글 경로·인용문자 포함 설정·실제 PID와 pg_ctl PID 차이 → pg_ctl start -l/-w → 정확한 identity·준비 상태·로그·cleanup | D03 |
| V16 | macOS 일반 사용자·부모 SIGKILL·동시 dev·tmp 잔존 → OS 생성 identity 확인/fast 회수 → 다른 앱 보존·영구 보존 | D01·D07·D08·D09 |
| V17 | watcher/native 선택시 Windows hard terminate/nested Job, macOS EOF/session 종료 → 회수/재시작 fallback → 범위별 보장과 실패가 관찰 가능 | D06 |

### 열린 결정 — 사용자 판단

| 열린 결정 | owner | 선택지와 근거 |
| --- | --- | --- |
| O01 남은 영구 DB를 어떻게 할지 | 사용자 | ① 권고: 소유 확인 후 fast stop·재시작(D01), 기존 앱 수명 유지·중단 비용. ② 호환성 검사 후 재사용(P02), 빠르지만 버전/설정·stop 권한/다중 소비자 계약 추가. ③ 소유 불명/기존 기록 없음은 자동 처리하지 않고 명시 복구 안내(P06); 안전하지만 수동 개입. 확인된 orphan 기본 정책은 ①/② 중 선택 |
| O02 부모 사망 직후 회수의 범위 | 사용자 | ① 권고 기본: 다음 시작 회수만(D01·D07), 추가 프로세스 없음·그 전까지 누적. ② 작은 독립 Node watcher를 이번 변경에 포함(P04/E35), 즉시 fast stop 기회·추가 Node RSS/IPC·동시 사망 한계. ③ strict OS native containment까지 포함(P05), 강제 tree 회수 강화·플랫폼별 helper와 배포 비용; 현재 보류 |
| O03 fast timeout 이후 강제 정지 | 사용자 | ① 권고: 영구 DB는 오류로 기동 중단·수동 진단, 임시 DB만 소유 재검사 뒤 제한된 escalation. ② 영구도 명시 설정으로 fast→immediate 허용, 자동 복구는 편하지만 다음 시작 recovery·실패 상황 구분 필요. 기본 postmaster SIGKILL/무조건 폴더 삭제는 배제(E03–E05·E12) |

## 한계와 미확인

- 공개 자료 접근의 영구 차단은 없었다. `theseus-rs/postgresql_embedded`, `mysticmind/PostgresEmbed`는 404였으나 실제 hyphen/이름의 저장소를 찾아 읽었다. nodkz 후보도 현재 typegoose 경로로 확인했다. Microsoft Learn 상단 로그인 안내와 달리 사용한 본문은 열렸다.
- JS의 직접 spawn 선정 이유는 읽은 README·#28/#32/#35/#38/#41 범위에서 찾지 못했다. commit 전체 이력·모든 discussion을 전수 추적하지 않았다. Zonky의 역사적 이유를 대신 쓰지 않는다.
- Windows/macOS는 문서·고정 소스만 확인했다. 우리 Windows 바이너리의 pg_ctl/initdb 포함·의존 DLL·token/ACL/pipe/콘솔·실제 stop 시간·exit taskkill race, CI 통과 이력은 미확인이다. Linux 설치본에는 initdb/pg_ctl/postgres 세 실행 파일이 있고 `postgres --version`은 18.6이었다.
- Linux는 유휴 소형 cluster에서 부모 SIGKILL, 합성 stale PID·무관한 live PID, pg_ctl fast/timeout, 최소 pipe watcher를 실행했다. 실제 OOM·DB postmaster SIGKILL·지속 중 거래 rollback·대용량 checkpoint·공유메모리 후손 잔존·장시간 경합·제품 통합은 실행하지 않았다. native addon/C launcher·Docker/Ryuk·타 라이브러리 자체 테스트도 실행하지 않았다.
- probe는 port 55400/55401과 `/tmp/pg-lifecycle-probe/`만 사용했다. 생성한 부모·대조 프로세스·DB는 정리했고 해당 경로를 지웠다. 두 실험 뒤 해당 경로의 살아 있는 postgres/node가 없음을 별도 확인했다. 로그·스크립트는 지정 cache에 보존했다.
- 기본 다음 시작 회수는 시작하지 않는 동안 자원 누적을 막지 못한다. watcher도 함께 죽으면 정상 정지를 보장할 수 없다. 기존 소유 기록이 없는 잔존 DB를 무조건 안전하게 자동 kill한다는 약속도 하지 않는다.
- 모든 근거는 설계 참고다. 실제 upstream 코드 복사나 새 바이너리 배포를 선택하면 해당 SHA의 LICENSE/header/NOTICE/의존성 및 AGENTS의 출처·THIRD_PARTY_NOTICES 규칙을 구현 단계에서 다시 적용해야 한다. 본문 미독 라이선스를 코드 재사용 가능 판정으로 사용하지 않았다.
- 허용 경로의 문서·조사 기록만 썼다. 제품 코드·테스트·설정·patches·git 조작·외부 댓글 게시를 하지 않았다. 제품 검사 전체를 실행한 것으로 보고하지 않는다.

## 추가 조사: 내장 Postgres의 port 고르기 (2026-11-10)

CI에서 시작 중 종료 신호 시험이 한 번 실패한 원인을 찾으며 조사했다. 빈 port 번호를 받아 두고 닫은 뒤 약 2초 뒤(initdb 후) Postgres가 그 번호를 잡는 사이, 다른 프로세스가 같은 번호를 먼저 잡을 수 있었다. 이때 Postgres는 `could not bind IPv4 address "127.0.0.1": Address already in use`로 끝났다. 듣는 주소를 `localhost`로 두면, localhost가 `::1`도 가리키는 컴퓨터에서는 `::1`에서만 듣고 성공으로 켜졌다. 그러면 127.0.0.1로 하는 접속이 그 번호를 잡은 다른 프로그램으로 갔다. 두 경우 모두 Linux에서 재현했다.

| 선례 | port를 정하는 방법 | 출처 |
| --- | --- | --- |
| PostgreSQL TAP 시험(`PostgreSQL::Test::Cluster`) | Windows가 아니면 TCP를 끄고(`listen_addresses = ''`) 사용자 전용 임시 폴더의 Unix socket을 쓴다. TCP 모드는 port 예약 파일을 쓴다. `start`는 다시 시도하지 않는다 | [Cluster.pm](https://github.com/postgres/postgres/blob/master/src/test/perl/PostgreSQL/Test/Cluster.pm) `init`·`start` |
| `pg_regress` 임시 instance | `listen_addresses`를 비우고 `-k <0700 임시 폴더>`로 Unix socket만 쓴다. Windows는 기본으로 Unix socket을 쓰지 않는다 | [pg_regress.c](https://github.com/postgres/postgres/blob/master/src/test/regress/pg_regress.c) `make_temp_sockdir`·`remove_temp` |
| zonky(Java)·fergusstrange(Go)·testing.postgresql(Python) | 우리와 같이 빈 번호를 받고 닫는다. 충돌을 다루지 않는다(Gemini 조사, 원문 미확인) | 각 저장소 `detectPort`·`freePort`·`get_unused_port` |
| Testcontainers | Docker가 host port를 잡은 채로 두고 번호를 알려 준다 | Testcontainers 문서(Gemini 조사, 원문 미확인) |

- Postgres는 `port = 0`을 받지 않는다(범위 1..65535). OS에 고르게 맡길 수 없다.
- Unix socket만 쓰는 방식은 충돌을 없애지만 Windows에서는 쓸 수 없다. node-postgres는 Windows에서 socket 경로 접속을 지원하지 않는다(Node `net`의 경로는 Windows에서 named pipe다).
- 결정: 모든 OS에서 같은 경로를 쓴다. Postgres는 접속 주소인 `127.0.0.1`에서만 듣는다. 정한 port가 없으면 후보 번호로 켜고, Postgres가 그 번호를 잡지 못해 끝났을 때만 다른 후보로 다시 켠다(최대 5번). 번호는 Postgres가 실제로 잡았을 때 정해지므로 "받아 둔 번호를 남이 먼저 잡는" 틈이 없다. 정한 port(제품 기본 54329)를 남이 잡았으면 다시 하지 않고 실패를 알린다.
