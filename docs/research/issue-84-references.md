# issue-84 레퍼런스 조사: 채널에서 들어오는 사용자 답

조사일: 2026-10-28. 대상: [#84](https://github.com/babo-jeonguk/BaboJUBot/issues/84) 4번(채널 답을 받는 seam). 구현 전 조사이며, 채택한 결정은 이슈 본문이 기준입니다. 상세 노트와 읽은 코드 사본은 `.reference-cache/issue-84/`(git 무시)에 있습니다. 클론한 코드는 읽기만 했고 실행하지 않았습니다.

## Brief

| 질문 | 조사 범위 | 채택 |
|---|---|---|
| [구조 문서의 "같은 명령 경로"는 무슨 뜻이었나](#같은-명령-경로의-원래-뜻) | 과거 세션 기록, git, #49·#61 | 같은 저장·거부 규칙. 같은 HTTP가 아님 |
| [알림마다 받는 답과 전달 방식](#알림마다-받는-답) | 상용·오픈소스 | 종류별 고정 답, 결정은 정해진 모양만 |
| [보낸 사람 확인](#보낸-사람-확인) | 상용·오픈소스 | adapter가 출처 서명과 보낸 사람 허용 목록으로 확인 |
| [앱 메시지와 알림 잇기](#앱-메시지와-알림-잇기) | 상용·오픈소스 | 버튼은 값에 알림 ID, 글 답장은 공용 연결 기록 |
| [adapter 모양과 시작 설정](#adapter-모양과-시작-설정) | 오픈소스 7개 | 한 adapter가 보내기·받기·멈춤, 서버가 입구를 건넴 |
| [알림에 답장하지 않은 글](#알림에-답장하지-않은-글) | 상용·오픈소스·Telegram API | 거부. 조직별 주제 등은 판 3 |

## 레퍼런스

| 분류 | 대상 | 버전·SHA |
|---|---|---|
| 메시지 플랫폼 | Slack, Telegram Bot API, Discord, Microsoft Teams(Universal Actions·Approvals) | 2026-10-28 공식 문서 |
| 상용 연동 | GitHub·PagerDuty·Opsgenie·Jira·Linear Slack 앱, Zapier Human in the Loop | 2026-10-28 공식 문서 |
| 상용 코딩 에이전트 | Claude Code channels, Claude Code in Slack, Claude Tag, Cursor, Devin, GitHub Copilot cloud agent | 2026-10-28 공식 문서 |
| 오픈소스 에이전트 다리 | [OpenClaw](https://github.com/openclaw/openclaw) | `fcfe9a652b815ad9b4020916140b696eb13f31bb` |
| | [Hermes Agent](https://github.com/NousResearch/hermes-agent) | `0431192d69d4afd2443a7da15bb9e129a424414c` |
| | [Claude Code 공식 Telegram channel](https://github.com/anthropics/claude-plugins-official) | `f8c5e7a1dcb71b10cb74586224b5401f3de5db28` |
| | [takopi](https://github.com/banteg/takopi) | `e0123d4` |
| | [claude-code-telegram](https://github.com/RichardAtCT/claude-code-telegram) | `164afc1` |
| | [Omnara](https://github.com/omnara-ai/omnara) (Go 재작성판) | `176fe4e` |
| | [n8n](https://github.com/n8n-io/n8n) Send and Wait | `6d9a0494` |
| 자체 모바일 앱(참고) | [Paseo](https://github.com/getpaseo/paseo), [Happy](https://github.com/slopus/happy) | `9fb7808`, `3a09941` |
| 채널 adapter 구조 | [Rasa](https://github.com/RasaHQ/rasa), [Errbot](https://github.com/errbotio/errbot), [Hubot](https://github.com/hubotio/hubot), [matterbridge](https://github.com/42wim/matterbridge) | `60a3cff9`, `af1bb75b`, `083df910`, `c4157a4d` |

사용자가 말한 "rakazo"는 찾지 못했습니다. 이름이 비슷한 Telegram 다리 takopi를 대신 넣었습니다. Paseo와 Happy는 자체 앱만 쓰고 메시지 앱 답장 경로가 없어 참고로만 봤습니다. Vibe Kanban, Conductor, Paperclip은 메시지 앱 답장 경로를 확인하지 못해 뺐습니다.

## 같은 명령 경로의 원래 뜻

[구조 문서](../architecture.md)의 "답장·버튼 입력은 같은 명령 경로로 돌립니다"가 "같은 HTTP를 거친다"는 뜻인지, "같은 명령 처리를 거친다"는 뜻인지 확인했습니다.

- 2026-10-13 설계 세션 1라운드에서 이 표현은 assistant가 제안했고 사용자는 "추천대로"로 동의했습니다. 비교 대상은 전달 방식이 아니었습니다. "메시지 앱을 Lead와 직접 대화하는 봇으로 두면 승인·중단이 Control Plane을 건너뛴다"는 대안과 비교했습니다.
- 처음 커밋한 문장(`a808426`, 2026-10-14)은 "받은 답장·버튼 입력은 위의 같은 명령 경로로 되돌립니다"입니다. 여기서 "위의"는 Surface가 보내는 제어 명령·사용자 메시지 목록을 가리킵니다. 같은 문서는 데이터 형식과 프로세스 분리를 다음 단계로 넘긴다고 적었습니다.
- "같은 HTTP 명령 경로"는 그 뒤 기능 명세 [#49](https://github.com/babo-jeonguk/BaboJUBot/issues/49)와 가짜 채널 이슈 [#61](https://github.com/babo-jeonguk/BaboJUBot/issues/61)에서 agent가 적었습니다. #61 조사의 결정 D04가 실제 HTTP 전달을 골랐습니다. 사용자가 이를 따로 확인한 기록은 없습니다.

결론: 원래 뜻은 "채널 입력도 대시보드와 같은 명령으로 Control Plane을 거친다(규칙을 건너뛰지 않는다)"입니다. 구조 문서 문장은 그 뜻으로 고쳤습니다.

## 알림마다 받는 답

관찰:

- 결정이 필요한 알림은 버튼으로, 에이전트 메시지는 스레드·답장 글로 받습니다. 두 입력은 플랫폼에서도 다른 이벤트로 옵니다. Slack은 [`block_actions`](https://docs.slack.dev/reference/interaction-payloads/block_actions-payload)와 [message](https://docs.slack.dev/messaging/retrieving-messages)로, Telegram은 [`CallbackQuery`](https://core.telegram.org/bots/api#callbackquery)와 [`Message.reply_to_message`](https://core.telegram.org/bots/api#message)로 옵니다.
- 버튼과 같은 뜻의 글 명령을 함께 두는 곳이 많습니다. OpenClaw `/approve <id> <decision>`(`src/infra/exec-approval-reply.ts`), Hermes `/approve`·`/deny [reason]`(`gateway/slash_commands.py:1206-1241`), Claude Code `yes <id>`([channels-reference](https://code.claude.com/docs/en/channels-reference))가 그렇습니다.
- 승인 요청에 온 자유 글은 승인으로 보지 않는 것이 기본입니다.
  - Claude Code는 ID가 붙은 형식만 판정으로 받고 나머지는 대화로 넘깁니다(`external_plugins/telegram/server.ts:89-93`).
  - Hermes는 승인이 실제로 막고 있을 때의 "yes/no"만 판정으로 바꿉니다.
  - Omnara와 Paseo는 반대로, 글이 오면 열린 승인을 "새 입력으로 대체됨"으로 닫고 그 글을 에이전트에 넘깁니다(Omnara `internal/toolpermission/interaction.go:142-147`, Paseo `packages/server/src/server/session.ts:8303-8320`).
- 실행 중에 온 답의 처리:
  - 상용은 다음 차례에 묶어 전달합니다(Claude Code channels: "Events queue into the session … delivered together on the next turn"). 중단은 별도 Stop 버튼이 맡습니다([Claude Tag](https://claude.com/docs/claude-tag/concepts/how-it-works)).
  - 오픈소스는 사용자가 고르게 하는 곳이 많습니다. 설정으로 고르는 곳은 OpenClaw `src/auto-reply/reply/queue/settings.ts:14-19`, Hermes `hermes_cli/config_defaults.py:817`, Omnara `queued`/`steering`입니다. takopi는 메시지마다 버튼으로 고릅니다(`src/takopi/telegram/bridge.py:41-53`). 기본값은 프로젝트마다 다릅니다.
- 거부 사유는 대부분 받지 않거나 선택 항목입니다.
  - 받는 곳은 버튼 뒤 입력 창을 엽니다. Slack 모달([handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction)), Teams 상세 폼([Approvals](https://learn.microsoft.com/en-us/power-automate/teams/respond-to-approvals-in-teams))이 그렇습니다.
  - 강제 답장으로 받는 곳도 있습니다(Telegram [`ForceReply`](https://core.telegram.org/bots/api#forcereply)).
  - 글 명령으로 받는 곳도 있습니다(Hermes `/deny <이유>`).
- 버튼에는 바로 개인 피드백을 줍니다. Slack은 3초 안에 응답해야 하고 ephemeral 메시지로 답합니다. Telegram은 [`answerCallbackQuery`](https://core.telegram.org/bots/api#answercallbackquery)를 반드시 불러야 하며, 0–200자의 화면 알림이나 대화상자로 보여 줍니다.

채택:

- 받는 쪽은 정해진 모양의 답만 받습니다.

  | 알림 | 받는 답 |
  |---|---|
  | Lead 메시지 | 글 답장 → 그 대화에 사용자 메시지로 들어감. 대시보드와 같은 두 전달 방식을 받고, 기본은 줄 세우기 |
  | 승인 요청 | 승인·반려·수정 요청 |
  | 결과 제출 | 최종 완료·수정 요청 |
  | 실행 시도 실패 | 받지 않음 |

- 사유 규칙은 대시보드와 같습니다.
- 글 명령, 사유 입력 창, 중단 버튼을 채널에 둘지는 adapter가 정합니다.
- 승인 요청·결과 제출 알림에 글로 답하면 거부하고 Lead에게 보내지 않습니다. 이 거부를 화면에 어떻게 보여 줄지는 adapter가 정합니다.

## 보낸 사람 확인

관찰:

- 상용은 두 겹으로 확인합니다.
  1. 요청이 정말 그 메시지 앱에서 왔는지 확인합니다. 방식은 플랫폼마다 다릅니다.
     - Slack: HMAC 서명과 5분 제한([verifying requests](https://docs.slack.dev/authentication/verifying-requests-from-slack))
     - Discord: Ed25519 서명([interactions](https://docs.discord.com/developers/interactions/overview))
     - Teams: JWT([Bot Framework auth](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication))
     - Telegram: `secret_token` 헤더만 있음([setWebhook](https://core.telegram.org/bots/api#setwebhook))
  2. 누른 사람을 제품 계정과 연결해 확인합니다. 방식은 로그인 연결([GitHub](https://github.com/integrations/slack), [PagerDuty](https://docs.pagerduty.com/integrations/slack-integration-guide)), 이메일 일치([Devin](https://docs.devin.ai/integrations/slack)), 페어링 코드([Claude Code channels](https://code.claude.com/docs/en/channels)) 중 하나입니다.
- 동작마다 제품 권한을 다시 확인합니다(PagerDuty, Jira, GitHub).
- 오픈소스는 모두 보낸 사람 ID 허용 목록을 기준으로 삼습니다.
  - Claude Code 문서는 "Gate on the sender's identity, not the chat or room identity"라고 명시합니다. 방 단위로 허용하면 그 방의 누구나 입력을 넣을 수 있기 때문입니다.
- 허용 목록은 짝짓기 코드로 채웁니다. 모르는 사람이 말을 걸면 짧은 코드를 돌려주고, 주인이 메시지 앱 밖(서버 CLI·터미널)에서 그 코드를 승인합니다.
  - 코드는 1시간 뒤 만료되고 대기는 3개까지입니다. OpenClaw `src/pairing/pairing-store-model.ts:7-11`, Hermes `gateway/pairing.py:1-59`, Claude Code `external_plugins/telegram/ACCESS.md`가 같은 값을 씁니다.
- 모르는 사람의 메시지는 에이전트에 넘기지 않고 버립니다. Claude Code channels와 Copilot([risks and mitigations](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations))은 조용히 버립니다.
- 승인 버튼을 누른 사람도 다시 확인합니다. OpenClaw `extensions/telegram/src/exec-approvals.ts:40-50`, n8n `approverIds`(`packages/nodes-base/nodes/Telegram/hitl/webhook.ts`)가 그렇습니다.
- webhook을 쓰면 Telegram 비밀값 확인이 필수입니다(OpenClaw·Hermes·n8n). long polling을 쓰면 이 단계가 필요 없습니다(takopi·Claude Code).
- 확인 없이 믿는 곳은 없었습니다. claude-code-telegram은 허용 목록도 토큰도 없으면 개발 모드가 아닌 한 시작을 거부합니다(`src/main.py:109-126`).

채택:

- 채널 adapter가 출처 서명·비밀값과 보낸 사람 허용 목록으로 확인한 답만 Control Plane에 넘깁니다. 이 규칙은 [구조 문서 강제 위치 표](../architecture.md#제품-불변-조건-강제-위치)에 적었습니다.
- 허용 목록 저장 위치와 짝짓기 화면은 판 3에서 첫 메시지 앱과 함께 정합니다.
- 가짜 채널은 로컬 신뢰 운영을 따릅니다.

## 앱 메시지와 알림 잇기

관찰:

- 버튼은 거의 모두 값 안에 내부 ID를 넣습니다. 버튼 값의 크기는 플랫폼마다 다릅니다.
  - Slack `value`: 2000자([button element](https://docs.slack.dev/reference/block-kit/block-elements/button-element))
  - Discord `custom_id`: 100자([components](https://docs.discord.com/developers/components/reference))
  - Telegram `callback_data`: 64바이트([InlineKeyboardButton](https://core.telegram.org/bots/api#inlinekeyboardbutton))
- 그래서 짧은 ID를 접두사와 함께 넣습니다. OpenClaw `tga1:<종류>:<결정>:<approvalId>`(`extensions/telegram/src/approval-callback-data.ts:5-53`), n8n은 HMAC 서명까지 붙입니다(`packages/core/src/utils/hitl-callback-reference.ts`).
- 글 답장은 원본을 스레드·답장 참조로만 알 수 있습니다(Slack `thread_ts`, Telegram `reply_to_message`).
  - 상용은 "채널 + 외부 메시지·스레드 ID → 객체" 연결을 저장합니다([Linear](https://linear.app/docs/slack) synced thread, [Jira](https://support.atlassian.com/jira-software-cloud/docs/sync-your-slack-threads-with-jira-work-items/) Sync with thread, Claude Tag 스레드=세션).
  - 오픈소스는 대부분 연결 기록 없이 "이 채팅방·스레드 = 이 세션"으로 보냅니다(OpenClaw `src/routing/session-key.ts:179-235`, Hermes `gateway/session.py:691-735`). 대화 상대가 에이전트 하나라서 가능한 방식입니다.
  - Omnara만 연결을 DB 표로 둡니다. 대화 → 에이전트 연결은 `integration_subscriptions`, 들어온 이벤트 중복 방지는 `integration_inbox`입니다(`migrations/000048_composable_integrations.sql:220-301`).
- 승인을 DB에 두는 곳은 재시작할 때 대기 승인을 명시적으로 닫습니다(OpenClaw `gateway-restart`). 옛 버튼을 누르면 "이미 끝남"을 보여 줍니다.

채택:

- 버튼 값에 알림 ID를 넣는 일은 adapter가 맡습니다. 알림 ID는 UUID 36자라 Telegram 64바이트에 들어갑니다.
- 글 답장을 위해 Control Plane이 "채널 이름 + 앱 메시지 번호 → 알림" 공용 기록을 둡니다. adapter가 알림을 보낼 때 앱 메시지 번호를 돌려주면, 전송 성공을 적는 자리에서 함께 남깁니다.
- BaboJUBot은 여러 조직의 알림이 한 채팅방에 섞여 오므로 "채팅방 = 대화" 방식은 쓸 수 없습니다.

## adapter 모양과 시작 설정

관찰:

- 보내기와 받기는 대부분 한 adapter 단위로 묶입니다.
  - Hermes는 한 클래스가 `connect`/`disconnect`/`send`를 모두 가집니다(`gateway/platforms/base.py`).
  - OpenClaw는 한 plugin 안에 `outbound`와 `gateway`를 둡니다(`src/channels/plugins/types.adapters.ts:204-232`).
  - Rasa만 두 클래스로 나누되 `get_output_channel()`로 짝을 맞춥니다(`rasa/core/channels/channel.py:83-136`).
- 받은 답은 본체가 adapter에게 입구를 건네는 방식으로 들어옵니다. 7곳 중 6곳이 이렇게 합니다.
  - Rasa는 `on_new_message` 콜백을 건넵니다.
  - Hermes는 `set_message_handler` 다음에 `connect`를 부릅니다(`gateway/run_adapters.py:225-296`).
  - OpenClaw는 `startAccount(ctx)`로 건넵니다(`src/gateway/server-channels.ts`).
  - matterbridge는 받은 메시지를 넣을 통로 `Remote`를 건넵니다(`bridge/bridge.go:13-42`).
  - Errbot만 본체를 상속합니다.
- polling이나 websocket 같은 연결 루프는 언제나 adapter가 맡습니다.
- webhook 경로를 여는 곳은 둘로 갈립니다.
  - adapter가 본체 HTTP 서버에 경로를 등록합니다. OpenClaw `registerPluginHttpRoute`, Rasa blueprint를 본체가 mount, Hubot `robot.router`가 그렇습니다.
  - adapter가 자기 포트를 엽니다. Hermes와 Claude Code가 그렇습니다.
- 멈추는 수단은 시작과 짝으로 둡니다(OpenClaw `abortSignal`, Hermes `disconnect`, Hubot `close`, matterbridge `Disconnect`).
- 승인 판정의 정합성은 본체가 검사합니다. Claude Code에서 adapter는 답을 `request_id`와 허용·거부로 바꿔 넘기기만 하고, 본체가 열린 요청과 맞을 때만 적용하며 먼저 온 답을 씁니다.
- OpenClaw, Hermes, matterbridge, Claude Code는 여러 채널을 동시에 돌립니다. 채널마다 실패를 격리하고 backoff로 다시 시작합니다(OpenClaw 5초~5분·최대 10회, matterbridge `reconnectBridge`). 상태는 본체에 보고합니다(OpenClaw `setStatus`).
  - Claude Code Telegram plugin에는 받기만 조용히 멈췄던 문제를 고친 흔적이 있습니다(`external_plugins/telegram/server.ts:1001-1005`).
- 시작 때 채널 선택은 설정 파일과 등록부(OpenClaw·Hermes·Rasa·matterbridge)나 실행 인자(Claude Code `--channels`, Hubot `--adapter`)로 합니다.

채택:

- adapter 하나가 보내기, 받기 시작, 멈춤을 모두 갖습니다. 서버는 받는 입구를 건네고, adapter는 서버의 같은 주소 아래에 자기 경로를 등록합니다. 서버를 끌 때 adapter도 닫습니다.
- 서버는 채널을 목록으로 받되, 이번에는 하나만 허용합니다. 연결 기록에는 채널 이름을 처음부터 붙입니다.
- 여러 채널 동시 전송(알림 × 채널마다 전송 상태)은 판 3으로 미룹니다. 채널마다 다시 시작하기, 대시보드에 채널 상태 보이기, 환경 변수로 채널 고르기도 판 3입니다.

## 알림에 답장하지 않은 글

관찰:

- 대상이 여럿이면 대화 자리가 대상을 정하는 방식이 가장 흔합니다. 대화방, 주제, 채널, 스레드 하나를 대상 하나에 묶습니다(OpenClaw binding, takopi·Hermes·claude-code-telegram 주제, Slack 앱 채널 구독).
- Telegram은 Bot API 9.3(2025-12-31)·9.4(2026-02-09)부터 봇 DM 안에도 주제를 만들 수 있습니다([changelog](https://core.telegram.org/bots/api-changelog)). Hermes와 claude-code-telegram이 "프로젝트마다 DM 주제 하나"로 씁니다.
- 묶이지 않은 자리의 글은 거부하고 어디에 쓸지 안내하는 곳이 많습니다(OpenClaw, takopi, claude-code-telegram 엄격 모드, Omnara). OpenClaw 문서는 대상이 여럿일 때 "첫 번째 에이전트에게 주지 않는다"고 명시합니다(`docs/concepts/multi-agent.md`).
- "최근 대상"이나 "기본 대상"으로 보내는 곳은 대상이 사용자 자신의 작업이거나 사용자가 명시적으로 설정했을 때뿐입니다.
  - Hermes는 코드상 주제 밖 글을 최근 주제로 옮기는데(`gateway/run_topics.py:171-245`), 삭제된 주제로 계속 보내던 버그(#31501)가 있었습니다. 문서는 여전히 "거부"라고만 적어 코드와 다릅니다.
- 애매할 때 고르게 하는 방식은 주로 새 작업을 시작할 때 씁니다(Omnara, [Claude Code in Slack](https://code.claude.com/docs/en/slack)).
- 대상과 무관한 시스템 명령은 묶이지 않은 자리에서도 받습니다(Hermes `/status`).

BaboJUBot은 여러 조직의 알림이 한 채팅방에 섞여 옵니다. 그래서 "최근 알림의 대화로", "기본 조직으로", "`/use 조직`" 같은 방식은 사용자 모르게 다른 조직의 Lead에게 글을 보낼 수 있고, 이는 조직 경계 위반입니다.

채택:

- 이번에는 거부합니다. 받는 쪽 입구는 알림에 대한 답만 받습니다.
- 판 3 후보는 다음과 같습니다.
  - 조직별 주제를 기본으로 합니다.
  - 주제 밖 글은 안내하거나 조직 고르기 버튼을 띄웁니다.
  - 전체 현황 질문은 Lead에게 보내지 않고 제품이 직접 답합니다.

## 한계와 미확인

- 상용 서비스의 내부 연결 구조(GitHub, Jira)와 연결하지 않은 사용자가 버튼을 눌렀을 때의 화면은 공식 문서에 없습니다.
- GitHub, Jira, Linear, PagerDuty, Devin이 대상 없이 DM에 쓴 글을 어떻게 처리하는지는 공식 문서에 없습니다.
- Cursor 문서는 요약으로만 읽어 원문 문장을 모두 대조하지 못했습니다.
- claude-code-telegram의 일부 버튼 콜백이 인증을 거치지 않는다는 관찰은 조사자의 추정이며 확인하지 않았습니다.
- 모든 Telegram 클라이언트가 개인 대화 주제를 같은 방식으로 보여 주는지는 확인하지 않았습니다.
- n8n, Botpress, Chatwoot의 adapter 구조는 보지 않았습니다.
- 제품 코드, 테스트, 실제 메시지 앱 연결은 실행하지 않았습니다.
