# 프로바이더 격리 레퍼런스 조사: 에이전트를 허용 폴더 안에 가두고, 사용자 API와 개인 설정에서 떼어 놓는 방법

조사일: 2026-10-30. 대상: [판 2](../architecture.md#구현-순서)에서 실제 프로바이더(Claude Code·Codex·OpenCode·Antigravity)를 사용자 기기에서 사용자의 구독 로그인으로 돌릴 때 필요한 **실행 환경 격리**다. 구현 전 기술 권고이며 확정 계약이나 구현 결과가 아니다.

사용자가 정한 두 요구:

- **R1. 쓰기·사용자 API 차단.** 에이전트는 허용한 폴더 밖에 쓰지 못하고, 사용자 API에 닿지 못한다. 사용자 API는 로그인 없이 `127.0.0.1`에서만 열린다(로컬 신뢰 운영, Paperclip `local_trusted`와 같음). 에이전트의 shell이 이 API를 부를 수 있으면 자기 승인 요청을 스스로 승인하거나 최종 완료를 누를 수 있어 제품 불변 조건이 깨진다. 에이전트는 조직 도구(실행 시도별 bearer 토큰)와 인터넷에는 닿아야 한다.
- **R2. 개인 설정 차단.** 사용자의 개인 프로바이더 설정(전역 지침 `~/.claude/CLAUDE.md`·`~/.codex/AGENTS.md`, 개인 기억, 설정, MCP 서버, plugin)이 에이전트 실행에 들어가지 않는다. 에이전트는 조직이 준 지침만 받는다. 구독 로그인은 계속 동작해야 한다.

이 문서가 따르는 이미 정한 결정:

- 폴더 배치: 조직마다 **조직 공유 폴더** 하나(바깥에 내보낼 산출물·보고)와 에이전트마다 **개인 폴더**를 둔다. 같은 조직의 에이전트는 서로의 개인 폴더를 읽을 수 있고, 쓰기는 자기 것만 한다.
- 프로바이더 네 개 모두 공통 설계 범위다. Antigravity도 포함하며, 사용자는 소비자 요금제 약관 위험을 받아들였다.

후보 세 가지를 놓고 비교한다. (a) 실행 시도나 조직마다 Docker 컨테이너를 띄우고 작업 폴더와 로그인 파일만 mount, (b) bubblewrap으로 파일 쓰기를 막고 사용자 API에 에이전트가 읽지 못하는 로그인을 더함, (c) 전용 OS 사용자와 사용자 API 로그인.

기존 조사와의 경계:

| 재사용한 조사 | 이미 답한 것 | 이 문서가 더하는 것 |
|---|---|---|
| [executor-capabilities.md](executor-capabilities.md) | 프로바이더별 sandbox 모드, `--setting-sources`, `CODEX_HOME`, `XDG_CONFIG_HOME`, Antigravity `inherit_user`, 인증 파일 위치, 동시 사용 경고 | 같은 flag를 **격리된 환경 안**에서 어떻게 쓰는지, 로그인 파일을 어떻게 넣는지, 레퍼런스가 실제로 무엇을 하는지 |
| [executor-selection-references.md](executor-selection-references.md) 5절·6절·권고 9 | "외부 프로바이더를 OS sandbox로 감싸는 곳은 드물다", 인증은 CLI 로그인 재사용, Multica·OpenClaw의 `CODEX_HOME` 분리 | 컨테이너·OS sandbox 레퍼런스를 더해 R1·R2 방법을 정한다 |
| [issue-57-references.md](issue-57-references.md#사용자-api-신뢰경계-추가-조사) | "같은 OS 사용자로 shell을 가진 프로그램을 운영자와 구별하는 도구는 없었다. 실제 경계는 실행 환경 격리다" | 그 격리를 어떤 수단·단위·네트워크 배치로 만드는가. 이 기기에서 실측 |

용어는 [공통 용어](../../GLOSSARY.md)를 따른다. 레퍼런스가 executor·harness·adapter·runtime·agent CLI라고 부르는 외부 프로그램은 모두 **프로바이더**라고 쓴다.

근거 수준 표기: **[실행]** 이 기기에서 모델을 부르지 않고 확인, **[소스]** 고정 SHA 코드를 읽음, **[문서]** 공식 문서·저장소 문서, **[바이너리]** 닫힌 바이너리의 문자열(약한 근거), **[추론]** 위 근거에서 끌어낸 판단, **[미확인]** 확인하지 못함.

## 기준 버전과 조사 방식

[executor-selection-references.md](executor-selection-references.md#기준-버전과-조사-방식)의 clone(`/tmp/execsel/`)을 같은 SHA로 다시 읽었다. 새 대상은 `/tmp/execiso/`에 shallow clone했다(Codex는 sandbox·login 경로만 sparse checkout). 공식 문서는 2026-10-30에 열람했다. 경로·줄 번호는 표의 SHA 기준이다.

| 대상 | 저장소·문서 | SHA·버전 | 라이선스 | 읽은 깊이 |
|---|---|---|---|---|
| Docker Sandboxes(`sbx`) | [docs.docker.com/ai/sandboxes](https://docs.docker.com/ai/sandboxes/) | 문서 2026-10-30 | 상용 | 문서(보안 기본값·자격 증명·네트워크·설치) |
| Claude Code 공식 devcontainer | [anthropics/claude-code `.devcontainer/`](https://github.com/anthropics/claude-code/tree/b3f291d131924810e2b7713ededc144843a229d5/.devcontainer) + [devcontainer 문서](https://code.claude.com/docs/en/devcontainer) | `b3f291d131924810e2b7713ededc144843a229d5` | **© Anthropic, 상용 약관**. 복사 불가 | 소스 전부(`devcontainer.json`·`Dockerfile`·`init-firewall.sh`) + 문서 |
| Claude Code sandbox / sandbox-runtime(`srt`) | [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime/tree/98a4016d27609ed34dd1fb43d23ed6efb6eeeb77) + [sandboxing 문서](https://code.claude.com/docs/en/sandboxing) | `98a4016d27609ed34dd1fb43d23ed6efb6eeeb77` | Apache-2.0 | README·Linux 네트워크·loopback·자격 증명 가림 |
| Codex 자체 sandbox | [openai/codex](https://github.com/openai/codex/tree/360319d8dee62d87e2d59fc0c21805d79519cfed) + [learn.chatgpt.com/codex/sandboxing](https://learn.chatgpt.com/codex/sandboxing) | `360319d8dee62d87e2d59fc0c21805d79519cfed`(0.165.0) | Apache-2.0 | `login/src/auth/storage.rs`, sandbox 문서 |
| OpenHands | [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk/tree/4dcb21455e388d32de2547c6217772e7fa0e075e) (+ [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands/tree/5e8052347cc021b7657abc7f30828dead944a683) `5e8052347cc0`, 이 SHA에서는 화면과 launcher만) | `4dcb21455e388d32de2547c6217772e7fa0e075e` | MIT | Docker runtime·session key·ACP 프로바이더·env 정리 |
| Dagger container-use | [dagger/container-use](https://github.com/dagger/container-use/tree/2e43e625e95216b719ec9338f4034fd3a0be2734) | `2e43e625e95216b719ec9338f4034fd3a0be2734` | Apache-2.0 | 환경·git 흐름·secret |
| Paperclip | [paperclipai/paperclip](https://github.com/paperclipai/paperclip/tree/2badf8a4a5a7fb07329d99d355cf0f9875de3b80) | `2badf8a4…` | MIT | bwrap sandbox·`local_trusted` 인증·Claude/Codex 설정 디렉터리 |
| Multica | [multica-ai/multica](https://github.com/multica-ai/multica/tree/c066f7ea61eecdfc7c227b20a45330eacc7cf352) | `c066f7ea…` | Multica License | 보안 모델 문서·Codex sandbox 결정·`CODEX_HOME` |
| OpenClaw | [openclaw/openclaw](https://github.com/openclaw/openclaw/tree/43af01b15c96785d1e69bbd14eafa7a56938cf7f) | `43af01b1…` | MIT | sandbox 문서·Claude 제한 flag·Codex home |
| Hermes Agent | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent/tree/088f657ecf77674c7b8e2ededf4e3576d82e042c) | `088f657e…` | MIT | Docker 실행 환경·egress proxy·자격 증명 |
| coder/mux | [coder/mux](https://github.com/coder/mux/tree/23ef46d01ee9e3370177f134a615062bf6ad113e) | `23ef46d0…` | AGPL-3.0. 복사 불가 | Docker runtime·proxy 토큰 |
| Sculptor | [imbue-ai/sculptor](https://github.com/imbue-ai/sculptor/tree/ea2a9dffea1327c48504936ad67776fab40e49ce) | `ea2a9dff…` | MIT | 로컬 실행·Docker recipe·session token |
| Composio AO | [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator/tree/9b95d754f5d4fcbad31ff8d6422b37c8703c6206) | `9b95d754…` | Apache-2.0 | 계정 폴더·loopback 인증 |
| Vibe Kanban·Emdash·Nimbalyst·Crystal·Claude Squad | 기존 조사 표의 SHA | — | — | 설정·격리·자기 API 검색(대부분 "없음") |

OpenHands·container-use·Sculptor·mux·Hermes와 아홉 orchestrator의 세부 줄 번호는 저장소별 읽기 전용 탐색 보조 agent가 찾았고, 메인 조사자가 다시 연 것은 [검증 결과와 한계](#검증-결과와-한계)에 나눠 적었다.

## 한눈 비교

| 대상 | 1. 격리 단위 | 2. 네트워크·호스트 접근 | 3. 자기 API 보호 | 4. 개인 설정 차단 | 5. 로그인 |
|---|---|---|---|---|---|
| Docker Sandboxes | **microVM**(별도 kernel) 하나에 프로바이더 전체 | TCP 기본 차단 + 허용 규칙. 호스트 `127.0.0.1`은 닿지 않고, `host.docker.internal`은 규칙으로만 | 해당 없음(관리 API 없음) | 호스트 `~/.claude`·`~/.codex`를 읽지 않음 | 값은 VM에 들어가지 않고 호스트 proxy가 인증 header를 덮어씀. Claude 구독은 VM 안 `/login` |
| Claude devcontainer | 프로젝트마다 컨테이너. workspace bind + `~/.claude` named volume | 컨테이너 안 iptables 기본 거부 + 도메인 allowlist. **호스트 /24 대역은 허용** | 해당 없음 | 컨테이너의 `CLAUDE_CONFIG_DIR`가 볼륨이라 개인 설정 없음 | 컨테이너 안에서 다시 로그인, 볼륨에 저장 |
| Claude sandbox / `srt` | 명령마다 bubblewrap. Bash만(Claude Code 안) 또는 임의 프로세스(`srt`) | `--unshare-net` + 호스트 proxy(Unix socket). allowlist 빈 값 시작, loopback 해석 차단 | 해당 없음 | 범위 밖 | 자격 증명 env·파일을 가리고 proxy가 진짜 값으로 바꿔 보냄(`srt`) |
| Codex sandbox | 명령마다 bubblewrap + seccomp | 기본 네트워크 꺼짐 | 해당 없음 | 범위 밖 | `auth.json` 제자리 덮어쓰기 |
| OpenHands | 기본은 격리 없음. 선택 시 **대화마다** 강화 컨테이너 | 기본 bridge + `host-gateway`. egress 정책 없음 | 컨테이너마다 다른 session key, 바깥 key는 넣지 않음 | 호스트 실행은 개인 홈을 그대로 씀(격리 opt-in). 컨테이너는 빈 `HOME` | 컨테이너에는 token·`auth.json`을 secret으로 복사 |
| container-use | 환경마다 Dagger 컨테이너. **프로바이더는 호스트**, 도구 호출만 컨테이너 | Dagger 네트워크, 호스트 서비스 연결 설정 없음 | 해당 없음 | 프로바이더가 호스트라 막지 않음 | secret 참조를 실행 때 env로 |
| Paperclip | 기본 없음. 선택 시 실행마다 bwrap(`filesystemScope`·`networkScope`) | allowlist proxy가 host:port 단위. **자기 API는 신뢰 규칙** | `local_trusted`: bearer 없는 요청은 모두 관리자 | Claude 기본은 개인 `~/.claude`. Codex는 회사마다 `CODEX_HOME` | Codex `auth.json` symlink(재사용 금지 토큰), sandbox 뒤 되돌려 씀 |
| Multica | 없음. "경계는 daemon 바깥(전용 사용자·컨테이너·VM)" | 제한 없음 | 실행 범위 `MULTICA_TOKEN`. 같은 사용자 프로세스는 막지 못함을 문서화 | Codex만 실행마다 `CODEX_HOME` | `auth.json` symlink |
| OpenClaw | 자체 sandbox(Docker 등)는 **자기 도구만**. CLI·ACP 프로바이더는 호스트 | sandbox 기본 `network: none`, `host` 금지 | Gateway 토큰(loopback도). 같은 사용자는 "trusted operator" | Claude 제한 모드 flag 묶음, Codex 에이전트마다 `CODEX_HOME` | Codex 토큰을 메모리로 넘기고 갱신은 OpenClaw가 |
| Hermes | 자기 도구는 강화 Docker. Codex는 호스트 + Codex sandbox | TLS 가로채는 egress proxy(env 강제만) | dashboard 토큰이 `index.html`에 박힘 | 반대: 개인 `~/.codex/config.toml`에 씀 | Claude OAuth를 읽고 갱신 후 되돌려 씀, 프로세스 간 잠금 |
| mux | 자체 루프. 도구만 Docker(작업 공간마다) | Docker는 "Xum으로 가는 경로 없음" | bearer 토큰, 파일 `0600`(같은 사용자는 읽음) | 실험 옵션 꺼짐이면 `~/.claude` 안 읽음 | 자체 OAuth |
| Sculptor | 없음(호스트 프로세스). Docker recipe는 서버 전체를 컨테이너 하나에 | 제한 없음 | session token을 인증 없는 route가 내줌 | 없음. 개인 `~/.claude` bind | 호스트 로그인 상속, recipe는 `~/.claude` bind |
| AO | 없음(tmux·pty) | 없음 | loopback listener 인증 없음 | 계정 = 프로바이더 설정 폴더 | 폴더마다 따로 로그인 |
| Vibe Kanban·Emdash·Nimbalyst·Crystal·Claude Squad | 없음 | 없음 | Vibe Kanban: Origin 없는 loopback 요청 허용. 나머지는 IPC·nonce | 없음(Emdash는 env 허용 목록만, 설정 경로는 통과) | 호스트 로그인 상속 |

요약: **R1과 R2를 함께 기본으로 만족하는 것은 Docker Sandboxes 하나다.** 나머지 orchestrator는 대부분 프로바이더를 호스트에서 사용자와 같은 권한으로 돌리고, 격리를 "사용자가 바깥에 두라"고 넘긴다(Multica·OpenClaw는 문서로 명시). 프로바이더 **전체**를 컨테이너에 넣는 레퍼런스는 Docker Sandboxes, Claude devcontainer, OpenHands Docker runtime, Sculptor recipe다.

## 1. 격리 방식과 단위

- **[문서] Docker Sandboxes는 microVM이 신뢰 경계다.** "The primary trust boundary is the microVM", "Hypervisor isolation: separate kernel per sandbox"([security](https://docs.docker.com/ai/sandboxes/security)). workspace는 호스트와 같은 절대 경로로 passthrough되고, clone 모드는 저장소를 `/run/sandbox/source`에 읽기 전용으로 둔다([architecture](https://docs.docker.com/ai/sandboxes/architecture/)).
- **[소스] Claude devcontainer는 프로젝트마다 컨테이너 하나다.** workspace는 `/workspace`로 bind하고, `~/.claude`는 `claude-code-config-${devcontainerId}` named volume이며 `CLAUDE_CONFIG_DIR=/home/node/.claude`다([devcontainer.json](https://github.com/anthropics/claude-code/blob/b3f291d131924810e2b7713ededc144843a229d5/.devcontainer/devcontainer.json)). 문서: "Claude can still modify any file in the bind-mounted workspace … and reach anything the container's network policy allows."([devcontainer](https://code.claude.com/docs/en/devcontainer))
- **[소스] OpenHands Docker runtime은 대화마다 강화 컨테이너다.** `docker run -d --rm --user uid:gid --cap-drop ALL --security-opt no-new-privileges --ulimit core=0 --add-host host.docker.internal:host-gateway`([registry.py L511-526](https://github.com/OpenHands/software-agent-sdk/blob/4dcb21455e388d32de2547c6217772e7fa0e075e/openhands-agent-server/openhands/agent_server/docker_runtime/registry.py#L511-L526)), 기본 메모리 4g·CPU 2·pids 512. mount는 대화 디렉터리, `HOME`으로 쓰는 runtime별 persistence 디렉터리, `/workspace` 셋이다. 기본 모드는 격리가 없고 README가 "full access to your filesystem"이라 경고한다(보조 agent).
- **[소스] container-use는 환경마다 컨테이너지만 프로바이더는 호스트에 있다.** 프로바이더가 `container-use stdio` MCP 서버를 불러 도구 호출만 컨테이너에서 돈다. 결과는 git branch `container-use/<id>`로 돌아온다(보조 agent: `environment/environment.go` L261-296, `repository/git.go` L376-393). 프로바이더 자체의 쓰기·네트워크는 막지 않는다.
- **[소스] Paperclip은 실행마다 선택형 bwrap이다.** `--die-with-parent --new-session --unshare-pid --unshare-ipc --unshare-uts`([local-process-sandbox.ts L381](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/packages/adapter-utils/src/local-process-sandbox.ts#L381)). `filesystemScope: "workspace"`는 `--tmpfs /` 위에 시스템 경로를 읽기 전용, workspace와 관리 설정 디렉터리를 쓰기로 bind한다(L387-404). 문서는 "disabled by default"이고 ACP 모드는 이 감싸기 밖이라 거부한다([agent-runs.md L319-321](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/doc/spec/agent-runs.md#L319-L321)).
- **[문서] Multica·OpenClaw는 격리를 바깥에 맡긴다고 명시한다.**
  - Multica: "Multica does not sandbox the filesystem for you." 권장 배치는 가벼운 순서로 전용 Unix 사용자 → 컨테이너 → VM이다([security-model.mdx L22-30](https://github.com/multica-ai/multica/blob/c066f7ea61eecdfc7c227b20a45330eacc7cf352/apps/docs/content/docs/security-model.mdx#L22-L30)). Linux에서 Codex `workspace-write`를 쓰다 뺐다. 실행마다 `HOME`을 바꾸니 호스트 CLI(aws·gcloud 등)가 설정 없이 돌았고, 쓰기만 막아 자격 증명을 읽고 내보내는 것은 못 막았기 때문이다([codex_sandbox.go L68-78](https://github.com/multica-ai/multica/blob/c066f7ea61eecdfc7c227b20a45330eacc7cf352/server/internal/daemon/execenv/codex_sandbox.go#L68-L78)).
  - OpenClaw: "ACP sessions currently run on the host runtime, **not** inside the OpenClaw sandbox"([delivery.md L142-150](https://github.com/openclaw/openclaw/blob/43af01b15c96785d1e69bbd14eafa7a56938cf7f/docs/tools/acp-agents/delivery.md#L142-L150)). CLI 프로바이더도 "Claude Code owns cwd, PATH, environment, and sandboxing"이다(보조 agent: `docs/gateway/cli-backends.md` L456-458).
- **[소스] Hermes·mux는 자기 도구만 컨테이너에 넣는다.**
  - Hermes Docker 실행 환경: `--cap-drop ALL`(+DAC_OVERRIDE·CHOWN·FOWNER), `no-new-privileges`, tmpfs `/tmp`, pids 2048. 작업마다 컨테이너를 재사용하고, Codex는 호스트에서 `codex app-server`로 돌린다.
  - mux: 작업 공간마다 `docker run … sleep infinity` 후 `docker exec`. 코드는 git bundle로 복사한다(보조 agent).
- **[소스] 나머지(Sculptor·AO·Vibe Kanban·Emdash·Nimbalyst·Crystal·Claude Squad)는 프로바이더를 호스트 프로세스로 돌린다.** Sculptor는 `IS_SANDBOX=1 claude --dangerously-skip-permissions`라는 flag만 주고 실제 격리는 없다(보조 agent).
- **[문서] 프로바이더 자체 sandbox는 덮는 범위가 좁다.** Claude: "The sandbox covers shell commands only. Claude's file tools, MCP servers, and hooks run outside it."([sandboxing](https://code.claude.com/docs/en/sandboxing)) Codex는 shell, Antigravity는 terminal, OpenCode는 없음([executor-capabilities.md 9절](executor-capabilities.md#9-권한sandbox)). Codex·Claude 문서 모두 컨테이너 안에서는 자체 sandbox가 못 뜰 수 있으니 컨테이너를 경계로 삼고 `danger-full-access`를 쓰라고 한다([agent-approvals-security](https://learn.chatgpt.com/codex/agent-approvals-security)).

## 2. 네트워크: 인터넷, 호스트 loopback, 조직 도구 접근

- **[문서] Docker Sandboxes: 모두 막고 허용한다.** "All outbound TCP traffic … is blocked unless an explicit rule allows the destination", UDP·ICMP 차단([defaults](https://docs.docker.com/ai/sandboxes/security/defaults)). 호스트 서비스: "`127.0.0.1` … not reachable from inside the sandbox". `host.docker.internal`에 `sbx policy allow network localhost:11434` 같은 규칙을 더해야 닿는다([development](https://docs.docker.com/ai/sandboxes/workflows/development/)).
- **[소스] Claude devcontainer: 컨테이너 안 iptables, 호스트 대역은 열어 둔다.**
  - `NET_ADMIN`·`NET_RAW`를 더해 컨테이너 안에서 `init-firewall.sh`를 돌린다. GitHub meta 대역과 `registry.npmjs.org`·`api.anthropic.com`·`sentry.io`·`statsig.com`·VS Code 도메인을 ipset에 넣는다. 나머지 OUTPUT은 `REJECT`다([init-firewall.sh L66-119](https://github.com/anthropics/claude-code/blob/b3f291d131924810e2b7713ededc144843a229d5/.devcontainer/init-firewall.sh#L66-L119)).
  - 기본 경로에서 호스트 IP를 찾아 **그 /24 전체를 INPUT·OUTPUT 허용**한다(L92-104). 즉 호스트에 열린 서비스에는 닿게 둔다.
  - `node` 사용자에게 이 script만 sudo로 허용한다(Dockerfile L89). 문서는 이 방화벽이 "not required for Claude Code itself"라 한다.
- **[소스] Claude sandbox·`srt`(Linux): 네트워크를 통째로 끊고 proxy로만 낸다.**
  - "bwrap --unshare-net which creates a completely isolated network namespace with NO network access". 호스트 쪽 socat이 Unix socket을 HTTP·SOCKS proxy에 잇고, sandbox 안에 `HTTP_PROXY=http://localhost:3128`을 준다([linux-sandbox-utils.ts L1488-1512](https://github.com/anthropic-experimental/sandbox-runtime/blob/98a4016d27609ed34dd1fb43d23ed6efb6eeeb77/src/sandbox/linux-sandbox-utils.ts#L1488-L1512)).
  - Linux에서 `allowLocalBinding`은 무시된다. sandbox loopback은 호스트 것이 아니다([sandbox-config.ts L726-741](https://github.com/anthropic-experimental/sandbox-runtime/blob/98a4016d27609ed34dd1fb43d23ed6efb6eeeb77/src/sandbox/sandbox-config.ts#L726-L741)).
  - 허용 도메인이 loopback·link-local로 해석되면 proxy가 거부한다(`resolved-address-guard.ts`). 다만 `localhost` 항목을 허용하면 "exposes every port on your machine's localhost"([sandboxing](https://code.claude.com/docs/en/sandboxing)).
  - Unix socket 차단은 선택형 seccomp 필터다. 문서는 `/var/run/docker.sock` 허용이 "effectively grants access to the host system"이라 경고한다.
- **[소스] Paperclip: allowlist proxy가 자기 API를 신뢰 규칙으로 연다.**
  - `networkScope: "deny"`는 `--unshare-net`, `"allowlist"`는 `HTTP(S)_PROXY=http://127.0.0.1:<port>`에 정확한 hostname만 허용한다([L475-487](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/packages/adapter-utils/src/local-process-sandbox.ts#L475-L487)).
  - `PAPERCLIP_API_URL`은 host:port 신뢰 규칙(`parseTrustedNetworkUrl` L196-206)이라, 에이전트가 쓰는 route와 관리자 route를 가르지 못한다.
- **[소스] OpenHands: 기본 bridge + `host-gateway`.** 컨테이너 포트는 호스트 `127.0.0.1`에만 publish하고 그 외 주소면 오류다. egress 정책은 없다(보조 agent: `registry.py` L550).
- **[소스] Hermes: egress proxy를 docker bridge IP에 둔다.** 주석: "docker bridge on Linux (what `host.docker.internal` resolves to; loopback is unreachable from containers), loopback on Docker Desktop (VPNkit). NEVER 0.0.0.0"([iron_proxy.py L398-402](https://github.com/NousResearch/hermes-agent/blob/088f657ecf77674c7b8e2ededf4e3576d82e042c/agent/proxy_sources/iron_proxy.py#L398-L402)).
  - Linux는 `--add-host host.docker.internal:host-gateway`를 붙인다(`docker_egress.py` L111-112).
  - proxy 강제는 env뿐이라 bridge 컨테이너는 직접 나갈 수 있다(보조 agent).
  - 이 주석이 **Docker Desktop에서는 컨테이너가 호스트 loopback에 닿는다**는 실무 근거다.
- **[소스] OpenClaw sandbox 기본은 `network: "none"`이고 `host` 네트워크를 막는다.** 도구는 Gateway가 컨테이너에 exec로 넣으므로 sandbox가 Gateway에 연결할 필요가 없다(보조 agent: `src/agents/sandbox/config.ts` L102).
- **[소스] mux: Docker 실행 환경은 "no route to Xum"이고 기본 bridge다.** 호스트 실행 명령은 `127.0.0.1`의 proxy에 작업 공간별 HMAC 토큰(`xum-proxy-<b64(wsId)>-<HMAC>`)으로 연결한다. 실행 시도별 bearer 토큰과 같은 모양이다(보조 agent).
- **조직 도구 연결.** 레퍼런스는 두 갈래다.
  - 프로바이더가 호스트에서 돌며 HTTP 도구 서버에 토큰으로 닿는다: Paperclip `PAPERCLIP_API_KEY`, Multica `MULTICA_TOKEN`.
  - 도구를 stdio MCP로 붙인다: container-use, Hermes→Codex.
  - 프로바이더 전체를 컨테이너에 넣고 호스트의 도구 서버에 닿게 하는 예는 Docker Sandboxes(규칙으로 `host.docker.internal` 허용)와 OpenHands(`host-gateway`)뿐이다.

## 3. 오케스트레이터 자기 API 보호

| 대상 | 방식 | 같은 기기 프로세스가 우회할 수 있는가 |
|---|---|---|
| Paperclip | `local_trusted`면 모든 요청이 처음부터 `local-board` 관리자(`isInstanceAdmin: true`, `source: "local_implicit"`), bearer가 있을 때만 에이전트로 바뀐다([auth.ts L220-230](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/server/src/middleware/auth.ts#L220-L230)) | **예.** bearer를 빼고 부르면 관리자다. 이를 인정하는 문서는 찾지 못함 [소스] |
| Multica | 서버 API는 실행 범위 `MULTICA_TOKEN`: "a run cannot act as you … through the Multica API"(security-model L38). daemon health 서버는 loopback, `/shutdown` 인증 없음 | 서버 API는 아니오, daemon 로컬 route는 예. 문서가 "not an OS-user isolation boundary"라 인정 |
| OpenClaw | Gateway 토큰이 loopback에서도 기본 | 같은 사용자는 `~/.openclaw`를 고칠 수 있어 "trusted operator"로 본다 |
| OpenHands | 모든 route가 `X-Session-API-Key`. 컨테이너마다 다른 key를 주고 바깥 key는 넣지 않으며, 바깥 proxy가 안쪽 key를 붙인다 | 호스트 모드는 예: loopback이면 key를 인증 없는 `index.html`에 넣는다. 호스트 ACP 프로바이더 env는 정리 없이 `os.environ`을 받는다(보조 agent) |
| Sculptor·Hermes | 헤더 토큰 | 예. 인증 없는 route(Sculptor `GET /api/v1/session-token`)나 `index.html`(Hermes)이 토큰을 내준다 |
| mux | bearer, `~/.xum/server.lock`(0600) | 호스트 실행은 예(같은 사용자가 파일을 읽음). Docker는 경로가 없음 |
| AO·Vibe Kanban | loopback 인증 없음, Origin 없는 요청 허용 | 예 |
| Docker Sandboxes | 해당 API 없음. 자격 증명은 호스트 proxy가 header 주입 | 해당 없음 |

- **[추론] 자기 API를 토큰·로그인으로 지키는 레퍼런스 모두, 에이전트가 같은 OS 사용자로 같은 네트워크에 있으면 뚫린다.** 토큰이 파일·HTML·env 어딘가에 있기 때문이다. 막는 경우는 둘이다. 에이전트가 **네트워크상 그 API에 닿지 못하거나**(Docker·mux Docker·OpenClaw `none`), **토큰을 볼 수 없는 다른 경계 안에 있을 때**(OpenHands 컨테이너별 key)다. [issue-57 조사](issue-57-references.md#사용자-api-신뢰경계-추가-조사)의 결론과 같다.
- **[소스] BaboJUBot 현재 코드: 조직 도구와 사용자 API가 같은 Express 앱·같은 포트에 있다.** `app.use(orgToolsBasePath, orgToolsRouter(…))`(`apps/server/src/app.ts` L246-249, `orgToolsBasePath = "/api/tools"`)와 사용자 route가 `127.0.0.1` 한 listener에 붙는다(`app.ts` L172, `main.ts` L54). 컨테이너에 조직 도구만 열려면 **조직 도구 전용 listener를 따로** 둬야 한다.
- **[소스] 같은 문제는 DB에도 있다.** embedded Postgres가 loopback `postgres/postgres`다([issue-57 조사](issue-57-references.md#사용자-api-신뢰경계-추가-조사)). 사용자 API에 로그인을 붙여도, 에이전트가 loopback에 닿으면 DB를 직접 고칠 수 있다. 후보 (b)·(c)의 "사용자 API 로그인"만으로는 R1이 닫히지 않는다.

## 4. 개인 설정 차단

레퍼런스가 쓰는 방법은 세 층이다. 실제로 막는 것은 빈 HOME 하나뿐이다.

1. **개인 설정이 아예 없는 HOME**: Docker Sandboxes("Sandboxes don't pick up user-level configuration from your host, such as `~/.claude`", [claude-code](https://docs.docker.com/ai/sandboxes/agents/claude-code), [codex](https://docs.docker.com/ai/sandboxes/agents/codex)), Claude devcontainer(볼륨), OpenHands 컨테이너(runtime별 빈 `HOME`, env는 허용 목록만 `-e`).
2. **프로바이더 설정 디렉터리 변수만 바꿈**:
   - `CODEX_HOME`: Multica 실행마다, OpenClaw 에이전트마다, Paperclip 회사마다.
   - `CLAUDE_CONFIG_DIR`: AO 계정 폴더, Paperclip 관리 연결.
   - `OPENCODE_CONFIG`: AO.
   - OpenHands `acp_isolate_data_dir`(기본 꺼짐).
3. **flag로 끄기**: OpenClaw Claude 제한 모드가 가장 촘촘하다. `--setting-sources ""`, `--settings '{"disableAllHooks":true,"enabledPlugins":{},"autoMemoryEnabled":false,"claudeMdExcludes":["**/CLAUDE.md","**/CLAUDE.local.md","**/.claude/rules/**"]}'`, `--disable-slash-commands`, `--strict-mcp-config`, `--tools …`([cli-shared.ts L37-40, L409-421](https://github.com/openclaw/openclaw/blob/43af01b15c96785d1e69bbd14eafa7a56938cf7f/extensions/anthropic/cli-shared.ts#L409-L421)). 주석은 "Safe mode also suppresses explicit MCP, while bare mode drops OAuth"다. [executor-capabilities.md](executor-capabilities.md#4-지침-주입과-개인-전역-지침)가 미확인으로 둔 "`--safe-mode`가 `--mcp-config`도 끄는가"에 대한 OpenClaw 쪽 답이다(실행 확인은 아님).

반대 사례: Hermes는 자기 MCP·plugin을 사용자의 `~/.codex/config.toml`에 써 넣는다. Sculptor는 개인 `~/.claude`를 컨테이너에 bind한다. Paperclip의 원격 seed는 `settings.json`·`CLAUDE.md`를 복사해 개인 지침이 따라간다. Multica는 관리 MCP가 없으면 `--strict-mcp-config`를 빼 "inherit the user's local runtime MCP servers"한다(보조 agent).

프로바이더별로 정리하면 다음과 같다(flag 자체는 [executor-capabilities.md](executor-capabilities.md#4-지침-주입과-개인-전역-지침)).

| 프로바이더 | 개인 설정이 있는 곳 | 레퍼런스가 막는 방법 | 컨테이너 안에서 남는 것 |
|---|---|---|---|
| Claude Code | `~/.claude/`(CLAUDE.md·rules·skills·plugins·settings·auto memory), `~/.claude.json`(MCP·계정 상태), managed policy `/etc/claude-code` | 빈 HOME(Docker Sandboxes·devcontainer), `CLAUDE_CONFIG_DIR`(AO), 제한 flag(OpenClaw) | 이미지의 managed policy(제품이 정함. OpenHands는 `/etc/claude-code/managed-settings.json`을 이미지에 씀). cwd 위쪽 CLAUDE.md는 mount한 폴더에서만 |
| Codex | `$CODEX_HOME`(기본 `~/.codex`)의 `AGENTS.md`·`config.toml`·skills·plugins | `CODEX_HOME` 분리(Multica·OpenClaw·Paperclip). `--ignore-user-config`로는 `AGENTS.md`를 못 막음 | 제품이 쓴 `config.toml`만 |
| OpenCode | `$XDG_CONFIG_HOME/opencode/`, 없으면 `~/.claude/CLAUDE.md`까지 읽음, `$XDG_DATA_HOME/opencode/auth.json` | `OPENCODE_CONFIG`(AO), `OPENCODE_CONFIG_CONTENT`(Multica). `XDG_*` 분리 레퍼런스는 못 찾음 | 빈 HOME이면 끝. `OPENCODE_DISABLE_CLAUDE_CODE=1`은 보조 |
| Antigravity | `~/.gemini/`(AGENTS.md·GEMINI.md·config/rules·antigravity-cli/settings.json·skills·MCP), 인증 `~/.gemini/oauth_creds.json`·`google_accounts.json`(이 기기의 파일 이름) | 레퍼런스 없음 | 빈 HOME이면 전역 rules가 없다[추론]. 바이너리에 `ANTIGRAVITY_GEMINI_DIR` 문자열이 있다[바이너리]. 뜻과 동작은 [미확인] |

## 5. 격리 아래의 로그인

- **[소스] Codex `auth.json`은 갱신 토큰이 한 번만 쓰인다. 사본을 만들면 깨진다.**
  - Paperclip: "Codex refresh tokens rotate and are single-use, so a stale copy fails with `refresh_token_reused` on the next run (#5028)". 그래서 관리 `CODEX_HOME`의 `auth.json`을 원본으로 가는 symlink로 바꾼다([codex-home.ts L269-274](https://github.com/paperclipai/paperclip/blob/2badf8a4a5a7fb07329d99d355cf0f9875de3b80/packages/adapters/codex-local/src/server/codex-home.ts#L269-L274)).
  - sandbox 실행 뒤에는 안쪽 `auth.json`을 호스트 원본에 되돌려 쓴다.
  - Multica도 symlink를 쓰고 사본으로 갈라졌는지 기록한다.
- **[소스] Codex는 `auth.json`을 rename 없이 제자리에서 덮어쓴다.** `OpenOptions::new().truncate(true).write(true).create(true)` + mode 0600([storage.rs L227-243](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/login/src/auth/storage.rs#L227-L243)). [추론] 그래서 **파일 하나만 bind mount**해도 컨테이너 안 갱신이 호스트 원본에 그대로 쓰인다. symlink와 같은 효과다. 다만 OpenAI는 "Use one `auth.json` per runner or per serialized workflow stream", "Do not share the same file across concurrent jobs"라 한다([executor-capabilities.md 8절](executor-capabilities.md#8-인증-동시-실행-구독-자동화-약관)). 동시 실행 갱신 경쟁은 남는다.
- **[문서] Claude는 컨테이너에서 두 가지 길을 쓴다.**
  - 컨테이너 안에서 다시 로그인해 볼륨에 둔다(devcontainer, Docker Sandboxes `/login`).
  - `claude setup-token`이 만드는 1년짜리 `CLAUDE_CODE_OAUTH_TOKEN`을 env로 넣는다(devcontainer 문서의 Codespaces 권고, Sculptor recipe, OpenHands). 공식 문서: "a one-year OAuth token … for CI pipelines, scripts, or other environments where interactive browser login isn't available", "This token authenticates with your Claude subscription … It can only make model requests", "Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN`."([authentication](https://code.claude.com/docs/en/authentication))
  - [추론] env 토큰은 갱신 쓰기가 없어 동시 실행 경쟁이 없다.
- **[소스] 개인 로그인과 제품 로그인을 나누는 예가 있다.**
  - AO는 "an account is a config folder of the provider's own CLI"다. 폴더마다 `claude auth login`을 따로 하고, Claude에 `CLAUDE_CONFIG_DIR`·`CLAUDE_SECURESTORAGE_CONFIG_DIR`를 같은 경로로 준다. 주석: "Claude keys the folder's Keychain login on the exact path text"([claude.go L58-66](https://github.com/ComposioHQ/agent-orchestrator/blob/9b95d754f5d4fcbad31ff8d6422b37c8703c6206/backend/internal/adapters/agentaccount/claude.go#L58-L66)).
  - 기기 계정의 로그인은 바꾸지 않는다.
  - Nimbalyst는 macOS에서 설정 디렉터리를 옮기면 Keychain 항목 이름이 `Claude Code-credentials-<sha256(dir)[:8]>`로 바뀐다고 적는다(보조 agent).
- **[문서] 자격 증명 값을 컨테이너에 넣지 않는 길.**
  - Docker Sandboxes: "The raw credential values never enter the VM". 호스트 proxy가 인증 header를 덮어쓰고, 안에서는 sentinel 값만 보인다([credentials](https://docs.docker.com/ai/sandboxes/configuration/credentials/)).
  - `srt`의 `credentials` `mode: "mask"`: sandbox 안에 sentinel을 두고, TLS를 끊은 proxy가 허용 호스트로 나갈 때 진짜 값으로 바꾼다. 파일 가림은 Linux만이다(README L601).
  - Hermes egress proxy도 진짜 key를 proxy에 두고 컨테이너에는 proxy 토큰만 준다.
- **[문서] 값이 들어가면 에이전트가 읽을 수 있다.** devcontainer 문서: "dev containers do not prevent a malicious project from exfiltrating anything accessible inside the container, including the Claude Code credentials stored in `~/.claude`." Codex 문서도 같은 경고를 하고 "treat `~/.codex/auth.json` like a password"라 쓴다.
- **[소스] OpenClaw Codex는 파일을 쓰지 않는다.** 구독 토큰을 app-server에 `chatgptAuthTokens`로 메모리 전달하고, 갱신은 Codex가 OpenClaw에 되묻는다(`account/chatgptAuthTokens/refresh`). 갱신 토큰은 OpenClaw SQLite에 남는다(보조 agent: `docs/plugins/codex-harness-reference/auth.md` L36-60). app-server 경로 전용이다.
- **[소스] 갱신 쓰기 경쟁을 잠그는 예.** Hermes는 Claude OAuth 갱신에 프로세스 간 path lock을 건다(보조 agent: `agent/anthropic_credentials.py` L477-483). OpenCode는 프로세스 안에서만 중복을 없앤다([executor-capabilities.md 8절](executor-capabilities.md#8-인증-동시-실행-구독-자동화-약관)).

## 6. 이미지·도구 설치·시작 비용

- **[소스] 프로바이더 CLI는 이미지에 미리 넣는다.**
  - OpenHands: debian:trixie-slim 기반 `python-node-runtime`에 `INSTALL_ACP_PROVIDERS=claude-code,codex,gemini-cli`를 설치하고, `npx -y` 호출을 고정 binary로 바꾼다. 사용자 base image 위에 runtime 층을 다시 쌓을 수 있다(`BASE_IMAGE`).
  - Claude devcontainer: `node:20` + `npm install -g @anthropic-ai/claude-code`.
  - Sculptor recipe: `ubuntu:24.04` + `install.sh`.
- **[소스] 연구·코딩 도구는 사용자가 정한 이미지나 설정 명령으로 넣는다.**
  - container-use: `.container-use/environment.json`의 base image(기본 `ubuntu:24.04`)·`setup_commands`·`install_commands` + Dagger layer cache.
  - mux: 사용자가 고른 이미지나 프로젝트 `devcontainer.json`.
  - Hermes: 자체 publish 이미지를 쓰고 사용자가 바꿀 수 있다.
- **[소스] 시작 비용 대책.** OpenHands는 health poll 기본 120초, 20분 유휴 회수, warm pool(`deferred_init`). Hermes·mux는 컨테이너를 재사용하고 `docker exec`를 쓴다.
- **[실행] 이 기기(Docker 29.3.1, WSL2)에서:**
  - `docker run --rm alpine true`: 1.46–2.11초(3회).
  - 살아 있는 컨테이너에 `docker exec true`: 1.58–2.33초(3회).
  - `bwrap … --unshare-all true`: 0.03초.
  - [추론] 실행 시도 한 번이 모델 호출로 수십 초~수십 분이 걸리므로 2초 시작 비용은 작다. exec 재사용이 run보다 빠르지도 않았다.

## 7. 플랫폼 주의점

- **[실행] 이 기기는 WSL2 NAT 모드(`wslinfo --networking-mode` = `nat`)의 Docker Engine(Docker Desktop 아님)이다.** rootful, seccomp builtin, cgroup v2. 사용자가 `docker` 그룹에 있다. `bwrap` 0.9.0과 `slirp4netns`가 있고 `socat`·`pasta`는 없다. `/dev/kvm`이 있다.
- **[소스·추론] Docker Desktop(macOS·Windows)에서는 컨테이너가 호스트 loopback에 닿을 수 있다.** Hermes는 그래서 Desktop에서 proxy를 loopback에 bind한다. Linux Docker Engine의 "loopback 서비스에 닿지 않음"을 Desktop에서 기대하면 안 된다. Docker 공식 문서에서 이를 직접 적은 쪽을 찾지 못했다[미확인].
- **[문서] WSL mirrored 모드**는 Windows 쪽 `127.0.0.1` 서비스를 WSL에서 닿게 하고, `hostAddressLoopback`(실험) 설정이 컨테이너→호스트 연결을 바꾼다([WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking)). mirrored 모드에서 Docker Engine 컨테이너가 WSL `127.0.0.1`에 닿는지는 확인하지 않았다[미확인].
- **[문서] Docker Sandboxes 지원 플랫폼**은 macOS 14+(Apple silicon), Windows 11(Hypervisor Platform), Ubuntu 24.04+ KVM이다. VM 안에서는 nested virtualization이 필요하다. **WSL2는 문서에 없다**([install](https://docs.docker.com/ai/sandboxes/install/)).
- **[소스] Podman 대체.** mux(`XUM_CONTAINER_CLI`)와 Hermes(`HERMES_DOCKER_BINARY`)가 자동·수동 대체를 둔다. Hermes는 snap Docker+AppArmor에서 `--init`·`no-new-privileges`를 빼는 호환 옵션을 둔다.
- **[문서] Claude `bypassPermissions`/`--dangerously-skip-permissions`는 root에서 거부된다.** 컨테이너는 비 root로 돌린다. OpenHands는 `--user $(id -u):$(id -g)`로 호스트 사용자와 같은 uid를 써 bind한 파일 소유권을 맞춘다.
- **[문서] Codex·Antigravity 자체 sandbox**는 user namespace가 막힌 환경(일부 컨테이너)에서 실패하거나 아무것도 하지 않는다. 바깥 컨테이너를 경계로 삼으면 안쪽 sandbox는 끄거나 보조로만 쓴다.
- **[미확인] rootless Docker**는 호스트 loopback 차단을 기본값으로 둔다고 알려져 있으나 이번에 확인하지 않았다.

## 이 기기에서 한 확인

모델 호출 없음, 자격 증명 내용을 열지 않음. 시험용 HTTP 서버 두 개를 띄웠다. "사용자 API" 역할은 `127.0.0.1:18765`, "조직 도구 listener" 역할은 docker0 주소 `172.17.0.1:18766`이다. 확인 뒤 서버·이미지·network·파일을 지웠다.

| 실행 위치 | 사용자 API(`127.0.0.1`) | 조직 도구(docker0 IP) | 인터넷 | 기타 |
|---|---|---|---|---|
| 기본 bridge + `--add-host host.docker.internal:host-gateway` | **닿지 않음**(`127.0.0.1`·`host.docker.internal`·`172.17.0.1` 모두) | 닿음 | 닿음 | 호스트에서 `0.0.0.0`에 열린 서비스(54321)에는 닿음 |
| 사용자 정의 bridge network | 닿지 않음(그 network gateway로도) | 닿음(다른 bridge의 호스트 IP) | 닿음 | |
| `--internal` network | 닿지 않음 | 닿지 않음 | 닿지 않음 | |
| `--network none` | 닿지 않음 | 닿지 않음 | 닿지 않음 | |
| `--network host` | **닿음** | — | 닿음 | 쓰면 안 됨 |
| bwrap, 네트워크 공유 | **닿음** | 닿음 | 닿음 | |
| bwrap `--unshare-net` | 닿지 않음 | 닿지 않음 | **닿지 않음** | `/var/run/docker.sock`에는 **여전히 닿음**(Docker version 응답) |
| user+net namespace + `slirp4netns --disable-host-loopback` | 닿지 않음(`127.0.0.1`·`10.0.2.2`) | 닿음 | 닿음 | root 없이 됨 |

- 컨테이너 쓰기 확인: `--user 1000:1000 --cap-drop ALL --security-opt no-new-privileges`로 띄웠다. 조직 공유 폴더(rw), `agents/`(ro) 위에 자기 개인 폴더 `agents/a`(rw)를 겹쳐 mount했다. 결과는 공유 폴더·자기 폴더 쓰기 성공, 남의 개인 폴더 `agents/b`·`/etc` 쓰기 거부, `/tmp`는 컨테이너 안 임시 쓰기 가능이었다. 만든 파일은 호스트에서 uid 1000 소유다. `HOME`은 `/`였다.
- bwrap 쓰기 확인: `--ro-bind / /` 위에 허용 폴더만 `--bind`하면 그 밖 쓰기는 "Read-only file system"이었다.
- `net.ipv4.conf.{all,docker0}.route_localnet = 0`. 컨테이너가 `NET_RAW`로 목적지 `127.0.0.1` 패킷을 만들어 호스트로 보내는 우회는 이 설정에서 커널이 버린다[추론]. `--cap-drop ALL`로 `NET_RAW`도 뺀다.

## BaboJUBot에 주는 시사점

### 권고 1. R1 수단은 Docker 컨테이너에 프로바이더 전체를 넣는 것이다 — 채택 후보. bubblewrap은 보류, 전용 OS 사용자는 배제

- **채택 후보: (a) Docker.**
  - 이 기기의 Docker Engine 기본 bridge는 아무 설정 없이 호스트 `127.0.0.1`(사용자 API·embedded Postgres)을 막고 인터넷은 열어 둔다[실행].
  - 쓰기 제한은 bind mount 목록 그대로다[실행].
  - 레퍼런스 중 R1·R2를 함께 기본으로 만족하는 Docker Sandboxes와, 프로바이더를 통째로 넣는 OpenHands·Claude devcontainer가 같은 계열이다.
  - 프로바이더 자체 sandbox(Claude는 Bash만, OpenCode는 없음)에 기대지 않아 네 프로바이더에 같은 경계를 준다.
- **보류: (b) bubblewrap.** 쓰기 제한은 쉽다[실행]. 하지만 R1의 나머지를 직접 조립해야 한다.
  - 네트워크: `--unshare-net`은 인터넷까지 끊는다. 인터넷을 살리려면 Claude·`srt`·Paperclip처럼 호스트 proxy를 Unix socket으로 넣거나, `slirp4netns --disable-host-loopback`으로 namespace를 이어야 한다[실행].
  - 파일 socket: `--unshare-net`도 `/var/run/docker.sock`을 막지 못했다[실행]. 사용자가 `docker` 그룹이라 docker.sock에 닿으면 호스트 root와 같다. 루트를 tmpfs로 덮고 필요한 경로만 bind하는 Paperclip `filesystemScope: "workspace"` 방식이 필수다.
  - 프로바이더가 쓰는 도구 체인(Python·CUDA·패키지 cache)을 호스트에서 경로별로 열어 줘야 한다. 연구 환경을 조직마다 다르게 두기 어렵다.
  - Docker가 없을 때의 대안으로 남긴다. 만들면 Anthropic `srt`(Apache-2.0)가 가장 완성된 부품이다. `srt`는 기본이 allowlist라 "인터넷 전체 허용 + loopback 차단"을 표현하는 방법(ask callback 등)은 확인하지 않았다[미확인].
- **배제(첫 판): (c) 전용 OS 사용자 + 사용자 API 로그인.**
  - 다른 uid여도 `127.0.0.1`은 그대로 닿는다. 사용자 API뿐 아니라 loopback `postgres/postgres` DB까지 열려 있어, API 로그인만으로는 닫히지 않는다(3절).
  - 막으려면 root로 `iptables -m owner` 규칙을 깔아야 한다.
  - 에이전트마다 "자기 개인 폴더만 쓰기"를 지키려면 에이전트마다 OS 사용자나 ACL이 필요하다. 사용자 생성에 sudo가 든다.
  - Multica가 이 방식을 "가장 가벼운" 권장으로 들지만, Multica 자신은 API를 실행 토큰으로 지키는 구조다. 로그인 없는 로컬 API를 둔 BaboJUBot과 전제가 다르다.

### 권고 2. 컨테이너 단위는 실행 시도 하나, 이미지는 조직마다 — 채택 후보. 조직마다 장기 컨테이너 하나는 배제

- **실행 시도마다 `docker run --rm`.** 실행 시도의 시작·취소·종료가 컨테이너 생애와 같아진다. 취소의 마지막 단계(강제 종료)는 `docker kill`, 끝나면 남는 프로세스가 없다.
  - 시작 비용은 이 기기에서 약 2초다[실행].
  - OpenHands는 대화마다, Docker Sandboxes·devcontainer는 작업 공간마다 컨테이너를 둔다. 실행마다 띄우는 것은 BaboJUBot이 더 짧다. 대신 세션·기억은 컨테이너 밖 폴더에 두므로 잃는 것이 없다[추론].
- **조직마다 장기 컨테이너 하나는 배제.** mount는 컨테이너 단위다. 같은 조직의 에이전트가 한 컨테이너를 쓰면 "자기 개인 폴더만 쓰기"를 mount로 지킬 수 없다.
- **에이전트마다 장기 컨테이너 + `docker exec`는 보류.** 이 기기에서 exec도 run과 비슷하게 1.6–2.3초였다[실행]. 남은 프로세스 정리·상태 오염 부담만 늘어난다.
- **mount 배치(실행 시도 하나):**

  | 컨테이너 안 경로(예) | 호스트 | 모드 |
  |---|---|---|
  | `/org/shared` | 조직 공유 폴더 | rw |
  | `/org/agents` | 같은 조직의 개인 폴더들 | ro |
  | `/org/agents/<자기>` | 자기 개인 폴더 | rw(위에 겹침) |
  | `/home/agent` | 조직·에이전트별 프로바이더 상태 디렉터리(권고 5) | rw |
  | 로그인 파일 | 권고 6 | 프로바이더별 |
  | 연구 환경 cache(예: 패키지·venv) | 조직 볼륨 | rw |

  - 다른 조직의 폴더, 사용자 홈, `docker.sock`, BaboJUBot 저장소·DB 데이터 디렉터리는 mount하지 않는다.
  - `--user <호스트 uid>:<gid> --cap-drop ALL --security-opt no-new-privileges`와 메모리·CPU·pids 상한을 둔다(OpenHands와 같은 묶음). 루트 파일시스템 `--read-only`+tmpfs는 이미지가 정해진 뒤 정한다.

### 권고 3. 네트워크는 bridge, 조직 도구는 사용자 API와 다른 전용 listener로 연다 — 채택 후보. 인터넷 allowlist는 보류

- **bridge network를 쓰고 `--network host`는 금지한다.** `host`에서는 사용자 API에 닿았다[실행]. 조직마다 사용자 정의 bridge를 두면 다른 조직의 컨테이너끼리 직접 통신하지 못한다(Docker 기본 network 분리)[추론]. 어느 bridge든 docker0 주소의 호스트 listener에는 닿는다[실행].
- **조직 도구는 별도 listener로 연다.**
  - 지금은 조직 도구가 사용자 API와 같은 Express 앱·포트에 있다(3절). 같은 listener를 컨테이너 쪽 주소에 열면 사용자 route도 같이 열린다.
  - 조직 도구 router만 붙인 두 번째 HTTP 서버를 docker0 주소(이 기기 `172.17.0.1`)에 bind한다. 컨테이너는 `--add-host host.docker.internal:host-gateway`로 `http://host.docker.internal:<도구 포트>`를 MCP URL로 받는다(OpenHands·Hermes와 같은 배치).
  - `0.0.0.0` bind는 LAN에 열리므로 금지한다(Hermes "NEVER 0.0.0.0").
  - 실행 시도별 bearer 토큰 검사는 지금처럼 이 listener가 한다. 에이전트가 이 listener로 할 수 있는 일은 원래 도구가 허락한 것뿐이다.
- **호스트의 다른 서비스.** `0.0.0.0`에 열린 호스트 서비스에는 컨테이너가 닿는다[실행]. BaboJUBot 서버·Postgres는 loopback에 두는 지금 기본값을 지켜야 한다. 사용자의 다른 서비스까지 막으려면 `DOCKER-USER` chain에 "조직 network → 호스트는 도구 포트만" 규칙을 둘 수 있다. root 설정이라 보류한다[추론].
- **인터넷 allowlist(Docker Sandboxes·devcontainer·`srt` 방식)는 보류.** 사용자 요구가 "인터넷에 닿아야 한다"이고, 연구는 논문·데이터셋·패키지 저장소로 넓게 나간다. devcontainer 방화벽은 컨테이너 안에 `NET_ADMIN`을 줘야 하고 호스트 /24를 열어 R1과 맞지 않는다. 승인 정책 항목으로 "네트워크 제한"이 필요해질 때 다시 본다.

### 권고 4. 사용자 API는 loopback·로그인 없음을 유지한다 — 채택 후보(Linux Docker Engine). 사용자 API 로그인은 보류

- 권고 1~3이면 에이전트는 사용자 API·DB에 닿지 않는다[실행]. [issue-57의 사용자 결정](issue-57-references.md#사용자-api-신뢰경계-추가-조사)(로컬 신뢰 운영)을 바꾸지 않아도 된다.
- **보류 조건:** Docker Desktop(macOS·Windows)이나 WSL mirrored 모드에서는 컨테이너가 호스트 loopback에 닿을 수 있다(7절). 이 환경을 지원하기로 하면 사용자 API 로그인과 DB 비밀번호 교체가 함께 필요하다. 그때도 로그인 비밀값이 컨테이너 mount에 들어가지 않는 한 에이전트는 읽지 못한다.
- **환경 확인:** 실행 시도 전에 "컨테이너에서 사용자 API에 닿지 않음"을 짧은 probe 컨테이너로 확인하고, 닿으면 실제 프로바이더 실행을 막는다[추론]. 이 기기 실측이 그 probe의 모양이다.

### 권고 5. R2는 빈 HOME 위에 제품이 쓴 설정만 둔다. 개인 설정 디렉터리는 mount하지 않는다 — 채택 후보

- 컨테이너 `HOME`은 조직·에이전트별 상태 디렉터리이고, 사용자의 `~/.claude`·`~/.codex`·`~/.config/opencode`·`~/.gemini`는 넣지 않는다(Docker Sandboxes·OpenHands 컨테이너와 같음).
- 지침과 도구는 실행 시도마다 flag·env·제품이 쓴 파일로만 준다. 상태 디렉터리 단위는 조직 경계를 위해 최소 조직마다 둔다. 세션 기록이 섞이지 않게 하려면 에이전트마다 둔다[추론].
- flag는 빈 HOME이 실패했을 때를 위한 이중 장치로 붙인다.

| 프로바이더 | 컨테이너 안 설정 위치 | 이중 장치 | 남는 미확인 |
|---|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR=$HOME/.claude`(제품 상태 디렉터리) | `--strict-mcp-config --mcp-config <0600 파일>`, `--setting-sources ""` 또는 `project,local`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, 필요하면 OpenClaw의 `--settings` 제한 묶음 | 빈 `--setting-sources`와 OAuth의 조합은 OpenClaw가 쓰지만 이 기기에서 실행 확인 안 함. managed policy는 이미지가 정함 |
| Codex | `CODEX_HOME=$HOME/.codex`, 제품이 쓴 `config.toml`(MCP는 `bearer_token_env_var`) | 컨테이너가 경계이므로 `-s danger-full-access`(Codex 문서 권고) | `-c mcp_servers.*` 실행별 주입 실측 |
| OpenCode | `XDG_CONFIG_HOME`·`XDG_DATA_HOME`을 `$HOME` 아래로, MCP·agent는 `OPENCODE_CONFIG_CONTENT` | `OPENCODE_DISABLE_CLAUDE_CODE=1` | 없음(빈 HOME으로 충분) |
| Antigravity | `HOME` 아래 `~/.gemini/`에 제품이 쓴 rules·`mcp_config`만 | custom agent `inherit_user: false` | 컨테이너 안 로그인 유지 방법, `ANTIGRAVITY_GEMINI_DIR` 뜻, Linux keyring 사용 여부 → **Antigravity만 보류** |

### 권고 6. 로그인은 개인 로그인과 나눈 "제품 로그인"으로 하고, 프로바이더마다 넣는 방식을 다르게 한다 — 채택 후보. 개인 로그인 공유는 배제

- **개인 `~/.claude`·`~/.codex`를 그대로 mount·symlink하는 것은 배제한다.** 그 디렉터리에 개인 설정이 같이 있어 R2가 깨진다(Sculptor 반례).
- **제품 로그인 자리를 둔다(AO 계정 폴더 방식).** 사용자가 BaboJUBot 화면에서 프로바이더별로 한 번 로그인한다. 결과는 BaboJUBot 데이터 디렉터리의 프로바이더별 로그인 디렉터리에 남고, 개인 로그인은 건드리지 않는다. 같은 구독 계정을 두 번 로그인하는 것이므로 과금 계정은 같다.
- **Claude Code: `claude setup-token`의 `CLAUDE_CODE_OAUTH_TOKEN`을 env로 — 채택 후보.**
  - 공식 문서가 대화형 로그인이 없는 환경용이라 밝힌다. 파일·갱신 쓰기가 없어 동시 실행 경쟁이 없다.
  - 위험: 1년짜리 토큰이 컨테이너 env에 있어 에이전트가 읽을 수 있다. 토큰 값은 Git·로그·Event log에 남기지 않는다.
  - 대안은 제품 로그인 디렉터리의 `.credentials.json`을 bind하는 것이다. Claude가 그 파일을 제자리에 쓰는지 rename하는지 확인하지 못해 보류한다[미확인].
- **Codex: 제품 로그인 `auth.json` 파일 하나를 rw bind — 채택 후보.**
  - 제자리 덮어쓰기라 갱신이 원본에 남는다[소스].
  - 위험: OpenAI가 경고한 동시 실행 갱신 경쟁(`refresh_token_reused`)이 있다. 갱신 실패를 "다시 로그인 필요"로 Inbox에 띄우는 환경 확인 항목을 둔다.
  - 조직마다 따로 로그인해 `auth.json`을 나누면 조직 간 경쟁은 없어진다. 로그인 횟수가 늘어나므로 첫 판은 하나로 시작한다.
- **OpenCode:** 같은 방식으로 `$XDG_DATA_HOME/opencode/auth.json`을 bind한다. 프로세스 간 갱신 잠금이 없어 Codex와 같은 위험이 있다.
- **Antigravity: 보류.** 인증 파일 위치(`~/.gemini/oauth_creds.json`·`google_accounts.json`)만 확인했다. 컨테이너에서 무엇을 넣어야 로그인이 유지되는지는 실제 로그인으로 확인해야 한다.
- **자격 증명 값을 컨테이너에 넣지 않는 proxy 주입(Docker Sandboxes·`srt` mask·Hermes)은 보류.** 에이전트의 자격 증명 유출까지 막지만, 프로바이더의 모델 API 호출을 TLS 가로채기 proxy로 지나게 해야 한다. 구독 OAuth 흐름에서 동작하는지 확인하지 않았다. 지금 요구(R1·R2)에는 없다.

### 권고 7. 이미지는 제품 기본 이미지 위에 조직의 연구 환경 층을 쌓는다 — 채택 후보

- **제품 기본 이미지:** 비 root 사용자, 네 프로바이더 CLI를 고정 버전으로 넣는다(OpenHands 방식). 호스트 CLI binary를 ro mount하는 길도 있다. 그러면 호스트와 버전이 같아지는 대신 glibc·의존 파일 호환을 프로바이더마다 확인해야 해 보류한다[추론].
- **조직 층:** 초기 연구 승인 때 승인한 연구 환경 명세에서 만든다(container-use `setup_commands` 방식).
- **실행 중 설치:** 연구 진행 중 에이전트가 설치하는 도구는 조직 볼륨(venv·패키지 cache)에 남겨 다음 실행 시도가 이어 쓴다.
- **[미확인] GPU 연구 환경.** NVIDIA container toolkit 연동은 범위 밖이다.

### 주요 위험

- **Docker가 없는 기기.** 권고는 Docker Engine을 요구한다. 없으면 실제 프로바이더 실행을 막고 안내한다. bwrap 경로(권고 1 보류)는 그 뒤 일이다.
- **Docker Desktop·mirrored 모드에서 R1이 조용히 깨짐.** 권고 4의 실행 전 probe로 막는다.
- **조직 도구 listener를 잘못 열면 R1이 깨짐.** 사용자 route가 섞이지 않는지를 구현 이슈의 음성 검증 항목으로 둔다(직접 사용자 API 호출 → 연결 실패, 도구 listener로 사용자 route 호출 → 404).
- **로그인 값은 에이전트가 읽을 수 있음.** R1·R2 범위 밖이지만, 에이전트가 구독 토큰을 바깥으로 보낼 수 있다는 점을 사용자에게 알린다.
- **동시 실행 갱신 경쟁(Codex·OpenCode).** 실행 시도가 많아질수록 커진다.
- **사용자가 `docker` 그룹.** BaboJUBot 서버는 Docker를 바로 부를 수 있다. 반대로 `docker.sock`이 컨테이너나 sandbox에 새면 호스트 root다. mount 목록은 허용 목록으로만 만든다.

## 검증 결과와 한계

- **메인 조사자가 원문을 직접 열어 확인한 것:**
  - Claude devcontainer 세 파일 전부
  - `srt` README·Linux 네트워크 주석·`allowLocalBinding` 설명·loopback 해석 차단 주석
  - Codex `storage.rs` 저장 방식
  - Paperclip `auth.ts` `local_implicit`, `local-process-sandbox.ts` bwrap 인자·network·신뢰 규칙, `agent-runs.md` L319-321, `codex-home.ts` symlink 주석·sandbox 복사 주석, Claude `managedAiConnection`·`--setting-sources user`
  - Multica 보안 모델 문서·`codex_sandbox.go` 주석
  - OpenClaw Claude 제한 flag·Codex home 문서·ACP sandbox 경고
  - OpenHands `registry.py` docker 인자
  - Hermes `iron_proxy.py`·`docker_egress.py` host-gateway 주석
  - AO `claude.go` `LaunchEnv`
  - Sculptor recipe의 `~/.claude` bind·`CLAUDE_CODE_OAUTH_TOKEN` 통과
  - BaboJUBot `app.ts`의 조직 도구 mount와 bind 주소
- **보조 agent가 찾고 메인이 다시 열지 않은 것([소스]·[문서]로 표기했지만 재확인 밖):**
  - OpenHands session key·`sanitized_env`·ACP env·이미지·warm pool 세부
  - container-use 세부
  - mux·Sculptor·Hermes의 나머지 줄 번호
  - Multica daemon health route
  - OpenClaw Gateway 인증·sandbox network 기본값·Codex 토큰 bridge
  - Vibe Kanban·Emdash·Nimbalyst·Crystal·Claude Squad의 "없음" 판정(검색어 기준이며 부재 증명은 아님)
  - Docker Sandboxes·Claude sandboxing/authentication/env-vars·Codex auth/sandboxing·OpenHands docs·WSL networking 문서 인용(웹 보조 agent가 열람)
- **이 기기에서 실행한 것:** [이 기기에서 한 확인](#이-기기에서-한-확인)의 network·mount·bwrap·slirp4netns 시험, `docker run`/`exec`/`bwrap` 시작 시간, `docker info`·`wslinfo`·`sysctl`, 설정 디렉터리의 **파일 이름만** 나열, `agy` 바이너리 문자열 검색. 시험용 서버·`alpine:3.20` 이미지·network·임시 파일은 지웠다.
- **실행하지 않은 것:**
  - 실제 프로바이더를 컨테이너 안에서 돌리기(모델 호출·로그인 금지 범위)
  - 그래서 컨테이너 안에서 다음을 확인하지 않았다:
    - `CLAUDE_CODE_OAUTH_TOKEN`·`--setting-sources ""` 조합의 동작
    - bind한 Codex `auth.json`의 실제 갱신
    - OpenCode·Antigravity 로그인 유지
    - 프로바이더 MCP client가 `host.docker.internal` 도구 URL에 붙는지
  - Docker Desktop·macOS·WSL mirrored·rootless Docker·Podman 실측
  - Docker Sandboxes(`sbx`) 설치·실행(WSL2 지원이 문서에 없음)
- **[미확인]으로 남긴 것:**
  - Claude가 `.credentials.json`을 rename으로 쓰는지
  - Antigravity의 설정 디렉터리 env(`ANTIGRAVITY_GEMINI_DIR`)와 Linux keyring 사용 여부
  - `srt`로 "인터넷 전체 허용 + loopback 차단"을 표현하는 방법
  - Docker 공식 문서의 "bridge 컨테이너는 호스트 loopback 서비스에 닿지 않는다" 문구(실측으로만 확인)
  - Docker Desktop의 loopback 도달 공식 근거
  - `claude setup-token` 토큰이 "model requests only"라서 못 하는 기능
- **라이선스.** Claude Code 저장소(devcontainer·방화벽 script)는 Anthropic 상용 약관이라 복사하지 않는다. mux(AGPL-3.0)는 설계만 참고한다. `srt`·Codex·container-use(Apache-2.0), OpenHands·Paperclip·OpenClaw·Hermes·Sculptor(MIT)는 복사할 때 [AGENTS.md](../../AGENTS.md)의 출처·`THIRD_PARTY_NOTICES.md` 규칙을 따른다(그 파일은 아직 없다). 이 문서는 코드를 복사하지 않았다.
- **이 문서의 범위 밖:** 승인 정책의 네트워크 항목, GPU·외부 job 실행 환경, 자격 증명 proxy 주입의 실제 설계, 구현 이슈 분할.
- **문서 지도.** 지시 범위상 [문서 지도](../README.md)의 조사 기록 표에 이 문서를 더하지 않았다. 채택할 때 함께 갱신해야 한다.
