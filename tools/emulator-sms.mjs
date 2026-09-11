// 通过模拟器控制台（telnet 协议）真正发一条短信给模拟器。
//
// 为什么不用 `content insert`：adb shell 会把参数再交给 Android 的 sh 解析一次，
// 中文短信里的括号/分号很容易被吃掉，且插数据库也没走真实的短信广播链路。
// 控制台的 `sms send` 会触发系统的 SMS_RECEIVED 广播 —— 和真机收短信完全一致，
// 能真正验证 SmsReceiver → PickupParser → PickupStore 这条链路。
//
// 用法： node tools/emulator-sms.mjs <号码> <内容>
import { connect } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// 5554 是控制台端口，5555 是 adb —— 别连错（连 5555 会因为不是行协议而一直等不到 OK）
const consolePort = Number(process.env.EMU_CONSOLE_PORT || 5554);
const [from, ...rest] = process.argv.slice(2);
const text = rest.join(' ');
if (!from || !text) {
  console.error('用法: node tools/emulator-sms.mjs <发件号码> <短信内容>');
  process.exit(2);
}

/** 模拟器控制台的认证 token（首次运行模拟器时随机生成） */
function authToken() {
  for (const p of [
    path.join(homedir(), '.emulator_console_auth_token'),
    path.join(process.env.TC_ROOT || '', '.emulator_console_auth_token'),
  ]) {
    if (p && existsSync(p)) return readFileSync(p, 'utf8').trim();
  }
  return null;
}

console.log(`连接模拟器控制台 127.0.0.1:${consolePort} ...`);

const sock = connect(consolePort, '127.0.0.1');
let buf = '';
let stage = 'auth';   // auth -> send -> done

const finish = (code) => {
  try { sock.end(); } catch { /* ignore */ }
  setTimeout(() => process.exit(code), 50);
};

sock.setTimeout(15000, () => {
  console.error(`控制台无响应（超时）。当前缓冲: ${JSON.stringify(buf.slice(-200))}`);
  finish(1);
});

sock.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  const recent = buf.slice(-300);

  if (stage === 'auth' && /(^|\n)OK\r?\n/.test(buf)) {
    const token = authToken();
    if (token) {
      console.log('  认证中…');
      sock.write(`auth ${token}\n`);
    }
    buf = '';
    stage = 'authenticated';
    return;
  }

  if (stage === 'authenticated' && /(^|\n)OK\r?\n/.test(buf)) {
    // 带空格的文本要用引号包住。
    // `-a` 指定字母表：不带它时控制台可能绕过 PDU 解析，
    // 带上更接近真机收到的短信（会走完整 SMS_RECEIVED 广播路径）。
    const cmd = `sms send -a ${from} "${text}"\n`;
    console.log(`  发送: sms send -a ${from} "${text}"`);
    sock.write(cmd);
    buf = '';
    stage = 'send';
    return;
  }

  if (stage === 'send' && /(^|\n)OK\r?\n/.test(buf)) {
    console.log('  OK — 短信已投递（应触发 SMS_RECEIVED 广播）');
    finish(0);
    return;
  }

  if (/\bKO\b|ERROR|authentication failed/i.test(buf)) {
    console.error('  控制台返回错误: ' + buf.trim());
    finish(1);
  }
});

sock.on('error', (e) => {
  console.error(`连接失败: ${e.message}`);
  console.error('提示：模拟器是否在跑？控制台端口默认 5554。');
  finish(1);
});
