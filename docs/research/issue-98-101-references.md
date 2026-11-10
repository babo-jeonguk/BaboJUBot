# issue-98-101 레퍼런스 조사: 실제 프로바이더 연결과 Claude 미리 압축

조사일: 2026-11-02. 대상: [#98](https://github.com/babo-jeonguk/BaboJUBot/issues/98)·[#99](https://github.com/babo-jeonguk/BaboJUBot/issues/99)·[#100](https://github.com/babo-jeonguk/BaboJUBot/issues/100)·[#101](https://github.com/babo-jeonguk/BaboJUBot/issues/101). 구현 전 권고이며 확정 계약이나 구현 결과가 아니다. 이 문서는 네 이슈가 공유하는 프로세스·전송·세션 경계를 한곳에서 비교한다.

## Brief

- 구현할 문제: 실행 시도마다 제품 전용 프로바이더를 띄워 조직 MCP와 연결하고, 세션·사용량·취소를 공통 계약으로 변환한다. Claude의 유휴 세션 정비는 일반 실행 시도와 구별하면서 경쟁·재시작을 처리한다.
- 동종 문제: 외부 상태 보유 프로세스의 요청/종료 상관관계, 자격 증명·설정 탐색의 격리, 세션의 단일 작성자와 지연 정비, 녹화한 프로토콜로 adapter 효과 검증.
- 고정된 결정: 부모 #91의 실행 시도별 프로세스·제품 로그인·연결 방식·화면 조건을 유지한다. #96의 필수 능력 여섯 항목·항목별 미보고 사용량·세션 세대·무모델 진단, #97의 stateless MCP·실행 시도별 토큰·같은 호출 키를 따른다. 초기 연구 승인·최종 완료·조직 경계는 제품 코드가 강제한다. 임의 셸의 host 권한 격리는 후속 #102이며 이번 설정 분리와 구별한다.
- 실제 모델 호출·제품 로그인 생성·녹화용 실제 시험은 하지 않는다. 코드 이식·의존성 추가도 권고하지 않고 설계만 참고한다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | Claude 양방향 입력·종료·끼워 넣기 수신을 어떻게 확인하는가? | #98 AC1·6–8, #96 후속 댓글 | Source Recon + runtime/failure |
| Q2 | 개인 설정·지침·로그인을 배제하고 MCP 토큰과 안정된 지침을 주입하는 경계는? | #98 AC2–5, #100 AC2–4, #101 AC1–3 | Source Recon + adversarial scenario |
| Q3 | 녹화 재생으로 세션·끼워 넣기의 실제 효과와 프로세스 실패를 어떻게 검증하는가? | #98 AC9–10, #100 AC7, #101 AC4 | API 계약 + Behavioral Recon |
| Q4 | 압축 예약의 시계·세션 크기·TTL·설정은 무엇을 원본으로 삼는가? | #99 AC1–2·5–7 | Source Recon + persistence/recovery |
| Q5 | 일반 실행·정비·재시작·중단의 경쟁을 어떻게 조정하는가? | #99 AC3–5 | Source Recon + runtime/failure |
| Q6 | 도구 없는 압축과 동일 prefix·세션 ID 유지·성공 확인이 양립하는가? | #99 AC2·4, 기존 캐시 조사 | 공식 문서 + Source Recon |
| Q7 | Codex app-server와 exec의 공개 계약·resume·usage 차이는? | #100 AC1·5–7 | 프로토콜·계약·호환성 검증 |
| Q8 | Codex의 readiness·모델 목록·로그인·지침 append는 어떻게 구성하는가? | #100 AC2–3·6·8 | Source Recon + adversarial scenario |
| Q9 | OpenCode 서버·SSE·입력·종료·resume·usage의 상관관계는? | #101 AC1·3–4 | Source Recon + runtime/failure |
| Q10 | OpenCode 제품 XDG·agent 지침·MCP·무료 모델 선택을 어떻게 검증하는가? | #101 AC1 | Source Recon + adversarial scenario |
| Q11 | Antigravity 비대화 실행·설정 파일·세션·취소의 확인 범위는? | #101 AC2–5 | 공식 문서 + Behavioral Recon |
| Q12 | 압축 토큰·비율 숫자 입력의 범위 제한과 좁은 폭 조작은? | #99 화면 조건 | Surface Capture + Behavioral Recon |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [기능 비교](executor-capabilities.md) | 네 프로바이더의 비교 축·기존 후보 | 과거 관찰로만 사용. 새 근거와 미확인은 아래 표에서 구별 |
| [연결 조사](provider-connection-references.md) | Paseo 호출 경로·취소·usage 후보 | 연결 방식은 #91에서 이미 결정. 재선정하지 않음 |
| [격리 조사](executor-isolation-references.md) | 제품 HOME/XDG와 OS 격리 구별 | Docker 강제는 후속 #102. 설정 분리로 조직 보안을 보장하지 않음 |
| [캐시 조사](provider-prompt-caching.md) | TTL·prefix·사용자 압축 프로젝트 출발점 | 과거 절약 효과 추론을 실제 비용 검증으로 승격하지 않음. 최신 프로젝트 재조사 |
| [#86](issue-86-references.md)·[#96](issue-96-references.md)·[#97](issue-97-references.md) | 도구 설명·공통 계약·MCP 경계 | 과거 upstream E ID 재발급 없이 링크로 재사용. 현행 제품 계약은 직접 열람 |
| [판2 화면 지침](design-guidelines-pan2.md) | 숫자 칸·단위·저장 묶음 | 기존 사용자 결정 유지. 신규 실제 숫자 입력 관찰은 아래 별도 근거 |

## 레퍼런스

관점별 마지막 탐색은 Claude 전송/명령 재생, Codex 원본/운영 wrapper, OpenCode/Antigravity 설정 탐색·장애 보고, 정비/지연 작업 엔진, 숫자 입력 strict/blur를 대조했고 이미 찾은 신원·ACK·배타·prefix·검증 패턴으로 수렴했다. 이는 기록한 검색 범위의 saturation이며 생태계 전수조사가 아니다.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| Paseo | 운영 OSS | `efc64a5443dfe166dfb0d80434ecb48516b8fbe2` | Apache-2.0 | 소스·helper 실행 | 턴 입력/종료·프로세스 wrapper와 회귀 테스트 |
| Claude Agent SDK Python | 공식 SDK | `2146f9d8985513053e904b13200c8f744b36785a` | MIT | 소스 | CLI argv·prompt·close/read 구현 공개 |
| cli-replay | 인접 명령 재생 | `bb196bdc430f83e56a099ce71b6c79bed03ebbc2` | MIT | 소스 | command 재생과 duplex frame 재생 차이 |
| Auto Compact for Claude | 사용자 프로젝트 | `a599a13208f401ea38ede8104149cd1ac05daaec` | root LICENSE 없음 | 소스·helper 실행 | 직접 출처, durable dispatch/복구 반례 |
| Codex | 원본 OSS | `a09812981de703f18f38015cd5d500ab373f616c`; 실행 binary0.166.0 | Apache-2.0 | 소스·무모델 실행 | app-server/exec 원본 계약·설정·테스트 |
| OpenCode | 원본 OSS | `271f5ef9bcceba185eee4f7225a883f857b04715`; 구판 `ef2880f379129aa048be9e9353e30aa168d42c17`, 설치1.18.23 | MIT | 소스·version 실행 | 최신 구조와 과거 agent.prompt 의미 차이 |
| Antigravity CLI | 비공개 제품 | 설치1.4.12, 문서 확인2026-11-02 | 상용 | 문서·help/version | 실제 CLI 정체·workspace MCP·headless 계약 |
| Mantine NumberInput | 공개 DS 예제 | 페이지9.7.4, deploy SHA 미확인 | 코드 이식 없음 | 문서·실화면 | 범위 초과 거부·stepper 두 폭 관찰 |

구판 재확인: 압축 프로젝트 `server/cache.ts`는 기존4039afd와 같은 blob `639206d2ff60dbc64f553c48460af9203287c522`, scheduler/runtime은 변경되어 새로 읽었다. Paseo query.ts는 a4f6966→efc64a5 blob `0f9525d5b106a5d7d840113b5e7d67ed42e78af9` 동일, agent.ts는 새로 읽었다. Codex 기존360319d→a098129의 MCP types/exec events/global instructions blob은 같고 turn/config/exec는 변경되어 새로 읽었다. OpenCode는 최신 구조로 이동해 구판과 최신을 별도 근거로 취급했다. 기존 조사 문서의 권고를 최신 동작 증거로 승격하지 않았다.

## 근거: 공통 경계와 압축

소스 확인은 해당 코드가 그렇게 작성되었다는 뜻이다. 테스트를 읽은 것과 실행한 것을 구별한다. 아래 E와 뒤의 프로바이더별 E는 같은 문서의 식별자다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| E01 | steer는 비동기 결과를 허용하지만 수신 불명 실패가 있는 연결은 지원을 선언하지 않는다. 사용량의 0과 null은 구별한다 | [현행 계약](https://github.com/babo-jeonguk/BaboJUBot/blob/994634cd32ee7d46f0a546c26419764dc311f755/packages/contracts/src/run.ts#L280-L371), [능력](https://github.com/babo-jeonguk/BaboJUBot/blob/994634cd32ee7d46f0a546c26419764dc311f755/packages/contracts/src/provider.ts#L39-L77) | 소스 확인 |
| E02 | MCP가 header 또는 `_meta` 키를 공통 dispatch로 넘긴다. 키는 선택 사항이며 없으면 재호출 receipt 없이 진행한다 | [MCP](https://github.com/babo-jeonguk/BaboJUBot/blob/994634cd32ee7d46f0a546c26419764dc311f755/apps/server/src/mcp.ts#L103-L133), [optional key](https://github.com/babo-jeonguk/BaboJUBot/blob/994634cd32ee7d46f0a546c26419764dc311f755/apps/server/src/tools.ts#L182-L191), [dispatch](https://github.com/babo-jeonguk/BaboJUBot/blob/994634cd32ee7d46f0a546c26419764dc311f755/apps/server/src/tools.ts#L499-L532) | 소스 확인 |
| E03 | 압축 프로젝트는 session/model/sidechain·compact boundary를 걸러 TTL을 읽고 관측→정책→60분 fallback을 둔다 | [cache.ts transcriptTtl/createCacheReader](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/blob/a599a13208f401ea38ede8104149cd1ac05daaec/server/cache.ts#L20-L77) | 소스 확인 |
| E04 | 원본 예약은 endedAt+idleMinutes이며 재시작 시 이미 due인 예약은 만료시킨다. #99의 lastRequestAt+TTL×ratio·재예약 요구와 다르다 | [policy](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/blob/a599a13208f401ea38ede8104149cd1ac05daaec/server/policy.ts#L4-L26), [recover](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/blob/a599a13208f401ea38ede8104149cd1ac05daaec/server/scheduler.ts#L20-L69) | 소스 확인 |
| E05 | dispatch marker 이후 복구는 재전송 대신 관찰한다. 성공에는 경계·완료·동일 세션 확인이 필요하며 deadline 후 unknown을 남긴다 | [worker](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/blob/a599a13208f401ea38ede8104149cd1ac05daaec/server/operations.ts#L67-L166), [gateway](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/blob/a599a13208f401ea38ede8104149cd1ac05daaec/server/gateway.ts#L157-L239) | 소스 확인 |
| E06 | 원본 cache.ts import: TTL·혼합 쓰기·잘못된 세션/모델·sidechain·경계·음수·fallback·미래 시각 10 assertions PASS, 메인 재실행 동일 | 로컬 probe; Node24.21.0, env -i·설치 없음 | 실행 확인 |
| E07 | 캐시는 요청 앞부분 일치에 의존한다. MCP 변경 영향은 tool search의 지연 여부에 따라 다르며, 압축 자체도 모델 요청이다 | [Claude 공식 캐시 문서](https://code.claude.com/docs/en/prompt-caching#connecting-or-removing-an-mcp-server), [압축](https://code.claude.com/docs/en/prompt-caching#compacting-the-conversation), 2026-11-02 직접 열람 | 문서 주장 |
| E08 | 공개 숫자 입력에서 100의 ArrowUp은 100, 101 입력은 거부되어 100 유지, 90의 ArrowDown은 89. 1280×844·390×844 캡처를 메인이 확인 | [Mantine NumberInput](https://mantine.dev/core/number-input/), 로컬 캡처·실행 기록, Playwright1.58.2/Chromium1208; 페이지 v9.7.4 | 실행 확인 |

## 근거: Claude와 녹화 재생

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| E09 | Paseo는 예상 turn/query/input 신원을 재확인한 뒤 queue push와 accepted를 수행한다. 큐 종료 뒤 push는 조용히 버린다 | [steerActiveTurn/enqueueSteer](https://github.com/getpaseo/paseo/blob/efc64a5443dfe166dfb0d80434ecb48516b8fbe2/packages/server/src/server/agent/providers/claude/agent.ts#L2607-L2664), [createAsyncMessageInput](https://github.com/getpaseo/paseo/blob/efc64a5443dfe166dfb0d80434ecb48516b8fbe2/packages/server/src/server/agent/providers/claude/agent.ts#L6609-L6655) | 소스 확인 |
| E10 | 위 원본 큐 추출 실행에서 정상 FIFO·대기 소비·종료와 종료 후 입력 유실 음성 대조 5 assertions PASS. 메인 재실행 동일 | 로컬 probe; Node24.21.0·types만 strip·설치/모델 없음 | 실행 확인 |
| E11 | 공식 Python SDK의 기본 system_prompt=None은 빈 system prompt 교체다. preset append 분기가 별도로 있다. MCP dict는 argv JSON, path는 경로만 넘긴다 | [prompt](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_internal/transport/subprocess_cli.py#L574-L590), [MCP](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_internal/transport/subprocess_cli.py#L670-L701) | 소스 확인 |
| E12 | SDK close/write는 같은 lock과 readiness 검사를 사용하고 EOF flush 유예 뒤 TERM/KILL한다. Paseo 회귀 테스트는 queued/dequeued/completed 입력을 구별한다(읽기만) | [close/write](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_internal/transport/subprocess_cli.py#L1000-L1090), [테스트](https://github.com/getpaseo/paseo/blob/efc64a5443dfe166dfb0d80434ecb48516b8fbe2/packages/server/src/server/agent/providers/claude/agent.interrupt-restart-regression.test.ts#L361-L425) | 소스 확인 |
| E13 | cli-replay는 command/argv/stdin 전체와 고정 응답을 매칭한다. 이 API 자체는 양방향 턴·control 응답 재생의 보장이 아니다 | [Engine.MatchWithStdin](https://github.com/ormasoftchile/cli-replay/blob/bb196bdc430f83e56a099ce71b6c79bed03ebbc2/pkg/replay/engine.go#L15-L90) | 소스 확인 |

## 근거: Codex

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| E14 | native steer는 thread·expectedTurnId를 검사하고 실제 제출 여부를 결과로 바꾼다. Paseo는 ACK ID 확인 뒤 permission cleanup await도 수행하므로 ACK 후 오류 가능 작업을 그대로 복제하면 안 된다 | [turn_steer_inner](https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/app-server/src/request_processors/turn_processor.rs#L1077-L1220), [wrapper](https://github.com/getpaseo/paseo/blob/efc64a5443dfe166dfb0d80434ecb48516b8fbe2/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L4473-L4525) | 소스 확인 |
| E15 | usage는 total/last 및 input/cache-read/cache-write/output/reasoning을 구별한다. exec turn usage와 차이가 있고 cache-write에는 serde default가 있으므로 wire 누락을 0 관측으로 오인하면 안 된다 | [thread usage](https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L2045-L2093), [exec usage](https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/exec/src/exec_events.rs#L59-L75) | 소스 확인 |
| E16 | developer_instructions 추가·제품 codex_home의 전역 AGENTS 탐색·MCP bearer 환경변수 참조가 별도 경로다 | [append](https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/config/src/config_toml.rs#L251-L277), [global instructions](https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/codex-home/src/instructions/mod.rs#L41-L77), [MCP](https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/config/src/mcp_types.rs#L391-L411) | 소스 확인 |
| E17 | 설치본0.166.0의 빈 제품 HOME/CODEX_HOME에서 login missing·initialize 성공·없는 thread steer 거부·EOF 종료0 확인. 실제 모델 시작 요청 없음 | 로컬 probe; Python subprocess, RLIMIT_AS 2GiB/process group. 설치 binary와 소스 SHA 동일성은 미확인 | 실행 확인 |

## 근거: OpenCode와 Antigravity

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| E18 | OpenCode는 XDG roots와 별도로 HOME의 .claude/.agents·system·ancestor를 탐색한다. internal discovery options는 CLI flag라는 증명이 아니다 | [roots](https://github.com/anomalyco/opencode/blob/271f5ef9bcceba185eee4f7225a883f857b04715/packages/util/src/global-roots.ts#L4-L18), [discovery](https://github.com/anomalyco/opencode/blob/271f5ef9bcceba185eee4f7225a883f857b04715/packages/core/src/config/discovery.ts#L59-L165) | 소스 확인 |
| E19 | 구판 agent.prompt는 기본 prompt를 교체한다. 최신은 agent.system과 instructions 조립 구조가 달라 추가 의미를 별도 검증해야 한다 | [구판 prepare](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/session/llm/request.ts#L56-L66), [최신 agent](https://github.com/anomalyco/opencode/blob/271f5ef9bcceba185eee4f7225a883f857b04715/packages/core/src/config/plugin/agent.ts#L101-L115), [context](https://github.com/anomalyco/opencode/blob/271f5ef9bcceba185eee4f7225a883f857b04715/packages/core/src/session/context.ts#L132-L163) | 소스 확인 |
| E20 | OpenCode MCP는 고정 headers와 call별 sessionID metadata를 보낸다. 읽은 경로에서 외부 설정의 임의 호출별 재호출 키 주입을 확인하지 못했다 | [connect](https://github.com/anomalyco/opencode/blob/271f5ef9bcceba185eee4f7225a883f857b04715/packages/core/src/mcp/client.ts#L305-L315), [callTool](https://github.com/anomalyco/opencode/blob/271f5ef9bcceba185eee4f7225a883f857b04715/packages/core/src/mcp/client.ts#L466-L488) | 소스 확인 |
| E21 | Paseo agy driver는 대화 ID·stream-json·detached group을 쓰며 종료 이벤트를 기다리고 잔존 group도 정리한다. 타이머는 제품의 2+2초와 다르다 | [driver](https://github.com/getpaseo/paseo/blob/efc64a5443dfe166dfb0d80434ecb48516b8fbe2/plugins/antigravity-provider/server/internal/process.ts#L34-L58), [stop](https://github.com/getpaseo/paseo/blob/efc64a5443dfe166dfb0d80434ecb48516b8fbe2/plugins/antigravity-provider/server/internal/process.ts#L146-L168) | 소스 확인 |
| E22 | 원본 signalPlan 함수의 Unix 음수 group PID/Windows tree 3 assertions PASS. 빈 HOME에서 agy1.4.12 help/version·OpenCode1.18.23 version 확인 | 로컬 probe. 실제 signal·모델 호출 없음 | 실행 확인 |
| E23 | 공식 Antigravity MCP는 global/workspace 설정과 HTTP headers, headless는 단건 print·conversation·상태 판정을 설명한다 | [MCP](https://antigravity.google/docs/mcp), [headless](https://antigravity.google/docs/cli/headless/), 2026-11-02 | 문서 주장 |

근거 23행: 소스 확인16 · 실행 확인5 · 문서 주장2. 실행 5행은 helper 18 assertions(10+5+3), 무모델 Codex 연결, CLI help/version, 숫자 입력 상호작용을 묶은 것이며 5개 제품 시나리오 통과라는 뜻이 아니다.

## 패턴

다음 표와 권고는 근거·제품 계약을 종합한 **추론**이다.

| ID | 패턴 | 사례 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|
| P01 | 프로세스·세션·턴·입력의 신원과 종료를 별도로 추적 | E01·E09–E14 | 늦은 응답의 새 실행 오귀속 방지 | queue push·socket write만으로 소비 단정, ACK 유실 뒤 중복 |
| P02 | 제품 설정 root·append 지침·비밀 주입을 각각 명시 | E02·E11·E16·E18–E20 | 기본 지침 유지·개인 설정 유입 차단 | 설정 파일 분리만으로 OS 격리 주장, argv/로그 유출 |
| P03 | 누적값 baseline과 미보고를 명시 | E01·E15 | 세션 재개·부분 보고에서 이중 집계 감소 | cache 포함 관계·reset·wire default0 오인 |
| P04 | 세션별 정비 예약·작성권과 dispatch 결과 증거 | E03–E07 | 재시작·유령 worker·정비 중 wake 조정 | process-local 타이머 경쟁, 결과 불명 자동 재전송 |
| P05 | 명령 재생보다 세밀한 frame 순서·효과 관찰 | E10·E12–E14·E17 | 실제 모델 없이 adapter 경계 검증 | fixture가 입력을 무시하면 가짜 성공, 정제 중 필요한 필드 소실 |
| P06 | 범위 제한·숫자 초안·단위/stepper 분리 | E08 | 설명문 없이 잘못된 입력 차단 | 큰 하한 strict clamp가 타이핑 중간값을 막음, 서버 검증 누락 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| D01 | 변형 채택 | 실행 시도마다 transport/codec와 process owner를 만들고 native session/turn을 run 신원에 묶는다. 종료 이벤트를 확인한 뒤 결과 한 번과 정리 완료 | P01·#91 | stdout EOF·result frame·프로세스 종료는 다를 수 있다. 공개 활동은 허용 필드만 추출 | Q1·Q7·Q9·Q11 |
| D02 | 변형 채택 | steer 수락 전 현재 run/native turn/stream을 재검사하고 accepted 결정 후 실패 가능한 emit·권한 정리를 하지 않는다. 모호 전달이 해소되지 않으면 true를 선언하지 않는다 | P01·E01·E09·E14 | Promise 사용 자체는 허용. exec/Antigravity false; 양방향 경로도 수신 효과 검증 전 선언 확정 금지 | Q1·Q7·Q9 |
| D03 | 채택 | 제품 HOME/config/XDG만 주입하고 개인 credential env·지침/기억/외부 MCP 탐색을 제어. MCP token은 0600 임시 파일 또는 env 참조로 전달·finally 제거 | P02·#98–101 | env와 파일도 raw log/오류·argv 재직렬화가 없는지 확인. host 임의 셸 경계는 후속 #102 | Q2·Q8·Q10·Q11 |
| D04 | 변형 채택 | 기본 지침을 보존하는 append seam을 선택하고 Role/Soul/Skill 순서를 고정한다. SDK 기본값이나 model/base prompt 교체를 무검증 채택하지 않음 | E11·E16·E19·P02 | OpenCode agent prompt 방식은 아래 R4에서 해결. 지침을 조직·승인 강제 수단으로 쓰지 않음 | Q2·Q8·Q10 |
| D05 | 변형 채택 | 알려진 resume-not-found만 같은 run에서 한 번 fresh로 재시작하고 진행 활동을 남긴다. session/bundle/provider 세대는 #96 그대로 | P01·#96 | timeout·인증 실패·부분 도구 실행을 catch-all fresh로 재실행하면 중복 효과. 취소 뒤 재시작 금지 | Q1·Q7·Q9·Q11 |
| D06 | 변형 채택 | 실행 시도별 usage로 정규화하고 누적 세션 비용/토큰은 session baseline 차감·중복 snapshot 제거. 미보고는 null, Codex 비용은 AC대로 미보고 | P03 | 입력 안 cache 포함·reasoning 포함 여부를 모드별 고정. cache-read를 입력에 다시 더하는 이중계상 금지 | Q1·Q7·Q9·Q11 |
| D07 | 변형 채택 | #98 재생 장치는 stdin 요청 검증→stdout chunk/stderr/지연/종료·signal 단계로 양방향 프로토콜을 재생하고 ID placeholder를 바인딩한다. 합성 fixture와 사람의 정제 녹화를 구별 | P05 | cli-replay 전체 응답 매칭만으로 대체하면 steer/control·chunk 경계가 빠진다. resume/steer 최종 효과 관찰 지점 필수 | Q3 |
| D08 | 채택 | 취소는 native interrupt→2초 확인→process group TERM→2초→KILL, 종료 이벤트/child 종료 확인. 정상 종료의 세션 flush도 대조 | E12·#98 및 #91 | SDK의 5초 종료 정책을 제품 2+2초로 대체하지 않음. exec는 SIGINT→내부 interrupt 경로를 별도 확인 | Q1·Q7·Q9·Q11 |
| D09 | 변형 채택 | #99는 lastRequestAt+TTL×ratio를 저장한 예약으로 계산하고 context 크기와 run 누적 tokens를 구별. 근거 없으면 unknown으로 압축하지 않음 | E03–E06 | 원본 endedAt+idleMinutes는 그대로 사용하지 않는다. TTL 관측 출처·version/model/options/bundle fingerprint 보존 | Q4 |
| D10 | 변형 채택 | run admission과 세션 정비 claim을 DB의 같은 배타 경계로 조정. 실제 run 시작이 예약 취소, 압축 중 wake는 보존 후 대기. provider slot은 정비도 점유 | P04·#99 | pause 중 허용, stopped/completed 거부. Run/Event/activity를 만들지 않고 내부 정비 상태만 유지 | Q5 |
| D11 | 변형 채택 | 예약·dispatch marker·세대·완료 증거를 영속화하고 startup 재조정. 전송 후 불명은 자동 재송신 없이 native 세션 상태·종료로 해소 | E04–E05 | marker 직전/직후 crash와 이미 지난 TTL은 R2. 원본 단일 queue를 DB 다중 실행 보장으로 오인 금지 | Q5·Q6 |
| D12 | 보류 | 도구 없는 정비에서 동일 prefix 유지와 캐시 절약 효과는 R1 선택·녹화/사람 시험으로 확인 | E07·#99 | MCP 제거가 캐시를 언제나 보존/언제나 모두 파괴한다고 단정하지 않음. 실제 토큰·비용 미검증 | Q6 |
| D13 | 변형 채택 | 압축 설정은 토큰·% 숫자/stepper와 기존 저장 묶음. 초안과 유효 저장값을 구별하고 paste·빈 값·NaN도 서버에서 거부 | E08·#99 화면 조건 | 0–100 데모를 200,000 하한 정책으로 일반화하지 않음. 범위/step은 R3 | Q12 |
| D14 | 채택 | readiness/model catalog는 모델 생성 없이 판·제품 로그인 상태·목록 조회로 한정. 원격 유효성 미확인은 unknown, catalog 실패는 기존 고정 목록 fallback | #96·E17·P02 | 로컬 자격 증명 존재를 원격 유효성으로 단정하지 않는다. 실제 로그인·녹화·시험은 별도 사용자 준비 후 | Q1·Q8·Q10·Q11 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 큐 push·socket write만으로 소비/반영 보장 | E09–E10 | 종료 큐 입력 유실, transport ACK 불명 |
| SDK 기본 system prompt·inline MCP bearer | E11 | 기본 지침 교체·argv 비밀 노출 |
| 고정 같은 호출 키를 모든 MCP 호출 header로 사용 | E02 | 다른 입력 conflict, 재시도 동일 효과 식별 불가. 키 누락은 중복 보호 상실 |
| 압축을 일반 run으로 기록·일시정지라 정비 금지 | #99 AC4 | 확정 범위와 충돌. 과거 캐시 조사 공개 활동 권고는 이번 이슈에 적용 안 함 |
| 원본 fixed idle delay·재시작 due 일괄 만료 그대로 사용 | E04 | lastRequest/TTL 비율·재예약 요구와 불일치 |
| 범용 workflow·새 queue/기억 엔진 도입 | Discovery의 Temporal/pg-boss | 기존 DB 경계를 활용할 수 있으며 네 이슈 범위를 불필요하게 넓힘 |
| OpenCode/Antigravity에 TTL 기반 세션 폐기 추가 | 과거 캐시 조사 권고 | 부모 #91의 세션 특별 규칙 제외와 충돌 |

## 구현 참고

코드를 복사하지 않고 경계를 참고한다. 실제 모델·사용자 로그인·정제 녹화는 구현과 별도 단계다.

- `packages/runtime/`: 프로바이더별 transport·지침/설정 builder·usage 변환·취소를 묶고 `runtime-contract.ts`의 `resumes`/`steers` 효과 관찰과 연결한다. 외부 SDK·프로세스 코드는 core에 넣지 않는다.
- `apps/server/src/dispatcher.ts`·`run-request.ts`·등록부: run admission·환경/토큰·선택된 provider 경계를 연결. #99의 정비 예약과 slot은 서버/DB에 별도 책임으로 두고 일반 run 내역과 섞지 않는다.
- `packages/contracts`·`packages/db/src/sessions.ts`·`runs.ts`·`providers.ts`: #99에 필요한 시각/세대·정비 상태·설정과 원자적 claim. 기존 조직→에이전트 잠금 순서, 종료 조직 guard, provider 변경 무효화 보존.
- `apps/web/src/global-settings.tsx`: #99 숫자 설정만 기존 저장 묶음에 연결. 다른 세 이슈는 화면 변경 없음. README 로그인 명령은 제품 경로를 명시하고 비밀값을 포함하지 않는다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 정상/분할 JSON/잘린 EOF/unknown field/늦은 종료 → 재생 → 결과 정확히 한 번·안전 오류·종료 후 emit 없음 | D01·D07 |
| V02 | live/끝난 run·잘못된 turn·ACK 전후 transport 실패 → steer → 같은 run 효과 또는 확실한 거부, 새 run 오귀속/중복 queue 없음 | D02 |
| V03 | resume 성공/known missing/인증·timeout/취소 → 재생 → 세션 효과 확인·known만 fresh1회·취소 후 재실행 없음 | D05 |
| V04 | 취소 무시/느린 종료/하위 프로세스 → interrupt·2+2 escalation → 종료 확인·토큰 임시 파일 제거 | D03·D08 |
| V05 | 개인 HOME/XDG/cwd 상위 sentinel·개인 MCP·credential env → 무모델 탐색 → 제품 설정 외 유입 없음, argv/로그/오류 토큰 없음 | D03–D04 |
| V06 | 토큰 없는/종료 토큰·다른 조직 ID·승인 전 작업/최종 완료 → native MCP → 기존 조직/Role/단계 거부 동일 | D03·#97 |
| V07 | MCP 같은 agent/key/input 재전달·다른 입력·다음 run → receipt → 최초 효과 한 번·conflict; 키 없는 호출과 구별 | E02·D07 |
| V08 | 0/null/부분 cache·누적 반복·reset/새 session → 변환 → 필드별 미보고 보존·실행 시도 차이·비용 null | D06 |
| V09 | 가짜 시계 lastRequest+TTL×0.9 전후·context 미달/미확인 → 예약 → 정확한 시점·근거 없는 압축 없음 | D09 |
| V10 | 같은 session run-start/정비 동시 claim·압축 중 wake·다른 session → DB 조정 → 예약 취소 또는 wake 대기·상한 유지 | D10 |
| V11 | pause/stopped/completed·프로바이더/지침 변경 → 정비 → pause 허용·끝난 조직 제외·낡은 세대 저장 금지·Run/activity 없음 | D10–D11 |
| V12 | 예약/marker 전후 crash·재시작·boundary만/완료만·결과 불명 → 복구 → 중복 압축 없음·동일 세션 검증·R1/R2 정책 준수 | D11–D12 |
| V13 | 숫자 paste/빈 값/경계/직접 API·390px·키보드/stepper → 저장 → 유효 범위·단위·초안·기존 저장 묶음 | D13 |
| V14 | 프로그램 없음/로그인 없음/로컬 존재/진단 timeout·목록 실패 → 무모델 진단 → 안전 code·unknown·fallback, 생성 API 요청0 | D14 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| R1 도구 없는 압축과 앞부분 일치 | #99, 요구 해석 변경 시 사용자 | MCP 완전 제거(권한 명확, 캐시 영향 시험 필요) / 같은 schema를 유지하되 호출 권한 없음(문언 적합성 결정 필요). 실행 시도 bearer를 정비에 재사용하는 안은 배제 |
| R2 TTL 지난 재시작·불명 정비 복구 | #99 | 이미 cold면 skip / 한 번 cold 압축. 비용 목적상 skip 권고하나 재예약 의미 확정 필요. 결과 불명 lease는 프로세스 종료·세션 재검사 후 해제, 자동 재송신·무기한 block 배제 |
| R3 숫자 범위·빈 초안 저장 정책 | #99, 사용자 정책 영향 시 사용자 | ratio는 0<r<1, 양수 threshold와 상한/step 결정. 편집 중간값을 허용하고 유효 시 저장 / strict rejection+완전 값 paste. 좁은 범위 타이핑을 막지 않는지 검증 |
| R4 OpenCode 기본 지침 추가 방식 | #101 | 아래 소스 근거로 agent.prompt 교체 여부를 확인한 뒤 append 가능한 seam을 선택. 기본 prompt 수동 복제·의존 버전 방치는 피함 |
| R5 native steer의 모호 전달·효과 | #98·#100·#101 | native lifecycle/조회로 불명을 해소 / capability false로 보류. true AC와 충돌하면 이슈에서 해결하며 fixture 통과만으로 실모델 수신 보장이라고 보고하지 않음 |
| R6 MCP 호출별 재호출 키 | #98·#100·#101, 공통 변경은 #97 후속 | native 호출 metadata 지원 확인 / call identity를 보존하는 bridge. token은 고정 header 가능하나 같은 호출 키는 호출별이어야 함. 임의 매 retry 새 UUID도 중복 효과를 막지 못함 |
| R8 Antigravity workspace 설정 충돌 | #101, 동시 실행 의미 변경 시 사용자 | 고정 조직 cwd의 `.agents/mcp_config.json`은 두 run token을 덮을 수 있다(E23). 설정 주입~정리 전체 직렬화 / 검증된 실행별 설정·broker. 0600만으로 같은 uid 간 분리되지 않는다. 기존 파일 덮기·run별 cwd 우회 금지, crash 복구·symlink 거부·원복 정책 필요 |
| R7 실제 판·로그인·무료 모델·녹화 | 각 구현 이슈, 로그인·비용은 사용자 | 검증할 binary/SDK 판을 pin하고 제품 로그인 준비 뒤 사람의 최소 시험·정제 녹화. 무료 catalog는 구현 시 재확인하며 특정 무료 모델 상시 제공 단정 금지 |

## 한계와 미확인

- 제품 코드·테스트·설정 변경, 제품 공통 검사·전체 upstream suite·실제 모델 호출·제품 로그인 생성·비용/캐시 적중 검증·실제 녹화 생성을 하지 않았다. 실행 근거는 특정 helper/무모델 프로토콜/공개 숫자 예제이며 제품 동작 보장이 아니다.
- 공개 CLI 문서·SDK·wrapper 소스와 설치 binary는 서로 같은 구현/판이라는 증명이 없다. 비공개 CLI 동작은 고정판 정제 녹화와 사람 시험으로 재확인한다. 무료 모델·계정 권한·사용 한도도 미확인이다.
- 설정 탐색·개인 credential 차단은 실제 sentinel 적대 시나리오로 검증해야 한다. 조직별 작업 폴더·제품 홈은 OS 권한 강제가 아니며 host 셸로 사용자 API·DB 접근을 차단하는 작업은 후속 #102다.
- #99 실제 `/compact` 성공·같은 ID·캐시 prefix 유지와 비용 절약은 미확인이다. helper 실행을 정비 claim·재시작 복구 실행 증거로 쓰지 않는다. 과거 캐시 조사와 현행 #99의 활동/세션 정책 차이는 현행 이슈를 따른다.
- UI는 공개 0–100 예제 두 폭의 입력과 키보드 동작만 확인했다. 제품 설정 화면의 저장·빈/실패 상태·한글 단위·스크린리더·터치·큰 토큰 하한은 미확인이다. 타사 캡처는 캐시에만 두었다.
- history는 압축 프로젝트 PR2·Codex provider mismatch 변경·Paseo 최근 log/SDK 주석까지다. 모든 파일의 blame·관련 PR 이유를 완전히 추적하지 않았다.
- 라이선스는 설계 참고 범위로 확인했다. 사용자 압축 프로젝트는 root LICENSE가 없고 부분 third-party 고지만 있어 코드 복사를 권고하지 않는다. 향후 이식은 각 SHA LICENSE/header/NOTICE/전이 의존성과 AGENTS의 출처·THIRD_PARTY_NOTICES 규칙을 다시 확인한다.
