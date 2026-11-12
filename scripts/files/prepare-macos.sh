#!/usr/bin/env bash
# macOS CI에서 파일 경계 시험용 볼륨을 준비한다. 기본 볼륨(APFS, 대소문자 무시)의 폴더와 시험 전용 디스크 이미지
# 세 개(대소문자 구분 APFS, HFS+, 대소문자 구분 HFS+)를 붙이고, 실제 파일 시스템 종류를 diskutil로 확인한 뒤
# 폴더 경로를 GITHUB_ENV에 남긴다. 사용자 디스크는 건드리지 않는다. 정리는 cleanup-macos.sh.
set -euo pipefail
work="${RUNNER_TEMP:?}/file-volumes"
mkdir -p "$work"

# 폴더가 놓인 볼륨의 파일 시스템 성격(personality)이 기대 패턴과 맞는지 본다. 설정 명령의 성공만 믿지 않는다.
check() {
  local dir=$1 want=$2 refuse=$3
  local device personality
  device=$(df "$dir" | tail -1 | awk '{print $1}')
  diskutil info "$device" | grep -E "Volume Name|File System Personality|Type \(Bundle\)|Owners|Mount Point" || true
  personality=$(diskutil info "$device" | awk -F': +' '/File System Personality/ {print $2}')
  echo "$dir on $device: $personality"
  if ! [[ $personality =~ $want ]] || { [ -n "$refuse" ] && [[ $personality =~ $refuse ]]; }; then
    echo "::error::$dir is on '$personality', expected /$want/"
    exit 1
  fi
}

apfs="$work/apfs"
mkdir -p "$apfs"
check "$apfs" "^APFS$" ""
echo "FILES_APFS=$apfs" >> "$GITHUB_ENV"

image() {
  local name=$1 fs=$2 key=$3 want=$4 refuse=$5
  hdiutil create -size 256m -fs "$fs" -volname "$name" -ov "$work/$name.dmg" > /dev/null
  # 소유권을 켜야 권한 거부 시험(C26)이 이 볼륨의 실제 권한을 본다.
  local mount
  mount=$(hdiutil attach -nobrowse -owners on "$work/$name.dmg" | awk -F'\t' '/\/Volumes\// {print $NF}')
  [ -d "$mount" ] || { echo "::error::$name did not mount"; exit 1; }
  mkdir -p "$mount/files"
  check "$mount/files" "$want" "$refuse"
  echo "$key=$mount/files" >> "$GITHUB_ENV"
}
image BaboAPFSX "Case-sensitive APFS" FILES_APFSX "^Case-sensitive APFS$" ""
image BaboHFS "HFS+" FILES_HFS "HFS" "Case-sensitive|APFS"
image BaboHFSX "HFSX" FILES_HFSX "Case-sensitive.*HFS" "APFS"
sw_vers
