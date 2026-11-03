# OpenCode 2.x의 기본 지침과 제품 지침

조사일: 2026-11-03. 질문: OpenCode에 한해 기본 system prompt를 우리 지침으로 교체해야 하는가? [#98–101 조사](issue-98-101-references.md)의 R4를 보충하는 소스 조사이며 아래 조사 뒤 사용자는 기본 지침 유지 + 세션 지침 API 추가(Paseo 방식)를 확정했다. #101의 agent 정의 경로 대신 이 경로를 쓴다. 실제 프로바이더·모델은 실행하지 않았다.

## 결론과 권고

**교체는 가능하지만, 현재 레퍼런스에 맞추려면 기본 지침을 보존하고 session instructions로 우리 지침을 추가하는 편이 낫다.** Paseo의 OpenCode **v2** 구현이 이미 이 방법을 쓴다. 따라서 기본값을 직접 복제하거나 OpenCode만 교체 예외로 둘 필요가 없다. 아래의 조립 경로를 근거로 한 권고이며 모델의 지침 준수 품질을 실험한 결과는 아니다.

## 확인한 구현

| 대상·고정 버전 | 실제 전달 방식 | 기본 지침과의 관계 |
| --- | --- | --- |
| OpenCode 2.2.5, `9bbb8ce18c80f099e0e448775f59d965ead40a21` | `agents.<id>.system`을 `agent.system`에 대입한다. `baseTranscript`가 그 값 또는 native 기본 prompt 중 하나를 첫 system part로 선택하고, 별도로 initial Instructions를 다음 system part에 넣는다. | `agent.system`은 **교체**다. session instructions는 별도 추가 경로다. [설정](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/config/plugin/agent.ts#L98-L126), [조립](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/model-request.ts#L101-L128) |
| Paseo `efc64a5443dfe166dfb0d80434ecb48516b8fbe2`, OpenCode v2 경로 | `systemPrompt`와 `daemonAppendSystemPrompt`를 합쳐 `session.instructions.entry.put({sessionID, key: "paseo", value: system})`로 넣는다. | 이 경로는 `agent.system`을 교체하지 않는다. 이름이 systemPrompt여도 전달 seam은 session instructions다. [v2/session.ts](https://github.com/getpaseo/paseo/blob/efc64a5443dfe166dfb0d80434ecb48516b8fbe2/packages/server/src/server/agent/providers/opencode/v2/session.ts#L179-L188), [문자열 합성](https://github.com/getpaseo/paseo/blob/efc64a5443dfe166dfb0d80434ecb48516b8fbe2/packages/server/src/server/agent/system-prompt.ts#L1-L11) |
| Paperclip `def4726bea0e3b340457100038d80ca55c2b7d4f`, opencode-local | instructions 파일 내용을 작업 prompt 앞에 붙여 `opencode run --format json`의 stdin으로 보낸다. | 이 주입 경로 자체는 native system prompt 교체가 아니다. 작업 입력에 넣는 방식이라 Paseo의 system instructions와는 계층이 다르다. 별도 사용자 설정·extraArgs가 기본값을 바꾸지 않는다는 보장은 아니다. [파일 읽기·합성](https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/packages/adapters/opencode-local/src/server/execute.ts#L527-L596), [실행·stdin](https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/packages/adapters/opencode-local/src/server/execute.ts#L619-L678) |

## 교체할 때 실제로 없어지는 것

OpenCode 2.2.5의 native 기본 prompt는 짧지만 harness 안내, system-reminder 처리, 병렬 도구 호출, 명확한 경로·간결한 소통, 코드베이스 관례와 낯선 사용자 파일 보존을 담는다. 사용 가능한 shell/write/edit에 따라 도구 사용 안내도 붙인다. `agent.system`을 지정하면 이 기본 블록과 동적 안내를 우회한다. [기본 본문](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/runner/prompt/system.txt), [도구별 렌더링](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/system-prompt.ts#L3-L27)

다만 교체해도 모든 내장 지침이 사라지는 것은 아니다. MCP·references·skills·discovery·builtins·session entries는 별도로 합쳐진다. session entry는 `api/<key>` 지침 소스로 읽히고 `<context key="…">` 블록으로 렌더링된다. [context 합성](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/context.ts#L137-L181), [entry 렌더링](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/instruction-entry.ts#L77-L104)

## 적용 범위와 미확인 사항

- BaboJUBot은 `agent.system`을 비워 native 기본값을 쓰고, 실행 시작 전에 session entry 하나에 Role → Soul → Skill 순서의 제품 지침을 넣는 방식이 적합하다. 초기 session 주입 뒤 첫 모델 요청으로 이어지는 순서는 구현에서 검증해야 한다.
- Paseo의 고정 SDK는 `@opencode/client` 2.0.10이다. 그 API 사용 사례와 위 2.2.5 소스를 함께 확인했으며, OpenCode 1.x의 `agent.prompt`나 다른 버전으로 일반화하지 않는다. [Paseo 의존성](https://github.com/getpaseo/paseo/blob/efc64a5443dfe166dfb0d80434ecb48516b8fbe2/packages/server/package.json#L117-L118)
- 서버 응답·첫 요청의 실제 wire payload·resume/compaction 이후 지침 유지·모델 준수율은 실행하지 않았다. 제품 결정은 기본 지침 보존으로 확정됐으며 실제 모델 지침 준수 검증은 보류 상태다. 조직 경계·승인은 어느 쪽에서도 제품 코드가 강제한다.

원본 소스는 기존 `.reference-cache/src/` 사본에서 읽었다. upstream 코드는 복사하지 않았다.
