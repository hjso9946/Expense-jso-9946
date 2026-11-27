/* 记账本 · 主逻辑（数据默认全在 localStorage、零外域请求；云同步为可选，默认关闭） */
'use strict';

const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const LS_TX = 'exp_tx_v1';
const LS_MEM = 'exp_mem_v1';
const LS_RULES = 'exp_rules_v1';
const LS_BUDGET = 'exp_budget_v1';
const LS_DEL = 'exp_del_v1';
const LS_MAP = 'exp_map_v1';
const LS_META = 'exp_meta_v1';
const LS_SYNC = 'exp_sync_v1';
const LS_SYNC_STATE = 'exp_sync_state_v1';
/* 云同步默认关闭：不开启就零外网请求、数据只存本机。
   开启后账目只进你自己的【私有】数据仓库（Expense-data），绝不进公开代码仓库。 */
const SYNC_DEFAULT = {
  owner: 'hjso9946',
  repo: 'Expense-data',
  path: 'sync.json',
  token: '',
  enabled: false
};

/* ---------- 基础工具 ---------- */
function $(s, el) { return (el || document).querySelector(s); }
function $all(s, el) { return Array.from((el || document).querySelectorAll(s)); }

function toast(m) {
  let t = $('#toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = m;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 1800);
}

function weekdayOf(ds) {
  try { return WD[new Date(ds + 'T12:00:00').getDay()]; } catch (e) { return ''; }
}
function fmtDate(ds) { return (ds || '') + ' ' + weekdayOf(ds); }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function thisMonth() { return todayISO().slice(0, 7); }
function monthShift(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
function uid(p) { return (p || 'x') + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function fmtMoney(n) {
  const v = Math.round((+n || 0) * 100) / 100;
  return (v % 1 === 0) ? String(v) : v.toFixed(2);
}

/* ---------- 存储层 ---------- */
function loadLS(key, def) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v == null ? def : v;
  } catch (e) { return def; }
}
function saveLS(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); }
  catch (e) { toast('存储失败（可能超出容量），请先导出备份'); }
}

function loadTx() { const a = loadLS(LS_TX, []); return Array.isArray(a) ? a : []; }
function saveTx(list) { saveLS(LS_TX, list); schedulePush(); }

function loadMem() { return loadLS(LS_MEM, {}); }
function saveMem(m) { saveLS(LS_MEM, m); schedulePush(); }

function loadRules() { return loadLS(LS_RULES, { version: 0, keywords: [] }); }
function saveRules(r) { saveLS(LS_RULES, r); schedulePush(); }

function loadBudget() { return loadLS(LS_BUDGET, { default: 3000, months: {} }); }
function saveBudget(b) { saveLS(LS_BUDGET, b); schedulePush(); }

function loadDeletes() { return loadLS(LS_DEL, {}); }
function saveDeletes(d) { saveLS(LS_DEL, d); schedulePush(); }
function markDeleted(key) {
  if (!key) return;
  const d = loadDeletes();
  d[key] = new Date().toISOString();
  saveDeletes(d);
}
function gcDeletes() {
  const d = loadDeletes();
  const cutoff = Date.now() - 30 * 86400000;
  let changed = false;
  Object.keys(d).forEach(k => {
    const t = Date.parse(d[k] || '') || 0;
    if (t && t < cutoff) { delete d[k]; changed = true; }
  });
  if (changed) saveDeletes(d);
}
function txDelKey(id) { return 't:' + id; }

function loadMap() { return loadLS(LS_MAP, {}); }
function saveMap(m) { saveLS(LS_MAP, m); schedulePush(); }

function loadMeta() { return loadLS(LS_META, {}); }
function saveMeta(m) { saveLS(LS_META, m); schedulePush(); }

function loadCats() { const a = loadLS('exp_cats_v1', []); return Array.isArray(a) ? a : []; }
function saveCats(a) { saveLS('exp_cats_v1', a); schedulePush(); }
/** 内置 + 自定义分类 */
function allCategories() { return CATEGORIES.concat(loadCats()); }
/** 分类配色：内置取 CAT_COLORS，自定义按名称散列到调色板（稳定不变） */
const CAT_PALETTE = ['#ffd166', '#06d6a0', '#118ab2', '#ef476f', '#f4a261', '#2ec4b6', '#9b5de5', '#f15bb5'];
function catColor(c) {
  if (CAT_COLORS[c]) return CAT_COLORS[c];
  let h = 0;
  for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) >>> 0;
  return CAT_PALETTE[h % CAT_PALETTE.length];
}

function trainOn() { return loadMeta().train !== false; }

/* 训练：记住收款方分类 */
function trainPayee(payee, category) {
  const p = normalizePayee(payee);
  if (!p || !category || category === '其他') return;
  const mem = loadMem();
  const cur = mem[p] || { count: 0 };
  mem[p] = {
    category: category,
    count: (cur.count || 0) + 1,
    lastSeen: todayISO(),
    origin: 'manual'
  };
  saveMem(mem);
}

/* ---------- 规则种子合并 ---------- */
async function mergeSeedRules() {
  let seed = null;
  try {
    const res = await fetch('rules.json', { cache: 'no-store' });
    if (res.ok) seed = await res.json();
  } catch (e) { /* file:// 或离线：改用内嵌种子 */ }
  if (!seed && window.RULES_SEED) seed = window.RULES_SEED;
  if (!seed) return;
  const cur = loadRules();
  if (seed.version > (cur.version || 0)) {
    saveRules({ version: seed.version, updated: seed.updated || '', keywords: seed.keywords || [] });
  } else if (!cur.keywords || !cur.keywords.length) {
    saveRules({ version: seed.version || 1, updated: seed.updated || '', keywords: seed.keywords || [] });
  }
}

/* ---------- Tab 切换 ---------- */
function initTabs() {
  const tabs = $('#tabs');
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-t]');
    if (!btn) return;
    $all('#tabs button').forEach(b => b.classList.toggle('on', b === btn));
    $all('.tab-pane').forEach(p => { p.hidden = true; });
    const pane = $('#tab-' + btn.dataset.t);
    if (pane) pane.hidden = false;
    if (btn.dataset.t === 'list') renderList();
    if (btn.dataset.t === 'queue') renderQueue();
    if (btn.dataset.t === 'stats') renderStats();
    if (btn.dataset.t === 'add' && !editingId) resetForm();
  });
}
function switchTab(name) {
  const btn = $('#tabs button[data-t="' + name + '"]');
  if (btn) btn.click();
}

/* ---------- 明细列表 ---------- */
let listFilterCat = '';
function initList() {
  $('#listMonth').value = thisMonth();
  $('#btnThisMonth').onclick = () => { $('#listMonth').value = thisMonth(); renderList(); };
  $('#listMonth').onchange = renderList;
  $('#listSearch').oninput = renderList;

  renderListCatChips();
}

function renderListCatChips() {
  const chipHost = $('#listCatChips');
  chipHost.innerHTML = '';
  const mk = (label, val) => {
    const b = document.createElement('button');
    b.className = 'chip' + (val === listFilterCat ? ' on' : '');
    b.textContent = label;
    b.onclick = () => { listFilterCat = val; renderListCatChips(); renderList(); };
    chipHost.appendChild(b);
  };
  mk('全部', '');
  allCategories().forEach(c => mk(c, c));
}

/** 分类集变化后刷新所有依赖分类的 UI（列表 chips / 记账下拉） */
function refreshCatUIs() {
  renderListCatChips();
  const sel = $('#fCat');
  if (sel) {
    const cur = sel.value;
    fillCatSelect(sel, allCategories().indexOf(cur) >= 0 ? cur : '其他');
  }
}

function txSortDesc(a, b) {
  const ka = a.date + ' ' + (a.time || '');
  const kb = b.date + ' ' + (b.time || '');
  return kb.localeCompare(ka);
}

function filteredTx() {
  const ym = $('#listMonth').value || thisMonth();
  const q = ($('#listSearch').value || '').trim().toLowerCase();
  return loadTx().filter(t => {
    if (t.date.slice(0, 7) !== ym) return false;
    if (listFilterCat && t.category !== listFilterCat) return false;
    if (q && (t.payee + ' ' + (t.note || '') + ' ' + (t.item || '')).toLowerCase().indexOf(q) < 0) return false;
    return true;
  }).sort(txSortDesc);
}

function catChip(cat) {
  const color = catColor(cat);
  return '<span class="cat-chip" style="color:' + color + ';border-color:' + color + '55;background:' + color + '1c">' + cat + '</span>';
}

function renderList() {
  renderListSummary();
  const list = filteredTx();
  const host = $('#listBody');
  if (!list.length) {
    host.innerHTML = '<div class="empty">这个月还没有记录<br/>「记一笔」手动记，或「导入」微信/支付宝账单</div>';
    return;
  }
  // 按日期分组
  const groups = {};
  list.forEach(t => { (groups[t.date] = groups[t.date] || []).push(t); });
  const dates = Object.keys(groups).sort().reverse();
  let html = '';
  dates.forEach(d => {
    const items = groups[d];
    const dayOut = items.filter(t => t.direction === 'out').reduce((s, t) => s + t.amount, 0);
    const dayIn = items.filter(t => t.direction === 'in').reduce((s, t) => s + t.amount, 0);
    html += '<div class="day-head"><span>' + fmtDate(d) + '</span><span class="day-sum">支 ' + fmtMoney(dayOut) +
      (dayIn ? ' · 收 ' + fmtMoney(dayIn) : '') + '</span></div>';
    items.forEach(t => {
      html += '<div class="tx-row" data-id="' + t.id + '">' +
        '<div class="tx-main">' +
        '<div class="tx-payee">' + esc(t.payee) + (t.item && t.item !== t.payee ? '<span class="tx-item">' + esc(t.item) + '</span>' : '') + '</div>' +
        '<div class="tx-meta">' + (t.time || '') + catChip(t.category || '其他') + srcBadge(t.source) + '</div>' +
        '</div>' +
        '<div class="tx-amt ' + (t.direction === 'in' ? 'in' : '') + '">' + (t.direction === 'in' ? '+' : '-') + fmtMoney(t.amount) + '</div>' +
        '<button class="del" data-act="edit" title="编辑">✎</button>' +
        '<button class="del" data-act="del" title="删除">✕</button>' +
        '</div>';
    });
  });
  host.innerHTML = html;
  host.onclick = (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('.tx-row');
    const id = row && row.dataset.id;
    if (!id) return;
    if (btn.dataset.act === 'edit') startEdit(id);
    if (btn.dataset.act === 'del') deleteTx(id);
  };
}

/** 明细页 · 分类小计卡：所选分类当月总计 + 近 6 个月月趋势（listFilterCat='' 表示全部） */
function renderListSummary() {
  const ym = $('#listMonth').value || thisMonth();
  const cat = listFilterCat;
  const inScope = t => t.date.slice(0, 7) === ym && (!cat || t.category === cat);
  const rows = loadTx().filter(inScope);
  const out = rows.filter(t => t.direction === 'out');
  const inc = rows.filter(t => t.direction === 'in');
  const total = out.reduce((s, t) => s + t.amount, 0);
  const totalIn = inc.reduce((s, t) => s + t.amount, 0);

  $('#sumCat').innerHTML = (cat ? catChip(cat) : '<span style="color:#8b9bb0">全部分类</span>') +
    ' <span style="color:#8b9bb0">· ' + ym + '</span>';

  // 当月小计：总计 / 笔数 / 笔均 / 日均（口径同统计页：当月已过天数）
  const today = todayISO();
  const daysPassed = (ym === today.slice(0, 7)) ? (+today.slice(8)) : daysInMonth(ym);
  const avgDay = daysPassed ? total / daysPassed : 0;
  const avgTx = out.length ? total / out.length : 0;
  $('#sumTotal').textContent = fmtMoney(total);
  $('#sumSub').textContent = out.length + ' 笔 · 笔均 ' + fmtMoney(Math.round(avgTx * 100) / 100) +
    ' · 日均 ' + fmtMoney(Math.round(avgDay * 100) / 100) +
    (totalIn ? ' · 收入 ' + fmtMoney(totalIn) : '');

  // 近 6 个月该分类（或全部）月度支出趋势
  // 窗口锚定：选中月在「当前月往前 6 个月内」时窗口固定贴当前月（点柱切换时柱子不移位），否则窗口跟随选中月
  const nowYm = thisMonth();
  const windowEnd = (ym >= monthShift(nowYm, -5) && ym <= nowYm) ? nowYm : ym;
  const series = [];
  for (let k = 5; k >= 0; k--) {
    const m = monthShift(windowEnd, -k);
    const mo = loadTx().filter(t => t.date.slice(0, 7) === m && t.direction === 'out' &&
      (!cat || t.category === cat)).reduce((s, t) => s + t.amount, 0);
    series.push({ label: m.slice(2), v: mo, m: m });
  }
  let selIdx = series.findIndex(s => s.m === ym);
  if (selIdx < 0) selIdx = series.length - 1;
  drawBars($('#catTrendBars'), series, {
    height: 160,
    showVals: true,
    colorFn: (x, i) => i === selIdx ? (cat ? catColor(cat) : '#5b9dff') : 'rgba(91,157,255,.35)',
    onClick: (i, item) => {
      if (item && item.m && item.m !== ym) {
        $('#listMonth').value = item.m;
        renderList();
      }
    }
  });
  $('#sumTrendVals').textContent = '近 6 个月月趋势 · 点柱子切换月份';

  // 环比（同口径上月）
  const prevYm = monthShift(ym, -1);
  const prevTotal = loadTx().filter(t => t.date.slice(0, 7) === prevYm && t.direction === 'out' &&
    (!cat || t.category === cat)).reduce((s, t) => s + t.amount, 0);
  const momEl = $('#sumMom');
  if (prevTotal > 0) {
    const delta = Math.round((total - prevTotal) / prevTotal * 100);
    let txt = '环比上月 ' + fmtMoney(prevTotal) + '：' + (delta >= 0 ? '+' : '') + delta + '%';
    if (cat) {
      const monthOut = loadTx().filter(t => t.date.slice(0, 7) === ym && t.direction === 'out')
        .reduce((s, t) => s + t.amount, 0);
      txt += monthOut ? '（占本月总支出 ' + Math.round(total / monthOut * 100) + '%）' : '';
    }
    momEl.textContent = txt;
    momEl.style.color = delta <= 0 ? '#3dd68c' : '#f07178';
  } else {
    momEl.textContent = '上月无数据';
    momEl.style.color = '#8b9bb0';
  }
}

function srcBadge(s) {
  const map = { wechat: ['微信', '#3dd68c'], alipay: ['支付宝', '#5b9dff'], manual: ['手动', '#8b9bb0'], other: ['导入', '#f5a524'] };
  const m = map[s] || map.other;
  return '<span class="src-chip" style="color:' + m[1] + '">' + m[0] + '</span>';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function deleteTx(id) {
  const t = loadTx().find(x => x.id === id);
  if (!t) return;
  if (!confirm('删除这笔「' + t.payee + ' -' + fmtMoney(t.amount) + '」？')) return;
  saveTx(loadTx().filter(x => x.id !== id));
  markDeleted(txDelKey(id));
  renderList();
  toast('已删除');
}

/* ---------- 记一笔 / 编辑 ---------- */
let editingId = null;
let formDir = 'out';

function fillCatSelect(sel, val) {
  sel.innerHTML = '';
  allCategories().forEach(c => {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    if (c === val) o.selected = true;
    sel.appendChild(o);
  });
}

function resetForm() {
  editingId = null;
  formDir = 'out';
  $('#formTitle').textContent = '记一笔';
  $all('#dirSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === 'out'));
  $('#fAmount').value = '';
  $('#fPayee').value = '';
  $('#fItem').value = '';
  $('#fDate').value = todayISO();
  $('#fTime').value = new Date().toTimeString().slice(0, 5);
  fillCatSelect($('#fCat'), '餐饮');
  $('#fNote').value = '';
  $('#fTrain').checked = true;
  $('#btnCancelEdit').hidden = true;
}

function startEdit(id) {
  const t = loadTx().find(x => x.id === id);
  if (!t) return;
  editingId = id;
  formDir = t.direction;
  switchTab('add');
  $('#formTitle').textContent = '编辑记录';
  $all('#dirSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === t.direction));
  $('#fAmount').value = t.amount;
  $('#fPayee').value = t.payee;
  $('#fItem').value = t.item || '';
  $('#fDate').value = t.date;
  $('#fTime').value = t.time || '';
  fillCatSelect($('#fCat'), t.category || '其他');
  $('#fNote').value = t.note || '';
  $('#fTrain').checked = true;
  $('#btnCancelEdit').hidden = false;
}

function initForm() {
  fillCatSelect($('#fCat'), '餐饮');
  $('#dirSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    formDir = b.dataset.v;
    $all('#dirSeg button').forEach(x => x.classList.toggle('on', x === b));
  });
  $('#btnCancelEdit').onclick = () => { resetForm(); switchTab('list'); };
  $('#btnSave').onclick = () => {
    const amount = parseFloat($('#fAmount').value);
    if (!(amount > 0)) { toast('请填金额'); return; }
    const payee = $('#fPayee').value.trim() || '未知收款方';
    const cat = $('#fCat').value;
    const now = Date.now();
    if (editingId) {
      const list = loadTx();
      const i = list.findIndex(x => x.id === editingId);
      if (i >= 0) {
        const oldCat = list[i].category;
        list[i] = Object.assign({}, list[i], {
          amount: amount, payee: payee, item: $('#fItem').value.trim(),
          date: $('#fDate').value || todayISO(), time: $('#fTime').value || '',
          direction: formDir, category: cat, note: $('#fNote').value.trim(),
          catSource: 'manual', updatedAt: now
        });
        if (cat !== oldCat && $('#fTrain').checked && trainOn()) trainPayee(payee, cat);
        saveTx(list);
        toast('已保存修改');
      }
    } else {
      const t = {
        id: uid('m'), date: $('#fDate').value || todayISO(), time: $('#fTime').value || '',
        payee: payee, item: $('#fItem').value.trim(), amount: amount, direction: formDir,
        category: cat, catSource: 'manual', catConfidence: 1,
        note: $('#fNote').value.trim(), source: 'manual', srcTxId: '',
        method: '', status: '', importBatch: '', createdAt: now, updatedAt: now
      };
      saveTx(loadTx().concat([t]));
      if ($('#fTrain').checked && trainOn()) trainPayee(payee, cat);
      toast('已记一笔');
    }
    resetForm();
    switchTab('list');
  };
}

/* ---------- 导入 ---------- */
let pendingRows = [];   // 待提交草稿（含分类结果）
let pendingMapCtx = null; // 手动映射上下文

function initImport() {
  const dz = $('#dropZone');
  const fi = $('#fileInput');
  $('#btnPick').onclick = () => fi.click();
  fi.onchange = () => { handleFiles(fi.files); fi.value = ''; };
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    handleFiles(e.dataTransfer.files);
  });
  $('#btnCommit').onclick = commitImport;
  $('#btnMapOk').onclick = commitMapping;
  $('#btnUndoImport').onclick = undoLastImport;
  refreshUndoBtn();
}

function refreshUndoBtn() {
  const meta = loadMeta();
  $('#btnUndoImport').hidden = !meta.lastBatch;
}

async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  let allRows = [];
  let infos = [];
  for (const f of files) {
    try {
      const buf = await f.arrayBuffer();
      const res = await parseBillFile(buf, f.name);
      if (res.needsMapping) {
        // 之前手动映射过同来源 → 自动套用
        const saved = loadMap()[res.source];
        if (saved && saved.time != null && saved.amount != null) {
          const rows = parseWithMapping(res.rows, saved, res.source);
          if (rows.length) {
            infos.push(f.name + '（' + sourceName(res.source) + ' · 已套用保存的列映射）→ ' + rows.length + ' 笔');
            allRows = allRows.concat(rows);
            continue;
          }
        }
        showMappingUI(res, f.name);
        return; // 映射完成后继续
      }
      if (!res.ok) { toast(f.name + '：' + res.error); continue; }
      infos.push(f.name + '（' + sourceName(res.source) + ' · ' + res.encoding +
        (res.fromZip ? ' · zip:' + res.fromZip : '') + '）→ ' + res.rows.length + ' 笔');
      allRows = allRows.concat(res.rows);
    } catch (e) {
      toast(f.name + ' 解析失败：' + (e.message || e));
    }
  }
  if (!allRows.length) { $('#importInfo').textContent = infos.join('；') || '没有解析到记录'; return; }
  $('#importInfo').textContent = infos.join('；');
  preparePreview(allRows);
}

function sourceName(s) {
  return { wechat: '微信', alipay: '支付宝', other: '未知来源', manual: '手动' }[s] || s;
}

function preparePreview(rows) {
  const mem = loadMem();
  const rules = loadRules();
  const existing = new Set(loadTx().map(txDedupeKey));
  const del = loadDeletes();
  pendingRows = [];
  let dup = 0;
  rows.forEach(t => {
    const key = txDedupeKey(t);
    if (existing.has(key) || del[txDelKey(t.id)]) { dup++; return; }
    const cls = classifyTx(t, rules.keywords, mem);
    pendingRows.push(Object.assign({}, t, {
      category: cls.category, catSource: cls.catSource,
      catConfidence: cls.catConfidence, reason: cls.reason
    }));
  });
  $('#pvDupNote').textContent = dup ? ('已自动跳过 ' + dup + ' 笔重复记录') : '';
  renderPreview();
}

function renderPreview() {
  const box = $('#previewBox');
  box.hidden = false;
  $('#pvCount').textContent = pendingRows.length;
  const host = $('#pvRows');
  host.innerHTML = pendingRows.map((t, i) => {
    return '<div class="pv-row" data-i="' + i + '">' +
      '<div class="tx-main">' +
      '<div class="tx-payee">' + esc(t.payee) + '</div>' +
      '<div class="tx-meta">' + t.date + ' ' + (t.time || '') + ' · ' + sourceName(t.source) +
      (t.reason ? ' · <span class="reason">' + esc(t.reason) + '</span>' : '') + '</div>' +
      '</div>' +
      '<div class="tx-amt' + (t.direction === 'in' ? ' in' : '') + '">' + (t.direction === 'in' ? '+' : '-') + fmtMoney(t.amount) + '</div>' +
      '<select class="pv-cat">' + allCategories().map(c =>
        '<option value="' + c + '"' + (c === t.category ? ' selected' : '') + '>' + c + '</option>').join('') +
      '</select>' +
      '<label class="train-row small"><input type="checkbox" class="pv-train" checked/>记住</label>' +
      '</div>';
  }).join('') || '<div class="empty">没有可导入的记录</div>';

  host.onchange = (e) => {
    const row = e.target.closest('.pv-row');
    if (!row) return;
    const i = +row.dataset.i;
    if (e.target.classList.contains('pv-cat')) {
      pendingRows[i].userCat = e.target.value;
      pendingRows[i].userTrain = $('.pv-train', row).checked;
    }
    if (e.target.classList.contains('pv-train')) {
      pendingRows[i].userTrain = e.target.checked;
    }
  };
}

function commitImport() {
  if (!pendingRows.length) { toast('没有可导入的记录'); return; }
  const batch = 'b' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const now = Date.now();
  const list = loadTx();
  pendingRows.forEach(t => {
    let category = t.category, catSource = t.catSource;
    if (t.userCat && t.userCat !== t.category) {
      category = t.userCat;
      catSource = 'manual';
    }
    const rec = {
      id: t.id || uid('w'),
      date: t.date, time: t.time, payee: t.payee, item: t.item,
      amount: t.amount, direction: t.direction,
      category: category, catSource: catSource, catConfidence: t.catConfidence || 0,
      note: t.note, source: t.source, srcTxId: t.srcTxId,
      method: t.method, status: t.status,
      importBatch: batch, createdAt: now, updatedAt: now
    };
    list.push(rec);
    const wantsTrain = t.userTrain !== false;
    if ((catSource === 'manual' || t.userCat) && wantsTrain && trainOn()) {
      trainPayee(rec.payee, category);
    }
  });
  saveTx(list);
  const meta = loadMeta();
  meta.lastBatch = batch;
  saveMeta(meta);
  pendingRows = [];
  $('#previewBox').hidden = true;
  $('#importInfo').textContent = '已导入 ' + list.filter(t => t.importBatch === batch).length + ' 笔（批次 ' + batch + '）';
  refreshUndoBtn();
  toast('导入完成');
  switchTab('list');
}

function undoLastImport() {
  const meta = loadMeta();
  if (!meta.lastBatch) return;
  if (!confirm('撤销上次导入（批次 ' + meta.lastBatch + '）的全部记录？')) return;
  const batch = meta.lastBatch;
  const list = loadTx();
  const keep = [];
  list.forEach(t => {
    if (t.importBatch === batch) markDeleted(txDelKey(t.id));
    else keep.push(t);
  });
  saveTx(keep);
  meta.lastBatch = '';
  saveMeta(meta);
  refreshUndoBtn();
  renderList();
  toast('已撤销该次导入');
}

/* 手动列映射 UI */
function showMappingUI(res, fileName) {
  pendingMapCtx = res;
  const box = $('#mapBox');
  box.hidden = false;
  $('#previewBox').hidden = true;
  $('#importInfo').textContent = fileName + '：没认出表头（' + sourceName(res.source) + ' · ' + res.encoding + '），请手动对应列';

  // 预览前 5 行
  const sample = res.rows.slice(0, 5);
  $('#mapPreview').innerHTML = '<table><tr>' +
    sample[0].map((_, i) => '<th>列' + (i + 1) + '</th>').join('') + '</tr>' +
    sample.map(r => '<tr>' + r.map(c => '<td>' + esc(String(c).slice(0, 18)) + '</td>').join('') + '</tr>').join('') +
    '</table>';

  const fields = [
    ['time', '时间 *'], ['payee', '收款方'], ['amount', '金额 *'], ['dir', '收/支'],
    ['txId', '单号'], ['status', '状态'], ['method', '支付方式'], ['item', '商品'], ['note', '备注']
  ];
  const cols = (res.rows[0] || []).length;
  $('#mapFields').innerHTML = fields.map(([f, label]) => {
    return '<div class="field"><label>' + label + '</label><select data-f="' + f + '">' +
      '<option value="">（无）</option>' +
      Array.from({ length: cols }, (_, i) => '<option value="' + i + '">列' + (i + 1) + '</option>').join('') +
      '</select></div>';
  }).join('');
}

function commitMapping() {
  const res = pendingMapCtx;
  if (!res) return;
  const map = {};
  $all('#mapFields select').forEach(s => {
    if (s.value !== '') map[s.dataset.f] = +s.value;
  });
  if (map.time == null || map.amount == null) { toast('必须映射「时间」和「金额」'); return; }
  // 持久化映射
  const maps = loadMap();
  maps[res.source] = map;
  saveMap(maps);
  const rows = parseWithMapping(res.rows, map, res.source);
  $('#mapBox').hidden = true;
  if (!rows.length) { toast('按此映射没有解析到记录'); return; }
  preparePreview(rows);
}

/* ---------- 待分类队列 ---------- */
function queueTx() {
  return loadTx().filter(t => t.catSource === 'unclassified' || t.catSource === 'heuristic')
    .sort((a, b) => b.amount - a.amount);
}

function renderQueue() {
  const list = queueTx();
  $('#qCount').textContent = list.length;
  const host = $('#queueBody');
  if (!list.length) {
    host.innerHTML = '<div class="empty">没有待分类的记录，太棒了 🎉</div>';
    return;
  }
  host.innerHTML = list.map(t => {
    const sug = t.catSource === 'heuristic' && t.category !== '其他'
      ? '<span class="sug">建议：' + t.category + (t.reason ? '（' + esc(t.reason) + '）' : '') + '</span>'
      : '<span class="sug none">无建议</span>';
    return '<div class="q-row" data-id="' + t.id + '">' +
      '<div class="tx-main">' +
      '<div class="tx-payee">' + esc(t.payee) + '</div>' +
      '<div class="tx-meta">' + t.date + ' ' + (t.time || '') + ' · ' + fmtMoney(t.amount) + '元 ' + sug + '</div>' +
      '</div>' +
      '<select class="q-cat">' + allCategories().map(c =>
        '<option value="' + c + '"' + (c === t.category && t.catSource === 'heuristic' ? ' selected' : '') + '>' + c + '</option>').join('') +
      '</select>' +
      '<button class="chip" data-act="save">保存</button>' +
      '<button class="chip" data-act="skip">忽略</button>' +
      '</div>';
  }).join('');

  host.onclick = (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('.q-row');
    const id = row.dataset.id;
    const t = loadTx().find(x => x.id === id);
    if (!t) return;
    if (btn.dataset.act === 'save') {
      const cat = $('.q-cat', row).value;
      updateTxCategory(id, cat, true);
      // 同收款方还有待分类 → 询问是否一并归类
      const others = queueTx().filter(x => x.id !== id && x.payee === t.payee);
      if (others.length && confirm('「' + t.payee + '」还有 ' + others.length + ' 笔待分类记录，一并归入「' + cat + '」吗？')) {
        const list = loadTx();
        let n = 1;
        list.forEach(x => {
          if (x.id !== id && x.payee === t.payee && (x.catSource === 'unclassified' || x.catSource === 'heuristic')) {
            x.category = cat;
            x.catSource = 'manual';
            x.updatedAt = Date.now();
            n++;
          }
        });
        saveTx(list);
        toast('「' + t.payee + '」' + n + ' 笔已全部归入「' + cat + '」');
      }
    } else {
      // 忽略：标记为已处理（归到其他，不训练）
      updateTxCategory(id, t.category && t.catSource === 'heuristic' ? t.category : '其他', false, 'manual');
    }
    renderQueue();
  };
}

function updateTxCategory(id, cat, train, forceSource) {
  const list = loadTx();
  const i = list.findIndex(x => x.id === id);
  if (i < 0) return;
  list[i].category = cat;
  list[i].catSource = forceSource || 'manual';
  list[i].updatedAt = Date.now();
  saveTx(list);
  if (train && trainOn()) trainPayee(list[i].payee, cat);
  toast('已归类：' + cat);
}

$('#btnAcceptAll') && ($('#btnAcceptAll').onclick = () => {
  const list = loadTx();
  let n = 0;
  list.forEach(t => {
    if ((t.catSource === 'unclassified' || t.catSource === 'heuristic') && t.catSource === 'heuristic' && t.category !== '其他') {
      t.catSource = 'manual';
      t.updatedAt = Date.now();
      if (trainOn()) trainPayee(t.payee, t.category);
      n++;
    }
  });
  saveTx(list);
  toast(n ? ('已接受 ' + n + ' 条建议') : '没有可接受的建议');
  renderQueue();
});

/* ---------- 统计 ---------- */
let stSource = 'all'; // 来源筛选：all | wechat | alipay | manual | other
function monthTx(ym) {
  return loadTx().filter(t => t.date.slice(0, 7) === ym);
}
function budgetFor(ym) {
  const b = loadBudget();
  return b.months && b.months[ym] != null ? +b.months[ym] : +b.default || 0;
}

function renderStats() {
  const ym = $('#stMonth').value || thisMonth();
  $('#stMonth').value = ym;
  const allTx = monthTx(ym);
  const tx = stSource === 'all' ? allTx : allTx.filter(t => t.source === stSource);
  const out = tx.filter(t => t.direction === 'out');
  const income = tx.filter(t => t.direction === 'in');
  const total = out.reduce((s, t) => s + t.amount, 0);
  const totalIn = income.reduce((s, t) => s + t.amount, 0);
  const budget = budgetFor(ym);
  const dim = daysInMonth(ym);
  const today = todayISO();
  const daysPassed = (ym === today.slice(0, 7)) ? (+today.slice(8)) : dim;
  const avg = daysPassed ? total / daysPassed : 0;

  // 来源筛选 chips（全部 + 本月出现过的来源）
  const srcCount = {};
  allTx.forEach(t => { if (t.direction === 'out') srcCount[t.source] = (srcCount[t.source] || 0) + t.amount; });
  const srcOptions = ['all'].concat(Object.keys(srcCount).sort((a, b) => srcCount[b] - srcCount[a]));
  $('#stSrcChips').innerHTML = srcOptions.map(s => {
    const label = s === 'all' ? '全部' : sourceName(s);
    const sub = s === 'all' ? '' : ' ' + fmtMoney(srcCount[s] || 0);
    return '<button class="chip' + (stSource === s ? ' on' : '') + '" data-src="' + s + '">' + label + sub + '</button>';
  }).join('');
  $('#stSrcChips').onclick = (e) => {
    const btn = e.target.closest('button[data-src]');
    if (!btn) return;
    stSource = btn.dataset.src;
    renderStats();
  };

  $('#stTitle').textContent = ym + ' 月度统计' +
    (stSource !== 'all' ? ' · ' + sourceName(stSource) : '') +
    (totalIn ? '（收入 ' + fmtMoney(totalIn) + '）' : '');
  $('#stTotal').textContent = fmtMoney(total);
  $('#stBudget').textContent = budget ? fmtMoney(budget) : '未设置';
  $('#stAvg').textContent = fmtMoney(Math.round(avg * 100) / 100);

  // 环比
  const prev = monthTx(monthShift(ym, -1));
  const prevTotal = prev.filter(t => t.direction === 'out').reduce((s, t) => s + t.amount, 0);
  const badge = $('#stBadge');
  if (prevTotal > 0) {
    const delta = Math.round((total - prevTotal) / prevTotal * 100);
    badge.textContent = (delta >= 0 ? '环比 +' : '环比 ') + delta + '%（上月 ' + fmtMoney(prevTotal) + '）';
    badge.className = 'badge ' + (delta <= 0 ? 'ok' : delta <= 20 ? 'warn' : 'bad');
  } else {
    badge.textContent = '上月无数据';
    badge.className = 'badge';
  }

  // 预算进度
  const prog = $('#stProg');
  const note = $('#stProgNote');
  if (budget > 0) {
    const pct = Math.min(100, total / budget * 100);
    prog.style.width = pct + '%';
    prog.className = 'prog-in ' + (pct < 80 ? 'ok' : pct <= 100 ? 'warn' : 'bad');
    note.textContent = '已用 ' + Math.round(pct) + '% · ' + (total > budget ? ('超支 ' + fmtMoney(total - budget) + ' 元') : ('剩余 ' + fmtMoney(budget - total) + ' 元'));
  } else {
    prog.style.width = '0%';
    note.textContent = '未设置预算（设置里可设）';
  }

  // 每日支出柱状图
  const daily = [];
  for (let d = 1; d <= dim; d++) {
    const ds = ym + '-' + String(d).padStart(2, '0');
    const dayOut = out.filter(t => t.date === ds).reduce((s, t) => s + t.amount, 0);
    daily.push({ label: String(d), v: dayOut });
  }
  const dailyBudget = budget ? budget / dim : 0;
  drawBars($('#dayBars'), daily, { target: dailyBudget, height: 200 });

  // 分类占比 + 饼图
  const byCat = {};
  const cntCat = {};
  out.forEach(t => {
    const c = t.category || '其他';
    byCat[c] = (byCat[c] || 0) + t.amount;
    cntCat[c] = (cntCat[c] || 0) + 1;
  });
  const cats = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]);
  drawPie($('#catPie'), cats.map(c => ({
    label: c, v: byCat[c], color: catColor(c)
  })), { height: 200 });
  $('#catBreak').innerHTML = cats.length ? cats.map(c => {
    const pct = total ? byCat[c] / total * 100 : 0;
    const color = catColor(c);
    return '<div class="cb-row">' +
      '<div class="cb-label">' + catChip(c) + '</div>' +
      '<div class="cb-bar"><div class="cb-in" style="width:' + pct.toFixed(1) + '%;background:' + color + '"></div></div>' +
      '<div class="cb-val">' + fmtMoney(byCat[c]) + ' · ' + Math.round(pct) + '% · ' + cntCat[c] + '笔</div>' +
      '</div>';
  }).join('') : '<div class="empty">暂无数据</div>';

  // 近 30 天趋势
  const trend = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    const dayOut = loadTx().filter(t => t.date === ds && t.direction === 'out' &&
      (stSource === 'all' || t.source === stSource)).reduce((s, t) => s + t.amount, 0);
    trend.push({ label: ds.slice(5), v: dayOut });
  }
  drawLine($('#trendLine'), trend, { height: 200, target: dailyBudget || undefined, color: '#5b9dff', empty: '暂无数据' });

  // 近 3 个月
  const rows = [];
  for (let k = 2; k >= 0; k--) {
    const m = monthShift(ym, -k);
    const mtx = monthTx(m).filter(t => stSource === 'all' || t.source === stSource);
    const mo = mtx.filter(t => t.direction === 'out').reduce((s, t) => s + t.amount, 0);
    const mi = mtx.filter(t => t.direction === 'in').reduce((s, t) => s + t.amount, 0);
    rows.push({ m: m, out: mo, inc: mi });
  }
  $('#momBody').innerHTML = rows.map((r, i) => {
    let mom = '—';
    let cls = '';
    if (i > 0 && rows[i - 1].out > 0) {
      const delta = Math.round((r.out - rows[i - 1].out) / rows[i - 1].out * 100);
      mom = (delta >= 0 ? '+' : '') + delta + '%';
      cls = delta <= 0 ? 'ok' : 'bad';
    }
    return '<tr class="' + cls + '"><td>' + r.m + '</td><td class="num">' + fmtMoney(r.out) +
      '</td><td class="num">' + (r.inc ? fmtMoney(r.inc) : '—') + '</td><td class="num">' + mom + '</td></tr>';
  }).join('');
}

function initStats() {
  $('#stMonth').value = thisMonth();
  $('#stPrev').onclick = () => { $('#stMonth').value = monthShift($('#stMonth').value, -1); renderStats(); };
  $('#stNext').onclick = () => { $('#stMonth').value = monthShift($('#stMonth').value, 1); renderStats(); };
  $('#stMonth').onchange = renderStats;
}

/* ---------- 设置 ---------- */
function renderCatManage() {
  const custom = loadCats();
  const box = $('#catChipsBox');
  box.innerHTML = CATEGORIES.map(c =>
    '<span class="chip" style="opacity:.75;cursor:default">' + c + '</span>'
  ).join('') + custom.map(c =>
    '<span class="chip on">' + esc(c) + '<button class="cat-del" data-cat="' + esc(c) + '" title="删除分类">✕</button></span>'
  ).join('');
  box.onclick = (e) => {
    const btn = e.target.closest('button[data-cat]');
    if (!btn) return;
    const name = btn.dataset.cat;
    const used = loadTx().filter(t => t.category === name).length;
    if (!confirm('删除自定义分类「' + name + '」？' + (used ? '（有 ' + used + ' 笔记录用到它，删除后这些记录归入「其他」）' : ''))) return;
    saveCats(loadCats().filter(c => c !== name));
    if (used) {
      const list = loadTx();
      list.forEach(t => {
        if (t.category === name) { t.category = '其他'; t.updatedAt = Date.now(); }
      });
      saveTx(list);
    }
    // 记忆里指向该分类的条目一并清掉，避免复活幽灵分类
    const mem = loadMem();
    let memChanged = false;
    Object.keys(mem).forEach(k => {
      if (mem[k] && mem[k].category === name) { delete mem[k]; memChanged = true; }
    });
    if (memChanged) saveMem(mem);
    renderCatManage();
    refreshCatUIs();
    toast('已删除分类：' + name);
  };
}

/** 设置页 · 云同步状态与表单回填 */
function renderSyncUI() {
  const cfg = loadSyncCfg();
  const st = $('#syncStatus');
  if (!st) return;
  const state = getSyncState();
  if (!cfg.enabled) {
    st.textContent = '未开启 · 数据只存本机，不发任何外网请求';
    st.style.color = '';
  } else if (!cfg.token) {
    st.textContent = '已开启但缺 Token · 请填写后保存';
    st.style.color = '#f5a524';
  } else {
    let line = '已开启 · 仓库 ' + cfg.owner + '/' + cfg.repo + '（私有）';
    if (state && state.msg) line += ' · ' + state.msg;
    st.textContent = line;
    st.style.color = (state && state.state === 'err') ? '#f07178' : '#3dd68c';
  }
  $('#syncToken').value = cfg.token || '';
  $('#syncRepo').value = cfg.owner + '/' + cfg.repo;
}

function initSettings() {
  renderCatManage();
  $('#btnAddCat').onclick = () => {
    const name = ($('#newCatName').value || '').trim();
    if (!name) { toast('请输入分类名'); return; }
    if (allCategories().indexOf(name) >= 0) { toast('「' + name + '」已存在'); return; }
    saveCats(loadCats().concat([name]));
    $('#newCatName').value = '';
    renderCatManage();
    refreshCatUIs();
    toast('已添加分类：' + name);
  };
  const b = loadBudget();
  $('#setBudget').value = b.default || '';
  $('#setTrain').checked = trainOn();
  $('#setTrain').onchange = () => {
    const meta = loadMeta();
    meta.train = $('#setTrain').checked;
    saveMeta(meta);
    toast($('#setTrain').checked ? '已开启自动学习' : '已关闭自动学习');
  };
  $('#btnSaveBudget').onclick = () => {
    const nb = loadBudget();
    const v = parseFloat($('#setBudget').value);
    if (v > 0) nb.default = v;
    const bm = $('#setBudgetMonth').value;
    const bv = parseFloat($('#setBudgetMonthVal').value);
    if (bm && bv > 0) { nb.months = nb.months || {}; nb.months[bm] = bv; }
    saveBudget(nb);
    toast('预算已保存');
  };
  $('#btnReclassify').onclick = () => {
    const rules = loadRules(), mem = loadMem();
    const list = loadTx();
    let n = 0;
    list.forEach(t => {
      if (t.catSource === 'unclassified' || t.catSource === 'heuristic') {
        const cls = classifyTx(t, rules.keywords, mem);
        // 规则/记忆命中 → 直接收编；启发式 → 更新建议；仍无解 → 保留原状
        if (cls.catSource !== 'unclassified') {
          t.category = cls.category; t.catSource = cls.catSource;
          t.catConfidence = cls.catConfidence; t.reason = cls.reason;
          t.updatedAt = Date.now();
          n++;
        }
      }
    });
    saveTx(list);
    toast(n ? ('重新归类了 ' + n + ' 笔') : '没有可重新归类的记录');
    renderQueue();
  };
  $('#btnExport').onclick = exportBackup;
  $('#btnImportBackup').onclick = () => $('#backupInput').click();
  $('#backupInput').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => importBackup(String(reader.result));
    reader.readAsText(f);
    e.target.value = '';
  };
  $('#btnExportUnknown').onclick = exportUnknownPayees;
  $('#btnClear').onclick = () => {
    const syncOn = loadSyncCfg().enabled;
    if (!confirm('确定清空全部数据？此操作不可恢复（建议先导出备份）' + (syncOn ? '\n注意：开着云同步的话，云端数据之后还会同步回来。' : ''))) return;
    if (!confirm('再次确认：真的要删除所有账目、记忆和规则缓存吗？')) return;
    [LS_TX, LS_MEM, LS_RULES, LS_BUDGET, LS_DEL, LS_MAP, LS_META, 'exp_cats_v1'].forEach(k => localStorage.removeItem(k));
    location.reload();
  };

  /* 云同步 UI */
  renderSyncUI();
  window.addEventListener('exp-sync-state', renderSyncUI);
  $('#btnSyncSave').onclick = () => {
    const tok = $('#syncToken').value.trim();
    const repo = $('#syncRepo').value.trim();
    const cfg = loadSyncCfg();
    if (repo && repo.indexOf('/') > 0) {
      const p = repo.split('/');
      cfg.owner = p[0].trim();
      cfg.repo = p[1].trim();
    }
    cfg.token = tok;
    cfg.enabled = true;
    saveSyncCfg(cfg);
    renderSyncUI();
    startSyncLoop();
    syncNow(true);
  };
  $('#btnSyncNow').onclick = () => {
    const cfg = loadSyncCfg();
    if (!cfg.enabled) { toast('先保存并开启同步'); return; }
    syncNow(true);
  };
  $('#btnSyncOff').onclick = () => {
    const cfg = loadSyncCfg();
    cfg.enabled = false;
    saveSyncCfg(cfg);
    stopSyncLoop();
    renderSyncUI();
    toast('已关闭同步（数据只存本机）');
  };
}

function downloadJSON(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function exportBackup() {
  downloadJSON({
    app: 'expense-tracker', version: 1, exportedAt: new Date().toISOString(),
    data: {
      tx: loadTx(), payees: loadMem(), rules: loadRules(),
      budget: loadBudget(), deletes: loadDeletes(), mappings: loadMap(), meta: loadMeta(),
      cats: loadCats()
    }
  }, '记账备份-' + todayISO().replace(/-/g, '') + '.json');
  toast('备份已导出');
}

/** 合并删除墓碑：同一 key 取较新的删除时间（删除不会被同步/导入复活） */
function mergeDeletes(local, remote) {
  const out = Object.assign({}, local || {});
  Object.keys(remote || {}).forEach(k => {
    const a = out[k], b = remote[k];
    if (!a || (b && b > a)) out[k] = b;
  });
  return out;
}

/** 备份/云端数据合并（导入备份与云同步共用一套规则），返回新增笔数 */
function mergeBackupData(d) {
  // 先并删除墓碑，再合并数据：已删除的记录不会被带回
  if (d.deletes) saveDeletes(mergeDeletes(loadDeletes(), d.deletes));
  const del = loadDeletes();
  // 本地已有但已被删除（本机删的或云端墓碑传过来的）→ 一并剔除，删除会传播到所有设备
  const list = loadTx().filter(t => !(t && t.id && del[txDelKey(t.id)]));
  const seen = new Set(list.map(txDedupeKey));
  let added = 0;
  (d.tx || []).forEach(t => {
    if (!t) return;
    if (t.id && del[txDelKey(t.id)]) return;
    const key = txDedupeKey(t);
    if (!seen.has(key)) { seen.add(key); list.push(t); added++; }
  });
  saveTx(list);
  // 记忆合并（count 取大）
  const mem = loadMem();
  Object.keys(d.payees || {}).forEach(k => {
    const a = mem[k], b = d.payees[k];
    if (!a) mem[k] = b;
    else mem[k] = { category: b.category || a.category, count: Math.max(a.count || 0, b.count || 0), lastSeen: (b.lastSeen > a.lastSeen ? b.lastSeen : a.lastSeen), origin: 'manual' };
  });
  saveMem(mem);
  if (d.rules && d.rules.version > loadRules().version) saveRules(d.rules);
  if (d.budget) saveBudget(Object.assign(loadBudget(), d.budget));
  // 自定义分类合并（并集）
  if (Array.isArray(d.cats)) {
    const merged = loadCats();
    d.cats.forEach(c => { if (merged.indexOf(c) < 0 && CATEGORIES.indexOf(c) < 0) merged.push(c); });
    saveCats(merged);
    renderCatManage();
    refreshCatUIs();
  }
  return added;
}

function importBackup(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (e) { toast('备份文件不是有效 JSON'); return; }
  const d = doc && (doc.data || doc);
  if (!d || !Array.isArray(d.tx)) { toast('备份格式不对'); return; }
  const added = mergeBackupData(d);
  toast('导入完成：新增 ' + added + ' 笔（跳过重复）');
  renderList();
}

/* ---------- 云端同步（GitHub 私有仓库 sync.json，可选，默认关闭） ----------
   不开启：零外网请求，数据只存本机。
   开启：账目只进你自己的私有仓库（Expense-data），手机/电脑任意网络互通。 */
function loadSyncCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(LS_SYNC) || 'null');
    const cfg = Object.assign({}, SYNC_DEFAULT, c || {});
    // 安全迁移：账目绝不能进公开代码仓库，指向公开仓库的配置自动改回私有数据仓库
    if (cfg.repo === 'Expense-jso-9946' || cfg.repo === 'expense-tracker') {
      cfg.repo = 'Expense-data';
      try { localStorage.setItem(LS_SYNC, JSON.stringify(cfg)); } catch (e2) {}
    }
    return cfg;
  } catch (e) {
    return Object.assign({}, SYNC_DEFAULT);
  }
}
function saveSyncCfg(cfg) {
  localStorage.setItem(LS_SYNC, JSON.stringify(cfg));
}

function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}
function unb64utf8(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function collectCloudDoc() {
  return {
    v: 1,
    updated: new Date().toISOString(),
    data: {
      tx: loadTx(), payees: loadMem(), rules: loadRules(),
      budget: loadBudget(), deletes: loadDeletes(), mappings: loadMap(), meta: loadMeta(),
      cats: loadCats()
    }
  };
}

async function ghApi(path, opts) {
  opts = opts || {};
  const cfg = loadSyncCfg();
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (cfg.token) headers['Authorization'] = 'Bearer ' + cfg.token;
  if (opts.body) headers['Content-Type'] = 'application/json';
  return fetch('https://api.github.com' + path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store' // 必须绕开 HTTP 缓存：GET sha 若命中缓存会一直 409
  });
}

function setSyncState(state, msg) {
  localStorage.setItem(LS_SYNC_STATE, JSON.stringify({
    state: state,
    msg: msg || '',
    at: Date.now()
  }));
  window.dispatchEvent(new CustomEvent('exp-sync-state', { detail: { state, msg } }));
}
function getSyncState() {
  try { return JSON.parse(localStorage.getItem(LS_SYNC_STATE) || 'null'); } catch (e) { return null; }
}

async function syncPull(showToast) {
  const cfg = loadSyncCfg();
  const rawUrl = 'https://raw.githubusercontent.com/' + cfg.owner + '/' + cfg.repo + '/main/' + cfg.path;
  // 优先 raw；私有仓库 raw 一律 404，须退到 API 用 Token 读
  try {
    let doc = null;
    try {
      const res = await fetch(rawUrl + '?t=' + Date.now(), { cache: 'no-store' });
      if (res.ok) {
        doc = await res.json();
      } else if (res.status !== 404) {
        throw new Error('pull ' + res.status);
      }
    } catch (e) { /* raw 不可用（网络失败/私有仓库 404）：退到 API */ }
    if (doc === null) {
      const res = await ghApi('/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + cfg.path);
      if (res.status === 404) doc = null;
      else if (!res.ok) {
        const t = await res.text();
        throw new Error('pull ' + res.status + ' ' + t.slice(0, 100));
      } else {
        const meta = await res.json();
        doc = JSON.parse(unb64utf8(meta.content));
      }
    }
    if (!doc) {
      if (showToast) toast('云端还没有数据，点「立即同步」上传');
      setSyncState('empty', '云端暂无数据');
      return false;
    }
    applyCloudDoc(doc);
    setSyncState('ok', '已同步 ' + new Date().toLocaleTimeString());
    if (showToast) toast('已拉取云端数据');
    return true;
  } catch (e) {
    setSyncState('err', String(e.message || e).slice(0, 80));
    if (showToast) toast('同步失败：' + (e.message || e));
    return false;
  }
}

async function syncPush(showToast) {
  const cfg = loadSyncCfg();
  if (!cfg.token) {
    setSyncState('need', '缺 Token，无法上传');
    if (showToast) toast('请先填 GitHub Token');
    return false;
  }
  try {
    const doc = collectCloudDoc();
    const content = b64utf8(JSON.stringify(doc, null, 2));
    // PUT 必须带当前 sha；两台设备同时上传会撞车（409），自动取新 sha 重试
    let res = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      let sha = undefined;
      const get = await ghApi('/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + cfg.path);
      if (get.ok) {
        const meta = await get.json();
        sha = meta.sha;
      } else if (get.status !== 404) {
        const t = await get.text();
        throw new Error('push ' + get.status + ' ' + t.slice(0, 100));
      }
      res = await ghApi('/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + cfg.path, {
        method: 'PUT',
        body: {
          message: 'sync expense data ' + new Date().toISOString(),
          content: content,
          sha: sha
        }
      });
      if (res.ok || res.status !== 409) break;
    }
    if (!res.ok) {
      const t = await res.text();
      throw new Error('push ' + res.status + ' ' + t.slice(0, 100));
    }
    setSyncState('ok', '已上传 ' + new Date().toLocaleTimeString());
    if (showToast) toast('已上传云端');
    return true;
  } catch (e) {
    const m = String(e.message || e);
    setSyncState('err', m.slice(0, 80));
    if (showToast) toast('上传失败：' + m);
    return false;
  }
}

async function syncNow(showToast) {
  await syncPull(false);
  await syncPush(showToast);
}

let _syncTimer = null;
function startSyncLoop() {
  stopSyncLoop();
  const cfg = loadSyncCfg();
  // 严格可选：不开同步（或没 Token）就绝不发外网请求
  if (!cfg.enabled || !cfg.token) return;
  syncPull(false);
  _syncTimer = setInterval(() => { syncPull(false); }, 20000);
}
function stopSyncLoop() {
  if (_syncTimer) {
    clearInterval(_syncTimer);
    _syncTimer = null;
  }
}

let _pushDebounce = null;
let _applyingCloud = false;
function schedulePush() {
  if (_applyingCloud) return; // 合并云端数据时不回推，避免拉一次推一次
  const cfg = loadSyncCfg();
  if (!cfg.enabled || !cfg.token) return;
  clearTimeout(_pushDebounce);
  _pushDebounce = setTimeout(() => { syncPush(false); }, 1500);
}

function applyCloudDoc(doc) {
  if (!doc) return false;
  const d = doc.data || doc;
  if (!d || !Array.isArray(d.tx)) return false;
  _applyingCloud = true;
  try { mergeBackupData(d); } finally { _applyingCloud = false; }
  renderList();
  renderQueue();
  renderListCatChips();
  return true;
}

function exportUnknownPayees() {
  const list = queueTx();
  const groups = {};
  list.forEach(t => {
    const p = normalizePayee(t.payee);
    const g = groups[p] = groups[p] || { payee: p, count: 0, total: 0, hours: [], amounts: [], samples: [] };
    g.count++;
    g.total += t.amount;
    if (t.time) g.hours.push(parseInt(t.time.slice(0, 2), 10));
    g.amounts.push(t.amount);
    if (g.samples.length < 5) g.samples.push({ date: t.date, time: t.time, amount: t.amount, source: t.source });
  });
  const payees = Object.keys(groups).map(k => {
    const g = groups[k];
    g.avg = Math.round(g.total / g.count * 100) / 100;
    g.total = Math.round(g.total * 100) / 100;
    return g;
  });
  if (!payees.length) { toast('没有陌生收款方，都归好类了'); return; }
  downloadJSON({
    app: 'expense-tracker', kind: 'unknown-payees', exportedAt: new Date().toISOString(),
    payees: payees
  }, '陌生收款方-' + todayISO().replace(/-/g, '') + '.json');
  toast('已导出 ' + payees.length + ' 个陌生收款方');
}

/* ---------- 图表（复用卡路里手写 Canvas） ---------- */
function drawLine(canvas, series, opts) {
  opts = opts || {};
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 640;
  const cssH = opts.height || 240;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const data = series || [];
  const vals = data.map(x => +x.v).filter(v => !isNaN(v));
  if (!data.length || !vals.length) {
    ctx.fillStyle = '#8b9bb0';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(opts.empty || '暂无数据', cssW / 2, cssH / 2);
    return;
  }
  let minV = Math.min.apply(null, vals);
  let maxV = Math.max.apply(null, vals);
  if (opts.yMin != null) minV = Math.min(minV, opts.yMin);
  if (opts.yMax != null) maxV = Math.max(maxV, opts.yMax);
  const pad = Math.max(1, (maxV - minV) * 0.2) || 1;
  minV -= pad; maxV += pad;
  const padL = 40, padR = 12, padT = 14, padB = 30;
  const W = cssW - padL - padR, H = cssH - padT - padB;

  ctx.strokeStyle = '#2a3542';
  ctx.fillStyle = '#8b9bb0';
  ctx.font = '10px sans-serif';
  for (let i = 0; i <= 4; i++) {
    const y = padT + H * (i / 4);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + W, y); ctx.stroke();
    const v = maxV - (maxV - minV) * (i / 4);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.round(v * 10) / 10), padL - 6, y);
  }
  if (opts.target != null) {
    const ty = padT + H - ((opts.target - minV) / (maxV - minV)) * H;
    if (ty >= padT && ty <= padT + H) {
      ctx.strokeStyle = '#8b9bb0';
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(padL, ty); ctx.lineTo(padL + W, ty); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  const pt = (i) => {
    const x = data.length === 1 ? padL + W / 2 : padL + (W * i / (data.length - 1));
    const y = padT + H - (((+data[i].v || 0) - minV) / (maxV - minV)) * H;
    return [x, y];
  };
  if (data.length > 1) {
    ctx.strokeStyle = opts.color || '#5b9dff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    data.forEach((_, i) => {
      const p = pt(i);
      if (i === 0) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[0], p[1]);
    });
    ctx.stroke();
  }
  data.forEach((d, i) => {
    const p = pt(i);
    ctx.fillStyle = opts.color || '#5b9dff';
    ctx.beginPath(); ctx.arc(p[0], p[1], 4, 0, Math.PI * 2); ctx.fill();
    const every = Math.max(1, Math.ceil(data.length / 7));
    if (i % every === 0 || i === data.length - 1) {
      ctx.fillStyle = '#8b9bb0';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(d.label || '', p[0], cssH - 10);
    }
  });
}

function drawBars(canvas, series, opts) {
  opts = opts || {};
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 640;
  const cssH = opts.height || 240;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const data = series || [];
  if (!data.length) return;
  const target = opts.target || 0;
  const maxV = Math.max(target, ...data.map(x => x.v || 0), 100) * 1.15;
  const padL = 36, padR = 8, padT = 12, padB = 28;
  const W = cssW - padL - padR, H = cssH - padT - padB;
  const n = data.length;
  const gap = 3;
  const bw = Math.max(4, (W - gap * (n - 1)) / n);

  ctx.strokeStyle = '#2a3542';
  ctx.fillStyle = '#8b9bb0';
  ctx.font = '10px sans-serif';
  for (let i = 0; i <= 4; i++) {
    const y = padT + H * (i / 4);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + W, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.round(maxV * (1 - i / 4))), padL - 6, y);
  }
  data.forEach((x, i) => {
    const val = x.v || 0;
    const h = (val / maxV) * H;
    const bx = padL + i * (bw + gap);
    const by = padT + H - h;
    if (x.v == null) {
      ctx.fillStyle = '#2a3542';
      ctx.fillRect(bx, padT + H - 2, bw, 2);
    } else {
      if (opts.colorFn) ctx.fillStyle = opts.colorFn(x, i);
      else if (!target) ctx.fillStyle = '#5b9dff';
      else {
        const diff = x.v - target;
        ctx.fillStyle = diff <= 0 ? '#3dd68c' : (diff <= target * 0.15 ? '#f5a524' : '#f07178');
      }
      if (h < 2) ctx.fillRect(bx, padT + H - 2, bw, 2);
      else ctx.fillRect(bx, by, bw, h);
    }
    if (opts.showVals) {
      ctx.fillStyle = val > 0 ? '#e6edf5' : '#5b6b7e';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(fmtMoney(val), bx + bw / 2, (x.v == null ? padT + H : by) - 3);
    }
    if (n <= 14 || i % 3 === 0) {
      ctx.fillStyle = '#8b9bb0';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(x.label, bx + bw / 2, cssH - 10);
    }
  });
  if (target > 0) {
    const ty = padT + H - (target / maxV) * H;
    ctx.strokeStyle = '#8b9bb0';
    ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(padL, ty); ctx.lineTo(padL + W, ty); ctx.stroke();
    ctx.setLineDash([]);
  }
  // 点击柱子：按列命中（含柱下标签区），回调 (i, 数据项)
  if (opts.onClick) {
    canvas.style.cursor = 'pointer';
    canvas.onclick = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (cssW / (rect.width || cssW));
      const i = Math.floor((x - padL) / (bw + gap));
      if (i >= 0 && i < n) opts.onClick(i, data[i]);
    };
  } else {
    canvas.style.cursor = '';
    canvas.onclick = null;
  }
}

/** 甜甜圈饼图：slices=[{label,v,color}]，扇区内标百分比，中心标总额 */
function drawPie(canvas, slices, opts) {
  opts = opts || {};
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 640;
  const cssH = opts.height || 220;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const data = (slices || []).filter(s => s.v > 0);
  const total = data.reduce((s, x) => s + x.v, 0);
  if (!data.length || total <= 0) {
    ctx.fillStyle = '#8b9bb0';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(opts.empty || '暂无数据', cssW / 2, cssH / 2);
    return;
  }
  const cx = cssW / 2, cy = cssH / 2;
  const R = Math.min(cssW, cssH) / 2 - 14;
  const r = R * 0.62;
  let angle = -Math.PI / 2;
  data.forEach(s => {
    const sweep = (s.v / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, angle, angle + sweep);
    ctx.closePath();
    ctx.fillStyle = s.color || '#8b9bb0';
    ctx.fill();
    const pct = s.v / total * 100;
    if (pct >= 6) { // 太薄的扇区不标，避免叠字
      const mid = angle + sweep / 2;
      const lr = (R + r) / 2;
      ctx.fillStyle = '#0f1419';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(Math.round(pct) + '%', cx + Math.cos(mid) * lr, cy + Math.sin(mid) * lr);
    }
    angle += sweep;
  });
  // 中心挖空 + 总额
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#e6edf5';
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(fmtMoney(total), cx, cy - 8);
  ctx.fillStyle = '#8b9bb0';
  ctx.font = '11px sans-serif';
  ctx.fillText(opts.centerLabel || '总支出', cx, cy + 12);
}

/* ---------- CSS（沿用卡路里暗色主题） ---------- */
(function injectCSS() {
  const css = `
:root{--bg:#0f1419;--card:#1a222c;--text:#e7eef7;--muted:#8b9bb0;--ok:#3dd68c;--warn:#f5a524;--bad:#f07178;--line:#2a3542;--accent:#5b9dff;--accent2:#7c6cff}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);padding:calc(14px + env(safe-area-inset-top)) calc(14px + env(safe-area-inset-right)) calc(40px + env(safe-area-inset-bottom)) calc(14px + env(safe-area-inset-left));-webkit-tap-highlight-color:transparent}
.wrap{max-width:520px;margin:0 auto}
.datebar{display:flex;gap:8px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:10px 12px;margin-bottom:12px}
.datebar input{flex:1;background:rgba(255,255,255,.06);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px;font-size:14px;outline:none;min-width:0}
.datebar button{border:0;background:rgba(91,157,255,.15);color:var(--accent);font-weight:700;border-radius:10px;padding:10px 12px;font-size:12px;cursor:pointer;white-space:nowrap}
.hero{text-align:center;padding:8px 0 14px}
.hero .date{color:var(--muted);font-size:13px}
.kcal-big{font-size:48px;font-weight:800;line-height:1.05;margin:4px 0 2px;letter-spacing:-1px}
.kcal-big em{font-style:normal;font-size:18px;font-weight:700;color:var(--muted);margin-left:6px}
.kcal-sub{font-size:14px;color:var(--muted);margin-bottom:10px}
.badge{display:inline-block;padding:6px 14px;border-radius:999px;font-size:13px;font-weight:600}
.badge.ok{background:rgba(61,214,140,.15);color:var(--ok)}
.badge.warn{background:rgba(245,165,36,.15);color:var(--warn)}
.badge.bad{background:rgba(240,113,120,.15);color:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:14px}
.card h2{font-size:12px;color:var(--muted);font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin-bottom:12px}
.grid{display:grid;gap:10px}
.g2{grid-template-columns:1fr 1fr}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{padding:9px 4px;text-align:left}
td.num{text-align:right;font-variant-numeric:tabular-nums}
th{color:var(--muted);font-weight:500;font-size:11px;border-bottom:1px solid var(--line)}
tr+tr td{border-top:1px solid var(--line)}
tr.ok td{color:var(--ok)} tr.bad td{color:var(--bad)}
.empty{color:var(--muted);text-align:center;padding:20px 0 !important}
.btn{border:0;border-radius:12px;padding:13px 14px;font-size:15px;font-weight:600;cursor:pointer;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;width:100%}
.btn:active{opacity:.85}
.btn.ghost{background:rgba(255,255,255,.06);color:var(--text)}
.btn.ghost.danger{background:rgba(240,113,120,.15);color:var(--bad)}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{background:rgba(91,157,255,.12);color:var(--accent);border:1px solid rgba(91,157,255,.25);border-radius:999px;padding:8px 11px;font-size:12px;cursor:pointer;user-select:none}
.chip.on{background:rgba(91,157,255,.3);color:#fff}
.cat-del{margin-left:6px;padding:0 2px;background:none;border:none;color:inherit;font-size:11px;cursor:pointer;opacity:.8}
.cat-del:hover{opacity:1}
.chip:active{transform:scale(.97)}
input[type=text],input[type=number],input[type=date],input[type=time],input[type=month],select{width:100%;background:rgba(255,255,255,.06);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:12px;font-size:16px;outline:none}
input:focus,select:focus{border-color:var(--accent)}
label{display:block;font-size:11px;color:var(--muted);margin:0 0 6px}
.field{margin-bottom:12px}
.seg{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;background:rgba(255,255,255,.04);padding:4px;border-radius:12px}
.seg button{border:0;background:transparent;color:var(--muted);padding:10px 4px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer}
.seg button.on{background:rgba(91,157,255,.2);color:var(--accent)}
.tabs{display:grid;grid-template-columns:repeat(6,1fr);gap:5px;margin-bottom:14px}
.tabs button{border:0;background:rgba(255,255,255,.05);color:var(--muted);padding:11px 2px;border-radius:11px;font-size:11px;font-weight:600;cursor:pointer}
.tabs button.on{background:rgba(91,157,255,.18);color:var(--accent)}
.toast{position:fixed;left:50%;top:16px;transform:translateX(-50%) translateY(-80px);background:#222c38;color:#fff;padding:12px 18px;border-radius:12px;font-size:14px;transition:transform .25s;z-index:99;box-shadow:0 8px 24px rgba(0,0,0,.35);max-width:90vw}
.toast.show{transform:translateX(-50%) translateY(0)}
.del{color:var(--bad);background:none;border:0;font-size:16px;cursor:pointer;padding:4px 6px}
.foot{text-align:center;color:var(--muted);font-size:11px;margin-top:18px;opacity:.75;line-height:1.7}
canvas{width:100%;height:200px;display:block}
.legend{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--muted);margin-top:8px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:4px;vertical-align:-1px}
.chart-note{font-size:11px;color:var(--muted);margin-top:8px;line-height:1.6}
.day-head{display:flex;justify-content:space-between;align-items:center;padding:10px 2px 6px;font-size:12px;color:var(--muted);font-weight:600}
.day-sum{font-weight:500}
.tx-row{display:flex;align-items:center;gap:8px;padding:10px 2px;border-top:1px solid var(--line)}
.tx-main{flex:1;min-width:0}
.tx-payee{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tx-item{font-size:11px;color:var(--muted);font-weight:400;margin-left:6px}
.tx-meta{font-size:11px;color:var(--muted);margin-top:3px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.tx-amt{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.tx-amt.in{color:var(--ok)}
.cat-chip{display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;border:1px solid}
.src-chip{font-size:10px;opacity:.85}
.reason{opacity:.85;font-style:italic}
.pv-row{display:flex;align-items:center;gap:8px;padding:9px 2px;border-top:1px solid var(--line);flex-wrap:wrap}
.pv-cat,.q-cat{width:auto;min-width:88px;padding:8px;font-size:12px;border-radius:9px}
.train-row{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);cursor:pointer;margin:2px 0}
.train-row input{width:auto}
.train-row.small{font-size:10px;white-space:nowrap}
.q-row{display:flex;align-items:center;gap:8px;padding:9px 2px;border-top:1px solid var(--line);flex-wrap:wrap}
.sug{color:var(--warn)}
.sug.none{color:var(--muted)}
.drop{border:2px dashed var(--line);border-radius:16px;padding:26px 16px;text-align:center;color:var(--muted);font-size:13px;transition:border-color .2s,background .2s}
.drop.over{border-color:var(--accent);background:rgba(91,157,255,.08)}
.drop-icon{font-size:34px;margin-bottom:8px}
.prog{height:10px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden;margin:4px 0}
.prog-in{height:100%;border-radius:999px;transition:width .3s;width:0}
.prog-in.ok{background:var(--ok)} .prog-in.warn{background:var(--warn)} .prog-in.bad{background:var(--bad)}
.cb-row{display:flex;align-items:center;gap:8px;margin-bottom:9px}
.cb-label{width:76px;flex-shrink:0}
.cb-bar{flex:1;height:10px;background:rgba(255,255,255,.07);border-radius:999px;overflow:hidden}
.cb-in{height:100%;border-radius:999px}
.cb-val{width:86px;text-align:right;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
`;
  const st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);
})();

/* ---------- PWA：注册 Service Worker + 安装提示 ---------- */
(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  let deferred = null;
  const banner = document.createElement('div');
  banner.id = 'pwaInstall';
  banner.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:98;display:none;gap:10px;align-items:center;background:#222c38;border:1px solid #2a3542;border-radius:14px;padding:12px 14px;box-shadow:0 10px 30px rgba(0,0,0,.4)';
  banner.innerHTML = '<div style="flex:1;font-size:13px;color:#e6edf3">装到桌面，当软件用</div>' +
    '<button id="pwaYes" style="border:0;background:#5b9dff;color:#fff;border-radius:10px;padding:9px 14px;font-size:13px;cursor:pointer">安装</button>' +
    '<button id="pwaNo" style="border:0;background:transparent;color:#8b9bb0;padding:9px 10px;font-size:13px;cursor:pointer">不用</button>';
  document.body.appendChild(banner);

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  if (!isStandalone && isIOS && !localStorage.getItem('pwa_hint_dismissed')) {
    banner.querySelector('div').textContent = 'iPhone：Safari 分享 → 添加到主屏幕，当软件用';
    banner.querySelector('#pwaYes').textContent = '知道了';
    banner.style.display = 'flex';
    banner.querySelector('#pwaYes').onclick = () => {
      localStorage.setItem('pwa_hint_dismissed', '1');
      banner.style.display = 'none';
    };
    banner.querySelector('#pwaNo').onclick = () => {
      localStorage.setItem('pwa_hint_dismissed', '1');
      banner.style.display = 'none';
    };
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    if (isStandalone || localStorage.getItem('pwa_hint_dismissed')) return;
    banner.querySelector('div').textContent = '装到桌面，当软件用（可离线打开）';
    banner.querySelector('#pwaYes').textContent = '安装';
    banner.style.display = 'flex';
    banner.querySelector('#pwaYes').onclick = async () => {
      if (deferred) {
        deferred.prompt();
        try { await deferred.userChoice; } catch (err) {}
        deferred = null;
      }
      banner.style.display = 'none';
      localStorage.setItem('pwa_hint_dismissed', '1');
    };
    banner.querySelector('#pwaNo').onclick = () => {
      banner.style.display = 'none';
      localStorage.setItem('pwa_hint_dismissed', '1');
    };
  });

  window.addEventListener('appinstalled', () => {
    banner.style.display = 'none';
    toast('已安装到桌面');
  });
})();

/* ---------- 启动 ---------- */
(function boot() {
  gcDeletes();
  mergeSeedRules();
  initTabs();
  initList();
  initForm();
  initImport();
  initStats();
  initSettings();
  renderList();
  startSyncLoop(); // 仅在开启同步时才连网（默认关闭 = 零外网请求）
})();
