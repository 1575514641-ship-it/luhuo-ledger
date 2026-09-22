// 撸货记账 · 主逻辑（v26）
// 状态只有两个：在途（垫了钱还没结清）/ 已回款；旧的「自留」单保留原样只读显示，不再能新建。
// 数据模型：单 JSON blob（orders 数组），经 sync.js 云同步（同设备组共用一个同步码）。
// v23：整批邮费/回款**可改可删**。每单多记 batchFeeShare/batchIncomeShare（本次真正摊到它头上的分额），
//      批次表头加了「改本批邮费」入口（点开弹窗并预选该批全部成员）。
// v24：三件事，都是用户实际用出来的缺口——
//      ① **把那两个入口补全**：v23 只有表头一条路，而单成员批次不渲染表头、已回款的单也不在
//         主入口的单里，用户点不到。现在每张批内单的卡片上都挂着同一个「改本批邮费」
//         （单成员批次/已回款成员照样有），表单里的「邮费」「回款金额」另各加一个小「清空」。
//      ② **去掉「覆盖 / 追加」的选择，改成纯重摊**（用户拍板：「我肯定是直接把它完全更改，
//         这并不需要我去重新选」）：一起寄的一批**只有一笔邮费**（单寄的单才记自己的），
//         整批金额是这一批的唯一权威值，成员单上的金额只是它的分摊（为了每单利润展示得出来）。
//         所以填数字＝把这一批改成这个数（按垫付占比重摊到成员）、留空＝不动、填 0＝删掉这笔钱。
//         不再叠加任何「这一单入批前自己记过多少」——那套算法会越改越大、填 0 还留残值
//         （用户实测「8 单各 ¥4、整批只录了 ¥1，填 0 后总额还是 ≈¥31.8」就是它）。
//         纯赋值天然幂等，也顺带把「清零留残值」整个消掉。
//      ③ 编辑批内单时在邮费下面提示「这一单的邮费在批次上统一改」，免得他继续去单据里找。
// v25：记一笔**纯收入**（"给别人开发票收到的钱"这类只有收入、没有成本的业务）。
//      做法刻意最省：**只在记单表单顶部加一个类型切换**（货单 / 收入），选收入时表单只留
//      名称/金额/日期/渠道/备注，保存时把收入语义写进**现有字段**（cost=0、fee=0、qty=1、
//      status=已回款、income=金额、incomeDate=date=用户只填的那一个日期）。
//      **绝不新增类型字段**：老账本零迁移，任何靠「新字段缺省」或「cost===0」这类宽松判断去
//      识别收入单的写法，都会把「垫付 0 + 已回款」的老货单误判成收入单、静默改写它的语义——
//      这是零迁移承诺下最脆弱的一行代码。类型只是**表单模式**，落库后与货单同形，
//      于是这笔钱天然并进现有的总收入/净利润，报表不需要任何分块、列或图例。
//      编辑既有记录一律按货单形态回显（垫付/邮费/数量/状态照常显示，值就是 0/0/1/已回款），
//      编辑表单不给类型切换；「0 元购」确认只服务货单（正反两个方向都保住）。
// v26：补两处小改动，都是一次定点修正——
//      ① **已回款的单也能改回款金额**（真实能力缺口）：卡片上的「回款」按钮以前只在未结算时渲染，
//         一旦「已回款」就没有任何入口能改金额/日期，只能删了重记；v25 的收入单天生已回款，
//         对这个缺口 100% 命中。改法＝复用同一个 #payModal：已回款的单把按钮显示为「改回款」
//         （同一个 data-act、位置与样式一字不动），打开时预填它现在记着的 income/incomeDate，
//         提交只写回这两个字段（状态保持已回款、不产生第二条记录、不动 cost/fee/qty/批次字段）。
//         旧「自留（旧）」单不给这个入口（不是回款语义，保持原样只读）。
//         批内单改回款后表头会如实提示「≠ 成员明细合计」——**预期**，批次口径属于另一个入口。
//      ② 「垫付金额为 0」的确认框改成中性措辞（同时覆盖白嫖单与纯收入单）：v25 起**编辑一条
//         纯收入单**也必然走到它（编辑一律按货单路径、垫付恒为 0），老文案在那条路上读不通。
//         刻意保留这次点击、只改措辞——为了免掉它去判「是不是收入单」正是 v25 定为禁止的脆弱代码。
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
  const CHANNELS = ["收货商", "闲鱼", "转转", "朋友", "自用", "开发票"];
  const STATUS_CLASS = { "在途": "st-out", "已回款": "st-done", "自留": "st-loss" };
  // v25：「收入」表单模式的默认值（只在新建表单、且用户没碰过那格时才补）
  const INCOME_NAME = "开发票";
  const INCOME_CHANNEL = "开发票";

  // ---- 状态 ----
  let data = { version: 1, orders: [] };
  let meta = { updatedAt: null, lastSyncedAt: null, lastSyncError: "", filter: "在途" };
  let editingId = null;
  let prefillPlatform = "";   // 「再来一单」预填时暂存原单平台（表单里没有平台输入框）
  // v25：记单表单的模式（"order" 货单 / "income" 收入）。**只是表单形态**，不落库、不是类型字段。
  // nameAuto / channelTouched 记录「那一格是我们替他补的默认值、还是用户自己碰过」——
  // 切类型时照旧保留共有值，只补用户没碰过的格子。
  let formKind = "order";
  let nameAuto = false;
  let channelTouched = false;
  let payTargetId = null;
  // v26：这一次打开 #payModal 是「回款」（在途单 → 写金额+日期并置已回款）还是「改回款」
  // （已回款的单 → 只改 income/incomeDate）。由 openPayForm 按记录当前 status 决定，closePayForm 复位。
  let payEditMode = false;
  let batchItems = [];        // 批量结算弹窗的勾选状态：{ id, name, cost, checked }
  // v28 报单（寄出后给收货商报「型号 颜色 数量」）：范围在打开面板那一刻定死，
  // 勾选与手改文案都只活在内存里——不落库、不进同步包、关掉即丢（见 openBaodan 上方说明）
  let baodanScope = null;     // { type:"batch"|"filter", batchId, title }
  let baodanCandidates = [];  // 这一次范围里的全部候选单（快照）
  let baodanSel = new Set();  // 勾选中的单 id
  // v31：用户**真的动过**快递单号那一格没有（change / 「清空」置位，开面板与关面板复位）。
  // 它是「写账本」的**必要条件**——预填值是范围里的众数，少数派单与它必然不同，
  // 只比字符串会让「点一下复制、什么都没改」顺手改掉那些单的正确单号（静默串单）。
  let baodanTrackingTouched = false;
  let currentFilter = "在途";
  // v32：「一起寄出」批次块折叠 —— 只记「被用户手动展开过的那些批次 id」。
  // 它是展开态的唯一真相（重渲染也照它还原），但**刻意只活在内存里**：不落库、不进同步包、
  // 不写 localStorage，刷新页面回到默认收起（用户确认过的默认态）。
  const expandedBatches = new Set();
  // v35：分项利润编辑的「钉住」状态 —— batchId → Map(orderId → 该单被手改过的利润, 分)。
  // 与 expandedBatches 同一待遇：**只活在页面内存里**（不落库、不进同步包，刷新即清）——
  // 锁定的值本身不需要持久化，它已经写进各单的 income；刷新后重置锁＝回到「全员未锁定」，
  // 下一次编辑按 A 语义从当前分摊重新钉住（不新增任何账本字段）。
  const profitLocks = new Map();
  // v37：状态提示的「每批每会话只首判一次」记号 —— batchId 的内存 Set（不落库、不进同步包，刷新即清）。
  // 首判＝本会话对该批的第一次提交编辑；**无论是否弹出都记为已看过**（见 commitProfitEdit 内注释）。
  const statusHintSeen = new Set();
  // v38：状态提示里「完整点名」那一行（内存，不落库、不进同步包）—— batchId → { generation, ids }。
  // 短 toast 只陈述关键事实（项名一旦变长，两个 120 字的名字曾把提示撑到 527px 高），
  // 完整清单落在这里、在批次表头里常驻可查（关掉编辑框之后仍然查得到）。见 commitProfitEdit。
  // v38 收尾（F1）：记的是**项的 id**、不是名字——条件会变（恢复默认分摊 / 退批 / 整批重摊 /
  // 整包换数据），一份存下来的名字清单过了那一刻就可能替一个已经退出本批的成员说话；
  // 渲染时按 id 现查账本、现算「它还偏离默认吗」，见 batchDetailNames。
  const statusHintDetail = new Map();

  // ---- v38（报告 B1/B2/B7）：账本代次 + 各类「打开时记账本、稍后才写回」的会话 ----
  // **账本代次**（内存、不落库）：整包替换（导入 JSON / 云端拉取）、重置身份、导入同步码时 +1。
  // 它回答的问题不是「钱守恒吗」而是「用户手上这份意图还是不是当前这本账」——旧拉取在重置后
  // 落库、换包后仍开着的编辑框把新金额覆盖回旧值，都属于这一类。
  let ledgerGeneration = 0;
  // 会话快照（内存、不落库）：打开弹窗那一刻记下这一单/这一批长什么样，写回前按 id 与账本现值对表。
  // 对不上就**拒绝落库并说明**、草稿留给用户核对，绝不自动挑一边的值（旧值或新值）。
  let formSession = null;      // { generation, id, snap }                  记单/编辑表单
  let paySession = null;       // { generation, id, snap }                  回款 / 改回款弹窗
  let batchSession = null;     // { generation, snaps: Map(id → snap) }     批量结算弹窗
  let baodanSession = null;    // { generation, snaps: Map(id → snap) }     报单面板
  // **拉取序号**（内存）：同一个身份可能有两次拉取在飞（启动那次 + 配对那次），后发起的才算数。
  // 只比金额或订单 id 分辨不出「哪一次是新意图」，所以另设一个单调递增的序号（见 pullFromCloud）。
  let pullSeq = 0;

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

  function monthStr(dateStr) {
    // 看板与报表共用真实日期校验；非法日期不归月，原始数据不改写。
    const d = parseDate(dateStr);
    return d ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}` : "";
  }
  function currentMonth() { return todayStr().slice(0, 7); }

  function parseDate(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ""));
    if (!m) return null;
    // v33：**回读校验**——`new Date(y, m-1, d)` 会把不存在的日期静默进位（`2026-02-30` → 3 月 2 日、
    // `2026-13-45` → 2027 年 2 月 14 日）。旧版这里只验格式，于是那种日子会悄悄落进**别的期**：
    // 2 月榜空着、3 月榜里多出这一笔，页面上没有任何提示。v33 起回款日期第一次决定商品榜与环图的
    // 归期，这条就变得更要紧。构造出来回读三个字段，对不上就当「不合法」返回 null ——
    // 与既有的「解析失败就不归期」完全同一条路（不改数据、不改卡片、不改看板累计）。
    const y = Number(m[1]), mo = Number(m[2]), day = Number(m[3]);
    const dt = new Date(y, mo - 1, day);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== day) return null;
    return dt;
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

  // v38：一单在**这一刻**的账本快照（内存态，只用来对表；不落库、不进同步包）。
  // 逐键 JSON 比对之所以稳定：normalizeData 与各处写入（submitForm / 收入单 / 分项编辑）
  // 用的是同一套键顺序，Object.assign 就地改也不会改变已有键的位置。
  function orderSnap(o) { return o ? JSON.stringify(o) : ""; }

  // v38：**唯一**的「接纳了一本新账」入口（报告 B2/B7/B9 同一处）：账本代次 +1，并把只活在内存里、
  // 指向旧账本的状态全部作废——手改锁（v36）、状态提示首判记号与它的详情行（v37）。
  // 刻意只在**真的换了账本**时调用（导入 JSON / 云端拉取成功落库 / 重置身份 / 换同步码）：
  // 一次失败的云端读取不算换账本，不许把首判额度白白复位。
  function invalidateForNewLedger() {
    ledgerGeneration += 1;
    profitLocks.clear();
    statusHintSeen.clear();
    statusHintDetail.clear();
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
        // v23：这一单在「整批邮费/回款」里**实际摊到多少**（分，整数）。整批金额是这一批的唯一
        // 权威值（v24 定的模型），份额是它摊到这一单上的那一份——「退出本批」与「重组另起一批」
        // 时要从原批次的整批口径里扣掉的就是它。老数据没有 → 0，此时老批次按权重反推一次
        // （见 batchShares）。v24 的替换路径不再需要它（成员金额直接等于新份额）
        batchFeeShare: shareCents(o.batchFeeShare),
        batchIncomeShare: shareCents(o.batchIncomeShare),
        note: String(o.note || "").slice(0, 300),
        // v31：快递单号（可空）。**这一行必须留在白名单里**——本函数是加载与云端拉取的唯一入口，
        // 没列在这里的字段会被它**静默丢掉**（记了单号、一刷新就没了，且全程不报错）。
        // 值走 cleanTracking（折空白 + 去首尾空格 + 截 40 字），与界面侧**同一个口径**：
        // 一份带换行的脏账本（只能从导入 JSON / 云端旧数据进来）原先会「存 A\nB、显示 A B」——
        // 账本、卡片、报单文本三处对不上。现在账本里存的就是那一格会显示的那个规范值。
        tracking: cleanTracking(o.tracking),
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

  // 收入口径（v27 起**唯一**一条规则，看板与报表共用这一个函数）：
  //   ① 算不算收入只看「**回款非空**」（income !== null）——与状态无关：
  //      「已回款」的单被编辑改成「在途」而回款字段留着，那笔钱**照旧是收入**；
  //   ② 归期只看「**回款日期**」（incomeDate）：有日期就落进那个月/那一期；
  //      没有回款日期时计入**总收入**（看板「累计回款」），但不落进任何具体月份（月/季/年报表都不算它）。
  // v27 修的真 bug：改之前看板按①（income !== null）、报表按「已结算且回款日期在期内」，
  // 于是「已回款 → 改成在途（回款保留）」这条记录被看板算进累计回款、报表却不算，两页对不上。
  // 以后凡是要判「这笔钱算不算收入」的新代码，一律走这个函数，别再各写一份判据。
  function hasIncome(o) { return o.income !== null && o.income !== undefined && o.income !== ""; }

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
      if (hasIncome(o)) totalIncome += o.income;      // v27：收入判据统一走 hasIncome（回款非空即收入）
      if (!isSettled(o)) { outstanding += o.cost; outCount += 1; }
      else settledProfit += orderProfit(o);
      if (monthStr(o.date) === cm) monthCost += o.cost;
      if (o.incomeDate && hasIncome(o) && monthStr(o.incomeDate) === cm) monthIncome += o.income;
      if (byStatus[o.status]) {
        byStatus[o.status].count += 1;
        byStatus[o.status].cost += o.cost;
      }
      const m = monthStr(o.date);
      byMonth[m] = byMonth[m] || { cost: 0, income: 0 };
      byMonth[m].cost += o.cost;
      if (hasIncome(o)) {
        // 归期按回款日期；没有回款日期时落在 "" 这格（近 6 个月列表里没有它 → 只进总收入、不进某个月）
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
  // 不再拿整批值当统计取值（v20 的 max(batchFee) 口径在「退出本批」时会把退出那单的
  // 分摊额重复计一次）。v24 起整批金额与成员明细恒等（纯重摊），两条腿就是同一个数。这样恒有：
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
  // 权威来源是结算时写下的 batchFeeShare / batchIncomeShare。唯一的例外是 v23 之前的老批次——
  // 整批数字 > 0 而各单份额全为 0（那时还没这两个字段），就按当时的分摊规则（权重＝各单垫付、
  // 在分层面取整）用整批数字反推一次；不反推的话「退出本批」与「重组另起一批」时无从扣起
  // （要把退出/被带走的成员那一份从原批次的整批口径里减掉）。
  // 反推只在**份额全为 0**时发生：份额有值但合计对不上，说明那一批后来被手工改过或删过单，
  // 这时必须相信单上的记录，不能拿整批数字重算（那会把别人改过的钱抹平）。
  // v24 起**替换（改本批金额）这条路不再需要它**：填数字 = 整批金额是唯一权威值、成员一律按它
  // 重摊（见 submitBatch），所以不存在「自带部分」要反推这回事。
  function batchShares(members, shareKey, totalCents) {
    const recorded = members.map((o) => shareCents(o[shareKey]));
    if (totalCents <= 0 || recorded.some((v) => v > 0)) return recorded;
    return splitByWeight(totalCents, members.map((o) => Math.max(0, toCents(o.cost))));
  }

  // ---- v35：批次「总利润 + 分项可编辑」----
  // 用户选定的手感是 **A**：改过的那项**钉住数值**，剩余池按默认规则分给**还没改过**的项；
  // 只剩一项未锁定时那一项就是余数；「恢复默认分摊」解开全部钉住。
  // **不是** B（每次把其余项含改过的全重摊——那样再改 B 时 A 会从 100 变回 37.5，与用户要的语义相反）。
  // 默认规则＝照 splitByWeight 那一套（别自己发明）：按垫付占比 floor(pool×w_i/Σw)，
  // 余数**逐分**补给权重最大的那几项（排序键 w[b]-w[a] || a-b，并列时**数组下标小的优先**）——
  // 不是把整笔尾差全给一个人；Σw=0 时退化成「floor 按项均分、多的几分给前几项」。
  // 这一支是**纯函数**：给定总利润 + 各项锁定值 → 返回各项最终分配，不碰 DOM、不碰账本，
  // 冒烟测试直接从 window.luhuoPure 喂数据断言（100/56/84 → 100/90/50 那组例子 + 第三方 48 组向量）。
  // 与 splitByWeight 的差别只有一处：那一支总额 ≤0 **早退返回全 0**（「填 0 删掉回款」那条路用的），
  // 拿它摊负剩余池会静默摊成全 0、Σ≠总利润、每批亮「待对账」——所以这里自实现一条
  // **正负池同规则**的分配（floor 向下取整，余数恒 ≥0 且 < 项数，逐分补给最重的几项，
  // 正负池都自动守恒）。恢复默认那条路（resetBatchShares）摊的是整批回款（≥0），照旧复用 splitByWeight。
  // 全部锁定且 Σ≠总利润 → { ok:false, diff }（拒绝并说清差多少），绝不静默凑数。
  // 数组顺序：调用方一律传 data.orders.filter(batchId) 的同序数组——并列按下标时顺序决定谁拿那 1 分，
  // 各入口必须同源（表头/卡片/编辑/恢复/测试都是这一个 filter）。
  function batchProfitSplit(totalCents, weights, locked) {
    const n = weights.length;
    const shares = new Array(n).fill(0);
    const free = [];
    let lockedSum = 0;
    for (let i = 0; i < n; i++) {
      const v = locked[i];
      if (v === null || v === undefined) free.push(i);
      else { shares[i] = v; lockedSum += v; }
    }
    if (free.length === 0) {
      return lockedSum === totalCents
        ? { ok: true, shares }
        : { ok: false, diff: totalCents - lockedSum };
    }
    const remaining = totalCents - lockedSum;
    const w = free.map((i) => Math.max(0, Math.round(weights[i] || 0)));
    const sumW = w.reduce((a, b) => a + b, 0);
    const parts = new Array(free.length).fill(0);
    if (sumW <= 0) {
      // 全 0 垫付：按项数均分（与 splitByWeight 的 Σw=0 分支同规则），余数给靠前的项
      const base = Math.floor(remaining / free.length);
      const rem = remaining - base * free.length;
      for (let k = 0; k < free.length; k++) parts[k] = base + (k < rem ? 1 : 0);
    } else {
      let used = 0;
      for (let k = 0; k < free.length; k++) {
        parts[k] = Math.floor((remaining * w[k]) / sumW);
        used += parts[k];
      }
      // floor 使 used ≤ remaining，余数（必 < 项数）**逐分**补给权重最大的那几项、
      // 并列时下标小的优先（r 每加 1 换下一项 —— 与 splitByWeight 的 byWeight[r] 同款，不是整笔给一个人）
      let rem = remaining - used;
      const byWeight = w.map((_, k) => k).sort((a, b) => w[b] - w[a] || a - b);
      for (let r = 0; r < rem && r < free.length; r++) parts[byWeight[r]] += 1;
    }
    free.forEach((i, k) => { shares[i] = parts[k]; });
    return { ok: true, shares };
  }

  // 这一批的「总利润」唯一口径（表头、卡片、编辑基准共用这一支）：
  //   总利润 := 整批回款 − Σ各单垫付 − 整批邮费（＝ batchGroups 的录入值口径，与表头「整批：」同源）。
  // pending：整批回款**为空**（没有任何成员记过回款，income 全 null）——不显示成一笔确定亏损，
  //   按 v34 卡片「待记回款」的同一条道理显示「待回款」；明确填过 0（income===0）不算空，照常算。
  // editable 为 false 的情形（总利润仍只读显示，**不开放**分项编辑）：
  //   ① 未回款（没有可分摊的回款）；
  //   ② 有人没记回款（v36 补：池子会摊到那个没回款的人头上，而它的 incomeDate 是空的 ⇒ 归期口径分裂）；
  //   ③ 不守恒（Σ成员回款 ≠ 整批回款、或 Σ成员邮费 ≠ 整批邮费——即「⚠ 待对账」那类分叉，
  //      含 batchDrift 漏报的「整批为 0 但成员有值」；两边合不上时分摊基准不唯一）；
  //   ④ 成员回款日期不一致，或**有 income 却没有归期**（v36 补：手改利润会把回款写到没有归期的
  //      成员头上，报表按回款日期归期时这笔钱就落错位置）。
  // ②③④ 都是可达状态（事后单独改过某一单），任务书要求动手前报出来：这里按安全默认**不开放**，
  // 总利润照常按整批录入值显示（卡片与表头同一个数）。
  function batchProfitInfo(g, members) {
    const anyIncome = members.some(hasIncome);
    const incSum = members.reduce((a, o) => a + (hasIncome(o) ? toCents(o.income) : 0), 0);
    const feeSum = members.reduce((a, o) => a + toCents(o.fee), 0);
    const dates = new Set();
    members.forEach((o) => { if (hasIncome(o)) dates.add(o.incomeDate || ""); });
    const total = g.incomeCents - g.costCents - g.feeCents;
    if (!anyIncome) return { pending: true, editable: false, reason: "no-income", total };
    // v36：只要有人没记回款就不开放编辑（必须在守恒那条**前面**判——「3 人有回款 + 1 人没记回款」
    // 时 Σincome 可能正好等于整批回款，守恒那条查不出来）
    if (members.some((o) => !hasIncome(o))) {
      return { pending: false, editable: false, reason: "partial-income", total };
    }
    if (incSum !== g.incomeCents || feeSum !== g.feeCents) {
      return { pending: false, editable: false, reason: "drift", total };
    }
    // v36：把「有 income 但无归期」当成一个**独立事实**（dates 里那个 "" 就是它）。声明：
    // **手改利润不改归期**——commitProfitEdit 只写 income 与 batchIncomeShare，一个字都不碰
    // incomeDate，所以无归期的成员根本不该出现在编辑集合里（而不是替它编一个日期）。
    if (dates.size > 1 || dates.has("")) return { pending: false, editable: false, reason: "date", total };
    return { pending: false, editable: true, reason: "", total };
  }

  // 批次「不开放编辑」的原因 → 给用户看的那一句话（表头的提示行与「恢复默认分摊」的提示共用一支）。
  // 前三条沿用 v35 的既有措辞，一个字不改；partial-income 是 v36 新增的那句。
  function batchReasonText(reason) {
    if (reason === "no-income") return "整批还没记回款，没有可分摊的钱";
    if (reason === "partial-income") return "这一批还有人没记回款，先补齐回款再分摊";
    return "这一批账目有分叉，先按「改本批邮费」对齐再分摊";   // drift / date 都走这句（v35 口径）
  }

  // 给冒烟测试的纯函数出口（A 语义要「不经过 DOM 直接喂数据断言」）；不是公共 API，别在业务代码里用。
  // v36 补两个**只读**探针：手改锁是内存态、禁入理由是 batchProfitInfo 的返回值，两者在页面外
  // 本来都看不见，而测试必须能断言「退批 / 整批重摊 / 整包换数据之后锁真的没了」与「新禁入的 reason」。
  // 只暴露读取视图——没有任何写入口，业务代码一律走 profitLocks 本体与 batchProfitInfo。
  window.luhuoPure = {
    batchProfitSplit,
    profitLockSnapshot: () => [...profitLocks].map(([bid, m]) => [bid, [...m]]),
    // v37 只读探针：状态提示的首判记号（测试断言「每批每会话只首判一次」用；无写入口）
    statusHintSeenKeys: () => [...statusHintSeen],
    // v38 只读探针：状态提示的**完整点名**那一行（短 toast 不再带项名之后，「详情项数准确」这条
    // 得能被断言）。同样只暴露读取视图——没有任何写入口，业务代码一律走 statusHintDetail 本体。
    statusHintDetailFor: (batchId) => {
      const d = statusHintDetail.get(batchId);
      // v38 收尾（F1）：报的是**这一刻真的会渲染出来的那份清单**（batchDetailNames 现算）——
      // 探针与 DOM 不能各说一套，否则「断言详情行内容」时两边会分叉。
      return d ? { generation: d.generation, names: batchDetailNames(batchId) } : null;
    },
    batchProfitInfoFor: (batchId) => {
      const g = batchGroups().get(batchId);
      const members = data.orders.filter((o) => o.batchId === batchId);
      return g && members.length > 0 ? batchProfitInfo(g, members) : null;
    },
  };

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
    // v27：在途单自己记的邮费**不在**「垫付在外未回笼」里（那格只累加 cost，统计口径不动），
    // 但用户心算「还有多少钱在外面」会把邮费一起算上——所以在这里如实补一句，
    // 做法与「本月垫出 · 另有邮费」完全一致（按各单自己记的 fee 汇总＝成员明细口径）。
    // 在途单邮费合计为 0 时这半句不显示（不写「另有邮费 ¥0」这种废话）。
    const pendingFeeCents = data.orders.reduce((a, o) => a + (isSettled(o) ? 0 : toCents(o.fee)), 0);
    $("#kpiOutstandingHint").textContent = s.outCount > 0
      ? `${s.outCount} 单在途，回款了记得销账${pendingFeeCents > 0 ? ` · 另有邮费 ${money(pendingFeeCents / 100)}` : ""}`
      : "还没有在途的单子";
    const profitEl = $("#kpiProfit");
    profitEl.textContent = money(s.settledProfit);
    profitEl.className = "kpi-value " + (s.settledProfit > 0 ? "pos" : s.settledProfit < 0 ? "neg" : "");
    $("#kpiMonthCost").textContent = money(s.monthCost);
    // 本月邮费：归期同报表页（整批按批次日期、单寄按下单日期），挂在「本月垫出」下面当补充口径
    const cmParts = currentMonth().split("-").map(Number);
    const monthFee = reportFeeStats(new Date(cmParts[0], cmParts[1] - 1, 1), new Date(cmParts[0], cmParts[1], 1));
    $("#kpiMonthFee").textContent = `本月邮费 ${money(monthFee.totalCents / 100)}`;
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
    // v33：图例点＝该序列线/柱的实色（与 chartFlowSVG 共用 SERIES_COLOR）
    $("#dashFlowLegend").innerHTML = `<i class="lg-dot" style="background:${SERIES_COLOR.cost}"></i>垫出　<i class="lg-dot" style="background:${SERIES_COLOR.income}"></i>回款`;
    const flowBuckets = s.months.map((m) => ({ label: `${parseInt(m.month.slice(5), 10)}月` }));
    const flowStats = s.months.map((m) => ({ cost: m.cost, income: m.income }));
    $("#dashFlow").innerHTML = chartFlowSVG(flowBuckets, flowStats, 118);

    // v38（报告 C 节）：最右一列补一个短标识「差」——它一直**没有列名**，只有脚注在讲它是什么，
    // 而脚注在卡片底部、与数字隔了好几行。标识走小字号 + 紧贴数字，金额口径一个字没动。
    $("#monthList").innerHTML = s.months.map((m) => `
      <div class="month-row">
        <span class="month-name">${m.month}</span>
        <span class="month-cell">垫 ${money(m.cost)}</span>
        <span class="month-cell">回 ${money(m.income)}</span>
        <span class="month-cell ${m.diff > 0 ? "pos" : m.diff < 0 ? "neg" : ""}"><i class="mc-tag">差</i>${money(m.diff)}</span>
      </div>`).join("");
  }

  // ---- 账本 ----
  function filteredOrders() {
    const orders = data.orders.slice();
    // 日期倒序；同日返回 0，保留账本数组里的先后，不制造互相矛盾的比较结果。
    orders.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
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
    // v32：顺手清掉已经不存在的批次 id（批次随删单/重组消失）。不清理也能跑，
    // 但一个长会话里来回重组批次会让这个 Set 一直涨；它只是内存里的一串 id，清理是幂等的。
    expandedBatches.forEach((id) => { if (!groups.has(id)) expandedBatches.delete(id); });
    const parts = [];
    blocks.forEach((b) => {
      const g = b.id ? groups.get(b.id) : null;
      const grouped = g && g.count > 1;      // 只剩一单的批次不再撑表头，免得「一起寄出 · 1 单」
      const solo = !!g && g.count === 1;     // 单成员批次：没表头，卡片上补一句它的批次归属
      if (grouped) {
        // v32：多成员批次整块包一层 .batch-block（默认收起态）。
        // 为什么包一层而不是给每张卡片加类：收起＝「表头 + 这一批全部成员」一起不显示，
        // 需要一个共同的祖先来挂状态；展开/收起只切这一个类，成员卡片与提示行始终留在
        // DOM 里（见 styles.css 的 .batch-block.collapsed），所以切态**不需要重渲染**。
        parts.push(`<div class="batch-block${expandedBatches.has(g.id) ? "" : " collapsed"}" data-batch="${escapeHtml(g.id)}">`);
        parts.push(batchHeadHtml(g, orders));
        b.orders.forEach((o) => parts.push(orderCardHtml(o, "in-batch", false)));
        parts.push("</div>");
        return;
      }
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
  // 返回一个数组（0～3 条），warn=true 的那条用红棕色显示。
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
    // v38（报告 B6）：金额对账**不以整批值 > 0 为前提**。原来两处 `> 0` 门槛让「整批为 0、成员上却有值」
    // 这种分叉彻底静默——用户把某一单回款改成 1 元之后，表头既不报「待对账」、分项编辑入口又消失，
    // 展开也看不到任何原因。这里只扩充异常可见性，**不重算**任何账本金额（判据与 batchProfitInfo
    // 的 drift 那条逐字同源，所以「能编辑」与「亮红」永远互斥）。
    const feeSum = members.reduce((a, o) => a + toCents(o.fee), 0);
    if (feeSum !== g.feeCents) diff.push(`邮费 ${money(feeSum / 100)}`);
    const incSum = members.reduce((a, o) => a + (o.income === null ? 0 : toCents(o.income)), 0);
    if (incSum !== g.incomeCents) diff.push(`回款 ${money(incSum / 100)}`);
    if (diff.length > 0) {
      // v27：把下一步点哪里写进同一行——删掉批内一单后整批口径**不会**自动扣（刻意的边界），
      // 只报数字的话用户会以为账坏了。指引就是那句自助修法：点「改本批邮费」按当前成员重摊一次
      // （填同一个整批数字即可，纯重摊后成员明细之和恒等于整批口径）。
      notes.push({ warn: true, text: `≠ 成员明细合计 ${diff.join(" · ")}，与整批口径不同　要对齐就点「改本批邮费」按当前成员重摊一次` });
    }
    // v24 说明：曾有一支「整批为 0 而成员上还有钱」的中性说明，用来兜「清零留下残值」——
    // 那笔残值本身随 v24 的**纯重摊**一起消失了（填数字 = 成员 fee 直接等于按权重摊到的新份额，
    // 不再叠加任何"自带部分"，所以填 0 之后成员一定也是 0）。剩下的差异只可能来自
    // 「事后手工改过某一单」或历史数据，上面那条「≠」如实报出来就够了，不必再单独写一支。
    return notes;
  }

  // v38 收尾（F1，选定方案 ②「渲染时现算」）：状态提示那一行说明的**事实部分一律现算**。
  // 记录（statusHintDetail）只回答一件事：「本会话对这批做过一次要报的编辑，当时该点名的是哪几个 id」。
  // 显示与否、项数、名字三者全部按**当前账本**算：
  //   · 只留仍是本批成员、且现值仍偏离默认分摊（±1 分容差与判偏离同款）的 id；
  //   · 名字按当前成员顺序现取 —— 恢复默认分摊后清单自然为空、整行消失；退批的人不再是本批成员、
  //     不会再被点名（旧实现存名字 + 只在 invalidateForNewLedger 清，于是这两件事都会说谎）；
  //   · 项数就是这份清单的长度，不会出现「共 3 项却只点出 2 个名」。
  // 为什么不用方案 ①（只在那三处补 delete）：删记录只治那几处，任何**别的**让条件消失的路径
  // （手改回默认值、导入同 id 数据、将来新加的入口）都会重新说谎；现算构造上不会。
  // 那三处仍然一并 delete（与 profitLocks 同寿命），但它是兜底而**不是**判据。
  function batchDetailNames(batchId) {
    const d = statusHintDetail.get(batchId);
    if (!d || d.generation !== ledgerGeneration || d.ids.length === 0) return [];
    const g = batchGroups().get(batchId);
    const members = data.orders.filter((o) => o.batchId === batchId);
    if (!g || members.length < 2) return [];
    const defCents = splitByWeight(g.incomeCents, members.map((m) => Math.max(0, toCents(m.cost))));
    const want = new Set(d.ids);
    return members
      .filter((m, i) => want.has(m.id) && Math.abs(toCents(m.income) - defCents[i]) > 1)
      .map((m) => m.name || "未命名");
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
    // v38（报告 B8 / D4）：状态提示的**完整点名**放在这里（不再塞进短 toast）。只在「本会话对该批
    // 首次提交编辑时确实存在非默认项」时才有这一行，且只认**当前账本代次**记下的那一份——整包换过
    // 数据（导入/拉取）后它与手改锁、首判记号一起作废，不会拿旧账的名字说新账的事。
    // 名字一个都不缩写、不靠 CSS 裁掉后半句：项数就是当时的项数，逐个商品名可定位。
    // v38 收尾（F1）：清单与项数**渲染时现算**（见 batchDetailNames）——记录只提供 id。
    const detailNames = batchDetailNames(g.id);
    const detailNote = detailNames.length > 0
      ? `<div class="bh-note bh-statusdetail">本批现值与默认分摊不同，共 ${detailNames.length} 项；本次编辑已把没钉住的项一并重算：${escapeHtml(detailNames.join("、"))}</div>`
      : "";
    const drift = batchDrift(g, members, batchCount);
    const expanded = expandedBatches.has(g.id);
    // v32：收起态只留两行（第一行 + 整批摘要），所以告警**不能**只靠下面那几行 .bh-note 说话——
    // 有 warn 级提示时在摘要行尾部补一个紧凑标记，展开后才看得到完整文案（文案一个字没改）。
    // 没有告警的批次一个字节都不多渲染。
    const warnFlag = drift.some((n) => n.warn) ? `<span class="bh-warnflag">⚠ 待对账</span>` : "";
    // v32：筛选把成员藏起来时，收起卡上的「N 单」会误导（那是**整批**单数，本页只有 N 单可看）——
    // 原来那句「本页只显示其中 N 单」就在下面几行里，折叠把它藏起来等于把它作废。
    // 同一套做法：本页可见成员 < 本批成员时，在摘要行尾部补一个短标记（收起态才显示，展开态照旧是完整那句）。
    // 与告警标记刻意分开：这个走弱色（只是「本页没显示全」的事实），告警那个走 --neg 红粗（真要动手对账）。
    const filterFlag = shownCount < g.count ? `<span class="bh-filterflag">· 本页 ${shownCount} 单</span>` : "";
    // v35：总利润（只读锚点）挂在第一行右侧 —— **收起态也要看得见**（「折叠不许藏信息」是 v32 的红线）。
    // 口径与表头「整批：」同源（batchProfitInfo 的 total＝整批录入值），待回款时显示「待回款」
    // 而不是 −Σ垫付−邮费 那笔确定亏损；负数照实上红色（允许负利润，不拦不警告）。
    const pinfo = members.length > 0 ? batchProfitInfo(g, members) : { pending: true, editable: false, total: 0 };
    const profitHtml = pinfo.pending
      ? `<span class="bh-profit pending">总利润 待回款</span>`
      : `<span class="bh-profit ${pinfo.total > 0 ? "pos" : pinfo.total < 0 ? "neg" : ""}">总利润 ${money(pinfo.total / 100)}</span>`;
    // 「恢复默认分摊」＝按垫付占比把整批回款重摊一次（与「改本批回款」那条路径等价：纯赋值、幂等、
    // 尾差规则一致），同时解开这一批的全部钉住。只在可编辑的批次上渲染（收起态与「改本批邮费」
    // 同属 .bh-act，本来就只在展开态可见）。
    const resetBtn = pinfo.editable
      ? `<button type="button" class="bh-act" data-act="breset" data-batch="${escapeHtml(g.id)}">恢复默认分摊</button>`
      : "";
    // v36：不开放编辑的两条**新**禁入（有人没记回款 / 有 income 却没归期）要给用户一句话——
    // 「按钮没了」本身不是解释（反静默）。既有两条各自已有说法：待回款看「总利润 待回款」，
    // 待对账看下面那条 ⚠ 告警（那句本来就写着下一步点哪里），所以这些**不重复渲染**：
    // 同一个批次上不再叠一句同义的话，提示行条数保持与 v35 一致。
    // v38（报告 B6）：这里**不再**按 reason 单独排除 drift —— 判据只留「下面已经有 warn 级告警」
    // 这一条（drift 与 warn 告警现在是逐字同源的判据，所以排除 drift 是死条件；留着它反而会
    // 在将来两处判据走岔时把「入口为什么不可用」的唯一解释吞掉）。
    const lockNote = !pinfo.pending && !pinfo.editable && !drift.some((n) => n.warn)
      ? `<div class="bh-note">${escapeHtml(batchReasonText(pinfo.reason))}</div>`
      : "";
    // v32：第一行整行是折叠开关。必须是真 <button> —— div 在手机上拿不到正确的键盘/触摸语义；
    // 样式在 styles.css 里抹平成「和以前那个 div 一样」（整行宽、左对齐、无边框背景）。
    // 箭头只有 ▾ 一个字符，收起态靠 CSS 转 -90° 变成 ▸ —— 这样切态只改类、不用重渲染。
    // title 给鼠标/读屏补一句「这一行是干什么的」（可见文本只有标题+单数+箭头，状态只有 aria-expanded）；
    // **刻意不用 aria-label**：那会把「一起寄出 · 日期 N 单」这段可见文本从无障碍名里整个顶掉。
    return `<div class="batch-head">
      <button type="button" class="bh-top" data-act="btoggle" data-batch="${escapeHtml(g.id)}" title="点一下展开/收起这一批的单子" aria-expanded="${expanded ? "true" : "false"}">
        <span class="bh-title">一起寄出 · ${escapeHtml(g.date)}</span>
        <span class="bh-right">
          ${profitHtml}
          <span class="bh-count">${g.count} 单</span>
          <span class="bh-caret" aria-hidden="true">▾</span>
        </span>
      </button>
      <div class="bh-meta-row">
        <div class="bh-meta">整批：${bits.join(" · ")}</div>
        ${filterFlag}
        ${warnFlag}
        <button type="button" class="bh-act" data-act="batchfee" data-batch="${escapeHtml(g.id)}">改本批邮费</button>
        <button type="button" class="bh-act" data-act="baodan" data-batch="${escapeHtml(g.id)}">报单</button>
        ${resetBtn}
      </div>
      ${shownCount < g.count ? `<div class="bh-note">本页只显示其中 ${shownCount} 单，另有 ${g.count - shownCount} 单被筛选隐藏</div>` : ""}
      ${lockNote}
      ${drift.map((n) => `<div class="bh-note${n.warn ? " warn" : ""}">${n.text}</div>`).join("")}
      ${detailNote}
    </div>`;
  }

  // v32：批次块折叠开关。**只改这一次 DOM**——切一个类 + 同步 aria-expanded；
  // 箭头是 CSS 按这个类转的，告警标记/成员卡片/提示行的显隐也全在这个类上，
  // 所以**绝不调 renderList()**：整列表重渲染会把滚动位置和用户此刻手上的状态（比如刚点开的弹窗）打飞。
  // 触发区严格限定在表头第一行那个 button 上：点这一批的「改本批邮费」「报单」或任何一张成员卡片上的
  // 按钮时，事件委托里的 closest("button[data-act]") 命中的是那些按钮自己（它们在 .bh-top 之外），
  // 不会走到这里，也不会顺手折叠——这一条有专门的断言（36.4）。
  function toggleBatchBlock(btn) {
    const id = btn.dataset.batch || "";
    if (!id) return;
    if (expandedBatches.has(id)) expandedBatches.delete(id);
    else expandedBatches.add(id);
    const expanded = expandedBatches.has(id);
    const block = btn.closest(".batch-block");
    if (block) block.classList.toggle("collapsed", !expanded);
    btn.setAttribute("aria-expanded", String(expanded));
  }

  // v31：快递单号（可空）**全局唯一**的一支规范化——换行/连续空白折成一个空格、去首尾空格、截 40 字。
  // 白名单（normalizeData）、记单/编辑表单、报单面板那一格与报单文本、卡片，**全都过它**：账本里存的就是
  // 界面上会显示的那个值，三处（格/文本/账本）永远对得上。
  // 为什么必须折空白而不是只 trim：报单是「一行一件」，一个带换行的单号会把那一行切成半截（v29 对商品名
  // 踩过同一个坑）；这类脏值只能从「导入的 JSON / 云端旧数据」进来，而三条入口最后都要过这一支。
  // 曾经有过两套口径（白名单只 trim+slice）——表现是账本存 `A\nB`、卡片与文本显示 `A B`，
  // 只在脏数据上出现，但「账本里那一格永远是一个规范值」这句话就不成立了。
  function cleanTracking(v) {
    return String(v === null || v === undefined ? "" : v).replace(/\s+/g, " ").trim().slice(0, 40);
  }

  // soloBatch：这一单的批次只剩它自己（页面上不显示「一起寄出」表头），卡片里补一句归属，
  // 免得「退出本批」这个按钮看起来没有来由
  function orderCardHtml(o, extraClass, soloBatch) {
    const settled = isSettled(o);
    const profit = orderProfit(o);
    // 已回款但金额未填，不在卡片上把未知回款显示成确定亏损。
    // 只改显示；旧自留、统计公式和账本字段保持原样。
    const pendingIncome = o.status === "已回款" && !hasIncome(o);
    const showProfit = !pendingIncome && (o.income !== null || settled);
    // v35：这一单的利润可不可以行内编辑（点数字变输入框）。前提：多成员批次 + 该批当前可编辑
    // （batchProfitInfo 的三条禁入都过了）。单成员批次没有表头也没有「分项」，散单不涉及，
    // 一律保持原样（利润只是展示）。mates 按**数据全量**取——被筛选只显示部分成员时，
    // 分摊仍按整批算（页面显示几个不影响钱）。
    let profitEditable = false;
    if (showProfit && o.batchId && !soloBatch) {
      const mates = data.orders.filter((x) => x.batchId === o.batchId);
      if (mates.length > 1) {
        const pg = batchGroups().get(o.batchId);
        if (pg && batchProfitInfo(pg, mates).editable) profitEditable = true;
      }
    }
    const actions = [];
    // v26：已回款的单也要能改回款金额——那个按钮以前只在未结算时渲染，一旦「已回款」，
    // 回款金额与回款日期就**没有任何入口**可改，只能删了重记；v25 的收入单天生就是已回款，
    // 对这类记录这个缺口 100% 命中。这里只是把同一个按钮在已回款的单上换个文案（同一个 data-act，
    // 走同一个 #payModal），位置/样式一字不动。
    // 旧「自留（旧）」单不给这个入口：它不是「回款」语义（那笔钱已经落地、只是没走回款流程），
    // 保持原样只读——**只有真的已回款**才认。
    // v29：o.id / o.batchId 一律过 escapeHtml —— 自己生成的 id 是 crypto.randomUUID()，但这个值
    // **会从外部数据进来**（「导入 JSON 备份」与云端拉取都直接落进 orders），一份 id 里带 `">` 的
    // 备份文件就能在渲染卡片时把脚本注进页面（外部验收实测：`data-id="qX"><img src=x onerror=…>`
    // 真的执行了）。同类写法在本文件里早就有先例（批次表头与报单清单都转义过），这里补齐。
    if (!settled) actions.push(`<button class="act primary" data-act="pay" data-id="${escapeHtml(o.id)}">回款</button>`);
    else if (o.status === "已回款") actions.push(`<button class="act primary" data-act="pay" data-id="${escapeHtml(o.id)}">改回款</button>`);
    actions.push(`<button class="act" data-act="dup" data-id="${escapeHtml(o.id)}">再来一单</button>`);
    actions.push(`<button class="act" data-act="edit" data-id="${escapeHtml(o.id)}">编辑</button>`);
    if (o.batchId) {
      // v24：批次的金额入口**常驻在卡片上**（与批次表头那个 .bh-act 走同一个动作）。
      // v23 只有表头一条路，于是两种情形下用户根本点不到：①单成员批次不渲染表头；
      // ②筛选把那一批藏起来时表头也不在页面上。卡片上的入口按 o.batchId 渲染，
      // 与「这一批是不是被筛选藏了」「这一批还剩几个人」都无关。
      // 已回款的成员同样有——openBatchModal 会把该批**全部成员**并进弹窗（不管在不在途）。
      actions.push(`<button class="act" data-act="batchfee" data-batch="${escapeHtml(o.batchId)}">改本批邮费</button>`);
      actions.push(`<button class="act" data-act="unbatch" data-id="${escapeHtml(o.id)}">退出本批</button>`);
    }
    actions.push(`<button class="act danger" data-act="del" data-id="${escapeHtml(o.id)}">删除</button>`);
    // v31：`order-mid` 末尾补「 · 单号 X」（没填单号的单一个字节都不多）。这一行本来就长，
    // 360px 上多这一截会折行——**属正常**（.order-mid 本来就会折），别为它缩字号或截断单号。
    // v33：利润从金额格里挪到卡片右上的 .order-side（状态下面），金额格只留垫付/回款/邮费三格。
    // 那一次判据（showProfit / profit 的计算）一个字没动，只搬展示位置；
    // 判据本身后来为「待记回款」改过一次，见本函数上方的 pendingIncome。
    return `<div class="order-card ${extraClass || ""}">
      <div class="order-top">
        <span class="order-name">${escapeHtml(o.name || "未命名")}</span>
        <div class="order-side">
          ${pendingIncome ? `<span class="order-income-pending">待记回款</span>` : ""}
          ${showProfit ? `<div class="order-profit${profitEditable ? " editable" : ""}">
            <span>利润</span>
            ${profitEditable
              ? `<button type="button" class="profit-edit" data-act="pedit" data-id="${escapeHtml(o.id)}" title="点一下改这一项的利润（整批总利润不变）"><b class="${profit > 0 ? "pos" : profit < 0 ? "neg" : ""}">${money(profit)}</b></button>`
              : `<b class="${profit > 0 ? "pos" : profit < 0 ? "neg" : ""}">${money(profit)}</b>`}
          </div>` : ""}
          <span class="status-tag ${STATUS_CLASS[o.status]}">${escapeHtml(statusLabel(o.status))}</span>
        </div>
      </div>
      <div class="order-mid">${escapeHtml(o.date)}${o.platform ? " · " + escapeHtml(o.platform) : ""} · ${o.qty} 件${o.channel ? " · " + escapeHtml(o.channel) : ""}${cleanTracking(o.tracking) ? " · 单号 " + escapeHtml(cleanTracking(o.tracking)) : ""}${soloBatch ? " · 单独一批寄出" : ""}</div>
      <div class="order-money">
        <span>垫付 <b>${money(o.cost)}</b></span>
        <span>回款 <b>${o.income === null ? "—" : money(o.income)}</b></span>
        <span>邮费 <b>${money(o.fee)}</b></span>
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
      }

      // v33：商品榜与环图沿用顶部利润的记录集合，按回款日期归期。
      // 回款非空即计入，0 也是回款；不以状态是否“已回款”筛掉记录。
      if (hasIncome(o)) {
        const id = parseDate(o.incomeDate);
        if (id && id >= startD && id < endD) {
          const p = orderProfit(o);
          income += o.income;
          profit += p;
          const name = o.name || "未命名";
          let g = Object.prototype.hasOwnProperty.call(byName, name)
            ? byName[name] : null;
          if (!g) {
            g = { count: 0, profit: 0 };
            Object.defineProperty(byName, name, {
              value: g, enumerable: true, writable: true, configurable: true,
            });
          }
          g.count += 1;
          g.profit += p;
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
  // v33：环图分片配色。**同一张环图里任意两片的 stroke 必须两两不同**。
  // 一张环图最多 6 片（利润 Top 5 + 「其他」），原来的 5 色调色板取模后第 6 片会绕回第 0 色，
  // 于是「其他」与榜首撞成同一个 #14b8a6、分不出来。补第 6 色（琥珀 #b97909，本就是本文件
  // 图表里在用的色），6 色对 6 片正好取模也不重复。
  // 分片与图例**必须**共用下面 donutColor() 这一支，别再各写一份 `% length`（那是上一版漏的地方）。
  const PALETTE = ["#14b8a6", "#7d8fa1", "#c0724f", "#7a5fb5", "#8a8378", "#b97909"];
  const donutColor = (i) => PALETTE[i % PALETTE.length];

  // v33：**图的实色只此一份**——SVG 里的线/柱与图例点共用这批常量。
  // 改之前图例的颜色是从渐变里手抄的，而且抄的正是 `stop-opacity="0"` 那一端的色
  // （垫出抄成 #b97909、回款抄成 #17b26a、亏抄成 #d05f45），于是图例点与线/柱的颜色对不上
  // （垫出线是 #7d8fa1 的板岩色，图例却点了个琥珀）。渐变那两个 stop 是**渐隐端**、
  // 只参与面积图的中间过渡，别再把它们当成序列色去用。
  const SERIES_COLOR = { cost: "#7d8fa1", income: "#14b8a6", gain: "#14b8a6", loss: "#c0724f" };
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
      <path d="${path("cost")}" fill="none" stroke="${SERIES_COLOR.cost}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <path d="${path("income")}" fill="none" stroke="${SERIES_COLOR.income}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots("cost", SERIES_COLOR.cost)}${dots("income", SERIES_COLOR.income)}
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
        fill="${s.profit >= 0 ? SERIES_COLOR.gain : SERIES_COLOR.loss}" opacity="${s.profit === 0 ? .25 : .9}"/>`;
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
  // 环形图中心那行金额：可用宽度就是**内圆直径**（2×(r − sw/2)），而金额位数是会长的。
  // 用户截图的问题：垫付合计 ¥13,159.81 在 15px 字号下约 89px 宽，而内圆只有 71px——数字直接压在圆环上。
  // 这里按字宽估算自动缩号；缩到下限还放不下就依次退让（先去小数 → 再上万/亿紧凑写法），保证永不压环。
  // 字宽系数是相对字号的**偏保守**估值（数字 0.62、逗号/点 0.33、负号 0.4、¥ 与汉字按 1 算），
  // 再只肯用内圆直径的 92%（留 8% 给字体度量误差）——宁可把字缩小一点，也不许压到环上。
  // 判据侧有几何断言兜底（verify-webapp.mjs 34.x：把字的包围盒四角拿去和内圆半径比）。
  function fitDonutValue(amount, innerPx) {
    const MAX = 15, MIN = 9.5, BUDGET = 0.92;
    const units = (s) => Array.from(s).reduce((a, ch) =>
      a + (/[0-9]/.test(ch) ? 0.62 : /[.,]/.test(ch) ? 0.33 : ch === "-" ? 0.4 : 1), 0);
    const n = numberValue(amount);
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    const cands = [money(n)];
    if (!Number.isInteger(abs)) cands.push(money(Math.round(n)));          // 退一步：去掉分位
    if (abs >= 1e8) cands.push(`${sign}¥${(abs / 1e8).toFixed(1)}亿`);      // 再退：紧凑写法
    else if (abs >= 1e4) cands.push(`${sign}¥${(abs / 1e4).toFixed(1)}万`);
    const budget = innerPx * BUDGET;
    for (const text of cands) {
      const size = budget / units(text);
      if (size >= MIN) return { text, size: Math.min(MAX, size) };
    }
    return { text: cands[cands.length - 1], size: MIN };
  }

  function chartDonutSVG(items, total, centerLabel = "已结算利润", colors = PALETTE) {
    // v30：环细一点（17→13）、半径大一点（44→45）——内圆从 71px 放到 77px，中心那行金额才有地方落脚，
    // 观感也轻一些（原来那圈 17px 的厚环是「有点丑」的来源之一）
    const S = 128, r = 45, sw = 13, C = 2 * Math.PI * r;
    let offset = 0, slices = "";
    items.forEach((it, i) => {
      const frac = it.value / total;
      const gap = items.length > 1 ? 1.5 : 0;
      const dash = `${Math.max(0.5, frac * C - gap).toFixed(2)} ${(C - Math.max(0.5, frac * C - gap)).toFixed(2)}`;
      slices += `<circle cx="${S / 2}" cy="${S / 2}" r="${r}" fill="none" stroke="${colors[i % colors.length]}"
        stroke-width="${sw}" stroke-dasharray="${dash}" transform="rotate(${(offset * 360 - 90).toFixed(2)} ${S / 2} ${S / 2})"/>`;
      offset += frac;
    });
    const cv = fitDonutValue(total, 2 * (r - sw / 2) - 4);
    const labelY = (S / 2 + 5 + cv.size * 0.62).toFixed(1);
    return `<svg viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
      <circle cx="${S / 2}" cy="${S / 2}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${sw}"/>
      ${slices}
      <text x="${S / 2}" y="${S / 2 - 2}" font-size="${cv.size.toFixed(1)}" font-weight="700" style="fill:var(--ink);font-variant-numeric:tabular-nums" text-anchor="middle">${cv.text}</text>
      <text x="${S / 2}" y="${labelY}" font-size="9" style="fill:var(--muted)" text-anchor="middle">${escapeHtml(centerLabel)}</text>
    </svg>`;
  }

  function renderReport() {
    const range = repRange(reportMode, repCursor);
    $("#repLabel").textContent = range.label;
    const s = reportStats(range.start, range.end);
    const prev = prevReportStats();

    const lines = [];
    const feeStats = reportFeeStats(range.start, range.end);
    // v33：空态不再只看「下单数 + 回款总额」——本期只记了批次邮费、或本期回款合计正好为零，
    // 都会被旧条件误判成「没有记录」。改成同时看本期回款记录（byName 由回款日期归期建组）与本期邮费。
    const hasPeriodIncome = Object.keys(s.byName).length > 0;
    if (s.n === 0 && !hasPeriodIncome && feeStats.totalCents === 0) {
      lines.push(`<b>${escapeHtml(range.label)}</b> 没有记录。`);
    } else {
      // v33：净亏时金额取绝对值——「净亏 ¥-120」是双负号读法，负号由文字承担。
      // 零值不称为“赚”；这里仍展示原有利润，不另扣本期邮费。
      const profitWord = s.profit > 0 ? "净赚" : s.profit < 0 ? "净亏" : "盈亏";
      const profitClass = s.profit > 0 ? "pos" : s.profit < 0 ? "neg" : "";
      lines.push(`<b>${escapeHtml(range.label)}</b> 下单 ${s.n} 单：垫出 <b>${money(s.cost)}</b>，邮费 <b>${money(feeStats.totalCents / 100)}</b>，回款 <b>${money(s.income)}</b>，${profitWord} <b class="${profitClass}">${money(Math.abs(s.profit))}</b>。`);
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

    // v33：图例点＝该序列线/柱的实色（与两支绘图函数共用 SERIES_COLOR）
    $("#flowLegend").innerHTML = `<i class="lg-dot" style="background:${SERIES_COLOR.cost}"></i>垫出　<i class="lg-dot" style="background:${SERIES_COLOR.income}"></i>回款`;
    $("#chartFlow").innerHTML = chartFlowSVG(buckets, bucketStats);

    $("#profitLegend").innerHTML = `<i class="lg-dot" style="background:${SERIES_COLOR.gain}"></i>赚　<i class="lg-dot" style="background:${SERIES_COLOR.loss}"></i>亏`;
    $("#chartProfit").innerHTML = chartProfitSVG(buckets, bucketStats);

    // 邮费统计：整批一起寄的合成一行（含这一批都是哪些货），单寄的合并成一行
    const feeRows = feeStats.batches.map((b) => {
      const nums = [`${b.count} 单`, `邮费 ${money(b.feeCents / 100)}`];
      if (b.incomeCents > 0) nums.push(`回款 ${money(b.incomeCents / 100)}`);
      if (b.pending > 0) nums.push(`${b.pending} 单在途`);
      // v24：一起寄的一批只有一笔邮费，整批金额就是这一批的唯一权威值，成员明细按它摊——
      // 所以正常情况下这两个数必然相等，报表只显示上面那一行。只有在**确实合不上**时才补一句：
      // 那是「有人单独改过某单」或历史数据留下的痕迹（退出/重组会按份额扣减，合得上）。
      // 措辞把两个数各自是谁讲清楚，别让人以为同一批有两个邮费（v21 的「整批录入 邮费 ¥1」很容易
      // 被读成「这一批的邮费是 ¥1」，而上面明明写着成员合计 ¥32）。
      if (b.entryFeeCents > 0 && b.entryFeeCents !== b.feeCents) {
        nums.push(`整批录的是 邮费 ${money(b.entryFeeCents / 100)}，与成员合计不同（有单被单独改过）`);
      }
      if (b.entryIncomeCents > 0 && b.entryIncomeCents !== b.incomeCents) {
        nums.push(`整批录的是 回款 ${money(b.entryIncomeCents / 100)}，与成员合计不同（有单被单独改过）`);
      }
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

    // 环形图：本期回款里合计利润为正的商品，Top5 + 其他
    const ranked = Object.entries(s.byName).map(([name, g]) => ({ name, value: g.profit }))
      .filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
    const top = ranked.slice(0, 5);
    const restVal = ranked.slice(5).reduce((a, b) => a + b.value, 0);
    if (restVal > 0) top.push({ name: "其他", value: restVal });
    const total = top.reduce((a, b) => a + b.value, 0);
    if (total <= 0) {
      $("#chartDonut").innerHTML = `<div class="empty-mini">本期回款中，暂无合计利润为正的商品</div>`;
    } else {
      // v33：切片色与图例色**同出一个数组**——分片与图例各写一份取模正是「其他」撞榜首的来路。
      const sliceColors = top.map((_, i) => donutColor(i));
      const legend = top.map((it, i) => `
        <div class="donut-legend-row">
          <i class="lg-dot" style="background:${sliceColors[i]}"></i>
          <span class="dl-name">${escapeHtml(it.name)}</span>
          <span class="dl-val">${money(it.value)} · ${Math.round(it.value / total * 100)}%</span>
        </div>`).join("");
      $("#chartDonut").innerHTML = `<div class="donut-wrap">${chartDonutSVG(top, total, "盈利合计", sliceColors)}<div class="donut-legend">${legend}</div></div>`;
    }

    // v33：本期回款商品榜；与顶部净盈亏共用记录集合。
    const products = Object.entries(s.byName)
      .sort((a, b) => b[1].profit - a[1].profit)
      .slice(0, 5);
    const maxP = Math.max(1, ...products.map(([, g]) => Math.abs(g.profit)));
    $("#reportProducts").innerHTML = products.length === 0
      ? `<div class="empty-mini">本期没有回款记录</div>`
      : products.map(([name, g]) => `
        <div class="prod-row">
          <div class="prod-line">
            <span class="prod-name">${escapeHtml(name)}</span>
            <span class="prod-nums">回款 ${g.count} 单 <b class="${g.profit > 0 ? "pos" : g.profit < 0 ? "neg" : ""}">${money(g.profit)}</b></span>
          </div>
          <div class="prod-bar-track"><span class="prod-bar ${g.profit >= 0 ? "pos" : "neg"}" style="width:${Math.round(Math.abs(g.profit) / maxP * 100)}%"></span></div>
        </div>`).join("");
  }

  // ---- 记单 / 编辑 ----
  // v25：类型切换只是**表单的显隐形态**（见文件头）。这里与落库无关，一个字都不写进数据。
  // v33：渠道控件只有**一个**（<select name="channel">），货单时住在「更多」里、收入模式搬回主区——
  // 移动的是同一个 DOM 节点（值和事件都跟着走），所以永远不可能出现两份控件不同步。
  // 摘要只在非默认状态时追加状态名；渠道为空**必须**显示「未填写」，不能虚报「收货商」——
  // 标题说的必须是真正会保存下去的那个值（提交那一步存的就是这一格的现值）。
  function updateFormMoreSummary() {
    const f = $("#orderForm");
    const channel = String(f.channel.value || "").trim() || "未填写";
    const status = f.status.value;
    const tail = status && status !== "在途" ? ` · ${statusLabel(status)}` : "";
    $("#formMoreSummary").textContent = `更多（渠道：${channel}${tail}）`;
  }

  function applyKindUi() {
    const income = formKind === "income";
    const f = $("#orderForm");
    const channelField = $("#formChannelField");

    // v33：只移动原控件，保留值和事件；收入模式的渠道仍默认可见。
    if (income) {
      $("#formChannelHome").appendChild(channelField);
    } else {
      const body = $("#formMore .more-body");
      body.insertBefore(channelField, body.firstChild);
    }

    f.classList.toggle("kind-income", income);
    $$("#formKind .seg").forEach((b) =>
      b.classList.toggle("on", b.dataset.kind === formKind));
    $("#formCostLabel").textContent = income ? "金额" : "垫付金额";
    $("#formChannelLabel").textContent = income ? "渠道" : "出掉渠道";
    f.goods.placeholder = income ? "这笔钱是什么？" : "卖什么？";
    updateFormMoreSummary();
  }

  // 切类型：隐藏的字段**不清空**（切回来值还在），共有字段（名称/金额/日期/渠道/备注）保留。
  // 只有「用户没碰过」的格子才补默认值：名称补「开发票」、渠道补「开发票」/「收货商」。
  function setFormKind(kind) {
    formKind = kind === "income" ? "income" : "order";
    const f = $("#orderForm");
    const income = formKind === "income";
    if (!channelTouched) f.channel.value = income ? INCOME_CHANNEL : "收货商";
    if (income) {
      if (!String(f.goods.value || "").trim()) { f.goods.value = INCOME_NAME; nameAuto = true; }
    } else if (nameAuto && String(f.goods.value || "").trim() === INCOME_NAME) {
      f.goods.value = "";        // 收回我们替他填的默认名：货单表单不该自带商品名
      nameAuto = false;
    }
    applyKindUi();
  }

  // order：编辑既有单（editingId = 其 id）；prefill：「再来一单」预填（editingId 保持 null，保存即新建）
  function openForm(order, prefill) {
    const src = order || prefill || null;
    editingId = order ? order.id : null;
    // v38（报告 B2）：**编辑会话**（内存）——记下这次编辑依赖的账本代次 + 原单快照，写回前对表。
    // 整包换过账本（导入/云端拉取/重置/换身份，代次变）或原单被别的入口改过/删掉（快照变），
    // 这一次保存就**整笔拒绝**并保留草稿，绝不自动挑一边的值（旧表单值 vs 新账本值）。
    // v38 收尾（F4）：新建（无 order）不建会话。「再来一单」也落在这条分支里（duplicateOrder 走
    // openForm(null, o)），两件事必须说清——
    //   · 它**有**原单：prefill 的各值确实可能来自换包**前**的那本账（弹窗不会被换包关掉，
    //     render() 只重绘列表），所以旧注释「它没有『原单』可对表」不成立。
    //   · 但保存走的是 push（写一条**新**记录），不覆盖任何既有记录，也不会把旧值写回原单；
    //     这类错值的代价只是用户自己看得见、可以删掉的一条新草稿。所以这里**不设**拒绝门槛
    //     （加了会改变「再来一单」的手感：一次拒绝＋要求重开）。要拦是产品决定，不在这轮自作主张。
    formSession = order
      ? { generation: ledgerGeneration, id: order.id, snap: orderSnap(order) }
      : null;
    prefillPlatform = !order && prefill ? String(prefill.platform || "") : "";
    // v25：编辑既有记录一律按货单形态回显（不判别它"是不是收入单"——没有类型字段可判）；
    // 打开时把模式与两个"默认值"标记复位，渠道带过来就算用户已经定过，切类型不该把它改掉
    formKind = "order";
    nameAuto = false;
    channelTouched = !!src;
    const f = $("#orderForm");
    f.goods.value = src ? src.name : "";
    // v25：金额两项按**数值**回填（0 就写 0），不再用 `|| ""` 把 0 变成空串。
    // 原因：垫付那一格带 required，回填成空串会让「编辑一条 0 元单、什么都不改直接保存」被浏览器
    // 的原生校验拦死（点保存像没反应）；而收入单的 cost 恒为 0，这条编辑路径天天要走。
    f.cost.value = src ? numberValue(src.cost) : "";
    f.qty.value = src ? src.qty : 1;
    f.date.value = order ? order.date : todayStr();     // 预填/新建一律用今天
    // v33：渠道下拉照**状态下拉那一套既有做法**——打开表单时把这一单自己的渠道补进选项。
    // 旧写法只写 `f.channel.value = src.channel`：渠道不在 CHANNELS 六项里时（比如一份手写备份或者
    // 早期版本留下的「拼多多」），控件因没有匹配项而回空、摘要如实写「未填写」，用户**不动任何格子
    // 直接保存就把渠道静默清成 ""**——v25 的状态下拉踩过同一个坑，当时的处理办法就是补一个选项。
    // 重建的是**那个唯一的渠道控件**本身（全表单只有一个 name="channel"）：收入模式下 applyKindUi
    // 把它整格搬到主区，选项跟着控件走，所以货单态与收入态都生效。
    const channelOpts = CHANNELS.slice();
    const currentChannel = src ? String(src.channel || "") : "收货商";
    // 空值也是原值：编辑和再来一单都不替用户补成“收货商”。
    if (src && !channelOpts.includes(currentChannel)) channelOpts.push(currentChannel);
    fillSelect(
      f.channel,
      channelOpts.map((c) => [c, c === "" ? "未填写" : c]),
      currentChannel
    );
    f.fee.value = src ? numberValue(src.fee) : "";      // 同上：0 写成 0（邮费可不填，留空仍按 0 算）
    // 状态下拉：现役两态；编辑遗留「自留」单时把该单自己的旧状态补进去（只读项），
    // 否则下拉会因没有匹配项而回空、保存时把状态静默改写掉——v21 的红线就是不许改写旧状态
    const statusOpts = STATUSES.slice();
    if (order && !statusOpts.includes(order.status)) statusOpts.push(order.status);
    fillSelect(f.status, statusOpts.map((s) => [s, statusLabel(s)]), order ? order.status : "在途");
    f.note.value = src ? src.note : "";
    // v31：快递单号只在**编辑既有单**时回填它的值；新建与「再来一单」一律空着——
    // 「再来一单」是又寄了一次、单号一定不一样（沿用原单的单号会报错单，比空着严重）。
    // 注意不能写成 `src ? src.tracking : ""`：src 也包含 prefill（再来一单），那正是要排除的那条路。
    f.tracking.value = order ? cleanTracking(order.tracking) : "";
    // v24：批内单的「邮费该在哪改」。用户的困惑点正是这个——他一直在找"每一单的邮费"，
    // 而项目模型是**一起寄的一批只有一笔邮费**，那个数记在批次上（改入口在批次表头和这张单的
    // 卡片上）。未成批的单不加这行（它的邮费就是它自己的）。不改表单行为：邮费框照样可改，
    // 单独改出来的差异由表头的「≠ 成员明细合计」如实提示。
    const batchHint = $("#formBatchHint");
    if (order && order.batchId) {
      batchHint.hidden = false;
      batchHint.textContent = `这一单属于一起寄出的那一批（${order.batchDate || order.date}），`
        + `邮费在批次那行、或这张单卡片上的「改本批邮费」里统一改；在这里单独改只会让它和整批口径不一致。`;
    } else {
      batchHint.hidden = true;
      batchHint.textContent = "";
    }
    // v27：编辑一条**自己填着回款**的单时，把那笔钱写在表单里（只读一行，纯展示、不加输入框）。
    // 起因：编辑表单里没有回款栏，用户点「编辑」想改金额时最容易把数字填进「垫付金额」那一格，
    // 一填就把这条单的垫付改坏。判据就是这条记录自己的两个字段（状态已是「已回款」且 income 非空），
    // **不判断它是不是收入单**；改金额的入口仍是卡片上的「改回款」。
    const incomeHint = $("#formIncomeHint");
    if (order && order.status === "已回款" && order.income !== null) {
      incomeHint.hidden = false;
      incomeHint.textContent = `本单回款 ${money(order.income)} · 改金额请用卡片上的「改回款」`;
    } else {
      incomeHint.hidden = true;
      incomeHint.textContent = "";
    }
    $("#formTitle").textContent = order ? "编辑订单" : "记一单";
    $("#formMore").open = !!(order && order.status !== "在途");
    // v25：编辑表单**不加**类型切换（一律按货单形态回显，用户在该形态下自由改）
    $("#formKind").hidden = !!order;
    applyKindUi();
    $("#formModal").classList.add("show");
    setTimeout(() => f.goods.focus(), 120);
  }

  function closeForm() {
    $("#formModal").classList.remove("show");
    editingId = null;
    formSession = null;   // v38：编辑会话随弹窗关闭一起作废（下次「编辑」会重新记一份）
  }

  function submitForm(ev) {
    ev.preventDefault();
    const f = ev.target;
    // v25：保存后表单已经关了（连点保存的第二次、或事件晚到的那一下）一律丢弃，
    // 保证「一次保存 → 恰好一条」。真实用户连点第二下时按钮已随弹窗隐藏，这里兜住程序化连点。
    if (!$("#formModal").classList.contains("show")) return;
    const isIncome = formKind === "income" && !editingId;   // 编辑一律走货单路径
    const name = String(f.goods.value || "").trim();
    const date = f.date.value || todayStr();
    if (!name) { toast(isIncome ? "先填名称" : "先填商品名称"); return; }

    // —— v25 收入单：只填一个金额，没有垫付/邮费/数量，落库全部用**现有字段** ——
    if (isIncome) {
      const raw = String(f.cost.value || "").trim();
      if (!raw) { toast("先填金额"); return; }        // 留空 ≠ 0：填 0 是合法的 0 元收入
      const amount = numberValue(raw);
      if (amount < 0) { toast("金额不能是负数"); return; }
      const order = {
        id: uid(),
        date,                                        // 用户只填一个日期：它既是发生日也是到账日
        name,
        platform: prefillPlatform,
        qty: 1,
        cost: 0,
        pay: "",
        channel: String(f.channel.value || "").trim(),   // 收入单渠道非必填
        income: amount,
        incomeDate: date,
        status: "已回款",
        fee: 0,
        batchId: "", batchDate: "", batchFee: 0, batchIncome: 0, batchCount: 0,
        batchFeeShare: 0, batchIncomeShare: 0,
        note: String(f.note.value || "").trim(),
        // v31：收入单不会寄件，单号恒空（那一格在收入模式下是 .kind-order、隐藏且不参与校验，
        // 与邮费/数量同一条规矩：隐藏字段取库里的定值，不回读界面）
        tracking: "",
        createdAt: new Date().toISOString(),
      };
      data.orders.push(order);
      closeForm();
      saveData();
      toast("已记账");
      switchView("list");
      return;
    }

    const cost = numberValue(f.cost.value);
    if (cost < 0) { toast("垫付金额不能是负数"); return; }
    // v38（报告 B2）：编辑会话先对表再往下走 —— 三条失效路各说各的话，**都在任何写入之前**：
    //   ① 原单已不在账本里（被别的入口删掉）：**必须拒绝**，绝不能落进下面那条「新建」分支
    //      ——那等于拿一份旧表单的草稿凭空造一条新记录；
    //   ② 账本整包被换过（代次变）或原单已被改过（快照对不上）：拒绝落库、草稿留在表单里供核对。
    // 对表放在「0 元购确认框」之前：失效的编辑连确认都不该弹（点完再报「没保存」是骗点击）。
    const existing = editingId ? data.orders.find((o) => o.id === editingId) : null;
    if (editingId && !existing) {
      toast("这一单已不在账本里，这次编辑没保存，请关掉重新核对");
      return;
    }
    if (formSession && (formSession.generation !== ledgerGeneration
      || formSession.id !== existing.id || formSession.snap !== orderSnap(existing))) {
      toast("账本已更新，这次编辑没保存，请重新打开核对");
      return;
    }
    // 垫付 0 的确认框（v26 起文案同时覆盖两种情形）：它服务货单的「0 元购/白嫖」，也是
    // **编辑一条纯收入单**时必然走到的那一格（编辑一律按货单路径回显、垫付恒为 0），
    // 老文案「确认这是 0 元购/白嫖的单子吗？」在后一条路上读起来不通，所以改成中性措辞。
    // 刻意**不做**「这条是不是收入单」的判断：任何靠 cost===0 / 字段缺省去识别的写法都会把
    // 「垫付 0 的已回款老货单」误判成收入单（v25 已定为禁止项），这次点击原样保留。
    if (cost === 0 && !confirm("这一单垫付金额为 0（白嫖单或纯收入单），确认保存吗？")) return;
    // v27：把状态存成「在途」而这一条自己还留着回款 → 先问一声（v27 起两处口径统一为
    // 「回款非空即收入」，所以这条记录存成在途后**回款照旧计入收入统计**——文案必须讲这条实话）。
    // 判据只有两个：这一条记录自己的 status 选择 + 它自己的 income 字段，
    // **不做**任何「这是不是收入单」的判断（v25 定的红线：靠 cost===0 / 字段缺省去识别必然误伤）。
    const keepIncome = existing ? existing.income : null;
    if (f.status.value === "在途" && keepIncome !== null) {
      if (!confirm(`这一单填着回款 ${money(keepIncome)}，却要存成「在途」？\n`
        + "存成「在途」后，它的垫付会重新算进「垫付在外未回笼」、也不再计入「已结算净盈亏」；"
        + "那笔回款照旧按回款日期计入收入统计。")) return;
    }
    const order = {
      id: existing ? existing.id : uid(),
      date,
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
      // 编辑不改变批次归属（改的是这一单自己的字段；整批口径仍以批量结算时为准，v24 起
      // 整批金额就是这一批的唯一权威值，成员单上的金额只是它的分摊）；
      // 份额字段原样带过——它记的是「本批摊到这一单多少」，退出/重组扣减要靠它。
      // 单独改这一单的邮费不算「改本批」：表头会用「≠ 成员明细合计」如实提示这种不一致
      batchId: existing ? existing.batchId : "",
      batchDate: existing ? existing.batchDate : "",
      batchFee: existing ? existing.batchFee : 0,
      batchIncome: existing ? existing.batchIncome : 0,
      batchCount: existing ? existing.batchCount : 0,
      batchFeeShare: existing ? existing.batchFeeShare : 0,
      batchIncomeShare: existing ? existing.batchIncomeShare : 0,
      note: String(f.note.value || "").trim(),
      // v31：新建与编辑**同一条表达式**——编辑时这一格由 openForm 回填了原值，用户改成什么就存什么；
      // 清空这一格再保存＝把这一单的单号去掉（与「邮费留空＝删掉」同一条规矩，界面里也有「清空」小按钮）
      tracking: cleanTracking(f.tracking.value),
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
    // v38（报告 B2）：回款/改回款也是「打开时记账本、稍后才写」的会话——预填的金额与利润预览
    // 都建立在打开那一刻这一单的样子上；代次变了或这一单被改过，提交必须整笔拒绝并说明。
    paySession = { generation: ledgerGeneration, id: o.id, snap: orderSnap(o) };
    // v26：「已回款的单」从这里进来是**改回款**——预填它现在记着的金额与回款日期（而不是
    // 「垫付价 + 今天」），提交时也只写回这两个字段（见 submitPay）。判据就是这一条记录自己的
    // status，与「它是不是收入单」无关（收入单不落任何类型字段，也不许去猜）。
    payEditMode = o.status === "已回款";
    const f = $("#payForm");
    // 已回款却没有回款金额的老单（状态是用户在编辑表单里手选成「已回款」的）：填 0 而不是留空，
    // 「留空」会被那个 required 框拦下，点确认像卡住（v24 记过的坑）。0 也正是它在利润口径里的值。
    const curIncome = o.income === null || o.income === undefined ? 0 : o.income;
    f.income.value = payEditMode ? curIncome : (o.cost || "");
    f.incomeDate.value = payEditMode ? (o.incomeDate || todayStr()) : todayStr();
    $("#payTitle").textContent = `${payEditMode ? "改回款" : "回款"} · ${o.name}`;
    updatePayPreview();
    $("#payModal").classList.add("show");
    setTimeout(() => f.income.focus(), 120);
  }

  function closePayForm() {
    $("#payModal").classList.remove("show");
    payTargetId = null;
    payEditMode = false;
    paySession = null;   // v38：会话随弹窗关闭一起作废（下次打开重新记一份）
  }

  function updatePayPreview() {
    const o = data.orders.find((x) => x.id === payTargetId);
    if (!o) return;
    const income = numberValue($("#payForm").income.value);
    const profit = income - o.cost - o.fee;
    $("#payPreview").innerHTML = `利润 <b class="${profit > 0 ? "pos" : profit < 0 ? "neg" : ""}">${profit >= 0 ? "+" : ""}${money(profit)}</b>（垫付 ${money(o.cost)}${o.fee ? "＋邮费 " + money(o.fee) : ""}）`;
    $("#paySubmit").textContent = `${payEditMode ? "确认改回款" : "确认回款"} ${money(income)}`;
  }

  function submitPay(ev) {
    ev.preventDefault();
    const f = ev.target;
    const o = data.orders.find((x) => x.id === payTargetId);
    if (!o) return closePayForm();
    // v38（报告 B2）：写回前对表——这一单被别的入口改过、或整包换过账本（代次变），
    // 就拒绝落库。**刻意不关弹窗**：用户刚打的金额留在框里供核对（关掉就等于把草稿也丢了）。
    // 原来这里是无条件写：云端把同 id 的垫付从 100 改成 777 之后，用户只改备注保存，
    // 结算预览是按旧垫付算的、写进去的也是旧垫付下的决定。
    if (paySession && (paySession.generation !== ledgerGeneration
      || paySession.id !== o.id || paySession.snap !== orderSnap(o))) {
      toast("账本已更新，这次回款没保存，请重新打开核对");
      return;
    }
    const income = numberValue(f.income.value);
    // v26：改回款 = 只改这一条记录自己的 income 与 incomeDate 两个字段，
    // 状态保持「已回款」（**不产生第二条记录**、不动 cost/fee/qty/批次字段/其它任何一格）。
    // 批内单改回款后批次表头会如实提示「≠ 成员明细合计」——那是预期的：批次口径属于另一个入口
    // （「改本批邮费/回款」），这里绝不顺手去改它。
    // 「回款」（未结算单）仍是老行为：写上金额与日期并置为已回款。
    const wasEdit = payEditMode && o.status === "已回款";
    o.income = income;
    o.incomeDate = f.incomeDate.value || todayStr();
    if (!wasEdit) o.status = "已回款";
    closePayForm();
    saveData();
    toast(wasEdit ? `已改回款 ${money(income)}，利润 ${money(orderProfit(o))}` : `已回款 ${money(income)}，利润 ${money(orderProfit(o))}`);
  }

  // v24：表单里的「清空」小动作（记单/编辑的邮费栏、回款弹窗的回款金额栏）。
  // 用户报「找不到删除入口」的另一半原因就是：删除＝把输入框留空，而「留空」这件事没人猜得到。
  // 语义一个字没改，只是让它可发现：
  //   · 邮费栏本来就不是必填，留空＝按 0 算（文档里的老口径），所以直接置空；
  //   · 回款金额那个框带着 required，置空会被浏览器拦下（点完「清空」再点确认会像卡住一样没反应），
  //     所以置 0——金额口径完全一样（numberValue("") === numberValue("0") === 0）。
  // 置完立刻跑既有的利润预览，数字当场跟着变。
  // v31：报单面板「快递单号」那一格的「清空」也走这一支（data-clear="tracking"）。
  // 清空＝**用户动过那一格**（与手输同一个提交口）：「留空＝去掉这几单的单号」与邮费那一格同一条规矩。
  // 这里不自己动手写库/复制，直接交给 commitBaodanTracking（写库 + 重算文本 + 重新复制 + toast 一套全走它），
  // 免得清空与手输两条路各写一套、日子久了行为分叉。
  function clearField(ev) {
    const btn = ev.target.closest("button[data-clear]");
    if (!btn) return;
    ev.preventDefault();        // 按钮在 <label> 里，兜一下 label 的激活行为
    if (btn.dataset.clear === "income") {
      $("#payForm").income.value = "0";
      updatePayPreview();
      return;
    }
    if (btn.dataset.clear === "tracking") {
      $("#baodanTracking").value = "";
      commitBaodanTracking();
      return;
    }
    $("#orderForm").fee.value = "";
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

  // ---- v35：分项利润编辑的三个写/渲染动作 ----
  // 只重渲染这一个批次块（照 v32 折叠的手法）：整列表 renderList() 会把滚动位置和
  // 用户手上的状态打飞；.batch-block 本身的类（展开/收起）不碰，所以切态结果保留。
  // 批次已经不存在（极端：刚被删单解散）时才兜底整表重绘。
  function rerenderBatchBlock(batchId) {
    const blocks = $$("#orderList .batch-block");
    const blk = blocks.find((x) => x.dataset.batch === batchId);
    const g = batchGroups().get(batchId);
    if (!blk || !g) { renderList(); return; }
    const orders = filteredOrders();
    const members = orders.filter((o) => o.batchId === batchId);
    blk.innerHTML = batchHeadHtml(g, orders) + members.map((o) => orderCardHtml(o, "in-batch", false)).join("");
  }

  // 写库 + 触发既有 450ms 防抖同步 + 局部重渲染（**不走 saveData**：那会 render() 整页）。
  // meta.updatedAt / meta.filter 与 saveData 保持同一套写法（同步包靠 updatedAt 判新旧）。
  function touchBatchAndRerender(batchId) {
    meta.updatedAt = new Date().toISOString();
    meta.filter = currentFilter;
    persist();
    scheduleSync();
    rerenderBatchBlock(batchId);
    // v38（报告 B5）：这一批的钱变了，**派生视图**（看板 / 报表）必须跟着刷。原来只重绘当前批次块，
    // 于是「改进分项利润 → 不刷新、切报表」看到的还是旧商品榜与旧环图（账本已经是对的，两页对不上；
    // 恢复默认分摊那条路同样）。局部重绘照旧保留（避免滚动位置跳动），这里只补两个派生页；
    // 统计公式一个字不动。
    renderDash();
    renderReport();
  }

  // 点一下利润数字 → 原地换成行内输入框（预填当前利润，元、两位小数），聚焦全选方便直接打新值。
  // 不弹窗、不加确认（用户偏好「点点就完事」）；提交走 change，放弃走 Escape。
  function startProfitEdit(btn) {
    const id = btn.dataset.id || "";
    const o = data.orders.find((x) => x.id === id);
    if (!o) return;
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.className = "profit-input";
    input.dataset.id = id;
    // v38 收尾（F3）：行内编辑也要带上自己的**账本代次**（与 formSession / paySession / batchSession 同款）。
    // 输入框里这个值是用户在**旧账本**上下文里形成的；提交时账本若已整包换过，绝不许按旧意图写。
    input.dataset.generation = String(ledgerGeneration);
    // v36：格式白名单（可选负号 + 整数/两位小数 + 可选指数）。**必须有**——commitProfitEdit
    // 提交前那句 `input.checkValidity()` 就是靠它兜住 "abc" 这类值；没有它，toCents("abc") 会
    // 静默返回 0、isSafeInteger(0) 又为真，「清空/打错再点到别处」就把那一项钉成 0 元并整批重摊
    // （v35 的缺陷）。指数那一段是刻意留的：1e307 这类要能走到「超出合理范围」那条判据，
    // 而不是被格式判据拦下。写法注意：`[+\-]` 里的短横**必须转义**——HTML 的 pattern 走 v 模式
    // 编译，`[+-]` 会编译失败、于是整条 pattern 被浏览器静默忽略（实测：那样 "abc" 会被放行）。
    input.pattern = "-?(\\d+(\\.\\d{0,2})?|\\.\\d{1,2})([eE][+\\-]?\\d+)?";
    // 按整数分算当前利润再转回元显示（orderProfit 是浮点直减，喂给输入框前先落分，避免 0.1+0.2 类残差）
    input.value = ((toCents(o.income === null ? 0 : o.income) - toCents(o.cost) - toCents(o.fee)) / 100).toFixed(2);
    btn.replaceWith(input);
    // v37 改动 B：输入框打开期间给一行灰色小字，把「钉住的作用域」讲清楚（只在编辑时占位，
    // 提交/放弃/Escape 都走 rerenderBatchBlock 整块重绘，提示随之消失、收起后零占位）。
    // 样式复用既有 .foot-note 小字，不新造视觉；文案为用户拍板的短版。
    const card = input.closest(".order-card");
    if (card && !card.querySelector(".profit-lock-hint")) {
      const hint = document.createElement("div");
      hint.className = "foot-note profit-lock-hint";
      hint.textContent = "钉住只在本次有效；刷新后按现值重算";
      const top = card.querySelector(".order-top");
      if (top) top.insertAdjacentElement("afterend", hint);
      else card.appendChild(hint);
    }
    input.focus();
    input.select();
  }

  // 提交一项利润编辑（行内输入框 change/Enter 时进来）。语义是 A：
  //   被改项按新值**钉住**（进 profitLocks），剩余池按垫付占比分给还没钉住的项；
  //   已钉住项一个字节不动；Σ各项恒 = 总利润。全锁且 Σ≠总利润 → 拒绝并提示差多少。
  // 只写 income + batchIncomeShare（submitBatch 回款分支的同一对字段，元/分两份同一数值）；
  // cost / fee / batchFeeShare / incomeDate / status / 整批口径一个字不动（表头三个「整批：」不变）。
  // v36 补强两处，都是为了「不许静默」：① 输入非法值先校验再结算（空 ≠ 0、格式/范围不对就不写库）；
  // ② 读锁时与账本现值对表，陈旧的锁当作没锁并按现值重摊，且把失效项的名字报给用户。
  function commitProfitEdit(input) {
    // v38 收尾（F3）：**显式**代次守门——这是本轮之前唯一没有守门的写入口。它当时之所以打不进去，
    // 只是因为「每次换包都恰好伴随 render() → renderList() 整块 innerHTML 把行内输入框销毁」，
    // 靠实现细节遮蔽：将来谁去掉那次重绘，就会重开 B2 那一类「拿旧账本的意图改新账本」的缺陷，
    // 而现有断言一条都抓不到。守门位置刻意在 `!o` 早退**之前**：换包后按 id 找不到这一单时走的正是
    // 这条，不许靠「找不到就当没事」。
    if (input.dataset.generation !== String(ledgerGeneration)) {
      toast("账本已更新，这次编辑没保存，请重新打开核对");
      return;
    }
    const id = input.dataset.id || "";
    const o = data.orders.find((x) => x.id === id);
    if (!o || !o.batchId) return;   // 散单/找不到：没有批次块要动，直接收工
    const batchId = o.batchId;
    const g = batchGroups().get(batchId);
    const members = data.orders.filter((x) => x.batchId === batchId);
    if (!g || members.length < 2) { rerenderBatchBlock(batchId); return; }
    const info = batchProfitInfo(g, members);
    if (!info.editable) { rerenderBatchBlock(batchId); return; }
    // v36：先校验再结算（照批次弹窗那套「先 checkValidity 再分摊」的精神）。空串＝放弃编辑，
    // **绝不是 0**；格式不对与超出合理范围一律不写库、不重摊，并说清是哪一种（v35 这里直接
    // toCents(input.value)，把 "" 与 "abc" 都静默当成 0 写进去，1e307 则靠守恒自查撞下来、
    // 提示还是句废话「差 ¥0.00」）。
    const rawVal = (input.value || "").trim();
    if (rawVal === "") { rerenderBatchBlock(batchId); return; }
    // 去掉首尾空白后再验格式：toCents 本来就接受 " 50 "，别因为加了校验反而把它拒掉
    input.value = rawVal;
    if (!input.checkValidity()) { toast("金额格式不对，这一项没改"); rerenderBatchBlock(batchId); return; }
    // v38（报告 B4）：**不许用带默认值的容错转换**判数值范围。`toCents()` 走 `numberValue()`，
    // 而它把 Infinity/NaN 一律收成 0 ⇒ `1e999`（JS 里的 Infinity）会以「本金 0 元」的身份通过
    // 后面每一道检查、被当成 0 元利润静默写进账本（另两项随之被重摊），全程没有一句提示。
    // 这里用 `Number(rawVal)` 原样转 + `Number.isFinite` 严格判，再把「元」落成整数「分」；
    // 上限仍是 ¥500,000（＝50,000,000 分）——**不动 numberValue() 本体**，避免连带改变导入兼容口径。
    const numeric = Number(rawVal);
    if (!Number.isFinite(numeric) || Math.abs(numeric) > 500000) {
      toast("这个数超出合理范围，这一项没改");
      rerenderBatchBlock(batchId);
      return;
    }
    const newProfit = Math.round(numeric * 100);
    if (!Number.isSafeInteger(newProfit)) {
      toast("这个数超出合理范围，这一项没改");
      rerenderBatchBlock(batchId);
      return;
    }
    // v36：读锁时**与账本现值对表**。锁记的是「钉住那一刻那一项的利润」，别的入口（改本批邮费/
    // 回款、退批、导入、云端拉取、单条改 cost…）重写过这一批之后就与现值不等了 ⇒ 这条锁是
    // **陈旧**的，当作没锁交给剩余池重摊，并收集起来报给用户。v35 无条件信锁，于是两种静默：
    // ① 那几行被悄悄改回旧锁值（唯一未锁项吃下负剩余池）；② 编辑被误拒（弹「与总利润差 ¥X」）。
    // 判据：现值 = toCents(income) − toCents(cost) − toCents(fee)，正是本函数写回时用的那三项。
    const raw = profitLocks.get(batchId);
    const kept = new Map();
    const dropped = [];
    const locked = members.map((m) => {
      if (m.id === id) return newProfit;
      const v = raw ? raw.get(m.id) : undefined;
      if (v === null || v === undefined) return null;
      if (toCents(m.income) - toCents(m.cost) - toCents(m.fee) === v) { kept.set(m.id, v); return v; }
      dropped.push(m);            // 陈旧锁：以账本现值为准
      return null;
    });
    const weights = members.map((m) => Math.max(0, toCents(m.cost)));
    const r = batchProfitSplit(info.total, weights, locked);
    if (!r.ok) {
      toast(`与总利润差 ${money(Math.abs(r.diff) / 100)}，这项改不动`);
      rerenderBatchBlock(batchId);
      return;
    }
    // 守恒自查（内部不变量，不该红）：Σ新利润必须等于总利润，否则拒绝写库
    const sum = r.shares.reduce((a, b) => a + b, 0);
    if (sum !== info.total) {
      toast(`分摊异常（差 ${money(Math.abs(info.total - sum) / 100)}），未写入`);
      rerenderBatchBlock(batchId);
      return;
    }
    // v37 状态提示必须在**写回之前**判定「现值 ≠ 默认值」——若等写回后再看，首编从全默认出发
    // 也会因本次写入把各项掰离默认而误弹，正好破坏「正常分配流程零提示」。
    const preIncomes = members.map((m) => toCents(m.income));
    const defCents = splitByWeight(g.incomeCents, members.map((m) => Math.max(0, toCents(m.cost))));
    // v38（报告 B9 ①）：判偏离加 **±1 分容差**——1 分的归属是分币规则的噪音（结算弹窗里的成员
    // 数组顺序与「恢复默认分摊」用的账本顺序曾经不同，`splitByWeight` 的尾差按下标发，于是那一分
    // 会落在不同人头上），不是用户意图；实测 3 单同价、整批回款 ¥3.34 时每次首判都误报一次。
    // **这条容差只用于这条提示**：金额守恒、入库、对账（batchProfitInfo / batchDrift）一律仍按分币
    // 严格相等判。代价是它会漏掉「真实的 1 分手动偏离」——这是已选口径的明确代价。
    // v38 收尾（F1）：这里只收集**项的 id**（名字留到渲染时现取）——存名字会让「退批之后还点名
    // 已离开的成员」变成一条存量事实；存 id 才能让渲染那一刻重新对表（见 batchDetailNames）。
    const offMembers = members.filter((m, i) => Math.abs(preIncomes[i] - defCents[i]) > 1);
    const offIds = offMembers.map((m) => m.id);
    let changed = false;
    members.forEach((m, i) => {
      const incCents = r.shares[i] + toCents(m.cost) + toCents(m.fee);  // 利润 = 回款 − 垫付 − 邮费 反推回款
      // 份额字段与 normalizeData 的白名单同一收敛（负值归 0 + 取整）：写进去的就等于刷新后留下的，
      // 不制造「存 −400、刷新变 0」的字节漂移；income 本身白名单不收敛（负回款各处口径一致），照写。
      const shareVal = shareCents(incCents);
      if (toCents(m.income) !== incCents || shareCents(m.batchIncomeShare) !== shareVal) changed = true;
      m.income = incCents / 100;
      m.batchIncomeShare = shareVal;
    });
    // 钉住被改项（新值即新锁），并只保留**刚验过的新鲜锁**——陈旧的那些在构 locked 时就丢了；
    // 没钉过的项即使被剩余池重摊过也不算钉住。锁表空了（没有新鲜锁 + 被改项是唯一那把）也照常建键，
    // 键下就只留被改项这一把新锁。
    const next = new Map(kept);
    next.set(id, newProfit);
    profitLocks.set(batchId, next);
    // v37 改动 A（最终定稿：状态提示，而非逐次报账）——两条提示**互斥**：
    // dropped 非空时只出 v36 陈旧锁原句（更精确：点名失效项 + 原因），状态提示不参与；
    // dropped 为空时才走状态提示的**每批每会话只首判一次**规则。
    //
    // 判定时机＝本会话对该批的第一次提交编辑；**无论是否弹出都记为已看过**（内存 Set，不落库）。
    // 触发条件＝该批存在「现值 ≠ 默认值」的成员（默认值按 3.1：splitByWeight(g.incomeCents, cost)；
    // 判偏离用 m.income，禁用 batchIncomeShare——后者经 shareCents 把负值夹成 0，是有损视图）。
    // offIds 在写回前算好（见上方 preIncomes）；名字**不存**，渲染时按 id 现取（见 batchDetailNames）。
    //
    // 为什么不要「逐次报被吃掉的手改值」（选 1）也不要「首次满足条件时才弹」（选 2）：
    // - 选 1：A 手感下第一次编辑之后，未钉住项就全是非默认值 ⇒ 从第二次编辑起几乎每次都弹 ⇒
    //   用户很快不再读它，而这条提示的价值全在被读到，噪音会摧毁机制本身。
    // - 选 2：构造上做不到——刷新后没有任何内存状态能区分「用户手改留下的值」与「上次重摊留下的值」，
    //   两者都只是「不等于默认值」；要能区分就得落库，本轮已排除。
    // 所以改成「每批每会话说一次状态」：正常分配流程零提示；刷新后再编辑必弹一次并点名非默认项。
    //
    // 与 v36 陈旧锁句**互斥、不合并**的理由：陈旧锁那条已经比状态提示更精确（点名失效项 + 原因），
    // 再叠一句状态陈述是冗余；而「两者同现」在真实操作里不可达——陈旧锁要求本会话先前编辑过该批，
    // 而那次编辑就是首判点，当时各项还是默认值。
    if (dropped.length) {
      // 反静默：失效必须说人话。v38 收尾（F2）：这一支原来把**项名**拼进 toast（`names.slice(0, 3)`），
      // 而项名长度不受限（normalizeData 的上限是 120 字）——4 个长名实测 toast 256 字、盒子
      // 195×449px；3 个 120 字的名约 390 字会到 700px+，而 `.toast` 锚在 bottom:124px 且没有高度上限，
      // 长过半个视口就从**顶部**跑出屏幕：那不是「挤坏版面」，是点名本身静默失效。
      // 改法与状态提示**同一套**（两条提示的呈现必须一致）：短 toast 只说条数与事实、一个项名都不带，
      // 完整清单落到本批那行常驻说明（复用同一个 .bh-statusdetail）。
      statusHintDetail.set(batchId, { generation: ledgerGeneration, ids: dropped.map((m) => m.id) });
      toast(`本批已重摊：共 ${dropped.length} 项的手改锁定失效（已按现值重算）· 完整清单见本批说明`);
    } else if (!statusHintSeen.has(batchId)) {
      statusHintSeen.add(batchId);   // 无论是否弹出都记为已看过（内存态，reload 清零）
      if (offIds.length) {
        // v38（报告 B8 / D4）：短 toast **只陈述关键事实与本次重算范围**，项名一个都不进 toast。
        // 起因：项名长度不受限，两个 120 字的合法商品名把这条提示撑到 360px 下 527px 高
        // （实测），「没越界」不等于「可读」。完整点名落到批次表头那行常驻说明（statusHintDetail）：
        // 关掉编辑框之后仍查得到、项数就是当时的项数、逐个商品名可定位（不许用 CSS 裁掉后半句）。
        statusHintDetail.set(batchId, { generation: ledgerGeneration, ids: offIds.slice() });
        toast("本批现值与默认分摊不同：本次编辑会把没钉住的项一并重算（钉住只在刷新前有效）· 完整清单见本批说明");
      }
    }
    if (changed) touchBatchAndRerender(batchId);
    else rerenderBatchBlock(batchId);   // 值没变（比如原样确认）：只收起输入框，不碰账本、不触发同步
  }

  // 「恢复默认分摊」＝按垫付占比把整批回款重摊一次 —— 与 submitBatch 的回款分支**等价**
  // （纯赋值、幂等、尾差规则一致；任务书实现提示：复用这条既有路径，这个按钮几乎是免费的）。
  // 刻意不写 incomeDate / status（那是结算那一刻的语义，重摊不动日期与状态）；同时解开全部钉住。
  function resetBatchShares(batchId) {
    const g = batchGroups().get(batchId);
    const members = data.orders.filter((x) => x.batchId === batchId);
    if (!g || members.length < 2) return;
    const info = batchProfitInfo(g, members);
    if (!info.editable) { toast(batchReasonText(info.reason)); return; }
    const weights = members.map((o) => Math.max(0, toCents(o.cost)));
    const shares = splitByWeight(g.incomeCents, weights);
    members.forEach((o, i) => {
      o.income = shares[i] / 100;
      o.batchIncomeShare = shares[i];
    });
    profitLocks.delete(batchId);
    touchBatchAndRerender(batchId);
    toast("已恢复按垫付占比的默认分摊");
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
    const g = batchGroups().get(o.batchId);
    const idx = mates.findIndex((x) => x.id === id);
    const outFee = idx < 0 ? 0 : batchShares(mates, "batchFeeShare", g ? g.feeCents : 0)[idx];
    // v36：退出者带走的**回款**按它自己账本里的 income 扣，不再走 batchIncomeShare 反推——
    // 那个字段经 shareCents 把负值夹成 0，于是「允许负利润 + 某成员 income 为负」时它实际
    // 带走的是负收入、而 outIncome 记 0，留批人的整批回款被**抬高**（差额＝被夹掉的负数之和），
    // 对账告警随即亮起。outFee 不用改：batchFeeShare 非负，没有夹值问题。
    const outIncome = idx < 0 ? 0 : toCents(mates[idx].income);
    const leavers = [o].concat(others.length === 1 ? others : []);
    const leaverIds = new Set(leavers.map((x) => x.id));
    const staying = mates.filter((x) => !leaverIds.has(x.id));
    // v38（报告 B3 / D1）：留批成员的整批回款扣完若是负数，现行模型表示不了（batchIncome 会被
    // 白名单夹成 0）——**在任何写入之前**整笔拒绝，原账一分不动并说明原因。
    // 原来只把负剩余 `Math.max(0, …)` 夹成 0（实测：留批明细回款合计 −¥100，整批口径却写 ¥0），
    // 于是留在批里的人「整批口径 vs 成员明细」当场分叉、表头亮红——而钱已经被改了一半。
    const remainingIncome = (g ? g.incomeCents : 0) - outIncome;
    if (staying.length > 0 && remainingIncome < 0) {
      toast(`退出后剩下这几单的回款合计会是 ${money(remainingIncome / 100)}（负数），账本表示不了负的整批回款，本次没退批`);
      return;
    }
    const title = `一起寄出 · ${o.batchDate || o.date}`;
    const tail = others.length === 0
      ? "它本来就是这一批里唯一的一单，退出后这一批就没了。"
      : `退出后它不再和另外 ${others.length} 单绑在一起${others.length === 1 ? "，那单也只剩自己、一并退出批次。" : `，该批还剩 ${others.length} 单（整批邮费/回款会按份额扣掉它那部分）。`}`;
    if (!confirm(`「${o.name}」退出「${title}」这一批？\n${tail}\n`
      + `已经分摊到它头上的邮费 ${money(o.fee)}${o.income === null ? "" : "、回款 " + money(o.income)} 不改动，留在这一单上继续算利润。`)) return;
    // 退出者（以及「只剩它自己」时一并退出那一单）清空全部批次字段；留着的成员**不动 batchCount**——
    // 它记的是「结算那一刻有几个人」，正是表头区分「有人退出」与「金额被改过」的依据。
    // 剩下的人之后若原班人马再结一次，batchCount 会被重写成当时的人数，提示随之消失。
    // v36：退批＝这一批的成员构成变了，指向这一批的手改锁（按成员 id 钉的）随之作废。
    // **必须在下面 leavers.forEach 清空 x.batchId 之前**取一次原 batchId —— 位置写错（挪到清空
    // 之后）就等于没清：那时 o.batchId 已经是 ""，删的是一个不存在的键，旧锁原地留着重摊下一批。
    profitLocks.delete(o.batchId);
    staying.forEach((x) => {
      x.batchFee = Math.max(0, toCents(x.batchFee) - outFee) / 100;
      // v38 收尾（F5）：这条 `Math.max(0, …)` **保留**，它是兜底、不是判据——原注释写「这里不再夹负」，
      // 紧邻的代码却仍在夹，两句互相打脸。如实说法：负剩余在**上面那道门**已经被整笔拒绝（拦的是
      // 「用户这次退批的意图」）；这里的夹子只兜「账本里本来就存的负数 / 半截写入的旧数据」——
      // normalizeData 的白名单本来就会在每次刷新时把 batchIncome 再夹一次，不夹反而会造成
      // 「存进去负数、读出来 0」的字节漂移。扣减本身按退出者的**实际回款**做（v36 口径，不动）。
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
  // v24：填数字 = 把这一批的这笔金额**改成这个数**（整批金额是该批次邮费/回款的唯一权威值，
  // 成员明细一律按各单垫付占比重摊，不再叠加任何「自带部分」）；两个框都留空 = 一个字都不动；
  // 填 0 = 删掉这一批的这笔钱。**没有「覆盖 / 追加」的选择**——用户明确要求「我肯定是直接把它
  // 完全更改，这并不需要我去重新选」（v23 的追加语义已删除）。
  // 从批次表头、以及每张批内单卡片上的「改本批邮费」进来时预选该批全部成员（含已回款的），
  // 于是「改错的钱」变成点一下 → 填新值 → 结算。
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
    // v38（报告 B2）：结算会话的快照——勾选、金额预期与分摊权重都建立在**打开这一刻**的账本上；
    // 提交前对表（代次 + 所选成员逐单），对不上就拒绝落库。
    batchSession = {
      generation: ledgerGeneration,
      snaps: new Map(batchItems.map((it) => {
        const cur = data.orders.find((o) => o.id === it.id);
        return [it.id, orderSnap(cur)];
      })),
    };
    $("#batchFee").value = "";
    $("#batchIncome").value = "";
    $("#batchDate").value = todayStr();
    renderBatchList();
    $("#batchModal").classList.add("show");
  }

  // 所勾选的单恰好是某个已存在批次的整批原班人马吗？→ 提交时复用该批次号（v19 的既有规则），
  // 弹窗里也用它决定要不要显示「这一批现在记着多少钱」。prev=null ＝ 这次是新批次。
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

  // 这一批当前的金额 + 这次会怎么处理（v24：**没有覆盖/追加的选择**，规矩就三条）：
  //   填数字＝把这一批改成这个数（按各单垫付占比重摊到成员上）；留空＝不动；填 0＝删掉这笔钱。
  // 只在所勾选单恰好是某个**已有邮费或回款**的整批原班人马时出现（新建批次没有「改」可言）。
  // 「留空＝不动」必须写在明面上：先只摊邮费、回款到了再补一趟是常用的两趟打法。
  function updateBatchNote() {
    const box = $("#batchNote");
    if (!box) return;
    const prev = selectedBatchInfo().prev;
    const show = !!(prev && (prev.feeCents > 0 || prev.incomeCents > 0));
    if (!show) { box.hidden = true; box.innerHTML = ""; return; }
    const bits = [];
    if (prev.feeCents > 0) bits.push(`邮费 <b>${money(prev.feeCents / 100)}</b>`);
    if (prev.incomeCents > 0) bits.push(`回款 <b>${money(prev.incomeCents / 100)}</b>`);
    box.hidden = false;
    box.innerHTML = `<div class="bn-hint">这一批现在记着 ${bits.join(" · ")}。`
      + `填数字＝把这一批<b>改成这个数</b>（按各单垫付占比重摊到成员上）；`
      + `两个框<b>留空＝不动</b>；填 0＝<b>删掉这一批的这笔钱</b>。</div>`;
  }

  function closeBatchModal() {
    $("#batchModal").classList.remove("show");
    batchItems = [];
    batchSession = null;   // v38：会话随弹窗关闭一起作废
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
        if (tags.length > 0) parts.push(`<div class="bg-tags">${tags.join(" · ")}${onCount === idxs.length ? `　再填金额＝把这一批改成那个数` : ""}</div>`);
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
    updateBatchNote();
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
    const selIds = new Set(sel.orders.map((o) => o.id));
    // v38（报告 B10 / D3）：**分摊一律用当前 data.orders 里的成员顺序** —— 与「恢复默认分摊」
    // （resetBatchShares）和分项利润编辑（commitProfitEdit）三处同源。原来这里用的是弹窗排过序的
    // 成员数组，而 splitByWeight 的尾差是**按下标**发的 ⇒ 同一批钱在「结算」与「恢复默认分摊」
    // 两处会把那 1 分发给不同的人（同日三单、整批 ¥3.34 实测：结算 111/111/112、恢复默认 112/111/111）。
    // 只改分摊顺序，**不动弹窗的显示排序**（那是另一码事）。
    const orders = data.orders.filter((o) => selIds.has(o.id));
    if (orders.length === 0) { toast("先勾选要结算的在途单"); return; }

    // v38（报告 B2）：批量结算弹窗同样绑账本代次 + 所选成员的快照。所选单任一在这期间被别的入口
    // 改过（或账本整包换过），这一批的分摊预期就不成立——整笔拒绝并说明，绝不按旧预期写。
    if (batchSession) {
      if (batchSession.generation !== ledgerGeneration) {
        toast("账本已更新，这次结算没保存，请重新打开核对");
        return;
      }
      const moved = orders.filter((o) => batchSession.snaps.get(o.id) !== orderSnap(o));
      if (moved.length > 0) {
        toast("勾选的单里有内容已变，这次结算没保存，请重新打开核对");
        return;
      }
    }

    // 结算按钮不在 form 中，min/step 不会自动拦住提交。
    // 先校验再分摊，避免把负数等非法输入静默当成 0 写回整批。
    for (const [selector, label] of [
      ["#batchFee", "本批邮费"],
      ["#batchIncome", "对方总回款"],
      ["#batchDate", "回款日期"],
    ]) {
      const input = $(selector);
      if (!input.checkValidity()) {
        input.reportValidity();
        toast(`${label}填写有误，请检查后再结算`);
        return;
      }
    }
    // 留空＝这一项一个字不动（保住「先只摊邮费、回款到了再补一趟」的两趟打法）；
    // 填数字＝把这一项**改成这个数**（不是加上去）；填 0＝删掉这一项。
    const feeGiven = String($("#batchFee").value || "").trim() !== "";
    const incomeGiven = String($("#batchIncome").value || "").trim() !== "";
    const feeCents = feeGiven ? Math.max(0, toCents($("#batchFee").value)) : 0;
    const incomeCents = incomeGiven ? Math.max(0, toCents($("#batchIncome").value)) : 0;
    const weights = orders.map((o) => Math.max(0, toCents(o.cost)));
    const prev = sel.prev;
    const batchId = sel.reuseId || uid();
    const batchDate = (prev && prev.date) || $("#batchDate").value || todayStr();

    // ---- v38（报告 B3 / D1 / D2）：先把整笔写入计划算完、校验通过，再动一个字节 ----
    // 原批次被带走的份额必须在改动任何单之前算完（改完再算读到的就是已经写过的值）。
    // 只勾了某一批的一部分人、或几个批混着一起结 → 这些单会进新批次，它们从原批次带走的份额
    // 同样要从原批次**剩余成员**的整批口径里扣掉（v23·D-3 的另一半：重组成批）。
    const deduct = new Map();          // 原批次 id → { fee, income }（单位：分）
    if (!sel.reuseId) {
      const groups = batchGroups();
      new Set(orders.map((o) => o.batchId).filter(Boolean)).forEach((sid) => {
        const g = groups.get(sid);
        if (!g) return;
        const members = data.orders.filter((o) => o.batchId === sid);
        const feeShares = batchShares(members, "batchFeeShare", g.feeCents);
        let fee = 0, income = 0;
        members.forEach((m, i) => {
          if (!selIds.has(m.id)) return;
          fee += feeShares[i];
          // v38：回款按**成员账本里的实际 income** 扣（含 0 与负数），不再用 batchIncomeShare——
          // 那个字段经 shareCents 把负值夹成 0（负回款是可达状态），按它扣会让原批次的整批口径
          // 多留一截、与剩余成员的实际合计当场分叉。也**不再以 income > 0 作入选条件**
          // （拿走一个 0 回款的成员同样要从原批次里记一笔 0 的扣减计划）。
          income += toCents(m.income);
        });
        deduct.set(sid, { fee, income });
      });
      // D1：扣完之后原批次**剩下的整批回款**若为负，现行模型表示不了（batchIncome 经白名单被
      // 夹成 0）——在**任何写入之前**整笔拒绝，原账一分不动并说明原因（不新增字段、不放宽模型）。
      for (const [sid, d] of deduct) {
        const g = groups.get(sid);
        const staying = data.orders.filter((o) => o.batchId === sid && !selIds.has(o.id));
        const remainingIncome = g.incomeCents - d.income;
        if (staying.length > 0 && remainingIncome < 0) {
          toast(`原批剩下的成员回款合计会是 ${money(remainingIncome / 100)}（负数），账本表示不了负的整批回款，本次没拆分`);
          return;
        }
      }
    }
    // D2：新批（或续用原批）的整批口径——填了就是这次填的数；**留空时按被带入成员的实际合计建立**
    // （成员该字段一个字不动，口径得跟它对得上；否则「一组在途单留空直接成批」会当场报出对账告警）。
    // 合计为负 → 现行模型表示不了，在任何写入前拒绝（D1 的另一半）。
    const broughtFee = orders.reduce((a, o) => a + toCents(o.fee), 0);
    const broughtIncome = orders.reduce((a, o) => a + toCents(o.income), 0);
    const batchFeeCents = feeGiven ? feeCents : (prev ? prev.feeCents : broughtFee);
    const batchIncomeCents = incomeGiven ? incomeCents : (prev ? prev.incomeCents : broughtIncome);
    if (batchIncomeCents < 0) {
      toast(`这一批的回款合计是 ${money(batchIncomeCents / 100)}（负数），账本表示不了负的整批回款，本次没结算`);
      return;
    }

    // 邮费／回款：**纯重摊**（v24 定的模型：一起寄的一批只有一笔邮费，整批金额是这一批的
    // 唯一权威值，成员单上的金额只是它的分摊——为了每单利润展示得出来）。
    // 所以填了数字就三件事一起写：成员金额 = 本次摊到的新份额、份额字段 = 新份额、整批口径 = 新总额；
    // 不再叠加任何「这一单入批前自己记过多少」——那样会算出越改越大、填 0 还留残值的一套账
    // （用户实测「8 单各 ¥4、整批只录了 ¥1，填 0 之后总额还是 ≈¥31.8」就是这么来的）。
    // 纯赋值天然幂等：同样的数字连填两遍，结果一模一样。
    // v38：份额**按 id 写回**（不是「算完再按下标赋给另一个顺序的数组」）——顺序只由一份
    // 权威来源（上面的 data.orders 过滤结果）决定，id 映射保证写回的每一项都对得上人。
    if (feeGiven) {
      const feeShares = splitByWeight(feeCents, weights);
      const feeById = new Map(orders.map((o, i) => [o.id, feeShares[i]]));
      orders.forEach((o) => { o.fee = feeById.get(o.id) / 100; o.batchFeeShare = feeById.get(o.id); });
    }

    // 回款同理。总回款 > 0 才把单子置为已回款；填 0 是「删掉这一批的回款」（金额归 0，
    // 状态不因此回退——那一单收没收到钱是另一回事，要改状态去「编辑」里改）。
    if (incomeGiven) {
      const incomeShares = splitByWeight(incomeCents, weights);
      const incById = new Map(orders.map((o, i) => [o.id, incomeShares[i]]));
      orders.forEach((o) => {
        o.income = incById.get(o.id) / 100;
        o.batchIncomeShare = incById.get(o.id);
        if (incomeCents > 0) {
          o.incomeDate = $("#batchDate").value || todayStr();
          o.status = "已回款";
        }
      });
      // v36：整批回款重摊＝用户明确要「按垫付重新分一遍」，这一批的手改锁定随之作废
      // （旧钉住是按上一次分摊的账本值记的，留着只会把刚重摊的钱按旧锁再掰回去）。
      // 只填邮费那趟不算（fee 重摊不改 income，锁的新鲜度由 commitProfitEdit 的对表自己判）。
      profitLocks.delete(batchId);
    }

    // 原批次扣减（照上面算好的计划一次落库）。回款那一项可能为负（被带走的成员自己回款是负的），
    // 那是**加**回留在批里的人的整批口径，与 D1 的拒绝路径配套；两边都是 0 时一个字节都不动
    // （「两框留空只记一下成员与日期」那趟照旧不写任何金额字段）。
    deduct.forEach((d, sid) => {
      if (d.fee === 0 && d.income === 0) return;
      data.orders.forEach((m) => {
        if (m.batchId !== sid || selIds.has(m.id)) return;
        m.batchFee = Math.max(0, toCents(m.batchFee) - d.fee) / 100;
        m.batchIncome = Math.max(0, toCents(m.batchIncome) - d.income) / 100;
      });
    });

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
    // 直接把结果报出来：改的是已有的那一批（prev 存在）就说「已改成」，新建批次说「已结算」。
    // 纯重摊之后成员明细必然等于整批金额，没有「成员上另有…」这种残值要交代了。
    // v38：留空那两趟也不再写 0 —— 整批口径按**被带入成员的实际合计**建立（D2），
    // 所以措辞说「成员金额没动」（成员那一格确实一个字没动，整批口径跟它们对齐）。
    let msg;
    if (!feeGiven && !incomeGiven) msg = "这一批的成员与日期已记下，成员金额没动";
    else if (prev) msg = `已改成本批${amounts.join(" · ")} · ${orders.length} 单`;
    else msg = `已结算 ${orders.length} 单${orders.length > 1 ? `（一起寄 ${batchDate.slice(5)}）` : ""} · ${amounts.join(" · ")}`;
    toast(msg);
  }

  // ---- 报单（v28：寄出后给收货商报「型号 颜色 数量」）----
  // 用户的痛点：寄出一批之后要向收货商报型号/颜色/数量，货多时得一个个手打。四条取舍：
  //  ① **不新增字段、不从 name 里猜着切型号和颜色**。名称里型号和颜色本来就是粘在一起的自由文本
  //     （「狗屁王 4 朱雀黑」与「狗屁王二代金刚黑」两种写法并存），要切就得靠颜色词表 + 正则，
  //     而词表必然误伤「红米 Note 13」里的数字与「白象方便面」这类名字，猜错还是静默的——
  //     收货商按型号+颜色核货，猜错比多出一行严重。整串参与分组，不确定的部分留给人看一眼。
  //  ② 分组键 = 归一化后的 name **全等**（空格全删 + ASCII 小写），key **只进 Map**：
  //     这样 `红米 Note 13 白` 与 `红米Note13白` 能并成一组，而「Note 13」里的 13 不会被切坏。
  //     渲染一律用组内第一单的**原始 name**——绝不把归一化串显示给用户（否则像账本被改坏了）。
  //  ③ 件数唯一来源是 **Σqty**，不是订单条数：批次表头那个 `batchCount`（单数）最顺手，
  //     复用它就会出现「4 单各 2 件」报成 ×4、收货商少收 4 件。每行的 ×N 与面板摘要里的件数
  //     都出自同一个 baodanCompute()，杜绝两处各算一套。
  //  ④ 面板基本是**只读视图 + 内存态**：勾选、手改文案都不写 localStorage、不进同步包，关掉即丢。
  //     **例外只有快递单号那一格（v31）**：**用户自己改了它**（change / 「清空」）才写进这次报的那几单
  //     （见 commitBaodanTracking）。打开面板那一下的自动复制、以及没动过那一格时的「复制报单」，
  //     一个字都不写——预填只是众数，顺手写会串掉少数派单的正确单号。
  //  ⑤ 组内「代表写法」= 最早那条单的原始 name（见 baodanCompute 里的说明），不是「数组里第一单」。
  function skuKey(name) {
    return String(name || "")
      .replace(/[\u3000\u00a0\u2007\u202f]/g, " ")   // 全角/不换行空格先并成普通空格
      .replace(/\s+/g, "")                           // 再删掉所有空白（含换行）
      .toLowerCase();                                // ASCII 大小写：note13 / Note13
  }

  function qtyOf(o) { return Math.max(1, Math.round(numberValue(o.qty)) || 1); }

  // 报单里显示的名字（v29）：换行折成一个空格、首尾空白去掉、全是空白的落成「未命名」。
  // 起因：`name` 是自由文本，一份从别处导入的脏数据里可能带换行或整串空白——那会把「一行一件」
  // 的报单切成半截行（外部验收实测：名字 `冒烟换行\n己` 报出独立一行 `己 ×2`）、或报出 ` ×1` 这种空行。
  // 只做这两步：名字**内部**的空格/全角空格/大小写原样保留（分组键早就把它们抹平了，但显示要是他写的样子）。
  function bdName(name) {
    return String(name == null ? "" : name).replace(/\s*\n\s*/g, " ").trim() || "未命名";
  }

  // 报单文本的形状照用户发给收货商的那种消息来（他给的样例）：
  //   9.21 待结
  //   荣耀 x60pro 8+128 灰 ×1
  //   荣耀 x60 8+128 ×1
  //   荣耀畅玩 50 6+128 紫色 ×2
  // 即：首行「月.日 待结」（月日不补零，抬头用词用户说无所谓，跟样例保持一致），
  // 底下**一行一件、每行行尾都带 ×N**（用户明确要「加上数量」）。
  // v31：抬头下面多一行「快递单号 X」（用户这次的要求：报单里要带日期、**快递单号**和明细）——
  // 值为空时**整行不渲染**（不许出现「快递单号 」这种空占位行，收货商那边看就是一行噪声）。
  // **末尾没有合计行**——收货商自己数，件数交给面板摘要与复制后的提示去交代。
  // 首行是纯文本，用户想改（称呼/单号）直接改文本框。
  function mdShort(dateStr) {
    // 正规入口（日期选择框）给的一定是 YYYY-MM-DD；导入的脏数据里可能是 `2026-1-5` 这种两位不齐的写法，
    // parseDate 会判不合法，这里再用宽松解析兜一道，两条都不成才回落今天（v29 补，原先直接回落今天）
    let d = parseDate(dateStr);
    if (!d) {
      // v33：宽松那一条**也必须过同一套回读校验**——`new Date("2026/02/30")` 一样会静默进位成 3 月 2 日。
      // 做法：先把 1 位/2 位的月日补成规范写法，再交给 parseDate 去验（只有一支校验，不会两处走岔）；
      // 仍不合法就与「压根解析不出来」一样回落今天。
      const loose = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(String(dateStr || ""));
      if (loose) d = parseDate(`${loose[1]}-${pad2(Number(loose[2]))}-${pad2(Number(loose[3]))}`);
    }
    if (!d) d = new Date();
    return `${d.getMonth() + 1}.${d.getDate()}`;
  }

  // v31：单号那一格的**预填值** = 这个范围里最常见的非空单号（同一次寄件通常只有一个单号，
  // 用户填过一次、以后打开面板就自动带着，不用每次重打）。
  // 空的一律不参与统计——否则「最常见」会被一堆空单统治，永远预填不出东西。
  // 返回值里带 list（按出现次数降序、同次数按范围内首次出现的先后）——提示行与开面板那句 toast 也用它，
  // 但**都不再存快照**：每次渲染现算（见 bdTrackingHint 上方说明）。
  function bdTrackingPick(cands) {
    const stat = new Map();
    cands.forEach((o, i) => {
      const v = cleanTracking(o.tracking);
      if (!v) return;
      const rec = stat.get(v) || { value: v, count: 0, first: i };
      rec.count += 1;
      stat.set(v, rec);
    });
    const list = Array.from(stat.values()).sort((a, b) => b.count - a.count || a.first - b.first);
    return { value: list.length ? list[0].value : "", list };
  }

  // v31：单号那一格下面那行小字——**每次渲染现算**（不存快照）。
  // 快照版踩过一个真缺陷（独立验收在副本里用真实鼠标/键盘打出来的）：把那一格改成统一值、写库成功之后，
  // hint 还一字不变地说着「有 2 个不同的单号…改这一格才会统一」——它已经统一完了，那句提示当场成了假话。
  // 现算就在写库/改勾选之后自己消失。
  // 而且只按**本次勾选的单**算（不是整个范围）：报出去的文本＝勾选的那些单，提示要说的是这个集合的事。
  // 四种情形，最常用的那条路径一个字都不吵：
  //   ① 勾选的单里有 ≥2 个不同非空单号 → 列出来（最多 3 个、多的写「等共 N 个」，与「同物异写」那条同一写法），
  //      并说清「文本里只带上面那一格的值」——预填只是众数，少数派那几单的号并不在文本里；
  //   ② 勾选的单里恰好一种非空单号、而那一格非空且**与它不同** → 说清「这一格填的号不在这次报的单里」：
  //      用户取消了少数派勾选之后就是这种局面（文本里带着的那个号不属于任何被报出去的单，收货商按它查不到件）；
  //   ③ 勾选的单一个号都没有（最常见的新增场景：新寄的货还没抄单号）→ **不给任何提示**，别在这里报警；
  //   ④ 其余（两边一致、或那一格为空）→ 无提示。
  function bdTrackingHint(orders, fieldValue) {
    const list = bdTrackingPick(orders).list;
    const values = list.map((r) => r.value);
    if (values.length > 1) {
      const shown = values.slice(0, 3).join(" / ") + (values.length > 3 ? ` 等共 ${values.length} 个` : "");
      return `本次报的单里有 ${values.length} 个不同单号：${shown}——文本里只带上面那一格的值；要统一就改这一格。`;
    }
    if (values.length === 1 && fieldValue && fieldValue !== values[0]) {
      return `上面这一格填的单号不在这次报的单里（它们记的是 ${values[0]}）；要改它们就改这一格。`;
    }
    return "";
  }

  // 返回 { orders, groups, qty, kinds, header, tracking, text }——件数/种数/文本都从这一处出
  function baodanCompute() {
    const orders = baodanCandidates.filter((o) => baodanSel.has(o.id));
    const map = new Map();
    const candKey = (o) => String(o.createdAt || "~") + "\u0000" + String(o.id || "");
    orders.forEach((o) => {
      const key = skuKey(o.name) || ("\u0000" + o.id);   // 名称全空白的单各算一组，不互相并
      let g = map.get(key);
      if (!g) { g = { name: "", nameKey: null, qty: 0, count: 0, raw: new Set() }; map.set(key, g); }
      // 组内「代表写法」= **最早那条单的原始 name**。不能取「数组里第一单」：候选顺序取决于
      // 排序、筛选与入口（批次表头 / 工具条），同一份报单可能因此显示成不同的写法。createdAt 相同（同一毫秒 / 导入的老数据）时用 id 兜底 —— 老数据没有 createdAt，
      // 补 "~"（比十六进制字符都大）让它排在最后，仍然唯一确定。归一化串永不显示。
      const k = candKey(o);
      if (g.nameKey === null || k < g.nameKey) { g.name = bdName(o.name); g.nameKey = k; }
      g.qty += qtyOf(o);
      g.count += 1;
      g.raw.add(bdName(o.name));
    });
    // 件数多的排前面（收货商按行核货，大头在最上面）；同件数按名称排，顺序稳定可复现
    const groups = Array.from(map.values())
      .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name, "zh-Hans-CN"));
    const qty = groups.reduce((a, g) => a + g.qty, 0);
    // 抬头日期：成批报用**批次自己的日期**（就是一起寄出的那天，和收货商账单上「7.22 待结」同义）；
    // 从账本工具条进来（按当前筛选报）没有批次日期，取今天
    const headDate = (baodanScope && baodanScope.headDate) || todayStr();
    const header = `${mdShort(headDate)} 待结`;
    // v31：单号取自**面板那一格**（不是账本里的值）——这一格是「这次报出去的单号」，改动它＝改文本第 2 行；
    // 账本里的单号只在点「复制报单」且两者不同时才被写回（见 baodanApplyTracking）。
    const tracking = cleanTracking($("#baodanTracking") ? $("#baodanTracking").value : "");
    const head = tracking ? `${header}\n快递单号 ${tracking}` : header;
    const text = groups.length === 0 ? ""
      : head + "\n" + groups.map((g) => `${g.name} ×${g.qty}`).join("\n");
    return { orders, groups, qty, kinds: groups.length, header, tracking, text };
  }

  // v31：把面板那一格的单号写进「这次报的那几单」（只写 tracking 一个字段，然后走既有的 saveData：
  // persist + render + 排程云同步）。返回是否真的写了。
  // 判据是「与账本里存的不同」——**全部目标单都已经是这个值时什么都不做**：于是同一份报单连点两次
  // 复制，第二次一个字节都不写（updatedAt 不被平白改掉、不多发一次同步），这就是「值没变不写」那条断言
  // 钉的东西。清空那一格＝把这几单的单号去掉（value 为空也照写，别当成「没填就不动」）。
  // **调用方必须先确认「用户真的动过那一格」**（baodanTrackingTouched）——本函数只管值比不比得上。
  // v38（报告 B7）：报单会话是否仍然对应当前账本 —— 代次没换 + 候选单逐 id 仍与账本现值一致。
  // 「按 id 重新 find」**不够**：那只是找到新对象，写进去的仍是旧面板的意图（把新账本覆盖掉）。
  // 整包换数据（云端拉取 / 导入）后候选单对象与账本脱钩，这里必须判死，随后禁用写入与复制。
  function baodanSessionAlive() {
    if (!baodanSession) return false;
    if (baodanSession.generation !== ledgerGeneration) return false;
    for (const [id, snap] of baodanSession.snaps) {
      const cur = data.orders.find((o) => o.id === id);
      if (!cur || orderSnap(cur) !== snap) return false;
    }
    return true;
  }

  function baodanApplyTracking(value) {
    const targets = baodanCompute().orders;
    if (targets.length === 0) return false;
    // v38（报告 B7）：按 id 从**当前账本**取，并与「打开面板那一刻的快照」逐单对表；任一单对不上
    // （面板里的意图已经不是这一份账了）就整笔不写。原注释「候选单与账本里是同一批对象、快照不会
    // 脱钩」不成立——云端换包之后候选单指向的就是被换掉的那份旧账。
    const live = [];
    for (const t of targets) {
      const cur = data.orders.find((o) => o.id === t.id);
      if (!cur) return false;
      if (baodanSession && baodanSession.snaps.get(cur.id) !== orderSnap(cur)) return false;
      live.push(cur);
    }
    if (!live.some((o) => cleanTracking(o.tracking) !== value)) return false;
    live.forEach((o) => {
      o.tracking = value;
      // 刚写进去的值就是新的对表基准（否则这次写入自己会让会话立刻「失效」）
      if (baodanSession) baodanSession.snaps.set(o.id, orderSnap(o));
    });
    saveData();
    return true;
  }

  // v31：**用户真的改过那一格之后的唯一提交口**（change 事件与「清空」按钮都走它）。
  // 为什么写库挂在这里而不是「点复制」上：面板一打开就自动复制过一次，那一刻那一格还是预填的众数，
  // 而少数派单（同一批里另一个包裹的号）与它必然不同——只比字符串的话，用户「什么都没改、只想再复制一遍」
  // 就会把那些单的正确单号统一成众数，账本被静默改写且无处可撤。所以：
  //   · 写库的**必要条件**是「用户动过这一格」（touched，见它的声明）；
  //   · 复制那一下只在「动过且值仍然不同」时兜一道底（勾选集合在动过之后又变了的那种情形）。
  // 顺序是四件事：收敛这一格的显示 → 写账本（值没变就不写）→ 重算文本 → **再复制一次剪贴板** → toast。
  // 重复制不是锦上添花：不重复制的话，剪贴板里还是**打开面板那一刻**的旧文本（没有单号或旧单号），
  // 而 toast 还在教用户「直接去微信粘贴」——他会粘出一份与面板所见不一致的报单。
  async function commitBaodanTracking() {
    baodanTrackingTouched = true;
    const box = $("#baodanTracking");
    box.value = cleanTracking(box.value);       // 界面也收敛：超 40 字的当场截断，三处（格/文本/账本）同一个值
    // v38（报告 B7）：账本在面板开着的时候被换过包 ⇒ 这一次写入与随后的复制都不做，也**不许**
    // 再报「单号已改」——那是拿旧面板的意图冒充已经写进当前账本（实测：文本 USER / 账本 REMOTE /
    // 提示「单号已改，但复制失败」）。
    if (!baodanSessionAlive()) { toast("账本已更新，请重新打开报单核对"); return; }
    const written = baodanApplyTracking(box.value);
    renderBaodan();                             // 文本第 2 行跟着这一格走
    // 范围里一单都没有（空范围面板）：这一格改了也没账本可写、没有文本可复制，如实说一句就走
    // （不拦的话会复制一个空串、还报「已重新复制」——那是句假话）
    if (!$("#baodanText").value.trim()) { toast("这个范围里没有可报的单"); return; }
    const ok = await writeBaodanClipboard($("#baodanText").value, $("#baodanText"));
    // 异步复制期间账本又变过（云端换包）：反馈也不许按旧会话说话（不许宣称成功、也不许宣称已改）
    if (!baodanSessionAlive()) { toast("账本已更新，请重新打开报单核对"); return; }
    if (!ok) { toast("单号已改，但复制失败：长按上面的文本框手动全选"); return; }
    toast(written
      ? `单号已记到 ${baodanCompute().orders.length} 单 · 已重新复制`
      : "单号没变，账本没动 · 已重新复制");
  }

  // 写剪贴板：非安全上下文/旧 WebView/无权限时会抛错，回退 execCommand，两条路都给可见反馈。
  // 返回 true/false 让调用方决定提示文案（面板与「点一下报单」两处共用这一支）
  async function writeClipboard(text, box) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      // 兜底路径（http / 旧 WebView / 权限被拒）：选中文本 + execCommand。
      // **v28 修过的真缺陷**：这里原先只 `box.select()` 就无条件 `return true`，漏了 execCommand ——
      // 于是复制没发生、却报「已复制报单」，用户到微信粘出来的是上一批货的内容，静默报错单。
      // 现在两条路都拿 execCommand 的返回值说话，false 就如实报失败（面板里的文本框仍是手动兜底）。
      let tmp = null;
      try {
        let target = box;
        if (!target) {                                     // 没有现成文本框时临时造一个（同一个用户手势里）
          tmp = document.createElement("textarea");
          tmp.value = text; tmp.setAttribute("readonly", "");
          tmp.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
          document.body.appendChild(tmp);
          target = tmp;
        }
        target.select();
        return !!document.execCommand("copy");
      } catch { return false; }
      finally { if (tmp) tmp.remove(); }
    }
  }

  // 正常复制成功时保留原说明；失败提示留在面板里，不随 toast 消失。
  async function writeBaodanClipboard(text, box) {
    const hint = $("#baodanModal .batch-sub");
    hint.textContent = "正在复制报单，请稍候。";
    const ok = await writeClipboard(text, box);
    hint.textContent = ok
      ? "点「报单」时已经复制好了，直接去微信粘贴；要改动就先改下面的内容再点一次复制"
      : "复制失败：请长按下面的文本框手动全选复制，核对后再去微信粘贴。";
    return ok;
  }

  // scope：{ type:"batch", batchId } 从批次表头进（报这一次寄出的货）；
  //        省略 / { type:"filter" } 从账本工具条进（报账本当前筛选下看得见的单）
  // v28 关键交互：**点一下就进剪贴板**——用户的原话是「点一下报单，它就自动整理好并粘贴到我的
  // 剪贴板里，然后我直接在微信发给对方就好了」。所以这里开面板的同时就把文本复制好，
  // 面板是「刚才复制了什么」的凭据 + 需要微调时的入口（改动后按「复制报单」再复制一次）。
  async function openBaodan(scope) {
    const fromBatch = !!(scope && scope.type === "batch");
    baodanScope = { type: fromBatch ? "batch" : "filter", batchId: fromBatch ? scope.batchId : "" };
    baodanCandidates = fromBatch
      ? data.orders.filter((o) => o.batchId === baodanScope.batchId)
      : filteredOrders();
    // 默认全选：常规「寄出一批 → 报单 → 去微信粘贴」。要拆两次报或剔掉赠品就在清单里取消勾选
    baodanSel = new Set(baodanCandidates.map((o) => o.id));
    // v38（报告 B7）：报单会话绑账本代次 + 候选单快照。云端换包之后候选单与账本脱钩，继续用旧面板
    // 的意图写回就是「文本改了、账本没改、提示还说已改」——代次变了就禁用写入与复制，提示重新生成。
    baodanSession = {
      generation: ledgerGeneration,
      snaps: new Map(baodanCandidates.map((o) => [o.id, orderSnap(o)])),
    };
    const head = baodanCandidates[0];
    if (head) baodanScope.headDate = fromBatch ? (head.batchDate || head.date) : "";
    baodanScope.title = fromBatch
      ? `一起寄出 · ${head ? (head.batchDate || head.date) : ""} · ${baodanCandidates.length} 单`
      : `账本当前筛选「${currentFilter}」· ${baodanCandidates.length} 单`;
    // v31：单号那一格预填**范围里最常见的非空单号**。这里只取预填值，**不存快照**——
    // 提示行按「本次勾选的单」现算（见 bdTrackingHint），这样写库统一之后它自己就消失了。
    baodanTrackingTouched = false;      // 新开一次面板＝这一格还没被用户动过（写账本的必要条件）
    const tkBox = $("#baodanTracking");
    if (tkBox) tkBox.value = bdTrackingPick(baodanCandidates).value;
    const { text } = renderBaodan();
    $("#baodanModal").classList.add("show");
    // 范围里没有单：面板会写「这个范围里没有可报的单」，但也得给一句 toast —— 点完什么都没发生很像坏了
    if (!text) {
      $("#baodanModal .batch-sub").textContent = "这个范围里没有可报的单，未复制任何内容。";
      toast("这个范围里没有可报的单");
      return;
    }
    const ok = await writeBaodanClipboard(text, $("#baodanText"));
    // v38 收尾（F8）：复制是 await —— 这期间用户可能改了勾选（勾选 handler 会重绘面板、重写
    // #baodanText，而兜底那条 execCommand 路复制的正是**盒子里当时的内容**），账本也可能整包换过。
    // 所以件数/种数必须在 await **之后**现取一次：旧代码用的是复制之前解构出来的 qty/kinds，
    // 慢复制 + 中途改勾选时会报一个与面板/剪贴板对不上的件数。
    // 顺带核一次会话（只读）：账本换过包就只说「重新打开核对」，绝不宣称复制成功。
    if (!baodanSessionAlive()) { toast("账本已更新，请重新打开报单核对"); return; }
    const after = renderBaodan();
    // v31：本次报的单里单号不止一种时，这一下自动复制出去的文本用的是**预填的那个号**（众数）——少数派那几单
    // 的号并不在文本里。这一下**不写账本**（见 commitBaodanTracking 的说明），但必须当场说清「单号不止一个」，
    // 否则用户点完直接切微信粘贴，收货商拿到的是别的包裹的号（v28 那类「静默报错单」的老毛病）。
    const tkKinds = bdTrackingPick(after.orders).list.length;
    toast(ok
      ? (tkKinds > 1
        ? `已复制报单 · ${after.qty} 件 / ${after.kinds} 种 · 单号有 ${tkKinds} 种，先核对面板里的提示再报`
        : `已复制报单 · ${after.qty} 件 / ${after.kinds} 种 · 直接去微信粘贴`)
      : "复制失败：长按面板里的文本框手动全选");
  }

  function closeBaodan() {
    $("#baodanModal").classList.remove("show");
    baodanScope = null;
    baodanCandidates = [];
    baodanSel = new Set();
    baodanTrackingTouched = false;
    baodanSession = null;   // v38：报单会话随面板关闭一起作废
  }

  function renderBaodan() {
    const res = baodanCompute();
    const { orders, groups, qty, kinds, text } = res;
    $("#baodanScopeLabel").textContent = baodanScope ? baodanScope.title : "";
    $("#baodanPickInfo").textContent = `已选 ${orders.length}/${baodanCandidates.length} 单`;
    $("#baodanAll").textContent = baodanCandidates.length > 0 && orders.length === baodanCandidates.length ? "全不选" : "全选";
    $("#baodanList").innerHTML = baodanCandidates.length === 0
      ? `<div class="bd-empty">这个范围里没有可报的单</div>`
      : baodanCandidates.map((o) => `<label class="batch-item">
          <input type="checkbox" data-bd="${escapeHtml(o.id)}"${baodanSel.has(o.id) ? " checked" : ""}>
          <span class="bi-name">${escapeHtml(bdName(o.name))}</span>
          <span class="bi-cost">${escapeHtml(String(o.date || "").slice(5))} · ×${qtyOf(o)}</span>
        </label>`).join("");
    // 同物异写被并成一组时，把并了哪些原始名写出来——看得见机器并了什么，才敢拿它去报货
    const merged = groups.filter((g) => g.raw.size > 1);
    $("#baodanMerge").innerHTML = merged.length === 0 ? "" : `<div class="bd-merge">已把同物异写并成一组：${
      merged.slice(0, 3).map((g) => escapeHtml(Array.from(g.raw).join(" / "))).join("；")
    }${merged.length > 3 ? `；等共 ${merged.length} 组` : ""}</div>`;
    $("#baodanSummary").innerHTML = orders.length === 0
      ? "还没勾选订单"
      : `已选 ${orders.length} 单 · 共 <b>${qty}</b> 件 / ${kinds} 种`;
    // v31：那一格下面的提示行——按**本次勾选的单 + 这一格现在的值**现算（见 bdTrackingHint）。
    // 别再退回成「开面板那一刻的快照」：写库统一之后它不会自己消失，会一直说着已经失效的话。
    $("#baodanTrackingHint").textContent = bdTrackingHint(orders, res.tracking);
    $("#baodanText").value = text;
    $("#baodanText").placeholder = baodanCandidates.length === 0 ? "这个范围里没有可报的单" : "勾选订单后这里会出现报单内容";
    return res;
  }

  // 复制的是框里**现在的文字**（用户手改过的也算）。
  // v29：件数/种数是从**勾选**重算出来的，手改过之后它已经和框里的内容脱钩了——那时不报数字，
  // 免得给一句「已复制 3 件」的假凭据（外部验收指出：删掉一行再复制，提示还是旧的件数）。
  async function copyBaodan() {
    const box = $("#baodanText");
    const res = baodanCompute();
    if (!box.value.trim()) {
      // 两种「空」分开说：一单没勾 vs 勾了但用户把文本框清空了（后者叫他先填内容，别再让他去查勾选）
      toast(res.orders.length === 0 ? "先勾选要报的单" : "文本框是空的，先写上要报的内容");
      return;
    }
    const edited = box.value !== res.text;
    // v38（报告 B7）：会话失效时既不写也不复制，明确让用户重新生成（不许返回「没变化」冒充成功）
    if (!baodanSessionAlive()) { toast("账本已更新，请重新打开报单核对"); return; }
    const ok = await writeBaodanClipboard(box.value, box);
    if (!baodanSessionAlive()) { toast("账本已更新，请重新打开报单核对"); return; }
    if (!ok) { toast("复制失败：长按上面的文本框手动全选"); return; }
    // v31：复制这一刻**不再无条件写库**，只在「用户真的动过那一格（touched）且值仍与账本里存的不同」时兜一道底。
    // touched 是必要条件：面板一打开就自动复制过一次，那一刻那一格是预填的**众数**，少数派单与它必然不同——
    // 只比字符串的话，用户「什么都没改、只想再复制一遍」就会把那几单的正确单号统一成众数（静默串单、无处可撤）。
    // 正常路径下这一句其实没事可做：用户改完那一格时 change 已经把账本写了（commitBaodanTracking）；
    // 它管的是「动过之后**勾选集合又变了**」——新勾进来的单可能不是这个号，这一下把它补上。
    if (baodanTrackingTouched) baodanApplyTracking(res.tracking);
    toast(edited ? "已复制 · 你改过的那份" : `已复制报单 · ${res.qty} 件 / ${res.kinds} 种 · 直接去微信粘贴`);
  }

  // ---- 云同步（改动防抖推送，启动拉取）----
  let syncTimer = null, syncPending = false, syncInFlight = false;
  let syncEpoch = 0;   // 导入同步码/重置身份时换代：旧身份数据的晚到同步直接作废
  // v27：**只有**「导入同步码」那条路会把它置 true——那条路自己已经按 id 把本机独有的单并回去了
  // （applySyncBtn 里那段 localOnly 合并，且前面已经问过用户「首次同步以最新的一份数据为准」），
  // 所以它触发的这次拉取不再弹「并入还是放弃」的确认框（两个确认框会互相矛盾）。
  let suppressPullMerge = false;

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
    // v38（报告 B1）：拉取前先取身份代次 + 拉取序号，await 回来后两者都没变才算这次结果还有效。
    // 推送路径本来就有代次检查（见 syncToCloud），拉取这一侧原来一个都没有——于是「启动时云端
    // 还没返回 → 用户重置成新账本 → 旧读取才返回」会把旧账原样写进新身份，并报「已从云端取回最新账本」。
    const epoch = syncEpoch;
    const seq = ++pullSeq;
    const stale = () => epoch !== syncEpoch || seq !== pullSeq;
    try {
      const remote = await window.luhuoSync.loadRecord();
      // 旧身份 / 已被更新的一次拉取取代：结果与错误一律丢弃，账本、meta、身份与当前 UI 都不许被它改动
      if (stale()) return;
      if (!remote || !remote.data) {
        if (data.orders.length > 0) syncToCloud();
        window.luhuoSync.setStatus("online", "云端暂无数据");
        return;
      }
      const remoteAt = remote.updatedAt || "";
      if (!meta.updatedAt || remoteAt > meta.updatedAt) {
        // v27：远端更新时**先看一眼会不会丢东西**再整体覆盖——本机存在「云端没有的订单」（按 id 比对）
        // 就弹一次确认，让用户选「并入（默认）还是放弃并采用云端版本」。
        // 场景：手机信号差、几单没推上去，期间电脑端改完同步成功 → 手机下次打开，那几单会被静默抹掉。
        // 不做时间戳/版本比较（那套在弱网下更容易出错）：只比 id 集合。
        // 正常情况下本机的单云端都有（localOnly 为空），启动时一次都不会弹；
        // 「另一台真删了单」也不会自动复活——用户在那里选「取消（放弃）」即可。
        const incoming = normalizeData(remote.data);
        const incomingIds = new Set(incoming.orders.map((o) => o.id));
        const localOnly = data.orders.filter((o) => !incomingIds.has(o.id));
        let merged = 0, declined = 0;
        if (localOnly.length > 0 && !suppressPullMerge) {
          const names = localOnly.slice(0, 3).map((o) => o.name || "未命名").join("、");
          const keep = confirm(`云端有更新的账本，本机还有 ${localOnly.length} 单是云端没有的：\n`
            + `${names}${localOnly.length > 3 ? "…" : ""}\n\n`
            + "点「确定」＝把它们并进账本（推荐）；点「取消」＝放弃这几单，改用云端版本。");
          if (keep) { incoming.orders = incoming.orders.concat(localOnly); merged = localOnly.length; }
          else declined = localOnly.length;
        }
        data = incoming;
        // v38：整包换掉了账本 —— 代次 +1、手改锁与状态提示首判记号（含它的详情行）一起作废
        // （报告 B9：原来只清 profitLocks，于是首判额度被提前烧掉、真正需要时不再响；
        //  **失败的读取不走这里**，额度不会被白复位）。
        invalidateForNewLedger();
        meta.updatedAt = remoteAt;
        persist();
        render();
        // 并入后**不**立刻把整本推上去：下次启动那次拉取的 else 分支会自然把它推上去（干净、少一次写）
        if (merged > 0) toast(`已并入本机 ${merged} 单`);
        else if (declined > 0) toast(`已采用云端版本（本机 ${declined} 单未并入）`);
        else toast("已从云端取回最新账本");
      } else {
        syncToCloud();
      }
      // v38 收尾（F6）：防御性；正常路径**不可达**——这一段与上面那次 `stale()` 之间没有 await
      //（中间只有 persist/render/toast 与一次不 await 的 syncToCloud），epoch/seq 不可能在中间变。
      // 留着是给将来在中间插 await 的人兜底，别再把它当成一条**当前**承担了保护作用的判据。
      if (stale()) return;
      meta.lastSyncError = "";
      renderSyncBadge();
    } catch (error) {
      if (stale()) return;   // 旧身份的错误不许覆盖当前身份的状态（它已经不指向这本账了）
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
        // v38：导入也是整本覆盖 —— 代次 +1、手改锁与状态提示首判记号（含详情行）一起作废（报告 B9）。
        invalidateForNewLedger();
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
      // v32：折叠开关（触发区只有表头第一行那个 button，它里面没有嵌套按钮）。
      // 注意判断顺序：落在别的按钮上时 closest 先命中的是那个按钮，下面这些分支各走各的，
      // 折叠只在真的点到 .bh-top 时发生——所以点「改本批邮费」不会顺手收起这一批。
      if (btn.dataset.act === "btoggle") { toggleBatchBlock(btn); return; }
      const { act, id } = btn.dataset;
      if (act === "pay") openPayForm(id);
      else if (act === "dup") duplicateOrder(id);
      else if (act === "edit") openForm(data.orders.find((x) => x.id === id));
      else if (act === "unbatch") leaveBatch(id);
      // 批次表头上的「改本批邮费」：直接开批量结算并预选这一批的全部成员（含已回款的）
      else if (act === "batchfee") openBatchModal(btn.dataset.batch || "");
      // v28：批次表头上的「报单」——范围就是这一批的全部成员（不看在不在途：报单发生在寄出后）
      else if (act === "baodan") openBaodan({ type: "batch", batchId: btn.dataset.batch || "" });
      // v35：分项利润行内编辑 + 恢复默认分摊（都只动这一批的回款分摊，整批总额不变）
      else if (act === "pedit") startProfitEdit(btn);
      else if (act === "breset") resetBatchShares(btn.dataset.batch || "");
      else if (act === "del") deleteOrder(id);
    });

    // v35：行内利润输入框 —— change（blur/回车）＝提交；Enter 只负责触发 change（blur）；
    // Escape＝放弃本次输入、还原显示（不写库）。输入框由 startProfitEdit 动态插进利润块，
    // 提交/放弃都由 rerenderBatchBlock 把它换回按钮，这里不需要自己收拾 DOM。
    $("#orderList").addEventListener("change", (ev) => {
      const inp = ev.target.closest("input.profit-input");
      if (inp) commitProfitEdit(inp);
    });
    $("#orderList").addEventListener("keydown", (ev) => {
      const inp = ev.target.closest("input.profit-input");
      if (!inp) return;
      if (ev.key === "Enter") { ev.preventDefault(); inp.blur(); }
      else if (ev.key === "Escape") { ev.preventDefault(); rerenderBatchBlock((data.orders.find((x) => x.id === inp.dataset.id) || {}).batchId || ""); }
    });

    $("#orderForm").addEventListener("submit", submitForm);
    $("#formCancel").addEventListener("click", closeForm);
    // v25：记单表单顶部的类型切换（货单 / 收入）。切换只动显隐与默认值，不写任何数据。
    $("#formKind").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-kind]");
      if (btn) setFormKind(btn.dataset.kind);
    });
    // 用户自己动过这两格之后，切类型不再覆盖它们（"切回来还在"@ 名称/渠道）
    $("#orderForm").goods.addEventListener("input", () => { nameAuto = false; });
    // v33：渠道那一格搬家后仍要实时反映到「更多」的摘要上；状态下拉同理（摘要里那句状态）。
    $("#orderForm").channel.addEventListener("change", () => {
      channelTouched = true;
      updateFormMoreSummary();
    });
    $("#orderForm").status.addEventListener("change", updateFormMoreSummary);

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

    // v24：表单里的两个「清空」小按钮（邮费 / 回款金额），两个表单共用一个处理函数
    $("#orderForm").addEventListener("click", clearField);
    $("#payForm").addEventListener("click", clearField);
    // v31：「快递单号」那一格（记单表单在 #orderForm 里，报单面板那一格在 #baodanModal 里）
    $("#baodanModal").addEventListener("click", clearField);

    // 批量结算（注意别把 click 事件本身当参数传进去：openBatchModal 的第一个参数是「预选哪一批」）
    $("#batchBtn").addEventListener("click", () => openBatchModal());

    // v28：报单面板。工具条入口报的是**账本当前筛选**下的单（所见即所报），批次表头入口报那一批
    $("#baodanBtn").addEventListener("click", () => openBaodan({ type: "filter" }));
    $("#baodanClose").addEventListener("click", closeBaodan);
    $("#baodanCopy").addEventListener("click", copyBaodan);
    $("#baodanAll").addEventListener("click", () => {
      const all = baodanCandidates.length > 0 && baodanSel.size === baodanCandidates.length;
      baodanSel = all ? new Set() : new Set(baodanCandidates.map((o) => o.id));
      renderBaodan();
    });
    $("#baodanList").addEventListener("change", (ev) => {
      const cb = ev.target.closest("input[data-bd]");
      if (!cb) return;
      if (cb.checked) baodanSel.add(cb.dataset.bd); else baodanSel.delete(cb.dataset.bd);
      renderBaodan();        // 勾选一变：件数/种数/报单文本一起重算
    });
    // v31：单号那一格分两个时机：
    //   input  = 每敲一下：只重算文本第 2 行（看得见就行，不写账本——写账本要等用户离开这一格）
    //   change = 用户真的改完了（blur / 回车）：写账本（若值变了）→ 重算 → **重新复制剪贴板** → toast，
    //            这一套在 commitBaodanTracking 里。为什么必须是 change 而不是 input：打字途中的半截单号
    //            会一次次写进账本、还每次重算文本；而复制挂在 change 上，剪贴板才不会停在打开面板那一刻的旧文本
    $("#baodanTracking").addEventListener("input", () => renderBaodan());
    $("#baodanTracking").addEventListener("change", () => commitBaodanTracking());
    $("#batchCancel").addEventListener("click", closeBatchModal);
    $("#batchSubmit").addEventListener("click", submitBatch);
    // v24：弹窗里那一行只是说明（填数字＝改成这个数 / 留空＝不动 / 填 0＝删掉），没有可点的选择
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
      const ok = await writeClipboard(box.value, box);
      toast(ok ? "同步码已复制" : "复制失败，请手动全选复制");
    });
    $("#applySyncBtn").addEventListener("click", async () => {
      const code = $("#applySyncInput").value.trim();
      if (!code) { toast("先粘贴另一台设备的同步码"); return; }
      if (!confirm("导入同步码后，本机将与对方共用同一本账。\n首次同步以最新的一份数据为准，继续？")) return;
      try {
        syncEpoch += 1;                       // 作废旧身份在途的同步
        invalidateForNewLedger();             // v38：换身份＝账本代次也换代（旧编辑会话/报单会话一并失效）
        syncPending = false; clearTimeout(syncTimer);
        const epoch = syncEpoch;              // v38：这一趟配对自己的代次（下面拉取期间可能又被换过）
        const localOnly = data.orders.slice(); // 本机订单先留底，导入后按 id 并回，防覆盖丢失
        window.luhuoSync.applySyncCode(code);
        meta.updatedAt = null;
        meta.lastSyncedAt = null;
        meta.lastSyncError = "";
        persist();
        // v27：这条路的合并语义由下面那段 localOnly 负责（而且上面已经问过用户了），
        // 所以这次拉取不弹「并入还是放弃」（suppressPullMerge，见它的声明）
        suppressPullMerge = true;
        try { await pullFromCloud(); } finally { suppressPullMerge = false; }
        // v38（报告 B1）：拉取期间身份又被换代（用户又按了一次配对、或重置了身份）⇒ 这次配对的
        // 收尾（把本机留底的旧单并回、保存、报「已配对」）已经没有意义，原样丢掉——
        // 原来这里是无条件继续，等于把旧身份的单并进新账本。
        if (epoch !== syncEpoch) return;
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
      invalidateForNewLedger();   // v38：重置＝换代（代次 +1、手改锁与状态提示首判记号一并作废）
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
