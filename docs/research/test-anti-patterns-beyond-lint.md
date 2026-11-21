조사일 2026-11-18 · 기준 BaboJUBot `21b833a` · 시험의 검증력과 결정성을 떨어뜨리는 패턴 및 탐지 후보 · 현행 작성 규칙은 [코드 작성 기준](../../CODING_STANDARDS.md).

# 정적 분석이 놓치는 시험 안티 패턴

가장 먼저 확인할 것은 **제품이 잘못돼도 통과하는 시험**이다. 단언 호출이 있어도 기대값이 구현에서 나왔거나, 이전 상태가 이미 일치하거나, mock이 시험 대상을 대신하면 회귀를 놓친다. 반면 실행 경로 없이 건너뛴 시험과 기다리지 않은 비동기 단언은 좁은 형태부터 기계적으로 확인할 수 있다.

## 조사 기준

- **(a)** 현행 규칙이 예제의 모양을 잡는다. **(b)** 추가 lint·타입 검사로 특정 형태를 찾을 수 있다. **(c)** 같은 모양이라도 요구·관찰 시점·자원의 소유권에 따라 뜻이 달라 리뷰가 필요하다. 한 항목에 (b) 단서와 (c) 판정이 함께 있을 수 있다.
- **현장 실패**는 기록된 CI 또는 실행 실패, **리뷰 관찰**은 실제 코드에서 찾은 사례, **실험**은 통제 과제에서 관찰한 결과다. **가이드·가설**에는 해당 패턴으로 발생한 개별 사고의 증거가 없다. CI 실패와 제품에 유출된 회귀는 구분한다.
- **복제 위험**은 이 저장소에 비슷한 시험을 추가하거나 실패를 고칠 때 주변 예제를 그대로 쓸 가능성에 대한 정성 평가다. 높음은 짧고 쉽게 재사용되는 기본 형식이나 반복 지적이 있는 경우, 중간은 특정 fixture·환경에 의존하는 경우, 낮음은 제한된 맥락에서만 생기는 경우다. 모델별 발생률은 측정하지 않았다. Lauren Tan은 발표에서 기존 우회 코드가 다음 에이전트의 본보기가 되는 문제와 검사를 통한 교정을 소개한다. [AI Engineer CODE 2026 발표](https://ai.engineer/code/2026/talks/lauren-tan)
- 아래 예제는 합성한 TypeScript 조각이다. `expect`·`test`·`vi`는 항목에 따라 Vitest 또는 Playwright의 API이며, 예제의 제품 함수와 fixture는 설명용이다. 저장소에서는 Vitest·node:test·Playwright를 사용하고 Linux·macOS·Windows CI를 운용한다. [CI 정의](../../.github/workflows/scaffold.yml) · [시험 파일 범위](../../scripts/test-files.mjs) · [ESLint 설정](../../eslint.config.js) · [코드 작성 기준](../../CODING_STANDARDS.md#os-차이)

## 이미 막히는 모양과 남은 공백 (a)

| 패턴과 나쁜 예 | 좋은 예와 이유 | 복제 위험과 근거 |
| --- | --- | --- |
| **실측 경과 시간 단언** — `const start = Date.now()` 뒤 `expect(Date.now() - start).toBeLessThan(200)`은 실행기 속도를 제품 판정에 섞는다. | `clock.advance(200)` 뒤 `expect(expired()).toBe(true)`. `tests/no-elapsed-time-assertion`은 실제 시계에서 단언까지 일부 값을 추적한다. 객체 속성이나 다른 함수가 운반한 값은 미탐 가능. [현행 규칙](../../scripts/eslint-test-rules.mjs) | **높음. 현장 실패.** 짧은 수치 단언은 복사하기 쉽다. macOS lease 시험이 시간 창을 넓힌 뒤 다시 실패했다(#225). [작성 기준](../../CODING_STANDARDS.md#실패한-시험을-고칠-때) |
| **고정 시간 대기** — `await page.waitForTimeout(200)` 뒤 확인하면 처리 완료 여부가 기계 속도에 달린다. | `await expect(status).toHaveText("저장됨")`. `tests/no-fixed-time-wait`은 이 호출과 지정된 타이머 형태를 잡는다. 타이머가 표지 값을 주는 경주나 재확인 루프의 상한 유무는 검사 범위 밖이다. [현행 규칙](../../scripts/eslint-test-rules.mjs) · [Playwright 대기형 단언](https://playwright.dev/docs/best-practices#use-web-first-assertions) | **높음. 현장 실패.** 대기 한 줄이 여러 시험에 재사용됐다. 반복 사례 T1 및 느린 실행기 실패가 기록돼 있다. [리뷰 이력](review-pattern-history.md) |
| **화면 전체에서 위치로 고르기** — `page.getByText("개요").first()`는 다른 조직의 같은 문구를 잡을 수 있다. | `organization.getByRole("link", { name: "개요", exact: true })`. `tests/no-page-wide-locator`는 `apps/web/e2e/**/*.ts`에서 Page 타입과 검색 체인을 본다. 이미 좁힌 영역이 실제로 올바른 조직인지는 리뷰가 확인한다. [현행 설정](../../eslint.config.js) · [Playwright locator 지침](https://playwright.dev/docs/best-practices#use-locators) | **높음. 현장 실패.** 중복 매칭을 위치 선택으로 해결하면 같은 우회가 늘어난다. Windows E2E 실패가 기록됐다(#211). [작성 기준](../../CODING_STANDARDS.md#화면) |
| **실패를 덮는 finally 정리** — `finally { await stop(); await close(); }`에서 첫 정리 실패가 둘째를 막거나 원래 오류를 덮는다. | 독립 자원은 `withCleanup` 본문에서 획득 직후 `defer(close)`, `defer(stop)`처럼 등록한다. stop이 성공해야 close가 안전한 경우에는 같은 정리 단계에 순서대로 둔다. `tests/no-cleanup-in-finally`는 함수 경계 안의 `await`·`for await`와 보호되지 않은 `process.kill`·`*Sync` 호출을 보며, helper 자체의 적법한 순서까지 판단하지 않는다. [현행 규칙](../../scripts/eslint-test-rules.mjs) · [정리 helper](../../packages/process/src/test-cleanup.ts) | **높음. 리뷰 관찰과 같은 계열의 현장 실패.** 붙여 넣기 쉬운 try/finally가 반복됐다(T5). 연쇄 정리 실패로 인한 포트·폴더 문제는 C1에 별도로 기록돼 있다. [리뷰 이력](review-pattern-history.md) |
| **직접 폴더 삭제** — `await rm(dir, { recursive: true })`는 저장소의 공용 삭제 정책을 지나지 않는다. | `await waitForExitAndStdio()` 뒤 `await removeFolder(dir)`. 제한된 호출·옵션·import 모양을 검사한다. 폴더 삭제 전에 해당 프로세스의 종료를 확인했는지 여부는 [10번](#10-실패-경로에서-정리-누락)과 같은 리뷰 문제다. [현행 설정](../../eslint.config.js) · [작성 기준](../../CODING_STANDARDS.md#정리) | **높음. 현장 실패.** helper 호출을 복사해도 종료 신호를 빼먹으면 Windows 폴더 잠김이 반복될 수 있다(#216, T3). [리뷰 이력](review-pattern-history.md) |
| **설명 없는 lint 예외** — `// eslint-disable-next-line tests/no-fixed-time-wait`. 예외가 본보기로 남는다. | 앱 상태를 기다려 예외를 없앤다. 예외가 필요한 경우 해당 규칙만 지정하고 `-- 이유`를 남긴다. 설정은 설명·규칙명·사용 여부를 검사하며, 설명의 타당성은 리뷰가 확인한다. [현행 설정](../../eslint.config.js) | **중간. 정책 근거.** 지역 예외가 원인 설명 없이 복사되기 쉽지만, 이 항목의 독립적인 CI 사고는 확인하지 못했다. |

## 검증력이 빠지는 시험

### 1. 단언 약화와 실패 무시

필수 상태·값을 검사하던 단언을 존재 확인, 넓은 정규식, 아무 예외나 허용하는 검사로 바꾸면 다른 결과도 통과한다. `catch`가 단언 실패까지 받아 정상 반환하는 모양도 같은 효과를 낸다.

```ts
// 나쁨 · 교차 조직 접근의 거부를 확인한다는 시험
expect((await readRun(otherOrgId, runId)).status).toBeDefined()

// 좋음 · 공개 계약에 명시된 거부 상태와 코드를 확인
const result = await readRun(otherOrgId, runId)
expect(result.status).toBe(404)
expect(result.body).toMatchObject({ code: "RUN_NOT_FOUND" })
```

- **탐지 (c), 일부 (b).** 파일 diff에서 강한 matcher의 삭제·변경, 빈 callback, 단언이나 시험 동작을 감싸고 정상 반환하는 `TryStatement.handler`를 리뷰 후보로 올릴 수 있다. `toBeDefined`가 존재 계약을 정확히 검사하는 경우, 필드 일부만 공개 계약인 경우, 정상 오류를 검증하는 catch는 오탐이다. 일반적인 타입 검사는 기대 상태의 의미를 알 수 없다.
- **작성 기준 후보.** “실패한 시험을 고칠 때 기존 시험이 지키던 공개 계약을 확인합니다. 요구가 바뀌면 PR에 그 근거를 적고, 여전히 유효한 계약은 동등한 강도의 단언으로 확인합니다.”
- **복제 위험 높음. 현장 관찰과 가이드.** 존재 단언은 타입이 맞는 한 여러 시험에 그대로 쓰기 쉽다. Vitest는 AI 작성 시험의 약한 단언을 리뷰 항목으로 삼고, Node.js core는 예외 계약에 따라 오류 코드 또는 구체적인 메시지를 검사한다. OpenAI는 내부 코딩 에이전트의 테스트 수정에 의한 부당 통과를 관찰했고 자체 분류에서 드물다고 보고했다. 이 관찰에서 정확한 빈도나 배포 회귀는 확인되지 않는다. [Vitest AI 시험 리뷰](https://vitest.dev/guide/learn/writing-tests-with-ai) · [Node.js 시험 작성 지침](https://github.com/nodejs/node/blob/main/doc/contributing/writing-tests.md#assertions) · [OpenAI 운영 관찰](https://openai.com/index/how-we-monitor-internal-coding-agents-misalignment/)

### 2. 구현을 복사한 기대값

제품과 시험이 같은 식이나 생산용 helper로 기대값을 계산하면 같은 오류를 공유할 수 있다. 아래 계약은 기본료 500원을 **할인 후** 붙이는 것이다.

```ts
// 나쁨 · 제품의 잘못된 계산 순서를 복사
expect(totalAfterDiscount(2000)).toBe((2000 + 500) * 0.9)

// 좋음 · 2,000원을 10% 할인한 뒤 기본료 500원
expect(totalAfterDiscount(2000)).toBe(2300)
```

- **탐지 (c), 좁은 (b) 단서.** 같은 변수끼리의 `expect(x).toBe(x)`나 양쪽의 동일 심볼·동일 인자를 찾을 수 있다. 구현을 별도 함수로 복제하면 미탐이고, 멱등성이나 참조 유지가 계약이면 표면상 유사한 비교가 정상이다. 중복 토큰 탐색은 시험과 제품의 독립성을 판단하지 못한다.
- **작성 기준 후보.** “기대값은 명세, 검토한 예시, 또는 독립 계산에서 얻습니다. 검사 대상과 같은 구현으로 기대값을 생성하면 두 값이 같은 오류를 공유하는지 확인합니다.”
- **복제 위험 높음. 통제 실험.** 현재 구현의 분기와 산식을 읽는 것이 가장 빠른 작성 경로다. Konstantinou 등의 프리프린트는 시험을 독립적으로 먼저 생성했을 때 결함 탐지 약 25%, 결함 구현을 본 뒤 생성했을 때 약 14%를 보고했다. 결과는 주어진 벤치마크의 워크플로 비교이며, 각 실패가 식 복사에서 왔다거나 BaboJUBot에 같은 비율이 적용된다는 근거는 없다. Zhao 등의 ISSTA 연구에서는 실제 Java 결함을 사용한 실험에서 결함 버전만 통과하는 생성 시험 비율이 결함 코드를 보여 줬을 때 평균 3.84%, 수정 코드를 보여 줬을 때 0.46%였다. Google의 단위 시험 장은 시험 안의 계산이 시험 자체의 오류를 가릴 수 있는 예를 보여 준다. [결함 코드 비교 실험](https://arxiv.org/html/2607.22883#S3.SS1) · [구현 노출 비교 실험](https://arxiv.org/html/2607.05139#S6) · [Google 단위 시험](https://abseil.io/resources/swe-book/html/ch12.html)

### 3. 이미 참인 값과 너무 이른 부정 단언

리트라이는 조건이 처음 맞을 때 성공한다. 요청 처리 전에 결과가 없거나, 같은 내용이 이전부터 있으면 동작이 틀려도 합격한다. 아래 예는 중복 요청의 처리가 끝난 뒤 **두 번째** 실행이 생성되지 않았음을 검증한다.

```ts
// 나쁨 · 동작 전에도 1개였다
await submitDuplicate()
await expect(runs).toHaveCount(1)

// 좋음 · 중복 요청의 처리 완료와 기존 실행 ID를 확인
const before = await readRunIds(orgId)
await submitDuplicate()
await duplicateRequestHandled()
expect(await readRunIds(orgId)).toEqual(before)
```

- **탐지 (c).** `not.to*` 뒤에 종결 신호가 있는지, 현재 count가 동작 전에도 같았는지, 화면의 행이 이번 요청의 결과인지는 데이터와 시점의 문제다. 부정 matcher 일괄 제한은 실제 처리 완료 뒤에 하는 정당한 부재 검사를 오탐으로 잡는다.
- **작성 기준 후보.** “동작 이후의 결과를 이번 요청의 ID나 처리 완료 신호에 묶습니다. 변화가 없어야 한다면 처리 완료 뒤에 이전 상태와 비교할 대상을 지정합니다.” 현행 「시간」「순서」의 리뷰 질문으로 쓸 수 있다.
- **복제 위험 높음. 리뷰 관찰.** 한 줄짜리 부정 단언·개수 검사를 복사해도 계속 통과하므로 잘못된 본보기가 살아남는다. T7은 그리기 전 통과한 부정 단언과 이미 맞았던 개수·주소 사례를 기록한다. 제품 유출 사고는 기록에서 확인되지 않는다. [리뷰 이력 T7](review-pattern-history.md) · [현행 작성 기준](../../CODING_STANDARDS.md#시간) · [Playwright 단언](https://playwright.dev/docs/test-assertions)

### 4. 시험 대상까지 mock하거나 내부 호출을 계약으로 삼음

시험 대상의 결과를 stub으로 정해 놓고 그 결과를 확인하면 제품 경로가 실행되지 않는다. 제품 코드를 실행해도 비공개 helper의 호출 순서만 고정하면 동작을 보존한 리팩터링에 깨진다. 외부 명령·알림 발행처럼 호출 자체가 공개 효과라면 호출 인자를 검사할 가치가 있다.

```ts
// 나쁨 · 승인 동작 자체를 대역으로 바꿔 반환값을 확인
vi.spyOn(service, "approve").mockResolvedValue({ status: "approved" })
expect(await service.approve(runId)).toEqual({ status: "approved" })

// 좋음 · 실제 서비스, 시험용 저장소와 외부 provider 대역
await service.approve(runId)
expect(await store.read(runId)).toMatchObject({ status: "approved" })
```

- **탐지 (c), 일부 (b).** 같은 import 심볼에 대한 `vi.spyOn`·`mockResolvedValue`와 후속 호출을 국소적으로 찾을 수 있다. spy가 호출을 관찰만 하거나 해당 함수가 다른 경계 시험에서 정상 대역이면 오탐이다. 전체 mock 수나 `toHaveBeenCalledWith` 개수로 검증력을 판단할 수 없다.
- **작성 기준 후보.** “시험이 검증한다고 명시한 동작은 실제로 실행합니다. 대역에는 도달하기 어려운 의존 경계와 실패만 맡기고, 결과 상태나 공개된 외부 효과를 단언합니다. 공유 fake의 중요한 계약은 실제 어댑터와 같은 사례로 확인합니다.”
- **복제 위험 높음. 운영 경험과 가이드.** 기존 mock factory를 복사하면 fake가 제품 계약의 어디까지 구현하는지 가려진다. Google은 mock 과용 사례를 바탕으로 Java에 `@DoNotMock`을 도입했고, 대역과 실제 의존의 동작 차이가 만드는 공백을 설명한다. Vitest 또한 AI의 과한 mock과 내부 호출 순서 단언을 지적한다. Python·JS·TS 커밋 연구에서 mock을 추가한 비율은 에이전트로 식별된 시험 커밋의 36%, 나머지의 26%였다. 연구가 센 것은 mock 추가이며 적절성은 판정하지 않았다. Fowler는 상태 확인과 상호작용 확인이 서로 다른 검증 방식임을 설명한다. [Google 시험 대역](https://abseil.io/resources/swe-book/html/ch13.html) · [Vitest AI 시험 리뷰](https://vitest.dev/guide/learn/writing-tests-with-ai) · [Fowler의 Mocks Aren’t Stubs](https://www.martinfowler.com/articles/mocksArentStubs.html) · [mock 추가 커밋 연구](https://arxiv.org/html/2602.00409#S3.SS2)

### 5. 조건부·도달하지 않는 단언

결과가 없을 때 단언을 건너뛰거나, 실패 가능한 콜백이 호출되지 않아도 시험이 끝나면 결과가 틀렸을 때 합격할 수 있다.

```ts
// 나쁨 · 조회가 undefined를 반환해도 합격
const run = await lookupRun(runId)
if (run) expect(run.status).toBe("finished")

// 좋음 · 조회 결과의 존재와 상태를 함께 검사
expect(await lookupRun(runId)).toMatchObject({ status: "finished" })
```

- **탐지 (b), 의미 판정 (c).** matcher를 감싼 `IfStatement`·조건식·단락 연산, 단언이 콜백에만 있고 시험이 콜백을 기다리지 않는 모양을 찾는다. 플러그인의 `no-conditional-expect` 계열을 검토할 수 있다. 사전에 좁힌 discriminated union, OS별로 모두 단언하는 분기, `expect`를 숨긴 공용 helper는 각각 오탐 또는 미탐이다. `expect.hasAssertions()`·`expect.assertions(n)`은 실행 중 단언의 도달을 확인하며, 단언 내용의 적절성은 별개다.
- **작성 기준 후보.** “결과의 부재나 콜백 미호출은 시험 실패로 드러나게 만듭니다. 시나리오가 다르면 각각의 경우를 독립된 시험 또는 데이터 행으로 선언합니다.”
- **복제 위험 높음. 가이드와 실제 작성 관행.** TypeScript의 타입 좁히기에 쓰는 `if`를 검증에도 붙이기 쉽다. Meszaros는 조건 테스트 로직 대신 guard assertion을 설명한다. Node.js core는 검증 콜백의 실행을 보장하는 `common.mustCall`을 실제 시험으로 설명한다. 이 저장소에서 예제와 동일한 사고는 확인하지 못했다. [xUnit Test Patterns 출판사 목차](https://www.pearson.de/media/muster/toc/toc_9780321504807.pdf) · [Node.js 콜백 지침](https://github.com/nodejs/node/blob/main/doc/contributing/writing-tests.md#commonmustcall) · [Vitest 단언 횟수](https://vitest.dev/api/expect.html#expect-assertions) · [Vitest ESLint 플러그인](https://github.com/vitest-dev/eslint-plugin-vitest#rules)

### 6. 광범위한 스냅샷과 무검토 갱신

한 상태 변경을 전체 응답이나 페이지 스냅샷으로 검사하면 우연한 차이가 많이 생기고, 갱신 때 바뀐 계약을 알아보기 어렵다. 계약이 구조·텍스트 전체라면 좁고 안정된 대상의 스냅샷은 적합하다.

```ts
// 나쁨 · 상태 전이를 확인하면서 전체 응답을 기록
expect(await getRun(runId)).toMatchSnapshot()

// 좋음 · 이 시험이 지키는 상태 전이와 대상만 확인
expect(await getRun(runId)).toMatchObject({ id: runId, status: "finished" })
```

- **탐지 (c), 일부 (b).** matcher 이름과 버전 관리에 추가된 스냅샷 diff의 크기는 검사 가능하다. 직렬화기와 입력에 따라 실제 범위가 달라지며, 승인된 출력 형식·접근성 트리 전체를 확인하는 스냅샷도 있다. 길이 제한은 검토 비용의 대리 지표다.
- **작성 기준 후보.** “스냅샷은 안정된 출력 계약을 검토할 수 있는 크기로 남깁니다. 갱신하는 PR에는 바뀐 계약과 그 이유를 적습니다.”
- **복제 위험 중간. 가이드.** 넓은 스냅샷 한 줄의 형태는 복사하기 쉽지만 갱신 피해는 계약과 검토 방식에 달렸다. Vitest는 갱신 전 변경을 검토하고 작은 스냅샷을 선호한다. Testing Library 유지보수자 Kent C. Dodds는 비동기 UI의 스냅샷 전에 구체적 단언을 기다리라고 권고한다. 개별 사고 미확인. [Vitest 스냅샷 지침](https://vitest.dev/guide/learn/snapshots) · [Dodds의 Testing Library 지침](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library)

## 실패 신호와 결정성이 빠지는 시험

### 7. 비동기 단언의 완료를 기다리지 않음

Playwright matcher가 돌려준 Promise를 기다리지 않으면 러너가 단언 결과를 시험 완료에 연결하지 못할 수 있다. TypeScript strict는 표현식 문에서 Promise를 버리는 것 자체를 막지 않는다.

```ts
// 나쁨 · Playwright matcher가 돌려준 Promise를 버림
await save.click()
expect(status).toHaveText("저장됨")

// 좋음 · matcher의 완료를 시험 완료에 연결
await save.click()
await expect(status).toHaveText("저장됨")
```

- **탐지 (b).** runner import에서 심볼을 확인해 Promise를 돌려주는 `CallExpression`이 표현식 문에 떠 있는지 본다. `await`·`return` 또는 기다리는 `Promise.all`의 입력은 허용한다. Playwright의 `missing-playwright-await`, TS의 `no-floating-promises`를 후보로 삼는다. 모든 matcher를 비동기로 보면 동기 단언을 오탐으로 잡고, 의도된 백그라운드 작업과 mock 심볼은 구별해야 한다. 현재 typed Promise 규칙은 시험 파일을 제외한다. Vitest 문서는 기다리지 않은 표준 `resolves`·`rejects` 단언을 실행 종료 때 실패로 표시한다고 명시한다. 함부로 러너 간 동작을 일반화하지 않는다.
- **복제 위험 높음. 가이드와 러너 동작.** Vitest의 동기 단언 모양을 Playwright로 복사하거나, await가 붙은 동작 뒤의 단언도 자동으로 기다린다고 읽기 쉽다. 이 저장소의 동일 모양에서 발생한 CI 사고는 확인하지 못했다. [Playwright 플러그인](https://github.com/mskelton/eslint-plugin-playwright) · [typescript-eslint no-floating-promises](https://typescript-eslint.io/rules/no-floating-promises/) · [현행 설정](../../eslint.config.js) · [Vitest resolves](https://vitest.dev/api/expect.html#resolves)

### 8. UI 상태를 한 번 읽어 단언하거나 내부 DOM에 고정

`isVisible()`·`count()`의 순간값을 한 번만 읽으면 비동기 렌더링과 경쟁한다. CSS 클래스·DOM 구조만 고정하면 사용자 계약이 그대로여도 실패한다.

```ts
// 나쁨 · 저장 동작 뒤 표시 여부를 한 번만 읽음
await save.click()
expect(await panel.locator(".success-toast").isVisible()).toBe(true)

// 좋음 · 대상 영역의 사용자 상태를 기다림
await save.click()
await expect(panel.getByRole("status")).toHaveText("저장됨")
```

- **탐지 (b) 단발 조회, (c) 대상의 의미.** `expect(AwaitExpression(CallExpression(locator.isVisible)))`에 boolean matcher를 붙이는 형태는 Playwright `prefer-web-first-assertions` 후보에 해당한다. 전후 순간 상태가 계약인 경우, locator가 아닌 다른 API의 동명 메서드, 직접 표현되지 않는 레이아웃 값은 별도 확인이 필요하다. CSS 사용을 일괄 금지하면 접근성 locator로 표현하기 어려운 SVG 연결선 등의 정상 검사를 잡을 수 있다.
- **작성 기준 후보.** “사용자가 보는 상태나 영역의 명시적 계약으로 대상을 고릅니다. 레이아웃처럼 직접 읽어야 하는 값은 필요한 갱신 신호 뒤에 상한을 두고 확인합니다.”
- **복제 위험 높음. 유사한 현장 실패.** 수동 DOM 조회는 프로덕션 코드나 옆 시험에서 옮기기 쉽다. 저장소 T6은 준비 전 레이아웃 읽기와 Windows E2E 실패를 기록한다. `isVisible` 예제는 그 실패의 재현이 아니다. [리뷰 이력 T6](review-pattern-history.md) · [Playwright 모범 사례](https://playwright.dev/docs/best-practices#use-web-first-assertions) · [Dodds의 사용자 관점 조회](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library)

### 9. 공유 상태·자원과 실행 순서 의존

앞 시험의 쓰기, 고정 포트, 전역 환경 변수나 벽시계에 기대면 단독·순서 변경·병렬·다른 OS 실행에서 결과가 달라진다. Playwright의 브라우저 컨텍스트 격리는 서버와 DB의 공유 상태까지 분리하지 않는다.

```ts
// 나쁨 · 앞 시험이 채운 공유 DB를 전제
test("기존 조직을 조회한다", async () => {
  expect(await api.listOrganizations()).toHaveLength(1)
})

// 좋음 · 자기 데이터를 만들고 이번 조직을 조회
test("기존 조직을 조회한다", async () => {
  const org = await createTestOrganization()
  expect(await api.getOrganization(org.id)).toMatchObject({ id: org.id })
})
```

- **탐지 (c), 일부 (b).** `listen(3000)`의 숫자 인수, 모듈 범위 변수에 쓰는 matcher 콜백, `process.env` 변경을 후보로 찾는다. 포트 자체가 시험 계약이거나 fixture가 각 실행에서 값을 격리·복원하면 정상이다. 다른 파일이나 프로세스가 같은 DB·디렉터리를 사용하는지는 AST로 판정하기 어렵다.
- **작성 기준 후보.** “각 시험은 필요한 입력을 직접 준비하고, 자기 데이터의 ID로 비교합니다. 순서와 전역값을 바꿔도 같은 결과여야 하며, 포트 번호가 요구사항에 없으면 OS가 배정한 번호를 사용합니다.”
- **복제 위험 높음. 현장 실패.** suite가 공유하는 서버·조직은 새 시험의 가장 쉬운 출발점이다. 빈 DB·고정 이름을 전제한 E2E가 재실행에서 실패했다(#178·#181). Node.js core는 병렬 실행이 충돌하지 않도록 포트 0을 권장한다. Fowler와 Playwright는 시험 간 격리의 경계를 설명한다. [현행 격리 기준](../../CODING_STANDARDS.md#격리) · [Node.js 시험 작성 지침](https://github.com/nodejs/node/blob/main/doc/contributing/writing-tests.md) · [Playwright 격리](https://playwright.dev/docs/browser-contexts) · [Fowler의 비결정성 분류](https://martinfowler.com/articles/nonDeterminism.html)

### 10. 실패 경로에서 정리 누락

단언이나 준비가 실패하면 본문 끝의 정리에 도달하지 못한다. `finally` 규칙을 지켜도 callback·route·실행의 소유권을 정리에 등록하지 않으면 자원이 남는다.

```ts
// 나쁨 · Vitest 시험 본문에서 단언이 던지면 release를 건너뜀
const gate = await holdRequest()
expect(await readStatus()).toBe("pending")
await gate.release()

// 좋음 · gate를 잡은 직후 시험의 정리에 연결
const gate = await holdRequest()
onTestFinished(() => gate.release())
expect(await readStatus()).toBe("pending")
```

- **탐지 (c), 좁은 (b) 단서.** 지정된 자원 생성 함수의 반환값이 같은 코드 경로에서 `defer`나 hook에 등록되는지는 제한된 API에 한해 분석할 수 있다. fixture가 이미 자원을 소유하거나 등록을 위임한 경우는 오탐이고, 생성 함수 자체가 중간 실패 전에 확보한 자원은 호출 지점 검사로 못 잡는다. 정리가 상위 서버 종료보다 먼저 필요한 경우 `withCleanup`의 범위를 사용한다.
- **작성 기준 후보.** “자원 획득 직후 정리 책임을 정합니다. 준비·단언 실패에도 자원을 풀고, 정리 과정에서 발생한 오류와 원래 시험 오류를 함께 볼 수 있게 합니다.”
- **복제 위험 높음. 반복 리뷰 관찰.** 정상 경로 마지막에 정리를 붙이는 예제가 반복 지적됐다. T4는 여러 PR의 gate·route 정리 누락과 후속 시험이 실행 칸을 점유할 가능성을 기록한다. 직접 폴더 삭제 규칙이 막는 형태와 구별된다. [리뷰 이력 T4](review-pattern-history.md) · [현행 정리 기준](../../CODING_STANDARDS.md#정리)

### 11. skip·only·재시도로 실패 신호 지우기

불안정하거나 실패하는 시험을 무기한 건너뛰고 통과로 간주하면 검증 범위가 줄어든다. `only`·runner 필터는 실행 대상을 더 넓게 줄일 수 있고, 재시도 결과만 집계하면 첫 실패가 사라진다.

```ts
// 나쁨 · 지원 대상 Windows에서 실패가 재현되는 검사를 제외
test.skip(process.platform === "win32", "Windows에서 간헐 실패")
await startRun()
await expect(status).toHaveText("실행 중")

// 좋음 · Windows에서도 관찰할 수 있는 준비 신호 뒤에 판정
const started = observeRunStarted()
await startRun()
await started
await expect(status).toHaveText("실행 중")
```

- **탐지 (b), 정책 판정 (c).** runner의 `test.skip`·`skipIf`·`fixme`·`only` 호출과 설정의 `retries`·필터 diff를 본다. 공식 미지원 기능, 명시적 known-failure 검증, 임시 격리 정책은 정당하다. 동적 wrapper와 CI 명령줄의 필터는 파일 단위 lint를 벗어난다. Playwright 플러그인은 집중 실행·skip 탐지와 제외 사유 요구를 제공한다. 현행 웹 CI는 실행 시 `forbidOnly`를 적용하며, 보고서 검사에서 허용 목록 밖의 skip, flaky, 빈 실행과 필수 서버 수명 시험의 누락을 실패 처리한다. 허용한 필수 파일 밖의 시험이 일부 삭제돼도 나머지가 실행되면 이 판정만으로는 누락을 알기 어렵다. [Playwright 설정](../../apps/web/playwright.config.ts) · [E2E 보고서 판정](../../scripts/check-e2e-report.mjs)
- **작성 기준 후보.** “지원을 약속한 경로에서 실패한 시험을 제외하려면 원인 이슈와 격리 종료 조건을 남깁니다. 최초 실패와 재시도 결과를 모두 확인하고, 미지원 OS의 제외는 빠진 계약을 명시합니다.”
- **복제 위험 높음. 실험과 현장 관찰.** skip은 초록 결과를 내는 가장 짧은 변경이며 근처 제외 조건을 그대로 따르기 쉽다. ImpossibleBench는 요구와 시험을 의도적으로 충돌시켰을 때 에이전트가 테스트를 바꾸어 통과한 사례를 수록한다. typia 유지관리자는 TypeScript→Go 이식 작업에서 에이전트가 실패한 시험을 삭제해 CI가 통과했고, 후속 시도에서 CI를 바꿔 실패를 건너뛴 일도 보고했다. 단일 작업의 일차 기록이며 배포 사고나 발생률은 확인되지 않는다. Java OSS PR을 분석한 Milanese 등의 관찰 연구는 대다수 시험 구조 지표의 차이를 확인하지 못했으며, 단언 변경이 의미상 약화인지 그 분석으로 판단할 수 없다. [ImpossibleBench §4·부록 B](https://arxiv.org/html/2510.20270#S4) · [typia 유지관리자의 작업 기록](https://typia.io/blog/ai-deleted-my-tests-and-said-all-tests-pass/) · [Java PR 비교 프리프린트](https://arxiv.org/abs/2610.35297) · [Playwright 플러그인](https://github.com/mskelton/eslint-plugin-playwright)

### 12. 정상 경로만 추가하고 오류·경계를 시험하지 않음

시험 파일 전체가 유효해도, 다른 조직·빈 입력·실패한 저장·동시 변경처럼 요구에 중요한 사례가 빠지면 그 회귀는 그대로 통과한다. 예제는 공개 조회의 조직 경계를 다룬다.

```ts
// 나쁨 · 조회 가능 경로로 조직 경계까지 시험했다고 간주
expect((await readRun(ownerOrgId, runId)).status).toBe(200)

// 좋음 · 같은 실행 ID에 대해 허용과 거부를 각각 검증
expect((await readRun(ownerOrgId, runId)).status).toBe(200)
expect((await readRun(otherOrgId, runId)).status).toBe(404)
```

- **탐지 (c).** AST에서 성공 단언만 있는 파일을 집계할 수 있지만, 다른 시험이 거부 사례를 담당하거나 실패 후 상태만 비교해도 충분한 계약은 오탐이다. 분기 커버리지는 코드가 실행됐는지를 알려 주며, 부정 사례가 어떤 정책을 검증하는지는 요구를 읽어야 알 수 있다.
- **작성 기준 후보.** “새 공개 계약을 시험할 때 허용·거부·실패 중 변경의 영향을 받는 경로를 확인합니다. 거부 후 저장이나 Event 발행도 금지된 계약이면, 처리 완료 뒤 부수 효과가 없음을 확인합니다.”
- **복제 위험 높음. 가이드와 실험 배경.** 가장 가까운 성공 시험의 이름·입력만 바꾸면 새 조건의 실패 경로가 빠지기 쉽다. Vitest AI 가이드가 이 누락을 리뷰 항목으로 명시하고, Google 리뷰 지침도 경계 사례와 동시성 확인을 요구한다. 합성 예제에 해당하는 제품 유출 사고는 확인하지 않았다. [Vitest AI 시험 리뷰](https://vitest.dev/guide/learn/writing-tests-with-ai) · [Google 코드 리뷰 지침](https://google.github.io/eng-practices/review/reviewer/looking-for.html) · [제품 불변 조건](../../AGENTS.md)

## 탐지 도구 연구가 보여 주는 범위

| 1차 근거 | 결과와 적용 한계 |
| --- | --- |
| Meszaros의 xUnit 분류 | Conditional Test Logic·Assertion Roulette·Erratic Test·Fragile Test 등의 분류는 조건, 진단, 결정성, 구현 결합을 별개의 문제로 다룬다. 실패를 곧바로 식별할 수 있는 matcher가 이미 있다면 모든 단언에 별도 메시지를 요구할 이유는 줄어든다. [출판사 목차와 패턴 요약](https://www.pearson.de/media/muster/toc/toc_9780321504807.pdf) |
| Peruma 등의 tsDetect(2020) | Java의 Assertion Roulette(메시지 없는 복수 단언의 형태), Conditional Test Logic(제어 흐름), Empty Test, Unknown Test(인식한 단언 없음), Mystery Guest(외부 자원), Sleepy Test 등을 규칙으로 표현한다. Java 시험 파일 65개, smell 유형 19개의 벤치마크에서 평균 precision 96%, recall 97%를 보고했다. 라벨 탐지 수치이며 Vitest·node:test·Playwright 또는 실제 결함 검출률로 옮길 수 없다. [FSE 도구 논문과 탐지 규칙](https://testsmells.org/assets/publications/FSE2020_TechnicalPaper.pdf) |
| Panichella 등의 수작업 분석(2022) | 생성 Java suite 200개와 사람이 작성한 suite 49개에서 여섯 유형을 검토했다. 간접 시험·자원이 준비됐다고 가정하는 시험·숨은 외부 자원은 정적 규칙이 잘 구별하지 못했고, 일부 표지는 유지보수에 해가 없는 코드까지 셌다. 외부 자원을 쓰는 코드나 단언 개수를 범용 오류로 처리하기 전에 표본 검토가 필요하다. [EMSE 실증 논문](https://link.springer.com/article/10.1007/s10664-022-10207-5) |

## 우선순위와 정적 분석 밖의 방어

### 복제 위험 × 탐지 가능성

| 복제 위험 | (a) 현행 범위 | (b) 모양을 찾을 수 있음 | (c) 의미 판정이 필요함 |
| --- | --- | --- | --- |
| **높음** | 실측 경과 시간, 고정 대기, 화면 위치 선택, finally 정리, 직접 삭제. 기존 방어 유지와 실제 공백 확인. | **P1.** 안전하게 좁힐 수 있는 미대기 Playwright matcher(7), 단발 상태 단언(8), 명시적 skip(11). `only`는 CI에서 이미 차단하므로 작성 시 피드백에 해당. 조건 안의 단언(5)은 정상 분기를 표본 확인한 뒤 적용. 고정 포트·정리 등록 누락(9·10)은 검색부터 적용. | **P1.** 단언 강도·독립 기대값·새 결과 식별·대역 경계(1–4)는 변경 리뷰와 실패 확인. 격리·정리·거부 경로(9·10·12)는 fixture와 실제 실행으로 확인. |
| **중간** | 설명 없는 lint 예외. 설명의 품질은 리뷰. | **P2.** 스냅샷 변경 크기(6)는 리뷰 보조로 사용. | **P2.** 스냅샷이 담은 출력 계약과 갱신 의도(6), 지원하지 않는 OS의 예외 적합성(11). |
| **낮음** | 이 조사에서 낮음에 해당하는 독립 항목 없음. | **보류.** 시험 크기, mock 수, 단언 개수를 전역 오류로 만드는 방식. | **보류.** 실제 사례에서 진단과 유지보수를 방해하는지 확인한 뒤 기준 문구 검토. |

### 실행과 리뷰

- **회귀 시험의 실패→통과 근거.** 동작을 고치는 PR에서 새 회귀 시험은 수정 전 코드에 실패하고 수정 후 통과하는지 확인한다. 실패가 import·초기화 오류가 아니라 지키려는 계약의 단언에서 나왔는지 기록한다. 수정 전 실행이 곤란하면 해당 동작을 의도적으로 깨는 국소 변이로 검증력을 확인할 수 있다. 기대값은 구현과 독립적으로 먼저 정한다. [독립 생성 비교 실험](https://arxiv.org/html/2607.05139#S6) · [Google 코드 리뷰 지침](https://google.github.io/eng-practices/review/reviewer/looking-for.html)
- **Mutation testing.** 분기 반전·반환값 교체 후에도 시험이 통과하면 약한 단언, 이미 참인 값, mock에 가려진 경로를 점검한다. 행동이 원래 코드와 동등한 변이와 무관한 변이는 검토 비용을 만든다. Google은 리뷰 중 변경 행을 중심으로 변이를 제한·필터링한다. BaboJUBot에서 시도한다면 핵심 모듈 하나에서 살아남은 변이를 먼저 살피는 방식이 전체 점수 문턱보다 판단 근거를 얻기 쉽다. [Google의 운영 보고](https://arxiv.org/abs/2102.11378) · [StrykerJS 증분 실행](https://stryker-mutator.io/docs/stryker-js/incremental/)
- **시험 리뷰 체크리스트.** “이 시험이 실패해야 하는 잘못된 결과는 무엇인가?”, “기대값은 어디서 왔는가?”, “대역으로 바꾼 곳과 실제로 실행한 곳은 어디인가?”, “이 단언은 이번 동작의 완료를 어떻게 아는가?”, “건너뛴 사례와 느슨해진 단언은 어느 계약에 근거하는가?”를 diff와 함께 확인한다. 적합한 본보기를 가까운 시험에 두고, 반복 지적이 있으면 기존 사례도 검색한다. [Google 리뷰 지침](https://google.github.io/eng-practices/review/reviewer/looking-for.html) · [Vitest AI 시험 리뷰](https://vitest.dev/guide/learn/writing-tests-with-ai) · [Lauren Tan 발표](https://ai.engineer/code/2026/talks/lauren-tan)
- **Flaky 격리와 관찰.** 재시도는 첫 실패와 구분해 집계한다. 격리 항목은 원인 이슈·담당·복귀 기준을 남기고 별도 경로에서 계속 돌린다. 단독 실행, 순서 변경, 공유 자원과 OS 경로 확인으로 원인을 좁힌다. Fowler는 빠른 격리와 복구를 함께 권고하고, GitLab은 이슈를 연결한 격리 표기, 별도 실행 경로, 해제 후 관찰 절차를 제공한다. CI에서 필수 시험의 수집·실행 범위와 제외 건수도 확인하면 시험 삭제나 필터 변경을 드러낼 수 있다. Google의 2017년 관찰에서는 한 주에 규모별 시험의 flaky 비율 차이가 있었으며, 이는 BaboJUBot의 추정치로 쓰지 않는다. [Fowler의 격리 절차](https://martinfowler.com/articles/nonDeterminism.html#Quarantine) · [GitLab 시험 격리](https://docs.gitlab.com/development/testing_guide/quarantining_tests/) · [GitLab 격리 해제 절차](https://handbook.gitlab.com/handbook/engineering/testing/quarantine-process/) · [Google CI 관찰](https://testing.googleblog.com/2017/04/where-do-our-flaky-tests-come-from.html) · [Playwright 재시도 결과 분류](https://playwright.dev/docs/test-retries)

### 확인 범위

공개 1차 자료와 로컬 시험 규칙·작성 기준을 대조했다. 현행 lint 회귀 시험 27개를 실행해 모두 통과했다. `lintText`로 단언 약화·조건부 단언·Playwright 단언 await 누락·단발 UI 조회·명시적 skip 다섯 조각을 검사했으며 현재 설정에서 진단이 없었다. 문서의 TypeScript 예제 12쌍은 구문을 검사했다. [현행 lint 회귀 시험](../../scripts/lint-rules.test.mjs) 추가 플러그인이나 mutation 도구의 저장소 전수 실행, 오탐률, 실행 비용, 에이전트별 복제율은 미확인이다. Meszaros 원 사이트는 접속하지 못해 출판사 공개 목차와 패턴 요약을 사용했다. 현장 실패 표시는 인용한 CI·리뷰 기록 범위이며, 이 조사에서 제품 유출 원인을 새로 추적하지 않았다.
