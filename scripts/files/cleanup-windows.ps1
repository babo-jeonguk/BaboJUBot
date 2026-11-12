# prepare-windows.ps1이 만든 SMB 공유와 가상 디스크를 정리한다. 실패·취소 뒤에도 돌며, 남은 것은 runner VM과 함께 폐기된다.
$ErrorActionPreference = 'Continue'
$work = Join-Path $env:RUNNER_TEMP 'file-volumes'
if (Get-SmbShare -Name 'babojubot-files' -ErrorAction SilentlyContinue) {
  Remove-SmbShare -Name 'babojubot-files' -Force
}
$vhd = Join-Path $work 'fat32.vhdx'
if (Test-Path $vhd) {
  $script = Join-Path $work 'detach.txt'
  "select vdisk file=`"$vhd`"`ndetach vdisk" | Set-Content -Encoding ascii $script
  diskpart /s $script | Write-Host
}
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
exit 0
