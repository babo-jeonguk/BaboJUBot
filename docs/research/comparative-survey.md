# BaboJUBot 비교 조사: 서비스·공개 프로젝트 1차 후보 목록

확인일: 2026-10-12 (Asia/Seoul).

이 문서의 요구 요약은 조사 당시 전제입니다. 이후 승인 정책과 구현 순서가 변경됐으며, 현재 기준은 [features.md](../features.md)와 [architecture.md](../architecture.md)를 따릅니다.

## 결론과 조사 범위

공식 문서와 공개 저장소에서 **23개 후보의 존재, 제품 성격, 참고할 기능과 공개 범위**를 1차 확인했습니다. 기능 전체의 지원 여부를 검사한 표가 아니며, 채택·재사용·기술 구조를 확정하지 않습니다. 상용 제품 내부의 비공개 구현은 확인하지 않았습니다. 설치, 서비스 로그인, 실제 agent 호출, 실행 성능 비교도 수행하지 않았습니다.

조사 출발점은 [목표와 인터뷰 기록](../project-intent.md) 및 [공통 용어](../../GLOSSARY.md)의 확정 요구사항입니다. 연구 목표 하나마다 독립 조직과 전용 Lead·팀을 구성하고, 초기 계획과 팀은 사용자 승인 후 실행합니다. 진행 중 작업자 추가도 승인받으며, 기억은 조직별로 분리하고 사용자가 지정한 내용만 공유합니다. Lead의 분담·조정과 작업자 직접 협력을 함께 지원합니다. 피드백과 새 작업은 진행 중 반영하고 주요 사건 또는 사용자 요청에 따라 보고합니다. 기준 충족 후 결과 제출과 사용자의 최종 완료 결정은 구분합니다. 사용자 접점은 웹 대시보드와 메신저를 모두 후보로 고려하되 첫 버전에 두 접점을 동시에 구현하는 것으로 고정하지 않습니다. 특정 연구 분야나 GPU 환경을 제품의 전제로 삼지 않습니다. 후속 사용자 보완으로 ‘grok bot’은 정식 xAI Grok Bot임을 확정했으며 Meta Muse와 OpenAI dots도 필수 비교 대상에 추가했습니다.

조사 가정은 **이 요구를 여러 계층의 구현 사례로 비교하는 것이 유용하다**는 것입니다. 이는 설계 판단입니다. 아래 원본에서 설명하거나 공개한 내용만 확인 사실로 기재하며, 확인하지 못한 기능을 없다고 단정하지 않습니다.

## 비교 대상의 분류

- **조직 운영 도구:** 역할·작업·승인·비용·진행 상태를 관리합니다. Paperclip이 기준점입니다.
- **작업자 실행 도구:** 실제 AI 작업자가 도구를 사용하고 대화·실행을 이어가는 프로그램입니다. Hermes, OpenClaw, DeerFlow, OpenHands, Claude Code, Grok Build 등을 비교합니다.
- **협력 프레임워크:** 작업자 간 호출·메시지·상태·중단 및 재개를 개발자가 구성하는 라이브러리입니다. 제품의 조직 승인 정책까지 자동으로 제공한다고 해석하지 않습니다.
- **연구·작업 서비스:** 사용자가 맡긴 조사나 작업을 수행하는 완성 제품입니다. 공개 사용자 흐름과 API를 비교하며 공개되지 않은 내부 코드를 역으로 확인했다고 표현하지 않습니다.

이 분류는 조사용이며 각 후보가 한 계층에서만 동작한다는 뜻은 아닙니다. ‘프레임워크’는 개발용 공통 부품, ‘API’는 다른 프로그램이 요청·결과를 주고받는 접점, ‘실행 도구’는 작업자가 실제 행동하는 프로그램을 뜻합니다. ‘메모리’는 이후 작업에서 검색·활용할 저장된 맥락이며 조직 간 공유 권한과 별개입니다.

## 23개 후보

‘참고할 항목’은 후속 분석 질문입니다. **BaboJUBot의 요구사항을 이미 모두 충족한다는 표시가 아닙니다.** 라이선스는 확인된 공개 저장소 루트 기준이며 개별 파일·의존성·상용 서비스 조건은 실제 재사용 전에 따로 확인합니다. 확인일은 모든 행에 명시했습니다.

| 후보 | 주된 분류 | 1차 확인 사실과 참고할 항목 | 공개 코드 조건 / 미확인 범위 | 공식 근거 | 확인일 |
|---|---|---|---|---|---|
| Paperclip | 조직 운영 | 회사별 역할·작업·실행·승인·예산 구조를 기존 정적 조사에서 확인했습니다. 초기 계획+팀 승인 및 결과 제출/최종 완료의 구현 단위를 비교합니다. | MIT. 채용 승인 설정 조건과 문서 설명 차이를 기존 노트에 기록했습니다. 실행 미검증입니다. | [고정 소스](https://github.com/paperclipai/paperclip/tree/1b4c803816e82b0265c8422e1a804327a7ed8c54), [기존 조사](paperclip.md) | 2026-10-12 |
| Hermes Agent | 실행 도구 | 공식 README가 지속 기억·세션 검색·격리된 하위 작업자·메신저 gateway·실행 중 방향 변경을 설명합니다. 조직별 기억 격리와 Lead 연결 계약을 분석할 후보입니다. | [MIT](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE). 조직 승인·지정 공유 강제 여부는 미확인입니다. | [README](https://github.com/NousResearch/hermes-agent) | 2026-10-12 |
| OpenClaw | 실행 도구·메신저 접점 | Gateway가 세션·도구·사건·메신저 연결을 관리하고 Control UI가 연결되는 구조를 공식 README에서 확인했습니다. 메신저와 웹의 동일 상태 참조 방식을 조사합니다. | [MIT](https://github.com/openclaw/openclaw/blob/main/LICENSE). 개인/팀 설정이 독립 연구 조직의 정보 격리를 충족하는지는 미확인입니다. | [README](https://github.com/openclaw/openclaw) | 2026-10-12 |
| DeerFlow | 실행 도구·연구 시스템 | 현행 README는 2.0의 하위 작업자·기억·격리 실행 환경·메신저 gateway를 설명합니다. 기존 1.x 연구 흐름과 2.0을 구분해 조사합니다. | [MIT](https://github.com/bytedance/deer-flow/blob/main/LICENSE). 사용자 공통 기억과 agent별 기억이 우리 조직 경계와 맞는지는 미확인입니다. | [README](https://github.com/bytedance/deer-flow) | 2026-10-12 |
| GPT Researcher | 공개 연구 시스템 | 질문 분해·병렬 조사·인용 보고서, LangGraph/AG2 기반 다중 작업자 사례와 웹 진행 화면을 설명합니다. 조사·검토·보고서 생성 구조의 후보입니다. | [Apache-2.0](https://github.com/assafelovic/gpt-researcher/blob/main/LICENSE). 인용 정확성과 범용 장기 연구 운영은 실행 미검증입니다. | [README](https://github.com/assafelovic/gpt-researcher) | 2026-10-12 |
| OpenHands | 실행 도구·작업 관리 | 현행 Agent Canvas README는 대화, 일정/사건 기반 작업, Slack 등 연동을 설명합니다. 외부 실행 도구·작업·웹 화면의 연결을 비교합니다. | [MIT](https://github.com/OpenHands/OpenHands/blob/main/LICENSE). 상용 기능과 다른 구성 요소의 조건은 별도 확인이 필요합니다. | [README](https://github.com/OpenHands/OpenHands) | 2026-10-12 |
| MetaGPT | 협력 프레임워크 | 역할을 나눈 협력과 표준 작업 절차를 중심으로 구성합니다. 역할별 산출물·업무 전달 구조를 비교합니다. | [MIT](https://github.com/FoundationAgents/MetaGPT/blob/main/LICENSE). 소프트웨어 개발 중심 절차를 범용 연구 요구로 채택하지 않습니다. | [README](https://github.com/FoundationAgents/MetaGPT) | 2026-10-12 |
| CrewAI | 협력 프레임워크 | 역할별 Crews와 상태·조건·사건을 다루는 Flows를 구분하며 manager 기반 위임과 human input을 설명합니다. 자율 협력과 승인 상태의 결합을 조사합니다. | [MIT](https://github.com/crewAIInc/crewAI/blob/main/LICENSE). 상용 AMP 관리 제품과 공개 라이브러리는 구분합니다. | [README](https://github.com/crewAIInc/crewAI) | 2026-10-12 |
| LangGraph | 상태·실행 프레임워크 | 지속 실행, 상태 저장, 사람의 개입, 장단기 기억을 공식 문서에서 설명합니다. 승인 대기·피드백 반영·장기 작업 재개의 공통 기반 후보입니다. | [MIT](https://github.com/langchain-ai/langgraph/blob/main/LICENSE). LangSmith 배포 제품 조건은 별도입니다. 조직 정책은 별도 구현 여부를 조사합니다. | [README](https://github.com/langchain-ai/langgraph), [개입·재개](https://docs.langchain.com/oss/python/langgraph/interrupts) | 2026-10-12 |
| AutoGen | 협력 프레임워크·기존 사례 | 다중 작업자 협력 프레임워크입니다. 현행 README가 새 기능 개발 없는 유지보수 상태와 Microsoft Agent Framework 이전을 권고합니다. 기존 협력 패턴을 비교합니다. | [코드 MIT](https://github.com/microsoft/autogen/blob/main/LICENSE-CODE), [문서 CC-BY-4.0](https://github.com/microsoft/autogen/blob/main/LICENSE). 신규 기반으로 확정하지 않습니다. | [README](https://github.com/microsoft/autogen) | 2026-10-12 |
| Microsoft Agent Framework | 협력 프레임워크 | 순차·동시·인계·그룹 협력, 중간 상태 저장, 사람의 개입을 설명합니다. AutoGen의 현행 후속 후보로 비교합니다. | [MIT](https://github.com/microsoft/agent-framework/blob/main/LICENSE). 우리 승인·기억 정책과 실제 안정성은 미확인입니다. | [README](https://github.com/microsoft/agent-framework) | 2026-10-12 |
| AgentScope | 협력 프레임워크 | 공식 저장소가 agent 구성과 관찰·이해 가능한 실행을 목표로 설명합니다. 메시지, 상태, 실행 관찰 구조를 심층 분석할 후보입니다. | [Apache-2.0](https://github.com/agentscope-ai/agentscope/blob/main/LICENSE). 조직별 기억 및 사용자 승인 충족 여부는 미확인입니다. | [README](https://github.com/agentscope-ai/agentscope) | 2026-10-12 |
| Claude Code agent teams | 상용 실행 도구의 협력 기능 | 전용 Lead, 공유 작업 목록, 작업자 간 직접 메시지·독립 대화 맥락을 공식 문서가 설명합니다. 협력·작업 소유·알림을 비교합니다. | 해당 기능의 공개 구현 코드는 미확인입니다. 실험적 기능이며 팀원 재개 한계가 문서화되어 있습니다. | [공식 문서](https://code.claude.com/docs/en/agent-teams) | 2026-10-12 |
| Devin | 상용 작업 서비스 | 공식 문서가 웹에서 실행을 관찰·인수하는 화면과 Slack/Teams 요청을 설명합니다. 중간 개입·보고와 메신저/웹 연결 흐름을 비교합니다. | 서비스 내부 코드·조직 기억 분리 구현은 미공개/미확인입니다. | [제품 소개](https://docs.devin.ai/get-started/devin-intro), [Slack](https://docs.devin.ai/integrations/slack) | 2026-10-12 |
| Manus | 상용 작업·연구 서비스 | 공식 API가 작업·후속 메시지·프로젝트·완료/입력 필요 알림을 설명하며 Telegram 접점을 제공합니다. 장기 외부 작업·추가 지시·사건 보고의 계약을 비교합니다. | 내부 구현은 미공개/미확인입니다. 프로젝트의 공유 지시가 조직별 기억 격리와 같다고 확인하지 않았습니다. | [API 소개](https://open.manus.im/docs/v2/introduction), [Telegram](https://help.manus.im/en/articles/14033617-how-do-i-set-up-and-use-manus-agents-in-telegram) | 2026-10-12 |
| Perplexity Research / Computer | 상용 연구·작업 서비스 | 공식 도움말이 Research의 다단계 조사와 Computer의 산출물·프로젝트 기능을 설명합니다. 검색 결과에서 후속 산출물·재작업으로 이어지는 흐름을 비교합니다. | 내부 작업자 구성·기억 구현은 미공개/미확인입니다. 서로 다른 제품 모드를 같은 실행 구조로 단정하지 않습니다. | [도움말](https://www.perplexity.ai/help-center/en/articles/11187416-which-perplexity-subscription-plan-is-right-for-you), [변경 기록](https://www.perplexity.ai/en-GB/changelog/deep-research-command-panel-forking-inline-actions-and-enterprise-controls) | 2026-10-12 |
| Gemini Deep Research | 상용 연구 서비스 | 사용자에게 계획을 제시하고 수정·Start research 후 조사하는 흐름, 결과 알림·내보내기를 공식 도움말에서 확인했습니다. 초기 계획 검토 접점의 후보입니다. | 내부 구현은 미공개/미확인입니다. 작업자 팀 승인까지 제공한다는 확인은 없습니다. | [공식 도움말](https://support.google.com/gemini/answer/15719111?hl=en) | 2026-10-12 |
| Open Deep Research | 공개 연구 구현 사례 | 여러 모델·검색 도구를 설정하는 공개 연구 구현입니다. 공식 저장소는 2026-08-21 보관 처리되어 읽기 전용입니다. 질문 보완·조사 분담·종합 코드를 분석할 후보입니다. | [MIT](https://github.com/langchain-ai/open_deep_research/blob/main/LICENSE). 유지보수 중인 신규 기반으로 단정하지 않습니다. | [공식 저장소](https://github.com/langchain-ai/open_deep_research) | 2026-10-12 |
| xAI Grok 서비스 / 연구 API | 상용 연구·도구 서비스·보조 비교 대상 | 공식 문서가 실시간 다중 작업자 연구를 beta로 설명하고, 서버 측 검색·코드 도구와 사용자 함수 호출을 구분합니다. 조사 협력·근거·도구 호출 접점을 비교합니다. | 내부 실행 코드·세부 조직 정책은 미공개/미확인입니다. 사용자가 지칭한 정식 Grok Bot과 별개입니다. | [Multi Agent](https://docs.x.ai/developers/model-capabilities/text/multi-agent), [도구](https://docs.x.ai/developers/tools/overview) | 2026-10-12 |
| Grok Build | 상용 실행 도구·보조 비교 대상 | 공식 문서가 계획 검토와 도구 권한을 분리하며 계획 검토 화면은 자동 승인 모드에서도 생략하지 않는다고 설명합니다. 계획 승인과 도구 실행 승인 분리를 비교합니다. | 공개 내부 코드는 미확인입니다. Grok 연구 API와 정식 Grok Bot과 구분합니다. | [공식 권한 문서](https://docs.x.ai/build/features/permissions) | 2026-10-12 |
| xAI Grok Bot | 상용 지속 작업 서비스·사용자 지정 대상 | 공식 개요가 이름·역할·지속 맥락을 가진 Bots, 클라우드 컴퓨터의 배경 작업, Bots 간 메시지·인계·그룹 협력을 설명합니다. 지속 Lead·직접 협력·승인 질문을 비교합니다. | 내부 코드는 미공개/미확인입니다. 계정 내 Bots가 파일·브라우저·로그인을 공유하는 구조이므로 연구 조직별 격리 요구를 그대로 충족한다고 해석하지 않습니다. | [공식 개요](https://docs.x.ai/grok-bot/overview) | 2026-10-12 |
| Meta Muse | 상용 지속 작업 서비스·사용자 지정 대상 | 공식 발표가 장기 목표 계획, 앱 종료 후 진행, 변화/승인 필요 시 연락, 기억과 사용자 접근 제어를 설명합니다. 지속 연구와 사건 보고 접점을 비교합니다. | 내부 구현은 미공개/미확인입니다. 개인 agent 설명을 연구별 독립 조직·Lead·팀 지원으로 확대하지 않습니다. | [공식 발표](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) | 2026-10-12 |
| OpenAI dots | 상용 지속 작업 서비스·사용자 지정 대상 | 공식 OpenAI documentation이 대화 사이의 진행, 작업 중 새 지시·우선순위 변경, 배경 작업자 병렬 실행과 결과/판단 요청을 설명합니다. 지속 Lead·개입·여러 접점의 기억 연속성을 비교합니다. | 내부 구현은 미공개/미확인입니다. 연구 조직별 기억 경계와 팀 구성 사용자 승인은 아직 확인하지 않았습니다. | [공식 ChatGPT Learn](https://learn.chatgpt.com/docs/dots) | 2026-10-12 |

## 해석할 때 주의할 차이

1. **승인이라는 이름만으로 같은 정책으로 취급하지 않습니다.** Claude Code 문서는 팀원의 계획 요청을 Lead 세션이 사용자에게 별도 질문 없이 승인한다고 설명합니다. 이는 BaboJUBot의 사용자 초기 계획+팀 승인과 다릅니다. Gemini의 계획 확인, Grok Build의 도구 권한, Paperclip의 조건부 채용 승인도 승인 대상과 강제 범위가 서로 다릅니다. [Claude Code](https://code.claude.com/docs/en/agent-teams), [Gemini](https://support.google.com/gemini/answer/15719111?hl=en), [Grok Build](https://docs.x.ai/build/features/permissions), [Paperclip 조사](paperclip.md)
2. **여러 대화나 프로젝트가 곧 독립 연구 조직은 아닙니다.** 조직 단위의 작업 조회·기억 검색·도구 실행·공유 권한을 어디서 제한하는지 추가 확인해야 합니다. 현재 표는 후보의 조직별 정보 격리를 실행 검증한 결과가 아닙니다.
3. **조사 보고서 생성만으로 연구 완료 모델을 충족하지 않습니다.** 완료 기준 합의, 기준 충족 판단, 결과 제출, 사용자 최종 완료 및 수정 요청을 별도로 비교해야 합니다. 상용 제품의 내부 상태는 공개 자료만으로 확정하지 않습니다.
4. **현행 제품과 과거 소개가 달라졌습니다.** AutoGen은 유지보수 상태이며 Open Deep Research는 보관 처리되었습니다. DeerFlow는 1.x와 2.0이 다르고 OpenHands 현행 README는 Agent Canvas를 중심으로 설명합니다. 이전 기억으로 버전·라이선스·제품 성격을 고정하지 않습니다. [AutoGen](https://github.com/microsoft/autogen), [Open Deep Research](https://github.com/langchain-ai/open_deep_research), [DeerFlow](https://github.com/bytedance/deer-flow), [OpenHands](https://github.com/OpenHands/OpenHands)
5. **지속 작업 서비스와 조직별 정보 격리를 구분합니다.** Grok Bot은 Bot별 대화·학습 맥락의 분리와 계정 내 공유 컴퓨터의 파일·브라우저 공유를 함께 설명합니다. BaboJUBot은 연구 조직 간 지정 공유를 요구하므로 세션 기억만 분리해도 충분하다고 판단하지 않습니다. Muse와 dots의 개인 기억도 조직별 격리와 동일한 개념으로 가져오지 않습니다. [Grok Bot](https://docs.x.ai/grok-bot/overview), [Muse](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/), [dots](https://learn.chatgpt.com/docs/dots)

## 우선 심층 조사 제안 — 미확정

첫 구현 범위나 채택 결정을 뜻하지 않습니다. 조사 순서를 정하기 위한 제안입니다.

| 조사 묶음 | 우선 비교 대상 | 이유 |
|---|---|---|
| 조직·작업·승인·최종 검토 | Paperclip, LangGraph, Grok Build | 조직 운영 기준점과 실행 중 승인·재개 부품, 계획/도구 권한의 차이를 함께 확인할 수 있습니다. |
| 대화 사이 지속 연구·사건 보고·개입 | Grok Bot, Meta Muse, OpenAI dots | 사용자가 지정한 상용 서비스의 지속 작업·연락·기억·사람의 판단 흐름을 우선 비교합니다. 사용자 종료 후에도 계속 진행하는 제품 경험과 미공개 내부 구현을 구분합니다. |
| 작업자 실행·메신저/웹·개입 | Hermes, OpenClaw, DeerFlow, Manus, Devin | 사용자 접점, 장기 작업과 후속 지시 전달을 서로 다른 구현 계층에서 비교할 수 있습니다. |
| Lead와 작업자 직접 협력 | Claude Code agent teams, CrewAI, AgentScope, Microsoft Agent Framework | 직접 메시지·공유 작업·manager 분담·사람의 개입을 비교할 수 있습니다. |
| 연구 계획·근거·결과 제출 | GPT Researcher, Open Deep Research, Gemini, Perplexity, xAI 연구 API | 공개 연구 코드와 상용 조사 흐름을 연결해 품질·완료·재작업 구조를 조사할 수 있습니다. |

## 기능별 후속 조사 질문

| 확정 요구 / 공통 기능 후보 | 실제 소스·문서·동작에서 확인할 질문 |
|---|---|
| 연구별 독립 조직·전용 Lead | 조직 식별자를 저장·조회·기억 검색·도구 요청의 어디에서 강제하며 다른 조직에 대한 접근을 어떻게 막습니까? |
| 초기 계획+팀 사용자 승인 | 계획과 팀의 버전을 함께 승인할 수 있습니까? 승인 전에 실제 연구가 시작되지 않는지, 수정·반려 후 무엇을 재승인합니까? |
| 신규 작업자 추가 승인 | 제안과 실행 가능한 작업자를 구분합니까? 승인 전 하위 작업자 실행을 우회할 수 있습니까? |
| 작업자 직접 협력 | 메시지 전달·응답 대기·결과 공유·작업 담당·의존 관계를 어떻게 기록하고 중복 실행·순환 대기를 처리합니까? |
| 조직별 기억·사용자 지정 공유 | 저장과 검색의 경계를 함께 적용합니까? 공유할 내용·대상·출처·버전·회수 권한을 어떻게 표현합니까? |
| 진행 중 피드백·새 작업 | 실행 중 요청을 전달하고 기존 계획과 우선순위의 변경을 기록합니까? 이미 시작한 외부 작업과 충돌하면 어떻게 처리합니까? |
| 사건/요청 보고·메신저/웹 | 같은 실제 상태로 보고를 만들고 두 접점의 승인·보고를 연결합니까? 재전송과 중복 알림을 어떻게 처리합니까? |
| 기준 충족 결과 제출·사용자 최종 완료 | 실행자의 종료와 조직의 최종 완료를 분리합니까? 사용자 수정 요청 시 기준·계획·작업을 어떻게 갱신합니까? |
| 범용 도구·장기 외부 작업 | agent 실행과 별도인 작업 ID·상태·실패·산출물을 어떻게 추적하고 완료 사건으로 후속 작업을 재개합니까? |
| 예산·시간·실패 관리 | 실제 사용량과 추정 비용을 구분하며 실행 중 비용·재시도·대기 시간을 어떻게 제한하고 중단 후 복구합니까? |

## 조사 방법과 검증 한계

- 공식 웹 문서·공식 GitHub 저장소·README를 열람했습니다. 라이선스 표시는 저장소 화면과 GitHub API의 `license.spdx_id`를 교차 확인했습니다. AutoGen은 대표 metadata가 문서 라이선스로 나타나므로 `LICENSE-CODE`와 README의 코드/문서 구분을 따로 확인했습니다. DeerFlow, OpenHands, Microsoft Agent Framework도 루트 LICENSE 원문을 읽었습니다.
- GitHub API의 `GET /repos/{owner}/{repo}`와 `GET /repos/{owner}/{repo}/commits/main`, 고정 commit의 raw README를 소규모 병렬 요청했습니다. 저장소를 clone하거나 패키지를 설치하지 않았습니다. Paperclip은 기존 조사 노트의 고정 commit과 정적 분석을 재사용했습니다.
- 주요 열람 README 기준 예시: Hermes `3569e8461ea721623fa16e6f01fb636157989fe6`, OpenClaw `b82b033920ee7a4df6323e3ee2b04ac8c6037fe0`, DeerFlow `1f15e0b43ca58b9601514f9f5c408fb032022833`, GPT Researcher `3582a6841fe7dc801e2a34e34ee408641aea9bce`, OpenHands `0f1b6f62507f1ccdb4e63f61cf3dc48356a0d4fa`, AutoGen `027ecf0a379bcc1d09956d46d12d44a3ad9cee14`, Open Deep Research `1b7d2e80db9faa586165c60e09096dbbfd483a64`, Microsoft Agent Framework `81836614649a31fca81cfe28995f6d816ae1f6c2`입니다. 이는 README 조사 기준이며 실제 주요 실행 경로를 코드 분석한 버전 목록은 아닙니다. 표의 기본 브랜치 링크와 상용 문서는 나중에 달라질 수 있습니다.
- 일부 추정 문서 URL은 접근 오류가 발생했습니다. Devin은 공식 문서 첫 페이지의 실제 Slack 링크를 따라 확인했고, xAI는 실제 공식 도구 URL로 다시 확인했습니다. Perplexity의 추정 Research 도움말 URL은 확인하지 못해 실제 공식 도움말·변경 기록만 사용했습니다.
- OpenAI dots는 OpenAI Docs 스킬에 따라 공식 `learn.chatgpt.com`에서 주제를 검색하고 실제 공식 문서를 열어 확인했습니다. API 구현이나 호출은 수행하지 않았습니다.
- **완료 범위:** 23개 1차 후보와 기능별 후속 조사 질문입니다. **미실행 범위:** 전수 기능 분석, 저장소 전체 코드 감사, 로그인 서비스 관찰, 실제 실행·장애·예산·격리·승인 검증, 라이선스의 전체 의존성 감사입니다. 따라서 실제 채택 전에는 대상 버전을 고정하고 해당 기능의 문서 설명·서버 강제·실행 결과를 구분해 확인해야 합니다.

## 다음 단계

**필수:** 위 승인·협력·기억·보고·완료 질문을 기준으로 기능별 심층 조사를 수행합니다. 사용자 지정 Grok Bot·Meta Muse·OpenAI dots의 공개 제품 흐름과 Paperclip·Hermes 등의 공개 구현을 같은 질문으로 비교합니다. 비공개 내부 구현은 미확인으로 남깁니다.

**필수:** 코드 재사용 또는 연동 대상으로 좁혀진 기능은 버전을 고정하고 실제 승인·조직 격리·실행 중 개입·중단 후 재개를 검증합니다. 후보 존재 확인만으로 실제 동작을 보장할 수 없기 때문입니다.

**권장:** 여러 후보에서 기능별로 근거를 수집한 뒤 Paperclip 확장, 일부 모듈 재사용, 독립 구현의 선택지를 비교합니다. 현재 단계에서 하나를 미리 선택하지 않습니다.

**선택:** Browser Use, smolagents 등 도구 실행·가벼운 작업자 구현 후보와 사용자가 추가로 지칭하는 개인 프로젝트를 다음 조사 묶음으로 확장합니다. 이번 23개가 유명 프로젝트 전체 목록이라는 주장은 하지 않습니다.
