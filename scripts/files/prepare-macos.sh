#!/usr/bin/env bash
# macOS CI에서 파일 경계 시험용 볼륨을 준비한다. 기본 볼륨(APFS, 대소문자 무시)의 폴더와 시험 전용 RAM 디스크
# 세 개(대소문자 구분 APFS, HFS+, 대소문자 구분 HFS+)를 포맷해 붙이고, 실제 파일 시스템 종류를 diskutil로 확인한 뒤
# 폴더 경로를 GITHUB_ENV에 남긴다. 파일에 둔 디스크 이미지는 runner에서 가끔 수십 배 느려져(10 MiB 읽기가 30초를
# 넘김) RAM 디스크를 쓴다. 사용자 디스크는 건드리지 않는다. 정리는 cleanup-macos.sh.
set -euo pipefail
work="${RUNNER_TEMP:?}/file-volumes"
mkdir -p "$work"

# 폴더가 놓인 볼륨의 파일 시스템 성격(personality)이 기대 패턴과 맞는지 본다. 설정 명령의 성공만 믿지 않는다.
check() {
  local dir=$1 want=$2 refuse=$3
  local device personality
  device=$(df "$dir" | tail -1 | awk '{print $1}')
  diskutil info "$device" | grep -E "Volume Name|File System Personality|Type \(Bundle\)|Owners|Mount Point|Device Location|Protocol" || true
  personality=$(diskutil info "$device" | awk -F': +' '/File System Personality/ {print $2}')
  echo "$dir on $device: $personality"
  if ! [[ $personality =~ $want ]] || { [ -n "$refuse" ] && [[ $personality =~ $refuse ]]; }; then
    echo "::error::$dir is on '$personality', expected /$want/"
    exit 1
  fi
  # 소유권이 꺼져 있으면 권한 거부 시험(C26)이 이 볼륨의 실제 권한을 보지 못한다.
  if ! diskutil info "$device" | grep -Eq "Owners: +Enabled"; then
    echo "::error::$dir has ownership disabled"
    exit 1
  fi
}

apfs="$work/apfs"
mkdir -p "$apfs"
check "$apfs" "^APFS$" ""
echo "FILES_APFS=$apfs" >> "$GITHUB_ENV"

# 512 MiB RAM 디스크(512-byte sector 1048576개)를 만들어 포맷한다. 떼는 데 쓸 장치 이름도 남긴다.
ram() {
  local name=$1 fs=$2 key=$3 want=$4 refuse=$5
  local device
  device=$(hdiutil attach -nobrowse -nomount ram://1048576 | awk '{print $1}')
  [ -n "$device" ] || { echo "::error::$name RAM disk was not created"; exit 1; }
  echo "${key}_DEVICE=$device" >> "$GITHUB_ENV"
  diskutil erasevolume "$fs" "$name" "$device" > /dev/null
  sudo -n diskutil enableOwnership "/Volumes/$name"
  mkdir -p "/Volumes/$name/files"
  check "/Volumes/$name/files" "$want" "$refuse"
  echo "$key=/Volumes/$name/files" >> "$GITHUB_ENV"
}
ram BaboAPFSX "Case-sensitive APFS" FILES_APFSX "^Case-sensitive APFS$" ""
ram BaboHFS "HFS+" FILES_HFS "HFS" "Case-sensitive|APFS"
ram BaboHFSX "Case-sensitive HFS+" FILES_HFSX "Case-sensitive.*HFS" "APFS"
sw_vers
