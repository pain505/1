// pre-push 校验（Node 实现）。
//
// 为什么不用 shell 写：本机的 Git Bash `sh.exe` 起不来
// （`couldn't create signal pipe, Win32 error 5`），hook 用纯 shell 会在 Windows 上失败。
// 所以逻辑放这里，`.git/hooks/pre-push` 只是一个转发到 node 的壳。
//
// 注意：这里调用子进程必须用 `stdio: 'inherit'`（或 'ignore'）。
// 某些受限环境下 Node 捕获子进程输出用的命名管道会被拒绝（EPERM），
// 而继承 stdio 不受影响。子脚本的退出码通过 execFileSync 的异常传播。
//
// 用法： node tools\pre-push.mjs    （退出码非 0 = 拒绝推送）
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const proj = path.resolve(import.meta.dirname, '..');
const results = [];
let failed = 0;

function step(label, fn) {
  process.stdout.write(`-- ${label} ... `);
  try {
    fn();
    console.log('OK');
    results.push({ label, ok: true });
  } catch (e) {
    console.log('FAIL');
    failed++;
    results.push({ label, ok: false, detail: e.status != null ? `退出码 ${e.status}` : String(e.message) });
  }
}

/** 用继承 stdio 的方式跑一个 Node 脚本；非 0 退出码抛异常 */
function run(script) {
  execFileSync(process.execPath, [path.join(proj, script)], { cwd: proj, stdio: 'inherit' });
}

function syntaxCheck(script) {
  execFileSync(process.execPath, ['--check', path.join(proj, script)], { cwd: proj, stdio: 'ignore' });
}

console.log('== pre-push 校验 ==');

step('解析规则语料回归', () => run('tools/node/run-tests.mjs'));
step('Kotlin/Node 规则一致性', () => run('tools/node/check-kotlin-parity.mjs'));
step('JSON 编解码契约', () => run('tools/codec-test.mjs'));
step('二维码编码/解码闭环', () => run('tools/qr-selftest.mjs'));
step('静态自检（资源 / 清单 / 禁用依赖）', () => run('tools/check-manifest.mjs'));
step('Kotlin 跨文件调用检查', () => run('tools/kotlin-lint.mjs'));
step('JS 语法', () => {
  for (const f of [
    'tools/node/extract.mjs', 'tools/node/run-tests.mjs', 'tools/node/check-kotlin-parity.mjs',
    'tools/check-manifest.mjs', 'tools/kotlin-lint.mjs', 'tools/codec-test.mjs', 'tools/pre-push.mjs',
    'tools/install-hooks.mjs', 'tools/fetch-toolchain.mjs', 'tools/layout-toolchain.mjs',
    'tools/gen-wrapper.mjs', 'tools/make-kit.mjs', 'tools/build-manual.mjs',
    'tools/qr.mjs', 'tools/qr-selftest.mjs', 'tools/qr-verify.mjs', 'tools/serve-apk.mjs',
  ]) syntaxCheck(f);
});
step('package.json 合法', () => {
  JSON.parse(readFileSync(path.join(proj, 'package.json'), 'utf8'));
});
step('Windows 脚本行尾/编码', () => {
  // .cmd 必须是 CRLF（LF 的批处理会出怪问题）；.ps1 必须带 UTF-8 BOM
  // （否则 PowerShell 5.1 按 ANSI 读，中文注释和提示会乱码）
  const problems = [];
  for (const rel of readdirSync(path.join(proj, 'tools'))) {
    const full = path.join(proj, 'tools', rel);
    if (rel.endsWith('.cmd') || rel.endsWith('.bat')) {
      const b = readFileSync(full);
      let bareLf = 0;
      for (let i = 0; i < b.length; i++) if (b[i] === 10 && (i === 0 || b[i - 1] !== 13)) bareLf++;
      if (bareLf) problems.push(`${rel}: 有 ${bareLf} 处裸 LF，批处理需要 CRLF`);
    }
    if (rel.endsWith('.ps1') || rel.endsWith('.cmd')) {
      const b = readFileSync(full);
      const hasBom = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
      if (rel.endsWith('.ps1') && !hasBom) problems.push(`${rel}: 缺 UTF-8 BOM，PowerShell 5.1 下中文会乱码`);
    }
  }
  if (problems.length) throw new Error(problems.join('; '));
});
step('wrapper 三件套', () => {
  const missing = [
    'gradlew', 'gradlew.bat',
    'gradle/wrapper/gradle-wrapper.jar', 'gradle/wrapper/gradle-wrapper.properties',
  ].filter((f) => !existsSync(path.join(proj, ...f.split('/'))));
  if (missing.length) throw new Error(`缺文件: ${missing.join(', ')}`);
});

if (failed) {
  console.log('');
  for (const r of results) if (!r.ok) console.log(`[失败] ${r.label}：${r.detail}`);
  console.log(`\npre-push 校验失败（${failed} 项），已阻止推送。`);
  process.exit(1);
}
console.log('\npre-push 校验全部通过。');
