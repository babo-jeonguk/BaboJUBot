#!/bin/sh
# 실행 시도마다 돈다(#149). 프로바이더는 이미지의 프로그램과 신뢰된 PATH·환경으로 시작한다.
# 조직 폴더·개인 폴더·제품 폴더의 가상환경이나 실행 파일은 자동으로 쓰지 않는다. 연구 패키지는 연구 명령이
# 개인 폴더의 가상환경을 직접 골라 쓴다(예: python3 -m venv "$BABOJUBOT_PERSONAL/.venv" 뒤 "$BABOJUBOT_PERSONAL/.venv/bin/python").
set -e
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# 시작할 때 다른 코드를 끌어들이는 환경 값은 지운다.
unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT PYTHONPATH PYTHONHOME PYTHONSTARTUP PYTHONUSERBASE \
  NODE_OPTIONS NODE_PATH BASH_ENV ENV VIRTUAL_ENV PERL5LIB PERL5OPT RUBYLIB RUBYOPT
# 함께 쓰는 HOME의 Python 사용자 패키지(usercustomize 등)를 자동으로 읽지 않는다.
export PYTHONNOUSERSITE=1
# git status 때 저장소·HOME 설정의 fsmonitor 명령이 자동으로 돌지 않게 한다.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=false
exec /usr/local/bin/node /usr/local/lib/babojubot/relay.mjs "$@"
