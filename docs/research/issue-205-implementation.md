# #205 구현 기록 — Windows 실행 시도의 묶음(Job Object) 정리

기준: `main` `2715292`, 작업 브랜치 `feat/205-windows-job-object`. 요구는 [#205](https://github.com/babo-jeonguk/BaboJUBot/issues/205) 본문, 조사는 [issue-205-references.md](issue-205-references.md)와 그 receipt 댓글이다. 현재 동작은 [프로바이더 안내의 Windows 묶음](../providers.md#windows-묶음)이 기준이다.

## 사용자 결정 (2026-11-17)

조사가 사용자 결정으로 남긴 두 가지를 구현 전에 물었다.

| 질문 | 결정 | 반영 |
| --- | --- | --- |
| 서버 강제 종료 때의 짧은 틈(실행기가 프로그램을 만든 뒤 묶음에 넣기 전, 서버가 실행기를 만든 뒤 Node.js가 자기 묶음에 넣기 전) | 만들 때 바로 넣기. 서버 감시는 두지 않는다 | 실행기가 `PROC_THREAD_ATTRIBUTE_JOB_LIST`로 프로그램을 묶음 안에서 만든다. 실패하면 명세대로 멈춘 채 만들어 넣는다. 서버 쪽 틈은 [한계](../providers.md#windows-묶음)로 적었다 |
| 기본 설치 Windows 10·11의 컴파일 확인 | windows-latest CI만 확인하고 미검증으로 남긴다 | 아래 검증 표 |

조사의 열린 결정 2(이미 프로그램을 띄웠을 수 있는 실패의 대체 실행)는 제품 정책을 바꾸지 않는 구현 판단으로 정했다. 실행기 안에서 묶음을 만들거나 넣지 못하면 실행기가 같은 프로그램을 묶음 없이 재개하고 경고 상태 줄을 쓴다(Codex 선례). 서버가 프로그램을 다시 띄우는 것은 실행기 자체를 띄우지 못해(`pid` 없음) 프로그램이 시작하지 않았음이 확실할 때뿐이다.

## 원문으로 다시 확인한 근거

| 근거 | 확인한 곳 | 적용 | 배제·차이 |
| --- | --- | --- | --- |
| libuv는 숨긴 자식에 stdio를 하나도 상속하지 않으면 `CREATE_NO_WINDOW`, 그리고 `SW_HIDE`를 쓴다 | [libuv `process.c` L1094–L1113](https://github.com/libuv/libuv/blob/840404ce8ba7cc0204be52389a6cfff9f2c90fb6/src/win/process.c#L1094-L1113) | 실행기는 모든 stdio가 pipe인 숨긴 자식이므로 `CREATE_NO_WINDOW`가 붙는다. 실행기도 프로그램을 같은 두 값으로 띄워 콘솔 창이 새로 생기지 않게 한다 | libuv의 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`(동시 spawn의 handle 누출 방지)는 쓰지 않았다. 실행기는 stdio 셋 말고 상속 가능한 handle을 만들지 않는다 |
| libuv의 인수 감싸기(`quote_cmd_arg`)와 verbatim이면 그대로 잇기(`make_program_args`) | [L448–L519](https://github.com/libuv/libuv/blob/840404ce8ba7cc0204be52389a6cfff9f2c90fb6/src/win/process.c#L448-L519), [L521–L590](https://github.com/libuv/libuv/blob/840404ce8ba7cc0204be52389a6cfff9f2c90fb6/src/win/process.c#L521-L590) | `quoteWindowsArgument`가 같은 규칙(빈 값 `""`, 공백·탭·따옴표가 없으면 그대로, 따옴표·역슬래시가 없으면 감싸기, 아니면 따옴표 앞·끝의 역슬래시 두 배)으로 명령줄을 만든다. verbatim이면 잇기만 한다 | 코드는 복사하지 않고 같은 규칙을 새로 썼다 |
| libuv의 전역 묶음은 KILL·BREAKAWAY_OK·SILENT_BREAKAWAY_OK이고, non-detached 자식만 생성 뒤 넣으며 ACCESS_DENIED는 무시한다. `detached`도 `CREATE_BREAKAWAY_FROM_JOB`를 쓰지 않는다 | [L69–L121](https://github.com/libuv/libuv/blob/840404ce8ba7cc0204be52389a6cfff9f2c90fb6/src/win/process.c#L69-L121), [L1115–L1167](https://github.com/libuv/libuv/blob/840404ce8ba7cc0204be52389a6cfff9f2c90fb6/src/win/process.c#L1115-L1167) | 실행기를 Node.js의 직접 non-detached 자식으로 둔다. 실행기가 만든 프로그램은 SILENT_BREAKAWAY로 libuv 묶음 밖에서 시작해 실행기의 묶음에 들어간다. 프로그램이 Node.js여서 자기 묶음을 만들면 실행기 묶음 안에 중첩된다. 프로그램의 `detached` 자식도 실행기 묶음 안이다 | 서버 생성→libuv 배정 사이의 틈은 그대로다(사용자 결정) |
| Codex `create_without_breakaway`는 KILL만 두고, 배정에 실패하면 같은 프로세스를 재개하고 경고한다. 재개 실패면 끝낸다 | [Codex `job.rs` L70–L95·L142–L195](https://github.com/openai/codex/blob/e5839cbc591df02408d5009e287887c7d57a9167/codex-rs/utils/pty/src/win/job.rs#L70-L195) | 묶음 설정(KILL만, breakaway 불허)과 배정 실패·재개 실패 처리 | Codex는 `NtResumeProcess`, 실행기는 주 스레드 `ResumeThread` |
| cross-spawn은 `.cmd`를 `cmd /d /s /c "<escape된 명령>"`과 `windowsVerbatimArguments`로 풀고, `file`에 찾은 경로를 둔다 | 설치본 `cross-spawn@7.0.6` `lib/parse.js` `parseNonShell`, `lib/util/resolveCommand.js` | `_parse`로 풀어 낸 명령·인수·verbatim을 그대로 쓰고, 실제로 띄울 프로그램은 풀어 낸 명령을 다시 `_parse`해 얻은 경로다 | `_parse`는 밑줄 붙은 공개 export다. 판은 lockfile이 고정한다 |
| Offstage는 사용자 폴더에 소스 해시·고유 임시 빌드·trial·rename 재시도로 실행기를 만든다 | 조사 E02·E03(고정 SHA `d256c97`) | 준비 절차의 모양 | 원문 재독은 하지 않았다. 컴파일에 시한(120초)을 두고, 같은 해시 파일이 있어도 시작마다 시험 실행한다 |
| `PROC_THREAD_ATTRIBUTE_JOB_LIST`는 Windows 10부터 프로세스를 만들 때 묶음에 넣는다 | Microsoft `UpdateProcThreadAttribute` 문서 | 첫 시도 | 문서 원문은 이번에 다시 열지 않았다. 실패하면 멈춘 채 만들어 넣는 경로로 돌아가므로 동작 판단은 CI 시험이 한다 |

## 결정과 구현

- **실행기**: `packages/runtime/src/providers/job-object-launcher.cs`(C# 5). 명령줄은 `<실행기> <프로그램 경로 base64> <프로그램 명령줄 그대로>`다. 명령줄을 다시 감싸지 않으려고 실행기는 자기 명령줄 원문(`GetCommandLineW`)에서 나머지를 그대로 떼어 `CreateProcessW`에 넘긴다. 프로그램이 돌기 전에 표준 오류에 상태 줄(`[babojubot-job-object] ok`·`warning: …`·`failed: …`)을 하나 쓴다. 프로그램이 끝나면 `TerminateJobObject` 뒤 묶음이 빌 때까지 최대 10초 기다리고 그 종료 코드로 끝난다.
- **준비**: `job-object.ts` `prepareJobObjectLauncher(dataDir)`를 서버 시작(`app.ts`, 복구 직후)에서 기다린다. Windows가 아니면 아무것도 하지 않는다. 결과는 모듈 상태로 두고 `startProcess`가 읽는다. 준비를 부르지 않은 프로세스(대부분의 시험)는 지금처럼 묶음 없이 돌고 경고하지 않는다.
- **startProcess**: 컨테이너가 아니고 준비된 실행기가 있으면 실행기로 띄운다. 대표 PID·실행 기록·취소 순서·`finish`는 그대로이며 대표가 실행기일 뿐이다. 상태 줄은 오류 출력 끝부분에서 떼어 낸다.
- **바꾸지 않은 것**: Linux·macOS 경로, 짧은 확인 실행(`runProbe`), 공개 API·DB schema·계약.

## 검증 경계와 결과

결과는 아래 [CI 결과](#ci-결과)에 적는다.

| 경계 | 검사 |
| --- | --- |
| 첫 단계: 기본 .NET Framework C# 컴파일러로 만들고 해가 없는 실행 | `job-object.test.ts` `beforeAll`(준비 시간·결과를 로그에 남김) |
| 출력을 쥔 남은 자식, 마지막 출력(20만 자 한 줄)·종료 코드 3 | 같은 파일 첫 시험 |
| 출력을 쥐지 않은 남은 자식, `detached` 자식 | 둘째·셋째 시험 |
| 취소(입력 닫기 → 트리 종료) | 넷째 시험 |
| 다른 실행 시도의 자식과 시험이 띄운 무관한 프로그램은 산다 | 다섯째 시험 |
| `.cmd` 시작 파일(공백·한글 경로, 따옴표·메타문자·`%PATH%`·빈 인수)과 경로 검색 프로그램의 인수 | cross-spawn 직접 실행 결과와 비교 |
| 서버 강제 종료 연쇄 | 합성 서버(`prepareJobObjectLauncher`+`startProcess`)를 `TerminateProcess`로 끝낸 뒤 프로그램과 그 자식이 꺼짐 |
| 실행기를 띄우지 못함(지워짐), 준비 실패(컴파일러 없음) | 지금처럼 돌고 경고 |
| Linux·macOS 기존 검사 | CI `tests / runtime`·`runtime on macos-latest` |

## CI 결과

## 미검증

- 기본 설치 Windows 10·11, Windows ARM64, 일반 권한 Windows, 실제 백신(Defender 실시간 보호의 다른 정책·Smart App Control·타사 백신). 늦은 격리로 실행기가 사라지면 그 실행 시도는 경고하고 묶음 없이 돈다.
- 서버가 실행기를 만든 직후 Node.js가 넣기 전의 수 마이크로초 틈(사용자 결정으로 남김). 실행기가 프로그램을 만든 뒤 묶음에 넣기 전의 틈은 `JOB_LIST`가 성공하는 한 없다. `JOB_LIST`가 실패하는 환경은 CI에서 재현하지 않았다.
- 실제 에이전트 프로그램·실제 모델.
