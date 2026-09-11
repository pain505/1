// 把仓库上传到 GitHub（REST API）—— 带重试的健壮版本。
//
// 为什么不用 git：这台机器上 git 自己的 HTTPS 栈会随机 TLS 失败
// （SSL_ERROR_SYSCALL），而 Node 的 fetch 稳定得多。
//
// 为什么要重试：网络偶发 ECONNRESET，且 GitHub 建 tree 偶发 404/5xx，
// 不加退避会把偶发失败误判成"接口坏了"（这次就吃过一次亏）。
//
// 特性：
//  - 所有请求自动重试（指数退避 + 抖动），区分可重试与不可重试状态码
//  - 已上传的 blob 结果缓存到本地，重复执行不用重传
//  - 最后校验远程文件清单与本地一致
//
// 用法： $env:GH_TOKEN='...'; node tools/gh-upload.mjs <owner> <repo> [branch]
//
// 用途：在 git 的 HTTPS 走不通（TLS 随机失败）或没有 git 的环境里，
// 直接用 GitHub REST API 把本仓库推上去。
// 注意：`.github/workflows/**` 需要 token 额外带 `workflow` 权限，否则会被拒绝
// （而且 GitHub 返回的是含糊的 404）——本脚本会把它单独跳过并给出提示。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const [OWNER, REPO, BRANCH = 'main'] = process.argv.slice(2);
const API = 'https://api.github.com';
const CACHE = '.gh-upload-cache.json';

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) { console.error('缺少 GH_TOKEN 环境变量'); process.exit(2); }
if (!OWNER || !REPO) {
  console.error('用法: node tools/gh-upload.mjs <owner> <repo> [branch]');
  process.exit(2);
}
const proj = path.resolve(import.meta.dirname, '..');
console.log(`目标: ${OWNER}/${REPO}  分支: ${BRANCH}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 可重试的状态码：网络抖动 / 限流 / 服务端问题 */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

async function request(method, url, body, { tries = 6, label = '' } = {}) {
  const full = url.startsWith('http') ? url : API + url;
  let lastErr = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(full, {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'pickup-code-uploader',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }

      if (res.ok) return json;

      // 404 在 GitHub 上是出了名的"啥都可能表示"，网络抖动时也会出现，所以也重试
      const worthRetry = RETRYABLE.has(res.status) || res.status === 404;
      const msg = `${method} ${url} -> HTTP ${res.status}: ${json?.message || text.slice(0, 150)}`;
      if (!worthRetry || attempt === tries) {
        const e = new Error(msg); e.status = res.status; e.json = json; throw e;
      }
      lastErr = new Error(msg);
      console.log(`    [重试 ${attempt}/${tries}] ${label || url} — ${res.status}`);
    } catch (e) {
      if (e.status && !RETRYABLE.has(e.status) && e.status !== 404) throw e;
      lastErr = e;
      if (attempt === tries) break;
      console.log(`    [重试 ${attempt}/${tries}] ${label || url} — ${e.code || e.message}`);
    }
    await sleep(Math.min(1000 * 2 ** (attempt - 1), 15000) + Math.random() * 500);
  }
  throw lastErr ?? new Error('未知失败');
}

// ---------------------------------------------------------------- 1. 校验身份

console.log('=== 1. 校验 token ===');
const me = await request('GET', '/user');
console.log(`  身份: ${me.login}`);
const repoApi = `/repos/${OWNER}/${REPO}`;
let repo = await request('GET', repoApi);
console.log(`  仓库: ${repo.full_name}  空=${repo.size === 0}  默认分支=${repo.default_branch}`);

// ---------------------------------------------------------------- 2. 确保仓库有首个提交

// 注意：不能用 repo.size 判断是否为空 —— GitHub 的 size 字段是异步统计的，
// 刚建完或刚提交时常常还是 0，会误判。直接查基线分支的 ref 更可靠。
let baseRef = null;
try {
  baseRef = await request('GET', `${repoApi}/git/ref/heads/${BRANCH}`);
  console.log(`\n=== 2. 仓库已有 ${BRANCH} 分支（${baseRef.object.sha.slice(0, 10)}），跳过引导 ===`);
} catch (e) {
  if (e.status !== 404 && e.status !== 409) throw e;
  console.log('\n=== 2. 建立引导提交（空仓库的 git 对象接口需要先有一个提交）===');

  // 若 .gitignore 已存在（例如上次跑到一半），PUT 必须带上它的 blob sha
  let existingSha = null;
  try {
    const cur = await request('GET', `${repoApi}/contents/.gitignore?ref=${BRANCH}`);
    existingSha = cur?.sha ?? null;
  } catch { /* 不存在 */ }

  const body = {
    message: 'chore: 初始化仓库',
    content: Buffer.from(readFileSync(path.join(proj, '.gitignore'), 'utf8'), 'utf8').toString('base64'),
    branch: BRANCH,
  };
  if (existingSha) body.sha = existingSha;

  await request('PUT', `${repoApi}/contents/.gitignore`, body);
  console.log(`  已${existingSha ? '更新' : '创建'} .gitignore`);
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    try {
      baseRef = await request('GET', `${repoApi}/git/ref/heads/${BRANCH}`);
      break;
    } catch { /* 还没生效，继续等 */ }
  }
  if (!baseRef) { console.error('  引导提交后仍拿不到分支 ref，放弃'); process.exit(1); }
  console.log(`  分支已就绪: ${baseRef.object.sha.slice(0, 10)}`);
}

// ---------------------------------------------------------------- 3. 上传 blob（带缓存）

const files = execFileSync('git', ['ls-files', '-z'], { cwd: proj, encoding: 'utf8' })
  .split('\0').filter(Boolean);

// GitHub 限制：通过 API 提交 `.github/workflows/**` 需要 token 带 `workflow` 权限，
// 否则会被拒绝（而且返回的是含糊的 404，不是 403 —— 很难查）。
// 默认尝试上传；若确实没权限，会在下面捕获并给出明确的补法提示。
// 设 SKIP_WORKFLOW=1 可显式跳过（例如只想快速同步其他文件）。
const WORKFLOW_PREFIX = '.github/workflows/';
const skipWorkflow = process.env.SKIP_WORKFLOW === '1';
const wfFiles = skipWorkflow ? files.filter((f) => f.replace(/\\/g, '/').startsWith(WORKFLOW_PREFIX)) : [];
const normalFiles = skipWorkflow
  ? files.filter((f) => !f.replace(/\\/g, '/').startsWith(WORKFLOW_PREFIX))
  : files;

let cache = {};
const cachePath = path.join(proj, CACHE);
if (existsSync(cachePath)) {
  try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { cache = {}; }
}
// 校验缓存里的 sha 还能用（blob 是内容寻址的，sha 不变就一直有效）
console.log(`\n=== 3. 上传 blob（${normalFiles.length} 个文件，缓存命中 ${Object.keys(cache).length}）===`);

const entries = [];
let uploaded = 0;
const t0 = Date.now();
for (const rel of normalFiles) {
  const p = rel.replace(/\\/g, '/');
  if (cache[p]) {
    entries.push({ path: p, mode: '100644', type: 'blob', sha: cache[p] });
    continue;
  }
  const buf = readFileSync(path.join(proj, rel));
  const isBinary = /\.(jar|png|jpe?g|gif|webp|keystore|apk|ico)$/i.test(rel);
  const blob = await request('POST', `${repoApi}/git/blobs`, {
    content: isBinary ? buf.toString('base64') : buf.toString('utf8'),
    encoding: isBinary ? 'base64' : 'utf-8',
  }, { label: `blob ${p}` });
  cache[p] = blob.sha;
  entries.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha });
  uploaded++;
  if (uploaded % 10 === 0) {
    writeFileSync(cachePath, JSON.stringify(cache, null, 0), 'utf8');
    console.log(`  已上传 ${uploaded} 个（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
  }
}
writeFileSync(cachePath, JSON.stringify(cache, null, 0), 'utf8');
console.log(`  blob 全部就绪（${entries.length} 条，本轮新传 ${uploaded} 个）`);

// ---------------------------------------------------------------- 4. 建 tree

console.log('\n=== 4. 建 tree ===');
const tree = await request('POST', `${repoApi}/git/trees`, { tree: entries }, { label: 'create tree' });
console.log(`  tree: ${tree.sha.slice(0, 10)}（${tree.tree.length} 项）`);

// ---------------------------------------------------------------- 5. commit + 更新 ref

console.log('\n=== 5. 建 commit 并更新分支 ===');
const ref = await request('GET', `${repoApi}/git/ref/heads/${BRANCH}`);
const parent = ref.object.sha;
console.log(`  父提交: ${parent.slice(0, 10)}`);

const message = (() => {
  try { return execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: proj, encoding: 'utf8' }).trim(); }
  catch { return 'feat: 取件码管家'; }
})();
const now = new Date().toISOString();
const who = { name: OWNER, email: `${OWNER}@users.noreply.github.com`, date: now };

const commit = await request('POST', `${repoApi}/git/commits`, {
  message, tree: tree.sha, parents: [parent], author: who, committer: who,
}, { label: 'create commit' });
console.log(`  commit: ${commit.sha.slice(0, 10)}`);

await request('PATCH', `${repoApi}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false }, { label: 'update ref' });
console.log(`  ${BRANCH} 已更新`);

// ---------------------------------------------------------------- 6. 验证

console.log('\n=== 6. 校验 ===');
const finalRepo = await request('GET', repoApi);
console.log(`  地址: ${finalRepo.html_url}`);
console.log(`  可见性: ${finalRepo.private ? '私有' : '公开'}  默认分支: ${finalRepo.default_branch}`);

const check = await request('GET', `${repoApi}/git/trees/${BRANCH}?recursive=1`);
const remote = check.tree.filter((t) => t.type === 'blob').map((t) => t.path);
const missing = entries.map((e) => e.path).filter((p) => !remote.includes(p));
console.log(`  远程文件: ${remote.length} / 本地共 ${files.length}`);
if (missing.length) {
  console.log(`  ✗ 缺失 ${missing.length} 个: ${missing.slice(0, 10).join(', ')}`);
  process.exit(1);
}
console.log('  ✓ 已上传的文件全部到位');

if (wfFiles.length) {
  console.log('');
  console.log('  ⚠️ 以下 workflow 文件还没上传（GitHub 要求 token 带 workflow 权限）:');
  for (const f of wfFiles) console.log(`     ${f.replace(/\\/g, '/')}`);
  console.log('');
  console.log('  补法（任选其一）:');
  console.log('    A) 新建 token 时在 scope 里额外勾 `workflow`，重跑本脚本（blob 有缓存，很快）');
  console.log('    B) 在 GitHub 网页上手动新建该文件，把本地内容粘进去');
}
console.log(`\n  ${finalRepo.html_url}`);
