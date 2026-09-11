// 从本地 Gradle 发行包里取出官方 wrapper 三件套（gradlew / gradlew.bat / gradle-wrapper.jar）。
// 不依赖能跑起来的 Gradle —— 因为沙箱封了 JVM 的 NIO selector，Gradle 本身没法启动。
//
// 说明：官方 gradle-wrapper.jar 嵌套在发行包的 lib/plugins/gradle-wrapper-8.7.jar 里，
// 用 tar 解出来即可，内容与 `gradle wrapper` 生成的一致。
// 若 jar 已存在则什么也不做（幂等）。
import { existsSync, mkdirSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = process.env.TC_ROOT || path.resolve(import.meta.dirname, '..', '..', '.android-toolchain');
const proj = path.resolve(import.meta.dirname, '..');
const wrapDir = path.join(proj, 'gradle', 'wrapper');
const jarOut = path.join(wrapDir, 'gradle-wrapper.jar');
const pluginJar = path.join(ROOT, 'gradle', 'lib', 'plugins', 'gradle-wrapper-8.7.jar');

mkdirSync(wrapDir, { recursive: true });

if (!existsSync(jarOut)) {
  if (!existsSync(pluginJar)) {
    console.error(
      `[ERR ] 找不到 ${pluginJar}\n` +
        `       请先跑 node tools/fetch-toolchain.mjs + node tools/layout-toolchain.mjs，\n` +
        `       或从任意一个 Android 项目里拷贝 gradle/wrapper/gradle-wrapper.jar 过来。`,
    );
    process.exit(2);
  }
  const tmp = path.join(ROOT, 'tmp-wrapper');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  copyFileSync(pluginJar, path.join(tmp, 'w.zip'));
  execFileSync('tar.exe', ['-xf', path.join(tmp, 'w.zip'), '-C', tmp, 'gradle-wrapper.jar'], { stdio: 'inherit' });
  renameSync(path.join(tmp, 'gradle-wrapper.jar'), jarOut);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`[ok  ] 从发行包提取 wrapper jar -> ${jarOut}`);
} else {
  console.log('[skip] wrapper jar 已存在');
}

const need = ['gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar', 'gradle/wrapper/gradle-wrapper.properties'];
let bad = 0;
for (const f of need) {
  const p = path.join(proj, ...f.split('/'));
  if (existsSync(p)) console.log(`[ok  ] ${f}`);
  else {
    console.log(`[ERR ] 缺 ${f}`);
    bad++;
  }
}
process.exit(bad === 0 ? 0 : 1);
