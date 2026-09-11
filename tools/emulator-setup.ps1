# 下载并启动 Android 模拟器（用于复现闪退、读 logcat）
# 用法： pwsh -NoProfile -File tools\emulator-setup.ps1
$ErrorActionPreference = 'Continue'
$Root = if ($env:TC_ROOT) { $env:TC_ROOT } else { (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.android-toolchain') }
$Java = Join-Path $Root 'jdk\bin\java.exe'
$Sdk = Join-Path $Root 'sdk'
$Bin = Join-Path $Sdk 'cmdline-tools\latest\bin'
$Cp = Join-Path $Sdk 'cmdline-tools\latest\lib\sdkmanager-classpath.jar'
$Main = 'com.android.sdklib.tool.sdkmanager.SdkManagerCli'

$env:JAVA_HOME = Join-Path $Root 'jdk'
$env:ANDROID_HOME = $Sdk
$env:ANDROID_SDK_ROOT = $Sdk
$env:ANDROID_USER_HOME = Join-Path $Root 'home'
Remove-Item Env:\JAVA_TOOL_OPTIONS -ErrorAction SilentlyContinue

function SdkMgr([string[]]$SdkArgs) {
  & $Java "-Dcom.android.sdkmanager.toolsdir=$Bin" -cp $Cp $Main "--sdk_root=$Sdk" @SdkArgs
  return $LASTEXITCODE
}

Write-Host '=== 接受 licenses ===' -ForegroundColor Cyan
("y`n" * 80) | & $Java "-Dcom.android.sdkmanager.toolsdir=$Bin" -cp $Cp $Main "--sdk_root=$Sdk" --licenses 2>&1 | Select-Object -Last 3

$pkgs = @('emulator', 'system-images;android-34;google_apis;x86_64')
$fail = 0
foreach ($p in $pkgs) {
  if ((Test-Path (Join-Path $Sdk 'emulator\emulator.exe')) -and $p -eq 'emulator') { Write-Host "[skip] emulator 已存在"; continue }
  Write-Host "=== 安装 $p ===" -ForegroundColor Cyan
  $c = SdkMgr @($p)
  if ($c -ne 0) { Write-Host "[warn] $p 退出码 $c" -ForegroundColor Yellow; $fail++ }
}

Write-Host '=== 已安装 ===' -ForegroundColor Cyan
SdkMgr @('--list_installed') | Out-Null

if ($fail -eq 0) { Write-Host 'EMULATOR INSTALL OK' -ForegroundColor Green; exit 0 }
Write-Host "EMULATOR INSTALL 有 $fail 个包失败" -ForegroundColor Red; exit 1
