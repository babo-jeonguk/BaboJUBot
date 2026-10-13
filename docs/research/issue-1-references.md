# issue-1 레퍼런스 조사: 기반 도메인·상태·데이터 계약과 개발 검증 환경

조사일: 2026-10-13. 대상: [#1](https://github.com/babo-jeonguk/BaboJUBot/issues/1). 구현 전 기술 권고이며 확정 계약이나 구현 결과가 아니다. 상세 자료: `.reference-cache/issue-1/`(git 무시).

## Brief

- 구현할 문제: 화면·server·worker가 공통 식별자·조직 귀속·상태·명령·이벤트·오류 계약을 사용하고, Node 24/pnpm 위에서 타입 검사와 유료 호출 없는 핵심 검증을 실행할 기반을 마련한다.
- 동종 문제: 서로 다른 실행 경계가 동일한 상태 기계와 검증 가능한 데이터 계약을 공유하는 메커니즘.
- 고정된 결정: 연구 목표마다 독립 조직; 초기 계획·팀 사용자 승인 후 실행; 결과 제출과 사용자 최종 완료, Task와 Run을 구분. 제품 규칙은 core, 교환 계약은 contracts, 외부 실행은 runtime, 저장 구현은 storage. web은 contracts를 소비한다. Node 24/pnpm 10.33.0/TypeScript workspace는 기존 골격. 저장 엔진·LLM 제공자·실제 호출은 이번 선정 대상이 아니다.
- 선행 관계: GitHub #1 본문과 dependencies API에서 blocker 없음 확인; parent 없음. ADR 디렉터리와 기존 `.reference-cache/` 없음.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | Task/Run 및 결과 제출/최종 완료를 구분하는 상태 계약과 전이 강제 위치는? | #1 구현 범위 2, 결정 2, 완료 조건 1 | Source Recon + runtime/failure |
| Q2 | 일곱 식별자와 조직 귀속을 어떻게 표현하고 교차 조직 참조·귀속 누락을 어디서 거부하는가? | #1 구현 범위 1; AGENTS.md 조직 경계 | Source Recon + adversarial scenario |
| Q3 | 명령·이벤트·오류의 검증, 시간 표현, 버전·unknown field 호환 정책은? | #1 구현 범위 3, 결정 2; 조사 1 | 프로토콜·계약·호환성 검증 + Source Recon |
| Q4 | 가짜 clock/runtime으로 승인·상태·조직 분리 경계를 어떤 방식으로 검증할 수 있는가? | #1 구현 범위 3, 검토 2 | Behavioral Recon + runtime/failure |
| Q5 | Node 24/pnpm에서 TS·테스트·포맷·정적 검사·웹/서버 도구와 CI의 최소 호환 조합은? | #1 조사 3, 결정 1, 완료 조건 2–4 | registry metadata + Behavioral Recon + 운영 repo 조합 |
| Q6 | 참고 코드와 도구의 라이선스가 독립 구현·배포 선택에 주는 제약은? | #1 조사 3, 참고 자료의 재사용 주의 | 고정 LICENSE·NOTICE·registry metadata 확인 |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [reference-code-structure](reference-code-structure.md#프로젝트별-구조와-참고-지점) | 네 지정 OSS의 경계·고정 SHA·핵심 파일 탐색 출발점 | 같은 SHA의 원문을 재열람하고 사용 파일의 blob identity를 기록한다. 구조 조사만으로 동작을 주장하지 않는다. |
| [paperclip](paperclip.md#제품-설명-문서-코드의-차이) | 조직·issue/run/approval 비교 질문의 출발점 | 관련 schema·service·route를 같은 SHA에서 다시 읽는다. 실행·격리 보장은 재사용하지 않는다. |
| [comparative-survey](comparative-survey.md#우선-심층-조사-제안--미확정) | 상태 엔진/프로토콜의 인접 후보 탐색 | 목록 정보만 재사용; 상용 서비스 및 기억 기법은 #1 답변에 직접 쓰지 않는다. |

## 레퍼런스

관점별 후보 항목 60개(제품 15·개발 패키지 28·표준/명세 17; 관점 간 중복 포함). 개발 버전 대안은 31행이다. 전체 후보·운영 상태·각 질문 연결: `.reference-cache/issue-1/candidates.md`. 목적은 다른 해법과 실패 모드를 비교하는 것이며 모든 OSS를 소진했다는 뜻은 아니다.

| 관점 | 마지막 라운드와 saturation 근거 |
|---|---|
| 제품·인접 도메인 | 5라운드. Argo 승인 예제, Celery 같은 Task ID 재시도, Prefect pause/suspend, BullMQ 멱등성을 재확인했으며 기존 실행/업무/승인 분리·재개·중복 패턴 외 새 변형 없음. |
| 개발 도구·라이브러리 | 3라운드. Hono in-process request, Vite/tsx/Node 타입 제거, TS 지원표를 확장 확인했으며 테스트/타입 검사 분리·peer 호환·입력 coercion 외 새 패턴 없음. |
| 표준·명세 | 4라운드. OpenRPC/RFC6901은 기존 schema/correlation/error 위치 패턴을 반복. RFC8259/OpenAPI 탐색에서 JSON 숫자·중복 key 경계는 추가했으며 마지막 라운드는 새 패턴 없음. |

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| [rakazo](https://github.com/elie222/rakazo/tree/40ee8548763ca1050350210291048274610bef79) | 공개 OSS 제품 | `40ee8548763ca1050350210291048274610bef79` | Apache-2.0 | 실행(순수 모듈만) | 순수 전이표와 contracts, 원본 상태 테스트 |
| [paperclip](https://github.com/paperclipai/paperclip/tree/1b4c803816e82b0265c8422e1a804327a7ed8c54) | 공개 OSS 제품 | `1b4c803816e82b0265c8422e1a804327a7ed8c54` | MIT | 소스·테스트 읽기 | 독립 업무/실행/승인 모델과 조직 guard·승인 정책 반례 |
| [paseo](https://github.com/getpaseo/paseo/tree/9246813fd2acd6afc7012c5fde79a164b8f8592e) | 공개 OSS 제품 | `9246813fd2acd6afc7012c5fde79a164b8f8592e` | Apache-2.0·내장 제3자 예외 | 소스·테스트 읽기 | 서버/클라이언트 공유 protocol과 관찰 상태 projection |
| [orca](https://github.com/stablyai/orca/tree/564693f1765e58bea9aee9cf642b96230411a8cd) | 공개 OSS 제품 | `564693f1765e58bea9aee9cf642b96230411a8cd` | MIT | 실행(순수 모듈만) | RPC 공통 admission, 응답 envelope, 부작용 전 버전 거부 |
| [CloudEvents](https://github.com/cloudevents/spec/tree/fc1f6f31f5f011a72183f1bcea20c987cb683ade) | 이벤트 명세 | v1.0.2 · `fc1f6f31f5f011a72183f1bcea20c987cb683ade` | Apache-2.0 | 문서 원문 | envelope와 payload 버전, 식별과 권한·순서 분리 |
| RFC9562·3339·9457 / JSON Schema | 표준·명세 | RFC 번호 / draft 2020-12 | 각 문서 고지; 코드 복제 권고 없음 | 문서 | ID·시간·오류·unknown field 정책 |
| TS / Vitest / Zod / 포맷·린트 / Vite / HTTP 도구 | 부품 라이브러리 | 아래 실행 조합·버전별 registry URL | MIT / Apache-2.0 / Biome 이중 선택 | 설치·실행 | 현재 Node24/pnpm 골격의 실제 호환성 |

깊이: 목록 / 문서 / 소스 / 실행. 네 제품의 조사일은 모두 2026-10-13. 기존 ref와 같은 SHA를 사용했고, 결정에 사용한 파일 원문을 메인이 재열람했다. `.reference-cache/issue-1/main-verification.md`에 원문 줄·blob identity·일치 결과를 남겼다. 새 근거는 기존 문서의 ID를 복제한 것이 아닌 이번 원문 재확인/실행이다.

## 근거

25개: 실행 확인 7 · 소스 확인 12 · 문서 주장 6. 원문 링크의 테스트는 별도 실행 표시가 없으면 **읽기만** 한 것이다. probe 로그는 `.reference-cache/issue-1/probes/`에 있으며 제품 검증 통과를 뜻하지 않는다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | Run 전이표는 core에, enum은 contracts에 있다. failed는 terminal로 분류되면서 queued 재시도를 허용한다. 전이표 호출만으로 모든 DB 쓰기 경로 보호를 입증하지는 않는다. | [canTransition/assertTransition](https://github.com/elie222/rakazo/blob/40ee8548763ca1050350210291048274610bef79/packages/core/src/run-state.ts#L31-L58); [lease 조건부 쓰기](https://github.com/elie222/rakazo/blob/40ee8548763ca1050350210291048274610bef79/packages/adapters/src/executor.ts#L3265-L3296) | 소스 확인 |
| <a id="E02"></a>E02 | 원본 상태 테스트 5개와 별도 64쌍 전이 대조가 통과했다. completed/cancelled 탈출 거부, failed→queued 허용을 확인했다. | [원본 테스트](https://github.com/elie222/rakazo/blob/40ee8548763ca1050350210291048274610bef79/packages/core/src/run-state.test.ts#L1-L54); `probes/vitest-log.txt`, `toolchain/probe.test.ts` (Node24.21.0·Vitest5.0.4·fast-check4.10.0) | 실행 확인 |
| <a id="E03"></a>E03 | Id는 nonempty string. IsoDate는 datetime 검증이지만 ProductEvent.createdAt은 string, payload는 unknown record여서 type별 payload를 강제하지 않는다. | [Id/IsoDate/RunStatus](https://github.com/elie222/rakazo/blob/40ee8548763ca1050350210291048274610bef79/packages/contracts/src/ids.ts#L1-L35); [ProductEventSchema](https://github.com/elie222/rakazo/blob/40ee8548763ca1050350210291048274610bef79/packages/contracts/src/events.ts#L329-L339) | 소스 확인 |
| <a id="E04"></a>E04 | Task에 해당하는 issue, heartbeat Run, Approval은 별도 상태 집합이며 Run 행에는 companyId·agentId·issueId가 있다. 독립 FK만으로 동일 조직 관계가 보장되지는 않는다. | [issue states](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/shared/src/constants.ts#L189-L198); [approval states](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/shared/src/constants.ts#L697-L704); [run states](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/shared/src/constants.ts#L919-L929); [heartbeatRuns](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/db/src/schema/heartbeat_runs.ts#L22-L42) | 소스 확인 |
| <a id="E05"></a>E05 | 신규 채용 사용자 승인 flag 기본 false; issue assertTransition는 target enum만 확인; reviewPolicy null/anyone이면 사용자 전용 완료를 강제하지 않는다. | [승인 기본값](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/packages/db/src/schema/companies.ts#L19-L21); [assertTransition](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/issues.ts#L312-L334); [review authority](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/issue-review-policy.ts#L100-L121) | 소스 확인 |
| <a id="E06"></a>E06 | HTTP 자원 접근은 타 조직/미존재에 같은 404를 반환한다. 내부 update의 companyGuard는 선택적이고 별도 updateForCompany가 조직 predicate를 전달한다. | [getAccessibleResource](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/routes/authz.ts#L157-L194); [update/companyGuard](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/issues.ts#L10828-L10867); [updateForCompany](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/issues.ts#L13743-L13760) | 소스 확인 |
| <a id="E07"></a>E07 | Run 시작 직전 agent readiness를 조건부 update로 재확인한다. 승인 HTTP는 assertBoard 후 조직 접근을 확인한다. 조직 전체의 초기 계획+팀 승인을 제공한다는 근거는 아니다. | [execution-start gate](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/services/heartbeat.ts#L4017-L4042); [approve route](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/server/src/routes/approvals.ts#L296-L304) | 소스 확인 |
| <a id="E08"></a>E08 | Paseo는 lifecycle과 UI bucket을 구분하며 initializing/idle도 done bucket이 될 수 있다. 관찰 상태를 연구 최종 완료로 매핑할 수 없다. | [deriveAgentStateBucket](https://github.com/getpaseo/paseo/blob/9246813fd2acd6afc7012c5fde79a164b8f8592e/packages/protocol/src/agent-state-bucket.ts#L14-L36) | 소스 확인 |
| <a id="E09"></a>E09 | server는 JSON 뒤 schema를 검증해 dispatch하지만 hello 버전은 <1만 거부한다. timestamp는 string/coerce.date/datetime이 혼재한다. | [handleRawMessage](https://github.com/getpaseo/paseo/blob/9246813fd2acd6afc7012c5fde79a164b8f8592e/packages/server/src/server/websocket-server.ts#L2295-L2330); [handleHello](https://github.com/getpaseo/paseo/blob/9246813fd2acd6afc7012c5fde79a164b8f8592e/packages/server/src/server/websocket-server.ts#L1562-L1594); [snapshot](https://github.com/getpaseo/paseo/blob/9246813fd2acd6afc7012c5fde79a164b8f8592e/packages/protocol/src/messages.ts#L813-L840); [activity](https://github.com/getpaseo/paseo/blob/9246813fd2acd6afc7012c5fde79a164b8f8592e/packages/protocol/src/messages.ts#L3413-L3425); [plugin log](https://github.com/getpaseo/paseo/blob/9246813fd2acd6afc7012c5fde79a164b8f8592e/packages/protocol/src/messages.ts#L6686-L6692) | 소스 확인 |
| <a id="E10"></a>E10 | Orca 응답은 알려진 discriminator/meta/error를 검증하고 추가 필드를 strip한다. result는 unknown이므로 method별 payload 검증의 근거는 아니다. | [RuntimeRpcEnvelopeSchema](https://github.com/stablyai/orca/blob/564693f1765e58bea9aee9cf642b96230411a8cd/src/shared/runtime-rpc-envelope.ts#L7-L52) | 소스 확인 |
| <a id="E11"></a>E11 | 공통 admission은 caller/method/source/version/params를 handler 전에 검사한다. mutation version 거부 때 handler·receipt 변화 없음을 assert하는 테스트가 있다(미실행). | [admitRpcRequest](https://github.com/stablyai/orca/blob/564693f1765e58bea9aee9cf642b96230411a8cd/src/main/runtime/rpc/rpc-request-admission-prologue.ts#L34-L85); [migrationFence](https://github.com/stablyai/orca/blob/564693f1765e58bea9aee9cf642b96230411a8cd/src/main/runtime/rpc/orchestration-contract-fence.ts#L11-L36); [부작용 없음 테스트](https://github.com/stablyai/orca/blob/564693f1765e58bea9aee9cf642b96230411a8cd/src/main/runtime/rpc/orchestration-contract-fence.test.ts#L50-L86) | 소스 확인 |
| <a id="E12"></a>E12 | UUID는 식별용이며 접근 권한을 뜻하지 않는다. RFC3339는 offset·정밀도 선택을 남기며 같은 형식이어야 문자열 정렬을 기대할 수 있다. 런타임 소유·권한 검사는 별도 필요하다(적용 추론). | [RFC9562 §8](https://www.rfc-editor.org/rfc/rfc9562.html#section-8), [RFC3339 §5](https://www.rfc-editor.org/rfc/rfc3339.html#section-5) | 문서 주장 |
| <a id="E13"></a>E13 | CloudEvents source+id는 중복 식별 기준이다. envelope specversion과 payload schema 진화는 별도이며 delivery·권한·전역 순서를 보장하지 않는다. | [spec id/source](https://github.com/cloudevents/spec/blob/fc1f6f31f5f011a72183f1bcea20c987cb683ade/cloudevents/spec.md#L248-L295), [primer versioning](https://github.com/cloudevents/spec/blob/fc1f6f31f5f011a72183f1bcea20c987cb683ade/cloudevents/primer.md#L253-L317) | 문서 주장 |
| <a id="E14"></a>E14 | JSON Schema additionalProperties와 format 정책은 명시해야 한다. format은 기본 annotation이며 날짜 강제 검증과 같지 않다. | [2020-12 validation §7.2.1](https://json-schema.org/draft/2020-12/json-schema-validation#section-7.2.1), [core §10](https://json-schema.org/draft/2020-12/json-schema-core#section-10) | 문서 주장 |
| <a id="E15"></a>E15 | 기계 판별 오류와 표시 문구를 분리하고 unknown 오류 확장은 허용할 수 있다. JSON-RPC notification은 오류 응답이 없고 batch 순서는 보장되지 않는다. | [RFC9457 §3](https://www.rfc-editor.org/rfc/rfc9457.html#section-3), [JSON-RPC §4.1·6](https://www.jsonrpc.org/specification) | 문서 주장 |
| <a id="E16"></a>E16 | Rakazo 이벤트의 invalid date·unrelated payload 수용/귀속 누락 거부, Zod strict vs additive 읽기, 결정론적 timer+fake runtime을 실행했다. Orca 원본 envelope도 5 assertion으로 strip·payload 미검증·잘못된 discriminator/meta 거부를 확인했다. | `probes/vitest-log.txt` (총 11 tests), `probes/orca-envelope-log.txt` (5 assertions); Zod4.6.7. 실제 승인/조직 API는 연결하지 않았다. | 실행 확인 |
| <a id="E17"></a>E17 | TS7.0.2와 typescript-eslint8.71.2의 TS peer >=4.8.4 <6.1.0은 충돌한다. Vitest5.0.4는 Node24와 Vite8을 허용한다. Node 타입 latest26과 제품용24를 구분했다. | [TS7 manifest](https://registry.npmjs.org/typescript/7.0.2), [typescript-eslint manifest](https://registry.npmjs.org/typescript-eslint/8.71.2), [Vitest manifest](https://registry.npmjs.org/vitest/5.0.4), [Node24 types](https://registry.npmjs.org/%40types%2Fnode/24.19.2) | 문서 주장 |
| <a id="E18"></a>E18 | A 조합은 strict-peer/ignore-scripts 설치 성공. 정상 tsc/lint/format 성공, 타입 오류·floating Promise·web→storage 하위 import를 각각 거부했다. | `probes/toolchain-a/commands.md`, `results.json`, `*-log.txt`: TS6.0.3·ESLint10.12.0·typescript-eslint8.71.2·Prettier3.9.10 | 실행 확인 |
| <a id="E19"></a>E19 | B 조합 TS7 tsc와 Biome lint의 정상/부정 대조군을 실행했다. 잘못된 타입과 금지 import를 거부한다. strict-peer B 설치는 혼합 탐색 설치의 peer 경고와 별도로 기록했다. | `probes/tools-log.txt`, `tools-results.json`, `toolchain-b-install.txt`: TS7.0.2·Biome2.5.15·Vitest5.0.4·Vite8.3.4·Zod4.6.7 | 실행 확인 |
| <a id="E20"></a>E20 | 작은 별도 pnpm workspace에서 contracts를 core·web·worker·server가 소비해 tsc -b 성공, Node compiled ESM import 성공. TaskId→OrganizationId 잘못된 대입은 TS2322로 거부했다. | `probes/workspace-build.txt`, `workspace-negative.txt`, `toolchain/workspace/`: TS7.0.2·NodeNext·exports dist·project references | 실행 확인 |
| <a id="E21"></a>E21 | React19.3.0/Vite8.3.4/plugin-react6.1.2 production smoke build 성공. Fastify5.12.7 inject·Hono4.13.13 app.request에서 정상 200/필수 id 누락 400 확인. 실제 HTTP listen·웹 사용자 흐름은 미실행. | `probes/tools-log.txt`, `vitest-log.txt`, `toolchain/probe.test.ts` | 실행 확인 |
| <a id="E22"></a>E22 | 네 고정 제품 LICENSE를 재확인했다. Rakazo/Paseo Apache-2.0, Paperclip/Orca MIT; Paseo 내장 제3자 예외. 실제 채택 도구의 직접 LICENSE도 캐시에 보존했으며 전이 의존성 전체 감사는 미수행. | [Rakazo](https://github.com/elie222/rakazo/blob/40ee8548763ca1050350210291048274610bef79/LICENSE#L1-L55); [Paseo](https://github.com/getpaseo/paseo/blob/9246813fd2acd6afc7012c5fde79a164b8f8592e/LICENSE#L1-L15); [Paperclip](https://github.com/paperclipai/paperclip/blob/1b4c803816e82b0265c8422e1a804327a7ed8c54/LICENSE#L1-L21); [Orca](https://github.com/stablyai/orca/blob/564693f1765e58bea9aee9cf642b96230411a8cd/LICENSE#L1-L21); `toolchain-a/licenses/` | 소스 확인 |
| <a id="E23"></a>E23 | Fastify baseline Ajv는 coerceTypes/useDefaults/removeAdditional을 활성화한다. strict command의 unknown 필드 거부를 이 기본값에 맡길 수 없다. | [Fastify 기본 검증 설정](https://github.com/fastify/fastify/blob/9f400035ebaf572b95989db5040ebb09c01e4e77/docs/Reference/Validation-and-Serialization.md#L499-L512) | 소스 확인 |
| <a id="E24"></a>E24 | number로 선언했지만 string을 대입한 TS를 Node native stripping과 tsx가 정상 종료로 실행했다. 변환·실행 성공은 타입 검사 성공과 별개다. | `probes/tools-log.txt`: Node24.21.0·tsx4.23.15의 `native-negative.ts`; tsc는 별도 TS2322 거부 | 실행 확인 |
| <a id="E25"></a>E25 | Node TS 실행은 typecheck/tsconfig alias/TSX를 대신하지 않는다. TS는 NodeNext와 bundler에서 import 해석이 달라 host별 설정이 필요하다. | [Node24 TS](https://nodejs.org/docs/latest-v24.x/api/typescript.html), [TypeScript modules reference](https://www.typescriptlang.org/docs/handbook/modules/reference.html) | 문서 주장 |

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 업무·실행·승인·관찰 상태를 분리 | E01·E04·E08 | Paperclip 영속 issue/run; Paseo UI bucket; Rakazo Run 재시도 | 실행 종료와 연구 완료 혼동 방지 | 상태 이름만 분리하고 actor/전이를 안 막으면 우회 |
| <a id="P02"></a>P02 | 순수 전이표 + 모든 명령의 제품 guard | E01·E05·E07·E11 | Rakazo 전이표, Paperclip 조건부 gate, Orca 공통 admission | 잘못된 전이를 외부 호출 전에 거부 | DB/직접 내부 쓰기 우회·검사 후 상태 변경 race |
| <a id="P03"></a>P03 | typed ID + 필수 조직 scope + 관계 소유 검사 | E03·E06·E12·E20 | UUID/brand는 식별; HTTP·SQL guard는 권한/귀속 | 교차 조직 ID와 잘못된 종류 대입 방지 | 타입·FK 존재를 권한 검사로 오인 |
| <a id="P04"></a>P04 | schema와 추론 type을 단일 원천에 둠 | E03·E09·E10·E14·E16 | Zod/Ajv/generated parser의 unknown 정책 차이 | web/server/worker 계약 차이 축소 | envelope 통과·type cast만으로 payload 유효성 오인 |
| <a id="P05"></a>P05 | 명령 strict, 읽기 확장 허용과 version gate 분리 | E09·E11·E13·E16 | Paseo >=1, Orca mutation exact version | 독립 배포·진화와 안전한 mutation 거부 | 미래 type 무조건 무시·인가 필드 coercion |
| <a id="P06"></a>P06 | 시각·순서·중복 식별을 별도 계약으로 정의 | E03·E09·E12·E13 | date coercion/단순 string/ISO 혼재 | 재현 가능한 fixture와 정렬 의미 | clock 역행·중복·ID 정렬로 인과 추정 |
| <a id="P07"></a>P07 | 안정 오류 code와 correlation, 부작용 없는 거부 | E10·E11·E15 | RPC code vs HTTP problem type | UI 복구 분기·감사·부정 검증 | 표시 message 파싱·알 수 없는 오류 정상 처리 |
| <a id="P08"></a>P08 | clock/runtime port와 순수/경계 테스트 | E02·E07·E11·E16·E21 | timer mock과 scripted fake는 다른 책임 | 유료 호출 없이 순서·거부·호출 0 검증 | global timer만 mock하면 실제 모델/다른 비동기 제어 누락 |
| <a id="P09"></a>P09 | 정확 peer 조합, 타입/테스트/빌드/린트 각각 실행 | E17–E21·E24–E25 | A type-aware ESLint; B TS7+Biome | 환경 재현·실제로 켜진 검사 확인 | latest 일괄 설치·no-tests 성공·transpile만 검사 |
| <a id="P10"></a>P10 | 설계 참고와 코드·자산·의존성 재사용 분리 | E22 | MIT/Apache/내장 자산 조건 차이 | 범위를 좁혀 독립 구현 | root license만으로 전체 배포 의무 확인했다고 주장 |

## 결정 권고

**아래는 연구자의 권고이며 사용자 확정·ADR·구현 완료가 아니다.** 기존 제품 불변 조건은 그대로 적용한다. 상태 이름·전이 목록과 정책 세부사항은 #1 및 후속 이슈에서 확정한다.

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | Task, Run, Approval, Organization 연구 진행 상태를 별도 타입으로 둔다. Run 종료→결과 제출→사용자 최종 완료를 자동 연결하지 않는다. UI 집계 상태는 순수 projection. | P01; #1 완료1; GLOSSARY | 기존 의미를 보존; 상태가 많아도 완료 권한을 명시 | Q1 |
| <a id="D02"></a>D02 | 변형 채택 | core의 명령에서 from/to·신뢰된 actor·조직 관계·승인 대상 revision을 검사하고 거부 시 runtime 호출/상태·이벤트 변경 0. 시작 순간 재확인은 #7/#9/#26 구현과 연결. | P02·P08; AGENTS.md | 전이표만으로 정책 미보장. 초기 승인과 신규 작업자 gate는 선택 flag로 풀지 않음 | Q1·Q2·Q4 |
| <a id="D03"></a>D03 | 변형 채택 | Organization/Agent/Task/Run/Approval/ResearchNode/Artifact별 branded ID와 runtime parser를 둔다. 각 조직 소유 객체에 organizationId 필수; Organization 자체는 id가 경계. command에는 인증된 actor 조직 맥락을 별도 전달하고 관련 ID의 동일 조직 소유를 core에서 조회·검사. | P03; #1 범위1 | 문자열 종류 실수+교차 조직 참조를 다른 검사로 막음. create 요청 body만 믿거나 기존 행 귀속을 암묵 유추하지 않음 | Q2 |
| <a id="D04"></a>D04 | 변형 채택 | contracts에 브라우저 안전 schema+inferred type. 명령/이벤트별 discriminated payload와 result/error를 검증한다. core의 제품 전이·권한은 contracts 밖. 최초 Zod4 후보를 우선 권고. | P04; E16·E20 | 지정 OSS와 직접 실행 근거가 강함. Valibot/Ajv로 바꿔도 경계 원칙 동일; 검증·타입 이중 수기 정의는 배제 | Q3·Q5 |
| <a id="D05"></a>D05 | 변형 채택 | 명령은 unknown key·잘못된 필수 값을 거부. response/event 독자는 known version/type의 additive optional 필드를 허용하되 원본을 보존하고 known payload를 검증. unsupported version/type은 명시 오류/관찰 상태로 처리. | P05; E23 | 명령 오타/미래 승인 필드 무시 방지와 읽기 진화의 균형. unknown 값을 정상 상태로 축약하지 않음 | Q3 |
| <a id="D06"></a>D06 | 변형 채택 | transport/envelope 버전과 event type별 payload 버전을 구분. 최초 지원 version은 명시하고 mutation은 미지원 version에서 부작용 전에 거부. producer/consumer 호환 fixture를 만든다. | P05; E11·E13 | >=1만 허용하는 검사보다 안전. CloudEvents 전체 도입은 요구하지 않음; 호환 기간 owner #1 | Q3·Q4 |
| <a id="D07"></a>D07 | 변형 채택 | wire 시각은 UTC·고정 millisecond RFC3339 부분집합을 후보로 권고하고 실제 parser로 검증. clock.now와 idFactory를 주입해 fixture를 고정. duration은 monotonic과 wall clock 의미 분리. eventId/requestId/organizationId와 발생 시각을 분리하고 seq 의미는 #3에 위임. | P06·P08 | 시간 역행/정렬/중복을 날짜·UUID 하나로 해결하지 않음. offset 입력 정규화 vs UTC만 허용은 열린 결정 | Q2·Q3·Q4 |
| <a id="D08"></a>D08 | 변형 채택 | stable domain error code·requestId·안전한 detail을 contracts에 정의하고 HTTP/RPC로 adapter에서 매핑. invalid_input/unsupported_version/invalid_transition/approval_required 등 후보를 actor·tenant 정보 노출 없이 구분. | P07; E06·E15 | UI가 message를 파싱하지 않음; core는 HTTP status를 몰라도 됨. 외부 타 조직/미존재의 같은 응답 정책은 #2 | Q3 |
| <a id="D09"></a>D09 | 채택 | testkit의 가짜 clock/id/runtime은 호출 기록과 scripted 성공·오류·지연·중단을 지원. 핵심 테스트는 승인/격리 거부 때 호출 0과 상태 불변을 검증. fake runtime은 승인을 대신 판단하지 않음. | P08; #1 검토2 | 결정론적 검증; 실제 adapter·lease·복구 동작은 후속 #7/#9/#10/#36 | Q4 |
| <a id="D10"></a>D10 | 변형 채택 | 공통 strict TS 기반, Node 앱/패키지는 NodeNext+명시 ESM exports+compiled JS, web은 bundler 설정 분리. pnpm workspace 의존으로 연결하고 tsc와 핵심 tests를 CI에 별도 실행. | P09; E20·E25; 구조 문서 | transpile 성공은 타입 보장 아님. dist 경로와 project references 순서를 검사. web→구현 import는 lint의 하위/상대 경로까지 검토 | Q5 |
| <a id="D11"></a>D11 | 변형 채택 | Vitest5.0.4/Vite8.3.4는 실행 가능한 후보. Node24.21.0/pnpm10.33.0에서 A(TS6+ESLint+Prettier)와 B(TS7+Biome+별도 tsc)를 비교. type-aware 규칙이 필요한 초기 규칙에는 A를 우선 권고하되 사용자 취향은 열린 결정. | P09; E17–E19 | A는 검사 생태계, B는 도구 수/TS7. 어느 경우도 peer 충돌을 무시해 제품 설치하지 않음 | Q5 |
| <a id="D12"></a>D12 | 보류 | 웹 React/Vite와 서버 Fastify/Hono는 smoke까지 확인한 후보. #1에서 도구 선택을 확정하되 최소 계약 소비 fixture로 먼저 검증하고 화면·API 기능은 #4/#2로 넘긴다. | E21·E23; 구조 문서 | 웹 프레임워크·server 구현을 contracts/core에 흘리지 않음. Zod strict 계약을 Fastify 기본 coercion과 분리 | Q5 |
| <a id="D13"></a>D13 | 배제 | Paperclip의 선택적 사용자 승인/anyone 완료, Paseo done bucket=연구 완료, untyped payload·weak timestamp를 공통 계약에 그대로 복제하지 않는다. | P01·P02·P04·P06 | 초기/팀/최종 사용자 승인, 연구 용어 불변 조건과 충돌 | Q1·Q3 |
| <a id="D14"></a>D14 | 보류 | DB·메모리 엔진·LLM provider·분산 workflow 엔진·채널·AOT schema 생성·대형 RPC catalog는 #1에서 채택하지 않는다. Run 재시도 새 ID/attempt 정책은 #9. | #1 결정3; P01·P08·P09 | 다른 이슈의 정책을 초기 기반 조사로 확정하지 않음 | Q1·Q4·Q5 |
| <a id="D15"></a>D15 | 보류 | 독립 구현을 권고하며 원본 코드/자산 복사를 제안하지 않는다. 제품 배포 라이선스는 사용자 결정으로 남기고 실제 lockfile/파일/NOTICE는 구현 조합 확정 때 확인. | P10; E22 | MIT/Apache 후보를 찾았다고 제품 라이선스가 자동 결정되지 않음 | Q6 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 승인·조직 정책을 prompt/route/선택 flag만으로 강제 | E05–E07 | 내부 호출과 신규 실행 경로도 core 규칙을 거쳐야 한다. |
| 모든 상태가 한 status 또는 UI done | E04·E08 | Task/Run·결과 제출/최종 완료 의미 손실. |
| generic Id/FK/schema 통과가 권한·관계 검증 | E03·E06·E10·E12 | runtime actor/대상 조직·payload 관계 검사가 별도 필요. |
| Date coercion/unknown 필드 제거를 모든 입력 기본값으로 사용 | E09·E23 | 안전 관련 명령 값이 조용히 바뀌거나 사라짐. |
| latest 일괄 선택·native TS 실행을 typecheck로 간주 | E17·E24 | peer 충돌과 잘못된 타입을 놓침. |
| 첫 기반에 upstream 전체 DB/실행·Electron·workflow 복사 | 네 Recon과 #1 고정 범위 | 책임/비용/라이선스/후속 결정을 과도하게 고정. |

## 구현 참고

- 권고 요약: 공유 schema/type, 독립 Task/Run/승인/연구 진행 상태, 필수 조직 scope와 actor 기반 core guard, 결정론적 fake, 실제 tsc/test/lint/format/CI를 각각 연결한다.
- 구현 위치: `packages/contracts/src/{http,events,runtime}`는 교환 데이터; `packages/core/src/{organizations,approvals,tasks}`는 순수 전이·권한/소유 규칙 및 작은 port; `packages/testkit/src/{fakes,fixtures}`는 가짜 clock/runtime/ID; `apps/server/src/composition`은 조립. runtime·storage는 기존 adapter 책임. 정적 import 경계는 프로젝트 검사 설정에 둔다. 이 문서는 파일/API 생성 지시나 확정 스키마가 아니다.
- 용어 빈틈: #1은 Run/Approval/ResearchNode/Artifact를 요구하지만 GLOSSARY는 이 네 개의 별도 정의가 없다. 특히 Run은 개별 실행 의미가 구조 문서에만 있다. 기존 의미를 확장하지 말고 사용자 확인 후 용어집에 정의할지 결정한다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 동일 Task의 Run 성공/실패 → Task·조직 조회 → 실행 종료만으로 연구 최종 완료하지 않음 | D01 |
| V02 | Lead 결과 제출 → user 미결정 → submitted/review 상태 유지; agent 최종 완료 명령 → 거부·상태 불변 | D01·D02 |
| V03 | 초기 계획/팀 승인 없음·한쪽만 승인·옛 revision 승인 → 실행 요청 → fake runtime 호출 0 | D02·D09; 후속 #26 |
| V04 | 조직 A actor와 조직 B Task/Agent/Run/Approval/ResearchNode/Artifact ID, 또는 scope 누락 → core 명령 → 거부·변경/호출 0 | D03; 전체 저장/API 격리 후속 #2 |
| V05 | 유효/무효 전이·terminal 이후 중복/늦은 종료 → 순수 규칙/명령 → 명시 결과, 기존 기록 보존 | D01·D02; retry/stale 상세 #9 |
| V06 | malformed payload·unknown command key/type·unsupported version → transport/core 경계 → 명시 오류·handler 호출 0 | D04–D06·D08 |
| V07 | 지원 version event에 optional field 추가·잘못된 known field·잘못된 type/payload 조합 → consumer → 허용/거부 규칙 분리 | D04–D06 |
| V08 | 잘못된 날짜·offset 없는 시각·고정 clock 및 time advance → parser/fixture → 유효성·정규화·timeout 재현 | D07·D09 |
| V09 | web/worker/server가 같은 contracts export 소비 → 실제 tsc/build → 성공; web→server/storage/runtime 및 core→SDK import → 검사 실패 | D10 |
| V10 | 의도 타입 오류/린트 위반/실패 테스트/테스트 없음 → CI 명령 → 필요한 job 실패; 정상 새 설치 → 동일 문서 명령 성공 | D10·D11 |
| V11 | 승인/결과/오류 이벤트 표시 → 대시보드 fixture → 관찰 가능한 활동만 표시; 비공개 모델 내부 추론을 로그로 요구하지 않음 | AGENTS.md; 후속 #3/#4 |

검증표는 **구현 시 필요한 시나리오**이며 이번 연구에서 제품 V01–V11을 통과했다는 뜻이 아니다. 실행한 probe는 위 E02/E16/E18–E21/E24로 제한한다.

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 최초 ID 형식 | 사용자 / #1 | UUIDv4(내장 생성·단순, 우선 권고) / UUIDv7(시간 정렬·추가 generator) / prefix+UUID(로그 구별·wire 복잡성). 모두 brand/runtime 소유 검사를 별도 유지(E12·E20). |
| Run 등 용어 정의와 상태 이름 | 사용자 / #1 | 기존 구조 문서 의미를 GLOSSARY에 명시 / 구현 이슈에서 정의를 먼저 확정. 현재 공식 정의 없는 네 개를 임의 추가하지 않음. Task/Run 분리와 사용자 최종 완료는 이미 고정. |
| 날짜 입력과 호환 정책 | 사용자 / #1, 이벤트 delivery #3 | UTC만 입력 허용 / offset허용 후 UTC 정규화. command strict+read additive(우선 권고) / 전체 closed+명시 migration. unsupported version과 payload 버전은 따로 정의(E11–E16). |
| 정적 검사 조합 | 사용자 / #1 | A TS6.0.3+ESLint10.12.0+typescript-eslint8.71.2+Prettier3.9.10(우선 권고) / B TS7.0.2+Biome2.5.15+별도 tsc. Node 타입24.19.2, Vitest5.0.4/Vite8.3.4 호환 후보(E17–E19). |
| 웹/서버 도구 | 사용자 / #1 | 웹 React19.3.0+Vite8.3.4(빌드 실행 근거) / 다른 UI로 contracts 소비. 서버 Fastify5.12.7(내장 inject/schema, coercion 조정 필요) / Hono4.13.13(in-process Fetch API, Node adapter는 별도 미실행). Express5는 후보 목록 수준(E21·E23). |
| 배포 라이선스 | 사용자 / #1 | MIT / Apache-2.0 / 공개 배포 전 결정 유예. 실제 복사 파일·lockfile·NOTICE 조건을 검토한 뒤 선택. 이 조사로 전체 의무를 판정하지 않음(E22). |
| 정책 상세와 운영 검증 | #2/#3/#7/#9/#26/#27/#36 | 조직 접근·이벤트 순서/재전송·runtime·retry/lease·계획팀 revision·완료/재개·실제 통합은 해당 이슈. #1은 계약·핵심 불변 검사 기반만 마련. |

## 한계와 미확인

- 제품 코드·테스트·설정, GLOSSARY/ADR/백로그 본문은 바꾸지 않았다. 신규 조사 문서만 Git 대상으로 남기고 커밋하지 않는다. 기존 사용자 변경도 그대로 보존했다.
- 실제 모델·유료 API·로그인 제품·실제 연구 데이터는 사용하지 않았다. 제품의 승인·조직 격리·실행 복구·DB atomicity는 아직 실행 가능한 구현이 없으므로 검증하지 않았다. Paperclip/Paseo 전체 설치·서비스·테스트, Orca dispatcher/network·version fence 테스트는 미실행이다.
- 단일 Linux·Node24.21.0·pnpm10.33.0 환경. GitHub CI·다른 OS/Node patch·브라우저 e2e·Hono Node adapter·실제 listen은 미실행. Vite build/in-process HTTP smoke를 배포 준비 완료로 해석하지 않는다.
- Rakazo 원본 5 tests와 추가 6 probes(총11), Orca envelope 별도5 assertions, A/B 정적 검사 정상/부정, 소형 workspace·웹 build를 실행했다. runtime fake는 scripted fixture이지 실제 외부 adapter가 아니다. 원본 파일의 checkout은 수정하지 않았고 ignored cache에 실행용 의존성 symlink를 만들었다.
- 처음 probe의 상대 경로 오류와 Orca Vite transform의 미설치 Electron tsconfig 오류를 보존했다. 앞 오류는 probe 경로 수정, 뒤는 원본 envelope를 Node native stripping으로 직접 실행해 확인했다. upstream 동작 실패의 근거로 쓰지 않았다. TS7 부정 typecheck exit1/TS6 exit2 차이를 wrapper에서 수정했고 TS2322를 직접 확인했다.
- 혼합 탐색 install은 TS7/typescript-eslint peer 경고를 관찰하려 strict-peer를 풀었다. 제품 설치 권고가 아니며 A/B 각각의 strict-peer 설치 성공 기록과 구분한다. 모든 외부 설치는 ignore-scripts, 실행은 HOME/PATH만 가진 셸을 사용했다.
- 고정 소스 checkout이 shallow여서 관련 guard·전이 정책 최초 도입 PR/blame의 이유는 미확인. upstream 변경은 이번 고정 SHA의 주장과 구분해야 한다. Paseo AOT generated artifact는 생성하지 않았으며 unknown key 보존은 공식 문서 주장 수준이다.
- 접근하지 못한 자료: Discovery의 Dagster 추정 run-retries 문서, 일부 Valibot/tsx 웹 URL. 각각 공식 issue/실제 공식 문서·고정 source로 보완했으며 제품 채택 근거로 승격하지 않았다. 상용 서비스의 비공개 구현은 조사하지 않았다.
- 라이선스는 고정 root·선택 도구의 직접 파일과 metadata까지 확인했다. Paperclip font NOTICE와 Orca third-party notice 존재는 확인했지만 자산은 재사용하지 않는다. 코드 복사 시 파일 header·NOTICE·lockfile 전체와 새 upstream 버전을 다시 확인해야 한다.
