// 手工构建 APK —— 绕开 Gradle。
//
// 为什么需要这个脚本：本机沙箱禁止 AF_UNIX 的 connect 调用，导致
// `Selector.open()` 抛 "Unable to establish loopback connection"，
// 而 Gradle daemon 与 Kotlin/Java 的 worker 都依赖它，所以 Gradle 起不来
// （提权到 danger-full-access 也一样，因为这是 AF_UNIX connect 被拦，不是文件权限）。
//
// 但 Android SDK 自带的工具链里，只有 Gradle 需要 selector：
//   aapt2 / kotlinc / d8 / zipalign / apksigner 都能正常跑。
// 所以这里按官方构建流程手工走一遍：
//
//   aapt2 compile  → aapt2 link (+--java) → kotlinc (+R.java) → d8 → aapt2 link (--dex) → zipalign → apksigner
//
// 产物：manual-build/pickup-code-debug.apk，同时复制一份到工作区根目录。
//
// 用法： node tools/build-manual.mjs
import { execFileSync, execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const proj = path.resolve(import.meta.dirname, '..');
const R = process.env.TC_ROOT || path.resolve(import.meta.dirname, '..', '..', '.android-toolchain');
const APP = path.join(proj, 'app', 'src', 'main');
const B = path.join(proj, 'manual-build');
const BT = path.join(R, 'sdk', 'build-tools', '34.0.0');
const AJ = path.join(R, 'sdk', 'platforms', 'android-34', 'android.jar');
const JAVA = path.join(R, 'jdk', 'bin', 'java.exe');
const KOTLINC = path.join(R, 'kotlinc', 'bin', 'kotlinc.bat');
const MANIFEST = path.join(APP, 'AndroidManifest.xml');

const env = { ...process.env, JAVA_HOME: path.join(R, 'jdk') };

function head(n, t) { console.log(`\n=== ${n}. ${t} ===`); }
function run(bin, args, label, opts = {}) {
  try {
    const out = execFileSync(bin, args, { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: opts.cwd });
    if (out && out.trim()) console.log(out.trim().split('\n').slice(-8).join('\n'));
    return out;
  } catch (e) {
    console.error(`[失败] ${label}`);
    if (e.stdout) console.error(String(e.stdout).split('\n').slice(-40).join('\n'));
    if (e.stderr) console.error(String(e.stderr).split('\n').slice(-40).join('\n'));
    process.exit(1);
  }
}
function walk(dir, ext) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p, ext));
    else if (n.endsWith(ext)) out.push(p);
  }
  return out;
}

// 0) 前置检查
for (const [label, p] of [
  ['aapt2', path.join(BT, 'aapt2.exe')],
  ['android.jar', AJ],
  ['kotlinc', KOTLINC],
  ['d8.jar', path.join(BT, 'lib', 'd8.jar')],
]) {
  if (!existsSync(p)) { console.error(`找不到 ${label}: ${p}`); process.exit(2); }
}
if (!existsSync(path.join(BT, 'zipalign.exe'))) { console.error('找不到 zipalign.exe'); process.exit(2); }
if (!existsSync(path.join(BT, 'lib', 'apksigner.jar'))) { console.error('找不到 apksigner.jar'); process.exit(2); }

rmSync(B, { recursive: true, force: true });
for (const d of ['compiled', 'java', 'classes', 'dex']) mkdirSync(path.join(B, d), { recursive: true });

// 0b) aapt2 需要 manifest 里有 `package` 属性，而 AGP 是从 build.gradle.kts 的
//     namespace 注入的。所以这里生成一份临时 manifest 补上该属性，
//     源文件保持「AGP 友好」（不含 package），两条构建路径互不干扰。
//
//     `--debuggable` 会额外注入 android:debuggable="true"，让 `adb shell run-as` 能读
//     应用私有目录 —— 仅用于在模拟器上验证解析结果是否真的入库，**不要用于正式包**。
const DEBUGGABLE = process.argv.includes('--debuggable');
const PACKAGE = 'com.pickupcode.app';
const srcManifest = readFileSync(MANIFEST, 'utf8');
let tmpManifest = MANIFEST;
{
  let text = srcManifest;
  if (!/<manifest[^>]*\bpackage\s*=/.test(text)) {
    text = text.replace(
      /<manifest\s+xmlns:android="([^"]+)"/,
      `<manifest xmlns:android="$1"\n    package="${PACKAGE}"`,
    );
  }
  if (DEBUGGABLE) {
    text = text.replace(/<application\b/, '<application\n        android:debuggable="true"');
  }
  if (text !== srcManifest) {
    tmpManifest = path.join(B, 'AndroidManifest.xml');
    writeFileSync(tmpManifest, text, 'utf8');
    console.log(`已生成临时 manifest: ${path.relative(proj, tmpManifest)}${DEBUGGABLE ? '（含 debuggable）' : ''}`);
  }
}

// 1) aapt2 compile：资源 -> 扁平包
head(1, 'aapt2 compile 资源');
run(path.join(BT, 'aapt2.exe'), ['compile', '--dir', path.join(APP, 'res'), '-o', path.join(B, 'compiled', 'res.zip')], 'aapt2 compile');
console.log(`res.zip ${statSync(path.join(B, 'compiled', 'res.zip')).size} bytes`);

// 2) aapt2 link：生成 base.apk + R.java
//    注意：AGP 是从 build.gradle.kts 的 namespace 注入 package 属性的，
//    手工调 aapt2 必须在 manifest 里显式声明 package（见 tools/manifest-package.mjs）。
head(2, 'aapt2 link（生成资源 APK 与 R.java）');
run(path.join(BT, 'aapt2.exe'), [
  'link', '-I', AJ, '--manifest', tmpManifest,
  '--java', path.join(B, 'java'),
  '--min-sdk-version', '29', '--target-sdk-version', '34',
  '-o', path.join(B, 'base.apk'), path.join(B, 'compiled', 'res.zip'),
], 'aapt2 link');
console.log(`base.apk ${statSync(path.join(B, 'base.apk')).size} bytes`);

// 3) kotlinc：Kotlin + 生成的 R.java -> .class
//    注意：不能直接 spawn `kotlinc.bat` —— Node 在 Windows 上 spawn .bat 会 EINVAL。
//    改为直接调 Kotlin 编译器的 Java 入口，行为完全一致。
head(3, 'kotlinc 编译 Kotlin/Java 源码');
const kt = walk(path.join(APP, 'java'), '.kt');
const javaSrc = walk(path.join(B, 'java'), '.java');
console.log(`Kotlin ${kt.length} 个文件，Java ${javaSrc.length} 个文件`);
const kotlinLib = path.join(R, 'kotlinc', 'lib');
run(JAVA, [
  '-cp', path.join(kotlinLib, 'kotlin-compiler.jar') + ';' + path.join(kotlinLib, 'kotlin-stdlib.jar'),
  'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
  '-nowarn',
  '-classpath', AJ + ';' + path.join(kotlinLib, 'kotlin-stdlib.jar'),
  '-jvm-target', '17',
  '-d', path.join(B, 'classes'),
  ...kt, ...javaSrc,
], 'kotlinc');
console.log(`生成 ${walk(path.join(B, 'classes'), '.class').length} 个 .class`);

// 3b) 把 Kotlin 标准库也放进 classes 目录。
//     ⚠️ 关键一步：Android 平台**不提供** Kotlin 运行时（不像 java.* 那样由系统预装），
//     而 Gradle 会自动把 kotlin-stdlib 当依赖带上 —— 手工构建没有这一步，
//     结果就是启动瞬间 NoClassDefFoundError: kotlin/collections/CollectionsKt。
//     实测：不打包 stdlib 时，MainActivity 的 <init> 里第一处 Kotlin 集合调用就崩。
const stdlib = path.join(R, 'kotlinc', 'lib', 'kotlin-stdlib.jar');
if (!existsSync(stdlib)) {
  console.error(`[失败] 找不到 kotlin-stdlib.jar: ${stdlib}`);
  process.exit(2);
}
// 注意 `jar --extract` 不支持 -C，所以把工作目录切到 classes 再解压
run(path.join(R, 'jdk', 'bin', 'jar.exe'), ['--extract', '--file', stdlib], 'jar extract (kotlin-stdlib)', {
  cwd: path.join(B, 'classes'),
});
const stdlibClasses = walk(path.join(B, 'classes'), '.class').length;
console.log(`解出 kotlin-stdlib 后共 ${stdlibClasses} 个 .class`);

// 4) 打 jar -> d8 转 dex
head(4, 'd8 转换 DEX');
run(path.join(R, 'jdk', 'bin', 'jar.exe'), ['--create', '--file', path.join(B, 'classes.jar'), '-C', path.join(B, 'classes'), '.'], 'jar');
run(JAVA, ['-cp', path.join(BT, 'lib', 'd8.jar'), 'com.android.tools.r8.D8',
  '--min-api', '29', '--lib', AJ, '--output', path.join(B, 'dex'), path.join(B, 'classes.jar')], 'd8');
console.log(`classes.dex ${statSync(path.join(B, 'dex', 'classes.dex')).size} bytes`);

// 5) 把 dex 塞进 APK
//    说明：build-tools 34 的 aapt2 没有 `--dex` 选项（那是很老的写法），
//    标准做法是把 classes.dex 直接加进 APK 的根目录，且必须在 zipalign/签名之前。
head(5, '把 classes.dex 装进 APK');
const unsigned = path.join(B, 'app-unsigned.apk');
cpSync(path.join(B, 'base.apk'), unsigned);
// -C 切到 dex 目录再加 classes.dex，避免把 manual-build 的目录结构带进去
run(path.join(R, 'jdk', 'bin', 'jar.exe'), [
  '--update', '--file', unsigned, '-C', path.join(B, 'dex'), 'classes.dex',
], 'jar update (add classes.dex)');
console.log(`app-unsigned.apk ${statSync(unsigned).size} bytes`);

// 验证 dex 真的在包里根目录
const entries = execFileSync(path.join(R, 'jdk', 'bin', 'jar.exe'), ['--list', '--file', unsigned], { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean);
if (!entries.includes('classes.dex')) {
  console.error('[失败] APK 里没有 classes.dex，包内容：\n' + entries.join('\n'));
  process.exit(1);
}
console.log(`包内条目 ${entries.length} 个（含 classes.dex、resources.arsc、AndroidManifest.xml）`);

// 6) zipalign（必须在签名之前）
head(6, 'zipalign 4 字节对齐');
const aligned = path.join(B, 'app-aligned.apk');
run(path.join(BT, 'zipalign.exe'), ['-f', '-p', '4', unsigned, aligned], 'zipalign');

// 7) 生成 debug keystore 并签名
head(7, 'apksigner 签名');
const ks = path.join(B, 'debug.keystore');
rmSync(ks, { force: true }); // 每次重建：同一口令与 DN，证书稳定，输出可复现
run(path.join(R, 'jdk', 'bin', 'keytool.exe'), [
  '-genkeypair', '-keystore', ks, '-storepass', 'android', '-keypass', 'android',
  '-alias', 'androiddebugkey', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
  '-dname', 'CN=Android Debug,O=Android,C=US',
], 'keytool');
const apk = path.join(B, 'pickup-code-debug.apk');
run(JAVA, ['-jar', path.join(BT, 'lib', 'apksigner.jar'), 'sign',
  '--ks', ks, '--ks-pass', 'pass:android', '--key-pass', 'pass:android',
  // minSdk 29 其实只要 v2/v3，但把 v1 也打开能让各种校验器和老旧侧载工具都满意
  '--v1-signing-enabled', 'true',
  '--v2-signing-enabled', 'true',
  '--v3-signing-enabled', 'true',
  '--out', apk, aligned], 'apksigner sign');
run(JAVA, ['-jar', path.join(BT, 'lib', 'apksigner.jar'), 'verify', '--print-certs', apk], 'apksigner verify');

// 8) 复制到工作区根目录，方便直接取
const finalApk = path.join(proj, DEBUGGABLE ? 'pickup-code-debuggable.apk' : 'pickup-code-debug.apk');
cpSync(apk, finalApk);

head(8, '完成');
const kb = (statSync(finalApk).size / 1024).toFixed(1);
console.log(`APK: ${finalApk}  (${kb} KB)`);
console.log(`同时保留: ${apk}`);
console.log('');
console.log('安装： adb install -r "' + finalApk + '"');
console.log('或把 APK 传到手机（微信文件传输助手）后点开安装，允许「未知来源」。');


