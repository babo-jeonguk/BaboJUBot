# issue-146 레퍼런스 조사: 로그인 공유와 조직 제품 폴더 선택 집중

Codex·Antigravity의 로그인 파일 준비와 실행용 제품 폴더 선택 경계를 조사한다. 확정 요구는 [#146](https://github.com/babo-jeonguk/BaboJUBot/issues/146), 운영 방법은 [프로바이더 안내](../providers.md)에 있다.

> **2026-11-12: 일부 대체됨.** #148 2단계(PR #171)로 격리 실행은 로그인 링크를 쓰지 않고 원본·로그인 전용 폴더를 컨테이너에 넣지 않는다. 이 문서의 D02(링크 불가 시 컨테이너 거부·로그인 전용 폴더 mount)와 D03(일반 파일 우선 이전)은 그 결정으로 대체됐고, #146 본문을 새 범위로 다시 썼다. 다시 하는 조사가 이 문서를 고친다.

조사일: 2026-11-10. 구현 전 기술 권고이며 확정 계약이나 구현 결과가 아니다. 기준 HEAD: `c88a98b58284a38bdadf7eff7aafa0219005371c`. 제품 코드·테스트·설정을 변경하지 않았고 커밋하지 않았다.

## Brief

- 구현할 문제: 두 adapter가 로그인 링크의 boolean을 제품 폴더 선택·공유 mount·컨테이너 거부로 각각 해석한다. 이 절차를 한 경계에 집중하여 누락과 정책 불일치를 줄인다.
- 동종 문제: 하나의 자격 증명 원본을 공유하면서 실행 주체별 상태 폴더를 선택하고, 준비 capability와 인증 결과를 구분하기.
- 고정된 결정: Codex·Antigravity만 대상. 로컬 연결 폴더 fallback과 링크 불가 컨테이너 거부를 유지한다. 조직 경로 검증은 `connectionFolders`, cwd와 배치는 기존 caller·`placeAttempt`, 프로세스 종료·컨테이너 제거는 `startProcess` 책임이다. 시작한 파일 작업은 정리를 기다리고 프로세스 시작 직전에 취소를 확인한다. 새 공개 API·DB·범용 인증 framework·OAuth 명령 중복 차단·취소 가능한 파일 큐는 제외한다. 초기 연구 승인·최종 완료·조직 경계를 바꾸지 않는다.
- 부모·blocker: GitHub 조회에서 parent 없음(404), blocker 빈 목록. #126의 해결 댓글과 이후 사용자 결정이 과거 조사 권고보다 우선한다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 로그인 공유 결과에서 제품 폴더·공유 mount·실행 거부를 결정하는 경계는? | #146 구현 전 조사, Implementation Decisions 2–8 | Source Recon + adversarial scenario |
| Q2 | 링크 가능/불가 전환과 재로그인 최신 값은 어떻게 보존하는가? | User Stories 2·4·7, Testing Decisions 3 | Source Recon + persistence/recovery + 합성 파일 probe |
| Q3 | 원본별 동시 준비를 직렬화하고 실패 뒤에도 진행하는가? | User Stories 6·10, Implementation Decisions 10 | Source Recon + runtime/failure |
| Q4 | 파일 작업 도중 취소되면 어디까지 정리하고 실행을 막는가? | User Story 8, Implementation Decisions 11 | Source Recon + runtime/failure |
| Q5 | 링크 성공·파일 존재와 실제 인증 성공을 어떻게 구분하는가? | User Stories 9·11·12, Implementation Decisions 8–9 | 공식 계약 + Source Recon + 음성 대조군 |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [조직 제품 폴더 사용자 결정](org-product-folders-references.md#사용자-결정-2026-11-06) | 공유 방식, 기존 fallback, 11-10 agy 실측·한계 | Codex 기존 `55897425…`와 새 SHA의 LICENSE·storage_file/storage/storage_commit/manager 5파일 blob 모두 동일. Paperclip 기존 `a4bb059…`와 새 SHA의 LICENSE·codex-home/test 3파일 동일. 관련 원문 재독. agy 1.5.3 실측은 과거 확인이며 이번 실행으로 승격하지 않음 |
| [#98–101 구현 근거](issue-98-101-implementation.md) | provider별 인증·정리 책임과 과거 검증 한계 | 현 HEAD의 provider·login-link·folders·container 호출 경로와 대조. 과거 실제 호출을 이번 결과로 재사용하지 않음 |
| [#102 조사](issue-102-references.md#한계와-미확인) | login-only 폴더 mount와 host 실행 한계 | 현재 mount 조립과 대조. 과거 Docker 실측을 이번 환경으로 일반화하지 않음 |
| [#126 해결 기록](https://github.com/babo-jeonguk/BaboJUBot/issues/126#issuecomment-6758489942) | agy 원본 공유·갱신 관찰·준비 확인 | 댓글 직접 재열람. 실제 동시 갱신은 당시에도 미확인 |
| [#140](issue-140-references.md)·[#141](issue-141-references.md)·[#142](issue-142-references.md)·[#143](issue-143-references.md) | 다른 module 경계 조사 | 로그인 원본/링크 메커니즘 근거로 재사용하지 않음 |

## 레퍼런스

전체 후보 12개. 3개 관점을 각각 2라운드 탐색했다. 오케스트레이터는 Paperclip·Multica 뒤 Paseo README/코드 검색에서 새 선택 경계를 찾지 못했다. 라이브러리는 파일별 큐·보유 잠금·취소 race 뒤 Node 취소 의미가 같은 실패 모드를 보강했다. OS·명세는 제자리 쓰기/링크 자체 교체/최종 대상 교체와 mount 범위 뒤 EXDEV·EBUSY 변형으로 수렴했다. 이것은 기록한 검색 범위의 saturation이며 모든 프로젝트·플랫폼을 망라했다는 주장은 아니다.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| Codex | provider OSS | `c82708f85803d21fe9046af407107a1ee105b6e5` | Apache-2.0 | 소스 | 링크 최종 대상 교체와 commit 잠금 범위 |
| Paperclip | 조직 실행 OSS | `8b3348c6bade125ed2f79014ac661cfc79e48176` | MIT | 소스 | home 준비와 readiness 분리, 예상 링크 경합 테스트 |
| Multica | 공개 소스 실행기 | `e17f76553eed99fc0f8446119523de679ecb4b84` | Multica License: Apache-2.0 + 추가 조건 | 소스 | 링크 실패 경고 후 진행하는 반례 |
| write-file-atomic | 파일 쓰기 라이브러리 | `23e111d95367e1d987c1b4d7823791eaaf6b21df` | ISC | 소스 | 파일별 직렬화와 finally 뒤 다음 작업 |
| p-queue | 작업 큐 | `7f272ab5ff2254c0dc2537b7977e88ede1cd55e8` | MIT | 소스 | 취소 반환이 원작업 정리를 기다리지 않는 반례 |
| async-mutex | 잠금 라이브러리 | `b0bb4c5aa0e42eb5ffc8d9342e56bb6de1b95554` | MIT | 문서 | 대기 취소와 보유 잠금 해제 구분, 심층 제외 |
| Paseo | agent daemon | `63ea3e55618ab0849cf0a45d5fee02f509b58c73` | 이번 LICENSE 미확인 | 문서 | credential 주입 참고, 동일 선택 경계 미확인으로 심층 제외 |
| Node fs·Linux symlink(2)·rename(2) | 런타임·OS 계약, 3후보 | Node 실행 v24.21.0, Linux 7.0.0-1013-oracle arm64 | 설계 참고 | 문서·합성 실행 | dangling link와 rename-over-link 음성 대조군 |
| Docker bind mounts | 공식 운영 계약 | 2026-11-10 열람 | 문서, 설계 참고 | 문서 | 로그인 전용 폴더 노출 범위, 이번 daemon 실행 불가 |
| Antigravity | 비공개 CLI·공식 문서 | 기존 agy 1.5.3 관찰, 이번 공식 인증 문서 열람 | 런타임 비공개 | 문서 | 파일 유무로 대체 인증 경로를 배제하지 않기 |

깊이는 upstream 실행과 합성 파일 실행을 구분한다. 외부 소스는 설계 참고뿐이며 코드 복사나 새 의존성 도입을 권고하지 않는다.

## 근거

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 현 두 adapter는 조직 경로를 먼저 계산하고 연결·조직 로그인 준비 후 linked로 폴더·shared·컨테이너 거부를 각각 결정한다. readiness/models는 연결 범위다. spawn 전 취소 재확인은 보강 대상이다 | [Codex execute](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/runtime/src/providers/codex.ts#L212-L275), [agy execute](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/runtime/src/providers/antigravity.ts#L161-L270) | 소스 확인 |
| <a id="E02"></a>E02 | `oneAtATime`은 original key의 이전 reject를 흡수한 뒤 다음 task 실행. fallback은 읽을 수 있는 기존 링크를 보존하고, 연결 자리 일반 파일은 링크 복귀 시 원본으로 이동한다. 최신값 의미는 mtime 비교가 아니다 | [loginLink·keepAtFallback·linkLogin](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/runtime/src/providers/login-link.ts#L13-L137) | 소스 확인 |
| <a id="E03"></a>E03 | Codex는 최종 링크 대상을 해석하고 그 옆 임시 파일을 sync→rename한다. hardlink·읽기 전용은 거부한다. 모든 writer가 링크를 보존한다는 일반 법칙은 아니다 | [resolve/check](https://github.com/openai/codex/blob/c82708f85803d21fe9046af407107a1ee105b6e5/codex-rs/login/src/auth/storage_file.rs#L10-L67), [save](https://github.com/openai/codex/blob/c82708f85803d21fe9046af407107a1ee105b6e5/codex-rs/login/src/auth/storage.rs#L274-L294) | 소스 확인 |
| <a id="E04"></a>E04 | Codex commit은 최종 대상 json.lock을 쓰지만 네트워크 요청 동안 보유하지 않는다. manager 내부 semaphore·재독·갱신 뒤 CAS와 파일 준비 큐는 다른 보호 범위다 | [commit lock](https://github.com/openai/codex/blob/c82708f85803d21fe9046af407107a1ee105b6e5/codex-rs/login/src/auth/storage_commit.rs#L1-L88), [manager](https://github.com/openai/codex/blob/c82708f85803d21fe9046af407107a1ee105b6e5/codex-rs/login/src/auth/manager.rs#L3473-L3518) | 소스 확인 |
| <a id="E05"></a>E05 | Paperclip `prepareManagedCodexHome`은 home을 반환하며 readiness predictor는 별도다. EEXIST는 예상 링크인지 재검사. 외부 home·API key에 대한 ready:true는 이 제품의 예측 정책이다 | [prepare](https://github.com/paperclipai/paperclip/blob/8b3348c6bade125ed2f79014ac661cfc79e48176/packages/adapters/codex-local/src/server/codex-home.ts#L819-L827), [readiness](https://github.com/paperclipai/paperclip/blob/8b3348c6bade125ed2f79014ac661cfc79e48176/packages/adapters/codex-local/src/server/codex-home.ts#L913-L982), [링크·경합 검사](https://github.com/paperclipai/paperclip/blob/8b3348c6bade125ed2f79014ac661cfc79e48176/packages/adapters/codex-local/src/server/codex-home.test.ts#L47-L139) | 소스 확인, 테스트 미실행 |
| <a id="E06"></a>E06 | write-file-atomic은 절대 filename별 큐를 잡고 realpath는 뒤에 읽는다. finally의 close/unlink 뒤 queue shift로 다음 작업을 시작한다. 조직별 링크를 별개 key로 잡으면 공유 원본 직렬화가 안 된다 | [큐](https://github.com/npm/write-file-atomic/blob/23e111d95367e1d987c1b4d7823791eaaf6b21df/lib/index.js#L50-L94), [정리](https://github.com/npm/write-file-atomic/blob/23e111d95367e1d987c1b4d7823791eaaf6b21df/lib/index.js#L144-L160) | 소스 확인, 마지막 문장은 E02와의 대조 |
| <a id="E07"></a>E07 | p-queue는 signal과 원작업을 Promise.race하고 finally에서 다음 슬롯을 연다. 비협력 파일 작업 완료까지 기다리는 계약으로 쓸 수 없다 | [add 취소·finally](https://github.com/sindresorhus/p-queue/blob/7f272ab5ff2254c0dc2537b7977e88ede1cd55e8/source/index.ts#L689-L731) | 소스 확인, 적용 판단은 추론 |
| <a id="E08"></a>E08 | Multica는 auth 링크 실패를 warn하고 다음 단계로 진행한다. #146의 컨테이너 거부 규칙과 다르다 | [prepareCodexHome](https://github.com/multica-ai/multica/blob/e17f76553eed99fc0f8446119523de679ecb4b84/server/internal/daemon/execenv/codex_home.go#L209-L229) | 소스 확인 |
| <a id="E09"></a>E09 | Codex는 file/keyring/auto/ephemeral 저장을, agy는 OS keyring·SSH 로그인·API key 등 인증 경로를 문서화한다. 로그인 파일 존재만으로 전체 인증 가능성을 판정하지 않는다 | [Codex credential storage](https://learn.chatgpt.com/docs/auth?surface=cli#credential-storage), [agy 인증](https://antigravity.google/docs/install?tab=cli) | 문서 주장, 판정 분리는 추론 |
| <a id="E10"></a>E10 | Codex 공식 운영 문서는 직렬 흐름별 auth.json을 유지하고 동시 job 공유와 갱신 파일의 seed 덮어쓰기를 피하도록 권한다 | [Operational rules](https://learn.chatgpt.com/docs/auth/ci-cd-auth#operational-rules-that-matter) | 문서 주장 |
| <a id="E11"></a>E11 | 현행 login-link 직접 import: 연결/A/B 동시 준비, A 갱신의 B 관찰, EIO 뒤 다음 작업 성공, 링크 거부 3종, fallback→복귀 최신값, 원본 없는 링크 성공 등 6개 검사 통과 | 로컬 probe(`packages/runtime/src/providers/login-link.ts` 직접 import) | 실행 확인 |
| <a id="E12"></a>E12 | 링크 가능→불가→재로그인 일반 파일→가능 복귀를 오류 3종 각각 검사. dangling link 성공/읽기 ENOENT, 링크 위 직접 rename은 링크만 교체하고 원본은 낡게 남는 음성 대조군: 5개 검사 통과 | 로컬 probe; 메인 재실행 | 실행 확인 |

E11–12 환경: Node v24.21.0, Linux 7.0.0-1013-oracle arm64. 임시 파일은 합성 문자열만 사용하고 제거했다. symlink·rename·read/write는 실제 Linux 파일 시스템 동작이며 EPERM·ENOTSUP·EOPNOTSUPP·EIO는 주입한 오류다. 실제 Windows 권한 실패를 실행한 것이 아니다.

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 파일 준비 결과를 실행 home 선택과 묶고 인증 판정은 분리 | E01·05·09·11 | Paperclip readiness 예측 규칙은 우리와 다름 | 호출자 boolean 재해석 감소 | 준비 완료를 로그인 성공으로 오해 가능 |
| <a id="P02"></a>P02 | 공유 원본 하나 + 실행별 링크 + 로그인 전용 폴더 | E02·03·12, 기존 사용자 결정 | agy in-place 실측과 Codex 원자 교체의 writer 차이 | 갱신 원본 공유, 전체 home 노출 방지 | 공유 grant 동시 갱신·writer 변경·로컬 fallback 예외 |
| <a id="P03"></a>P03 | 원본별 큐, 실패 전달과 다음 작업 진행 분리 | E02·06·11 | 일반 filename 큐 대신 canonical original key 유지 | 준비 경쟁으로 원본을 잃는 문제 감소 | 프로세스 밖 CLI·서버 다중 인스턴스 보호 아님 |
| <a id="P04"></a>P04 | 시작한 파일 작업 정리 후 취소 확인 | E02·06·07 | race 취소보다 응답이 늦을 수 있음 | 부분 이동 도중 큐 해제·spawn 방지 | crash 복구나 무한 I/O 중단 계약 아님 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | 조직 경로 검증 후 연결·조직 로그인을 준비하고 제품 폴더·login-only shared·거부 사유를 반환하는 좁은 내부 경계. 결과 형태와 파일명은 구현자가 정한다 | P01, #146 | cwd·전체 배치·인증을 소유하지 않고 기존 선택 절차만 집중 | Q1·Q5 |
| <a id="D02"></a>D02 | 채택 | 링크 가능이면 요청 조직 제품 폴더와 로그인 전용 폴더. 불가이면 로컬 연결 폴더 fallback, 컨테이너는 spawn 전 거부 | P02, #146 확정 | 연결 home·다른 조직 home을 컨테이너에 제공하지 않음. fallback은 기존 격리 예외이며 승인 확대 아님 | Q1·Q2 |
| <a id="D03"></a>D03 | 채택 | 기존 loginLink의 이동·일반 파일 우선 이전·링크 복귀 정책을 그대로 사용. 매 실행 seed 복사·mtime 기반 최신값 새 정책은 도입하지 않음 | E02·10–12 | 최신 재로그인 보존 의미를 바꾸지 않는 추출 | Q2 |
| <a id="D04"></a>D04 | 채택 | original별 기존 큐와 실패 뒤 진행을 유지. 공유 준비 직렬화를 OAuth 갱신 안전성으로 설명하지 않음 | P03, E04·10 | 인프로세스 준비 큐의 보장 범위를 명확히 함 | Q3 |
| <a id="D05"></a>D05 | 채택 | 시작한 준비 promise를 정리까지 await. provider별 추가 준비 이후를 포함하여 실제 startProcess 직전에 취소 재확인, cancelled와 프로세스 미실행 검증 | P04, #146 | Antigravity 설정 게시·exec/app-server 분기에서 늦은 await를 놓치지 않기. 종료와 컨테이너 제거는 기존 소유자 유지 | Q4 |
| <a id="D06"></a>D06 | 채택 | 링크 capability를 ready로 반환하지 않음. 원본 없음·준비 확인 결과가 조직 폴더 선택을 바꾸지 않음. provider별 실제 응답·권한 확인·오류·로그인 명령 유지 | P01, E09·11 | keyring 등 대체 경로와 파일 공유 준비 구분 | Q5 |
| <a id="D07"></a>D07 | 보류 | fallback 장기 폐지·강제 조직 폴더 전환, grant 갱신 broker/직렬 실행, OAuth 로그인 명령 중복 차단 | E04·10, #146 범위 밖 | 사용자 정책 검토가 필요한 별도 작업. 이번 추출 blocker가 아님 | Q1·Q3 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 링크 실패 경고 후 컨테이너 계속 실행 | E08 | #146의 spawn 전 거부와 상충 |
| 파일 준비를 AbortSignal race로 끊고 다음 슬롯 해제 | E07 | 원작업 정리 완료를 기다리지 않음 |
| upstream ready 예측을 실제 인증 성공으로 복제 | E05·09·11 | 다른 제품의 정책이며 인증 서버·provider 응답이 아님 |
| 모든 writer에 단일 파일 mount·로그인 사본 적용 | E03·10·12, 기존 조사 | 원자 교체/링크 교체/낡은 seed 문제, 기존 폴더 mount 계약과 다름 |
| 여러 callback으로 Claude·OpenCode까지 흡수 | #146, P01 | 인증 방식과 작업 책임이 다르고 이번 내부 경계를 넘음 |

## 구현 참고

권고 요약: 기존 파일 관리와 큐 위에 실행 선택의 좁은 경계를 두고 두 adapter가 그 결과를 소비한다. `connectionFolders`의 조직 검증을 파일 변경보다 앞에 유지한다. `packages/runtime/src/providers/` 내부에 머물며 core·contracts·DB에 파일 시스템 정책이나 새 API를 올리지 않는다([구조](../architecture.md#패키지-구성), [ADR-0001](../adr/0001-adapter-control-plane.md), [ADR-0005](../adr/0005-approval-policy-enforcement-scope.md)).

`login-link.ts`의 파일 알고리즘, `folders.ts`의 검증, `container.ts`의 `placeAttempt`는 기존 책임을 유지한다. `codex.ts`의 app-server/exec와 `antigravity.ts`의 전용 설정 게시 전후에서 취소·정리 순서를 확인한다. `login.ts`·준비 확인·모델 목록은 연결 범위다. 관련 주석·운영 설명에는 로컬 fallback 예외를 정합적으로 표시하되 과거 조사 원문은 보존한다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 잘못된 조직 ID → 실행 준비 → 로그인 파일 변경·프로세스 시작 전 거부 | D01 |
| V02 | A/B 같은 연결·준비 확인 동시 시작 → 이동/공유 → 원본 하나·A 갱신이 B에 보임. 준비 확인/models는 연결 범위 | D03·04 |
| V03 | 링크 거부 3종·기존 링크 이후 불가·재로그인·가능 복귀 → 원본/연결/조직 관찰 → 최신 합성 값 유지 | D02·03 |
| V04 | 불가+로컬/컨테이너 → 폴더 선택 → 로컬 fallback, 컨테이너 프로세스 미실행·연결 폴더 mount 없음 | D02 |
| V05 | A 컨테이너 → mount 관찰 → A 제품 폴더와 로그인 전용 폴더만, 다른 조직·연결 제품 폴더 없음 | D02 |
| V06 | 준비 중 실패/취소 → 파일 정리 → 다음 조직 준비 가능; 취소 시 cancelled·spawn 없음. Codex 두 모드와 agy 늦은 준비도 확인 | D04·05 |
| V07 | 링크 성공+원본 없음/대체 인증 응답 → 준비 확인 → 링크 자체를 ready로 오인하지 않음, 조직 신원/폴더 선택 유지 | D06 |
| V08 | provider 명령·안내·권한·로그인 오류 및 Claude/OpenCode/process recovery → 회귀 검사 → 기존 책임과 결과 유지 | D01·06 |

검사 출발점은 기존 `codex-login-link.test.ts`·`organization-folders.test.ts`와 연결 계약 검사다. 위 표는 구현 검증 권고이며 이번에 adapter 통합 검사를 실행했다는 뜻이 아니다.

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 이번 추출의 제품 정책 | #146 | 열린 결정 없음. 내부 이름·반환 타입만 구현에서 선택 |
| 로컬 fallback 장기 유지 여부 | 사용자, 별도 후속 정책 | 기존 예외 유지 / 조직 폴더 강제와 호환성 변화. #146은 전자 유지로 확정, 후속 이슈 번호 미정 |
| 공유 grant의 동시 refresh·OAuth 로그인 명령 중복 차단 | 사용자, 별도 후속 작업 | 기존 위험 수용 / grant 분리·직렬화·broker 검토. 이번에 새 기능·이슈를 만들지 않음 |

## 한계와 미확인

- 이번 실행은 합성 파일 probe 2개(6+5 검사)다. 실제 로그인·모델·유료 API·개인 자격 증명을 사용하지 않았다. upstream 테스트는 소스를 읽었으며 실행하지 않았다. 제품 통합·E2E·전체 test/typecheck/lint는 미실행이다.
- Linux 실제 링크/rename과 오류 모의를 구분한다. Windows·macOS·NFS·실제 링크 불가 환경은 미확인. Docker는 socket permission denied로 실행하지 못했다. login-only mount의 제품 실측은 과거 사용자 승인 기록이며 이번 재현이 아니다.
- agy runtime writer·keyring·실제 로그인 명령의 파일 교체·동시 갱신은 소스로 확인할 수 없다. 기존 agy 1.5.3 실측이 이후 버전에 유지되는지는 미확인. Codex Rust suite·Windows writer·실제 OAuth refresh도 미실행이다.
- **상충 — 사용자 판단 기록:** E10의 공식 운영 권고는 동시 auth.json 공유를 피하라고 한다. 기존 사용자는 동시 갱신 시 재로그인 위험을 수용했고 #146도 공유 정책을 유지한다. 이 조사는 그 결정을 재개방하지 않으며 파일 준비 큐로 공식 운영 위험까지 해결됐다고 주장하지 않는다. 향후 정책 변경의 owner는 사용자다.
- 소스 부분 캐시의 상위 저장소 `git rev-parse`를 upstream SHA로 사용하지 않았다. 고정 SHA·파일 blob 비교와 원문을 확인했다. 라이선스는 설계 참고의 식별이며 추후 코드 복사 시 header·NOTICE·의존성과 루트 THIRD_PARTY_NOTICES 규칙을 별도로 적용해야 한다.
