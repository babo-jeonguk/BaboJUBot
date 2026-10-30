# issue-52 레퍼런스 조사: 스택 뼈대와 조직 생성

조사일: 2026-10-16 (Asia/Seoul). 대상: [#52](https://github.com/babo-jeonguk/BaboJUBot/issues/52), parent [#49](https://github.com/babo-jeonguk/BaboJUBot/issues/49), 완료된 blocker [#50](https://github.com/babo-jeonguk/BaboJUBot/issues/50). 구현 전 권고이며 확정 계약이나 구현 완료가 아니다. 상세 후보·원문·실행 기록은 `.reference-cache/issue-52/`에 보관하고 Git에서 제외한다. 이 문서는 미커밋으로 남겨 구현 변경과 함께 커밋한다.

## Brief

- 구현할 문제: 정해진 스택과 패키지 구조로 첫 수직 흐름을 만든다. 이름만 받는 dialog에서 조직을 만들면 전용 Research Lead 하나와 `목표 설정` 단계가 함께 생긴다. 조직 ID가 붙은 Event로 사이드바·홈을 갱신하고 해당 조직의 Lead 대화로 이동한다. HTTP·Event stream API helper와 Playwright smoke, root dev/test/typecheck/lint/check, embedded/external Postgres 연결이 필요하다.
- 동종 문제: 새 tenant와 소유 구성원을 일관되게 영속 생성하고, 그 변경을 전체 및 범위별 구독 화면에 반영하는 메커니즘.
- 고정된 결정: [AGENTS](../../AGENTS.md), [용어](../../GLOSSARY.md), [기능](../features.md), [구조](../architecture.md), [ADR](../adr/). Node24·pnpm10.33.0·TypeScript, Express+ws, Postgres+Drizzle, React·Vite·Tailwind·Radix/shadcn·TanStack Query, zod, Vitest·Playwright. `apps/server`, `apps/web`, `packages/core`, `contracts`, `db`, `runtime`, `harness/` 책임을 유지한다. 단일 self-host 사용자이며 조직 경계·초기 연구 승인·최종 완료는 제품 코드가 강제한다.
- 화면 결정: [#50 C 배치 확정](https://github.com/babo-jeonguk/BaboJUBot/issues/50#issuecomment-6161637737), 원본 `prototype/dashboard-layout@f362363f4aac8e8bbd9ca9ec3c37fc6b20dc72ee`. 조직 레일＋/조직 없음 빈 상태 → 이름 dialog → `/orgs/:id/chat`. 배치를 다시 선정하지 않는다. 이슈 조회 및 native dependencies API로 #50 closed와 parent #49를 확인했다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 확정 스택의 workspace·build·개발/검증 명령과 버전 결합은? | #52 스택·패키지 구성, AC1/6 | registry metadata + 운영 저장소 Source Recon + 설치 |
| Q2 | embedded/external Postgres·migration·HTTP/WS fixture의 수명주기는? | #52 test seam·AC2, #49 Testing Decisions | Source Recon + persistence/recovery + 격리 실행 |
| Q3 | 조직+Lead+초기 단계+Event의 부분 실패와 조직 귀속을 어디서 막는가? | #52 AC3/4, AGENTS 조직 경계 | Source Recon + adversarial/failure scenario |
| Q4 | 전체/조직 WS 구독·commit 후 발행·최초 연결/재연결·캐시 정합성의 최소 패턴은? | #52 Event log/stream·AC4/5 | Source Recon + protocol + 실행 |
| Q5 | dialog→Lead route·목록/홈 갱신·실패/중복 제출을 어떻게 연결할까? | #52 AC5/6, features 화면 지도, #50 결정 | Source Recon + 공개 실화면 조작 + smoke 시나리오 |

| 기존 조사 | 재사용 범위 | 재확인·판단 |
|---|---|---|
| [#50 조사](issue-50-references.md#brief) | 조직 범위·캐시·빈/오류 상태의 질문과 소스 위치 | A/B 제안보다 이후 C 확정 댓글과 프로토타입을 우선. 실제 backend 생성 근거는 아니므로 이번 원문/실행으로 보강 |
| [Paperclip 대시보드](paperclip-dashboard.md), [Paperclip](paperclip.md), [코드 구조](reference-code-structure.md) | source 탐색과 MIT 라이선스 출발점 | old `1b4c803`→이번 `78b833c` 파일별 blob 비교. 같아도 이번 SHA 원문을 재열람. 변경 파일의 옛 줄·동작 근거를 그대로 옮기지 않음 |
| [#1 조사](issue-1-references.md#brief) | 계약·도구 검증 방법만 | 백로그 초기화 전의 storage 명칭·스택 후보·버전 권고는 채택하지 않음. 최신 architecture·ADR-0004·#49/#52 우선 |
| [실행 모델](agent-runtime-models.md), [상호작용](agent-interaction-models.md) | Control Plane·영속 기록·깨우기 배경 | 실제 프로바이더·메시지·토큰 구현은 #53 이후. #52 Lead 생성이 실제 모델 호출을 요구한다는 근거로 쓰지 않음 |
| [비교 목록](comparative-survey.md), [기타 대시보드](dashboard-references.md), [#51](issue-51-references.md#brief) | 후보/범위 확인 | 연구 지도·기억·연구 방법론은 이번 문제의 직접 근거가 없어 심층 재사용하지 않음 |

기존 `.reference-cache/issue-{1,50,51}/`, `wayfinder-foundation/`도 질문·소스 위치에만 재사용했다. 새 Evidence ID는 이번 원문/실행 근거다. 이전 조사 자체는 위 anchor로 인용한다.

## 레퍼런스

세 관점의 후보 항목은 **32개**(스택11·조직 생성13·WS/UI8, 관점 간 중복 포함)다. 질문5개, 패턴5개, 결정 권고9개를 정리했다.

| 관점 | 마지막 라운드와 saturation 근거 |
|---|---|
| 개발 스택·DB·검증 도구 | 11후보/4라운드. native PostgreSQL·WASM·emulator·container의 소유권 차이를 비교. 마지막 오류/이슈·사용처 확장은 native 라이브러리/locale·독립 dataDir·로그·외부 URL 우회라는 이미 찾은 실패 유형을 반복해 종료 |
| 조직 생성·영속 원자성 | 13후보/4라운드. schema-per-tenant·RLS·PG queue·CDC를 추가 비교했으며 마지막 pg-boss/Debezium 확장은 동일 tx 기록+relay·중복/순서·운영 비용의 변형 외 새 실패 유형을 더하지 않음 |
| WS·캐시·생성 UI | 8후보/4라운드. push+snapshot / cursor replay / DB CDC를 비교. 마지막 공식 소스·race 테스트·global/all 사용처 확인은 재조회·scope guard·전체 구독 누락의 구체화이며 새 메커니즘 없음 |

검색 범위의 패턴 포화이며 생태계 전수조사를 뜻하지 않는다. 후보별 질문·실행 경로·선정 이유와 검색 라운드는 `candidates.md`, `notes/discovery-*.md`에 있다.

| 심층 대상 | 버전·고정 SHA | 라이선스 | 깊이·선정 이유 |
|---|---|---|---|
| Paperclip | `78b833c4958465b5e345b0e337018011b00dab72` | MIT 원문 확인 | 소스·원본 event 모듈 실행. 같은 스택의 생성/DB/WS/캐시 경로와 반례를 한 번에 추적 가능. 전체 앱은 실행 안 함 |
| embedded-postgres | 실행 `18.1.0-beta.16`(source `9a1e52f4ac4d92bf24976f635020374342fd0838`); 최신 소스 `8c8c16d1b81bec8ae3315d59a050654086a85e23` | wrapper MIT LICENSE.md 두 SHA 동일; binaries 별도 고지(README Apache-2.0 설명) | 소스·격리 실행. postinstall/native/locale/정지 문제가 Docker 없는 개발·테스트의 직접 위험. 최신 배포판 실행과 구분 |
| Postgres + Drizzle + Express/ws + Vitest | PG18 계열 embedded; Drizzle0.45.2·kit0.31.10·pg8.16.3·Express5.1.0·ws8.18.3·Vitest4.0.18 | PostgreSQL License / Apache-2.0 / MIT | 공식 문서·설치·임시 fixture 실행. transaction/migration/HTTP/WS/종료 조합 확인. 제품 버전 확정 아님 |
| TanStack Query·ws·pnpm·Playwright | Query docs `ee47993724e5b71e65d9f38ae416367d2dd18395`; ws README `85319a7297318e4c16dd1b0a3c4d8a69b1b55f17`; pnpm10.33.0; 공식 문서 확인일 기준 | Query/ws/pnpm MIT; Playwright Apache-2.0; 문서 고지 별도 | 문서·소스. invalidation·upgrade·build-script·process 정리 계약 확인. Query core·전체 Playwright 제품 smoke는 미실행 |
| Radix Dialog·기존 C 프로토타입 | 공개 예제 배포 SHA 미확인; C `f362363f4aac8e8bbd9ca9ec3c37fc6b20dc72ee` | Radix MIT; C는 본 저장소 | 공개 UI 조작/캡처 + C 소스. 이름 입력·성공 후 route는 기존 결정을 유지하고 비동기 실패 상태만 보강 |

Hermes profile·OpenClaw workspace는 tenant DB 경계를 대신할 수 없고, Better Auth는 server가 생성된 org ID로 creator membership를 붙이는 인접 사례다. 범위가 더 직접적인 Paperclip/PG를 결정 근거로 골랐다. Socket.IO·Supabase·tRPC·Debezium·pg-boss는 비교 대상이며 도입 권고가 아니다. 라이선스·header·NOTICE·의존성 확인 없는 코드 복사를 권고하지 않는다. 이번 산출물은 설계 참고이며 제품으로 옮긴 코드는 없다.

## 근거

19개: 실행 확인 4 · 소스 확인 12 · 문서 주장 3. 테스트 링크는 별도 실행 표시가 없으면 **읽기만** 했다. 모든 확인일은 2026-10-16이다. 실행 로그와 SHA/blob 재검증은 `probes/`, `recon/`, `main-verification.md`에 있다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | C의 dialog는 이름을 trim하고 local store에 만든 뒤 chat route로 이동한다. createOrg는 React 메모리에만 추가하므로 영속 API·WS·전용 Lead 생성의 증거는 아니다. | [CreateOrgDialog](https://github.com/babo-jeonguk/BaboJUBot/blob/f362363f4aac8e8bbd9ca9ec3c37fc6b20dc72ee/apps/prototype-dashboard-layout/src/details.tsx#L549-L603), [createOrg](https://github.com/babo-jeonguk/BaboJUBot/blob/f362363f4aac8e8bbd9ca9ec3c37fc6b20dc72ee/apps/prototype-dashboard-layout/src/shared.tsx#L80-L84) | 소스 확인 |
| <a id="E02"></a>E02 | Paperclip은 workspace별 typecheck/build와 DB migration asset 복사를 명령으로 분리한다. dev source export와 publish dist export도 구별한다. 그 저장소의 pnpm9·TS7·복잡한 preflight를 BaboJUBot 명령 계약으로 그대로 복사할 근거는 아니다. | [DB scripts/exports](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/packages/db/package.json#L14-L64), [workspace/patches](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/pnpm-workspace.yaml#L1-L20), [root versions](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/package.json#L103-L118) | 소스 확인 |
| <a id="E03"></a>E03 | DB test helper는 임시 dataDir/port, 명시 locale, startup/migrate, cleanup을 감춘다. client를 먼저 닫고 PG stop 후 dataDir을 지운다. 대형 migration template cache는 이미 커진 저장소의 최적화다. | [create instance](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/packages/db/src/test-embedded-postgres.ts#L119-L150), [start/cleanup](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/packages/db/src/test-embedded-postgres.ts#L705-L736) | 소스 확인 |
| <a id="E04"></a>E04 | Paperclip은 Linux native library alias와 LD_LIBRARY_PATH를 준비하며 embedded package의 locale/env도 patch한다. stop timeout 경과와 실제 PG 종료/파일 삭제는 구별한다. | [native preparation](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/packages/db/src/embedded-postgres-native.ts#L51-L85), [bounded stop](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/packages/db/src/test-embedded-postgres.ts#L165-L217), [embedded patch](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/patches/embedded-postgres%4018.1.0-beta.16.patch#L1-L30) | 소스 확인 |
| <a id="E05"></a>E05 | Node24.21/pnpm10.33, 2GiB·키 없는 환경에서 고정 11개 직접 패키지(전이 포함147개)를 ignore-scripts 설치했다. 무패치 embedded18.1 beta의 initdb/postgres는 ICU .so.60 누락으로 status127. 임시 환경에서 Paperclip 방식 alias와 locale/env 3곳 수정 후 PG 기동에 성공했다. 기본 설치 성공으로 표현하지 않는다. | `selfhost/stack-db.md`, `probes/stack-db/`의 install/native-baseline/prepare-native 로그 | 실행 확인 |
| <a id="E06"></a>E06 | 패치된 조사 fixture에서 Vitest 1 test/14 assertions 통과: migration 두 번→journal1행, rollback→0행, 공백 HTTP422 무쓰기, trim 후201/영속행/조직 ID 포함 WS frame, PG stop/start 유지, 외부 연결 client만 정리, 종료/디렉터리 정리. Lead·Event log·조직별 구독을 구현한 테스트는 아니다. | `probes/stack-db/stack.test.mjs`, `probe.log`; Express5.1/ws8.18.3/pg8.16.3/Drizzle0.45.2/Vitest4.0.18 | 실행 확인 |
| <a id="E07"></a>E07 | 회사 생성 service의 insert→environment→built-in ensure와 route의 membership→activity는 순차 await다. 이 생성 경로에 전체를 묶은 tx가 없으므로 조직+Lead+Event의 원자 생성 선례로 사용할 수 없다. | [create service](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/server/src/services/companies.ts#L247-L297), [create route](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/server/src/routes/companies.ts#L1196-L1244) | 소스 확인 |
| <a id="E08"></a>E08 | autoProvision의 신규 자동 생성 key set은 비어 있다. fresh company의 bundled agent marker0 테스트가 있으며 Lead 고용은 onboarding 후속 step이다. 주석의 only its own lead만 보고 자동 Lead 하나를 보장한다고 해석하면 오독이다. | [empty keys](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/server/src/services/built-in-agents.ts#L482-L486), [autoProvision](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/server/src/services/built-in-agents.ts#L2090-L2114), [fresh company test](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/server/src/__tests__/companies-service.test.ts#L110-L123), [separate hire](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/ui/src/components/OnboardingWizard.tsx#L2231-L2265) | 소스 확인 |
| <a id="E09"></a>E09 | createCompanySchema는 name min1이며 trim/strict가 없고 부가 필드를 허용한다. route에서 사용자 actor를 확인하고 schema.parse 결과를 쓴다. resource 조회 helper는 타 조직과 미존재를 같은404로 감춘다. #52 이름 전용 계약과 제품 scope 검사는 별도 작성해야 한다. | [schema](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/packages/shared/src/validators/company.ts#L24-L29), [actor gate](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/server/src/routes/companies.ts#L1196-L1220), [resource access](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/server/src/routes/authz.ts#L157-L194) | 소스 확인 |
| <a id="E10"></a>E10 | persistActivity는 DB 기록과 publication DTO를 분리한다. optional publication 배열을 사용해야 즉시 발행을 피할 수 있다. 회계 transaction은 commit 후 publish하며 실패를 기록하고 committed 결과를 보존한다. commit→publish crash gap까지 해결하는 durable relay는 아니다. | [persist/logActivity](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/server/src/services/activity-log.ts#L164-L234), [post-commit publication](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/server/src/services/accounting-transaction.ts#L10-L40) | 소스 확인 |
| <a id="E11"></a>E11 | live-events는 프로세스 내 EventEmitter와 증가 ID다. 회사 event는 같은 회사와 내부 allCompanyEvents에, public global은 별도 *에 전달한다. process 재시작 뒤 안정적 Event ID나 replay storage의 근거가 아니다. | [publish/subscribe](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/server/src/services/live-events.ts#L7-L66) | 소스 확인 |
| <a id="E12"></a>E12 | 원본 live-events.ts를 Node로 직접 import해 12 assertions 통과: A/B 분리, 내부 all과 public global의 분리, 늦은 구독자 replay0, unsubscribe. 원본 WS 전송·인증·DB 보장은 이 probe에서 실행하지 않았다. | `probes/live-events.mjs`, `live-events-log.txt`; Paperclip@78b833c·Node24.21.0 | 실행 확인 |
| <a id="E13"></a>E13 | WS 서버는 연결 scope를 authorize한 뒤 company subscription을 만들고 OPEN/queue cap/pong/close cleanup을 처리한다. 선택 조직 구독 경로이므로 새 조직을 모르는 전체 홈 구독을 그대로 해결하지 않는다. | [upgrade authorization](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/server/src/realtime/live-events-ws.ts#L133-L156), [delivery/cleanup](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/server/src/realtime/live-events-ws.ts#L340-L378) | 소스 확인 |
| <a id="E14"></a>E14 | LiveUpdatesProvider는 expectedCompanyId 이외 event를 무시한다. 최초 onopen도 재연결처럼 active query를 재조회하고 backoff·연결 실패 polling·숨김 복귀를 처리한다. 과거 event를 재전송하는 구현은 아니다. | [scope guard](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/ui/src/context/LiveUpdatesProvider.tsx#L1700-L1710), [open/reconnect](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/ui/src/context/LiveUpdatesProvider.tsx#L1960-L2095) | 소스 확인 |
| <a id="E15"></a>E15 | onboarding은 in-flight ref로 중복 제출을 막고 POST 성공 시 companies cache를 invalidate한다. 응답 대기 중 사용자가 다른 조직으로 이동했으면 selection을 덮지 않는 guard와 같은 회사가 이미 채택된 race의 테스트가 있다. 즉시 Lead chat 이동은 C 결정을 적용해야 한다. | [handleCreateCompany](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/ui/src/components/OnboardingWizard.tsx#L2039-L2083), [adoption race test](https://github.com/paperclipai/paperclip/blob/78b833c4958465b5e345b0e337018011b00dab72/ui/src/components/OnboardingWizard.step.test.tsx#L443-L484) | 소스 확인 |
| <a id="E16"></a>E16 | Query invalidation은 일치 key를 stale로 만들고 active observer를 refetch한다. async onSuccess Promise를 기다리면 isPending 유지가 가능하다. WS 연결이나 durable delivery 자체를 제공하지는 않는다. | [Query invalidation](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/docs/framework/react/guides/query-invalidation.md#L19-L28), [mutation invalidation](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/docs/framework/react/guides/invalidations-from-mutations.md#L18-L45) | 문서 주장 |
| <a id="E17"></a>E17 | Postgres tx는 여러 쓰기를 전부 commit/rollback한다. tenant_id를 포함한 복합 FK는 연결된 행의 같은 tenant 귀속을 표현한다. 고유 이름이나 사용자 권한 검사까지 자동 제공하지는 않는다. | [PG18 transactions](https://www.postgresql.org/docs/18/tutorial-transactions.html), [PG18 composite tenant FK](https://www.postgresql.org/docs/18/ddl-constraints.html#DDL-CONSTRAINTS-FK), [Drizzle tx](https://orm.drizzle.team/docs/transactions) | 문서 주장 |
| <a id="E18"></a>E18 | pnpm10의 허용 build 목록과 ignore-scripts 설치는 구별한다. Playwright webServer는 gracefulShutdown 설정이 없으면 process group을 강제 종료할 수 있어 embedded PG를 소유한 runner의 정리 계약이 필요하다. | [pnpm approve-builds](https://pnpm.io/cli/approve-builds), [Playwright webServer gracefulShutdown](https://playwright.dev/docs/test-webserver#configuring-a-web-server) | 문서 주장 |
| <a id="E19"></a>E19 | 공식 Radix 예제에서 dialog 열기→Name 입력→Escape 닫기/trigger focus 복귀와 390px 재열기·입력을 관찰했다. desktop1280/mobile390 캡처를 메인이 직접 열어 확인했다. profile 예제여서 생성 성공·pending·오류·승인 동작의 근거는 아니다. | [Radix Dialog 공개 예제](https://www.radix-ui.com/primitives/docs/components/dialog); `probes/dialog-log.json`, `captures/captures.md`; Playwright1.58.2·Chromium1228 | 실행 확인 |

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 명시적인 조립 root와 소유 자원 cleanup | E02–E06,E18 | Paperclip는 production-sized template/native 보정, #52는 작은 fixture부터 | 같은 DB 코드 경로로 dev/API test/external URL 검증 | 스크립트만 보고 설치 가능하다고 오인, stop 전 dataDir 삭제, external PG 중지 |
| <a id="P02"></a>P02 | 생성 aggregate와 Event를 한 DB tx로 쓰기 | E07–E10,E17 | Paperclip 생성은 반례, 회계 path는 post-commit publication 사례 | 조직만/Lead만 남는 부분 성공과 유령 event 방지 | callback 밖 db 사용, 하네스 파일/WS처럼 rollback되지 않는 부수효과 |
| <a id="P03"></a>P03 | 영속 Event는 원본, WS는 변화 알림 | E10–E14,E16 | Paperclip public global≠all companies; #52는 전체/조직 모두 필요 | 한 조직의 기록을 같은 ID로 여러 화면에 전파 | commit 후 send 전 crash·late subscriber 누락·프로세스 ID 재사용 |
| <a id="P04"></a>P04 | 응답 기반 생성 완료와 push 기반 재조회 결합 | E01,E14–E16,E19 | C는 동기 local store, Paperclip은 비동기 wizard, #52는 dialog→chat | 본인 탭은 WS race와 무관하게 성공 반영, 다른 탭도 갱신 | 중복 POST, 늦은 응답이 새 탐색을 덮음, 재조회 실패를 생성 실패로 오인 |
| <a id="P05"></a>P05 | 서버 scope·계약과 저장 참조 제약 병행 | E09,E13,E17 | 단일 사용자 전체 조회와 에이전트 조직 경계는 별개 | role prompt/클라이언트 선택에 의존하지 않음 | orgId/status 주입·ID만 조회·broadcast의 조직 필터 누락 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | 기존 pnpm10.33/Node24와 architecture의 패키지 책임을 유지. root dev/test/typecheck/lint/check를 구별하고 server Node ESM·web bundler 설정을 검증. DB migration SQL/journal도 build 산출물에 포함 | P01, E02/E05, ADR-0004 | Paperclip 전체 도구/모델 adapter 의존성을 가져올 필요 없음. 정확한 pin은 실제 구현 lockfile로 결정 | Q1 |
| <a id="D02"></a>D02 | 변형 채택 | DB factory가 명시 external URL이면 연결만 소유하고, 없으면 local embedded cluster를 소유. 같은 migration 경로를 쓰며 테스트는 임시 dataDir/port와 명시 cleanup을 반환. startup 실패 이유를 숨기거나 핵심 API 테스트를 자동 skip하지 않음 | P01,E03–E06 | native/locale 실패를 초기에 드러냄. 종료는 WS clients→WS/HTTP→DB clients→소유 PG→dataDir 순서. 외부 DB는 정지·삭제하지 않음 | Q2 |
| <a id="D03"></a>D03 | 채택 | 조직 생성 command에서 서버가 org/Lead ID·목표 설정 단계·기본 꺼진 승인 정책을 결정하고 조직+Lead+Event를 하나의 tx에 저장. commit 후 응답·발행하며 실패면 전부 rollback. Lead 실제 실행/깨우기는 #53 | P02,E07–E10,E17, AGENTS | 전용 Lead는 반드시 하나. Paperclip 회사 생성/별도 hire를 그대로 옮기면 AC 미충족. 필수 하네스 준비는 쓰기 전 검증하고 파일 부수효과를 tx 중에 숨기지 않음 | Q3 |
| <a id="D04"></a>D04 | 변형 채택 | name-only schema를 서버에서 trim/nonempty 검증하고 서버 전용 필드는 거부하는 strict 입력 권고. 조회·참조는 조직 predicate로 묶고 FK/non-null/Lead 중복 방지 제약으로 뒷받침. core는 도메인 규칙, contracts는 입력/Event schema, db는 제약, server는 tx 조립 | P05,E09,E17 | 화면 validation은 빠른 피드백. actor/조직 경계는 제품 강제. 다중 사용자 인증 체계 도입은 범위 밖. 이름 길이/중복 정책은 열린 결정 | Q3,Q5 |
| <a id="D05"></a>D05 | 변형 채택 | 조직 Event를 저장한 ID와 실제 organizationId로 발행. 사용자용 전체 구독은 모든 조직 event를 받고 조직 구독은 해당 ID만 받도록 별도 계약/서버 필터. 구독 scope all을 Event의 organizationId=*로 바꾸지 않음 | P03,P05,E11–E14 | 전체 홈·사이드바는 새 조직을 미리 알 수 없음. Paperclip public global이나 ws broadcast 예제만 복사하면 AC 누락/누출 | Q4 |
| <a id="D06"></a>D06 | 변형 채택 | 최초 구독 성립과 재연결 때 전체 목록·홈·현재 조직의 snapshot 재조회. Event는 관련 query invalidation, query key는 전역/조직별 분리. 중복 Event로 행을 중복 append하지 않음. commit 후 publish 실패를 DB 생성 실패로 반환하지 않는 방향 권고 | P03,P04,E10–E16 | 단일 프로세스 첫 판에 맞는 최소 복구. 끊김 없는 exactly-once나 Event 전체 replay 보장은 아님. replay/durable relay 필요 수준은 #52 열린 결정 | Q4,Q5 |
| <a id="D07"></a>D07 | 변형 채택 | C의 두 진입점과 이름 폼·chat route 유지. 제출 중 중복 억제, POST 성공 응답으로 목록/상세 캐시 반영 및 관련 목록 재조회, dialog 닫기/Lead route 이동. 실패면 입력/오류 유지. 캐시 재조회 실패가 이미 성공한 POST 재시도를 유도하지 않게 구분 | P04,E01/E15/E16/E19 | 본인 탭 생성은 WS 도착에만 의존하지 않음. 요청 중 dialog 취소·다른 조직 탐색 뒤 응답은 기존 탐색을 덮지 않는 guard 권고. focus/좁은 폭 smoke 필요 | Q5 |
| <a id="D08"></a>D08 | 채택 | API helper는 실제 HTTP+WS를 ephemeral port에서 띄우고 구독 준비 barrier 후 생성·조회·frame을 검증. fake model 불필요. 한 Playwright smoke는 레일＋/빈 상태 생성→Lead route→사이드바/홈을 새로고침 없이 확인 | P01–P05,#49 Testing Decisions | 실제 구현의 주요 seam을 검사. API 테스트가 core/DB를 함께 통과해야 하며 아래 V 경계를 검증. pre-commit 설정은 #52 구현 완료 후 별도 명시 절차 | Q1–Q5 |
| <a id="D09"></a>D09 | 보류 | embedded-postgres의 정확한 pin과 native 준비 전략은 #52에서 clean install로 재검증. 이번 beta patch를 검토 없이 의무 복제하거나 최신18.4가 해결했다고 단정하지 않음 | E04–E06 | 수정한 임시 환경의 PASS는 재현 경로를 제공하지만 지원 OS/CI의 정상 설치 보장이 아님 | Q1,Q2 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 회사만 만든 뒤 다음 화면에서 Lead 고용 | E07/E08 | #52의 조직 생성 결과 Lead 하나와 부분 실패 방지 계약에 맞지 않음 |
| process counter Event ID + 메모리 event만 원본으로 취급 | E11/E12 | 영속 Event log·재시작 뒤 식별 계약을 충족하지 않음 |
| public * 스트림을 전체 조직 이벤트로 간주 / 모든 socket 무조건 broadcast | E11/E13, ws README | 구독 scope와 원본 조직 ID·제품 경계가 사라짐 |
| prototype local store를 제품 생성 API로 사용 | E01 | 영속성·서버 validation·타 탭 갱신 근거 없음 |
| profile/workspace/Role 지침으로 조직 경계 강제 | Discovery Hermes/OpenClaw, AGENTS/ADR-0001 | 프로바이더 편의 namespace와 Control Plane 권한 경계가 다름 |
| Kafka/CDC·새 인증 제품·대형 test template cache를 첫 판 필수로 추가 | Discovery Debezium/Better Auth, E03 | 현재 규모와 확정 스택에 비해 운영·정책 범위가 큼. 원리만 참고 |

## 구현 참고

권고의 중심은 **이름 하나 → 조직·Lead·Event 원자 저장 → commit 후 전체/조직 구독 전달 → 응답 기반 chat 이동과 snapshot 재조회**다. 상태·승인은 core, 계약은 contracts, 트랜잭션/제약은 db와 server 조립, 화면은 web에 둔다. core가 Express/Drizzle/ws/React를 import하지 않는 의존 방향을 지킨다.

#52는 Lead 대화의 빈 상태까지다. 실제 Lead 대화·깨우기·실행 시도·조직 도구는 후속 #53, 초기 연구 승인 #54, 작업 #55, 연구 지도 #56, 결과 검토 #57, 승인 정책 행동 #58, 실행 제어 #59, heartbeat/기억/복구 #60, 알림 outbox/Inbox #61, 홈·조직 지표의 완성 #62, 전체 데모/E2E #63, 하네스 편집/revision #64다. 홈의 새 조직 반영은 #52 AC에 남기며 지표 완성을 기다리지 않는다. 이 조사에서는 ADR·기능·이슈 본문을 변경하지 않는다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 정상 이름 POST→GET: 동일 org ID, 목표 설정, 그 조직의 Lead 정확히1, 기본 승인 정책 꺼짐, 같은 org의 영속 Event 조회 및 frame | D03–D05 |
| V02 | 공백·orgId/status/leadRole 주입·잘못된 JSON→거부, 조직/Lead/Event 쓰기와 frame 모두0. strict unknown/길이 정책을 공개 계약대로 검증 | D04 |
| V03 | Lead insert 또는 Event insert 실패 주입→조직/Lead/Event 모두 rollback, frame0. commit 전 barrier에서는 frame0, commit 후 frame 수신 즉시 GET으로 조직+Lead 조회 | D03,D05 |
| V04 | 전체·조직A·조직B subscriber를 준비→B 생성/변경은 전체와 B에만 전달. 선택 조직 없는 다른 브라우저도 새 조직을 봄. agent용 all 허용은 하지 않음(#53) | D04,D05 |
| V05 | 초기 query 뒤 WS 구독 전 변경 또는 disconnect 중 변경→구독 성립/재연결 snapshot으로 복구. 이전 조직의 늦은 응답/이벤트는 현재 조직 cache를 덮지 않음 | D06,D07 |
| V06 | 같은 Event 반복·mutation 응답과 push 순서 교환→중복 조직 표시0. commit 후 publisher 실패에서도 생성 결과 유지, 재조회로 확인하고 무조건 POST 재시도하지 않음 | D06,D07 |
| V07 | 임시 PG bootstrap/migrate/정리, 외부 URL 연결, migration 실패·잘못된 URL→명시 오류. 외부 DB의 stop/drop0. test 실패 경로에서도 client/PG/dataDir 수명주기 검증 | D02,D09 |
| V08 | UI 레일＋/조직 없음→이름 dialog(공백 방지·pending 중 억제)→성공 뒤 해당 chat 빈 상태. sidebar 단계/홈 새 조직이 reload 없이 표시. 실패 입력 유지, Escape/focus·390px·뒤로가기·다른 조직 탐색 중 응답 확인 | D07,D08 |
| V09 | root dev/test/typecheck/lint/check, lockfile clean install, production server의 migration asset, Playwright smoke를 실제 구현에서 실행. import 의존 방향·출처/라이선스 고지 확인 | D01,D08,D09 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| embedded package pin/native 전략 | #52 | ①이번 beta+검토된 patch/alias ②최신 배포판을 별도 clean install 검증. 전자는 실행 근거 있으나 패치 유지비, 후자는 이번 실행 미확인. Docker 없는 embedded 조건은 유지 |
| commit 후 알림 유실과 복구 보장 | #52 | ①영속 Event+best-effort push+최초/재연결 snapshot(최소 권고) ②Event cursor replay 또는 PG relay. ②는 중복/순서/offset 비용과 테스트가 추가되며 정확한 replay를 AC가 요구하는지 명시. notification outbox #61과 구별 |
| 서버 idempotency·이름 정책 | #52 (제품 정책 변경 시 사용자) | 이름은 identity가 아님. ①UI in-flight 억제만 ②request key로 재전송 중복 생성 억제. 응답 유실 후 재시도 위험은 ②가 줄임. 동일 이름 허용/길이 제한은 별도 명시하고 근거 없이 unique(name)를 만들지 않음 |
| 구체 driver·lint·wire 이름 | #52 | Paperclip postgres.js와 이번 pg probe 둘 다 Drizzle 사용 가능하나 같은 드라이버/버전 실행을 검증해야 함. lint 도구·정확한 root script 이름·Event envelope/구독 endpoint는 구현 계약으로 정함 |

## 한계와 미확인

- 제품 코드·테스트·설정 변경, 실제 모델/API 호출, 자격 증명 사용, 커밋은 없다. 역할 지침으로 승인·조직 경계를 강제했다고 판단하지 않는다. #52를 닫거나 구현 완료로 표시하지 않는다.
- **실행한 것:** 원본 Paperclip event 모듈 12 assertions, 격리된 패치 환경의 DB/HTTP/WS fixture 1 test/14 assertions, Radix 공개 dialog desktop/mobile 조작. 제품 기능이나 전체 Paperclip 앱의 검증은 아니다. 기동한 브라우저/HTTP/WS/PG는 정리했다.
- **실패/보정:** embedded18.1 beta 기본 바이너리의 ICU 누락을 기록했다. tmp 환경의 alias·LD_LIBRARY_PATH·locale/env 수정 후 실행만 확인했다. 최신 embedded18.4, 다른 OS/아키텍처, pnpm 전체 build-script 정책은 실행 미확인이다. Chromium 최초 sandbox 실행은 EPERM으로 실패했고 허용된 실행에서 성공했다.
- **미실행:** BaboJUBot 조직+Lead+Event tx·교차 조직 API/WS·초기 연구 승인·실제 생성 실패/동시성·전체 web build/typecheck/lint·제품 Playwright smoke, Paperclip upstream suite, Query core 동작 probe. C prototype은 소스만 재열람했다. 실제 원격 운영 Postgres에는 연결하지 않았고 로컬 PG를 외부 URL처럼 client-only로 연결한 경로만 확인했다.
- 공개 Radix 예제 배포 SHA는 확인하지 못했으며 고정 라이브러리 소스와 같은 빌드라고 가정하지 않는다. 프로필 UI 캡처는 입력/focus/좁은 폭의 근거만 되며 제품 생성 오류·loading·권한 없음 실화면은 미확인이다. 타사 캡처는 로컬에만 보존한다.
- 일부 Query 공식 웹 guide는404라 고정 SHA GitHub 공식 문서로 대체했다. 검색 결과만 확인한 후보는 결정 근거에서 제외했다. 로그인·유료 서비스·계정 생성 경로는 열지 않았다.
- 이 문서의 권고는 확정 계약이 아니다. 복사 구현 시 해당 SHA LICENSE·header·NOTICE·함께 들어오는 의존성을 다시 확인하고 파일 머리 출처와 루트 THIRD_PARTY_NOTICES.md를 남긴다. upstream 변경 시 native/DB/WS 경로를 재확인해야 한다.

문서 검사: Node24.21.0으로 기존 링크 검사 script를 직접 실행해 Markdown34개를 통과했고 새 문서 whitespace·ID·산출물 검사를 통과했다. 이 환경의 standalone pnpm10.33.0은 내장 Node20.11.1 때문에 기본 `pnpm check`의 engine 검사에서 거부됐다. 일회성 `--config.engine-strict=false`로 같은 check script 통과를 확인했으며 제품 설정은 변경하지 않았다. 세부는 `validation.md`에 남겼다.
