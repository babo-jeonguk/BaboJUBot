# issue-145 레퍼런스 조사: Codex 연결의 요청 대기·종료 정리 집중

#145의 세 소비자가 공유할 Codex 연결 처리와 요청 수명을 조사한다. 현행 계약은 [#145](https://github.com/babo-jeonguk/BaboJUBot/issues/145), 구조는 [architecture](../architecture.md), 용어는 [GLOSSARY](../../GLOSSARY.md)가 기준이다. 로그인·조직 폴더 준비 공통화는 [#146](https://github.com/babo-jeonguk/BaboJUBot/issues/146)의 책임이다.

재확인일: 2026-11-12. 아래 「현재 재확인」이 현재 권고이며, 뒤의 2026-11-10 기록은 과거 근거를 보존한다. 구현 전 조사로 제품 구현·설정 변경·커밋·개인 자격 증명 접근·실제 모델 호출은 없다.

## 현재 재확인 — Brief

- 기준: fetch한 최신 origin/main과 로컬 HEAD 모두 `983dbc5a4e9342c460f081a4888250e6634522c6`. 현재 이슈 본문·기존 receipt를 읽었다. parent 없음(404), blocker 빈 목록. #146은 선행 blocker가 아니다.
- 문제·동종 메커니즘: 모델 목록·연구 실행·서버 로그인 갱신의 중복 연결 처리를 하나의 interface로 모아, 연결별 pending 요청을 모든 종료 경로에서 정확히 한 번 완료한다.
- 확정 철학 유지: 연결은 handshake·ID·응답 분배·pending·timer·닫힘만 소유한다. 결과 불명 요청은 자동 재전송하지 않는다. 목적별 해석·인증·프로세스/중계·grant·폴더 수명은 기존 담당에 남긴다. 로그인 갱신은 **연결 처리만** 공통화한다.
- 일반 RPC 120초, steer 10초, 목록 전체 60초, 갱신 전체 60초. 갱신은 제품 연결별 진행 중 하나에 합류한다. 명시적 resume ProtocolRejection에만 새 thread 한 번, baseline 초기화·안내 한 번이다. timeout·닫힘·취소·갱신 실패는 resume 거절이 아니다.

| 질문 | 현재 출처·전략 | 기존 근거 재사용 판단·보강 |
|---|---|---|
| Q1 세 소비자의 interface·handshake·pagination | #145 Implementation Decisions 연결 범위·목록·갱신; 프로토콜 + Source Recon | E01–03 재사용. 갱신이 빠져 있어 E16/E20 보강. 목록은 완성 결과만 반환, 갱신은 모델 턴 없음 |
| Q2 등록·완료·닫힘·취소 경합 | #145 정확히 한 번 완료·닫힘 선확정; Source Recon + failure 경로 대조 | E04–06/E08–10 재사용. 새 경쟁 실행은 불필요한 중복이므로 하지 않음. 현재 process의 종료 통지 제약 E18 보강 |
| Q3 목적별 deadline·단일 갱신·resume 거절 | #145 시간·갱신·세션 정책; 계약 + Source Recon | E01/E02의 wire 오류와 관측 실패 구분 재사용. 시간값의 근거는 OSS 기본값이 아닌 확정 계약. E16/E17로 현재 소유 확인 |
| Q4 프레임 분배 교착 | #145 queue 밖 RPC 대기; Source Recon + 과거 합성 결과 한계 대조 | E07 재독, E12/E13은 11-10 과거 실행으로만 재사용. 현재 직렬 queue와 done 의존은 E18에서 다시 확인 |
| Q5 연결 격리·실제 정리·사용량·#146 경계 | #145 사용량·grant/중계·준비 범위; Source Recon + adversarial 시나리오 | E08/E10 원칙 재사용, E14는 현행 정리 추가로 보강(E18). E17/E19로 사용량·인증 회귀 검사 읽음. 실행 결과 승격 없음 |

| 기존 조사 | 현재 재사용 범위 | 판단 |
|---|---|---|
| 이 문서 11-10 E01–10·D01–07 | 요청 수명·wire/오류 구별·교착/정리 패턴 | 관련 소스 원문 재독·파일별 blob 대조. D01–07은 아래 D08–13의 보강과 함께 읽음 |
| 이 문서 E11–13 | CLI0.167.0·memory peer·이전 startProcess 실행 | 과거 실행임을 유지. 현재 main·새 연결·갱신 실행의 증거로 쓰지 않음 |
| [#98–101 Codex 근거](issue-98-101-references.md#근거-codex)·[구현 기록](issue-98-101-implementation.md) | 기존 프로토콜·검사 배경 | 새로 확대할 근거 없음. 과거 실모델 결과 재사용 안 함 |
| [#148 2단계 기록](issue-148-references.md#구현-기록--2단계-2026-11-12)·[#149 구현 기록](issue-149-implementation.md) | 원본 비전달·실행별 grant·중계/placement 소유 | 최신 main 호출·finally를 직접 확인(E16–19). 과거 실제 CLI·Docker 결과 재사용 안 함 |
| [#146 현재 재조사](issue-146-references.md#brief--2026-11-12) | 준비 결과와 caller 수명·spawn 직전 취소 확인 책임 | 현재 #146 본문과 대조. 그 문서의 합성 파일 실행은 이번 실행으로 세지 않음 |
| provider-connection·executor-capabilities·agent-runtime-models / #125·#140–143 | 배경 또는 별도 경계 | 추가 심층 재조사 안 함. 프로바이더 전체 lifecycle/세션 정책 일반화 근거로 쓰지 않음 |

## 현재 재확인 — Discovery와 원문 비교

기존 후보 8종을 유지하고 새 제품군 탐색은 하지 않았다. 관점은 ① Codex 프로토콜·운영 wrapper ② 요청 대기 부품·표준·실패 모드 두 개다. 첫 관점의 보강 라운드는 공식 account/read 계약과 현재 갱신 caller를 대조했고, 마지막 비교에서 새 연결/세션 복구 패턴은 필요하지 않았다. 둘째 관점은 기존 고정 파일의 최신 blob 및 완료·dispose·분배 원문을 재독했고 새 실패 모드는 추가되지 않았다. 기록한 질문 범위에서의 saturation이며 전수조사가 아니다. 부족한 근거는 현재 소스와 공식 계약으로 채웠으므로 신규 OSS 설치·probe는 하지 않았다.

| 대상·실행 경로 | 이전 → 이번 고정 SHA | 파일별 비교·심층 판단 |
|---|---|---|
| Codex; 무모델 CLI self-host 가능, 이번 미실행 | `c82708f85803d21fe9046af407107a1ee105b6e5` → `ce3031018ef130e653ed4d9c5bb971652de97161` | rpc.rs·initialize_processor.rs·catalog_processor.rs·outgoing_message.rs 4개 동일. message_processor.rs 변경은 ThreadPrepareApprovedPlan 분기 추가, 초기화 guard 유지. README 변경은 원문 재확인하되 갱신 계약은 공식 문서로 보강 |
| VSCode JSON-RPC; memory peer 가능, 이번 미실행 | `898f44d0fd2a0e9c182414060fb7084ed39f49bc` → 동일 | connection.ts blob 동일. E05–07의 선등록·close/dispose·즉시 응답 분배 재독 |
| MCP SDK; 로컬 transport 가능, 이번 미실행 | `1e608caeb5130b2ad0fa067c84b26a038c1c6e36` → `919bb8ea88b6e10e72c2f8b6218fad4cfdc40b2c` | protocol.ts blob 동일. E08 _onclose 재독. #1459는 과거 장애 보고로만 유지 |
| Paseo; CLI wrapper self-host 가능, 이번 미실행 | `c91948048b308adaa91416cd31f87a0015dac72a` → `065c487a908171d83ce6ff48c623aea2107b9cad` | app-server-transport.ts blob 동일. E09 request/dispose/종료 reject 재독 |
| JSON-RPC / Sourcegraph / Go | 기존 명세·목록 수준 유지 | 실행 경로·라이선스·심층 제외 이유는 11-10 표와 동일. 신규 근거로 승격하지 않음 |

OSS 라이선스와 이식 제한은 아래 기존 표를 유지한다. 설계 참고만 하며 코드 복사·새 의존성 권고 없음. 현행 제품 process.ts는 `c88a98b` 대비 중계 생성/close와 네트워크 배치가 바뀌어 E14만으로 현행 정리를 설명하지 않는다.

## 현재 재확인 — 보강 근거

| ID | 원문 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E15"></a>E15 | 최신 Codex의 초기화 가드·wire·페이지·callback 완료 구조 유지. 변경된 dispatch는 승인 계획 분기 추가이며 이 관찰을 바꾸지 않음 | [dispatch guard](https://github.com/openai/codex/blob/ce3031018ef130e653ed4d9c5bb971652de97161/codex-rs/app-server/src/message_processor.rs#L1037-L1052), E02–04 파일별 blob 비교 | 소스 확인 |
| <a id="E16"></a>E16 | refreshLogin은 제품 연결 closure의 refreshing Promise에 합류하고 finally에서 해제. 갱신용 별도 child가 initialize→initialized→account/read를 수행. timer는 child 시작 뒤 한 번 설정. currentLogin이 필요 판단·원본 재독·갱신 후 유효성 검증을 소유 | [refreshLogin/currentLogin](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/runtime/src/providers/codex.ts#L290-L349) | 소스 확인 |
| <a id="E17"></a>E17 | 실행 adapter가 누계 readTotals/savedTotals/codexUsage와 resume fallback·활동·steer 결과를 소유. 보고된 누계는 취소·완료 없는 종료에도 반환에 사용. contracts가 이상값과 미보고를 구분하며 음수 차감/이상 baseline을 0으로 보정하지 않음 | [usage](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/runtime/src/providers/codex.ts#L210-L273), [execute](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/runtime/src/providers/codex.ts#L679-L882), [숫자 계약](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/contracts/src/usage.ts#L60-L125) | 소스 확인 |
| <a id="E18"></a>E18 | startProcess는 onFrame 직렬 queue. end는 stdin 종료/신호 예약, closed는 child close 때 확정. done은 중계 close→자식 정리→컨테이너 제거→queue를 기다림. Codex adapter finally는 grant revoke·attempt 폴더 제거. 예고 없는 close를 즉시 외부 통지하는 별도 hook은 읽은 반환 interface에 없음 | [queue/end/done](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/runtime/src/providers/process.ts#L218-L362), [반환·finally](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/runtime/src/providers/codex.ts#L860-L882) | 소스 확인 |
| <a id="E19"></a>E19 | 합성 갱신 fixture와 container 검사에 정상·동시 두 실행의 갱신1회·실패 후 중계 차단·미갱신 사례가 있음. Codex usage 검사에 이상 baseline·감소 누계·취소/완료 없는 종료가 있음. credential relay revoke는 등록 제거·listener 해제·inflight destroy | [갱신 검사](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/runtime/src/providers/container.test.ts#L1157-L1255), [사용량 검사](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/runtime/src/providers/codex.test.ts#L199-L420), [revoke](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/runtime/src/providers/credential-relay.ts#L251-L259) | 소스 확인; 검사 미실행 |
| <a id="E20"></a>E20 | 공식 app-server 문서는 연결당 handshake와 account/read의 refreshToken을 설명. managed ChatGPT에서는 강제 갱신, external token mode에서는 flag 무시. API 호출과 모델 turn은 별도 계약 | [공식 초기화](https://learn.chatgpt.com/docs/app-server#initialization), [공식 계정 상태](https://learn.chatgpt.com/docs/app-server#1-check-auth-state) | 문서 주장 |

E16의 기존 전체 60초는 child가 시작된 뒤의 연결 작업 한도다. mkdir/shareLogin에 새 한도를 정하거나, 실제 정리 대기를 포함해 adapter가 반드시 60초 안에 반환한다고 해석하지 않는다. 목록 readiness도 기존 사전 단계이며 RPC 추출로 정책을 넓히지 않는다.

## 현재 재확인 — 패턴·결정 권고

기존 P01–05 유지. 추가 패턴은 **같은 연결 수명 interface + caller의 목적별 시한/결과/자원 소유**(E16–20)다. 한 제품 연결(provider 설정)의 공유 갱신 Promise와 한 app-server 프로세스의 pending 맵은 서로 다른 수명이다.

| ID | 판단·현재 권고 | 근거·이유 | 질문 |
|---|---|---|---|
| D08 | 변형 채택: 세 소비자가 같은 내부 연결 interface의 handshake/request/notify/close를 사용한다. 연결 인스턴스·pending·프로세스는 소비 작업별이며 전역 맵으로 공유하지 않는다. 갱신 필요 판단·원본 접근·단일 실행·후검증·중계 실패는 기존 갱신 caller에 둔다 | D01/P01·E16/E20. 연결만 추출하며 인증 정책 변경 없음 | Q1/Q3/Q5 |
| D09 | 채택: request는 caller의 남은 시한을 받아 timer를 소유하고 typed timeout/ProtocolRejection/closed/cancel/write 실패를 전달한다. 일반120초 실패 시 adapter가 close, steer10초 불명 오류는 본 실행 유지. 목록·갱신은 각각 최초 연결 작업의 절대 deadline 60초를 이어 써 단계마다 재시작하지 않는다 | D03/D04·E16/E17. 남은 시간≤0 또는 이미 취소/닫힘이면 write 안 함. 공통 기본120초가 갱신/목록 시한을 늘리지 않음 | Q1/Q2/Q3 |
| D10 | 채택: pending 선등록→write, 공통 settle에서 등록 제거·timer/listener 해제 후 완료. write false/throw·응답·timeout·취소·close 모두 같은 일회 완료 경로. close 선확정 후 새 요청 거부·pending 즉시 오류. 늦은/중복/unknown 응답 무시, ID만 있는 서버 request를 response로 오인하지 않음 | D01/D02/D06·E02/E05/E08. 등록 중 이미 abort된 signal과 settle 뒤 write 예외의 경합도 방어 | Q2/Q5 |
| D11 | 채택: onFrame은 분배만 하고 즉시 반환. handshake/pagination/account/read의 다음 RPC는 queue 밖 async 흐름에서 await. queue 안 close handler가 cleanup done을 await하지 않음. done이 queue를 기다리므로 그 역시 자기 대기 교착 | D05·E07/E18, 과거 E13. 알림 callback도 같은 제약 | Q1/Q4 |
| D12 | 변형 채택: 논리 close가 먼저 대기를 끝내고 별도 cleanup 완료를 await한다. 예고 없는 종료의 즉시 통지는 기존 process 경계에 필요한 좁은 내부 hook으로 연결하는 것이 권고이며, process 정리의 재구현은 하지 않는다. adapter 반환은 startProcess.done·활동 drain·finally의 grant/폴더 정리 뒤 | D02·E18/E19. 현행 done만 pending 해제에 쓰면 물리 정리가 끝날 때까지 대기가 남음. 이 hook의 정확한 형태는 구현자가 선택 | Q2/Q4/Q5 |
| D13 | 채택: thread/turn·사용량·resume 전환·interrupt/active steer는 adapter에 남긴다. 명시적 resume 거절 때만 새 thread1회·baseline 초기화·안내1회. 실행 취소는 그 실행 grant/연결을 닫으며 공유 갱신 자체의 취소로 전파하지 않는다. #146의 준비·spawn 직전 취소 검사와 수명만 접속 | D03/D06·E16–19·#145/#146. 새 공통 준비 실행기·세션 복구 실행기 금지 | Q3/Q5 |

배제 유지: 자동 재전송/무응답을 거절로 간주, 종료0을 요청 성공으로 간주, VSCode close/cancel 대기 유지, Paseo write 후 등록/14일 기본값, 전 프로바이더 일반화. 신규 배제: RPC가 usage를 합산·보정하거나 grant/중계/mount/로그인 파일을 소유, 갱신 실패를 thread/start로 우회. 모두 확정 범위와 다르다. **확정 계약과의 새 충돌은 발견하지 못했다.** 현재 구현에서 앞으로 보완할 부분은 명세 충돌로 취급하지 않는다.

## 현재 재확인 — 구현 참고·미확인

수정 위치의 권고는 Codex 내부 연결 경계와 세 caller다. startProcess는 종료 통지와 실제 정리 완료를 구분할 최소 seam만 검토한다. 조직별 grant/폴더·초기 연구 승인·최종 완료 강제·runtime→contracts 의존 방향과 [ADR-0001](../adr/0001-adapter-control-plane.md)을 보존한다.

| 후속 구현 검증 경계 | 기대·관찰할 결과 | 연결 결정 |
|---|---|---|
| 기존 V01–08 + 같은 interface의 initialize/account/read 정상·오류·무응답·EOF | 모델 턴0회, 목록 미완성은 빈 목록, initialize 지연을 포함한 전체60초 후 후속 write0 | D08–11 |
| 동시 갱신 A/B, A 실행만 취소, 갱신 실패 후 다음 호출 | 단일 갱신 합류·B에 취소 전염 없음·refreshing 해제. 중계의 기존 fail-closed는 유지하며 RPC가 실패 후 자동 우회하지 않음 | D08/D13 |
| write와 응답/abort/timeout/close 경합, 초기화·resume 중 취소 | 일회 완료·미처리 rejection/잔여 timer/listener 없음·취소 후 thread/turn 시작0 | D09/D10/D13 |
| cleanup을 gate로 지연한 child/relay | 요청 Promise는 gate 해제 전 오류 완료, adapter Promise는 정리 완료 전 미완료. queue callback의 다음 RPC/cleanup 대기 교착 없음 | D11/D12 |
| 정상/실패/timeout/취소/EOF + 이미 보고한 usage | 기존 누계 차감·cache/input·이상 baseline·미보고 구분 유지. 반환 뒤 활동0·grant 거부·전용 폴더 삭제·중계/자식/컨테이너 정리 결과 확인 | D12/D13 |
| #146 준비 중 취소 후 통합 | 준비 정리와 spawn 직전 취소 확인 뒤 연결로 진행하지 않음. #145에 별도 준비 정책 없음 | D13 |

- 이번 신규 실행 확인은 **0건**이다. E15–19는 소스 확인 5행, E20은 문서 주장 1행. main/upstream 파일별 비교와 원문 재독 및 문서 정적 검사만 새로 수행했다. E11–13 및 다른 조사 문서의 테스트는 과거 결과다.
- 위 표와 V01–08은 구현 완료 조건이며 통과 보고가 아니다. 새 연결·경쟁 순열·60/120/10초 동작·resume fallback·갱신 단일 실행/취소 분리·권한 회수의 통합 동작은 미확인이다.
- 합성 fixture/test를 읽었고 실행하지 않았다. 개인 로그인·실제 모델·CLI·Docker·타 플랫폼·제품 전체 테스트/타입 검사는 미실행. 사용자 계정에서의 refresh 성공이나 모델 가용성을 주장하지 않는다.
- 열린 제품 결정 없음. 내부 interface/종료 통지 형태와 경합 검사는 #145 구현자가 담당하고, 준비 공통화는 #146 담당이다. 주요 공개 자료 접근 실패 없음. binary와 upstream SHA 동일성·전체 upstream 이력/테스트는 재확인하지 않았다.

## 구현 기록 — 2026-11-16

기준 main `8af2c11`. 조사 기준 `983dbc5` 이후 runtime의 변경은 `credential-relay.test.ts`뿐이라 위 권고를 그대로 적용했다.

**구현자가 다시 연 원문과 적용**

| 원문(고정 SHA) | 확인한 내용 | 적용·배제 |
|---|---|---|
| [VSCode connection.ts](https://github.com/microsoft/vscode-languageserver-node/blob/898f44d0fd2a0e9c182414060fb7084ed39f49bc/jsonrpc/src/common/connection.ts#L1422-L1476) L1422–1476, L908–949, L1544–1570 | 보내기 전에 대기 등록, 쓰기 실패면 제거 뒤 거절. 응답은 ID로 먼저 지우고 완료. dispose가 남은 대기를 한꺼번에 거절 | 적용(D10). close가 대기를 남기는 동작은 배제 |
| 같은 파일 L701–763 | 병렬 한도가 있으면 응답을 queue에 넣지 않고 바로 분배(교착 회피) | 적용(D11). 응답 분배는 곧 돌아오고 다음 요청은 queue 밖에서 기다림 |
| [Paseo app-server-transport.ts](https://github.com/getpaseo/paseo/blob/c91948048b308adaa91416cd31f87a0015dac72a/packages/server/src/server/agent/providers/codex/app-server-transport.ts#L306-L407) L306–407 | disposed 선확정 → 대기 거절 → 실제 종료 대기. 예고 없는 종료도 같은 거절 | 적용(D12). 쓰기 뒤 등록·기본 14일 timeout은 배제 |
| [MCP protocol.ts](https://github.com/modelcontextprotocol/typescript-sdk/blob/1e608caeb5130b2ad0fa067c84b26a038c1c6e36/packages/core-internal/src/shared/protocol.ts#L855-L896) L855–896 | 닫힘에서 대기 목록 교체·timer 해제 뒤 대기를 오류로 완료 | 적용(D10) |
| [Codex rpc.rs](https://github.com/openai/codex/blob/ce3031018ef130e653ed4d9c5bb971652de97161/codex-rs/app-server-protocol/src/rpc.rs#L1-L88) | jsonrpc 필드 없음. 서버 요청은 id+method, 응답은 id+result/error | 적용(E02). method가 있는 프레임은 응답으로 보지 않음 |

**구현**

- `codex-connection.ts` `openCodexConnection`: 요청 ID·대기·timer·닫힘을 연결 하나가 맡는다. 오류 응답은 `ProtocolRejection`, 시간 초과는 `ProtocolTimeout`(연결은 열어 둠), 닫힘·종료·쓰기 실패는 `ProtocolClosed`. 남은 시간이 0 이하면 보내지 않는다. 다시 보내기·새 세션 선택은 하지 않는다.
- `process.ts` `startProcess`에 `exited`를 더했다. 프로그램이 끝나고 그 전 출력의 처리가 끝난 때이며 정리 완료(`done`)를 기다리지 않는다. 연결은 이것으로 예고 없는 종료의 대기를 바로 끝낸다. 정리 순서는 바꾸지 않았다.
- 외부 리뷰 1·2회차(SPEC-1·SPEC-3) 반영: 정리는 출력이 닫힐 때(`close`) 시작했는데, 프로그램이 남긴 자식이 출력을 쥐고 있으면 출력이 닫히지 않아 대기·정리가 함께 멈췄다. 이제 프로그램이 끝나고 1초(남은 출력을 읽을 시간) 안에 출력이 닫히지 않으면 같은 정리를 시작한다. 정리는 하나뿐이라 순서(중계 → 남은 그룹 → 컨테이너)가 그대로이고, 그 뒤 출력은 읽지 않는다. 1회차의 프로그램 종료 즉시 그룹 정리는 중계보다 먼저 신호를 보내 2회차에 걷어냈다. Windows는 끝난 프로그램의 자식을 찾지 못해 그 자식은 남지만 대기·정리는 끝난다. 입력 쓰기 실패는 `inputFailed`로 알려 연결이 프로그램 종료를 기다리지 않고 대기를 바로 끝낸다.
- `codex.ts`: 모델 목록·실행 시도·로그인 갱신이 같은 연결을 쓴다. 목록·갱신은 시작 때 정한 전체 시한의 남은 시간을 단계마다 넘긴다. 실행 시도는 일반 요청 시간 초과·오류에서 연결을 닫고, 끼워 넣기 시간 초과는 오류로 알린다. 재개는 `ProtocolRejection`이고 취소·닫힘이 아닐 때만 새 thread를 한 번 시작한다. 반환은 `done`과 기존 finally(권한 회수·전용 폴더 삭제) 뒤다. 사용량·세션 해석, 갱신 필요 판단·합류·후검증, exec 대안은 그대로다.
- 시험용 `CodexOptions.timeouts`로 시한을 줄인다. 제품은 기본값을 쓴다.

**검증(합성 peer·합성 로그인, 실제 CLI·모델·Docker 미사용)**

| 완료 조건 | 검사 |
|---|---|
| 다중 페이지 목록, 오류·종료·전체 시한·취소에서 빈 목록, 모델 턴 없음 | `codex.test.ts` `the model list` |
| 역순·중복·늦은·모르는 ID, 시간 초과 뒤 연결 유지, 시한 0이면 미전송 | `codex-connection.test.ts` |
| 닫기·프로그램 종료에서 대기 즉시 완료(정리 완료보다 먼저), 닫힌 연결의 새 요청 즉시 실패, 종료 직전 응답 전달 | `codex-connection.test.ts` |
| 쓰기 실패(입력을 닫은 프로그램)에서 프로그램이 아직 도는 동안 대기 완료·연결 닫힘 | `codex-connection.test.ts` |
| 프로그램이 끝났는데 남긴 자식이 출력을 쥐고 있어도 대기가 시한 전에 닫힘으로 끝나고 마지막 응답은 전달된다. 같은 그룹 자식은 끝나고(Linux·macOS), 그룹 밖 자식(Windows와 같은 상황)이어도 대기·정리는 끝난다 | `codex-connection.test.ts` |
| 그 경우에도 중계를 닫은 뒤에 남은 자식에게 종료 신호가 간다 | `container.test.ts` |
| 일반 요청 시간 초과는 실패·재전송 없음, 끼워 넣기 시간 초과는 본 실행 완료·재전송 없음 | `codex.test.ts` `a run` |
| 명시적 재개 거절에만 새 thread 한 번(누계 0부터·안내 한 번), 새 thread도 거절되면 끝, 무응답·종료·취소에서는 새 세션 없음 | `codex.test.ts` `a run` |
| 초기화·재개 대기 중 취소가 곧바로 효력, 반환 뒤 활동·프로세스 없음 | `codex.test.ts` `a run` |
| 로그인 갱신 무응답·종료·단계별로는 시한 안이지만 전체로 넘김에서 실패·모델 요청 없음, 갱신 실패 뒤 중계 재확인에서 새 갱신, 기존 정상·동시 합류·실패·미갱신 | `container.test.ts` Codex 갱신 |
| 격리 실행의 요청 무응답·프로그램 종료에서 권한 거부·전용 폴더 삭제·컨테이너 제거 뒤 반환, 기존 취소·정상 종료 정리 | `container.test.ts` Codex 격리 |
| 기존 사용량·재개·exec·CLI 관용·느린 응답·무응답 끼워 넣기·recovery | 기존 검사 유지 |

미검증: 실제 Codex CLI·실제 Docker·실제 로그인 갱신. CI의 macOS·Windows runtime 검사는 합성 peer로 돈다. 쓰기 실패 검사, 같은 그룹 자식이 끝나는지 보는 검사, 격리 실행 검사는 Windows에서 건너뛴다(그룹 밖 자식 검사는 Windows에서도 돈다). 쓰기 실패: windows-latest에서 입력을 닫는 합성 프로그램으로는 요청이 15초 안에 끝나지 않았고(입력을 닫아도 pipe가 끊기지 않는 것으로 보임), Windows의 쓰기 실패는 확인하지 못했다. Windows에서 끝난 프로그램이 남긴 자식은 찾을 수 없어 그대로 남는다(기존 한계, 대기·정리는 끝남). 한 실행의 취소가 공유 갱신을 취소하지 않는 점은 갱신이 실행의 취소 신호를 받지 않는 구조로만 확인했다(전용 검사 없음). 갱신 실패 뒤 중계는 기존대로 실패 상태로 남고, 다음 갱신은 중계를 다시 확인할 때(`recover`) 일어난다.

## 2026-11-10 조사 기록 — 과거 근거 보존

이하 당시 기준 `c88a98b`와 당시 실행 결과를 보존한다. 「현행」「이번」은 11월 10일을 뜻하며 현재 권고·범위는 위 재확인 절을 따른다. 특히 아래 Q1·D01의 두 소비자 설명은 D08로 보강되었다.

## Brief

- 구현할 문제: 모델 목록과 실행 시도가 중복 관리하는 handshake·요청 ID·pending·timer·close를 Codex 내부 연결에 집중한다.
- 동종 문제: 연결 하나에서 요청/응답을 ID로 연결하고 모든 종료 경로에서 대기를 한 번 완료하는 메커니즘.
- 고정된 결정: 목록 전체 60초 deadline·불완전 목록 폐기, 일반 RPC 120초 실패/연결 종료, steer 10초 전달 불명/본 실행 유지. 자동 재전송 없음. 명시적 resume ProtocolRejection에만 새 thread 1회, baseline 초기화와 안내 1회. 초기화·재개 중 취소도 유효하며 startProcess의 실제 프로세스·컨테이너 정리까지 기다린다. exec·다른 프로바이더·공통 복구 실행기·DB/API 변경 제외.
- 기준: 로컬 HEAD `c88a98b58284a38bdadf7eff7aafa0219005371c`. 이슈 댓글·blocker 없음, parent API 404. 이슈 작성 뒤 정책 변경 없음.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 초기화와 ID/응답 연결·페이지 완료 계약은? | #145 User Stories 1–3, Implementation Decisions 1/6 | 프로토콜·호환성 + Source Recon |
| Q2 | 성공·오류·write 실패·timeout·취소·종료 경쟁을 한 번 완료하고 정리하는가? | #145 Implementation Decisions 2–5/10 | Source Recon + runtime/failure |
| Q3 | timeout·프로토콜 거절·닫힘을 구분하고 호출자 정책을 남기는가? | #145 Implementation Decisions 5–9 | 프로토콜·계약 + failure |
| Q4 | 후속 RPC와 응답 queue 교착을 피하는가? | #145 Implementation Decisions 11 | Source Recon + 합성 peer |
| Q5 | 늦은 응답·취소·종료가 후속 연결/실행에 영향을 주지 않는가? | #145 User Stories 4/10/11, Testing Decisions | Source Recon + adversarial scenario |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [#98–101 Q7/Q8·Codex 근거](issue-98-101-references.md#근거-codex) | 공식 타입·Paseo 후보·초기화 출발점 | E14 steer는 배경으로만 사용. E15 usage/E16 지침·exec는 이번 수명 조사 밖. E17 CLI0.166.0은 과거 실행이며 이번 실행으로 세지 않음 |
| [#98–101 구현 근거](issue-98-101-implementation.md) | 합성 peer와 실제 호출의 기존 회귀 범위 | 기존 실제 모델 검증을 이번 결과로 승격하지 않음. 현재 codex.ts/process.ts와 검사 진입점을 다시 읽음 |
| [프로바이더 연결](provider-connection-references.md)·[기능 비교](executor-capabilities.md)·[실행 모델](agent-runtime-models.md) | 더 넓은 프로바이더 비교 맥락 | 새 공통 lifecycle 근거로 사용하지 않음. 필요한 Codex 원문만 보강 |
| [#125](issue-125-references.md)·#140–143 로컬 조사 | 재사용하지 않음 | Claude background·server action/DB 경계로 질문이 다름 |

Codex a098129→c82708f에서 initialize/outgoing/rpc 3파일 blob 동일, catalog/turn/thread/message 4파일 변경 후 최신 분기를 재확인했다. Paseo efc64a5→c919480 transport blob은 `5a218e2edbaec89f4e3bb887f41937ba8ad9b938`→`04793e011adb021e06d6583e8ad3bf466b49c17a`로 변경되어 최신 request/dispose/response를 다시 읽었다. 과거 조사 권고를 최신 실행 증거로 취급하지 않았다.

## 레퍼런스

후보 8종. 관점은 ① 프로토콜 원본·운영 wrapper ② 요청 대기 라이브러리·표준·장애 사례다. 1라운드는 기존 조사/Codex/Paseo, 2라운드는 공식 문서/JSON-RPC/VSCode/MCP 장애, 마지막 확장은 Sourcegraph·Go의 context/비동기 응답 구조였다. 원본 관점은 handshake/페이지/오류 분리로, 대기 관점은 pending 제거·취소·큐 분배로 수렴했고 마지막 확장에서 새 패턴이 추가되지 않았다. 기록한 검색 범위의 saturation이며 생태계 전수조사가 아니다. Recon 두 작업을 분담하고 메인이 채택 원문을 다시 읽었다.

| 레퍼런스 | 분류 | 고정 SHA/판 | 라이선스 | 깊이·선정 이유 |
|---|---|---|---|---|
| Codex | 원본 | `c82708f85803d21fe9046af407107a1ee105b6e5`; binary0.167.0 | Apache-2.0 | 소스·무모델 실행: wire와 페이지 계약 |
| VSCode JSON-RPC | 부품 | `898f44d0fd2a0e9c182414060fb7084ed39f49bc`; package10.0.0 | MIT | 소스·메모리 peer 실행: close/dispose·취소 반례 |
| MCP TypeScript SDK | 부품 | `1e608caeb5130b2ad0fa067c84b26a038c1c6e36` | MIT→Apache-2.0 전환 중; 기여별 확인 필요 | 소스: timer/registry/transport 정리 대조 |
| Paseo | 운영 wrapper | `c91948048b308adaa91416cd31f87a0015dac72a` | Apache-2.0, third-party 예외 | 소스: 같은 CLI의 pending·종료 구조 |
| JSON-RPC 2.0·MCP #1459 | 표준·장애 보고 | 명세2013-01-04; 보고 확인2026-11-10 | 코드 이식 없음 | 문서: ID 규칙·재연결 timer 오염 |
| Sourcegraph jsonrpc2·Go x/tools jsonrpc2_v2 | 인접 구현 | SHA 미고정 | 미검토·이식 없음 | 목록만: self-host 가능, 위 후보와 중복되어 심층 제외 |

## 근거

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 공식 문서는 initialize 성공 뒤 initialized 알림, 이후 일반 요청 순서를 설명한다. JSON-RPC 명세는 ID 대응과 result/error 구별을 정하지만 timeout/재시도 정책을 정하지 않는다. | [공식 app-server](https://learn.chatgpt.com/docs/app-server), [JSON-RPC §4–5](https://www.jsonrpc.org/specification#request_object) | 문서 주장 |
| <a id="E02"></a>E02 | Codex는 jsonrpc 필드를 생략하는 유사 wire 형식이다. ID만 보고 서버 request를 response로 오인하면 안 된다. 초기화 전·중복 초기화는 명시적 오류다. | [wire](https://github.com/openai/codex/blob/c82708f85803d21fe9046af407107a1ee105b6e5/codex-rs/app-server-protocol/src/rpc.rs#L1-L88), [initialize](https://github.com/openai/codex/blob/c82708f85803d21fe9046af407107a1ee105b6e5/codex-rs/app-server/src/request_processors/initialize_processor.rs#L53-L70), [guard](https://github.com/openai/codex/blob/c82708f85803d21fe9046af407107a1ee105b6e5/codex-rs/app-server/src/message_processor.rs#L1037-L1047) | 소스 확인 |
| <a id="E03"></a>E03 | model/list는 cursor/limit로 자르고 마지막 next_cursor=None, 잘못된 cursor는 오류다. 전체 deadline은 이 서버 페이지 함수의 책임이 아니다. | [list_models](https://github.com/openai/codex/blob/c82708f85803d21fe9046af407107a1ee105b6e5/codex-rs/app-server/src/request_processors/catalog_processor.rs#L304-L361) | 소스 확인 |
| <a id="E04"></a>E04 | 서버의 역방향 요청도 연결 callback을 먼저 제거해 완료하고, 전체 취소는 drain한다. unknown 응답은 로그 후 끝난다. 방향이 반대이므로 정책을 그대로 복제하지 않는다. | [callback completion](https://github.com/openai/codex/blob/c82708f85803d21fe9046af407107a1ee105b6e5/codex-rs/app-server/src/outgoing_message.rs#L562-L655) | 소스 확인 |
| <a id="E05"></a>E05 | VSCode는 pending을 write 전에 등록하고 실패하면 제거·reject한다. 응답도 ID로 먼저 제거하고 success/error에서 취소 listener를 정리한다. | [connection.ts](https://github.com/microsoft/vscode-languageserver-node/blob/898f44d0fd2a0e9c182414060fb7084ed39f49bc/jsonrpc/src/common/connection.ts#L908-L949), [connection.ts](https://github.com/microsoft/vscode-languageserver-node/blob/898f44d0fd2a0e9c182414060fb7084ed39f49bc/jsonrpc/src/common/connection.ts#L1422-L1476) | 소스 확인 |
| <a id="E06"></a>E06 | VSCode close는 Closed+이벤트만, dispose에서 pending 일괄 reject. 취소 알림만으로 로컬 대기를 끝내지 않는다. | [connection.ts](https://github.com/microsoft/vscode-languageserver-node/blob/898f44d0fd2a0e9c182414060fb7084ed39f49bc/jsonrpc/src/common/connection.ts#L659-L678), [connection.ts](https://github.com/microsoft/vscode-languageserver-node/blob/898f44d0fd2a0e9c182414060fb7084ed39f49bc/jsonrpc/src/common/connection.ts#L1422-L1476), [connection.ts](https://github.com/microsoft/vscode-languageserver-node/blob/898f44d0fd2a0e9c182414060fb7084ed39f49bc/jsonrpc/src/common/connection.ts#L1544-L1570) | 소스 확인 |
| <a id="E07"></a>E07 | maxParallelism 제한 시 VSCode는 응답을 queue 밖에서 즉시 분배하여 후속 RPC 대기의 교착을 피한다. | [connection.ts](https://github.com/microsoft/vscode-languageserver-node/blob/898f44d0fd2a0e9c182414060fb7084ed39f49bc/jsonrpc/src/common/connection.ts#L701-L763) | 소스 확인 |
| <a id="E08"></a>E08 | MCP _onclose는 registry 교체·timer 해제·transport 제거 후 finally에서 waiter를 오류 완료한다. callback 오류에도 정리를 보장하는 참고다. | [Protocol](https://github.com/modelcontextprotocol/typescript-sdk/blob/1e608caeb5130b2ad0fa067c84b26a038c1c6e36/packages/core-internal/src/shared/protocol.ts#L855-L896) | 소스 확인 |
| <a id="E09"></a>E09 | Paseo는 disposed 선확정→pending reject→실제 종료 await를 나눈다. 다만 request는 write 후 pending 등록, 기본 timeout 14일이어서 그대로 채택하지 않는다. | [CodexAppServerClient](https://github.com/getpaseo/paseo/blob/c91948048b308adaa91416cd31f87a0015dac72a/packages/server/src/server/agent/providers/codex/app-server-transport.ts#L13-L15), [CodexAppServerClient](https://github.com/getpaseo/paseo/blob/c91948048b308adaa91416cd31f87a0015dac72a/packages/server/src/server/agent/providers/codex/app-server-transport.ts#L306-L407) | 소스 확인 |
| <a id="E10"></a>E10 | MCP 장애 보고는 예전 연결 timer가 새 transport에 취소를 보내고 낡은 finally가 같은 ID의 새 controller를 지우는 실패 모드를 제시한다. 보고 자체는 재현 실행이 아니다. | [SDK #1459](https://github.com/modelcontextprotocol/typescript-sdk/issues/1459) | 문서 주장 |
| <a id="E11"></a>E11 | 설치 CLI0.167.0: 초기화 전/중복 초기화 거절, 정상 handshake, limit1 목록9페이지 완료, invalid cursor·없는 thread steer 거절, EOF exit0. 빈 HOME/CODEX_HOME와 loopback mock provider 사용, turn/start 없음. | Python3 subprocess, 요청당8초·주소공간2GiB, 로컬 codex-probe 로그 | 실행 확인 |
| <a id="E12"></a>E12 | 고정 VSCode 원문을 TS6.0.3 transpileModule로 /tmp에 빌드: 역순/unknown/late, close 후 dispose, write 실패 정리, 취소 대기, maxParallelism1 nested RPC 5개 PASS. close와 취소의 대기 유지가 음성 대조다. | Node24.21.0; 키 없는 env의 memory reader/writer, 로컬 실행 기록 | 실행 확인 |
| <a id="E13"></a>E13 | 실제 startProcess에서 첫 프레임 콜백이 후속 프레임을 기다리면 후속 전달이 막힘. 외부 barrier 해제로 정리하고, 즉시 분배 대조군은 두 응답과 done 완료. | Node24.21.0; 키 없는 env의 합성 child, 로컬 process-queue 로그 | 실행 확인 |
| <a id="E14"></a>E14 | 현행 startProcess는 onFrame을 serial queue로 처리하고 done은 자식/컨테이너 정리·queue를 기다린다. end 요청과 closed/done은 다른 시점이다. | [startProcess](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/runtime/src/providers/process.ts#L204-L337) | 소스 확인 |

실행 명령은 로컬 조사 캐시에 보존했다. Codex(Python)·VSCode RPC·프로세스 큐(Node) probe를 실행했다. 외부 라이브러리 설치 없이 실행했고 남긴 서비스 프로세스는 없다. 소스와 설치 Codex binary의 동일 SHA는 확인하지 않았다.

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| P01 | 연결별 맵·ID와 제거 후 완료 | E02/E04/E05 | Codex 서버는 역방향 요청에도 사용 | 역순·중복 격리 | pending 선등록과 모든 terminal 경로의 정리 필요 |
| P02 | 논리 close와 물리 정리 분리 | E06/E08/E09/E14 | VSCode는 dispose 전 대기 유지 | 즉시 요청 종료와 프로세스 정리 동시 충족 가능 | close와 cleanup done을 혼동하면 무한 대기/조기 반환 |
| P03 | wire 결과와 관측 실패 구별 | E01/E02/E05 | timeout/취소는 로컬 사유 | 무응답을 거절로 오인하지 않음 | 호출자별 정책 필요 |
| P04 | 응답 분배에서 후속 RPC를 await하지 않음 | E07/E12/E13 | VSCode는 제한 병렬성 시 우회 분배 | 교착 방지 | 직렬 알림 처리와 요청 orchestration 분리 필요 |
| P05 | 연결 수명마다 timer/listener/registry 폐기 | E08/E10 | MCP는 재연결 재사용도 다룸 | 낡은 callback 오염 차단 | 맵 clear만으로 timer까지 없어지지 않음 |

## 결정 권고

모두 #145 확정 정책을 구현하기 위한 설계 권고다. 새 제품 정책을 결정하지 않는다.

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| D01 | 변형 채택 | Codex 내부 연결이 handshake/ID/pending/timer/닫힘을 소유. pending 선등록 후 write, 완료 시 제거·timer/listener 해제. unknown/duplicate/late는 무시 | P01/P05 | 라이브러리 추가 없이 작은 내부 경계로 보장 | Q1/Q2/Q5 |
| D02 | 변형 채택 | close 요청 시 먼저 닫고 신규 요청 거부·대기자 즉시 오류. cleanup Promise는 따로 startProcess.done까지 await | P02/E08/E09 | 사용자 대기 완료와 실제 프로세스 정리는 별개 조건 | Q2/Q5 |
| D03 | 채택 | timeout/ProtocolRejection/closed/취소 구별, 연결은 자동 재전송·새 thread 선택 안 함. 일반120초와 steer10초 행동은 adapter가 결정 | P03 | 전달 불명과 확정 거절 혼동 방지, 기존 명세 유지 | Q2/Q3 |
| D04 | 채택 | 목록 호출자가 전체60초 deadline과 pagination 소유. 페이지마다 시한 재시작 안 함. 취소/오류/미완료 종료면 부분 목록 폐기 | E03/E11, #145 | 목록 완성 계약을 RPC 수명에 섞지 않음 | Q1/Q3 |
| D05 | 채택 | 응답 처리 콜백은 분배만 끝냄. handshake/pagination await는 queue 밖. 알림에서 후속 RPC 대기하는 경로도 대조 | P04/E14 | 실제 현행 queue의 교착 조건 확인 | Q4 |
| D06 | 채택 | 실행별 연결 객체 재사용 안 함. 취소 후 continuation이 다음 요청을 시작하지 않게 닫힘/신호 확인. 가능한 interrupt 뒤 close, active steer와 활동은 adapter 소유 | P02/P05, #145 | 연결별 pending과 provider 수명의 active run 맵 구분 | Q2/Q5 |
| D07 | 배제 | VSCode close/cancel 대기 유지, Paseo write후등록·14일 timeout, MCP 취소 wire 및 provider 전체 lifecycle/재시도 일반화 | E06/E09/E10, #145 | 즉시 정리·시간 정책·프로토콜별 차이와 맞지 않음 | Q2/Q3/Q5 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 응답 없음→새 세션/재전송 | 이번 비교가 보장하지 않는 해석 | #145는 명시적 resume 거절에만 새 thread1회. 실제 ACK를 잃었을 수도 있음 |
| 종료 코드0→미응답 성공 | EOF0 관측 E11 | 프로세스 정상 종료와 개별 요청 성공은 독립 |
| 프로토콜 표준 라이브러리 전면 도입 | VSCode/MCP | jsonrpc 필드·취소/close 의미가 다름. 설계 참고만 하고 코드 이식/의존성 도입 없음 |

## 구현 참고

권고 위치는 `packages/runtime/src/providers/codex.ts`와 그 안에서 쓰는 Codex 전용 내부 연결이다. `process.ts`의 PID·시작 시각·lease·자식·컨테이너 정리 책임은 유지한다. [ADR-0001](../adr/0001-adapter-control-plane.md)의 adapter 기반 control plane과 폴더 의존 방향(runtime→contracts)을 지킨다. 조직별 환경/토큰을 연결 밖으로 공유하지 않고 초기 연구 승인·최종 완료·조직 경계 강제 지점도 유지한다. 이 작업에서 메모리 엔진·공통 복구 정책·새 ADR을 도입할 근거는 없다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 두 페이지 정상/둘째 오류·deadline·취소·EOF → 목록 완성만 반환, 모델 턴 시작0회 | D01/D04 |
| V02 | 동시 요청 역순·unknown·duplicate·late → 맞는 대기만 한 번 완료, 다음 연결 무영향 | D01/D06 |
| V03 | write 실패·정상 종료·프로세스 사망·명시적 close → 모든 대기 완료, 새 요청 즉시 실패 | D01/D02 |
| V04 | 초기화·resume 대기 중 abort, 응답/timeout/close 경합 → 후속 작업 시작0·미처리 rejection0·timer/listener 잔존0 | D01/D02/D06 |
| V05 | 일반 RPC timeout → 실행 실패/닫힘; steer timeout → 전달 불명 오류·본 실행 정상 완료 가능, 재전송0 | D03 |
| V06 | resume 명시적 거절만 → thread/start1회·baseline 초기화·안내1회; timeout/닫힘/취소 → 새 thread0회 | D03, #145 |
| V07 | handshake·pagination·동시 steer → 교착 없음; 반환 시 프로세스/컨테이너 정리 완료·이후 활동0 | D02/D05/D06 |
| V08 | 기존 exec·정상 턴·usage·CLI tolerance·PID/시각/lease recovery → 기존 계약 유지 | D07, 기존 구현 근거 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 제품 정책: 없음 | #145 | 기존 확정 정책 유지. 내부 타입·파일 이름은 구현자가 선택 |

## 한계와 미확인

- 실행 확인 3행, 소스 확인 9행, 문서 주장 2행이다. 서로 다른 근거 수준을 구현 검증 통과로 합산하지 않는다.
- 이번 실행은 CLI 무모델 요청·VSCode memory peer·현행 startProcess queue 대조만이다. 제품의 새 연결 구현, 60/120/10초 경합, resume fallback, 활동 종료 보장 전체는 아직 검증하지 않았다. V01–V08은 구현 시 검사할 항목이다.
- 실제 모델·계정 로그인·자격 증명·유료 API를 사용하지 않았다. CLI mock catalog의9개는 사용자 계정 모델 가용성 보장이 아니다. 실제 resume/turn/interrupt, 네트워크 장애와 모든 취소 순열은 미실행이다.
- Windows/macOS·Docker/자식 정리·전체 upstream Rust/VSCode/MCP tests와 제품 전체 테스트·타입 검사는 실행하지 않았다. 이번 작업은 조사 문서만 변경한다.
- 주요 자료 접근 실패 없음. shallow 이력으로 upstream 변경 이유/연결 PR 전체 추적은 미확인이다. Sourcegraph/Go는 검색 후보 수준으로 구현 근거에 사용하지 않았다.
- 상충 — 사용자 판단 대상으로 올릴 새 정책 충돌은 발견하지 못했다. 비교 대상의 다른 close/취소 의미는 D07로 배제했다. 구현자는 채택 permalink와 구현 시점 upstream/제품 코드를 다시 확인한다.
- 설계 참고만 하며 제3자 코드 복사 없음. 향후 코드 재사용 시 고정 SHA LICENSE/header/NOTICE/의존성을 다시 확인하고 저장소 출처·THIRD_PARTY_NOTICES 규칙을 적용한다.
