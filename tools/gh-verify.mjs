// 独立核验上传结果：把 GitHub 上**实际的内容**拉回来，与本地逐字节比对。
//
// 不看文件数量就下结论是不够的 —— 必须确认内容一致（尤其是有没有行尾/BOM/编码被改动）。
//
// 用法： $env:GH_TOKEN='...'; node tools/gh-verify.mjs <owner> <repo> [branch]
//       （私有仓库需要 token；公开仓库不带也能跑）
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const [OWNER, REPO, BRANCH = 'main'] = process.argv.slice(2);
const API = 'https://api.github.com';
const TOKEN = process.env.GH_TOKEN || '';

if (!OWNER || !REPO) {
  console.error('用法: node tools/gh-verify.mjs <owner> <repo> [branch]');
  process.exit(2);
}

const proj = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url, { raw = false } = {}) {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url.startsWith('http') ? url : API + url, {
        headers: {
          ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
          Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'verify',
        },
      });
      if (res.ok) return raw ? Buffer.from(await res.arrayBuffer()) : await res.json();
      if (res.status === 404) { const e = new Error('404'); e.status = 404; throw e; }
      if (i === 3) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (e.status === 404) throw e;
      if (i === 3) throw e;
    }
    await sleep(1500);
  }
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12);

console.log('=== 1. 仓库概况 ===');
const repo = await api(`/repos/${OWNER}/${REPO}`);
console.log(`  地址      : ${repo.html_url}`);
console.log(`  可见性    : ${repo.private ? '私有' : '公开'}`);
console.log(`  默认分支  : ${repo.default_branch}`);
console.log(`  Star/Fork : ${repo.stargazers_count} / ${repo.forks_count}`);
console.log(`  描述      : ${repo.description || '(空)'}`);
console.log(`  License   : ${repo.license?.spdx_id || '(未识别)'}`);
console.log(`  创建时间  : ${repo.created_at}`);

console.log('\n=== 2. 提交历史 ===');
const commits = await api(`/repos/${OWNER}/${REPO}/commits?sha=${BRANCH}&per_page=20`);
for (const c of commits) {
  console.log(`  ${c.sha.slice(0, 8)}  ${c.commit.author?.date?.slice(0, 16)}  ${c.commit.message.split('\n')[0]}`);
}

console.log('\n=== 3. 远程文件清单 ===');
const tree = await api(`/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`);
const remote = tree.tree.filter((t) => t.type === 'blob');
console.log(`  远程文件数: ${remote.length}`);

const files = execFileSync('git', ['ls-files', '-z'], { cwd: proj, encoding: 'utf8' })
  .split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/'));
console.log(`  本地文件数: ${files.length}`);

const remotePaths = new Set(remote.map((r) => r.path));
const missing = files.filter((f) => !remotePaths.has(f));
const extra = [...remotePaths].filter((p) => !files.includes(p));
console.log(`  缺失      : ${missing.length ? missing.join(', ') : '无'}`);
console.log(`  多余      : ${extra.length ? extra.join(', ') : '无'}`);

console.log('\n=== 4. 逐字节内容比对（抽样 + 关键文件）===');
// 关键文件全比；其余抽样
const critical = [
  'README.md', 'LICENSE', 'BUILD.md', 'PUSH.md', 'CONTRACT.md', '使用手册.md',
  'app/src/main/AndroidManifest.xml',
  'app/src/main/java/com/pickupcode/app/core/PickupParser.kt',
  'app/src/main/java/com/pickupcode/app/ui/MainActivity.kt',
  'tools/node/extract.mjs', 'tools/node/samples.json',
  'package.json', 'settings.gradle.kts', 'app/build.gradle.kts',
  '.gitattributes', '.gitignore', 'gradlew', 'gradlew.bat',
  'gradle/wrapper/gradle-wrapper.properties',
];
const rest = files.filter((f) => !critical.includes(f));
const sample = [];
for (let i = 0; i < rest.length; i += Math.max(1, Math.floor(rest.length / 25))) sample.push(rest[i]);
const toCheck = [...critical.filter((f) => files.includes(f)), ...sample];

let same = 0, diff = 0;
const problems = [];
for (const rel of toCheck) {
  if (!remotePaths.has(rel)) { problems.push(`${rel}: 远程不存在`); diff++; continue; }
  const local = readFileSync(path.join(proj, rel));
  let remoteBuf;
  try {
    remoteBuf = await api(`/repos/${OWNER}/${REPO}/contents/${encodeURI(rel)}?ref=${BRANCH}`, { raw: true });
  } catch (e) { problems.push(`${rel}: 拉取失败 ${e.message}`); diff++; continue; }

  if (Buffer.compare(local, remoteBuf) === 0) { same++; continue; }

  // 允许的差异：CRLF/LF 归一后相同
  const norm = (b) => b.toString('utf8').replace(/\r\n/g, '\n');
  if (norm(local) === norm(remoteBuf)) {
    same++;
    continue;
  }
  diff++;
  problems.push(`${rel}: 内容不同（本地 ${sha256(local)} / 远程 ${sha256(remoteBuf)}，${local.length} vs ${remoteBuf.length} 字节）`);
}
console.log(`  比对 ${toCheck.length} 个文件：一致 ${same}，不一致 ${diff}`);
for (const p of problems) console.log(`  ✗ ${p}`);

console.log('\n=== 5. workflow 文件 ===');
try {
  const wf = await api(`/repos/${OWNER}/${REPO}/contents/.github/workflows/build-apk.yml?ref=${BRANCH}`, { raw: true });
  const localWf = readFileSync(path.join(proj, '.github/workflows/build-apk.yml'));
  const eq = Buffer.compare(localWf, wf) === 0
    || localWf.toString().replace(/\r\n/g, '\n') === wf.toString().replace(/\r\n/g, '\n');
  console.log(`  已上传，${wf.length} 字节，与本地${eq ? '一致 ✓' : '不一致 ✗'}`);
} catch (e) {
  console.log(`  未上传（${e.message}）—— Actions 不会触发`);
}

console.log('\n=== 6. README 渲染检查 ===');
const readme = (await api(`/repos/${OWNER}/${REPO}/contents/README.md?ref=${BRANCH}`, { raw: true })).toString('utf8');
const checks = [
  ['标题', /^#\s+取件码管家/m.test(readme)],
  ['无本机路径', !/Wangxinyu|C:\\\\Users|192\.168\.1\./.test(readme)],
  ['有许可证段', /## License/.test(readme)],
  ['有致谢段', /## 致谢/.test(readme)],
  ['引用了 BUILD.md', /BUILD\.md/.test(readme)],
  ['引用了 使用手册.md', /使用手册\.md/.test(readme)],
  ['相对链接可用（无绝对 file://）', !/file:\/\//.test(readme)],
];
for (const [name, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${name}`);
// 检查 README 里引用的相对文件是否都存在
const refs = [...readme.matchAll(/\]\(([^)#][^)]*)\)/g)]
  .map((m) => m[1]).filter((u) => !/^https?:/.test(u));
console.log('  README 引用的相对路径:');
for (const r of [...new Set(refs)]) {
  const clean = r.replace(/^\.\//, '').split('#')[0];
  console.log(`    ${remotePaths.has(clean) ? '✓' : '✗'} ${r}`);
}

console.log('\n=== 7. token 是否仍然有效 ===');
if (!TOKEN) {
  console.log('  （未提供 token，跳过）');
} else {
  try {
    const me = await api('/user');
    console.log(`  ⚠️ token 仍然有效（身份 ${me.login}）—— 建议尽快删除`);
  } catch {
    console.log('  ✓ token 已失效或已被删除');
  }
}

console.log('\n=== 8. Actions 工作流状态 ===');
try {
  const runs = await api(`/repos/${OWNER}/${REPO}/actions/runs?per_page=5`);
  if (!runs.workflow_runs.length) console.log('  还没有任何运行记录（workflow 未上传，或不曾触发）');
  else for (const r of runs.workflow_runs) console.log(`  ${r.name}  ${r.status}/${r.conclusion}  ${r.created_at}`);
} catch (e) {
  console.log(`  查询失败: ${e.message}`);
}
