# issue-149 레퍼런스 조사: 컨테이너 실행의 신뢰 경계

조사일: 2026-11-10. 대상: [#149](https://github.com/babo-jeonguk/BaboJUBot/issues/149). PATH·mount·네트워크의 원인과 수정 방향을 다루는 구현 전 권고다. 확정 정책·구현 결과는 이슈에서 관리하며, 자격 증명 원본 보호는 [#148](https://github.com/babo-jeonguk/BaboJUBot/issues/148)이 맡는다.

## 2026-11-11 사용자 확정

사용자는 조사 후 제안한 두 기본안에 동의했다. 네트워크는 필요한 도메인·포트만 허용하고 실제 연결 주소에서 호스트·내부망을 차단한다. 연구 패키지는 개인 환경을 명시적으로 사용하는 것을 기본으로 하며 공유 venv를 프로바이더 시작 환경에 자동 활성화하지 않는다. 아래 후보·열린 결정 표는 조사 당시 기록이며, 이 두 선택은 더 이상 사용자 답변 대기가 아니다. 공개 웹 허용은 이번 기본값으로 채택하지 않는다. 구현 계약은 [확정 Agent Brief](https://github.com/babo-jeonguk/BaboJUBot/issues/149#issuecomment-6784681615)가 맡는다. 게시된 본문 일치와 `bug`·`ready-for-agent`·`priority:high` 라벨을 재조회해 확인했다.

중계 배치·라이브러리는 정책 결정과 구분한다. network-none+Unix socket 중계와 internal/isolated 실행망+전용 중계를 무모델 fixture로 검증한 후, 같은 강제 조건을 만족하는 구성을 구현자가 선택한다. 호환성을 이유로 직접 통신을 열거나 host 실행으로 대신하지 않는다. 실제 Docker 검증과 프로바이더 transport 호환성은 아직 미확인이다.

## Brief

- 구현할 문제: 에이전트가 수정하는 데이터가 신뢰된 실행 파일·호스트 mount 권한으로 승격되고, 일부 연결 시험이 포괄적인 네트워크 격리 보장으로 해석되는 문제를 제거한다.
- 동종 문제: 신뢰하지 않는 프로그램을 실행하면서 실행 기반·파일 권한·통신 권한을 프로그램 밖에서 결정하고 강제하는 방법.
- 고정된 결정: 조직 간 공유는 사용자 지정 내용으로 제한한다. 초기 연구 승인·최종 완료·조직 경계는 제품 코드가 강제한다. 실제 프로바이더를 adapter로 구동한다(ADR-0001). 이번에는 조사와 수정안만 작성하고 제품 코드·테스트·설정은 변경하지 않는다. 실제 모델·계정 로그인은 사용하지 않는다.
- 재검토 대상: 공유 venv의 자동 PATH 편입(`docs/providers.md`), 전용 bridge와 제한된 API/DB probe의 보호 범위. 공유 패키지 지속성 자체와 신뢰된 프로바이더 시작 환경은 별개다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 공유 연구 파일이 프로바이더 시작 환경을 바꾸지 않게 하려면? | #149 PATH, 사용자 근본 원인 제거 요구 | Source Recon + 최소 재현 + adversarial scenario |
| Q2 | mount 권한을 어느 조직·역할에 묶고 경로 교체를 어떻게 막는가? | #149 mount | Source Recon + 경로/수명 경계 분석 |
| Q3 | 주요 OSS는 무엇을 격리하며 모델·패키지 통신은 어떻게 허용하는가? | 사용자 네트워크 선행 조사 요청 | 공식 문서 + 고정 SHA Source Recon |
| Q4 | 호스트·LAN 차단과 인터넷 사용을 함께 강제할 수 있는가? | #149 network | 엔진/프록시 Source Recon + 우회 시나리오 |
| Q5 | 무엇을 기본으로 권고하고 어떤 비용·선택을 사용자에게 설명해야 하는가? | 사용자 기반 지식 부족, 조사 후 결정 요청 | 패턴 비교 + 실패/운영 비용 분석 |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [#102](issue-102-references.md) | 실행 시도별 컨테이너·최소 mount·별도 조직 도구 listener·실패 시 host fallback 금지 | 현행 소스 재열람. 이전 Docker 실행을 이번 실행 결과로 인용하지 않는다 |
| [기존 격리 조사](executor-isolation-references.md) | 후보 탐색과 bridge/프록시 대안의 배경 | 외부 소스는 새 SHA로 확인. host 접근 차단을 DOCKER-USER만으로 설명한 이전 권고는 INPUT/FORWARD 구분 필요 |
| #148 인증 경계 조사 | 인증 중계와 통신 중계의 책임이 만나는 지점 | 인증·토큰 갱신 설계는 이번에 다시 결정하지 않는다 |

## 현행 재현과 원인

기준 HEAD: `8c47977d2140a4aeebc516259541a1b821f0dde1`. 현행 경계 재현은 자격 증명 없이 임시 폴더를 만들고 종료 때 삭제하는 로컬 probe로 실행했다. 실제 `entry.sh`와 `placeAttempt` → `dockerRunArgs`를 사용했다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| L01 | 공유 가상환경의 `bin/python`이 실행 가능하면 그 bin이 PATH 앞에 놓이고 최종 `exec`에도 적용된다. 가짜 `node`의 marker가 출력됐다 | [entry.sh](https://github.com/babo-jeonguk/BaboJUBot/blob/8c47977d2140a4aeebc516259541a1b821f0dde1/docker/runner/entry.sh#L1-L13), 현행 경계 재현 | 소스·실행 확인 |
| L02 | 다른 조직 fixture를 가리키는 symlink 경로가 writable bind source 인자로 그대로 만들어졌다. 현재 mount 타입에는 소유 조직·허용 용도·고정한 파일 정체성이 없다 | [containerLaunch](https://github.com/babo-jeonguk/BaboJUBot/blob/8c47977d2140a4aeebc516259541a1b821f0dde1/packages/runtime/src/providers/container.ts#L117-L161), 현행 경계 재현 | 소스·인자 생성 실행 확인. 실제 Docker mount는 미확인 |
| L03 | 네트워크는 bridge의 ICC를 끄고, 호스트 주소들에 대해 지정 API/DB 포트만 probe한다 | [network 생성](https://github.com/babo-jeonguk/BaboJUBot/blob/8c47977d2140a4aeebc516259541a1b821f0dde1/packages/runtime/src/providers/container.ts#L343-L423), [IsolationGate](https://github.com/babo-jeonguk/BaboJUBot/blob/8c47977d2140a4aeebc516259541a1b821f0dde1/apps/server/src/isolation.ts#L134-L161) | 소스 확인 |

### 원인에 따른 수정 경계

1. **연구 데이터와 실행 기반의 혼합.** 공유 venv는 조직 안 에이전트가 쓰는 코드다. 이것을 모든 프로바이더의 시작 환경으로 자동 활성화하는 것이 문제다. PATH 뒤로 이동해도 이미지에 없는 명령은 공유 파일에서 찾아 실행한다. 절대 실행 파일 하나만 고정해도 그 파일의 shebang·하위 명령·로더·환경 변수로 다시 넘어갈 수 있다. 이미지의 프로바이더·인터프리터와 고정 PATH로 시작하고, 공유/개인 연구 환경은 연구 명령이 명시해서 사용하도록 나눈다. 그 환경을 실행할 때 그 안의 코드를 신뢰한다는 점은 유지된다. 악성 연구 패키지를 안전한 패키지로 바꾼다는 보장은 아니다.
2. **문자열 경로와 mount 권한의 혼합.** 서버가 신원에서 허용 슬롯(조직 공유 RW·자기 개인 RW·동료 개인 RO·제품 상태·실행 전용 파일)을 만들고, 공통 launch 경계가 검증한 슬롯만 받게 한다. 모든 조직의 공통 부모 안이라는 검사로는 조직 B를 막지 못한다. 임의 cwd를 mount로 추가하는 fallback도 제거하거나 같은 권한 검증을 통과시킨다. 경로 해석과 실제 mount 사이 교체 가능성까지 검토한다.
3. **관측과 강제의 혼합.** 몇 포트에 연결하지 못했다는 시험은 통신 권한을 제한하지 않는다. 실행 시도 밖에서 목적지·프로토콜·포트 정책을 강제하고, probe는 그 강제가 작동하는지 확인하는 회귀·준비 검사로 둔다.

mount 재현은 잘못 배치된 호스트 경로를 받아들이는 증거다. 정상 mount에서 부모 디렉터리는 컨테이너에 보이지 않으므로, 에이전트가 mount 루트 자체를 rename/swap할 수 있다고 입증한 것은 아니다. 미리 심은 링크, 서버의 잘못된 배치, host 실행과의 혼용, 쓰기 가능한 조상이 있는 경우를 나눠 검증해야 한다. 호스트 관리자나 Docker daemon 자체의 악의를 방어한다는 목표도 아니다.

## 외부 근거와 패턴

아래는 고정 소스에서 확인한 설계 원리다. 같은 프로젝트의 모든 경로가 안전하다는 보증이나 이번에 그 프로젝트를 실행했다는 뜻은 아니다.

3개 서브에이전트가 에이전트 제품, 엔진/중계, 파일시스템/실행 기반을 나눠 조사했고 메인이 아래 결정 근거 원문을 다시 열었다. 후보와 세부 노트는 git 제외 조사 캐시에 남겼다. 에이전트 제품은 3라운드에서 설정 기본값·직접 연결·부모 중계 반례로, 엔진은 ICC→internal/INPUT→isolated/수명/CONNECT로, 파일시스템은 image/workspace→bind-fd→runc/import 경계로 확장했다. 마지막 라운드가 추가한 실패 모드까지 반영한 범위 한정 조사이며 모든 OSS 탐색이 포화됐다는 주장은 하지 않는다.

| 레퍼런스 | 고정 SHA | 라이선스 확인 | 깊이·선정 이유 |
|---|---|---|---|
| anthropics/sandbox-runtime | `f7a0f19fd3b4437bcf808f9c18c1f73e9f1a9889` | Apache-2.0 | 소스·테스트 읽기. netns/UDS와 실제 주소 검사 |
| openai/codex | `627b579219d492b5445d6d433d3110eb53e507dc` | Apache-2.0 | 소스·테스트 읽기. connect-time 주소 정책 |
| openclaw/openclaw | `afaaa8d287a3607e07c36bf73d096ced983155c3` | MIT | 소스·문서. 도구만 무망으로 두는 대조군 |
| moby/moby | `5dc4ce2d07072960878fe923caf7e9cd7f83113d` | Apache-2.0 | 소스·테스트 읽기. bridge의 실제 허용/차단 범위 |
| docker/docs | `75a95460ce3cc8db87a23893490ec331506d08fd` | root Apache-2.0 | 공식 문서. internal/isolated·방화벽 hook 구분 |
| squid-cache/squid 7.8 | `16716ff240b3d1fc07dd8cf019528d2c057a1683` | COPYING GPLv2, source GPLv2+ | 소스. 별도 중계 후보·CONNECT의 한계. 특정 구현 채택은 보류 |
| OpenHands/software-agent-sdk | `ca00c36ec32aefc2f64cca4d74f6d0210b8783d7` | MIT | 소스. 실행 기반과 workspace 분리 |
| containers/bubblewrap | `1fb0aa26d3eb66254f7742e704add7f82f41a582` | root LGPL 2.1 본문, 파일 LGPL-2.0-or-later | 소스·테스트 읽기. mount 후 identity 확인 |
| opencontainers/runc | `0274699189a91e0a735a2cc577e68c2378a6ac71` | Apache-2.0 | 소스. FD mount의 조건과 수명 |

추가 후보 Envoy·Cilium·gVisor는 예비 탐색에 그쳤다. 각각 forward proxy 구성, eBPF 운영 계층, syscall 격리의 대안이지만 이 조사에서는 우열 판단 근거로 사용하지 않는다. Claude Code·Python·Node·netfilter 공식 문서는 보조 자료다. 가장 작은 후속 실행 경로는 SRT/Codex의 proxy 단위 fixture, Docker의 일회용 network+HTTP fixture, OpenHands의 DockerWorkspace, bubblewrap의 bind-fd fixture다. Docker 권한과 namespace/build 환경 제약으로 외부 OSS 동작 실행은 하지 않았다.

| ID | 관찰 | 원문 | 수준 |
|---|---|---|---|
| E01 | SRT Linux 제한 경로는 network namespace를 분리하고 Unix socket으로 외부 HTTP/SOCKS 중계를 연결한다. 환경 변수는 그 경로를 이용하게 하는 편의 설정이다 | [linux-sandbox-utils.ts](https://github.com/anthropics/sandbox-runtime/blob/f7a0f19fd3b4437bcf808f9c18c1f73e9f1a9889/src/sandbox/linux-sandbox-utils.ts#L3696-L3778) | 소스 확인 |
| E02 | SRT는 직접 연결 시 DNS를 한 번 해석하고 거부 주소를 제외해 연결한다. RFC1918·ULA·CGNAT는 기본 차단에 없고 별도 설정이 필요하다. 상위 중계 경로의 주소 검사는 그 중계 책임이다 | [resolved-address-guard.ts](https://github.com/anthropics/sandbox-runtime/blob/f7a0f19fd3b4437bcf808f9c18c1f73e9f1a9889/src/sandbox/resolved-address-guard.ts#L1-L76) | 소스 확인 |
| E03 | Codex 직접 연결 connector는 실제 SocketAddr에 대해 정책·비공개 주소 검사를 하고 그 주소에 연결한다. 부모 프록시 경로 전체를 이 증거로 보장할 수 없다 | [connect_policy.rs](https://github.com/openai/codex/blob/627b579219d492b5445d6d433d3110eb53e507dc/codex-rs/network-proxy/src/connect_policy.rs#L194-L231) | 소스 확인 |
| E04 | OpenClaw의 Docker sandbox 기본 네트워크는 none이다. sandbox는 도구 실행 경계이며 호스트 Gateway의 모델 호출과 구분된다 | [docker-backend.md](https://github.com/openclaw/openclaw/blob/afaaa8d287a3607e07c36bf73d096ced983155c3/docs/gateway/sandboxing/docker-backend.md#L1-L16), [격리 범위](https://github.com/openclaw/openclaw/blob/afaaa8d287a3607e07c36bf73d096ced983155c3/docs/gateway/sandboxing/what-gets-sandboxed.md) | 공식 문서 주장 |
| E05 | Docker internal 네트워크는 기본적으로 bridge 주소가 있어 호스트의 bridge/all-address listener에 닿을 수 있다. isolated gateway 모드가 이 주소를 없앤다 | [port-publishing.md](https://github.com/docker/docs/blob/75a95460ce3cc8db87a23893490ec331506d08fd/content/manuals/engine/network/port-publishing.md#L186-L192) | 공식 문서 주장 |
| E06 | Moby ICC=false 분기는 같은 bridge로 향하지 않는 outgoing 트래픽을 허용한다. DOCKER-USER는 FORWARD에서 호출되므로 호스트 자신의 INPUT 처리를 대체하지 않는다 | [network.go](https://github.com/moby/moby/blob/5dc4ce2d07072960878fe923caf7e9cd7f83113d/daemon/libnetwork/drivers/bridge/internal/iptabler/network.go#L353-L375), [firewall-iptables.md](https://github.com/docker/docs/blob/75a95460ce3cc8db87a23893490ec331506d08fd/content/manuals/engine/network/firewall-iptables.md#L38-L39) | 소스 확인·공식 문서 주장 |
| E07 | OpenHands는 이미지 안 `/agent-server` 아래 interpreter와 venv를 설치하고 절대 경로 entrypoint로 시작한다. 연구 workspace와 실행 기반을 분리하는 참고 사례이며 해당 파일 소유권만으로 불변성이 증명되지는 않는다 | [Dockerfile 빌드](https://github.com/OpenHands/software-agent-sdk/blob/ca00c36ec32aefc2f64cca4d74f6d0210b8783d7/openhands-agent-server/openhands/agent_server/docker/Dockerfile#L181-L225), [entrypoint](https://github.com/OpenHands/software-agent-sdk/blob/ca00c36ec32aefc2f64cca4d74f6d0210b8783d7/openhands-agent-server/openhands/agent_server/docker/Dockerfile#L698-L732) | 소스 확인 |
| E08 | bubblewrap은 bind-fd에도 namespace 때문에 pathname 재해석 race가 남는다고 명시하고 mount 후 dev/inode가 기대 FD와 다르면 거부한다 | [bubblewrap.c](https://github.com/containers/bubblewrap/blob/1fb0aa26d3eb66254f7742e704add7f82f41a582/bubblewrap.c#L1283-L1307) | 소스 확인 |
| E09 | runc는 일부 source 경로에 O_PATH/open_tree FD를 사용하고 mount 완료까지 유지한다. 이 경로는 조건부이며 모든 Docker bind가 FD 고정된다고 해석하면 안 된다 | [mount_linux.go](https://github.com/opencontainers/runc/blob/0274699189a91e0a735a2cc577e68c2378a6ac71/libcontainer/mount_linux.go#L242-L342), [rootfs_linux.go](https://github.com/opencontainers/runc/blob/0274699189a91e0a735a2cc577e68c2378a6ac71/libcontainer/rootfs_linux.go#L113-L164) | 소스 확인 |
| E10 | Squid CONNECT는 연결 뒤 받은 byte를 양방향으로 전달한다. 목적지 host:port를 허용하는 것과 특정 HTTPS API 경로·전송 내용을 허용하는 것은 다르다 | [tunnel.cc](https://github.com/squid-cache/squid/blob/16716ff240b3d1fc07dd8cf019528d2c057a1683/src/tunnel.cc#L628-L647), [공식 HTTPS 설명](https://wiki.squid-cache.org/Features/HTTPS#connect-tunnel-through-squid) | 소스·문서 확인, 후반은 추론 |

| ID | 패턴 | 사례 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|
| P01 | 실행 기반과 연구 환경 분리 | L01·E07 | 연구 파일의 실행 권한 승격을 없앰 | 명시적 연구 환경 사용법, 로더·설정 경계까지 검토 필요 |
| P02 | 경로 문자열보다 권한·객체·수명으로 mount 검증 | L02·E08·E09 | 조직별 권한 및 경로 교체를 같은 경계에서 처리 | daemon과 검사 호스트가 다르거나 재해석하면 보장 깨짐 |
| P03 | 직접 통신 차단 + 외부 정책 중계 | E01·E04·E05·E06 | 프로그램이 프록시 설정을 무시해도 우회 불가 | 전체 프로바이더 통신·OpenCode 제어까지 연결할 필요 |
| P04 | 이름 허용과 실제 주소 허용을 함께 검사 | E02·E03 | DNS로 LAN/호스트를 가리키는 우회 방지 | 부모 프록시·IPv6·예외 정책·허용 사이트 반출은 별도 처리 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| D01 | 변형 채택 | 공유 venv 자동 활성화 제거, 신뢰된 이미지 runtime·PATH·시작 환경으로 프로바이더 시작 | P01 | 편의 기능이 실행 권한을 만들지 않게 함. 연구 패키지 명시 호출 필요 | Q1 |
| D02 | 변형 채택 | 조직·역할별 허용 mount 슬롯과 교체 불가능한 서버 소유 root 배치. 필요할 때 객체 고정 helper | P02 | broad prefix·일회성 realpath로는 부족. 저수준 runtime 교체를 먼저 요구하지 않음 | Q2 |
| D03 | 변형 채택 | 직접 egress 없는 실행 환경, 외부 중계에서만 통신 정책 강제 | P03 | bridge 플래그·probe 추가로 증상을 가리지 않음. transport 변경 비용 있음 | Q3·Q4 |
| D04 | 사용자 판단 | 목적지+포트 허용 목록을 기본 후보로, 공개 웹 허용을 명시 선택 후보로 제공 | P03·P04 | 무인 연구의 편의와 공용 목적지 반출 위험 사이 선택 | Q3·Q5 |
| D05 | 변형 채택 | 실제 dial 주소에서 host·LAN·metadata 등 차단, 조직/run별 중계 권한과 실패 시 차단 유지 | P04·조직 불변 조건 | 상위 중계와 예외 목적지도 동일 원칙 필요 | Q4·Q5 |
| D06 | 배제 | PATH 뒤로 이동, realpath/lstat 1회, ICC/internal 플래그만 추가, probe 포트만 확대 | L01–L03·E05·E06·E08 | 신뢰 승격·재해석·직접 경로를 남김 | Q1·Q2·Q4 |

## 수정안의 구조와 완료 기준

### 실행 환경

서버가 정한 이미지의 프로바이더·인터프리터를 신뢰된 PATH·환경으로 시작한다. 공유 venv의 자동 활성화를 없애고 연구 명령에서 명시적으로 호출한다. 환경 변수·shebang·자식 프로세스의 명령 탐색도 같은 기준으로 검토한다. 공유 설정·프로젝트 플러그인 자동 로딩을 포함해 어디까지 신뢰하는지 적어야 한다. 고정 PATH는 악성 프로젝트 설정이나 프로바이더 자체의 취약점까지 해결하지 않는다.

패키지 재사용은 먼저 **개인 연구 환경의 명시적 실행**으로 유지하는 안을 권고한다. 조직 공유 환경은 사용자가 지정한 공유 코드이며 실행하면 그 코드를 신뢰한다는 계약을 드러낸다. 불변 의존성 환경을 원하면 별도 빌드 단계에서 버전이 고정된 환경을 만들고 실행 때 RO로 넣는다. 이미 오염된 공유 환경을 그대로 복사하거나 RO로 바꾸는 것은 안전성 검증이 아니다. 개인 환경으로 기본을 옮기는 것은 현행 공유 패키지 사용법의 변경이므로 사용자 선택이 필요하다.

### mount

서버 소유의 resolver가 조직·에이전트·실행 시도 신원에서 허용 슬롯을 만든다. 슬롯에는 용도·정확한 허용 루트·접근 모드·source/target 관계를 담고, provider adapter는 임의 경로를 권한으로 승격하지 못한다. 실행·미리 압축 등 모든 컨테이너 시작이 이 경계를 지난다.

조직별 실제 루트를 대조하고 경로의 모든 조상·symlink·누락·종류·RO/RW 중첩을 확인한다. 사용자 데이터 루트 자체의 정상 symlink를 허용할지는 서버 설정을 canonical root로 고정하는 정책과 별도로 구분한다. 서버 소유 부모와 mount 루트가 에이전트에 의해 교체될 수 없도록 배치하는 것이 우선이다. 그 불변 조건을 보장할 수 없는 경로는 검증부터 Docker mount 완료까지 같은 객체를 유지하는 helper/고정 staging mount가 필요하며, 경로를 재해석하는 CLI에 FD 이름만 넘기는 것으로 해결됐다고 하지 않는다. 안전성을 보장할 수 없는 경우 시작을 거부한다. remote daemon에서 로컬 realpath 검증을 사용하지 않으며, 이번 지원 대상은 같은 호스트의 Linux Docker Engine으로 제한하는 안이다.

### 네트워크

**강제 구조 권고:** 실행 시도 컨테이너에는 직접 외부로 나가는 경로를 주지 않고, 실행 시도 밖의 중계가 조직별 목적지·포트 정책을 적용한다. `HTTP_PROXY` 환경 변수만 넣는 안은 배제한다. 프로그램이 변수를 무시하거나 `NO_PROXY`를 설정해도 직접 연결은 실패해야 한다.

구체적인 첫 검증 후보는 `--network none` + 실행 시도별 Unix socket 중계다. 컨테이너 안 loopback relay는 그 소켓으로만 HTTP CONNECT/SOCKS를 전달한다. 조직 도구도 일반 호스트 접근 권한을 여는 대신 정확한 도구 경로만 중계한다. OpenCode의 기존 host loopback publish는 이 배치에서 그대로 작동하지 않으므로 제어 연결도 전용 relay로 바꿔 검증해야 한다. 이는 SRT의 원리를 Docker에 적용하는 **설계 권고**이며 동작 확인 결과가 아니다. 대안은 실행 시도별 internal/isolated segment + 전용 중계이나, 같은 network의 peer·host gateway 우회와 Docker 버전 의존성을 더 검증해야 한다. 어느 쪽이든 실패하면 기존 bridge나 host 실행으로 자동 복귀하지 않는다.

중계는 허용 이름·포트뿐 아니라 **실제로 연결할 주소**를 검사하고 그 주소에 연결한다. IPv4·IPv6·IPv4-mapped IPv6, 호스트의 공인 주소, loopback·사설망·link-local·metadata·멀티캐스트·미지정 주소를 기본 거부한다. HTTP redirect 후 목적지와 CONNECT/SOCKS 대상도 검사한다. DNS는 중계에서 처리하고 runner의 임의 DNS/DoH·직접 UDP/QUIC는 기본 허용하지 않는다. 허용한 공용 사이트를 통한 데이터 반출은 도메인 제한만으로 막지 못한다. 중계 체인을 허용하면 마지막으로 연결하는 중계가 같은 주소 정책을 강제해야 한다.

| 허용 범위 후보 | 할 수 있는 일 | 비용·남는 위험 | 권고 |
|---|---|---|---|
| 필요한 목적지만 허용 | 확인된 모델·인증·패키지 endpoint 및 연구 계획에 명시한 사이트로 통신 | 새 사이트·CDN·인증 흐름 발견 시 목록 갱신 필요. 허용 사이트로 데이터 전송은 가능 | 기본 후보. 무인 실행 도중 사용자에게 계속 묻는 대신 필요한 목록을 사전에 검증 |
| 공개 웹 허용 | 호스트·LAN 등을 제외한 공용 HTTP(S) 사이트 조사 | 연구 자유도는 높지만 임의 공용 사이트로 데이터 반출 가능. 허용 포트·프로토콜 정의 필요 | 광범위한 웹 조사가 필요한 조직의 명시적 선택 후보 |
| 통신 없음 | 모델까지 바깥에서 중계하거나 오프라인 작업만 수행 | 현재 프로바이더 전체 컨테이너 배치에서는 그대로 쓸 수 없음 | 단독 해결책으로 배제 |

네트워크 정책은 사용자만 정하고, 에이전트나 공유 파일은 넓힐 수 없게 한다. 초기 연구 환경 승인에 조직별 선택을 포함할 수 있지만 **이번 조사로 기존 승인 정책 항목을 자동 추가하거나 정책을 확정하지 않는다**. 내부 모델 서버·데이터 저장소가 필요한 경우 전체 LAN이 아니라 명시한 endpoint·포트만 예외로 주고 사용자 API/DB·다른 조직의 서비스는 보호한다. 프록시가 고장 나거나 정책을 읽지 못하면 차단 상태를 유지한다. 정책 축소 시 기존 연결을 언제 끊을지도 정의한다.

### 구현 작업을 나눌 기준

PATH·mount·네트워크는 별도 변경으로 구현할 수 있지만, 모두 같은 실행 경계의 계약을 공유해야 한다. Docker argv 곳곳에 blacklist를 추가하는 방식으로 나누지 않는다. #148과는 중계의 조직/run 신원·수명·취소 인터페이스를 맞추되 인증 원본 노출 해결을 #149 완료로 주장하지 않는다.

| ID | 입력 → 행동 → 기대 결과 |
|---|---|
| V01 | 공유 환경에 `node`·`python`·프로바이더 이름·자식 명령 삽입 → 새 실행 시도·미리 압축 → 신뢰된 시작 경로 유지. 개인 연구 환경 명시 실행은 정상 동작 |
| V02 | 조직 B·홈·socket을 가리키는 source/조상 symlink, 누락, 파일/폴더 타입 불일치, 임의 cwd fallback → 시작 전 거부. 로그에 호스트 전체 경로·비밀 값 노출 없음 |
| V03 | 쓰기 가능한 조상의 rename/symlink swap → 검증된 객체만 mount하거나 실행 거부. 정상 공유 RW·자기 RW·동료 RO 및 실행 전용 파일 overlay는 유지 |
| V04 | 프록시 변수 제거·NO_PROXY·직접 IP·임의 DNS/DoH·UDP·IPv6·host alias → 허용 밖 연결 실패. 조직 도구 양성 대조·허용 웹/모델 fixture 연결은 성공 |
| V05 | 허용 hostname이 host/LAN으로 해석됨, DNS 응답 변경, redirect, CONNECT/SOCKS의 우회, 상위 프록시 → 실제 dial 목적지 정책으로 차단 |
| V06 | 다른 실행 시도의 중계 자격·조직 도구 토큰·정책 변경 요청 → 거부. 종료/취소된 실행의 중계 권한 회수, 조직 간 정책 혼합 없음 |
| V07 | 중계 중단·정책 읽기 실패·서버/Docker 재시작·안전 확인 실패 → 직접 통신/host fallback 없이 차단. 정책 축소의 기존 연결 처리도 확인 |
| V08 | Linux Docker Engine에서 무모델 HTTP/TCP fixture로 네 프로바이더 transport·OpenCode 제어·취소·세션·미리 압축 검증. 실제 인증/모델 통신은 별도 권한·계정 확인 후 실시 |

| 열린 결정 | owner | 선택지·후속 확인 |
|---|---|---|
| 네트워크 기본 범위 | 사용자 | 목적지 허용 목록 기본 권고 / 공개 웹 허용. 편의와 데이터 반출 위험 차이를 이해한 뒤 선택 |
| 연구 패키지 기본 재사용 | 사용자 | 개인 환경 명시 사용 권고 / 공유 환경 명시 사용 유지 / 별도 빌드한 불변 환경. 자동 PATH 활성화는 모두 제거 |
| 중계 배치와 호환성 | #149 구현 전 실험 | network-none+Unix socket 우선 후보. OpenCode 제어와 각 CLI의 프록시·인증 흐름이 통과해야 채택 |
| credential 중계와 인터페이스 | #148·#149 | 공통 조직/run 귀속·수명 계약. 인증서 주입·TLS 가로채기는 이번에 필수로 정하지 않음 |

## 한계와 미확인

| 단계 | 상태 | 근거 |
|---|---|---|
| Brief | 완료 | 질문 5개, 기존 격리 조사·#102·#148의 책임 구분 |
| Discovery | 부분 | 3관점 조사, 심층 OSS 8개와 공식 문서. 범위 한정 탐색이며 전체 후보 포화는 주장하지 않음 |
| Recon | 부분 | 고정 SHA·라이선스·소스/테스트 읽기 및 메인 원문 재확인. 외부 OSS 동작 실행·일부 변경 이력 추적 미완료 |
| Synthesis | 완료 | 패턴 4개·권고 6개·검증 경계 8개, 사용자 선택과 구현 전 실험 구분 |
| Receipt | 완료 | [#149 조사 댓글](https://github.com/babo-jeonguk/BaboJUBot/issues/149#issuecomment-6775686883) 게시 후 본문 일치 확인. bug·needs-triage·priority:high 유지 |

- `docker info --format '{{.ServerVersion}}'`: `/var/run/docker.sock` permission denied. 실제 컨테이너, LAN·IPv6 통신, mount 교체 경합은 이번에 실행하지 못했다.
- 실제 모델 호출·로그인·구독 OAuth·패키지 다운로드 통합 검사는 하지 않는다. 연구 기록·자격 증명을 열거나 출력하지 않았다.
- 일반 FD 수명 fixture는 rename 뒤 원래 객체를 유지하지만 그 객체 내용의 변경은 그대로 보임을 실행 확인했다. 이는 객체 고정과 내용 불변성이 별개라는 보조 근거이며 Docker mount 실행 확인이 아니다.
- 정책 누락의 의미도 검증해야 한다. SRT SDK는 `allowedDomains` 생략과 빈 배열의 동작이 다르고 Codex proxy는 기본 비활성이다. 제품 설정에서 명시적으로 필요한 경계를 생성해야 하며 라이브러리 이름이나 README의 default-deny 표현만 믿지 않는다.
- 외부 코드 복사·의존성 추가 없이 설계만 참고한다. 복사할 경우 해당 SHA의 LICENSE·파일 header·NOTICE를 확인하고 프로젝트 고지 규칙을 따른다.
