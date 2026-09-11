// 安装 pre-push 钩子。
//
// 钩子本体是一个转发到 `node tools/pre-push.mjs` 的 shell 壳 —— 逻辑写在 Node 里，
// 因为本机 Git Bash 的 sh.exe 起不来，纯 shell 的钩子在 Windows 上会直接失败。
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const proj = path.resolve(import.meta.dirname, '..');
const gitDir = path.join(proj, '.git');

if (!existsSync(gitDir)) {
  console.error('不是 git 仓库（缺 .git）。先 git init。');
  process.exit(1);
}

const hooks = path.join(gitDir, 'hooks');
mkdirSync(hooks, { recursive: true });
const dst = path.join(hooks, 'pre-push');

const content = `#!/bin/sh
# 由 tools/install-hooks.mjs 生成：转发到 Node 实现
exec node "$(dirname "$0")/../../tools/pre-push.mjs" "$@"
`;
writeFileSync(dst, content, 'utf8');
try { chmodSync(dst, 0o755); } catch { /* Windows 不需要可执行位 */ }
console.log(`已安装 pre-push 钩子 -> ${dst}`);
console.log('（逻辑在 tools/pre-push.mjs，改那里即可）');
