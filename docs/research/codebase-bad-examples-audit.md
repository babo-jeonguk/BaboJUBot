2026-11-18 · 기준 `168854a344e843decbca21075e2d4d77a357ed9c` (origin/main, PR #234 병합) · 범위 `apps/*/src/**`·`packages/*/src/**` 제품 코드 · 상태 정적 감사 완료, 수정·실행 재현 없음

# 제품 코드에서 에이전트가 따라 쓰기 쉬운 나쁜 본보기

| # | 패턴 | 반복 수 | 대표 위치 | 실제 위험 | 처리 분류 | 수정 크기 |
| --- | --- | ---: | --- | --- | --- | --- |
| 1 | 정리 오류가 원래 실패를 덮음 | 7 | `packages/db/src/client.ts:59`, `apps/server/src/main.ts:172` | 기동·쿼리 실패의 원인이 가려지고 일부 경로에서 같은 DB를 두 번 닫음 | 나 | 중간 |
| 2 | 보조 명령에 종료 상한이 없거나 시한에 신호만 보냄 | 5 | `packages/runtime/src/providers/recovery.ts:119`, `packages/runtime/src/providers/process.ts:147` | 시작·준비 확인·취소가 도구 종료에 매달림 | 다 | 중간 |
| 3 | 프로바이더별 임시 폴더 정리·실패 처리 분기 | 4 | `packages/runtime/src/providers/codex.ts:797`, `packages/runtime/src/providers/claude.ts:671` | 폴더가 조용히 남거나 결정한 실행 결과가 삭제 오류로 바뀜 | 나 | 중간 |
| 4 | 주기 확인이 진행 중인 확인 뒤에 매번 대기 | 2 | `apps/server/src/heartbeat.ts:38`, `apps/server/src/compaction.ts:91` | 느린 DB 작업이 풀린 뒤 밀린 조회가 연속으로 돎 | 나 | 중간 |
| 5 | 실행 시도별 중복 제거 상태에 정상 종료 정리가 없음 | 1 | `apps/server/src/app.ts:387` | 실행 시도당 상한을 지켜도 실행 이력에 비례해 Map이 커짐 | 나 | 작음 |
| 6 | 자원을 얻은 뒤 늦게 정리 범위에 들어감 | 1 | `packages/runtime/src/providers/opencode.ts:316` | 설정 쓰기·실행 시작 실패 때 폴더나 listener가 남음 | 나 | 중간 |
| 7 | 계약 상태 목록·판정을 소비자가 재선언 | 6 | `packages/db/src/compaction.ts:65`, `packages/contracts/src/research-map.ts:28` | 상태 추가 때 저장·표시·허용 조건 중 일부가 조용히 빠짐 | 나 | 작음 |
| 8 | 파일 종류를 확인한 뒤 같은 경로를 다시 읽음 | 2 | `packages/runtime/src/providers/codex.ts:134`, `packages/runtime/src/providers/antigravity.ts:83` | 동시에 바뀐 파일을 앞서 확인한 파일의 내용처럼 분류할 수 있음 | 다 | 중간 |
| 9 | 외부 JSON의 타입을 단언으로 붙임 | 2 | `apps/web/src/api.ts:175`, `packages/runtime/src/providers/recovery.ts:281` | 응답·복구 기록의 잘못된 필드가 타입을 믿는 호출부까지 내려감 | 가 | 중간 |
| 10 | 같은 외부 객체 변환 helper를 파일 안에 다시 만듦 | 2 (구현) | `packages/runtime/src/providers/record.ts:2`, `packages/runtime/src/providers/opencode.ts:41` | 객체 판정과 빈 값 처리의 변경이 갈라짐 | 나 | 작음 |
| 11 | 이벤트 대상의 DOM 타입을 확인 없이 단언 | 4 | `apps/web/src/shell.tsx:137`, `apps/web/src/research-map.tsx:940` | 대상에 따른 동작을 타입 검사 없이 호출하고 SVG 자손과 직접 대상의 차이가 흐려짐 | 나 | 작음 |
| 12 | 진입점 주석이 이미 바뀐 제품 계약을 안내 | 1 | `apps/server/src/app.ts:745` | 다음 경로를 구현할 때 최종 완료·중단 조직의 메시지 규칙을 잘못 옮김 | 나 | 작음 |

반복 수는 아래에 열거한 독립된 구현 또는 호출 지점의 수다. 3번은 정리 정책을 고르는 프로바이더 경로, 10번은 같은 helper의 정의를 셌다. 3번의 **삭제 정책**과 6번의 **정리 범위에 도달하지 못하는 경로**는 각각 따로 셌다. 가는 규칙으로 막을 수 있는 모양, 나는 코드 수정, 다는 작성 기준에 판단을 기록할 사안이다. 수정 크기와 동작 변경은 제안 기준이다. 위험은 코드에서 따라간 실패 경로이며 발생 빈도는 측정하지 않았다. 기준은 [현행 lint](../../eslint.config.js), [코드 작성 기준](../../CODING_STANDARDS.md), [전체 구조](../architecture.md), [용어집](../../GLOSSARY.md), [반복 지적 조사 C1–C9·5절](review-pattern-history.md)이다.

## 상세

### 1. 정리 오류가 원래 실패를 덮음 (C1)

- **어디서 반복되나** 같은 DB 수명 경로에서 `packages/db/src/client.ts:59`(embedded DB 연결 실패 뒤 `stop`), `:84`(작업 실패 뒤 `client.end`), `:105`(pool 닫기 실패 뒤 `release`), `:119`(migration 오류 뒤 `close`). `packages/db/src/embedded.ts:92`(초기화·이전 DB 확인 실패 뒤 정리), `:546`(임시 DB 소유권 확보 실패 뒤 삭제), `apps/server/src/main.ts:172`(HTTP 서버 시작 실패 뒤 DB 닫기)도 앞선 오류가 뒷단 정리 오류로 바뀔 수 있다. 임시 DB도 서버 진입점 옵션에서 사용한다(`apps/server/src/main.ts:89`).
- **왜 고치나** migration 실패는 `connect`의 `close`를 거쳐 cluster를 멈춘 뒤 `openDatabase`의 `catch`에서 다시 `stop`에 닿는다. `packages/db/src/embedded.ts:110`의 `stop`은 호출마다 정지를 시작한다. 부팅 진단에서 원인과 후속 오류를 모두 잃기 쉽고, 이 구조를 따라 쓰면 자원이 어디서 닫히는지도 갈린다.
- **좋은 형태** `apps/server/src/app.ts:1358`은 시작 오류를 다시 던지고 정리 오류를 따로 기록한다. 서로 독립인 정리 단계만 모아 수행하는 예는 `:1317`의 `AggregateError`다. 시작 경로에서는 `await close().catch(reportCleanup); throw startError`처럼 두 오류를 남기고, DB handle 취득 전후 어느 쪽이 cluster를 닫는지 한 곳에서 정한다.
- **처리** 나 · 중간 · 성공 동작 유지. 이중 실패에서 표면에 남는 오류와 DB 정지 호출 횟수가 바뀐다.

### 2. 보조 명령에 종료 상한이 없거나 시한에 신호만 보냄 (C4)

- **어디서 반복되나** `packages/runtime/src/providers/recovery.ts:119`(복구 중 동기 시작 시각 조회), `:224`(Windows 복구 중 동기 `taskkill`), `:176`(비동기 시작 시각 기록), `:50`(일반 종료 경로의 Windows `taskkill`)에는 호출 상한이 없다. `packages/runtime/src/providers/process.ts:147`에서는 시한·취소가 기본 종료 신호만 보내며, 반환 Promise는 자식의 `error`·`close`에서만 정해진다. Claude Code·Codex·Antigravity가 이 공용 구현을 이용한다(`claude.ts:236`, `codex.ts:355`, `antigravity.ts:192`, 같은 폴더).
- **왜 고치나** 동기 복구 명령이 돌아오지 않으면 `apps/server/src/app.ts:1330`의 시작 흐름과 서버 이벤트 루프가 멈춘다. 보조 프로세스에 취소 신호를 보내도 프로세스나 그 출력이 닫히지 않으면 대기가 끝나지 않는다. 준비 확인과 모델 목록 호출부에는 각각 응답 시한이 있지만(`apps/server/src/readiness.ts:155`, `packages/runtime/src/providers.ts:89`), 그 시한은 보조 프로세스의 회수를 확인하지 않는다.
- **좋은 형태** 호출자 종료 시점과 자원 정리 시점을 함께 설계한다. 예를 들어 `queryProcess(pid, { signal, deadline })`은 예산 만료를 결과로 돌려주고, 소유한 보조 명령은 종료를 확인하며 회수하지 못하면 기록을 남긴다. `apps/server/src/isolation.ts:149`는 요청 결과의 상한과 늦게 끝나는 자원 정리를 구별한다. `packages/runtime/src/providers/container.ts:480`은 보조 명령 옵션에서 시한·취소를 전달하는 예다.
- **처리** 다 · 중간 · 보조 명령의 완료 상한·취소 후 상태·잔여 기록을 호출 경계에 쓰도록 작성 기준을 추가한다. 지연이나 취소 상황에서 완료 시점과 진단이 바뀐다.

### 3. 같은 임시 폴더의 정리 정책이 프로바이더마다 갈림 (C1·오류 삼킴)

- **어디서 반복되나** `packages/runtime/src/providers/codex.ts:797`과 `packages/runtime/src/providers/antigravity.ts:592`는 폴더 삭제의 모든 실패를 버린다(Antigravity의 실행 시도 폴더와 로그 폴더는 한 정책). `packages/runtime/src/providers/claude.ts:671`과 `packages/runtime/src/providers/opencode.ts:382`는 삭제를 기다리며 실패를 그대로 던진다. OpenCode의 호출부는 `:884`다. 네 경로 모두 재시도 없는 재귀 삭제를 쓴다.
- **왜 고치나** 잠깐 파일이 잠겨도 Codex·Antigravity 폴더가 기록 없이 남을 수 있고, Claude Code·OpenCode는 이미 결정한 결과를 정리 예외로 바꿀 수 있다. 이후 어댑터가 어느 쪽을 본보기로 삼느냐에 따라 같은 운영 장애가 서로 다르게 보인다. 정리 결과와 실행 결과의 관계를 이 네 지점에서 명시한 근거는 찾지 못했다.
- **좋은 형태** `await removeOwnedAttemptFolder(folder).catch(reportCleanupFailure)`처럼 종료와 쓰기 완료를 확인한 뒤 제한된 재시도 및 진단을 공통으로 처리한다. `packages/runtime/src/remove-folder.ts:17`의 시험 폴더 helper가 재시도 대상과 소진 기준의 본보기다. 결과와 별도로 알릴 진단에는 폴더 종류·연결·실행 시도 ID를 쓰고 파일 내용은 담지 않는다. 회수 실패가 실행 시도에 미칠 영향은 자원 종류별로 정한다.
- **처리** 나 · 중간 · 삭제 실패에서 진단·재시도와 일부 실행 시도의 반환 결과가 바뀐다.

### 4. 주기 확인마다 느린 이전 확인 뒤에 새 작업을 붙임

- **어디서 반복되나** `apps/server/src/heartbeat.ts:38`의 타이머는 매번 `tick`을 시작하고 `:47`에서 이미 진행 중인 확인을 기다린다. `apps/server/src/compaction.ts:91`·`:100`도 같은 방식으로 `scan`을 시작하고 기다린다.
- **왜 고치나** 동시에 DB를 두드리지는 않지만, 확인 하나가 여러 주기에 걸치면 주기마다 Promise가 대기한다. 기존 작업이 끝나면 대기 호출이 각각 새 조회를 수행한다. 두 조회 모두 실행 시점의 DB 상태를 읽으므로, 지나간 주기마다 별도로 최신 상태를 훑는 비용이 생긴다.
- **좋은 형태** 자동 주기 호출은 진행 중이면 후속 확인 하나만 예약한다. `apps/server/src/notifications.ts:57`의 `kick`이 `running`과 단일 `again` 표시를 쓰는 예다. 직접 기다리는 `tick` 호출은 자신이 기다릴 확인과 완료 조건을 유지한다.
- **처리** 나 · 중간 · 느린 확인 뒤 몰리는 자동 조회 횟수가 줄어든다. DB가 정한 예정 시각과 깨우기·정산 규칙은 유지한다.

### 5. 실행 시도별 중복 제거 상태를 정상 종료에서 버리지 않음

- **어디서 반복되나** `apps/server/src/app.ts:387`의 Map 하나다. `:416`부터 실행 시도별 Set을 만들고 키는 50개로 제한한다. 삭제는 거부 기록을 **쓰려고 시도한 뒤** 저장소에서 Event를 받지 못했을 때(`:432`)만 한다. 기존 Event 구독은 `:393`에서 `run.*`을 전부 건너뛴다.
- **왜 고치나** 진행 중 거부 기록 저장에 성공한 실행 시도가 끝나고 추가 거부가 들어오지 않으면 해당 Set이 계속 남는다. 또 Set에 기록한 뒤 DB 쓰기가 실패하면 `:435`에서 실패를 버려, 같은 거부가 다시 와도 그 키의 기록을 재시도할 수 없다.
- **좋은 형태** 실행 시도의 종료를 관찰하는 쪽이 해당 Set을 버리고, 종료 이후 도착한 호출은 Map을 다시 만들지 않게 한다. `onRunFinished(runId) → refusalKeys.delete(runId)`를 정상 경로에 둔다. 쓰기를 중복 실행하지 않도록 보류 키를 먼저 잡되 실패하면 키를 풀고 진단하는 방식으로 저장 결과와 중복 제거를 맞춘다. 종료 Event는 `packages/contracts/src/event.ts:151`에 있다.
- **처리** 나 · 작음 · 정상 종료 뒤 메모리 보존과 DB 실패 뒤 재시도 여부가 바뀐다. `apps/server/test/isolation.test.ts:817`은 거부 이유가 활동에 보이는 동작을 검사한다.

### 6. 준비를 끝낸 뒤에야 실패 정리 범위에 들어감 (C1)

- **어디서 반복되나** `packages/runtime/src/providers/opencode.ts:316`에서 폴더를 만든 뒤 설정 파일을 쓰고, abort listener를 달고(`:331`), 프로세스를 띄운 뒤(`:337`)에야 `:382`에서 `close`를 정의하고 `:390`의 `try`로 들어간다. 같은 `launch`의 자원 획득 경로 하나를 셌다.
- **왜 고치나** 파일 쓰기 실패는 폴더를 남긴다. `startProcess`가 동기 예외를 던지는 경우에는 등록한 listener도 해제 경로에 닿지 않는다. 호출자의 실행 실패 처리만으로는 그 단계에서 잡은 자원을 회수할 수 없다.
- **좋은 형태** 첫 `mkdtemp` 직후 준비 작업을 `try`에 넣고, 이후 얻은 listener와 프로세스는 있는 것만 닫는다. 준비 성공 시 반환 handle에 정리 책임을 넘기고 준비 실패 시 그 자리에서 정리한다. `packages/runtime/src/providers/codex.ts:483`·`:797`은 준비 중간부터 잡은 권한과 폴더를 바깥 범위에서 거두는 예다.
- **처리** 나 · 중간 · 설정 쓰기·프로세스 시작 실패에서 회수와 진단이 바뀐다.

### 7. 계약에서 정할 목록과 판정을 다시 씀 (C7)

- **어디서 반복되나** `packages/db/src/compaction.ts:65`, `:155`, `:188`은 `isClosedStage`의 두 상태를 각자 비교한다. `packages/contracts/src/run.ts:42`는 전체 실행 시도 상태 목록에 이미 있는 프로바이더 종료 사유를 별도 리터럴로 쓰고, `packages/db/src/dashboard.ts:51`은 계약에 이미 있는 저장 종료 사유(`runEndReasonSchema`)를 필터와 타입 술어로 재구성한다. `packages/contracts/src/research-map.ts:28`은 폐기를 제외한 전체 연구 노드 상태를 다시 쓴다.
- **왜 고치나** 새 상태나 종료 사유를 추가해도 여러 배열과 개별 비교가 나란히 누락될 수 있다. 압축에서는 신청·결과 반영·lease 확인의 판정이 갈라질 수 있다. 현재 열어 본 값은 서로 일치한다.
- **좋은 형태** 압축에서 `isClosedStage(org.stage)`를 사용한다(`packages/contracts/src/organization.ts:31`). 대시보드는 `runEndReasonSchema.options`를 쓰는 웹(`apps/web/src/dashboard.tsx:151`)을 따른다. 실행 시도 목록은 프로바이더의 종료 사유에 저장 전용 값을 합성하고, 연구 노드 편집 스키마는 `researchNodeStatusSchema.exclude(["discarded"])`에서 얻을 수 있다. 배열 순서가 소비자에 표시되는 곳에서는 같은 순서를 유지한다.
- **처리** 나 · 작음 · 기존 값·순서·판정을 유지하는 변경이다.

### 8. 확인한 파일과 실제로 읽는 파일이 서로 다른 시점의 경로 (C5)

- **어디서 반복되나** `packages/runtime/src/providers/codex.ts:134`·`:136`과 `packages/runtime/src/providers/antigravity.ts:83`·`:84`는 `lstat`으로 일반 파일을 확인한 뒤 경로 문자열을 다시 열어 로그인 자리 표시인지 판정한다.
- **왜 고치나** 두 호출 사이에 파일이 정상적으로 교체되거나 사라지면 확인한 엔트리와 읽은 내용의 대응이 깨진다. 두 함수 모두 읽기·해석 실패를 `false`로 돌려주며, 공통 호출부는 같은 값을 자리 표시가 아닌 파일의 결과에도 쓴다(`packages/runtime/src/providers/file-login.ts:83`·`:105`·`:127`). **[확인 필요]** 정상적인 동시 교체가 실제 운영에서 이 경로를 얼마나 자주 타는지는 재현하지 않았다.
- **좋은 형태** 같은 파일 핸들에서 파일 종류와 내용을 확인한다. 부재·읽기 오류·형식 불일치의 처리 결과를 호출부에서 구분할 필요도 함께 살핀다. 한 번 연 파일을 기준으로 판단하는 본보기는 `apps/server/src/workspace.ts:298`의 산출물 읽기다. 그 경로의 별도 프로세스와 경계 정책은 산출물에 맞춘 설계다.
- **처리** 다 · 중간 · 작성 기준에 검사와 실제 사용의 대상이 같아야 하는 경우를 적는다. 동시 교체나 읽기 오류 때의 분류가 바뀔 수 있다.

### 9. JSON의 실제 모양보다 타입 단언이 앞섬

- **어디서 반복되나** `apps/web/src/api.ts:175`의 실패 응답은 본문 해석 성공 뒤 `error.code`를 확인 없이 문자열로 취급한다. `packages/runtime/src/providers/recovery.ts:281`·`:289`는 디스크 JSON을 `Partial<ProcessRecord>`로 단언하고 PID만 검사한 뒤 전체 타입으로 좁힌다. 이력에서 오래된 기록과 새 기록을 읽으므로 일부 필드의 부재는 아래 복구 분기에서 의도적으로 다룬다.
- **왜 고치나** 숫자나 객체인 HTTP 오류 코드가 `ApiError.code`에 들어가면 호출부가 코드에 따라 보여 주는 처리가 어긋난다. 복구에서는 예컨대 문자열이 아닌 `lease`가 전체 타입을 믿는 `recoverRecord`로 넘어간다(`:303`). 형식 오류와 지원하는 레거시 형식을 입구에서 구분할 수 있어야 한다.
- **좋은 형태** `const raw: unknown = await response.json(); const parsed = errorSchema.safeParse(raw);`처럼 파싱과 검증을 구별한다. `packages/runtime/src/tools-client.ts:80`은 HTTP 실패 본문의 본보기다. 복구 기록의 본보기는 `packages/db/src/embedded.ts:512`의 필드 확인이며, 기존에 인정한 생략은 선택 필드로 표현한다.
- **처리** 가 · 중간 · 저장소 ESLint의 AST 규칙으로 `JSON.parse(...)`·`response.json()` 결과를 직접 객체 타입으로 단언하는 모양을 좁게 지적할 수 있다. 이 규칙은 별도 변수에 저장한 뒤의 단언까지 검증하지 않는다. 입력 계약에 맞는 값의 결과는 유지하고, 비정상 HTTP 본문·복구 기록의 처리가 바뀐다.

### 10. 같은 외부 객체 변환을 별도 함수로 복제

- **어디서 반복되나** `packages/runtime/src/providers/record.ts:2`의 `record`와 `packages/runtime/src/providers/opencode.ts:41`의 `object`는 값이 객체면 `Record<string, unknown>`으로 보고 그 외에는 빈 객체를 반환한다. Codex·Antigravity·Claude Code의 대화 분석은 공용 함수를 가져온다.
- **왜 고치나** 새 어댑터가 가까운 지역 구현을 베끼면 객체 모양과 기본값 처리의 변경이 여러 곳으로 늘어난다. 지금 두 함수의 반환 규칙은 같다.
- **좋은 형태** OpenCode에서 `import { record } from "./record.ts"`를 사용하고 내부에서 필요한 필드 확인을 이어 간다.
- **처리** 나 · 작음 · 반환값과 호출 동작을 유지한다.

### 11. 이벤트 대상을 `HTMLElement`로 단언하고 사용

- **어디서 반복되나** `apps/web/src/shell.tsx:137`·`apps/web/src/chat.tsx:129`·`apps/web/src/research-map.tsx:940`에서는 `target` 단언 뒤 바로 `closest`를 호출한다. `apps/web/src/agents.tsx:574`는 배열의 요소와 비교하기 위해 같은 단언을 한다. 마지막 지점에는 즉시 메서드를 부르는 위험은 없고 그대로 복제하기 쉬운 타입 처리만 있다.
- **왜 고치나** React 이벤트의 `target`은 등록한 요소와 다르다. 위임된 이벤트의 SVG 자손에는 `Element`의 탐색 기능이 있고, `Element`가 아닌 대상으로 처리기가 불리면 해당 메서드 호출은 실패한다. 현재 사용자 동작 중 실패하는 장면은 확인하지 않았다.
- **좋은 형태** 위임한 탐색은 `const target = event.target; if (!(target instanceof Element)) return; const link = target.closest("a");`로 좁힌다. 포커스 동작은 탐색 **결과**가 `HTMLElement`인지 확인한다. 탭 배열에서는 `tabs.findIndex(tab => tab === e.target)`처럼 비교에 필요 없는 단언을 뺄 수 있다.
- **처리** 나 · 작음 · 요소가 아닌 대상을 무시하는 경로가 생기며 평소 링크·키보드 동작은 유지한다.

### 12. 진입점의 주석이 이전 메시지 계약을 설명

- **어디서 반복되나** `apps/server/src/app.ts:745`의 `findChat` 주석 한 곳. 끝난 조직에서 `중단하고 보내기`만 409라고 썼지만, `packages/db/src/conversations.ts:270`의 저장 경로와 `packages/contracts/src/owner-actions.ts:28`의 판정은 전달 방식과 관계없이 새 메시지를 거부한다.
- **왜 고치나** 조회 helper의 주석에 남은 이전 쓰기 규칙을 바탕으로 별도 입력 경로를 구현하면 최종 완료·중단 조직에서 잘못된 조건을 복제할 수 있다. 실제 판정은 이미 최신 계약을 따른다.
- **좋은 형태** 조회 helper에는 끝난 조직도 조회할 수 있다는 사실과 조직 범위만 둔다. 쓰기 계약이 필요하면 `newMessageRefusal`을 가리킨다. `apps/web/src/chat.tsx:953`은 공유 판정의 위치를 안내하는 예다.
- **처리** 나 · 작음 · 주석만 바뀐다. `apps/server/test/conversations.test.ts:466`·`:470`은 주석이 아니라 현재 거부 동작을 확인한다.

## 확인했으나 의도됨

- **C1·5절, 정리 순서와 오류 격리.** `packages/db/src/embedded.ts:420`의 임시 DB 디렉터리·소유권 기록 삭제 순서에서는 DB 디렉터리 제거가 실패하면 소유권 기록이 남는다. `apps/server/src/readiness.ts:103`은 실패한 저장이 다음 저장의 시작을 막지 않도록 대기열에 실패를 흡수한 Promise를 넣고, 같은 저장의 원본 Promise를 기다리며 `:109`에서 오류를 기록한다.
- **C2–C4, 별도 자식 프로세스와 응답 시한.** `packages/runtime/src/providers/process.ts:86`의 프로바이더 환경은 필요한 값부터 만들고, `:319`는 stdin 오류를 관찰한다. 대화형 로그인은 사용자가 자기 터미널에서 마칠 때까지 기다리며 시작 오류를 처리한다(`packages/runtime/src/providers/login.ts:99`). Codex 모델 목록은 모든 페이지를 받은 경우만 사용한다는 정책이 코드에 적혀 있다(`packages/runtime/src/providers/codex.ts:404`·`:438`). [프로바이더 운영 안내](../providers.md#세션과-정리)
- **C5, 확인과 사용의 경계.** 사용자 산출물은 경로를 따라 확인한 대상과 같은 파일을 읽는 별도 경로를 사용한다(`apps/server/src/workspace.ts:298`·`:307`). 서버 소유 폴더의 조직 표식 읽기(`:515`)는 별도의 신뢰 전제를 따른다. [전체 구조의 조직 경계](../architecture.md#제품-불변-조건-강제-위치)
- **C7, 확인되는 계약 중복.** `packages/contracts/src/dashboard.ts:84`의 깨우기 목록은 `satisfies`와 `Exclude`로 추가·누락 양쪽을 검사한다. 조직 지도 편집 허용 단계의 웹 표시(`apps/web/src/research-map.tsx:271`)와 실제 저장 규칙(`packages/db/src/research-map.ts:157`)은 같은 계약 목록을 따르며 저장 쪽이 강제한다.
- **5절, 입력의 출처가 확정된 단언.** `apps/web/src/research-map.tsx:207`에서 자체 생성한 배치 키만 `:212`에서 읽는다. `apps/server/src/in-flight.ts:58`은 Express 내부 stack을 사용하는 이유와 의존하는 버전 동작, 검사 위치를 명시한다.
- **C8, 같은 낱말의 다른 의미.** `packages/runtime/src/providers/job-object.ts:16`의 묶음 실행기는 실제 Windows 실행기다. `packages/runtime/src/providers/codex.ts:270`의 대화 기록은 제품의 사용자 대화와 다른 Codex 프로바이더 자료다. `apps/web/src/api.ts:1075`의 ‘다음 실행 시도에 반영’은 작업 댓글 설명의 서술어다. 셋 모두 용어집이 피하라고 한 제품 개념의 이름으로 쓰이지 않았다.

## 보지 못한 범위

- 시험·시험 helper·E2E는 위에 인용한 제품 동작 확인 위치만 읽었다. 별도 감사 대상인 CI와 개발 스크립트(C9), 문서·코드 지도 전체의 정합성(C6), migration 파일과 제품 `src` 밖의 코드는 포함하지 않았다.
- 제품 코드는 패턴 검색과 해당 호출 경로의 정적 추적으로 확인했다. 모든 함수 본문을 줄 단위로 읽는 전수 감사, 모든 package export의 외부 사용 여부, 화면 스타일의 중복, OS별 파일 잠금·프로세스 종료의 실측은 하지 않았다. 표의 숫자는 읽어서 확인한 지점이다.
- **[확인 필요]** 호스트의 `ps`·PowerShell 보조 조회가 전체 환경을 받는 지점은 확인했다(`packages/runtime/src/providers/lease.ts:123`, `packages/runtime/src/providers/recovery.ts:109`, `packages/db/src/embedded.ts:327`). 이 조회가 OS별로 실제로 필요로 하는 환경 값은 검증하지 않았다.
- 정적 분석 규칙을 추가하거나 성능을 계측하지 않았다. 빌드·시험·CLI·실제 프로바이더 실행은 하지 않았다.
