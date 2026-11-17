# #219 구현 기록 — Linux·macOS 새 세션 자손의 표식 정리

기준: `main` `fd9b803`, 작업 브랜치 `fix/219-lease-marker-sweep`. 요구는 [#219](https://github.com/babo-jeonguk/BaboJUBot/issues/219) 본문과 [Agent Brief](https://github.com/babo-jeonguk/BaboJUBot/issues/219#issuecomment-6947919097)이고, 조사는 [하위 프로세스 정리 조사](orphan-process-cleanup-references.md)다. 현재 동작은 [프로바이더 안내의 새 세션 정리](../providers.md#linuxmacos-새-세션-정리)가 기준이다.

## 사용자 결정 (2026-11-17)

| 질문 | 결정 | 반영 |
| --- | --- | --- |
| Linux도 표식 탐색을 쓸지, 조사 D01(실행 시도별 cgroup·systemd)을 쓸지 | 표식 탐색. 특정 환경(systemd 사용자 관리자)에 묶이지 않는 일반 경로로 둔다 | Linux `/proc/<pid>/environ` 전역 탐색. cgroup·subreaper·네이티브 실행기는 쓰지 않는다 |
| 끄지 못했을 때 알리는 곳 | 서버 운영 기록만. 조사 D06(실행 시도 상태·활동에 실패 기록)은 쓰지 않는다 | 프로세스 그룹 정리 실패와 같은 처리: 경고, 실행 자리 반납, 기록 유지. 대시보드·계약·DB는 바꾸지 않는다 |

## 원문으로 다시 확인한 근거

| 근거 | 확인한 곳 | 적용 | 배제·차이 |
| --- | --- | --- | --- |
| Paseo 같은 문제의 수정: Linux `/proc` 환경을 NUL로 나눠 정확히 비교, macOS는 `ps -A -ww -o pid=,command=`를 `-E` 없이·있이 받아 실행 인자 뒤 부분만 비교, TERM → 유예 → 매 단계 다시 찾아 KILL | [getpaseo/paseo#9986](https://github.com/getpaseo/paseo/pull/9986) head `d1f01517fde7dc578cdffc451bc31698edbc7c6e`의 `packages/server/src/server/agent/provider-process/leftovers.ts` | 같은 방식(찾기 규칙·두 번 받는 `ps`·KILL 직전 재조회)을 새로 썼다. 오탐 사례(실행 인자 속 표식, 다른 값, 다른 변수의 값 속 표식)를 시험으로 가져왔다 | 코드는 복사하지 않았다(라이선스 혼합). Paseo는 KILL 뒤 꺼졌는지 기다리지 않는다. 여기서는 KILL 뒤 10초까지 다시 찾아 남은 것을 실패로 돌려준다. `/proc` 환경은 UTF-8이 아닌 바이트를 위해 latin1로 읽는다 |
| 조사 D03(macOS 표식 + 같은 UID 전역 탐색 + PID 시작 신원 재확인)·D05(Paseo식 /proc·ps 표식 탐색 + 그룹 정리 병행 + 재시작 복구) | [조사 문서 결정 권고](orphan-process-cleanup-references.md#결정-권고) | D05 모양: 그룹 정리 뒤 표식 정리, 실행 시도 끝과 재시작 복구 양쪽 | D03의 시작 신원 재확인 대신 KILL 직전 표식 재조회를 쓴다(번호 재사용된 무관한 프로그램은 표식이 없다). D01·D02·D06은 위 사용자 결정으로 배제 |
| 재현 결과: Claude Code·Codex·Antigravity가 갑자기 죽으면 새 세션 명령이 남는다 | #219 본문, 시험 도구 [`probe/`](https://github.com/babo-jeonguk/BaboJUBot/tree/4f014b1239463fc63787822ed9253a449343eb99/probe) | 수정 전후 비교에 같은 도구를 썼다 | 시험 도구는 병합하지 않는다 |

## 결정과 구현

- **표식 모듈** `packages/runtime/src/providers/lease.ts`: `leaseHolders(lease)`가 서버 자신을 뺀 표식 보유 프로그램을 돌려주고, 조회 자체가 실패하면 던진다. `stopLeaseHolders(lease, { find })`는 TERM → 2초 → KILL(매번 다시 찾은 번호에만) → 최대 10초를 하고 `{ stopped, left }`를 돌려준다. 조회는 `find`로 바꿔 끼운다. 다른 사용자의 프로그램처럼 환경을 읽을 수 없는 프로그램은 우리 것으로 확인할 수 없으므로 건너뛴다.
- **실행 시도 끝** (`process.ts` `finish`): 프로세스 그룹 정리 다음, 컨테이너 삭제·기록 삭제 전에 표식 정리를 한다. 프로그램이 어떻게 끝났든 같은 경로다. 남은 것이 있거나 조회가 실패하면 그룹 정리 실패와 같이 `broken`, 운영 기록 경고, 기록 유지다. 컨테이너 실행과 Windows는 하지 않는다.
- **재시작 복구** (`recovery.ts` `recoverRecord`): Linux 부팅 식별자 확인 뒤 기존 그룹 복구를 하고, 기록에 lease가 있으면 표식 정리를 한다. 기존 그룹 복구가 "우리 것인지 확인할 수 없음"으로 끝났던 경우(대표 없이 남은 그룹, macOS에서 시작 시각을 모르는 대표)는 바로 던지지 않고, 표식 정리 뒤에도 남았을 때만 기록을 남긴다. 그래서 macOS에서 대표가 없어도 표식으로 확인되면 끈다. lease 없는 예전 기록은 지금과 같다. 그룹 안 표식 확인도 같은 정확 비교(`holdsLease`)로 바꿨다(예전에는 NUL로 끝나는 부분 문자열이었다).
- **바꾸지 않은 것**: Windows 묶음 경로, 컨테이너 정리, 짧은 확인 실행(`runProbe`), 공개 API·DB schema·계약·대시보드.

## 검증

자동 시험(`packages/runtime/src/providers/`):

| 경계 | 시험 | 수정 전 |
| --- | --- | --- |
| 대표가 SIGKILL·정상 종료·취소로 끝날 때 새 세션 자손과 손자가 꺼진다 | `process-leftovers.test.ts` | 4건 모두 실패(자손이 살아 있음) |
| 같은 시점의 다른 실행 시도 자손, 표식 없는 프로그램, 서버 자신은 산다 | `process-leftovers.test.ts` 마지막 건 | 실패(우리 자손이 남음) |
| 실행 인자 속 표식, 다른 lease, 다른 변수의 값 속 표식(Linux는 공백 뒤 포함)은 대상이 아니다. macOS `ps`는 환경 부분만 본다 | `lease.test.ts` | 새 모듈 |
| TERM을 무시하면 KILL, KILL 직전 재조회에서 빠진 번호는 신호를 받지 않음, 조회 실패·시간 초과 보고 | `lease.test.ts` | 새 모듈 |
| 실행 시도 끝의 조회 실패: `broken`, 경고, 기록 유지 | `process-record.test.ts` | 실패 |
| 재시작 복구: 대표·그룹이 없고 표식 자손만 남음(Linux 경로·macOS 경로), 표식을 가진 그룹이 대표 없이 남음, 조회 실패 시 기록 유지 | `recovery.test.ts` | Linux 경로의 그룹 건만 통과, 나머지 실패 |

시험 도구 수정 전후(이 컴퓨터 Linux arm64, Claude Code 2.1.326·Codex 0.169.0, 가짜 모델):

`node probe/run.mjs <claude|codex> <direct|nested> <agent|host> <port>`. 수정 전은 #219의 결과(`main` `2715292`, 이 컴퓨터와 CI가 같았다), 수정 후는 이 브랜치의 작업 트리(커밋 전, 아래 커밋과 같은 제품 코드)다. `agent`는 에이전트 프로그램만 SIGKILL한 경우(실행 시도 `done` 3초 뒤 확인), `host`는 서버를 SIGKILL하고 10초 뒤 `recoverProviderProcesses`를 돌린 경우다.

| 경우 | 수정 전 | 수정 후 |
| --- | --- | --- |
| claude direct agent | 남음 2 | 정리됨 0 |
| claude direct host | 정리됨(에이전트가 스스로 정리) | 정리됨 0 |
| claude nested agent | 남음 3 | 정리됨 0 |
| claude nested host | 정리됨(에이전트가 스스로 정리) | 정리됨 0 |
| codex direct agent | 정리됨(Codex의 부모 종료 신호) | 정리됨 0 |
| codex direct host | 정리됨 | 정리됨 0 |
| codex nested agent | 남음 1 | 정리됨 0 |
| codex nested host | 남음 1 | 정리됨 0 |

수정 후 8건 모두 끝난 뒤 `http.server`가 남지 않았다.

## 미검증

- macOS의 표식 정리는 CI(`runtime on macos-latest`)의 자동 시험으로만 확인한다. macOS에서 시험 도구는 다시 돌리지 않았다.
- Antigravity는 실제 계정 호출이 들어가 수정 뒤 다시 돌리지 않았다. 남은 것은 같은 새 세션 명령이므로 같은 경로로 정리된다고 보지만 확인하지 않았다.
- 실제 모델을 쓴 실행 시도. 서버가 죽은 뒤 다음 시작 전에 에이전트까지 죽는 순서는 자동 시험(`recovery.test.ts`의 대표·그룹이 없는 경우)으로만 본다.
