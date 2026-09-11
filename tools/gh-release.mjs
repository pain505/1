// 给仓库补上描述、话题（topics），并创建 Release 把 APK 挂上去。
//
// 用法： $env:GH_TOKEN='...'; node tools/gh-release.mjs <owner> <repo> <apk路径> [tag] [标题]
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const [OWNER, REPO, APK, TAG = 'v1.0.0', TITLE = '取件码管家 v1.0.0'] = process.argv.slice(2);
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) { console.error('缺少 GH_TOKEN'); process.exit(2); }
if (!OWNER || !REPO || !APK) {
  console.error('用法: node tools/gh-release.mjs <owner> <repo> <apk> [tag] [title]');
  process.exit(2);
}
const API = 'https://api.github.com';
const repoApi = `/repos/${OWNER}/${REPO}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, url, body, extraHeaders = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url.startsWith('http') ? url : API + url, {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'pickup-code-release',
          ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}),
          ...extraHeaders,
        },
        body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* */ }
      if (res.ok) return json;
      if ([404, 429, 500, 502, 503, 504].includes(res.status) && i < tries - 1) { await sleep(2000); continue; }
      const e = new Error(`${method} ${url} -> ${res.status}: ${json?.message || text.slice(0, 200)}`);
      e.status = res.status; e.json = json; throw e;
    } catch (e) {
      if (e.status && ![404, 429, 500, 502, 503, 504].includes(e.status)) throw e;
      if (i === tries - 1) throw e;
      await sleep(2000);
    }
  }
}

// ---------------------------------------------------------------- 1. 仓库信息

console.log('=== 1. 补全仓库信息 ===');
const DESCRIPTION = '取件码管家 —— 把快递短信、App 通知、微信里的取件码自动汇总成一张清单。'
  + '纯本地解析，未申请 INTERNET 权限。Android / Kotlin / 零第三方依赖。';

const TOPICS = [
  'android', 'kotlin', 'sms', 'notification-listener', 'privacy',
  'offline-first', 'no-dependencies', 'pickup-code', 'chinese', 'express-delivery',
];

const repo = await req('PATCH', repoApi, {
  description: DESCRIPTION,
  homepage: '',
  has_issues: true,
  has_wiki: false,
  has_projects: false,
});
console.log(`  描述已写入`);

// topics 用的是另一个媒体类型
try {
  await req('PUT', `${repoApi}/topics`, { names: TOPICS }, { Accept: 'application/vnd.github.mercy-preview+json' });
  console.log(`  话题已写入: ${TOPICS.join(', ')}`);
} catch (e) {
  console.log(`  话题写入失败（不影响其他）: ${e.message}`);
}

// ---------------------------------------------------------------- 2. 创建 Release

console.log('\n=== 2. 创建 Release ===');
const apkPath = path.resolve(APK);
const apkBuf = readFileSync(apkPath);
const apkName = path.basename(apkPath);
console.log(`  APK: ${apkName}  ${(apkBuf.length / 1024).toFixed(0)} KB`);

const NOTES = `### 功能

- **自动汇总取件码**：短信一到就自动识别并入库，按取件点分组展示，带过期倒计时
- **支持多种真实码形**：\`8-3-2015\`、\`5-5-9-13\`、\`A88123\`、\`H-01485\`、\`109-6-4006\`、\`470812\`
- **监听购物 App 通知**：拼多多 / 淘宝 / 京东 / 支付宝 / 菜鸟 / 微信
- **分享与粘贴导入**：应对微信、支付宝小程序没有开放接口的情况
- **纯本地解析**：App **没有申请 INTERNET 权限**，物理上无法联网；零第三方依赖

### 安装

1. 下载本 Release 里附带的 \`pickup-code-debug.apk\`，传到手机
2. 点开安装，系统提示时允许「安装未知来源应用」
3. 打开 App：**允许读取短信** → **开启通知使用权** → **电池策略设为「不受限制」**

> 通知使用权的路径：设置 → 通知 → 通知使用权 → 打开「取件码管家」
> （各品牌路径不同，见仓库里的 \`使用手册.md\`）

### 说明

- 这是 **debug 签名**的包，仅供自用侧载
- \`RECEIVE_SMS\` / \`READ_SMS\` 是 Google Play 的受限权限（只对默认短信应用开放），
  所以本应用**不能上架商店**
- 请只在自己的手机上解析自己的快递短信

### 验证情况

- 解析规则：**105 条**真实风格语料回归（含 22 条必须拒收的负样本）
- Kotlin 与 Node 两版实现的正则逐条自动比对
- 在 Android 14 模拟器上完成端到端验证：短信广播自动入库、多码与字母码正确提取、
  银行验证码正确拒收、UI 分组渲染正常、无崩溃
`;

let release = null;
try {
  release = await req('GET', `${repoApi}/releases/tags/${TAG}`);
  console.log(`  Release ${TAG} 已存在，跳过创建`);
} catch (e) {
  if (e.status !== 404) throw e;
  release = await req('POST', `${repoApi}/releases`, {
    tag_name: TAG,
    target_commitish: 'main',
    name: TITLE,
    body: NOTES,
    draft: false,
    prerelease: false,
  });
  console.log(`  已创建: ${release.html_url}`);
}

// ---------------------------------------------------------------- 3. 上传 APK

console.log('\n=== 3. 上传 APK 到 Release ===');
const uploadUrl = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(apkName)}`;

// 已存在同名资产则先删掉（避免 422）
try {
  const assets = await req('GET', `${repoApi}/releases/${release.id}/assets`);
  for (const a of assets) {
    if (a.name === apkName) {
      await req('DELETE', `${repoApi}/releases/assets/${a.id}`);
      console.log(`  删除同名旧资产 ${a.name}`);
    }
  }
} catch { /* ignore */ }

const asset = await req('POST', uploadUrl, apkBuf, {
  'Content-Type': 'application/vnd.android.package-archive',
});
console.log(`  已上传: ${asset.name}  ${(asset.size / 1024).toFixed(0)} KB`);
console.log(`  下载地址: ${asset.browser_download_url}`);

// ---------------------------------------------------------------- 4. 复核

console.log('\n=== 4. 复核 ===');
const finalRepo = await req('GET', repoApi);
console.log(`  仓库: ${finalRepo.html_url}`);
console.log(`  描述: ${finalRepo.description}`);
console.log(`  topics: ${(finalRepo.topics || []).join(', ') || '(无)'}`);
const rel = await req('GET', `${repoApi}/releases/tags/${TAG}`);
console.log(`  Release: ${rel.html_url}  (${rel.tag_name}, ${rel.assets.length} 个资产)`);
for (const a of rel.assets) console.log(`    - ${a.name}  ${(a.size / 1024).toFixed(0)} KB  下载数 ${a.download_count}`);
