/**
 * 取件码解析核心 — 离线语料回归测试
 *
 * 用法： node tools/node/run-tests.mjs [samples.json]
 * 输出（契约 7.1）：
 *   TOTAL n  PASS x  FAIL y
 *   FAIL: <id> 期望 code=..., 实得 [<codes>]
 * 退出码 0 = 全过，1 = 有失败。
 *
 * 比对口径：
 *   - codes：顺序无关，按 normalize 后的集合比对（空串 "" 是 3.6「有取件但没解析出码」
 *     的合法结果，与「完全没有取件通知」的 [] 区分开）
 *   - courier / station：仅当 expect 里给出该字段时才比对（严格相等）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extract, normalize } from './extract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 固定事件时间，保证 expireAt 可复现（2024-06-15 12:00:00 本地时间） */
const FIXED_TIME = new Date(2024, 5, 15, 12, 0, 0, 0).getTime();

/** 顺序无关、normalize 后去重集合（保留空串，代表 3.6 的「需人工确认」条目） */
function codeSet(codes) {
  return [...new Set((codes || []).map((c) => normalize(c)))].sort();
}

function sameSet(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * 跑一遍语料，返回 { total, pass, fail, failures, lines }。
 * 导出成函数是为了让 tools/pre-push.mjs 能在**同进程**里调用
 * （本机沙箱禁止 node 再 spawn node）。
 */
export function runCorpus(samplesPath) {
  const p = samplesPath ? path.resolve(samplesPath) : path.join(here, 'samples.json');
  const samples = JSON.parse(readFileSync(p, 'utf8'));

  let pass = 0;
  let fail = 0;
  const failures = [];

  for (const s of samples) {
    const expect = s.expect || {};
    const items = extract(s.text, s.source || 'sms', FIXED_TIME, s.sourceApp || null);
    const gotCodes = items.map((it) => it.code);
    const problems = [];

    const want = codeSet(expect.codes);
    const got = codeSet(gotCodes);
    if (!sameSet(want, got)) {
      problems.push(`期望 code=[${(expect.codes || []).join(', ')}], 实得 [${gotCodes.join(', ')}]`);
    }

    if (expect.courier !== undefined) {
      const c = items.length ? items[0].courier : null;
      if ((c ?? null) !== (expect.courier ?? null)) problems.push(`期望 courier=${expect.courier}, 实得 ${c}`);
    }

    if (expect.station !== undefined) {
      const st = items.length ? items[0].station : null;
      if ((st ?? null) !== (expect.station ?? null)) problems.push(`期望 station=${expect.station}, 实得 ${st}`);
    }

    if (problems.length === 0) pass += 1;
    else {
      fail += 1;
      failures.push({ id: s.id, problems, text: s.text, gotCodes });
    }
  }

  const lines = [`TOTAL ${samples.length}  PASS ${pass}  FAIL ${fail}`];
  for (const f of failures) for (const pr of f.problems) lines.push(`FAIL: ${f.id} ${pr}`);
  if (failures.length) {
    lines.push('', '--- 失败明细 ---');
    for (const f of failures) {
      lines.push(`[${f.id}] ${f.text}`, `   ${f.problems.join(' | ')}`);
    }
  }
  return { total: samples.length, pass, fail, failures, lines, ok: fail === 0 };
}

// 仅当被直接执行时才打印并设置退出码（被 import 时不打扰调用方）
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const r = runCorpus(process.argv[2]);
  for (const l of r.lines) console.log(l);
  process.exit(r.ok ? 0 : 1);
}
