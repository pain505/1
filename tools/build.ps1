# 一键构建：装工具链 → 装 SDK → 生成 gradlew → 编译 APK
# 用法： pwsh -File tools\build.ps1
$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
Set-Location $proj

Write-Host "== [1/5] 检查/下载工具链 ==" -ForegroundColor Cyan
node tools\fetch-toolchain.mjs
if ($LASTEXITCODE -ne 0) { throw "工具链下载失败" }

Write-Host "== [2/5] 整理工具链目录 ==" -ForegroundColor Cyan
. "$PSScriptRoot\env.ps1"
node tools\layout-toolchain.mjs
if ($LASTEXITCODE -ne 0) { throw "工具链整理失败" }

Write-Host "== [3/5] 安装 Android SDK 组件 ==" -ForegroundColor Cyan
node tools\install-sdk.mjs
if ($LASTEXITCODE -ne 0) { throw "SDK 安装失败" }

Write-Host "== [4/5] 生成 gradlew ==" -ForegroundColor Cyan
node tools\gen-wrapper.mjs
if ($LASTEXITCODE -ne 0) { throw "gradlew 生成失败" }

Write-Host "== [5/5] 编译 Debug APK ==" -ForegroundColor Cyan
& .\gradlew.bat --no-daemon assembleDebug
if ($LASTEXITCODE -ne 0) { throw "编译失败" }

$apk = Join-Path $proj 'app\build\outputs\apk\debug\app-debug.apk'
if (Test-Path $apk) {
  Write-Host "`nAPK OK -> $apk  ($([math]::Round((Get-Item $apk).Length/1KB,1)) KB)" -ForegroundColor Green
} else {
  throw "编译命令成功但没有找到 APK：$apk"
}
