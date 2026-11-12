# #149 구현 기록 — 컨테이너 시작 환경·mount·네트워크 경계

기준: `main` `89f6abb`, 작업 브랜치 `fix/149-container-boundaries`. 요구는 [#149 Agent Brief](https://github.com/babo-jeonguk/BaboJUBot/issues/149)(2026-11-11 사용자 확정: 도메인+포트 허용 목록과 실제 주소의 내부망 기본 차단, 개인 연구 환경 명시 사용), 조사는 [issue-149-references.md](issue-149-references.md)다.

## 원문으로 다시 확인한 근거

| 근거 | 확인한 곳 | 적용 | 배제·차이 |
|---|---|---|---|
| sandbox-runtime: 네트워크 namespace를 끊고 프록시 Unix socket만 bind, 안쪽 listener(3128)가 socket으로 잇고 프록시 환경 변수를 정함 | [linux-sandbox-utils.ts L3694-L3778](https://github.com/anthropics/sandbox-runtime/blob/f7a0f19fd3b4437bcf808f9c18c1f73e9f1a9889/src/sandbox/linux-sandbox-utils.ts#L3694-L3778) | `--network none` + 실행 시도별 중계 폴더(읽기) + 이미지의 `relay.mjs`가 loopback 39280/39281을 socket에 잇는 배치 | socat·SOCKS 대신 Node 한 파일, SOCKS는 받지 않음. 환경 변수는 편의이며 경계는 네트워크 없음 |
| sandbox-runtime: 허용한 이름이 풀린 주소의 금지 분류(loopback·미지정·link-local·멀티캐스트·broadcast·metadata, IPv4를 담은 IPv6 형태, 이 컴퓨터의 인터페이스 주소) | [resolved-address-guard.ts L55-L80](https://github.com/anthropics/sandbox-runtime/blob/f7a0f19fd3b4437bcf808f9c18c1f73e9f1a9889/src/sandbox/resolved-address-guard.ts#L55-L80) | `egress-policy.ts`의 금지 대역과 mapped·NAT64·6to4 안의 IPv4 확인, 인터페이스 주소 차단 | SRT는 사설망·ULA·CGNAT를 기본 허용한다. #149 결정대로 기본 거부하고 목적지별 주소 예외로만 연다 |
| Codex network-proxy: 허용 이름이 아니라 실제로 dial할 SocketAddr를 검사하고 그 주소로 연결 | [connect_policy.rs L194-L231](https://github.com/openai/codex/blob/627b579219d492b5445d6d433d3110eb53e507dc/codex-rs/network-proxy/src/connect_policy.rs#L194-L231) | 중계가 이 컴퓨터에서 이름을 한 번 풀어 모든 주소를 판정하고, 판정한 주소로만 연결(다시 풀지 않음) | `allow_local_binding` 같은 전역 내부망 허용은 두지 않음 |
| Docker: internal 네트워크도 bridge 주소의 host 서비스(0.0.0.0 포함)에 닿는다 | [port-publishing.md L186-L192](https://github.com/docker/docs/blob/75a95460ce3cc8db87a23893490ec331506d08fd/content/manuals/engine/network/port-publishing.md#L186-L192) | 실행 시도별 internal 네트워크안을 배제한 근거 | — |

## 배치 비교(무모델 fixture, 2026-11-11, 이 컴퓨터 Docker 29.1.3)

| 안 | 결과 | 판단 |
|---|---|---|
| `--network none` + 읽기 bind한 Unix socket(`--user`·`--cap-drop ALL`·`no-new-privileges`) | 컨테이너 장치 `lo`만, `1.1.1.1:443` ENETUNREACH, DNS EAI_AGAIN, `::1` 거부, socket으로 이 컴퓨터 listener 응답 수신 | 채택. 이 컴퓨터 방화벽을 바꾸지 않는다. 기존 조직 도구 listener의 임시 iptables 규칙이 필요 없어진다 |
| `--internal` bridge(icc 끔) + gateway listener | 외부 ENETUNREACH. gateway listener는 이 컴퓨터 INPUT REJECT 때문에 EHOSTUNREACH. 규칙이 없는 컴퓨터에서는 Docker 문서대로 닿는다 | 배제. 호스트 서비스 차단을 호스트 INPUT 규칙(root)에 맡겨야 하고, 같은 bridge의 0.0.0.0 서비스가 열린다 |

## 결정과 구현

- **신뢰된 시작 환경**: `entry.sh`가 고정 PATH·시작 코드 주입 변수 제거·`PYTHONNOUSERSITE`·git `core.fsmonitor=false`로 `relay.mjs`를 띄우고, `relay.mjs`가 프로그램을 띄운다. 조직 폴더 가상환경(`shared/.venv`)의 자동 생성·활성화는 없앴다(기존 것은 그대로 둔다). 서버도 `NODE_OPTIONS` 등은 넘기지 않는다. 연구 패키지는 `BABOJUBOT_PERSONAL/.venv`를 경로로 부르도록 역할 지침에 적었다.
- **권한에서 만든 mount**: `placeAttempt`가 신원(조직·에이전트)의 자리(제품·로그인·조직·자기·동료·실행 시도 전용 파일)만 만들고, 서버 소유 부모를 실제 경로로 푼 뒤 자리의 칸마다 `lstat`(링크·종류·없음)를 본다. 겹침·자리 밖 작업 폴더는 거부한다. mount 원본의 부모·칸은 어떤 컨테이너에도 들어가지 않아 확인과 mount 사이에 에이전트가 바꿀 수 없다. FD 이름을 Docker에 넘기는 방식은 쓰지 않았다.
- **중계와 정책**: 실행 시도마다 `babojubot-relay-*`에 `egress.sock`·`tools.sock`(OpenCode는 `inbound.sock`)을 연다. 필수 목적지는 연결마다 코드(`destinations.ts`)와 운영자 설정(`BABOJUBOT_MODEL_DESTINATIONS`), 연구 목적지는 조직 허용 목록이며 초기 연구 승인 뒤에만 더한다. 목록 축소는 열린 연결을 끊고, 거부는 실행 활동에 남긴다. 조직 도구 요청에는 중계가 실행 시도·조직 신원을 덮어쓰고 서버가 토큰과 대조한다.
- **Docker 구성**: 같은 컴퓨터의 Linux Docker Engine만 받는다(`DOCKER_HOST` unix, Docker Desktop·rootless·Windows engine 거부). 이미지 label `babojubot.runner=2`가 아니면 `격리 환경 없음`이다.

## 검증 경계와 결과

| 조사의 검증 경계 | 검사 | 결과 |
|---|---|---|
| V01 공유 실행 파일·시작 환경 오염 | Docker 전용 `starts the program and its child commands from the image…`: 조직 `shared/.venv/bin`·HOME의 사용자 실행 파일 폴더에 node·python·sh·git을 심고 `NODE_OPTIONS`·`LD_PRELOAD`를 줌 | 이미지 node·sh만 실행, 표식 없음, 개인 도구 명시 실행 성공, 기존 공유 가상환경 유지 |
| V02 다른 조직·홈·socket·링크·누락·타입·임의 cwd | `container-mounts.test.ts` 11건, Docker 전용 `refuses a pre-planted link…`·폴더 권한 검사 | 시작 전 거부(컨테이너 생성 없음), 다른 조직 sentinel ENOENT, 거부 문장에 경로 없음 |
| V03 조상 교체 | 조상(`organizations/<조직>`)을 다른 조직 링크로 바꾼 경우 거부. 동시 교체는 구조로 막음(위 결정) | 거부. 확인-mount 사이의 실제 경합 재현은 하지 않았다(교체할 수 있는 컨테이너가 없음) |
| V04 직접 통신 우회 | Docker 전용 `reaches an allowed destination only through the relay…`·안전 확인 | 직접 IPv4·LAN·IPv6·UDP·DNS 실패, 프록시 경유 허용 fixture만 성공, 금지 fixture 요청 0건 |
| V05 허용 이름의 내부 주소·mixed·literal·CONNECT | `egress-policy.test.ts` 9건, `relay.test.ts` 11건 | 거부. redirect는 클라이언트가 다음 요청을 다시 중계에 보내므로 같은 판정을 받는다(별도 시험 없음) |
| V06 다른 실행 시도의 중계·토큰 | 서버 `runs real connections … only through that run's relay`(다른 중계로 같은 토큰 401), `opens research destinations only after…`(다른 조직 목록 미적용) | 거부 |
| V07 중계·정책 장애, 종료, 축소 | `relay.test.ts`(정책 읽기 실패 `policy_unavailable`, 종료 뒤 소켓 없음, 축소 시 연결 끊김), 관문 단위·서버 시험 | 차단 유지, fallback 없음 |
| V08 실제 Docker의 transport | Docker 전용 9건(OpenCode식 역방향 제어, 취소 뒤 컨테이너·중계 정리, 실행 시도 전용 파일 overlay 포함) | 통과. 네 프로바이더 실제 CLI·로그인·모델 통신은 실행하지 않았다(비용·계정) |

## 미실행·한계

- 제품 공통 이미지(`pnpm runner:build`)로 네 프로바이더 CLI가 프록시 환경에서 실제로 모델·로그인 목적지에 닿는지는 확인하지 않았다(계정·비용 권한 필요). 필수 목적지 목록은 공개 문서 기준이며, 빠진 목적지는 실행 활동의 거부로 드러나고 운영자가 `BABOJUBOT_MODEL_DESTINATIONS`로 더한다.
- Antigravity CLI의 프록시 환경 지원은 확인하지 않았다.
- 허용한 사이트를 통한 데이터 반출은 막지 않는다. TLS 내용은 보지 않는다.
- 같은 조직·같은 연결의 제품 폴더·작업 폴더의 프로바이더 설정(hook 등)은 그 조직 에이전트가 함께 바꿀 수 있는 상태로 남는다([격리 실행](../providers.md#격리-실행)).
