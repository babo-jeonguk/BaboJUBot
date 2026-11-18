# static-analysis-rules 레퍼런스 조사

조사일: 2026-11-18. 대상: [반복 지적 코드 패턴](review-pattern-history.md)을 lint·타입 검사·`pnpm check`로 막을 수 있는지. 시험 코드 규칙은 다루지 않는다. 구현 전 권고이며 확정 계약이나 구현 결과가 아니다. 채택한 규칙은 아래 채택 결과와 [lint 설정](../../eslint.config.js)이 맡는다.

| 순서·패턴 | 다음 PR에서 고를 방법 | 현재 예상 적중 | 오탐·정상 대조군 | 비용·권고 |
| --- | --- | --- | --- | --- |
| 1 · C2, C3, 일부 C4 | 런타임의 격리 프로바이더 실행을 기존 실행 경계로 통과시킨 뒤, **그 소비자에서만** `no-restricted-imports`로 원시 `spawn`·`fork` 금지 | 경계 밖 직접 호출을 옮긴 뒤 위반 0건을 목표로 설정. 단순 인라인 상속 9줄 중 격리 소비자에서 확정한 위반 0건 | 의도적으로 부모 환경을 쓰는 로컬 실행, Windows job launcher, 장기 감독 프로세스 | 규칙 비용 낮음, 경계 계약 확인은 중간 · **변형 채택** [D01](#D01) |
| 2 · C1 | 수명 소유 지점에서 기존 순차 실패 수집 방식 재사용. 짧은 역순 정리에는 `await using` 검토 | 일반 소스·스크립트 195개에서 `finally` 51개 중 최상위 `await` 문 2개 이상인 곳 2건, 모두 수동 프로바이더 스크립트 | 제품 서버의 정해진 직렬 종료, 뒤 단계가 앞 단계 성공을 전제하는 호출 | 구조 수정 낮음~중간 · **변형 채택**. 연속 `await` lint는 배제 [D02](#D02) |
| 3 · C3 인접 Promise 오류 | 기존 typed `src`에서 업무 파일만 `no-floating-promises` 기본 옵션으로 진단. `no-misused-promises`는 별도 평가 | 기본 5건, 모두 업무 코드. `no-misused-promises` 3건 중 업무 2건. `ignoreVoid: false`는 97건 | `after-commit`의 실패 기록을 거친 Promise 4건. 기존 백그라운드 `void` 호출 | 설정 낮음, 기존 진단 분류·실행 시간 중간 · **보류** [D03](#D03) |
| 4 · C4, C9 | 유한 명령·준비·종료에는 소유 지점의 시한. workflow는 기존 다운로드·집계 계약 시험에 해당 단계만 포함 | 알려진 workflow의 job 시한 누락 0건. 일반 프로세스 timeout 규칙은 릴리스 미포함 확인 | 장기 실행 자식, job 상한이 적용되는 짧은 checkout·로그 단계 | 기존 검사 확장 낮음 · **변형 채택**. 전역 timeout 린트는 보류 [D04](#D04) |
| 5 · C5 | 작업 전 존재 검사 대신 직접 읽고 예상 오류만 분기. 격리 경로는 고정된 읽기 경계를 사용 | CodeQL에서 과거 #178 형태 0건. 현재 스크립트의 단순 확인 후 읽기 수동 표본 4곳 | 존재 자체를 검증하는 boot 검사, 정적 UI 디렉터리를 분기하는 서버 | 구조 수정 낮음~중간 · **변형 채택**. 범용 경쟁 탐지기는 배제 [D05](#D05) |
| 6 · C6 | 코드 지도에서 안정된 파일 참조를 기존 링크 검사로 보냄 | 경로 이동 후 오래된 링크에 1건씩. 백틱 심벌·새 파일 누락에는 0건 | 행에는 라우트·패키지·시험 제목·지역 심벌도 들어감 | 기존 비용 거의 없음 · **변형 채택**. 전수 매칭은 배제 [D06](#D06) |
| 7 · C7 | 계약 값에서 파생하고 전체 대응표에 `satisfies Record<Union, Value>` 사용 | 새 union 값에 누락된 대응표마다 타입 오류 1건. 기존 임의 리터럴 배열에 자동 적중 0건 | 의도적으로 제외한 종료 상태, 화면 필터의 부분 집합 | 검사 추가 비용 없음 · **변형 채택** [D07](#D07) |
| 8 · C2, C5 관련 의존 방향 | 현재 `no-restricted-imports` 유지. 필요한 패키지 import나 공개 subpath만 경계 명세와 함께 추가 | 합성 회귀에서 정적 금지 import 1건당 1진단. 현재 좁은 그래프에서 0건 | core의 `node:crypto` 해시, contracts의 `node:http` 타입 | 목록 비용 낮음, 해석 그래프는 중간 · **보류** [D09](#D09) |
| 9 · C8 | 한국어 금지어 목록을 Vale·textlint 또는 토큰 검색으로 검사 | 한국어 합성 경고 0→4건. 저장소 실적중 미확인 | 조사 기록의 인용·과거 명칭, 다른 층의 같은 토큰 | 사전·예외 관리 중간~높음 · **배제** [D08](#D08) |

> **채택 결과(2026-11-18):** 다음 PR은 위 1번(runtime의 프로그램 실행 위치 제한)과, 이 조사 밖의 일반 규칙 셋(바깥 데이터 `any` 사용 금지, 객체 리터럴 `as` 금지, 느슨한 비교 금지)을 채택했습니다. 1번은 과거 사례(#163·#165·#200)가 모두 공용 실행 함수 안이나 개발 스크립트에서 생겨 그 사례를 막지는 못하고 앞으로의 우회만 막습니다. 3번 Promise 진단은 적중 5건이 모두 의도된 코드여서 넣지 않았습니다. 현행 기준은 [lint 설정](../../eslint.config.js)입니다.

조사일 2026-11-18. BaboJUBot 기준 SHA `feac87acd156e7234528bfd2336b84850af7c17b`. 다음 PR의 규칙 선택을 위한 조사입니다. 위 표에서 실측 수와 도입 후 예상 수를 구분했습니다. 리뷰 기록의 반복 PR 수는 과거 영향의 근거이며 현재 적중 수에는 합산하지 않았습니다.

## Brief

기록상 실제 영향이 확인된 C1(일반 코드·스크립트 7 PR), C2(3 PR), C3(3~4 PR), C4(6 PR 중 일부), C5(3 PR와 #178)를 먼저 다뤘습니다. C6은 약 16 PR에서 위치·형식 수정으로 처리됐고, C7(5 PR)·C8(7 PR)은 리뷰 비용 중심입니다. C9(3 PR)는 일부 CI 결과에 영향을 주었고 이미 해당 계약 시험이 있습니다. 이 수는 회차 처리 기록의 개략치입니다. [리뷰 패턴 요약](review-pattern-history.md#2-요약--규칙-후보가-될-만한-상위-패턴)

- 실제 결함이나 CI 실패를 반복시킨 코드 형태 가운데 수정 방향을 오류 메시지로 알려 줄 수 있는 최소 규칙을 찾습니다.
- 동종 문제는 실패를 소유하는 진입점으로 호출을 모으고, 그 경계에서 포착 가능한 위반만 자동으로 검사하는 일입니다.
- 조직 경계·초기 승인·최종 완료는 제품 코드가 강제합니다. [ADR-0001](../adr/0001-adapter-control-plane.md), [ADR-0004](../adr/0004-paperclip-aligned-stack.md), [ADR-0005](../adr/0005-approval-policy-enforcement-scope.md), [기능 범위](../features.md), [아키텍처](../architecture.md) 및 [용어집](../../GLOSSARY.md)을 기준으로 삼았습니다. 시험 코드 규칙은 진행 중인 별도 작업 범위입니다.

| ID | 조사 질문 | 출처 | 전략 |
| --- | --- | --- | --- |
| Q1 | C1·C3·C5·C2·C4의 실패를 막는 기능·규칙과 오탐 | [리뷰 패턴 3·5·6절](review-pattern-history.md), [코드 작성 기준](../../CODING_STANDARDS.md) | 저장소 진입점·실패 경로 추적, 공개 릴리스와 직접 실행 대조 |
| Q2 | 기존 TS 프로젝트에서 Promise 검사 확장 효과와 비용 | [ESLint](../../eslint.config.js), [TS 설정](../../tsconfig.base.json) | 고정 버전·동일 파일 대조, TS 프로젝트 포함 범위 확대 |
| Q3 | C6~C9에 가벼운 기계적 검사나 타입 구조가 있는가 | [프로젝트 검사](../../scripts/check-project.mjs), [코드 지도](../agents/code-map.md) | 운영 도구 비교, 현재 파일·정상 반례 확인 |
| Q4 | 공개 경계 시험과 도메인 의존 방향을 어디까지 강제하는가 | [아키텍처](../architecture.md#패키지-구성), [기존 시험 규칙](../../scripts/eslint-test-rules.mjs) | 원전의 경계와 로컬 공개 진입점 대조, import 검출 대조 |
| Q5 | 유지·예외·점진 도입과 실패 사례 | [리뷰 패턴 5·6절](review-pattern-history.md), [규칙 회귀 시험](../../scripts/lint-rules.test.mjs) | 공식 API·운영 사례와 리뷰 기록 비교 |

| 기존 조사 | 재사용 범위 | 재확인 |
| --- | --- | --- |
| [리뷰 패턴 기록](review-pattern-history.md) | 실패 이력, 이미 번복한 지적, T1~T10 분류 | #229·#230의 현행 설정과 대기 브랜치 스냅샷 대조. 회차 처리 결론은 입력의 판단을 인용 |
| [서버 종료](graceful-shutdown-references.md#패턴)·[자식 정리](orphan-process-cleanup-references.md#패턴) | 정리 순서·OS별 경계 | 현행 앱 종료와 Node 24 문서 재확인. 예전 외부 SHA에서 구현을 가져오는 권고는 없음 |
| [실행 격리](executor-isolation-references.md#1-격리-방식과-단위)·[산출물 경로](artifact-path-confinement.md#공통-결론) | 실행 환경과 파일 읽기 진입점의 범위 | 현행 소스 대조. 이전 운영 실험 결과를 새 lint 실측에 포함하지 않음 |
| [코드 작성 기준 조사](coding-standards-references.md#질문별-답) | 사람이 판단할 기준과 자동 규칙의 위치 | 현재 `CODING_STANDARDS.md`와 회귀 시험만 현재 기준으로 사용 |

## 레퍼런스

관점별 탐색 종료 기준은 마지막 비교에서 새 해결 방식이나 실패 유형이 추가되는지였습니다. 언어·런타임은 정리 구문에서 오류 표현과 emitter 계약으로 넓혔고, CodeQL의 읽기 예외까지 확인했습니다. 경계·도구는 지역 selector, import 제한, 해석된 그래프를 비교했고 계산된 import가 공통 한계로 남았습니다. 운영·문서는 workflow 스키마, 정책, 제품 계약 시험과 코드 지도 링크·생성 방식까지 넓혔습니다. 스키마 검사에서 재시도 총량이나 집계의 의미를 판정하는 기능은 찾지 못했습니다.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
| --- | --- | --- | --- | --- | --- |
| Node.js·TypeScript | 런타임·언어 | Node 24.21.0 `955266bfdd854cd280dffd47548673914484e4c0`, TS 6.0.3 `050880ce59e30b356b686bd3144efe24f875ebc8`, `@types/node` 24.19.2 | MIT 계열(Node), Apache-2.0(TS), MIT(타입) | 실행·문서 | 저장소와 일치하는 정리·프로세스 계약 |
| ESLint·typescript-eslint | 기존 분석기 | ESLint 10.12.0 `a438ec39512c3381f4785a1f3058982ce9845970`, typescript-eslint 8.71.2 `7488d681f6e0e96c2aaa1eee9c3d1b9b1ef077cb` | MIT | 실행·소스 | 새 엔진 없이 좁은 범위와 부하 비교 |
| Execa·eslint-plugin-n | 실행 래퍼·Node lint | Execa 10.2.1 `247faa0ff0641020e8790475989cee72df85d62b`, plugin-n 18.5.0 `5bbe603030c658599db596a7175e1094b01c0157` | MIT | 실행·소스 | 기본 환경 상속과 릴리스에 없는 시한 규칙 대조 |
| CodeQL | 경로 데이터흐름 질의 | `8f4acc4edf216c0ff0d6c44ece272e8c8b64a7cb` | 질의 MIT, CLI 별도 조건 | 소스 | #178 형태를 명시적으로 제외 |
| eslint-plugin-boundaries·dependency-cruiser | 의존 방향 | boundaries 7.4.1 `ab01ec5b18b13ae8b309a0f887a33a47998e3d51`, dependency-cruiser 18.8.0 `925af173a09e6885d6ea6c4b91b51cd0f555cad3` | MIT | 문서·그래프 실행 | 상대 경로·타입·리터럴 동적 import의 검출 차이 |
| Vitest·Playwright | 시험 실행기 | Vitest 5.0.5, Playwright 1.65.1 `bbd948344ea9a60bf1e6f125c02ca99b2b51593b` | MIT·Apache-2.0 | 실행(Vitest 합성), 소스(Playwright) | 본문과 정리 실패가 어떻게 표시되는지 확인 |
| actionlint·ghalint·jactionlint·zizmor | CI | 1.7.12 `914e7df`, 1.6.0 `db3f6a7`, 2.6.0 `72c0045`, 1.32.0 `21bd300` | MIT | 격리 실행 | workflow 구문·정책과 저장소 판정 구분 |
| Lychee·TypeDoc·Vale·textlint-rule-prh | 문서 | 0.24.2 `2bba271`, 0.28.20 `34d843b`, 3.27.0 `4ce91ef`, 6.1.1 `ea507ea` | MIT 또는 Apache-2.0(Lychee), Apache-2.0(TypeDoc), MIT(Vale·prh) | 격리 실행·문서(prh) | 파일·심벌 참조와 용어 문맥을 구분 |
| eslint-plugin-playwright·@vitest/eslint-plugin | 시험 lint 인계 | 2.12.2 `d499b63`, 1.6.28 `c5df105` | MIT | 격리 실행 | 담당 작업과 겹치는 규칙만 비교 |
| Cockburn·Evans, reviewdog | 설계·운영 | 공개 원전과 도구 설명, 2026-11-18 확인 | 설계 참고, reviewdog MIT | 문서 | 테스트 seam과 변경 범위 기반 점진 도입 |

## 근거

| ID | 관찰 | 출처 | 수준 |
| --- | --- | --- | --- |
| <a id="e01"></a>E01 | C1은 일반 코드·스크립트 7 PR에서 지적됐고 #87·#168 등에서 실패가 재현됐다. 현재 제품의 서버 종료는 정해진 단계마다 실패를 모아 최종 `AggregateError`로 보고한다. 반면 `no-unsafe-finally`가 잡는 것은 `finally` 밖으로 나가는 명시적 제어문이다. `await close()`의 거부로 그 뒤가 건너뛰는 형태는 규칙의 대상 밖이다. | [리뷰 패턴 C1](review-pattern-history.md#c1-정리-단계-연쇄), [서버 종료](../../apps/server/src/app.ts), [ESLint 규칙](https://eslint.org/docs/latest/rules/no-unsafe-finally) | 저장소·공식 문서 |
| <a id="e02"></a>E02 | `target/lib: ES2023`, `erasableSyntaxOnly`, `noEmit`를 상속한 격리 프로젝트에서 TS 6.0.3이 `await using`과 스택을 타입 검사했다. `@types/node`가 `esnext.disposable` 선언을 참조한다. Node 24.21.0에서 단독 선언과 스택 모두 B→A를 실행하고 정리 A·B와 본문 오류를 중첩 `SuppressedError`에 보존했다. 연속 `await`를 둔 `finally`는 B만 실행하고 본문 오류를 잃었다. TS AST 검색에서는 일반 소스·스크립트 195개 중 해당 최상위 모양 2건을 찾았다. 두 지점은 수동 실행 스크립트의 서버→DB→폴더 정리다. | [Node 24 릴리스](https://nodejs.org/en/blog/release/v24.0.0), [TS 5.2 리소스 관리](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html), [TS 5.8 타입 제거 제한](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-8.html), [TS 설정](../../tsconfig.base.json), [수동 실행](../../scripts/provider-live.mjs), [수동 점검](../../scripts/provider-smoke.mjs) | Linux 실행·AST 계수, 공식 문서 |
| <a id="e03"></a>E03 | 자식 `error`와 쓰기 스트림 `error`는 별개다. Node 24.21.0 Linux에서 조기 종료한 합성 자식에 썼을 때 반환값은 `false`, 콜백과 stdin 이벤트는 각각 EPIPE였다. 기존 `startProcess`는 stdin 오류를 `inputFailed`로 알리고 자식 쪽도 감시한다. Node의 자식 `Symbol.dispose`는 SIGTERM 요청까지 맡는다. 정리에서 실제 exit와 stdio close를 기다리는 책임은 별도다. | [Node ChildProcess 계약](https://nodejs.org/download/release/v24.21.0/docs/api/child_process.html#event-error), [Node writable.write](https://nodejs.org/download/release/v24.21.0/docs/api/stream.html#writablewritechunk-encoding-callback), [런타임 공용 실행](../../packages/runtime/src/providers/process.ts) | Linux 실행·공식 문서·저장소 |
| <a id="e04"></a>E04 | Node에서 `env` 생략은 부모 상속이고 명시 객체는 교체다. 합성 환경 키는 Execa 기본값에서 상속됐고 `extendEnv: false`에서 제외됐다. Windows 환경 키는 대소문자를 구별하지 않으므로 허용 키 정규화와 충돌 우선순위가 필요하다. 현재 `providerEnvironment`는 격리 모드에서 연결별 추가 상속을 비우고, `dockerClientEnv`는 Docker 실행 전용 환경을 만든다. 전체 환경을 `env:`에 바로 넘기는 단순 검색 9줄 중 업무·개발 스크립트는 3줄이고, 격리 프로바이더 직접 실행에서 확정한 위반은 0건이다. 부모 상속을 빠짐없이 판정할 수 있는 배포 규칙은 조사한 목록에서 찾지 못했다. security 4.2.1의 `detect-child-process`는 `require` 및 비정적 `exec`를 보며 env 출처와 오류 채널을 검사하지 않는다. | [Node 환경 계약](https://nodejs.org/download/release/v24.21.0/docs/api/child_process.html#child_processspawncommand-args-options), [Execa getEnv](https://github.com/sindresorhus/execa/blob/247faa0ff0641020e8790475989cee72df85d62b/lib/arguments/options.js#L79-L140), [Daintree 허용 목록과 Windows 키 처리](https://github.com/daintreehq/daintree/blob/167352d4fcdab481487ed6eaaabf408b22c39f57/electron/utils/minimalSpawnEnv.ts#L68-L127), [컨테이너](../../packages/runtime/src/providers/container.ts), [security 4.2.1](https://github.com/eslint-community/eslint-plugin-security/blob/7c5b9cd51a70862b598d6125e50aae8af885d963/rules/detect-child-process.js#L26-L68) | Linux 실행·문서·문자열 표본. Windows 동작은 문서 |
| <a id="e05"></a>E05 | `no-floating-promises` 기본값은 명시적 `void`를 통과시킨다. `void`는 거부 처리기를 붙이지 않는다. `no-misused-promises`는 조건·spread와 `void` 반환 계약의 콜백을 검사한다. 둘 다 Node emitter에 리스너를 연결했는지 알 수 없다. | [floating 옵션](https://typescript-eslint.io/rules/no-floating-promises/#ignorevoid), [misused 옵션](https://typescript-eslint.io/rules/no-misused-promises/#checksvoidreturn), [upstream 기본 옵션 구현](https://github.com/typescript-eslint/typescript-eslint/blob/7488d681f6e0e96c2aaa1eee9c3d1b9b1ef077cb/packages/eslint-plugin/src/rules/no-misused-promises.ts#L194-L202) | 소스·문서, 격리 합성 실행 |
| <a id="e06"></a>E06 | typed `src` 257개를 같은 파일로 비교했다. 기존 exhaustive-switch 단독 **12.8초 / 1.30GiB**, Promise 두 규칙 기본 **30.7초 / 1.66GiB**, `ignoreVoid: false` **31.2초 / 1.86GiB**. 느린 첫 타입 질의와 프로젝트 로드 비용이 섞인 단일 실행별 최고 RSS다. 기본 floating 다섯 건은 `after-commit` 네 건과 웹 `navigate` 한 건이었다. 두 웹 mutation `onError`와 시험용 HTTP 서버의 async 리스너가 misused 세 건이었다. | [현재 typed 설정](../../eslint.config.js), [commit 뒤 실행](../../apps/server/src/after-commit.ts), [조직 생성](../../apps/web/src/create-organization.tsx), [승인 화면](../../apps/web/src/approvals.tsx), [전역 설정](../../apps/web/src/global-settings.tsx), [공식 성능 가이드](https://typescript-eslint.io/troubleshooting/typed-linting/performance/) | Linux arm64, Node 24.21.0, ESLint 10.12.0, TS 6.0.3, typescript-eslint 8.71.2 격리 실행 |
| <a id="e07"></a>E07 | 서버·웹의 프로젝트에 포함된 시험 TS는 같은 서비스를 사용할 수 있다. `src` 밖 TS·TSX와 config까지 넓힌 362개는 45.2초 / 2.61GiB, 추가 Promise 진단 1건과 TS 프로젝트 밖 config 두 곳의 파싱 오류를 냈다. 두 `scripts/*.mjs`도 단순 확장 시 모두 파싱 오류였다. 두 파일만 `allowDefaultProject`와 `allowJs`가 있는 격리 설정에 넣으면 3.0초 / 0.38GiB에 Promise 진단 0건이다. `allowDefaultProject`는 `**`를 허용하지 않고 기본 최대가 8개다. JS 전용 프로젝트를 만들면 범위를 넓힐 수 있지만 별도 설정과 JS 추론 품질을 관리해야 한다. | [projectService 안내](https://typescript-eslint.io/troubleshooting/typed-linting/#project-service-issues), [parser 제약](https://typescript-eslint.io/packages/parser/#allowdefaultproject), [서버 TS](../../apps/server/tsconfig.json), [웹 TS](../../apps/web/tsconfig.json) | 격리 실행·공식 문서 |
| <a id="e08"></a>E08 | `n/require-child-process-timeout`은 릴리스 18.5.0의 내보낸 규칙에 없다. 고정 upstream 구현은 해석 가능한 별칭과 `require` 등에서 시한 없는 호출·리터럴 0을 잡고, 양수 timeout이나 async signal을 인정한다. 옵션의 값이 동적이거나 signal이 실제 중단될지 모르면 진단하지 않는 경우가 있다. Node timeout도 종료 신호를 보낸 뒤 자식 종료가 늦을 수 있다. | [upstream 규칙](https://github.com/eslint-community/eslint-plugin-n/blob/96aa33410da24ac4a6467adcd6f4f9386086f4a8/docs/rules/require-child-process-timeout.md#L11-L69), [Node execFileSync 계약](https://nodejs.org/download/release/v24.21.0/docs/api/child_process.html#child_processexecfilesyncfile-args-options), [검사 대상 예](../../scripts/boot-check.mjs) | 릴리스 export·upstream 실행·문서 |
| <a id="e09"></a>E09 | CodeQL `js/file-system-race`는 정밀도 medium이고 같은 경로와 실행 순서를 보지만 **exists 계열 검사 뒤 readFile 계열 읽기는 명시적으로 제외**한다. 따라서 #178 모양의 적중은 0이다. 공개 오탐 보고는 권한 검사 뒤 파일 내용을 단언하는 시험이다. 현재 단순 형태는 boot-check, file-boundary-report, chaos-budget, chaos-server 네 지점에서 확인했다. 실제 실패 여부는 호출 맥락에 달린다. 존재 자체가 관찰값인 검사도 있다. 제품의 산출물 경로는 이미 고정한 경계가 맡으며 rename 경쟁은 별도 실패 계약이다. | [CodeQL 설명](https://codeql.github.com/codeql-query-help/javascript/js-file-system-race/), [고정 질의 필터](https://github.com/github/codeql/blob/8f4acc4edf216c0ff0d6c44ece272e8c8b64a7cb/javascript/ql/src/Security/CWE-367/FileSystemRace.ql#L112-L118), [Node fs 계약](https://nodejs.org/download/release/v24.21.0/docs/api/fs.html#fsaccesspath-mode-callback), [경로 조사](artifact-path-confinement.md#공통-결론), [공개 오탐 보고](https://github.com/github/gh-aw-firewall/issues/10111) | 질의 소스·문서·수동 표본. CLI 실행 미확인 |
| <a id="e10"></a>E10 | 코드 지도 Lychee 0.24.2 오프라인 점검에서 412 링크(333개 고유) 모두 통과했다. 합성 파일에서 죽은 상대 링크와 한글 Markdown anchor는 검출했고 단순 백틱 심벌과 TS 줄 표시는 통과했다. TypeDoc 0.28.20은 명시적 JSDoc `{@link}`만 합성 사례에서 검증했다. 프로젝트 검사로는 현재 파일 존재를 확인할 수 있다. mittwald/agent-skills가 오프라인 링크를 PR에서 보는 사례도 있다. CODEOWNERS는 경로의 리뷰 권한에 쓰인다. | [Lychee 릴리스](https://github.com/lycheeverse/lychee/releases/tag/lychee-v0.24.2), [TypeDoc validation](https://typedoc.org/documents/Options.Validation.html), [현재 검사](../../scripts/check-project.mjs), [공통 경로 지도](../agents/code-map/shared-path.md), [mittwald/agent-skills CI](https://github.com/mittwald/agent-skills/blob/f2742eb0ccd1a03007499d74772bc1808e547486/.github/workflows/ci.yml#L31-L37), [GitHub CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) | 오프라인 실행·문서 |
| <a id="e11"></a>E11 | 현재 계약은 `runStatusSchema.exclude([\"running\"])`를 파생하고 대시보드는 `.options`를 읽는다. `ApprovalKind` 대응표는 `satisfies Record`를 사용한다. TS 6.0.3 합성 사례에서도 `satisfies readonly Contract[]`는 부분 집합을 허용했고 `satisfies Record<Contract, string>`는 누락 또는 초과 키를 오류로 처리했다. | [실행 계약](../../packages/contracts/src/run.ts), [승인 계약](../../packages/contracts/src/approval.ts), [대시보드](../../apps/web/src/dashboard.tsx), [TS satisfies](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator) | 격리 타입 검사·저장소 |
| <a id="e12"></a>E12 | Vale 3.27.0 `substitution` 기본 단어 경계에서는 합성 한국어 구절이 지나갔다. `nonword: true`는 한국어 본문과 TS 주석을 잡았고, 과거 명칭을 설명하는 허용 맥락도 같이 진단했다. 합성의 인라인 코드·문자열은 지나갔다. textlint 용어 사전 역시 검사 대상·예외가 필요하다. | [Vale substitution](https://docs.vale.sh/checks/substitution), [textlint-rule-prh](https://github.com/textlint-rule/textlint-rule-prh/tree/ea507ea65fb725980ad04f67f45377b015e88cf0), [용어집](../../GLOSSARY.md) | Vale 실행·문서. textlint 문서만 |
| <a id="e13"></a>E13 | 합성 workflow에서 actionlint 1.7.12는 잘못된 시한 자료형·없는 `needs`를 잡고 누락 시한과 집계 의미는 통과시켰다. ghalint 1.6.0 정책 012는 job 시한 누락을 잡되 모든 step에 시한이 있으면 허용했다. jactionlint 2.6.0은 그 job도 누락으로 잡고 `needs.*.result`와 암묵적 skip의 조합을 진단했다. `always()`를 붙인 뒤 실패 상태가 통과하는 식과 하위 재시도 총량은 통과했다. zizmor 1.32.0 오프라인 검사는 같은 합성 사례에서 관련 진단 0건이다. 현재 scaffold에 있는 전체 51개 시한과 집계·다운로드 검사로 확인한 계약은 이 도구와 범위가 다르다. | [actionlint 검사 범위](https://github.com/rhysd/actionlint/tree/914e7df21a07ef503a81201c76d2b11c789d3fca#features), [ghalint 정책](https://github.com/suzuki-shunsuke/ghalint/blob/db3f6a73750c237074a17298010c322ec321e6dc/docs/policies/012.md), [zizmor 감사 규칙](https://docs.zizmor.sh/audits/), [workflow](../../.github/workflows/scaffold.yml), [집계 시험](../../scripts/ci-test-gate.test.mjs), [다운로드 시험](../../scripts/ci-downloads.test.mjs) | 오프라인 실행·저장소·공식 문서 |
| <a id="e14"></a>E14 | core의 계약 import는 허용됐고 DB 타입 import·runtime subpath re-export에 ESLint가 진단했다. 상대 경로와 동적 리터럴은 통과했다. dependency-cruiser는 합성의 상대 경로·별칭 타입 import·re-export·리터럴 동적 import를 막고 계산된 동적 경로를 통과시켰다. 현재 core/contracts 바깥 의존 금지 그래프 자체는 40모듈·155의존에서 위반 0개다. | [ESLint import 범위](https://eslint.org/docs/latest/rules/no-restricted-imports), [boundaries 규칙](https://www.jsboundaries.dev/docs/rules/dependencies/), [dependency-cruiser 옵션](https://github.com/sverweij/dependency-cruiser/blob/925af173a09e6885d6ea6c4b91b51cd0f555cad3/doc/options-reference.md), [저장소 ESLint](../../eslint.config.js) | 격리 합성·로컬 그래프 실행, 플러그인 문서 |
| <a id="e15"></a>E15 | Cockburn의 포트는 운영 UI와 시험이 같은 응용 접근점을 공유할 수 있게 한다. Evans의 계층 원칙은 도메인 규칙을 UI·인프라로부터 독립시키는 데 해당한다. 여기서는 Control Plane ingress와 실행 adapter 계약을 통해 조직 범위·승인·stdin 실패를 관찰할 근거다. 조직별 데이터 격리는 실행 때 코드가 강제하며 저장소 경로 규칙은 패키지 의존에 적용한다. | [Cockburn 원전](https://alistair.cockburn.us/hexagonal-architecture/), [Evans 원고 4장](https://fabiofumarola.github.io/nosql/readingMaterial/Evans03.pdf), [제품 불변 조건](../architecture.md), [도메인 기준](../agents/domain.md), [런타임 계약 시험](../../packages/runtime/src/runtime-contract.ts) | 원전·저장소, 적용 판단은 추론 |
| <a id="e16"></a>E16 | ESLint RuleTester의 valid/invalid와 현재 `lint-rules.test.mjs`의 실제 설정 경계 시험은 상호 보완한다. Bulk suppression은 파일·규칙별 개수를 잠그고 stale entries를 prune할 수 있다. 같은 파일·규칙에 새 진단이 생기면서 기존 것이 하나 줄면 개수상 통과할 수 있다. reviewdog added-lines 방식도 변경 밖 위치에 보고되는 오류를 놓칠 수 있다. 과거 typescript-eslint #4619에는 React callback 옵션 변경 뒤 기존 프로젝트에서 100건 이상 생겼다는 사용자 보고가 있다. | [RuleTester](https://eslint.org/docs/latest/integrate/nodejs-api#ruletester), [ESLint baseline](https://eslint.org/docs/latest/use/suppressions), [reviewdog filter mode](https://github.com/reviewdog/reviewdog#filter-mode), [사례 #4619](https://github.com/typescript-eslint/typescript-eslint/issues/4619), [기존 회귀 검사](../../scripts/lint-rules.test.mjs) | 공식 문서·공개 사례. 저장소에서 같은 실패율은 미확인 |
| <a id="e17"></a>E17 | 고정 upstream 시한 규칙으로 별도 ESLint 설정에서 421개를 검사해 34파일·71진단이 나왔다. 시험 파일·시험 디렉터리·지정 지원 파일을 경로 패턴으로 거른 뒤에는 10건이었다. 장기 웹 시험 서버, 외부에서 감독하는 boot-check 서버, 의도적으로 멈추는 fixture도 잡았다. 임의 AbortSignal을 주면 실제 중단 가능성에 관계없이 통과한 합성 대조군이 있다. | [고정 규칙 원문](https://github.com/eslint-community/eslint-plugin-n/blob/96aa33410da24ac4a6467adcd6f4f9386086f4a8/lib/rules/require-child-process-timeout.js), [boot-check](../../scripts/boot-check.mjs), [Git 작업](../../scripts/gh-post.mjs) | Linux 격리 실행 |
| <a id="e18"></a>E18 | 이미 있는 `pnpm check`는 집계가 허용하는 결과 값과 다운로드 단계의 최악 재시도 예산을 시험한다. 외부 alls-green 액션은 `needs` 결과를 받고 허용 실패·skip을 입력으로 명시하는 선례다. 이를 바꿔도 matrix 각 작업의 결과를 한 값으로 압축할 때 그 내역이 복구되지는 않는다. 기준 scaffold에서 actionlint와 jactionlint 선택 규칙은 0건이었다. | [alls-green 입력과 판정](https://github.com/re-actors/alls-green/blob/b5b5b37504aa4183270bd3d855c52a67f212be35/action.yml#L15-L52), [jactionlint 시한](https://github.com/jdx/jactionlint/blob/72c00452809bcca05b8bc12acdcf15dd7a9c1c5e/rule_timeout_check.go#L78-L123), [jactionlint 집계 skip](https://github.com/jdx/jactionlint/blob/72c00452809bcca05b8bc12acdcf15dd7a9c1c5e/rule_gate_job_skipped_on_failure.go#L31-L84), [현재 집계 시험](../../scripts/ci-test-gate.test.mjs) | 소스·Linux 실행 |
| <a id="e19"></a>E19 | Vitest 5.0.5 합성 시험의 JSON에서 별도 `onTestFinished` 콜백 두 개는 본문과 정리 오류 두 개를 각각 보고했다. 같은 실패를 `await using stack`에 담으면 보고서에는 `SuppressedError` 한 항목이 나왔다. Playwright은 fixture를 의존 역순으로 정리하면서 오류를 기록하지만, 할당 시한이 소진되면 해당 teardown을 건너뛸 수 있다. | [Vitest hook](https://vitest.dev/api/hooks.html#ontestfinished), [Playwright fixtureRunner](https://github.com/microsoft/playwright/blob/bbd948344ea9a60bf1e6f125c02ca99b2b51593b/packages/playwright/src/worker/fixtureRunner.ts#L128-L145), [Playwright 오류 기록](https://github.com/microsoft/playwright/blob/bbd948344ea9a60bf1e6f125c02ca99b2b51593b/packages/playwright/src/worker/testInfo.ts#L383-L438) | Vitest 격리 실행·Playwright 소스 |
| <a id="e20"></a>E20 | Playwright lint의 `no-wait-for-timeout`은 해당 메서드를 잡고 Node sleep은 통과시켰다. `no-nth-methods`는 `.first()`를 거르고 같은 fixture의 넓은 `getByText` 부정 단언은 통과했다. Vitest와 Playwright의 조건부·존재 단언 검사는 명시적 조건부·단언 부재를 잡았다. 이미 참인 값을 다시 단언하는 경우는 통과했다. | [Playwright lint 규칙](https://github.com/mskelton/eslint-plugin-playwright#rules), [Vitest lint 규칙](https://github.com/vitest-dev/eslint-plugin-vitest#rules), [테스트 작성 원칙](https://testing-library.com/docs/guiding-principles/), [Beck의 Canon TDD](https://newsletter.kentbeck.com/p/canon-tdd) | 격리 실행·문서. 제품 E2E 실행 없음 |
| <a id="e21"></a>E21 | Google의 자체 배치 경험은 작성 흐름 중 조치할 수 있는 진단과 사용자의 피드백을 중요하게 다룬다. 공개 결과로 이 저장소의 리뷰 회차 감소를 환산할 수 없다. | [Google의 정적 분석 배치 경험](https://research.google/pubs/lessons-from-building-static-analysis-tools-at-google/), [Tricorder 평가](https://research.google.com/pubs/archive/43322.pdf) | 운영 경험 보고·추론 |

측정은 캐시를 끈 별도 프로세스에서 했습니다. 격리 설정은 관심 규칙만 포함해 플러그인 전체 성능이나 CI 소요 시간을 예측하는 수치로 쓰기 어렵습니다. `src` 비교의 기존 inline 주석 진단 두 건과 확대 비교에서 생긴 별도 inline 주석 진단은 Promise 수에 포함하지 않았습니다. 타입 확장 측정은 E2E 파일을 읽어 분석했으며 E2E를 실행하지 않았습니다.

Beck이 말한 동작의 호출 방법과 구현의 분리는 BaboJUBot에서 승인·조직 범위를 공개 진입점의 입력과 저장 결과로 확인하는 데 대응합니다. 경계 위반으로 실패하는 회귀 시험을 먼저 두고, 실행 helper 안에서 오류 전달을 고친 뒤에도 그 시험을 유지할 수 있습니다. ESLint는 합의된 패키지 import의 방향까지 확인합니다. 현재 module 배치는 하나의 제품 용어집을 사용하며, 연구 조직의 데이터 격리는 실행 때 조직 ID로 강제합니다. [Canon TDD](https://newsletter.kentbeck.com/p/canon-tdd), [도메인 기준](../agents/domain.md)

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
| --- | --- | --- | --- | --- | --- |
| P01 | 자식 환경과 생애주기를 호출 경계 한 곳에서 소유 | E03, E04, E17 | 포그라운드 확인과 장기 연결, 로컬과 컨테이너의 계약이 다름 | 금지 import 오류가 올바른 경로를 가리킴 | 모든 `child_process`에 붙이면 정상 감독·관리 호출까지 차단 |
| P02 | 정리 순서와 본문 오류의 소유자를 함께 선택 | E01, E02, E19 | 앱 종료는 명시 순서·집계, 짧은 수명은 역순 해제가 맞을 수 있음 | 앞 단계 실패 뒤에도 가능한 다음 정리 수행 | 스택 등록 순서, 부분 획득, 오류 표시를 검증해야 함 |
| P03 | 기존 타입 문맥에서 Promise 진단만 관찰 | E05~E07 | 서버와 웹의 콜백 계약, 일반 JS와 TS의 프로젝트 범위가 다름 | 명백히 누락된 await·reject 핸들러 발견 | false positive와 CI 증가, 알 수 없는 emitter 오류 |
| P04 | 필요한 계약의 상한·승인된 집계값을 직접 검증 | E08, E13, E17, E18 | 단계 기본값, 자식 신호, retry budget은 각자 다름 | 기존 시험에서 판정 근거를 표현 | config marker 하나는 실제 종료를 증명하지 못함 |
| P05 | 읽은 결과와 고정 자원을 사용 | E09 | 단순 파일 부재, 격리 경로, 동시 rename의 실패 계약이 다름 | 실패 분류가 실제 I/O 결과에 따름 | 같은 이름 검색은 별칭·helper를 놓치고 상태 조회를 섞음 |
| P06 | 이미 있는 링크 및 타입 검사로 원본 참조 | E10, E11, E12 | 코드 지도는 진입점 안내이고 용어집은 문맥 규칙을 포함 | 새 도구 없이 경로·계약값 누락을 잡음 | 심벌 의미, 부분 집합, 같은 글자의 다른 쓰임은 검토 필요 |
| P07 | 공개 seam을 통해 변화를 관찰하고 실제 import edge만 제한 | E14~E16, E20 | 테스트 경계는 HTTP, 공개 함수, adapter 계약일 수 있음 | 구현 이동 뒤에도 동작 시험이 유효 | 디렉터리나 mock 이름만 보는 규칙은 정상 seam 시험도 막음 |

## 결정 권고

| ID | 권고 | 설정·도입 | 근거와 판단 | 질문 |
| --- | --- | --- | --- | --- |
| <a id="D01"></a>D01 | 변형 채택 | 격리 프로바이더 소비자 glob을 정하고, 공용 실행 소유자(`process.ts`의 실행 함수 및 별도 launcher) 밖에서 `node:child_process`·`child_process`의 지정 import를 제한한다. 정적 named import와 namespace 접근을 함께 피해야 하면 해당 **소비자 glob에서 모듈 전체**를 제한한다. 오류 메시지는 해당 실행 함수 및 환경 작성 경계를 명시한다. 범위 확정 뒤 0건부터 오류로 켠다. | P01. C2의 env 누락과 C3의 emitter 오류는 **정책을 구현한 진입점**을 지나게 해서 줄인다. 실행·검사·로컬 진단에 같은 정책을 씌우면 오탐이 크다. 라이브러리 교체는 필요성을 확인하지 못했다. | Q1, Q4, Q5 |
| <a id="D02"></a>D02 | 변형 채택 | 현재 앱의 정해진 순차 실패 수집 방식을 수동 실행 두 지점에서 검토한다. 독립적으로 실패할 수 있는 정리를 모두 실행하고 본문 오류도 남기는 계약부터 정한다. 자원 획득의 역순이 계약인 곳은 `await using` 또는 `AsyncDisposableStack`을 쓸 수 있다. | P02. `Promise.allSettled`는 독립 정리일 때만 쓴다. 서버 종료 뒤 DB 종료와 폴더 삭제에는 순서가 있다. 뒷단 접근 자체가 안전하지 않을 때까지 무조건 실행하는 lint는 배제한다. | Q1 |
| <a id="D03"></a>D03 | 보류 | 다음 PR이 Promise 규칙을 고르면 먼저 현재 typed glob의 비시험 코드에 `no-floating-promises: ["warn", { ignoreVoid: true }]`을 별도로 관찰한다. 4건을 직접 await로 바꾸면 `applyAfterCommit` 계약과 지연이 바뀔 수 있으므로 안전한 fire-and-forget 경계를 확인한다. 확인한 뒤 좁은 파일 범위에서 오류로 올릴 수 있다. | P03. 기본 5건 중 네 건은 실패를 이미 기록하고 웹의 `navigate` 한 건은 반환·오류 계약을 추가 확인할 후보이다. `no-misused-promises`의 `checksVoidReturn`에서 attributes·properties 등을 끄고 arguments를 남긴 비교는 비시험 적중 0, 시험 적중 1이었다. 두 웹 콜백의 실제 거부 전달 여부를 확인할 때까지 일괄 예외·지연 추가는 보류한다. `ignoreVoid: false`와 scripts·시험 전체 확장은 제외한다. | Q1, Q2, Q5 |
| <a id="D04"></a>D04 | 변형 채택 | 새로 생기는 **유한** 프로브·Git·준비·종료의 소유자가 시한과 실패를 관리한다. 현재 `runProbe`, 작업별 종료 시한과 시한을 받는 실행 helper를 먼저 본다. workflow의 다운로드와 집계는 기존 `pnpm check`에 있는 계약 시험을 사용한다. | P04. 동일 문제에 대해 포괄 규칙 71건을 우선 수정할 근거는 없다. 구문 회귀가 반복되면 actionlint를 독립 진단에, job cap을 팀 정책으로 정하면 ghalint/jactionlint의 해당 규칙만 검토한다. #231의 사용자 번복 사례는 강제 범위에서 뺀다. | Q1, Q3, Q5 |
| <a id="D05"></a>D05 | 변형 채택 | 확인된 단순 읽기 경로에선 먼저 읽고 `ENOENT` 등 계약이 허용하는 오류만 분기한다. 이슈 #111·#131 계열의 경계는 기존 고정 읽기 진입점의 경쟁 회귀로 검증한다. 같은 모양을 자주 고치는 특정 helper가 생기면 **그 모듈에서만** 원시 접근을 제한하는 방식을 재검토한다. | P05. CodeQL 도입이나 범용 `existsSync`/read 금지로 #178을 지킬 수 있다는 근거가 없다. `accessSync`→read라도 검사 의도 자체가 권한 확인이면 별도 검토가 필요하다. | Q1, Q4 |
| <a id="D06"></a>D06 | 변형 채택 | 파일 위치는 기존 코드 지도 Markdown 링크로 두고 현재 `pnpm check`에 맡긴다. 기존 링크 검사에서 빠지는 **오래된 심벌**이 누적되면 명시적으로 표시한 참조만 검사할 수 있다. | P06. Markdown 링크 도구는 현재 파일 참조에 겹치고 TypeDoc은 JSDoc에 명시한 공개 심벌에 맞는다. 모든 새 파일의 지도 등록이나 백틱 심벌 전수 검사는 비용 대비 신뢰도가 낮다. | Q3 |
| <a id="D07"></a>D07 | 변형 채택 | 전체 값은 계약 tuple·`.options`에서 파생하고, 전체별 표현이 의무이면 `satisfies Record<Union, Value>`를 쓴다. 부분 집합은 계약의 `.exclude`/필터에서 의도를 드러낸다. | P06. 정적 복제 탐지는 계약과 비슷한 리터럴을 이유 없이 막고 기존 exhaustive-switch와 다른 확인을 보장하기 어렵다. | Q3 |
| <a id="D08"></a>D08 | 배제 | 정의·문맥이 필요한 용어집 문장은 리뷰에서 다룬다. 언젠가 특정 새 공개 식별자 하나를 예약할 때만 제한된 범위를 논의한다. | P06. 어휘 목록과 예외가 늘고 허용 문맥까지 지적한다. 한국어에 단순 단어 경계를 적용하는 것만으로는 빠지는 경우도 있다. | Q3, Q5 |
| <a id="D09"></a>D09 | 보류 | 현재 정적 import 제한과 package `exports` 유지. 다음 실제 상대·별칭 우회가 있다면 public subpath·폴더와 금지 edge를 먼저 정의한다. resolver가 필요하면 dependency-cruiser의 `forbidden` 두 규칙을 core/contracts에 한정하고, 편집기에서 즉시 진단해야 할 때 boundaries 요소·resolver 설정을 비교한다. | P07. 현재 좁은 그래프는 0건. core의 해시나 contracts의 타입 등 정상 edge가 있어 전부 금지하는 DDD 프리셋은 비용이 더 크다. 타입 전용 import 허용은 경계 계약에 따라 정한다. | Q4, Q5 |
| <a id="D10"></a>D10 | 배제 | 모든 시험의 내부 모듈 import 또는 `vi.mock`을 일괄 금지하지 않는다. package 경계를 건너는 비공개 subpath를 금지하는 정책을 따로 합의하면 특정 경로 위반은 막을 수 있다. | P07. 초기 승인·최종 완료·조직 경계는 Playwright 화면에만 의존하지 않고 실제 Control Plane 입력·응답과 저장 행위를 비교할 수 있다. C3는 adapter 프로토콜, C5는 고정 읽기나 경계 API 응답으로 확인한다. 동일 패키지의 공개된 도메인 함수와 주입한 가짜 adapter에 대한 시험은 유효하다. | Q4 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
| --- | --- | --- |
| 실패 부재와 확인 불가의 의미 판정, 락 순서, 상태 전이 | 리뷰 기록 5절, ADR-0005 | 도메인과 실행 계약을 통한 검증이 필요하다. 구문 검사와 그래프만으로 증명할 수 없다. |
| 중복 감지, 파일 크기·책임, 이름·주석 일반 기준, 전체 cast 제한 | 리뷰 기록 5절 | 지적 수에 반증과 유지 판단이 포함돼 있다. 수정 방향이 하나로 정해지지 않는다. |
| 모든 직접 파일 접근·자식 실행 또는 모든 timeout 누락 금지 | E04, E09, E17 | 장기 자원·의도된 부모 환경·존재 확인·별도 소유 시한을 정상 경로에서 사용한다. |
| 일반 workflow 정책 도구로 집계와 시한 산술을 대체 | E13, E18 | 제품이 허용하는 상태와 재시도·대기 총량을 해당 도구가 판정하지 않는다. |
| 사용하지 않는 패키지 그래프 도구와 모델 도구 도입 | E14, E15 | Nx의 전사 프로젝트 그래프나 Java bytecode 검사, bounded context 문서 DSL은 현재 금지 edge에 비해 설정 범위가 크다. |

### 시험 lint 담당 작업에 넘길 참고

대상은 `test/lint-fixed-time-waits`의 `7f0f264785632891f86f412e5b202883345e33d5`와 이미 병합된 #229·#230의 범위입니다. 이 표는 다음 PR의 선택 표에 포함하지 않았습니다.

| 패턴 | 확인한 기존 규칙·근거 | 넘길 참고 |
| --- | --- | --- |
| T1 | Playwright `no-wait-for-timeout`, 브랜치 `tests/no-fixed-time-wait` | 내장 규칙은 메서드 호출을 잡고 Node sleep을 놓친다. 브랜치의 더 넓은 타입 없는 AST 검사와 대기·상한 구분 근거를 재사용할 수 있다. |
| T2, T3 | #230 `tests/no-elapsed-time-assertion`, #229 폴더 지우기 제한 | 현재 회귀 시험이 이미 전담한다. 두 도구의 `expect-expect`는 경과값 단언도 통과했고 자원 종료 순서는 파일 삭제 API 이름만으로 알 수 없다. |
| T4, T5 | Vitest `onTestFinished`, Playwright fixture teardown | E19의 JSON 보고 항목 차이와 fixture 시한을 비교할 수 있다. 붙잡은 gate를 해제하는지 판정하는 기존 lint는 이번 조사에서 찾지 못했다. |
| T6 | Playwright `no-nth-methods`, `no-raw-locators`, `prefer-web-first-assertions` | 최초 인덱스·CSS selector 형태와 웹 단언 사용은 잡을 수 있다. 조직·대화 범위나 레이아웃이 안정됐는지는 관찰할 신호가 필요하다. |
| T7 | Playwright/Vitest `expect-expect`, `no-conditional-expect`, Playwright `no-useless-not` | 단언이 없어 지나가는 모양 일부만 잡는다. 이미 참이었던 부정 단언을 통과시킨 합성 반례가 있다. |
| T8, T9, T10 | C5의 Node/CodeQL 범위, C3의 stream·child 오류 계약, T3 공용 정리 함수 | CodeQL은 #178 모양을 제외한다. 표준 Promise lint는 EPIPE를 보지 못한다. 포트·DB·실행 칸의 실제 격리에는 이번 조사에서 맞는 기존 lint를 찾지 못했다. |

## 구현 참고

- 검출할 이름이 하나이고 조치 방향이 분명하면 현재 ESLint 규칙 또는 좁은 selector를 사용합니다. 바인딩의 출처·스코프를 따라가야 할 때만 자체 규칙을 검토합니다. 자체 규칙은 설명 문구·AST 변형·parser 업데이트와 회귀 사례를 저장소가 관리합니다. 플러그인은 그 구현을 upstream에서 관리하지만 peer 범위, preset 변경, 추가 진단과 설치를 관리해야 합니다.
- 예외가 소수면 해당 호출이나 범위를 먼저 좁힙니다. 프로젝트의 lint 예외는 규칙 이름과 이유가 필요하고 사용되지 않으면 오류입니다. 기존 위반이 많고 사용자 가치가 확인된 규칙에만 `--suppress-rule`과 `--prune-suppressions`를 고려합니다. 파일·규칙별 개수 baseline과 줄 diff를 유일한 차단 기준으로 쓰면 E16의 누락이 생깁니다. 타입 변경이 다른 파일의 진단을 만드는 규칙은 PR의 변경 파일만 lint해도 누락됩니다. 채택할 규칙의 신호 수와 제외 사유를 전체 스캔으로 먼저 확인합니다.
- 오류 메시지는 가야 할 진입점이나 조치를 적습니다. 기존 `scripts/lint-rules.test.mjs`에 실제 config를 통과시키는 정상·위반 사례를 두는 선례가 있고, 복잡한 자체 규칙을 택하면 RuleTester에 별칭·namespace·동적 경로 등 판정 범위와 정상 반례를 둡니다. 기존 제품·CI 회귀 시험은 구문 규칙이 보장하지 않는 동작을 담당합니다.

| ID | 검증할 경계 | 근거 |
| --- | --- | --- |
| V01 | 격리 adapter가 직접 spawn import → 공용 진입점을 쓰라는 오류. 진입점에 명시 환경을 줘도 허용 외 합성 키는 전달하지 않음. stdin 조기 종료와 시작 실패는 종결 결과로 관찰 | D01, E03, E04 |
| V02 | 본문과 정리 A·B가 실패 → 나머지 독립 정리 실행, 본문과 각각의 정리 실패를 보고. 뒤 정리에 앞 단계 성공이 필요한 경로는 정해진 안전 조건을 따름 | D02, E02, E19 |
| V03 | 처리기 없는 Promise와 처리기를 연결한 같은 호출 → 전자만 진단. 기존 `after-commit` 형태가 비차단 진단으로 남으면 허용 근거를 확인 | D03, E05, E06 |
| V04 | 유한 명령·재시도 최악치가 상한 초과 → 계약 시험 실패. 장기 감독 프로세스는 자신의 종료 계약을 사용 | D04, E13, E17, E18 |
| V05 | 사라진 선택 파일 → 계약에 따른 부재. 권한·I/O 오류 → 보존. 조직 경계 밖 경로 실패는 공개 읽기 경계에서 검증 | D05, E09 |
| V06 | 지도 링크 대상 이동 → 현재 링크 오류. 계약에 새 값 추가 → 전체 대응표 누락 진단. 부분 집합 유지 → 해당 동작 회귀 통과 | D06, D07, E10, E11 |

| 열린 결정 | 담당 | 선택지와 근거 |
| --- | --- | --- |
| 다음 PR에서 먼저 강제할 한 가지 | 사용자 | 격리 실행 진입점과 소비자 import 한정(D01), 또는 기존 수동 스크립트 실패 수집 방식 검토(D02). 전자는 미래 우회를 줄이고 후자는 현재 구조 후보 두 곳을 다룬다. |
| Promise 검사를 추가할 범위 | 사용자 | 보류 또는 기존 typed 비시험 파일에서 기본 옵션 진단을 먼저 관찰(D03). `src` 밖 확대의 추가 신호는 시험 1건이었다. |
| workflow와 도메인에 새 의존 검사기 필요 여부 | 사용자 | 현재 `pnpm check`·ESLint 유지, 또는 실제 구문 회귀/패키지 우회 확인 뒤 해당 영역의 좁은 규칙만 비교(D04, D09). |
| E2E와 시험 규칙의 적용 여부 | 진행 중인 시험 lint 작업 | E19·E20의 참고 범위만 전달. |

## 한계와 미확인

- 검색과 AST 계수는 현행 파일과 합성 표본을 사용했습니다. 전체 호출의 의미와 미래 오탐률, 과거 리뷰 횟수가 줄어드는지는 측정할 수 없었습니다. C2의 누락 환경·별칭, C1의 중첩 함수, C5의 여러 파일을 건너는 흐름의 위반 수는 각각 미확인입니다.
- CodeQL CLI는 실행하지 않았습니다. Daintree의 운영 환경, Windows·macOS 자식 동작, Playwright 실행, 실제 CI와 실제 프로바이더도 미실행입니다. Evans의 공식 배포 페이지는 403으로 원고 미러를 열었습니다. 로그인·유료 API 자료는 사용하지 않았습니다.
- 초기 대조 중 일부는 저장소 루트의 기존 ESLint와 설정을 읽기 전용으로 사용했습니다. 이 문서의 typed lint 수치와 import·시한 규칙 대조는 캐시의 별도 설치·설정으로 실행했습니다.
- 실행 결과는 이 Linux 장비와 고정 버전에 한정됩니다. 타입 선언을 번들로 내리는 웹 빌드, 터미널 리포터의 중첩 오류 표시, 외부 도구의 전체 preset에는 숫자를 외삽하지 않았습니다. 외부 구현의 코드 복제는 권고 범위 밖입니다.
