# Windows CI에서 파일 경계 시험용 볼륨을 준비한다. runner 임시 폴더의 NTFS(8.3 짧은 이름 켬), 시험 전용 가상 디스크의
# FAT32, 같은 컴퓨터의 SMB 공유(loopback, 실제 NAS가 아니다)를 만들고 실제 종류를 확인한 뒤 폴더 경로를 GITHUB_ENV에 남긴다.
# 사용자 디스크는 건드리지 않는다. 정리는 cleanup-windows.ps1.
$ErrorActionPreference = 'Stop'
$work = Join-Path $env:RUNNER_TEMP 'file-volumes'
New-Item -ItemType Directory -Force $work | Out-Null
function Export-Folder([string]$Name, [string]$Value) {
  "$Name=$Value" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}
function Assert-FileSystem([string]$Letter, [string]$Expected) {
  $volume = Get-Volume -DriveLetter $Letter
  $volume | Format-List DriveLetter, FileSystemType, FileSystemLabel, Size, AllocationUnitSize | Out-String | Write-Host
  if ($volume.FileSystemType -ne $Expected) {
    throw "${Letter}: is $($volume.FileSystemType), expected $Expected"
  }
}

[System.Environment]::OSVersion | Out-String | Write-Host
whoami /groups | Select-String 'S-1-16-12288' | Out-String | Write-Host  # 높은 무결성(관리자) 여부

# NTFS: runner 임시 폴더의 볼륨. 짧은 이름(8.3)은 볼륨마다 꺼져 있을 수 있어 이 볼륨에서 켠다(새로 만드는 파일부터).
$ntfs = Join-Path $work 'ntfs'
New-Item -ItemType Directory -Force $ntfs | Out-Null
$drive = (Get-Item $ntfs).PSDrive.Name
Assert-FileSystem $drive 'NTFS'
fsutil 8dot3name set "${drive}:" 0
fsutil 8dot3name query "${drive}:"
fsutil behavior query SymlinkEvaluation
Export-Folder 'FILES_NTFS' $ntfs

# FAT32: 1 GiB 가상 디스크를 만들어 붙이고 포맷한다.
$vhd = Join-Path $work 'fat32.vhdx'
$letter = 'R'
$script = Join-Path $work 'fat32.txt'
@"
create vdisk file="$vhd" maximum=1024 type=expandable
select vdisk file="$vhd"
attach vdisk
create partition primary
format fs=fat32 quick label=BABOFAT
assign letter=$letter
"@ | Set-Content -Encoding ascii $script
diskpart /s $script | Write-Host
if ($LASTEXITCODE -ne 0) { throw "diskpart exited with $LASTEXITCODE" }
Assert-FileSystem $letter 'FAT32'
New-Item -ItemType Directory -Force "${letter}:\files" | Out-Null
Export-Folder 'FILES_FAT32' "${letter}:\files"

# SMB: NTFS 폴더를 공유하고 \\localhost로 연다. 서버·클라이언트가 같은 Windows인 loopback이다.
$smb = Join-Path $work 'smb'
New-Item -ItemType Directory -Force $smb | Out-Null
$share = 'babojubot-files'
New-SmbShare -Name $share -Path $smb -FullAccess 'Everyone' | Out-Null
$unc = "\\localhost\$share\files"
New-Item -ItemType Directory -Force $unc | Out-Null
Get-SmbShare -Name $share | Format-List Name, Path, ShareType, ShareState | Out-String | Write-Host
$connection = Get-SmbConnection -ServerName localhost
$connection | Format-List ServerName, ShareName, Dialect, UserName | Out-String | Write-Host
if (-not $connection) { throw "no SMB connection to localhost" }
Assert-FileSystem ((Get-Item $smb).PSDrive.Name) 'NTFS'
Export-Folder 'FILES_SMB' $unc
Export-Folder 'FILES_SMB_DIALECT' (($connection | Select-Object -First 1).Dialect)
