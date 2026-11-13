# issue-189 레퍼런스 조사: Windows E2E 서버 정상 종료와 CI

조사일: 2026-11-13. 대상: [#189](https://github.com/babo-jeonguk/BaboJUBot/issues/189). 구현 전 기술 권고이며 확정 계약이나 구현 결과가 아니다.

## Brief

- 구현할 문제: Windows에서 공용·격리 E2E 서버가 강제 종료되어 서버 정리와 내장 Postgres 정지를 마치지 못한다. 정상 종료 경로와 Windows E2E CI가 필요하다.
- 동종 문제: 부모가 소유한 Node 자식에 운영체제 신호와 별개로 종료를 요청하고, 자원 정리와 실제 종료를 시한 안에 확인하는 수명 관리.
- 고정된 결정: 기존 POSIX 신호·서버 정리→DB close 순서·전체 정리 예산·조직 경계·초기 승인·사용자 최종 완료 계약을 유지한다. 모델 호출·제품 구현·새 의존성 도입은 조사 범위 밖이다.
- 기준: [#181](https://github.com/babo-jeonguk/BaboJUBot/issues/181)은 닫혔고 [PR #188](https://github.com/babo-jeonguk/BaboJUBot/pull/188)은 병합됐다. remote main `5d84cbc56246027bef9e8da3413ac1643cf63b4e` 소스를 읽었다. 조사 중 로컬 checkout은 이전 main `3dd6e1572a8eecf9693f447af9de61bd210ba3fc`에 두었다. #189 blocker는 없다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | Windows에서 부모가 자식을 정상 종료시키는 IPC·stdin 선례와 적용 조건은? | #189 What to build, AC 1·3 | Source Recon + 프로토콜 계약·runtime/failure |
| Q2 | 공용 E2E API 서버가 Playwright의 taskkill 전에 정리를 마치려면 누가 수명을 소유해야 하는가? | #189 AC 2 | Source Recon + 실행 순서·실패 경로 |
| Q3 | 시작 중·중복 요청·시한·부모 종료·예기치 않은 코드 0 종료·PG 잔류를 어떻게 검증할 것인가? | #189 AC 1·3·5, #188 STD-1·STD-2 | Source Recon + Linux mock 양성/음성 대조 |
| Q4 | Windows E2E를 실제 실행하고 빠짐없이 CI 결과에 반영하려면? | #189 AC 4·6 | 공식 CI 계약 + 현재 workflow·집계 소스 |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [정상 종료 조사](graceful-shutdown-references.md) | 단일 coordinator·DB-last·전체 예산의 배경 | Node 고정 SHA가 같고 `process.md`·`child_process.md` blob ID가 양쪽 ref에서 동일함을 확인. 과거 권고의 종료 코드 정책을 새로 확정하지 않음 |
| [내장 PG 수명 조사](embedded-postgres-lifecycle-references.md) | 부모 강제 사망과 다음 시작 회수의 보장 범위 | 외부 PG 근거를 새 E로 옮기지 않고 현재 main의 `embedded.ts`를 읽음 |
| [#63 조사](issue-63-references.md) | Playwright 수명 조사 출발점 | 기존 1.58.2 실행 근거를 재사용하지 않음. 현재 1.64.1 소스와 설치본으로 다시 확인 |

## 레퍼런스

두 관점에서 각각 3라운드 탐색했다. 런타임·감독자 관점은 Node/PM2/Vite→Execa→메시지와 종료 시한의 재검색에서 새 패턴이 없었다. runner·CI 관점은 webServer/globalSetup→Windows 설치/needs 집계→teardown 순서 재검색에서 같은 소유권·역순 정리 패턴이 반복됐다. 조사 범위의 saturation이며 생태계 전수 조사 주장은 아니다.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| Node.js | 런타임 계약 | v24.22.2 `f7f273a9bb6445f6f7fb6349105e7532972045fb` | MIT 및 포함 구성요소 | 문서·실행 | Windows kill·IPC의 기본 계약 |
| PM2 | 프로세스 감독자 | `7a7fb4e22e9a26ec79c870ce8daafd2f78b648d1` | AGPL-3.0 | 소스 | Windows message shutdown의 운영 선례 |
| Vite | 개발 서버 | v8.3.4 `b6c20f6a8126d8561891e5fb9368e8fc9da37538` | MIT | 소스 | stdin EOF 대안과 CI 가드 |
| Playwright | 테스트 runner | v1.64.1 `cfe490d941f992655948eee8fd4fd94e1c4234bf` | Apache-2.0, NOTICE 있음 | 소스·실행 | 현재 채택 버전의 실제 정리 순서 |
| Execa | 프로세스 라이브러리 | 공식 termination/API 문서, 소스 버전 미고정 | 재사용 심사 안 함 | 문서 | gracefulCancel/IPC 추상화 대안 |
| GitHub Actions | CI 계약 | 공식 needs 문서, 확인일 기준 | 코드 복사 없음 | 문서 | 실패·skip 전달과 집계 |
| BaboJUBot | 적용 대상 | main `5d84cbc56246027bef9e8da3413ac1643cf63b4e` | 외부 코드 복사 없음 | 소스 | 현재 종료·DB·fixture·CI 경계 |

공개 실행 경로는 Node/Playwright의 로컬 mock, PM2/Vite/Execa의 OSS self-host다. 이번에는 기존 설치된 Node·Playwright만 실행했고 다른 패키지 설치·전체 upstream suite는 실행하지 않았다. 모든 외부 소스는 설계 참고다.

## 근거

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | Windows의 `subprocess.kill('SIGTERM'/'SIGINT')`은 정상 정리를 요청하는 POSIX 신호가 아니라 강제 종료다. | [Node `child_process.md`](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/doc/api/child_process.md#L1748-L1754) | 문서 주장 |
| <a id="E02"></a>E02 | Node 자식의 stdio에 IPC를 열면 message·disconnect를 사용할 수 있다. send callback은 메시지가 보내졌다는 뜻이며 자식의 수신·정리 완료를 보장하지 않는다. 종료 코드·실제 종료를 별도로 기다려야 한다는 권고다. | [IPC stdio](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/doc/api/child_process.md#L1051-L1066), [send callback](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/doc/api/child_process.md#L1992-L2004), [disconnect](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/doc/api/process.md#L83-L91) | 문서 주장·추론 |
| <a id="E03"></a>E03 | PM2는 Windows 정상 정지에 shutdown message를 공식 안내한다. `killProcess`는 `proc.send('shutdown')` 뒤 `processIsDead`를 기다리고, 시한 후 살아 있는 PID에 강제 종료를 시도한다. PM2 자체 도입 없이 이 요청→종료 확인→시한 패턴을 참고할 수 있다. | [PM2 Windows graceful stop](https://pm2.keymetrics.io/docs/usage/signals-clean-restart/), [`killProcess`](https://github.com/Unitech/pm2/blob/7a7fb4e22e9a26ec79c870ce8daafd2f78b648d1/lib/God/Methods.js#L228-L250), [`processIsDead`](https://github.com/Unitech/pm2/blob/7a7fb4e22e9a26ec79c870ce8daafd2f78b648d1/lib/God/Methods.js#L153-L215) | 문서 주장·소스 확인 |
| <a id="E04"></a>E04 | Vite는 SIGTERM과 stdin end를 공유 callback으로 연결하지만 EOF listener는 `CI !== 'true'`일 때만 붙인다. stdin EOF를 보편적인 서버 종료 계약으로 볼 수 없다. 역사적 #4196은 비대화형 Docker stdin에서 예기치 않은 code 0 종료를 보고한다. | [`setupSIGTERMListener`](https://github.com/vitejs/vite/blob/b6c20f6a8126d8561891e5fb9368e8fc9da37538/packages/vite/src/node/utils.ts#L1924-L1954), [Vite #4196](https://github.com/vitejs/vite/issues/4196) | 소스 확인·issue 문서 주장 |
| <a id="E05"></a>E05 | Playwright API webServer command는 shell + stdin pipe로 시작하며 IPC를 제공하지 않는다. Windows graceful callback은 즉시 오류를 내고 launcher가 `taskkill /T /F`로 fallback한다. 설정의 graceful timeout 확대만으로 해결되지 않는다. 읽은 종료 경로에는 stdin을 먼저 닫아 정리시키는 단계가 없다. | [`WebServerPlugin._startProcess`](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/playwright/src/plugins/webServerPlugin.ts#L109-L145), [`gracefullyClose`](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/utils/processLauncher.ts#L208-L241), [`killProcessTree`](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/utils/processLauncher.ts#L274-L281) | 소스 확인·추론 |
| <a id="E06"></a>E06 | plugin setup는 globalSetup보다 먼저다. task runner는 teardown을 역순으로 쌓는다. 따라서 globalSetup이 반환한 cleanup에서 API 자식을 멈추면 webServer plugin teardown보다 앞선다. 반환 전 setup 실패는 cleanup 함수가 저장되지 않으므로 자체 catch에서 자원을 정리해야 한다. | [`createGlobalSetupTasks`](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/playwright/src/runner/tasks.ts#L151-L160), [`createGlobalSetupTask`](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/playwright/src/runner/tasks.ts#L208-L224), [`TaskRunner`](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/playwright/src/runner/taskRunner.ts#L72-L89) | 소스 확인·추론 |
| <a id="E07"></a>E07 | globalSetup 반환 함수와 환경 변수 전달은 공개 API다. project dependencies는 trace·report 통합에 권장되지만 `--no-deps`로 teardown까지 생략할 수 있다. 전역 deadline이 소진되면 runner의 같은 deadline을 쓰는 cleanup도 즉시 끝나는 한계가 있다. | [globalSetup](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/docs/src/test-global-setup-teardown-js.md#L133-L149), [deadline 한계](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/playwright/src/runner/taskRunner.ts#L112-L116) | 문서 주장·소스 확인 |
| <a id="E08"></a>E08 | Linux Node v24.21.0 IPC mock 6개에서 시작 중 중복 요청은 cleanup 1회·코드 0, unknown message는 무시, 시작 실패·정리 hang은 코드 1, IPC disconnect·SIGTERM은 코드 0이었다. | 이번 조사 mock 실행: 최소 환경의 Node 자식과 300ms watchdog. 외부 DB·제품 서버 없음 | 실행 확인 |
| <a id="E09"></a>E09 | 설치된 Playwright 1.64.1의 mock 4개에서 API cleanup이 plugin close보다 먼저였다. 정상은 exit 0, 본문 실패·setup 실패·예기치 않은 API 코드 0 종료는 exit 1이었다. 마지막은 본문 `1 passed`여도 teardown error로 전체 실패했다. | 이번 조사 Linux runner 실행: 브라우저 없는 합성 test + loopback webServer + IPC child. 오류 3건의 exit 1은 기대값 | 실행 확인 |
| <a id="E10"></a>E10 | 현재 main은 신호가 처음 오면 stopping Promise를 공유하며 startup을 기다린 뒤 서버→DB를 닫고 성공 0·실패/시한 1로 끝난다. 시작 중 정지 요청이 있으면 HTTP 서버는 띄우지 않는다. IPC adapter를 이 coordinator에 붙이는 것이 종료 순서를 보존한다. | [main `start`·`shutdown`](https://github.com/babo-jeonguk/BaboJUBot/blob/5d84cbc56246027bef9e8da3413ac1643cf63b4e/apps/server/src/main.ts#L124-L197) | 소스 확인·추론 |
| <a id="E11"></a>E11 | 격리 fixture는 정지 전 이미 끝난 서버를 코드와 관계없이 실패시키고, SIGTERM→유한 대기→SIGKILL 후 실패한다. 현재 테스트의 SIGTERM을 Windows에서도 정상 종료하는 요청으로 바꾸어야 한다. | [`stopChild`](https://github.com/babo-jeonguk/BaboJUBot/blob/5d84cbc56246027bef9e8da3413ac1643cf63b4e/apps/web/e2e/support/isolated-server.ts#L151-L182), [회귀 spec](https://github.com/babo-jeonguk/BaboJUBot/blob/5d84cbc56246027bef9e8da3413ac1643cf63b4e/apps/web/e2e/support/isolated-server.spec.ts#L1-L25) | 소스 확인 |
| <a id="E12"></a>E12 | 현재 DB adapter는 pool을 닫은 뒤 cluster를 release한다. embedded stop은 `pg_ctl stop -m fast -w`를 기다리고 임시 경로를 지운다. process.exit 비상 정지와 다음 시작 회수는 정상 close와 별도다. 앱 kill 성공만으로 detached PG 소멸·임시 폴더 정리를 증명할 수 없다. | [pool close](https://github.com/babo-jeonguk/BaboJUBot/blob/5d84cbc56246027bef9e8da3413ac1643cf63b4e/packages/db/src/client.ts#L98-L110), [정상·비상 정지](https://github.com/babo-jeonguk/BaboJUBot/blob/5d84cbc56246027bef9e8da3413ac1643cf63b4e/packages/db/src/embedded.ts#L85-L100), [`stopCluster`](https://github.com/babo-jeonguk/BaboJUBot/blob/5d84cbc56246027bef9e8da3413ac1643cf63b4e/packages/db/src/embedded.ts#L214-L237) | 소스 확인·추론 |
| <a id="E13"></a>E13 | E2E는 Linux check matrix에만 있다. Windows job은 runtime·boot·일부 파일 시험을 수행한다. `ci / test`는 명시 needs/env와 Node gate로 success/skipped를 엄격히 판정하므로 Windows E2E도 세 곳에 연결해야 한다. | [Linux E2E](https://github.com/babo-jeonguk/BaboJUBot/blob/5d84cbc56246027bef9e8da3413ac1643cf63b4e/.github/workflows/scaffold.yml#L55-L98), [집계](https://github.com/babo-jeonguk/BaboJUBot/blob/5d84cbc56246027bef9e8da3413ac1643cf63b4e/.github/workflows/scaffold.yml#L210-L251), [Windows](https://github.com/babo-jeonguk/BaboJUBot/blob/5d84cbc56246027bef9e8da3413ac1643cf63b4e/.github/workflows/scaffold.yml#L285-L316), [gate](https://github.com/babo-jeonguk/BaboJUBot/blob/5d84cbc56246027bef9e8da3413ac1643cf63b4e/scripts/check-ci-test-gate.mjs#L1-L70) | 소스 확인 |
| <a id="E14"></a>E14 | Playwright의 공식 CI 흐름은 의존성·browser 설치 뒤 test 실행이다. GitHub Actions의 실패·skip된 needs는 후속 job을 건너뛰게 하므로 항상 평가할 집계 job의 조건과 각 결과 판정이 필요하다. | [Playwright CI](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/docs/src/ci.md#L5-L44), [GitHub jobs.needs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds) | 문서 주장 |

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 명시적 IPC 요청→앱 coordinator→자식 실제 종료 확인 | E01–E03·E08 | PM2의 문자열 대신 제품 전용 메시지 형태를 쓸 수 있음 | Windows와 POSIX에서 같은 요청 의미 | IPC 연결·send 오류·예산·수명 listener 관리 |
| <a id="P02"></a>P02 | 수명을 소유하는 setup이 child handle과 cleanup을 함께 보유 | E05–E09 | API는 globalSetup이 직접 spawn, Vite만 webServer에 유지 | 강제 plugin 종료 전에 정상 정리 기회 | setup 자체 실패·전체 deadline·부모 hard kill 대응 별도 |
| <a id="P03"></a>P03 | 요청 여부와 종료 코드를 별도로 검사 | E09·E11 | 서버가 먼저 끝났으면 코드 0도 실패 | teardown이 수명 이상을 성공으로 덮지 않음 | 중복 stop은 같은 Promise를 반환하도록 설계 필요 |
| <a id="P04"></a>P04 | 앱·PG·임시 경로를 각각 검증 | E10–E12 | PG는 detached라 앱 PID 종료와 다름 | 파일 잠금·잔류 프로세스까지 관찰 | Windows 실제 PG 실행과 경로 소유권 검사 필요 |
| <a id="P05"></a>P05 | 독립 OS E2E job을 엄격한 결과 gate에 연결 | E13·E14 | 기존 OS runtime job과 별도, 같은 change filter | 기존 runtime 검사와 E2E 결과를 구별 | needs·env·gate·gate 회귀 시험의 동시 갱신 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | Node IPC가 있는 자식에 전용 종료 메시지를 보내고 기존 main coordinator를 호출한다. 부모는 send callback 대신 exit/code를 기다린다. POSIX 신호 handler를 유지한다. | P01, E10 | 추가 HTTP endpoint·새 라이브러리 없이 명시적 부모 소유 채널. PM2 wire 형식을 그대로 복사할 필요 없음 | Q1·Q3 |
| <a id="D02"></a>D02 | 변형 채택 | 공용 API를 webServer 목록에서 빼고 globalSetup이 직접 IPC spawn·준비 확인·반환 teardown을 소유한다. Vite build/preview는 webServer에 남긴다. setup 중 실패는 그 자리에서 정리한다. | P02 | 공식 cleanup API와 확인된 역순 teardown. 공용 포트·fake-provider 설정·health·상속 환경 격리는 동일하게 명시 | Q2 |
| <a id="D03"></a>D03 | 채택 | 격리 fixture와 main 진입점 시험도 D01 요청을 사용한다. stop 상태/Promise와 실제 종료를 처음부터 관찰하고, 요청 전 종료는 코드 0도 실패시킨다. | P03·P04 | 기존 #188 STD-1 회귀 계약 유지. 중복 stop 성공과 자발 종료 실패를 구별 | Q3 |
| <a id="D04"></a>D04 | 변형 채택 | 부모 IPC disconnect를 같은 coordinator에 연결하는 best effort를 검토한다. IPC가 없는 일반 서버의 stdin/terminal 수명에는 붙이지 않는다. | E02·E07·E08 | 소유 부모가 사라졌을 때 정리 기회. 부모·자식 동시 hard kill/OS tree 종료까지 정상 정리 보장하지 않음 | Q1·Q3 |
| <a id="D05"></a>D05 | 채택 | 기존 서버 10초/부모 15초의 예산 관계를 유지하고 timeout·전송 실패·강제 종료는 시험 실패로 보고한다. 정상 stop 뒤 PG PID·dataDir·제품 임시 경로 소멸을 별도로 단언한다. | P01·P04 | deadline 증가만으로 숨기지 않음. 정상 완료와 비상 회수/다음 시작 회수의 범위 분리 | Q3 |
| <a id="D06"></a>D06 | 채택 | 별도 Windows Chromium E2E job을 추가한다. browser 설치·전체 E2E·실제 test 수·실패 trace를 확인하고 gate needs/env/suites 및 gate 회귀 검사에 연결한다. | P05 | runtime-on-Windows 성공을 E2E 성공으로 보지 않음. 문서 변경 skip과 code 변경 필수 성공을 엄격히 유지 | Q4 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| `SIGINT`로 바꾸기 또는 Playwright graceful timeout 확대만 하기 | E01·E05 | Windows kill/launcher 분기가 정상 종료로 바뀌지 않음 |
| webServer wrapper가 부모 신호나 stdin EOF를 받아 IPC 전달만 하기 | E04·E05 | Windows에서는 wrapper도 taskkill 대상. 강제 종료 전에 실행할 callback 자체가 필요 |
| 일반 서버가 언제나 stdin EOF에서 종료 | E04 | CI·redirected stdin·비대화형 실행과 수명이 다름. opt-in 계약과 전달 경로 추가 필요 |
| HTTP shutdown endpoint·control file·별도 named pipe | P01·P02에서 파생한 대안 | 구현 가능하지만 현재 Node 부모-child에 이미 IPC가 있어 별도 인증·주소·파일 수명 계약 비용을 늘림. 이번에는 보류 |
| Execa/PM2 신규 의존성 도입 | [Execa termination](https://github.com/sindresorhus/execa/blob/main/docs/termination.md), E03 | Node IPC만으로 필요한 경로를 만들 수 있음. 도입 자체의 검증·운영 비용을 정당화할 필요 없음 |
| native Job object·watcher·영구 DB 회수 정책 재설계 | 기존 내장 PG 수명 조사 | #189의 정상 종료/CI를 넘어감. 기존 비상·다음 시작 회수 정책을 유지하고 한계를 보고 |

## 구현 참고

권고의 중심은 **IPC 종료 요청을 main의 기존 정리에 연결하고, 공용 API 자식 수명을 globalSetup이 소유하는 것**이다. globalSetup은 Vite webServer 뒤에 실행되므로 정적 빌드가 준비된 뒤 API를 띄우며, cleanup은 Vite plugin teardown 전에 온다. 별도 setup project는 trace 관측의 장점이 있지만 child handle을 worker 사이에 넘기는 설계가 더 필요해 이번 기본 권고로 삼지 않았다.

구현 위치는 `apps/server/src/main.ts`의 process adapter, `apps/server/test/main.test.ts`, `apps/web/e2e/support/isolated-server.ts`·회귀 spec, `apps/web/playwright.config.ts` 및 새로운 suite setup, `.github/workflows/scaffold.yml`·`scripts/check-ci-test-gate.mjs`·gate 시험이다. 제품 Control Plane·조직/승인·DB 저장 계약은 변경 대상이 아니다. 다른 테스트 패키지의 helper를 직접 import하는 추출은 필요하지 않다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 일반 서버를 IPC 없이 시작 → 기존 POSIX SIGINT/SIGTERM/SIGHUP → 기존 정리·종료 코드 유지. POSIX 전용 group/SIGSTOP 검사는 해당 플랫폼에서 계속 실행 | D01·D03 |
| V02 | IPC child가 준비됨 → 정상 stop → 서버 close 뒤 PG close, code 0, PG PID 종료·pidfile/dataDir·제품 임시 경로 소멸 | D01·D05 |
| V03 | DB 시작 중 종료 요청 → startup settle 후 정리, HTTP listen/ready 없음. startup 자체 실패면 code 1 유지 | D01·D03 |
| V04 | 요청 2회/stop 2회 또는 IPC와 POSIX 신호 경합 → 동일 stopping Promise·정리 1회·정상 code 0. unknown message는 무시 | D01·D03 |
| V05 | 정리 hang/전송 실패 → 한 번의 전체 예산 안에서 실패 진단·nonzero. 강제 kill을 정상 완료로 보고하지 않음 | D05 |
| V06 | fixture 요청 전에 child가 code 0으로 자발 종료 → 본문이 성공해도 stop/teardown 실패. 기존 fixture 음성 대조를 Windows에서도 같은 IPC 정상 종료로 구성 | D03 |
| V07 | IPC disconnect와 실제 소유 부모 종료를 각각 유도 → child 정리 시도·완료, PG/임시 경로 관찰. 부모/자식 동시 강제 종료는 별도 한계로 기록 | D04·D05 |
| V08 | 공용 API setup 성공/본문 실패/setup 중 실패 → API cleanup 완료가 webServer 강제 정리보다 먼저. 두 번째 webServer 시작 실패 및 전체 deadline 소진도 누락 없이 확인 | D02 |
| V09 | Windows E2E job success/failure/cancelled/skipped/결과 누락 → code 변경은 success만, 문서 변경은 예상 skipped만 gate가 수용. 전체 E2E 실제 개수와 fixture 두 테스트 실행을 로그로 확인 | D06 |

Windows의 진입점 시험은 IPC 경로를 추가하면서 POSIX 전용 신호·프로세스 그룹·SIGSTOP 시험을 억지로 그대로 실행하지 않는다. POSIX 커버리지는 유지하고 Windows 공통 계약을 별도로 증명한다. 실제 잔류 검증은 새 서버를 다시 시작하기 **전에** 수행해야 다음 시작 회수가 정상 종료 누락을 가리지 않는다.

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| IPC의 구체 메시지·활성 조건 | #189 구현 | 권고: `process.send`/IPC가 있고 부모가 의도적으로 소유할 때만 전용 type을 수용. 문자열 `shutdown` 호환은 PM2 실제 운영 요구가 있을 때 선택 |
| 부모 종료 보장 범위 | #189 | 권고: IPC disconnect 정리 + Windows 실제 부모 종료 시험. OS가 자식도 즉시 없애는 경우의 PG 즉시 회수 보장까지 요구하면 별도 범위·수단 결정 필요 |
| suite API 소유자 배치 | #189 | 권고: 모든 OS에서 같은 globalSetup. 대안: Windows만 별도 수명 경로(변경은 작지만 OS별 분기 증가), 외부 runner가 API와 Playwright를 함께 소유(실행 진입점이 늘어남) |

## 한계와 미확인

- Linux에서 Node v24.21.0·설치된 Playwright 1.64.1의 **mock 10개만** 실행했다. 실제 BaboJUBot 서버·내장 Postgres·browser 전체 E2E·Windows/macOS·GitHub CI 실행은 하지 않았다. 위 검증 표는 구현 때 수행할 항목이다.
- 실행 확인은 IPC 요청의 수명 패턴과 Playwright 정리 순서다. upstream Node/PM2/Vite/Playwright 전체 suite를 통과했다거나 Windows 정상 종료가 이미 해결됐다는 뜻이 아니다. IPC disconnect 모의 실행은 실제 부모 SIGKILL·Windows taskkill 시험과 구별한다.
- probe 정상 1건과 의도적 오류 3건의 Playwright process 결과는 각각 0과 1이었다. 오류 음성 대조까지 예상대로 통과했다. 첫 CLI module 경로 오류는 수정 후 다시 실행했으며 동작 근거로 쓰지 않았다.
- Vite stdin EOF의 최신 소스는 읽었지만 실제 EOF 실행은 하지 않았다. Execa는 공식 문서 후보만 검토했다. PM2 Windows graceful stop의 실행 시간·tree 정리 보장은 직접 확인하지 않았다.
- globalSetup cleanup은 일반 성공·테스트 실패·자체 setup 실패를 다루지만 전역 deadline 소진·runner 강제 사망·OS 동시 종료의 보장은 아니다. 특히 detached PG는 Node child PID만 보고 잔류가 없다고 판단할 수 없다.
- 고정 raw 소스 다운로드 중 Playwright의 이동한 경로는 tree API로 찾아 해결했다. 최종 판단에 필요한 primary source 접근 실패는 남아 있지 않다.
- 제품 코드·테스트·설정·자격 증명·실제 연구 데이터를 변경하지 않았고 커밋도 만들지 않았다. 외부 코드를 복사한다면 해당 SHA의 LICENSE/header/NOTICE/의존성 및 저장소 출처·고지 규칙을 구현 단계에서 다시 적용한다.
