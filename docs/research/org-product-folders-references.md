# org-product-folders 레퍼런스 조사: 조직별 제품 폴더와 로그인 공유

조사일: 2026-11-06. 대상: 이슈 없는 기술 조사. 구현 전 권고이며 확정 계약이나 구현 결과가 아니다. 상세 자료: `.reference-cache/org-product-folders/`(git 무시). 제품 코드·테스트·설정·다른 문서는 변경하지 않는다.

## Brief

- 구현할 문제: 연결마다 하나인 제품 폴더의 쓰기 가능한 설정·확장·세션이 여러 조직에 노출된다. 조직 A가 남긴 설정이 B에서 실행되면 B의 실행 시도 토큰을 훔칠 수 있다.
- 동종 문제: 하나의 CLI 로그인을 공유하면서 CLI home의 설정·세션·확장은 격리 단위마다 나누기.
- 고정된 결정: 조직 경계는 제품 코드가 강제한다. 초기 연구 승인·최종 완료·조직 간 명시적 공유 원칙은 유지한다. 개인 로그인·설정은 읽지 않으며 로그인·유료 API·실제 모델 호출 없이 조사한다.
- 용어: 여기서 **제품 폴더**는 CLI 상태를 두는 폴더다. GLOSSARY의 산출물용 **조직 폴더**(`shared`)와 구분한다. 로그인 원본을 조직 실행이 쓸 수 있는 workspace 아래에 두는 것은 권고하지 않는다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 네 CLI의 인증 저장·갱신·잠금·회전·분리와 symlink/파일 mount/폴더 mount/env 공유 가능성 | 작업 브리프 Q1 | Source Recon + persistence/recovery + 공격 시나리오 + 합성 파일 실행 |
| Q2 | 선행 제품의 분리 단위, 공유·복사·연결, 초기화·로그인 대상 | 작업 브리프 Q2 | Source Recon + 신뢰 경계 비교 |
| Q3 | 컨테이너 없는 실행의 home 분할과 공용 경로 반례 | 작업 브리프 Q3 | Source Recon + 공격 시나리오 |
| Q4 | 세션 재개와 home·cwd 결합, 기존 세션 이전 | 작업 브리프 Q4 | Source Recon + persistence/recovery |
| Q5 | 로그인·준비 확인·모델 목록·재시작 프로세스 정리의 대상 폴더 | 작업 브리프 Q5 | Source Recon + runtime/failure |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [격리 조사 4·5절](executor-isolation-references.md#5-격리-아래의-로그인) | home 분할·로그인 공유 후보 | 과거 관찰로 보존. 새 소스에서 달라진 인증 저장·갱신을 아래에 명시 |
| [#102 조사](issue-102-references.md#한계와-미확인) | mount·네트워크·정리와 host 실행 한계 | 현행 container/process/recovery와 대조. 전체 home 공유를 안전하다고 일반화하지 않음 |
| [기능 비교 5·8절](executor-capabilities.md#8-인증-동시-실행-구독-자동화-약관) | 세션·인증 후보·이전 버전 | CLI별 현재 고정 SHA·공식 문서로 재확인. 특히 1.x 파일 저장을 OpenCode 2.x에 전용하지 않음 |
| [프로바이더 운영](../providers.md#제품-로그인), [구조](../architecture.md#제품-불변-조건-강제-위치), [ADR-0001](../adr/0001-adapter-control-plane.md), [ADR-0002](../adr/0002-durable-records-and-wakes.md), [ADR-0005](../adr/0005-approval-policy-enforcement-scope.md) | 현행 동작·책임·불변 조건 | 착수 HEAD `1d9e85517b3a97103d6f80a5fba31456ee28d39a` 기준. host 실행은 같은 OS 사용자 파일 격리를 제공하지 않음 |

## 레퍼런스

조사 관점은 CLI 원본·저장/동시성 실패·오케스트레이터·격리 서비스다. 각 관점의 마지막 검색은 기존 패턴(분리 home, 자격 증명 연결/복제, 갱신 주체 통합, 프록시)의 변형을 보강했으며 새 패턴을 더하지 않았다. 비공개 writer는 검색 포화와 별개로 미확인이다. 라운드별 검색·전체 후보·실행 경로·심층 선정 이유는 `.reference-cache/org-product-folders/candidates.md`와 `notes/`에 남겼다.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| Codex | CLI OSS | `55897425e839d943a744c658701445ff732568a0` | Apache-2.0 | 소스 | symlink·원자 교체·잠금·회전·재개를 직접 추적 |
| Claude Code | 상용 CLI의 공개 문서·일부 코드 | npm 2.1.318; 공개 repo `90380efca7f9d73e206fac453f841b6acd664f4d` | Commercial Terms; 런타임 OSS 아님 | 문서·일부 소스 | 현재 제품이 쓰는 setup-token 경로와 비공개 writer 한계 |
| OpenCode | CLI OSS | 2.2.5 `9bbb8ce18c80f099e0e448775f59d965ead40a21` | MIT | 소스 | 1.x와 다른 인증·세션 DB와 갱신 잠금 |
| Antigravity `agy` | 상용 CLI의 공개 릴리스 문서 | 1.5.2 문서 `e186eb5819bc33ce2d9e26420f30f30ae289b1a5` | 런타임 비공개·코드 재사용 제외 | 문서 | Gemini CLI의 인증 저장을 전용할 수 있는지 검토 |
| Paperclip | 연구/에이전트 조직 OSS | `a4bb059f5926875b908678d3b563b3725bc1e3de` | MIT | 소스·문서 | 회사별 home과 새 연결별 로그인 경로의 차이 |
| Multica | 공개 소스 에이전트 운영 도구 | `7c75b34a23fdb636c67c39e60d158e6eeeec6d3b` | Multica License: Apache-2.0 + 추가 조건 | 소스 | host에서도 작업별 home, 귀속된 재개 기록만 이전 |
| AO | 계정 전환 OSS | `0a43ac09dde2261a469fb39d7c64d3d946352942` | Apache-2.0 | 소스 | 인증을 나눠도 설정·이력을 공유하는 반례 |
| OpenHands SDK | 에이전트 SDK OSS | `295b3baf71dfac1be028c5b187134ec3eb495346` | MIT | 소스 | 대화별 home과 버전 비교를 갖춘 credential 동기화 |
| Hermes | 에이전트 OSS | `ca4360692055bdb4df3a695c164646e528891da8` | MIT | 소스 | OAuth 사본 제거와 원본 갱신 소유권 |
| Sculptor | 에이전트 도구 OSS | `5435bd424044d37d66be43cf746448a82700843d` | MIT | 소스 | 개인 Claude 폴더 전체 RW 마운트의 반례 |
| Docker Sandboxes | 공식 서비스 문서 | 2026-11-06 열람 | 문서; 코드 재사용 제외 | 문서 | 실제 토큰을 밖에 두는 프록시와 예외 |
| Linux·Docker 파일 의미 | 인접 시스템 계약 | Docker Engine 29.3.1, WSL2 Linux 6.18.54.1 | 설계 참고만 | 실행 | 자격 증명 없는 symlink/단일 파일·폴더 mount 대조 |

기존 소스 재사용은 파일별 Git blob SHA를 비교했다. Codex `a098129…` 대비 저장 writer는 동일, manager·rollout·exec는 변경되어 새 SHA로 재독했다. Paperclip `78b833c…` 대비 조사한 네 파일은 모두 변경되어 새 SHA로 재독했다. OpenCode tag 대비 HEAD 비교와 Hermes 이전 ref 비교도 캐시에 기록했다. 부분 파일 캐시의 상위 저장소 SHA를 해당 프로젝트 SHA로 사용하지 않았다.

## 근거

아래 소스 확인은 실행 성공을 뜻하지 않는다. 전체 호출 경로·테스트 이름·미확인은 `recon/`에, 메인의 원문 재독·정정 결과는 `main-verification.md`에 있다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 현 제품은 연결별 home을 HOME으로 지정하고 그 전체를 컨테이너에 RW로 넣는다. Claude setup-token도 같은 home에 두고 실행 시 env로 읽는다. 재시작 정리는 `providers/<연결>/processes`만 순회한다. | [환경](../../packages/runtime/src/providers/process.ts), [mount](../../packages/runtime/src/providers/container.ts), [Claude](../../packages/runtime/src/providers/claude.ts), [로그인](../../packages/runtime/src/providers/login.ts), [복구](../../packages/runtime/src/providers/recovery.ts), 위 착수 HEAD | 소스 확인 |
| <a id="E02"></a>E02 | Codex file backend는 `CODEX_HOME/auth.json`, keyring 식별자는 home 경로 hash다. file/keyring/auto/ephemeral 선택은 credential backend 선택이며 별도 auth-dir 설정과 다르다. auth schema에는 hook/plugin 명령 필드가 없다. | [storage.rs `AuthDotJson`, backend·keyring L20–77, L302–320](https://github.com/openai/codex/blob/55897425e839d943a744c658701445ff732568a0/codex-rs/login/src/auth/storage.rs#L20-L77), [keyring](https://github.com/openai/codex/blob/55897425e839d943a744c658701445ff732568a0/codex-rs/login/src/auth/storage.rs#L302-L320) | 소스 확인 |
| <a id="E03"></a>E03 | Codex는 symlink의 최종 대상을 먼저 풀고 그 옆 임시 파일에 써서 fsync 후 rename한다. 링크는 보존하며 read-only/hardlink는 거부한다. 과거 제자리 truncate 관찰을 이 SHA에 적용하면 틀린다. | [storage_file.rs L10–66](https://github.com/openai/codex/blob/55897425e839d943a744c658701445ff732568a0/codex-rs/login/src/auth/storage_file.rs#L10-L66), [storage.rs `save` L274–294](https://github.com/openai/codex/blob/55897425e839d943a744c658701445ff732568a0/codex-rs/login/src/auth/storage.rs#L274-L294) | 소스 확인 |
| <a id="E04"></a>E04 | Codex는 home의 auth.lock 외에 최종 auth 대상 옆 auth.json.lock으로 commit/CAS를 직렬화한다. 다른 home의 symlink도 대상 lock을 공유한다. **네트워크 갱신 요청은 이 lock을 잡지 않는다.** | [storage_commit.rs L1–88](https://github.com/openai/codex/blob/55897425e839d943a744c658701445ff732568a0/codex-rs/login/src/auth/storage_commit.rs#L1-L88), [storage.rs L194–230](https://github.com/openai/codex/blob/55897425e839d943a744c658701445ff732568a0/codex-rs/login/src/auth/storage.rs#L194-L230) | 소스 확인 |
| <a id="E05"></a>E05 | Codex는 manager 내부 semaphore·재독 뒤 HTTP refresh, 그 후 기존 token과 비교하여 갱신 결과를 저장한다. 새 refresh_token이 응답에 있으면 교체한다. 서로 다른 프로세스의 동시 HTTP 요청까지 배타라는 근거는 없다. 서버의 단일사용/grace 정책 전체는 클라이언트 소스로 증명하지 않는다. | [manager.rs L3473–3518](https://github.com/openai/codex/blob/55897425e839d943a744c658701445ff732568a0/codex-rs/login/src/auth/manager.rs#L3473-L3518), [L3742–3795](https://github.com/openai/codex/blob/55897425e839d943a744c658701445ff732568a0/codex-rs/login/src/auth/manager.rs#L3742-L3795), [persist_tokens L1766–1800](https://github.com/openai/codex/blob/55897425e839d943a744c658701445ff732568a0/codex-rs/login/src/auth/manager.rs#L1766-L1800) | 소스 확인 |
| <a id="E06"></a>E06 | OpenAI 공식 문서는 같은 auth.json을 병렬 job/여러 기기에서 공유하지 말고 직렬 실행 흐름별로 유지하도록 권한다. 갱신 뒤 파일을 보존하며 원래 seed로 되돌리지 않는다. | [OpenAI Docs: CI/CD 인증 운영 규칙](https://learn.chatgpt.com/docs/auth/ci-cd-auth#operational-rules-that-matter) | 문서 주장 |
| <a id="E07"></a>E07 | Codex 세션은 home 아래 rollout과 state index를 함께 쓴다. cwd는 목록 필터·세션 metadata다. home 변경은 자동 이관이 아니며 ID를 알아도 새 home에서 기록을 찾을 수 있어야 한다. | [recorder.rs `list_threads` L416–465](https://github.com/openai/codex/blob/55897425e839d943a744c658701445ff732568a0/codex-rs/rollout/src/recorder.rs#L416-L465), [recorder.rs](https://github.com/openai/codex/blob/55897425e839d943a744c658701445ff732568a0/codex-rs/rollout/src/recorder.rs#L1-L80), [exec resume](https://learn.chatgpt.com/docs/non-interactive-mode#resume-a-non-interactive-session) | 소스 확인 |
| <a id="E08"></a>E08 | Claude는 Linux/Windows에서 config dir의 .credentials.json, macOS에서 config dir에 대응하는 Keychain(실패 시 파일 fallback)을 쓴다. config dir는 설정·로그인·세션을 함께 바꾼다. API-key 없는 Console profile은 dir 밖 저장 예외다. | [공식 authentication](https://code.claude.com/docs/en/authentication#credential-management), [다중 계정](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts) | 문서 주장 |
| <a id="E09"></a>E09 | Claude setup-token의 access token env는 명시적 /login이 없으면 세션 내내 유지된다. 만료 시 재발급·재시작한다. refresh token env는 auth login provisioning용이며 자동 access-token 갱신 변수와 다르다. | [공식 env-vars](https://code.claude.com/docs/en/env-vars), `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` | 문서 주장 |
| <a id="E10"></a>E10 | Claude는 같은 머신의 병렬 세션 renewal 조정을 문서화한다. credential store에는 MCP 로그인·plugin sensitive 값도 함께 저장된다. 서로 다른 home/컨테이너까지 잠금을 공유한다는 계약은 확인하지 못했다. | [공식 login troubleshooting](https://code.claude.com/docs/en/troubleshoot-install#not-logged-in-or-token-expired) | 문서 주장 |
| <a id="E11"></a>E11 | 공식 mod는 CLAUDE_SECURESTORAGE_CONFIG_DIR라는 credential folder 변수를 식별한다. 이 파일은 runtime writer가 아니다. symlink가 rename 때 끊겼다는 원 보고가 있지만 최신 Claude writer의 rename/lock/회전 구현은 비공개라 미확인이다. | [policy 변수 L1–24](https://github.com/anthropics/claude-code/blob/90380efca7f9d73e206fac453f841b6acd664f4d/mods/sec-default/hooks/policy/policy-source-variables.ts#L1-L24); [사용자 원 보고 #76561](https://github.com/anthropics/claude-code/issues/76561), [문서화 요청 #79223](https://github.com/anthropics/claude-code/issues/79223) | 소스 확인(변수명만); 나머지 문서 주장·미확인 |
| <a id="E12"></a>E12 | Claude transcript는 config dir의 projects/cwd인코딩/session-id.jsonl이다. continue는 현재 cwd, ID/path resume는 지정 기록을 사용한다. project-dir-name 변수도 config dir와 함께 지정해야 한다. | [공식 sessions 저장 위치](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored), [project 이름](https://code.claude.com/docs/en/sessions#name-the-project-directory-yourself) | 문서 주장 |
| <a id="E13"></a>E13 | OpenCode 2.2.5의 인증은 credential 테이블, 세션은 같은 DB의 session 테이블이다. 기본 data/opencode.db와 OPENCODE_DB 선택이 있으며 auth.json은 legacy migration 입력이다. SQLite WAL·busy timeout을 쓴다. | [credential.ts L75–94](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/credential.ts#L75-L94), [legacy import L34–40](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/database/migration/20260805200742_import_legacy_credentials.ts#L34-L40), [DB path](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/cli/src/database-path.ts#L4-L13), [WAL L39–44](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/database/database.ts#L39-L44) | 소스 확인 |
| <a id="E14"></a>E14 | OpenCode 2.2.5는 credential ID별 pending과 프로세스 간 file lock 안에서 DB를 재독하고 만료 임박이면 refresh→DB update한다. lock root는 global.state/locks다. DB만 공유하고 XDG_STATE_HOME을 나누면 같은 잠금이 되지 않는다. | [credential.ts L98–111](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/credential.ts#L98-L111), [integration.ts L743–773](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/integration.ts#L743-L773), [effect-flock.ts L104–110](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/util/src/effect-flock.ts#L104-L110) | 소스 확인 |
| <a id="E15"></a>E15 | OpenCode의 credential value는 OAuth/key/external이며 직접 hook 명령 필드는 없다. 원격 integration config도 plugin·local command를 허용하지 않는다. 그러나 DB 전체 공유는 세션까지 공개한다. XDG data/config/state/cache는 독립 root다. | [credential schema L32–58](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/schema/src/credential.ts#L32-L58), [remote config 거부 L69–119](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/config/integration.ts#L69-L119), [roots L4–18](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/util/src/global-roots.ts#L4-L18), [session schema](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/sql.ts#L1-L80) | 소스 확인 |
| <a id="E16"></a>E16 | OpenCode는 credential export/import와 session export/import를 제공한다. auth import는 같은 ID를 건너뛴다. env key 연결은 파일 공유 없이 값을 읽는다. export/import는 시점 사본이며 회전형 OAuth의 장기 갱신 동기화가 아니다. | [env resolve L743–746](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/integration.ts#L743-L746), [auth import L18–49](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/cli/src/commands/handlers/auth/import.ts#L18-L49), [session export](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/cli/src/commands/handlers/session/export.ts#L1-L84), [session import](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/cli/src/commands/handlers/session/import.ts#L25-L57) | 소스 확인; 동기화의 한계 판단은 추론 |
| <a id="E17"></a>E17 | agy는 공식 배포상 별도 Antigravity CLI다. 공개 changelog는 Keychain/keyring·headless DBus·파일 fallback 수정 등을 기록한다. Gemini CLI oauth_creds.json의 writer를 agy 소스로 간주할 근거는 없다. | [공식 README](https://github.com/google-antigravity/antigravity-cli/blob/e186eb5819bc33ce2d9e26420f30f30ae289b1a5/README.md#L1-L50), [공식 CHANGELOG](https://github.com/google-antigravity/antigravity-cli/blob/e186eb5819bc33ce2d9e26420f30f30ae289b1a5/CHANGELOG.md) | 문서 주장 |
| <a id="E18"></a>E18 | Paperclip legacy Codex home은 회사별이며 명시적 per-agent home도 인정한다. auth.json은 원본 symlink, config는 사본, 원격 전달은 allowlist다. sessions/plugins/DB는 전달하지 않는다. 테스트 준비도 실제 실행의 effective home을 맞춘다. | [codex-home.ts L169–203](https://github.com/paperclipai/paperclip/blob/a4bb059f5926875b908678d3b563b3725bc1e3de/packages/adapters/codex-local/src/server/codex-home.ts#L169-L203), [seed L646–656](https://github.com/paperclipai/paperclip/blob/a4bb059f5926875b908678d3b563b3725bc1e3de/packages/adapters/codex-local/src/server/codex-home.ts#L646-L656), [allowlist L12–31](https://github.com/paperclipai/paperclip/blob/a4bb059f5926875b908678d3b563b3725bc1e3de/packages/adapters/codex-local/src/server/codex-home.ts#L12-L31), [probe L111–147](https://github.com/paperclipai/paperclip/blob/a4bb059f5926875b908678d3b563b3725bc1e3de/packages/adapters/codex-local/src/server/test.ts#L111-L147) | 소스 확인 |
| <a id="E19"></a>E19 | Paperclip의 새 managed connection 문서는 로그인 attempt별 빈 home→별도 browser login→암호화 grant 저장을 설명한다. 운영자 회전 토큰을 seed하지 않으며 readiness는 connection 전용 home을 본다. legacy 경로와 공존하므로 하나로 일반화하지 않는다. | [AI-CONNECTIONS.md L440–483](https://github.com/paperclipai/paperclip/blob/a4bb059f5926875b908678d3b563b3725bc1e3de/doc/connections/AI-CONNECTIONS.md#L440-L483), [L516–527](https://github.com/paperclipai/paperclip/blob/a4bb059f5926875b908678d3b563b3725bc1e3de/doc/connections/AI-CONNECTIONS.md#L516-L527) | 문서 주장 |
| <a id="E20"></a>E20 | Multica는 host 작업에도 task별 Codex home을 만든다. auth만 symlink, config는 사본이며 세션은 task 또는 (agent, issue/chat)의 지속 store로 나눈다. 예전 공용 sessions 링크를 끊고 재개 ID에 해당하는 rollout만 노출한다. | [codex_home.go L17–85](https://github.com/multica-ai/multica/blob/7c75b34a23fdb636c67c39e60d158e6eeeec6d3b/server/internal/daemon/execenv/codex_home.go#L17-L85), [준비 L209–229](https://github.com/multica-ai/multica/blob/7c75b34a23fdb636c67c39e60d158e6eeeec6d3b/server/internal/daemon/execenv/codex_home.go#L209-L229), [이전 L588–628](https://github.com/multica-ai/multica/blob/7c75b34a23fdb636c67c39e60d158e6eeeec6d3b/server/internal/daemon/execenv/codex_home.go#L588-L628) | 소스 확인 |
| <a id="E21"></a>E21 | AO의 계정 폴더는 auth만 private이며 Codex config/sessions/skills/plugins와 Claude projects/hooks/plugins 등을 기기 home과 연결한다. 로그인·신원 확인은 선택한 account home에서 실행한다. 계정 전환 뒤 이력 공유가 의도된 설계다. | [Codex 공유 목록·login L15–75](https://github.com/OrchestratorInc/agent-orchestrator/blob/0a43ac09dde2261a469fb39d7c64d3d946352942/backend/internal/adapters/agentaccount/codex.go#L15-L75), [Prepare L198–233](https://github.com/OrchestratorInc/agent-orchestrator/blob/0a43ac09dde2261a469fb39d7c64d3d946352942/backend/internal/adapters/agentaccount/codex.go#L198-L233), [Claude L22–99](https://github.com/OrchestratorInc/agent-orchestrator/blob/0a43ac09dde2261a469fb39d7c64d3d946352942/backend/internal/adapters/agentaccount/claude.go#L22-L99), [settings 공유 L303–353](https://github.com/OrchestratorInc/agent-orchestrator/blob/0a43ac09dde2261a469fb39d7c64d3d946352942/backend/internal/adapters/agentaccount/claude.go#L303-L353) | 소스 확인 |
| <a id="E22"></a>E22 | OpenHands는 opt-in 대화별 CLI root를 제공한다(기본 false: sandbox 자체가 대화별이면 이미 private). Codex 로그인은 임시 파일에 materialize해 durable home에서 symlink하고 갱신을 canonical credential의 버전 비교 replace로 동기화한다. CAS는 동시 HTTP refresh 자체의 방지 증거는 아니다. | [acp_agent.py L1963–1979](https://github.com/OpenHands/software-agent-sdk/blob/295b3baf71dfac1be028c5b187134ec3eb495346/openhands-sdk/openhands/sdk/agent/acp_agent.py#L1963-L1979), [L2716–2762](https://github.com/OpenHands/software-agent-sdk/blob/295b3baf71dfac1be028c5b187134ec3eb495346/openhands-sdk/openhands/sdk/agent/acp_agent.py#L2716-L2762), [materialize L138–205](https://github.com/OpenHands/software-agent-sdk/blob/295b3baf71dfac1be028c5b187134ec3eb495346/openhands-sdk/openhands/sdk/agent/acp_file_credentials.py#L138-L205), [CAS L369–427](https://github.com/OpenHands/software-agent-sdk/blob/295b3baf71dfac1be028c5b187134ec3eb495346/openhands-sdk/openhands/sdk/agent/acp_file_credentials.py#L369-L427) | 소스 확인 |
| <a id="E23"></a>E23 | Hermes는 profile 복제 때 회전형 OAuth grant 사본을 제거하고 root grant를 참조한다. Codex refresh는 원본 store transaction 안에서 재독→HTTP→저장하며 이미 갱신됐으면 저장값을 채택한다. CLI home 전체의 안전 공유를 뜻하지 않는다. | [profiles.py L1215–1237](https://github.com/NousResearch/hermes-agent/blob/ca4360692055bdb4df3a695c164646e528891da8/hermes_cli/profiles.py#L1215-L1237), [auth_codex.py L523–564](https://github.com/NousResearch/hermes-agent/blob/ca4360692055bdb4df3a695c164646e528891da8/hermes_cli/auth_codex.py#L523-L564) | 소스 확인 |
| <a id="E24"></a>E24 | Sculptor Docker recipe는 호스트 Claude config 폴더 전체를 RW 마운트하고 OAuth env도 전달한다. 컨테이너 존재만으로 설정·이력의 조직 분리가 되는 것은 아니다. | [run-backend.py L147–169](https://github.com/imbue-ai/sculptor/blob/5435bd424044d37d66be43cf746448a82700843d/container/recipes/docker/run-backend.py#L147-L169) | 소스 확인 |
| <a id="E25"></a>E25 | Docker Sandboxes는 호스트 프록시가 인증 header를 넣고 sandbox에는 sentinel만 보이게 한다. OAuth passthrough를 켜면 실제 token이 안으로 들어오므로 예외다. 네 CLI 구독 로그인 모두에 적용됨을 검증한 것은 아니다. | [공식 Manage credentials](https://docs.docker.com/ai/sandboxes/configuration/credentials/#how-credential-injection-works) | 문서 주장 |
| <a id="E26"></a>E26 | 합성 파일 실험에서 truncate는 symlink/단일 파일 mount 원본에 반영됐다. plain rename은 symlink 자체를 대체했다. 단일 파일 mount rename은 일반 uid /tmp에서 EPERM, root 대조에서 EBUSY로 실패했다. 폴더 mount rename은 성공했다. 호스트 rename 후 단일 파일 mount는 이전 inode 내용을 계속 읽었다. | `probes/mount-semantics.py`, `probes/run-log.txt`; Docker29.3.1·Node24 공개 기존 이미지 sha256:55fb5f5a527e…·WSL2 Linux6.18.54.1; network none·합성 데이터만. [rename 계약](https://man7.org/linux/man-pages/man2/rename.2.html), [Docker mount 계약](https://docs.docker.com/engine/storage/bind-mounts/) | 실행 확인 |
| <a id="E27"></a>E27 | agy 공식 문서는 OS keyring 재사용, API key의 설정+env 조합, cwd→ID cache·backend 확인을 명시한다. 과거 컨테이너 fallback 파일은 사용자 보고일 뿐 최신 writer 계약이 아니다. | [keyring·API key·ADC](https://antigravity.google/docs/install#local-silent-keyring-sign-in), [세션 cache](https://antigravity.google/docs/cli/commands/resume/#the-cache-file), [과거 사용자 보고 #479](https://github.com/google-antigravity/antigravity-cli/issues/479): ~/.gemini/antigravity-cli/antigravity-oauth-token | 문서 주장 |
| <a id="E28"></a>E28 | Codex API-key env와 구독 OAuth는 다르다. 공식 app-server의 외부 ChatGPT token 모드는 experimental이며 host가 access token 제공·401 갱신 응답을 소유한다. | [OpenAI Docs: external ChatGPT tokens](https://learn.chatgpt.com/docs/app-server#3c-log-in-with-externally-managed-chatgpt-tokens-chatgptauthtokens); env reader는 고정 SHA manager.rs L1049–1065(메인 재독 기록). API key 지원 표면은 [공식 non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode) | 문서 주장 |
| <a id="E29"></a>E29 | OpenClaw 문서는 Claude config dir와 Linux/Windows credential dir를 따로 지정하는 예를 준다. macOS Keychain 및 자동 이력 복구의 제약을 함께 명시한다. 이는 Claude runtime writer의 소스 확인이 아니다. | [공식 CLI backends: Separate Claude configuration](https://docs.openclaw.ai/gateway/cli-backends#separate-claude-configuration) | 문서 주장 |
| <a id="E30"></a>E30 | Paperclip 자동 per-agent Codex home은 API key 조건부다. Multica는 Codex만 task root로 옮기고 일반 HOME은 유지하며 user skills/plugin cache를 공유한다. 모델 목록은 task 초기화와 별도 daemon 경로, 세션 writer lock은 store 단위다. | [Paperclip guard L2261–2280](https://github.com/paperclipai/paperclip/blob/a4bb059f5926875b908678d3b563b3725bc1e3de/server/src/routes/agents.ts#L2261-L2280), [Multica HOME L1103–1107](https://github.com/multica-ai/multica/blob/7c75b34a23fdb636c67c39e60d158e6eeeec6d3b/server/internal/daemon/execenv/execenv.go#L1103-L1107), [공유 skill L14–35](https://github.com/multica-ai/multica/blob/7c75b34a23fdb636c67c39e60d158e6eeeec6d3b/server/internal/daemon/execenv/codex_user_skills.go#L14-L35), [모델 조회 L4680–4722](https://github.com/multica-ai/multica/blob/7c75b34a23fdb636c67c39e60d158e6eeeec6d3b/server/internal/daemon/daemon.go#L4680-L4722), [writer lock L19–77](https://github.com/multica-ai/multica/blob/7c75b34a23fdb636c67c39e60d158e6eeeec6d3b/server/internal/daemon/execenv/codex_session_writer_lock.go#L19-L77) | 소스 확인 |
| <a id="E31"></a>E31 | 읽은 테스트는 Codex 링크 보존·RO/hardlink/CAS 거부, OpenCode 중복 실패 공유·재시도, OpenHands 임시 인증 정리와 durable 세션·rotation writeback을 assert한다. 실제 OAuth·컨테이너 경합 시험으로 세지 않는다. | [Codex storage_tests.rs L19–90](https://github.com/openai/codex/blob/55897425e839d943a744c658701445ff732568a0/codex-rs/login/src/auth/storage_tests.rs#L19-L90), [OpenCode credential-lock.test.ts L18–39](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/test/credential-lock.test.ts#L18-L39), [OpenHands test L466–518](https://github.com/OpenHands/software-agent-sdk/blob/295b3baf71dfac1be028c5b187134ec3eb495346/tests/sdk/agent/test_acp_file_credentials.py#L466-L518) | 소스 확인(테스트 미실행) |

### Q1: 프로바이더별 인증과 공유 가능성

| 프로바이더 | 저장·설정 분리 수단 | 갱신 쓰기·회전·잠금 | 로그인 저장소 자체의 실행 설정 혼재 |
|---|---|---|---|
| Codex | file는 home/auth.json, keyring은 home 기반 식별자. CODEX_HOME은 config·세션도 이동. 별도 auth-dir flag는 조사 경로에서 확인 못 함(E02). API key env·experimental app-server 외부 token 경로는 E28·recon 참고 | 해당 SHA는 원자 교체·symlink target 보존·target sidecar CAS. 응답 refresh token 교체, HTTP 중복까지 배타 아님(E03–06) | auth.json schema는 credential 전용. 상위 home 공유는 config/AGENTS/skills/plugins까지 노출. 쓰기 공유 credential 자체의 신원·issuer 변조와 구독 탈취 위험은 남음(E02·05) |
| Claude Code | config dir에 credential 파일·설정·세션, macOS는 dir별 Keychain. setup-token env로 로그인 파일 없이 실행 가능(E08–09). 별도 credential dir는 생태계 공식 예시까지 확인(E29), 배포 버전 검증 필요 | 같은 머신 renewal 조정은 공식 계약. writer의 in-place/rename·정확 lock 경로·회전/grace는 미확인. symlink 파손은 사용자 보고(E10–11) | credential store에 MCP/plugin secret도 포함. sensitive 값을 통한 임의 실행은 검증 못 함. 전체 config dir는 hook/plugin 실행 설정까지 공유(E10·11) |
| OpenCode 2.2.5 | XDG config/data/state/cache 분리, OPENCODE_DB로 DB 위치 선택. 인증만 별도 파일로 지정하는 구조 아님(E13·15) | SQLite row update/WAL. credential lock 안에서 재독→refresh→update. 동일 DB·동일 lock root 필요. 회전 정책은 integration/provider별이며 일률적 single-use 아님(E14) | credential schema에 직접 실행 명령 없음, remote config는 plugin/local command 거부. DB에는 세션도 함께 있음. config/plugins를 공유하면 원래 위험 지속(E13·15) |
| Antigravity agy | OS keyring·파일 fallback은 공개 문서로 확인. 기본 keyring과 과거 fallback 파일 경로는 E27. 정확 namespace·별도 auth-dir·HOME/XDG 효과는 실행 검증 못 함 | refresh token 회전·writer·rename·lock·경쟁 모두 미확인. 개인 파일·설치 바이너리를 열어 추정하지 않음 | 공개 changelog는 plugin/hook 지원을 보여주나 credential 파일에 실행 설정이 섞이는지 미확인. 전체 .gemini나 keyring 공유는 안전하다고 판정 못 함 |

| 방식 | Codex | Claude Code | OpenCode 2.2.5 | agy |
|---|---|---|---|---|
| (a) 조직 home에서 로그인 원본 symlink | **기계적으로 가능**: 새 writer는 target 보존. 컨테이너에서도 target의 전용 부모 폴더가 보여야 함. HTTP refresh 경쟁·공유 쓰기 위험 때문에 병렬 기본안으로는 보류(E03–06) | **보류**: 링크 파손 보고, 최신 writer 미확인. macOS Keychain은 파일 링크로 해결 안 됨(E08·11) | **로그인만 연결 불가**: DB 링크는 세션까지 공유. legacy auth.json 링크는 최초 import일 뿐(E13) | **미확인** |
| (b) Docker 단일 로그인 파일 bind mount | **갱신용 배제**: 새 writer rename과 충돌, 호스트 교체도 기존 mount에 반영 안 됨(E03·26). 읽기 전용은 갱신 성공 방안 아님 | **권고 보류**: writer 미확인, rename이면 같은 실패. 파일 RO도 refresh 저장 문제 | **배제**: auth.json은 현재 저장소 아님. DB 하나 mount해도 세션 혼재·WAL 동반 파일·잠금 문제(E13–15) | **미확인**: 실제 파일 계약부터 없음 |
| (c) 로그인 파일이 든 전용 부모 폴더 bind mount | **조건부 가능**: auth+임시파일+sidecar lock만 있는 전용 폴더와 home의 링크. 전체 CODEX_HOME mount는 금지 권고. 직렬화 없이 동시 refresh 안전하지 않음(E03–06·26) | **실험 후보**: 별도 secure-storage dir 예시는 E29, 실제 lock·writer 검증 필요. default config dir 공유는 설정까지 노출, credential store에는 다른 secret도 있음(E08·10–11) | **요구에 부적합**: data dir/DB 공유는 세션도 노출하며 state lock까지 맞춰야 함(E13–15) | **미확인**: .gemini 전체 mount로 대신하지 않음 |
| (d) 토큰 환경 변수 전달 | **API key는 가능**, 구독 auth.json 전체를 env로 바꾸는 보편 계약은 아님. 외부 ChatGPT token/app-server 경로는 experimental이며 별도 adapter·갱신 주체 검증 필요(E28) | **권고 후보**: 현 setup-token 경로 재사용. 호스트만 원본 보관, 조직 config/session 분리. env access token은 자체 refresh 파일 경쟁 없음(E01·09) | **env key는 가능**. OAuth access/refresh bundle 공유를 env key와 혼동하지 않음(E16) | **API key 후보**: modelProvider=gemini 설정+GEMINI_API_KEY 조합, ADC는 AGY_ADC_AUTH(E27). 구독 OAuth access-token env는 미확인 |

이 표의 ‘가능’은 파일·프로토콜 구조 판단이다. worker에 들어간 파일/env 토큰은 worker가 읽을 수 있다. 이는 CLI 구독 자격 증명 노출이며, 조직 B의 도구 토큰이 A가 쓴 실행 설정을 통해 새는 원래 공격과 구별한다. 로그인 공유는 사용자가 허용한 범위여야 한다.

### Q2·Q3: 무엇을 나누고 무엇을 공유하는가

| 사례 | 분리 단위·처음 준비 | 공유 범위와 배제할 부분 | 컨테이너 밖 |
|---|---|---|---|
| Paperclip legacy | 기본 회사 home; API key 지정 시 agent home; config 사본·auth symlink(E30) | sessions/plugins/DB를 원격 allowlist에서 제외. 개인 config 복사까지 우리 기본으로 채택하지 않음 | local adapter도 같은 회사 home. companyId 없으면 instance 공용 경로(E18) |
| Paperclip managed | 연결 로그인 attempt별 빈 home→별도 로그인→grant | 회전 원본 사본을 seed하지 않음. legacy와 공존하며 자동 통합 이관 아님 | local browser login도 연결 home(E19) |
| Multica | task home, agent+issue/chat별 세션 store | auth 연결·config 복사·선택한 resume rollout. user skills/plugin cache 공유도 있어 그 부분은 우리 기본안에서 제외(E30) | host local_directory에서도 CODEX_HOME 분리. 일반 HOME/XDG는 host 상속(E20·30) |
| AO | account home, CLI 자체 login | auth와 daemon control은 private, 이력/설정/확장은 의도적으로 공유. **조직 격리의 반례** | 기기 기본 home 사용 경로와 계정별 home 모두 있음(E21) |
| OpenHands | 대화별 sandbox, 또는 opt-in 대화별 CLI root | 임시 credential + canonical CAS. 설정·세션은 durable 대화 root | home 분리는 별도 옵션. 기본 공용 HOME은 sandbox당 대화 하나라는 전제(E22) |
| Hermes | profile config·세션 분리, root credential fallback | clone 시 OAuth 사본 제거, 원본을 잠그고 갱신. profile은 보안 tenant 경계로 검증한 사례 아님 | host profile도 분리(E23) |
| Sculptor / Docker Sandboxes | 전자는 backend 컨테이너, 후자는 sandbox/VM | 전자는 .claude 전체 RW 공유 반례. 후자는 proxy credential 분리, OAuth passthrough 예외 | proxy/VM 모델을 host 단순 home 변경과 같다고 보지 않음(E24–25) |

**추론:** 격리를 꺼도 조직별 home은 유지하는 것이 설정·이력의 우발적 혼입을 줄인다. 그러나 같은 OS 사용자에게 다른 조직 디렉터리를 직접 읽거나 고치는 권한이 남으므로 악의적 에이전트의 조직 경계가 되지는 않는다. 이는 현행 [구조의 신뢰 경계](../architecture.md#제품-불변-조건-강제-위치)와 같다. 실행 설정이 들어 있는 공용 폴더를 RO로 넣어도 A가 호스트/다른 경로에서 그 원본을 고칠 수 있으면 B 오염은 남는다.

### Q4: 기존 세션과 이전

| 프로바이더 | home·cwd 결합 | 이관 선택과 한계 |
|---|---|---|
| Claude | config/projects/cwd인코딩; continue는 현재 cwd, resume는 ID 또는 transcript path. project-dir-name은 버전·config dir 조건 있음(E12) | 귀속된 transcript/관련 상태만 정지 중 이관하거나 새 세션. 내부 형식은 안정된 export 계약 아님. 전 조직에 projects 전체 복사 금지 |
| Codex | home의 rollout·index, cwd metadata와 목록 필터(E07) | Multica처럼 지정된 resume ID만 노출·index 재생성 검토(E20). 실제 CLI 버전에서 ID 재개·cwd 유지 검사 전 ‘파일 하나면 충분’으로 확정하지 않음 |
| OpenCode | 같은 DB의 session/location/worktree metadata(E13·15) | 지원 session export/import로 조직 귀속분만 이전 검토(E16). DB 통째 복사하면 다른 세션·credential까지 따라감. import 뒤 실제 재개·경로 복원 미실행 |
| agy | 공식 문서는 절대 cwd→ID cache와 backend 존재 확인을 명시. 전체 transcript/DB·keyring 결합·home 이관 계약은 미확인(E27). 현 adapter는 다른 ID면 새 세션을 알림(E01) | cache는 ~/.gemini/antigravity-cli/cache/last_conversations.json. cache만 복사하면 재개된다고 보장 못 함. 새 세션 또는 전체 이관 계약 확인 후 선택 |

기본 권고는 **새 home은 새 세션**, 사용자가 연속성을 원하면 **조직 귀속이 확정된 세션만 선택 이관**이다. 기존 BaboJUBot의 연결 변경·지침 버전·세션 세대 판정을 우회해 예전 ID를 되살리지 않는다. 선행 사례에는 선택 migration(Multica), 기존 이력 의도적 공유(AO), durable 대화 root 유지(OpenHands)가 있고, 어느 것도 우리 조직 간 이력 복사 허가가 아니다.

### Q5: 실행 밖의 일

| 작업 | 선행 근거 | BaboJUBot 권고(추론) |
|---|---|---|
| 로그인·재로그인·logout | AO는 account home에서 CLI login/status; Paperclip managed는 연결 attempt 전용 home(E19·21) | 연결별 **인증 관리 문맥**과 조직별 실행 home을 구분. 선택②는 조직별 login 대상 명시. 선택① Claude는 호스트 연결 원본에서 setup-token 발급, 실행 home에 원본 파일 mount 안 함 |
| 준비 확인 | Paperclip은 실제 effective home/connection home과 같은 credential을 검사(E18–19). Claude status도 상태 저장과 무관한 순수 read-only라고 가정 못 함 | 공용 인증 준비와 조직 home/config 준비를 구별. 검사는 B의 token/env가 A의 수정 가능한 home을 로드하게 하지 않음. readiness가 refresh를 유발하면 실행과 동일한 갱신 직렬화 적용 |
| 모델 목록 | AO는 선택 account home의 API 사용(E21). Multica 모델 조회는 task home 생성과 별도 daemon 경로이며 cache는 config에 묶임(E30). 현 Claude는 내장 목록, 나머지는 연결 home 조회(E01) | 버전 목록과 계정/설정별 가용 목록 구별. 조직 설정을 읽는 목록 호출은 해당 home 또는 신뢰된 일회용 probe home. CLI 목록이 무모델인지 버전별 확인; 유료 hello test를 무모델 검사로 전용하지 않음 |
| 취소·재시작 정리 | Paperclip 로그인 attempt 만료·서버 재시작 정리와 실행 home은 수명이 다름(E19). 현 제품은 연결 processes만 스캔(E01) | 제품 소유 process 기록은 **에이전트가 수정하는 CLI home 밖**에 두고 조직·연결·실행 시도·프로세스 신원을 함께 기록. 연결 인증 관리 프로세스도 별도 기록. home 재배치 때 기존 기록·고아 컨테이너까지 조사; CLI home recursive scan만으로 PID 신뢰 금지 |

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 격리 단위별 쓰기 가능한 CLI home | E18·20·22 | 회사/task/대화별 | 설정·세션·확장 오염 경로 축소 | 같은 uid host 실행은 보안 경계 아님; 조직 안 공유는 별도 범위 |
| <a id="P02"></a>P02 | 인증 원본과 실행 상태 분리 | E03·09·18·22 | symlink / env / canonical binding | 로그인 운영 횟수 감소 | rename·파일 inode·MCP/plugin secret·공유 쓰기 문제 |
| <a id="P03"></a>P03 | 갱신 원본 소유권과 network까지 포함한 직렬화 | E04–06·14·23 | Codex commit lock과 Hermes/OpenCode 전체 refresh lock 차이 | 회전 chain 분기 방지 | CAS만으로 이미 수행한 HTTP 요청을 취소하지 못함; 서로 다른 home lock은 무효 |
| <a id="P04"></a>P04 | 선택한 세션만 귀속시켜 지속 | E07·12·16·20·22 | rollout/transcript/DB export | 연구 연속성과 조직 경계 양립 | cwd·index·내부 형식·resume ID·실행 중 이관 경쟁 |
| <a id="P05"></a>P05 | 실제 credential은 호스트에서 관리 | E19·25 | encrypted grant 또는 인증 header proxy | worker의 원본 변조·탈취 범위 축소 | 프로토콜·OAuth·인증 실패·egress 신뢰 경계 추가 구현; 네 CLI 공통 성공 미검증 |

## 결정 권고

다음 세 선택지는 확정 계약이 아니다. **조직별 제품 폴더 분리는 공통 권고**, 로그인 운영 방식은 사용자 결정이다.

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 채택 권고 | 격리 on/off 모두 `(조직 ID, 연결 ID)`별 home·config·세션·확장·임시 상태. 실행 상태는 해당 home만 노출하고 인증은 별도 허용 목록으로 전달. 연결 공용 쓰기 home 전체 mount 폐기 | P01, E01·21·24 | 원래 A→B 실행 설정 오염 경로 차단. host 같은 uid 한계는 유지. 조직 내부 agent별 세션/권한은 보존 | Q1·Q2·Q3 |
| <a id="D02"></a>D02 | 변형 채택 후보·사용자 결정① | **조직별 home + 연결별 인증 원본 하나**. Claude는 setup-token env 권고. Codex는 검증된 전용 auth 폴더+symlink와 전체 흐름 직렬화 또는 검증된 호스트 갱신 주체 필요. OpenCode2 OAuth는 DB 공유 대신 별도 자격 증명 전달 설계 전 보류. agy 미확인 | P02·P03·P05 | 재로그인 부담 최소. 단일 파일 mount·무제한 병렬 공유·OAuth 사본 방치는 배제. 인증 원본을 worker에 RW로 보이는 신뢰 비용이 있음 | Q1·Q2·Q5 |
| <a id="D03"></a>D03 | 채택 후보·사용자 결정② | **조직별 home + 별도 로그인 grant**. Claude config dir·Codex file home·OpenCode 조직별 DB에 독립 login. 같은 계정도 원본 파일 복사가 아니라 별도 login grant여야 함. agy는 keyring namespace 검증 전 확정 불가 | E08·13·19, P03 | refresh chain 공유와 세션 노출을 줄이는 가장 단순한 대안. 로그인 횟수·logout 영향·계정/구독 동시 사용 조건은 남음. 같은 계정 별도 login의 서버 독립성은 실시험 필요 | Q1·Q2·Q5 |
| <a id="D04"></a>D04 | 기본안 배제·사용자 결정③ | **제품 폴더 RO + 일부 쓰기 경로 overlay**. 신뢰된 제품 소유 정적 seed만 RO 배포하는 용도는 가능하지만 공용 전체 home을 공유하는 대안은 권고 안 함 | E03·13·24·26, P01·P02 | 읽기만 해도 타 조직 세션 노출. hook/plugin 실행은 RO여도 가능. 인증 rename·SQLite WAL·전역 설정·임시 상태·sidecar lock을 CLI 버전마다 분해해야 함 | Q1·Q2·Q3 |
| <a id="D05"></a>D05 | 변형 채택 권고·사용자 결정 | 기본 새 세션, 필요 시 조직 소유가 확정된 세션만 정지 중 선택 이관. cwd·ID·index·세대 일치 검증 후 재개 | P04 | 기존 home 전체 복사/링크는 조직 분리와 충돌. 실패하면 이전 세션 삭제 없이 새 세션 안내 | Q4 |
| <a id="D06"></a>D06 | 채택 권고 | 인증 관리·조직 실행·검사/목록·프로세스 복구의 문맥과 수명을 나눈다. 모든 코드 경로가 올바른 조직 home을 선택하도록 공통 경계에서 강제 | E01·18–19·21, P03 | execute만 바꾸면 readiness·모델 조회·미리 압축·재시작 정리가 공용 폴더로 우회함 | Q5 |

| 선택지 | Claude | Codex | OpenCode 2.2.5 | agy |
|---|---|---|---|---|
| ① 로그인 원본 하나 공유 | **우선 권고**: setup-token env, 조직 home 분리 | **조건부**: 파일 연결은 가능하나 병렬 refresh 안전 안 됨. 최소 직렬화/갱신 주체를 먼저 결정 | **OAuth 기본안 보류**: 인증만의 파일 없음. env API key는 가능(비용/인증 방식 변경은 사용자 결정) | **보류**: 저장·namespace·갱신 미확인 |
| ② 조직마다 별도 로그인 | **가능 후보**: config-dir별; Console 예외 주의 | **가능 후보**: 별도 grant·file home; 공유 OS keyring 묵시 fallback 금지 | **우선 권고**: 조직별 DB/lock/config; OAuth 사본 복제가 아님 | **미확인**: HOME/XDG만으로 keyring까지 나뉜다고 보장 못 함 |
| ③ 공용 RO+쓰기 overlay | **기본 배제** | **기본 배제** | **기본 배제** | **근거 부족으로 보류** |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| account 폴더가 있으면 조직 경계도 성립 | AO E21 | 인증과 달리 설정·확장·모든 이력은 의도적으로 공유 |
| 모든 OAuth 파일을 복사하면 로그인 공유 완료 | E05–06·14·23 | 회전 뒤 stale 사본이 남고 다른 grant의 갱신을 무효화할 수 있음 |
| 파일 RW mount는 CLI 버전과 무관하게 갱신 가능 | E03·26 | rename 교체와 mount inode 수명 때문에 실패 |
| OpenCode2에 예전 auth.json 연결 적용 | E13–16 | legacy import 입력과 현재 DB를 혼동 |
| agy를 Gemini CLI 인증 구현과 동일 취급 | E17 | 현재 agy writer의 공개 소스·동일 구현 근거 없음 |
| RO home이면 hook/plugin도 안전 | E21·24, P01 | 실행 코드는 읽기만 해도 실행되며 타 조직 이력 노출도 남음 |

## 구현 참고

이 조사는 구현하지 않았다. 폴더 이름 제안은 예시이며 저장 경로 계약을 확정하지 않는다. `providers/<연결>/…`는 신뢰된 인증 관리, `organizations/<조직>/providers/<연결>/…`는 조직 실행 상태처럼 역할을 나누되 후자는 산출물용 `shared` 바깥에 둔다. 어떤 경로든 컨테이너에 부모 전체를 mount하면 분리 효과가 사라진다. server 소유 process 기록·auth 원본은 조직 실행이 수정할 수 없어야 한다(D01·D02·D06).

- `packages/runtime/src/providers/{claude,codex,opencode,antigravity}.ts`: execute·resume·precompact·readiness·모델 조회에서 같은 조직 문맥 선택, 인증 전달의 provider별 차이. 재사용 가능한 인터페이스와 private 구현으로 경로 정책을 한곳에 둔다(ADR-0001).
- `process.ts`·`container.ts`·`login.ts`·`recovery.ts`: HOME/XDG·마운트 경계·로그인 대상·프로세스 기록·기존 기록 복구를 함께 검토. 프로세스 기록은 agent가 바꾼 CLI 파일을 근거로 PID를 죽이지 않는다.
- `apps/server`의 요청 조립·readiness·모델 목록·시작 정리, 세션 저장/세대 판정: 실행 신원에서 조직을 결정하고 사용자 API의 로그인 대상과 연결한다. core에 OS 경로·Docker 구현을 넣지 않는다. 연결 전체 동시 실행 상한과 인증 grant 직렬화는 다른 잠금이다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | A가 자기 home의 hook/plugin/config 변경→B execute/readiness/models/precompact→A 파일을 읽거나 실행하지 않고 B 토큰이 A에 노출되지 않음 | D01·D06 |
| V02 | 다른 조직 home·부모 symlink·절대경로·없는 source mount 요청→신원/정규 경로 확인→거부. host 모드는 보안 경계로 오인하지 않음 | D01 |
| V03 | 같은 grant 두 프로세스 동시 만료·401·중단→refresh→HTTP 요청부터 저장까지 정책대로 직렬화, stale write/seed 복원 거부. file lock만 검사하고 완료로 보지 않음 | D02·D03 |
| V04 | symlink/단일 파일/전용 폴더, in-place/rename, 호스트 교체→재읽기→선택한 CLI 버전에서 원본 유지·가용성 확인 | D02, E26 |
| V05 | 별도 grant login/logout·만료·keyring unavailable→동일 조직 재실행→다른 조직/개인 grant 묵시 fallback 없음 | D03 |
| V06 | 기존 A/B 세션·알 수 없는 귀속·다른 cwd·중복 ID→이관/재개→허용한 조직분만 유지, 애매한 기록은 격리·새 세션 안내, 원본 보존 | D05 |
| V07 | 서버 재시작·조직 삭제·인증 관리 명령 중단→process/container 복구→기록한 신원만 정리, legacy 기록도 누락 없음 | D06 |
| V08 | OpenCode 조직 DB+분리 state, Claude config-dir/securestorage-dir, agy keyring→병렬 실행→잠금·credential·세션 귀속을 실제 지원 버전에서 검증 | D02·D03 |

### 사용자 결정 (2026-11-06)

위 권고를 사용자가 아래처럼 정했다. 아래 열린 결정 표는 조사 당시 기록이다.

| 항목 | 결정 | 구현 메모 |
|---|---|---|
| 나누는 범위 | 격리 실행을 켜든 끄든 `(조직, 연결)`마다 제품 폴더를 나눈다(D01) | 연결 폴더는 로그인 원본·준비 확인·모델 목록·프로세스 기록용으로 남기고 컨테이너에 넣지 않는다(D06) |
| Claude | 로그인 하나를 같이 쓴다 | 연결 폴더의 setup-token을 실행마다 환경 변수로 넣는다(E09) |
| Codex | 로그인 하나를 같이 쓴다(Paperclip·Multica 방식) | 연결의 로그인 전용 폴더에 `auth.json` 원본을 두고 조직 폴더의 `auth.json`은 그 원본을 가리키는 링크로 둔다. 컨테이너에는 로그인 전용 폴더만 쓰기로 더 넣는다(E03·E26의 단일 파일 mount 배제). 동시 갱신이 겹치면 다시 로그인해야 할 수 있다는 위험은 받아들인다(E05·E06) |
| OpenCode | 새 조직 폴더에 로그인만 복사한다. 사용자의 로그인은 API 키 방식이다 | 조직 DB에 로그인이 없을 때 연결 폴더의 로그인 목록을 조직 쪽으로 옮긴다(공식 `GET`/`POST /api/credential`, `auth import`와 같은 규칙). 세션은 옮기지 않는다. 갱신형 계정 로그인은 복사본끼리 어긋날 수 있다(E14·E16) |
| Antigravity | 다른 프로바이더처럼 나누고 사용자가 실제 로그인으로 확인한다 | 조직 실행에서 로그인이 보이지 않았다(#126). Codex와 같은 로그인 전용 폴더 원본+링크로 바꿨다(아래 추가 확인 2026-11-10) |
| 기존 세션 | 새 세션으로 시작한다(D05 기본안) | 네 프로바이더 모두 이전 세션을 찾지 못하면 새 세션으로 시작하는 경로가 이미 있다 |

추가 확인(메인, 2026-11-06): 이 컴퓨터의 Codex 0.166.0에서 `CODEX_HOME/auth.json`을 다른 폴더의 없는 파일로 가리키는 링크로 두고 가짜 API 키로 `codex login --with-api-key`를 두 번 실행했다. 원본 자리에 파일이 생겼고 링크는 유지됐다(네트워크·모델 호출 없음). Codex `storage_file.rs`(E03)와 OpenCode 2.2.5 `credential.ts`·`groups/credential.ts`(E13)는 메인이 고정 소스에서 다시 읽었다. 설치 판: Claude Code 2.1.317, OpenCode 2.2.5, agy 1.5.0.

추가 확인(메인, 2026-11-10, #126): agy 1.5.3, 키링 서비스가 없는 이 컴퓨터. 기록에 `Failed to load stored token from keyring, falling back to file`이 남고 로그인은 HOME의 `.gemini/antigravity-cli/antigravity-oauth-token`에서 읽는다. 임시 HOME의 그 자리를 연결 폴더 로그인 파일을 가리키는 링크로 두고 `agy models`(모델 호출 없음)를 strace로 따라갔다. 링크로 읽었고, 접근 토큰이 만료돼 갱신한 로그인을 `open(O_WRONLY|O_CREAT|O_TRUNC, 0600)`으로 같은 경로에 써서 원본(같은 inode)이 바뀌고 링크는 남았다. 토큰 파일 잠금은 보이지 않았다. 로그인이 없을 때 stream-json 실행은 결과 없이 `Error: authentication required. Run 'agy' to log in, then retry.`와 종료 코드 1로 끝난다(#91 서버 기록). 로그인 명령(`agy` 대화형 로그인)이 링크를 따라 쓰는지와 갱신 토큰 회전·동시 갱신은 확인하지 않았다. 로그인 명령이 링크를 보통 파일로 바꿔도 다음 준비 확인·실행이 그 파일을 원본으로 옮긴다.

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 로그인 운영 방식 | 사용자 결정 | 위 ①·②·③. 권고는 Claude①, OpenCode2②, Codex② 또는①+직렬화; agy는 인증 분리 계약 확인 전 보류 |
| Codex 하나의 구독 grant 병렬 사용 | 사용자 결정 | 연결/grant 단위 직렬 실행(동시성 감소) / 독립 grant(로그인 증가) / 호스트 token 갱신 broker·proxy(추가 adapter/신뢰 경계). 원본 symlink만으로 해결됐다고 하지 않음 |
| 기존 세션 | 사용자 결정 | 기본 새 세션 / 조직 귀속분 선택 이관. 개인·타 조직 이력 일괄 복사는 선택지로 권하지 않음 |
| agy 지원 조건 | 사용자 결정 | 공식 분리·갱신 확인 전 보류 / 승인된 별도 인증 방식과 실제 지원 버전으로 검증 후 채택. 모델 호출은 계정·비용 권한 확인 후 별도 작업 |
| 조직 안 agent별 home 추가 분리 | 사용자 결정 | 조직 단위 기본 / agent별 추가. 조직 내 설정 공유·세션 가시성·성능의 별도 제품 정책이며 연구 목표별 조직 경계를 약화하지 않음 |

## 한계와 미확인

- 개인 로그인·설정 파일을 열지 않았으며 CLI 로그인·실제 모델·유료 API를 실행하지 않았다. Claude·agy runtime writer의 저장 경로·rename·잠금·서버 회전 정책을 소스로 확정할 수 없는 항목은 미확인으로 남겼다. 공식 changelog·사용자 issue는 런타임 소스 증거와 구분했다.
- 실행 확인은 합성 파일의 OS/Docker 의미뿐이다. 일반 uid /tmp의 EPERM과 root의 EBUSY를 구분했으며, 제품 uid·대상 디렉터리·Desktop·rootless·remote daemon·Windows/macOS·NFS에서의 결과는 미검증이다. 초기 EBUSY 단정 assertion 실패도 `probes/initial-permission-log.txt`에 보존했다.
- Codex commit/CAS·OpenCode2 refresh lock·OpenHands credential CAS·Hermes root grant 동작은 소스를 읽었다. upstream 테스트는 읽었고 실행하지 않았다. 해당 CLI 전체 suite·인증 refresh 경합·프로바이더 통합/E2E·실제 세션 재개는 미실행이다.
- 확인한 버전과 이 기기에 설치된 실행 버전이 일치하는지 확인하지 않았다. 기존 [격리 조사 5절](executor-isolation-references.md#5-격리-아래의-로그인)의 Codex 제자리 덮어쓰기, 예전 OpenCode auth.json, agy/Gemini 파일 전제는 위 버전에 적용하지 않는다. 기존 문서는 작업 경계에 따라 수정하지 않았다.
- 문서/공개 저장소를 읽고 패턴만 참고했으며 외부 코드를 제품에 복사하지 않았다. 추후 복사 시 해당 SHA LICENSE·file header·NOTICE·의존성을 재확인하고 출처·THIRD_PARTY_NOTICES 규칙을 적용한다.
- 문서 검사 결과와 단계 완료 기록은 `.reference-cache/org-product-folders/receipt.md`. 이슈·PR 댓글은 작성하지 않으며 commit·push·branch 조작도 하지 않는다.
