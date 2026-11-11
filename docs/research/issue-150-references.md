# issue-150 레퍼런스 조사: OpenCode 쓰기 호출의 재시작 중복 방지

호출 식별자·MCP 전달 경로와 실행 의도 복구의 근거를 기록한다. 현재 구현은 [현재 구현 현황](../current-implementation.md), 이번 요구와 구현 계약은 [#150 본문](https://github.com/babo-jeonguk/BaboJUBot/issues/150)과 [누적 Agent Brief](https://github.com/babo-jeonguk/BaboJUBot/issues/150#issuecomment-6785043707)가 맡는다.

조사일: 2026-11-10~11. 구현·실제 모델 실행 결과가 아닌 소스 조사다. 다음 사용자 계약은 2026-11-11 확정됐으며 변경 이력을 추론해 구현할 필요가 없다.

## 현재 확정 계약

### 확정 계약

1. **대상·신원:** 실행 의도는 에이전트가 수행하려고 확정한 조직 도구 쓰기 한 건이다. 모든 기존 조직 쓰기 도구에 적용한다. 제품이 조직·에이전트에 귀속된 안정적인 실행 의도 ID를 발급하며 실행 시도·토큰·프로바이더 세션이 바뀌어도 저장된 의도의 ID는 유지한다. 에이전트에게 재시도/신규 선언이나 키 생성을 요구하지 않는다.
2. **효과 전 기록:** 도구·입력·필요한 원본 자료를 고정하고 복구 가능한 실행 의도를 영속화한 뒤에만 효과를 수행한다. 의도 수락·원본 고정 완료 전 중단에서는 효과가 없어야 한다. 파일 경로 산출물은 최초 쓰기 전에 안전하게 읽은 바이트를 보존한다. 복구 때 현재 경로의 바뀐 파일로 대체하지 않는다. 수락한 의도의 원본 자료를 복원할 수 없으면 진행을 막는다.
3. **최초 결과 보존:** 효과와 최초 결과의 저장은 원자적이어야 한다. 저장된 동일 의도·도구·입력의 재전달은 최초 결과를 재사용하고 효과·연구 기록·Event·깨우기를 추가하지 않는다. 같은 ID에 다른 도구·입력은 충돌로 거절한다. 동일 내용의 별개 의도는 각각 수행한다. 입력 순서·생략값을 임의 정규화해 기존 digest와 충돌시키지 않는다.
4. **복구와 모델의 순서:** 재시작 후 모델을 진행하기 전에 저장된 의도와 결과를 조회·정산한다. 이미 완료됐으면 결과를 가져오고, 미수행이면 현재 권한·상태가 허용할 때만 같은 고정 입력으로 수행한다. 정산한 결과를 모델이 받을 맥락에 반영한 뒤 모델을 재개한다. 복구 결과 전달도 재중단 시 유실·중복되지 않아야 한다. 옛 실행 시도는 기존 server_restart 의미를 보존한다.
5. **조회·거절·제어:** 완료된 의도의 최초 결과 조회는 새 쓰기가 아니다. 복구 주체가 조직·에이전트·의도 신원을 검증하면 현재 단계에서 해당 쓰기가 금지됐어도 기존 결과만 조회할 수 있다. 미수행 쓰기는 현재 승인·Role·단계·조직/에이전트 제어를 존중한다. 정책상 금지되면 효과 없이 확정 거절로 정산하고 이후 허용된 모델 실행에 전달한다. 사용자 취소·중단된 입력을 부활시키지 않는다. 완료 효과는 되돌리지 않으며 옛 토큰을 재사용하지 않는다. 일반 도구 경로의 인증·조직 경계·승인 검사를 느슨하게 하지 않는다.
6. **복구 실패 차단:** 일시적 오류는 제한적으로 자동 재시도한다. 한도 초과·기록 모순·필수 자료 부족은 이유를 표시하고 해당 에이전트의 모델 진행을 차단한다. 새 메시지·Heartbeat·서버 재시작으로 차단이나 재시도 한도가 우회되지 않아야 한다. 사용자가 명시적으로 복구 재시도를 선택하고 정산에 성공해야 차단을 해제한다. Inbox 읽음·보관만으로 해제하지 않으며 기존 일시정지·조직 종료 등 제약은 계속 적용한다. 이 계약은 자동으로 사용자의 일시정지 설정을 바꾸라는 뜻이 아니다.
7. **세션 재구성:** 기존 OpenCode 세션을 이어갈 수 없으면, 미확정 의도를 정산한 뒤 제품의 연구 기록·원래 입력·확정 결과로 새 세션을 구성해 재개할 수 있다. 필요한 기록이 부족하면 차단한다. 새 세션을 만들었다고 기존 의도·결과를 새 것으로 바꾸지 않는다.
8. **보장 한계:** 복구는 제품이 저장된 의도로 자동 처리한다. 결과를 전달한 뒤 모델이 새로 요청한 호출은 새 실행 의도로 처리한다. 모델이 의미상 같은 일을 다시 요청하는 것까지 자동 판별하지 않는다. 내용 hash·호출 순번·JSON-RPC id·프롬프트 준수로 이 한계를 숨기지 않는다. 조직 도구 밖 외부 효과는 보장 대상이 아니다.

### 중단 지점별 기대 동작

| 중단 지점 | 복구 결과 |
| --- | --- |
| 의도·원본 고정의 수락 완료 전 | 효과 없음. 불완전 자료를 수락된 의도로 오인하지 않음 |
| 의도 수락 후 효과 commit 전 | 저장된 의도·원본으로 현재 제어·권한 확인 후 수행 또는 확정 거절 |
| 효과 commit 후 응답 전 | 최초 결과 조회. 효과를 다시 수행하지 않음 |
| 응답 후 프로바이더 결과·세션 저장 전 | 최초 결과를 복구 맥락에 반영. 완료 기록 누락을 새 쓰기의 근거로 삼지 않음 |
| 결과 전달 중 또는 복구 도중 다시 중단 | 동일 의도와 전달 신원으로 정산·전달을 반복해도 효과·입력이 중복되지 않음 |
| 원본·기록 부족, 모순 또는 재시도 소진 | 에이전트 모델 진행 차단·이유 표시·사용자 복구 재시도 필요 |

## 구현 인계

#150은 `bug` · `ready-for-agent`로 인계한다. 실제 API·전송·복구 fixture는 구현 완료 조건이며 아직 실행하지 않았다. 저장 테이블·구체 API·제한된 재시도 횟수는 구현자가 계약에 맞게 정한다. 특정 기술 경로가 확인되지 않으면 보장을 낮추거나 모델 지침으로 대체하지 말고 이유를 보고한다. #161은 통합 종료했고 #159·#154는 별개다.

## Brief

- 구현할 문제: OpenCode의 조직 MCP 쓰기에 호출별 멱등 키가 없으며, 제품 재시작 후 모델이 이미 수행한 효과를 다시 만들 수 있다.
- 동종 문제: 불확실한 응답 뒤 **동일한 실행 의도**를 다시 전달하는 것과 모델이 새 호출을 생성하는 것을 구분하는 분산 쓰기 멱등성.
- 고정된 결정: 초기 연구 승인·조직 경계·최종 완료는 제품 코드가 강제한다. #159의 steer 복구와 다른 프로바이더 전면 개편은 제외한다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | OpenCode v2.2.6은 호출별 키를 어디에 넣을 수 있는가? | #150 완료 조건 1 | 공식 소스 call path·타입 대조 |
| Q2 | 호출 ID는 전송 재시도·세션 재개·새 모델 생성에서 유지되는가? | #150 완료 조건 1·2·5 | 상태 저장·실패 복구 소스 추적 |
| Q3 | 고정 키·내용 hash·순번·호출 ID의 실패 모드는 무엇인가? | #150 완료 조건 3 | 반례 비교 |
| Q4 | 어떤 범위까지 결정적으로 검증할 수 있는가? | #150 완료 조건 4·5 | 무모델 fixture 계획 |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [OpenCode 2.x 지침 주입](opencode-2-instructions.md) | 공식 저장소와 v2 API 경로 | v2.2.6 태그에서 MCP·도구 API 재확인; 이전 v2.2.5 결론을 호출 ID 보장으로 확장하지 않음 |

## 레퍼런스

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| anomalyco/opencode | 공식 구현 | v2.2.6, `dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06` | MIT | 소스 | 실행 대상 버전의 실제 hook·MCP·resume 구현 |
| modelcontextprotocol/typescript-sdk | 공식 구현 | `@modelcontextprotocol/client`·core 2.3.1, `fcef852f6cdafea07f36cf6fae69b37c8adf85be` | MIT | 소스 | OpenCode가 직접 import하는 모듈형 SDK의 JSON-RPC ID와 전송 |

버전은 공개 Git 태그와 manifest를 대조했다. OpenCode의 native MCP는 `@modelcontextprotocol/client` 2.3.1을 import한다. lock에 함께 존재하는 legacy `@modelcontextprotocol/sdk` 1.32.2와 혼동하지 않는다. OpenCode 자체 client patch도 확인했으며 ID 영속화나 제품용 멱등 키 추가는 없다. [버전·저장소](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/package.json#L1-L11), [직접 의존성](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/package.json#L96-L108), [import](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/mcp/client.ts#L4-L29), [patch](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/patches/@modelcontextprotocol%252Fclient@2.3.1.patch)

관점별 탐색 종료 근거: MCP 전송 → 도구 등록·hook → 모델 stream·세션 저장·복구 → SDK request ID까지 경로를 추적했다. 이 경로에는 새 모델 호출과 이전 효과를 연결하는 영속 실행 의도 계약이 없었다. 이는 다른 모든 OSS에 그런 기능이 없다는 결론이 아니다.

## 근거

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 모델의 `tool-call` event를 먼저 publish한 뒤 실제 도구를 실행한다. Tool.Context.id는 input.call.id이고 messageID는 해당 assistant message다. | [실행 순서](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/session/runner/step.ts#L95-L130), [context 생성](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/tool.ts#L299-L316) | 소스 확인 |
| <a id="E02"></a>E02 | OpenAI Chat 경로는 응답의 tool.id를 받아 stream 동안 유지한다. 도구 ID는 공급자 응답 식별자이며 제품 효과 ID가 아니다. | [ID 수신](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/ai/src/protocols/openai-chat.ts#L1166-L1177), [event 변환](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/ai/src/protocols/utils/tool-stream.ts#L79-L91) | 소스 확인·해석 |
| <a id="E03"></a>E03 | `ctx.tool.hook("execute.before", ...)`는 tool·input을 바꿀 수 있고 sessionID·agent·messageID·id를 읽는다. HTTP header·MCP envelope 필드는 없다. 실행 전 hook 이후 입력 검증을 거쳐 executor가 호출된다. | [공개 API](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/plugin/src/promise/tool.ts#L26-L46), [hook 적용](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/tool.ts#L121-L129), [입력 검증](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/tool/runtime.ts#L30-L38) | 소스 확인 |
| <a id="E04"></a>E04 | MCP tool executor는 args와 context.sessionID만 native mcp.callTool에 전달한다. context.id와 messageID는 전달하지 않는다. | [MCP executor](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/tool/mcp.ts#L55-L83), [MCP callTool API](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/mcp/index.ts#L166-L171) | 소스 확인 |
| <a id="E05"></a>E05 | native client는 `params.arguments = input.args`와 `params._meta["ai.opencode/sessionID"]`를 별도로 만든다. hook의 input._meta를 추가하면 arguments._meta일 뿐 params._meta가 아니다. 모델이 `_meta` 인자를 생성해도 transport metadata가 된다고 볼 수 없다. | [wire 인자 조립](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/mcp/client.ts#L508-L530) | 소스 확인·해석 |
| <a id="E06"></a>E06 | MCP 설정 headers는 StreamableHTTPClientTransport requestInit에 들어가는 연결 설정이다. 공개 MCP plugin API는 설정 transform·reload·list이고, 호출별 envelope hook을 제공하지 않는다. | [연결 headers](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/mcp/client.ts#L341-L353), [MCP plugin API](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/plugin/src/promise/mcp.ts#L6-L17) | 소스 확인 |
| <a id="E07"></a>E07 | tool.transform editor.update로 execute를 교체할 수 있고 executor는 sessionID/messageID/id가 있는 context를 받는다. 따라서 자체 전송 wrapper는 가능한 seam이다. 원래 execute(input,context)를 그대로 호출하는 것만으로 native MCP의 metadata를 바꾸지는 못한다. | [도구 editor·execute](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/plugin/src/promise/tool.ts#L11-L35), [context](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/schema/src/tool.ts#L14-L20), [실제 update](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/tool.ts#L216-L225), E04·E05 | 소스 확인·구현 가능성 추론 |
| <a id="E08"></a>E08 | tool.id는 assistant tool part에 남으며 DB part row의 call_id에도 저장된다. 저장된 과거 호출을 읽을 수 있다는 사실은 다음 모델 생성이 그 ID를 다시 낸다는 보장이 아니다. | [tool part](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/session/message-updater.ts#L306-L341), [DB 저장](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/session/projector.ts#L698-L720) | 소스 확인·해석 |
| <a id="E09"></a>E09 | drain 시작 시 stale tool calls를 정리한다. 과거 assistant의 streaming/running 도구는 `aborted` 실패로 표시하며, 해당 구현은 이전 MCP 호출을 재전송하지 않는다. | [진입](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/session/runner/llm.ts#L63-L80), [stale 정리](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/session/runner/llm.ts#L412-L435) | 소스 확인 |
| <a id="E10"></a>E10 | 새 runStep은 새 assistantMessageID를 만든다. 출력 이전 retry는 기존 messageID를 쓰지만 출력 이후 중단 continuation·compaction은 새 messageID를 만든다. | [step ID 생성](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/session/runner/llm.ts#L232-L249), [Retry·Continue](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/session/runner/llm.ts#L324-L337), [출력 여부 분기](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/session/runner/step.ts#L211-L215), [출력 이후 continuation](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/session/runner/step.ts#L272-L280) | 소스 확인 |
| <a id="E11"></a>E11 | native MCP 쓰기는 read-only listing용 일반 transient retry helper로 감싸지 않는다. 별도 재시도는 modern HEADER_MISMATCH 시 목록 갱신 후 1회, MCP session expired 시 연결 재생성 후 run 재호출이다. | [listing retry 구분](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/mcp/client.ts#L398-L406), [header mismatch](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/mcp/client.ts#L534-L544), [session 복구](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/mcp/connection.ts#L130-L150) | 소스 확인 |
| <a id="E12"></a>E12 | 모듈형 SDK Protocol의 JSON-RPC counter는 인스턴스별 0에서 시작하며 요청마다 증가한다. onprogress가 있으면 progressToken에도 요청 번호를 넣는다. 새 client·새 요청이 이전 효과를 기억하는 식별자는 아니다. | [counter](https://github.com/modelcontextprotocol/typescript-sdk/blob/fcef852f6cdafea07f36cf6fae69b37c8adf85be/packages/core-internal/src/shared/protocol.ts#L563-L572), [request 생성](https://github.com/modelcontextprotocol/typescript-sdk/blob/fcef852f6cdafea07f36cf6fae69b37c8adf85be/packages/core-internal/src/shared/protocol.ts#L1438-L1454) | 소스 확인·해석 |
| <a id="E13"></a>E13 | SDK SSE resumption은 resumptionToken으로 응답 stream을 다시 연결하며 원래 message.id를 연결한다. 일반 send는 전달받은 message를 POST한다. 응답 stream 이어가기와 모델 재생성·새 callTool 실행은 다르다. | [응답 stream 재개](https://github.com/modelcontextprotocol/typescript-sdk/blob/fcef852f6cdafea07f36cf6fae69b37c8adf85be/packages/client/src/client/streamableHttp.ts#L1005-L1018), [POST](https://github.com/modelcontextprotocol/typescript-sdk/blob/fcef852f6cdafea07f36cf6fae69b37c8adf85be/packages/client/src/client/streamableHttp.ts#L1055-L1063) | 소스 확인·해석 |
| <a id="E14"></a>E14 | CodeMode의 여러 내부 도구는 외부 execute의 context.id를 공유한다. 내부 호출 순번은 파일 정렬용으로만 쓰인다. MCP 설정 codemode가 registry options에 반영되므로 조직 도구의 `codemode:false`를 유지해야 호출 ID당 한 direct 도구라는 전제를 세울 수 있다. | [내부 context 공유](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/codemode/tool.ts#L139-L158), [서버 설정 전파](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/mcp/index.ts#L478-L494), [registry 반영](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/tool/mcp.ts#L55-L61) | 소스 확인·해석 |
| <a id="E15"></a>E15 | SDK callTool은 자체 params._meta와 호출별 options.headers를 전달할 수 있다. modern x-mcp-header mirroring은 지정 argument를 Mcp-Param-*으로 복제하는 별개 기능이며 임의 Idempotency-Key 주입 기능으로 간주하지 않는다. native OpenCode wrapper는 그 options를 공개하지 않는다. | [SDK callTool](https://github.com/modelcontextprotocol/typescript-sdk/blob/fcef852f6cdafea07f36cf6fae69b37c8adf85be/packages/client/src/client/client.ts#L2327-L2370), E05·E06 | 소스 확인·해석 |

## 현재 제품과의 대조

제품 기준 SHA는 `8c47977d2140a4aeebc516259541a1b821f0dde1`이다. 아래는 메인이 직접 확인한 제품 코드이며 upstream의 실행 검증으로 간주하지 않는다.

| 경계 | 현재 코드와 의미 | 근거 |
|---|---|---|
| OpenCode 연결 | MCP header는 Authorization뿐이고 `codemode:false`는 이미 설정한다. 외부 실행에서 생성하는 키를 이 설정의 고정 header로 대체할 수 없다. | [adapter 설정](https://github.com/babo-jeonguk/BaboJUBot/blob/8c47977d2140a4aeebc516259541a1b821f0dde1/packages/runtime/src/providers/opencode.ts#L321-L335) |
| 세션과 재시작 | adapter는 이전 세션을 열거나 새로 만들고 매번 `/prompt`를 보낸다. `nextSession: {id}`는 성공 종료에서만 반환한다. 서버 중단은 `sessionBefore`를 복원하므로 중단된 첫 실행의 새 세션 ID가 제품 DB에 저장됐다고 가정할 수 없다. 이전부터 알던 세션을 이어도 새 prompt와 모델 생성은 과거 호출 재전송이 아니다. | [세션 선택](https://github.com/babo-jeonguk/BaboJUBot/blob/8c47977d2140a4aeebc516259541a1b821f0dde1/packages/runtime/src/providers/opencode.ts#L344-L383), [prompt·완료](https://github.com/babo-jeonguk/BaboJUBot/blob/8c47977d2140a4aeebc516259541a1b821f0dde1/packages/runtime/src/providers/opencode.ts#L485-L503), [중단 복구](https://github.com/babo-jeonguk/BaboJUBot/blob/8c47977d2140a4aeebc516259541a1b821f0dde1/packages/core/src/run.ts#L416-L447) |
| MCP 수신 | header와 `params._meta["idempotency-key"]`를 받으며 둘이 다르면 거절한다. `arguments._meta`는 이 경로가 아니다. | [MCP dispatch](https://github.com/babo-jeonguk/BaboJUBot/blob/8c47977d2140a4aeebc516259541a1b821f0dde1/apps/server/src/mcp.ts#L118-L144) |
| 효과와 receipt | 에이전트별 같은 key의 도구·입력 digest·최초 결과를 효과와 같은 transaction에 저장한다. 동일 호출은 연구 기록·Event·깨우기를 추가하지 않는다. 단 유효 실행 시도·Role·단계 검사가 receipt 조회보다 먼저라서 단계가 바뀌어 금지된 호출까지 성공 응답을 보장하지 않는다. | [toolWrite](https://github.com/babo-jeonguk/BaboJUBot/blob/8c47977d2140a4aeebc516259541a1b821f0dde1/packages/db/src/tool-calls.ts#L103-L175) |
| 입력 digest | `JSON.stringify({params, body})`의 SHA-256이며 필드 순서와 생략 여부를 유지해야 한다. wrapper가 입력을 정규화하면 같은 키여도 충돌할 수 있다. 키는 printable ASCII 1–200자이며 `oc1:` + 구조화된 신원 tuple의 SHA-256 hex 형식은 제한 안에 든다. 구체 prefix·형식은 아직 권고다. | [digest](https://github.com/babo-jeonguk/BaboJUBot/blob/8c47977d2140a4aeebc516259541a1b821f0dde1/apps/server/src/tools.ts#L188-L201), [key schema](https://github.com/babo-jeonguk/BaboJUBot/blob/8c47977d2140a4aeebc516259541a1b821f0dde1/packages/contracts/src/tools.ts#L703-L709) |
| 가짜 프로바이더 | 받은 깨우기 묶음 hash+도구별 순번 키를 쓴다. 새 깨우기가 합쳐지면 키가 바뀌므로 이 구현의 결정적 시나리오를 모델 재생성의 일반 보장으로 확장하지 않는다. | [scripted 키 생성](https://github.com/babo-jeonguk/BaboJUBot/blob/8c47977d2140a4aeebc516259541a1b821f0dde1/packages/runtime/src/scripted.ts#L1003-L1015) |

## 호출 식별자의 수명

| 상황 | 유지되는 것 | 유지된다고 보장할 수 없는 것 | 근거 |
|---|---|---|---|
| 같은 native tool 실행 안의 MCP session-expired 재시도 | executor가 가진 sessionID·messageID·모델 call ID | SDK JSON-RPC id·MCP 연결 session id | E01·E11·E12 |
| SSE 응답 stream 재개 | 원래 요청과 응답의 연결 | 제품 효과가 한 번만 실행됐다는 사실 | E13 |
| 출력 이전 모델 요청 retry | assistant messageID | 새 공급자 응답의 tool ID; 단 이미 로컬 도구가 실행되기 전 분기 | E02·E10 |
| 일부 출력·도구 실행 뒤 모델 continuation | 기존 history의 과거 call ID | 새 messageID와 새 모델 call ID의 동일성 | E08·E10 |
| 같은 OpenCode session을 다시 실행 | 저장된 session history | 과거 stale 호출 재실행·동일 call ID 재생성 | E08·E09·E10 |
| 새 OpenCode session | 제품이 별도로 저장한 값만 재사용 가능 | OpenCode session/message/call ID와 과거 효과의 연결 | E01·E10; OpenCode 자체 연결 계약이 아니며 위 제품 복구 계약으로 구현 |

## 패턴

| ID | 패턴 | 장점 | 비용·실패 모드 | 근거 |
|---|---|---|---|---|
| P01 | 연결 전체 고정 키 | 전송 간단 | 두 번째 다른 쓰기 충돌; 같은 입력의 의도적 두 쓰기 억제 | #150, E06 |
| P02 | tool+내용 hash | 같은 내용 재전달 감지 | 의도적인 동일 내용 두 쓰기도 합침; 모델 표현·입력 변화는 놓침 | E02·E05에서 도출한 반례 |
| P03 | wakeup+tool별 순번 | 완전히 같은 순서의 mock replay에 적용 가능 | 새 깨우기 합침·호출 삽입·병렬 순서 변화 시 다른 의도와 충돌하거나 과거 효과 누락 | E10·E14에서 도출한 반례 |
| P04 | 제품 scope+안정적인 provider connection ID+session+assistant message+direct call ID | 같은 구체적 호출의 재전송과 동일 내용의 서로 다른 호출을 구분 | 모델 재생성은 새 ID로 중복 가능; CodeMode에서는 단독 사용 불가 | E01·E08–E14 |
| P05 | 제품이 영속화한 execution intent ID+도구·입력 snapshot | 새 토큰·프로세스에서도 모델 생성 없이 같은 의도 재전달 가능 | 모델 생성 전에 이미 수행한 효과와 새 제안의 의미적 동일성은 자동 해결 못 함; intent 생성·복구 계약 필요 | E09·E10; 별도 제품 설계 권고 |

## 조사에서 비교한 권고와 현재 범위

| ID | 권고 | 내용 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|
| D01 | 배제 | 고정 연결 키·내용 hash만·단순 순번·JSON-RPC id를 효과 식별자로 쓰지 않는다. | P01–P03·E12 반례. agent/org/run scope를 넣어도 의미적 동일성 문제는 남음. | Q2·Q3 |
| D02 | 변형 채택 권고 | 조직 direct 도구만 별도 execute wrapper로 감싸 모델에 키 생성을 맡기지 않고 호출별 키를 MCP params._meta 또는 per-call HTTP header에 넣는다. 조직·에이전트 scope와 안정적인 provider connection ID·sessionID·messageID·direct call ID를 묶고 버전 접두사+hash로 서버 형식 제한 안에 넣는다. 토큰·attempt ID·도구명·입력 digest는 키에 넣지 않아 같은 key의 다른 도구·입력을 서버가 충돌로 잡도록 한다. | E03–E07·E15. 기존 executor를 호출하는 방식만으로 metadata를 넣을 수 없으므로 자체 MCP 전송/상위 변경이 필요하다. | Q1 |
| D03 | 단독 범위로 채택하지 않음 | P04는 **같은 식별자의 구체적 호출을 재전송**하는 범위에 한정한다. 새 모델 생성에 의한 동일 효과 중복 방지는 별도 복구 설계로 둔다. | E09는 stale call을 재전송하지 않는다. 따라서 D02만으로 원래 SIGKILL 재현을 해결했다고 할 수 없다. | Q2·Q4 |
| D04 | #150 범위에 통합 확정 | 원래 SIGKILL 시나리오까지 #150에서 보장하려면 P05와 crash window 처리·불확실 결과 조회·새 모델 실행 제한을 요구에 추가한다. | 모델 호출 ID와 효과 ID의 수명이 다르다. 같은 문구가 의도적 두 쓰기인지 구별하려면 명시적 의도 계약이 필요하다. | Q2·Q4 |

## 구현 참고

- v1의 `tool.execute.before` 문자열 hook 예제를 v2.2.6에 그대로 적용하지 않는다. v2는 `ctx.tool.hook("execute.before", ...)`와 `ctx.tool.transform(...)`이다(E03·E07).
- wrapper는 조직 도구의 `codemode:false`를 유지하고, 기존 도구 입력·출력 변환, MCP isError/오류 응답, 취소 signal, timeout을 보존하는 계획이 필요하다. native executor의 permission.assert도 생략하지 않는 경로 또는 동등한 강제 수단을 명시한다. 제품 서버의 현재 토큰·조직·에이전트·stage 검사는 항상 적용한다(E04·E07·E14).
- header를 전역 설정으로 매 호출 변경하는 구현은 병렬 호출 간 key 오염을 만든다. 개별 요청 envelope 또는 개별 request options에서만 주입한다(E06·E15에서 도출한 권고).
- 새 토큰은 인증 수단이고 멱등 키의 identity가 아니다. 이미 생성한 동일 실행 의도를 유효한 새 토큰으로 재전달하는 계약은 가능하지만, 만료·취소된 토큰이나 종료 stage를 우회해 receipt를 읽게 만들지는 않는다.

### 결정적 fixture 계획

실제 모델 대신 고정 call frame을 내는 provider 또는 plugin executor fixture를 사용한다. 실제 OpenCode/plugin 검증과 BaboJUBot 서버 검증을 구분해 기록한다.

| ID | 입력 → 행동 → 기대 | 검증할 경계 |
|---|---|---|
| V01 | 동일 send_message call identity·입력을 두 번 전달 → 최초 receipt 반환, 메시지·Event·깨우기 증가 없음 | wrapper key+서버 receipt |
| V02 | 동일 record_artifact identity·입력을 두 번 전달 → 최초 artifact/receipt 반환, 산출물·Event 증가 없음 | artifact·receipt |
| V03 | 같은 내용이지만 서로 다른 direct call ID 두 개 → 두 효과 각각 수행 | P02 과도한 dedup 방지 |
| V04 | 같은 key에 입력·도구 변경 → idempotency_conflict, 두 번째 효과 없음 | 서버 충돌 |
| V05 | 같은 key 문자열을 다른 조직·에이전트에서 사용 → 허용된 각 scope의 독립 효과; 다른 조직 접근 거절 | 조직·에이전트 분리 |
| V06 | 같은 영속 intent를 새 attempt·새 유효 토큰으로 재전달 → 기존 receipt; 옛 만료·취소 토큰은 거절 | 인증과 identity 분리 |
| V07 | DB commit 직후 응답 전달 전 중단 → 재시작 후 **동일 intent를 모델 없이** 재전달하면 최초 결과·추가 효과 없음 | 보장 가능한 crash window |
| V08 | 같은 wakeup으로 모델을 다시 실행하되 call ID·순서·인자·합쳐진 입력을 변경 → 자동으로 과거 효과와 같다고 처리하지 않음; 명시한 복구 정책 수행 | D03/D04 경계·원래 재현 |
| V09 | session resume·new session 각각 과거 call ID와 새 call ID 생성 → concrete replay와 새 생성의 보장 차이를 assertion | E08–E10 |
| V10 | 조직 도구 codemode:false 확인; 반례로 하나의 execute에서 동일 도구 두 번 호출 → outer ID만으로는 충돌함을 확인 | E14 회귀 |
| V11 | metadata capture MCP 서버 → params._meta/header key 확인, arguments에 주입용 `_meta`가 섞이지 않음; 병렬 두 호출 key 격리 | 실제 envelope seam |
| V12 | 유효 토큰이더라도 연구 stage가 달라진 상태로 이전 intent 재전달 → 현재 승인·stage 정책을 통과하는지 확인, 정책 우회 금지 | 제품 불변 조건 |

| 범위 결정 기록 | owner | 선택과 후속 |
|---|---|---|
| #150 보장을 동일한 구체적 호출 재전송으로 먼저 제한할 것인가, 모델 재생성 복구까지 포함할 것인가? | 사용자 / #150 | D04까지 #150에 포함한다. #161은 통합 종료했다. 현재 사용자 확정 계약과 Agent Brief가 기준이며, 구체 저장 구조·API와 제한된 재시도 횟수는 구현자가 정한다. 소스 조사와 계약 확정만으로 구현이 완료된 것은 아니다. |

## 이번 조사에서 실행한 검증

- 제품 SHA: `8c47977d2140a4aeebc516259541a1b821f0dde1`. 작업 시작 당시 `docs/README.md` 수정과 `docs/research/issue-148-references.md` 미추적 파일이 있었으며 보존했다. 이번 변경은 조사 문서와 문서 지도뿐이다.
- 명령: `pnpm --filter @babojubot/server exec vitest run test/idempotency.test.ts test/mcp.test.ts test/file-artifacts.test.ts`
- 결과: **3개 파일, 5개 테스트 통과**, 종료 코드 0. 기존 HTTP 키 재호출·충돌·Event/깨우기 중복 억제, MCP/HTTP receipt 공유·조직 접근 거부, 파일 삭제 후 산출물 receipt 재호출을 확인했다.
- 이는 기존 서버에 키를 전달한 상태의 검사다. OpenCode 자동 키 생성·주입, 새 토큰을 이용한 재시작 복구, V01–V12 전체가 검증됐다는 뜻은 아니다. 실제 plugin wire capture와 원래 SIGKILL 시나리오는 미실행이다.
- upstream 원문을 메인이 재열람했다: v2 hook·tool.transform, native MCP executor/client, CodeMode context 전파, stale 호출 정리·새 메시지 ID, 올바른 modular SDK의 counter·callTool options.

## 기록 검사 결과 — 2026-11-11

#150 본문·Agent Brief·label과 #161 본문·label을 다시 조회해 사용자 결정 및 범위 분리가 일치함을 확인했다. `pnpm check`와 `git diff --check`도 통과했다. 제품 코드·테스트·설정 변경은 없으며 이번 작업에서 실제 모델·SIGKILL 또는 제품 테스트를 새로 실행하지 않았다. 앞 절의 기존 서버 검사 결과와 이번 문서 검사를 구분한다.

## 한계와 미확인

- 이 문서의 upstream 근거는 고정 SHA **소스 확인**이다. 공개 소스 외 계정·자격 증명·유료 API는 사용하지 않았다.
- 실제 OpenCode 프로세스·plugin/MCP wire payload·모델·SIGKILL을 실행하지 않았다. V01–V12는 실행 결과가 아닌 계획이다.
- 새 모델이 같은 효과를 제안했을 때 이를 기존 의도로 재결합할 수 있다는 보장은 확인하지 못했다. 모델의 지침 준수나 내용 hash로 이를 대신하지 않는다.
- OpenCode 버전 변경 시 hook signature, MCP metadata, CodeMode inner ID, stale-call 처리와 SDK patch를 재확인한다. upstream 코드는 제품에 복사하지 않았다.

## Q1~Q3 기록 검사 — 2026-11-11

실행 의도 정의를 GLOSSARY에 추가하고 #150 본문·댓글에 사용자 확정을 반영했다. `git diff --check`는 통과했다. `pnpm check`는 이번에 수정하지 않은 `docs/research/issue-149-references.md:34`의 Git 무시 폴더 경로 검사에서 실패했다. 제품 코드·테스트·설정과 실제 모델은 실행하지 않았다.

## 복구 결과 전달·실행 차단 추가 확인 — 2026-11-11

- OpenCode v2.2.6의 `session.synthetic`는 `resume:false`로 입력을 영속 대기시킬 수 있고 모델을 깨우지 않는다. 이는 history의 과거 tool part를 성공 결과로 제자리 수정하는 API가 아니다. 복구 정산 후 안정적인 입력 ID로 확정 결과를 전달하는 후보이며 실제 모델 요청의 순서·중단 회귀는 아직 미실행이다. [구현](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/session/session.ts#L286-L325), [첫 입력 보존](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/session/inbox.ts#L176-L225).
- 현재 제품의 `serve --stdio`는 managed service의 부팅 시 orphaned execution 자동 resume 경로와 구분된다. managed lifecycle이 있을 때만 restart continuity가 설치되며, 자체 Schedule은 모든 서버 모드에서 시작한다. 제품이 통제하지 않는 모델 호출로 복구 전 차단이 우회되지 않는지 구현에서 검증해야 한다. [service 모드 구분](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/cli/src/server-process.ts#L68-L73), [설치 조건·Schedule](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/server/src/process.ts#L113-L120).
- 기존 failed Run과 Inbox 항목은 진행 차단 수단이 아니다. `claimNextRun`은 조직 단계·agent.paused·진행 중 실행 시도 등을 확인하며 과거 실패나 Inbox 읽음 상태로 admission을 막지 않는다. Q5를 만족하려면 복구 상태를 반영한 강제 차단이 필요하다. 기존 실패 Inbox 표시는 사용할 수 있지만 그것만으로 Q5를 충족했다고 할 수 없다.
- 메인이 `session.synthetic`, service 모드 분기·restart continuity 설치 조건, 제품 `claimNextRun`·Inbox 실패 목록을 원문으로 재확인했다. 제품 구현·실제 모델·새 무모델 fixture 실행은 하지 않았다.

## 최종 triage 정리 — 2026-11-11

Q9에 따라 파일 산출물은 최초 쓰기 전에 고정한 바이트를 사용하며 복구 시 현재 경로 내용으로 대체하지 않는다. Q1~Q9의 확정 계약을 본문과 누적 Agent Brief에 같은 기준으로 정리했다. 이슈 댓글은 현재 계약과 기술 조사 두 개만 유지한다. 제품 구현·새 복구 fixture·실제 모델 검증은 이번 정리 작업에서 실행하지 않았다.

## 구현 기록 — 2026-11-11

이 절은 구현 PR이 채택한 근거와 검증 범위다. 현재 동작은 [현재 구현 현황](../current-implementation.md)이 맡는다.

| 결정 | 채택·배제 | 근거 |
|---|---|---|
| 실행 의도 저장 | P05 채택. 기존 `tool_operations`를 실행 의도 저장으로 넓혀(migration 0032) 제품 발급 ID·고정 입력(JSON 표기 그대로)·원본 자료·상태(`accepted`·`completed`·`refused`·`abandoned`)를 둔다. 키는 에이전트마다 하나이며 키 없는 쓰기도 의도로 남는다. | 확정 계약 1–3, 입력 digest 절 |
| 효과 전 기록 | 도구 경로가 Role·단계·입력 검사 → 원본 자료 읽기(파일 경로 산출물) → 의도 수락 commit → 효과의 순서로 처리한다. 효과와 정산은 `toolWrite`의 한 transaction이다. | 확정 계약 2·3 |
| 완료 결과 조회 | 같은 키의 정산한 의도는 Role·단계 검사 전에 최초 결과를 돌려준다. 수락만 한 의도는 지금 규칙으로 수행하거나 확정 거절한다. 토큰 인증은 그대로다. | 확정 계약 5, 이 문서의 `toolWrite` 대조 |
| 복구 순서 | 서버 재시작으로 끝난 실행 시도에 의도가 있으면 복구 깨우기를 남기고, 그 깨우기를 받은 실행 시도가 모델을 부르기 전에 정산한 뒤 결과를 깨우기 사유로 넘긴다. 전달 신원은 깨우기이므로 재중단 때 기존 재대기 규칙으로 한 번만 다시 받는다. | 확정 계약 4·6 |
| 결과 전달 수단 | `session.synthetic`(resume:false)는 쓰지 않았다. 깨우기 사유는 모든 프로바이더의 요청에 이미 실리고 재중단 의미가 정해져 있으며, OpenCode 세션을 이어 갈 수 없어 새 세션을 만들 때도 같은 내용이 간다(확정 계약 7). | 복구 결과 전달 절 |
| 키 주입 | D02 변형 채택. 실행마다 `OPENCODE_CONFIG_DIR/plugins/`에 plugin을 써 넣고 `ctx.tool.transform`·`editor.update`로 조직 도구 실행만 바꾼다. 키는 `oc1:` + SHA-256(세션·assistant 메시지·호출 ID)이며 `params._meta`에 넣는다. 제품 서버는 상태 없는 MCP라 plugin이 `tools/call`을 직접 보낸다. 원래 실행처럼 `permission.assert`를 먼저 부른다. 연결 header `babojubot-call-key: required`로 plugin이 빠진 키 없는 쓰기를 서버가 거부한다. | E03–E07·E14·E15 |
| 고정 header·내용 hash·순번·JSON-RPC id | 배제(D01). 가짜 프로바이더의 묶음 hash 키는 시험용으로 남기되 복구 깨우기를 셈에서 뺀다. | P01–P03·E12 |

OpenCode v2.2.6 plugin API의 세부(설정 폴더 `plugins/` 자동 읽기, 기본 내보내기 `{ id, setup }`, 도구 ID `organization_<도구>`·`options.namespace`, 바꾼 실행이 `output`을 돌려줘야 함, transform 등록 순서)는 위 SHA의 `core/src/plugin/source-directory.ts`, `core/src/plugin/module.ts`, `plugin/src/promise/tool.ts`, `core/src/tool/mcp.ts`, `core/src/tool/runtime.ts`, `core/src/state.ts`를 조사 보조 에이전트가 읽어 보고했다. 메인은 같은 SHA의 clone에서 `source-directory.ts`(`plugin`·`plugins` 폴더의 `.ts`·`.js` 자동 읽기), `promise/tool.ts`(editor·`ToolContext`의 `signal`), `tool/mcp.ts` 50–70행(MCP 도구 등록·`permission.assert`·`output` schema)을 직접 읽었고, 나머지는 실제 OpenCode 2.2.6 실행으로 확인했다. transform 등록 순서는 소스에서 보장되지 않아 plugin이 도구를 보지 못했으면 다시 등록한다. 목록 바뀜 알림(`ctx.event.subscribe`의 `mcp.tools.changed`)을 plugin이 실제로 받는지와 글이 아닌 MCP 결과 조각의 변환은 확인하지 않았다(제품 서버는 글과 `structuredContent`만 보낸다).

검증 범위(Linux, 이 커밋 기준): 일회용 embedded Postgres와 가짜 프로바이더로 중단 지점별 복구·반복 중단·동시 재전송·단계 변경·취소·일시정지·조직 분리·복구 멈춤과 재시도(`apps/server/test/intent-recovery.test.ts`), 기존 SIGKILL 서버 재현의 복구 깨우기(`recovery.test.ts`), 실제 OpenCode 2.2.6과 이 컴퓨터의 가짜 모델로 병렬·다음 메시지 호출의 키 분리와 입력 비오염(`opencode-real-cli.test.ts`), plugin 단위 시험. 실제 모델·실제 OpenCode 실행 중 SIGKILL·macOS/Windows는 실행하지 않았다.
