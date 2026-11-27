/* 记账本 · 账单解析 + 三层分类引擎（纯函数，无 DOM） */
'use strict';

/* ================= 分类体系 ================= */
const CATEGORIES = ['餐饮', '交通', '购物', '居家', '通讯', '娱乐', '医疗健康', '教育学习', '人情往来', '其他'];
const CAT_COLORS = {
  '餐饮': '#f5a524', '交通': '#5b9dff', '购物': '#7c6cff', '居家': '#3dd68c',
  '通讯': '#4dd0c4', '娱乐': '#f07178', '医疗健康': '#ff8f6b', '教育学习': '#9d8cff',
  '人情往来': '#e06bf0', '其他': '#8b9bb0'
};

/* ================= 编码 / ZIP ================= */

/** ArrayBuffer → 文本：UTF-8（严格）优先，失败回退 GBK。返回 {text, encoding} */
function decodeBytes(buf) {
  const bytes = new Uint8Array(buf);
  // 去 BOM
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) start = 3;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start)), encoding: 'utf-8' };
  } catch (e) {
    try {
      return { text: new TextDecoder('gbk').decode(bytes.subarray(start)), encoding: 'gbk' };
    } catch (e2) {
      return { text: new TextDecoder('utf-8').decode(bytes.subarray(start)), encoding: 'utf-8?' };
    }
  }
}

function isZip(buf) {
  const b = new Uint8Array(buf);
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04;
}

/** 极简 zip 读取：返回 [{name, bytes}]（只取 stored / deflate） */
async function unzipEntries(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  // 找中央目录末记录 EOCD
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i > u8.length - 22 - 65536; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 结构无法识别');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder('utf-8').decode(u8.subarray(off + 46, off + 46 + nameLen));
    // 本地头：跳过本地头取数据
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = u8.subarray(dataStart, dataStart + compSize);
    entries.push({ name: name, method: method, data: data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  const out = [];
  for (const en of entries) {
    if (en.name.endsWith('/')) continue; // 目录
    let bytes;
    if (en.method === 0) {
      bytes = en.data;
    } else if (en.method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('no-deflate');
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([en.data]).stream().pipeThrough(ds);
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      continue;
    }
    out.push({ name: en.name, bytes: bytes });
  }
  return out;
}

/** 从 zip 里挑账单文件（csv/txt 优先）；失败返回 null */
function pickBillFromEntries(entries) {
  return entries.find(e => /\.(csv|txt)$/i.test(e.name)) ||
    entries.find(e => /\.(xls|xlsx)$/i.test(e.name)) || null;
}

/** 真 xlsx 包判定：zip 里含 xl/workbook.xml */
function isXLSXPkg(entries) {
  return entries.some(e => e.name === 'xl/workbook.xml');
}

/* ================= XLSX（真 Excel） ================= */

function xmlUnescape(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&'); // &amp; 必须最后替换
}

/** xlsx entries → 二维数组（sharedStrings + sheet XML，正则解析） */
function parseXLSXRows(entries) {
  const byName = {};
  entries.forEach(e => { byName[e.name] = e.bytes; });

  // 共享字符串表：<si> 里可能有多个 <t>（富文本 runs），拼接
  const shared = [];
  const ssXml = byName['xl/sharedStrings.xml'];
  if (ssXml) {
    const xml = new TextDecoder('utf-8').decode(ssXml);
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(xml))) {
      let s = '';
      const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      let tm;
      while ((tm = tRe.exec(m[1]))) s += xmlUnescape(tm[1]);
      shared.push(s);
    }
  }

  // 找第一个有数据的工作表
  const sheetNames = Object.keys(byName)
    .filter(n => /^xl\/worksheets\/[^/]+\.xml$/i.test(n)).sort();
  for (const sn of sheetNames) {
    const xml = new TextDecoder('utf-8').decode(byName[sn]);
    const rows = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml))) {
      const cells = [];
      const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      while ((cm = cRe.exec(rm[1]))) {
        const attrs = cm[1], body = cm[2] || '';
        // 列位置：r="BC12" → 列索引（无 r 属性则顺延）
        let idx = cells.length;
        const ref = attrs.match(/\br="([A-Z]+)\d+"/);
        if (ref) {
          idx = 0;
          for (const ch of ref[1]) idx = idx * 26 + (ch.charCodeAt(0) - 64);
          idx -= 1;
        }
        const tAttr = (attrs.match(/\bt="(\w+)"/) || [])[1];
        let val = '';
        if (tAttr === 's') { // 共享字符串
          const v = body.match(/<v>([\s\S]*?)<\/v>/);
          val = v ? (shared[parseInt(v[1], 10)] || '') : '';
        } else if (tAttr === 'inlineStr') {
          const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
          let tm;
          while ((tm = tRe.exec(body))) val += xmlUnescape(tm[1]);
        } else { // 数值 / 公式字符串
          const v = body.match(/<v>([\s\S]*?)<\/v>/);
          val = v ? xmlUnescape(v[1]) : '';
        }
        while (cells.length < idx) cells.push('');
        cells[idx] = val;
      }
      if (cells.some(c => String(c).trim() !== '')) rows.push(cells);
    }
    if (rows.length) return rows;
  }
  return [];
}

/** 真二进制 .xls（OLE 复合文档，Excel 97-2003）判定 */
function isOLE(buf) {
  const b = new Uint8Array(buf);
  return b.length > 8 && b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0;
}

/* ================= CSV ================= */

/** RFC4180 风格 CSV → 二维数组 */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  // 统一换行；去掉尾部空行
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
      else field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

/** HTML 表格伪 xls（支付宝邮件常见）→ 二维数组 */
function parseHTMLTable(text) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const table = doc.querySelector('table');
  if (!table) return null;
  const rows = [];
  table.querySelectorAll('tr').forEach(tr => {
    const cells = [];
    tr.querySelectorAll('td,th').forEach(td => cells.push(td.textContent.trim()));
    if (cells.some(c => c)) rows.push(cells);
  });
  return rows.length ? rows : null;
}

/* ================= 来源识别 / 表头匹配 ================= */

function detectSource(text) {
  const head = text.slice(0, 2000);
  if (/微信支付|WeChat\s*Pay/i.test(head)) return 'wechat';
  if (/支付宝|Alipay/i.test(head)) return 'alipay';
  // 列名特征回退（账单导出文件没带品牌名时，如 HTML 表格 xls）
  if (/交易单号/.test(head) && /当前状态/.test(head)) return 'wechat';
  if (/交易创建时间|付款时间/.test(head) && /交易对方|商品名称/.test(head)) return 'alipay';
  return null;
}

const FIELD_ALIASES = {
  wechat: {
    time: ['交易时间'],
    payee: ['交易对方', '收款方'],
    item: ['商品'],
    dir: ['收/支'],
    amount: ['金额(元)', '金额（元）', '金额'],
    method: ['支付方式'],
    status: ['当前状态', '交易状态'],
    txId: ['交易单号', '商户单号'],
    note: ['备注']
  },
  alipay: {
    time: ['付款时间', '交易创建时间', '交易时间'],
    payee: ['交易对方', '收款方'],
    item: ['商品名称', '商品'],
    dir: ['收/支'],
    amount: ['金额（元）', '金额(元)', '金额'],
    method: ['支付方式', '资金渠道'],
    status: ['交易状态', '当前状态'],
    txId: ['交易号', '商户订单号'],
    note: ['备注']
  }
};

/** 在行数组里找表头行：命中 ≥2 个已知列名。返回 {headerRow, map:{field→colIdx}} 或 null */
function findHeaderRow(rows, aliases) {
  const fields = Object.keys(aliases);
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = rows[i].map(c => String(c).trim());
    const map = {};
    let hits = 0;
    fields.forEach(f => {
      for (let c = 0; c < cells.length; c++) {
        if (aliases[f].some(a => cells[c] === a || cells[c].replace(/\s/g, '') === a)) {
          map[f] = c;
          hits++;
          break;
        }
      }
    });
    if (hits >= 2 && map.time != null && map.amount != null) {
      return { headerRow: i, map: map, headerCells: cells };
    }
  }
  return null;
}

/* ================= 行规整 ================= */

function parseAmountCell(s) {
  const n = parseFloat(String(s || '').replace(/[¥￥,，\s]/g, ''));
  return isNaN(n) ? null : Math.abs(n);
}

/** Excel 日期序列号（1899-12-30 起算）→ {date, time}，UTC 换算防时区漂移 */
function excelSerialToDT(serial) {
  const pad = x => String(x).padStart(2, '0');
  const days = Math.floor(serial);
  let mins = Math.round((serial - days) * 1440);
  const d = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
  if (mins >= 1440) { mins -= 1440; d.setUTCDate(d.getUTCDate() + 1); }
  return {
    date: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()),
    time: pad(Math.floor(mins / 60)) + ':' + pad(mins % 60)
  };
}

function parseTimeCell(s) {
  const raw = String(s || '').trim();
  // xlsx 日期列常见：Excel 序列号（如 46353.4744）
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const serial = parseFloat(raw);
    if (serial > 20000 && serial < 80000) return excelSerialToDT(serial);
  }
  const m = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const pad = x => String(x).padStart(2, '0');
  return {
    date: m[1] + '-' + pad(m[2]) + '-' + pad(m[3]),
    time: m[4] != null ? pad(m[4]) + ':' + pad(m[5]) : ''
  };
}

function normalizeDirection(s) {
  const t = String(s || '').trim();
  if (/支出|付款/.test(t)) return 'out';
  if (/收入|收款|退款/.test(t)) return 'in';
  return ''; // 不计收支 / 空
}

const SKIP_STATUS = /交易关闭|交易失败|等待付款|已全额退款|关闭/;

/**
 * 用 map 把一行规整成交易草稿。
 * 返回 null 表示该行应跳过（状态过滤 / 金额解析失败）。
 */
function normalizeRow(cells, map, source) {
  const get = f => map[f] != null ? String(cells[map[f]] || '').trim() : '';
  const t = parseTimeCell(get('time'));
  const amount = parseAmountCell(get('amount'));
  if (!t || amount == null || amount === 0) return null;
  const status = get('status');
  if (status && SKIP_STATUS.test(status)) return null;
  let dir = normalizeDirection(get('dir'));
  if (!dir) {
    if (map.dir == null) dir = 'out'; // 未映射收/支列 → 默认支出
    else return null;                 // 映射了但值为 不计收支/空：跳过
  }
  const payee = get('payee') || get('item') || '未知收款方';
  return {
    date: t.date,
    time: t.time,
    payee: payee,
    item: get('item'),
    amount: amount,
    direction: dir,
    source: source,
    srcTxId: get('txId') || '',
    method: get('method') || '',
    status: status || '',
    note: get('note') || ''
  };
}

/** 轻量指纹（无单号时去重用） */
function txFingerprint(t) {
  return 'fp:' + t.date + '|' + t.payee + '|' + t.amount.toFixed(2) + '|' + t.direction;
}

function txDedupeKey(t) {
  return (t.source && t.srcTxId) ? (t.source + ':' + t.srcTxId) : txFingerprint(t);
}

/* ================= 主解析入口 ================= */

/**
 * 解析一个账单文件（ArrayBuffer）。
 * 返回 {ok:true, source, encoding, rows:[草稿], needsMapping:false, sample, headerCells}
 * 或 {ok:false, error} 或 {ok:false, needsMapping:true, rows, sampleRows, source}
 */
async function parseBillFile(buffer, fileName) {
  let raw = buffer;
  let fromZip = '';
  let xlsxRows = null;

  if (isZip(buffer)) {
    try {
      const entries = await unzipEntries(buffer);
      if (isXLSXPkg(entries)) {
        // 直接拖进来的 .xlsx
        xlsxRows = parseXLSXRows(entries);
      } else {
        const pick = pickBillFromEntries(entries);
        if (!pick) return { ok: false, error: 'zip 里没有找到 csv/txt 账单文件' };
        raw = pick.bytes.buffer.slice(pick.bytes.byteOffset, pick.bytes.byteOffset + pick.bytes.byteLength);
        fromZip = pick.name;
        if (isZip(raw)) {
          // zip 里装着 .xlsx
          xlsxRows = parseXLSXRows(await unzipEntries(raw));
        }
      }
    } catch (e) {
      const msg = String(e.message || e);
      if (msg === 'no-deflate') return { ok: false, error: '浏览器不支持解压 zip，请先手动解压再把 CSV 拖进来' };
      return { ok: false, error: 'zip 解析失败：' + msg };
    }
  } else if (isOLE(raw)) {
    return {
      ok: false,
      error: '这是 Excel 97-2003 二进制 .xls，浏览器无法直接解析。请用 Excel/WPS 打开后另存为 CSV 或 .xlsx 再导入'
    };
  }

  let text, rows, encLabel;
  if (xlsxRows) {
    rows = xlsxRows;
    encLabel = 'xlsx';
    text = rows.slice(0, 25).map(r => r.join(',')).join('\n'); // 供来源识别
    if (!rows.length) return { ok: false, error: 'xlsx 里没有找到数据行' };
  } else {
    const dec = decodeBytes(raw);
    text = dec.text;
    encLabel = dec.encoding;
    // 伪 xls：HTML 表格
    if (/^\s*</.test(text) && /<table/i.test(text)) {
      rows = parseHTMLTable(text);
      if (!rows) return { ok: false, error: 'HTML 表格解析失败' };
    } else {
      rows = parseCSV(text);
    }
    if (!rows.length) return { ok: false, error: '文件是空的' };
  }

  const source = detectSource(text);
  const aliases = source ? FIELD_ALIASES[source] : null;

  if (source) {
    const found = findHeaderRow(rows, aliases);
    if (found) {
      const drafts = [];
      for (let i = found.headerRow + 1; i < rows.length; i++) {
        const t = normalizeRow(rows[i], found.map, source);
        if (t) drafts.push(t);
      }
      return {
        ok: true, source: source, encoding: encLabel, fromZip: fromZip,
        rows: drafts, needsMapping: false, headerCells: found.headerCells
      };
    }
    // 有来源但表头没认出来 → 手动映射
    return {
      ok: false, needsMapping: true, source: source, encoding: encLabel,
      rows: rows, sampleRows: rows.slice(0, 8), fromZip: fromZip
    };
  }

  // 完全未知来源 → 手动映射（source 记 'other'）
  return {
    ok: false, needsMapping: true, source: 'other', encoding: encLabel,
    rows: rows, sampleRows: rows.slice(0, 8), fromZip: fromZip
  };
}

/** 手动映射提交后：用用户给的 {field: colIdx} 规整全部行 */
function parseWithMapping(rows, map, source) {
  const drafts = [];
  for (let i = 0; i < rows.length; i++) {
    const t = normalizeRow(rows[i], map, source || 'other');
    if (t) drafts.push(t);
  }
  return drafts;
}

/* ================= 三层分类引擎 ================= */

function normalizePayee(p) {
  return String(p || '').trim().replace(/\s+/g, ' ');
}

/**
 * Layer 1：最长关键词包含匹配。
 * keywords: [{kw, category, sub?, match?}]
 */
function ruleClassify(payee, keywords) {
  const p = normalizePayee(payee);
  let best = null;
  (keywords || []).forEach(r => {
    const kw = String(r.kw || '').trim();
    if (!kw) return;
    if (p.indexOf(kw) >= 0) {
      if (!best || kw.length > best.kw.length) best = r;
    }
  });
  return best;
}

/**
 * Layer 3：时段 + 金额形态启发式（只建议，永不自动确认）
 * 返回 {category, reason, confidence} 或 null
 */
function heuristicSuggest(t) {
  const hour = parseInt((t.time || '12:00').slice(0, 2), 10) || 12;
  const amt = +t.amount || 0;
  const day = parseInt(t.date.slice(8, 10), 10) || 1;
  const payee = normalizePayee(t.payee);
  // 个人收款方形态：2-4 个中文字符（名字），且不像店名
  const personalLike = /^[一-龥]{2,4}$/.test(payee) && !/店|公司|官方|商行|超市|药|馆|铺/.test(payee);

  if (t.direction === 'in') {
    return { category: '人情往来', reason: '收入/退款行', confidence: 'low' };
  }
  // 整数金额 + 个人收款方 → 红包/转账
  if (personalLike && amt >= 50 && amt % 100 === 0 && amt <= 2000) {
    return { category: '人情往来', reason: '整数金额转给个人，像红包/转账', confidence: 'low' };
  }
  if (personalLike && amt >= 500) {
    return { category: '人情往来', reason: '较大金额转给个人', confidence: 'low' };
  }
  // 月初大额 → 房租/居家
  if (day <= 5 && amt >= 1000) {
    return { category: '居家', reason: '月初大额支出，像房租/水电', confidence: 'low' };
  }
  // 用餐时段
  if (hour >= 6 && hour < 10 && amt >= 3 && amt <= 40) {
    return { category: '餐饮', reason: '早餐时段 ¥3–40', confidence: 'med' };
  }
  if (hour >= 11 && hour < 14 && amt >= 8 && amt <= 60) {
    return { category: '餐饮', reason: '午餐时段 ¥8–60', confidence: 'med' };
  }
  if (hour >= 17 && hour < 21 && amt >= 12 && amt <= 120) {
    return { category: '餐饮', reason: '晚餐时段 ¥12–120', confidence: 'med' };
  }
  if (hour >= 21 && amt >= 8 && amt <= 50) {
    return { category: '娱乐', reason: '夜间小额支出', confidence: 'low' };
  }
  return null;
}

/**
 * 三层分类：memory → rule → heuristic。
 * mem: {payee: {category,...}}  keywords: [{kw,category,sub?}]
 * 返回 {category, catSource, catConfidence, reason}
 */
function classifyTx(t, keywords, mem) {
  const payee = normalizePayee(t.payee);
  // Layer 2 收款方记忆（最优先）
  const m = mem && mem[payee];
  if (m && m.category) {
    return { category: m.category, catSource: 'memory', catConfidence: 1, reason: '记住的收款方' };
  }
  // Layer 1 关键词
  const hit = ruleClassify(payee, keywords);
  if (hit) {
    return {
      category: hit.category, catSource: 'rule', catConfidence: 0.9,
      reason: '关键词「' + hit.kw + '」' + (hit.sub ? '·' + hit.sub : '')
    };
  }
  // Layer 3 启发式
  const h = heuristicSuggest(t);
  if (h) {
    return { category: h.category, catSource: 'heuristic', catConfidence: h.confidence === 'med' ? 0.5 : 0.3, reason: h.reason };
  }
  return { category: '其他', catSource: 'unclassified', catConfidence: 0, reason: '' };
}
