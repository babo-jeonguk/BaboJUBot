# issue-102 레퍼런스 조사: 격리 실행(Docker)

조사일: 2026-11-05. 대상: [#102](https://github.com/babo-jeonguk/BaboJUBot/issues/102), 부모 [#91](https://github.com/babo-jeonguk/BaboJUBot/issues/91), 선행 #97·#98. 구현 전 권고이며 확정 계약이나 구현 결과가 아니다. 제품 코드·테스트·설정은 변경하지 않았고 이 문서는 구현 변경과 함께 커밋하도록 둔다.

## Brief

- 구현할 문제: 선택형 Docker 실행에서 파일 쓰기 범위와 사용자 API·DB 접근을 실제 실행 환경으로 제한하면서 네 프로바이더의 도구·세션·취소를 유지한다.
- 동종 문제: 제어 평면의 권한을 넘기지 않고 외부 프로그램을 짧게 실행하고, 지속 파일과 임시 프로세스를 분리하는 경계.
- 고정된 결정: 기본 꺼짐, 실행 시도당 컨테이너, 호스트 uid/gid·capability 제거·host network 금지. 조직 폴더 RW·동료 개인 폴더 RO·자기 개인 폴더 RW·해당 프로바이더 제품 설정만 mount. 사용자 API·DB는 loopback, 조직 도구는 전용 listener. 시험 컨테이너로 차단 확인, 공통 이미지 하나와 조직 폴더 venv, GitHub 로그인 없음. 취소 마지막에 컨테이너 제거. 초기 연구 승인·최종 완료·조직 경계는 코드가 강제한다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | mount·제품 설정·이미지와 패키지 지속성을 어떻게 나누는가? | #102 AC2·5, #91 작업 공간 | Source Recon + adversarial + persistence |
| Q2 | 사용자 API·DB는 막고 도구 listener만 연결하는가? | #102 AC3, architecture 제품 불변 조건 | Source Recon + 네트워크 음성 대조 |
| Q3 | 취소·부분 생성 실패·서버 재시작 때 컨테이너를 어떻게 거두는가? | #102 AC1·6, #98 취소 순서 | Source Recon + runtime/failure |
| Q4 | 무모델 준비 확인으로 무엇을 검증하며 어떤 실패를 막는가? | #102 AC4·7, #91 준비 확인 | Behavioral Recon + 양성·음성 대조 |
| Q5 | 즉시 적용 switch와 준비 상태는 어떻게 보이는가? | #102 화면 조건 | 공식 문서 + Surface Capture |
| Q6 | 현재 transport·MCP·정비 경로에 Docker를 어디서 연결하는가? | #102 AC2, #91 네 프로바이더 공통 연결 | 현행 Source Recon + 프로토콜 경계 대조 |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [프로바이더 격리](executor-isolation-references.md) | mount·bridge·실행 시도 단위의 출발점 | 옛 실행 결과를 이번 실행으로 대체. OpenHands는 새 SHA 재열람. **조직별 이미지 권고는 #102 공통 이미지 결정으로 대체** |
| [#57 사용자 API 신뢰 경계](issue-57-references.md#사용자-api-신뢰경계-추가-조사) | local trusted 배경 | 사용자 API 로그인을 새로 요구하지 않는다. 외부 소스 근거는 재사용하지 않음 |
| [#97](issue-97-references.md) | 조직 cwd·폴더·도구 공통 판정 | 현행 workspace·MCP·run-request 소스 재열람. 경로 검사가 OS 격리를 대체하지 않음 |
| [#98–101](issue-98-101-references.md)·[구현 기록](issue-98-101-implementation.md) | 취소·제품 홈·세션·정비 | 현행 process·opencode·claude 소스 재열람. #98 최신 댓글의 판 제한 제거·세 OS 지원을 우선 |
| [화면 가이드](design-guidelines-pan2.md) | 설명 없는 switch·배지 정책 | 새 SEED SHA의 switch 핵심 파일 blob 비교와 공개 예제 확인. 기존 정책 전체를 재정의하지 않음 |

## 레퍼런스

Discovery는 실행 생애·파일, 네트워크·실패 환경, 화면의 세 관점으로 나눴다. 관점별 후보 5/7/5행(중복 포함 총17행), 마지막 라운드는 각각 3/4/2회차이며 최소 mount/ID 정리, 주소 치환/프록시, 즉시 적용/disabled 패턴의 변형으로 수렴했다. 이번 질문 범위의 탐색 종료 판단이며 모든 프로젝트를 조사했다는 뜻은 아니다.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| OpenHands software-agent-sdk | 실행 조직 OSS | `28f4dfeeec4473060873185d301495d1c3743947` | MIT | 소스 | uid·권한·mount·환경·owner별 재시작 정리 |
| OpenClaw | sandbox OSS | `43ff4de2a5d178273f17d52e58589b4cf9e89578` | MIT | 소스 | 생성 도중 실패와 제거 실패를 따로 남김 |
| Moby·VPNKit | 네트워크 구현 | `b3b7197adfc8f056dd50b74317ed3c26d1abb82f` / `42340d105737658de198210f3fac377ff56c7256` | Apache-2.0 | 소스 | host-gateway의 실제 의미와 localhost 프록시 반례 |
| Docker Engine·공식 문서 | 엔진·명세 | Engine 29.3.1, 문서 확인 2026-11-05 | Apache-2.0(엔진) | 실행·문서 | mock 경계 시험, submount·signal·Desktop 제약 |
| SEED Design | UI OSS | `22a426f4c1de3db4bfdd2318e226f95a52170422` | Apache-2.0 | 소스·화면 | 즉시 적용 switch와 공개 예제의 켜기·끄기 |

## 근거

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | `_build_container`가 제품 persistence/workspace mount·선택 env와 uid/gid·cap-drop·no-new-privileges를 조립한다. 대화 단위이며 `host-gateway`·loopback publish도 사용한다. owner label로 stale 컨테이너를 찾는다 | [registry.py 생성](https://github.com/OpenHands/software-agent-sdk/blob/28f4dfeeec4473060873185d301495d1c3743947/openhands-agent-server/openhands/agent_server/docker_runtime/registry.py#L607-L730), [정리](https://github.com/OpenHands/software-agent-sdk/blob/28f4dfeeec4473060873185d301495d1c3743947/openhands-agent-server/openhands/agent_server/docker_runtime/registry.py#L295-L317) | 소스 확인 |
| <a id="E02"></a>E02 | `throwAfterPartialSandboxCleanup`는 rm 성공 또는 이미 없음일 때만 registry entry를 지우며, 제거 실패는 생성 실패와 함께 AggregateError로 보존한다 | [docker-partial-cleanup.ts](https://github.com/openclaw/openclaw/blob/43ff4de2a5d178273f17d52e58589b4cf9e89578/src/agents/sandbox/docker-partial-cleanup.ts#L1-L44) | 소스 확인 |
| <a id="E03"></a>E03 | `host-gateway`는 daemon의 HostGatewayIPs를 extra-host에 대입하는 주소 치환이다. 접근 제어 정책이 아니다 | [Moby buildSandboxOptions](https://github.com/moby/moby/blob/b3b7197adfc8f056dd50b74317ed3c26d1abb82f/daemon/container_operations.go#L76-L92) | 소스 확인 |
| <a id="E04"></a>E04 | VPNKit은 host_ip로 온 패킷을 Localhost 경로로 넘기며 TCP 목적지를 host localhost로 바꾼다. Desktop 계열을 Linux bridge 실측으로 일반화할 수 없다 | [VPNKit Localhost](https://github.com/moby/vpnkit/blob/42340d105737658de198210f3fac377ff56c7256/src/hostnet/slirp.ml#L498-L558), [host_ip 분기](https://github.com/moby/vpnkit/blob/42340d105737658de198210f3fac377ff56c7256/src/hostnet/slirp.ml#L1318-L1333) | 소스 확인 |
| <a id="E05"></a>E05 | bind는 daemon 호스트 경로이며 원본을 수정한다. RO 하위 mount 강제는 kernel 5.12 이상 제약이 있다. `--mount`는 없는 source를 오류로 취급한다 | [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/) | 문서 주장 |
| <a id="E06"></a>E06 | `--init`은 신호 전달·자식 회수, `--rm`은 컨테이너 종료 후 제거다. PID1 신호 처리에는 별도 규칙이 있다 | [docker run](https://docs.docker.com/reference/cli/docker/container/run/) | 문서 주장 |
| <a id="E07"></a>E07 | Docker29.3.1/Ubuntu에서 uid1000·cap-drop ALL·no-new-privileges로 공유/자기/제품 폴더 쓰기 성공, 동료 EROFS·/etc EACCES. docker.sock은 없고 새 컨테이너가 공유 파일을 읽었다 | 로컬 probe; image `sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205` | 실행 확인 |
| <a id="E08"></a>E08 | 같은 fixture에서 bridge→mock loopback API/DB는 실패, bridge주소 도구는 성공, 도구의 사용자 경로는 404. host-network 양성 대조에서는 mock API/DB 연결 성공 | 같은 probe. 실제 API·DB 대신 임시 HTTP/TCP 포트를 사용 | 실행 확인 |
| <a id="E09"></a>E09 | Docker client SIGKILL 뒤에도 컨테이너 Running=true였다. 명시적 `docker rm -f` 뒤 inspect는 부재를 확인했다 | 같은 probe, `--memory=256m --pids-limit=64`, 시험 컨테이너 제거 완료 | 실행 확인 |
| <a id="E10"></a>E10 | 현재 MCP Host guard는 localhost/127.0.0.1/[::1]만 허용한다. tools router와 사용자 route는 같은 앱에 있다 | [mcp.ts](../../apps/server/src/mcp.ts), [app.ts](../../apps/server/src/app.ts) `orgToolsRouter`, 조사 기준 HEAD `a857772f88134e09e0d0478c5128fa1f04a8dcfc` | 소스 확인 |
| <a id="E11"></a>E11 | OpenCode `server`는 127.0.0.1 서버 URL을 받아 호스트 fetch로 제어한다. 단순 docker command 치환이면 다른 network namespace의 loopback을 가리킨다 | [opencode.ts](../../packages/runtime/src/providers/opencode.ts) `server` L76–180 | 소스 확인·마지막 문장은 추론 |
| <a id="E12"></a>E12 | ReadinessMonitor는 비동기 관찰이며 현재 admission이 결과를 보지 않는다. Claude precompact도 executeClaude를 호출해 별도 프로세스를 만든다 | [readiness.ts](../../apps/server/src/readiness.ts), [claude.ts](../../packages/runtime/src/providers/claude.ts) `precompact`, [process.ts](../../packages/runtime/src/providers/process.ts) `startProcess` | 소스 확인 |

| <a id="E13"></a>E13 | useSwitch는 checked/defaultChecked/onCheckedChange를 연결하고 hidden checkbox role=switch를 제공한다. 예제 callback은 count/lastValue를 즉시 갱신한다. 기존 SHA99efaf5와 useSwitch blob은 동일(7671392178518f82b78ce025a01918840a9d494c) | [useSwitch](https://github.com/daangn/seed-design/blob/22a426f4c1de3db4bfdd2318e226f95a52170422/packages/react-headless/switch/src/useSwitch.ts#L13-L26), [예제](https://github.com/daangn/seed-design/blob/22a426f4c1de3db4bfdd2318e226f95a52170422/docs/examples/react/switch/value-changes.tsx#L5-L20) | 소스 확인 |
| <a id="E14"></a>E14 | 공개 SEED 예제 라벨 클릭:1280px false→true/callback1,true, 390px true→false/callback2,false. 두 캡처를 메인도 열어 switch와 callback 표시 확인 | [공개 Switch](https://seed-design.io/react/components/switch), 로컬 실행 기록·캡처. Playwright1.64.1, 2026-11-05T08:16:15Z | 실행 확인 |

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 최소 mount와 제품 상태의 명시적 지속 | E01·E05·E07 | OpenHands 대화 단위, 우리는 run 단위 | 종료해도 결과·세션 유지 | 과도한 부모 mount, submount, 잘못된 source, 설정 공유 |
| <a id="P02"></a>P02 | 데이터 경계와 네트워크 경계를 따로 검사 | E03·E04·E08·E10 | Engine bridge와 Desktop 프록시가 다름 | 조용한 자기 승인 경로 발견 | 연결 실패만으로 서비스 차단과 서비스 부재를 구별 못 함 |
| <a id="P03"></a>P03 | container ID 소유권과 제거 확인 | E01·E02·E06·E09 | client 수명과 container 수명이 다름 | 취소·재시작 뒤 고아 회수 | 제거 실패를 성공으로 기록하면 슬롯·토큰 상태와 어긋남 |
| <a id="P04"></a>P04 | 프로토콜과 프로세스 실행 환경 분리 | E11·E12 | stdio와 HTTP server 제어의 차이 | 네 연결 공통 launch 경계 | 주소·파일·취소를 argv 치환만으로 해결 못 함 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 채택 | run별 컨테이너, host uid/gid·cap-drop ALL·no-new-privileges·host network 금지. Docker 비활성은 기존 host 실행 | P01·#102 AC | 모델별 자체 sandbox에 경계를 맡기지 않음 | Q1·Q3 |
| <a id="D02"></a>D02 | 변형 채택 | 공유 RW·동료 RO·자기 RW·해당 제품 설정만 허용 목록으로 mount. 서버 데이터 루트·개인 홈·다른 조직·Docker socket·GitHub 인증은 제외. 사전 canonical 경로/조직 표식 검증, 없는 source는 거부 | P01·#97·architecture | mount는 daemon 기준이므로 remote context를 무심코 허용하지 않음. RO submount도 검사 | Q1 |
| <a id="D03"></a>D03 | 채택 | 네 CLI·git·Python·Node 공통 이미지 하나, 조직 폴더의 venv/패키지로 지속. CLI 설치와 제품 로그인은 분리. 실행 경로·cwd를 안정적으로 유지 | E07·#102 AC5 | 조직별 이미지·개인 호스트 CLI mount 권고는 배제. 이미지·ABI 변경 시 venv 재생성 필요 | Q1 |
| <a id="D04"></a>D04 | 변형 채택 | 도구 router만 별도 앱/listener에 붙이고, 토큰·Role·단계·조직·같은 호출 키 판정 재사용. 지정 bridge주소에 bind, 사용자 앱·DB는 loopback 유지 | P02·E10 | `0.0.0.0`에 사용자 앱을 그대로 열면 안 됨. 전용 listener는 컨테이너용 경로이지 호스트도 접근 못 한다는 뜻은 아님 | Q2 |
| <a id="D05"></a>D05 | 변형 채택 | 실제 실행과 같은 daemon/network/주소로 무모델 probe. 컨테이너 자신의 127.0.0.1만 보지 말고 host alias·gateway·해석된 IPv4/IPv6를 검사하며 TCP 성공 뒤 401/404도 차단 실패다. 사용자 API·DB 차단과 도구 성공을 함께 검사. 이미지·Docker 오류/시간 초과도 안전 확인 실패로 취급 | P02·E08 | 호스트에서 fixture 서비스가 살아 있는 양성 확인이 필요. known unsafe에서는 모든 실제 연결 준비안됨, host fallback 없음 | Q4 |
| <a id="D06"></a>D06 | 변형 채택 | 준비 배지와 별도로 공통 launch 경계에 안전 확인 세대 guard. 설정/network/daemon 변경 시 이전 성공 무효화, 안전 확인 전 실제 컨테이너 시작 거부 | E12·#102·제품 불변 조건 | UI에 준비안됨만 보이면 현행 admission 경로로 실행 가능. 비동기 준비 확인을 run마다 기다리게 바꾸지 않고 미확인 구성 실행을 차단 | Q4·Q6 |
| <a id="D07"></a>D07 | 변형 채택 | 취소 프로토콜→2초→종료 신호→2초→강제 종료 순서 뒤 container remove·부재 확인. create/run 이전 고유 ID 또는 name·서버 instance/조직/run label 기록, 실패 시에도 정리. 재시작 때 자기 instance의 고아만 회수 | P03 | docker CLI PID 종료를 컨테이너 종료로 간주하지 않음. 제거 실패는 재시도 가능한 기록으로 남기며 슬롯 조기 해제 방지 | Q3 |
| <a id="D08"></a>D08 | 변형 채택 | process 실행·probe·precompact를 같은 host/container launch 경계에 태우고, stdio는 비TTY 양방향 유지. MCP 주소와 파일 경로를 함께 구성 | P04·E10 | MCP Host allowlist를 전용 listener의 정확한 host/port로 제한해 확장. localhost guard를 전역 제거하지 않음 | Q6 |
| <a id="D09"></a>D09 | 보류 | OpenCode 제어는 컨테이너 내부 relay 또는 loopback publish+인증 중 선택. 호스트 OpenCode를 몰래 남기는 우회 배제 | E11·E01 | relay는 구현 비용, publish는 컨테이너 내부 bind/호스트 포트/인증 검증 추가. 아래 R2 | Q6 |
| <a id="D10"></a>D10 | 채택 | 격리 switch 한 행 즉시 저장, 기존 readiness 배지·spinner 재사용. 설명 subtext·배너 없이 상태 값과 컨트롤로 표현 | #102 화면 계약, E13·E14 | 저장 실패 때 실제 값으로 복원하고 다른 탭 설정 갱신. 아래 R1의 실행 중 적용 정책은 별개 | Q5 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 조직 장기 컨테이너·exec 재사용 | 기존 격리 조사 대안 | run 수명과 다르고 에이전트마다 mount 권한 구분 어려움 |
| host network·사용자 앱 전체 재bind | E08의 양성 대조 | 사용자 API·DB 차단과 충돌 |
| host-gateway 이름만으로 안전 판정 | E03·E04 | 주소 치환 또는 localhost 프록시이며 보안 보장이 아님 |
| --rm 또는 docker CLI 강제 종료에만 의존 | E06·E09 | 실행 중 컨테이너·고아 정리 보장 없음 |
| Docker가 안 되면 host로 자동 대체 | #102·D05 | 사용자가 켠 격리 경계를 조용히 해제함 |

## 구현 참고

- `packages/contracts`·`core`·`db`: 전역 격리 설정의 기본 false·저장·세대/정책 표현. core에는 Docker SDK·프로세스를 넣지 않는다(ADR-0001).
- `packages/runtime/src/providers`: 공통 launch/정리 port의 Docker 구현, container ID 기록·주소·제품 홈·임시 파일·세션 경로, 정비와 준비 확인 포함. 자격 증명은 env 참조/제품 파일로, argv·공개 활동·로그에 값을 넣지 않는다.
- `apps/server/src/app.ts`·`mcp.ts`·`run-request.ts`·`readiness.ts`·`dispatcher.ts`·`compaction.ts`: 별도 listener의 수명/Host/토큰, 구성별 안전 확인, run/정비 admission과 종료 연계. 조직→에이전트→실행 시도 잠금과 토큰 취소 규칙 유지.
- `apps/web/src/global-settings.tsx`·`provider-choice.tsx`: switch와 기존 상태 컴포넌트 재사용. Docker 세부 옵션은 화면에 노출하지 않는다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 격리 false/true → 가짜 launch port → host/container 선택, 요청의 provider/model/세션·지침 유지 | D01·D08 |
| V02 | 조직 A run → 공유/자기/동료/조직 B/호스트/제품 설정 쓰기·읽기 → 허용 범위만 성공; 심볼릭 링크·submount·없는 source 음성 대조 | D02 |
| V03 | 동일 network에서 살아 있는 mock API/DB·도구 → TCP/HTTP 접근 → API/DB 거부·도구 성공, 도구 listener의 사용자 route 404·토큰 없음/다른 조직/취소 토큰 거부 | D04·D05 |
| V04 | 안전하지 않은 환경·Docker 없음·image 없음·timeout·오래된 probe 성공 → 준비 확인/실행 → 실제 연결 모두 막힘·가짜 유지·host fallback 없음 | D05·D06 |
| V05 | 정상·취소 무시·부분 생성·client 죽음·서버 재시작·rm 실패 → 정리 → 컨테이너 부재 확인 후 슬롯 해제; 타 instance 컨테이너 보존 | D07 |
| V06 | 네 CLI의 재생 프로그램·OpenCode HTTP 제어·precompact → 격리 경로 실행 → 양방향 입력/취소·MCP URL·임시 파일 접근·재개 유지 | D08·D09 |
| V07 | 첫 컨테이너 venv 설치 → 새 컨테이너 → 같은 조직 venv 사용, 다른 조직/개인 인증 유입 없음 | D02·D03 |
| V08 | switch 저장·실패·다른 탭·390px·키보드 → 상태/초점/준비 배지 → 서버 값 일치·실패 복원·설명문 없음 | D10 |

Docker 없는 CI에서는 V01과 launch/주소/정리 실패 대역 검사를 항상 돌리고 실제 Docker 경계 검사는 명시적 skip 사유를 출력한다. 실제 Docker가 있는 별도 검사는 선택 사항으로 숨기지 말고 결과를 구별한다(#102 AC7).

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| R1 켜기 직전부터 실행 중인 host run의 처리 | 사용자 | A 다음 run부터 적용(비용/세션 유지, 기존 run은 호스트 권한 지속), B 기존 run 취소 후 다음 run부터 격리(즉시 경계 전환, 작업 중단 비용). switch 저장 즉시 적용과 기존 run 소급 취소는 다른 결정 |
| R2 OpenCode HTTP 제어 경계 | #102 | 컨테이너 내부 relay로 stdio 제어 / container 서버를 인증+호스트 loopback publish. 두 경로 모두 재생 왕복·취소·다른 run 접근 거부 검증 필요 |
| R3 지원 Docker 환경·전용 listener 배치 | #102, 지원 OS 축소 시 사용자 | 이번 Linux Engine 배치부터 안전 확인 통과 환경 허용 / Desktop 전용 중계까지 지원. Desktop·rootless에서 docker0를 가정하지 않으며 실패 시 host fallback하지 않음 |
| R4 공통 이미지의 네 CLI 배포·도구 목록·resource 상한 | #102 | 설치 가능/이용 조건·아키텍처 확인 후 이미지 구성. 비공개 CLI를 OSS 시험으로 검증했다고 말하지 않음. 메모리·pids 값은 이번 256m/64 시험값과 별도 결정 |

## 한계와 미확인

- 이번 실행은 기존 공개 Node 이미지와 임시 HTTP fixture만 사용했다. 실제 제품 서버·Postgres, 네 프로바이더 컨테이너 실행·구독 로그인·모델 호출·MCP 왕복·세션 재개·압축·venv 설치·공통 이미지 빌드는 하지 않았다. 제품 검사를 대체하지 않는다.
- Linux Engine29.3.1에서 확인했다. Docker Desktop·rootless·remote daemon·Windows/macOS·WSL mirrored·IPv6·사용자 프록시 우회·GPU·커널 탈출·악의적 hardlink/submount 경합은 미실행이다. VPNKit 소스는 반례 가능성의 근거이며 최신 모든 Desktop 설치의 동작 증명이 아니다.
- 도구 listener는 컨테이너가 접근할 수 있게 여는 전용 경로다. 모든 호스트 서비스·LAN egress까지 차단한다는 보장은 없다. 다른 조직 컨테이너의 직접 통신·프록시를 통한 host loopback 우회도 구현 때 음성 검사해야 한다. 네트워크 분리와 run token 조직 검사를 함께 유지한다.
- 같은 프로바이더 제품 설정 mount에 세션/임시 파일·로그인이 함께 있으면 같은 uid의 실행 간 읽기 범위를 줄이지 못할 수 있다. 이번 AC는 해당 제품 설정을 허용한다. 이 사실을 조직 기억 공유 허가로 일반화하지 말고, 실제 파일 배치를 확인해 최소 mount와 run별 비밀 파일 노출 범위를 검토한다.
- 코드 복사·의존성 추가 없음, 설계 참고만 했다. 복사 채택 시 해당 SHA LICENSE·header·NOTICE·전이 의존성을 다시 확인하고 AGENTS 출처·고지 규칙을 적용한다.

문서 검사: `pnpm check`·`git diff --check` 결과는 receipt에 기록한다. 이번 문서 외 기존 작업 트리의 변경은 그대로 보존했다. 제품 통합·회귀·E2E와 upstream 전체 suite는 실행하지 않았다. 화면 실행은 공개 예제 클릭뿐이며 키보드·저장 실패·배지/spinner의 새 동작 검증은 하지 않았다.
