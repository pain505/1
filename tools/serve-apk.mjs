// 局域网 APK 下载服务 + 二维码。
//
// 为什么用它：手机扫码直接下 APK，比"传到微信再打开"少两步，而且**文件不经过任何第三方**
// （全部在你自己的局域网里）。AI 操作不了微信 GUI，这是最接近"帮你送到手机"的做法。
//
// 用法： node tools/serve-apk.mjs [port]
//   启动后：桌面生成 apk-qr.png，手机扫码即可下载安装。
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { qrPng } from './qr.mjs';

const proj = path.resolve(import.meta.dirname, '..');
const APK = path.join(proj, 'pickup-code-debug.apk');
const PORT = Number(process.argv[2] || 8080);

if (!existsSync(APK)) {
  console.error(`找不到 APK：${APK}\n先跑 node tools/build-manual.mjs`);
  process.exit(2);
}
const apkBuf = readFileSync(APK);
const apkSize = statSync(APK).size;
const apkName = path.basename(APK);

/** 找一个局域网 IPv4 地址（跳过回环、链路本地、虚拟网卡 198.18.x） */
function lanIp() {
  const cands = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      if (a.address.startsWith('198.18.')) continue; // Meta/虚拟网卡
      cands.push({ name, address: a.address });
    }
  }
  // 优先常见家用网段
  const prefer = cands.find((c) => /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(c.address));
  return prefer || cands[0] || { name: 'loopback', address: '127.0.0.1' };
}

const { name: ifName, address: ip } = lanIp();
const url = `http://${ip}:${PORT}/${apkName}`;

const page = (u, size) => `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>下载 取件码管家</title>
<style>
  body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
       margin:0;padding:28px 20px;background:#f5f6f8;color:#1b1e23;text-align:center}
  .card{max-width:520px;margin:0 auto;background:#fff;border-radius:16px;
        padding:26px 22px;box-shadow:0 2px 14px rgba(0,0,0,.08)}
  h1{font-size:21px;margin:0 0 6px}
  .sub{color:#666;font-size:14px;margin-bottom:20px}
  img{width:100%;max-width:320px;height:auto;image-rendering:pixelated}
  a.btn{display:inline-block;margin-top:20px;padding:15px 30px;background:#2b6cb0;color:#fff;
        border-radius:10px;text-decoration:none;font-size:17px;font-weight:600}
  .meta{margin-top:18px;color:#888;font-size:13px;line-height:1.7}
  code{background:#f0f1f3;padding:2px 6px;border-radius:4px;font-size:12px;word-break:break-all}
  ol{text-align:left;color:#444;font-size:14px;line-height:1.9;padding-left:20px;margin:18px 0 0}
</style></head><body>
<div class="card">
  <h1>取件码管家</h1>
  <div class="sub">扫码下载 APK · ${(size / 1024).toFixed(0)} KB</div>
  <img src="/qr.png" alt="下载二维码">
  <a class="btn" href="/${apkName}" download>直接下载 APK</a>
  <ol>
    <li>点上面的按钮下载（或在手机浏览器打开本页）</li>
    <li>下载完成后点开这个 apk 文件</li>
    <li>系统提示时允许「安装未知来源应用」</li>
    <li>打开 App，授予短信权限 + 开启通知使用权</li>
  </ol>
  <div class="meta">
    地址：<code>${u}</code><br>
    文件不经过任何第三方，全部在你自己的局域网内传输。
  </div>
</div></body></html>`;

const qrPngBuf = qrPng(url, { scale: 7, quiet: 3 });
const qrPath = path.join(proj, 'apk-qr.png');
writeFileSync(qrPath, qrPngBuf);

const server = createServer((req, res) => {
  const u = (req.url || '/').split('?')[0];
  if (u === '/' || u === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(url, apkSize));
    return;
  }
  if (u === '/qr.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': qrPngBuf.length });
    res.end(qrPngBuf);
    return;
  }
  if (u === `/${apkName}` || u === '/apk') {
    console.log(`  -> ${req.socket.remoteAddress} 正在下载 ${apkName}`);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': apkBuf.length,
      'Content-Disposition': `attachment; filename="${apkName}"`,
    });
    res.end(apkBuf);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  取件码管家 — 局域网下载服务已启动');
  console.log('  ─────────────────────────────────────');
  console.log(`  网卡    : ${ifName}`);
  console.log(`  手机访问: ${url}`);
  console.log(`  桌面打开: http://127.0.0.1:${PORT}/`);
  console.log(`  二维码  : ${qrPath}`);
  console.log('');
  console.log('  手机连同一个 WiFi 后：');
  console.log('    · 扫码，或');
  console.log('    · 浏览器打开上面的「手机访问」地址');
  console.log('');
  console.log('  首次启动 Windows 可能弹防火墙提示，请点「允许」');
  console.log('  （只在专用/家庭网络放行即可，不需要公用网络）。');
  console.log('');
  console.log('  按 Ctrl+C 停止。');
});
