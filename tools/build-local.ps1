# 本机构建（需要本机 JVM 能正常运行 Gradle）
#
# ⚠️ 重要：这台机器**跑不了** Gradle。沙箱禁止 JVM 创建 NIO selector 的唤醒管道
#    （Unix domain socket），`Selector.open()` 直接抛
#    "Unable to establish loopback connection"，Gradle daemon、Kotlin 编译器都起不来。
#    所以本脚本在本机注定失败，它存在的意义是给**换到另一台机器**时用。
#
#    本机请改用两条路：
#      A) 推到 GitHub 走 .github/workflows/build-apk.yml 云编译（见 BUILD.md）
#      B) 装 Android Studio 直接 Build APK（见 BUILD.md）
#
# 用法（在能跑 Gradle 的机器上）： pwsh -File tools\build-local.ps1
$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
Set-Location $proj

function Step($n, $t) { Write-Host "`n== [$n] $t ==" -ForegroundColor Cyan }

Step 1 '检查工具链'
. "$PSScriptRoot\env.ps1"
$java = Join-Path $env:JAVA_HOME 'bin\java.exe'
if (-not (Test-Path $java)) { throw "找不到 JDK: $java（先跑 node tools\fetch-toolchain.mjs）" }

Step 2 '确认 JVM 能创建 NIO selector'
node -e "
const {execFileSync}=require('child_process');
const j=process.env.JAVA_HOME+'/bin/java.exe';
const src='public class C{public static void main(String[] a)throws Exception{java.nio.channels.Selector.open();System.out.println(\"SELECTOR_OK\");}}';
require('fs').writeFileSync(process.env.TEMP+'/C.java',src);
try{const o=execFileSync(j,[process.env.TEMP+'/C.java'],{encoding:'utf8'});console.log(o.trim());if(!o.includes('SELECTOR_OK'))process.exit(1);}catch(e){console.error('JVM 无法创建 NIO selector，Gradle 一定跑不起来。见本脚本头部说明。');process.exit(1);}
" 
if ($LASTEXITCODE -ne 0) { throw 'JVM NIO selector 不可用 —— 本机无法构建，请走云端编译（BUILD.md）' }

Step 3 '整理工具链 + 生成 wrapper'
node tools\layout-toolchain.mjs
if ($LASTEXITCODE -ne 0) { throw '工具链整理失败' }
node tools\gen-wrapper.mjs
if ($LASTEXITCODE -ne 0) { throw 'wrapper 生成失败' }

Step 4 '安装 Android SDK 组件'
pwsh -NoProfile -File tools\install-sdk.ps1
if ($LASTEXITCODE -ne 0) { throw 'SDK 安装失败' }

Step 5 '离线验证解析规则（Node 镜像）'
node tools\node\run-tests.mjs
if ($LASTEXITCODE -ne 0) { throw '解析规则语料未全过' }

Step 6 '静态自检（资源 / 清单 / 禁用依赖）'
node tools\check-manifest.mjs
if ($LASTEXITCODE -ne 0) { throw '静态自检未通过' }

Step 7 '把 wrapper 指向本地 Gradle zip（避免联网下载）'
$propsPath = Join-Path $proj 'gradle\wrapper\gradle-wrapper.properties'
$orig = Get-Content $propsPath -Raw
$zip = Join-Path $env:TC_ROOT 'dl\gradle-8.7-bin.zip'
if (Test-Path $zip) {
  $local = 'distributionUrl=file\:///' + ($zip -replace '\\', '/')
  ($orig -replace '(?m)^distributionUrl=.*$', $local) | Set-Content $propsPath -Encoding UTF8
  Write-Host "distributionUrl -> $local"
}

try {
  Step 8 '编译 Debug APK'
  & .\gradlew.bat --no-daemon assembleDebug
  if ($LASTEXITCODE -ne 0) { throw '编译失败' }
} finally {
  # 还原成官方地址，避免把本机路径提交进仓库
  if (Test-Path $zip) { Set-Content $propsPath -Value $orig -Encoding UTF8; Write-Host '已还原 gradle-wrapper.properties' }
}

$apk = Join-Path $proj 'app\build\outputs\apk\debug\app-debug.apk'
if (Test-Path $apk) {
  Write-Host "`nAPK OK -> $apk  ($([math]::Round((Get-Item $apk).Length/1KB,1)) KB)" -ForegroundColor Green
  Write-Host "安装： adb install -r `"$apk`"" -ForegroundColor Green
} else {
  throw "编译命令成功但没找到 APK：$apk"
}
