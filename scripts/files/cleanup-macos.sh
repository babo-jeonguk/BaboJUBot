#!/usr/bin/env bash
# prepare-macos.sh가 붙인 시험 이미지를 떼고 지운다. 실패·취소 뒤에도 돌며, 남은 것은 runner VM과 함께 폐기된다.
set -u
for name in BaboAPFSX BaboHFS BaboHFSX; do
  if [ -d "/Volumes/$name" ]; then
    hdiutil detach "/Volumes/$name" -force || echo "::warning::could not detach $name"
  fi
done
rm -rf "${RUNNER_TEMP:?}/file-volumes"
