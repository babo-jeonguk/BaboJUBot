# issue-146 레퍼런스 재조사: 로그인 공유와 조직 제품 폴더 선택 집중

조사일: 2026-11-12. 대상: [#146](https://github.com/babo-jeonguk/BaboJUBot/issues/146). 구현 전 기술 권고이며 확정 계약이나 구현 완료가 아니다. 기준은 #171 병합 main `c8757de6b547861774bf8c75c96a90350aab84bd`이다. 작업 브랜치 HEAD `3e63b04`는 이전 코드라 사용하지 않고, 병합 소스의 수정 없는 스냅샷으로 조사했다. 제품 코드·테스트·설정 변경, 커밋·push는 없다.

## Brief — 2026-11-12

- 구현할 문제: Codex·Antigravity의 격리 켬·끔 로그인 준비 순서를 좁은 내부 경계에 집중해 원본 노출·오염 파일 역수입·조직 폴더 오선택·취소 후 spawn을 막는다.
- 동종 문제: 신뢰 수준이 다른 파일을 구별해 준비하고, 실행 시도별 권한 파일의 배치와 권한 수명 소유를 분리하기.
- 고정된 결정: 대상은 두 provider. 조직 경로 검증은 파일 변경보다 먼저, 격리 실행은 조직 폴더와 grant-only 실행 시도 전용 파일만 사용한다. 비격리 실행의 연결 폴더 fallback은 유지한다. grant 발급·회수와 attempt 폴더 삭제는 adapter, cwd·placeAttempt·프로세스 및 컨테이너 수명은 기존 담당이다. 초기 연구 승인·최종 완료·조직 경계를 코드로 강제하는 원칙과 공개 계약·DB를 바꾸지 않는다. parent 없음(404), blocker 빈 목록을 재확인했다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q6 | 두 갈래의 흔적 검사·자리 표시·전용 파일 순서와 소유는? | #146 구현 전 조사 1, Implementation Decisions 순서·소유 | Source Recon + adversarial scenario |
| Q7 | 파일 모양의 최소 전달 형태와 Claude·OpenCode 포함 여부는? | #146 구현 전 조사 2·마지막 질문 | Source Recon + 계약 대조 |
| Q8 | 늦은 준비 중 취소와 grant·폴더 정리 경계는? | #146 구현 전 조사 3, US11 | Source Recon + runtime/failure |
| Q9 | 링크 전환·최신 값·조직 파일 치우기·실패 후 진행은? | #146 구현 전 조사 4, US8–12 | persistence/recovery + 합성 파일 probe |
| Q10 | 링크 성공과 인증, 조직 신원 검사를 어떻게 분리하는가? | #146 US13·14 | Source Recon + 음성 대조군 |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| 이 문서의 11-10 기록(E01–12·D01–07, 아래 보존) | 원본 큐·인증 판정 분리·취소 원칙 | D02·D03 교체, D07 일부 해결. Paperclip LICENSE/home/test/execute 4파일은 이전 `8b3348c6…`와 새 SHA blob 동일. atomic·p-queue 소스와 LICENSE도 동일. 새 원문 재독 |
| [#148 조사·2단계 기록](issue-148-references.md#구현-기록--2단계-2026-11-12) | 원본 비전달·서버 갱신·grant 수명은 확정 전제 | main 문서와 두 adapter의 실제 파일·finally 대조. 과거 CLI·실제 계정 확인은 이번 실행으로 승격하지 않음 |
| [조직 제품 폴더 조사](org-product-folders-references.md#사용자-결정-2026-11-06) | 과거 공유 정책 배경만 | agy writer 실측 재실행 안 함. 과거 컨테이너 mount 권고는 현재 근거로 사용하지 않음 |
| [#149 구현 기록](issue-149-implementation.md), [#98–101 구현 기록](issue-98-101-implementation.md) | placement·기존 adapter 책임 배경 | 현재 main 호출 경로로 재확인, 과거 통합 실행 결과 재사용 안 함 |
| [#171 리뷰 기록](https://github.com/babo-jeonguk/BaboJUBot/pull/171#issuecomment-6818337576) | SP-1 조직 안 치운 파일 재노출, SP-2 OpenCode 동시 로그인 수입 | 댓글 및 main set-aside·isolatedRuns/copying 분기 재독 |

## 레퍼런스 — 재조사

후보 18개(오케스트레이터 9, 격리 파일 4, 큐·취소 4, Docker bind 계약 1)를 캐시에 기록했다. 이전 후보 목록도 보존했다. 오케스트레이터는 3라운드에서 staging 실패 정리/성공 후 caller 소유/원본 복사 반례를 얻고, 마지막 caller-owned 사례들이 같은 소유 패턴을 반복했다. 격리 파일은 3라운드에서 BuildKit·projected token·Swarm으로 확장했으나 마지막 라운드에 새 결정 패턴은 없었다. 큐는 2라운드에서 registry→실패 issue #241·Node·async-mutex로 확장했고 취소 반환과 작업 완료 차이로 수렴했다. 기록한 검색 범위의 saturation이며 생태계 전체를 망라하지 않는다. 같은 placeholder 분류·set-aside를 통째로 제공하는 외부 레퍼런스는 확인하지 못했다.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이·실행 경로 | 선정 이유 |
|---|---|---|---|---|---|
| Paperclip | 조직 실행 OSS | `424e2c6488035994833526bf83193664d05cc21c` | MIT 확인 | 소스; self-host 파일 unit test 가능, 미실행 | 준비 결과와 caller 수명 분리·원본 복사 반례 |
| BuildKit | 인접 실행 엔진 | `8cd4dbe133ab23a3d9b9ea749012f38d5db4604d` | Apache-2.0 확인 | 소스; self-host daemon+합성 secret, 미실행 | 시도별 임시 파일·RO descriptor·cleanup 반환 |
| write-file-atomic | 파일 큐 | `23e111d95367e1d987c1b4d7823791eaaf6b21df` | ISC 확인 | 소스; Node 파일 API, 미실행 | 정리 이후 다음 작업 진행 |
| p-queue | 작업 큐 | `7f272ab5ff2254c0dc2537b7977e88ede1cd55e8` | MIT 확인 | 소스; Node/build, 미실행 | signal race의 직접 반례와 테스트 |
| Docker bind/build secrets·Kubernetes projected token·async-mutex·Node | 명세·라이브러리 보조 후보 | 11-12 열람; async-mutex 기존 SHA 동일 | 설계 참고 | 문서; 각 로컬 Docker/cluster/Node 실행 경로, 이번 미실행 | mount 아래 파일의 잔존, 수명 제한, 취소 의미 보강 |

나머지 오케스트레이터 후보는 Multica, Agents Python, Docker sandbox usage, inoio agents-sandbox, AgentOpsSec agent-sandbox, agent-of-empires, kubernetes-sigs agent-sandbox, deepseek-harness다. 공개 문서·검색 결과 수준으로 제한했다. 로그인·VM·cluster 설치가 필요한 실행은 하지 않았고, 경계 API를 구체화할 새 근거가 없어 심층 제외했다. 외부 코드 복사·신규 의존성 도입은 권고하지 않는다.

## 근거 — 재조사

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E13"></a>E13 | Codex는 조직 경로→연결 준비→흔적 검사(알려진 원본 링크·relay 형식 예외)→비격리 placeholder 삭제/링크→home 선택. 격리 파일은 grant만 담고 권한 없는 placeholder 위에 RO 배치. finally가 grant 회수·attempt 삭제 | [execute](https://github.com/babo-jeonguk/BaboJUBot/blob/c8757de6b547861774bf8c75c96a90350aab84bd/packages/runtime/src/providers/codex.ts#L496-L574), [정리](https://github.com/babo-jeonguk/BaboJUBot/blob/c8757de6b547861774bf8c75c96a90350aab84bd/packages/runtime/src/providers/codex.ts#L878-L882) | 소스 확인 |
| <a id="E14"></a>E14 | agy도 같은 갈래. token 경로·형식·식별은 다르며 cwd realpath와 이후 ACP 조립은 고유 책임. Codex 식별은 id_token/account_id/API key, agy는 expiry/refresh 검사라 predicate 통일은 동작 변경 | [agy 준비](https://github.com/babo-jeonguk/BaboJUBot/blob/c8757de6b547861774bf8c75c96a90350aab84bd/packages/runtime/src/providers/antigravity.ts#L313-L384), [agy 형식](https://github.com/babo-jeonguk/BaboJUBot/blob/c8757de6b547861774bf8c75c96a90350aab84bd/packages/runtime/src/providers/antigravity.ts#L78-L120), [Codex 형식](https://github.com/babo-jeonguk/BaboJUBot/blob/c8757de6b547861774bf8c75c96a90350aab84bd/packages/runtime/src/providers/codex.ts#L122-L167) | 소스 확인 |
| <a id="E15"></a>E15 | loginLink는 original별 큐, reject 후 진행. 일반 파일은 at===fallback일 때만 원본 이동, 조직 파일은 연결 set-aside로 이동. 알려진 조직 링크도 매번 링크 capability 확인 | [파일 관리](https://github.com/babo-jeonguk/BaboJUBot/blob/c8757de6b547861774bf8c75c96a90350aab84bd/packages/runtime/src/providers/login-link.ts#L13-L170) | 소스 확인 |
| <a id="E16"></a>E16 | Paperclip staging은 경로 반환·부분실패 자체 삭제, 성공 후 caller finally 삭제. auth 원문 dereference 복사는 우리 정책과 다름. I/O 실패 후 폴더 없음 assert 존재(미실행) | [stage](https://github.com/paperclipai/paperclip/blob/424e2c6488035994833526bf83193664d05cc21c/packages/adapters/codex-local/src/server/codex-home.ts#L554-L643), [caller](https://github.com/paperclipai/paperclip/blob/424e2c6488035994833526bf83193664d05cc21c/packages/adapters/codex-local/src/server/execute.ts#L1704-L1727), [test](https://github.com/paperclipai/paperclip/blob/424e2c6488035994833526bf83193664d05cc21c/packages/adapters/codex-local/src/server/codex-home.test.ts#L1338-L1365) | 소스 확인 |
| <a id="E17"></a>E17 | BuildKit은 매 mount 임시 파일과 RO mount·cleanup 반환, 실행기가 cleanup을 소유. 원본 secret 자체를 넣는 정책은 우리와 다름. unmount 실패면 뒤 디렉터리 삭제가 안 될 수 있음 | [mount](https://github.com/moby/buildkit/blob/8cd4dbe133ab23a3d9b9ea749012f38d5db4604d/solver/llbsolver/mounts/secretmount_unix.go#L16-L90), [caller](https://github.com/moby/buildkit/blob/8cd4dbe133ab23a3d9b9ea749012f38d5db4604d/executor/runcexecutor/executor.go#L324-L328) | 소스 확인 |
| <a id="E18"></a>E18 | atomic은 filename별 큐이며 close/unlink await 뒤 다음 waiter. 공유 원본의 alias를 key로 쓰면 보호 범위가 다름 | [finally](https://github.com/npm/write-file-atomic/blob/23e111d95367e1d987c1b4d7823791eaaf6b21df/lib/index.js#L50-L160) | 소스 확인 |
| <a id="E19"></a>E19 | p-queue는 abort race 뒤 슬롯 해제. 테스트가 끝나지 않는 원작업을 남기고 다음 작업 성공을 assert. 비협력 파일 준비 전체 정리 대기 계약과 다름 | [runner](https://github.com/sindresorhus/p-queue/blob/7f272ab5ff2254c0dc2537b7977e88ede1cd55e8/source/index.ts#L689-L731), [test](https://github.com/sindresorhus/p-queue/blob/7f272ab5ff2254c0dc2537b7977e88ede1cd55e8/test/basic.ts#L278-L292) | 소스 확인·테스트 미실행 |
| <a id="E20"></a>E20 | Claude는 환경 변수 grant와 흔적 목록, OpenCode는 DB 로그인·isolatedRuns/copying 관리. 같은 파일 descriptor로 흡수할 수 없는 고유 수명. folders는 조직 ID 형식 검사 후 경로 반환 | [Claude](https://github.com/babo-jeonguk/BaboJUBot/blob/c8757de6b547861774bf8c75c96a90350aab84bd/packages/runtime/src/providers/claude.ts#L322-L375), [OpenCode](https://github.com/babo-jeonguk/BaboJUBot/blob/c8757de6b547861774bf8c75c96a90350aab84bd/packages/runtime/src/providers/opencode.ts#L538-L574), [folders](https://github.com/babo-jeonguk/BaboJUBot/blob/c8757de6b547861774bf8c75c96a90350aab84bd/packages/runtime/src/providers/folders.ts#L1-L20) | 소스 확인 |
| <a id="E21"></a>E21 | 수정 없는 main loginLink 직접 import: 14검사 통과. 오류 3종 각각 A/B 공유, 조직 파일 set-aside·원본 불변, 링크 실패→재로그인→복귀, EIO 후 진행. 원본 없는 링크 성공/읽기 ENOENT와 gate 중 취소 후 파일 완료도 확인 | Node v24.21.0, Linux 7.0.0-1013-oracle arm64, 합성 파일만·빈 환경. 파일 임시 폴더 제거 | 실행 확인 |
| <a id="E22"></a>E22 | bind mount는 아래 기존 파일을 가린다. build secret은 지시문 수명에 한정. RO mount 해제 뒤 공유 폴더에 권한 값이 남지 않도록 하는 근거이나 grant 회수까지 보장하는 것은 아님 | [bind mounts](https://docs.docker.com/engine/storage/bind-mounts/), [build secrets](https://docs.docker.com/build/building/secrets/) | 문서 주장; 적용은 추론 |

E13–20은 메인이 원문을 다시 읽었다. E21에서 symlink/rename/read/write는 실제 Linux 동작, EPERM·ENOTSUP·EOPNOTSUPP·EIO와 지연은 모의 주입이다. 취소 후 adapter가 spawn하지 않음·cancelled 반환·grant 회수는 이번 probe의 실행 확인이 아니다.

## 패턴 — 재조사

| ID | 패턴 | 사례·프로젝트 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|
| P05 | 준비 결과만 경계 밖으로, 수명은 실행 caller | E13·14·16·17; 우리 grant는 caller만 소유 | 오류·취소·정상 종료 공통 정리 | 준비가 throw하기 전 자원 소유자가 명확해야 함 |
| P06 | 조직 공유 자리에는 무권한 placeholder, 실행 시도별 파일만 RO | E13·14·17·22; BuildKit 원본과 달리 grant만 전달 | 같은 조직 동시 시도의 권한 혼합 방지 | RO 아래 파일은 mount 해제 뒤 드러남, 원본 사본 금지 |
| P07 | 신뢰 위치에 따른 비대칭 이전 | E15·21; fallback만 원본 수입 | 재로그인 보존과 조직 오염 역수입 방지 | set-aside를 조직 폴더에 두면 재노출 |
| P08 | 시작한 준비 완료 뒤 취소, 프로세스 시작 직전 재검사 | E18·19·21; race 반환과 다름 | 부분 이동과 다음 준비 경합 감소 | 취소 응답 지연·영구 I/O 멈춤·crash는 별도 |

## 결정 권고 — 재조사

| ID | 권고 | 내용 | 근거·이유·트레이드오프 | 질문 |
|---|---|---|---|---|
| <a id="D08"></a>D08 | 변형 채택 | 조직 경로 검증→연결 준비→격리 흔적 검사/비격리 placeholder 제거·링크→home 선택→격리 전용 파일·placeholder를 한 내부 경계에 모음. 결과는 home·선택적 파일 source/target·거부 사유 | P05·06, #146. 컨테이너 배치보다 검사 선행. caller가 boolean을 다시 해석하지 않음 | Q6·Q10 |
| <a id="D09"></a>D09 | 채택 | 격리는 링크 불가여도 조직 home, 원본·연결 home·login-only mount 없음. 실행 시도별 grant 파일 RO, 조직에는 무권한 placeholder | P06. 아래 D02의 컨테이너 거부·shared mount는 #148로 대체 | Q6·Q9 |
| <a id="D10"></a>D10 | 채택 | 기존 loginLink 그대로 사용: 연결 fallback 파일만 원본으로, 조직 일반 파일은 연결 set-aside. seed 복사·mtime 새 정책 금지 | P07·E21. 아래 D03의 무조건 일반 파일 우선 이전을 대체 | Q9 |
| <a id="D11"></a>D11 | 변형 채택 | provider는 상대 로그인 경로, grant→파일 내용 생성, 기존 placeholder 식별/생성에 필요한 최소 동작만 제공. 파일 정리·폴더 선택은 공통 경계. 반환 타입·이름은 구현에서 정함 | E14·P05. Codex/agy predicate를 그대로 유지할 수 있는 작은 descriptor. grant 발급·회수·프로세스 callback을 받는 범용 틀은 배제 | Q7 |
| <a id="D12"></a>D12 | 채택 | grant 발급 및 attempt 폴더 생성·finally 삭제는 adapter의 정리 범위 안. 경계는 이미 소유자가 있는 attempt 경로·권한 값을 받아 씀. 중간 throw에도 caller가 위치를 알아야 함 | E13·16·17. 파일 준비 helper가 폴더를 만든 뒤 반환 전 throw하여 caller가 경로를 잃는 형태 회피 | Q6·Q8 |
| <a id="D13"></a>D13 | 채택 | 시작한 준비는 await, original 큐 유지. provider의 늦은 await 뒤 실제 startProcess 직전 signal 검사, 취소 시 cancelled로 종료하고 기존 finally 실행 | P08·E15. Codex app-server와 exec helper 각각 확인. OAuth 갱신·프로세스 간 잠금 보장 아님 | Q8·Q9 |
| <a id="D14"></a>D14 | 채택 | link capability·파일 존재를 인증 성공으로 반환하지 않음. readiness·로그인 안내·서버 갱신 유지. 조직 ID 검사를 로그인 변경보다 먼저 유지 | E13·15·20·21. 제품 정책·공개 API·DB·승인 계약 변화 없음 | Q10 |
| <a id="D15"></a>D15 | 배제·보류 | Claude/OpenCode 흡수 배제. fallback 폐지·OAuth 명령 중복 차단은 별도 후속(번호 미정). 기존 D07의 broker 보류는 #148 서버 갱신으로 해결 | E20·#146. 겹치는 흔적 검사는 기존 helper 재사용, 인증 방식과 DB 동시성까지 확장하지 않음 | Q7·Q9 |

배제: Paperclip auth 원문 복사·BuildKit 원본 secret mount(E16·17)는 #148과 상충. p-queue 취소 race(E19)는 정리 전 큐 해제. 조직 폴더 안 set-aside는 #171 SP-1 재노출. 기존 Multica의 링크 실패 후 진행은 이제 격리 거부의 직접 반례가 아니므로 과거 E08을 현 결정에 재사용하지 않는다. 이전의 단일 파일 mount 일반 배제도 grant-only RO 파일에는 적용하지 않는다.

## 구현 참고 — 재조사

위치는 `packages/runtime/src/providers/` 내부다. core/contracts/DB에 파일 시스템 정책을 올리지 않는다([구조](../architecture.md#패키지-구성), [ADR-0001](../adr/0001-adapter-control-plane.md), [ADR-0005](../adr/0005-approval-policy-enforcement-scope.md)). `folders` 검증·`login-link` 알고리즘·`credentialResidue`를 재사용하고 `placeAttempt`의 mount 신원 검증과 `startProcess` 수명은 유지한다. descriptor의 구체 이름은 계약으로 확정하지 않는다. 연구 조직의 승인·격리 불변 조건을 역할 프롬프트로 옮기지 않는다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V09 | 잘못된 조직 ID → 준비 → 로그인 파일 변경·spawn 전 거부 | D08·14 |
| V10 | 같은 연결 A/B+준비 확인 동시 시작 → A 갱신 → B도 같은 원본 읽음, EIO 뒤 다음 준비 가능 | D10·13 |
| V11 | 링크 가능↔불가 3오류+재로그인 → 비격리 실행 → home/fallback 선택·최신 값 보존, 조직 파일은 원본 덮지 않음 | D09·10 |
| V12 | 격리+링크 불가 → 배치 관찰 → 조직 home만, 연결/login-only/원본 내용 없는 mount | D09 |
| V13 | 조직 일반 파일/임의 링크/알려진 원본 링크/기존 placeholder → 격리 준비 → 앞 둘 거부, 뒤 둘 허용 | D08·11 |
| V14 | 같은 조직 두 격리 실행 → 파일/mount 관찰 → 서로 다른 시도 파일·RO, 공유 placeholder에는 grant 없음 | D09·12 |
| V15 | 격리→비격리→격리 → placeholder 제거·조직 일반 파일 치우기 → 원본 보존, set-aside가 어느 mount에도 없음 | D10 |
| V16 | 격리 켬·끔 준비 gate 중 취소 → 파일 작업 완료 후 spawn 차단·cancelled → grant 회수·시도 폴더 삭제·다음 조직 준비 가능 | D12·13 |
| V17 | 링크 성공+원본 없음 → readiness/실행 → 링크 자체를 인증 성공으로 보고하지 않음; Claude/OpenCode·프로세스 복구 회귀 | D14·15 |

이 표는 구현 단계 검증 권고다. 이번 실행은 E21의 파일 동작만 검증했다. 기존 login-link·organization-folders·container 및 provider 통합 시험의 원본·링크·mount·반환 상태 assertions를 기준으로 하며 private callback 모양을 검사하지 않는다.

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 내부 descriptor 이름·반환 타입·두 단계 준비 표현 | #146 구현 | 작은 descriptor와 소유된 attempt 경로 전달을 우선. grant 발급을 helper로 옮기지 않고 순서를 표현할 수 있어야 함(D11·12). 새 제품 정책 선택은 없음 |
| fallback 장기 폐지·OAuth 로그인 명령 중복 차단 | 사용자, 별도 후속 번호 미정 | 기존 예외 유지가 현재 범위. 별도 정책 변경 때 재검토(D15) |

## 한계와 미확인 — 재조사

- 외부 OSS 테스트·제품 adapter 통합·실제 Docker mount·E2E·전체 test/typecheck/lint는 미실행. Docker daemon 실행을 이번에 시도하지 않았고, 이전 권한 거부를 현재 실행 결과로 주장하지 않는다.
- macOS·Windows·NFS의 실제 링크 제약·grant 파일 동시 노출·grant 회수·취소 결과의 adapter 통합은 미확인. 오류 주입 probe를 실제 플랫폼 검증으로 일반화하지 않는다.
- 실제 로그인·개인 자격 증명·모델 호출 없음. #148의 실제 구독 검증은 그 기록의 근거이며 이번 실측 아님. 파일 큐는 OAuth 갱신 경쟁을 해결하지 않는다.
- 제품과 똑같은 placeholder 최소 descriptor 외부 사례는 못 찾았다. D11은 현재 provider 형식과 수명 분리 사례에서 도출한 설계 추론이다. 공개 자료는 접근했지만 로그인·유료 서비스는 조사하지 않았다.
- 소스·LICENSE·upstream 변경, 코드 복사를 하게 되면 header/NOTICE/의존 라이선스를 다시 확인한다. 이번에는 설계 참고뿐이다.

## 구현 기록 — 2026-11-16

기준: `origin/main` `99b884b`. 브랜치 `feat/146-login-share-boundary`.

- 경계: `packages/runtime/src/providers/file-login.ts`의 `fileLogin`이 조직 ID 확인 → 연결 자리 로그인 준비 → 격리면 흔적 검사 / 끔이면 자리 표시 지우기·조직 자리 링크 → 돌 제품 폴더 → (격리) 실행 시도 전용 로그인 파일·자리 표시를 맡는다(D08). 연결이 넘기는 것은 로그인 자리 상대 경로, 권한 값 → 파일 내용, 자리 표시·전용 파일 식별 네 값뿐이다(D11). 두 predicate의 형식은 그대로다.
- 두 단계: `prepare(조직, 격리)`가 제품 폴더나 거부 사유를 돌려주고, 격리면 `attemptLogin(시도 폴더, 권한)`을 함께 준다. 어댑터는 그 사이에 `placeAttempt`·권한 발급·`mkdtemp`를 기존 try/finally 안에서 하고, 경계는 받은 폴더에 파일만 쓴다(D12). 권한 발급을 경계로 옮기지 않았다.
- 취소(D13): Codex app-server는 `openCodexConnection` 직전, exec는 `executeExec`의 `startProcess` 직전(새 세션으로 다시 시도하는 호출 포함), Antigravity는 `startProcess` 직전에 취소를 다시 본다. 취소면 cancelled, 중계 실패면 중계 실패로 끝내고 기존 finally가 권한 회수·시도 폴더 삭제를 한다. `loginLink`의 큐는 그대로다.
- 동작 변화 없음: 격리 실행은 조직 폴더만, 끔은 링크 가능 시 조직·불가 시 연결 폴더, 조직 자리 보통 파일은 연결 `set-aside/`(D09·D10). Claude·OpenCode는 바꾸지 않았다(D15).
- 시험: `login-preparation.test.ts`를 더했다. Codex app-server·exec·Antigravity 각각 ① 격리 끔: 조직 링크 작업 중 취소 → 링크 완료·원본 그대로·프로세스 없음·cancelled·다음 조직 실행 ② 격리: 시도 전용 파일 쓰기 중 취소 → 컨테이너 없음·cancelled·권한 403→401·시도 폴더 없음·조직 자리에 권한 없음·다음 실행 ③ 링크 거절(EPERM 모의) 격리 실행 → 연결 안 mount는 조직 폴더뿐·어느 mount에도 원본 내용 없음 ④ 잘못된 조직 ID → 프로세스 없음·연결 폴더 예전 로그인 그대로. ①②는 변경 전 코드에서 6건 모두 프로세스를 띄워 실패했다. 프로세스 시작은 `cross-spawn` 호출로, 파일 작업 gate는 `node:fs/promises` 모의로 본다.
- 원문 확인(2026-11-16, 고정 SHA): Paperclip `stageCodexHomeForSync`는 경로를 돌려주고 실패 시 자기 폴더를 지우며 성공 뒤 삭제는 호출자에 남긴다(원본 auth는 바이트 복사 — 배제). 호출자 `execute.ts`는 바깥 finally가 지우도록 변수를 try 밖에 둔다(finally 본문은 원문으로 확인하지 못함). BuildKit secret mount는 마운트마다 임시 파일을 RO bind로 돌려주고 cleanup을 호출자에 넘긴다(원본 secret 전달 — 배제). p-queue는 abort가 race에서 이겨 작업 완료 전에 자리를 돌려준다(정리 완료 대기 계약과 달라 배제).
- 발견(범위 밖): 링크를 만들 수 없는 컴퓨터에서는 `loginLink`가 원본을 연결 폴더 자리로 옮긴다(시험 ③에서 원본 자리가 비는 것을 확인). 인증 중계는 원본 자리만 읽으므로 그 컴퓨터의 Codex·Antigravity 격리 실행은 중계가 로그인을 읽지 못할 것으로 보인다(코드 경로 추론, 중계 실패 자체는 미실행). #148 중계 쪽 후속 대상이다.
- 미실행: 실제 Docker(CI Linux에서 확인), macOS·Windows의 실제 링크 제약, 실제 로그인·모델 호출.

## 이전 결정 대체 이력

| 이전 결정 | 2026-11-12 관계 |
|---|---|
| D01 | D08·11·12로 범위 확장, shared login-only 반환 제거 |
| D02 | #148로 대체 → D09. 격리 링크 불가 거부·login-only mount 폐기, 비격리 fallback 유지 |
| D03 | #148로 대체 → D10. 원본으로 받아들이는 일반 파일은 연결 fallback만 |
| D04·D05·D06 | D13·D14에 원칙 유지, grant·폴더 정리는 D12 보강 |
| D07 | broker는 #148로 해결. fallback 장기 정책·OAuth 중복 명령만 범위 밖(D15) |

아래는 2026-11-10 당시 기록으로 현재 구현 권고가 아니다. ID·원문은 이력 추적을 위해 보존했다. 현재 구현자는 위 D08–D15·V09–V17을 따른다.

---

## 2026-11-10 과거 조사: 로그인 공유와 조직 제품 폴더 선택 집중

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
