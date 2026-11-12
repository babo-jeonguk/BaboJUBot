#!/usr/bin/env bash
# prepare-macos.sh가 만든 시험 RAM 디스크를 떼고 임시 폴더를 지운다. 실패·취소 뒤에도 돌며, 남은 것은 runner VM과 함께
# 폐기된다.
set -u
for device in "${FILES_APFSX_DEVICE:-}" "${FILES_HFS_DEVICE:-}" "${FILES_HFSX_DEVICE:-}"; do
  if [ -n "$device" ]; then
    hdiutil detach "$device" -force || echo "::warning::could not detach $device"
  fi
done
rm -rf "${RUNNER_TEMP:?}/file-volumes"
