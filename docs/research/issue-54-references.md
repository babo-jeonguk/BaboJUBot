# issue-54 레퍼런스 조사: 판 1 · 목표 합의와 초기 연구 승인

조사일: 2026-10-18. 대상: [#54](https://github.com/babo-jeonguk/BaboJUBot/issues/54). 구현 전 기술 권고이며 확정 계약이나 구현 결과가 아니다. 상세 자료: `.reference-cache/issue-54/`(git 무시).

## Brief

- 구현할 문제: Lead 대화로 합의한 목표·완료 기준을 기록하고, 계획·팀·환경 명세·흐름 템플릿을 하나의 초기 연구 승인 요청으로 올린다. 사용자 승인 후 팀과 하네스 사본을 만들고 Lead를 깨운다. 반려·수정 요청은 사유와 함께 계획 수립으로 돌린다.
- 동종 문제: **버전이 고정된 복합 제안의 사용자 결정을 한 번 적용하고, 그 결정에 묶인 리소스 사본과 후속 입력을 원자적으로 생성하는 업무 승인**.
- 고정된 결정: [AGENTS](../../AGENTS.md), [용어](../../GLOSSARY.md), [기능](../features.md), [구조](../architecture.md), [ADR](../adr/)가 기준이다. 초기 연구 승인·사용자 최종 완료는 끌 수 없다. 조직 도구 scope는 실행 시도 토큰에서 정하고 정책은 제품 코드가 강제한다. PG/Drizzle/Express/React/Query/zod와 가짜 프로바이더를 유지한다.
- Lead Role·Soul은 조직 생성 때, 흐름 템플릿은 승인 때 조직 사본으로, 작업자 Role·Soul·Skill은 승인 때 에이전트별 별도 식별자 사본으로 복사한다. 같은 Role도 공유하지 않는다. bundle 버전은 에이전트 사본 내용에서 정하고 바뀌면 새 세션을 연다. 환경 명세는 문서로만 다루며 실제 환경 구축·모델 호출은 하지 않는다.
- 읽기 전용 에이전트 하네스 보기는 #54, 편집·revision은 후속 #64. 작업·작업자 실행은 #55, 선택 승인 정책은 #58, 재시작 복구는 #60, outbox·Inbox 완성은 #61이다. #53은 병합 완료했으며 연구 조사와 구현은 구별한다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 목표 기록·제안·결정의 상태와 사용자 권한을 어디서 강제하며 승인 전 직접 호출을 어떻게 거부·기록하는가? | #54 도구·단계별 허용 도구·AC4/6/7; #49 stories8/10/11/18 | Source Recon + adversarial scenario |
| Q2 | 중복·경합·실패에도 결정을 한 번 적용하고 팀·사본·stage·Event·Lead wake를 함께 저장하는가? | #54 AC1/5/6/7; ADR2 | Source Recon + persistence/recovery + 독립 PG probe |
| Q3 | 승인받은 계획·팀·환경·템플릿과 실제 생성 내용이 바뀌지 않게 묶는 최소 표현은? | #54 단일 승인 요청; features 승인 대상 버전 미결 | Source Recon + protocol/contract + stale snapshot 대조 |
| Q4 | 라이브러리→조직/에이전트 사본의 독립성, provenance, 내용 기반 bundle 버전과 세션 경계를 어떻게 잡는가? | #54 하네스 규칙·AC1/2/3; ADR1 | Source Recon + persistence/recovery + 제한 원본 함수 실행 |
| Q5 | Inbox→계획·팀·환경 통합 검토→결정 및 agent 하네스 읽기 보기를 상태·조직·좁은 폭에 맞춰 제공하는가? | #54 화면·AC8; features 웹 화면 지도 | Surface Capture + Behavioral Recon + Source Recon |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [#53](issue-53-references.md#brief) | PG 잠금·wake·실행 토큰·bundle 세션 계약·공개 활동 범위 | 과거 실행을 이번 승인 실행으로 세지 않는다. 현재 core/run·db/runs·server/tools를 읽어 연결 위치만 확인 |
| [#52](issue-52-references.md#brief)·[#1](issue-1-references.md#brief) | 조직 생성 transaction, strict 명령, fake runtime 검증 | 스택·생성은 구현을 기준으로 읽고 옛 저장 엔진 선택/과거 backlog 권고는 재채택하지 않음 |
| [#50](issue-50-references.md#brief)·[화면 조사](paperclip-dashboard.md)·[후보](dashboard-references.md) | Inbox와 도메인 승인 구별, scope/cache, 에이전트 상세 | 확정 화면 지도와 #54의 별도 승인 상세가 우선. 캡처 재사용 없이 필요한 상태 새 확인 |
| [실행 모델](agent-runtime-models.md)·[협력](agent-interaction-models.md)·[Paperclip](paperclip.md)·[코드 구조](reference-code-structure.md) | adapter·하네스·승인 소스 후보 | 고정 ref 파일별 비교 또는 새 ref 원문 재독. 기존 E는 위 문서 링크로만 인용 |
| [#51](issue-51-references.md#brief)·[비교 목록](comparative-survey.md) | 템플릿/그래프 경계·후보 출발점 | 그래프 layout은 #56으로 이번 심층 제외 |

기존 `.reference-cache/issue-{1,50,51,52,53}/`는 소스·도구 위치 탐색에 사용한다. 실행 로그와 신규 근거는 이번 캐시에 별도 보존한다.

## 레퍼런스

후보 **34행·31종**(승인16·하네스7·화면11, 관점 간 중복 포함)이다. 전체 후보·실행 경로는 `candidates.md`, 라운드별 검색은 `notes/{approval,harness,surface}.md`에 남겼다. 공개 생태계 전수조사가 아닌 질문별 패턴 포화다.

| 관점 | 마지막 라운드와 saturation 근거 |
|---|---|
| 승인·업무 gate | 4라운드. agent→workflow→CI/cloud callback→TS event/document approval로 확장. 마지막 기존 후보의 실패 절·추가 검색은 correlation·인가·중복·재실행·timeout·부분 실패의 기존 변형만 더해 종료 |
| 하네스 사본·지침 | 4라운드. 제품→포맷 명세→template renderer→symbol/실패 경로. 마지막 mirror·개인 template·runtime guide는 생성/보존/인가 분리/세션 경계 외 새 패턴이 없음 |
| 승인·사본 화면 | 3라운드. 제품/부품 데모→human task/co-planning→실패 이슈. 마지막 사례가 note 미전달·wake 누락·목록→상세→결정의 기존 실패와 패턴을 반복 |

| 심층 대상 | 버전·고정 SHA | 라이선스 | 깊이·선정 이유 |
|---|---|---|---|
| Paperclip | `c9669a6c2237626ab0b0b2059d34c3965a86f02f` | MIT, root 직접 확인 | 소스·테스트 읽기·순수 함수 제한 실행. 같은 스택의 승인/CAS/조직 잠금/하네스/화면과 계약 불일치 반례 |
| OpenClaw | `28f97f236f882af739aac9f0e6e77d83b2da2a7c` | MIT, root 직접 확인 | 소스·테스트 읽기. AGENTS/SOUL 생성·기존 파일 보존·atomic publish의 다른 해법 |
| Agent Skills | `69ef37e9424c0a7ea9dd2293b559e43ec8176379` | root Apache-2.0, docs CC-BY-4.0 직접 확인 | 명세 원문. SKILL.md 포맷과 allowed-tools의 한계 |
| PostgreSQL18 | 공식 18 문서; 실행은 PG18.1 | PostgreSQL License | 명세·독립 SQL 실행. 승인 경합/rollback/조직 관계/사본 스냅샷의 최소 메커니즘 |
| Temporal·LangGraph | 공식 문서 2026-10-18 확인, 문서 배포 SHA 미확인 | 문서 라이선스 재사용 검토 안 함 | 문서. 수락/완료 분리와 resume 재실행의 반례; 새 엔진 채택 대상 아님 |
| GitHub protected branches | 공식 문서 2026-10-18 확인, 문서 배포 SHA 미확인 | 서비스 문서 | 문서. 검토 대상 변경 시 오래된 승인을 무효화하는 인접 패턴 |
| assistant-ui Approval card | 공개 배포 2026-10-18, 배포 SHA 미확인 | OSS repo MIT는 기존 조사에 있으나 이번 배포 자산 라이선스 대응 미확인 | 공개 scripted UI 조작. 요청→결정 receipt와 좁은 폭 |
| handup | beta 공개 데모 2026-10-18, 배포 SHA 미확인 | 상용; 코드 재사용 제외 | 공개 browser demo 조작. Markdown 계획·사유·결정 footer. 서버·hash 보장 미확인 |

이번에는 **설계 참고만 권고하며 제품에 코드 복사나 새 라이브러리 도입을 권고하지 않는다.** 캐시의 probe는 별도 조사 실험이다. 복사 시 해당 SHA의 파일 header·NOTICE·의존성까지 다시 확인하고 출처·SHA·경로와 루트 고지를 남겨야 한다.

## 근거

모든 확인일은 2026-10-18이다. 메인이 아래 결정에 사용한 원문과 8개 캡처를 다시 열었다. `main-verification.md`에 일치·정정과 범위를 기록했다. 테스트는 실행 표시가 없으면 **읽기만** 했다. 기존 Paperclip `4415665`와 새 ref는 파일별 blob 비교로 확인했다(상세 `recon/approval.md`, `recon/surface.md`). 공통 파일은 동일하며 변경된 agents route·AgentDetail은 새 원문을 읽었다. 하네스 파일은 새 SHA 원문을 별도로 읽었다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | PG Read Committed의 UPDATE는 경쟁 transaction이 끝난 뒤 WHERE를 다시 검사한다. 행 잠금과 복합 FK는 별도 계약이다. | [isolation](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED) · [row locks](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS) · [FK](https://www.postgresql.org/docs/18/ddl-constraints.html#DDL-CONSTRAINTS-FK) | 문서 주장 |
| <a id="E02"></a>E02 | 독립 PG 실험 7건·23 assertions PASS. 선행 읽기+id-only UPDATE의 덮어쓰기 반례, CAS 경합 패자0행, 승인/stage/team/event/wake rollback, 응답 유실 재시도0, scope predicate, 독립 FK의 교차 조직 허용 반례, 고정 내용의 사본 분리를 확인했다. | `probes/postgres-approval.mjs`, `postgres-approval-log-prlimit.txt`; Node24.21.0·PG18.1·pg8.16.3. 제품·upstream API/스키마 실행 아님 | 실행 확인 |
| <a id="E03"></a>E03 | Paperclip resolveApproval은 pending/revision_requested 조건부 UPDATE다. 같은 결과 재요청은 applied=false로 돌려주고 route tests는200/no duplicate wake를 assert한다. #54의 재결정 거부와 다르다. | [resolveApproval](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/server/src/lib/approval-records.ts#L5-L64) · [route tests](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/server/src/__tests__/approval-routes-idempotency.test.ts#L146-L202) | 소스 확인 |
| <a id="E04"></a>E04 | requestRevision과 resubmit은 SELECT에서 상태를 확인하고 UPDATE에서는 id만 검사한다. 수정 재제출은 같은 행의 결정 메타데이터를 지우고 pending으로 되돌린다. | [requestRevision/resubmit](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/server/src/services/approvals.ts#L82-L122) | 소스 확인 |
| <a id="E05"></a>E05 | hire 결정은 회사 행 잠금 transaction 안에서 승인과 agent activation/create를 묶는다. activation Event 실패 시 agent와 approval rollback을 assert하는 DB 테스트가 있다. | [hireApprovalService.decide](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/server/src/modules/agent-lifecycle/adapters/approvals.ts#L21-L92) · [transaction](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/server/src/services/accounting-transaction.ts#L7-L20) · [tests](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/server/src/modules/agent-lifecycle/__tests__/lifecycle.test.ts#L322-L357) | 소스 확인 |
| <a id="E06"></a>E06 | approval.approved activity와 requester wake는 service commit 뒤 route의 applied 분기에 있다. reject는 linked issue review path wake, revision은 logActivity 후 반환한다. 세 결과의 requester wake가 대칭인 코드는 이 구간에서 확인되지 않는다. | [approve route](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/server/src/routes/approvals.ts#L304-L393) · [reject/revision](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/server/src/routes/approvals.ts#L412-L470) | 소스 확인 |
| <a id="E07"></a>E07 | 결정 route는 assertBoard와 resource access, actor의 userId를 사용한다. 반면 hire route는 선택 승인 flag에 따라 pending agent와 지침을 먼저 만들고 승인 요청을 생성한다. #54의 승인 후 팀 생성과 다르다. | [approve auth](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/server/src/routes/approvals.ts#L296-L304) · [hire 순서](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/server/src/routes/agents.ts#L4387-L4474) | 소스 확인 |
| <a id="E08"></a>E08 | 상세 approve/reject/revision mutation은 note를 전달하지 않고, 댓글은 별도 요청이다. API는 optional decisionNote를 받는다. 상세는 query 실패와 not found를 이 구간에서 구분하지 않는다. | [mutations](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/ui/src/pages/ApprovalDetail.tsx#L88-L150) · [API](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/ui/src/api/approvals.ts#L11-L22) | 소스 확인 |
| <a id="E09"></a>E09 | 상세는 payload와 원문 펼침, 결정 후 CTA를 제공한다. 각 결정 버튼은 자기 mutation pending만 disable하고 revision_requested도 actionable이다. | [payload](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/ui/src/pages/ApprovalDetail.tsx#L150-L239) · [buttons](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/ui/src/pages/ApprovalDetail.tsx#L264-L309) | 소스 확인 |
| <a id="E10"></a>E10 | agent 변경 시 선택 파일/모드/draft를 초기화하고 agent+path로 조회한다. 본문은 Markdown/빈 파일/원문 모드지만 edit도 제공한다. 별도 preserved-edit 테스트는 해당 영역에 editor와 save 호출이 없음을 assert한다. | [agent reset/query](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/ui/src/pages/AgentDetail.tsx#L2287-L2349) · [mode](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/ui/src/pages/AgentDetail.tsx#L3034-L3048) · [render](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/ui/src/pages/AgentDetail.tsx#L3126-L3167) · [read-only test](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/ui/src/pages/AgentDetail.instructions.test.tsx#L433-L455) | 소스 확인 |
| <a id="E11"></a>E11 | managed root는 company/agent별이다. files map을 그 root에 쓰며 DB owner lock이 있지만 파일 쓰기 자체가 DB rollback되는 계약은 아니다. 현 default bundle은 AGENTS.md 하나다. | [owner root](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/server/src/services/agent-instructions.ts#L136-L145) · [materialize](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/server/src/services/agent-instructions.ts#L759-L822) · [default](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/server/src/services/default-agent-instructions.ts#L3-L26) | 소스 확인 |
| <a id="E12"></a>E12 | OpenClaw bootstrap은 기존 파일을 보존하고 새 파일은 atomic/durable로 공개한다. 실패 시 partial 파일이 없고 동시 생성 winner 하나만 완전함을 assert하는 테스트가 있다. 승인 purpose와 기존 AGENTS가 다르면 오류다. | [publishBootstrapFile/publishAgentInstructions](https://github.com/openclaw/openclaw/blob/28f97f236f882af739aac9f0e6e77d83b2da2a7c/src/agents/workspace-bootstrap-publish.ts#L15-L77) · [tests](https://github.com/openclaw/openclaw/blob/28f97f236f882af739aac9f0e6e77d83b2da2a7c/src/agents/workspace-bootstrap-publish.test.ts#L77-L155) | 소스 확인 |
| <a id="E13"></a>E13 | instructionPath는 상대 경로·traversal·빈 부분·backslash·NUL 등을 검사하고, instructionBytes는 UTF-8/1MiB를 검사한다. | [두 함수](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/server/src/services/agent-instruction-files.ts#L7-L53) | 소스 확인 |
| <a id="E14"></a>E14 | 위 두 원본 함수를 추출하고 TS 타입만 제거해 17 assertions PASS. 정상 skill 경로/한국어/BOM과 traversal·잘못된 UTF-8·surrogate·초과 길이를 대조했다. unprocessable만 Error constructor로 대체했다. | `probes/instruction-files.mjs`, `instruction-files-log.txt`; Node24.21.0. filesystem/I/O/symlink/service/HTTP는 실행하지 않음 | 실행 확인(제한) |
| <a id="E15"></a>E15 | Agent Skills는 SKILL.md frontmatter의 name/description과 Markdown 본문을 정한다. allowed-tools는 선택·실험적이며 구현별 지원이 다르다. | [format](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx#L6-L32) · [allowed-tools](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx#L163-L185) | 문서 주장 |
| <a id="E16"></a>E16 | OpenClaw 문서는 workspace가 cwd이며 hard sandbox가 아니고 AGENTS Tools 절도 availability 제어가 아닌 guidance라고 명시한다. | [workspace](https://github.com/openclaw/openclaw/blob/28f97f236f882af739aac9f0e6e77d83b2da2a7c/docs/concepts/agent-workspace.md#L9-L18) · [Tools](https://github.com/openclaw/openclaw/blob/28f97f236f882af739aac9f0e6e77d83b2da2a7c/docs/concepts/agent-workspace.md#L73-L86) | 문서 주장 |
| <a id="E17"></a>E17 | LangGraph resume은 interrupt가 있는 node의 앞부분을 재실행하므로 앞선 부작용의 중복을 고려해야 한다. Temporal은 Update 수락과 완료를 구별하고 async handler의 await 경합을 별도로 다룬다. | [LangGraph Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) · [Temporal message passing](https://docs.temporal.io/develop/typescript/workflows/message-passing) | 문서 주장 |
| <a id="E18"></a>E18 | GitHub branch 보호는 검토 대상 변경 시 stale approval을 무효화하는 옵션을 둔다. 이 옵션의 구체 제품 정책을 초기 연구 승인에 그대로 가져오지는 않는다. | [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) | 문서 주장 |
| <a id="E19"></a>E19 | 공개 UI8캡처를 조작·재열람했다. assistant-ui는 요청→반려/진행/완료 receipt, handup은 Markdown 계획·사유 입력·390px footer를 보여준다. handup Deny 후 Inbox8→7과 Undo toast는 관찰했지만 최종 이력 추가는 미확인이다. | [Approval card](https://www.assistant-ui.com/elements/approval-card) · [handup](https://gethandup.dev/); `captures/captures.md`, `probes/ui-capture-log.json` | 실행 확인 |
| <a id="E20"></a>E20 | Paperclip working copy baseHash는 선택 entry 파일 bytes의 SHA256이다. 전체 Role/Soul/Skill bundle 해시의 근거가 아니다. | [prepare](https://github.com/paperclipai/paperclip/blob/c9669a6c2237626ab0b0b2059d34c3965a86f02f/server/src/services/agent-instruction-working-copies.ts#L145-L170) | 소스 확인 |

근거20개: 실행3·소스12·문서5. E04의 경합, E06의 commit 뒤 손실, E11의 filesystem/DB 경계에서 도출한 위험은 **추론**이며 upstream 전체 서비스의 실제 장애 재현이 아니다. E02는 그 최소 SQL 메커니즘만 검증한다.

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 승인 요청과 결정, 조직 단계, 실행 상태를 구분 | E03–E07,E17 | agent별 채용/flow interrupt/연구 조직 전체 최초 승인은 단위가 다름 | 사용자 승인 이후에만 팀 생성 | 같은 행 재제출로 옛 검토 대상 소실·재결정 |
| <a id="P02"></a>P02 | 조건부 결정+소유 조직 잠금+한 transaction의 도메인 효과 | E01–E06 | PG CAS는 경쟁자0행; Paperclip route wake는 tx 밖 | 중복·부분 실패 방어 | id-only revision overwrite·commit 뒤 Event/wake 공백·잠금 순서 충돌 |
| <a id="P03"></a>P03 | 검토 내용 고정과 승인한 내용으로 생성 | E02,E11,E12,E18 | snapshot 저장 또는 불변 ref+digest, library 경로만으로는 부족 | 검토와 생성의 내용 일치 | library drift, filesystem 부분 쓰기, 오래된 화면의 결정 |
| <a id="P04"></a>P04 | 사본 소유 ID와 내용 버전을 분리 | E02,E10–E14,E20 | 회사/agent root, workspace bootstrap, #54 명시 copy ID | 같은 Role 사본 독립·재현 가능한 지침 | entry 파일 해시만 쓰면 Soul/Skill 변경 누락; runtime에 원본 재주입 |
| <a id="P05"></a>P05 | 문서 관례와 제품 권한을 다른 경계에 둠 | E07,E13,E15,E16 | AGENTS/SOUL/SKILL은 지침; 도구 allowlist는 실행 시 검사 | 직접 호출에도 승인 경계 유지 | prompt/allowed-tools/cwd만으로 차단했다고 오인 |
| <a id="P06"></a>P06 | 상세 검토·사유와 결정 결합·서버 결과 receipt | E08–E10,E19 | Paperclip 댓글 별도, assistant-ui 단일 action card, handup feedback/undo | 사용자가 무엇을 결정했는지 알 수 있음 | 사유 미전달·개별 pending 경쟁·낙관적 성공·조회 실패를 없음으로 표시 |

## 결정 권고

다음은 구현 전 권고이며 계약 확정이 아니다. 제품 불변 조건과 #54 AC를 우선한다.

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | core에서 신뢰된 actor·조직·현재 단계·도구를 함께 검사. 목표 기록은 목표 설정의 Lead, 초기 요청은 계획 수립의 Lead, 결정은 사용자 명령만 허용. 승인 전 작업 생성·작업자 추가는 runtime 노출과 직접 dispatch 양쪽에서 막고 인증된 거부를 Event에 남김 | P01,P05; #54 AC4/6/7 | 노출 목록은 편의이고 실제 거부는 도메인 명령 경로가 책임. 기본 꺼진 선택 정책으로 초기 gate를 우회할 수 없음 | Q1 |
| <a id="D02"></a>D02 | 변형 채택 | approve/reject/request_changes 모두 같은 pending→결정 CAS를 사용. 결정된 요청은 같은 outcome 포함 재결정 거부. 수정 후 제안은 새 요청 ID(또는 불변 revision)로 옛 결정을 보존 | P01,P02; #54 AC5/6 | Paperclip의200 no-op와 같은 행 reset을 그대로 쓰면 요구 불일치. 응답 유실은 조회로 확정 결과 확인 | Q1,Q2,Q3 |
| <a id="D03"></a>D03 | 변형 채택 | 조직 행→승인 요청→agent/run 등 일관된 잠금 순서를 정하고, 승인 결정·연구 진행 stage·팀·각 사본·템플릿 사본·Lead wake·Event를 한 PG transaction에 저장. 반려/수정도 결정·계획 수립 stage·사유 wake·Event를 같은 tx로 저장 | P02,P03; #54 AC1/5/7 | commit 뒤 hub publish/dispatcher kick은 알림·처리 촉진만 맡음. 영속 wake와 Event 저장을 postcommit에 미루지 않음. 새 잠금은 기존 #53 agent/run lock 순서와 대조 필요 | Q2 |
| <a id="D04"></a>D04 | 변형 채택 | 요청에 목표·완료 기준, 계획, 팀 명세, 환경 문서, 템플릿 및 복사 원본의 불변 내용/버전을 묶음. 승인 시 현재 library 경로를 무조건 재읽지 않고 검토한 내용을 복사. 추천은 서버가 검증한 snapshot 저장; 표현은 열린 결정 | P03; E02,E18 | 원본 drift/옛 화면의 다른 제안 승인을 예방. 환경 문서는 실행 명령·자격 증명이 아니며 실제 구축은 #55 이후 작업 | Q3,Q4 |
| <a id="D05"></a>D05 | 채택 | Lead 사본은 조직 생성 transaction에, worker별 사본과 조직 template 사본은 승인 transaction에 저장. 같은 Role도 별도 copy ID/owner/provenance를 부여. 승인 전 worker agent/사본을 미리 만들지 않음 | P01,P03,P04; #54 AC1/2/3 | 최초 내용은 같아도 소유 사본은 다름. DB에 사본 내용을 두고 runtime 파일은 파생 출력으로 두면 승인 원자성 단순화 | Q2,Q4 |
| <a id="D06"></a>D06 | 변형 채택 | bundle version은 agent 사본의 실제 지침 전체(Role/Soul/Skill 및 주입하는 부속자료)의 결정론적 manifest+내용에서 산출. 경로·파일 경계·조립 규칙 버전을 포함하고 ID/시간은 내용 버전과 분리. 같은 내용의 두 agent는 같은 version이어도 됨 | P04; E20; ADR1 | 단일 entry hash·library 버전·mtime을 bundle 버전으로 대신하지 않음. 이 버전과 기존 planRunStart의 새 세션 분기를 연결. 구체 직렬화는 #54 owner | Q4 |
| <a id="D07"></a>D07 | 변형 채택 | 최소 Lead Role/Soul, worker Role·Soul 사본과 노드 기록 Skill, 기본 흐름 template을 제공. worker Soul의 기본 내용/복사 원본도 명시. SKILL name/description과 고정 상대 경로·UTF-8를 검증. 흐름 node/edge 종류의 구조만 검증하고 연구 판단은 harness가 담당 | P04,P05; E13–E16; #54 범위 | 임의 파일 manager/템플릿 엔진/런타임 지침 수정 체계를 이번에 도입할 필요 없음. 프롬프트 금지문은 gate가 아님 | Q1,Q4 |
| <a id="D08"></a>D08 | 변형 채택 | 확정된 별도 승인 상세에서 계획·팀·환경·템플릿과 요청 식별자를 함께 읽고 결정. 반려/수정 사유는 같은 명령 payload로 보냄. 세 버튼 공통 pending, 서버 성공 후 receipt, 이미 결정이면 재조회 결과 표시 | P06; #54 AC8 | 실패 시 사유 유지·재시도, 404/조회 실패 구분, 조직 전환 시 옛 응답 배제. 읽음·보관은 결정이 아님. 390px에서 긴 내용과 결정부를 함께 접근 가능하게 함 | Q3,Q5 |
| <a id="D09"></a>D09 | 변형 채택 | 에이전트 상세에 해당 agent 소유 Role/Soul/Skill 사본을 Markdown/원문으로 읽기 전용 제공. 조직+agent+사본으로 조회하고 전환 시 선택/데이터 초기화. 빈 파일·오류·로딩 구분 | P04,P06; E10,E19; #54 AC8 | read 기본 모드의 editable viewer를 복사하면 읽기 전용 보장이 아님. 편집/저장/revision은 후속 #64 | Q4,Q5 |
| <a id="D10"></a>D10 | 배제 | 새 workflow 엔진·자체 agent loop, 초기 승인 always-allow/YOLO/timeout 자동승인/지연 Undo, 환경 자동 구축, 신규 작업자 선택 정책·완료 결정까지 #54로 확대하지 않음 | P01,P05,P06; ADR1/3/4; #54/55/57/58/60/61/64 | fixed 초기 승인과 세부 후속 범위를 유지. 엔진 사례는 실패 메커니즘 비교 자료 | Q1,Q2,Q5 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 승인 전에 pending worker와 지침을 생성 | E07 | #54는 승인 시 제안 팀을 생성하며 계획 단계의 worker 추가를 금지 |
| 같은 결과는200/no-op, revision은 같은 행을 다시 pending으로 reset | E03,E04 | 이미 결정한 요청의 재결정 거부·검토 대상 보존과 다름 |
| SELECT 뒤 id-only 갱신, 승인 commit 뒤 필수 Event/wake 생성 | E04,E06 | 경합과 부분 실패 공백. 최소 메커니즘은 E02로 확인했지만 upstream 전체 장애는 미재현 |
| library 경로 공유·단일 AGENTS hash·filesystem copy의 SQL rollback 가정 | E11,E12,E20 | 사본 독립성과 bundle 전체 변화·원자성을 보장하지 못함 |
| 댓글=사유, 버튼별 pending, 원문 viewer의 edit 토글 | E08–E10 | 사유 누락·경합·읽기 전용 범위 위반 |
| 문서 allowed-tools 또는 workspace cwd를 제품 권한/격리로 사용 | E15,E16 | 구현별 지침과 보안 강제 경계는 다름 |

## 구현 참고

구현 위치는 [구조](../architecture.md#패키지-구성)와 [코드 지도](../agents/code-map.md) 기준이다. `packages/contracts`에 요청/결정/하네스 조회/깨우기·Event의 구체 schema를, `packages/core`에 생애주기·actor·단계별 도구 규칙을, `packages/db`에 조건부 결정과 사본/팀/wake/Event transaction을 둔다. `apps/server`는 사용자 명령과 실행 시도 토큰 도구를 분리해 같은 core 규칙을 호출한다. `apps/web`은 조회·제어·상태 표시를 맡고 `harness/`에는 연구 내용물을 둔다. web이 db를 직접 읽거나 harness가 core 승인 규칙을 대신하지 않는다.

현재 #53의 `wakeReasonSchema`/core Wake는 owner_message·messageId에 한정되고, dispatcher가 bundle version을 넘겨받는 자리만 있다. 승인 사유를 가짜 채팅 메시지로 꾸미기보다 승인 ID·결정·사유를 가진 wake 계약을 확장하는 편이 직접적이다. 조직 생성 plan/transaction에 Lead 사본을 묶고, 승인 transaction의 worker 사본을 기존 bundle/session 분기와 연결한다. 아래 경계는 **구현 검증 제안**이며 이번에 제품 테스트로 실행한 것이 아니다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 새 조직 생성 → Lead/Role/Soul 사본·Event 함께 생성, stage 목표 설정. 사본 실패 → 조직/Lead 생성도 rollback | D03,D05 |
| V02 | Lead 목표·완료 기준 기록 → 계획 수립; 계획 요청 → 승인 대기. 승인 전 작업/worker 직접 HTTP 호출 → 자원 변경0·runtime 작업 호출0, 거부 Event는 해당 조직/실행 시도 귀속 | D01,D07 |
| V03 | 사용자 승인 → 정확한 제안 팀·worker별 사본·조직 template·연구 진행·Lead wake·Event. 같은 Role2명 → copy ID 다름·owner 다름·초기 내용 같음 허용 | D03–D06 |
| V04 | reject와 request_changes 각각 → 계획 수립·사유 포함 Lead wake·제어 Event, worker 생성0. 후속 새 제안 → 옛 요청의 결정/내용 보존 | D02,D03,D08 |
| V05 | approve/approve·approve/reject·approve/request_changes를 동시에 요청 → 한 결정만 성공, 패자는 명시 거부. 재시도 포함 team/copy/wake/Event 중복0 | D02,D03 |
| V06 | 사본/팀/Event/wake 저장 중 오류 → 결정·stage 포함 전체 rollback. commit 뒤 알림 오류/응답 유실 → 영속 결정은 조회 가능, 중복 적용0 | D03; E02 |
| V07 | A run token이 B approval/copy/agent ID 또는 없는 ID 사용 → 같은 not-found, 사용자 결정 endpoint에 agent token만 제시 → 거부. body에 actor/org를 위조해도 신원/소유 범위 불변 | D01,D03,D09 |
| V08 | 요청 뒤 library 변경/목표 변경 또는 오래된 요청 ID → 승인해 생성되는 내용이 검토 snapshot과 같거나 명시 stale 거부; 변경 원본을 조용히 적용하지 않음 | D02,D04 |
| V09 | 동일 사본 내용으로 bundle 조립 반복 → version 같음; Role/Soul/Skill 중 하나가 다른 fixture → version 다름, 이전 세션 없음. 실제 저장 편집의 agent간 독립성은 #64 | D05,D06 |
| V10 | Inbox→상세에서 목표·계획·팀·환경·템플릿 검토→세 결정. pending 공통 잠금·실패 사유 보존·이미 결정/404/조회 실패·다른 탭·A→B stale·390px 확인 | D08 |
| V11 | agent A/B 사본 보기→소유 표시와 실제 사본 내용. 빈/오류/로딩/좁은 폭 구별, textarea/contenteditable/save 요청 없음. 다른 조직 사본 접근 거부 | D09 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 승인 대상 내용의 표현 | #54 | **추천: 요청 snapshot에 서버가 확정한 내용+digest 보존** — 검토/생성 일치 단순. 대안: 불변 library revision ID+파일 digest pin, 불변 원본 보존 체계가 필요. 단순 mutable 경로만 저장하는 안은 배제(P03) |
| 수정 재제안 식별 | #54 | **추천: 새 approval ID+이전 요청 연결** — 각 요청1회 결정과 감사가 직접적. 대안: 요청+불변 proposal revision을 별도 key로 하되 결정은 revision마다1회. 같은 결정 행 초기화는 배제(E04) |
| 기존 #52/#53 조직 Lead 사본 | 사용자/#54 | 새 조직은 필수. 기존 dev 데이터는 명시 migration/backfill로 원본·시각을 남기거나 dev DB 재생성 절차를 안내할 수 있음. startup마다 원본을 덮어쓰는 안은 배제(P04). 데이터 이관 정책은 이번 조사로 확정하지 않음 |
| worker Soul의 최소 원본 | #54 | 최소 내용물 목록에는 worker Role/Skill만 명시되지만 사본 AC는 Soul도 요구한다. 기본 worker Soul을 라이브러리에 두거나 명시한 기본 Soul에서 복사하여 에이전트별 사본을 충족해야 한다. 빈 사본 사용 여부도 구현 계약에 명시(D05,D07) |
| 사본/manifest 직렬화 상세 | #54, 편집 #64 | 파일 경로 순서·byte 경계·encoding·조립 format 버전의 결정론적 규칙 확정 필요. copy ID와 content version을 구분하고 full bundle fixture로 검증(D06) |

#55는 작업/worker 실행, #56은 template 구조를 소비하는 연구 지도, #57은 결과·최종 완료, #58은 선택 승인 정책, #59는 실행 제어, #60은 재시작 복구, #61은 알림 outbox·Inbox 완성, #64는 사본 편집·revision을 맡는다. #54에서 영속 wake와 제어 Event를 저장하는 책임을 이 후속 이슈로 미루지는 않는다. 승인 후 강제 crash의 자동 재처리·전달 보장은 후속 검증이며 E02의 정상 rollback/중복 방어와 다르다.

## 한계와 미확인

- 실행함: 독립 PG7건/23 assertions, Paperclip 순수 함수2개/17 assertions(에러 생성자 stub), 공개 UI8상태 캡처·재열람. PG는 기존 `/tmp/reference-selfhost/issue-52-stack`의 임시 설치18.1을 재사용했으며 제품 embedded18.4 검증이 아니다. 설치/실행 명령·보정·정리는 `selfhost/execution.md`, `probes/run-log.txt`에 기록했다.
- 미실행: 제품 코드·제품 테스트·API/E2E·upstream 전체 tests·Paperclip/OpenClaw 전체 self-host·실제 agent/provider/모델 호출·실제 승인 backend·강제 crash 자동 복구·filesystem symlink/I/O race. token/actor/격리·승인 상태를 제품에서 강제했음을 이번 조사로 주장하지 않는다.
- 공개 UI는 scripted/local demo다. 실패·권한 없음·이미 결정 경합·조직 전환 stale·에이전트 하네스 읽기 전용의 **실화면**은 미확인이다. 화면 제안 중 이 항목들은 소스/계약에서 도출했다. handup의 서버 영속성·승인 내용 hash 검증·agent 전달·Undo 후 확정 이력도 미확인이다. 배포 SHA와 source SHA 일치는 확인하지 못했다.
- Camunda의 일부 공식 lifecycle 페이지와 GetApproved 본문은 접근/추출 실패로 결정 근거에서 제외했다. 계정이 필요한 Agent Inbox/상용 서비스는 로그인하지 않았다. 추측한 OpenClaw test 경로404는 실제 publish test로 바로잡았다. sandbox network/browser 및 systemd user bus 실패는 허용 환경·prlimit으로 재시도했으며 동작 부재 증거로 쓰지 않았다.
- 사본 데이터 저장·승인 대상 버전 표현은 권고다. 확정 계약은 이슈/기능/구조/ADR이며 수정하지 않았다. 코드 복사 시 upstream ref와 라이선스·NOTICE·전이 의존성을 재확인해야 한다. 문서는 커밋하지 않고 구현 변경과 함께 검토되도록 남긴다.
