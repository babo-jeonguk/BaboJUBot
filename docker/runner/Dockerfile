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
# OpenCode 2.x는 공식 설치 스크립트로 받는다(npm 1.x는 서버 방식이 다르다).
ARG OPENCODE_INSTALL="curl -fsSL https://opencode.ai/install | bash"
RUN HOME=/tmp/opencode-install sh -c "$OPENCODE_INSTALL" \
  && install -m 0755 /tmp/opencode-install/.opencode/bin/opencode /usr/local/bin/opencode \
  && rm -rf /tmp/opencode-install
# Antigravity CLI(agy)는 공개 패키지를 정하지 않았다. 설치 명령을 주면 /usr/local/bin/agy가 되게 설치한다.
ARG ANTIGRAVITY_INSTALL=""
RUN if [ -n "$ANTIGRAVITY_INSTALL" ]; then sh -c "$ANTIGRAVITY_INSTALL"; fi
COPY entry.sh /usr/local/bin/babojubot-entry
RUN chmod 0755 /usr/local/bin/babojubot-entry
ENTRYPOINT ["/usr/local/bin/babojubot-entry"]
