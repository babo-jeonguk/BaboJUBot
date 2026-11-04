# #98–101 구현 근거와 검증 기록

기준: `5c32ba09e562d0a367ff5d3ecbe73f0e422c1ff5`, 작업 브랜치 `feat/providers-98-101`. 2026-11-03. 기존 [결합 조사](issue-98-101-references.md)를 재사용하고 아래 원문을 구현 중 직접 읽었다. upstream 코드는 복사하지 않았다.

| 원문·고정 판 | 직접 확인한 위치 | 적용·배제 |
| --- | --- | --- |
| [Claude CLI](https://code.claude.com/docs/en/cli-reference), 설치 2.1.316 | 격리 HOME의 `--version`, `--help`, 설치 binary의 slash-command 설정 경로 | duplex stream-json, append, strict MCP. OAuth를 막는 bare는 배제. `/compact`도 막는 disable-slash-commands는 일반 실행·정비 모두 배제 |
| [Paseo efc64a5](https://github.com/getpaseo/paseo/tree/efc64a5443dfe166dfb0d80434ecb48516b8fbe2/packages/server/src/server/agent/providers) | Claude active-turn enqueue, Codex/OpenCode turn steer | user 확정대로 전송/ACK를 accepted로 해석. 모델 소비 보장으로 표현하지 않음 |
| [Codex a098129](https://github.com/openai/codex/tree/a09812981de703f18f38015cd5d500ab373f616c/codex-rs), CLI 0.166.0 | app-server protocol thread/turn/model types, token usage, exec events; [공식 app-server 문서](https://learn.chatgpt.com/docs/app-server) | app-server 기본·exec 선택, developer instructions·제품 CODEX_HOME, env bearer, 턴 ID ACK, 누적 token 차이 |
| [OpenCode 2.2.5](https://github.com/anomalyco/opencode/tree/9bbb8ce18c80f099e0e448775f59d965ead40a21) | cli/server-process.ts, core/config/discovery.ts·plugin/agent.ts·plugin/instruction.ts, core/session/model-request.ts·inbox.ts, protocol/groups/session.ts·event.ts·model.ts, schema/config/mcp.ts | 1.x 자료로 구현하지 않음. stdio 수명 HTTP 서버, 제품 HOME/XDG, project·Claude discovery 차단, 기본 prompt 유지·세션 entry API. 고정판에 system config 차단 CLI 옵션이 없어 Linux `/etc/opencode`가 있으면 처음에는 거부했고, 2026-11-03 결정 뒤로는 경고만 한다 |
| [Paseo OpenCode v2](https://github.com/getpaseo/paseo/blob/efc64a5443dfe166dfb0d80434ecb48516b8fbe2/packages/server/src/server/agent/providers/opencode/v2/session.ts#L179-L188) | configureConnection의 session.instructions.entry.put | GPT-6.1 Sol의 추가 원문 조사 후 사용자 확정: agent 정의 대신 세션 API. [결정 근거](opencode-2-instructions.md) |
| [Antigravity headless](https://antigravity.google/docs/cli/headless/), [MCP](https://antigravity.google/docs/mcp), CLI 1.4.12 | stdin user/result, conversation flag, SIGINT/EOF, workspace serverUrl/header; Paseo plugin wire/process/session.ts | 단건 입력/결과, 첫 메시지 지침, steer=false, DONE step usage. 원본 wrapper의 개인 환경 상속은 배제 |
| 기존 auto-compact 프로젝트 a599a13 | server/cache.ts 및 기존 조사 scheduler 분석 | transcript 기반 TTL 판단만 참고. fixed idle delay, Run으로 정비 기록, 불명 dispatch 재시도는 배제 |

## 사용자 결정

- TDD seam: RuntimeAdapter 공통 계약, 서버 예약·MCP·설정 API, 압축 설정 화면.
- 실제 모델 호출·실제 녹화는 처음에 보류했다가 2026-11-03에 진행하기로 했다.
- 프로그램 판을 제한하지 않는다(2026-11-03, 이슈의 "고정 판"보다 우선). 자동 업데이트만으로 제품이 멈추면 안 된다. 판 검사와 `version_unsupported`를 없애고 모의 프로그램은 실재하지 않는 판을 출력한다. 압축도 판이 달라졌다고 막지 않으므로, 그사이 업데이트되면 캐시를 못 쓸 수 있다.
- OpenCode 기본 지침은 유지한다. `agent.system` 교체 대신 Paseo v2처럼 `session.instructions.entry.put`으로 추가한다.

- 특정 환경·타이트한 규칙에 묶지 않는다(2026-11-03). 일반 경로에서 동작하고 특수 상황은 덧붙인다. 지원 OS는 Linux·macOS·Windows다. Antigravity 작업 폴더에 사용자의 MCP 설정 파일이 있으면 실패시키는 결정(#101 확정 결정 3)은 유지한다.
- 하드링크 산출물 거부는 유지한다. 다른 조직의 파일을 이 조직 폴더의 파일처럼 보이게 할 수 있어 조직 경계와 직결된다.
- 실제 호출·녹화를 진행했다(2026-11-04, 아래 「실제 호출」).

## 개발 중 확인

- Claude·Codex 양 모드·OpenCode·Antigravity의 합성 CLI/HTTP/SSE peer로 공통 계약 실행: 종료·취소·공개 활동·세션 재개 효과·재개 실패·지원하는 끼워 넣기 효과·사용량·readiness.
- Claude 분할 NDJSON, interrupt, 세션 비용 차이, 제품 로그인 없음, transcript metadata, 동일 세션 압축 boundary+result.
- Codex model/list(모델 생성 없음), OpenCode 모델 목록과 무료 모델 선택·지침 전송 순서, Antigravity MCP 파일 0600·소유권 보존.
- 서버 설정 범위 검사·영속화, 압축 시점, 일시정지 중 정비, 목록 전용 토큰, Run/Event 비생성, 일반 실행 대기/예약 취소, TTL 만료·조직 중단.
- 화면은 숫자 중간 입력·blur 제한·동일 저장·390px E2E로 확인. 완료 검사와 화면 캡처 검토 결과는 PR에 최종 기록한다.

## 실제 호출

`scripts/provider-live.mjs`로 실제 서버의 조직 도구 위에서 시험했다(Linux/WSL). Claude 2.1.317 Haiku, Codex 0.166.0 `gpt-5.6-luna`(app-server·exec), OpenCode 2.2.5 무료 모델, Antigravity 1.4.12 `gemini-3.8-flash-low`. 조직 도구 호출·답장, 세션 재개, 끼워 넣기(지원 연결), 취소와 프로세스 정리, 없는 세션의 새 세션 전환, Claude의 실제 `/compact` 압축을 확인했다.

실제 호출로 드러나 고친 결함: 판 문자열 불일치로 OpenCode가 시작되지 않음, 모델 목록 3초 제한(실측 2.4~6초), Antigravity 로그인 파일 위치 가정, Codex exec의 세션 없음 판단(실제는 표준 오류로 알림)과 누적 사용량, Claude가 인증 실패를 `subtype: success`로 냄. Claude는 재개 때 새 추가 지침을 반영하지 않았으나, 제품은 지침이 바뀌면 세션을 잇지 않아 영향이 없다.

녹화 정제본 `*-recorded.json`은 허용 목록 밖의 글자를 모두 가린 실제 프로토콜 출력이다. 공통 검사는 이 출력을 내보내되 동작은 시뮬레이터가 연기하므로, 모델 대화 전체의 재현은 아니다.

## 미검증

macOS·Windows의 실제 프로그램 실행, 실제 캐시 절약 효과, 압축의 실제 소요 시간과 시간 초과 종료, 만료된 실제 로그인(잘못된 토큰·로그인 없음으로만 시험), 비용 누적 계산의 재개 전제는 확인하지 않았다. Claude의 transcript 시각은 관측된 assistant row timestamp이며 네트워크 요청 전송 시각을 별도 계측한 값이 아니다.

## 로컬 리뷰

기준 SHA는 위와 같고, 커밋 전 staged snapshot과 후속 working diff를 별도 Standards·Spec 에이전트가 검토했다.

- Standards 1차 S1(그룹 종료·재시작), S2(README 현황), S3(공통 장면 중복): 모두 수정. S1의 추가 오류 경로·지원 OS까지 3차 제한 재검토에서 수렴. Linux 고아 자식 회귀 검사 통과; 재시작 process recovery 자체의 별도 강제 종료 통합 검사는 미실행.
- Spec 1차 P1(SSE 10초), P2(압축 직렬 지연), P3(종료 저장 실패), P4(수동 시험 범위), P5(이전 MCP 목록): 모두 수정. 2차 P6(종료 중 새 claim)까지 수정해 3차 제한 재검토에서 수렴. P3·P6는 코드 검사 근거이며 별도 DB 장애·claim 순간 종료 주입 검사는 미실행.
- 회귀: 10초 넘는 SSE, 다른 조직의 동시 압축, 단계 변경 전 MCP 목록 보존, 유효·만료 TTL 재시작을 추가했다. 압축 API 10개와 관련 화면 E2E 6개 통과. 390px·1280px 캡처를 직접 확인했다.

완료 검사 최종 SHA·명령·CI 결과는 PR에 기록한다. 이 로컬 리뷰 시점에는 실제 호출을 보류했고, 그 결정은 2026-11-03에 바뀌었다(「사용자 결정」).

## 외부 리뷰

- 1회차 Spec P1(압축 중 같은 에이전트의 다른 작업 실행 시작): 수정. 압축과 실행 시도의 배타를 세션이 아닌 에이전트 단위로 통일했다. 같은 원인인 같은 에이전트의 동시 압축도 함께 막았다. 그 결과 멈춘 압축이 에이전트 전체를 막을 수 있어 압축 시간을 서버 시계 15분으로 제한했다. 15분은 실제 압축 소요를 측정한 값이 아니라 정상 압축을 끊지 않으려고 넉넉히 잡은 값이다.
- 2회차 Spec P2(시간 제한의 중단 신호 뒤 성공 보고가 저장됨): 의도된 동작. Claude는 프로세스 정상 종료와 압축 경계 확인 뒤에만 성공을 보고하므로 그 압축은 실제로 끝난 것이다. 세션 ID는 같고, 압축 중에는 다른 실행 시도가 세션을 바꿀 수 없다. 성공을 버리면 저장된 누적 비용이 낡아 압축 비용이 다음 실행 시도에 잡힌다. 완료·실패 구분은 읽는 곳이 없다. 1회차 재리뷰 자료의 "시간 초과 시 failed, 세션 그대로"는 실제로 중단된 경우에만 맞는 표현이었다. 공유 계약 설명과 두 경우의 회귀 테스트로 고정했다.
- 설계 권고 R1(Antigravity 설정 파일의 토큰이 산출물에 복사될 수 있음): 후속 처리. 토큰은 실행 시도가 끝나면 무효이고 같은 조직 에이전트는 그 파일을 이미 읽을 수 있어 새 접근 경로가 아니다. 실제 호출 전에 위협 모델과 함께 정하기로 했으나 정하지 않은 채 실제 호출을 진행했으므로, 이 위험은 아직 후속 검토 대상이다.
- 설계 권고 R2(작업 폴더 직렬화가 서버 한 프로세스 전제): 후속 처리. 현재 구조가 한 프로세스이므로 worker 분리 때 다룬다.

## PR #111 외부 리뷰

기준 `5f4298342cc97d25e8ff176c2d7233086e54a816`. 모두 이 PR이 바꾼 코드에서 생겼거나 사용자가 이 작업에서 요구한 기준에 걸려 이번에 고쳤다.

- Spec P1(조직 경계 우회): 수정. 조직 폴더의 실제 경로를 믿는 대신 조직들을 담은 폴더에서 있어야 할 경로를 계산해 비교한다. 파일을 연 뒤에는 열린 파일의 경로(Linux)와 경로 재해석·같은 파일 여부(모든 OS)를 확인한다. Linux 밖의 이중 바꿔치기는 2회차에서 막았다. 하드링크 거부와 같은 보호 목적이다.
- Spec P2(설정 파일이 한 번에 나타나지 않음): 수정. 직접 쓰기 대체 경로를 없앴다. 1회차의 빈 파일 자리 잡기 방식은 2회차 P5·P6으로 되돌렸다.
- Spec P3(정리 실패 후 복구 기록 삭제), P4(기록 삭제 실패로 서버 시작 실패): 수정. 끝났음을 확인했을 때만 기록을 지운다. 자리는 그대로 반납하고, 남은 기록은 다음 시작 때 다시 본다. /proc가 없는 시스템도 종료를 확인한다. 같은 경로에서 기록의 번호를 검사 없이 PowerShell 명령과 신호에 쓰던 문제도 고쳤다. 깨졌거나 이름과 맞지 않는 기록은 아무것도 건드리지 않고 지운다.
- Standards S1(이 문서의 결정·검증 상태 모순): 수정.
- 설계 권고 R1(Windows 실제 실행): 후속 처리. Windows 환경이 없어 미검증으로 남긴다.
- 설계 권고 R2(SSE의 CRLF): 채택. 표준이 허용하는 형식이고, 특정 형식에 묶지 않는다는 이번 작업 기준에 해당한다.
- 수정 뒤 실제 호출: 코드가 바뀐 Antigravity(1.4.12, `gemini-3.8-flash-low`)와 OpenCode(2.2.5, 무료 모델)의 전체 시나리오를 다시 돌려 통과했다. 조직 폴더 경계와 복구 기록 수명은 회귀 테스트로 확인했고, 실제로 죽지 않는 프로세스는 재현하지 않았다.

2회차, 기준 `08ed873e997060207157eb5d278d2eb6e8bdf945`.

- Spec P1(macOS·Windows의 이중 바꿔치기): 수정. Node에 폴더 핸들로 여는 기능이 없어 경로를 여러 번 확인하는 방식으로는 막을 수 없다. 별도 프로세스가 한 칸씩 들어가 작업 폴더로 고정한 뒤 그 안에서 연다. 세 OS가 한 경로를 쓰고 `/proc` 검사와 경로 재해석은 없앴다. 파일 산출물을 읽을 때마다 프로세스를 하나 띄우는 비용이 든다. macOS·Windows CI에서도 이 검사를 돌린다.
- Spec P5(표시 없는 빈 파일 삭제), P6(자리 잡기와 옮기기 사이 사용자 파일 덮어쓰기): 수정. 소유는 표시로만 판단한다. 한 번에 나타나면서 덮어쓰지 않는 수단은 링크뿐이라 링크 한 경로로 돌아갔다. 대가로 하드링크를 지원하지 않는 파일 시스템(exFAT 등)에 데이터 폴더를 두면 Antigravity는 이유와 함께 실패한다. 쓰다 멈춰 표시를 읽을 수 없는 임시 파일은 남는다. 그 안의 토큰은 실행 시도가 끝나면 무효다.
- Spec P3(Windows에서 시작 시각을 몰라도 기록 삭제): 수정. 프로세스가 있는지와 시작 시각을 따로 본다. 살아 있는데 시작 시각을 모르면 기록을 남긴다.
- Spec P7(번호 재사용을 5초 여유로 오인): 2초로 줄였으나 3회차에서 근본 수정했다(아래).
- 2회차 수정 뒤 Antigravity 전체 시나리오를 실제 호출로 다시 돌려 통과했다. 읽기 검사는 작업 단계마다 바꿔치기를 넣는 시험으로 확인했고, 확인 로직을 뺀 코드에서 이 시험이 실패함을 확인했다.

3회차, 기준 `40768666cb1b1f2032575ba01dd93c0ec553c391`.

- Spec P7(시각 여유 안의 번호 재사용): 수정. 파일 시각으로 추측하지 않고 프로세스의 시작 시각을 기록해 같은지 비교한다. 시작 시각을 기록하기 전에 서버가 죽으면 그 프로세스는 끝내지 못하고 기록과 경고가 남는다.
- Spec P9(macOS·Windows 기본 서버 기동): 수정. 설치 설정이 Linux x64의 내장 DB 준비 스크립트만 허용했다. 모든 시스템에 허용했고, macOS CI에서 기본 설정의 서버가 내장 DB와 migration을 거쳐 DB를 읽는 API까지 응답함을 확인한다. 내장 DB가 이유 없이 끝나던 오류는 Postgres의 말을 보이도록 고쳤다. 그 결과 Windows CI 실패는 CI 계정이 관리자라 Postgres가 거부한 것으로 드러났다. Windows CI는 러너에 설치된 Postgres로 서버와 migration을 확인하고, 일반 권한 Windows의 내장 DB는 미검증으로 남긴다.
- Standards S2(README·문서 지도의 낡은 설명): 수정.
- Spec P8(`.agents` 확인 뒤 경로로 다시 접근): 수정. 기준 코드에도 있는 문제지만 사용자가 이 PR에서 고치기로 했다. 별도 프로세스가 `.agents`로 들어가 확인한 폴더 안에서만 쓰고 지운다. 내용은 입력으로 넘겨 명령 인수에 남지 않는다. 모든 단계에 바꿔치기를 넣는 시험으로 확인했고, 확인 로직을 뺀 코드에서 이 시험이 실패함을 확인했다. 수정 뒤 Antigravity 전체 시나리오를 실제 호출로 다시 돌려 통과했다.
- Spec P1(조직 폴더 통째 교체): 수정, 사용자 결정 2026-11-04. 이 PR 이전 코드도 같았다. 근본 원인은 폴더가 자기 조직을 모르는 것이다. 조직 ID는 DB에 이미 있으므로 폴더에도 적어 대조한다(`workspace-identity.json`). 레퍼런스와 선택지는 [조사](workspace-identity-references.md). 처음 쓰는 폴더와 예전 조직은 첫 사용 때 현재 폴더를 믿고 한 번 적고, DB에 적었음을 남겨 그 뒤로는 자동으로 다시 적지 않는다. 폴더가 통째로 없으면 헷갈릴 일이 없어 새로 만든다. 같은 OS 계정의 에이전트가 표식을 고치는 것은 막지 못하며 #102의 몫이다. 표식 전 조직은 첫 사용 전에 바뀐 폴더를 구별할 수 없다. 표식은 구별 수단이지 내용 출처의 증명이 아니다. 에이전트 개인 폴더는 조직 폴더 아래에 있어 조직 간 교체는 이 표식으로 잡고, 같은 조직 안의 교체는 조직 경계가 아니어서 다루지 않았다.

4회차, 기준 `92cf645505ff0ca337b500a0e6b7357f40011b0c`.

- Spec P10(게시 뒤 실패로 알려 토큰 파일이 남음): 수정. 정리 책임이 "성공을 돌려받은 뒤"에 생긴 것이 원인이다. 쓰지 않았음이 확실한 거부만 빼고 게시 시도부터 정리 책임을 진다. 임시 파일 정리 실패는 게시 실패로 알리지 않는다. 거부 경로에서 임시 파일을 못 지우면 표시가 있는 채로 남아 다음 실행이나 서버 시작 때 지운다.
- Spec P11(표식을 읽거나 쓰지 못한 이유가 사라짐): 수정. 파일 시스템 오류도 오류 코드와 경로를 담은 안내로 실행 실패에 남긴다.
- Standards S3(코드 지도): 수정.
- 권고 R3(`ps`의 초 단위 시작 시각): 후속 처리. 같은 초 안의 번호 재사용은 재현하지 못했고, 해상도를 높일 일반 수단이 macOS에 없다.
- 권고 R4(일반 권한 Windows의 내장 DB): 후속 처리. CI 계정이 관리자라 확인하지 못했다.
- 4회차 수정 뒤 실제 호출: Antigravity 전체 시나리오, Claude Haiku·Codex `gpt-5.6-luna` 두 모드의 답장·재개·취소, OpenCode 무료 모델의 답장·재개를 최종 코드에서 통과했다.
