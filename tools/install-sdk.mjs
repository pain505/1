// 用 sdkmanager 安装 Android SDK 组件（Java 侧 TLS 可能被沙箱阻断，故带上 TLS1.2 参数）
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = process.env.TC_ROOT || path.resolve(import.meta.dirname, '..', '..', '.android-toolchain');
const JAVA_HOME = path.join(ROOT, 'jdk');
const SDK = path.join(ROOT, 'sdk');
const CMDLINE = path.join(SDK, 'cmdline-tools', 'latest', 'bin');
const HOME = path.join(ROOT, 'home');

for (const p of [SDK, HOME]) mkdirSync(p, { recursive: true });

const env = {
  ...process.env,
  JAVA_HOME,
  ANDROID_HOME: SDK,
  ANDROID_SDK_ROOT: SDK,
  ANDROID_USER_HOME: HOME,
  PATH: `${path.join(JAVA_HOME, 'bin')};${CMDLINE};${process.env.PATH}`,
  // Java 侧遇到代理/证书问题时的兜底
  JAVA_TOOL_OPTIONS:
    '-Dhttps.protocols=TLSv1.2,TLSv1.3 -Dhttp.auth.preference=basic -Dfile.encoding=UTF-8',
};

// 注意：Node 在 Windows 上 spawn .bat 会 EINVAL，所以直接调 sdkmanager 的 java 入口
const JAVA = path.join(JAVA_HOME, 'bin', 'java.exe');
const CLASSPATH = path.join(CMDLINE, '..', 'lib', 'sdkmanager-classpath.jar');
const SDKMANAGER_MAIN = 'com.android.sdklib.tool.sdkmanager.SdkManagerCli';

function sdkmanager(args) {
  return execFileSync(JAVA, ['-Dcom.android.sdkmanager.toolsdir=' + CMDLINE, '-cp', CLASSPATH, SDKMANAGER_MAIN, ...args], {
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function run(args, label) {
  console.log(`\n=== ${label}: ${args.join(' ')} ===`);
  try {
    const out = sdkmanager(args);
    if (out && out.trim()) console.log(out.trim().split('\n').slice(-40).join('\n'));
    return 0;
  } catch (e) {
    console.log(`[warn] ${label} 退出码 ${e.status}`);
    if (e.stdout) console.log(String(e.stdout).split('\n').slice(-30).join('\n'));
    if (e.stderr) console.log(String(e.stderr).split('\n').slice(-30).join('\n'));
    return e.status ?? 1;
  }
}

const javaBin = path.join(JAVA_HOME, 'bin', 'java.exe');
if (!existsSync(javaBin)) {
  console.error(`找不到 java：${javaBin}。先跑 node tools/fetch-toolchain.mjs`);
  process.exit(2);
}
if (!existsSync(CLASSPATH)) {
  console.error(`找不到 sdkmanager-classpath.jar：${CLASSPATH}`);
  process.exit(2);
}

// 先看看能不能连通 Google 仓库
try {
  const out = sdkmanager(['--list_installed']);
  console.log('--- 已安装组件 ---\n' + out);
} catch (e) {
  console.log('[warn] --list_installed 执行异常:', e.message);
  if (e.stderr) console.log(String(e.stderr).slice(-2000));
}

const PKGS = [
  'platform-tools',
  'platforms;android-34',
  'build-tools;34.0.0',
];

// 接受 license
console.log('\n=== 接受 licenses ===');
try {
  execFileSync(
    javaBin,
    ['-Dcom.android.sdkmanager.toolsdir=' + CMDLINE, '-cp', CLASSPATH, SDKMANAGER_MAIN, '--licenses'],
    { env, input: 'y\n'.repeat(80), stdio: ['pipe', 'inherit', 'inherit'] },
  );
  console.log('[ok] licenses 已接受');
} catch (e) {
  console.log('[warn] license 接受过程退出码', e.status);
}

let fail = 0;
for (const p of PKGS) fail += run([p], `install ${p}`);

// local.properties 指到本机 SDK
const proj = path.resolve(import.meta.dirname, '..');
writeFileSync(
  path.join(proj, 'local.properties'),
  `# 由 tools/install-sdk.mjs 生成\nsdk.dir=${SDK.replace(/\\/g, '\\\\')}\n`,
  'utf8',
);
console.log(`\nlocal.properties -> sdk.dir=${SDK}`);

run(['--list_installed'], 'final list');
console.log(fail === 0 ? '\nSDK INSTALL OK' : `\nSDK INSTALL 有 ${fail} 个包失败`);
process.exit(fail === 0 ? 0 : 1);
