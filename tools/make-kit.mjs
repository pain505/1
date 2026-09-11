// 一键导出：把项目打包成一个 zip + 一个自解压 .ps1（单文件，可微信传）
// 用法： node tools\make-kit.mjs
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const proj = path.resolve(import.meta.dirname, '..');
const outDir = path.join(proj, 'dist');
mkdirSync(outDir, { recursive: true });

const zipPath = path.join(outDir, 'pickup-code-android-src.zip');
try { execFileSync('tar.exe', ['-a', '-c', '-f', zipPath, '-C', proj, '--exclude=dist', '--exclude=app/build', '--exclude=.gradle', '.'], { stdio: 'inherit' }); }
catch (e) { console.error('打包失败', e.message); process.exit(1); }
console.log(`zip: ${zipPath}  ${(statSync(zipPath).size / 1024).toFixed(0)} KB`);

const b64 = readFileSync(zipPath).toString('base64');
const selfPs1 = path.join(outDir, 'pickup-code-android-src.ps1');
const head = `# 取件码管家 — 源码自解压包
# 用法：pwsh -File .\\pickup-code-android-src.ps1  [-OutDir <目录>]
param([string]$OutDir = (Join-Path (Get-Location) 'pickup-code-android'))
$ErrorActionPreference = 'Stop'
$tmp = Join-Path $env:TEMP ('pickup-src-' + [guid]::NewGuid().ToString('N') + '.zip')
[IO.File]::WriteAllBytes($tmp, [Convert]::FromBase64String(@'
`;
const tail = `
'@))
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
tar.exe -xf $tmp -C $OutDir
Remove-Item $tmp -Force
Write-Host "已解压到: $OutDir" -ForegroundColor Green
Write-Host "下一步：" -ForegroundColor Cyan
Write-Host "  1) 装 Android Studio，Open 这个目录，或"
Write-Host "  2) 推到 GitHub 走 .github/workflows/build-apk.yml 云编译（见 BUILD.md）"
`;
writeFileSync(selfPs1, head + b64 + tail, 'utf8');
console.log(`自解压脚本: ${selfPs1}  ${(statSync(selfPs1).size / 1024).toFixed(0)} KB`);
