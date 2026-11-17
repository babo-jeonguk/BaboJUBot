# #209 구현 기록 — 링크를 만들 수 없는 컴퓨터의 인증 중계 로그인 읽기

기준: `main` `3b5c3d1`, 작업 브랜치 `feat/209-relay-login-no-links`. 요구는 [#209](https://github.com/babo-jeonguk/BaboJUBot/issues/209)(2026-11-17 사용자 결정: 조사의 방법 A), 조사는 [relay-login-no-links-references.md](relay-login-no-links-references.md)다.

## 원문으로 다시 확인한 근거

| 근거 | 확인한 곳 | 적용 | 배제·차이 |
|---|---|---|---|
| Codex는 저장할 때 `auth.json` 링크를 풀어 대상 옆에 새 파일을 쓰고 대상 자리로 rename한다. 보통 파일이면 그 자리다 | [storage.rs L274-L296](https://github.com/openai/codex/blob/c656014177079dae2dcc5e1e70c03e3158383a27/codex-rs/login/src/auth/storage.rs#L274-L296) `FileAuthStorage::save` | 링크를 만들 수 없는 컴퓨터에서 이 컴퓨터의 Codex(로그인·갱신)가 쓰는 자리는 연결 폴더 자리의 보통 파일이므로, 중계가 그 자리를 읽는다. 갱신 시험 대역(`codex-refresh.mjs`)도 `realpath` 뒤 같은 자리에 쓴다 | 하드 링크 거부(`check_replaceable`)는 이번 변경과 무관 |
| OpenHands는 링크를 못 만들면 CLI를 임시 폴더의 실제 파일로 돌리고, 감시가 그 파일(`self.path`)을 읽는다 | [acp_file_credentials.py L135-L205](https://github.com/OpenHands/software-agent-sdk/blob/98c8cd30ddfa7282f29bb95eb1df62f1c28c39e1/openhands-sdk/openhands/sdk/agent/acp_file_credentials.py#L135-L205) | "프로그램이 실제로 읽는 파일을 읽는다"는 방법 A의 선례 | OpenHands는 사본을 정본에 되쓴다. 여기서는 사본이 없고 원본 자체가 연결 폴더 자리로 옮겨진다(#146 「로그인은 하나」) |
| Paperclip의 Codex 로그인 사본 갈라짐(#5028) | 이 구현에서 다시 열지 않음 | — | 방법 C(사본 동기화)를 배제한 근거이며 조사 문서와 이슈 receipt의 메인 확인에 따른다 |

agy가 링크 불가 디스크의 보통 파일 로그인을 같은 경로에 덮어써 갱신한다는 점(1.5.9)은 이슈 receipt의 메인 실행 확인을 따르며, 이 구현에서 다시 실행하지 않았다.

## 결정과 구현

- **읽는 자리**: `login-link.ts`의 `readLogin(original, fallback)`이 원본 자리를 읽고, 없으면(ENOENT) 연결 폴더 자리를 읽는다(링크면 따라감). `fileLogin(...).read`가 이를 연결마다 묶고, Codex `currentLogin`·Antigravity `currentAccess`가 갱신 전후에 쓴다. 판정 규칙(곧 끝나면 갱신, 갱신 뒤에도 끝나 가면 실패)과 복구 규칙(`recover`가 같은 읽기로 다른 로그인을 찾으면 풂)은 바꾸지 않았다.
- **차례**: 읽기는 같은 원본의 링크 작업 줄(`oneAtATime`, 이번에 이름을 `turns`로 바꿈)에 선다. 링크가 되돌아올 때의 rename 두 번 사이에 시작한 읽기는 두 자리 모두에서 못 읽는다(조사 E24). 시험은 옮기기를 gate로 붙잡아(되돌아오는 방향은 두 rename 사이에서) 요청이 끝나지 않고 상류에도 가지 않았음을 보고, 풀어 준 뒤 중계가 로그인을 읽기 시작한 때가 옮기기가 끝난 뒤임을 차례 기록으로 본다. 실패 결과(두 자리 모두 비어 보임)는 파일 입출력이 끝나는 때에 달려 있어 단언하지 않는다(외부 리뷰 1회차 STD-1·SPEC-1).
- **바꾸지 않은 것**: 컨테이너 mount(원본·로그인 전용 폴더·연결 폴더 없음), 복사본 없음, 링크 불가 때 원본을 연결 자리로 옮기는 규칙, `set-aside/`, 링크 불가 경고, 실패 문구.

## 검증 경계와 결과

| 이슈의 검증 경계 | 검사 | 결과(로컬, 2026-11-17) |
|---|---|---|
| 1. 링크 거절(EPERM·ENOTSUP·EOPNOTSUPP 모의) 격리 실행 완료·mount에 로그인 없음, 다시 로그인 반영, 갱신, 링크 가능↔불가 섞기, 로그인 없음 | `container.test.ts` `an isolated attempt on a machine that cannot create links (#209)` — Codex app-server·exec, Antigravity | 통과. 수정 전에는 로그인 없음 3건 말고 모두 중계 실패로 실패 |
| 2. 로그인 옮기기와 중계 읽기의 경합 | `login-preparation.test.ts` `holds a relay request that comes while the login is moved back …`, `… moved to the connection folder …` | 통과(15회 반복 모두 통과). 줄 없이 읽게 바꾸면 두 방향 6건 모두 실패: 되돌아오는 방향은 503, 반대 방향은 옮기기 전에 원본을 읽은 차례 |
| 3. 준비 확인과 회복 | `apps/server/src/isolation.test.ts` `readiness of a … connection on a machine that cannot create links`; 회복 뒤 다음 격리 실행 완료는 `container.test.ts` `completes the next isolated … after a relay failure …` | 통과. 원본만 읽게 바꾸면 4건 실패 |
| 4. 실제 vfat | `container.test.ts` `on a real disk that refuses links`(`BABOJUBOT_TEST_NO_LINK_DIR`), CI `tests / runtime`의 vfat loop 단계 | 로컬 미실행(loop mount 권한 거절). CI 결과는 PR에 적는다 |
| 5. 회귀 | runtime 전체, 서버 격리 관문, `pnpm check`·`typecheck`·`lint`·`test` | PR에 적는다 |

## 미실행·한계

- 실제 Codex·Antigravity 프로그램, 실제 Docker, 실제 로그인으로의 흐름은 실행하지 않았다(모델 호출 없음).
- 서버 시험은 관문(`IsolationGate`)과 실제 연결의 중계까지이며, 서버 전체(HTTP·DB)를 거치는 격리 실행은 runtime 시험이 대신한다.
- 원본 자리와 연결 폴더 자리에 둘 다 보통 파일이 있는 경우(링크를 풀어 복사한 데이터 폴더를 링크 불가 디스크에 둔 경우 등) 이 컴퓨터의 실행은 연결 폴더 자리를, 중계는 이슈의 순서대로 원본 자리를 읽는다. 제품 동작만으로는 이 상태가 생기지 않으며, 이번 범위에서 다루지 않았다.
