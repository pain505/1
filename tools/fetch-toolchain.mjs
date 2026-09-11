// 用 Node 下载 Android 构建工具链（沙箱只放行 Node 的网络）
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// 沙箱只允许写工作区，工具链放在工作区内的隐藏缓存目录（可用 TC_ROOT 覆盖）
const ROOT = process.env.TC_ROOT || path.resolve(import.meta.dirname, '..', '..', '.android-toolchain');
const DL = path.join(ROOT, 'dl');
mkdirSync(DL, { recursive: true });

const targets = [
  {
    name: 'jdk',
    url: 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse',
    file: 'jdk17.zip',
    extractTo: path.join(ROOT, 'jdk-raw'),
  },
  {
    name: 'cmdline-tools',
    url: 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip',
    file: 'cmdline-tools.zip',
    extractTo: path.join(ROOT, 'sdk-tmp'),
  },
  {
    name: 'gradle',
    url: 'https://services.gradle.org/distributions/gradle-8.7-bin.zip',
    file: 'gradle-8.7-bin.zip',
    extractTo: path.join(ROOT, 'gradle-raw'),
  },
];

async function download(t) {
  const dest = path.join(DL, t.file);
  if (existsSync(dest)) {
    console.log(`[skip] ${t.name} 已存在 ${dest}`);
    return dest;
  }
  console.log(`[get ] ${t.name} <- ${t.url}`);
  const res = await fetch(t.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${t.name} HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  let got = 0;
  let last = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => {
    got += c.length;
    const mb = Math.floor(got / 1048576);
    if (mb >= last + 20) {
      last = mb;
      const pct = total ? ` (${((got / total) * 100).toFixed(0)}%)` : '';
      console.log(`       ${t.name} ${mb} MB${pct}`);
    }
  });
  await pipeline(body, createWriteStream(dest));
  console.log(`[done] ${t.name} ${(got / 1048576).toFixed(1)} MB`);
  return dest;
}

function unzip(zip, dest) {
  mkdirSync(dest, { recursive: true });
  console.log(`[unzip] ${path.basename(zip)} -> ${dest}`);
  // tar.exe (Windows 10+ 自带, bsdtar) 能解 zip
  execFileSync('tar.exe', ['-xf', zip, '-C', dest], { stdio: 'inherit' });
}

const only = process.argv[2];
for (const t of targets) {
  if (only && only !== t.name) continue;
  const zip = await download(t);
  unzip(zip, t.extractTo);
}
console.log('ALL DOWNLOADS OK');
