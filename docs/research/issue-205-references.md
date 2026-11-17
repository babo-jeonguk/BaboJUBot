# issue-205 레퍼런스 조사: Windows 실행 시도의 후손 정리

조사일: 2026-11-17. 대상: [#205](https://github.com/babo-jeonguk/BaboJUBot/issues/205). 로컬 C# 묶음 실행기의 배포·실패와 OS 소유권을 조사한다. 구현 전 권고이며 확정 계약이나 구현 결과가 아니다. 현재 동작은 [프로바이더 안내](../providers.md), 책임은 [전체 구조](../architecture.md)를 따른다.

## Brief

- 구현할 문제: Windows에서 프로바이더가 먼저 끝나도 실행 시도가 남긴 프로그램을 회수하고, 서버 강제 종료에서도 회수 연결을 유지한다.
- 동종 문제: 부모 사망 뒤에도 유효한 OS 자원 소유권과, 사용자 컴퓨터에서 처음 만드는 작은 보조 실행기의 배포.
- 고정된 결정: 실행 시도별 Job Object, `KILL_ON_JOB_CLOSE`, suspended→assign→resume, stdio 직접 상속, helper를 대표 PID로 기록, 기본 Framework csc로 첫사용 컴파일·소스 해시 캐시, 준비/시작 실패 시 경고와 기존 실행. Linux/macOS·짧은 확인 실행·공개 계약·DB schema는 범위 밖이다.
- #205 parent는 없음(API 404). blocker #145는 종료됐고 [PR #200](https://github.com/babo-jeonguk/BaboJUBot/pull/200)이 선행이다. 명세 기준 e0d0e34와 현재 HEAD cd1099104f3833703166e0e7bcf9b66187053a02의 process.ts는 다르므로 현재 `finish`·1초 출력 대기·대표 종료 뒤 신호 중단을 다시 읽었다.

| ID | 조사 질문 | 출처 | 전략 |
| --- | --- | --- | --- |
| Q1 | 기본 Windows 10·11/CI의 csc 가용성, 처음 컴파일하는 선례·실패·대안은? | #205 Further Notes 1, Implementation Decisions 컴파일 gate | 개발 도구 탐색 + Source Recon + 공개 CI 로그 |
| Q2 | 새 로컬 exe가 AV에 막히는 사례·빈도·대응은? | Further Notes 2, 실패 fallback | 실패 보고 + 공식 정책 + Source Recon |
| Q3 | libuv job과 helper/run job, Node 프로바이더의 job이 어떻게 공존하는가? | Further Notes 3, suspended·stdio·breakaway 결정 | OS 계약 + Source Recon |
| Q4 | 서버 강제 종료→helper→후손 정리가 실제 성립하는가? | Further Notes 4, User Stories 2·4·12·13 | Source Recon + runtime/failure; Windows 실행은 미확인 |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
| --- | --- | --- |
| [#145 조사](issue-145-references.md) | 정리 하나·출력 대기·Windows 잔존 한계 | 본문·댓글·현재 process.ts 재독. 과거 합성 실행을 이번 실행으로 표시하지 않음 |
| [#189 E01·E05](issue-189-references.md#E01) | Windows kill과 정상 종료 요청의 차이 | Node/Playwright 정책 배경만 재사용. 이번 권고는 새 libuv 원문으로 확인; IPC 도입은 범위 밖 |
| [서버 종료 조사 P03](graceful-shutdown-references.md#P03) | 정상 정리와 강제 종료 회수의 분리 | DB 설계 권고는 재사용하지 않음. 실행 시도와 내장 DB의 수명 분리만 유지 |

## 레퍼런스

후보는 관점별 31행(중복 포함: 컴파일 12, 보안 10, OS 수명 8, cross-spawn 1)을 등록했다. 핵심 대상으로 좁힌 결과는 아래와 같다. 설계 참고만 권고하며 코드 복사는 권고하지 않는다.

관점별 saturation은 조사 범위 내의 판단이다. 컴파일 관점은 공식 설치/이미지→유사 helper→스크립트 엔진·추가 미디어 도구까지 3라운드에서 마지막 후보들이 캐시·경로 탐색·SDK 대안을 반복했다. 보안 관점은 AV 오류 검색→도구별 실패 이슈→Offstage·SAC·대응 문서까지 4라운드에서 생성 차단·실행 차단·파일 잠금·늦은 격리로 수렴했고 분모 통계는 못 찾았다. OS 관점은 이슈의 선례→라이브러리·공식 nested 계약→종료/이탈 실패 검색에서 동일한 handle 소유·조건부 배정 패턴이 반복됐다. 완전히 같은 libuv→helper→job 강제 종료를 이번에 직접 재현한 레퍼런스는 없다.

| 레퍼런스 | 분류 | 고정 버전·SHA | 라이선스 | 깊이·선정 이유 | 실행 경로 |
| --- | --- | --- | --- | --- | --- |
| Offstage | OSS helper | d256c979c01846705c0e244be11f94a762e3cba6 | MIT | 소스·공개 CI 보고; 첫사용 csc·캐시·Job이 가장 밀접. 신생 v0.1.1 | Windows `node offstage.cjs --check`, selftest; 미실행 |
| runner-images | CI 이미지 | f40a752b24f9f5c2380d5bf53f91353ca122f7e7 | MIT | 문서; CI 가용성 보조 | Windows CI; 이번 job 실행 없음 |
| Hermes | 데스크톱 helper | 39faafb61688282a372ff2d59191581588e9a003 | MIT | 소스; Node→csc 및 다른 실패 정책 | Windows build, 앱 의존; 미실행 |
| Unsloth | 설치 도구 | 95feb6979e79ca431a232071e980a8c0bc7c8b92 | Apache-2.0 | 소스·실패 보고; 컴파일 차단 반례 | Windows 설치 스크립트; 설치 변경이 커서 미실행 |
| libuv | 프로세스 엔진 | v1.53.0, 840404ce8ba7cc0204be52389a6cfff9f2c90fb6 | MIT | 소스; 서버 사망과 helper 배정의 실제 경로 | Windows Node 합성 프로그램; 미실행 |
| Codex | 실행 라이브러리 | e5839cbc591df02408d5009e287887c7d57a9167 | Apache-2.0 | 소스; suspended·배정 실패 후 호환 실행 | Windows Rust 합성 실행; 미실행 |
| Cargo | 실행 도구 | f93c676e3e7ab1aee08dc95d869700f6b99a1a20 | MIT/Apache-2.0 | 소스; 정상 종료 정책의 반례 | Windows Cargo 합성 build; 미실행 |
| command-group | 프로세스 라이브러리 | bf3f6c94a84f7f5892e640d95339317c9268962d | MIT/Apache-2.0 | 소스 후보; suspended 배정, kill-on-drop 선택형 | Windows Rust tests; 읽기만 함 |
| cross-spawn | 명령 해석 | v7.0.6, 77cd97f3ca7b62c904a63a698fc4a79bf41977d0 | MIT | 소스; `.cmd`와 인수 처리 | Windows Node; 미실행 |
| MicrosoftDocs/win32 | OS 명세 | bc82a65f74ef2c4f2f44a3d7db5f7cfebfdc3583 | 문서 참조 | 문서; job 계층·마지막 handle | 없음(명세) |

## 근거

수준은 실행 확인 0, 소스 확인 11, 문서 주장 7이다. 공개 CI 로그와 사용자 장애 보고는 이번 직접 실행이 아니다. 각 소스의 SHA·확인일은 위 표와 조사일을 따른다.

| ID | 관찰 | 출처 | 수준 |
| --- | --- | --- | --- |
| <a id="E01"></a>E01 | Windows 10·11은 Framework 4.x를 포함한다. csc는 보통 Windows의 Framework 폴더에 있지만 정확한 위치는 구성에 따라 다르다. 런타임 포함만으로 모든 기본 설치의 컴파일 성공을 확정할 수 없다. | [설치 문서](https://learn.microsoft.com/en-us/dotnet/framework/install/on-windows-and-server), [compiler options](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-options/) | 문서 주장 |
| <a id="E02"></a>E02 | Offstage `buildHelper`는 C# 소스 해시 캐시, 사용자 폴더, 고유 임시 빌드, Framework64→Framework의 v4.0.30319 csc 탐색을 구현한다. | [`buildHelper`·`compiler`](https://github.com/LippInc/offstage-windows/blob/d256c979c01846705c0e244be11f94a762e3cba6/offstage.cjs#L851-L927) | 소스 확인 |
| <a id="E03"></a>E03 | 생성 후 무해한 trial에 30초 제한, rename 잠금 오류에 최대 5회 재시도. 캐시 hit는 존재만 확인하고 컴파일 자체에는 timeout이 없다. 그대로 복사할 계약은 아니다. | [`buildHelper`](https://github.com/LippInc/offstage-windows/blob/d256c979c01846705c0e244be11f94a762e3cba6/offstage.cjs#L866-L918) | 소스 확인 |
| <a id="E04"></a>E04 | Offstage의 2026-10-17 Windows CI 로그는 Windows Server 2025 이미지에서 helper 생성 성공을 보고한다. 기본 Windows 클라이언트의 보장은 아니다. | [공개 CI job](https://github.com/LippInc/offstage-windows/actions/runs/39064176078/job/117488203993) | 문서 주장 |
| <a id="E05"></a>E05 | 조사한 runner 이미지에는 Framework 4.8/4.8.1이 명시돼 있다. windows-latest의 이미지·도구는 변할 수 있다. | [이미지 목록](https://github.com/actions/runner-images/blob/f40a752b24f9f5c2380d5bf53f91353ca122f7e7/images/windows/Windows2025-VS2026-Readme.md#L440-L451) | 문서 주장 |
| <a id="E06"></a>E06 | Unsloth는 Windows 11/Bitdefender가 PowerShell→csc→임시 DLL 경로를 차단한 사례를 보고하고 컴파일 제거로 대응했다. 관리자 실행도 해결하지 못했다고 보고한다. 제품 차단율이나 Defender의 빈도로 일반화할 수 없다. | [PR #10540](https://github.com/unslothai/unsloth/pull/10540) | 문서 주장 |
| <a id="E07"></a>E07 | Unsloth는 `Reflection.Emit`·`DefinePInvokeMethod`로 native 선언을 메모리에 만든다. 독립 helper exe를 제공하는 방식은 아니다. | [`New-StudioEmittedNativeType`](https://github.com/unslothai/unsloth/blob/95feb6979e79ca431a232071e980a8c0bc7c8b92/install.ps1#L1091-L1135) | 소스 확인 |
| <a id="E08"></a>E08 | Hermes도 inbox csc로 helper exe를 만든다. timeout 120초, 임시 출력 rename, Windows 빌드 오류는 재던지며 Linux만 경고한다. #205와 실패 정책이 다르다. | [compiler 탐색](https://github.com/NousResearch/hermes-agent/blob/39faafb61688282a372ff2d59191581588e9a003/apps/desktop/scripts/build-hud-modifier-monitor.mjs#L12-L18), [빌드·실패](https://github.com/NousResearch/hermes-agent/blob/39faafb61688282a372ff2d59191581588e9a003/apps/desktop/scripts/build-hud-modifier-monitor.mjs#L70-L115) | 소스 확인 |
| <a id="E09"></a>E09 | Smart App Control enforcing은 신뢰되지 않고 서명도 없는 코드를 차단할 수 있다. 다운로드 평판 경고와 로컬 실행 정책 차단을 구별해야 한다. | [SAC 개요](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview), [SmartScreen·SAC 구분](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation) | 문서 주장 |
| <a id="E10"></a>E10 | libuv global job handle은 비상속이며 KILL·SILENT_BREAKAWAY·BREAKAWAY를 설정한다. 명시 배정한 자식을 대상으로 하고 그 자식의 후손은 자동으로 빠져나가게 하려는 코드다. | [`uv__init_global_job_handle`](https://github.com/libuv/libuv/blob/840404ce8ba7cc0204be52389a6cfff9f2c90fb6/src/win/process.c#L69-L121) | 소스 확인 |
| <a id="E11"></a>E11 | non-detached 자식 생성 뒤 global job에 배정한다. 배정의 ACCESS_DENIED는 무시하고 계속한다. 이 경로는 생성·배정의 원자성을 제공하지 않는다. | [`uv_spawn`](https://github.com/libuv/libuv/blob/840404ce8ba7cc0204be52389a6cfff9f2c90fb6/src/win/process.c#L1117-L1175) | 소스 확인 |
| <a id="E12"></a>E12 | Windows 8 이후 중첩 job은 유효한 부분집합 계층·UI 제한 등 조건을 따른다. immediate job이 breakaway를 막으면 상위가 허용해도 후손은 남는다. | [`Nested Jobs`](https://github.com/MicrosoftDocs/win32/blob/bc82a65f74ef2c4f2f44a3d7db5f7cfebfdc3583/desktop-src/ProcThread/nested-jobs.md#L25-L43) | 문서 주장 |
| <a id="E13"></a>E13 | Codex `create_without_breakaway`와 suspended→assign→resume이 선례다. 배정 실패에도 같은 프로세스를 재개하고 warn·None을 반환한다. 재개 실패 시 TerminateProcess한다. | [Job 생성](https://github.com/openai/codex/blob/e5839cbc591df02408d5009e287887c7d57a9167/codex-rs/utils/pty/src/win/job.rs#L70-L95), [`assign_and_resume_process`](https://github.com/openai/codex/blob/e5839cbc591df02408d5009e287887c7d57a9167/codex-rs/utils/pty/src/win/job.rs#L142-L195) | 소스 확인 |
| <a id="E14"></a>E14 | Cargo는 KILL을 설정하지만 정상 `Drop for Setup`에서는 해제한다. 정상 종료 뒤 잔존 프로그램 회수의 직접 선례로 쓰면 틀린다. | [setup·Drop](https://github.com/rust-lang/cargo/blob/f93c676e3e7ab1aee08dc95d869700f6b99a1a20/src/util/job.rs#L84-L160) | 소스 확인 |
| <a id="E15"></a>E15 | Offstage도 suspended 자식 배정 실패 시 경고 후 재개한다. cmd 경유 때문에 libuv job에서 벗어나는 stand-in 경로에는 별도 parent-handle 감시를 둔다. 직접 helper exe spawn과 구별해야 한다. | [배정·감시 호출](https://github.com/LippInc/offstage-windows/blob/d256c979c01846705c0e244be11f94a762e3cba6/offstage.cjs#L173-L202), [`WatchParent`](https://github.com/LippInc/offstage-windows/blob/d256c979c01846705c0e244be11f94a762e3cba6/offstage.cjs#L392-L416) | 소스 확인 |
| <a id="E16"></a>E16 | cross-spawn은 `.cmd`를 cmd `/d /s /c`로 풀면서 escaping과 `windowsVerbatimArguments=true`를 함께 정한다. command/args만 가져와 다시 일반 quoting하면 같은 계약이 아니다. | [`parseNonShell`](https://github.com/moxystudio/node-cross-spawn/blob/77cd97f3ca7b62c904a63a698fc4a79bf41977d0/lib/parse.js#L27-L62) | 소스 확인 |
| <a id="E17"></a>E17 | NULL security attributes로 만든 job handle은 비상속이다. KILL은 마지막 job handle이 닫힐 때 작동한다. stdio 상속과 job handle 상속은 다른 문제다. | [CreateJobObjectW](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw), [stdio 상속](https://learn.microsoft.com/en-us/windows/win32/procthread/inheritance) | 문서 주장 |
| <a id="E18"></a>E18 | 현재 startProcess는 Windows detached=false, pipe stdio, 대표 종료 뒤 취소 신호 중단, close 또는 1초 뒤 단일 finish, queue 처리 후 done을 사용한다. | [현재 조사 HEAD의 startProcess](https://github.com/babo-jeonguk/BaboJUBot/blob/cd1099104f3833703166e0e7bcf9b66187053a02/packages/runtime/src/providers/process.ts#L160-L405) | 소스 확인 |

### 소유권 해석과 명세의 조건

E10–E12·E17에서의 **추론**: helper가 libuv job에 성공적으로 배정돼 있어도 helper가 만든 agent는 SILENT_BREAKAWAY로 빠져나온 뒤 별도 run job에 명시 배정되는 것이 기본 예상이다. 따라서 프로세스 부모 계층이 곧 Job의 중첩 계층은 아니다. 이후 Node 프로바이더가 자체 libuv job을 만들면 run job 안에 job이 중첩될 수 있다. run job은 breakaway를 허용하지 않아야 한다.

서버 종료→서버가 쥔 global handle 닫힘→배정된 helper 종료→helper만 쥔 run-job handle 닫힘→agent·후손 종료라는 연쇄는 **조건부 추론**이다. E11의 배정 실패 묵인, helper를 cmd 뒤에 놓는 구성(E15), handle 유출(E17), 생성/배정 사이 사망이 보장을 약화시킨다. helper 자체는 run job에 넣지 않고 그 handle의 유일 소유자로 두는 권고다.

특히 `CREATE_SUSPENDED`는 agent가 배정 전에 손자를 만드는 것을 막지만, helper가 CreateProcess 성공 후 Assign 전에 죽을 때 남을 수 있는 suspended agent까지 원자적으로 회수하지 않는다. libuv의 helper 생성→배정 사이에도 창이 있다(E11·E13에서의 추론). 이는 #205의 “서버 강제 종료에도 모두 정리”를 무조건 보장한다고 읽을 경우 상충한다. 구현하지 않고 아래 열린 결정으로 남긴다.

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
| --- | --- | --- | --- | --- | --- |
| P01 | inbox 컴파일 + 소스 해시 캐시 + 고유 임시 파일 공개 | E01–E05·E08 | Hermes는 빌드 실패를 전파, Offstage는 호환 실행 | 추가 설치 없이 검토 가능한 소스 배포 | 컴파일러 부재·구문 버전·동시 빌드·정책 차단 |
| P02 | 무해한 trial·유한 재시도·단계별 fallback | E03·E06·E09·E13 | 배정 실패는 같은 자식 재개 가능 | 최초 실패가 연구를 막는 범위를 줄임 | 늦은 격리·시작 여부 불명 실패 후 재실행 중복 |
| P03 | 비상속 소유 handle + suspended 배정 | E10–E13·E17 | libuv outer는 이탈 허용, run job은 불허 | 정상/비정상 owner 종료를 OS 회수에 연결 | 배정 오류·handle 누출·초기 생성/배정 창 |
| P04 | 정상 종료의 후손 보존 여부를 명시 | E14·E15 | Cargo 정상 종료는 보존; #205는 회수 | 제품 정책 혼입 방지 | 유명 선례를 그대로 적용하면 요구 위반 |
| P05 | 명령 해석·stdio·최종 출력 계약을 보존 | E16–E18 | helper는 출력 중계 없이 handle 상속 | 마지막 응답·사용량·종료 코드 유지 | cmd quoting 이중 적용·조기 pipe 닫기 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
| --- | --- | --- | --- | --- | --- |
| D01 | 변형 채택 | 기본 csc 첫사용 컴파일·해시 캐시. C#5 수준 구문, 컴파일/시험 실행 시한, 고유 임시 파일→공개, 기존 exe 존재만 믿지 않는 실패 처리 | P01·P02 | 거의 동일한 선례·upstream CI가 있으나 기본 OS 검증을 대신하지 못함 | Q1 |
| D02 | 채택 | 구현 첫 단계 Windows 10·11 기본 설치와 windows-latest에서 동일 소스 컴파일·무해 실행 확인 gate 유지. 실패하면 제품 구현 진행을 멈추고 보고 | E01·E04·E05 | 명세 그대로. CI 성공을 모든 클라이언트의 보장으로 확대하지 않음 | Q1 |
| D03 | 변형 채택 | 컴파일·helper 실행 거부를 기존 경로+서버 경고로 처리. 배정 실패 후에는 이미 만든 자식을 계속 쓸지 명시하고, 실제 시작 여부 불명 실패에 자동 재실행하지 않음 | P02·E13 | 명세의 호환 동작과 중복 실행 방지를 함께 검토해야 함 | Q1·Q2 |
| D04 | 변형 채택 | helper exe를 Node의 직접 non-detached 자식으로 두고 비상속·이름 없는 run-job handle을 단독 소유. stdio만 상속, no-breakaway, 배정 후 재개 | P03·P05 | cmd는 helper 밖이 아니라 helper 안에서 provider 실행용으로 사용. 외부 job/다른 실행 시도/DB를 run job에 넣지 않음 | Q3·Q4 |
| D05 | 보류 | 서버 강제 종료의 무조건 보장과 생성/배정 창의 허용 범위를 결정하고 Windows에서 연쇄를 검증 | E10–E13·E15·E17 | 현재 방식은 조건부. 더 강한 생성 시 job 연결·독립 부모 감시 등은 추가 조사/명세 변경 필요 | Q3·Q4 |
| D06 | 채택 | cross-spawn의 최종 명령·인수·verbatim 의미와 stdio·종료 코드·finish 경계를 보존 | P05 | helper 외부 포장 때 quoting을 다시 적용하지 않도록 실제 `.cmd` 대조 필요 | Q3·Q4 |
| D07 | 배제 | 별도 SDK/Roslyn 설치·사전빌드 바이너리 배포, Reflection.Emit만으로 exe 대체, Cargo 정상종료 플래그 해제 적용 | E07·E14·명세 | 추가 설치/배포는 명세 밖; 인프로세스 native 선언은 독립 owner를 대신하지 못함 | Q1–Q4 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
| --- | --- | --- |
| taskkill/부모 PID 재탐색만으로 정상 종료 뒤 후손 회수 | #205의 기존 경로 | 이미 선택된 Job Object 대안보다 약하고 명세가 배제함 |
| AV 차단율을 임의 추정하거나 trial 성공을 영구 보장으로 간주 | E03·E06·E09 | 분모 통계 없음; 생성 후 뒤늦은 격리 가능 |
| 기존 정책을 바꾸어 AV 보호를 끄거나 예외를 자동 등록 | 보안 차단의 편법 | #205의 기존 실행 fallback을 우선하며 보안 설정 변경은 범위 밖 |
| parent watcher를 바로 추가해 보장했다고 보고 | E15 | 직접 helper spawn과 다른 선례. 부모 신원·시작 창·감시 실패를 추가로 검토해야 함 |

## 구현 참고

권고는 D01–D04·D06을 출발점으로 삼되 D02 gate와 D05 미결을 해소하는 것이다. 수정 책임은 `packages/runtime`의 `startProcess` Windows 경로와 그 내부 helper 준비 경계이며, adapter·Control Plane·DB에 별도 프로세스 소유권을 만들지 않는다. 초기 연구 승인·최종 완료·조직 경계 강제는 현행 제품 코드에 유지한다. 이번 조사는 구현하거나 승인 정책을 바꾸지 않았다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
| --- | --- | --- |
| V01 | 기본 Windows 10·11/CI, 추가 개발도구 없는 계정 → inbox csc로 같은 helper 소스 빌드·trial → 성공 또는 정확한 실패 진단. OS/build/arch/csc 경로 기록 | D01·D02 |
| V02 | 같은/다른 소스·동시 첫 실행·잠긴/사라진 exe·컴파일 hang → 유한 준비·캐시 재사용/갱신·경고·기존 실행. 실제 provider 중복 시작 없음 | D01·D03 |
| V03 | 합성 provider가 후손 생성 후 먼저 종료, stdout을 쥔/안 쥔 두 경우 → done 뒤 후손 사망, 최종 프레임·원 종료 코드 전달 | D04·D06 |
| V04 | 입력 닫기·취소·강제 helper 종료 → 정해진 취소 순서와 후손 정리; 서로 다른 실행 시도와 내장 DB 역할의 음성 대조 프로세스 생존 | D04 |
| V05 | 합성 Node 서버→직접 helper→Node provider→후손 → 서버 hard kill 뒤 모두 사망; 자체 libuv job·detached 후손·외부 job 환경도 구분 | D04·D05 |
| V06 | 생성/배정 중 서버 또는 helper 사망 → 남은 suspended 프로세스 여부 확인. 재현 못하면 미검증 창을 명시하고 무조건 보장으로 보고하지 않음 | D05 |
| V07 | 공백·한글 경로, `.exe`/npm `.cmd`, 따옴표·공백·메타문자 인수, 큰 마지막 출력 → 기존 실행과 argv/stdout/stderr/exit 동일 | D06 |
| V08 | helper 준비/생성/배정 실패 전후 → 운영 경고 한 번, 프로토콜 출력 오염 없음, lease/PID/시작시각은 실제 대표 프로세스와 일치. Linux/macOS 기존 검사는 유지 | D03·D06 |

| 열린 결정 | owner | 선택지와 근거 |
| --- | --- | --- |
| 서버 사망 보장의 초기화 창·outer 배정 실패 | 사용자 / #205 | (1) 조건·미검증 창을 명세에 명시하고 현재 설계 검증, (2) 생성 시 job 연결/명시 부모 감시를 추가 조사해 더 강한 수명 계약으로 명세 보완. E11·E13·E15. 이번에 어느 쪽도 확정하지 않음 |
| 이미 provider가 시작했을 수 있는 helper 실패의 fallback | #205, 제품 정책 변경은 사용자 | (1) 배정 실패는 같은 자식 재개+경고, (2) 시작 전 실패를 확인하는 내부 통로 후에만 기존 실행으로 전환. 모호한 사망을 새 provider 실행으로 덮지 않음. E13·E15 |
| Windows 기본 설치 확인 가능 환경 | #205 구현 담당 | V01을 첫 gate로 수행. 현 Linux/공개 CI 자료만으로 통과 처리하지 않음 |

## 한계와 미확인

- 직접 Windows 실행 0건. Linux aarch64이며 wine/csc/dotnet/pwsh를 찾지 못했다. 따라서 Windows 10·11 기본 설치·ARM64, 실제 Defender/SAC·다른 AV, 중첩 job·강제 종료 연쇄·마지막 출력은 미확인이다. 제품 테스트나 실제 모델·프로바이더·로그인 실행도 하지 않았다.
- 공개 CI 성공은 Offstage의 특정 이미지/커밋 보고다. 현재 BaboJUBot나 모든 windows-latest 이미지의 실행 결과가 아니다. framework 포함 문서도 csc와 보안정책의 전체 보장이 아니다.
- Unsloth의 차단은 upstream 장애 보고, Hermes helper 소실 보고는 AV 원인 미확정이다. AV 빈도/점유율별 성공률을 계산할 공개 분모는 찾지 못했다. 동적으로 변하는 정책·이슈·runner 이미지는 구현 착수 시 재확인해야 한다.
- Codex/Cargo는 이슈가 지정한 SHA를 직접 재독했다. 최신 HEAD와 동일하다고 주장하지 않는다. 기존 조사 원문과 이번 HEAD에서 결정에 닿는 파일은 다시 읽었으며, 테스트를 읽은 사실을 실행 통과로 표시하지 않았다.
- 일부 공개 raw 요청은 429였고 GitHub API로 해당 핵심 파일을 다시 읽었다. worker가 접근하지 못한 Old New Thing 글(403)·pnpm 파일(404)은 결정 근거에서 제외했다.
- 심층 소스의 라이선스는 조사용으로 확인했으며 구현 코드 복사는 제안하지 않는다. 나중에 복사하면 고정 SHA의 header/NOTICE·의존성 재확인과 저장소 출처 고지 규칙을 적용해야 한다.
