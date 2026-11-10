# issue-145 레퍼런스 조사: Codex 연결의 요청 대기·종료 정리 집중

#145의 연결별 요청 수명과 응답 분배를 조사한다. 현행 정책은 [#145](https://github.com/babo-jeonguk/BaboJUBot/issues/145), 구조는 [architecture](../architecture.md), 용어는 [GLOSSARY](../../GLOSSARY.md)가 기준이다.

조사일: 2026-11-10. 구현 전 권고이며 확정 계약이나 구현 완료가 아니다. 제품 코드·테스트·설정 변경 및 커밋 없음. 상세 실행·후보 기록은 git에서 제외되는 로컬 조사 캐시에 보관한다.

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
| <a id="E12"></a>E12 | 고정 VSCode 원문을 TS6.0.3 transpileModule로 /tmp에 빌드: 역순/unknown/late, close 후 dispose, write 실패 정리, 취소 대기, maxParallelism1 nested RPC 5개 PASS. close와 취소의 대기 유지가 음성 대조다. | Node24.21.0; 키 없는 env의 memory reader/writer, 로컬 rpc-run-log | 실행 확인 |
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
