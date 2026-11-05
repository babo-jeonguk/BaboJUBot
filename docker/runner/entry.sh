#!/bin/sh
# 실행 시도마다 돈다. 추가 패키지는 조직 폴더의 가상환경(BABOJUBOT_VENV)에 두어 다음 실행 시도에서도 쓴다.
set -e
if [ -n "$BABOJUBOT_VENV" ]; then
  if [ ! -x "$BABOJUBOT_VENV/bin/python" ]; then
    python3 -m venv "$BABOJUBOT_VENV" >/dev/null 2>&1 || true
  fi
  if [ -x "$BABOJUBOT_VENV/bin/python" ]; then
    export VIRTUAL_ENV="$BABOJUBOT_VENV"
    export PATH="$BABOJUBOT_VENV/bin:$PATH"
  fi
fi
exec "$@"
