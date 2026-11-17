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
- **준비**: `job-object.ts` `prepareJobObjectLauncher(dataDir)`를 서버 시작(`app.ts`, 복구 직후)에서 기다린다. 어떤 실패도 던지지 않고 이유와 경고로 돌려주며, 다른 소스로 만든 예전 실행기는 지운다. Windows가 아니면 아무것도 하지 않는다. 명세의 “처음 쓸 때”는 한 컴퓨터에서 처음 쓸 때로 읽었다. `startProcess`는 동기라 첫 실행 시도에서 만들면 그동안의 실행 시도가 묶음 없이 돌기 때문이다. 결과는 모듈 상태로 두고 `startProcess`가 읽는다. 준비를 부르지 않은 프로세스(대부분의 시험)는 지금처럼 묶음 없이 돌고 경고하지 않는다.
- **startProcess**: 컨테이너가 아니고 준비된 실행기가 있으며 cross-spawn이 프로그램을 찾으면 실행기로 띄운다. 찾지 못하면 지금처럼 cross-spawn이 띄워 시작 실패로 알린다. 대표 PID·실행 기록·취소 순서·`finish`는 그대로이며 대표가 실행기일 뿐이다. 상태 줄은 오류 출력 끝부분에서 떼어 낸다.
- **바꾸지 않은 것**: Linux·macOS 경로, 짧은 확인 실행(`runProbe`), 공개 API·DB schema·계약.

## 검증 경계와 결과

Windows 시험은 `packages/runtime/src/providers/job-object.test.ts`(Windows에서만 돈다)이며 모두 `startProcess`·`prepareJobObjectLauncher` 바깥에서 본다. 코드 최종 head `d9e7847`의 PR [CI run 44073402214](https://github.com/babo-jeonguk/BaboJUBot/actions/runs/44073402214) 필수 검사 모두 성공. `runtime on windows-latest`에서 이 파일 13건 통과(그 job 416 통과·154 건너뜀). 실행기 준비는 windows-latest에서 1.6–2.1초였다. 아래 표는 처음 12건에 외부 리뷰 1회차의 입력·오류 출력 시험을 더한 13건이다. 처음 12건은 head `596e07d`의 run 44050989175에서 처음 통과했다.

| 경계 | 검사 | 결과 |
| --- | --- | --- |
| 첫 단계: 기본 .NET Framework C# 컴파일러로 만들고 해가 없는 실행 | `beforeAll`(준비 시간·결과를 로그에 남김) | windows-latest에서 `Framework64` csc로 1.6–1.7초. 첫 run은 C# 확정 대입 오류(CS0170)로 컴파일 실패 → 경고·묶음 없이 도는 경로가 실제로 동작했고, 수정 뒤 성공 |
| 출력을 쥔 남은 자식, 마지막 출력(20만 자 한 줄)·종료 코드 3 | 첫 시험 | 통과 |
| 출력을 쥐지 않은 남은 자식, `detached` 자식 | 둘째·셋째 시험 | 통과 |
| 취소(입력 닫기 → 트리 종료) | 넷째 시험 | 통과 |
| 다른 실행 시도의 자식과 시험이 띄운 무관한 프로그램은 산다 | 다섯째 시험 | 통과 |
| `.cmd` 시작 파일(공백·한글 경로, 따옴표·메타문자·`%PATH%`·빈 인수)과 경로 검색 프로그램의 인수 | cross-spawn 직접 실행 결과와 비교 | 통과 |
| 서버 강제 종료 연쇄 | 합성 서버(`prepareJobObjectLauncher`+`startProcess`)를 `TerminateProcess`로 끝낸 뒤 프로그램과 그 자식이 10초 안에 꺼짐 | 통과 |
| 찾지 못한 프로그램은 시작 실패(`broken`) | 리뷰 P2 회귀 시험 | 통과 |
| 실행기를 띄우지 못함(지워짐), 준비 실패(컴파일러 없음), `tools` 폴더를 만들 수 없음(던지지 않음) | 지금처럼 돌고 경고 | 통과 |
| Linux·macOS 기존 검사 | `tests / runtime`·`runtime on macos-latest` | 통과 |

Windows E2E는 이 브랜치에서 두 번 서로 다른 모양으로 실패했고, 둘 다 실패한 job만 다시 돌리자 통과했다. 원인은 확인하지 못했다.

- head `9555620` run 44048971116, `e2e on windows-latest (2/2)`의 첫 시험(`provider-contract.spec.ts:48`): `/settings`의 API 요청 넷이 10초 동안 응답 없이 남아 live event ready를 받지 못했다(trace의 network 기록).
- head `d9e7847` run 44073402214, `e2e on windows-latest (1/2)`: 시계 고정 격리 서버 정리 중 `postgres.log` 잠김(EBUSY)과 `lead-conversations.spec.ts:12`의 응답 대기 시한 초과.

같은 기간 main도 Windows E2E가 5회 중 1회 실패했고, 소요 시간은 main과 비슷했다(210–354초). 이 PR이 E2E에 더하는 것은 서버 시작 때의 실행기 준비뿐이며, E2E의 가짜 프로바이더는 실행기를 쓰지 않는다. 두 모양은 제품 결함 없는 CI 실패를 모은 [#213](https://github.com/babo-jeonguk/BaboJUBot/issues/213)과 Windows 파일 잠김 묶음 [#216](https://github.com/babo-jeonguk/BaboJUBot/issues/216)의 계열이라 그 이슈들에 사례로 연결한다.

## 로컬 리뷰 (1회차, 검토 SHA `0ab201b`, 수정 SHA `596e07d`)

| ID | 축 | 판정 | 근거·처리 |
| --- | --- | --- | --- |
| P1 | Spec | 수정 | 준비 중 파일 오류가 던져져 서버 시작이 실패할 수 있었다(US8 위반). 준비 전체를 실패 값으로 바꾸고 정리 실패도 삼킨다. 회귀 시험: `tools` 자리에 파일 |
| P2 | Spec | 수정 | 찾지 못한 프로그램이 cross-spawn의 cmd.exe 경유로 실행기에 들어가 시작 실패(ENOENT)가 종료 코드 1로 바뀌었다. cross-spawn ENOENT 판단과 같은 `file` 없음이면 실행기를 쓰지 않는다. 회귀 시험 추가 |
| P3 | Spec | 의도된 동작 | 서버 시작 때 준비. 위 “준비” 항목의 이유 |
| P4 | Spec | 일부 수정 | 예전 해시 실행기를 지운다. 종료 뒤 묶음 끄기·10초 대기(정리 완료 때 남은 프로그램이 꺼져 있음을 결정적으로 보장)와 상태 줄(US9 경고)은 의도된 동작 |
| S1 | Standards | 수정 | 이 절에 CI 결과를 채웠다 |
| S2 | Standards | 수정 | “job runner”는 외부 job adapter([전체 구조](../architecture.md))와 겹친다. 코드·로그 이름을 `job object launcher`(`job-object.ts`·`job-object-launcher.cs`)로 바꿨다. 한국어는 “묶음 실행기” 그대로 |
| S3 | Standards | 수정 | 문서 지도의 issue 조사 표에 #205를 넣었다 |
| S4·S5·S8 | Standards | 수정 | Windows 폴더 대체값·상태 줄 읽기(`readLauncherStatus`)·시험 fixture를 한 곳으로 모았다. 합성 서버 시험은 최소 환경 변수와 `error` 관찰을 쓴다 |
| S6 | Standards | 의도된 동작 | 실행기는 서버 프로세스에 하나라 모듈 상태로 둔다. 상태를 바꾸는 시험은 파일 끝에 모았다 |
| S7 | Standards | 의도된 동작 | cross-spawn `_parse` 사용은 같은 명령 해석을 지키려는 선택이며 판은 lockfile이 고정한다 |
| S9 | Standards | 반증 | 주석 언어 규칙은 문서에 없고 `process.ts`에도 영어 주석이 있다 |

P1·P2 회귀 시험은 수정과 같은 커밋에 넣었고, Windows에서만 돌아 수정 전 실패를 CI로 따로 확인하지 않았다. 수정 전 코드에서의 실패는 코드 경로로만 판단했다.

## 외부 리뷰 1회차 (검토 SHA `cc51afa`)

| ID | 축 | 판정 | 근거·처리 |
| --- | --- | --- | --- |
| STD-1 | Standards | 수정 | 시험이 띄운 것을 번호로만 들고 끝에 번호로 끄며 꺼짐을 기다리지 않았다([검증 기준](../agents/verification.md#테스트-작성) 정리는 시한을 두고 기다림). 직접 띄운 프로그램은 핸들로 끄고 `exit`를 기다리며, 실행 시도는 끝마다 마저 끝내 묶음을 닫는다. 번호만 아는 자손은 번호 재사용을 고려해 다시 끄지 않고 시한 안에 꺼졌는지만 확인해, 남아 있으면 실패한다 |
| SPEC-R1 | Spec | 수정 | 입력(`write`)이 프로그램에 닿고 프로그램의 오류 출력이 실행기 상태 줄 없이 그대로 남는 시험을 더했다(US6) |
| SPEC-R2 | Spec | 의도된 동작 | `JOB_LIST`·배정 실패 경로의 실제 환경 검증은 위 미검증 범위로 이미 공개했다. windows-latest에서 결정적으로 재현할 방법이 없다 |

## 외부 리뷰 2회차 (검토 SHA `daa5cee`)

| ID | 축 | 판정 | 근거·처리 |
| --- | --- | --- | --- |
| STD-2 | Standards | 수정 | 시험 정리가 단계마다 앞 단계 성공에 기대어, 하나가 실패하면 남은 실행 시도를 끝내지 않았다. 세 단계(직접 띄운 프로그램, 실행 시도, 자손 확인)를 모두 돌리고 실패를 모아 마지막에 함께 알린다. 시작하지 못한 프로그램(`pid` 없음)은 기다리지 않고, 끄는 중의 `error`도 끝으로 본다 |

## 외부 리뷰 3회차 (검토 SHA `dba73c4`)

| ID | 축 | 판정 | 근거·처리 |
| --- | --- | --- | --- |
| STD-3 | Standards | 수정 | 직접 띄운 프로그램의 끝남을 `exit`와 `error` 어느 쪽으로든 인정해, 끄지 못한 경우도 성공으로 보았다. 세 회차 모두 시험 정리를 손으로 짠 대기 코드에서 지적이 나와(반복 원인), 사용자 승인으로 저장소의 다른 시험(`apps/web/e2e/support`)과 같은 Node 표준 `events.once(child, "exit")`와 시한(`AbortSignal.timeout`)으로 바꿨다. `error`나 시한 초과는 실패이며 끄기 신호가 전달되지 않았는지도 메시지에 남긴다. 끄기 거부를 흉내 내는 회귀 시험은 시험 보조 코드를 다시 시험하는 일이라 넣지 않았다 |

## 외부 리뷰 4회차 (검토 SHA `0cf83aa`)

요청에 따라 시험 정리 코드 전체를 한 번에 검토받았다.

| ID | 축 | 판정 | 근거·처리 |
| --- | --- | --- | --- |
| STD-4 | Standards | 수정 | 직접 띄운 무관한 프로그램은 `error`를 관찰하지 않아 시작 실패가 처리되지 않은 오류가 될 수 있었고, 정리는 `pid` 없는 프로그램을 조용히 건너뛰었다. 직접 띄우는 것은 띄우는 순간 오류를 관찰하는 `spawnTracked` 하나로만 띄우고, 시작하지 못한 프로그램은 그 오류를 정리 실패로 알린다 |
| STD-5 | Standards | 수정 | 생존 확인이 어떤 오류든 꺼짐으로 보아 권한 거부를 정리 완료로 셀 수 있었다. `recovery.ts`의 `processAlive`와 같이 `ESRCH`만 꺼짐으로 본다 |
| 설계 권고 | Standards | 반영 | 실행 시도 마무리의 `end()`가 동기로 던져도 다음 정리 단계가 돌도록 `async`로 감쌌다 |

## 병합 전 감사 (head `d9e7847`)

문서·이슈 감사(Codex sub)를 읽기 전용으로 돌렸다. 두 감사 뒤 `git status --short`는 비어 있었다.

- 문서: 이 기록의 최종 head 문구만 갱신 필요(위에 반영). `docs/providers.md`의 Windows 묶음 절, 코드 지도, 문서 지도, README·현재 구현 현황·CONTRIBUTING·GLOSSARY·전체 구조는 유지.
- 이슈: 확정 결정과 어긋난 구현 없음. US2(예고 없는 프로그램 사망)는 프로그램 종료 뒤의 같은 정리 경로와 취소의 강제 종료로, US13(내장 DB 보호)은 무관한 프로그램의 생존으로 대신 확인했다. 실제 DB를 둔 음성 대조와 프로그램만 외부에서 죽이는 전용 시험은 없다. #205에는 병합 뒤 결과를, #213·#216에는 위 E2E 사례를 남긴다. #145·#189·#211 등 닫힌 이슈는 유지.
- 후속 후보: 기본 설치 Windows 10·11·ARM64·일반 권한·실제 보안 제품 호환성 확인, `JOB_LIST`·배정 실패 때 한 번만 시작·경고·정리 확인.

## 미검증

- 기본 설치 Windows 10·11, Windows ARM64, 일반 권한 Windows, 실제 백신(Defender 실시간 보호의 다른 정책·Smart App Control·타사 백신). 늦은 격리로 실행기가 사라지면 그 실행 시도는 경고하고 묶음 없이 돈다.
- 서버가 실행기를 만든 직후 Node.js가 넣기 전의 수 마이크로초 틈(사용자 결정으로 남김). 실행기가 프로그램을 만든 뒤 묶음에 넣기 전의 틈은 `JOB_LIST`가 성공하는 한 없다. `JOB_LIST`가 실패하는 환경은 CI에서 재현하지 않았다.
- 실제 에이전트 프로그램·실제 모델.
