# #98–101 구현 근거와 검증 기록

기준: `5c32ba09e562d0a367ff5d3ecbe73f0e422c1ff5`, 작업 브랜치 `feat/providers-98-101`. 2026-11-03. 기존 [결합 조사](issue-98-101-references.md)를 재사용하고 아래 원문을 구현 중 직접 읽었다. upstream 코드는 복사하지 않았다.

| 원문·고정 판 | 직접 확인한 위치 | 적용·배제 |
| --- | --- | --- |
| [Claude CLI](https://code.claude.com/docs/en/cli-reference), 설치 2.1.316 | 격리 HOME의 `--version`, `--help`, 설치 binary의 slash-command 설정 경로 | duplex stream-json, append, strict MCP. OAuth를 막는 bare는 배제. `/compact`도 막는 disable-slash-commands는 일반 실행·정비 모두 배제 |
| [Paseo efc64a5](https://github.com/getpaseo/paseo/tree/efc64a5443dfe166dfb0d80434ecb48516b8fbe2/packages/server/src/server/agent/providers) | Claude active-turn enqueue, Codex/OpenCode turn steer | user 확정대로 전송/ACK를 accepted로 해석. 모델 소비 보장으로 표현하지 않음 |
| [Codex a098129](https://github.com/openai/codex/tree/a09812981de703f18f38015cd5d500ab373f616c/codex-rs), CLI 0.166.0 | app-server protocol thread/turn/model types, token usage, exec events; [공식 app-server 문서](https://learn.chatgpt.com/docs/app-server) | app-server 기본·exec 선택, developer instructions·제품 CODEX_HOME, env bearer, 턴 ID ACK, 누적 token 차이 |
| [OpenCode 2.2.5](https://github.com/anomalyco/opencode/tree/9bbb8ce18c80f099e0e448775f59d965ead40a21) | cli/server-process.ts, core/config/discovery.ts·plugin/agent.ts·plugin/instruction.ts, core/session/model-request.ts·inbox.ts, protocol/groups/session.ts·event.ts·model.ts, schema/config/mcp.ts | 1.x 자료로 구현하지 않음. stdio 수명 HTTP 서버, 제품 HOME/XDG, project·Claude discovery 차단, 기본 prompt 유지·세션 entry API. 고정판에 system config 차단 CLI 옵션이 없어 Linux `/etc/opencode` 존재 시 거부 |
| [Paseo OpenCode v2](https://github.com/getpaseo/paseo/blob/efc64a5443dfe166dfb0d80434ecb48516b8fbe2/packages/server/src/server/agent/providers/opencode/v2/session.ts#L179-L188) | configureConnection의 session.instructions.entry.put | GPT-6.1 Sol의 추가 원문 조사 후 사용자 확정: agent 정의 대신 세션 API. [결정 근거](opencode-2-instructions.md) |
| [Antigravity headless](https://antigravity.google/docs/cli/headless/), [MCP](https://antigravity.google/docs/mcp), CLI 1.4.12 | stdin user/result, conversation flag, SIGINT/EOF, workspace serverUrl/header; Paseo plugin wire/process/session.ts | 단건 입력/결과, 첫 메시지 지침, steer=false, DONE step usage. 원본 wrapper의 개인 환경 상속은 배제 |
| 기존 auto-compact 프로젝트 a599a13 | server/cache.ts 및 기존 조사 scheduler 분석 | transcript 기반 TTL 판단만 참고. fixed idle delay, Run으로 정비 기록, 불명 dispatch 재시도는 배제 |

## 사용자 결정

- TDD seam: RuntimeAdapter 공통 계약, 서버 예약·MCP·설정 API, 압축 설정 화면.
- 실제 모델 호출·실제 녹화는 보류. 합성 peer·재생·로컬 API로 구현을 검증한다.
- OpenCode 기본 지침은 유지한다. `agent.system` 교체 대신 Paseo v2처럼 `session.instructions.entry.put`으로 추가한다.

## 개발 중 확인

- Claude·Codex 양 모드·OpenCode·Antigravity의 합성 CLI/HTTP/SSE peer로 공통 계약 실행: 종료·취소·공개 활동·세션 재개 효과·재개 실패·지원하는 끼워 넣기 효과·사용량·readiness.
- Claude 분할 NDJSON, interrupt, 세션 비용 차이, 제품 로그인 없음, transcript metadata, 동일 세션 압축 boundary+result.
- Codex model/list(모델 생성 없음), OpenCode 모델 목록과 무료 모델 선택·지침 전송 순서, Antigravity MCP 파일 0600·소유권 보존.
- 서버 설정 범위 검사·영속화, 압축 시점, 일시정지 중 정비, 목록 전용 토큰, Run/Event 비생성, 일반 실행 대기/예약 취소, TTL 만료·조직 중단.
- 화면은 숫자 중간 입력·blur 제한·동일 저장·390px E2E로 확인. 완료 검사와 화면 캡처 검토 결과는 PR에 최종 기록한다.

## 미검증

실제 모델·제품 로그인 유효성·실제 정제 녹화·실제 MCP 모델 왕복·실제 캐시 적중과 절약·OpenCode 2.2.5 binary의 실제 실행은 확인하지 않았다. 합성 테스트 통과는 실제 provider 동작의 증명이 아니다. Claude의 transcript 시각은 관측된 assistant row timestamp이며 네트워크 요청 전송 시각을 별도 계측한 값이 아니다. 모델 요청 타이밍과 TTL 추론은 실제 시험에서 확인해야 한다.

## 로컬 리뷰

기준 SHA는 위와 같고, 커밋 전 staged snapshot과 후속 working diff를 별도 Standards·Spec 에이전트가 검토했다.

- Standards 1차 S1(그룹 종료·재시작), S2(README 현황), S3(공통 장면 중복): 모두 수정. S1의 추가 오류 경로·지원 OS까지 3차 제한 재검토에서 수렴. Linux 고아 자식 회귀 검사 통과; 재시작 process recovery 자체의 별도 강제 종료 통합 검사는 미실행.
- Spec 1차 P1(SSE 10초), P2(압축 직렬 지연), P3(종료 저장 실패), P4(수동 시험 범위), P5(이전 MCP 목록): 모두 수정. 2차 P6(종료 중 새 claim)까지 수정해 3차 제한 재검토에서 수렴. P3·P6는 코드 검사 근거이며 별도 DB 장애·claim 순간 종료 주입 검사는 미실행.
- 회귀: 10초 넘는 SSE, 다른 조직의 동시 압축, 단계 변경 전 MCP 목록 보존, 유효·만료 TTL 재시작을 추가했다. 압축 API 10개와 관련 화면 E2E 6개 통과. 390px·1280px 캡처를 직접 확인했다.

완료 검사 최종 SHA·명령·CI 결과는 PR에 기록한다. 실제 호출 보류 결정은 유지한다.

## 외부 리뷰

- 1회차 Spec P1(압축 중 같은 에이전트의 다른 작업 실행 시작): 수정. 압축과 실행 시도의 배타를 세션이 아닌 에이전트 단위로 통일했다. 같은 원인인 같은 에이전트의 동시 압축도 함께 막았다. 그 결과 멈춘 압축이 에이전트 전체를 막을 수 있어 압축 시간을 서버 시계 15분으로 제한했다. 15분은 실제 압축 소요를 측정한 값이 아니라 정상 압축을 끊지 않으려고 넉넉히 잡은 값이다.
- 2회차 Spec P2(시간 제한의 중단 신호 뒤 성공 보고가 저장됨): 의도된 동작. Claude는 프로세스 정상 종료와 압축 경계 확인 뒤에만 성공을 보고하므로 그 압축은 실제로 끝난 것이다. 세션 ID는 같고, 압축 중에는 다른 실행 시도가 세션을 바꿀 수 없다. 성공을 버리면 저장된 누적 비용이 낡아 압축 비용이 다음 실행 시도에 잡힌다. 완료·실패 구분은 읽는 곳이 없다. 1회차 재리뷰 자료의 "시간 초과 시 failed, 세션 그대로"는 실제로 중단된 경우에만 맞는 표현이었다. 공유 계약 설명과 두 경우의 회귀 테스트로 고정했다.
- 설계 권고 R1(Antigravity 설정 파일의 토큰이 산출물에 복사될 수 있음): 후속 처리. 토큰은 실행 시도가 끝나면 무효이고 같은 조직 에이전트는 그 파일을 이미 읽을 수 있어 새 접근 경로가 아니다. 실제 호출을 허용하기 전에 위협 모델과 함께 정한다.
- 설계 권고 R2(작업 폴더 직렬화가 서버 한 프로세스 전제): 후속 처리. 현재 구조가 한 프로세스이므로 worker 분리 때 다룬다.
