// 撸货记账 · 主逻辑（v23）
// 状态只有两个：在途（垫了钱还没结清）/ 已回款；旧的「自留」单保留原样只读显示，不再能新建。
// 数据模型：单 JSON blob（orders 数组），经 sync.js 云同步（同设备组共用一个同步码）。
// v23：整批邮费/回款**可改可删**。每单多记 batchFeeShare/batchIncomeShare（本次真正摊到它头上的分额），
//      「自带部分 = fee − batchFeeShare/100」就成了覆盖/清零/退出扣减的地基；
//      批次表头加了「改本批邮费」入口（点开弹窗并预选该批全部成员）。
(function () {
  "use strict";

  // ---- 常量 ----
  const DATA_KEY = "luhuo-ledger-data-v1";
  const META_KEY = "luhuo-ledger-meta-v1";

  // v21 起「自留」退出模型：能创建的状态只有在途/已回款（货自己留着用就不算生意，用户宁可删单）。
  // 但旧账本里已经存在的「自留」（含更老的「翻车自留」）**原样保留、绝不静默改写**：
  // 它仍是合法的遗留值，照旧按「回款−垫付−邮费」计入已结算净盈亏，只是不再能新建。
  const STATUSES = ["在途", "已回款"];
  const LEGACY_STATUSES = ["自留"];              // 只读的遗留状态：认得、能显示，不能创建
  const SETTLED = ["已回款", "自留"];             // 「已结算」= 不在途：含旧自留（那笔钱已经落地）
  const FILTERS = ["在途", "全部", "已回款"];     // 账本页筛选；「全部」也要能记住
  const CHANNELS = ["收货商", "闲鱼", "转转", "朋友", "自用"];
  const STATUS_CLASS = { "在途": "st-out", "已回款": "st-done", "自留": "st-loss" };

  // ---- 状态 ----
  let data = { version: 1, orders: [] };
  let meta = { updatedAt: null, lastSyncedAt: null, lastSyncError: "", filter: "在途" };
  let editingId = null;
  let prefillPlatform = "";   // 「再来一单」预填时暂存原单平台（表单里没有平台输入框）
  let payTargetId = null;
  let batchItems = [];        // 批量结算弹窗的勾选状态：{ id, name, cost, checked }
  let batchMode = "overwrite"; // 弹窗里已有的整批再填金额时的语义：overwrite=改成新值 / append=追加到原有
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

  // 金额换算成“分”（整数）：分摊一律在分的层面算，严禁浮点直加
  function toCents(v) { return Math.round(numberValue(v) * 100); }

  // 把 totalCents（整数分）按 weights 拆成整数份：
  // 先 floor(total×w_i/Σw)，余数（必小于单数）逐分补给权重最大的单；Σw=0（全是 0 元购）按单数均分
  function splitByWeight(totalCents, weights) {
    const n = weights.length;
    const shares = new Array(n).fill(0);
    if (n === 0 || totalCents <= 0) return shares;
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum <= 0) {
      const base = Math.floor(totalCents / n);
      const rem = totalCents - base * n;
      for (let i = 0; i < n; i++) shares[i] = base + (i < rem ? 1 : 0);
      return shares;
    }
    let used = 0;
    for (let i = 0; i < n; i++) {
      shares[i] = Math.floor((totalCents * weights[i]) / sum);
      used += shares[i];
    }
    const rem = totalCents - used;
    const byWeight = weights.map((w, i) => i).sort((a, b) => weights[b] - weights[a] || a - b);
    for (let r = 0; r < rem; r++) shares[byWeight[r]] += 1;
    return shares;
  }

  // ---- 持久化 ----
  function persist() {
    localStorage.setItem(DATA_KEY, JSON.stringify(data));
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  }

  // 旧状态（待发货/待寄出/已寄出/退货中/翻车自留）→ 现役状态
  // 重点：v21 起「自留」不可再创建，但旧的「自留/翻车自留」必须落到「自留」这个**遗留值**上——
  // 既不能打回「在途」（那会把已经留着自用的货算成还垫在外面的钱），也不能改写成别的值。
  // 换句话说这里只是「认得」，不是「改写」：老数据的 status 一个字节都不动。
  function migrateStatus(status) {
    if (status === "已回款") return "已回款";
    if (status === "自留" || status === "翻车自留") return "自留";
    return "在途";
  }

  // 状态显示名：遗留在旧单上的「自留」标成「自留（旧）」，提醒它不是现在能新建的状态
  function statusLabel(status) {
    return LEGACY_STATUSES.includes(status) ? status + "（旧）" : status;
  }

  // 金额字段的**负值收敛**（v22）：cost / fee / batchFee / batchIncome 只在 < 0 时收敛为 0，
  // 其它一律不碰（0 与正数原样保留、小数保持两位以内原值）。
  // 为什么必须收敛：表单本来就拦负数（min="0"），能带进负数的只有**导入 JSON / 云端拉取**两条路，
  // 而负的 fee 会让两处自相矛盾——报表「本期邮费合计」只累加 > 0 的 fee（显示 ¥0），
  // 卡片上却照原样显示「邮费 −¥3」。收敛后全应用只有一个口径。
  // 注意：income 不在此列（负数回款在各处口径一致，没有这种自相矛盾），故不动。
  // v23 的 batchFeeShare / batchIncomeShare 也走同一规则（负值归 0），另加取整——它们的单位是**分**。
  function nonNegative(v) { const n = numberValue(v); return n < 0 ? 0 : n; }
  // 份额字段（分，整数）：负值归 0 + 取整，保证「分摊在分的层面算」这条不变量
  function shareCents(v) { return Math.max(0, Math.round(numberValue(v))); }

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
        cost: nonNegative(o.cost),
        pay: String(o.pay || ""),          // 已废弃字段，留着兼容旧数据
        channel: String(o.channel || ""),
        income: o.income === null || o.income === undefined || o.income === "" ? null : numberValue(o.income),
        incomeDate: o.incomeDate ? String(o.incomeDate) : null,
        status: migrateStatus(o.status),
        fee: nonNegative(o.fee),
        // 批次（一起寄出的那一批）：id 为空 = 没成批的单寄单；后四个是整批口径，
        // 冗余存在每张单上，删单不会留下孤儿批次记录
        batchId: String(o.batchId || ""),
        batchDate: o.batchDate ? String(o.batchDate) : "",
        batchFee: nonNegative(o.batchFee),
        batchIncome: nonNegative(o.batchIncome),
        // batchCount = 结算那一刻这一批的成员数；有人退出本批后不再改写它，
        // 表头据此区分「有人退出」（预期内）与「金额被改过」（真漂移）。老数据没有 → 0
        batchCount: Math.max(0, Math.round(numberValue(o.batchCount))),
        // v23：这一单在「整批邮费/回款」里**实际摊到多少**（分，整数）。整批录入值只管分组与对账，
        // 有了它才算得出「这一单自带的邮费」= fee − batchFeeShare/100（回款同理）；覆盖/清零/
        // 退出扣减全靠它。老数据没有 → 0，此时老批次的份额在覆盖/退出时按权重反推一次（见 batchShares）
        batchFeeShare: shareCents(o.batchFeeShare),
        batchIncomeShare: shareCents(o.batchIncomeShare),
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
      if (!FILTERS.includes(meta.filter)) meta.filter = "在途";
      currentFilter = meta.filter;
    } catch { /* 损坏则从空账本开始 */ }
  }

  // ---- 统计口径 ----
  function isSettled(order) { return SETTLED.includes(order.status); }
  function orderProfit(o) { return (o.income === null ? 0 : o.income) - o.cost - o.fee; }

  // 展示/汇总用的状态集合 = 现役两态 + 数据里实际出现的遗留态（旧「自留」）。
  // 必须带上遗留态，否则那些单子的垫付既不进环形图也不进状态行，
  // 「垫付合计」就会大于各状态之和、占比凑不满 100%。
  function statusKeys() {
    const keys = STATUSES.slice();
    LEGACY_STATUSES.forEach((s) => {
      if (data.orders.some((o) => o.status === s) && !keys.includes(s)) keys.push(s);
    });
    return keys;
  }

  function computeStats() {
    const orders = data.orders;
    let totalCost = 0, totalIncome = 0, outstanding = 0, outCount = 0, settledProfit = 0;
    let monthCost = 0, monthIncome = 0;
    const cm = currentMonth();
    const keys = statusKeys();
    const byStatus = {}; keys.forEach((s) => { byStatus[s] = { count: 0, cost: 0 }; });
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
    return { totalCost, totalIncome, outstanding, outCount, settledProfit, monthCost, monthIncome, byStatus, statusKeys: keys, months, count: orders.length };
  }

  // ---- 批次（一起寄出的一批单子）----
  // 一批一起寄出的单子共用一个 batchId，整批邮费/回款冗余存在每张单上：
  // 删单不会留下孤儿批次，也不需要额外维护一张批次表。
  function batchGroups() {
    const map = new Map();
    data.orders.forEach((o) => {
      if (!o.batchId) return;
      let g = map.get(o.batchId);
      if (!g) {
        g = {
          id: o.batchId, date: o.batchDate || o.date,
          feeCents: 0, incomeCents: 0, costCents: 0,
          count: 0, pending: 0, names: [],
        };
        map.set(o.batchId, g);
      }
      g.count += 1;
      g.costCents += toCents(o.cost);
      g.names.push(o.name || "未命名");
      if (!isSettled(o)) g.pending += 1;
      // 整批口径同值冗余，取最大可容忍半截写入的旧数据
      g.feeCents = Math.max(g.feeCents, toCents(o.batchFee));
      g.incomeCents = Math.max(g.incomeCents, toCents(o.batchIncome));
    });
    return map;
  }

  // 邮费归期：整批寄的按批次日期，单寄的按下单日期。
  // 统计口径 = 成员明细合计：成批的单子一律按各单自己记的 fee 汇总，批次只管分组与归期，
  // 不再拿整批录入值当统计取值（v20 的 max(batchFee) 口径在「退出本批」时会把退出那单的
  // 分摊额重复计一次；成员入批前自带邮费时又会少算）。这样恒有：
  //   本期邮费合计 = Σ各批成员 fee + Σ单寄 fee = 本期归期的所有单子 fee 之和
  function reportFeeStats(startD, endD) {
    const batches = [];
    let totalCents = 0;
    batchGroups().forEach((g) => {
      const d = parseDate(g.date);
      if (!d || d < startD || d >= endD) return;
      const members = data.orders.filter((o) => o.batchId === g.id);
      const feeCents = members.reduce((a, o) => a + toCents(o.fee), 0);
      if (feeCents <= 0) return;
      const incomeCents = members.reduce((a, o) => a + (o.income === null ? 0 : toCents(o.income)), 0);
      // entry* = 用户录入口径的整批数字，只用于「整批录入 ¥X」的备注，不参与统计
      batches.push(Object.assign({}, g, {
        feeCents, incomeCents, entryFeeCents: g.feeCents, entryIncomeCents: g.incomeCents,
      }));
      totalCents += feeCents;
    });
    batches.sort((a, b) => (a.date < b.date ? 1 : -1));

    let looseCents = 0, looseCount = 0;
    const looseNames = [];
    data.orders.forEach((o) => {
      if (o.batchId) return;                       // 成批的已按成员明细计入，不重复
      const d = parseDate(o.date);
      if (!d || d < startD || d >= endD) return;
      const cents = toCents(o.fee);
      if (cents <= 0) return;
      looseCents += cents;
      looseCount += 1;
      looseNames.push(o.name || "未命名");
    });
    totalCents += looseCents;
    return { totalCents, batches, looseCents, looseCount, looseNames };
  }

  // 这一批里**每张单各摊到多少分**（整批邮费 / 整批回款各一份表）。
  // 权威来源是结算时写下的 batchFeeShare / batchIncomeShare；唯一的例外是 v23 之前的老批次——
  // 整批数字 > 0 而各单份额全为 0（那时还没这两个字段），就按当时的分摊规则（权重＝各单垫付、
  // 在分层面取整）用整批数字反推一次。不反推的话，「覆盖」会把成员入批前的自带邮费当成 0、
  // 把整批数字再叠一遍（fee 会越改越大），「退出扣减」也无从扣起。
  // 反推只在**份额全为 0**时发生：份额有值但合计对不上，说明那一批后来被手工改过或删过单，
  // 这时必须相信单上的记录，不能拿整批数字重算（那会把别人改过的钱抹平）。
  function batchShares(members, shareKey, totalCents) {
    const recorded = members.map((o) => shareCents(o[shareKey]));
    if (totalCents <= 0 || recorded.some((v) => v > 0)) return recorded;
    return splitByWeight(totalCents, members.map((o) => Math.max(0, toCents(o.cost))));
  }
  // 这一批各成员当前的份额表（Map: 单 id → 分），老批次按权重反推。
  // 覆盖时要拿它算「自带部分」，所以必须按 id 取——弹窗里的顺序和 data.orders 的顺序不一定一样
  function batchShareMap(batchId, shareKey, totalCents) {
    const members = data.orders.filter((o) => o.batchId === batchId);
    const table = batchShares(members, shareKey, totalCents);
    const map = new Map();
    members.forEach((m, i) => map.set(m.id, table[i]));
    return map;
  }
  // 一张单「自带的部分」（分）＝ 它现在的金额 − 它在本批分摊到的份额（份额由调用方给：
  // 覆盖时来自 batchShareMap，因为老批次单上没有份额字段、得按整批数字反推）。
  // 成员入批前自己记过邮费、或它带着上一批的摊额挪进新批次时，全靠这个减法把原值摘出来。
  function ownCentsOf(order, amountKey, shareValue) {
    const total = amountKey === "income"
      ? (order.income === null || order.income === undefined ? 0 : toCents(order.income))
      : toCents(order[amountKey]);
    return total - shareValue;
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
    // 本月邮费：归期同报表页（整批按批次日期、单寄按下单日期），挂在「本月垫出」下面当补充口径
    const cmParts = currentMonth().split("-").map(Number);
    const monthFee = reportFeeStats(new Date(cmParts[0], cmParts[1] - 1, 1), new Date(cmParts[0], cmParts[1], 1));
    $("#kpiMonthFee").textContent = `另有邮费 ${money(monthFee.totalCents / 100)}`;
    $("#kpiMonthIncome").textContent = money(s.monthIncome);
    $("#kpiTotal").textContent = `${money(s.totalCost)} / ${money(s.totalIncome)}`;

    // 订单状态：垫付占比小环形 + 三态行
    // 环形图 + 状态行都按 statusKeys（现役两态 + 数据里真有的遗留态），
    // 这样各块垫付之和恒等于分母「垫付合计」，占比加起来正好 100%
    const stColors = { "在途": "#7d8fa1", "已回款": "#14b8a6", "自留": "#c0724f" };
    const donutItems = s.statusKeys.map((st) => ({ name: st, value: s.byStatus[st].cost })).filter((x) => x.value > 0);
    $("#statusDonut").innerHTML = s.totalCost > 0
      ? chartDonutSVG(donutItems, s.totalCost, "垫付合计", donutItems.map((it) => stColors[it.name]))
      : `<div class="empty-mini">暂无垫付</div>`;
    $("#statusList").innerHTML = s.statusKeys.map((st) => {
      const b = s.byStatus[st];
      return `<div class="status-row">
        <span class="status-tag ${STATUS_CLASS[st]}">${escapeHtml(statusLabel(st))}</span>
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
    // v21 起没有「自留」筛选（那个状态不能再新建）；旧自留单在「全部」里看得到、可手动删除
    const chips = ["在途", "全部", "已回款"];
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
    // 同批的单子收成一块：成员各自的下单日期可能夹着别的单，但显示上必须挨在一起，
    // 否则散单会插进批次表头和成员之间、看起来像这一批的。块按下单日期倒序定位（也就是原来表头的位置）
    const groups = batchGroups();
    const blocks = [];
    const blockOf = new Map();
    orders.forEach((o) => {
      if (!o.batchId) { blocks.push({ id: "", date: o.date, orders: [o] }); return; }
      let b = blockOf.get(o.batchId);
      if (!b) { b = { id: o.batchId, date: o.date, orders: [] }; blockOf.set(o.batchId, b); blocks.push(b); }
      b.orders.push(o);
      if (o.date > b.date) b.date = o.date;
    });
    blocks.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
    const parts = [];
    blocks.forEach((b) => {
      const g = b.id ? groups.get(b.id) : null;
      const grouped = g && g.count > 1;      // 只剩一单的批次不再撑表头，免得「一起寄出 · 1 单」
      const solo = !!g && g.count === 1;     // 单成员批次：没表头，卡片上补一句它的批次归属
      if (grouped) parts.push(batchHeadHtml(g, orders));
      b.orders.forEach((o) => parts.push(orderCardHtml(o, grouped ? "in-batch" : "", solo)));
    });
    $("#orderList").innerHTML = parts.join("");
  }

  // 整批口径 vs 成员明细：结算那一刻两者本来就相等（邮费按分摊落到各单、回款按分摊写到各单），
  // 之后手工改某单邮费、或单给某单回款就会分叉。只对表头真显示出来的那两项对账，只报数不动钱。
  // v22 修的两件事：
  //   ① 金额对账**永远要跑**。v21 在「当前成员数 < batchCount」时直接 return 陈述句、跳过对账——
  //      于是 3 单同批（整批邮费 ¥12）删掉一单后再把另一单邮费改成 ¥99（整批 12 vs 明细 103，
  //      差 91 元）时，表头只剩那句陈述、不再告警：专门抓静默漂移的机制自己静默失效了。
  //      现在两条腿各走各的、结论并存：有人退出（陈述，非告警）＋ 金额合不上（告警）。
  //   ② 措辞中性化：batchCount 只记得到人数，分不出「退出本批」与「删除该单」，
  //      所以陈述句说「不在其中（退出或删除）」而不是断言「退出本批」。
  // 返回一个数组（0/1/2 条），warn=true 的那条用红棕色显示。
  function batchDrift(g, members, batchCount) {
    const notes = [];
    if (batchCount > 0 && members.length < batchCount) {
      // v23 起不再断言「整批口径仍含它们」：退出本批的人带走的份额会从剩余成员的整批口径里
      // **扣掉**（见 leaveBatch），录入值因此恒等于当前成员的份额合计。措辞保持中性——
      // batchCount 分不出「退出本批」与「删除该单」，而删单走的是另一条路（份额不扣，由下面的
      // 金额告警如实报出来）。那句话留着已经不准，删掉。
      notes.push({ warn: false, text: `本批已有 ${batchCount - members.length} 单不在其中（退出或删除）` });
    }
    const diff = [];
    if (g.feeCents > 0) {
      const feeSum = members.reduce((a, o) => a + toCents(o.fee), 0);
      if (feeSum !== g.feeCents) diff.push(`邮费 ${money(feeSum / 100)}`);
    }
    if (g.incomeCents > 0) {
      const incSum = members.reduce((a, o) => a + (o.income === null ? 0 : toCents(o.income)), 0);
      if (incSum !== g.incomeCents) diff.push(`回款 ${money(incSum / 100)}`);
    }
    if (diff.length > 0) {
      notes.push({ warn: true, text: `≠ 成员明细合计 ${diff.join(" · ")}，与整批口径不同` });
    }
    return notes;
  }

  function batchHeadHtml(g, visible) {
    const shownCount = visible.filter((o) => o.batchId === g.id).length;
    const members = data.orders.filter((o) => o.batchId === g.id);
    // 结算时的成员数冗余在每张单上（取最大，容忍半截写入的旧数据）；老数据没有这个字段就是 0
    const batchCount = members.reduce((a, o) => Math.max(a, Math.round(numberValue(o.batchCount))), 0);
    const bits = [`垫付 ${money(g.costCents / 100)}`];
    if (g.feeCents > 0) bits.push(`邮费 ${money(g.feeCents / 100)}`);
    if (g.incomeCents > 0) bits.push(`回款 ${money(g.incomeCents / 100)}`);
    if (g.pending > 0) bits.push(`${g.pending} 单在途`);
    const drift = batchDrift(g, members, batchCount);
    return `<div class="batch-head">
      <div class="bh-top">
        <span class="bh-title">一起寄出 · ${escapeHtml(g.date)}</span>
        <span class="bh-count">${g.count} 单</span>
      </div>
      <div class="bh-meta-row">
        <div class="bh-meta">整批：${bits.join(" · ")}</div>
        <button type="button" class="bh-act" data-act="batchfee" data-batch="${escapeHtml(g.id)}">改本批邮费</button>
      </div>
      ${shownCount < g.count ? `<div class="bh-note">本页只显示其中 ${shownCount} 单，另有 ${g.count - shownCount} 单被筛选隐藏</div>` : ""}
      ${drift.map((n) => `<div class="bh-note${n.warn ? " warn" : ""}">${n.text}</div>`).join("")}
    </div>`;
  }

  // soloBatch：这一单的批次只剩它自己（页面上不显示「一起寄出」表头），卡片里补一句归属，
  // 免得「退出本批」这个按钮看起来没有来由
  function orderCardHtml(o, extraClass, soloBatch) {
    const settled = isSettled(o);
    const profit = orderProfit(o);
    const showProfit = o.income !== null || settled;
    const actions = [];
    if (!settled) actions.push(`<button class="act primary" data-act="pay" data-id="${o.id}">回款</button>`);
    actions.push(`<button class="act" data-act="dup" data-id="${o.id}">再来一单</button>`);
    actions.push(`<button class="act" data-act="edit" data-id="${o.id}">编辑</button>`);
    if (o.batchId) actions.push(`<button class="act" data-act="unbatch" data-id="${o.id}">退出本批</button>`);
    actions.push(`<button class="act danger" data-act="del" data-id="${o.id}">删除</button>`);
    return `<div class="order-card ${extraClass || ""}">
      <div class="order-top">
        <span class="order-name">${escapeHtml(o.name || "未命名")}</span>
        <span class="status-tag ${STATUS_CLASS[o.status]}">${escapeHtml(statusLabel(o.status))}</span>
      </div>
      <div class="order-mid">${escapeHtml(o.date)}${o.platform ? " · " + escapeHtml(o.platform) : ""} · ${o.qty} 件${o.channel ? " · " + escapeHtml(o.channel) : ""}${soloBatch ? " · 单独一批寄出" : ""}</div>
      <div class="order-money">
        <span>垫付 <b>${money(o.cost)}</b></span>
        <span>回款 <b>${o.income === null ? "—" : money(o.income)}</b></span>
        <span>邮费 <b>${money(o.fee)}</b></span>
        ${showProfit ? `<span>利润 <b class="${profit > 0 ? "pos" : profit < 0 ? "neg" : ""}">${money(profit)}</b></span>` : ""}
      </div>
      ${o.note ? `<div class="order-note">${escapeHtml(o.note)}</div>` : ""}
      <div class="order-actions">${actions.join("")}</div>
    </div>`;
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
  const PALETTE = ["#14b8a6", "#7d8fa1", "#c0724f", "#7a5fb5", "#8a8378"];
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
          <stop offset="0" stop-color="#7d8fa1" stop-opacity=".28"/><stop offset="1" stop-color="#b97909" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="${idB}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#14b8a6" stop-opacity=".32"/><stop offset="1" stop-color="#17b26a" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}
      ${area("cost", idA)}${area("income", idB)}
      <path d="${path("cost")}" fill="none" stroke="#7d8fa1" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <path d="${path("income")}" fill="none" stroke="#14b8a6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots("cost", "#7d8fa1")}${dots("income", "#14b8a6")}
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
        fill="${s.profit >= 0 ? "#14b8a6" : "#c0724f"}" opacity="${s.profit === 0 ? .25 : .9}"/>`;
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
    const feeStats = reportFeeStats(range.start, range.end);
    if (s.n === 0 && s.income === 0) {
      lines.push(`<b>${escapeHtml(range.label)}</b> 没有记录。`);
    } else {
      lines.push(`<b>${escapeHtml(range.label)}</b> 共 ${s.n} 单：垫出 <b>${money(s.cost)}</b>，邮费 <b>${money(feeStats.totalCents / 100)}</b>，收回 <b>${money(s.income)}</b>，净${s.profit >= 0 ? "赚" : "亏"} <b class="${s.profit >= 0 ? "pos" : "neg"}">${money(s.profit)}</b>。`);
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

    // 邮费统计：整批一起寄的合成一行（含这一批都是哪些货），单寄的合并成一行
    const feeRows = feeStats.batches.map((b) => {
      const nums = [`${b.count} 单`, `邮费 ${money(b.feeCents / 100)}`];
      if (b.incomeCents > 0) nums.push(`回款 ${money(b.incomeCents / 100)}`);
      if (b.pending > 0) nums.push(`${b.pending} 单在途`);
      // 明细合计与用户录入的整批数字不同时（有人退出、成员入批前自带邮费、手工改过）点一句，
      // 免得对照账本页表头的「整批：…」以为算错了；统计值永远是成员明细那一列
      if (b.entryFeeCents > 0 && b.entryFeeCents !== b.feeCents) nums.push(`整批录入 邮费 ${money(b.entryFeeCents / 100)}`);
      if (b.entryIncomeCents > 0 && b.entryIncomeCents !== b.incomeCents) nums.push(`整批录入 回款 ${money(b.entryIncomeCents / 100)}`);
      return `<div class="fee-row">
        <div class="fee-line">
          <span class="fee-name">一起寄 · ${escapeHtml(b.date)}</span>
          <span class="fee-nums">${nums.join(" · ")}</span>
        </div>
        <div class="fee-names">${escapeHtml(b.names.join("、"))}</div>
      </div>`;
    });
    if (feeStats.looseCount > 0) {
      feeRows.push(`<div class="fee-row">
        <div class="fee-line">
          <span class="fee-name">单寄（未成批）</span>
          <span class="fee-nums">${feeStats.looseCount} 单 · 邮费 ${money(feeStats.looseCents / 100)}</span>
        </div>
        <div class="fee-names">${escapeHtml(feeStats.looseNames.join("、"))}</div>
      </div>`);
    }
    $("#reportFees").innerHTML = feeRows.length === 0
      ? `<div class="empty-mini">本期没有邮费记录</div>`
      : `<div class="fee-total"><span>本期邮费合计</span><b>${money(feeStats.totalCents / 100)}</b></div>${feeRows.join("")}`;

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
  // order：编辑既有单（editingId = 其 id）；prefill：「再来一单」预填（editingId 保持 null，保存即新建）
  function openForm(order, prefill) {
    const src = order || prefill || null;
    editingId = order ? order.id : null;
    prefillPlatform = !order && prefill ? String(prefill.platform || "") : "";
    const f = $("#orderForm");
    f.goods.value = src ? src.name : "";
    f.cost.value = src ? (src.cost || "") : "";
    f.qty.value = src ? src.qty : 1;
    f.date.value = order ? order.date : todayStr();     // 预填/新建一律用今天
    f.channel.value = src ? (src.channel || "收货商") : "收货商";
    f.fee.value = src ? (src.fee || "") : "";
    // 状态下拉：现役两态；编辑遗留「自留」单时把该单自己的旧状态补进去（只读项），
    // 否则下拉会因没有匹配项而回空、保存时把状态静默改写掉——v21 的红线就是不许改写旧状态
    const statusOpts = STATUSES.slice();
    if (order && !statusOpts.includes(order.status)) statusOpts.push(order.status);
    fillSelect(f.status, statusOpts.map((s) => [s, statusLabel(s)]), order ? order.status : "在途");
    f.note.value = src ? src.note : "";
    $("#formTitle").textContent = order ? "编辑订单" : "记一单";
    $("#formMore").open = !!(order && order.status !== "在途");
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
      platform: existing ? existing.platform : prefillPlatform,
      qty: Math.max(1, Math.round(numberValue(f.qty.value)) || 1),
      cost,
      pay: existing ? existing.pay : "",
      channel: String(f.channel.value || "").trim(),
      income: existing ? existing.income : null,
      incomeDate: existing ? existing.incomeDate : null,
      status: f.status.value,
      fee: numberValue(f.fee.value),
      // 编辑不改变批次归属（改的是这一单自己的字段，整批口径仍以批量结算时为准）；
      // v23 的份额同样原样带过——它们记的是「本批摊到这一单多少」，编辑这一单的邮费时不能丢，
      // 丢了「自带部分」就算错了（下次覆盖会把整批数字再叠一遍）
      batchId: existing ? existing.batchId : "",
      batchDate: existing ? existing.batchDate : "",
      batchFee: existing ? existing.batchFee : 0,
      batchIncome: existing ? existing.batchIncome : 0,
      batchCount: existing ? existing.batchCount : 0,
      batchFeeShare: existing ? existing.batchFeeShare : 0,
      batchIncomeShare: existing ? existing.batchIncomeShare : 0,
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
    openForm(null, o);   // 预填原单信息，保存即新建一单
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
    $("#payPreview").innerHTML = `利润 <b class="${profit > 0 ? "pos" : profit < 0 ? "neg" : ""}">${profit >= 0 ? "+" : ""}${money(profit)}</b>（垫付 ${money(o.cost)}${o.fee ? "＋邮费 " + money(o.fee) : ""}）`;
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
    const mates = o.batchId ? data.orders.filter((x) => x.batchId === o.batchId) : [];
    const n = mates.length;
    const batchLine = n > 1
      ? `它属于一起寄出的 ${n} 单之一，删掉后该批还剩 ${n - 1} 单${n - 1 === 1 ? "（只剩它自己，「一起寄出」那一栏就没了）" : ""}。\n整批邮费/回款照旧记在剩下的单子上。\n`
      : n === 1 ? "它是「一起寄出」那批的最后一单，删掉这一批就没了。\n" : "";
    if (!confirm(`删除「${o.name}」这一单？\n${batchLine}删除后无法恢复（云端也会删）。`)) return;
    data.orders = data.orders.filter((x) => x.id !== id);
    saveData();
    toast("已删除");
  }

  // 退出本批：结错批时的救回口子。解开这一单的批次归属，**不动它自己的钱**——
  // 整批分摊到它头上的邮费/回款留在它自己的 fee/income 里，照旧算利润（v20 定的规矩）。
  // v23 补的那一半：它带走的份额要**从剩余成员的整批口径里扣掉**，整批录入值才恒等于
  // 「当前成员实际分摊之和」。v22 之前不扣，于是退出后表头永远报一句「整批口径仍含它们」式的
  // 假漂移（D-3），而这句陈述又把同一批的金额告警顶掉，用户分不清是退出还是钱被改坏了。
  function leaveBatch(id) {
    const o = data.orders.find((x) => x.id === id);
    if (!o || !o.batchId) return;
    const mates = data.orders.filter((x) => x.batchId === o.batchId);
    const others = mates.filter((x) => x.id !== id);
    const title = `一起寄出 · ${o.batchDate || o.date}`;
    const tail = others.length === 0
      ? "它本来就是这一批里唯一的一单，退出后这一批就没了。"
      : `退出后它不再和另外 ${others.length} 单绑在一起${others.length === 1 ? "，那单也只剩自己、一并退出批次。" : `，该批还剩 ${others.length} 单（整批邮费/回款会按份额扣掉它那部分）。`}`;
    if (!confirm(`「${o.name}」退出「${title}」这一批？\n${tail}\n`
      + `已经分摊到它头上的邮费 ${money(o.fee)}${o.income === null ? "" : "、回款 " + money(o.income)} 不改动，留在这一单上继续算利润。`)) return;
    // 退出者（以及「只剩它自己」时一并退出那一单）清空全部批次字段；留着的成员**不动 batchCount**——
    // 它记的是「结算那一刻有几个人」，正是表头区分「有人退出」与「金额被改过」的依据。
    // 剩下的人之后若原班人马再结一次，batchCount 会被重写成当时的人数，提示随之消失。
    const g = batchGroups().get(o.batchId);
    const idx = mates.findIndex((x) => x.id === id);
    const outFee = idx < 0 ? 0 : batchShares(mates, "batchFeeShare", g ? g.feeCents : 0)[idx];
    const outIncome = idx < 0 ? 0 : batchShares(mates, "batchIncomeShare", g ? g.incomeCents : 0)[idx];
    const leavers = [o].concat(others.length === 1 ? others : []);
    const leaverIds = new Set(leavers.map((x) => x.id));
    mates.filter((x) => !leaverIds.has(x.id)).forEach((x) => {
      x.batchFee = Math.max(0, toCents(x.batchFee) - outFee) / 100;
      x.batchIncome = Math.max(0, toCents(x.batchIncome) - outIncome) / 100;
    });
    leavers.forEach((x) => {
      x.batchId = ""; x.batchDate = ""; x.batchFee = 0; x.batchIncome = 0; x.batchCount = 0;
      x.batchFeeShare = 0; x.batchIncomeShare = 0;
    });
    saveData();
    toast(others.length === 1 ? "已退出，那一批也解散了" : "已退出本批，这一单变成单寄");
  }

  // ---- 批量结算（整批寄出 / 对方一笔总回款，按垫付占比分摊）----
  // 结算过的单子记下批次：一批一起寄出去的货从此绑在一起，回头补回款时整批一键勾选，
  // 账本和报表里也按「一起寄出」合并显示，看得到这一批到底是哪些货。
  // v23：所勾选单**恰好是某个已存在批次的整批原班人马**时，这次填的金额可以选
  // 「改成新值（覆盖）」还是「追加到原有」——覆盖用于「寄出去后发现邮费变了」，填 0 就是
  // 删掉这一批的这笔钱（成员回到各自的自带部分）；两个框都留空 = 一个字都不动。
  // 从批次表头「改本批邮费」进来时预选该批全部成员（含已回款的），于是「改错的钱」变成
  // 点一下 → 填新值 → 覆盖。
  function openBatchModal(preselectBatchId) {
    const pool = data.orders.filter((o) => o.status === "在途");
    if (preselectBatchId) {
      // 这一批的**全部成员**都要列进来：弹窗平时只列在途单，已经收过款的那批一进来就空了，
      // 「邮费记错了」却正好常常是在回款之后才发现的
      const seen = new Set(pool.map((o) => o.id));
      data.orders.forEach((o) => {
        if (o.batchId === preselectBatchId && !seen.has(o.id)) { pool.push(o); seen.add(o.id); }
      });
    }
    if (pool.length === 0) { toast("没有在途单可结算"); return; }
    const groups = batchGroups();
    // 同批次的单排在一起、批次日期新的在前（先摊了邮费的那批最好找），没成批的殿后
    const rank = new Map();
    pool.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).forEach((o) => {
      if (!o.batchId || rank.has(o.batchId)) return;
      const g = groups.get(o.batchId);
      rank.set(o.batchId, g ? g.date : "");
    });
    pool.sort((a, b) => {
      const ra = a.batchId ? rank.get(a.batchId) : undefined;
      const rb = b.batchId ? rank.get(b.batchId) : undefined;
      if (ra === undefined && rb === undefined) return a.date < b.date ? 1 : -1;
      if (ra === undefined) return 1;
      if (rb === undefined) return -1;
      if (ra !== rb) return ra < rb ? 1 : -1;
      return a.date < b.date ? 1 : -1;
    });
    batchItems = pool.map((o) => ({
      id: o.id, name: o.name, cost: o.cost, batchId: o.batchId,
      checked: preselectBatchId ? o.batchId === preselectBatchId : true,
    }));
    batchMode = "overwrite";      // 默认覆盖：改错的钱本来就该用新值盖掉
    $("#batchFee").value = "";
    $("#batchIncome").value = "";
    $("#batchDate").value = todayStr();
    renderBatchList();
    $("#batchModal").classList.add("show");
  }

  // 所勾选的单恰好是某个已存在批次的整批原班人马吗？→ 提交时复用该批次号（v19 的既有规则），
  // 弹窗里也用它决定要不要问「覆盖 / 追加」。prev=null ＝ 这次是新批次，没有歧义、不显示选择。
  function selectedBatchInfo() {
    const orders = batchItems.filter((it) => it.checked)
      .map((it) => data.orders.find((o) => o.id === it.id)).filter(Boolean);
    let reuseId = "";
    if (orders.length > 0 && orders.every((o) => o.batchId)) {
      const ids = new Set(orders.map((o) => o.batchId));
      if (ids.size === 1) {
        const cand = [...ids][0];
        const selectedIds = new Set(orders.map((o) => o.id));
        if (data.orders.every((o) => o.batchId !== cand || selectedIds.has(o.id))) reuseId = cand;
      }
    }
    return { orders, reuseId, prev: reuseId ? (batchGroups().get(reuseId) || null) : null };
  }

  // 「改成新值（覆盖）/ 追加到原有」这一行：只在所勾选单恰好是某个**已有邮费或回款**的整批
  // 原班人马时出现（新建批次没有歧义，不打扰）。「留空＝不动」要写在明面上：先只摊邮费、
  // 回款到了再补一趟是常用的两趟打法，不能因为默认是覆盖就把已经记好的邮费清掉。
  function updateBatchMode() {
    const box = $("#batchMode");
    if (!box) return;
    const prev = selectedBatchInfo().prev;
    const show = !!(prev && (prev.feeCents > 0 || prev.incomeCents > 0));
    if (!show) { box.hidden = true; box.innerHTML = ""; return; }
    const bits = [];
    if (prev.feeCents > 0) bits.push(`邮费 <b>${money(prev.feeCents / 100)}</b>`);
    if (prev.incomeCents > 0) bits.push(`回款 <b>${money(prev.incomeCents / 100)}</b>`);
    box.hidden = false;
    box.innerHTML = `<div class="bm-hint">这一批现有 ${bits.join(" · ")}。两个框<b>留空＝不动</b>；`
      + `填数字按下面选的方式处理，填 0 就是删掉这一批的这笔钱。</div>`
      + `<div class="bm-chips">`
      + `<button type="button" class="bm-chip${batchMode === "overwrite" ? " on" : ""}" data-mode="overwrite">改成新值（覆盖）</button>`
      + `<button type="button" class="bm-chip${batchMode === "append" ? " on" : ""}" data-mode="append">追加到原有</button>`
      + `</div>`;
  }

  function closeBatchModal() {
    $("#batchModal").classList.remove("show");
    batchItems = [];
  }

  function renderBatchList() {
    if (batchItems.length === 0) {
      $("#batchList").innerHTML = `<div class="empty-mini">没有在途单可结算</div>`;
      updateBatchSummary();
      return;
    }
    const groups = batchGroups();
    const parts = [];
    const seen = new Set();
    let sepShown = false;
    batchItems.forEach((it, i) => {
      if (it.batchId && !seen.has(it.batchId)) {
        seen.add(it.batchId);
        const idxs = [];
        batchItems.forEach((x, j) => { if (x.batchId === it.batchId) idxs.push(j); });
        const onCount = idxs.filter((j) => batchItems[j].checked).length;
        const g = groups.get(it.batchId);
        const tags = [];
        if (g && g.feeCents > 0) tags.push(`已分摊邮费 ${money(g.feeCents / 100)}`);
        if (g && g.incomeCents > 0) tags.push(`已回款 ${money(g.incomeCents / 100)}`);
        parts.push(`<label class="batch-item bg-row">
          <input type="checkbox" data-group="${escapeHtml(it.batchId)}"${onCount === idxs.length ? " checked" : ""}${onCount > 0 && onCount < idxs.length ? ` data-partial="1"` : ""}>
          <span class="bg-title">一起寄 · ${escapeHtml(g ? g.date : "")}</span>
          <span class="bi-cost">${idxs.length} 单</span>
        </label>`);
        if (tags.length > 0) parts.push(`<div class="bg-tags">${tags.join(" · ")}${onCount === idxs.length ? `　整批再填金额可按「覆盖 / 追加」处理` : ""}</div>`);
      } else if (!it.batchId && !sepShown && seen.size > 0) {
        sepShown = true;
        parts.push(`<div class="bg-sep">未成批（单寄的单子）</div>`);
      }
      parts.push(`<label class="batch-item${it.batchId ? " in-group" : ""}">
        <input type="checkbox" data-idx="${i}"${it.checked ? " checked" : ""}>
        <span class="bi-name">${escapeHtml(it.name || "未命名")}</span>
        <span class="bi-cost">${money(it.cost)}</span>
      </label>`);
    });
    $("#batchList").innerHTML = parts.join("");
    $$("#batchList input[data-partial='1']").forEach((cb) => { cb.indeterminate = true; });
    updateBatchMode();
    updateBatchSummary();
  }

  // 只更新合计行，不触发 saveData
  function updateBatchSummary() {
    const sel = batchItems.filter((it) => it.checked);
    const totalCents = sel.reduce((a, b) => a + toCents(b.cost), 0);
    $("#batchSummary").textContent = sel.length === 0
      ? "还没勾选任何单子"
      : `已选 ${sel.length} 单 · 垫付合计 ${money(totalCents / 100)}`;
  }

  function submitBatch() {
    const sel = selectedBatchInfo();
    const orders = sel.orders;
    if (orders.length === 0) { toast("先勾选要结算的在途单"); return; }
    // 留空＝这一项不动（保住「先只摊邮费、回款到了再补一趟」的两趟打法：默认是覆盖，
    // 但覆盖只对**填了数字**的那一项生效，不会顺手把已有邮费清掉）
    const feeGiven = String($("#batchFee").value || "").trim() !== "";
    const incomeGiven = String($("#batchIncome").value || "").trim() !== "";
    const feeCents = feeGiven ? Math.max(0, toCents($("#batchFee").value)) : 0;
    const incomeCents = incomeGiven ? Math.max(0, toCents($("#batchIncome").value)) : 0;
    const weights = orders.map((o) => Math.max(0, toCents(o.cost)));
    const prev = sel.prev;
    const batchId = sel.reuseId || uid();
    const batchDate = (prev && prev.date) || $("#batchDate").value || todayStr();
    // 覆盖 = 按这次填的整批总额**重新分摊**（幂等：同样的输入跑两遍结果一样，见 ownCentsOf）；
    // 追加 = 沿用 v22 的累加语义；新批次没有歧义，一律按新批次写入。
    const overwrite = !!prev && batchMode !== "append";
    // 覆盖要拿这一批**当前**的份额表（按 id 取；老批次单上没有份额字段 → 按整批数字×权重反推），
    // 因为它决定「自带部分」是多少：份额读成 0 的话，覆盖会把整笔 fee 当自带部分、金额越改越大
    const oldFeeShares = overwrite ? batchShareMap(sel.reuseId, "batchFeeShare", prev.feeCents) : null;
    const oldIncomeShares = overwrite ? batchShareMap(sel.reuseId, "batchIncomeShare", prev.incomeCents) : null;

    // 原批次被带走的份额：必须在改动任何单之前算完（改完再算读到的就是已经写过的值）。
    // 只勾了某一批的一部分人、或几个批混着一起结 → 这些单会进新批次，它们从原批次带走的份额
    // 同样要从原批次**剩余成员**的整批口径里扣掉（v23·D-3 的另一半：重组成批）
    if (!sel.reuseId) {
      const takenIds = new Set(orders.map((o) => o.id));
      const groups = batchGroups();
      const deduct = new Map();
      new Set(orders.map((o) => o.batchId).filter(Boolean)).forEach((sid) => {
        const g = groups.get(sid);
        if (!g) return;
        const members = data.orders.filter((o) => o.batchId === sid);
        const feeShares = batchShares(members, "batchFeeShare", g.feeCents);
        const incomeShares = batchShares(members, "batchIncomeShare", g.incomeCents);
        let fee = 0, income = 0;
        members.forEach((m, i) => {
          if (!takenIds.has(m.id)) return;
          fee += feeShares[i];
          income += incomeShares[i];
        });
        if (fee > 0 || income > 0) deduct.set(sid, { fee, income });
      });
      deduct.forEach((d, sid) => {
        data.orders.forEach((m) => {
          if (m.batchId !== sid || takenIds.has(m.id)) return;
          m.batchFee = Math.max(0, toCents(m.batchFee) - d.fee) / 100;
          m.batchIncome = Math.max(0, toCents(m.batchIncome) - d.income) / 100;
        });
      });
    }

    // 邮费：覆盖＝「自带部分 + 本次新份额」（自带部分 = 现在的 fee − 本批份额，所以重复跑结果不变）；
    // 追加＝直接在现有 fee 上累加（单子可能自己寄出时已记过邮费，这是 v22 起的有意设计）。
    // 份额字段：新批次从零起算（上一批的份额并进自带部分），同批追加才累加。
    if (feeGiven) {
      const feeShares = splitByWeight(feeCents, weights);
      orders.forEach((o, i) => {
        const base = prev ? shareCents(o.batchFeeShare) : 0;
        const next = overwrite ? ownCentsOf(o, "fee", oldFeeShares.get(o.id) || 0) + feeShares[i] : toCents(o.fee) + feeShares[i];
        // 覆盖时兜一下底：自带部分可能是负数（有人手工把这一单的邮费改到比它摊到的还低，
        // 或这份是「删过成员的旧批次」反推出来的份额），加起来若为负就按 0 收——负数只可能来自
        // 脏数据，一旦写进账本又会变成「卡片显示 −¥3、报表 ¥0」那种自相矛盾（v22 修的就是这个）
        o.fee = Math.max(0, next) / 100;
        o.batchFeeShare = (overwrite ? 0 : base) + feeShares[i];
      });
    }

    // 回款：同理（回款是「收到的钱」，所以追加＝在已收到的金额上继续累加）。
    // 总回款 > 0 才把单子置为已回款；填 0 是「清零」——金额退回自带部分，状态不因此回退。
    if (incomeGiven) {
      const incomeShares = splitByWeight(incomeCents, weights);
      orders.forEach((o, i) => {
        const base = prev ? shareCents(o.batchIncomeShare) : 0;
        const have = o.income === null || o.income === undefined ? 0 : toCents(o.income);
        o.income = (overwrite ? ownCentsOf(o, "income", oldIncomeShares.get(o.id) || 0) + incomeShares[i] : have + incomeShares[i]) / 100;
        o.batchIncomeShare = (overwrite ? 0 : base) + incomeShares[i];
        if (incomeCents > 0) {
          o.incomeDate = $("#batchDate").value || todayStr();
          o.status = "已回款";
        }
      });
    }

    // 整批口径：覆盖时 = 这次填的总额；追加/留空 = 原值 + 本次（留空时加的是 0，等于一个字不动）
    const batchFeeCents = (overwrite && feeGiven) ? feeCents : (prev ? prev.feeCents : 0) + feeCents;
    const batchIncomeCents = (overwrite && incomeGiven) ? incomeCents : (prev ? prev.incomeCents : 0) + incomeCents;
    orders.forEach((o) => {
      o.batchId = batchId;
      o.batchDate = batchDate;
      o.batchFee = batchFeeCents / 100;
      o.batchIncome = batchIncomeCents / 100;
      // 本次结算时的成员数：之后有人「退出本批」就靠它区分「退出」（预期内）与「金额被改过」
      o.batchCount = orders.length;
    });

    closeBatchModal();
    saveData();
    const amounts = [];
    if (feeGiven) amounts.push(`邮费 ${money(feeCents / 100)}`);
    if (incomeGiven) amounts.push(`回款 ${money(incomeCents / 100)}`);
    let msg;
    if (!feeGiven && !incomeGiven) msg = "这一批的成员与日期已记下，金额没动";
    else if (prev) msg = `已${overwrite ? "覆盖" : "追加"}本批 · ${amounts.join(" · ")}`;
    else msg = `已结算 ${orders.length} 单${orders.length > 1 ? `（一起寄 ${batchDate.slice(5)}）` : ""} · ${amounts.join(" · ")}`;
    toast(msg);
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

  // 只填渠道：状态下拉由 openForm 每次按「现役两态 +（编辑遗留单时）该单的旧状态」重建
  function populateSelects() {
    fillSelect(document.querySelector("#orderForm [name=channel]"),
      CHANNELS.map((c) => [c, c]), "收货商");
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
      else if (act === "dup") duplicateOrder(id);
      else if (act === "edit") openForm(data.orders.find((x) => x.id === id));
      else if (act === "unbatch") leaveBatch(id);
      // 批次表头上的「改本批邮费」：直接开批量结算并预选这一批的全部成员（含已回款的）
      else if (act === "batchfee") openBatchModal(btn.dataset.batch || "");
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

    // 批量结算（注意别把 click 事件本身当参数传进去：openBatchModal 的第一个参数是「预选哪一批」）
    $("#batchBtn").addEventListener("click", () => openBatchModal());
    $("#batchCancel").addEventListener("click", closeBatchModal);
    $("#batchSubmit").addEventListener("click", submitBatch);
    // 「改成新值（覆盖）/ 追加到原有」：容器是稳定的，按钮每次重渲染，所以用事件委托
    $("#batchMode").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-mode]");
      if (!btn) return;
      batchMode = btn.dataset.mode === "append" ? "append" : "overwrite";
      updateBatchMode();
    });
    $("#batchList").addEventListener("change", (ev) => {
      const cb = ev.target.closest("input[type=checkbox]");
      if (!cb) return;
      if (cb.dataset.group) {                 // 整批一键勾选/取消
        batchItems.forEach((it) => { if (it.batchId === cb.dataset.group) it.checked = cb.checked; });
        renderBatchList();
        return;
      }
      const it = batchItems[Number(cb.dataset.idx)];
      if (it) it.checked = cb.checked;
      renderBatchList();                      // 批次表头的全选/半选态跟着变
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
        const localOnly = data.orders.slice(); // 本机订单先留底，导入后按 id 并回，防覆盖丢失
        window.luhuoSync.applySyncCode(code);
        meta.updatedAt = null;
        meta.lastSyncedAt = null;
        meta.lastSyncError = "";
        persist();
        await pullFromCloud();
        syncEpoch += 1;
        // 合并：本机有、云端没有的订单不丢
        const ids = new Set(data.orders.map((o) => o.id));
        let recovered = 0;
        localOnly.forEach((o) => {
          if (!ids.has(o.id)) { data.orders.push(o); recovered += 1; }
        });
        render();
        renderSettings();
        if (recovered > 0) { saveData(); toast(`已配对，并找回本机 ${recovered} 单`); }
        else { scheduleSync(); toast("同步码已导入"); }
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
