<#
  本机直接编译出 APK（不需要 GitHub、不需要 Android Studio）

  为什么能用：AI 的运行沙箱禁止 JVM 创建 NIO selector 的唤醒管道，
  所以 AI 自己跑不了 Gradle；但**你自己开的窗口不受这个限制**，
  而 JDK / Android SDK / Gradle 都已经下载好了。

  用法（推荐直接双击 build-now.cmd）：
      pwsh -ExecutionPolicy Bypass -File tools\build-now.ps1
#>
$ErrorActionPreference = 'Stop'

$proj = Split-Path -Parent $PSScriptRoot
$Root = if ($env:TC_ROOT) { $env:TC_ROOT } else { (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.android-toolchain') }

$Java   = Join-Path $Root 'jdk\bin\java.exe'
$Sdk    = Join-Path $Root 'sdk'
$Gradle = Join-Path $Root 'gradle\bin\gradle.bat'
$Gh     = Join-Path $Root 'gradle-home'
$Adb    = Join-Path $Sdk 'platform-tools\adb.exe'

function Head($t) { Write-Host ""; Write-Host "==== $t ====" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "  OK   $t" -ForegroundColor Green }
function Bad($t)  { Write-Host "  !!   $t" -ForegroundColor Red }

Write-Host "取件码管家 — 本机一键编译" -ForegroundColor White
Write-Host "项目目录: $proj"

# ---------------------------------------------------------------- 1. 前置检查
Head "1/5 检查工具链"
$missing = @()
if (-not (Test-Path $Java))   { $missing += "JDK      : $Java" }
if (-not (Test-Path $Gradle)) { $missing += "Gradle   : $Gradle" }
if (-not (Test-Path (Join-Path $Sdk 'platforms\android-34')))       { $missing += "SDK platform android-34" }
if (-not (Test-Path (Join-Path $Sdk 'build-tools\34.0.0')))         { $missing += "SDK build-tools 34.0.0" }
if ($missing.Count) {
  Bad "缺少以下组件："
  $missing | ForEach-Object { Write-Host "       $_" }
  Write-Host ""
  Write-Host "修复：先跑  node tools\fetch-toolchain.mjs  ，再跑  pwsh -NoProfile -File tools\install-sdk.ps1" -ForegroundColor Yellow
  exit 2
}
Ok "JDK 17         $Java"
Ok "Android SDK    $Sdk"
Ok "Gradle 8.7     $Gradle"

# ---------------------------------------------------------------- 2. 环境变量
Head "2/5 设置环境"
$env:JAVA_HOME = Join-Path $Root 'jdk'
$env:ANDROID_HOME = $Sdk
$env:ANDROID_SDK_ROOT = $Sdk
$env:GRADLE_USER_HOME = $Gh
$env:GRADLE_OPTS = '-Dfile.encoding=UTF-8'
$env:PATH = "$env:JAVA_HOME\bin;$Sdk\platform-tools;$env:PATH"
Ok "JAVA_HOME        = $env:JAVA_HOME"
Ok "ANDROID_HOME     = $env:ANDROID_HOME"
Ok "GRADLE_USER_HOME = $env:GRADLE_USER_HOME"

# local.properties（Gradle 靠它找 SDK）
$lp = Join-Path $proj 'local.properties'
Set-Content -Path $lp -Encoding UTF8 -Value "# 由 tools/build-now.ps1 生成`nsdk.dir=$($Sdk.Replace('\','\\'))"
Ok "local.properties 已写入"

# 离线校验（不依赖编译器，几秒钟）
Head "3/5 编译前离线校验"
Push-Location $proj
try {
  foreach ($s in @('tools\node\run-tests.mjs', 'tools\node\check-kotlin-parity.mjs', 'tools\codec-test.mjs')) {
    $out = & node $s 2>&1
    if ($LASTEXITCODE -ne 0) { Bad "$s 失败"; $out | Select-Object -Last 20; exit 3 }
  }
  Ok "解析规则语料 / Kotlin 一致性 / JSON 契约 全部通过"
} finally { Pop-Location }

# ---------------------------------------------------------------- 4. 编译
Head "4/5 编译 Debug APK（首次会下载 AGP/Kotlin 依赖，约 300MB，可能几分钟）"
Write-Host "  如果卡在下载，可以按 Ctrl+C 中断；国内网络已在 settings.gradle.kts 里配了阿里云镜像。" -ForegroundColor DarkGray
Push-Location $proj
$buildOk = $false
try {
  & $Gradle --no-daemon assembleDebug
  $buildOk = ($LASTEXITCODE -eq 0)
} finally { Pop-Location }

$apk = Join-Path $proj 'app\build\outputs\apk\debug\app-debug.apk'
if (-not $buildOk) {
  Head "编译失败"
  Bad "请把上面最后 30 行红色报错复制给 AI，它能直接改代码。"
  Write-Host "  常见原因：Kotlin 语法/空安全报错、依赖下载失败（重试即可）。" -ForegroundColor Yellow
  exit 1
}
if (-not (Test-Path $apk)) { Bad "编译返回成功但没找到 APK：$apk"; exit 1 }

Head "5/5 编译成功"
$size = [math]::Round((Get-Item $apk).Length / 1KB, 1)
Ok "APK: $apk  ($size KB)"

# ---------------------------------------------------------------- 装到手机（可选）
$devices = @()
if (Test-Path $Adb) {
  $devices = (& $Adb devices) 2>$null | Select-Object -Skip 1 | Where-Object { $_ -match '\tdevice$' }
}
Write-Host ""
if ($devices.Count -gt 0) {
  Write-Host "检测到已连接的手机，正在安装..." -ForegroundColor Cyan
  & $Adb install -r $apk
  if ($LASTEXITCODE -eq 0) { Ok "已安装到手机" } else { Bad "安装失败，可手动把 APK 传到手机点开安装" }
} else {
  Write-Host "没检测到已连接的手机（USB 调试未开或没插线）。手动安装方法：" -ForegroundColor Yellow
  Write-Host "  把下面这个文件传到手机（微信文件传输助手 / 数据线 / 网盘），在手机上点开安装，"
  Write-Host "  系统提示时允许「安装未知来源应用」。"
  Write-Host ""
  Write-Host "  $apk" -ForegroundColor White
}
Write-Host ""
Write-Host "装好后按 使用手册.md 操作：授予短信权限 + 开启通知使用权，它会自动导入历史取件码。" -ForegroundColor Green
