# issue-62 레퍼런스 조사: 조직 대시보드 지표와 홈

조사일: 2026-10-27(KST). 대상: [#62](https://github.com/babo-jeonguk/BaboJUBot/issues/62), parent [#49](https://github.com/babo-jeonguk/BaboJUBot/issues/49), 완료된 blocker [#55](https://github.com/babo-jeonguk/BaboJUBot/issues/55). 구현 전 권고이며 확정 계약이나 구현 결과가 아니다. 상세 자료: `.reference-cache/issue-62/`(Git 무시). [조사 receipt](https://github.com/babo-jeonguk/BaboJUBot/issues/62#issuecomment-6422188274).

권고는 **서버가 조직별 원장으로 정확한 집계와 14개 날짜를 만들고, 홈 전체 합계·카드 목록·Event 갱신을 구분하는 방식**이다. 제한된 최근 실행 목록 길이로 총수를 세거나 현재 작업 상태를 과거 상태 추세로 표시하지 않는다. 차트 의미·시간대·성공률 분모는 아래 열린 결정이며, 이 조사로 확정하지 않는다.

## Brief

구현할 문제: 조직 대시보드 지표(상태별 작업·실행 시도·산출물), 14일 차트, 실행 중 에이전트, 최근 활동과 홈의 전체 조직 개요·진행 중 실행 시도 수를 Event stream으로 갱신한다. 조직 활동은 에이전트로 필터한다.
동종 문제: 다중 tenant 운영 화면이 원본 상태를 범위별 snapshot·일별 bucket으로 집계하고 push invalidation 뒤 다시 조회한다.
고정 결정: Node24/Express/Postgres/Drizzle/React/TanStack Query(WebSocket), 조직 ID 강제는 Control Plane, HTTP 원본/Event invalidation, #77의 single-flight+trailing 갱신 구현 유지. 실행 시도와 heartbeat·외부 job 구별, 조직 stage/에이전트 pause/실제 running은 별개, 취소 정리 중 slot은 종료까지 유지. 초기 승인·최종 완료·예산·Inbox 판정 그대로. 제품 코드·테스트·설정 수정, 실제 모델/실제 데이터/자격 증명 사용 없음.

|ID|질문|출처|전략|
|---|---|---|---|
|Q1|조직별 지표·홈 실행 중 수·실행 중 에이전트의 authoritative 원본과 scope/join·snapshot 경계는?|#62 AC1·2, #55 작업/산출물, AGENTS 조직 격리|Source Recon + adversarial + persistence|
|Q2|14일 차트의 날짜·시간대·0 bucket·상태별 작업/성공률의 의미와 기간 경계는?|#62 대시보드 14일 차트, GLOSSARY 실행 시도·최종 완료 구분|공식 명세/SQL + source + behavioral probe|
|Q3|조직 대시보드·전체 홈·에이전트 활동 필터를 어떻게 배치하고 빈/로딩/오류/좁은 폭·실행 상세 이동을 표시하나?|#62 What to build·AC3, features 화면 지도, #50 기존 화면|Surface Capture + Behavioral + source|
|Q4|Event burst/최초 연결/재연결·다른 조직·취소 정리 중 갱신 및 검증 경계는?|#62 AC 전부, #77, #59 제어·#60 재시작|Source Recon + runtime/failure|

재사용 판단: paperclip-dashboard/dashboard-references는 후보·화면 메커니즘 출발점, #50은 홈/조직 scope·반응형 셸 맥락, #52는 snapshot reconnect, #55는 작업/산출물 정의, #59는 취소 정리 중 running, #60은 server_restart 종료, #61/inbox-detail는 Inbox 의미 분리, #77은 현재 live-refresh 전제로 재사용한다. #51/54/56/57/58/64 및 runtime/interaction/stack 일반 조사는 고정 결정·제약 맥락만 사용한다. 동일 소스 재사용 시 파일별 blob 비교 또는 새 SHA 원문 재열람. 캐시의 기존 캡처/실행을 이번 실행 증거로 세지 않는다.

### 기존 조사 재사용

| 조사 | 재사용 범위 | 재확인·배제 |
|---|---|---|
| [Paperclip 대시보드](paperclip-dashboard.md#21-홈주의-화면)·[기타 대시보드](dashboard-references.md) | 후보·탐색 경로 | 과거 화면/실행을 이번 근거로 세지 않음. 최신 원문 재열람 |
| [#50 D07](issue-50-references.md#결정-권고) | 전체 홈과 조직 대시보드의 구분 | 기존 1b4c803 대비 최신 ActivityCharts/ActiveAgentsPanel blob 동일, Dashboard/MetricCard 변경되어 재열람 |
| [#52](issue-52-references.md#결정-권고)·[#77](issue-77-references.md#결정-권고) | HTTP snapshot·ready/reconnect·조회 중 dirty 보존 | 현행 `live-events.ts`/`live-refresh.ts` 재열람. #77은 이미 구현되어 새 배처/큐 조사 제외 |
| [#55](issue-55-references.md#구현-참고)·[#59](issue-59-references.md#구현-참고)·[#60](issue-60-references.md#구현-참고) | 작업·산출물·취소 정리·server_restart 의미 | 현행 DB schema와 조회 재열람. 종료·승인 정책을 새로 정하지 않음 |
| [#61](issue-61-references.md#구현-참고)·[Inbox 상세](inbox-detail-references.md#결정-권고) | 주의 필요와 실행 중 분리 | Inbox 배지/읽음/보관은 대시보드 실행 수로 대체하지 않음 |
| #51·54·56·57·58·64, runtime/interaction/stack 일반 조사 | 고정 제약의 배경 | 지도·팀·승인·결과·하네스·모델 실행 재조사는 범위 밖 |

## 레퍼런스

중복 제거한 후보 **14개**: Paperclip, Kestra, Trigger.dev, Windmill, Bull Board, AgentLens, Inngest, Grafana Play, UseAgent, PostgreSQL, Grafana PostgreSQL datasource, Prometheus 가이드, TimescaleDB, dbt snapshots. 전체 후보별 출처·실행 경로는 `.reference-cache/issue-62/candidates.md`에 있다. Grafana Play(화면)와 datasource(집계 부품)는 별도 후보로 센다.

| 관점 | 탐색·saturation 근거 |
|---|---|
| 운영 제품의 scope/집계 | 4후보·3라운드. 마지막 심볼/실패 검색은 scope 직접 count, 제한 카드, stale gauge, 여러 원본의 비원자 조회를 반복하고 새 패턴을 더하지 않음 |
| 시간·집계 부품/명세 | 6후보·4라운드. 마지막 공식 source 추적은 달력일/빈 값/분모/변경 이력 위험의 구현 위치만 좁힘 |
| UI/운영 화면 | 8후보·4라운드. 마지막 mobile/empty/오류 검색은 필터 빈 상태, 연결 상태, 기간·상세 이동 패턴의 변형에 수렴 |

포화는 이 질문·검색 경로에서 새 패턴을 얻지 못했다는 뜻이며 전 생태계 전수조사를 뜻하지 않는다.

| 심층 대상 | 고정 버전·SHA | 라이선스 | 깊이·선정 이유 |
|---|---|---|---|
| Paperclip | `125ddcabe51b2850cac2c64ee111a529d0578673` | MIT 원문 확인 | route→service→schema→test·git log, 원본 차트 module 실행. 같은 스택에서 scope·제한 목록·날짜 오류를 함께 비교 |
| PostgreSQL | 공식 문서 18, 독립 실행 엔진 17.11 | 엔진 도입 없음; 라이선스 심사 미실시 | 날짜·snapshot 명세 + 합성 SQL 실행. 기존 Postgres 기능만으로 구현 가능한지 확인 |
| Grafana PostgreSQL datasource | `975580aadf51fa075e0181026abd0dcfb9f366dd` | AGPL-3.0 원문 확인 | macro→fill→빈 결과 guard·테스트 소스. gapfill이 무행 결과까지 보장하지 않는 반례 |
| Prometheus 가이드 | docs `3576591af32864770ad6ff73a14fc485f70afb73` | Apache-2.0 원문 확인 | 공식 계수·비율 문서. 진행 중과 종료 성과, 합산 비율 구분 |

심층 대상 확인일은 모두 2026-10-27. **설계 참고만 권고하며 코드 복사·새 패키지·DB 확장 도입을 권고하지 않는다.** Paperclip 원본은 무시 캐시·연구용 `/tmp`에서만 실행했다. 제품 이식 시에는 그 SHA의 파일 header·NOTICE·동반 의존성을 다시 확인하고 AGENTS의 출처·THIRD_PARTY_NOTICES 규칙을 적용해야 한다.

## 근거

메인이 결정용 원문과 캡처를 다시 열었다. 재확인 기록: `.reference-cache/issue-62/main-verification.md`. 테스트 소스 열람은 실행 통과가 아니다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 현행 `listRuns`는 최근50 기본, `listRunningRuns`는 조직+running으로 무제한. running 행은 finishedAt=null이고 agent당 하나이며 취소 요청 중도 포함 | BaboJUBot [runs](https://github.com/babo-jeonguk/BaboJUBot/blob/ea1a3f02a874e76adfb4cb86126a799866f9a502/packages/db/src/runs.ts#L538-L568), [schema](https://github.com/babo-jeonguk/BaboJUBot/blob/ea1a3f02a874e76adfb4cb86126a799866f9a502/packages/db/src/schema.ts#L194-L234) | 소스 확인 |
| <a id="E02"></a>E02 | 현행 조직 제어의 화면 주 숫자는 running 전체에서 취소 정리 중을 빼고 별도 표시한다. DB 원본 running과 화면 주 숫자의 뜻이 다르므로 홈 계약에 명시가 필요 | [OrganizationControl](https://github.com/babo-jeonguk/BaboJUBot/blob/ea1a3f02a874e76adfb4cb86126a799866f9a502/apps/web/src/pages.tsx#L230-L234) | 소스 확인 |
| <a id="E03"></a>E03 | Paperclip summary는 company를 먼저 확인하고 각 원장 count에 company 조건을 넣는다. agent running은 agents.status 기반이며 별도 순차 SELECT에 transaction 경계가 없다 | [dashboardService.summary](https://github.com/paperclipai/paperclip/blob/125ddcabe51b2850cac2c64ee111a529d0578673/server/src/services/dashboard.ts#L30-L84) | 소스 확인 |
| <a id="E04"></a>E04 | 서버는 UTC 오늘부터 13일 전까지 날짜 Map을 먼저 만들고 created_at 집계를 채운다. 실패 재시도 조상을 recovered로 재분류하며 running/cancelled 등도 other와 total에 포함 | [날짜·window](https://github.com/paperclipai/paperclip/blob/125ddcabe51b2850cac2c64ee111a529d0578673/server/src/services/dashboard.ts#L9-L24), [runActivity](https://github.com/paperclipai/paperclip/blob/125ddcabe51b2850cac2c64ee111a529d0578673/server/src/services/dashboard.ts#L104-L184) | 소스 확인 |
| <a id="E05"></a>E05 | UI의 날짜는 local setDate 뒤 UTC ISO로 변환. 작업 차트는 생성일별 현재 상태이며 성공률은 (succeeded+recovered)/total. flat-list fallback은 recovery를 계산하지 못한다 | [getLast14Days](https://github.com/paperclipai/paperclip/blob/125ddcabe51b2850cac2c64ee111a529d0578673/ui/src/components/ActivityCharts.tsx#L5-L10), [IssueStatusChart/SuccessRateChart](https://github.com/paperclipai/paperclip/blob/125ddcabe51b2850cac2c64ee111a529d0578673/ui/src/components/ActivityCharts.tsx#L249-L327) | 소스 확인 |
| <a id="E06"></a>E06 | live-runs는 queued/running, default·cap50, minCount 지정 시 종료 이력 padding. 카드용으로는 task별 대표를 고르고 limit한다 | [route](https://github.com/paperclipai/paperclip/blob/125ddcabe51b2850cac2c64ee111a529d0578673/server/src/routes/agents.ts#L6949-L6961), [조회·padding](https://github.com/paperclipai/paperclip/blob/125ddcabe51b2850cac2c64ee111a529d0578673/server/src/routes/agents.ts#L7003-L7049), [대표 선택](https://github.com/paperclipai/paperclip/blob/125ddcabe51b2850cac2c64ee111a529d0578673/server/src/services/dashboard-run-selection.ts#L5-L48) | 소스 확인 |
| <a id="E07"></a>E07 | activity의 agent 필터는 company 조건에 AND로 붙는다. 조직 URL에 다른 조직 agent ID를 주어도 조회 범위를 다른 조직으로 바꾸는 조건은 아니다 | [activity.list](https://github.com/paperclipai/paperclip/blob/125ddcabe51b2850cac2c64ee111a529d0578673/server/src/services/activity.ts#L360-L397) | 소스 확인 |
| <a id="E08"></a>E08 | 최신 AuditFeed는 company+agent 필터를 query key·HTTP에 함께 넣고 loading·오류/retry·필터 결과0건/필터 해제를 구분 | [query](https://github.com/paperclipai/paperclip/blob/125ddcabe51b2850cac2c64ee111a529d0578673/ui/src/pages/audit/AuditFeed.tsx#L374-L419), [상태](https://github.com/paperclipai/paperclip/blob/125ddcabe51b2850cac2c64ee111a529d0578673/ui/src/pages/audit/AuditFeed.tsx#L740-L780) | 소스 확인 |
| <a id="E09"></a>E09 | Dashboard는 초기 skeleton/summary error를 구분. ActiveAgentsPanel은 기본4개를 active와 최근 완료로 채워 최대4카드를 보여주므로 실행 중 전용 목록과 다르다 | [Dashboard 상태](https://github.com/paperclipai/paperclip/blob/125ddcabe51b2850cac2c64ee111a529d0578673/ui/src/pages/Dashboard.tsx#L299-L329), [ActiveAgentsPanel](https://github.com/paperclipai/paperclip/blob/125ddcabe51b2850cac2c64ee111a529d0578673/ui/src/components/ActiveAgentsPanel.tsx#L84-L166) | 소스 확인 |
| <a id="E10"></a>E10 | 명시 timezone의 날짜 자정과 calendar series를 사용할 수 있다. generate_series의 stop은 포함되며 DST는 달력일 길이를 바꿀 수 있다 | [PostgreSQL18 date_trunc](https://www.postgresql.org/docs/18/functions-datetime.html#FUNCTIONS-DATETIME-TRUNC), [series](https://www.postgresql.org/docs/18/functions-srf.html) | 문서 주장 |
| <a id="E11"></a>E11 | Read Committed는 SELECT 시작 시 snapshot, 같은 transaction의 연속 SELECT도 다를 수 있다. Repeatable Read는 첫 조회 기준 snapshot 유지 | [PostgreSQL18 isolation](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED) | 문서 주장 |
| <a id="E12"></a>E12 | Grafana macro는 timeFilter에 양끝 포함 BETWEEN, timeGroup에 epoch/interval floor를 쓴다. 지역 달력일 경계 구현으로 그대로 복사할 계약이 아니다 | [evaluateMacro](https://github.com/grafana/grafana-postgresql-datasource/blob/975580aadf51fa075e0181026abd0dcfb9f366dd/pkg/postgresql/macros.go#L197-L230) | 소스 확인 |
| <a id="E13"></a>E13 | Grafana는 0행이면 fill에 도달하기 전에 반환한다. fill 설정만으로 완전히 빈 조직의14일 행이 생긴다고 볼 수 없다 | [processFrame](https://github.com/grafana/grafana-postgresql-datasource/blob/975580aadf51fa075e0181026abd0dcfb9f366dd/pkg/postgresql/sqleng/sql_engine.go#L296-L311) | 소스 확인 |
| <a id="E14"></a>E14 | 공식 가이드는 진행 중 gauge와 완료 계수의 의미를 구분하고, 비율을 모을 때 분자·분모를 각각 합한 뒤 나누도록 한다 | [instrumentation](https://github.com/prometheus/docs/blob/3576591af32864770ad6ff73a14fc485f70afb73/docs/practices/instrumentation.md#L24-L51), [rules](https://github.com/prometheus/docs/blob/3576591af32864770ad6ff73a14fc485f70afb73/docs/practices/rules.md#L30-L45) | 문서 주장 |
| <a id="E15"></a>E15 | upstream 테스트는 105개 당일+7일 전3개 전체 집계·다른 company 제외·14행과 live cap50을 assert한다. 이번 실행은 하지 않았다 | [dashboard service test](https://github.com/paperclipai/paperclip/blob/125ddcabe51b2850cac2c64ee111a529d0578673/server/src/__tests__/dashboard-service.test.ts#L96-L210), [live route test](https://github.com/paperclipai/paperclip/blob/125ddcabe51b2850cac2c64ee111a529d0578673/server/src/__tests__/agent-live-run-routes.test.ts#L712-L755) | 소스 확인 |
| <a id="E16"></a>E16 | 독립 SQL16검사 통과: A/B scope, 잘못 결합한6행 대비 정확한2/3건, recent50의 오래된running 누락, 취소 중 슬롯,14일0건, UTC/KST,25시간 날짜, 현재 상태 변경과 과거 bucket, 두 격리 수준의 snapshot 차이 | `probes/aggregation.sql`·`aggregation-run-log.txt`. PostgreSQL17.11,2GB 컨테이너, 합성 자료만 사용 | 실행 확인 |
| <a id="E17"></a>E17 | 원본 날짜 함수 body를 추출해 고정 clock으로 실행. UTC는 연속14일, 뉴욕 2026-11-02T00:30Z는 11/1이 빠지고 10/19…10/31→11/2. 서울 local10/28 01시는 UTC 날짜10/27로 끝남 | `probes/original-date.mjs`·`original-date-result.json`, Node24.21.0. 원본 body만 사용, mock Date·TZ는 probe에서 주입 | 실행 확인 |
| <a id="E18"></a>E18 | 원본 차트를1440/390px에서 fixture empty→data로 조작. 캡처4개 재열람,14개 bar/title 확인·가로 넘침0·focus 가능한 bar0·외부 요청0. 전체 Dashboard/WS 실행은 아니다 | `probes/chart-capture.mjs`·`chart-surface-log.json`, `captures/`. Paperclip@위 SHA 원본 module+합성 fixture, 브라우저 Playwright1.58.2/Chromium1228 | 실행 확인 |
| <a id="E19"></a>E19 | 현행 key는 전역 organizations exact와 조직 prefix·agent별 events, ready는 전체 갱신. createLiveRefresh가 요청 중 dirty를 보존한다. 새로운 별도 홈 key는 현재 Event 분기에 자동 포함되지 않는다 | [keys](https://github.com/babo-jeonguk/BaboJUBot/blob/ea1a3f02a874e76adfb4cb86126a799866f9a502/apps/web/src/api.ts#L50-L63), [Event](https://github.com/babo-jeonguk/BaboJUBot/blob/ea1a3f02a874e76adfb4cb86126a799866f9a502/apps/web/src/live-events.ts#L33-L43), [live-refresh](https://github.com/babo-jeonguk/BaboJUBot/blob/ea1a3f02a874e76adfb4cb86126a799866f9a502/apps/web/src/live-refresh.ts#L1-L78) | 소스 확인 |
| <a id="E20"></a>E20 | 정확한 수·의미·시각 경계는 HTTP 집계 계약이고 Event는 재조회 신호다. UI의 scope·filter 표시는 서버 조직 경계/승인 강제를 대신하지 않는다 | E01/E03/E07/E11/E19, [구조](../architecture.md#surface--control-plane), [ADR-0002](../adr/0002-durable-records-and-wakes.md)에서 도출 | 추론 |

근거20개: 실행3·소스13·문서3·추론1. 실행 행마다 범위가 다르므로 제품 테스트 통과로 합산하지 않는다.

## 패턴

아래 패턴·결정은 관찰에서 도출한 권고다.

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 정확한 aggregate와 제한 카드 목록 분리 | E01/E03/E06/E15/E16 | Paperclip은 대표 task+padding, Babo는 agent당 실행 하나 | 오래된 진행 시도도 정확히 셈 | list.length·task 수·agent 활성 설정을 run 수로 오인 |
| <a id="P02"></a>P02 | 원장별 선집계·조직 scope·하나의 읽기 snapshot | E03/E07/E11/E16 | Paperclip 독립 SELECT와 snapshot 보장 비교 | fanout·scope 누락·순차 조회 불일치 방지 | Promise.all·기본 transaction만으로 동일 시점 보장 안 됨 |
| <a id="P03"></a>P03 | 서버의14개 날짜와 명시 timezone/경계 | E04/E10/E12/E13/E17 | 서버UTC vs 클라이언트 local/ISO·Grafana fixed epoch | 빈 조직에도 안정된 날짜 계약 | off-by-one·DST·조회 오류를0으로 은폐 |
| <a id="P04"></a>P04 | 시작량·종료결과·작업 현재상태·연구완료 분리 | E04/E05/E14/E16 | recovered 재분류는 Paperclip 고유 정책 | 숫자의 의미와 분모를 설명 가능 | 현재 cohort를 과거 추세로 오인·진행 중을 실패처럼 분모에 혼합 |
| <a id="P05"></a>P05 | scope/필터 query key와 empty/error 분리 | E07/E08/E09/E18 | 최신 audit는 필터 empty 구분, live panel은 이력 혼합 | 조직 전환/필터 때 정확한 맥락 유지 | 다른 조직 지연 응답·초기 로딩을0건으로 표시 |
| <a id="P06"></a>P06 | invalidation 뒤 HTTP로 수렴 | E19/E20, [#77](issue-77-references.md#결정-권고) | 현재 dirty 조율을 재사용 | 중복·누락·재연결에도 원본 재확인 | Event별 +/- 계산 drift·새 홈 key 갱신 누락 |
| <a id="P07"></a>P07 | 작은 원본 chart와 접근 가능한 수치 표현 | E05/E18 | 원본은title div, 실험 host 배치/색은 연구 fixture | 추가 차트 엔진 없이14일 표현 가능 | hover title만으로 keyboard/touch 사용자가 수치에 접근하기 어려움 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 채택 | 조직 요약은 task 상태별·run·artifact 원장별 선집계 뒤 조직 ID로 결합. 전체 홈은 모든 조직+조직별/전체 running을 한 조회 계약으로 제공. 없는 조직은404, 존재하는 빈 조직은0 | P01/P02, #62 AC1·2 | 홈의 전역 조회 권한과 조직 API 범위를 분리. 합성 probe는 실제 API 거부 검증을 대신하지 않음 | Q1 |
| <a id="D02"></a>D02 | 변형 채택 | 실행 중 원본은 status=running·finishedAt=null. 취소 정리 중 수를 별도 반환하고 합계/부분집합 관계를 고정. 큐 깨우기·heartbeat on·task status·외부 job·종료 이력은 세지 않음 | P01, E01/E02 | DB 슬롯 기준 total에는 cancel이 포함. 현행 제어 화면의 주 숫자와 다른 점은 명시하고 표시 숫자는 열린 결정 O4에서 선택 | Q1,Q4 |
| <a id="D03"></a>D03 | 채택 | count/실행 중 목록/홈 조직별 합계 등 서로 맞아야 하는 데이터는 단일SQL 또는 짧은 READ ONLY REPEATABLE READ snapshot. asOf와 기간 기준을 하나 잡음 | P02, E11/E16 | 응답 하나 내부의 정합성. 별도 HTTP인 홈과 조직 화면이 항상 같은 순간인 것은 보장하지 않음. 읽기 때문에 조직 쓰기 잠금을 추가하지 않음 | Q1,Q4 |
| <a id="D04"></a>D04 | 변형 채택 | 서버가14개 날짜와0건 bucket을 만들고 `[dayStart,nextDayStart)` 및 기준시각까지 집계. timezone/range/asOf 의미를 응답 계약에 둠. 오늘 포함UTC를 추천하되 O1에서 확정 | P03 | 로컬/UTC 혼합 함수·BETWEEN 복사 배제. 다음 자정의 새 bucket도 Event 없이 날짜가 바뀌므로 그때 또는 focus 복귀 시 회수 필요 | Q2,Q4 |
| <a id="D05"></a>D05 | 보류 | 차트 종류/기준시각·분모를 O2/O3에서 확정. 실행 시작량은 startedAt, 종료성과는 finishedAt, 작업 현재상태는 상태카드 또는 정확히 이름 붙인 생성일 cohort. 연구 최종완료와 무관 | P04 | Paperclip의 recovered 성공·running 포함 total을 우리 정책으로 수입하지 않음. 현재 상태에서 과거 일말 상태를 꾸며내지 않음 | Q2 |
| <a id="D06"></a>D06 | 변형 채택 | 조직 대시보드의 기존 제어·목표·승인/결과 영역에 지표/차트/실행 중 agent/최근 활동을 연결. 실행 중 카드에는 run 링크·상태·시작시각·취소정리 표시, 많으면 총수와 더보기. 홈은 기존 조직 개요 유지 | P01/P05, #50 D07, #62 | 원본4개 padding으로 빈 슬롯을 채우지 않음. 최근 활동은Event ID 내림차순으로 제한하고 전체 활동으로 이동. 개수 제한은 총수와 분리 | Q3 |
| <a id="D07"></a>D07 | 채택 | 기존 activity 서버 AND agent 필터와 query key를 유지. 다른 조직 agent 입력은 빈 결과/404 정책을 따르고 타 조직 자료 금지. 전체 활동과 필터0건·초기 loading·오류/retry·오래된 정상값을 구분 | P05, E07/E08 | 이미 구현된 필터를 교체할 필요 없음. 사용자/조직 Event를 특정 agent 활동으로 억지 귀속하지 않음 | Q1,Q3 |
| <a id="D08"></a>D08 | 채택 | 조직 summary key는 기존 조직 prefix 아래, 홈 key는 Event별 명시 갱신에 포함. ready/reconnect는 전체 회수, #77 dirty/trailing 유지. Event payload로 직접 카운터를 누적하지 않음 | P06, E19 | 새 전역 key를 넣기만 하면 실시간 갱신된다는 가정 금지. 다른 조직 Event도 홈 합계는 바뀔 수 있음 | Q4 |
| <a id="D09"></a>D09 | 변형 채택 |14일 그림은 서버 series로 그리는 가벼운 막대/SVG 후보. 날짜·분자/분모를 읽을 수 있는 표/텍스트와 keyboard/touch 접근을 제공. 390px에서는 한 열 후보로 검증 | P03/P07, E18 | 추가 시각화 패키지 필요 근거 없음. 관찰한 한 열 배치·팔레트는 연구 host이므로 제품 배치 확정 근거가 아님 | Q3 |
| <a id="D10"></a>D10 | 채택 | 합성 자료·가짜 프로바이더의 기존 제품 경로로 V01–V12를 검증. API의 scope/정확한 원본/진행 중 수와 UI의 최종 갱신을 각각 assert | E15/E16/E19, #62 AC1–3 | 실제 모델 없이 검증 가능. 이번 조사 probe 통과는 구현 AC 통과가 아님 | Q1,Q2,Q3,Q4 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 최근50개·카드4개·task 대표 길이로 running 전체 계산 | E01/E06/E15/E16 | 오래된 진행 시도·다중 시도 누락, 이력 padding 혼합 |
| agent.status/heartbeat 활성 수를 실행 중으로 표시 | E03, GLOSSARY | 에이전트 설정/깨우기와 실제 실행 시도가 다름 |
| 큰 테이블을 모두 JOIN한 뒤 count, Promise.all이면 같은 snapshot | E03/E11/E16 | 중복 집계 또는 서로 다른 시점 |
| local setDate+UTC ISO, 초 단위 interval을 지역 달력으로 간주 | E10/E12/E17 | 날짜 누락·경계 불일치 |
| 0분모를0%/100%, 누락·실패를0건, 과거 상태를 현재 상태로 추정 | E05/E13/E16 | 숫자·시간 의미 왜곡 |
| Grafana/Prometheus/Timescale/dbt 또는 새 큐 플랫폼 도입 | Discovery + ADR-0004 | 기존 Postgres·Query로 충분. 관찰을 위한 비교 대상 |

## 구현 참고

- 최소 데이터 계약 후보: 조직 ID·asOf, task 상태별 count, run 전체/상태별 count, artifact count, runningTotal/cancellingCount, 정확한 total과 별개인 runningAgents·recentEvents, timezone/range·14개 day bucket. 홈은 조직별 running과 전체 합계를 같은 snapshot에 맞춘다. 이름·응답 shape는 구현자가 계약을 검토하며 확정한다.
- 위치: `packages/contracts`의 조회 스키마 → `packages/db`의 조직별 선집계/읽기 snapshot → `apps/server`의 사용자 조회 route → `apps/web` query/key·홈/조직 dashboard·activity renderer. 조회가 새 승인·wake·실행 시도를 만들지 않게 한다. 계산 때문에 `packages/core`에 DB/웹 의존성을 넣지 않는다.
- 현재 ActivityScreen 필터와 #77 조율은 재사용하고, 기존 제어·승인/결과·연구 목표 영역은 요구에 맞춰 함께 배치한다. 통합 구조는 [architecture](../architecture.md#패키지-구성), 수정 진입점은 [code-map](../agents/code-map.md)을 따른다.
- 후속 #63: 판1 전체 데모에 새 지표가 작업·산출물·최종 완료 흐름을 반영하는 장면을 연결. #62가 자기 API/UI AC 검증을 #63으로 미루는 뜻은 아니다. 외부 job·비용/예산 상세는 구조의 판4이며 새 provider·기억 엔진·알림 정책을 추가하지 않는다.

| ID | 검증할 경계: 입력 → 행동 → 기대 | 근거 |
|---|---|---|
| V01 | A/B 조직에 서로 다른 작업·산출물·실행 자료 → A summary/agent filter → A 자료만, 다른 조직 ID·조인·최근 활동 혼합0 | D01/D07 |
| V02 | 작업2·산출물3·run 여러 개 → 집계 →2/3과 각 상태 합계 일치, fanout 없음. 없는 조직404/빈 조직0 구분 | D01/D03 |
| V03 | A running2(그중 cancel1), B running1, 최근 종료55개 → 홈/조직 요약 → raw 전체3=A2+B1, cancel1 별도. 오래된 running 누락 없음 | D02 |
| V04 | pause/취소 요청 뒤 아직 미종료 → count 유지·정리중 표시, 종료/restart 저장 뒤 감소·후속 새 실행이면 증가. completed 조직의 기존 실행 자연 종료도 stage로 숨기지 않음 | D02, #59/#60 |
| V05 | 동시 commit을 두 조회 사이에 삽입 → summary snapshot → counts/list 및 홈 조직별 합계/전체 수가 한 snapshot 안에서 일치 | D03 |
| V06 | 무행/기간 밖만 있는 조직·start 직전/정각·end 정각·UTC/KST·DST →14개 오름차순 unique 날짜, 정확한 포함/배제·0건. 오늘 partial/asOf 및 자정 후 날짜 이동 검증 | D04 |
| V07 | 어제 시작 오늘 종료·재시도 성공·실패·취소·server_restart·미종료 → 선택한 시각/분모에만 포함,0분모는—, 연구완료로 해석하지 않음 | D05 |
| V08 | 오래된 작업의 상태가 오늘 변경 → 선택한 cohort/전이 정의대로만 차트 변경. 과거 일말 상태를 임의 복원하지 않음 | D05 |
| V09 | A→B 이동 직후 A의 지연 응답·Event, agent 필터 변경 → route/key/본문/link 모두B, 필터와 API 일치. 사용자/조직 Event의 필터 의미 유지 | D07/D08 |
| V10 | 느린 조회 중 Event burst·연결 전 누락·socket 단절/재연결·다른 탭 쓰기 → 진행 응답도 표시하고 마지막 서버 상태로 수렴, 홈·현재 조직·필터 활성 조회 갱신 | D08, #77 |
| V11 | 최초 로딩·정상0·필터0·오류·마지막 정상값 후 갱신실패 → 구별된 안내/retry, 오래된 수를 최신0으로 덮지 않음 | D06/D07 |
| V12 |1440/390px·keyboard/touch→수치/기간·0분모·run 상세 접근, chart 표 대안·가로 overflow 없음. 카드 제한이면 총수와 더보기 일치 | D06/D09 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| O1 날짜/시간대 | 사용자/#62 | A 오늘 포함UTC14달력일(권고, 오늘부분일) / B 사용자 IANA zone14일. 어제까지 완결14일도 가능하나 화면에 명시. local/UTC 혼합 배제(E10/E17) |
| O2 작업/실행 차트 의미 | 사용자/#62 | A 실행 시작량+생성일별 작업의 현재 상태(권고, cohort라 명명) / B 작업 상태 전이 건수(영속Event로 완전 복원 가능한지 확인) / C 일말 상태량(이력/snapshot 필요, 범위 크면 별도 이슈).14일 chart 요구를 임의로 없애지 않음 |
| O3 성공률을 넣을 때 분모 | 사용자/#62 | A finishedAt 기준 성공/(성공+실패), 취소/server_restart 별도(권고) / B 성공/모든 종료 시도. 분자·분모 원수와0분모—는 공통. 연구완료 지표가 아님(E14) |
| O4 홈의 주 숫자·정리중 표시 | 사용자/#62 | A raw running 전체에 '이 중 취소 정리중M'(권고: 실제 미종료 수) / B 동작 중과 취소 정리중을 나란히 표시(현행 제어와 일관). raw total/cancelling은 둘 다 서버에서 명확히 반환(E01/E02) |

## 한계와 미확인

- 제품 코드·테스트·설정, 브랜치·커밋·push·PR은 변경/생성하지 않았다. 새 조사 문서와 문서 지도만 작업 트리에 남긴다. API/제품 E2E·upstream test suite·대용량 query plan·스크린리더·전체 Paperclip Dashboard·active panel/필터의 실제 상호작용은 실행하지 않았다.
- 공개 UI는 JS shell 또는 접근 실패까지만 확인했다. 로그인 벽/서비스 중단의 근거가 아니다. 최신 Storybook 예상4경로는404였고, 옛 SHA1b4c803의 story만 읽었다. 로컬 관찰은 최신 원본 차트에 한정되며 host 배치/색/fixture 버튼은 연구용이다. native title은 속성을 확인했으며 tooltip 자체가 캡처에 보인다는 주장은 하지 않는다.
- SQL은 Docker PostgreSQL17.11의 합성 schema에서16검사와 읽기 전용 snapshot2 assertions를 수행했다. 제품 embedded18·Drizzle·API는 실행하지 않았다. 초기 recent50 음성 대조군의 동률 시각을 제거한 뒤 다시 실행해 통과했다. 독립 probe는 제품의 조직 경계·모든 쓰기 경로를 보장하지 않는다.
- 최초 Vite 기동은 읽기 전용 의존 경로로 설정 임시 파일을 쓰려다가 실패했으며 `--configLoader native`로 해결했다. 의존성 추가/lifecycle script 실행은 없었다. 서버는 Node24 이미지, 브라우저 runner는 Node20.20.2, 메모리2GB 제한·키 없는 env·합성 자료를 사용했다. 브라우저의 외부 요청0, 모델 호출0. 날짜 함수 probe는 Node24.21.0으로 원본 body를 추출해 mock Date/TZ를 주입했으며 module 전체 실행은 아니다.
- 원문·캡처4개 재열람, 로컬 링크/anchor·`git diff --check` 결과는 캐시 검증 기록에 남긴다. 구현 시 upstream 변경과 코드 채택 시 LICENSE/NOTICE/의존성을 다시 확인해야 한다.
