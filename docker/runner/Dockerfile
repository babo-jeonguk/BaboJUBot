# 격리 실행의 공통 이미지(#102): 네 프로바이더 CLI, git, Python·Node, 기본 연구 도구. 제품 로그인과 GitHub 로그인은 넣지 않는다.
# 만들기: pnpm runner:build (docker build -t babojubot-runner docker/runner)
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git jq python3 python3-pip python3-venv ripgrep tini unzip \
  && rm -rf /var/lib/apt/lists/*
ARG CLAUDE_CODE_PACKAGE=@anthropic-ai/claude-code
ARG CODEX_PACKAGE=@openai/codex
RUN npm install -g "$CLAUDE_CODE_PACKAGE" "$CODEX_PACKAGE" && npm cache clean --force
# OpenCode 2.x는 GitHub 릴리스 묶음으로 받는다(공식 설치 스크립트와 npm은 1.x이며 서버 방식이 다르다). 판은 build arg로 바꾼다.
ARG OPENCODE_VERSION=2.2.5
RUN arch="$(dpkg --print-architecture)" \
  && case "$arch" in amd64) asset=x64 ;; arm64) asset=arm64 ;; *) echo "unsupported architecture: $arch" >&2; exit 1 ;; esac \
  && curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${asset}.tar.gz" \
    | tar -xz -C /usr/local/bin opencode \
  && chmod 0755 /usr/local/bin/opencode \
  && opencode --version
# Antigravity CLI(agy)는 공개 패키지를 정하지 않았다. 설치 명령을 주면 /usr/local/bin/agy가 되게 설치한다.
ARG ANTIGRAVITY_INSTALL=""
RUN if [ -n "$ANTIGRAVITY_INSTALL" ]; then sh -c "$ANTIGRAVITY_INSTALL"; fi
# 시작 프로그램(#149): 신뢰된 PATH·환경으로 프로바이더를 띄우고, 네트워크 없는 컨테이너의 loopback 포트를 실행 시도 밖 중계의 파일 소켓에 잇는다.
COPY entry.sh /usr/local/bin/babojubot-entry
COPY relay.mjs /usr/local/lib/babojubot/relay.mjs
RUN chmod 0755 /usr/local/bin/babojubot-entry && chmod 0644 /usr/local/lib/babojubot/relay.mjs
# 서버가 안전 확인 때 이 판인지 본다. 시작 프로그램의 약속(소켓·포트·환경)이 바뀌면 올린다.
LABEL babojubot.runner="2"
ENTRYPOINT ["/usr/local/bin/babojubot-entry"]
