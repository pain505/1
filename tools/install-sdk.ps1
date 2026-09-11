# 安装 Android SDK 组件（直接调 sdkmanager 的 java 入口，绕开 .bat 与 Node 管道限制）
# 用法： pwsh -File tools\install-sdk.ps1
$ErrorActionPreference = 'Continue'
$Root = if ($env:TC_ROOT) { $env:TC_ROOT } else { (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.android-toolchain') }
$Java = Join-Path $Root 'jdk\bin\java.exe'
$Sdk = Join-Path $Root 'sdk'
$CmdLine = Join-Path $Sdk 'cmdline-tools\latest\bin'
$Cp = Join-Path $Sdk 'cmdline-tools\latest\lib\sdkmanager-classpath.jar'
$Home2 = Join-Path $Root 'home'

New-Item -ItemType Directory -Force -Path $Sdk, $Home2 | Out-Null

if (-not (Test-Path $Java)) { throw "找不到 java: $Java" }
if (-not (Test-Path $Cp)) { throw "找不到 sdkmanager-classpath.jar: $Cp" }

$env:JAVA_HOME = Join-Path $Root 'jdk'
$env:ANDROID_HOME = $Sdk
$env:ANDROID_SDK_ROOT = $Sdk
$env:ANDROID_USER_HOME = $Home2
$env:JAVA_TOOL_OPTIONS = $null
Remove-Item Env:\JAVA_TOOL_OPTIONS -ErrorAction SilentlyContinue

$main = 'com.android.sdklib.tool.sdkmanager.SdkManagerCli'
function Invoke-SdkManager([string[]]$SdkArgs) {
  & $Java "-Dcom.android.sdkmanager.toolsdir=$CmdLine" -cp $Cp $main "--sdk_root=$Sdk" @SdkArgs
  return $LASTEXITCODE
}

Write-Host '=== 接受 licenses ===' -ForegroundColor Cyan
$yes = ("y`n" * 80)
$yes | & $Java "-Dcom.android.sdkmanager.toolsdir=$CmdLine" -cp $Cp $main "--sdk_root=$Sdk" --licenses 2>&1 | Select-Object -Last 6

$pkgs = @('platform-tools', 'platforms;android-34', 'build-tools;34.0.0')
$fail = 0
foreach ($p in $pkgs) {
  Write-Host "=== 安装 $p ===" -ForegroundColor Cyan
  $code = Invoke-SdkManager @($p)
  if ($code -ne 0) { Write-Host "[warn] $p 退出码 $code" -ForegroundColor Yellow; $fail++ }
}

# 写 local.properties
$proj = Split-Path -Parent $PSScriptRoot
$sdkEsc = $Sdk.Replace('\', '\\')
Set-Content -Path (Join-Path $proj 'local.properties') -Encoding UTF8 -Value "# 由 tools/install-sdk.ps1 生成`nsdk.dir=$sdkEsc"
Write-Host "local.properties -> sdk.dir=$Sdk"

Write-Host '=== 已安装组件 ===' -ForegroundColor Cyan
Invoke-SdkManager @('--list_installed') | Out-Null

if ($fail -eq 0) { Write-Host "SDK INSTALL OK" -ForegroundColor Green; exit 0 }
else { Write-Host "SDK INSTALL 有 $fail 个包失败" -ForegroundColor Red; exit 1 }
