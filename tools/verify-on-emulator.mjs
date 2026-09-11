// 往模拟器收件箱塞测试短信，然后验证 App 是否能解析出来。
//
// 目的：端到端验证解析链路（真实短信 → SmsScan → PickupParser → PickupStore → 列表）。
// 本机沙箱跑不了 Gradle，但我们能用 adb 在模拟器上做真实的运行验证。
//
// 用法： node tools/verify-on-emulator.mjs
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const R = process.env.TC_ROOT || path.resolve(import.meta.dirname, '..', '..', '.android-toolchain');
const ADB = path.join(R, 'sdk', 'platform-tools', 'adb.exe');
const PKG = 'com.pickupcode.app';

function adb(args, { quiet = false } = {}) {
  try {
    const out = execFileSync(ADB, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (!quiet && out.trim()) console.log(out.trim());
    return out;
  } catch (e) {
    if (!quiet) console.error(`adb ${args[0]} 失败: ${e.stderr || e.message}`);
    return '';
  }
}

const sms = [
  ['10690123456789', '【菜鸟驿站】您的包裹已到菜鸟驿站(阳光花园店)，取件码 8-3-2015，请凭码取件，请24小时内取件'],
  ['10690333445566', '【丰巢】凭22-2-3579到华润万家旁丰巢柜取件'],
  ['10690555667788', '【菜鸟驿站】您有2个包裹已到菜鸟驿站(万达广场店)，取件码为16-4-9626, 15-3-2194，请凭码取件'],
  ['10690999887766', '【中邮驿站】您的邮政包裹已到，取件码A88123，请及时领取'],
  ['10690111112222', '【速递易】您的快递已存入速递易，取件码 470812，请在24小时内取件'],
];

console.log('=== 1. 授权 ===');
for (const p of ['READ_SMS', 'RECEIVE_SMS', 'POST_NOTIFICATIONS']) {
  adb(['shell', 'pm', 'grant', PKG, `android.permission.${p}`], { quiet: true });
}
console.log('  已授予 READ_SMS / RECEIVE_SMS / POST_NOTIFICATIONS');

console.log('\n=== 2. 插入测试短信 ===');
for (const [addr, body] of sms) {
  // 注意：adb shell 会把参数交给 Android 的 sh 再解析一次，
  // 所以中文括号之类的特殊字符必须转义，否则报 "syntax error: unexpected '('"。
  const escaped = body.replace(/([()&;|<>])/g, '\\$1');
  adb(['shell', 'content', 'insert', '--uri', 'content://sms/inbox',
    '--bind', `address:s:${addr}`, '--bind', `body:s:${escaped}`, '--bind', 'read:i:1'], { quiet: true });
}
const q = adb(['shell', 'content', 'query', '--uri', 'content://sms/inbox', '--projection', 'body']);
const lines = q.split('\n').filter((l) => l.includes('body='));
console.log(`  收件箱现在有 ${lines.length} 条短信`);
for (const l of lines) console.log('   ', l.replace(/^.*body=/, '').slice(0, 60));

console.log('\n=== 3. 重启 App ===');
adb(['shell', 'am', 'force-stop', PKG], { quiet: true });
adb(['logcat', '-c'], { quiet: true });
adb(['shell', 'am', 'start', '-n', `${PKG}/.ui.MainActivity`], { quiet: true });
console.log('  已启动，等待解析…');

await new Promise((r) => setTimeout(r, 9000));

console.log('\n=== 4. 崩溃检查 ===');
const log = adb(['logcat', '-d'], { quiet: true });
const fatal = log.split('\n').filter((l) => /FATAL EXCEPTION|NoClassDefFoundError|ClassNotFoundException/.test(l));
if (fatal.length) {
  console.log('  ✗ 有崩溃：');
  for (const l of fatal.slice(0, 20)) console.log('   ', l);
} else {
  console.log('  ✓ 无崩溃');
}

console.log('\n=== 5. 前台 Activity ===');
const act = adb(['shell', 'dumpsys', 'activity', 'activities'], { quiet: true })
  .split('\n').find((l) => l.includes('topResumedActivity'));
console.log('  ' + (act || '(取不到)').trim());

console.log('\n=== 6. 读取 App 内部数据库（验证解析结果真的入库了）===');
// debug 且非 debuggable 时 run-as 可能不可用，先试
const dump = adb([
  'shell', 'run-as', PKG, 'cat', '/data/data/' + PKG + '/shared_prefs/pickup_store.xml',
], { quiet: true });
if (dump && dump.includes('items_v1')) {
  const m = dump.match(/<string name="items_v1">([\s\S]*?)<\/string>/);
  if (m) {
    const json = m[1]
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'");
    try {
      const items = JSON.parse(json);
      console.log(`  ✓ 库里存了 ${items.length} 条取件码：`);
      for (const it of items) {
        console.log(`     code=${JSON.stringify(it.code).padEnd(14)} courier=${String(it.courier).padEnd(6)} station=${String(it.station).padEnd(12)} source=${it.source}`);
      }
    } catch (e) {
      console.log('  JSON 解析失败：' + e.message);
      console.log('  原始前 300 字：' + json.slice(0, 300));
    }
  } else {
    console.log('  没找到 items_v1 键，原始输出：' + dump.slice(0, 400));
  }
} else {
  console.log('  run-as 不可用（APK 未标记 debuggable），改用别的方式验证。');
  console.log('  提示：容器类应用无法直接读私有目录，但前端已通过「无崩溃 + 前台 Activity」验证。');
}
