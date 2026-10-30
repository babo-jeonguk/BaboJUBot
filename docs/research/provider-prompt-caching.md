# 프로바이더 프롬프트 캐시와 압축 조사: 몇 시간 뒤 같은 작업을 이어갈 때 세션을 재개할지, 새로 시작할지, 미리 압축할지

조사일: 2026-10-30. 대상: Claude Code·Codex·OpenCode·Antigravity 네 **프로바이더**를 사용자의 구독 계정으로 로그인해 실행 시도마다 띄우고, 실행 시도가 끝나면 프로세스를 닫는 현재 연결 방식([프로바이더 연결 방식 조사](provider-connection-references.md))이다. 세션은 (에이전트, 작업)마다 보관하고 같은 작업의 다음 실행 시도에서 재개한다. 구현 전 기술 조사이며 확정 결정이 아니다.

배경 장면: 작업자가 10:00에 실행 시도를 마치고 Lead의 답을 기다린다. 15:00에 같은 작업으로 다시 깨어나 세션을 재개한다. 그 사이 프로바이더의 프롬프트 캐시가 만료됐다면, 재개 첫 요청은 지금까지의 대화 전체를 캐시 할인 없이 다시 입력으로 처리한다. 대화가 클수록 구독 한도를 크게 소모한다.

이 문서가 답하는 질문(프로바이더마다):

1. **캐시 방식.** 자동인가 명시인가, 캐시 유지 시간(TTL)은 얼마인가, 구독 로그인이 TTL을 바꾸는가, 환경 변수·설정으로 정할 수 있는가, 무엇이 캐시되는가(시스템 프롬프트·도구·대화 앞부분).
2. **TTL이 지난 뒤 재개.** 대화 전체를 다시 보내는가, 서버 쪽 상태(`previous_response_id`, 서버 대화, 서버 압축)로 다시 보내지 않는가. 사용자 주장 (a) "Codex는 TTL이 지나도 캐시 가격을 유지한다"의 근거가 여기에 있다.
3. **구독 한도.** 구독 로그인에서 캐시 적중 입력과 캐시 실패 입력이 한도를 다르게 소모하는가.
4. **압축.** 자동 압축 시점(크기 기준, 유휴·TTL 기준), 비대화·양방향 연결에서 수동 압축을 보낼 수 있는가, 압축 자체의 비용, 결과(같은 세션 ID인가). 사용자 주장 (b) "Claude Code는 기본으로 캐시 만료 직전에 자동 압축한다"를 우리 연결 방식에서 쓸 수 있는가.
5. **새 세션 사이의 앞부분 캐시.** 지침·도구가 같은 새 세션이 다른 세션의 캐시를 읽는가. 읽는다면 "조직 기록으로 새 세션 시작"이 싸다.

근거 수준 표기: **[소스]** 고정 SHA 코드 또는 설치 바이너리(문자열·내장 changelog)에서 읽은 사실, **[문서]** 공식 문서·공식 변경 기록의 주장, **[실측]** 이 PC에 남아 있는 프로바이더 로컬 기록의 숫자 메타데이터(프롬프트 본문·자격 증명은 열지 않음), **[추론]** 위 근거에서 끌어낸 판단, **[미확인]** 확인하지 못한 것.

## 기준 버전과 조사 방식

모델을 호출하지 않았고, 로그인하지 않았고, 자격 증명 파일을 열지 않았다. 코드는 정적으로 읽었다. 버전·소스는 [프로바이더 기능 조사](executor-capabilities.md#기준-버전)와 같다.

| 대상 | 버전 | 근거 | 읽은 범위 |
|---|---|---|---|
| Claude Code | 2.1.312 (`~/.local/share/claude/versions/2.1.312`, 빌드 GIT_SHA `f375cd85…`) | 소스 비공개. 바이너리 문자열, [CC 문서](https://code.claude.com/docs/en/prompt-caching) | prompt-caching, costs, agent-sdk/cost-tracking·skills(명령)·modifying-system-prompts, settings-reference, [v2.1.299 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.299). 바이너리의 idle compaction·sleep compaction 코드 |
| Codex CLI | 0.165.0 | [openai/codex `360319d8dee62d87e2d59fc0c21805d79519cfed`](https://github.com/openai/codex/tree/360319d8dee62d87e2d59fc0c21805d79519cfed) (Apache-2.0) | `core/src/client.rs`, `codex-api/src/common.rs`, `compact_remote_v2*.rs`, `app-server-protocol`, `model-provider` |
| OpenCode | 1.18.23 | [anomalyco/opencode `ef2880f379129aa048be9e9353e30aa168d42c17`](https://github.com/anomalyco/opencode/tree/ef2880f379129aa048be9e9353e30aa168d42c17) (MIT) | `provider/transform.ts`, `session/{prompt,compaction,overflow,system,message-v2}.ts`, `plugin/openai/codex.ts`, server routes, docs `.mdx` |
| Antigravity CLI (`agy`) | 1.4.10 | 소스 비공개. 바이너리 문자열·내장 proto 설명자·`agy changelog`, [AG 문서](https://antigravity.google/docs/cli/headless) | 요청 형식, 압축 설정, slash command, 로컬 대화 DB의 사용량 숫자 |
| 사용자 프로젝트 | Auto Compact for Claude (Paseo 플러그인) | 공개 저장소 [`babo-jeonguk/paseo-auto-compact-for-claude`](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/tree/4039afd9e5bdc1f9f184541022352bee8d242cde)(v1.0.0)와 비공개 개발 작업 공간(로컬, 2026-10-30 열람) | `README.md`, `paseo-auto-compact-for-claude/{README,docs/runtime}.md`, `docs/research/idle-compact-reference-review-2026-10-22.md` |

링크 약어: **CC** = `https://code.claude.com/docs/en/`, **CX** = `https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/`, **OC** = `https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/`, **AG** = `https://antigravity.google/docs/`.

## 한눈 비교

| 질문 | Claude Code | Codex | OpenCode | Antigravity |
|---|---|---|---|---|
| 1. 캐시 방식·TTL | 자동(Claude Code가 `cache_control` 부착). 구독 한도 안에서는 본 대화 **1시간**, 그 밖(하위 에이전트·압축 요청 등)은 5분. 한도 초과로 usage credits를 쓰면 본 대화도 5분. `promptCacheTtl`·`CLAUDE_CODE_PROMPT_CACHE_TTL`·`ENABLE_PROMPT_CACHING_1H`·`FORCE_PROMPT_CACHING_5M`으로 지정 [문서] | 자동(서버가 앞부분 캐시). Codex는 TTL 옵션을 보내지 않고 `prompt_cache_key` = 루트 thread ID만 보냄 [소스]. ChatGPT 백엔드의 보존 시간은 공식 문서에 없음 [미확인] | OpenCode가 공급자별로 표시를 붙임. Anthropic 계열은 시스템 앞 2개+마지막 2개 메시지에 `ephemeral`(TTL 미지정 → 5분 [추론]), OpenAI 계열은 `promptCacheKey` = 세션 ID [소스]. TTL 설정 항목 없음 | 자동(implicit) 앞부분 캐시만 사용, 명시 캐시 생성 호출 없음 [소스]. TTL 비공개. Vertex 문서는 "최대 24시간, 대부분 그 전에 삭제" [문서]. 7.9시간 뒤 재개 요청은 적중 0 [실측] |
| 2. TTL 뒤 재개 | 대화 전체를 다시 보냄. 바뀌지 않았고 TTL 안인 앞부분만 캐시에서 읽음 [문서] | 전체 기록을 다시 보냄(`store:false`, HTTP에 `previous_response_id` 없음). 증분 전송은 살아 있는 WebSocket 연결 안에서만 [소스]. "로그인 사용자는 캐시 영구 보존" 주장은 OpenAI 임원 X 게시물뿐 [미확인] | 매 요청 로컬 DB에서 대화 전체를 다시 조립해 보냄. 서버 상태 미사용 [소스] | 전체 기록을 다시 보냄(Code Assist `streamGenerateContent`의 `contents`) [소스·실측] |
| 3. 구독 한도에서 캐시 적중분 | "캐시 토큰 단가로 다시 읽어" 한도를 소모한다는 문서 문장 있음. 정확한 배율 [미확인] | 크레딧 단가표에서 캐시 입력은 입력의 1/10(일부 1/20), 캐시 쓰기 요금 없음. 단 "크레딧 단가만으로 구독 포함 사용량이 정해지지 않는다" [문서] | 로그인 종류에 따름. Go는 한도를 달러로 정하고 캐시 읽기 단가가 따로 있음 [문서]. ChatGPT·Copilot 경로 [미확인] | 2026-05 공식 블로그: 한도를 "API 가격 기준으로 차감"(입력·출력·캐시 읽기 비율 언급) [문서]. 캐시 배율 명시 문장 없음 [미확인] |
| 4. 압축 | 크기 기준 자동 압축 + **터미널 대화형 전용** 유휴 압축(200K 이상, 약 54분). `-p`·Agent SDK에서는 유휴 압축이 동작하지 않음 [소스]. `/compact`는 stream-json·SDK 입력으로 보낼 수 있고 `compact_boundary`로 확인, 같은 세션 [문서] | 컨텍스트 창의 90%에서 자동 [소스]. 유휴·TTL 기준 없음 [소스]. app-server `thread/compact/start {threadId}` 수동 압축, 같은 thread [소스·문서]. 압축 요청은 일반 턴과 같은 앞부분 → 캐시가 살아 있으면 적중 [소스·추론] | 사용 가능 토큰 초과 시 자동(`compaction.auto`), 유휴·TTL 기준 없음 [소스]. `POST /session/:id/summarize` 수동 압축, 같은 세션 [소스·문서]. 압축 요청은 **본 대화와 앞부분이 다름**(도구 없음, 기록을 텍스트로 붙임) → 캐시를 거의 못 씀 [소스·추론] | 토큰 임계값 기준 자동 [소스]. 유휴·TTL 기준 없음 [소스]. `/compact`는 대화형에서 확인, `-p`·stream-json에서 동작 여부 [미확인] |
| 5. 새 세션 간 앞부분 캐시 | API 캐시는 조직 안에서 앞부분이 같으면 공유. Claude Code는 시스템 프롬프트에 auto memory 경로, 대화 첫머리에 cwd·git 상태가 들어가 기계·디렉터리 단위로 갈림. SDK `excludeDynamicSections`/`--exclude-dynamic-system-prompt-sections`로 시스템 프롬프트를 고정 가능 [문서] | thread마다 `prompt_cache_key`가 다르고, OpenAI 문서상 키가 다르면 캐시 집계가 분리 → 새 thread는 다른 thread 캐시를 거의 못 읽음 [소스·문서·추론] | Anthropic 계열은 키가 없어 앞부분이 같으면 공유 가능, 단 시스템 프롬프트에 **오늘 날짜**가 들어감. OpenAI 계열은 세션 ID 키로 분리 [소스·추론] | 자동 캐시는 요청 단위 앞부분 일치. 새 대화 첫 요청 65건 중 2건만 약 8K 적중 [실측]. 몇 시간 간격이면 기대하기 어려움 [추론] |

## 1. 캐시 방식과 TTL

### Claude Code

- [문서] 매 요청에 시스템 프롬프트·프로젝트 맥락·이전 대화 전체를 다시 보내고, API가 앞부분(prefix) 일치로 캐시를 읽는다. 층 순서는 시스템 프롬프트(핵심 지침·도구 정의) → 프로젝트 맥락(CLAUDE.md·auto memory) → 대화. 앞부분 어디가 바뀌면 그 뒤가 모두 다시 계산된다. [CC prompt-caching "How the cache is organized"](https://code.claude.com/docs/en/prompt-caching#how-the-cache-is-organized)
- [문서] TTL은 요청 묶음별로 정해진다. "Main conversation: your interactive turns, non-interactive `-p` runs, and Agent SDK turns"와 "Everything else: … subagents, workflows, … forks, compaction, and session titles". 기본값 표: 구독 한도 안이면 본 대화 1시간, 그 밖은 5분(서버가 정한 일부 보조 요청만 1시간). API key·usage credits·클라우드는 모두 5분. "Once you go over your plan's usage limit and Claude Code draws on usage credits … drops the main conversation to the five-minute TTL." [CC "Which TTL each request gets"](https://code.claude.com/docs/en/prompt-caching#which-ttl-each-request-gets)
- [문서] 직접 지정(v2.1.242+): 본 대화 `promptCacheTtl` 설정 또는 `CLAUDE_CODE_PROMPT_CACHE_TTL`, 그 밖 `subagentPromptCacheTtl` 또는 `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`. 값은 `5m`·`1h`만. 우선순위: `FORCE_PROMPT_CACHING_5M=1` → 묶음별 env → 묶음별 설정 → 하위 에이전트 frontmatter `cacheTtl` → `ENABLE_PROMPT_CACHING_1H=1` → 기본값. [CC "Choose the TTL yourself"](https://code.claude.com/docs/en/prompt-caching#choose-the-ttl-yourself)
- [문서] 실제 TTL 확인: 결과의 `usage.cache_creation`에서 `ephemeral_1h_input_tokens`·`ephemeral_5m_input_tokens`. stream-json 결과에도 같은 usage가 실린다. 사용자 프로젝트도 transcript의 이 값으로 TTL을 읽는다([runtime.md "Cache evidence"](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/blob/4039afd9e5bdc1f9f184541022352bee8d242cde/docs/runtime.md)).
- [문서] 캐시 타이머는 "Each request that hits the cache resets the timer". 즉 마지막 요청 시각부터 TTL이 흐른다.

### Codex

- [문서] OpenAI 캐시는 기본 자동이다("OpenAI chooses breakpoint locations out of the box"). 캐시 재사용은 "the entire rendered prefix to match"이며, 렌더링 순서는 숨은 지시 → developer 메시지 → tools → 기록. [OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
- [소스] 요청 본문은 `store: false`, `include: ["reasoning.encrypted_content"]`, `prompt_cache_key`를 보낸다([CX `core/src/client.rs` L1112-L1129](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/core/src/client.rs#L1112-L1129)). `prompt_cache_retention`·`prompt_cache_options`는 코드 어디에도 없다(검색 0건). 따라서 Codex 쪽에서 TTL을 정하는 설정·env는 없다.
- [소스] `prompt_cache_key` 기본값은 세션(루트 thread) ID, 내부 하위 세션은 `"{source}:{parent_thread_id}"`([CX `client.rs` L657-L678](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/core/src/client.rs#L657-L678)). 재개 시 rollout의 `SessionMeta`에서 같은 ID를 복원하므로 키가 유지된다(`core/src/session/session.rs` L971-L993). ChatGPT 로그인은 기본 주소가 `https://chatgpt.com/backend-api/codex`이고, 주석 "ChatGPT derives cache affinity from the Responses session-id header"대로 같은 값을 `session-id` 헤더로도 보낸다(`client.rs` L680-L688, `model-provider-info/src/lib.rs` L432-L450).
- [소스] 앞부분 순서: `tools` 필드, `input` 맨 앞에 base instructions(developer 메시지, id는 thread ID 기반 UUIDv5), 그 뒤 전체 기록(`client.rs` L1008-L1042).
- [문서] API 쪽 보존 시간(참고, ChatGPT 백엔드와 같다는 근거는 없음): GPT-5.6 이후 기본 `"30m"`, Responses API에서 `"12h"` 선택 가능(쓰기 1.25배/2.5배, 읽기 0.1배). 이전 모델 `in_memory`는 "around 5 to 10 minutes of inactivity, up to one hour", `24h`는 최대 24시간. "Cache entries are not stored indefinitely." [guide](https://developers.openai.com/api/docs/guides/prompt-caching), [API changelog 2026-10-20 "12-hour prompt caching"](https://developers.openai.com/api/docs/changelog)

### OpenCode

- [소스] 기본 실행 경로는 AI SDK. `applyCaching`이 앞쪽 시스템 메시지 최대 2개와 마지막 비시스템 메시지 2개에 표시를 붙인다. Anthropic·OpenRouter는 `cacheControl {type:"ephemeral"}`, Bedrock은 `cachePoint`, Copilot은 `copilot_cache_control`. 도구 정의에는 붙이지 않는다([OC `provider/transform.ts` L359-L405](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/provider/transform.ts#L359-L405), 적용 조건 L466-L485).
- [소스·추론] 표시에 `ttl`이 없어 Anthropic 기본 5분이다. OpenCode 자체의 TTL 설정·env는 없다. 모델·agent 옵션에 `cacheControl`을 주면 개별 표시 대신 Anthropic 자동 캐시 경로를 쓰며, 내장 `@ai-sdk/anthropic`은 `{type:"ephemeral", ttl:"1h"}` 형식을 받는다(`transform.ts` L469-L482, 실제 요청은 미검증).
- [소스] OpenAI 계열은 `store=false`, `promptCacheKey = sessionID`(`transform.ts` L1171-L1184, L1260-L1273). provider 옵션 `setCacheKey:false`로 끌 수 있다([config 문서](https://opencode.ai/docs/config/)).
- [문서·소스] **구독 로그인 범위가 다르다.** Claude Pro/Max 로그인은 1.3.0부터 내장되지 않는다: "Anthropic explicitly prohibits this. Previous versions of OpenCode came bundled with these plugins but that is no longer the case as of 1.3.0"(`packages/web/src/content/docs/providers.mdx` L357-L368). 내장 구독 로그인은 ChatGPT Plus/Pro(Codex OAuth 플러그인, `plugin/openai/codex.ts` L323-L433), GitHub Copilot, GitLab Duo, SuperGrok, OpenCode Zen·Go다. 따라서 OpenCode의 캐시 동작은 고른 모델의 공급자를 따른다.

### Antigravity

- [실측] 구독 로그인은 Code Assist 백엔드(`cloudcode-pa.googleapis.com/v1internal:streamGenerateContent`)를 쓴다. generativelanguage·Vertex 직접 호출 흔적은 없다.
- [소스] 요청은 Code Assist 요청이 Vertex `GenerateContentRequest`를 감싼 구조다. 안쪽에 `contents`(반복)·`system_instruction`·`tools`·`cached_content`·`implicit_cache_config`가 있지만 agy 코드에서 cachedContents 생성 호출은 찾지 못했다. Claude 모델용 `cache_control` 부착 함수는 따로 있다.
- [문서] Gemini 자동 캐시: "Implicit caching is enabled by default for all Gemini 2.5 and newer models", "Try to send requests with similar prefix in a short amount of time". TTL은 적혀 있지 않다. [Gemini API caching](https://ai.google.dev/gemini-api/docs/caching). Vertex: "Implicit caching provides a 90% discount", "A cached prefix expires no later than 24 hours after it's created, and most entries are evicted earlier." [Vertex context cache overview](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview)
- [소스] agy 쪽 TTL 설정은 없다. 이름만 확인된 `prompt_cache_keep_alive`·`prompt_cache_keep_alive_max_pings`(실험 플래그로 보임)와 `TRUNCATION_REASON_PROMPT_CACHE_TTL_EXPIRED` enum이 있으나 의미·활성 여부는 [미확인].
- [실측] 한 대화 안에서는 캐시 읽기량이 약 4K 단위로 늘어나며 적중한다. 약 7.9시간 쉬고 보낸 요청은 32,242 토큰 전부 캐시 실패였다. 5시간 간격 표본은 없다.
- [소스] 내장 changelog: JSON·stream-json usage에 `cache_read_tokens`가 실린다("so non-interactive consumers can attribute prompt-cache hits").

## 2. TTL이 지난 뒤 재개: 기록을 다시 보내는가

- **Claude Code** [문서]: "When you resume a session, Claude Code sends the whole conversation again, and the request reads from the cache whatever part of its prefix is unchanged and still within the cache lifetime." 재개한 대화는 처음 기록한 시스템 프롬프트를 유지하므로(업그레이드·`--append-system-prompt` 변경은 압축 또는 새 대화 때 적용), TTL 안이면 다른 프로세스에서 재개해도 앞부분이 맞는다. [CC "Resuming a session"](https://code.claude.com/docs/en/prompt-caching#resuming-a-session). 서버 쪽 대화 상태는 없다.
- **Codex** [소스]:
  - HTTP 요청 구조체에 `previous_response_id`가 없다([CX `codex-api/src/common.rs` L279-L304](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/codex-api/src/common.rs#L279-L304)). 매 요청 전체 `input`, 항상 `store:false`.
  - `previous_response_id`·증분 입력은 WebSocket 연결 안에서만, 같은 `ModelClient` 메모리에 직전 요청·응답이 있고 요청 속성이 같을 때만 쓴다(`common.rs` L330-L340, `client.rs` L2119-L2190). 연결이 끊기면 지우고, 복원한 세션의 첫 요청은 사유 `"restored_history"`로 전체를 보낸다([CX `client.rs` L2134-L2140](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/core/src/client.rs#L2134-L2140)).
  - 따라서 실행 시도마다 `codex app-server`를 새로 띄우는 우리 방식에서 15:00 재개는 **항상 전체 기록을 다시 보낸다**. 비용은 서버 캐시가 아직 있는지에만 달려 있다.
- **사용자 주장 (a) 판정.** OpenAI Codex 책임자 Thibault Sottiaux의 X 게시물(2026-10-21 전후, [x.com/thsottiaux/status/2112712984644784534](https://x.com/thsottiaux/status/2112712984644784534))이 출처다. 원문은 열지 못했고(HTTP 402), 검색 결과 제목으로 본 문장은 "for logged in users across Codex & Work we keep cache forever and you don't have any penalty for coming back to an old conversation or resuming after a few hours and are now guaranteed to hit the cache"이다 [미확인]. 2차 보도도 같은 내용이다([Magica](https://magica.com/news/openai-permanent-prompt-cache-codex-work)). 공식 문서([pricing](https://learn.chatgpt.com/docs/pricing), [Codex changelog](https://learn.chatgpt.com/docs/changelog), learn.chatgpt.com `llms-full.txt` 전체)와 API changelog에서는 이 약속을 찾지 못했다. 반례 보고가 하나 있다: 비공식 클라이언트로 gpt-6.1-sol을 쓰다 약 3.5시간 뒤 재개했더니 캐시 0([earendil-works/pi#11493](https://github.com/earendil-works/pi/issues/11493), 2026-10-27, 원인 미설명). **결론:** (a)가 맞다면 그것은 Codex가 기록을 안 보내서가 아니라 ChatGPT 백엔드가 로그인 사용자 캐시를 오래 보존하기 때문이다. 공식 문서로는 [미확인]이고, 공식 Codex 클라이언트(같은 `prompt_cache_key`·`session-id` 헤더)에 적용되는지는 실측으로 확인해야 한다. 확인 수단은 재개 첫 턴의 app-server `thread/tokenUsage/updated` `last.cachedInputTokens`다(CX `app-server-protocol/src/protocol/v2/thread.rs` L1992-L2027).
- **OpenCode** [소스]: 매 반복 단계에서 DB에서 메시지를 읽어(`MessageV2.filterCompactedEffect`, [OC `session/prompt.ts` L1092](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/session/prompt.ts#L1092)) 모델 메시지로 바꾸고 시스템 프롬프트를 새로 조립해 보낸다(L1255-L1283). `previous_response_id`·`store:true`는 쓰지 않는다. ChatGPT 로그인 경로도 `store:false`에 암호화된 추론을 다시 보낸다. `opencode serve` 프로세스가 바뀌어도 연속성은 DB에만 있다.
- **Antigravity** [소스·문서]: 요청마다 `contents` 전체를 보내고, 로컬 생성 메타데이터에 요청마다 system prompt·메시지·도구가 저장된다. Interactions API(`previous_interaction_id`) 타입은 바이너리에 있으나 로그에 호출이 없다 [실측]. "Headless runs are stateless by default"이며 이어 가려면 `--continue`·`--conversation <id>`를 쓴다([AG cli/headless](https://antigravity.google/docs/cli/headless)). 대화는 `~/.gemini/antigravity-cli/conversations/<uuid>.db`(SQLite)에 있다.

## 3. 구독 한도에서 캐시 적중분을 어떻게 세는가

- **Claude Code** [문서]: "Why usage climbs in a long session"에서 "With prompt caching, Claude Code re-reads that history at the cached token rate, so a one-line question in a session that has been open all day still draws usage for the whole conversation", "Cache misses: your first message after a break longer than the cache lifetime misses the cache and reprocesses your full context." [CC costs](https://code.claude.com/docs/en/costs#why-usage-climbs-in-a-long-session). 캐시 적중분이 구독 한도를 적게 소모한다는 방향은 문서에 있지만 배율은 [미확인]. 압축도 "is itself a large request"로 한도를 쓴다.
- **Codex** [문서]: 크레딧 단가표는 입력·캐시 입력·출력을 나누고 캐시 입력이 입력의 1/10(GPT-6.1 Sol·Terra는 1/20)이며 "Codex credit billing has no separate cache-write charge". 그러나 "Credit prices alone don't determine included subscription usage; check your usage dashboard for current limits." 포함 한도(5시간·주간)에서의 배율은 [미확인]. [pricing](https://learn.chatgpt.com/docs/pricing)
- **OpenCode** [문서·추론]: Go는 "Limits are defined in dollar value"(5시간 $12·주간 $30·월 $60)이고 가격표에 "Cached Read" 열이 있어 캐시 적중분은 캐시 읽기 단가로 차감된다고 본다(`packages/web/src/content/docs/go.mdx` L92-L98, L152-). Zen은 사용량 차감에 캐시 읽기·쓰기 단가가 따로 있다. ChatGPT 로그인은 Codex와 같은 [미확인], Copilot은 요청 단위 과금이며 캐시 영향 [미확인].
- **Antigravity** [문서]: 요금제 변경 공지 "we are combining these into a single rate limit, drawn down according to API pricing" 및 예시 속 "(assuming the same ratio of input, output, and cache read tokens)". [AG blog 2026-05-19](https://antigravity.google/blog/changes-to-antigravity-plans). API 가격에서 캐시 입력은 입력의 약 1/10이므로 적게 차감될 가능성이 높다 [추론]. 직접 명시한 문장은 없다 [미확인].

## 4. 압축

### Claude Code: 유휴 압축은 우리 연결 방식에서 동작하지 않는다

- [문서] v2.1.299 release: "Added idle compaction **in the terminal**: a 200K+ token conversation left idle for about 54 minutes is compacted before its one-hour prompt cache expires", "Added `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` to change idle compaction's 200K-token minimum; `"idleCompaction": false` in settings.json turns it off." [release v2.1.299](https://github.com/anthropics/claude-code/releases/tag/v2.1.299). prompt-caching 문서: "If you leave a long conversation idle while it is on the one-hour TTL, Claude Code can compact it."
- [소스, 2.1.312 바이너리] 유휴 압축기(`tengu_idle_compact_fired` 이벤트를 내는 클래스)는 다음 조건을 모두 통과해야 예약된다.
  - 세션 종류 검사: 대화형(`interactive`)이거나, 하위 세션이 아니면서 진입점이 `claude-vscode`·`claude-desktop`·`local-agent`·`remote*`·`ssh-remote`·`claude-in-slack` 등 1st-party 호스트 목록에 있어야 한다. `-p`의 진입점은 `sdk-cli`, Agent SDK는 `sdk-ts`·`sdk-py`이며 목록에 없다. 즉 **`-p --input-format stream-json`과 Agent SDK에서는 예약 자체가 일어나지 않는다.**
  - 동작 모드(`off`·`log`·`compact`·`compact_on_return`)를 서버 feature flag(`tengu_sunny_locket`)에서 읽고 기본은 `off`다. 즉 터미널에서도 Anthropic이 켠 계정에서만 동작한다.
  - 마지막 요청의 TTL이 `1h`여야 하고, 발동 시각은 `마지막 활동 + (만료 − 마지막 활동) × 0.9`(1시간이면 54분), 최소 토큰 기본 200,000(하한 100,000), 사용량 한도 근접(`near_limit`)·새 요청·캐시 식음이면 취소한다.
  - `compact` 모드는 터미널 화면 쪽이 등록한 `host.compact()`를 부른다. SDK 질의(`querySource "sdk"`)에는 요약만 미리 만들어 두는 `compact_on_return` 경로 함수가 붙지만, 앞의 세션 종류 검사에서 이미 막힌다.
- [소스] 별도로 `-p`·stream-json 경로에 "sleep compaction"(`CLAUDE_CODE_SLEEP_COMPACT`)이 있다. 유휴가 되면 TTL × 0.9 시점에 `/compact`를 meta 입력으로 대기열에 넣는다(기본 최소 150,000 토큰). 그러나 `CLAUDE_CODE_REMOTE`이고 원격 호스트일 때만 켜지는 Anthropic 클라우드 세션용이며 문서에 없다. 우리가 쓸 수단이 아니다 [소스·추론].
- **사용자 주장 (b) 판정.** "기본으로 TTL 직전 자동 압축"은 터미널 대화형 Claude Code에 대해서는 사실이지만(서버 flag로 켜진 경우), 우리 서버가 쓰는 `-p` stream-json·Agent SDK에서는 동작하지 않는다. 게다가 우리는 실행 시도가 끝나면 프로세스를 닫으므로 프로세스 안 타이머는 어차피 살아 있지 않다 [추론].
- [문서] **수동 압축은 가능하다.** Agent SDK 명령 문서: `/compact`는 "Built-in commands … execute logic coded into the Claude Code process the SDK runs"이며 프롬프트로 `/compact`를 보내고 `system`/`compact_boundary` 메시지의 `compact_metadata.pre_tokens`·`trigger`로 결과를 확인한다. 기존 세션을 `continue`/`resume`한 뒤 보내는 예시가 문서에 있고, 압축할 내용이 없으면 `compact_boundary` 없이 "Not enough messages to compact." 결과로 끝난다. [CC agent-sdk "Compact history with /compact"](https://code.claude.com/docs/en/agent-sdk/slash-commands). stream-json 입력도 같은 처리기를 쓴다 [추론, Agent SDK가 CLI stream-json을 감싸므로].
- [문서] **압축 비용.** "To produce the summary, Claude Code sends a separate request. The request repeats your conversation's system prompt, tools, and the history being summarized … While the cache is warm, that request reads your prefix from the cache." "After a break longer than the cache lifetime, there is no cache left to read, so the summarization request reprocesses that history as uncached input." 압축 뒤 첫 턴은 짧은 요약만 다시 캐시한다. 시스템 프롬프트 층은 캐시에 남는다. [CC "Compacting the conversation"](https://code.claude.com/docs/en/prompt-caching#compacting-the-conversation)
- [문서] **결과.** 같은 세션에서 기록이 요약으로 바뀐다(`/clear`만 새 `session_id`). 자동 압축 창은 `autoCompactWindow`(100,000–1,000,000 또는 `auto`), `autoCompactEnabled`, `DISABLE_AUTO_COMPACT`로 조절한다([CC settings-reference](https://code.claude.com/docs/en/settings-reference)).

### Codex

- [소스] 자동 압축 기본값은 모델 컨텍스트 창의 90%이며, 카탈로그·config(`model_auto_compact_token_limit`) 값과 비교해 작은 쪽을 쓴다(`protocol/src/openai_models.rs` L534-L545). 압축 사유는 `UserRequested | ContextLimit | ModelDownshift | CompHashChanged`뿐이고(`analytics/src/facts.rs` L461-L466) 유휴·TTL 기준 경로는 없다.
- [소스] OpenAI·Azure 공급자는 인증 방식과 무관하게 원격 압축 V2를 쓴다([CX `model-provider/src/capabilities.rs` L36-L42](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/model-provider/src/capabilities.rs#L36-L42)). 요청은 일반 Responses 요청과 같은 tools·base instructions·전체 기록 끝에 `CompactionTrigger` 항목만 붙이고, `Compaction { encrypted_content }` 하나를 받는다(`core/src/compact_remote_v2_attempt.rs` L172-L185, `compact_remote_v2.rs` L380-L478). 앞부분이 일반 턴과 같으므로 캐시가 살아 있으면 적중한다 [추론]. 결과는 같은 thread ID에서 남길 사용자 메시지(64k 토큰 예산)+Compaction 항목으로 기록 교체(L480-L505).
- [소스·문서] app-server 수동 압축: `thread/compact/start { threadId }` → `{}`. thread를 불러 `Op::Compact`를 제출하고 진행은 `turn/*`·`item/*`(`contextCompaction`) 알림으로 온다(`app-server-protocol/src/protocol/common.rs` L753-L756, `app-server/src/request_processors/thread_processor.rs` L2523-L2540, [Codex App Server](https://learn.chatgpt.com/docs/app-server)). 새로 띄운 프로세스라면 먼저 `thread/resume`이 필요하다 [추론]. `codex exec`에는 수동 압축 명령이 없다.
- [문서] OpenAI 가이드: "the first request after compaction may reuse less of the previous cache".

### OpenCode

- [소스] 자동 압축: 마지막 응답 토큰 수가 `limit.input − reserved`(기본 `reserved = min(20000, maxOutputTokens)`) 이상이면 발동, `compaction.auto=false`로 끈다([OC `session/overflow.ts` L8-L34](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/session/overflow.ts#L8-L34)). 유휴·TTL 기준은 없다.
- [소스·문서] 수동 압축: `POST /session/:sessionID/summarize`, 본문 `{ providerID, modelID, auto? }`, 응답 boolean. 유휴 세션에서 동작한다(`server/routes/instance/httpapi/groups/session.ts` L303-L315, [server 문서](https://opencode.ai/docs/server/)). `opencode run`에는 압축 명령이 없다.
- [소스] **압축 요청은 본 대화와 앞부분이 다르다.** 별도 compaction 에이전트가 도구 없이(`system: []`) 요약 대상 대화를 텍스트로 이어 붙여(도구 출력은 2,000자로 자름) 사용자 메시지 하나로 보낸다([OC `session/compaction.ts` L361-L439](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/session/compaction.ts#L361-L439), L51-L87). 그래서 캐시가 살아 있어도 압축 요청은 거의 캐시 실패다 [추론]. 즉 OpenCode에서는 **"TTL 전에 압축"이 압축 요청 자체를 싸게 만들지 않는다.**
- [소스] 결과는 같은 세션 ID. 압축 표시 메시지와 요약(`summary:true`) 뒤로 보존한 최근 대화와 이후 메시지만 모델에 보낸다(`session/message-v2.ts` L521-L572). `compaction.prune`(기본 꺼짐)은 오래된 도구 출력을 지워 대화 중간을 바꾸므로 그 지점 뒤 캐시를 깬다.

### Antigravity

- [소스] 자동 압축은 토큰 기준: `CompactionConfig{token_threshold, checkpoint_interval_tokens, max_context_tokens, …}`, `HarnessConfig.compaction_threshold`, 문서에 없는 env `AGY_CLI_AUTO_COMPACT_OVERRIDE`(형식 [미확인]). 유휴·시간 기준은 찾지 못했다.
- [소스] 내장 changelog: "Improved `/compact` and automatic compaction to retain tool declarations on summarization requests so the model API reuses its cached prompt prefix." 즉 압축 요청이 캐시 앞부분을 공유하도록 맞췄다. 1.3.5: "`/compact` on its own summarizes the conversation and ends the turn".
- [미확인] `-p`·stream-json에서 `/compact`가 동작하는가. changelog는 print 모드에서 대화 전용 slash command가 "each now fails with the flag or subcommand that replaces it"라 하고, 응답하는 명령 목록(`/usage /quota /credits /model /effort /skills /permissions /hooks /help /changelog /config`)에 `/compact`가 없다. 확인 방법은 모델을 부르지 않는 `agy -p "/help"`(이번에는 실행하지 않음).
- [추론] 압축은 trajectory 안의 step(`CompactionStep`, stream-json `step_type: checkpoint`)으로 기록되므로 같은 대화 ID가 유지될 것으로 보인다 [미확인].

## 5. 새 세션 사이의 앞부분 캐시

- **Claude Code** [문서]: API 캐시는 조직 안에서 모델·속도·앞부분이 같으면 공유된다. 그러나 Claude Code에서는 "the cache is effectively scoped to one machine and directory": 시스템 프롬프트에 auto memory 경로가 들어가고 대화 첫머리에 cwd·플랫폼·셸, 시작 시 git 상태(branch·최근 커밋)가 들어간다. 같은 디렉터리의 병렬 세션은 서로 읽고, 순차 세션은 git 스냅샷이 같을 때만 공유한다. [CC "Cache scope"](https://code.claude.com/docs/en/prompt-caching#cache-scope). 시스템 프롬프트 층만이라도 공유하려면 SDK `excludeDynamicSections: true`(CLI `--exclude-dynamic-system-prompt-sections`)로 auto memory 경로를 첫 사용자 메시지로 옮긴다. git 스냅샷은 `includeGitInstructions:false` 또는 `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`로 뺄 수 있다. [CC agent-sdk/modifying-system-prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts#improve-prompt-caching-across-users-and-machines). 고정 부분 + 가변 부분은 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`로 나눠 고정 부분만 캐시할 수 있다(같은 문서). 본 대화 TTL이 1시간이므로, 같은 지침·도구로 1시간 안에 시작한 다른 세션이 있으면 새 세션의 시스템 프롬프트·도구 층은 적중한다 [추론].
- **Codex** [문서·추론]: OpenAI 문서는 키가 다른 요청은 "maintain separate cache accounting … even when their requests contain the same prefix"라고 한다. Codex는 thread마다 다른 `prompt_cache_key`·`session-id`를 보내고 base instructions 메시지 id도 thread별로 다르므로, 새 thread가 다른 thread의 캐시를 읽을 가능성은 낮다. ChatGPT 백엔드의 실제 해석은 [미확인].
- **OpenCode** [소스]: 시스템 프롬프트에 `Today's date: ${new Date().toDateString()}`, cwd, 작업 공간 루트, git 저장소 여부, 플랫폼, 모델 ID가 들어간다([OC `session/system.ts` L72-L82](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/session/system.ts#L72-L82)). 같은 날·같은 cwd·같은 지침이면 새 세션도 시스템 프롬프트가 같고, Anthropic 계열은 키가 없어 TTL 안이면 공유 가능하다 [추론]. 날짜가 바뀌면 재개한 세션도 시스템 프롬프트부터 달라져 전체가 캐시 실패다(매 요청 시스템 프롬프트를 새로 조립하므로) [추론]. OpenAI 계열은 세션 ID 키로 분리된다.
- **Antigravity** [문서·실측]: 자동 캐시는 대화가 아니라 요청 앞부분 일치 단위다. 새 대화 첫 요청 65건 중 2건에서만 약 8.1K 토큰이 적중했다. 내장 changelog는 rules 정렬을 고정해 "needless prompt-cache misses"를 막았다고 한다. 몇 시간 간격의 새 대화에서 적중을 기대하기는 어렵다 [추론].

## 사용자 프로젝트(Auto Compact for Claude)와의 관계

- 그 프로젝트는 Paseo가 띄운 **대화형** Claude 세션에 Mod(관측기)를 넣어, 응답 완료를 관측한 뒤 마지막 요청 시각 + 사용자 지연(기본 55분, 크기 기본 200,000 토큰)에 Paseo 공개 API로 `/compact`를 보낸다. TTL은 Stop hook이 준 transcript의 `cache_creation` TTL → Claude 설정·env → 1시간 가정 순으로 정한다. 완료는 새 compaction 경계와 관측기 기록이 모두 맞아야 성공으로 친다. 사용자 입력과 압축 전송 사이의 경쟁은 API가 원자적이지 않아 남는다고 스스로 적었다([runtime.md](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/blob/4039afd9e5bdc1f9f184541022352bee8d242cde/docs/runtime.md)).
- Claude Code 자체 유휴 압축(0.9 × 1시간 = 54분, 200K)과 기본값이 거의 같다. 사용자 README도 "Claude Code added idle auto-compaction … Paseo does not yet use this feature"라고 적어 이 기능이 SDK 경로에서 안 돈다는 관찰과 맞는다.
- 그 프로젝트의 README는 Codex 구독 세션은 "caches are retained indefinitely for logged-in Codex users"라며 대상에서 뺐다. 근거는 2절의 같은 X 게시물이다.

## BaboJUBot에 주는 시사점

전제: 우리 서버는 프로바이더 프로세스를 소유하고, 실행 시도가 끝나면 닫는다. 따라서 "프로세스 안 타이머가 TTL 직전에 압축"하는 방식은 어느 프로바이더에서도 그대로 쓸 수 없다. 대신 **서버가** 실행 시도 종료 시점이나 그 뒤 예약 시점에 같은 세션을 다시 열어 압축 명령만 보낼 수 있다 [추론].

### 사용자 방식을 우리 서버에서 재사용할 수 있는가

재사용할 수 있다. 바꿀 점은 "관측기 Mod + 공개 전송"이 "서버가 소유한 정비 실행"으로 바뀐다는 것뿐이다 [추론].

- **예약 시계.** 실행 시도의 마지막 모델 요청 시각과 그 결과 usage의 TTL(Claude는 `cache_creation.ephemeral_1h_input_tokens`/`ephemeral_5m_input_tokens`)을 실행 기록에 남긴다. 사용자 프로젝트의 "transcript에서 TTL 읽기"가 우리에게는 stream-json 결과 usage 읽기로 바뀌어 더 단순하다.
- **발동.** 마지막 요청 + TTL × 0.9(1시간이면 54분)에, 그 작업이 다시 깨어나지 않았고 컨텍스트가 임계값(기본 200,000) 이상이면, 서버가 같은 세션을 `--resume`으로 띄워 `/compact`만 보내고 `compact_boundary`를 받으면 닫는다. 그 사이 같은 작업의 실행 시도가 시작되면 예약을 취소한다. 입력 경쟁은 서버가 작업별 실행을 직렬화하므로 사용자 프로젝트보다 다루기 쉽다.
- **앞부분 일치 조건.** 정비 실행은 원래 실행 시도와 같은 Claude Code 버전·모델·effort·도구 목록(MCP 서버)·`--append-system-prompt`·설정으로 띄워야 캐시를 읽는다. 재개한 대화는 기록된 시스템 프롬프트를 유지하므로 지침 갱신은 압축 뒤에 반영된다 [문서]. 정비 결과 usage의 `cache_read_input_tokens`로 적중을 확인해 기록한다.
- **간단한 대안.** 실행 시도가 "Lead 응답 대기"처럼 긴 대기로 끝나는 것을 서버가 알면, 프로세스를 닫기 전에 그 자리에서 `/compact`를 보낸다. 캐시가 가장 따뜻한 순간이라 압축이 가장 싸지만, 곧바로 다시 깨어날 작업에도 압축 비용과 세부 손실이 생긴다 [추론].
- **제품 규칙과의 연결(결정 필요).** 정비 실행도 모델 호출이므로 대시보드에서 관찰 가능한 활동으로 남기고, 조직별 승인 정책의 대상인지 정해야 한다 [추론].

### 프로바이더별 세션 정책 권고

| 프로바이더 | 권고 | 이유와 조건 |
|---|---|---|
| Claude Code | **TTL 전 압축 후 재개** (큰 대화), 작은 대화는 TTL과 무관하게 재개 | 재개 시 전체 재전송이 문서로 확정, 자체 유휴 압축은 `-p`·SDK에서 꺼져 있음, 수동 `/compact`는 stream-json·SDK로 가능하고 따뜻할 때 압축은 캐시를 읽음. 구독 한도 안 본 대화 TTL은 기본 1시간이지만, usage credits로 넘어가면 5분이 되므로 실행 결과의 TTL을 매번 읽는다. 1시간을 고정하려면 `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`(credits 사용 중 쓰기 단가 상승) |
| Codex | **자유 재개(잠정)**, 첫 재개 턴의 `cachedInputTokens`로 검증. 적중하지 않으면 "TTL 안에서만 재개, 아니면 압축 또는 새 thread"로 전환 | 소스상 항상 전체 재전송이므로 비용은 ChatGPT 백엔드 보존에 달림. "로그인 사용자 캐시 영구 보존"은 공식 문서 [미확인]. 필요 시 `thread/compact/start`는 일반 턴과 같은 앞부분이라 따뜻할 때 싸다. 새 thread는 다른 thread 캐시를 거의 못 읽어 "새로 시작"의 이점이 작다 |
| OpenCode | **TTL 안에서만 재개, 아니면 새 세션**(조직 기록으로 시작). 큰 세션은 압축이 재개 1회 재전송과 비슷한 비용임을 감안 | 공급자가 로그인 종류에 따라 달라짐(Claude 구독은 내장 안 됨, ChatGPT·Copilot·Go/Zen). Anthropic 계열 기본 TTL 5분. 압축 요청은 앞부분이 달라 TTL 전 압축의 이점이 없음. 시스템 프롬프트에 날짜가 있어 날짜가 바뀌면 재개도 전체 캐시 실패. ChatGPT 로그인 경로의 장기 캐시 적용 여부는 Codex와 같은 [미확인] |
| Antigravity | **TTL 안에서만 재개, 아니면 새 세션**. TTL을 알 수 없으므로 짧게(수 분~1시간 이하) 잡고 실측으로 조정 | 전체 재전송, 자동 캐시 TTL 비공개, 7.9시간 뒤 적중 0. `-p`·stream-json `/compact` 지원이 [미확인]이라 TTL 전 압축은 확인 전 쓸 수 없음. stream-json `cache_read_tokens`를 실행마다 기록해 간격별 적중률을 쌓는다 |

공통: 실행 시도마다 프로바이더가 보고하는 캐시 적중·쓰기 토큰(Claude `cache_read_input_tokens`·`cache_creation`, Codex `cachedInputTokens`, OpenCode 메시지 `tokens.cache`, agy `cache_read_tokens`)을 실행 기록에 남기면, 위 정책을 우리 데이터로 검증하고 바꿀 수 있다 [추론]. "새 세션 + 조직 기록으로 시작"은 앞부분 캐시가 공유되는 Claude Code(같은 디렉터리·시스템 프롬프트 고정 시)에서 가장 싸고, Codex·OpenCode(OpenAI 계열)는 세션별 키 때문에 이점이 작다.

## 검증 결과와 한계

실행한 것:

- Claude Code 2.1.312 바이너리 문자열에서 유휴 압축기(진입점 검사 `IF()`, 서버 flag `tengu_sunny_locket`, 0.9 비율, 200,000 기본·100,000 하한)와 sleep compaction(`CLAUDE_CODE_SLEEP_COMPACT` + `CLAUDE_CODE_REMOTE`) 코드를 읽었다. `-p`의 진입점이 `sdk-cli`로 정해지는 코드도 확인했다.
- Codex·OpenCode는 고정 SHA 소스를 읽었고, 핵심 주장(`prompt_cache_key` 정책, `"restored_history"` 전체 전송, OpenCode 시스템 프롬프트의 날짜)은 해당 줄을 다시 열어 확인했다.
- 공식 문서는 2026-10-30에 열람했다(CC prompt-caching·costs·agent-sdk 3종·settings-reference 일부, OpenAI prompt caching guide·API changelog, learn.chatgpt.com pricing·changelog, Gemini·Vertex caching, Antigravity headless·plans·blog).
- Antigravity는 로컬 대화 DB와 로그의 숫자 메타데이터·API 메서드 이름만 읽었다(프롬프트 본문·자격 증명 미열람).

실행하지 않은 것과 남은 미확인:

- 어떤 프로바이더에도 모델 호출을 하지 않았다. 따라서 5시간 간격 재개의 실제 캐시 적중, 정비 실행으로 다시 띄운 Claude 세션이 원래 앞부분 캐시를 읽는지, OpenCode `cacheControl` `ttl:"1h"` 우회의 실제 요청은 검증하지 않았다.
- Codex "로그인 사용자 캐시 영구 보존"의 원문·적용 조건(공식 클라이언트·모델·헤더). X 게시물을 열지 못했다.
- 네 프로바이더 모두 캐시 적중 입력이 구독 포함 한도를 얼마나 덜 소모하는지의 공식 배율.
- Antigravity: 자동 캐시 TTL, `-p`·stream-json에서 `/compact` 동작, 압축 후 대화 ID, `AGY_CLI_AUTO_COMPACT_OVERRIDE` 형식, keep-alive 플래그 활성 여부.
- Claude Code의 서버 flag(`tengu_sunny_locket`)가 이 계정에서 켜져 있는지. 우리 경로에서는 진입점 검사에서 이미 막히므로 결론에는 영향이 없다.
- `settings-reference`의 `idleCompaction` 항목 본문은 페이지가 길어 읽지 못했고, release note와 바이너리로 대신했다.
- 이 문서는 [문서 지도](../README.md#배경과-조사-기록)에 아직 등록하지 않았다.
