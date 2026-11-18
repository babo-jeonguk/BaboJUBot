조사일 2026-11-18 · 범위 BaboJUBot `168854a`의 현행 검사에서 빠지는 AI 코딩 에이전트 안티 패턴 · 상태 조사 완료, 채택 판단 전(기존 도구 실험은 [정적 분석 규칙 조사](static-analysis-rules-references.md)).

# AI 코딩 에이전트의 안티 패턴과 현행 검사 공백

| 패턴 | 출처 | 현재 규칙으로 잡히나 | 기계 판정 수단 | 오탐 위험 | 리뷰 기록 대응 |
| --- | --- | --- | --- | --- | --- |
| [조직·승인 조건 누락](#조직승인-조건-누락) | [E1](#e1)·[E7](#e7), 제품 불변 조건 | 일부. 특정 import·후속 호출 모양만 검사 | 공개 진입점에서 거부·미저장·이벤트 부재를 검증 | 호출명·폴더만 제한하면 이미 범위가 확인된 정상 호출도 잡음 | C5 경계와 인접, 직접 대응 없음 |
| [오류를 성공·빈 결과로 바꿈](#오류를-성공빈-결과로-바꿈) | [E3](#e3) | 일부. `no-empty`는 빈 블록만 보고 반환값의 의미는 모름 | ast-grep·Semgrep으로 fallback 위치 검색, 실패 주입 시험 | 계약이 허용한 데이터 부재·일시적 실패도 검색됨 | C1·C3·C9 인접 |
| [정리 연쇄가 끊기거나 원인 오류가 가려짐](#정리-연쇄와-프로세스-수명) | [E1](#e1), 기존 [E01·E02·E19](static-analysis-rules-references.md#e01) | 일부. 폴더 삭제 API와 일부 `finally` 제어문 검사 | 연속 `await` 구조 검색, 단계별 실패 주입 | 다음 단계가 앞 단계 성공을 요구하면 중단이 정상 | C1·T4·T5 |
| [프로세스 환경·입력 오류·시한 누락](#정리-연쇄와-프로세스-수명) | [E1](#e1)·[E4](#e4), 기존 [E03~E08](static-analysis-rules-references.md#e03) | 일부. 런타임 실행 위치 제한, 환경·수명 계약은 별도 | 환경 복사·호출 모양 검색, 격리·동시 종료·상한 시험 | 의도적 환경 상속·장기 감독·외부 시한 | C2·C3·C4·T9 |
| [Promise 거부 방치](#promise-거부-방치) | 기존 [E05~E07](static-analysis-rules-references.md#e05), [E3](#e3) 인접 | 못 잡음. 해당 typed 규칙은 꺼져 있음 | `no-floating-promises`·`no-misused-promises`, 관찰 가능한 실패 시험 | 이미 오류를 기록하는 비동기 후속 작업 | C3 인접 |
| [외부 데이터의 타입·존재 단언](#외부-데이터의-타입존재-단언) | [E2](#e2)·[E4](#e4) 인접 | 일부. `any` 사용·객체 리터럴 단언을 막지만 일반 `as`·`!`는 통과 | `no-unsafe-type-assertion`·`no-non-null-assertion`, 경계 입력 시험 | 외부 제약이나 라이브러리 계약이 타입에 표현되지 않은 경우 | C5·C7 인접 |
| [타입이 맞는 외부 경로를 그대로 신뢰](#타입이-맞는-외부-경로를-그대로-신뢰) | [E3](#e3)·[E4](#e4) | 못 잡음. `string`은 경계 검증 여부를 표현하지 않음 | 승인된 읽기 경계와 지정 출처·도달 지점 분석, 경계 계약 시험 | 내부에서 생성했거나 이미 검증된 경로 | C5 경계 인접 |
| [확인 후 사용 사이의 상태 변경](#확인-후-사용-사이의-상태-변경) | [E1](#e1), 기존 [E09](static-analysis-rules-references.md#e09) | 못 잡음. 상태의 변화와 순서를 분석하지 않음 | 동일 자원 구조 검색, 경쟁 순서를 고정한 통합 시험 | 존재 자체가 관찰 목표이거나 자원 변경이 불가능한 경우 | C5·T8·T10 |
| [기존 구현·계약 목록 복제](#기존-구현계약-목록-복제) | [E1](#e1)·[E5](#e5)·[E6](#e6) | 일부. switch 누락은 검사, 별도 목록과 함수 복제는 통과 | jscpd 토큰 비교, 원본으로부터 파생하거나 전체 대응표 타입 검사 | 부분 집합·독립 변경이 필요한 프로토콜·시험 데이터 | C7, C6·C8에 원본 재기록 유사 |
| [폐기 API·우회 코드 재사용](#폐기-api우회-코드-재사용) | [E1](#e1) | 일부. 명시된 import·호출 이름만 검사 | `no-deprecated`, ast-grep, 경계 API 계약 시험 | 마이그레이션·호환 어댑터와 정상 레거시 데이터 읽기 | C2~C4·C7 인접 |
| [같은 이름으로 상위 변수를 가림](#같은-이름으로-상위-변수를-가림) | [E3](#e3) | 못 잡음. `no-unused-vars`는 둘을 모두 쓰면 통과 | `@typescript-eslint/no-shadow` | 의도한 지역 콜백 변수도 진단 | 직접 대응 없음 |
| [존재하지 않거나 다른 버전의 의존 API 사용](#존재하지-않거나-다른-버전의-의존-api-사용) | [E8](#e8)·[E10](#e10) | 일부. 파일·타입의 해석 실패 및 CI 잠금 파일 불일치 | 버전별 공식 exports 확인, 타입 검사·CI 빌드 | 사설 registry·workspace·생성 코드·조건부 exports | C9 간접 |
| [잘못된 구현과 함께 통과하는 시험](#잘못된-구현과-함께-통과하는-시험) | [E7](#e7)·[E10](#e10) | 일부. 대기·경과 시간·locator 모양은 검사, 단언의 검증력은 통과 | 수정 전 실패·수정 후 통과, 선택적 mutation testing, 독립 오라클 리뷰 | 동등한 변이, 실제 계약상 정상인 무동작 | T7, T6 일부 |
| [오래된 코드 지도·용어·CI 전제 복제](#오래된-코드-지도용어ci-전제-복제) | [E1](#e1)·[E9](#e9), 기존 [E10~E13](static-analysis-rules-references.md#e10) | 일부. 로컬 링크 존재와 지정 CI 계약, 용어·설명·일반화는 통과 | 선언 참조·한정된 용어 검색·workflow 스키마 및 계약 시험 | 과거 기록 인용·의도적으로 다른 후속 job·별칭 | C6·C8·C9 |

**[확인]**은 원문·저장소·합성 검사를 직접 대조한 사실입니다. **[추측]**은 BaboJUBot 적용, 원인 해석 또는 오탐 예상입니다. **[확인 필요]**는 효과나 빈도를 추가로 재야 할 주장입니다. 표의 현행 판정은 **[확인]**, 기계 판정의 적용 범위와 오탐 추정은 아래 상세에서 구분합니다. C1~C9·T1~T10은 [리뷰 패턴 기록](review-pattern-history.md)의 번호입니다.

## 현행 검사 기준

- **[확인]** ESLint는 JS·TS recommended에 제품 `src`의 `no-unsafe-{assignment,member-access,call,return,argument}`, 객체 리터럴 타입 단언 제한, `eqeqeq`(`== null` 예외)를 더합니다. typed `src`에 `switch-exhaustiveness-check`가 걸리며 `considerDefaultExhaustiveForUnions: true`라 `default`가 있으면 빠진 union case를 별도로 요구하지 않습니다. 웹에는 React Hooks, core/contracts와 runtime에는 지정 import 제한, 서버에는 지정 후속 호출 제한이 적용됩니다. `strict`와 `noUncheckedIndexedAccess`는 표현된 타입 계약을 검사합니다. [ESLint 설정](../../eslint.config.js) · [TS 설정](../../tsconfig.base.json)
- **[확인]** 시험 규칙은 고정 대기, 실제 경과 시간 단언, 폴더 삭제 API를 지정 범위에서 검사합니다. 웹 E2E에서는 타입으로 페이지를 확인해 넓은 locator 사용도 검사합니다. `check-project.mjs`는 Markdown 로컬 링크 대상·무시 경로·worker 설정을 확인하고, `pnpm check`의 다른 시험은 지정 CI 계약을 확인합니다. 시험의 관찰 신호, 실패와 정리의 관계, OS 차이는 작성 기준에 있습니다. [시험 규칙](../../scripts/eslint-test-rules.mjs) · [프로젝트 검사](../../scripts/check-project.mjs) · [명령 정의](../../package.json) · [코드 작성 기준](../../CODING_STANDARDS.md)
- **[확인]** ESLint 10.12.0의 `lintText`를 기존 TS 파일 경로에 메모리로 적용했습니다. 빈 `catch {}`, 직접 `JSON.parse(text).id`, 런타임 소비자의 금지 import, 서버의 지정 `hub.publish()`는 각각 진단을 냈습니다. 상수 반환 catch, 일반 `as`·인덱스 `!`, 연속 정리 await, 반환값을 버린 Promise, 가려진 변수, 폐기 표시 함수 호출, 프로세스 소유 파일의 환경 복사, 범위 조건 없는 콜백, 일반 알림 콜백, 동작 전 값만 단언하는 시험은 모두 0건이었습니다. 예제는 별도 표시 없으면 계약을 설명하는 합성 조각입니다. 후보 규칙과 도구의 저장소 전수 적중·오탐은 **[확인 필요]**입니다. [기존 합성 검사 방식](../../scripts/product-lint-rules.test.mjs)
- **[확인]** 비교 대조군으로 E3의 JS/TS 표에 있는 미사용 변수는 이미 `@typescript-eslint/no-unused-vars`가 검사합니다(`_` 예외). `@typescript-eslint/no-unused-expressions`도 활성 상태이며 `no-sequences`와 `complexity`는 현재 서버 제품 파일에서 꺼져 있습니다. 종전 연구의 버전·성능·도구 오탐 수치는 해당 조사에 따릅니다. [E3](#e3) · [정적 분석 규칙 조사](static-analysis-rules-references.md)

## 패턴별 상세

### 조직·승인 조건 누락

```ts
return store.getRun(runId); // 호출 경계가 조직 ID와 접근 권한을 함께 확인해야 한다.
```

**[확인]** 조직 ID, 초기 승인, 최종 완료 결정은 제품 코드가 강제하는 계약입니다. 정상적으로 타입 검사되는 조회 호출이라도 해당 변경이 조직 검증을 거치는지는 타입과 import만으로 판정되지 않습니다. 서버의 `no-restricted-syntax`도 지정 이름의 `hub.publish*`·`dispatcher` 호출을 가려낼 뿐, 별도 추상화에서 잘못된 시점에 알렸는지 판정하지 않습니다. [AGENTS](../../AGENTS.md) · [승인 정책 ADR](../adr/0005-approval-policy-enforcement-scope.md) · [ESLint 설정](../../eslint.config.js)

**[추측]** 에이전트가 내부 작업자나 이미 범위가 확인된 호출을 새 외부 진입점의 선례로 쓰면 전제까지 복사하지 못할 수 있습니다. E1은 본보기 재사용을, E7은 기능 시험을 통과하고도 리뷰 제약을 위반하는 사례를 뒷받침합니다. 도메인 제약 자체의 AI 기인 빈도는 **[확인 필요]**입니다. 승인·조직 범위가 표현된 진입점과 외부 경계 계약 시험은 기계적으로 평가할 수 있습니다. 호출 이름만 찾는 검사는 상위에서 검증된 값이나 승인과 무관한 조회를 오탐으로 올릴 수 있습니다. [E1](#e1) · [E7](#e7) · [기존 경계 시험 검토 D10](static-analysis-rules-references.md#D10)

### 오류를 성공·빈 결과로 바꿈

```ts
try {
  return await loadItems();
} catch {
  return [];
}
```

**[확인]** E3은 AI 기여 이력에서 광범위 예외 처리로 읽기 실패가 묻힌 Python 사례를 제시합니다. 이 TS 예에서는 실제 빈 결과와 읽기 실패가 같은 배열이 됩니다. ESLint `no-empty`는 주석 없는 빈 catch를 검출하며 반환문이나 설명이 든 블록은 통과합니다. C9의 실패 상태 누락과도 결과 표면에서 닮았습니다. [E3](#e3) · [ESLint no-empty, 게시일 표기 없음](https://eslint.org/docs/latest/rules/no-empty) · [리뷰 기록](review-pattern-history.md)

**[추측]** 정상 경로를 끝내는 데 집중하거나 근처 best-effort 코드를 따라 하면 실패 응답을 보존해야 하는 자리에도 기본값을 반환하기 쉽습니다. 구조 검색으로 catch 안의 상수·빈 컬렉션 반환을 찾고, 계약을 아는 시험으로 부재·저장 실패를 따로 주입할 수 있습니다. 검색 적중은 진단 후보이며, 정해진 부재 기본값이나 오류를 이미 기록한 best-effort 동작도 포함될 수 있습니다. [E1](#e1) · [구조 검색 도구](#도구와-확인-범위)

### 정리 연쇄와 프로세스 수명

```ts
try {
  await run();
} finally {
  await releaseRequest();
  await stopServer();
}
// 실행 소유 파일 안의 별도 예
const child = spawn(tool, ["status"], { env: { ...process.env } });
child.stdin?.write(input);
```

**[확인]** 첫 예는 해제 실패 시 서버 정리를 건너뛰며 본문 오류가 가려질 수 있습니다. 두 번째 예는 부모 환경을 통째로 전달하고, 이 조각에는 자식과 stdin의 별도 실패 통지 경로 및 유한 명령의 시한이 없습니다. ESLint는 시험 폴더 삭제 API와 일부 `finally` 제어문, 실행 소유 파일 밖의 지정 launcher import를 검사합니다. 소유 파일·시험·개발 스크립트의 동일 코드와 허용 경로 안의 오류 처리는 검증하지 않습니다. C1~C4의 실제 실패 및 종전 도구 대조는 기존 조사에 있습니다. [리뷰 기록](review-pattern-history.md) · [정적 분석 규칙 조사 E01~E08·E17·E19](static-analysis-rules-references.md#e01)

**[추측]** 성공 경로만 보여 주는 주변 코드를 복사하면 플랫폼·종료·부분 획득의 전제가 빠지기 쉽습니다. 정리 콜백의 연속 `await`, 실행 옵션의 환경 전체 복사, 제한된 프로브 API 호출 형태는 구조 검색 후보입니다. 독립 정리는 실패 주입으로 뒤 단계와 원인 오류를 함께 확인하고, 실행 경계는 가짜 자식·합성 환경·가짜 시계를 사용한 계약 시험으로 평가할 수 있습니다. `on("error")`의 문자열 유무만 보면 공용 소유자가 단 등록을 놓칩니다. 정상 직렬 정리, 대화형 로그인, 장기 감독자와 이미 상위에서 제한한 시한도 전역 검색의 오탐입니다. 이 패턴의 에이전트별 빈도는 **[확인 필요]**입니다. [E1](#e1) · [기존 판단 D01~D04](static-analysis-rules-references.md#D01)

### Promise 거부 방치

```ts
persist();
return { accepted: true };
```

**[확인]** 반환 전에 저장을 기다려야 하거나 거부를 기록해야 하는 자리의 예입니다. 합성 bare Promise 호출은 현행 lint를 통과했습니다. 종전 실험에서 `no-floating-promises` 기본값은 명시적 `void`를 허용했고, `no-misused-promises`는 일부 `void` 콜백 계약을 검사했습니다. 두 규칙의 검출 자체로 자식 프로세스 이벤트와 스트림 오류 처리까지 확인할 수 없습니다. [기존 Promise 실험 E05~E07](static-analysis-rules-references.md#e05)

**[추측]** 주변의 의도된 비동기 후속 작업을 일반화하면 오류를 이미 수집하는 경계가 달라졌을 때도 같은 호출 모양을 쓸 수 있습니다. typed lint로 후보를 좁히고 응답·저장·실패 통지 순서를 시험으로 관찰할 수 있습니다. 의도된 `applyAfterCommit` 작업을 기계적으로 await하면 응답 지연과 계약을 바꿀 수 있습니다. AI와 사람의 상대 빈도는 **[확인 필요]**입니다. [E1](#e1) · [기존 판단 D03](static-analysis-rules-references.md#D03)

### 외부 데이터의 타입·존재 단언

```ts
type Row = { id: string };
const row = JSON.parse(text) as Row;
const name = names[0]!.trim();
```

**[확인]** 두 표현 모두 실제 입력을 검사하는 분기를 추가하지 않습니다. 제품 코드의 무단언 `any` 사용과 객체 리터럴 `as Row`는 일부 규칙이 막지만, 이 예의 일반 단언과 단일 비널 단언은 합성 검사에서 통과했습니다. 타입을 좁히는 `no-unsafe-type-assertion`과 비널 단언의 `no-non-null-assertion`은 별도 규칙입니다. 구조 검색은 파싱·외부 응답 경계로 범위를 좁힐 수 있습니다. [ESLint 설정](../../eslint.config.js) · [타입 단언 규칙](https://typescript-eslint.io/rules/no-unsafe-type-assertion/) · [비널 단언 규칙](https://typescript-eslint.io/rules/no-non-null-assertion/)

**[추측]** 에이전트가 타입 오류 해결을 목표로 삼거나 저장 계약으로 이미 보장된 단언을 바깥 입력에도 복사하면 오류가 실행 시점으로 밀립니다. 경계에서 잘못된 모양을 넣는 시험으로 실제 검증을 확인할 수 있습니다. 광범위한 단언 금지는 타입이 표현하지 못한 라이브러리 보장이나 내부 데이터 불변 조건도 진단합니다. E2와 E4는 각각 문맥의 결함 전이와 보안 약점의 존재를 보여 주며, 이 두 TS 구문의 상대 빈도는 **[확인 필요]**입니다. [E2](#e2) · [E4](#e4)

### 타입이 맞는 외부 경로를 그대로 신뢰

```ts
return readReport(requestedPath); // 외부 입력인 string을 내부 경로 계약으로 오인
```

**[확인]** E3의 JS/TS 데이터에서 경로 조합에 관한 보안 진단이 반복됐습니다. E4도 실제 저장소에서 AI 도구에 귀속된 조각의 여러 보안 약점을 관찰했습니다. 외부에서 온 `string` 값의 접근 범위는 TS와 `no-unsafe-*`로 보장되지 않습니다. BaboJUBot 산출물의 경계와 기존 검증은 별도 조사에 있습니다. [E3](#e3) · [E4](#e4) · [산출물 경로 조사](artifact-path-confinement.md)

**[추측]** 내부에서 검증된 경로를 읽는 호출을 새 외부 입력에도 적용하면 매개변수 타입은 맞아도 안전 조건이 빠질 수 있습니다. 범위가 명확한 API에 대해 Semgrep으로 입력에서 읽기까지 흐름을 검색하거나 승인된 저장소 경계를 시험할 수 있습니다. 입력이 내부 생성이거나 공용 검증 경계를 이미 거치면 단순 호출 이름 검사는 오탐입니다. BaboJUBot에서 발견 건수와 실제 위험은 **[확인 필요]**입니다. [E1](#e1) · [도구와 확인 범위](#도구와-확인-범위)

### 확인 후 사용 사이의 상태 변경

```ts
if (await exists(resultFile)) return await readResult(resultFile);
```

**[확인]** 파일이 있는지 확인한 시점과 실제 읽기 사이에 상태가 바뀔 수 있습니다. 리뷰 기록 #178에 실패가 있으며 현행 lint는 이 순서를 분석하지 않습니다. 종전 조사에서 CodeQL `js/file-system-race`는 해당 `exists` 뒤 `readFile` 모양을 제외했습니다. [리뷰 기록 C5](review-pattern-history.md#c5-확인한-뒤-사용-check-then-use) · [기존 도구 대조 E09](static-analysis-rules-references.md#e09)

**[추측]** 존재 확인을 선례에서 복제하면 당시 파일 소유권이나 저장 순서까지 가져오지 못할 수 있습니다. 같은 경로를 확인하고 바로 사용하는 조각은 구조 검색으로 찾고, 자원 상태가 바뀌는 순서를 gate로 강제하면 계약을 자동으로 검증할 수 있습니다. 존재 자체를 점검하는 검사와 불변 파일의 읽기도 검색에 걸립니다. E1은 실무의 모방 관찰이며 이 경쟁 조건이 AI에 더 많은지는 **[확인 필요]**입니다. [E1](#e1) · [코드 작성 기준의 순서](../../CODING_STANDARDS.md#순서)

### 기존 구현·계약 목록 복제

```ts
const visible = ["pending", "running"] satisfies readonly RunStatus[];
```

**[확인]** `satisfies readonly RunStatus[]`는 요소의 유효성을 확인하고 전체 값의 포함 여부는 확인하지 않습니다. 별도로 적은 목록과 함수 복제는 exhaustive switch 검사의 대상 밖입니다. E5의 최대 7.50%는 특정 모델·언어·표본에서 외부 공개 코드와 일치한 Type 1·2 복제율입니다. E6의 반복 변경 실험은 자신의 앞선 작업 결과를 이어받을 때의 중복 증가를 관찰했습니다. [E5](#e5) · [E6](#e6) · [기존 계약 비교 E11](static-analysis-rules-references.md#e11)

**[추측]** 이미 있는 함수를 찾기 전에 가까운 구현을 다시 적으면 새 상태나 오류 처리 변경이 한쪽에만 반영될 수 있습니다. jscpd의 토큰 길이·모드를 조절해 긴 복제 후보를 찾더라도 짧은 계약 배열이나 의미만 같은 구현은 빠질 수 있습니다. 전체 매핑은 `satisfies Record<RunStatus, Label>`로 계약을 표현할 수 있으며, 부분 집합은 원본에서 파생할 수 있습니다. 서로 다른 수명이나 진화 방향을 가진 코드, 반복 fixture, 의도한 UI 부분 집합은 검색 오탐입니다. [E1](#e1) · [기존 판단 D07](static-analysis-rules-references.md#D07) · [도구와 확인 범위](#도구와-확인-범위)

### 폐기 API·우회 코드 재사용

```ts
return legacyRead(name); // 기존 호출 예가 많아 새 코드에서도 선택됨
```

**[확인]** Tan은 에이전트가 남아 있는 폐기 코드와 타이머 우회를 선례로 쓰는 실무 관찰을 발표했습니다. 현행 합성 검사에서는 `@deprecated`로 표시된 함수 호출이 통과했습니다. typed `no-deprecated`는 선언에 폐기 표식이 있을 때 진단합니다. 표시 없는 우회는 지정 API·경로의 AST 검색으로 후보를 만들 수 있으며, 기존 import 제한은 이미 합의된 경계에서 일부 경로를 차단합니다. [E1](#e1) · [폐기 API 규칙, 게시일 표기 없음](https://typescript-eslint.io/rules/no-deprecated/)

**[추측]** 우회를 설명하는 주석은 정당한 표준 구현처럼 읽힐 수 있습니다. 합의된 진입점을 구조적으로 드러내면 새 작업의 선택을 줄일 수 있습니다. 구버전 데이터 읽기, 전환 기간의 호환 어댑터와 지정된 예외 소유자를 일률적으로 잡으면 오탐입니다. 저장소에서 어떤 우회가 실제 반복 입력이 됐는지는 **[확인 필요]**입니다. [E1](#e1) · [E2](#e2)

### 같은 이름으로 상위 변수를 가림

```ts
return owner + users.map((owner) => owner.trim()).join(", ");
```

**[확인]** E3의 JS/TS 표에서 상위 변수를 가리는 진단은 18,417건이었습니다. 그 수는 분석기의 진단 건수이며 실제 버그 수가 아닙니다. 위 두 바인딩을 모두 사용하면 현행 `no-unused-vars`와 TS 검사로는 이름 재사용을 막지 못합니다. `@typescript-eslint/no-shadow`는 후보를 직접 검출합니다. [E3](#e3) · [TS 변수 가리기 규칙, 게시일 표기 없음](https://typescript-eslint.io/rules/no-shadow/)

**[추측]** 인접 map 콜백이나 중첩 핸들러의 관용 이름을 그대로 붙이면 바깥 값 참조 의도가 가려지기 쉽습니다. 지역 콜백의 의도적 재사용도 진단되므로 정당한 리팩터링인지 리뷰 판단이 필요합니다. E3에는 인간 대조군이 없어 AI가 더 자주 가리는지는 **[확인 필요]**입니다. [E3](#e3)

### 존재하지 않거나 다른 버전의 의존 API 사용

```ts
import { parseForWorkspace } from "illustrative-parser"; // 가상 이름
```

**[확인]** E8은 JavaScript·Python 생성 표본에서 없는 패키지 이름을 관측했습니다. TS가 대상 모듈이나 export를 해석할 수 없으면 컴파일에서 확인되고 고정 잠금 파일 설치는 명세·잠금 파일 불일치를 잡습니다. 이미 설치된 패키지의 API를 정확히 확인하지 않았거나 타입 선언과 실제 런타임 exports가 어긋난 경우는 설치 성공만으로 판정되지 않습니다. [E8](#e8) · [E10](#e10) · [pnpm 설치 계약, 게시일 표기 없음](https://pnpm.io/cli/install#--frozen-lockfile) · [CI 설치](../../.github/workflows/scaffold.yml)

**[추측]** 모델이 유사한 이름을 조합하거나 다른 버전의 관용 API를 현재 코드에 옮길 수 있습니다. 설치 전 사용 목적과 고정 버전 공식 API를 검토하고, 당시 workspace·빌드·실행 경계에서 확인할 수 있습니다. 공개 registry에 이름이 없다는 검사만으로는 사설 registry·workspace 별칭·코드 생성 모듈도 오탐 처리합니다. 이 저장소에서의 발생 빈도는 **[확인 필요]**입니다. [E8](#e8) · [E10](#e10)

### 잘못된 구현과 함께 통과하는 시험

```ts
const before = await listItems();
await refresh();
expect(before).toHaveLength(3);
```

**[확인]** 예의 단언은 refresh 효과를 관찰하지 않습니다. 현행 고정 대기·경과 시간·locator 규칙과 TS 타입 검사는 구현이 실패할 때 단언도 실패하는지 판정하지 않습니다. E7에서는 오류가 있는 코드가 시험 생성 입력일 때 구현과 같은 오류를 단언에 담기도 했습니다. 테스트 오라클의 독립성 위험은 T7의 거짓 통과와 맞닿아 있습니다. [E7](#e7) · [E10](#e10) · [기존 단언 규칙 대조 E20](static-analysis-rules-references.md#e20) · [리뷰 기록 T7](review-pattern-history.md#4-다른-작업에-넘길-시험-품질-목록)

**[추측]** 에이전트가 자기 구현과 테스트를 함께 조정하면 테스트 성공을 위해 현재 반환값을 다시 기술할 수 있습니다. 명세에서 독립적으로 고른 기대값, 수정 전후 대조, 실제 공개 경계에서 저장값·응답을 확인하는 시험, 선택적 mutation testing이 후보입니다. 변이 생존 자체는 동등한 변이나 의도된 무동작도 포함합니다. 작은 AST 검사로 `expect(x).toBe(x)` 같은 자명한 형태는 찾을 수 있지만, 정책·지연·경쟁을 반영한 의도는 리뷰가 필요합니다. [E7](#e7) · [도구와 확인 범위](#도구와-확인-범위)

### 오래된 코드 지도·용어·CI 전제 복제

```ts
/** Starts a research goal. */ // 개별 작업을 여는 함수에 붙은 잘못된 설명
export const openTask = (id: string) => taskStore.open(id);
```

**[확인]** C6의 오래된 백틱 심벌과 지도 누락, C8의 정의와 다른 용어, C9의 workflow 결과 집계와 시한 산술은 제품 TS 타입 검사로 판정되지 않습니다. 로컬 링크 존재와 이미 지정된 CI 계약은 확인합니다. E9의 OSS 사례는 기여자가 생성 문서와 증거를 직접 이해·검증할 것을 요구합니다. [E9](#e9) · [프로젝트 검사](../../scripts/check-project.mjs) · [기존 도구 대조 E10~E13](static-analysis-rules-references.md#e10)

**[추측]** 에이전트가 오래된 지도와 이웃 workflow를 진입점 안내로 읽으면 의미가 틀린 예까지 반복할 수 있습니다. 명시된 심벌 참조·한정 용어·CI 구조는 기계 검색 후보이며, 새 작업이 요구하는 결과 집계와 단계별 재시도 상한은 계약 시험으로 다룹니다. 과거 명칭 인용, 같은 글자의 다른 뜻, 정책이 다른 job은 오탐 후보입니다. 문서·CI 복제를 에이전트 작성분과 대조한 저장소 수치는 **[확인 필요]**입니다. [E1](#e1) · [리뷰 기록](review-pattern-history.md)

## 선례를 따라 쓰는 근거와 대응

| 대응 | 관찰 또는 실험 결과 | BaboJUBot에서의 판단 |
| --- | --- | --- |
| 잘못된 본보기 제거 | **[확인]** E2의 통제 비교에서 잘못된 예시를 본 초기 Codex의 정확도가 낮아졌고 일반적인 정확성 지시는 일부만 회복했습니다. E1의 두 실무팀은 기존 우회·불균일한 코드를 에이전트가 반복하는 사례를 보고하고 정리했습니다. | **[추측]** 수정 빈도가 높은 본보기는 정상 대안을 정한 뒤 같은 패턴의 검색 결과와 함께 보는 가치가 있습니다. 정리 단독 효과의 저장소 실측은 **[확인 필요]**입니다. |
| 올바른 진입점과 사용 예 지정 | **[확인]** Tan은 Dune의 허용 API·디렉터리 경계, OpenAI는 공유 유틸리티·검증 경계와 수정 경로를 알려 주는 lint 오류를 보고했습니다. BaboJUBot의 실행 제한 메시지는 `startProcess`·`runProbe`를 알려 줍니다. [E1](#e1) · [현행 설정](../../eslint.config.js) | **[추측]** 호출 이름에 더해 실패·부분 성공·취소까지 포함하는 짧은 예가 정리와 실행 계약의 재사용에 맞습니다. 예시 지정만의 효과 크기는 **[확인 필요]**입니다. |
| 짧은 저장소 지침과 작업별 제약 | **[확인]** Gloaguen 등은 개발자 지침의 평균 작업 성공률 +2.4%p를 관찰했으나 지침 없는 조건과 유의한 차이는 없었습니다(`p=.21`). 경로 탐색·시험 행동과 비용은 달라졌습니다. SWE-Gate에서 구체적 제약을 제공하자 각 모델의 기능·제약 동시 통과가 개선됐지만, 제약을 본 기능 통과 시도 644건 중 221건은 별도 제약 검사를 실패했습니다. [E7](#e7) | **[추측]** 알고 있어야 할 파일·계약 위치는 지침에, 조직·승인 등의 침범 불가 조건은 실행 가능한 코드와 시험에 둔 현재 원칙에 부합합니다. |
| 검증 증거를 요구하는 리뷰 | **[확인]** Tan은 영상·상태 전이·실행 검증을, 공개 pstack 절차는 과거 결함에서 검사 실패를 확인하고, Docusaurus·OpenTelemetry는 생성물의 기여자 검토와 이해를 요구합니다. 에이전트가 잘못된 구현을 보며 시험을 만든 실험에서는 독립 생성보다 결함 검출이 낮았습니다. [E1](#e1) · [E7](#e7) · [E9](#e9) | **[추측]** 리뷰의 질문을 “어느 실패·순서·조직 조건이 어느 관찰에서 드러나는가”로 정하면 코드 모양을 통과한 결함을 확인할 수 있습니다. 이 저장소에서 체크리스트만으로 줄어든 결함 수는 **[확인 필요]**입니다. |

## 우리 저장소에서 먼저 볼 다섯 가지

**[추측]** 우선순위는 제품 불변 조건, 과거 실제 실패, 현행 검사에서 빠지는 범위를 함께 고려한 판단입니다. 빈도 수치는 기존 리뷰 기록의 서로 다른 PR 수이며, 새 코드 결함의 개수는 **[확인 필요]**입니다. [리뷰 기록](review-pattern-history.md)

1. **조직·승인 조건 누락.** 조직 격리·초기 승인·최종 완료는 위반 시 제품 계약이 깨집니다. 타입이 맞는 호출과 정적 import 제한을 통과할 수 있어 거부 응답과 미저장·미실행이 공개 경계에서 관찰되는지가 중요합니다. [AGENTS](../../AGENTS.md) · [E7](#e7)
2. **정리 연쇄와 원인 오류 손실.** C1은 일반 코드·스크립트 7 PR와 시험 본문 2건에서 반복됐고 포트 재사용 실패와 Windows 프로세스 잔류가 확인됐습니다. 폴더 삭제 API를 통일해도 정리 단계의 실패 격리와 본문 오류 보존은 별개입니다. [C1 기록](review-pattern-history.md#c1-정리-단계-연쇄)
3. **실행 소유자 안의 환경·입력 오류·시한 누락.** C2는 격리 환경의 상속 결함, C3은 조기 종료 뒤 EPIPE 등 CI 실패, C4는 지연·정지 사례가 있었습니다. 현행 import 제한의 예외인 소유 파일에서 그 계약이 깨질 수 있습니다. [C2~C4 기록](review-pattern-history.md#c2-자식-프로세스-환경-만들기) · [기존 채택 결과](static-analysis-rules-references.md)
4. **확인과 사용 사이의 경쟁.** C5는 3 PR와 #178에서 문제였고 실제 읽기 실패가 확인됐습니다. 링크나 토큰 검사 결과로는 상태 변경을 알 수 없습니다. 경쟁 순서를 제어하는 회귀 시험이 계약을 직접 보여 줍니다. [C5 기록](review-pattern-history.md#c5-확인한-뒤-사용-check-then-use) · [기존 E09](static-analysis-rules-references.md#e09)
5. **잘못된 구현에서 통과하는 시험.** T7에는 원래 참이던 값과 아직 표시되지 않은 UI를 검증한 사례가 있습니다. 실패를 숨기는 테스트는 다른 우선순위의 검증도 약하게 만듭니다. 독립 기대값과 수정 전후 대조로 진단할 수 있습니다. [T7 기록](review-pattern-history.md#4-다른-작업에-넘길-시험-품질-목록) · [E7](#e7)

## 1차 자료와 해석 범위

<a id="e1"></a>

### E1. 저장소 선례의 실무 관찰

- **[확인]** Lauren Tan(로렌 탄, SpaceXSI), *All Code Is Slop (Except Mine)*, AI Engineer CODE, **2026-11-11**. 공식 녹화·슬라이드의 약 2~4분에서 코드와 기존 본보기, 5~8분에서 Dune의 `useEffect` 사용 범위·Electron 프로세스 경계, 이후 실행 검증을 다룹니다. 공식 대회 기록에서 타이머 우회를 정당화하는 설명 사례는 메인 무대 녹화 1:08:23 부근입니다. 팀 내부의 적용 경험이며 정리·lint·검증의 개별 효과를 비교한 실험은 제시하지 않습니다. [대회 날짜·기록](https://ai.engineer/code/2026/talks/lauren-tan) · [원본 영상](https://www.youtube.com/watch?v=O_zcc6Xl12g) · [공식 슬라이드](https://ai.engineer/talks/O_zcc6Xl12g-all-code-is-slop-except-mine)
- **[확인]** Tan이 공개한 pstack의 `/correct`, 고정 판본 **2026-10-15**. 커밋·revert·리뷰와 우회 설명을 읽고 반복 원인을 찾아 구조·타입·lint·행동 시험 순으로 검토한 뒤, 새 검사가 과거 오류에서 실패하는지 확인하라고 명시합니다. 가장 가까운 예시를 따른다는 문구는 이 절차의 설계 가정이며 독립 측정값은 아닙니다. [고정 SHA 원문](https://github.com/cursor/plugins/blob/e5136d82418d2db3165ea1050d17577cd618cc05/pstack/skills/correct/SKILL.md)
- **[확인]** Ryan Lopopolo, *Harness engineering*, OpenAI, **2026-02-11**. 팀 내부 제품에서 Codex가 기존의 불균일한 패턴을 반복했다고 보고했습니다. 공유 유틸리티, 경계 파싱, 구조 lint·시험, 반복 정리와 짧은 저장소 안내를 운영했습니다. 효과는 한 제품의 사례로 읽습니다. [운영 원문](https://openai.com/index/harness-engineering/)

<a id="e2"></a>

### E2. 입력 예시와 정확성 통제 실험

- **[확인]** Chen 등, *Evaluating Large Language Models Trained on Code*, **2021-07-07 최초 공개**, 부록 E.3·E.5 및 그림 14. HumanEval 158개 문제에서 정답 예시 세 개, 미세 결함 예시 세 개, 예시 없음 등을 비교했습니다. 대상 문제 자체는 본보기에서 제외했습니다. 결함이 있는 예시에서 정확성이 낮아졌고 일반적인 정확성 지시는 이를 일부 회복했습니다. 초기 Codex의 Python 완성 실험이므로 현대 도구의 저장소 편집에서 동일 효과나 복제율을 추정할 수 없습니다. [논문과 게시 이력](https://arxiv.org/abs/2107.03374) · [부록](https://arxiv.org/html/2107.03374v2#A5.SS3)

<a id="e3"></a>

### E3. 실제 AI 기여 커밋의 정적 진단

- **[확인]** *Debt Behind the AI Boom*, **2026-03-30 최초 공개, 2026-10-13 v3**. 분석기에서 302,579개 AI 기여 귀속 커밋 중 27,677개에 새 진단을 보고했습니다. JS/TS의 상위 진단에는 미사용 변수·인자, 가려진 바깥 변수, 블록 범위 오용과 sequence가 있었습니다. Python에서는 넓은 예외 처리가 두드러졌습니다. 귀속 가능한 공개 커밋과 도구가 검사하는 패턴의 표본이며 이 표를 인간과 비교한 결함률로 읽을 수 없습니다. [판본 이력](https://arxiv.org/abs/2603.28592v3) · [논문 표 3·4](https://arxiv.org/html/2603.28592v3)

<a id="e4"></a>

### E4. 보안 약점과 오류 처리

- **[확인]** *Security Weaknesses of Copilot-Generated Code in GitHub Projects*, **2023-10-03 최초 공개**, **2025-02-06 v4**, ACM TOSEM 게재. Copilot·CodeWhisperer·Codeium에 귀속시킨 GitHub 조각 733개에서 JavaScript 24.2%, Python 29.5%에 약점을 보고했습니다. 귀속된 조각의 분석 결과이며 임의의 제품 변경에 대한 위험 확률이나 각 약점의 실제 악용 검증을 뜻하지 않습니다. [논문과 판본 이력](https://arxiv.org/abs/2310.02059) · [출판 기록](https://doi.org/10.1145/3716848)

<a id="e5"></a>

### E5. 코드 복제 실험과 관측 지표

- **[확인]** Wu 등, *An Empirical Study of Code Clones from Commercial AI Code Generators*, **2025-06-19 공개**. Copilot·Amazon Q·GPT-4o 결과를 공개 코드와 비교해 동일·식별자 등이 바뀐 복제가 최대 7.50%였고 결함을 함께 재현한 사례를 제시합니다. 공개 코드 집합은 실제 학습 목록의 대리 자료이며, 최대치는 사전 실험에서 복제가 높았던 구간의 특정 모델·언어 결과입니다. 저장소에 보이는 예시를 직접 복사한 비율과는 다른 측정입니다. [FSE 원문](https://doi.org/10.1145/3729397)
- **[확인]** GitClear, *AI Copilot Code Quality*, **2025년 보고서(공식 소개에 월일 표기 없음)**. 2020~2024년 변경 코드 2억 1,100만 줄에서 복사로 분류한 변경 줄의 비율이 2021년 8.3%에서 2024년 12.3%로 늘었다고 보고합니다. 도구사의 관찰 집계이며 기간 차이와 개별 변경의 AI 귀속을 분리할 수 없습니다. [데이터 수집팀의 보고서](https://www.gitclear.com/ai_assistant_code_quality_2025_research)

<a id="e6"></a>

### E6. 반복 변경에서 구조가 나빠지는지 측정

- **[확인]** Orlanski 등, *SlopCodeBench*, **2026-05-07 v2**. 36개 문제·196개 검증 단계에서 15개 에이전트가 이전 작업을 이어 변경했습니다. 실행 경로의 77%에서 복잡도 집중이, 75.5%에서 중복·불필요 코드 지표가 증가했습니다. 구조 중복이 늘어나는 동안 연구용 ast-grep 위반 밀도 변화는 작았고, 필수 플래그의 분기마다 같은 파싱을 덧붙인 사례도 나왔습니다. 품질을 명시한 프롬프트는 초기 결과를 개선했으나 뒤 단계의 악화 속도를 줄이지 못했습니다. 합성 과제와 관측 지표이므로 실제 TS 저장소의 복잡도 임계치나 결함률 근거로 사용하지 않습니다. [v2 원문](https://arxiv.org/html/2603.24755v2)

<a id="e7"></a>

### E7. 지침·리뷰 제약·시험 독립성의 비교

- **[확인]** Gloaguen 등, *Evaluating AGENTS.md*, **2026-02-12 최초 공개**. SWE-bench와 CTXbench에서 지침 종류를 비교했습니다. 개발자 지침의 +2.4%p는 지침 없음과 통계적으로 유의하지 않았고, LLM 생성 지침은 도구 호출·비용을 늘렸습니다. 일부 문서·예시를 제거한 대조 실험에서는 지침에 담긴 정보의 가치가 달랐습니다. [논문과 판본 이력](https://arxiv.org/abs/2602.11988) · [실험 §4](https://arxiv.org/html/2602.11988v3#S4)
- **[확인]** He 등, *SWE-Gate*, **2026-09-03 사전 공개**. 75개 Python 저장소 PR의 실제 리뷰 지적에서 합성한 303개 과제로 네 모델을 비교했습니다. 리뷰 제약의 명시는 기능·제약의 동시 통과를 개선했고, 기능을 통과해도 별도 제약 검사에 실패하는 사례가 남았습니다. 221/644는 제약을 명시한 조건의 네 모델 시도를 합친 값입니다. [논문 §5](https://arxiv.org/html/2609.04167v1)
- **[확인]** *On the risk of coding before testing*, **2026-07-06 사전 공개**. 잘못된 구현을 입력으로 시험을 생성한 비교에서 결함 검출 약 14%, 명세로부터 독립 생성한 비교에서 약 25%를 보고했습니다. 해당 과제와 실험 조건의 수치이며 저장소 전반의 검출률을 예측하지 않습니다. [논문 원문](https://arxiv.org/html/2607.05139v1) · [게시일](https://arxiv.org/abs/2607.05139v1)

<a id="e8"></a>

### E8. 패키지 이름 환각

- **[확인]** Spracklen 등, *We Have a Package for You!*, **2025-08 USENIX Security 25**. 모델 16개가 만든 JS·Python 표본 576,000개에서 없는 패키지 이름을 확인하고 완화 조건을 실험했습니다. 공개 레지스트리와 당시 설치 가능한 이름의 실험으로, BaboJUBot의 의존 검토에서 놓치는 비율은 확인하지 않았습니다. [USENIX 원문·발표](https://www.usenix.org/conference/usenixsecurity25/presentation/spracklen)

<a id="e9"></a>

### E9. 오픈소스 기여 지침

- **[확인]** Docusaurus `AGENTS.md`, 고정 판본 **2026-11-06**. 외부 기여는 에이전트가 이슈·PR을 자동으로 만들지 못하도록 안내하고, 편집·검토 없이 나온 결과의 제출을 금합니다. 작업별 코드 스타일·의존성 지침을 가리킵니다. [고정 SHA 원문](https://github.com/meta/docusaurus/blob/f390446c203811d39222caf55325ade70d582a00/AGENTS.md)
- **[확인]** OpenTelemetry 기여 정책, 고정 판본 **2026-04-06**. 생성한 코드·문서·시험을 제출하기 전에 기여자가 검토·이해·검증할 책임을 두고, 대부분 생성된 기여에 공개 표기를 요구합니다. 두 정책은 리뷰 기준의 채택 사례입니다. 도입 전후 결함률은 **[확인 필요]**입니다. [고정 SHA 원문](https://github.com/open-telemetry/community/blob/6d44ee3df36df59fdd2a5ce1adb406191d406608/policies/genai.md)

<a id="e10"></a>

### E10. 보안 경계 변경의 기여 지침

- **[확인]** Microsoft Agent Governance Toolkit의 기여 지침은 보안 관련 코드의 AI 변경을 따로 검토하고 환각 패키지 이름·폐기된 암호 알고리즘·안전하지 않은 기본값을 확인하도록 요구합니다. 고정 판본은 **2026-09-21**입니다. [고정 SHA 원문](https://github.com/microsoft/agent-governance-toolkit/blob/f3efe468001ed9d3165ac9e77a6e2c5231dc9f43/CONTRIBUTING.md)

### 도구와 확인 범위

- **[확인]** ast-grep은 AST의 안팎 관계를, Semgrep은 패턴과 지정한 출처·검증·도달 지점 사이 흐름을 검사할 수 있습니다. jscpd는 토큰 중복을 검사합니다. StrykerJS는 선택한 코드를 변형해 기존 시험이 실패하는지 확인합니다. **[추측]** 오탐 비용은 후보 범위·정상 반례·팀 계약에 좌우됩니다. 이 도구들의 공식 설명과 위에 직접 연결한 현행 규칙 설명에는 게시일 표기가 없어 확인일 **2026-11-18**을 적용했습니다. [ast-grep](https://ast-grep.github.io/guide/rule-config/relational-rule.html) · [Semgrep](https://docs.semgrep.dev/writing-rules/data-flow/taint-mode/overview) · [jscpd](https://jscpd.dev/) · [Stryker](https://stryker-mutator.io/docs/)
- **[확인]** 합성 lint와 이전 조사의 실험을 구분했습니다. 새 도구의 도입·성능 시험, AI 작성 비율 추정, 현재 제품 결함 전수조사는 이번 확인 범위 밖입니다. **[확인 필요]** 모델·프롬프트·작업·저장소가 달라질 때 각 패턴의 빈도와 새 방어의 효과. [기존 실험과 한계](static-analysis-rules-references.md#한계와-미확인)
