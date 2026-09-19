// 撸货记账 · 主逻辑（v4 简化版）
// 状态只有三个：在途（垫了钱还没结清）/ 已回款 / 自留。
// 数据模型：单 JSON blob（orders 数组），经 sync.js 云同步（同设备组共用一个同步码）。
(function () {
  "use strict";

  // ---- 常量 ----
  const DATA_KEY = "luhuo-ledger-data-v1";
  const META_KEY = "luhuo-ledger-meta-v1";

  const STATUSES = ["在途", "已回款", "自留"];
  const SETTLED = ["已回款", "自留"];
  const CHANNELS = ["收货商", "闲鱼", "转转", "朋友", "自用"];
  const STATUS_CLASS = { "在途": "st-out", "已回款": "st-done", "自留": "st-loss" };

  // ---- 状态 ----
  let data = { version: 1, orders: [] };
  let meta = { updatedAt: null, lastSyncedAt: null, lastSyncError: "", filter: "在途" };
  let editingId = null;
  let payTargetId = null;
  let currentFilter = "在途";

  // 报表
  let reportMode = "month";
  const now0 = new Date();
  let repCursor = { y: now0.getFullYear(), m: now0.getMonth() };

  // ---- 工具 ----
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function numberValue(v) {
    if (v === null || v === undefined || v === "") return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function money(value) {
    const n = numberValue(value);
    const abs = Math.abs(n);
    const s = new Intl.NumberFormat("zh-CN", {
      style: "currency", currency: "CNY",
      minimumFractionDigits: Number.isInteger(abs) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(abs);
    return n < 0 ? "-" + s : s;
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function pad2(n) { return String(n).padStart(2, "0"); }

  function monthStr(dateStr) { return String(dateStr || "").slice(0, 7); }
  function currentMonth() { return todayStr().slice(0, 7); }

  function parseDate(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ""));
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function uid() {
    return crypto.randomUUID ? crypto.randomUUID() : "o" + Date.now() + Math.random().toString(16).slice(2);
  }

  // ---- 持久化 ----
  function persist() {
    localStorage.setItem(DATA_KEY, JSON.stringify(data));
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  }

  // 旧状态（待发货/待寄出/已寄出/退货中/翻车自留）→ 新三态
  function migrateStatus(status) {
    if (status === "已回款") return "已回款";
    if (status === "翻车自留") return "自留";
    return "在途";
  }

  function normalizeData(source) {
    const out = { version: 1, orders: [] };
    const orders = source && Array.isArray(source.orders) ? source.orders : [];
    orders.forEach((o) => {
      if (!o || typeof o !== "object") return;
      out.orders.push({
        id: String(o.id || uid()),
        date: String(o.date || todayStr()),
        name: String(o.name || "").slice(0, 120),
        platform: String(o.platform || ""),
        qty: Math.max(1, Math.round(numberValue(o.qty)) || 1),
        cost: numberValue(o.cost),
        pay: String(o.pay || ""),          // 已废弃字段，留着兼容旧数据
        channel: String(o.channel || ""),
        income: o.income === null || o.income === undefined || o.income === "" ? null : numberValue(o.income),
        incomeDate: o.incomeDate ? String(o.incomeDate) : null,
        status: migrateStatus(o.status),
        fee: numberValue(o.fee),
        note: String(o.note || "").slice(0, 300),
        createdAt: String(o.createdAt || new Date().toISOString()),
      });
    });
    return out;
  }

  function loadLocal() {
    try {
      const raw = JSON.parse(localStorage.getItem(DATA_KEY) || "null");
      if (raw) data = normalizeData(raw);
      const rawMeta = JSON.parse(localStorage.getItem(META_KEY) || "null");
      if (rawMeta) meta = Object.assign(meta, rawMeta);
      if (!STATUSES.includes(meta.filter)) meta.filter = "在途";
      currentFilter = meta.filter;
    } catch { /* 损坏则从空账本开始 */ }
  }

  // ---- 统计口径 ----
  function isSettled(order) { return SETTLED.includes(order.status); }
  function orderProfit(o) { return (o.income === null ? 0 : o.income) - o.cost - o.fee; }

  function computeStats() {
    const orders = data.orders;
    let totalCost = 0, totalIncome = 0, outstanding = 0, outCount = 0, settledProfit = 0;
    let monthCost = 0, monthIncome = 0;
    const cm = currentMonth();
    const byStatus = {}; STATUSES.forEach((s) => { byStatus[s] = { count: 0, cost: 0 }; });
    const byMonth = {};

    orders.forEach((o) => {
      totalCost += o.cost;
      if (o.income !== null) totalIncome += o.income;
      if (!isSettled(o)) { outstanding += o.cost; outCount += 1; }
      else settledProfit += orderProfit(o);
      if (monthStr(o.date) === cm) monthCost += o.cost;
      if (o.incomeDate && monthStr(o.incomeDate) === cm && o.income !== null) monthIncome += o.income;
      if (byStatus[o.status]) {
        byStatus[o.status].count += 1;
        byStatus[o.status].cost += o.cost;
      }
      const m = monthStr(o.date);
      byMonth[m] = byMonth[m] || { cost: 0, income: 0 };
      byMonth[m].cost += o.cost;
      if (o.income !== null) {
        const mi = monthStr(o.incomeDate);
        byMonth[mi] = byMonth[mi] || { cost: 0, income: 0 };
        byMonth[mi].income += o.income;
      }
    });

    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
      const row = byMonth[key] || { cost: 0, income: 0 };
      months.push({ month: key, cost: row.cost, income: row.income, diff: row.income - row.cost });
    }
    return { totalCost, totalIncome, outstanding, outCount, settledProfit, monthCost, monthIncome, byStatus, months, count: orders.length };
  }

  // ---- 渲染 ----
  function render() {
    renderDash();
    renderList();
    renderReport();
    renderSyncBadge();
  }

  function renderSyncBadge() {
    if (!window.luhuoSync) return;
    if (meta.lastSyncError) window.luhuoSync.setStatus("error", meta.lastSyncError);
    else if (meta.lastSyncedAt) window.luhuoSync.setStatus("online", "上次同步：" + meta.lastSyncedAt);
    else if (data.orders.length === 0) window.luhuoSync.setStatus("offline", "本地空账本");
    else window.luhuoSync.setStatus("offline", "尚未云同步");
  }

  function renderDash() {
    const s = computeStats();
    $("#kpiOutstanding").textContent = money(s.outstanding);
    $("#kpiOutstandingHint").textContent = s.outCount > 0
      ? `${s.outCount} 单在途，回款了记得销账`
      : "还没有在途的单子";
    const profitEl = $("#kpiProfit");
    profitEl.textContent = money(s.settledProfit);
    profitEl.className = "kpi-value " + (s.settledProfit > 0 ? "pos" : s.settledProfit < 0 ? "neg" : "");
    $("#kpiMonthCost").textContent = money(s.monthCost);
    $("#kpiMonthIncome").textContent = money(s.monthIncome);
    $("#kpiTotal").textContent = `${money(s.totalCost)} / ${money(s.totalIncome)}`;

    // 订单状态：垫付占比小环形 + 三态行
    const stColors = { "在途": "#b97909", "已回款": "#2b9fe0", "自留": "#d05f45" };
    const donutItems = STATUSES.map((st) => ({ name: st, value: s.byStatus[st].cost })).filter((x) => x.value > 0);
    $("#statusDonut").innerHTML = s.totalCost > 0
      ? chartDonutSVG(donutItems, s.totalCost, "垫付合计", donutItems.map((it) => stColors[it.name]))
      : `<div class="empty-mini">暂无垫付</div>`;
    $("#statusList").innerHTML = STATUSES.map((st) => {
      const b = s.byStatus[st];
      return `<div class="status-row">
        <span class="status-tag ${STATUS_CLASS[st]}">${st}</span>
        <span class="status-nums"><em>${b.count} 单</em><i>${money(b.cost)}</i></span>
      </div>`;
    }).join("");

    // 近 6 个月迷你走势（垫出/回款）
    $("#dashFlowLegend").innerHTML = `<i class="lg-dot" style="background:#b97909"></i>垫出　<i class="lg-dot" style="background:#17b26a"></i>回款`;
    const flowBuckets = s.months.map((m) => ({ label: `${parseInt(m.month.slice(5), 10)}月` }));
    const flowStats = s.months.map((m) => ({ cost: m.cost, income: m.income }));
    $("#dashFlow").innerHTML = chartFlowSVG(flowBuckets, flowStats, 118);

    $("#monthList").innerHTML = s.months.map((m) => `
      <div class="month-row">
        <span class="month-name">${m.month}</span>
        <span class="month-cell">垫 ${money(m.cost)}</span>
        <span class="month-cell">回 ${money(m.income)}</span>
        <span class="month-cell ${m.diff > 0 ? "pos" : m.diff < 0 ? "neg" : ""}">${money(m.diff)}</span>
      </div>`).join("");
  }

  // ---- 账本 ----
  function filteredOrders() {
    const orders = data.orders.slice();
    orders.sort((a, b) => (a.date < b.date ? 1 : -1));
    if (currentFilter === "全部") return orders;
    return orders.filter((o) => o.status === currentFilter);
  }

  function renderList() {
    const chips = ["在途", "全部", "已回款", "自留"];
    $("#filterChips").innerHTML = chips.map((c) => {
      const n = c === "全部" ? data.orders.length
        : data.orders.filter((o) => o.status === c).length;
      return `<button class="chip ${currentFilter === c ? "on" : ""}" data-filter="${c}">${c} ${n > 0 ? `<b>${n}</b>` : ""}</button>`;
    }).join("");

    const orders = filteredOrders();
    if (orders.length === 0) {
      $("#orderList").innerHTML = `<div class="empty">没有${currentFilter === "全部" ? "" : "「" + currentFilter + "」的"}单子<br><small>点右下角「记一单」开始</small></div>`;
      return;
    }
    $("#orderList").innerHTML = orders.map((o) => {
      const settled = isSettled(o);
      const profit = orderProfit(o);
      const showProfit = o.income !== null || settled;
      const actions = [];
      if (!settled) actions.push(`<button class="act primary" data-act="pay" data-id="${o.id}">回款</button>`);
      if (!settled) actions.push(`<button class="act" data-act="keep" data-id="${o.id}">自留</button>`);
      actions.push(`<button class="act" data-act="dup" data-id="${o.id}">再来一单</button>`);
      actions.push(`<button class="act" data-act="edit" data-id="${o.id}">编辑</button>`);
      actions.push(`<button class="act danger" data-act="del" data-id="${o.id}">删除</button>`);
      return `<div class="order-card">
        <div class="order-top">
          <span class="order-name">${escapeHtml(o.name || "未命名")}</span>
          <span class="status-tag ${STATUS_CLASS[o.status]}">${o.status}</span>
        </div>
        <div class="order-mid">${escapeHtml(o.date)}${o.platform ? " · " + escapeHtml(o.platform) : ""} · ${o.qty} 件${o.channel ? " · " + escapeHtml(o.channel) : ""}</div>
        <div class="order-money">
          <span>垫付 <b>${money(o.cost)}</b></span>
          <span>回款 <b>${o.income === null ? "—" : money(o.income)}</b></span>
          ${showProfit ? `<span>利润 <b class="${profit > 0 ? "pos" : profit < 0 ? "neg" : ""}">${money(profit)}</b></span>` : ""}
        </div>
        ${o.note ? `<div class="order-note">${escapeHtml(o.note)}</div>` : ""}
        <div class="order-actions">${actions.join("")}</div>
      </div>`;
    }).join("");
  }

  // ---- 报表 ----
  function repRange(mode, cur) {
    if (mode === "month") {
      return { start: new Date(cur.y, cur.m, 1), end: new Date(cur.y, cur.m + 1, 1), label: `${cur.y}-${pad2(cur.m + 1)}` };
    }
    if (mode === "quarter") {
      const q = Math.floor(cur.m / 3);
      return { start: new Date(cur.y, q * 3, 1), end: new Date(cur.y, q * 3 + 3, 1), label: `${cur.y} Q${q + 1}` };
    }
    return { start: new Date(cur.y, 0, 1), end: new Date(cur.y + 1, 0, 1), label: `${cur.y} 年` };
  }

  function shiftCursor(mode, cur, dir) {
    const step = mode === "month" ? 1 : mode === "quarter" ? 3 : 12;
    const d = new Date(cur.y, cur.m + dir * step, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  }

  function reportStats(startD, endD) {
    let n = 0, cost = 0, income = 0, profit = 0;
    const byName = {};
    data.orders.forEach((o) => {
      const od = parseDate(o.date);
      const inByDate = od && od >= startD && od < endD;
      if (inByDate) {
        n += 1;
        cost += o.cost;
        const g = byName[o.name || "未命名"] = byName[o.name || "未命名"] || { count: 0, profit: 0, pending: 0 };
        g.count += 1;
        if (isSettled(o)) g.profit += orderProfit(o);
        else g.pending += 1;
      }
      if (isSettled(o) && o.incomeDate) {
        const id = parseDate(o.incomeDate);
        if (id && id >= startD && id < endD) {
          income += o.income;
          profit += orderProfit(o);
        }
      }
    });
    return { n, cost, income, profit, byName };
  }

  function prevReportStats() {
    const r = repRange(reportMode, shiftCursor(reportMode, repCursor, -1));
    return reportStats(r.start, r.end);
  }

  // ---- 报表图表（手写 SVG，无外部依赖）----
  const PALETTE = ["#0f6cbd", "#2b9fe0", "#7fbce8", "#5b7f95", "#b97909", "#8c9a92"];
  let gradSeq = 0;

  // 周期切桶：月视图按天、季视图 3 个月、年视图 12 个月
  function buildBuckets(mode, range) {
    const buckets = [];
    if (mode === "month") {
      const d = new Date(range.start);
      let i = 1;
      while (d < range.end) {
        const start = new Date(d), end = new Date(d); end.setDate(end.getDate() + 1);
        buckets.push({ label: String(i), start, end });
        d.setDate(d.getDate() + 1); i += 1;
      }
    } else {
      const d = new Date(range.start);
      while (d < range.end) {
        const start = new Date(d), end = new Date(d); end.setMonth(end.getMonth() + 1);
        buckets.push({ label: `${pad2(d.getMonth() + 1)}月`, start, end });
        d.setMonth(d.getMonth() + 1);
      }
    }
    return buckets;
  }

  function sparseTicks(n) {
    if (n <= 8) return [...Array(n).keys()];
    const step = Math.ceil(n / 6);
    const idx = [];
    for (let i = 0; i < n; i += step) idx.push(i);
    if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
    return idx;
  }

  // 垫出 vs 回款：双序列面积图
  function chartFlowSVG(buckets, stats, H = 158) {
    const W = 336, padL = 6, padR = 6, padT = 14, padB = 22;
    const n = buckets.length;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const maxV = Math.max(1, ...stats.map((s) => Math.max(s.cost, s.income)));
    const x = (i) => padL + (n === 1 ? innerW / 2 : i * innerW / (n - 1));
    const y = (v) => padT + innerH - (v / maxV) * innerH;
    let grid = "";
    [0, .5, 1].forEach((f) => {
      const gy = padT + innerH - f * innerH;
      grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" style="stroke:var(--line)" stroke-dasharray="3 4"/>`;
    });
    grid += `<text x="${padL + 2}" y="${padT + 4}" font-size="9" style="fill:var(--muted)">至多 ${money(maxV)}</text>`;
    const path = (key) => stats.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s[key]).toFixed(1)}`).join(" ");
    const area = (key, gid) => n === 1 ? "" :
      `<path d="${path(key)} L${x(n - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${x(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z" fill="url(#${gid})"/>`;
    const dots = (key, color) => n <= 14 ? stats.map((s, i) =>
      `<circle cx="${x(i).toFixed(1)}" cy="${y(s[key]).toFixed(1)}" r="2.6" fill="#fff" stroke="${color}" stroke-width="1.6"/>`).join("") : "";
    const ticks = sparseTicks(n).map((i) =>
      `<text x="${x(i).toFixed(1)}" y="${H - 6}" font-size="9" style="fill:var(--muted)" text-anchor="middle">${escapeHtml(buckets[i].label)}</text>`).join("");
    const idA = "gf" + (++gradSeq), idB = "gf" + (++gradSeq);
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="${idA}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#b97909" stop-opacity=".28"/><stop offset="1" stop-color="#b97909" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="${idB}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#2b9fe0" stop-opacity=".30"/><stop offset="1" stop-color="#17b26a" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}
      ${area("cost", idA)}${area("income", idB)}
      <path d="${path("cost")}" fill="none" stroke="#b97909" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <path d="${path("income")}" fill="none" stroke="#2b9fe0" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots("cost", "#b97909")}${dots("income", "#2b9fe0")}
      ${ticks}
    </svg>`;
  }

  // 净盈亏：零轴发散柱
  function chartProfitSVG(buckets, stats) {
    const W = 336, H = 148, padL = 6, padR = 6, padT = 12, padB = 22;
    const n = buckets.length;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const maxAbs = Math.max(1, ...stats.map((s) => Math.abs(s.profit)));
    const half = innerH / 2;
    const zero = padT + half;
    const slot = innerW / n;
    const bw = Math.min(26, slot * 0.56);
    let bars = "";
    stats.forEach((s, i) => {
      const h = Math.max(s.profit === 0 ? 0 : 2, Math.abs(s.profit) / maxAbs * (half - 2));
      const bx = (padL + i * slot + (slot - bw) / 2).toFixed(1);
      const by = s.profit >= 0 ? (zero - h).toFixed(1) : zero.toFixed(1);
      bars += `<rect x="${bx}" y="${by}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(3, bw / 2).toFixed(1)}"
        fill="${s.profit >= 0 ? "#2b9fe0" : "#d05f45"}" opacity="${s.profit === 0 ? .25 : .9}"/>`;
      if (n <= 13 && s.profit !== 0) {
        const ty = s.profit >= 0 ? zero - h - 4 : zero + h + 11;
        bars += `<text x="${(padL + i * slot + slot / 2).toFixed(1)}" y="${ty.toFixed(1)}" font-size="9" style="fill:var(--muted)" text-anchor="middle">${money(s.profit)}</text>`;
      }
    });
    const ticks = sparseTicks(n).map((i) =>
      `<text x="${(padL + i * slot + slot / 2).toFixed(1)}" y="${H - 6}" font-size="9" style="fill:var(--muted)" text-anchor="middle">${escapeHtml(buckets[i].label)}</text>`).join("");
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">
      <line x1="${padL}" y1="${zero.toFixed(1)}" x2="${W - padR}" y2="${zero.toFixed(1)}" style="stroke:var(--line)" stroke-width="1"/>
      ${bars}${ticks}
    </svg>`;
  }

  // 商品利润占比环形图
  function chartDonutSVG(items, total, centerLabel = "已结算利润", colors = PALETTE) {
    const S = 128, r = 44, sw = 17, C = 2 * Math.PI * r;
    let offset = 0, slices = "";
    items.forEach((it, i) => {
      const frac = it.value / total;
      const gap = items.length > 1 ? 1.5 : 0;
      const dash = `${Math.max(0.5, frac * C - gap).toFixed(2)} ${(C - Math.max(0.5, frac * C - gap)).toFixed(2)}`;
      slices += `<circle cx="${S / 2}" cy="${S / 2}" r="${r}" fill="none" stroke="${colors[i % colors.length]}"
        stroke-width="${sw}" stroke-dasharray="${dash}" transform="rotate(${(offset * 360 - 90).toFixed(2)} ${S / 2} ${S / 2})"/>`;
      offset += frac;
    });
    return `<svg viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
      <circle cx="${S / 2}" cy="${S / 2}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${sw}"/>
      ${slices}
      <text x="${S / 2}" y="${S / 2 - 2}" font-size="15" font-weight="700" style="fill:var(--ink)" text-anchor="middle">${money(total)}</text>
      <text x="${S / 2}" y="${S / 2 + 14}" font-size="9" style="fill:var(--muted)" text-anchor="middle">${escapeHtml(centerLabel)}</text>
    </svg>`;
  }

  function renderReport() {
    const range = repRange(reportMode, repCursor);
    $("#repLabel").textContent = range.label;
    const s = reportStats(range.start, range.end);
    const prev = prevReportStats();

    const lines = [];
    if (s.n === 0 && s.income === 0) {
      lines.push(`<b>${escapeHtml(range.label)}</b> 没有记录。`);
    } else {
      lines.push(`<b>${escapeHtml(range.label)}</b> 共 ${s.n} 单：垫出 <b>${money(s.cost)}</b>，收回 <b>${money(s.income)}</b>，净${s.profit >= 0 ? "赚" : "亏"} <b class="${s.profit >= 0 ? "pos" : "neg"}">${money(s.profit)}</b>。`);
      const st = computeStats();
      if (st.outCount > 0) lines.push(`现在还有 ${st.outCount} 单 / ${money(st.outstanding)} 在途，回款了记得来销账。`);
      if (prev.n > 0 || prev.income > 0) {
        const diff = s.profit - prev.profit;
        lines.push(diff === 0 ? "和上一期持平。"
          : `比上一期${diff > 0 ? "多赚" : "少赚"} <b class="${diff > 0 ? "pos" : "neg"}">${money(Math.abs(diff))}</b>。`);
      }
    }
    $("#reportSummary").innerHTML = lines.map((l) => `<p>${l}</p>`).join("");

    $("#reportKpis").innerHTML = `
      <div class="kpi card"><span class="kpi-label">单数</span><span class="kpi-value">${s.n}</span></div>
      <div class="kpi card"><span class="kpi-label">垫付</span><span class="kpi-value">${money(s.cost)}</span></div>
      <div class="kpi card"><span class="kpi-label">回款</span><span class="kpi-value">${money(s.income)}</span></div>
      <div class="kpi card"><span class="kpi-label">净盈亏</span><span class="kpi-value ${s.profit > 0 ? "pos" : s.profit < 0 ? "neg" : ""}">${money(s.profit)}</span></div>`;

    // 图表
    const buckets = buildBuckets(reportMode, range);
    const bucketStats = buckets.map((b) => reportStats(b.start, b.end));

    $("#flowLegend").innerHTML = `<i class="lg-dot" style="background:#b97909"></i>垫出　<i class="lg-dot" style="background:#17b26a"></i>回款`;
    $("#chartFlow").innerHTML = chartFlowSVG(buckets, bucketStats);

    $("#profitLegend").innerHTML = `<i class="lg-dot" style="background:#17b26a"></i>赚　<i class="lg-dot" style="background:#d05f45"></i>亏`;
    $("#chartProfit").innerHTML = chartProfitSVG(buckets, bucketStats);

    // 环形图：已结算利润为正的商品，Top5 + 其他
    const ranked = Object.entries(s.byName).map(([name, g]) => ({ name, value: g.profit }))
      .filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
    const top = ranked.slice(0, 5);
    const restVal = ranked.slice(5).reduce((a, b) => a + b.value, 0);
    if (restVal > 0) top.push({ name: "其他", value: restVal });
    const total = top.reduce((a, b) => a + b.value, 0);
    if (total <= 0) {
      $("#chartDonut").innerHTML = `<div class="empty-mini">这个周期还没有已结算的利润可分</div>`;
    } else {
      const legend = top.map((it, i) => `
        <div class="donut-legend-row">
          <i class="lg-dot" style="background:${PALETTE[i % PALETTE.length]}"></i>
          <span class="dl-name">${escapeHtml(it.name)}</span>
          <span class="dl-val">${money(it.value)} · ${Math.round(it.value / total * 100)}%</span>
        </div>`).join("");
      $("#chartDonut").innerHTML = `<div class="donut-wrap">${chartDonutSVG(top, total)}<div class="donut-legend">${legend}</div></div>`;
    }

    // 商品榜 + 比例条
    const products = Object.entries(s.byName)
      .sort((a, b) => b[1].profit - a[1].profit)
      .slice(0, 5);
    const maxP = Math.max(1, ...products.map(([, g]) => Math.abs(g.profit)));
    $("#reportProducts").innerHTML = products.length === 0
      ? `<div class="empty-mini">该周期没有商品</div>`
      : products.map(([name, g]) => `
        <div class="prod-row">
          <div class="prod-line">
            <span class="prod-name">${escapeHtml(name)}${g.pending ? ` <i class="pending-tag">在途${g.pending}</i>` : ""}</span>
            <span class="prod-nums">${g.count} 单 <b class="${g.profit > 0 ? "pos" : g.profit < 0 ? "neg" : ""}">${money(g.profit)}</b></span>
          </div>
          <div class="prod-bar-track"><span class="prod-bar ${g.profit >= 0 ? "pos" : "neg"}" style="width:${Math.round(Math.abs(g.profit) / maxP * 100)}%"></span></div>
        </div>`).join("");
  }

  // ---- 记单 / 编辑 ----
  function openForm(order) {
    editingId = order ? order.id : null;
    const f = $("#orderForm");
    f.goods.value = order ? order.name : "";
    f.cost.value = order ? (order.cost || "") : "";
    f.qty.value = order ? order.qty : 1;
    f.date.value = order ? order.date : todayStr();
    f.channel.value = order ? (order.channel || "收货商") : "收货商";
    f.fee.value = order ? (order.fee || "") : "";
    f.status.value = order ? order.status : "在途";
    f.note.value = order ? order.note : "";
    $("#formTitle").textContent = order ? "编辑订单" : "记一单";
    $("#formMore").open = !!(order && (order.fee > 0 || order.status !== "在途"));
    $("#formModal").classList.add("show");
    setTimeout(() => f.goods.focus(), 120);
  }

  function closeForm() {
    $("#formModal").classList.remove("show");
    editingId = null;
  }

  function submitForm(ev) {
    ev.preventDefault();
    const f = ev.target;
    const name = String(f.goods.value || "").trim();
    const cost = numberValue(f.cost.value);
    if (!name) { toast("先填商品名称"); return; }
    if (cost < 0) { toast("垫付金额不能是负数"); return; }
    if (cost === 0 && !confirm("垫付金额为 0？确认这是 0 元购/白嫖的单子吗？")) return;
    const existing = editingId ? data.orders.find((o) => o.id === editingId) : null;
    const order = {
      id: existing ? existing.id : uid(),
      date: f.date.value || todayStr(),
      name,
      platform: existing ? existing.platform : "",
      qty: Math.max(1, Math.round(numberValue(f.qty.value)) || 1),
      cost,
      pay: existing ? existing.pay : "",
      channel: String(f.channel.value || "").trim(),
      income: existing ? existing.income : null,
      incomeDate: existing ? existing.incomeDate : null,
      status: f.status.value,
      fee: numberValue(f.fee.value),
      note: String(f.note.value || "").trim(),
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
    };
    if (existing) Object.assign(existing, order, { id: existing.id });
    else data.orders.push(order);
    closeForm();
    saveData();
    toast(existing ? "已更新" : "已记账");
    switchView("list");
  }

  // ---- 快捷动作 ----
  function duplicateOrder(id) {
    const o = data.orders.find((x) => x.id === id);
    if (!o) return;
    data.orders.push({
      ...o,
      id: uid(),
      date: todayStr(),
      income: null,
      incomeDate: null,
      status: "在途",
      createdAt: new Date().toISOString(),
    });
    saveData();
    toast("已复制一单，改个金额就能存");
  }

  function markKept(id) {
    const o = data.orders.find((x) => x.id === id);
    if (!o) return;
    o.status = "自留";
    if (o.income === null) o.income = 0;
    saveData();
    toast("已记自留，点编辑可以改回");
  }

  function openPayForm(id) {
    const o = data.orders.find((x) => x.id === id);
    if (!o) return;
    payTargetId = id;
    const f = $("#payForm");
    f.income.value = o.cost || "";
    f.incomeDate.value = todayStr();
    $("#payTitle").textContent = `回款 · ${o.name}`;
    updatePayPreview();
    $("#payModal").classList.add("show");
    setTimeout(() => f.income.focus(), 120);
  }

  function closePayForm() {
    $("#payModal").classList.remove("show");
    payTargetId = null;
  }

  function updatePayPreview() {
    const o = data.orders.find((x) => x.id === payTargetId);
    if (!o) return;
    const income = numberValue($("#payForm").income.value);
    const profit = income - o.cost - o.fee;
    $("#payPreview").innerHTML = `利润 <b class="${profit > 0 ? "pos" : profit < 0 ? "neg" : ""}">${profit >= 0 ? "+" : ""}${money(profit)}</b>（垫付 ${money(o.cost)}${o.fee ? "＋杂费 " + money(o.fee) : ""}）`;
    $("#paySubmit").textContent = `确认回款 ${money(income)}`;
  }

  function submitPay(ev) {
    ev.preventDefault();
    const f = ev.target;
    const o = data.orders.find((x) => x.id === payTargetId);
    if (!o) return closePayForm();
    const income = numberValue(f.income.value);
    o.income = income;
    o.incomeDate = f.incomeDate.value || todayStr();
    o.status = "已回款";
    closePayForm();
    saveData();
    toast(`已回款 ${money(income)}，利润 ${money(orderProfit(o))}`);
  }

  function deleteOrder(id) {
    const o = data.orders.find((x) => x.id === id);
    if (!o) return;
    if (!confirm(`删除「${o.name}」这一单？\n删除后无法恢复（云端也会删）。`)) return;
    data.orders = data.orders.filter((x) => x.id !== id);
    saveData();
    toast("已删除");
  }

  // ---- 云同步（改动防抖推送，启动拉取）----
  let syncTimer = null, syncPending = false, syncInFlight = false;
  let syncEpoch = 0;   // 导入同步码/重置身份时换代：旧身份数据的晚到同步直接作废

  function saveData() {
    meta.updatedAt = new Date().toISOString();
    meta.filter = currentFilter;
    persist();
    render();
    scheduleSync();
  }

  function scheduleSync() {
    syncPending = true;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncPending = false;
      syncToCloud();
    }, 450);
  }

  function flushPendingSync() {
    if (!syncPending) return;
    clearTimeout(syncTimer);
    syncPending = false;
    syncToCloud();
  }

  async function syncToCloud() {
    if (!window.luhuoSync || !window.luhuoSync.isConfigured()) return;
    if (syncInFlight) { syncPending = true; return; }
    syncInFlight = true;
    const epoch = syncEpoch;
    window.luhuoSync.setStatus("syncing");
    try {
      const record = await window.luhuoSync.saveData(data, meta.updatedAt || new Date().toISOString());
      if (epoch !== syncEpoch) return;   // 身份已换代，丢弃本轮结果
      meta.lastSyncedAt = (record.updatedAt || new Date().toISOString()).replace("T", " ").slice(0, 16);
      meta.lastSyncError = "";
      persist();
      window.luhuoSync.setStatus("online", "上次同步：" + meta.lastSyncedAt);
    } catch (error) {
      if (epoch !== syncEpoch) return;
      meta.lastSyncError = error && error.message ? error.message : String(error);
      persist();
      window.luhuoSync.setStatus("error", meta.lastSyncError);
    } finally {
      syncInFlight = false;
      if (syncPending && epoch === syncEpoch) { syncPending = false; syncToCloud(); }
    }
  }

  async function pullFromCloud() {
    if (!window.luhuoSync || !window.luhuoSync.isConfigured()) return;
    try {
      const remote = await window.luhuoSync.loadRecord();
      if (!remote || !remote.data) {
        if (data.orders.length > 0) syncToCloud();
        window.luhuoSync.setStatus("online", "云端暂无数据");
        return;
      }
      const remoteAt = remote.updatedAt || "";
      if (!meta.updatedAt || remoteAt > meta.updatedAt) {
        data = normalizeData(remote.data);
        meta.updatedAt = remoteAt;
        persist();
        render();
        toast("已从云端取回最新账本");
      } else {
        syncToCloud();
      }
      meta.lastSyncError = "";
      renderSyncBadge();
    } catch (error) {
      meta.lastSyncError = error && error.message ? error.message : String(error);
      renderSyncBadge();
    }
  }

  // ---- 设置 ----
  function renderSettings() {
    $("#syncEndpoint").textContent = window.luhuoSync ? window.luhuoSync.endpointLabel() : "-";
    $("#syncLast").textContent = meta.lastSyncedAt || "还没同步过";
    $("#syncErrLine").textContent = meta.lastSyncError || "";
    try { $("#syncCodeText").value = window.luhuoSync.getSyncCode(); } catch { $("#syncCodeText").value = ""; }
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...data }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `luhuo-ledger-${todayStr().replace(/-/g, "")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("已导出备份文件");
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const incoming = normalizeData(parsed);
        if (!confirm(`导入 ${incoming.orders.length} 单，覆盖当前账本（${data.orders.length} 单）？\n建议先导出备份。`)) return;
        data = incoming;
        saveData();
        toast("导入完成");
      } catch {
        toast("文件格式不对，导入失败");
      }
    };
    reader.readAsText(file);
  }

  // ---- 视图切换 / toast ----
  function switchView(view) {
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
    $$(".tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
    window.scrollTo(0, 0);
  }

  let toastTimer = null;
  function toast(text) {
    const el = $("#toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
  }

  function openSettings() {
    renderSettings();
    $("#settingsModal").classList.add("show");
  }
  function closeSettings() { $("#settingsModal").classList.remove("show"); }

  // ---- 表单下拉 ----
  function fillSelect(sel, options, def) {
    sel.innerHTML = options.map((o) =>
      `<option value="${escapeHtml(o[0])}" ${o[0] === def ? "selected" : ""}>${escapeHtml(o[1])}</option>`).join("");
  }

  function populateSelects() {
    fillSelect(document.querySelector("#orderForm [name=channel]"),
      CHANNELS.map((c) => [c, c]), "收货商");
    fillSelect(document.querySelector("#orderForm [name=status]"),
      STATUSES.map((s) => [s, s]), "在途");
  }

  // ---- 事件绑定 ----
  function bind() {
    $$(".tabbar button").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
    $("#settingsBtn").addEventListener("click", openSettings);
    $("#fab").addEventListener("click", () => openForm(null));

    $("#filterChips").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-filter]");
      if (!btn) return;
      currentFilter = btn.dataset.filter;
      meta.filter = currentFilter;
      persist();
      renderList();
    });

    $("#orderList").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-act]");
      if (!btn) return;
      const { act, id } = btn.dataset;
      if (act === "pay") openPayForm(id);
      else if (act === "keep") markKept(id);
      else if (act === "dup") duplicateOrder(id);
      else if (act === "edit") openForm(data.orders.find((x) => x.id === id));
      else if (act === "del") deleteOrder(id);
    });

    $("#orderForm").addEventListener("submit", submitForm);
    $("#formCancel").addEventListener("click", closeForm);

    $("#payForm").addEventListener("submit", submitPay);
    $("#payCancel").addEventListener("click", closePayForm);
    $("#payForm").addEventListener("input", updatePayPreview);
    $("#payQuick").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-add]");
      if (!btn || !payTargetId) return;
      const o = data.orders.find((x) => x.id === payTargetId);
      const input = $("#payForm").income;
      if (btn.dataset.add === "reset") input.value = o ? o.cost : "";
      else input.value = numberValue(input.value) + Number(btn.dataset.add);
      updatePayPreview();
    });

    $$(".modal").forEach((m) => m.addEventListener("click", (ev) => {
      if (ev.target === m) m.classList.remove("show");
    }));

    // 报表
    $("#repModes").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-mode]");
      if (!btn) return;
      reportMode = btn.dataset.mode;
      $$("#repModes .seg").forEach((c) => c.classList.toggle("on", c.dataset.mode === reportMode));
      const now = new Date();
      repCursor = { y: now.getFullYear(), m: now.getMonth() };
      renderReport();
    });
    $("#repPrev").addEventListener("click", () => { repCursor = shiftCursor(reportMode, repCursor, -1); renderReport(); });
    $("#repNext").addEventListener("click", () => { repCursor = shiftCursor(reportMode, repCursor, 1); renderReport(); });

    // 设置
    $("#copySyncCode").addEventListener("click", async () => {
      const box = $("#syncCodeText");
      box.select();
      try { await navigator.clipboard.writeText(box.value); toast("同步码已复制"); }
      catch { try { document.execCommand("copy"); toast("同步码已复制"); } catch { toast("请手动全选复制"); } }
    });
    $("#applySyncBtn").addEventListener("click", async () => {
      const code = $("#applySyncInput").value.trim();
      if (!code) { toast("先粘贴另一台设备的同步码"); return; }
      if (!confirm("导入同步码后，本机将与对方共用同一本账。\n首次同步以最新的一份数据为准，继续？")) return;
      try {
        syncEpoch += 1;                       // 作废旧身份在途的同步
        syncPending = false; clearTimeout(syncTimer);
        window.luhuoSync.applySyncCode(code);
        meta.updatedAt = null;
        meta.lastSyncedAt = null;
        meta.lastSyncError = "";
        persist();
        await pullFromCloud();
        syncEpoch += 1;
        render();
        renderSettings();
        scheduleSync();                       // 把采纳到的数据推上去，盖掉可能落地的旧包
        toast("同步码已导入");
      } catch (error) {
        toast(error.message || "同步码无效");
      }
    });
    $("#exportBtn").addEventListener("click", exportJson);
    $("#importFile").addEventListener("change", (ev) => {
      if (ev.target.files[0]) importJson(ev.target.files[0]);
      ev.target.value = "";
    });
    $("#resetIdentityBtn").addEventListener("click", async () => {
      if (!confirm("重置后本机将生成全新空账本（云端旧账不受影响，但没有同步码就再也连不上）。\n确定重置？")) return;
      if (!confirm("再次确认：旧账本数据将无法从本机再访问，确定？")) return;
      syncEpoch += 1;
      syncPending = false; clearTimeout(syncTimer);
      window.luhuoSync.resetIdentity();
      data = { version: 1, orders: [] };
      meta = { updatedAt: null, lastSyncedAt: null, lastSyncError: "", filter: "在途" };
      currentFilter = "在途";
      persist();
      render();
      renderSettings();
      toast("已重置为新账本");
    });
    $("#closeSettings").addEventListener("click", closeSettings);

    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushPendingSync(); });
    window.addEventListener("pagehide", flushPendingSync);
  }

  // ---- 启动 ----
  async function start() {
    loadLocal();
    populateSelects();
    bind();
    render();
    switchView("list");
    await pullFromCloud();
  }

  start();
})();
