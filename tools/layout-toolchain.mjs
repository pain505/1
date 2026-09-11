// 把下载解压出来的原始目录整理成规范位置：
//   jdk-raw/jdk-17.x.y+z  -> jdk/
//   sdk-tmp/cmdline-tools -> sdk/cmdline-tools/latest
//   gradle-raw/gradle-8.7 -> gradle/
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, cpSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.env.TC_ROOT || path.resolve(import.meta.dirname, '..', '..', '.android-toolchain');

function pick(dir, startsWith) {
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir).find((n) => n.startsWith(startsWith) && !n.endsWith('.zip'));
  return hit ? path.join(dir, hit) : null;
}

function move(src, dest, label) {
  if (!src) {
    console.log(`[skip] ${label}: 源不存在`);
    return false;
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.dirname(dest), { recursive: true });
  try {
    renameSync(src, dest);
  } catch {
    cpSync(src, dest, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }
  console.log(`[ok  ] ${label}: ${src} -> ${dest}`);
  return true;
}

// 1) JDK
const jdkSrc = pick(path.join(ROOT, 'jdk-raw'), 'jdk-');
if (jdkSrc && !existsSync(path.join(ROOT, 'jdk', 'bin', 'java.exe'))) {
  move(jdkSrc, path.join(ROOT, 'jdk'), 'jdk');
} else if (existsSync(path.join(ROOT, 'jdk', 'bin', 'java.exe'))) {
  console.log('[skip] jdk 已就位');
}

// 2) cmdline-tools -> sdk/cmdline-tools/latest
const cmdSrc = pick(path.join(ROOT, 'sdk-tmp'), 'cmdline-tools');
if (cmdSrc) {
  move(cmdSrc, path.join(ROOT, 'sdk', 'cmdline-tools', 'latest'), 'cmdline-tools');
  rmSync(path.join(ROOT, 'sdk-tmp'), { recursive: true, force: true });
} else if (existsSync(path.join(ROOT, 'sdk', 'cmdline-tools', 'latest', 'bin'))) {
  console.log('[skip] cmdline-tools 已就位');
}

// 3) Gradle
const gSrc = pick(path.join(ROOT, 'gradle-raw'), 'gradle-');
if (gSrc && !existsSync(path.join(ROOT, 'gradle', 'bin', 'gradle.bat'))) {
  move(gSrc, path.join(ROOT, 'gradle'), 'gradle');
} else if (existsSync(path.join(ROOT, 'gradle', 'bin', 'gradle.bat'))) {
  console.log('[skip] gradle 已就位');
}

const checks = [
  ['jdk', path.join(ROOT, 'jdk', 'bin', 'java.exe')],
  ['cmdline-tools', path.join(ROOT, 'sdk', 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat')],
  ['gradle', path.join(ROOT, 'gradle', 'bin', 'gradle.bat')],
];
let bad = 0;
for (const [n, p] of checks) {
  if (existsSync(p)) console.log(`[ok  ] ${n} -> ${p}`);
  else {
    console.log(`[ERR ] ${n} 缺失: ${p}`);
    bad++;
  }
}
process.exit(bad === 0 ? 0 : 1);
