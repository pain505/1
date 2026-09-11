# 取件码管家 — 本机构建环境
# 用法： . .\tools\env.ps1   （注意前面的点：点源导入，否则环境变量不留在当前会话）
$script:Root = if ($env:TC_ROOT) { $env:TC_ROOT } else { (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.android-toolchain') }
$env:TC_ROOT = $script:Root
$env:JAVA_HOME = "$Root\jdk"
$env:ANDROID_HOME = "$Root\sdk"
$env:ANDROID_SDK_ROOT = "$Root\sdk"
$env:GRADLE_USER_HOME = "$Root\gradle-home"
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\cmdline-tools\latest\bin;$env:PATH"
Write-Host "TC_ROOT          = $env:TC_ROOT"
Write-Host "JAVA_HOME        = $env:JAVA_HOME"
Write-Host "ANDROID_HOME     = $env:ANDROID_HOME"
Write-Host "GRADLE_USER_HOME = $env:GRADLE_USER_HOME"
