# 실제 프로바이더 연결

서버는 기본적으로 가짜 연결만 등록한다. 실제 연결은 `BABOJUBOT_PROVIDERS=claude,codex,opencode,antigravity pnpm dev`로 추가한다. 전역 설정에서 사용할 연결을 선택하고 저장한다. 프로그램 설치와 제품 로그인은 사용자가 한다. 실제 모델 호출은 구독 사용량이나 비용을 쓴다.

| 연결 | 코드를 맞춘 판 | 실행 방식 | 지침 | 끼워 넣기 |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.316 | 실행마다 duplex stream-json | 기본 지침에 append | 살아 있는 입력 큐에 전달 |
| Codex | 0.166.0 | app-server 기본, `BABOJUBOT_CODEX_MODE=exec` 선택 | developerInstructions | app-server 턴 ACK; exec 미지원 |
| OpenCode | 2.2.5 | 실행마다 `serve --stdio`로 HTTP 서버 시작 | 기본 지침 유지, session instructions API 추가 | `delivery: steer` 응답 |
| Antigravity | 1.4.12 | 실행마다 한 입력·한 결과 | 첫 입력 앞에 추가 | 미지원 |

현재 실제 CLI 프로세스 감독·재시작 정리는 Linux의 `/proc`를 지원 범위로 삼는다. 다른 OS 실행은 거부한다. 판을 제한하지 않는다. 설치된 프로그램을 그대로 쓰며, 표의 판은 프로토콜을 맞춘 기준일 뿐이다. 판이 바뀌어 프로토콜이 어긋나면 준비 확인이나 실행 시도가 실패로 드러난다. OpenCode 1.x는 서버 방식이 달라 동작하지 않는다. 현재 OpenCode 설정 분리 경로는 Linux를 지원하며 `/etc/opencode`가 있으면 상속하지 않고 준비 실패로 알린다. 로컬 로그인 존재는 원격 유효성 확인이 아니므로 `unknown`일 수 있다. OpenCode의 모델 미지정 실행은 조회한 목록에서 입력·출력 가격이 모두 0인 모델을 선택하며, 무료 모델이 없으면 실패한다. 특정 무료 모델의 지속 제공을 보장하지 않는다.

## 제품 로그인

`BABOJUBOT_HOME`은 절대 경로를 사용한다. 기본 데이터 폴더는 저장소의 `.babojubot`이다. 개인 설정·로그인 파일을 복사하지 않는다. 아래 명령은 로그인만 준비하며 이 문서를 구현하는 과정에서는 실행하지 않았다.

```bash
product_root="/absolute/path/to/.babojubot"
mkdir -p "$product_root/providers/claude/config" "$product_root/providers/codex" "$product_root/providers/opencode" "$product_root/providers/antigravity"
chmod 700 "$product_root/providers/claude" "$product_root/providers/codex" "$product_root/providers/opencode" "$product_root/providers/antigravity"
```

- Claude: `env -i PATH="$PATH" HOME="$product_root/providers/claude" CLAUDE_CONFIG_DIR="$product_root/providers/claude/config" claude setup-token`. 발급받은 토큰만 `$product_root/providers/claude/setup-token`에 저장하고 `chmod 600`을 적용한다. 토큰을 명령 인수·Git·이슈에 넣지 않는다.
- Codex: `env -i PATH="$PATH" HOME="$product_root/providers/codex" CODEX_HOME="$product_root/providers/codex" codex login`.
- OpenCode: `env -i PATH="$PATH" HOME="$product_root/providers/opencode" XDG_CONFIG_HOME="$product_root/providers/opencode/config" XDG_DATA_HOME="$product_root/providers/opencode/data" XDG_CACHE_HOME="$product_root/providers/opencode/cache" XDG_STATE_HOME="$product_root/providers/opencode/state" OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_DISABLE_CLAUDE_CODE=1 opencode auth login`. 무료 모델 제공자는 로그인 없이 제공할 수도 있다.
- Antigravity: `env -i PATH="$PATH" HOME="$product_root/providers/antigravity" XDG_CONFIG_HOME="$product_root/providers/antigravity/config" XDG_DATA_HOME="$product_root/providers/antigravity/data" XDG_CACHE_HOME="$product_root/providers/antigravity/cache" agy`에서 로그인한다. 이 판의 제품 로그인은 제품 HOME의 `.gemini/oauth_creds.json`에서 확인한다.

제품 HOME/XDG와 환경 변수 허용 목록은 개인 설정의 자동 유입을 막는 경계다. 호스트 파일·네트워크 접근을 격리하는 컨테이너는 후속 #102 범위다. 사용자 홈·자격 증명·연구 원본은 Git에 추가하지 않는다.

## 세션과 정리

실행 시도마다 별도 프로세스를 만들고 프로토콜 중단(없는 경우 SIGINT) → 2초 → 프로세스 그룹 TERM → 2초 → KILL 순서로 취소한다. 종료 뒤 남은 그룹도 정리한다. Linux에서는 PID·부팅 식별자·프로세스 시작 시각을 제품 폴더에 기록하고 서버 재시작 때 일치하는 잔여 프로세스를 정리한다.

MCP bearer는 Claude의 임시 0600 파일, Codex·OpenCode의 자식 환경, Antigravity의 작업 폴더 `.agents/mcp_config.json`으로 전달한다. 명령 인수에는 넣지 않는다. Antigravity는 같은 작업 폴더를 파일 생성부터 제거까지 직렬화한다. 제품 소유 표시가 있는 잔여 파일만 지우며 사용자 파일·심볼릭 링크는 거부한다. 정상 종료·실패·취소·서버 재시작 때 정리한다.

세션 부재가 확인될 때만 새 세션으로 전환한다. 인증 실패나 전송 실패를 세션 부재로 취급하지 않는다. 공개 활동은 일반적인 시작·재개 실패 안내만 담고 원시 모델 출력이나 내부 추론을 전달하지 않는다. 관찰 가능한 연구 결과는 조직 도구로 기록한다.

## Claude 미리 압축

전역 설정의 기존 저장 버튼으로 기준 토큰(기본 400,000, 50,000–1,000,000)과 TTL 비율(기본 90%, 50–95%)을 함께 저장한다. 제품 transcript에서 읽은 마지막 주 세션 입력 크기·시각과 캐시 생성 TTL(확인할 수 없으면 1시간)로 예약한다. 해당 metadata가 없으면 추측해서 예약하지 않는다.

일반 실행이 시작되면 그 세션의 예약은 취소된다. 압축과 일반 실행은 에이전트 단위로 배타다. 그 에이전트의 어느 세션이든 압축 중이면 다른 작업의 일반 실행도 기다리고, 다른 세션의 압축은 앞선 압축이 끝난 뒤 진행한다. 압축은 화면에서 취소할 수 없으므로 15분을 넘으면 중단한다(실측값이 아니라 여유 있게 잡은 값이다). 압축도 연결의 동시 실행 상한을 점유한다. 일시정지 중에는 허용하지만 중단·완료 조직에는 실행하지 않는다. 재시작 때 TTL 안의 지난 예약은 다시 확인하고, TTL이 지난 예약은 버린다. 이미 전송한 압축의 결과가 불명이면 자동 재전송하지 않는다.

압축은 저장한 모델·지침·작업 폴더로 같은 세션을 재개한다. MCP 목록은 동일하게 제공하되 별도 정비 토큰은 모든 도구 호출을 거부한다. 일반 Run·Event·활동을 만들지 않는다. compact boundary와 성공 결과, 동일 세션 ID가 모두 확인되어야 성공이다. 중단 신호 뒤라도 이미 성공이 확인된 압축의 결과는 저장한다. 실제 캐시 적중·비용 절약은 아직 검증하지 않았다.

## 수동 실제 시험과 재생 검증

실제 호출을 허용할 때만 다음을 직접 실행한다. 각 실행은 60초 후 취소하며, 격리된 임시 조직에서 `get_run_context` 한 번과 `send_message` 한 줄 OK 답장을 요청한다. Claude는 Haiku, OpenCode는 목록의 무료 모델을 쓰며, Codex·Antigravity는 사용자가 현재 계정에서 가장 저렴한 `BABOJUBOT_SMOKE_MODEL`을 지정해야 한다. 모델 자체가 요청을 어떻게 수행할지는 프로바이더 동작에 따른다. 이 스크립트는 CI에서 실행하지 않는다.

```bash
BABOJUBOT_HOME="$product_root" node scripts/provider-smoke.mjs claude --allow-live
# codex, opencode, antigravity도 같은 위치 인수로 선택
# BABOJUBOT_CODEX_MODE=exec 선택; Codex·Antigravity는 BABOJUBOT_SMOKE_MODEL=<가장 저렴한 모델 ID> 지정
```

이 시험은 단건 연결 확인이다. 세션 재개·끼워 넣기·취소·세션 실패·압축까지 돌리는 시험은 같은 조건으로 `node scripts/provider-live.mjs <연결> --allow-live`이고, `--record`를 붙이면 원본을 Git 밖에 남긴다. 현재 자동 검사는 `packages/runtime/test-fixtures`의 **합성** CLI/HTTP/SSE peer를 쓴다. 실제 녹화로 표현하지 않는다. 재생 형식과 정제 기준은 [fixture 안내](../packages/runtime/test-fixtures/README.md)를 따른다.
