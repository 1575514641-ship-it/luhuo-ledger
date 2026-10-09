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
  // v41：账本版本 1 → 2（新增可空字段 shipDate）。读入 1 与 2 都接受；写出一律 2。
  // 升版本号的用意是给**没刷新的旧页面（v40）装护栏**：v40 的 ledgerProblem 只认 version 1，
  // 读到 2 会在 readCloudRecord 里返回 failed → 暂停上传——旧页面不会把丢了 shipDate 的账本覆盖回云端。
  // 注意：本机完整快照外壳（SNAPSHOT_KEY 里的 { version: 1, owner, ... }）是另一套东西，**不要跟着改**。
  const LEDGER_VERSION = 2;
  const LEDGER_VERSIONS = [1, 2];
  const DATA_KEY = "luhuo-ledger-data-v1";
  const META_KEY = "luhuo-ledger-meta-v1";
  const SNAPSHOT_KEY = "luhuo-ledger-snapshot-v1";
  const SYNC_BASE_KEY = "luhuo-ledger-sync-base-v1";
  const RECOVERY_KEY = "luhuo-ledger-recovery-v1";
  const IDENTITY_KEY = "luhuo-sync-identity-v1";

  // v21 起「自留」退出模型：能创建的状态只有在途/已回款（货自己留着用就不算生意，用户宁可删单）。
  // 但旧账本里已经存在的「自留」（含更老的「翻车自留」）**原样保留、绝不静默改写**：
  // 它仍是合法的遗留值，照旧按「回款−垫付−邮费」计入已结算净盈亏，只是不再能新建。
  const STATUSES = ["在途", "已回款"];
  const LEGACY_STATUSES = ["自留"];              // 只读的遗留状态：认得、能显示，不能创建
  const SETTLED = ["已回款", "自留"];             // 「已结算」= 不在途：含旧自留（那笔钱已经落地）
  // v41：账本页按阶段分四个页签（待寄 / 待回款 / 已回款 / 全部）；「全部」也要能记住。
  // 「待寄 / 待回款」是 status=在途 的两个**派生**子集（见 orderStage），不是新状态。
  const FILTERS = ["待寄", "待回款", "已回款", "全部"];
  // 旧版记住的筛选值 → 新页签（只在读 meta.filter 时换一次，不写回账本）
  const LEGACY_FILTER = { "在途": "待寄" };
  const CHANNELS = ["收货商", "闲鱼", "转转", "朋友", "自用", "开发票"];
  const STATUS_CLASS = { "在途": "st-out", "已回款": "st-done", "自留": "st-loss" };
  // v25：「收入」表单模式的默认值（只在新建表单、且用户没碰过那格时才补）
  const INCOME_NAME = "开发票";
  const INCOME_CHANNEL = "开发票";

  // ---- 状态 ----
  let data = { version: LEDGER_VERSION, orders: [] };
  let meta = { updatedAt: null, lastSyncedAt: null, lastSyncError: "", filter: "在途" };
  let storageBaseline = null;
  let localIssue = "";
  let syncBlocked = "";
  let syncBase = null;
  let activeWrite = null;
  let durableData = null;
  let durableMeta = null;
  let pairingEpoch = null;
  let ledgerViewIndex = null;
  let storageLockHeld = false;
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
  let payBaseline = null;    // 04 期：打开回款弹窗时的控件基线（判"有没有改过"）
  let batchItems = [];        // 批量结算弹窗的勾选状态：{ id, name, cost, checked }
  let batchBaseline = null;   // 04 期：打开批量结算弹窗时的控件基线（含勾选态）
  // v28 报单（寄出后给收货商报「型号 颜色 数量」）：范围在打开面板那一刻定死，
  // 勾选与手改文案都只活在内存里——不落库、不进同步包、关掉即丢（见 openBaodan 上方说明）
  let baodanScope = null;     // { type:"batch"|"filter", batchId, title }
  let baodanCandidates = [];  // 这一次范围里的全部候选单（快照）
  let baodanSel = new Set();  // 勾选中的单 id
  // v31：用户**真的动过**快递单号那一格没有（change / 「清空」置位，开面板与关面板复位）。
  // 它是「写账本」的**必要条件**——预填值是范围里的众数，少数派单与它必然不同，
  // 只比字符串会让「点一下复制、什么都没改」顺手改掉那些单的正确单号（静默串单）。
  let baodanTrackingTouched = false;
  let baodanRevision = 0, baodanCopySeq = 0;
  let clipboardQueue = Promise.resolve();
  let currentFilter = "待寄";
  // v41：账本页勾选（只活在内存里，不落库、不进同步包）。键：o:<订单id> 或 b:<批次id>（整批）。
  // 每次 renderList 都按「当前页签里还能勾的东西」收敛一次——保存成功后单子换了阶段，勾选自然消失。
  const selection = new Set();
  let legacyLoaded = false;
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
    const raw = numberValue(value);
    const n = Number.isSafeInteger(Math.round(raw * 100)) ? displayedAmount(raw) : raw;
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
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(String(dateStr || ""));
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

  // Validate before conversion: a finite yuan value can overflow in cents.
  function safeAmount(v) {
    const n = Number(v);
    return Number.isFinite(n) && Number.isSafeInteger(Math.round(n * 100));
  }

  function displayedAmount(v) {
    const cents = Math.round(v * 100);
    return cents === 0 ? 0 : cents / 100;
  }

  function validAmountInputs(inputs) {
    for (const input of inputs) {
      if (!input || input.disabled || input.value === "") continue;
      if (!safeAmount(input.value)) {
        toast("金额超出可安全计算的范围，请修改后再保存");
        input.focus();
        return false;
      }
    }
    return true;
  }

  function floorWeighted(total, weight, sum) {
    const product = total * weight;
    if (Number.isSafeInteger(product)) return Math.floor(product / sum);
    const numerator = BigInt(total) * BigInt(weight), denominator = BigInt(sum);
    const quotient = numerator / denominator;
    return Number(numerator < 0n && numerator % denominator !== 0n ? quotient - 1n : quotient);
  }

  function validShares(shares, total) {
    return shares.every((value) => Number.isSafeInteger(value) && value >= 0)
      && shares.reduce((sum, value) => sum + value, 0) === total;
  }

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
      shares[i] = floorWeighted(totalCents, weights[i], sum);
      used += shares[i];
    }
    const rem = totalCents - used;
    const byWeight = weights.map((w, i) => i).sort((a, b) => weights[b] - weights[a] || a - b);
    for (let r = 0; r < rem; r++) shares[byWeight[r]] += 1;
    return shares;
  }

  // ---- Local commit boundary ----
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const identityRaw = () => localStorage.getItem(IDENTITY_KEY) || "";
  const identityOwner = () => {
    try { return JSON.parse(identityRaw()).userId || ""; } catch { return ""; }
  };

  function captureStorageBaseline() {
    storageBaseline = {
      identity: identityRaw(),
      data: localStorage.getItem(DATA_KEY),
      snapshot: localStorage.getItem(SNAPSHOT_KEY),
    };
  }

  function showLedgerIssue(message) {
    localIssue = message;
    clearTimeout(syncTimer);
    syncPending = false;
    renderLedgerNotice();
  }

  function renderLedgerNotice() {
    const box = $("#ledgerNotice");
    if (!box) return;
    const issue = localIssue || ledgerProblem(data) || syncBlocked;
    box.hidden = !issue;
    $("#ledgerNoticeText").textContent = issue;
    $("#reloadLedgerBtn").hidden = !localIssue;
    $("#retrySyncBtn").hidden = !!localIssue || !!ledgerProblem(data) || !syncBlocked;
    $("#retrySyncBtn").textContent = syncBlocked.includes("配对") ? "重试配对" : "重试同步";
    const writeIssue = localIssue || ledgerProblem(data);
    $$(".modal .save-error").forEach((line) => {
      line.textContent = writeIssue ? `保存已暂停，输入内容仍保留。${writeIssue}` : "";
      line.hidden = !writeIssue;
    });
    if (issue && window.luhuoSync) window.luhuoSync.setStatus("error", issue);
  }

  function checkWriteBoundary() {
    if (localIssue) { toast(localIssue); return false; }
    try {
      if (!storageBaseline || identityRaw() !== storageBaseline.identity
        || localStorage.getItem(DATA_KEY) !== storageBaseline.data
        || localStorage.getItem(SNAPSHOT_KEY) !== storageBaseline.snapshot) {
        showLedgerIssue("其他页面已更换或更新账本。本页已停止写入，请先保留草稿，再重新载入。");
        toast("账本已在其他页面更新，本次没有保存");
        return false;
      }
      return true;
    } catch {
      showLedgerIssue("无法读取本机存储，已停止保存和同步。请保留草稿并检查浏览器存储权限。");
      return false;
    }
  }

  function ledgerProblem(source, structural = false) {
    if (!source || typeof source !== "object" || Array.isArray(source) || !Array.isArray(source.orders)) {
      return "账本格式不正确：需要包含 orders 数组，原账本未改动。";
    }
    if (source.version !== undefined && !LEDGER_VERSIONS.includes(source.version)) return "暂不支持这个账本版本，请保留原文件。";
    const ids = new Set();
    const sums = { cost: 0, fee: 0, income: 0 };
    for (const order of source.orders) {
      if (!order || typeof order !== "object" || Array.isArray(order)) return "账本含无效的订单结构，请先核对原文件。";
      const id = String(order.id || "");
      if (id && ids.has(id)) return "账本存在重复订单 ID，已停止有歧义的写入与同步。请先导出核对，不会自动删单。";
      ids.add(id);
      for (const key of ["cost", "fee", "income", "batchFee", "batchIncome", "batchFeeShare", "batchIncomeShare", "qty", "batchCount"]) {
        const value = order[key];
        if (value === null || value === undefined || value === "") continue;
        const unit = key.endsWith("Share") || key === "qty" || key === "batchCount" ? 1 : 100;
        if ((typeof value !== "number" && typeof value !== "string") || !Number.isFinite(Number(value))
          || !Number.isSafeInteger(Math.round(Number(value) * unit))) {
          return "账本金额或数量超出安全计算范围，已停止写入。请保留原数据并核对。";
        }
        if (Object.prototype.hasOwnProperty.call(sums, key)) {
          sums[key] += Math.abs(Math.round(Number(value) * 100));
          if (!Number.isSafeInteger(sums[key])) return "账本累计金额超出安全计算范围，请先导出核对。";
        }
      }
      if (!structural && !id) return "订单缺少唯一 ID，请先核对账本。";
    }
    return "";
  }

  function restoreMemory() {
    if (durableData) data = clone(durableData);
    if (durableMeta) meta = clone(durableMeta);
  }

  function ensureLocalSnapshot() {
    if (localStorage.getItem(SNAPSHOT_KEY)) return true;
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ version: 1, owner: identityOwner(), revision: uid(),
        data: durableData || data, updatedAt: durableMeta ? durableMeta.updatedAt : meta.updatedAt }));
      captureStorageBaseline();
      return true;
    } catch {
      if (activeWrite) activeWrite.failed = true;
      showLedgerIssue("无法建立完整保存快照，本次未改动账本。请检查存储空间或权限并保留草稿。");
      toast("保存失败，本次没有提交；请保留草稿");
      return false;
    }
  }

  function persist() {
    if (!checkWriteBoundary()) { if (activeWrite) activeWrite.failed = true; return false; }
    const problem = ledgerProblem(data);
    if (problem) { if (activeWrite) activeWrite.failed = true; toast(problem); renderLedgerNotice(); return false; }
    if (!ensureLocalSnapshot()) return false;
    const previous = new Map([DATA_KEY, META_KEY, SNAPSHOT_KEY].map((key) => [key, localStorage.getItem(key)]));
    try {
      const snapshot = { version: 1, owner: identityOwner(), revision: uid(), data, updatedAt: meta.updatedAt };
      // Legacy mirrors remain compatible; the final single-key write is the commit point.
      localStorage.setItem(DATA_KEY, JSON.stringify(data));
      localStorage.setItem(META_KEY, JSON.stringify(meta));
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
      captureStorageBaseline();
      durableData = clone(data);
      durableMeta = clone(meta);
      if (activeWrite) activeWrite.committed = true;
      return true;
    } catch {
      let rollbackFailed = false;
      for (const [key, value] of previous) {
        try {
          if (localStorage.getItem(key) === value) continue;
          if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
        } catch { rollbackFailed = true; }
      }
      if (activeWrite) activeWrite.failed = true;
      restoreMemory();
      showLedgerIssue(rollbackFailed
        ? "保存未完成，本机存储状态需要核对。最近完整快照已保留，请保留草稿后重新载入。"
        : "这次没有保存，草稿仍在。请检查存储空间或权限，保留草稿后重新载入。");
      toast("保存失败，本次没有提交；请保留草稿");
      return false;
    }
  }

  function persistMeta() {
    if (!checkWriteBoundary()) return false;
    try {
      localStorage.setItem(META_KEY, JSON.stringify(meta));
      durableMeta = clone(meta);
      return true;
    } catch {
      toast("本机状态暂时无法保存，账本金额未改动");
      return false;
    }
  }

  function withStorageLock(action) {
    if (storageLockHeld) return action();
    if (!navigator.locks || !navigator.locks.request) return action();
    return navigator.locks.request("luhuo-ledger-local-write", { mode: "exclusive" }, () => {
      storageLockHeld = true;
      try { return action(); } finally { storageLockHeld = false; }
    });
  }

  function controlState(root) {
    return JSON.stringify([...root.querySelectorAll("input, select, textarea")]
      .map((input) => [input.name || input.id, input.value, input.checked, input.disabled]));
  }

  // ---- 03 期：提交那一刻的"表单读数快照" ----
  // 每个格子存成 { value, disabled } 两字段 —— 与 `validAmountInputs` 需要的形状一致，
  // 所以拿到写锁后如果发现表单已被重新打开，可以直接把它**当成 `f` 用**，不必改任何读取点。
  // v38 会话快照（内存、不落库）：它记的是"打开表单那一刻的表单是什么样"——
  // 04 期的离开保护用它判"有没有真的改动"（改过才提醒，没改过不问）。
  let formBaseline = null;

  let formOpenSerial = 0;   // 每次 openForm 自增：用来判"这张表单还是不是提交时那一张"
  function formIntentSnapshot(f) {
    const snap = {};
    ["goods", "cost", "fee", "date", "qty", "channel", "status", "note", "tracking"].forEach((k) => {
      snap[k] = { value: f && f[k] ? String(f[k].value ?? "") : "", disabled: !!(f && f[k] && f[k].disabled) };
    });
    snap.serial = formOpenSerial;
    // 表单模式与在编辑哪一条也是**提交那一刻**的事实：收入单与货单落库形态不同，
    // 排到锁之后才读 live 值的话，中途被重新打开的表单会把这一笔的落库形态换掉。
    snap.formKind = formKind;
    snap.editingId = editingId;
    snap.prefillPlatform = prefillPlatform;
    // 04 期：新单的**候选 orderId** 也在这里定下来——草稿创建时分配、正式提交沿用它，
    // 这样同一份草稿被提交两次能被本机证据识别出来（见 draftGateForSubmit）。
    snap.orderId = (editingId || !draftState) ? uid() : String(draftState.orderId || uid());
    // 04 二轮审查第 2/5 项：把「提交那一刻这份新单是否认领了草稿、认领的是哪一份」也抓进快照。
    // 草稿守门全部按这份快照判——等待写锁期间表单被重开（reopened）也不会误用新表单的草稿态，
    // 更不会漏掉旧提交本该做的草稿分类。
    const claimedDraft = !editingId && draftState && draftState.mode === "own" && draftState.claimed;
    snap.draftClaimed = !!claimedDraft;
    if (claimedDraft) {
      snap.draftOwner = String(draftState.owner || "");
      snap.draftId = String(draftState.draftId);
      snap.draftRevision = Number(draftState.revision) || 0;
    }
    return snap;
  }

  // 「原生那几条」的 JS 版（非负、最多两位小数）。为什么必须补：`#formSaveNext` 是 type="button"，
  // 点它**不走** form 的原生校验（required/min/step 全不生效），于是"保存"与"保存并继续"两条路的
  // 校验强度就不一样了。02 期的寄出面板与批量结算都补过同样的 JS 校验，这里补齐让两条路同强度。
  // 禁用的格子跳过——收入模式下邮费/数量是隐藏且禁用的，取库里的定值（与 validAmountInputs 同一条规矩）。
  function amountTextProblem(f, pairs) {
    for (const [key, label] of pairs) {
      const ctl = f && f[key];
      if (!ctl || ctl.disabled) continue;
      const raw = String(ctl.value ?? "").trim();
      if (raw === "") continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) return `${label}填写有误，请修改后再保存`;
      if (n < 0) return `${label}不能是负数`;
      if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-9) return `${label}最多两位小数`;
    }
    return "";
  }

  function withFormIntent(root, session, currentSession, action, serial, serialNow, precheck) {
    const state = controlState(root);
    // 04 审查第 5 项：原来这里套的是 withLedgerWrite（它自己先跑一遍 checkWriteBoundary），
    // 于是内层那份草稿 precheck **永远到不了** —— 外层旧基线一拒就直接返回了。
    // 现在只取一次锁，把草稿归属分类交给 withLedgerWriteNow 在**通用旧基线之外、之前**执行。
    return withStorageLock(() => {
      // 03 期：表单在等待写锁期间被**重新打开**过（serial 变了）时不按"输入已变化"拒绝——
      // 用户点保存那一刻的值已经抓成了快照（见 formIntentSnapshot），要写的正是那一份；不这么做的话
      // 下面那条判据会把"已经点过保存的那一单"整笔丢掉（C20 实测：提交后立刻再点一次「记一单」
      // 就会丢第一单；同一时序在纯 v39 上同样复现，属既有缺陷，不是 03 期引入的）。
      // 不传 serial 的两条路（回款 / 批量结算）行为与从前**一字不差**。
      const reopened = serial !== undefined && typeof serialNow === "function" && serialNow() !== serial;
      // 04 二轮审查第 5 项收尾：reopened 的那次提交**也照跑**草稿分类——判据全部来自提交那一刻的
      // 快照（draftClaimed/draftId/draftRevision/orderId），不会碰新表单的草稿态。漏跑它就等于
      // "重开表单可以把已提交的草稿再记一笔"，且只会听到通用基线提示、没有草稿分类。
      const gate = precheck;
      return withLedgerWriteNow(() => {
        if (session !== currentSession()) {
          toast("等待期间输入已变化，本次没有保存，请重新确认"); return false;
        }
        if (!reopened && state !== controlState(root)) {
          toast("等待期间输入已变化，本次没有保存，请重新确认"); return false;
        }
        return action();
      }, gate);
    });
  }

  function withLedgerWrite(action, precheck) { return withStorageLock(() => withLedgerWriteNow(action, precheck)); }

  function withLedgerWriteNow(action, precheck) {
    if (pairingEpoch !== null) { toast("正在配对，请稍候再保存"); return false; }
    // 04 期：草稿归属/重复提交的守门。它是**唯一**在"通用旧基线拒绝"之前跑的自定义检查——
    // 因为"这份草稿其实已经提交过"与"账本被别处改过"要分别给出不同的提示、不同的后续动作。
    if (typeof precheck === "function") {
      const verdict = precheck();
      if (verdict && verdict.block) {
        toast(verdict.message || "这一份草稿不能继续提交，请到账本里核对");
        return false;
      }
    }
    if (!checkWriteBoundary()) return false;
    const problem = ledgerProblem(data);
    if (problem) { toast(problem); renderLedgerNotice(); return false; }
    if (activeWrite) return action();
    const previous = { data, meta, locks: new Map([...profitLocks].map(([id, locks]) => [id, new Map(locks)])),
      seen: new Set(statusHintSeen), detail: new Map(statusHintDetail) };
    data = clone(data); meta = clone(meta);
    const transaction = { committed: false, failed: false };
    activeWrite = transaction;
    try { return action(); }
    finally {
      activeWrite = null;
      if (!transaction.committed) { data = previous.data; meta = previous.meta; }
      if (transaction.failed) {
        profitLocks.clear(); previous.locks.forEach((value, id) => profitLocks.set(id, value));
        statusHintSeen.clear(); previous.seen.forEach((id) => statusHintSeen.add(id));
        statusHintDetail.clear(); previous.detail.forEach((value, id) => statusHintDetail.set(id, value));
      }
      if (!transaction.committed) renderLedgerNotice();
    }
  }

  function setLedger(incoming, updatedAt, options = {}) {
    const expected = storageBaseline && { ...storageBaseline, epoch: syncEpoch };
    return withStorageLock(() => {
      if (!expected || expected.epoch !== syncEpoch || expected.identity !== identityRaw()
        || expected.data !== storageBaseline.data || expected.snapshot !== storageBaseline.snapshot) {
        toast("核对期间账本已更新，本次没有覆盖，请重新操作"); return false;
      }
      return setLedgerNow(incoming, updatedAt, options);
    });
  }

  function setLedgerNow(incoming, updatedAt, options = {}) {
    const problem = ledgerProblem(incoming);
    if (problem) { toast(problem); return false; }
    const previousData = data, previousMeta = meta;
    const previousIssue = localIssue;
    if (options.recovery) localIssue = "";
    data = incoming;
    meta = Object.assign({}, meta, options.meta || {}, { updatedAt });
    if (!persist()) { data = previousData; meta = previousMeta; localIssue = localIssue || previousIssue; return false; }
    invalidateForNewLedger();
    render();
    if (options.sync) scheduleSync();
    return true;
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
    const out = { version: LEDGER_VERSION, orders: [] };
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
        // v41：寄出日期（可空）。只由「寄出」写入、「改回待寄」清空；不参与任何金额口径与报表归期。
        // 它只回答一件事：没有单号、也没成批的单是不是**已经寄出了**（见 isShipped）。
        // 与 tracking 同理必须留在白名单里，否则加载/拉取会静默丢掉它。非 YYYY-MM-DD 一律归空串。
        shipDate: cleanShipDate(o.shipDate),
        createdAt: String(o.createdAt || new Date().toISOString()),
      });
    });
    return out;
  }

  function loadLocal() {
    try {
      if (window.luhuoSync) window.luhuoSync.getSyncCode();
      const rawText = localStorage.getItem(DATA_KEY);
      const snapshotText = localStorage.getItem(SNAPSHOT_KEY);
      const raw = JSON.parse(rawText || "null");
      const snapshot = JSON.parse(snapshotText || "null");
      try {
        const rawMeta = JSON.parse(localStorage.getItem(META_KEY) || "null");
        if (rawMeta && typeof rawMeta === "object") meta = Object.assign(meta, rawMeta);
      } catch { meta.lastSyncError = "本机同步状态无法读取，账本数据仍保留"; }
      const source = snapshot && snapshot.version === 1 && snapshot.data ? snapshot.data : raw;
      if (source) { localIssue = ledgerProblem(source, true); data = normalizeData(source); }
      // v41：本机这本账是不是旧版（version 1 / 无版本）存下的——决定要不要出一次「老单标记寄出」提示
      legacyLoaded = !!(source && source.version !== LEDGER_VERSION && Array.isArray(source.orders) && source.orders.length > 0);
      if (snapshot) {
        if (snapshot.version !== 1 || !snapshot.data || snapshot.owner !== identityOwner()) {
          localIssue = "本机身份与完整快照不一致，已停止写入和同步。请先导出核对或重新配对。";
        } else {
          meta.updatedAt = snapshot.updatedAt;
          if (rawText !== JSON.stringify(snapshot.data)) localIssue = "本机旧版数据与最近完整快照不同，已停止自动写入。请在设置中导出两份数据核对。";
        }
      }
      try {
        const base = JSON.parse(localStorage.getItem(SYNC_BASE_KEY) || "null");
        // v41：基线也过一遍 normalizeData。旧版存下的基线没有 shipDate 键，而本机/云端两份都经新版
        // 规范化带上了它——orderSnap 逐键比对会让「基线 ≠ 本机」对每一单都成立，conflictingIds 的
        // bothChanged 分支就会把升级后第一次正常拉取误判成整本冲突。三方同一口径才可比。
        syncBase = base && base.owner === identityOwner() && !ledgerProblem(base.data) ? normalizeData(base.data) : null;
      } catch { syncBase = null; }
      if (LEGACY_FILTER[meta.filter]) meta.filter = LEGACY_FILTER[meta.filter];
      if (!FILTERS.includes(meta.filter)) meta.filter = "待寄";
      currentFilter = meta.filter;
      captureStorageBaseline();
      durableData = clone(data); durableMeta = clone(meta);
    } catch {
      localIssue = "本机账本或存储无法读取，原数据未覆盖。请在设置中导出原始数据核对。";
      try { captureStorageBaseline(); } catch { storageBaseline = null; }
      durableData = clone(data); durableMeta = clone(meta);
    }
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
    settledProfit = displayedAmount(settledProfit);
    return { totalCost, totalIncome, outstanding, outCount, settledProfit, monthCost, monthIncome, byStatus, statusKeys: keys, months, count: orders.length };
  }

  // ---- 批次（一起寄出的一批单子）----
  // 一批一起寄出的单子共用一个 batchId，整批邮费/回款冗余存在每张单上：
  // 删单不会留下孤儿批次，也不需要额外维护一张批次表。
  function viewIndex() {
    if (ledgerViewIndex && ledgerViewIndex.source === data) return ledgerViewIndex;
    const members = new Map();
    data.orders.forEach((order) => {
      if (!order.batchId) return;
      if (!members.has(order.batchId)) members.set(order.batchId, []);
      members.get(order.batchId).push(order);
    });
    ledgerViewIndex = { source: data, groups: buildBatchGroups(), members, profitInfo: new Map() };
    return ledgerViewIndex;
  }

  function batchGroups() { return viewIndex().groups; }
  function batchMembers(id) { return viewIndex().members.get(id) || []; }

  function buildBatchGroups() {
    const map = new Map();
    data.orders.forEach((o) => {
      if (!o.batchId) return;
      let g = map.get(o.batchId);
      if (!g) {
        g = {
          id: o.batchId, date: o.batchDate || o.date,
          feeCents: 0, incomeCents: 0, costCents: 0,
          count: 0, pending: 0, names: [], variants: { date: new Set(), fee: new Set(), income: new Set() }, conflictFields: [],
        };
        map.set(o.batchId, g);
      }
      g.count += 1;
      g.costCents += toCents(o.cost);
      g.names.push(o.name || "未命名");
      g.variants.date.add(o.batchDate || "");
      g.variants.fee.add(toCents(o.batchFee));
      g.variants.income.add(toCents(o.batchIncome));
      if (!isSettled(o)) g.pending += 1;
      // 整批口径同值冗余，取最大可容忍半截写入的旧数据
      g.feeCents = Math.max(g.feeCents, toCents(o.batchFee));
      g.incomeCents = Math.max(g.incomeCents, toCents(o.batchIncome));
    });
    map.forEach((g) => { g.conflictFields = Object.keys(g.variants).filter((key) => g.variants[key].size > 1); });
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
      const members = batchMembers(g.id);
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
        parts[k] = floorWeighted(remaining, w[k], sumW);
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
    const index = viewIndex();
    if (members === index.members.get(g.id)) {
      if (!index.profitInfo.has(g.id)) index.profitInfo.set(g.id, computeBatchProfitInfo(g, members));
      return index.profitInfo.get(g.id);
    }
    return computeBatchProfitInfo(g, members);
  }

  function computeBatchProfitInfo(g, members) {
    const anyIncome = members.some(hasIncome);
    const incSum = members.reduce((a, o) => a + (hasIncome(o) ? toCents(o.income) : 0), 0);
    const feeSum = members.reduce((a, o) => a + toCents(o.fee), 0);
    const dates = new Set();
    members.forEach((o) => { if (hasIncome(o)) dates.add(o.incomeDate || ""); });
    const total = g.incomeCents - g.costCents - g.feeCents;
    if (g.conflictFields && g.conflictFields.length) return { pending: !anyIncome, editable: false, reason: "metadata", total };
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
    if (dates.size > 1 || [...dates].some((date) => !parseDate(date))) return { pending: false, editable: false, reason: "date", total };
    return { pending: false, editable: true, reason: "", total };
  }

  // 批次「不开放编辑」的原因 → 给用户看的那一句话（表头的提示行与「恢复默认分摊」的提示共用一支）。
  // 前三条沿用 v35 的既有措辞，一个字不改；partial-income 是 v36 新增的那句。
  function batchReasonText(reason) {
    if (reason === "metadata") return "同批成员记录的整批口径不一致，已停止重摊；请先导出核对，再导入修正版本";
    if (reason === "no-income") return "整批还没记回款，没有可分摊的钱";
    if (reason === "partial-income") return "这一批还有人没记回款，先补齐回款再分摊";
    if (reason === "date") return "本批回款日期缺失、无效或不一致，请用各单的「改回款」核对日期";
    return "这一批账目有分叉，先按「改本批邮费」对齐再分摊";   // drift / date 都走这句（v35 口径）
  }

  // 给冒烟测试的纯函数出口（A 语义要「不经过 DOM 直接喂数据断言」）；不是公共 API，别在业务代码里用。
  // v36 补两个**只读**探针：手改锁是内存态、禁入理由是 batchProfitInfo 的返回值，两者在页面外
  // 本来都看不见，而测试必须能断言「退批 / 整批重摊 / 整包换数据之后锁真的没了」与「新禁入的 reason」。
  // 只暴露读取视图——没有任何写入口，业务代码一律走 profitLocks 本体与 batchProfitInfo。
  window.luhuoPure = {
    ledgerSnapshot: () => clone(data),
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
    ledgerViewIndex = null;
    renderDash();
    renderList();
    // 01 期：查账面板开着时跟着重算（从结果里点了「编辑 / 回款」保存成功 → saveData → render，
    // 结果按最新数据重算：已不匹配的单如实移出，查询条件与面板内的位置都保持不变）。
    // 面板没开时它第一行就返回，对既有渲染路径零影响。
    renderLookup();
    renderReport();
    renderSyncBadge();
    renderLedgerNotice();
  }

  function renderSyncBadge() {
    if (!window.luhuoSync) return;
    if (localIssue || syncBlocked || ledgerProblem(data)) {
      window.luhuoSync.setStatus("error", localIssue || syncBlocked || ledgerProblem(data));
      return;
    }
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
    const ht = $("#heroTotals");
    if (ht) ht.innerHTML = `累计净赚 <b class="${s.settledProfit > 0 ? "pos" : s.settledProfit < 0 ? "neg" : ""}">${money(s.settledProfit)}</b>`
      + ` · 累计垫付 ${money(s.totalCost)} · 回款 ${money(s.totalIncome)}`;

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
    // v41：页签按阶段过滤（待寄 / 待回款 / 已回款）；旧「自留」只在「全部」里出现
    return orders.filter((o) => orderStage(o) === currentFilter);
  }

  // v41：账本顶部摘要（垫付在外 + 待寄/待回款单数）。口径与统计页英雄卡同源（computeStats）。
  function renderLedgerSum() {
    const el = $("#lsOutstanding");
    if (!el) return;
    el.textContent = money(computeStats().outstanding);
    let toShip = 0, toPay = 0;
    data.orders.forEach((o) => { const st = orderStage(o); if (st === "待寄") toShip += 1; else if (st === "待回款") toPay += 1; });
    $("#lsCounts").textContent = toShip + toPay > 0 ? `待寄 ${toShip} · 待回款 ${toPay}` : "";
  }

  // v41：当前页签里「能勾」的东西。待寄：每张待寄单；待回款：多成员批次按**整批**一个键（b:），
  // 散单与单成员批次的单按单（o:）。其余页签不提供勾选。
  function selectableKeys() {
    const keys = new Set();
    if (currentFilter !== "待寄" && currentFilter !== "待回款") return keys;
    const groups = batchGroups();
    data.orders.forEach((o) => {
      if (orderStage(o) !== currentFilter) return;
      const g = o.batchId ? groups.get(o.batchId) : null;
      if (currentFilter === "待回款" && g && g.count > 1) keys.add("b:" + o.batchId);
      else keys.add("o:" + o.id);
    });
    return keys;
  }

  function pruneSelection() {
    const ok = selectableKeys();
    [...selection].forEach((k) => { if (!ok.has(k)) selection.delete(k); });
  }

  // v41：勾选操作条。待回款允许的组合只有两种：恰好一整批，或若干散单（≥2 单会在结算时合成一批）。
  function selectionPlan() {
    const keys = [...selection];
    const batches = keys.filter((k) => k.startsWith("b:")).map((k) => k.slice(2));
    const loose = keys.filter((k) => k.startsWith("o:")).map((k) => k.slice(2));
    if (currentFilter === "待寄") return { kind: loose.length ? "ship" : "none", ids: loose };
    if (batches.length === 1 && loose.length === 0) return { kind: "pay-batch", batchId: batches[0] };
    if (batches.length === 0 && loose.length === 1) return { kind: "pay-one", id: loose[0] };
    if (batches.length === 0 && loose.length > 1) return { kind: "pay-merge", ids: loose };
    if (keys.length === 0) return { kind: "none" };
    return { kind: "bad", reason: "一次回款只能是一整批，或若干单独寄的单" };
  }

  function renderSelBar() {
    const bar = $("#selBar");
    if (!bar) return;
    const all = $("#selAll");
    if (all) {
      const keys = selectableKeys();
      all.hidden = keys.size === 0;
      all.textContent = keys.size > 0 && [...keys].every((k) => selection.has(k)) ? "全不选" : "全选";
    }
    const show = selection.size > 0 && (currentFilter === "待寄" || currentFilter === "待回款");
    bar.hidden = !show;
    document.body.classList.toggle("has-sel", show);
    if (!show) return;
    let n = 0, costCents = 0;
    selection.forEach((k) => {
      const id = k.slice(2);
      const list = k.startsWith("b:") ? data.orders.filter((o) => o.batchId === id) : data.orders.filter((o) => o.id === id);
      list.forEach((o) => { n += 1; costCents += toCents(o.cost); });
    });
    const plan = selectionPlan();
    $("#selCount").textContent = `已选 ${n} 单`;
    $("#selSub").textContent = plan.kind === "bad" ? plan.reason : ` · 垫付 ${money(costCents / 100)}`;
    const go = $("#selGo");
    go.textContent = currentFilter === "待寄" ? "寄出" : "回款";
    go.disabled = plan.kind === "bad" || plan.kind === "none";
  }

  function runSelection() {
    const plan = selectionPlan();
    if (plan.kind === "ship") openShipForm({ kind: "new", ids: plan.ids });
    else if (plan.kind === "pay-one") openPayForm(plan.id);
    else if (plan.kind === "pay-batch") openBatchModal(plan.batchId, { mode: "pay" });
    else if (plan.kind === "pay-merge") openBatchModal("", { mode: "pay", ids: plan.ids });
    else if (plan.kind === "bad") toast(plan.reason);
  }

  // v41：升级提示的候选＝升级前就记下、现在落在「待寄」的单（老数据没有寄出日期，没单号也没成批的
  // 在途单一律落在待寄；其中其实已经寄出的，请用户勾选标记一次）。只看本机 meta，不进账本、不同步。
  // 新设备配对到旧版写的云端账本、或导入旧版备份时，本机加载那一刻看不出「升级前」——
  // 在换入旧版（version≠2）且有订单的账本时补记一次升级时刻，升级提示与「老单默认各自寄」才不会漏。
  function markLegacyLedger(rawVersion, orders) {
    if (meta.v41FirstSeen || rawVersion === LEDGER_VERSION || !orders || !orders.length) return;
    meta.v41FirstSeen = new Date().toISOString();
    persistMeta();
    renderListHints();
  }

  function upgradeCandidates() {
    if (!meta.v41FirstSeen || meta.v41HintDone) return [];
    return data.orders.filter((o) => orderStage(o) === "待寄" && String(o.createdAt || "") < meta.v41FirstSeen);
  }

  function renderListHints() {
    const ch = $("#checkHint");
    if (ch) {
      const n = checkActionable(checklistItems());
      ch.hidden = n === 0;
      ch.textContent = n > 0 ? `${n} 项需要核对 ›` : "";
    }
    const uh = $("#upgradeHint");
    if (uh) {
      const list = upgradeCandidates();
      uh.hidden = list.length === 0;
      if (list.length) {
        $("#upgradeHintText").textContent = `升级后，有 ${list.length} 单还没标记寄出（老数据没有寄出记录）。`
          + `其中已经寄出的，勾选后点「寄出」标记一下；没寄的不用管。`;
      }
    }
  }

  function renderList() {
    // v21 起没有「自留」筛选（那个状态不能再新建）；旧自留单在「全部」里看得到、可手动删除
    // v41：页签按阶段（待寄 / 待回款 / 已回款 / 全部）。数字只在 >0 时显示；「全部」不带数字（不是待办）。
    renderLedgerSum();
    const counts = { 待寄: 0, 待回款: 0, 已回款: 0 };
    data.orders.forEach((o) => { const st = orderStage(o); if (st in counts) counts[st] += 1; });
    $("#filterChips").innerHTML = FILTERS.map((c) => {
      const n = c === "全部" ? 0 : counts[c];
      return `<button class="chip ${currentFilter === c ? "on" : ""}" data-filter="${c}">${c} ${n > 0 ? `<b>${n}</b>` : ""}</button>`;
    }).join("");
    pruneSelection();
    renderSelBar();
    renderListHints();

    const orders = filteredOrders();
    if (orders.length === 0) {
      const empty = {
        待寄: "没有待寄的单<br><small>点右下角「记一单」开始</small>",
        待回款: "没有等回款的单<br><small>寄出之后会出现在这里</small>",
        已回款: "还没有已回款的单",
        全部: "还没有单子<br><small>点右下角「记一单」开始</small>",
      }[currentFilter] || "没有单子";
      $("#orderList").innerHTML = `<div class="empty">${empty}</div>`;
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
    if (g.conflictFields && g.conflictFields.length) notes.push({ warn: true, text: batchReasonText("metadata") });
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
    const members = batchMembers(batchId);
    if (!g || members.length < 2) return [];
    const defCents = splitByWeight(g.incomeCents, members.map((m) => Math.max(0, toCents(m.cost))));
    const want = new Set(d.ids);
    return members
      .filter((m, i) => want.has(m.id) && Math.abs(toCents(m.income) - defCents[i]) > 1)
      .map((m) => m.name || "未命名");
  }

  function batchHeadHtml(g, visible) {
    const shownCount = visible.filter((o) => o.batchId === g.id).length;
    const members = batchMembers(g.id);
    // 结算时的成员数冗余在每张单上（取最大，容忍半截写入的旧数据）；老数据没有这个字段就是 0
    const batchCount = members.reduce((a, o) => Math.max(a, Math.round(numberValue(o.batchCount))), 0);
    const bits = [`垫付 ${money(g.costCents / 100)}`];
    if (g.conflictFields.length) bits.push("整批口径待核对");
    else {
      if (g.feeCents > 0) bits.push(`邮费 ${money(g.feeCents / 100)}`);
      if (g.incomeCents > 0) bits.push(`回款 ${money(g.incomeCents / 100)}`);
    }
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
    const profitHtml = pinfo.reason === "metadata" ? `<span class="bh-profit pending">总利润 待核对</span>` : pinfo.pending
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
    // v41：待回款页签里整批一个勾选框（勾的是这一整批，不是某几个成员）；表头的「回款」在收起态也看得见
    const payable = members.some((o) => o.status === "在途");
    const selBox = currentFilter === "待回款" && payable
      ? `<label class="sel-box bh-sel" title="勾选这一整批"><input type="checkbox" data-sel="b:${escapeHtml(g.id)}"${selection.has("b:" + g.id) ? " checked" : ""} aria-label="勾选这一整批"></label>`
      : "";
    return `<div class="batch-head${selBox ? " has-sel" : ""}">
      ${selBox}
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
        ${payable ? `<button type="button" class="bh-pay" data-act="bpay" data-batch="${escapeHtml(g.id)}">回款</button>` : ""}
        <button type="button" class="bh-act" data-act="baodan" data-batch="${escapeHtml(g.id)}">报单</button>
        <button type="button" class="bh-act" data-act="bship" data-batch="${escapeHtml(g.id)}">改单号/邮费</button>
        ${payable ? "" : `<button type="button" class="bh-act" data-act="batchfee" data-batch="${escapeHtml(g.id)}">改本批回款</button>`}
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
    if (block) {
      block.classList.toggle("collapsed", !expanded);
      // v42：只在用户亲手展开的这一下给成员卡片一个轻入场（类随后自摘）；整列表重渲染不带这个类，不会每次都动。
      block.classList.toggle("just-opened", expanded);
      if (expanded) setTimeout(() => block.classList.remove("just-opened"), 400);
    }
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

  // v41：寄出日期的规范化——只认真实日历日的 YYYY-MM-DD，其余（空、乱码、2026-02-30）一律空串。
  // 空串＝没标记过寄出（老数据全是空串，阶段由单号/批次推得，见 isShipped）。
  function cleanShipDate(v) {
    const t = String(v === null || v === undefined ? "" : v).trim();
    // parseDate 自带回读校验（2026-02-30 → null），这里只再卡掉它允许的带时刻写法
    return /^\d{4}-\d{2}-\d{2}$/.test(t) && parseDate(t) ? t : "";
  }

  // v41：阶段（只派生、不落库）。status 仍只有 在途/已回款（+遗留自留），统计口径一字不动；
  // 「在途」在账本页再细分成「待寄 / 待回款」两个页签，判据只有这一处：
  //   有寄出日期 ∨ 有单号 ∨ 已在某个批次里  ⇒ 已寄出。
  // 老数据没有 shipDate：有单号或已成批的在途单自动算已寄（落到「待回款」），其余落「待寄」。
  function isShipped(o) {
    return !!(o && (o.shipDate || cleanTracking(o.tracking) || o.batchId));
  }
  function orderStage(o) {
    if (o.status === "已回款") return "已回款";
    if (o.status === "在途") return isShipped(o) ? "待回款" : "待寄";
    return "遗留";   // 旧「自留」：只在「全部」里出现
  }

  // soloBatch：这一单的批次只剩它自己（页面上不显示「一起寄出」表头），卡片里补一句归属，
  // 免得「退出本批」这个按钮看起来没有来由
  // opts（01 期新增，可选）：
  //   · opts.lookup=true —— 这张卡片画在**查账面板**里。查账是只读查找视图、范围只是"命中集合"，
  //     所以**不渲染**「改本批邮费 / 退出本批」这两个批次写入口（规格：查账模式不提供范围含糊的
  //     批量操作，要整批操作就退出查账回账本页走明确完整范围）。其余动作（回款/改回款、再来一单、
  //     编辑、删除）都是**单笔**语义、范围无歧义，照常保留。
  //   · opts.hit=false —— 这一张是「查看整批」展开后补出来的**未命中**成员，标一句免得看错。
  // 不传 opts 时行为与以前一字不差（账本页、既有测试全走这条）。
  function orderCardHtml(o, extraClass, soloBatch, opts) {
    const settled = isSettled(o);
    const profit = displayedAmount(orderProfit(o));
    const inLookup = !!(opts && opts.lookup);
    const missFlag = inLookup && opts.hit === false ? `<div class="lk-flag">未命中本次查询（属于这一批）</div>` : "";
    // 已回款但金额未填，不在卡片上把未知回款显示成确定亏损。
    // 只改显示；旧自留、统计公式和账本字段保持原样。
    const pendingIncome = o.status === "已回款" && !hasIncome(o);
    const showProfit = !pendingIncome && (o.income !== null || settled);
    // v35：这一单的利润可不可以行内编辑（点数字变输入框）。前提：多成员批次 + 该批当前可编辑
    // （batchProfitInfo 的三条禁入都过了）。单成员批次没有表头也没有「分项」，散单不涉及，
    // 一律保持原样（利润只是展示）。mates 按**数据全量**取——被筛选只显示部分成员时，
    // 分摊仍按整批算（页面显示几个不影响钱）。
    // 查账模式下不做行内利润编辑：那是**整批**口径的分摊写入（改一项会连带重算同一批其他项），
    // 属于"整批操作"，规格要求这类入口只在明确完整范围里给。渲染成死按钮比不给更糟（点了没反应），
    // 所以这里只按只读文本显示利润，退出查账回账本页就能改。
    let profitEditable = false;
    if (showProfit && o.batchId && !soloBatch && !inLookup) {
      const mates = batchMembers(o.batchId);
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
    // v41：卡片只露**一个**与阶段对应的主按钮（待寄 → 寄出；待回款的散单 → 回款），其余动作收进「更多」。
    // 所有既有 data-act 按钮**原样保留**（只是住进 .order-more 里），行为一字未改。
    const eid = escapeHtml(o.id);
    const stage = orderStage(o);
    const looseShipped = stage === "待回款" && !(o.batchId && !soloBatch);
    let primary = "";
    if (stage === "待寄") primary = `<button class="act primary" data-act="shipnew" data-id="${eid}">寄出</button>`;
    let payBtn = "";
    if (!settled) payBtn = `<button class="act${looseShipped ? " primary" : ""}" data-act="pay" data-id="${eid}">回款</button>`;
    else if (o.status === "已回款") payBtn = `<button class="act" data-act="pay" data-id="${eid}">改回款</button>`;
    if (looseShipped) { primary = payBtn; payBtn = ""; }
    if (payBtn) actions.push(payBtn);
    actions.push(`<button class="act" data-act="dup" data-id="${eid}">再来一单</button>`);
    actions.push(`<button class="act" data-act="edit" data-id="${eid}">编辑</button>`);
    // 02 期：寄出信息（散单＝这一单；批内单＝这一整批，范围由 openShipForm 定死）。
    // 查账模式也给（范围是确定的一单/一整批，不是"跟着筛选走"的含糊范围）。
    actions.push(`<button class="act" data-act="ship" data-id="${eid}">改单号/邮费</button>`);
    if (!inLookup && o.status === "在途" && isShipped(o) && !o.batchId) {
      // v41：已寄出的散单——补报一次单、或寄错了改回待寄
      actions.push(`<button class="act" data-act="bd1" data-id="${eid}">报单</button>`);
      actions.push(`<button class="act" data-act="unship" data-id="${eid}">改回待寄</button>`);
    }
    if (o.batchId && !inLookup) {
      // v24：批次的金额入口**常驻在卡片上**（与批次表头走同一个动作）：单成员批次没有表头、
      // 筛选把表头藏起来时，卡片上的入口仍在。openBatchModal 会把该批**全部成员**并进弹窗。
      actions.push(`<button class="act" data-act="batchfee" data-batch="${escapeHtml(o.batchId)}">改本批邮费</button>`);
      actions.push(`<button class="act" data-act="unbatch" data-id="${eid}">退出本批</button>`);
    }
    actions.push(`<button class="act danger" data-act="del" data-id="${eid}">删除</button>`);
    // v41：勾选框只在账本页「待寄 / 待回款」页签、且这张卡是一个独立勾选单元时出现（批内成员跟着表头整批勾）
    const selKey = "o:" + o.id;
    const selOn = !inLookup && (currentFilter === "待寄" || currentFilter === "待回款")
      && stage === currentFilter && !(currentFilter === "待回款" && o.batchId && !soloBatch);
    const selBox = selOn
      ? `<label class="sel-box" title="勾选"><input type="checkbox" data-sel="${escapeHtml(selKey)}"${selection.has(selKey) ? " checked" : ""} aria-label="勾选这一单"></label>`
      : "";
    // v31：`order-mid` 末尾补「 · 单号 X」（没填单号的单一个字节都不多）。这一行本来就长，
    // 360px 上多这一截会折行——**属正常**（.order-mid 本来就会折），别为它缩字号或截断单号。
    // v33：利润从金额格里挪到卡片右上的 .order-side（状态下面），金额格只留垫付/回款/邮费三格。
    // 那一次判据（showProfit / profit 的计算）一个字没动，只搬展示位置；
    // 判据本身后来为「待记回款」改过一次，见本函数上方的 pendingIncome。
    return `<div class="order-card ${extraClass || ""}${selBox ? " has-sel" : ""}">
      ${selBox}
      <div class="order-top">
        <span class="order-name">${escapeHtml(o.name || "未命名")}</span>
        <div class="order-side">
          ${pendingIncome ? `<span class="order-income-pending">待记回款</span>` : ""}
          ${showProfit ? `<div class="order-profit${profitEditable ? " editable" : ""}">
            ${profitEditable
              ? `<button type="button" class="profit-edit" data-act="pedit" data-id="${escapeHtml(o.id)}" title="点一下改这一项的利润（整批总利润不变）"><b class="${profit > 0 ? "pos" : profit < 0 ? "neg" : ""}">${money(profit)}</b></button>`
              : `<b class="${profit > 0 ? "pos" : profit < 0 ? "neg" : ""}">${money(profit)}</b>`}
            <span>利润</span>${roiText(toCents(profit), toCents(o.cost)) ? `<i class="order-roi">${roiText(toCents(profit), toCents(o.cost))}</i>` : ""}
          </div>` : ""}
        </div>
      </div>
      ${missFlag}
      <div class="order-mid"><span class="status-tag ${STATUS_CLASS[o.status]}${stage === "待寄" ? " st-toship" : ""}">${escapeHtml(o.status === "在途" ? stage : statusLabel(o.status))}</span>${escapeHtml(o.date)}${o.platform ? " · " + escapeHtml(o.platform) : ""} · ${o.qty} 件${o.channel ? " · " + escapeHtml(o.channel) : ""}${cleanTracking(o.tracking) ? " · 单号 " + escapeHtml(cleanTracking(o.tracking)) : ""}${soloBatch ? " · 单独一批寄出" : ""}${o.shipDate && !cleanTracking(o.tracking) && !o.batchId ? " · 已寄出（无单号）" : ""}</div>
      ${o.note ? `<div class="order-note">${escapeHtml(o.note)}</div>` : ""}
      <div class="order-foot">
        <div class="order-money">
          <span>垫付 <b>${money(o.cost)}</b></span>
          ${o.income === null ? "" : `<span>回款 <b>${money(o.income)}</b></span>`}
          ${stage === "待寄" && !(toCents(o.fee) > 0) ? "" : `<span>邮费 <b>${money(o.fee)}</b></span>`}
        </div>
        <div class="order-actions">${primary}<button class="act more-toggle" data-act="more" aria-expanded="false" aria-label="更多操作" title="更多操作"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button></div>
      </div>
      <div class="order-more" hidden>${actions.join("")}</div>
    </div>`;
  }

  // ================= 01 期：查账（搜索 + 年月日定位） =================
  // 这一整块是**只读查找视图**，与账本页的筛选/写入范围彻底分开，三条边界写在最前面：
  //   ① 条件（关键词/状态/日期）只活在本次会话内存里——不落库、不进同步包、**不写 meta.filter**
  //      （账本页的筛选 chip 走的是 persistMeta，查账这一套刻意不走）。退出查账后账本页的筛选、
  //      批次展开记忆与滚动位置一个字节都不变，因为整块代码从来没碰过它们。
  //   ② 渲染走自己的 #lookupList，**不碰 filteredOrders()**——那个函数的含义仍然是「账本页当前
  //      筛选」，报单面板（openBaodan type:"filter"）与批次局部重绘都靠它。搜索命中集合**绝不能**
  //      被当成写入范围，所以这里既不提供批量结算、也不提供报单（要整批操作就退出查账）。
  //   ③ 一次业务写都没有：不调 saveData/persist/scheduleSync，不开任何写入弹窗之外的写路径。
  //      （用户仍可从结果里点「编辑 / 回款」——那是用户显式发起的单笔业务写，走的是原有守门。）
  const lookup = {
    open: false,
    q: "",                  // 关键词原文（分词与大小写在判据里做，展示仍用原文）
    status: "全部",          // 全部 / 在途 / 已回款
    dateMode: "all",        // all | y | ym | ymd | bad（bad＝日期待核对：date 解析不出真日历日）
    y: 0, m: 0, d: 0,
    panel: false,           // 日期导航面板是否展开
    level: "year",          // 面板当前层：year | month | day
    expanded: new Set(),    // 已「查看整批」的批次 id（只活在本面板/本次会话，与 expandedBatches 分开）
    composing: false,       // 中文组词中：组词期间不重绘（免得打断输入法候选）
    // 05 期：面板的两个页签（查账 / 核对清单），以及"从核对项精确跳到某一单/某一整批"的焦点
    tab: "search",
    focusId: "",
    focusBatchId: "",      // 05 二轮审查：批次类核对项用它把**整批成员**精确带到眼前，不是"清空条件看全部"
  };
  // v41：查账的状态 chip 与账本页同一套阶段叫法（待寄 / 待回款 / 已回款），旧「自留」只在「全部」里
  const LOOKUP_STATUSES = ["全部", "待寄", "待回款", "已回款"];

  // 关键词分词：按空白切、去掉空段、统一小写。多个词要求**每一段都命中**（AND），可落在不同字段上。
  function lookupTokens() {
    return String(lookup.q || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  // 命中判据：商品名 / 快递单号 / 备注 / 渠道 四个字段的**包含**匹配（忽略大小写与首尾空白）。
  // 单号过 cleanTracking：账本里存的本来就是规范值，这里再过一道只为对齐"界面上显示的那个值"。
  // 暂不做金额、拼音、AI 猜测（规格）。页面里这些值一律经 escapeHtml 作文本显示。
  function lookupHit(order) {
    const tokens = lookupTokens();
    if (tokens.length === 0) return true;
    const fields = [order.name, cleanTracking(order.tracking), order.note, order.channel]
      .map((v) => String(v === null || v === undefined ? "" : v).toLowerCase());
    return tokens.every((t) => fields.some((f) => f.includes(t)));
  }

  // 日期范围判据。分类全部由现有 order.date 现算派生，**不创建年份/月度业务字段**。
  // 解析用项目现成的 parseDate（它已经带真日历回读校验：2026-02-30 这种进位日返回 null），
  // 所以跨年、跨月、闰日都由同一套口径兜住，不会另算一套。
  // 日期无效/缺失的旧单**不替换成今天、也不丢掉**——它们单独进「日期待核对」那一档。
  function lookupDateHit(order) {
    if (lookup.dateMode === "all") return true;
    const dt = parseDate(order.date);
    if (lookup.dateMode === "bad") return !dt;
    if (!dt) return false;
    if (lookup.dateMode === "y") return dt.getFullYear() === lookup.y;
    if (lookup.dateMode === "ym") return dt.getFullYear() === lookup.y && dt.getMonth() + 1 === lookup.m;
    if (lookup.dateMode === "ymd") {
      return dt.getFullYear() === lookup.y && dt.getMonth() + 1 === lookup.m && dt.getDate() === lookup.d;
    }
    return true;
  }

  // 关键词＋日期先筛（**不含状态**）——状态 chip 的计数用这一份基底：
  // 它回答的正是「点这个状态会看到几单」。
  function lookupBase() {
    return data.orders.filter((o) => lookupDateHit(o) && lookupHit(o));
  }

  // 关键词＋状态（**不含日期**）——年/月/日三层格子里的计数用这一份基底。
  // 为什么日期层不能复用 lookupBase：那个已经被"当前日期范围"筛过一次，于是选中 2026-01 之后，
  // 月份层会显示「2 月 0 单」（真实 2 单）、「看整年」也只剩 1 单——「有记录的日期作标记」当场失效。
  // 用这一份基底时，格子里的数字仍等于"点下去会看到几单"（日期是唯一再叠上去的条件）。
  function lookupDateBase() {
    return data.orders.filter((o) => (lookup.status === "全部" || orderStage(o) === lookup.status) && lookupHit(o));
  }

  // 最终命中集合：基底再叠状态。三个条件取交集（规格）。
  function lookupMatch() {
    // 05 期：从核对清单「去查看这一单」进来时，按 **order id** 精确锁定这一单
    if (lookup.focusId) return data.orders.filter((o) => String(o.id) === String(lookup.focusId));
    // 05 二轮审查第 1 项：批次类核对项按 **batchId** 精确锁定——结果就是这一批的**全部成员**，
    // 不是"清空条件后的整本账"（大账本里目标批次可能离当前视窗十万八千里）。
    if (lookup.focusBatchId) return data.orders.filter((o) => String(o.batchId || "") === String(lookup.focusBatchId));
    const base = lookupBase();
    if (lookup.status === "全部") return base;
    return base.filter((o) => orderStage(o) === lookup.status);
  }

  function lookupDateLabel() {
    if (lookup.dateMode === "y") return `${lookup.y} 年`;
    if (lookup.dateMode === "ym") return `${lookup.y}-${pad2(lookup.m)}`;
    if (lookup.dateMode === "ymd") return `${lookup.y}-${pad2(lookup.m)}-${pad2(lookup.d)}`;
    if (lookup.dateMode === "bad") return "日期待核对";
    return "全部日期";
  }

  // 现算年月日三层的计数：年份 → 月份 → 日期 → 单数，另有「日期待核对」计数。
  // 年份/月份/日期的存在性完全由现有 order.date 派生（规格：不建年度/月度字段）。
  function lookupDateCounts() {
    const years = new Map();
    let bad = 0;
    lookupDateBase().forEach((o) => {
      const dt = parseDate(o.date);
      if (!dt) { bad++; return; }
      const y = dt.getFullYear(), mo = dt.getMonth() + 1, day = dt.getDate();
      if (!years.has(y)) years.set(y, { total: 0, months: new Map() });
      const yRec = years.get(y);
      yRec.total += 1;
      if (!yRec.months.has(mo)) yRec.months.set(mo, { total: 0, days: new Map() });
      const mRec = yRec.months.get(mo);
      mRec.total += 1;
      mRec.days.set(day, (mRec.days.get(day) || 0) + 1);
    });
    return { years, bad };
  }

  // 纯状态设置（不渲染）：渲染由调用方显式做，免得下钻时连渲染两遍。
  function lookupSetDate(mode, y, m, d) {
    lookup.dateMode = mode;
    lookup.y = mode === "all" || mode === "bad" ? 0 : y || 0;
    lookup.m = mode === "ym" || mode === "ymd" ? m || 0 : 0;
    lookup.d = mode === "ymd" ? d || 0 : 0;
  }

  // 日期导航面板：年 → 月 → 日三层，每层都能「直接看整层」，**不需要按几十次「上一月」**
  // （旧年份直接点在列表里选；只列有记录的年份，另加今年兜底）。
  function renderLookupDates() {
    const box = $("#lookupDates");
    if (!box) return;
    if (!lookup.panel) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    const { years, bad } = lookupDateCounts();
    const sel = (on) => (on ? " on" : "");
    const cell = (label, n, on, attr) => `<button type="button" class="lk-dcell${sel(on)}${n > 0 ? "" : " zero"}" ${attr}>`
      + `<span>${escapeHtml(label)}</span><span class="lk-n">${n} 单</span></button>`;
    const parts = [];

    // 每一层都先给这两个「跳出去」的口子：回全部日期 / 看日期待核对那一档
    const head = (label) => `<div class="lk-dnav">
      <span class="lk-dlabel">${escapeHtml(label)}</span>
      <button type="button" data-lkall="1">全部日期</button>
      <button type="button" data-lkbad="1">日期待核对${bad > 0 ? `（${bad}）` : ""}</button>
    </div>`;

    if (lookup.level === "year") {
      const list = [...years.keys()].sort((a, b) => b - a);
      // 今年即使一条都没有也给一个格子：用户可能正是要确认「今年还没记」
      if (!list.includes(new Date().getFullYear())) list.push(new Date().getFullYear());
      list.sort((a, b) => b - a);
      parts.push(head("选择年份"));
      parts.push(`<div class="lk-dgrid">${list.map((y) => cell(`${y} 年`, years.has(y) ? years.get(y).total : 0,
        lookup.dateMode === "y" && lookup.y === y, `data-lky="${y}"`)).join("")}</div>`);
      parts.push(`<p class="lk-dnote">数字＝当前关键词/状态下该年的单数；点年份＝看整年，再往下还能选月、选日。</p>`);
    } else if (lookup.level === "month") {
      const rec = years.get(lookup.y);
      parts.push(head(`${lookup.y} 年`));
      const cells = [];
      for (let mo = 1; mo <= 12; mo++) {
        const n = rec && rec.months.has(mo) ? rec.months.get(mo).total : 0;
        cells.push(cell(`${mo} 月`, n, lookup.dateMode === "ym" && lookup.y === lookup.y && lookup.m === mo, `data-lkm="${mo}"`));
      }
      parts.push(`<div class="lk-dgrid">${cells.join("")}</div>`);
      parts.push(`<div class="lk-dnav"><button type="button" data-lkyear="1">看整年（${rec ? rec.total : 0} 单）</button>`
        + `<button type="button" data-lkback="year">‹ 换年份</button></div>`);
    } else {
      const rec = years.get(lookup.y);
      const mRec = rec && rec.months.get(lookup.m);
      // 这个月的天数按**真日历**算（new Date(y, m, 0) 给出上个月最后一天）——闰年 2 月自然是 29 天。
      // 2 月 30 日这类不存在的日子根本不会出现在格子里（真出现也只能进「日期待核对」）。
      const days = new Date(lookup.y, lookup.m, 0).getDate();
      parts.push(head(`${lookup.y}-${pad2(lookup.m)}`));
      const cells = [];
      for (let dd = 1; dd <= days; dd++) {
        const n = mRec && mRec.days.has(dd) ? mRec.days.get(dd) : 0;
        cells.push(cell(`${dd} 日`, n, lookup.dateMode === "ymd" && lookup.y === lookup.y && lookup.m === lookup.m && lookup.d === dd, `data-lkd="${dd}"`));
      }
      parts.push(`<div class="lk-dgrid">${cells.join("")}</div>`);
      parts.push(`<div class="lk-dnav"><button type="button" data-lkmonth="1">看整月（${mRec ? mRec.total : 0} 单）</button>`
        + `<button type="button" data-lkback="month">‹ 换月份</button></div>`);
    }
    box.innerHTML = parts.join("");
  }

  // 查账结果里的批次表头：**块内保持与账本页同一个批次口径**（表头那些钱是整批的），
  // 但把「命中几单 / 整批几单」写在明面上，免得整批金额被误读成"命中这几单的合计"（规格要求）。
  function lookupBatchHeadHtml(g, hitIds, allMembers) {
    const hitCount = hitIds.size;
    const total = allMembers.length;
    const bits = [`垫付 ${money(g.costCents / 100)}`];
    if (g.feeCents > 0) bits.push(`邮费 ${money(g.feeCents / 100)}`);
    if (g.incomeCents > 0) bits.push(`回款 ${money(g.incomeCents / 100)}`);
    const expanded = lookup.expanded.has(g.id);
    return `<div class="batch-head lk-bh">
      <div class="bh-meta-row">
        <span class="bh-title">一起寄出 · ${escapeHtml(g.date)}</span>
        <span class="lk-hit">命中 ${hitCount} 单／整批 ${total} 单</span>
      </div>
      <div class="bh-meta">整批：${bits.join(" · ")}<span class="lk-whole">（整批口径，不是命中这几单的合计）</span></div>
      <div class="bh-meta-row">
        <button type="button" class="bh-act" data-lkwhole="${escapeHtml(g.id)}">${expanded
          ? `只看命中（${hitCount} 单）`
          : `查看完整批次（${total} 单）`}</button>
      </div>
    </div>`;
  }

  // 结果列表：同批在结果里**只出现一个批次块**（按 batchId 归组，成员跨购入日也只出一块、不复制表头、不造新 ID）。
  // 命中成员**直接可见、不折叠**（规格：匹配成员在查账模式下直接可见，不藏在默认折叠里）；
  // 「查看完整批次」再把未命中的成员补在下面，用一行分隔说明，随时可切回"只看命中"。
  function renderLookupList() {
    const listBox = $("#lookupList");
    if (!listBox) return;
    const sheet = listBox.closest(".sheet");
    const keepScroll = sheet ? sheet.scrollTop : 0;      // 重绘后把弹窗内的滚动位置还回去
    const matched = lookupMatch();
    const groups = batchGroups();
    const matchedIds = new Set(matched.map((o) => o.id));
    // 「全部条件都空着」时才叫全部；否则如实说这是"命中"（核对项焦点下也不是"全部"）
    const isAll = !lookup.focusId && !lookup.focusBatchId
      && lookupTokens().length === 0 && lookup.status === "全部" && lookup.dateMode === "all";

    const back = $("#lkFocusBack");
    // 05 期：只有"从核对项跳过来"时才出现返回入口（单笔与整批两种焦点都给）
    if (back) back.hidden = !lookup.focusId && !lookup.focusBatchId;
    $("#lookupScope").textContent = lookup.focusId ? "从核对清单定位到这一单"
      : lookup.focusBatchId ? "从核对清单定位到这一批（含全部成员）"
      : `${lookup.status} · ${lookupDateLabel()}`;
    $("#lookupDateBtn").textContent = lookupDateLabel() + (lookup.panel ? " ▴" : " ▾");
    $("#lookupMeta").innerHTML = matched.length === 0
      ? `没有找到符合的单子`
      : (isAll
        ? `本账本共 <b>${matched.length}</b> 单`
        : `命中 <b>${matched.length}</b> 单 · 本账本共 ${data.orders.length} 单`);

    if (matched.length === 0) {
      const hint = lookupTokens().length > 0
        ? `关键词「${escapeHtml(String(lookup.q).trim().slice(0, 40))}」没搜到；可以试试清空关键词或换日期范围`
        : "换个状态或日期范围看看";
      listBox.innerHTML = `<div class="empty">没有找到符合的单子<br><small>${hint}</small></div>`;
      if (sheet) sheet.scrollTop = keepScroll;
      return;
    }

    // 块的分组与排序照账本页同一套（块按下单日期倒序定位，同日保持账本数组里的先后，不制造互相矛盾的比较）。
    const blocks = [];
    const blockOf = new Map();
    matched.forEach((o) => {
      if (!o.batchId) { blocks.push({ id: "", date: o.date, orders: [o] }); return; }
      let b = blockOf.get(o.batchId);
      if (!b) { b = { id: o.batchId, date: o.date, orders: [] }; blockOf.set(o.batchId, b); blocks.push(b); }
      b.orders.push(o);
      if (o.date > b.date) b.date = o.date;
    });
    blocks.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
    lookup.expanded.forEach((id) => { if (!groups.has(id)) lookup.expanded.delete(id); });

    const parts = [];
    blocks.forEach((b) => {
      if (!b.id) {
        b.orders.forEach((o) => parts.push(orderCardHtml(o, "", false, { lookup: true, hit: true })));
        return;
      }
      const g = groups.get(b.id);
      const allMembers = data.orders.filter((o) => o.batchId === b.id);
      // 只剩一单的批次不撑表头（与账本页同一条规矩）：这一版没有"整批 vs 命中"可讲
      if (!g || allMembers.length <= 1) {
        const solo = !!g && allMembers.length === 1;
        b.orders.forEach((o) => parts.push(orderCardHtml(o, solo ? "in-batch" : "", solo, { lookup: true, hit: true })));
        return;
      }
      const hitIds = new Set(b.orders.map((o) => o.id));
      parts.push(`<div class="batch-block lk-block">`);
      parts.push(lookupBatchHeadHtml(g, hitIds, allMembers));
      b.orders.forEach((o) => parts.push(orderCardHtml(o, "in-batch", false, { lookup: true, hit: true })));
      if (lookup.expanded.has(b.id)) {
        const rest = allMembers.filter((o) => !matchedIds.has(o.id));
        if (rest.length > 0) {
          parts.push(`<div class="lk-rest">以下 ${rest.length} 单属于这一批但没命中本次查询</div>`);
          rest.forEach((o) => parts.push(orderCardHtml(o, "in-batch lk-miss", false, { lookup: true, hit: false })));
        }
      }
      parts.push(`</div>`);
    });
    listBox.innerHTML = parts.join("");
    if (sheet) sheet.scrollTop = keepScroll;
  }

  // 状态 chip：计数只回答「点下去会看到几单」（= 关键词＋日期筛完之后该状态的单数）。
  function renderLookupStatus() {
    const box = $("#lookupStatus");
    if (!box) return;
    const base = lookupBase();
    const counts = { "全部": base.length, "待寄": 0, "待回款": 0, "已回款": 0 };
    base.forEach((o) => { const st = orderStage(o); if (counts[st] !== undefined) counts[st] += 1; });
    box.innerHTML = LOOKUP_STATUSES.map((s) =>
      `<button type="button" class="chip${lookup.status === s ? " on" : ""}" data-lkstatus="${s}">${s}${counts[s] > 0 ? ` <b>${counts[s]}</b>` : ""}</button>`).join("");
  }

  // render() 里统一调它；面板没开时直接返回（对既有渲染路径零影响）。
  // 判据用 lookup.open 而**不是** `.show`：openLookup 里必须先 openModal 再渲染，但两者之间
  // 有一瞬是"已打开、类还没加上"；而"面板开着但被表单盖住/inert"时 `.show` 仍在，两种情形都要渲染。
  function renderLookup() {
    const modal = $("#lookupModal");
    if (!lookup.open || !modal) return;
    // 05 期：核对页签走自己的只读派生渲染，不碰查账那一套条件与结果
    if (lookup.tab === "check") { renderChecklist(); return; }
    renderLookupStatus();
    renderLookupDates();
    renderLookupList();
  }

  // 进入查账：每次都从「全部状态、全部日期、无关键词」开始（规格的默认态），不继承上次的条件。
  function openLookup() {
    lookup.open = true;
    lookup.q = "";
    lookup.status = "全部";
    lookup.dateMode = "all";
    lookup.y = 0; lookup.m = 0; lookup.d = 0;
    lookup.panel = false;
    lookup.level = "year";
    lookup.expanded.clear();
    lookup.tab = "search";                 // 05 期：每次进入都从查账页签开始
    lookup.focusId = "";
    lookup.focusBatchId = "";
    $("#lookupInput").value = "";
    $("#lookupDates").hidden = true;
    // 顺序要紧：先 openModal（把 .show 加上、并把焦点放到关键词框），再渲染——
    // 反过来的话 renderLookup 的判据还没成立，第一次进入会是一片空白。
    openModal("#lookupModal");
    renderLookup();
  }

  // 退出查账：只关自己这一层。**刻意什么都不还原**——因为从来没动过账本页的筛选/展开/位置，
  // 「还原」这件事是由"不碰"保证的，而不是由一串回写保证的（回写才是会把状态弄丢的那条路）。
  function closeLookup() {
    lookup.open = false;
    lookup.panel = false;
    lookup.expanded.clear();
    $("#lookupDates").hidden = true;
    closeModal("#lookupModal");
  }

  // ================= 02 期：寄出信息统一补录 =================
  // 目标：买到先记名称与价格 → 按单寄或合寄 → **寄出后一次补单号和邮费** → 到账再补回款。
  // 这一块只做"寄出"这一步，四条边界写在前面：
  //   ① **范围永远是确定的**：入口挂在卡片上，点批内单＝这一整批（全部成员），点散单＝这一单。
  //      面板里没有"选哪几单"这回事 ⇒ 结构上就不可能部分选批或跨批拆并（不是靠校验挡住的）。
  //   ② **一次保存＝一个候选账本、一次业务提交**：单号与邮费在任何写入之前一起算完，
  //      然后只调一次 saveData()。绝不串接两个各自落盘的旧回调（那会出现"写了一半"）。
  //   ③ **回款那一套一个字不碰**：income / incomeDate / status / batchIncome / batchIncomeShare
  //      全不在本面板的写入集合里，寄出保存不可能改变回款金额、状态或到账日期。
  //   ④ **不新增账本字段**：`order.date` 是购入日、`batchDate` 是批次寄出日；散单**没有**单独
  //      的寄出日期字段，本面板就**不记**散单寄出日——既不新增 schema，也绝不拿下单日顶替
  //      （这条受限能力记在 docs/ux-phases/02/BLOCKED.md，不当成缺陷偷偷绕过）。
  let shipTarget = null;      // { kind: "batch"|"loose", batchId?, id? }
  let shipSession = null;     // { generation, ids, snaps, trackingClear }：打开那一刻的形状
  let shipBaseHint = "";      // 单号那一格的"现状说明"（与"已点清空"那句互斥显示）

  // 一次打开的目标成员（**全部**，不是子集）：这批就是这批、这单就是这单。
  function shipMembers() {
    if (!shipTarget) return [];
    // v41：「寄出」新模式——范围是打开那一刻勾的这几单（按 data.orders 的顺序，分摊尾差与批量结算同源）
    if (shipTarget.kind === "new") {
      const want = new Set(shipTarget.ids);
      return data.orders.filter((o) => want.has(o.id));
    }
    if (shipTarget.kind === "loose") {
      const o = data.orders.find((x) => x.id === shipTarget.id);
      return o && !o.batchId ? [o] : [];
    }
    return data.orders.filter((o) => o.batchId === shipTarget.batchId);
  }

  // 整批邮费按**现有分摊权重与尾差算法**落到成员（与批量结算、恢复默认分摊同源：垫付占比 + 逐分尾差）。
  // 只算，不写——写发生在 submitShip 的唯一一次提交里。
  function shipFeePlan(members, feeGiven, feeCents) {
    if (!feeGiven) return null;
    const weights = members.map((o) => Math.max(0, toCents(o.cost)));
    const shares = splitByWeight(feeCents, weights);
    if (!validShares(shares, feeCents)) return null;
    return shares;
  }

  // 已有的单号现状：**混合就是混合**，既不取第一条覆盖、也不自动统一（规格明文禁止）。
  function shipTrackingState(members) {
    const values = [...new Set(members.map((o) => cleanTracking(o.tracking)).filter(Boolean))];
    if (values.length === 0) return { kind: "empty", values };
    if (values.length === 1) return { kind: "same", values };
    return { kind: "mixed", values };
  }

  // v41：「寄出」（新模式）——把**待寄**的一单或几单标记为已寄出，同一次提交写齐：
  //   寄出日期（shipDate）＋ 单号（填了才写）＋ 邮费（留空＝不改各单已有邮费；新记的单本来就是 0）。
  //   几单「一起寄」＝当场建成一批：批次字段的写法与批量结算「两框留空 / 只填邮费」那条既有路径逐字段同款
  //   （batchId / batchDate=寄出日期 / batchCount / batchFee=填的整批邮费或各单现有邮费之和 /
  //    batchIncome=各单现有回款之和 / 填了邮费才写 fee 与 batchFeeShare）；回款、状态一个字都不碰。
  //   「各自寄 / 只标记已寄」＝不成批，只写寄出日期（单号邮费之后在每单的「改单号/邮费」里补）。
  let shipTogether = true;
  function applyShipTogetherUi() {
    const isNew = !!(shipTarget && shipTarget.kind === "new");
    const n = isNew ? shipTarget.ids.length : 0;
    const separate = isNew && n > 1 && !shipTogether;
    $$("#shipTogetherRow .seg").forEach((b) => b.classList.toggle("on", (b.dataset.together === "1") === shipTogether));
    $("#shipModal").classList.toggle("ship-separate", separate);
    if (isNew) {
      $("#shipSubmit").textContent = separate ? `标记 ${n} 单已寄出` : "保存并复制报单";
      $("#shipScopeNote").textContent = n === 1 ? ""
        : separate ? "各自寄：只把这几单标记为已寄出（不成批）；单号和邮费之后在每单的「改单号/邮费」里补。"
          : "一起寄：这几单记成一批，单号写到每一单上；邮费填整批合计，按各单垫付占比分摊。";
      $("#shipFeeHint").textContent = n > 1 && !separate
        ? "整批合计；留空＝不改各单已有邮费，填 0＝明确 0。"
        : "留空＝不改（新记的单本来就是 0），填 0＝明确 0。";
    }
  }

  function openShipForm(target) {
    if (target.kind === "new") return openShipNew(target);
    $("#shipModal").classList.remove("ship-new", "ship-separate");
    $("#shipTogetherRow").hidden = true;
    $("#shipDateRow").hidden = true;
    $("#shipTitleText").textContent = "寄出信息";
    $("#shipSubmit").textContent = "保存寄出信息";
    $("#shipTracking").placeholder = "留空＝不改";
    $("#shipFee").placeholder = "留空＝不改";
    const members = (() => {
      if (target.kind === "loose") {
        const o = data.orders.find((x) => x.id === target.id);
        return o && !o.batchId ? [o] : [];
      }
      return data.orders.filter((o) => o.batchId === target.batchId);
    })();
    if (members.length === 0) { toast("这一单已经不在账本里了，请重新打开"); return; }
    shipTarget = target.kind === "batch" ? { kind: "batch", batchId: target.batchId } : { kind: "loose", id: target.id };
    // 会话快照：打开这一刻的成员集合与逐单形状。提交时对表，对不上整笔拒绝（旧面板不许改新账）。
    shipSession = {
      generation: ledgerGeneration,
      ids: members.map((o) => o.id).sort(),
      snaps: new Map(members.map((o) => [o.id, orderSnap(o)])),
      // 单号那一格"算不算给了意图"只看**当前值**与"是否点了清空"这两件事，**不看是否打过字**：
      //   · 填了非空值            ⇒ 写成这个值
      //   · 点了「清空」小按钮     ⇒ 明确要清空（写成空串）
      //   · 其余（含"打过字又全删掉"）⇒ 留空＝不改
      // 早先只用旗标 trackingTouched（只置不复位）是有缺陷的：输入→删空→保存会把空串写进整批每一单，
      // 而面板文案还写着"留空＝不动"——独立复核抓到这条，已改。
      trackingClear: false,
    };

    const isBatch = shipTarget.kind === "batch";
    const totalCost = members.reduce((a, o) => a + numberValue(o.cost), 0);
    $("#shipScopeLabel").textContent = isBatch ? `整批 ${members.length} 单` : "单寄一单";
    $("#shipScopeNote").textContent = isBatch
      ? `范围＝这一整批（${members.length} 单，垫付合计 ${money(totalCost)}）。一起寄的一批只有一笔邮费，`
        + `填在下面会按各单垫付占比摊到成员上；单号会写到这一批每一单上。`
      : `范围＝这一单。这一趟只改单号与邮费（寄出日期、回款与状态不动）。`;
    $("#shipMembers").innerHTML = members.map((o) => `<div class="batch-item"><span class="bi-name">`
      + `${escapeHtml(o.name || "未命名")}</span><span class="bi-cost">${money(o.cost)}</span></div>`).join("");
    // 2026-09-27 补强 D：成员名单收进可折叠块——摘要恒写范围与单数（折叠不改变范围）；
    // 短名单默认展开（看得见全体成员），长名单默认收起（输入框不用滚半屏才够到）。
    const fold = $("#shipMembersBox");
    if (fold) {
      const label = $("#shipMembersLabel");
      if (label) {
        label.textContent = isBatch
          ? `成员明细 · 整批 ${members.length} 单 · 垫付合计 ${money(totalCost)}（范围＝这一整批，不含批外单）`
          : `成员明细 · 单寄这一单 · 垫付 ${money(totalCost)}`;
      }
      fold.open = members.length <= 8;
    }

    const st = shipTrackingState(members);
    shipBaseHint = st.kind === "empty"
      ? "现在还没有单号；留空＝不动、填了才记。"
      : st.kind === "same"
        ? `现在记着 ${st.values[0]}；留空＝不动（不会重复写）。`
        : `现有单号「不一致」（${st.values.join(" / ")}）。留空＝逐条保持原样；要统一才在这里填，填了就写到这一批每一单上。`;
    updateShipTrackingHint();
    const curFee = isBatch
      ? (batchGroups().get(shipTarget.batchId) || { feeCents: 0 }).feeCents / 100
      : numberValue(members[0].fee);
    $("#shipFeeHint").textContent = isBatch
      ? `这一批现在记着整批邮费 ${money(curFee)}；填 0＝明确改成 0。`
      : `现在记着邮费 ${money(curFee)}；填 0＝明确改成 0。`;

    $("#shipTracking").value = "";
    $("#shipFee").value = "";
    openModal("#shipModal");
  }

  function openShipNew(target, opts = {}) {
    const want = new Set(target.ids || []);
    const members = data.orders.filter((o) => want.has(o.id));
    if (members.length === 0 || members.length !== want.size) { toast("勾选的单已经变了，请重新勾选"); return; }
    if (members.some((o) => o.status !== "在途" || isShipped(o))) { toast("勾选里有单已经不是「待寄」了，请重新勾选"); return; }
    shipTarget = { kind: "new", ids: members.map((o) => o.id) };
    shipSession = {
      generation: ledgerGeneration,
      ids: members.map((o) => o.id).sort(),
      snaps: new Map(members.map((o) => [o.id, orderSnap(o)])),
      trackingClear: false,
    };
    // 升级前就记下的老单默认「各自寄 / 只标记已寄」（不当场成批，免得改动老邮费的归期）
    const allLegacy = !!meta.v41FirstSeen && members.every((o) => String(o.createdAt || "") < meta.v41FirstSeen);
    shipTogether = opts.together === undefined ? !allLegacy : opts.together !== false;
    const n = members.length;
    const totalCost = members.reduce((a, o) => a + numberValue(o.cost), 0);
    const modal = $("#shipModal");
    modal.classList.add("ship-new");
    $("#shipTitleText").textContent = "寄出";
    $("#shipScopeLabel").textContent = `${n} 单`;
    $("#shipTogetherRow").hidden = n < 2;
    $("#shipDateRow").hidden = false;
    $("#shipDate").value = todayStr();
    $("#shipMembers").innerHTML = members.map((o) => `<div class="batch-item"><span class="bi-name">`
      + `${escapeHtml(o.name || "未命名")}</span><span class="bi-cost">×${qtyOf(o)} · ${money(o.cost)}</span></div>`).join("");
    const fold = $("#shipMembersBox");
    if (fold) {
      const label = $("#shipMembersLabel");
      if (label) label.textContent = `这次寄的 ${n} 单 · 垫付合计 ${money(totalCost)}`;
      fold.open = n <= 8;
    }
    shipBaseHint = n > 1 ? "可空；一起寄时写到这几单每一单上。" : "可空；没有单号也能标记寄出。";
    updateShipTrackingHint();
    $("#shipTracking").value = "";
    $("#shipFee").value = "";
    $("#shipTracking").placeholder = "可空";
    $("#shipFee").placeholder = n > 1 ? "整批合计，可空" : "可空";
    applyShipTogetherUi();
    openModal("#shipModal");
  }

  function submitShipNew() {
    const members = shipMembers();
    const n = shipTarget.ids.length;
    if (members.length !== n) { toast("勾选的单已经变了，这次没有保存，请重新勾选"); return false; }
    const separate = n > 1 && !shipTogether;
    const shipDate = cleanShipDate($("#shipDate").value);
    if (!shipDate) { toast("寄出日期填写有误"); return false; }
    const tracking = separate ? "" : cleanTracking($("#shipTracking").value);
    const trackingGiven = tracking !== "";
    const feeRaw = separate ? "" : String($("#shipFee").value || "").trim();
    const feeGiven = feeRaw !== "";
    if (feeGiven && !validAmountInputs([$("#shipFee")])) return false;
    const fee = feeGiven ? numberValue(feeRaw) : 0;
    if (feeGiven && fee < 0) { toast("邮费不能是负数"); return false; }
    const feeCents = feeGiven ? toCents(fee) : 0;
    const together = n > 1 && !separate;
    const plan = together && feeGiven ? shipFeePlan(members, true, feeCents) : null;
    if (together && feeGiven && !plan) { toast("分摊校验未通过，账本没有改动"); return false; }

    const ids = shipTarget.ids.slice();
    // 注意：withLedgerWrite 在有 Web Locks 时是**异步**的（排队拿锁）。关面板、报单这些后续动作
    // 必须放在写入回调里、确认 saveData 成功之后再做（与 submitShip 同一写法），不能看返回值就关。
    return withLedgerWrite(() => {
      const now = shipMembers();
      if (!shipSession || shipSession.generation !== ledgerGeneration
        || JSON.stringify(now.map((o) => o.id).sort()) !== JSON.stringify(shipSession.ids)) {
        toast("勾选的单已经变了，这次没有保存，请重新勾选"); return false;
      }
      if (now.some((o) => shipSession.snaps.get(o.id) !== orderSnap(o))) {
        toast("这几单的内容已变化，这次没有保存，请重新核对"); return false;
      }
      if (now.some((o) => o.status !== "在途" || isShipped(o))) {
        toast("勾选里有单已经不是「待寄」了，这次没有保存"); return false;
      }
      const undoBefore = clone(data.orders);
      if (together) {
        const broughtFee = now.reduce((a, o) => a + toCents(o.fee), 0);
        const broughtIncome = now.reduce((a, o) => a + toCents(o.income), 0);
        if (broughtIncome < 0) {
          toast(`这几单的回款合计是 ${money(broughtIncome / 100)}（负数），账本表示不了负的整批回款，本次没寄出`);
          return false;
        }
        const batchId = uid();
        const batchFeeCents = feeGiven ? feeCents : broughtFee;
        if (feeGiven) {
          const feeById = new Map(now.map((o, i) => [o.id, plan[i]]));
          now.forEach((o) => { o.fee = feeById.get(o.id) / 100; o.batchFeeShare = feeById.get(o.id); });
        } else {
          // 邮费留空：整批口径＝各单现有邮费之和，份额就记各单现有邮费（分）。否则份额全 0 时，
          // 之后「退出本批」会按垫付权重反推扣减，与成员实际邮费对不上，表头亮假的「≠」。
          now.forEach((o) => { o.batchFeeShare = Math.max(0, toCents(o.fee)); });
        }
        now.forEach((o) => {
          if (trackingGiven) o.tracking = tracking;
          o.shipDate = shipDate;
          o.batchId = batchId;
          o.batchDate = shipDate;
          o.batchFee = batchFeeCents / 100;
          o.batchIncome = broughtIncome / 100;
          o.batchCount = now.length;
        });
      } else {
        now.forEach((o) => {
          o.shipDate = shipDate;
          if (n === 1 && trackingGiven) o.tracking = tracking;
          if (n === 1 && feeGiven) o.fee = fee;
        });
      }
      if (!saveData()) return false;
      ids.forEach((id) => selection.delete("o:" + id));
      closeShipForm();
      renderList();
      offerUndo(separate ? `已标记 ${n} 单寄出` : `已寄出 ${n} 单`, undoBefore);
      if (separate) { toast(`已标记 ${n} 单寄出`); return true; }
      // 寄完就报单：紧接着打开报单面板并写剪贴板（与「报单」按钮同一条复制路径）；复制失败面板里有按钮再点一次
      openBaodan({ type: "ids", ids });
      return true;
    });
  }

  // v41：已寄出的散单改回待寄（寄错了/记错了）。只清寄出日期与单号；邮费、回款、状态一个字都不碰。
  // 批内单不走这里（先「退出本批」，避免拆批口径）。
  function unshipOrder(id) {
    const o = data.orders.find((x) => x.id === id);
    if (!o) return;
    if (o.status !== "在途" || o.batchId) { toast("只有没成批、还在途的单能改回待寄"); return; }
    if (!confirm(`把「${o.name || "未命名"}」改回待寄？\n会清掉它的寄出日期和单号（邮费保留）。`)) return;
    const snap = orderSnap(o), gen = ledgerGeneration;
    withLedgerWrite(() => {
      const cur = data.orders.find((x) => x.id === id);
      if (!cur || gen !== ledgerGeneration || orderSnap(cur) !== snap) { toast("这一单已变化，没有改动，请重新核对"); return false; }
      const undoBefore = clone(data.orders);
      cur.shipDate = ""; cur.tracking = "";
      if (!saveData()) return false;
      toast("已改回待寄");
      offerUndo("已改回待寄", undoBefore);
      return true;
    });
  }

  function closeShipForm() {
    closeModal("#shipModal");
    shipTarget = null;
    shipSession = null;
    shipBaseHint = "";
  }

  // 单号那一格的说明：平时说"现在记着什么"；用户点了「清空」就换成"保存会清掉什么"。
  // 两句话互斥显示，免得用户看到"留空＝不动"却其实已经表达了清空意图。
  function updateShipTrackingHint() {
    const el = $("#shipTrackingHint");
    if (!el) return;
    if (shipSession && shipSession.trackingClear && !(shipTarget && shipTarget.kind === "new")) {
      el.textContent = shipTarget && shipTarget.kind === "batch"
        ? "已点「清空」：保存会把这一批每一单的单号一起清掉。"
        : "已点「清空」：保存会清掉这一单的单号。";
      return;
    }
    el.textContent = shipBaseHint;
  }

  // 唯一的一次提交：所有校验与整笔写入计划都在任何改动之前算完，只调一次 saveData()。
  function submitShip() {
    if (!shipTarget) return;
    if (shipTarget.kind === "new") return submitShipNew();
    const members = shipMembers();
    if (members.length === 0) { toast("这一单已经不在账本里了，这次没有保存"); return; }
    const isBatch = shipTarget.kind === "batch";
    // —— 单号：**留空＝不改**（不管用户是不是打过字又全删掉）；填了非空值＝写成它；
    //    点了「清空」＝明确清空（写成空串）。判据只看这两件事，见 shipSession.trackingClear 的说明。——
    const tracking = cleanTracking($("#shipTracking").value);
    const trackingGiven = tracking !== "" || !!(shipSession && shipSession.trackingClear);
    // —— 邮费：留空＝不改；填数字＝改成这个数（0 也是明确意图）——
    const feeRaw = String($("#shipFee").value || "").trim();
    const feeGiven = feeRaw !== "";
    if (feeGiven && !validAmountInputs([$("#shipFee")])) return;
    const fee = feeGiven ? numberValue(feeRaw) : 0;
    if (feeGiven && fee < 0) { toast("邮费不能是负数"); return; }
    if (!trackingGiven && !feeGiven) { toast("单号与邮费都没改，这次没有保存"); return; }
    const feeCents = feeGiven ? toCents(fee) : 0;
    const plan = isBatch ? shipFeePlan(members, feeGiven, feeCents) : null;
    if (isBatch && feeGiven && !plan) { toast("分摊校验未通过，账本没有改动"); return; }

    return withLedgerWrite(() => {
      // 写守门内重新核一遍范围与会话：成员集合变了、或任何一单被别的入口改过、或整包换过账本，
      // 这一笔就整笔拒绝（过期面板不许改旧成员集合、更不许部分写账）。
      const now = shipMembers();
      const nowIds = now.map((o) => o.id).sort();
      if (!shipSession || shipSession.generation !== ledgerGeneration
        || JSON.stringify(nowIds) !== JSON.stringify(shipSession.ids)) {
        toast("这一批的成员已变化，这次没有保存，请重新打开核对");
        return false;
      }
      const moved = now.filter((o) => shipSession.snaps.get(o.id) !== orderSnap(o));
      if (moved.length > 0) {
        toast("这一单的内容已变化，这次没有保存，请重新打开核对");
        return false;
      }
      // 到这里才开始改：单号（若用户给了）与邮费（若用户给了）在**同一次**改动里一起落。
      if (trackingGiven) now.forEach((o) => { o.tracking = tracking; });
      if (feeGiven) {
        if (isBatch) {
          // 与批量结算那条既有路径**逐字同款**的写法（成员 fee = 新份额、份额字段同写、整批口径 = 新总额）。
          // 只写 fee / batchFeeShare / batchFee 三项；income、incomeDate、status、batchIncome、
          // batchIncomeShare、batchDate、batchCount 一个字都不碰（寄出保存不可能改回款，也不动归期）。
          const feeById = new Map(now.map((o, i) => [o.id, plan[i]]));
          now.forEach((o) => { o.fee = feeById.get(o.id) / 100; o.batchFeeShare = feeById.get(o.id); });
          now.forEach((o) => { o.batchFee = fee; });
        } else {
          now[0].fee = fee;
        }
      }
      if (!saveData()) return false;
      const bits = [];
      if (trackingGiven) bits.push(tracking ? `单号 ${tracking}` : "单号已清空");
      if (feeGiven) bits.push(isBatch ? `整批邮费 ${money(fee)}` : `邮费 ${money(fee)}`);
      toast(`已保存寄出信息：${bits.join(" · ")}${isBatch ? `（${now.length} 单）` : ""}`);
      closeShipForm();
      return true;
    });
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
    profit = displayedAmount(profit);
    Object.values(byName).forEach((g) => { g.profit = displayedAmount(g.profit); });
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
  // v41：赚红亏绿（用户选定）。gain / loss 与 styles.css 的 --gain / --loss 同值
  const SERIES_COLOR = { cost: "#7d8fa1", income: "#14b8a6", gain: "#d23f31", loss: "#2e8b4e" };
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
    const minV = Math.min(0, ...stats.map((s) => Math.min(s.cost, s.income)));
    const x = (i) => padL + (n === 1 ? innerW / 2 : i * innerW / (n - 1));
    const y = (v) => padT + innerH - ((v - minV) / (maxV - minV)) * innerH;
    const zeroY = y(0);
    let grid = "";
    [0, .5, 1].forEach((f) => {
      const gy = padT + innerH - f * innerH;
      grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" style="stroke:var(--line)" stroke-dasharray="3 4"/>`;
    });
    grid += `<text x="${padL + 2}" y="${padT + 4}" font-size="9" style="fill:var(--muted)">至多 ${money(maxV)}</text>`;
    if (minV < 0) {
      grid += `<line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${W - padR}" y2="${zeroY.toFixed(1)}" style="stroke:var(--muted)"/>`;
      grid += `<text x="${padL + 2}" y="${(padT + innerH - 3).toFixed(1)}" font-size="9" style="fill:var(--muted)">最低 ${money(minV)}</text>`;
    }
    const path = (key) => stats.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s[key]).toFixed(1)}`).join(" ");
    const area = (key, gid) => n === 1 ? "" :
      `<path d="${path(key)} L${x(n - 1).toFixed(1)},${zeroY.toFixed(1)} L${x(0).toFixed(1)},${zeroY.toFixed(1)} Z" fill="url(#${gid})"/>`;
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
    // v42：「在途」那句与统计页顶部英雄卡重复，打上类名由 CSS 收起（文字仍在 DOM）。
    $("#reportSummary").innerHTML = lines.map((l) => `<p${l.startsWith("现在还有") ? ' class="rs-out"' : ""}>${l}</p>`).join("");

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
      if (b.conflictFields.length) nums.push("整批口径不一致，请核对；当前邮费按表列日期展示");
      if (!b.conflictFields.length && b.entryFeeCents !== b.feeCents) {
        nums.push(`整批录的是 邮费 ${money(b.entryFeeCents / 100)}，与成员合计不同`);
      }
      if (!b.conflictFields.length && b.entryIncomeCents !== b.incomeCents) {
        nums.push(`整批录的是 回款 ${money(b.entryIncomeCents / 100)}，与成员合计不同`);
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
        </div>`).join("");    renderMonthProfit();
  }

  // v41：每月利润（近 12 个月，按回款月份的净盈亏）。口径与月报**同一个函数** reportStats——
  // 所以点某根柱子切到那个月的月报，看到的「净盈亏」必然与柱子一致。赚红亏绿（SERIES_COLOR）。
  function renderMonthProfit() {
    const box = $("#monthProfit");
    if (!box) return;
    const now = new Date();
    const months = [];
    for (let k = 11; k >= 0; k -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
      const cur = { y: d.getFullYear(), m: d.getMonth() };
      const r = repRange("month", cur);
      months.push({ cur, label: `${cur.m + 1}月`, ym: r.label, cents: toCents(reportStats(r.start, r.end).profit) });
    }
    const sel = reportMode === "month" ? `${repCursor.y}-${pad2(repCursor.m + 1)}` : "";
    const total = months.reduce((a, m) => a + m.cents, 0);
    const active = months.filter((m) => m.cents !== 0).length;
    // v42：回报率＝这 12 个月里有回款的单「利润合计 ÷ 垫付合计」（与月报同一归期：按回款日期）
    const winStart = repRange("month", months[0].cur).start, winEnd = repRange("month", months[11].cur).end;
    let roiCost = 0;
    data.orders.forEach((o) => {
      if (!hasIncome(o)) return;
      const d = parseDate(o.incomeDate);
      if (d && d >= winStart && d < winEnd) roiCost += toCents(o.cost);
    });
    const roi = roiText(total, roiCost);
    $("#mpSummary").innerHTML = `近 12 个月合计 <b class="${total > 0 ? "pos" : total < 0 ? "neg" : ""}">${money(total / 100)}</b>`
      + (roi ? ` · 回报率 <b class="${total > 0 ? "pos" : total < 0 ? "neg" : ""}">${roi}</b>` : "")
      + (active ? ` · 有回款的月份平均 <b>${money(Math.round(total / active) / 100)}</b>` : "");
    const W = 336, H = 150, top = 22, bottom = 22, gap = 6;
    const maxAbs = Math.max(1, ...months.map((m) => Math.abs(m.cents)));
    const hasNeg = months.some((m) => m.cents < 0);
    const hasPos = months.some((m) => m.cents > 0);
    const plotH = H - top - bottom;
    const zeroY = top + (hasNeg && hasPos ? plotH / 2 : hasNeg ? 0 : plotH);
    const scale = (hasNeg && hasPos ? plotH / 2 : plotH) / maxAbs;
    const bw = (W - gap * 11) / 12;
    const bars = months.map((m, i) => {
      const x = i * (bw + gap);
      const h = Math.max(m.cents === 0 ? 0 : 2, Math.abs(m.cents) * scale);
      const y = m.cents >= 0 ? zeroY - h : zeroY;
      const on = m.ym === sel;
      const color = m.cents >= 0 ? SERIES_COLOR.gain : SERIES_COLOR.loss;
      // 柱顶数字：上万写成「¥1.2万」；靠左/靠右两端的柱子把文字往里对齐，任何金额都不出图（37.22 抓到过出界）
      const short = Math.abs(m.cents) >= 1000000
        ? `${m.cents < 0 ? "-" : ""}¥${(Math.abs(m.cents) / 1000000).toFixed(Math.abs(m.cents) >= 100000000 ? 0 : 1)}万`
        : money(m.cents / 100);
      const anchor = i <= 1 ? "start" : i >= 10 ? "end" : "middle";
      const tx = anchor === "start" ? x : anchor === "end" ? x + bw : x + bw / 2;
      const val = on || (m.cents !== 0 && Math.abs(m.cents) === maxAbs)
        ? `<text x="${tx.toFixed(1)}" y="${(m.cents >= 0 ? y - 5 : y + h + 12).toFixed(1)}" text-anchor="${anchor}" class="mp-val">${escapeHtml(short)}</text>` : "";
      return `<g class="mp-bar${on ? " on" : ""}" data-ym="${m.cur.y}-${m.cur.m}" role="button" tabindex="0" aria-label="${escapeHtml(m.ym)} 利润 ${escapeHtml(money(m.cents / 100))}">
        <rect x="${x.toFixed(1)}" y="${top - 6}" width="${bw.toFixed(1)}" height="${H - top - 2}" fill="transparent"/>
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${color}" opacity="${on ? 1 : .55}"/>
        ${val}
        <text x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="mp-lab">${m.label}</text></g>`;
    }).join("");
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="近 12 个月每月利润">
      <line x1="0" x2="${W}" y1="${zeroY.toFixed(1)}" y2="${zeroY.toFixed(1)}" class="mp-zero"/>${bars}</svg>`;
  }

  // 点某个月 → 下方月报切到那个月（模式切成「月」），并滚到月报
  function pickProfitMonth(key) {
    const [y, m] = String(key || "").split("-").map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m)) return;
    reportMode = "month";
    $$("#repModes .seg").forEach((c) => c.classList.toggle("on", c.dataset.mode === "month"));
    repCursor = { y, m };
    renderReport();
    const head = $(".rep-head");
    if (head && head.scrollIntoView) head.scrollIntoView({ behavior: "smooth", block: "start" });
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
    f.querySelectorAll(".kind-order input, .kind-order select").forEach((input) => { input.disabled = income; });
    // v41：编辑时隐藏的邮费格退出浏览器原生校验（disabled 不参与校验；值仍可读，保存取原单的值）
    f.fee.disabled = income || !!editingId;
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
    // 03 期：连续录入中的下一单，渠道默认是**清空**（或用户勾了保留才沿用的那个），
    // 不能再被打回「收货商」——那正是规格要防的"把上一单的渠道悄悄带过来"的另一面。
    if (!channelTouched) f.channel.value = income ? INCOME_CHANNEL : (chainSession.active ? chainSession.channel : "收货商");
    if (income) {
      if (!String(f.goods.value || "").trim()) { f.goods.value = INCOME_NAME; nameAuto = true; }
    } else if (nameAuto && String(f.goods.value || "").trim() === INCOME_NAME) {
      f.goods.value = "";        // 收回我们替他填的默认名：货单表单不该自带商品名
      nameAuto = false;
    }
    applyKindUi();
    applyChainUi();   // 切到收入模式时「保存并继续」「保留本次渠道」必须跟着消失
  }

  // ================= 05 期：待补信息与核对清单 =================
  // 用**轻量派生清单**指出值得人工核对的账目，并把用户带到已有的查找/补录入口（01 的查账、02 的补寄出）。
  // 只读：不写账、不生成待办字段、不发提醒、不创造状态/截止日/逾期结论、不改任何订单状态。
  // 严格区分"空"与"0"（规格点名的红线）：
  //   · income 缺失/空串  ⇒ 待补回款；**income: 0 是合法金额，绝不算缺回款**
  //   · fee: 0 可以代表包邮 ⇒ **不能当漏邮费**，本清单根本不派生"缺邮费"
  //   · tracking 为空 ⇒ 不能证明未发货 ⇒ 只作**可选、低优先级**的查找入口，不列高危
  //   · 归期一律用项目现成的 parseDate（真日历回读校验）判；无效日期**不补成今天**，也不推断逾期
  // 批次只沿用现有批次组与金额校验口径（batchDrift），把**实际差异**展示出来供人查，不自动重摊、不改金额。
  function checklistItems() {
    const items = [];
    const locate = (o) => `${escapeHtml(String(o.date || ""))} · ${escapeHtml(o.name || "未命名")}`
      + (cleanTracking(o.tracking) ? ` · 单号 ${escapeHtml(cleanTracking(o.tracking))}` : "");
    // ① 在途＝尚未结清（状态事实，不是错误；**不自行更改状态**）
    data.orders.filter((o) => o.status === "在途").forEach((o) => {
      items.push({
        kind: "pending", level: "info", id: o.id, sortDate: String(o.date || ""),
        title: "还挂在在途（垫付未回笼）", who: locate(o),
        money: `垫付 ${money(o.cost)}${numberValue(o.fee) > 0 ? ` · 邮费 ${money(o.fee)}` : ""}`,
      });
    });
    // ② 已回款但没记回款金额：判据是项目唯一那一支 hasIncome（空串/缺失才算；0 不算）
    data.orders.filter((o) => o.status === "已回款" && !hasIncome(o)).forEach((o) => {
      items.push({
        kind: "income-missing", level: "todo", id: o.id, sortDate: String(o.date || ""),
        title: "已回款，但没记回款金额", who: locate(o),
        money: `垫付 ${money(o.cost)} · 邮费 ${money(o.fee)}`,
      });
    });
    // ③ 有回款金额、却没有有效的到账日期（按 parseDate 的真日历校验判；不补成今天）
    data.orders.filter((o) => hasIncome(o) && !parseDate(o.incomeDate)).forEach((o) => {
      items.push({
        kind: "income-date", level: "todo", id: o.id, sortDate: String(o.date || ""),
        title: "回款金额有，但到账日期缺失或不是有效日期", who: locate(o),
        money: `回款 ${money(o.income)} · 记的到账日期「${escapeHtml(String(o.incomeDate ?? "（空）"))}」`,
      });
    });
    // ④ 批次差异：**只沿用现有口径**（batchDrift 与表头同源），把差异原样列出来
    batchGroups().forEach((g, id) => {
      const members = batchMembers(id);
      if (members.length === 0) return;
      const batchCount = members.reduce((a, o) => Math.max(a, Math.round(numberValue(o.batchCount))), 0);
      batchDrift(g, members, batchCount).forEach((n, i) => {
        items.push({
          kind: n.warn ? "batch-drift" : "batch-note", level: n.warn ? "warn" : "info",
          batchId: id, sortDate: String(g.date || ""), seq: i,
          title: n.warn ? "一起寄出的这一批：整批口径与成员明细对不上" : "一起寄出的这一批：有成员不在其中了",
          who: `批次 ${escapeHtml(String(g.date || ""))} · 当前 ${members.length} 单`,
          money: n.text,
        });
      });
    });
    // ⑤ 还没记快递单号：**可选、低优先级**（空单号证明不了没发货，所以不列高危、也不改状态）
    data.orders.filter((o) => !cleanTracking(o.tracking) && o.status === "在途").forEach((o) => {
      items.push({
        kind: "no-tracking", level: "low", id: o.id, sortDate: String(o.date || ""),
        title: "还没记快递单号（可选，不代表没发货）", who: locate(o), money: "",
      });
    });
    // 去重：同一问题按「订单/批次 + 问题类型」只出现一次（seq 让同一批的不同提示各自成条，不互相吞掉）
    const seen = new Set();
    return items.filter((it) => {
      const key = `${it.kind}|${it.id || it.batchId || ""}|${it.seq || 0}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const CHECK_GROUPS = [
    { level: "warn", label: "整批口径待对账" },
    { level: "todo", label: "待补 / 待核对" },
    { level: "info", label: "在途未结清（只是状态）" },
    { level: "low", label: "可选" },
  ];
  // 要动手的项 = warn + todo（页签上那个数字只数它们；没有问题时不显示数字、也不常驻告警）
  const checkActionable = (items) => items.filter((it) => it.level === "warn" || it.level === "todo").length;

  function renderChecklist() {
    const box = $("#checkList");
    if (!box) return;
    const all = checklistItems();
    const actionable = checkActionable(all);
    const badge = $("#lkCheckCount");
    if (badge) { badge.hidden = actionable === 0; badge.textContent = actionable > 0 ? String(actionable) : ""; }
    const meta = $("#lkCheckMeta");
    if (meta) {
      meta.innerHTML = all.length === 0
        ? `这份账本没有需要核对的项。`
        : `派生自查现有字段，「只读」：不写账、不改状态、不推断逾期。共 <b>${all.length}</b> 项`
          + (actionable > 0 ? `，其中 <b>${actionable}</b> 项值得动手核对。` : `，没有需要动手的项。`);
    }
    if (all.length === 0) {
      box.innerHTML = `<div class="chk-empty">没有需要核对的项 ✓</div>`;
      return;
    }
    const parts = [];
    CHECK_GROUPS.forEach((grp) => {
      const list = all.filter((it) => it.level === grp.level)
        .sort((a, b) => (a.sortDate === b.sortDate ? 0 : a.sortDate < b.sortDate ? 1 : -1));
      if (list.length === 0) return;
      parts.push(`<div class="chk-group"><div class="chk-head ${grp.level}">${grp.label}`
        + `<span class="chk-n">${list.length} 项</span></div>`);
      list.forEach((it) => {
        parts.push(`<div class="chk-item" data-chk-kind="${escapeHtml(it.kind)}">`
          + `<div class="ci-title">${escapeHtml(it.title)}</div>`
          + `<div class="ci-who">${it.who}</div>`
          + (it.money ? `<div class="ci-money">${escapeHtml(it.money)}</div>` : "")
          + `<div class="ci-act"><button type="button" data-chk-go="${escapeHtml(it.id || "")}"`
          + ` data-chk-batch="${escapeHtml(it.batchId || "")}">去查看这一单</button></div></div>`);
      });
      parts.push(`</div>`);
    });
    box.innerHTML = parts.join("");
  }

  // 从核对项跳到 01 的查账视图并**精确定位**（单笔按 order id、批次按 batchId 锁定成员集合，不靠名字/单号猜）。
  // 写操作仍然要重新核对当前订单 ID 与整个批次（02 自己的守门），这里只是"带路"。
  function checklistGoTo(id, batchId) {
    setLookupTab("search");
    if (id) {
      lookup.focusId = id;
      lookup.focusBatchId = "";
      lookup.q = "";
      lookup.status = "全部";
      lookupSetDate("all");
      lookup.panel = false;
      renderLookup();
      return;
    }
    if (batchId) {
      // 批次类的项没有单笔 id：把**整批成员**精确带到眼前（05 二轮审查第 1 项）——
      // 结果集合就是这一批的全部成员、置顶可见，返回核对清单的入口照常出现。
      lookup.focusId = "";
      lookup.focusBatchId = batchId;
      lookup.q = "";
      lookup.status = "全部";
      lookupSetDate("all");
      lookup.panel = false;
      renderLookup();
    }
  }

  function setLookupTab(tab) {
    lookup.tab = tab === "check" ? "check" : "search";
    const isCheck = lookup.tab === "check";
    const sp = $("#lkSearchPane"), cp = $("#lkCheckPane");
    if (sp) sp.hidden = isCheck;
    if (cp) cp.hidden = !isCheck;
    $$("#lkTabs .seg").forEach((b) => b.classList.toggle("on", b.dataset.lktab === lookup.tab));
    if (isCheck) { $("#lookupScope").textContent = "核对清单"; }
    renderLookup();
  }


  // ================= 04 期：新单草稿与误关闭保护 =================
  // 目标：手机录单被打断/误关之后还能找回**新单的输入**；同时编辑/回款/批次只在"确有改动将丢失"时提醒。
  // 边界（逐条对着 04 期提示词与 02-难点设计）：
  //   ① **只服务新单**（含「再来一单」，它本质是新建）。编辑、回款、批次**不做跨刷新恢复**，
  //      只加"未保存就离开"的提醒。
  //   ② 草稿是**本机**的一份输入，**不属于账本、不上传、不进同步包**；键里只放版本号与
  //      **编码后的非秘密 userId**，值里只放新单那几个字段 + 候选 orderId。绝不放同步码/密钥。
  //   ③ 每个 owner 一个槽，彼此隔离：owner 判不出来（身份为空/损坏）就**完全不读写草稿**。
  //   ④ 恢复必须**用户显式选**（继续 / 丢弃）；绝不自动回填后直接写账。
  //   ⑤ 只有草稿**确实写成功**才显示"已暂存"；草稿槽出错**绝不拦正式保存**。
  //   ⑥ 正式提交时在一个**写守门内、拿到排他锁后、动 data 之前**重核 owner/草稿ID/版本/候选 orderId，
  //      并核 DATA/SNAPSHOT 镜像：候选 ID 已存在 ⇒ 判为"已提交/待清理"，不保存、不排同步；
  //      对不上或结果不明 ⇒ 保留输入、标"待核对"、拒绝这份草稿继续提交。
  //   ⑦ 清理只在槽仍是本次 draftId+revision 时做（草稿 set/remove 与正式写共用同一把 Web Lock）。
  //   ⑧ 无 Web Locks 时**不承诺跨页持续草稿**：绝不静默覆盖已存在的槽；确认不了的旧草稿只标"待核对"。
  const DRAFT_KEY_PREFIX = "luhuo-new-order-draft-v1";
  const DRAFT_FIELDS = ["goods", "cost", "fee", "date", "qty", "channel", "status", "note", "tracking"];
  // 内存态：{ owner, draftId, revision, orderId, savedAt, status, savedFields, pendingCheck, conflict }
  let draftState = null;
  let draftTimer = null;

  function draftKeyFor(owner) {
    return owner ? `${DRAFT_KEY_PREFIX}:${encodeURIComponent(owner)}` : "";
  }
  const draftOwner = () => identityOwner();     // 身份包解析不出 userId 时是空串 ⇒ 整个草稿功能停用

  // 读当前 owner 的槽。**任何**异常/结构不符/owner 不符都当作"没有草稿"（宁可不恢复，也不串身份）。
  function draftRead(owner) {
    const key = draftKeyFor(owner);
    if (!key) return null;
    try {
      const raw = JSON.parse(localStorage.getItem(key) || "null");
      if (!raw || typeof raw !== "object" || raw.v !== 1) return null;
      if (String(raw.owner || "") !== owner) return null;
      if (!raw.draftId || !Number.isFinite(Number(raw.revision)) || !raw.fields) return null;
      return raw;
    } catch { return null; }
  }

  // 槽的三种状态：none（没有）/ ok（可解析且 owner 对得上）/ corrupt（**存在但读不出来**）。
  // corrupt 必须与 none 分开：规格要求"绝不静默覆盖已存在槽"，把损坏的槽当空槽就会静默盖掉它。
  function draftSlotState(owner) {
    const key = draftKeyFor(owner);
    if (!key) return { kind: "none" };
    let raw = null;
    try { raw = localStorage.getItem(key); } catch { return { kind: "none" }; }
    if (raw === null) return { kind: "none" };
    const rec = draftRead(owner);
    return rec ? { kind: "ok", rec } : { kind: "corrupt" };
  }

  // 候选 orderId 是否已经在**本机证据**里（内存账本 / 本机 DATA 实时镜像 / 最近完整快照）。
  // 三处都看：内存账本可能是从快照装载的、而 DATA 可能已被别页写过，只看一处会漏。
  function draftOrderIdInLedger(orderId, owner) {
    const wanted = String(orderId || "");
    if (!wanted) return false;
    if (data.orders.some((o) => String(o.id) === wanted)) return true;
    if (draftOwnerOk() === false) return false;
    try {
      const live = JSON.parse(localStorage.getItem(DATA_KEY) || "null");
      if (live && Array.isArray(live.orders) && live.orders.some((o) => String(o.id) === wanted)) return true;
    } catch { /* 读不出来就不据此判定 */ }
    try {
      const snap = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "null");
      if (snap && snap.owner === (owner || draftOwner()) && snap.data && Array.isArray(snap.data.orders)
        && snap.data.orders.some((o) => String(o.id) === wanted)) return true;
    } catch { /* 同上 */ }
    return false;
  }

  // 本机证据是否"结果不明"：DATA / SNAPSHOT 键**存在但解析不了**（被外部写坏）。
  // 键不存在是正常态（新账本本来就没有 SNAPSHOT），不算不明；解析不了才算——
  // 这时既不能证明候选 ID 没提交过、也不能证明提交过 ⇒ 守门按"结果不明"只拦这一份。
  function ledgerEvidenceUncertain() {
    for (const key of [DATA_KEY, SNAPSHOT_KEY]) {
      let raw = null;
      try { raw = localStorage.getItem(key); } catch { return true; }
      if (raw === null) continue;
      try { JSON.parse(raw); } catch { return true; }
    }
    return false;
  }

  function draftFieldsFromForm(f) {
    const out = {};
    DRAFT_FIELDS.forEach((k) => { if (f && f[k]) out[k] = String(f[k].value ?? ""); });
    return out;
  }

  // 当前表单的字段与"已落盘的那一份"是否逐格一致 —— 离开保护用它回答"最后这次输入到底落盘了没有"。
  // 不用近似判断：差一次 400ms 防抖就要如实说"还没落盘"，不能拿"刚才写成功过"顶替。
  function draftFieldsEqual(a, b) {
    if (!a || !b) return false;
    return DRAFT_FIELDS.every((k) => String(a[k] ?? "") === String(b[k] ?? ""));
  }

  // 身份在会话中途被换掉（导入同步码 / 重置身份 / 别页改了身份包）时，这份草稿**不再属于当前身份**：
  // 立即丢掉内存态并停用一切草稿读写。这样"用 A 的内存草稿去写 B 的槽"这条串单路径就不存在了。
  function draftOwnerOk() {
    if (!draftState) return false;
    const now = draftOwner();
    if (!now || !draftState.owner || now !== draftState.owner) {
      draftState = null;
      draftRender();
      return false;
    }
    return true;
  }

  function draftRender() {
    const bar = $("#formDraftBar");
    if (!bar) return;
    if (editingId || !draftState) { bar.hidden = true; bar.innerHTML = ""; bar.className = "draft-bar"; return; }
    const st = draftState;
    const btn = (what, text, cls) => `<button type="button"${st.busy ? " disabled" : ""}${cls ? ` class="${cls}"` : ""} data-draft="${what}">${text}</button>`;
    const acts = (list) => `<div class="dr-acts">${list.join("")}</div>`;
    if (st.status === "offer") {
      // 关键：这里**还没有认领**旧槽。用户不点任何按钮、直接开始填，也只会另记新的一单（新单号），
      // 旧草稿原样留着 —— 不会被覆盖、也不会被消费（04 审查第 1 项）。
      bar.className = "draft-bar";
      bar.hidden = false;
      bar.innerHTML = `这个账本上次没写完的一单还留着（${escapeHtml(st.savedAt || "")}）。<br>`
        + `直接开始填也行——那样会另记新的一单，这份草稿仍然留着、不会被覆盖。`
        + acts([btn("continue", "继续那一单"), btn("newone", "另记新的一单", "ghost"), btn("discard", "丢弃这份草稿", "ghost")]);
      return;
    }
    if (st.status === "pending") {
      bar.className = "draft-bar warn";
      bar.hidden = false;
      bar.innerHTML = `本机还留着一份「待核对」的草稿（它在另一处可能已经提交过，或读不出来）。`
        + `已经保留它、不会覆盖；本页这一单不会被暂存。`
        + acts([btn("newone", "继续记这一单（用新单号）"), btn("discard", "丢弃这份待核对的草稿", "ghost")]);
      return;
    }
    if (st.status === "unprotected") {
      bar.className = "draft-bar muted";
      bar.hidden = false;
      bar.innerHTML = `本机还留着一份没处理的草稿（请到账本里核对一下）。这一单不会被暂存——`
        + `保存前别退出；想让它也受草稿保护，先处理掉那份旧草稿。`;
      return;
    }
    if (st.status === "conflict") {
      bar.className = "draft-bar warn";
      bar.hidden = false;
      bar.innerHTML = `另一页也在填这一单，草稿已经按它那边的版本走了。这里保留你正在输入的内容，`
        + `但不会覆盖它——请确认好留哪一份再保存。`;
      return;
    }
    if (st.status === "nolock") {
      // 无 Web Locks 降级：槽里是先前那一版，之后的改动没有再写进去（也不该谎称"已暂存"）。
      bar.className = "draft-bar muted";
      bar.hidden = false;
      bar.innerHTML = `本机浏览器不支持多页写入锁，草稿槽里保留的是先前那份（这里没有覆盖它）。`
        + `这一单仍可正常保存，只是这次的改动不会再写进草稿。`;
      return;
    }
    if (st.status === "dirty") {
      bar.className = "draft-bar muted";
      bar.hidden = false;
      bar.innerHTML = `刚改的内容还没落到草稿里（马上会落，别在这时候退出）。`;
      return;
    }
    if (st.status === "nosave") {
      bar.className = "draft-bar muted";
      bar.hidden = false;
      bar.innerHTML = `未保存在草稿（本机存储暂时写不进去）——不影响你正常保存这一单。`;
      return;
    }
    if (st.status === "saved") {
      bar.className = "draft-bar muted";
      bar.hidden = false;
      bar.innerHTML = `已暂存为草稿，退出后可以找回。`;
      return;
    }
    bar.hidden = true; bar.innerHTML = ""; bar.className = "draft-bar";
  }

  // 把当前表单写进槽。**必须在与正式写同一把锁里**，而且只在"这一份表单确实认领了槽"时才写：
  //   · mode=blocked（有未处理/可疑的旧槽）⇒ 一律不写：既不覆盖旧槽，也不给这一单留下"已暂存"的错觉
  //   · claimed=false（offer 还没点继续）  ⇒ 一律不写：未明确选择不得覆盖或消费旧草稿
  // 锁内重读该 owner 的槽，只有两种情况允许写：槽不存在（首次）或槽仍是本次 draftId+revision。
  function draftWriteNow() {
    if (!draftState || editingId) return false;
    if (!draftOwnerOk()) return false;
    if (draftState.mode !== "own" || !draftState.claimed) return false;
    // 最终写入口的拒写守卫（补强任务 A）：已判"待核对/冲突"的草稿写通道整体关闭。
    // draftSchedule 只是不再排写，而**关窗补写**（formLeaveGuard，取消/Esc/点遮罩全部出口都走它）
    // 会直呼本函数——不在这里拦，取消关闭仍会把旧槽推进一版（复核探针 04.pending-close 抓到的正是这条）。
    if (draftState.pendingCheck || draftState.conflict) return false;
    const owner = draftState.owner;
    const state = draftSlotState(owner);
    if (state.kind === "corrupt") {
      draftState.conflict = true; draftState.status = "conflict"; draftRender();
      return false;
    }
    const cur = state.kind === "ok" ? state.rec : null;
    if (cur && (String(cur.draftId) !== String(draftState.draftId)
      || Number(cur.revision) !== Number(draftState.revision))) {
      draftState.conflict = true;
      draftState.status = "conflict";
      draftRender();
      return false;
    }
    if (cur && String(cur.orderId || "") !== String(draftState.orderId)) {
      // 04 二轮审查第 2 项：同 draftId+revision 但**候选单号被换掉** ⇒ 槽被别人动过、结果不明：
      // 不写、标冲突，绝不把别人的候选号当成自己这份继续推进。
      draftState.conflict = true;
      draftState.status = "conflict";
      draftRender();
      return false;
    }
    if (!cur && Number(draftState.revision) >= 1) {
      // 04 二轮审查第 2 项：认领后**写过**（revision ≥ 1）而槽现在没了（别页刚提交并清理、
      // 或刚丢弃）⇒ 结果不明，**绝不当"首次创建"把草稿复活**。保留 DOM 输入、标待核对。
      draftState.pendingCheck = true;
      draftState.status = "pending";
      draftRender();
      return false;
    }
    if (cur && !(navigator.locks && navigator.locks.request)) {
      // 无 Web Locks 的保守降级（补强任务 B，原设计契约：无锁时"绝不静默覆盖已存在槽"）：
      // 读到的"仍是同一份"不构成 CAS——排锁等待的间隙里别页可能已消费/推进这份槽。
      // 旧槽原样保留、如实说明状态；这一单仍可正常保存（新单号路径不受影响）。
      // 无锁空槽的首次创建不在此列（原设计已豁免该并发窗口的原子性，见 04 期 BLOCKED）。
      draftState.status = "nolock";
      draftRender();
      return false;
    }
    const revision = cur ? Number(cur.revision) + 1 : 1;
    const record = {
      v: 1, owner, draftId: draftState.draftId, revision,
      updatedAt: new Date().toISOString(),
      kind: formKind === "income" ? "income" : "order",
      orderId: draftState.orderId,                       // 稳定候选 ID：正式提交沿用它
      fields: draftFieldsFromForm($("#orderForm")),
    };
    try {
      localStorage.setItem(draftKeyFor(owner), JSON.stringify(record));
    } catch {
      draftState.status = "nosave";                      // 写失败：如实说"未保存在草稿"，但绝不拦正式保存
      draftRender();
      return false;
    }
    draftState.revision = revision;
    draftState.savedAt = record.updatedAt.replace("T", " ").slice(0, 16);
    draftState.savedFields = record.fields;
    if (!draftState.pendingCheck && !draftState.conflict) draftState.status = "saved";
    draftRender();
    return true;
  }

  function draftSchedule() {
    if (!draftState || editingId) return;
    // 未认领 / 受保护槽模式：不排写，也不谎报状态
    if (draftState.mode !== "own" || !draftState.claimed) return;
    // 已被守门判成"待核对"（候选号已入库/槽结果不明）或处在冲突态：这一单的草稿通道已经关了，
    // 状态条也写着"不会被暂存"——绝不再排写（否则会把已判 duplicate 的槽悄悄推进一版）。
    // 无锁降级（nolock）同理：再写也只会被 draftWriteNow 拒掉，别把状态条翻回"马上会落"的假话。
    if (draftState.pendingCheck || draftState.conflict || draftState.status === "nolock") return;
    clearTimeout(draftTimer);
    // **立刻**把状态改成"还没落盘"：提示条与离开保护都据此说话。原来只在写成功后才改状态，
    // 于是"改了但还没写"这段时间里界面还写着"已暂存、退出可找回"（04 审查第 2 项）。
    if (!draftState.pendingCheck && !draftState.conflict && draftState.status !== "nosave") {
      draftState.status = "dirty";
      draftRender();
    }
    // 防抖：手机上每敲一下都落一次盘没必要；400ms 足够"被打断也能找回"
    draftTimer = setTimeout(() => { withStorageLock(draftWriteNow); }, 400);
  }

  // 按**调用方给的目标快照**（owner/draftId/revision）删槽，且只在槽仍匹配时才删。
  // 用显式快照而不是读 draftState：① 丢弃"待核对/损坏"的旧槽时，本页的 draftState 根本不属于它；
  // ② 排队等锁期间别页可能推进版本，锁后必须按**发起时那一份**重核。
  // allowCorrupt：只在调用方明确声明"整槽不可信、要整份丢掉"时才允许删读不出来的槽。
  function draftClearSnapshot(target) {
    if (!target || !target.owner) return false;
    const key = draftKeyFor(target.owner);
    if (!key) return false;
    let raw = null;
    try { raw = localStorage.getItem(key); } catch { return false; }
    if (raw === null) return true;                        // 本来就没有：算成功
    const rec = draftRead(target.owner);
    if (rec) {
      if (String(rec.draftId) !== String(target.draftId)) return false;
      if (Number(rec.revision) !== Number(target.revision)) return false;
    } else {
      if (!target.allowCorrupt) return false;
      // 04 二轮审查第 3 项：损坏槽只删**用户看到的那一份**——发起丢弃时钉下的原文在排队等锁期间
      // 被换成别的字节（另一页写了另一份坏内容）就不删，让用户重新看一眼再决定。
      if (typeof target.raw === "string" && raw !== target.raw) return false;
    }
    try { localStorage.removeItem(key); return true; } catch { return false; }
  }

  // 自己认领的那一份：按当前 draftId/revision 删
  function draftClearNow() {
    if (!draftState || draftState.mode !== "own" || !draftState.claimed) return false;
    return draftClearSnapshot({ owner: draftState.owner, draftId: draftState.draftId, revision: draftState.revision });
  }

  // 打开新单表单时：看一眼当前 owner 的槽。
  //   · 没有槽        ⇒ own + 已认领，正常暂存
  //   · 有可续的槽    ⇒ **不认领**，给「继续 / 另记新的一单 / 丢弃」三个选择（offer）
  //   · 已提交或读不出的槽 ⇒ blocked + 待核对，给「用新单号继续记 / 丢弃这份」
  // options.forceNew：「保存并继续」这类"用户已经明确要下一单"的路径，不必被旧草稿挡住 ——
  // 直接进"另记新的一单"（新单号、不写槽），旧草稿原样留着（04 审查第 3 项）。
  function draftOpenForNewForm(options) {
    clearTimeout(draftTimer);
    const forceNew = !!(options && options.forceNew);
    const owner = draftOwner();
    draftState = {
      owner, mode: "own", claimed: true,
      draftId: uid(), revision: 0, orderId: uid(),
      slotDraftId: "", slotRevision: 0, slotOrderId: "",
      status: "", savedAt: "", savedFields: null, pendingCheck: false, conflict: false,
    };
    if (!owner) { draftRender(); return; }
    const state = draftSlotState(owner);
    if (state.kind === "none") { draftRender(); return; }
    // 槽存在：先把它的身份记下来，但**本表单自己用全新的 draftId/orderId**。
    // 这样"未选择就直接填"只会另记新的一单（新单号），绝不会复用旧候选号、更不会覆盖旧槽。
    draftState.mode = "blocked";
    draftState.claimed = false;
    draftState.slotDraftId = state.kind === "ok" ? String(state.rec.draftId) : "";
    draftState.slotRevision = state.kind === "ok" ? Number(state.rec.revision) : 0;
    draftState.slotOrderId = state.kind === "ok" ? String(state.rec.orderId || "") : "";
    draftState.savedAt = state.kind === "ok" ? String(state.rec.updatedAt || "").replace("T", " ").slice(0, 16) : "";
    const already = state.kind === "ok" && draftOrderIdInLedger(state.rec.orderId, owner);
    draftState.status = (already || state.kind === "corrupt") ? "pending" : "offer";
    draftState.pendingCheck = draftState.status === "pending";
    if (forceNew && draftState.status === "offer") draftState.status = "unprotected";
    // （复核回退注记）pending 不在这里归整：残留槽的 pending 状态条带着「用新单号 / 丢弃」两个入口，
    // 归整成 unprotected 会把入口一起丢掉（用户得关窗重开才能处理残留）。关窗问句的分流改在
    // formLeaveGuard 里做：未认领的新单说"这一单没有被暂存"，不再误用"本页不再提交它"。
    draftRender();
  }

  // 「另记新的一单」：旧槽原样留着（不写、不删），本表单用**全新的单号**走普通新单路径。
  // 这一单不享受草稿保护 —— 本机每个身份只有一份草稿槽，那一份属于还没处理的旧草稿。
  function draftEnterNewOrder() {
    if (!draftState || draftState.busy) return false;    // 丢弃在途：互斥，先等它落地
    draftState.mode = "blocked";
    draftState.claimed = false;
    draftState.draftId = uid();
    draftState.orderId = uid();
    draftState.savedFields = null;
    draftState.status = "unprotected";
    draftRender();
    return true;
  }

  // 用户选「继续那一单」：认领 + 把字段回填到表单（**只回填，仍然要用户自己点保存**）。
  function draftApplyToForm() {
    const st = draftState;
    if (!st || !st.owner || st.busy) return false;       // 丢弃在途：互斥，"继续"插不进来（04 二轮审查第 3 项）
    // 认领前重核：槽还在吗？身份/版本还是打开时看到的那一份吗？不符就不认领、也不动它。
    const state = draftSlotState(st.owner);
    if (state.kind !== "ok") {
      st.status = "pending"; st.pendingCheck = true; draftRender();
      toast("那份草稿已经不在了或读不出来，这里没有动它");
      return false;
    }
    if (String(state.rec.draftId) !== String(st.slotDraftId)
      || Number(state.rec.revision) !== Number(st.slotRevision)) {
      st.status = "conflict"; draftRender();
      toast("那份草稿在别处已经变过，这里没有覆盖它");
      return false;
    }
    const cur = state.rec;
    const f = $("#orderForm");
    const fields = cur.fields || {};
    const kind = cur.kind === "income" ? "income" : "order";
    if (kind === "income" && formKind !== "income") setFormKind("income");
    if (kind === "order" && formKind !== "order") setFormKind("order");
    nameAuto = false;
    channelTouched = true;                       // 回填的渠道算"已经定过"，切类型不该被默认值顶掉
    DRAFT_FIELDS.forEach((k) => { if (f[k] && fields[k] !== undefined) f[k].value = String(fields[k]); });
    if (f.status && !STATUSES.includes(f.status.value)) fillSelect(f.status, STATUSES.map((s) => [s, statusLabel(s)]), "在途");
    const chVal = String(f.channel.value || "");
    const chOpts = CHANNELS.slice();
    if (!chOpts.includes(chVal)) chOpts.push(chVal);
    fillSelect(f.channel, chOpts.map((c) => [c, c === "" ? "未填写" : c]), chVal);
    st.mode = "own";
    st.claimed = true;
    st.draftId = String(cur.draftId);
    st.revision = Number(cur.revision);
    st.orderId = String(cur.orderId || st.orderId);
    st.savedFields = fields;
    st.status = "saved";
    st.pendingCheck = false;
    draftRender();
    // v41：邮费与单号在记单表单里是隐藏格（只在寄出面板改）。旧版留下的草稿可能带着它们——
    // 新建形态下一律清掉，免得看不见的邮费/单号被悄悄写进新单（有单号还会让它直接跳过「待寄」）。
    if (!editingId) { f.fee.value = ""; f.tracking.value = ""; }
    // 恢复的日期若不是今天，直接展开日期框，小字与将要保存的日期保持一致
    f.querySelector(".fld-date").classList.toggle("open", !!editingId || f.date.value !== todayStr());
    updateDateToggle();
    updateFormMoreSummary();
    applyKindUi();
    return true;
  }

  // 用户选「丢弃草稿」：**等待真实结果**再说话（原来把 withStorageLock 的 Promise 当布尔，
  // 失败也说已丢弃 —— 04 审查第 4 项）。锁后再核一遍要丢的还是不是当初那一份。
  // 04 二轮审查第 3 项：排队等锁期间**互斥**（按钮禁用 + 操作序号），"继续那一单"插不进来，
  // 丢弃完成后也不会把刚认领的旧草稿用同 draftId/orderId 复活；损坏槽按**发起时钉下的原文**删。
  let draftOpSerial = 0;
  async function draftDiscard() {
    const st = draftState;
    if (!st || !st.owner || st.busy) return false;
    const op = ++draftOpSerial;
    // 丢弃目标按**归属**路由（复核修正）：本页自己认领的那份（own+claimed，含被判待核对/冲突的）
    // 按自己的 draftId/revision 删——槽已被别人换掉时自然删不动、如实说"没能删掉"；
    // 只有没有认领的旧槽（offer/待核对残留）才走"槽快照 + 原文钉住"那条路。
    const target = (st.mode === "own" && st.claimed)
      ? { owner: st.owner, draftId: st.draftId, revision: st.revision }
      : (() => {
        const key = draftKeyFor(st.owner);
        let raw;
        try { raw = key ? localStorage.getItem(key) : undefined; } catch { raw = undefined; }
        return { owner: st.owner, draftId: st.slotDraftId || "", revision: st.slotRevision || 0,
          allowCorrupt: true, raw: typeof raw === "string" ? raw : undefined };
      })();
    st.busy = true;
    draftRender();                                        // 丢弃在途：草稿条按钮全部禁用
    let ok = false;
    try {
      ok = await withStorageLock(() => {
        if (draftOwner() !== target.owner) return false;
        return draftClearSnapshot(target);
      });
    } finally {
      st.busy = false;
      if (draftState === st) draftRender();
    }
    if (draftState !== st || op !== draftOpSerial) return !!ok;   // 期间被换过会话/又发起了别的操作：不纠正别人的状态
    if (ok) {
      st.slotDraftId = ""; st.slotRevision = 0; st.slotOrderId = "";
      st.savedFields = null; st.pendingCheck = false; st.conflict = false;
      if (st.mode === "blocked") { st.mode = "own"; st.claimed = true; st.draftId = uid(); st.orderId = uid(); st.revision = 0; }
      st.status = "";
      toast("已丢弃那份草稿");
    } else {
      st.status = st.status === "offer" ? "offer" : "pending";
      toast("没能删掉那份草稿（另一页刚更新过，或本机存储写不进去）——这里没有动它");
    }
    draftRender();
    return !!ok;
  }

  // ---- 离开保护：所有出口（取消 / Esc / 点遮罩）统一过它 ----
  // 判据：**有改动**且**改动会丢**才提醒。而"会不会丢"只看一件事：**当前字段与已落盘的那份是否一致**。
  // 原来只看 status === "saved"，于是"改成 100、400ms 内关窗"会听到"可以找回"，实际存储里还是 10
  //（04 审查第 2 项）。现在关窗前先补写一次，再按补写结果决定措辞。
  // 04 二轮审查第 1 项：补写**必须过与正式写同一把锁**——同步直写绕开互斥，两页同锁读写交错时
  // "读旧 revision → 写同号 revision"不是 CAS，最后一次输入会被对方持锁写入后静默顶掉。
  // 所以守门是 async：等同一把锁补写完，再按真实结果问话。
  let leaveGuardBusy = false;   // 已有一次守门在等锁：挡住连点取消/Esc 的重复进入
  async function formLeaveGuard() {
    if (!$("#formModal").classList.contains("show")) return true;
    if (leaveGuardBusy) return false;                           // 在等的那次守门马上会问，这次不重复
    const f = $("#orderForm");
    const changed = formBaseline === null || controlState(f) !== formBaseline;
    if (!changed) return true;                                  // 没改动：不问
    const durable = () => !!(draftState && draftState.mode === "own" && draftState.claimed
      && draftState.status === "saved"
      && draftFieldsEqual(draftFieldsFromForm(f), draftState.savedFields));
    if (!durable() && draftState && draftState.mode === "own" && draftState.claimed) {
      leaveGuardBusy = true;
      try {
        clearTimeout(draftTimer);
        await withStorageLock(draftWriteNow);                   // 与正式写/草稿写同一把排他锁
      } finally { leaveGuardBusy = false; }
      // 等锁期间保存成功可能已经把表单关了（closeForm(true) 清掉 draftState）：无事可问，直接放行
      if (!$("#formModal").classList.contains("show")) return true;
      // 等锁期间若又打了字，durable() 会如实说"没落盘"，不拿补写成功顶替最后那次输入。
    }
    if (durable()) {
      return confirm("这一单还没保存，但输入已经暂存在草稿里（退出后可以找回）。\n确定离开？");
    }
    if (draftState && draftState.status === "pending"
      && draftState.mode === "own" && draftState.claimed) {
      // 只有"本页自己认领的那份被判待核对"才说"本页不再提交它"（守门确实会拦它）；
      // blocked/未认领的新单其实能用新单号正常保存，说那句话是骗人——按"未被暂存"如实说。
      return confirm("这份草稿待核对（可能在另一处已经提交过），本页不再提交它。\n"
        + "离开会丢掉你现在的输入，确定离开？");
    }
    if (draftState && draftState.status === "nolock") {
      // 无锁降级：槽里只有先前那一版，之后的改动没写进去。两头都不冒充——不说"可以找回"，
      // 也不说"全都会丢"；如实说清哪部分在、哪部分丢。
      return confirm("草稿里只留有先前暂存的那一版（本机浏览器不支持多页写入锁，之后的改动没有再写进去）。\n"
        + "离开的话最后这些改动会丢，确定离开？");
    }
    if ((draftState && draftState.status === "pending")
      || (draftState && draftState.status === "unprotected")) {
      return confirm("这一单没有被暂存（本机还留着一份没处理的草稿）。\n离开会丢掉你现在的输入，确定离开？");
    }
    // 编辑 / 回款 / 批次：只提示"当前改动会丢"，**不承诺刷新后能恢复**
    return confirm("你有还没保存的改动，离开就丢了。\n确定离开？");
  }

  // 草稿守门的"待核对"只落在**仍是这一份**的 live 状态上；reopened（live 已属于新表单）时
  // 只拦这次提交，不去改新表单的状态条。
  function draftMarkPendingSnap(snap, owner) {
    if (draftState && draftState.owner === owner
      && String(draftState.draftId) === String(snap.draftId)
      && Number(draftState.revision) === Number(snap.draftRevision)) {
      draftState.pendingCheck = true; draftState.status = "pending"; draftRender();
    }
  }

  // 正式提交前的**草稿归属分类**。由 withFormIntent 在**同一把锁内、通用旧基线拒绝之前**调用
  //（04 审查第 5 项：原来它被嵌在通用写守门之后，外层基线一拒就根本跑不到）。
  // 04 二轮审查第 2/5 项：判据全部用**提交那一刻的快照**（snap），不读 live draftState 的归属——
  // 等待写锁期间表单可能被重新打开，live 态已经属于新表单；reopened 的提交同样要过这道分类。
  // 返回 "ok" | "duplicate" | "blocked"。
  function draftGateForSubmit(snap) {
    if (!snap || snap.editingId || !snap.draftClaimed) return "ok";
    const owner = String(snap.draftOwner || "");
    if (!owner || owner !== draftOwner()) return "ok";           // 身份判不出来/中途换过：草稿机制整体不参与
    // ① 候选 ID 已经在本机证据里（内存账本 / DATA 实时镜像 / 最近完整快照，三处都看）⇒ 已经提交过
    if (draftOrderIdInLedger(snap.orderId, owner)) {
      draftMarkPendingSnap(snap, owner);
      return "duplicate";
    }
    // ①b 证据**读不出来**≠没有证据（复核指出的规格残留）：DATA/SNAPSHOT 存在但解析不了
    //    ⇒ 本机证据"结果不明"，按规格只拦这一份、标待核对（键不存在是正常态，不在此列）。
    if (ledgerEvidenceUncertain()) {
      draftMarkPendingSnap(snap, owner);
      return "blocked";
    }
    const cur = draftRead(owner);
    if (Number(snap.draftRevision) >= 1) {
      // ② 认领后**写过**的草稿：槽必须仍然是同一份（同 draftId + revision + orderId）。
      //    槽没了/读不出/版本或候选号被换掉 ⇒ 无法证明这份草稿没在别处被提交或处理过
      //    ⇒ 只拦这一份、标待核对（不拦与草稿无关的合法新单）。
      if (!cur || String(cur.draftId) !== String(snap.draftId)
        || Number(cur.revision) !== Number(snap.draftRevision)
        || String(cur.orderId || "") !== String(snap.orderId)) {
        draftMarkPendingSnap(snap, owner);
        return "blocked";
      }
    }
    // ③ 还没写过（revision 0）的全新草稿：候选号是本机新号；就算槽已被别的草稿占了也与这份提交无关
    //   （清理只删匹配版本，不会误删别人的）。重复 ID 由通用守门再兜一道。
    return "ok";
  }

  // ================= 03 期：连续录入与历史商品名建议 =================
  // 目标：手机上连着记两单时少重复点，且**绝不把上一笔的价格或快递信息带进新单**。四条边界：
  //   ① 「保存并继续」只给**新建货单**（编辑既有单、收入单都不渲染这个入口），普通「保存」一个字不改。
  //   ② 只有**一次本地保存确认成功**才进入下一单；失败时整张表单（含所有值与选择）原样保留。
  //   ③ 下一单的默认值严格按规格重置：名称/垫付/邮费/单号/备注清空，数量 1、日期今天、状态在途，
  //      **不带**旧订单 ID/批次/回款金额/回款日期；渠道默认清空（只有显式勾了「保留本次渠道」才沿用）。
  //   ④ 历史商品名建议是**临时派生**（每次打开表单现算）：不建模板库、不加账本字段、不合并同名单、
  //      不重做「再来一单」；点选**只改名称这一格**，金额/渠道/数量/日期等一个都不碰。
  // 会话状态只活在内存里：普通保存 / 关窗 / 取消都结束本次连续录入，重新打开表单不记住任何选择。
  let chainSession = { active: false, channel: "" };

  // 近期商品名：按「下单日期新→旧、同日按 createdAt 新→旧」取前 N 个**去重**的非空名称。
  // 排序与账本页同一套日期口径（不自造第二套）；同日同毫秒时用 name 兜底，保证顺序稳定可复现。
  function recentNames(limit = 8) {
    const seen = new Set();
    const out = [];
    const sorted = data.orders.slice().sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      const ca = String(a.createdAt || ""), cb = String(b.createdAt || "");
      if (ca !== cb) return ca < cb ? 1 : -1;
      return String(a.name || "") < String(b.name || "") ? -1 : 1;
    });
    for (const o of sorted) {
      const name = String(o.name || "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      if (out.length >= limit) break;
    }
    return out;
  }

  function renderRecentNames() {
    const box = $("#formRecent");
    if (!box) return;
    const names = editingId ? [] : recentNames();
    if (names.length === 0) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = `<span class="rn-label">近期：</span>`
      + names.map((n) => `<button type="button" class="rn" data-rn="${escapeHtml(n)}" title="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join("");
  }

  // 「保存并继续」与「保留本次渠道」的显隐：都只服务**新建货单**。
  function applyChainUi() {
    const isNewOrder = !editingId && formKind === "order";
    $("#formSaveNext").hidden = !isNewOrder;
    $("#formKeepChannelWrap").hidden = !isNewOrder;
    renderRecentNames();
  }

  // 一次成功保存之后把表单换成"下一单"的空白态。**刻意不关弹窗**（这正是"继续"的含义），
  // 也刻意不整表重渲染——只把该清的清掉、该还原的还原，用户视线与键盘都不用挪。
  function startNextOrder() {
    const f = $("#orderForm");
    chainSession.active = true;      // 本次连续录入开始了（结束于点保存/关窗/取消）
    // 04 期：下一单＝一份**全新草稿**（新的候选 ID）——上一单的那份已经在保存成功时被消费掉了。
    // 若上一份因为清理失败还留在槽里，这里会照实把它作为待处理的那份呈现出来，
    // 而不是静默覆盖它。
    const keep = !$("#formKeepChannel").hidden && $("#formKeepChannel").checked && channelTouched;
    // 勾了"保留本次渠道"且这一单确实手选过渠道 ⇒ 记住它；勾着但没碰过渠道 ⇒ 沿用上次记住的那个
    if ($("#formKeepChannel").checked) {
      if (keep) chainSession.channel = String(f.channel.value || "").trim();
    } else {
      chainSession.channel = "";
    }
    editingId = null;
    formSession = null;                 // 新建从一开始就没有编辑会话；这里显式保证
    formKind = "order";
    nameAuto = false;
    channelTouched = false;
    prefillPlatform = "";
    f.goods.value = "";
    f.cost.value = "";                  // 全新一单：金额从空开始（**绝不复用上一笔的价**）
    f.fee.value = "";
    f.tracking.value = "";              // 单号必然不同，空着比填错强
    f.note.value = "";
    f.qty.value = 1;
    f.date.value = todayStr();
    fillSelect(f.status, STATUSES.map((s) => [s, statusLabel(s)]), "在途");
    // 渠道：默认清空（"未填写"）；只有沿用态才带上次那个值。空值也照既有做法补进选项表，
    // 否则控件会因为没有匹配项而回空、摘要骗人（v33 渠道下拉踩过同一个坑）。
    const chOpts = CHANNELS.slice();
    const chVal = chainSession.channel;
    if (!chOpts.includes(chVal)) chOpts.push(chVal);
    fillSelect(f.channel, chOpts.map((c) => [c, c === "" ? "未填写" : c]), chVal);
    $("#formBatchHint").hidden = true;
    $("#formBatchHint").textContent = "";
    $("#formIncomeHint").hidden = true;
    $("#formIncomeHint").textContent = "";
    $("#formMore").open = false;
    $("#formTitle").textContent = "记一单";
    f.classList.add("is-new");                         // v41：下一单也是新建形态
    f.querySelector(".fld-date").classList.remove("open");
    updateDateToggle();
    $("#formShipInfo").hidden = true;
    $("#formKind").hidden = false;
    applyKindUi();
    applyChainUi();
    draftOpenForNewForm({ forceNew: true });   // 04 期：下一单用**全新单号**；若还有未处理的旧槽，进"另记新的一单"（不覆盖旧槽）
    formBaseline = controlState(f); // 新一单的没改动基线也跟着重置
    setTimeout(() => f.goods.focus({ preventScroll: true }), 60);
  }

  // order：编辑既有单（editingId = 其 id）；prefill：「再来一单」预填（editingId 保持 null，保存即新建）
  function openForm(order, prefill) {
    const src = order || prefill || null;
    formOpenSerial += 1;   // 03 期：这是新的一张表单，在飞的那次提交据此判定自己该不该关表单
    editingId = order ? order.id : null;
    // 03 期：**每次打开表单都结束上一次的连续录入**（新建、编辑、再来一单都一样）——
    // 「保留本次渠道」只活在"连着记"的这一串里，重开一次就不该记得它。
    chainSession = { active: false, channel: "" };
    $("#formKeepChannel").checked = false;
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
    // 同上：0 写成 0（邮费可不填，留空仍按 0 算）。
    // v41：邮费只在**编辑既有单**时回填（与单号同一条规矩）——「再来一单」是又一次寄件，邮费那时还没发生；
    // 表单里这一格已隐藏（全站只在「寄出」面板里填邮费），沿用原单邮费会悄悄带进一笔看不见的钱。
    f.fee.value = order ? numberValue(order.fee) : "";
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
        + `邮费是整批一笔，在下面「改寄出信息」里按整批改。`;
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
    // v41：新建表单只留 商品名 / 垫付 / 数量（日期默认今天，点那行小字才展开；状态一律在途不出现）。
    // 编辑时日期、状态照常；单号与邮费只读写出一行 + 「改寄出信息」链接（全站只有寄出面板能改它们）。
    f.classList.toggle("is-new", !order);
    f.querySelector(".fld-date").classList.toggle("open", !!order);
    updateDateToggle();
    const shipInfo = $("#formShipInfo");
    shipInfo.hidden = !order;
    if (order) $("#formShipInfoText").textContent = shipInfoText(order);
    $("#formMore").open = !!(order && order.status !== "在途");
    // v25：编辑表单**不加**类型切换（一律按货单形态回显，用户在该形态下自由改）
    $("#formKind").hidden = !!order;
    applyKindUi();
    applyChainUi();      // 03 期：「保存并继续」/「保留本次渠道」只对新建货单出现；近期名称建议同此
    // 04 期：编辑既有单不进草稿（也不承诺跨刷新恢复）；新建（含「再来一单」）看一眼当前身份的草稿槽
    if (order) { draftState = null; draftRender(); }   // 编辑既有单：完全不用草稿
    else draftOpenForNewForm();                       // 新建/再来一单：建一份新草稿，或请用户处理旧的那份
    openModal("#formModal");
    // 基线必须在表单**建好之后**取：之后只有真改动才会与它不同（离开保护与草稿判据共用）
    formBaseline = controlState(f);
    setTimeout(() => f.goods.focus(), 120);
  }

  // v41：编辑表单里那一行只读的寄出信息
  function shipInfoText(o) {
    if (!isShipped(o)) return "还没寄出（寄出请在卡片上点「寄出」）";
    const bits = [];
    const when = o.shipDate || o.batchDate;
    bits.push(when ? `已寄出 ${when.slice(5)}` : "已寄出");
    if (cleanTracking(o.tracking)) bits.push(`单号 ${cleanTracking(o.tracking)}`);
    bits.push(o.batchId ? `本单摊到邮费 ${money(o.fee)}` : `邮费 ${money(o.fee)}`);
    return bits.join(" · ");
  }

  function updateDateToggle() {
    const f = $("#orderForm");
    const t = $("#formDateToggle");
    if (!t) return;
    const isNew = f.classList.contains("is-new");
    const open = f.querySelector(".fld-date").classList.contains("open");
    t.hidden = !isNew || open;
    const v = f.date.value;
    t.textContent = v === todayStr() ? `日期：今天 ${v.slice(5)} · 改` : `日期：${v || "未填"} · 改`;
  }

  // force=true 只给"确实保存成功"那几条路用（避免保存成功后再弹一次"要丢改动吗"）——
  // 这与 02-难点设计里"真正保存成功用显式 bypass"是同一条要求。
  // 守门是 async（关窗补写要等与正式写同一把锁）：closeForm 等它落地再关；同步布尔路径保持原样。
  function closeForm(force) {
    if (force === true) { closeFormNow(); return true; }
    const verdict = formLeaveGuard();
    if (verdict && typeof verdict.then === "function") {
      return verdict.then((ok) => { if (ok) closeFormNow(); return ok; });
    }
    if (!verdict) return false;
    closeFormNow();
    return true;
  }
  function closeFormNow() {
    closeModal("#formModal");
    editingId = null;
    formSession = null;   // v38：编辑会话随弹窗关闭一起作废（下次「编辑」会重新记一份）
    formBaseline = null;
    // 03 期：关窗（取消/遮罩/Esc/保存成功）＝结束本次连续录入，不记住"保留本次渠道"
    chainSession = { active: false, channel: "" };
    // 04 期：草稿**不在这里删**——它正是"被误关之后还能找回"的东西。只有保存成功那条路才消费它。
    // 内存态留着（下次 openForm 会重新读槽），但把那句"已暂存"的提示收起来。
    clearTimeout(draftTimer);
    draftState = null;
    draftRender();
    return true;
  }

  function submitForm(ev) {
    ev.preventDefault();
    const snap = formIntentSnapshot(ev.target);
    const gate = draftPrecheck(snap);
    return withFormIntent(ev.target, formSession, () => formSession,
      () => submitFormImpl(ev, false, snap), snap.serial, () => formOpenSerial, gate);
  }
  // 04 期：「保存并继续」除了草稿归属检查，还要在成功之后换成下一单的空白态。
  function submitFormNext(ev) {
    ev.preventDefault();
    const form = $("#orderForm");
    const snap = formIntentSnapshot(form);
    const gate = draftPrecheck(snap);
    // 合成一个与 form submit 同形的事件对象，让 submitFormImpl 不需要为这条入口分叉
    return withFormIntent(form, formSession, () => formSession,
      () => submitFormImpl({ preventDefault() { }, target: form }, true, snap), snap.serial, () => formOpenSerial, gate);
  }
  // 04 期：交给写守门的草稿归属检查。**在拿到排他锁之后、通用旧基线拒绝与任何改动之前**调用；
  // 判定"这份草稿是不是已经提交过"只用账本与服务端无关的本机证据（DATA / 最近完整快照里的候选 orderId）。
  function draftPrecheck(snap) {
    if (!snap || snap.editingId) return null;
    return () => {
      const verdict = draftGateForSubmit(snap);
      if (verdict === "duplicate") {
        return { block: true, message: "这一单看起来已经记过了（草稿的候选单号已在账本里），这次没有重复保存" };
      }
      if (verdict === "blocked") {
        return { block: true, message: "这份草稿在别处已经变过或已不在原状，本页不再提交它；请关掉后到账本里核对" };
      }
      return null;
    };
  }

  function submitFormImpl(ev, chain, snap) {
    ev.preventDefault();
    let f = ev.target;
    // 03 期：拿到写锁时如果**表单已经被重新打开过**（serial 变了），说明排队期间用户又开了新表单；
    // 这次要写的是他点保存那一刻看到的那张表单 ⇒ 换成提交时抓下的快照读数，并把"关表单/进入下一单"
    // 这两件事都跳过（现在开着的这张表单不属于这次提交，不该替用户关掉或清空）。
    const reopened = !!(snap && snap.serial !== formOpenSerial);
    if (reopened) f = snap;
    // v25：保存后表单已经关了（连点保存的第二次、或事件晚到的那一下）一律丢弃，
    // 保证「一次保存 → 恰好一条」。真实用户连点第二下时按钮已随弹窗隐藏，这里兜住程序化连点。
    if (!$("#formModal").classList.contains("show")) return;
    // 模式/编辑目标：被重新打开过时用提交那一刻的快照，否则读 live（与从前一字不差）
    const kindAtSubmit = reopened ? snap.formKind : formKind;
    const editingAtSubmit = reopened ? snap.editingId : editingId;
    const prefillAtSubmit = reopened ? snap.prefillPlatform : prefillPlatform;
    const isIncome = kindAtSubmit === "income" && !editingAtSubmit;   // 编辑一律走货单路径
    const name = String(f.goods.value || "").trim();
    const date = f.date.value || todayStr();
    if (!name) { toast(isIncome ? "先填名称" : "先填商品名称"); return; }
    // v41：编辑时邮费格是隐藏的（界面上只在寄出面板改），它装着原单的值、原样回写。
    // 值没动过就不校验它：否则一份从导入/云端带进来的三位小数邮费会让保存被一个看不见的格子拦死。
    const editingOrder = editingAtSubmit ? data.orders.find((o) => o.id === editingAtSubmit) : null;
    const feeUntouched = !!editingOrder && String(f.fee.value) === String(numberValue(editingOrder.fee));
    if (!validAmountInputs(feeUntouched ? [f.cost] : [f.cost, f.fee])) return;

    // 03 期：把原生校验那几条在 JS 里补上（`#formSaveNext` 绕过了 required/min/step），
    // 让「保存」与「保存并继续」逐条同强度。负金额／三位小数从这里起就进不来。
    const rawProblem = amountTextProblem(f, feeUntouched ? [["cost", "垫付金额"]] : [["cost", "垫付金额"], ["fee", "邮费"]]);
    if (rawProblem) { toast(rawProblem); return; }

    // —— v25 收入单：只填一个金额，没有垫付/邮费/数量，落库全部用**现有字段** ——
    if (isIncome) {
      const raw = String(f.cost.value || "").trim();
      if (!raw) { toast("先填金额"); return; }        // 留空 ≠ 0：填 0 是合法的 0 元收入
      const amount = numberValue(raw);
      if (amount < 0) { toast("金额不能是负数"); return; }
      const order = {
        id: (snap && snap.orderId) ? snap.orderId : uid(),   // 04 期：新单沿用草稿的候选 ID
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
        shipDate: "",                                // v41：收入单不寄件
        createdAt: new Date().toISOString(),
      };
      data.orders.push(order);
      if (!saveData()) return;
      clearTimeout(draftTimer);
      // 保存成功才消费草稿（清不掉也不拦）。按**提交那一刻的快照**清：reopened 的提交也清得对那一份；
      // draftClearSnapshot 锁内会再核 draftId+revision，别页推进过就不删（残留 → 下次按"待核对"处理）。
      if (snap.draftClaimed) withStorageLock(() => draftClearSnapshot({ owner: String(snap.draftOwner || ""), draftId: String(snap.draftId), revision: Number(snap.draftRevision) || 0 }));
      if (reopened) { toast("已记账"); return; }   // 现在开着的是另一张表单，别替用户关掉
      closeForm(true);
      toast("已记账");
      switchView("list");
      return;
    }
    // 03 期：只有「新建货单」这条路可能要求连续录入（收入单/编辑都不给那个入口，这里再兜一道）
    const wantChain = !!chain && !editingAtSubmit && !isIncome;

    const cost = numberValue(f.cost.value);
    if (cost < 0) { toast("垫付金额不能是负数"); return; }
    // v38（报告 B2）：编辑会话先对表再往下走 —— 三条失效路各说各的话，**都在任何写入之前**：
    //   ① 原单已不在账本里（被别的入口删掉）：**必须拒绝**，绝不能落进下面那条「新建」分支
    //      ——那等于拿一份旧表单的草稿凭空造一条新记录；
    //   ② 账本整包被换过（代次变）或原单已被改过（快照对不上）：拒绝落库、草稿留在表单里供核对。
    // 对表放在「0 元购确认框」之前：失效的编辑连确认都不该弹（点完再报「没保存」是骗点击）。
    const existing = editingAtSubmit ? data.orders.find((o) => o.id === editingAtSubmit) : null;
    if (editingAtSubmit && !existing) {
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
      id: existing ? existing.id : (snap && snap.orderId ? snap.orderId : uid()),   // 04 期：新单沿用草稿的候选 ID
      date,
      name,
      platform: existing ? existing.platform : prefillAtSubmit,
      qty: Math.max(1, Math.round(numberValue(f.qty.value)) || 1),
      cost,
      pay: existing ? existing.pay : "",
      channel: String(f.channel.value || "").trim(),
      income: existing ? existing.income : null,
      incomeDate: existing ? existing.incomeDate : null,
      status: f.status.value,
      fee: feeUntouched ? editingOrder.fee : numberValue(f.fee.value),   // v41：没动过就原值带回（见上方校验处的说明）
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
      // v41：编辑不改寄出日期（它只归「寄出 / 改回待寄」两个入口管）；新单一律未寄
      shipDate: existing ? existing.shipDate : "",
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
    };
    if (existing) Object.assign(existing, order, { id: existing.id });
    else data.orders.push(order);
    if (!saveData()) return;
    clearTimeout(draftTimer);
    // 同上：按提交那一刻的快照清理，reopened 也清得对（见 income 分支的注释）。
    if (snap.draftClaimed) withStorageLock(() => draftClearSnapshot({ owner: String(snap.draftOwner || ""), draftId: String(snap.draftId), revision: Number(snap.draftRevision) || 0 }));
    if (reopened) { toast(existing ? "已更新" : "已记账"); return; }   // 同上：这次提交不属于当前这张表单
    if (wantChain) {
      // 保存**已经确认成功**才进入下一单：到这里的 saveData() 返回真，账本已落库、已排同步。
      // 失败（persist 返回 false）在上面那行就 return 了，整张表单原样留着，什么都不清。
      switchView("list");
      startNextOrder();
      toast("已记账，接着记下一单");
      return;
    }
    closeForm(true);
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
    // Existing negative member income may keep its amount while correcting its date.
    f.income.readOnly = payEditMode && curIncome < 0;
    if (f.income.readOnly) f.income.removeAttribute("min");
    else f.income.min = "0";
    $("#payQuick").hidden = f.income.readOnly;
    $("#payForm [data-clear='income']").hidden = f.income.readOnly;
    $("#payNegativeHint").hidden = !f.income.readOnly;
    f.incomeDate.value = payEditMode ? (o.incomeDate || todayStr()) : todayStr();
    $("#payTitle").textContent = `${payEditMode ? "改回款" : "回款"} · ${o.name}`;
    updatePayPreview();
    openModal("#payModal");
    payBaseline = controlState(f);      // 04 期：预填之后取基线，"没动过"才不会被问
    setTimeout(() => f.income.focus(), 120);
  }

  // 04 期（独立复核 P0-2）：回款弹窗也要"确有未保存改动才提醒"。基线在 openPayForm 预填之后取，
  // 所以"打开看一眼就关"不会被问，只提示**当前**改动会丢——**不承诺**刷新后能恢复（规格明文）。
  function payLeaveGuard() {
    const modal = $("#payModal");
    if (!modal.classList.contains("show")) return true;
    if (payBaseline === null || controlState($("#payForm")) === payBaseline) return true;
    return confirm("回款这里有还没保存的改动，离开就丢了。\n确定离开？");
  }

  function closePayForm(force) {
    if (force !== true && !payLeaveGuard()) return false;
    closeModal("#payModal");
    payTargetId = null;
    payEditMode = false;
    paySession = null;   // v38：会话随弹窗关闭一起作废（下次打开重新记一份）
    payBaseline = null;
    return true;
  }

  function updatePayPreview() {
    const o = data.orders.find((x) => x.id === payTargetId);
    if (!o) return;
    const income = numberValue($("#payForm").income.value);
    const profit = income - o.cost - o.fee;
    $("#payPreview").innerHTML = `利润 <b class="${profit > 0 ? "pos" : profit < 0 ? "neg" : ""}">${profit >= 0 ? "+" : ""}${money(profit)}</b>（垫付 ${money(o.cost)}${o.fee ? "＋邮费 " + money(o.fee) : ""}）`;
    $("#paySubmit").textContent = `${payEditMode ? "确认改回款" : "确认回款"} ${money(income)}`;
  }

  function submitPay(ev) { ev.preventDefault(); return withFormIntent(ev.target, paySession, () => paySession, () => submitPayImpl(ev)); }
  function submitPayImpl(ev) {
    ev.preventDefault();
    const undoBefore = clone(data.orders);   // v42：撤销用（写入回调里，这一刻还没改）
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
    if (!validAmountInputs([f.income])) return;
    if (o.income < 0 && income !== o.income) { toast("本次只修回款日期，负回款金额请在分项利润中核对"); return; }
    // v26：改回款 = 只改这一条记录自己的 income 与 incomeDate 两个字段，
    // 状态保持「已回款」（**不产生第二条记录**、不动 cost/fee/qty/批次字段/其它任何一格）。
    // 批内单改回款后批次表头会如实提示「≠ 成员明细合计」——那是预期的：批次口径属于另一个入口
    // （「改本批邮费/回款」），这里绝不顺手去改它。
    // 「回款」（未结算单）仍是老行为：写上金额与日期并置为已回款。
    const wasEdit = payEditMode && o.status === "已回款";
    o.income = income;
    o.incomeDate = f.incomeDate.value || todayStr();
    if (!wasEdit) o.status = "已回款";
    if (!saveData()) return;
    closePayForm(true);      // 04 期：保存成功用显式 bypass，别再问一次
    toast(wasEdit ? `已改回款 ${money(income)}，利润 ${money(orderProfit(o))}` : `已回款 ${money(income)}，利润 ${money(orderProfit(o))}`);
    offerUndo(wasEdit ? `已改回款 ${money(income)}` : `已回款 ${money(income)}`, undoBefore);
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

  function deleteOrder(id) { return withLedgerWrite(() => deleteOrderImpl(id)); }
  function deleteOrderImpl(id) {
    const undoBefore = clone(data.orders);
    const o = data.orders.find((x) => x.id === id);
    if (!o) return;
    const mates = o.batchId ? data.orders.filter((x) => x.batchId === o.batchId) : [];
    const n = mates.length;
    const batchLine = n > 1
      ? `它属于一起寄出的 ${n} 单之一，删掉后该批还剩 ${n - 1} 单${n - 1 === 1 ? "（只剩它自己，「一起寄出」那一栏就没了）" : ""}。\n整批邮费/回款照旧记在剩下的单子上。\n`
      : n === 1 ? "它是「一起寄出」那批的最后一单，删掉这一批就没了。\n" : "";
    if (!confirm(`删除「${o.name}」这一单？\n${batchLine}删除后几秒内可在底部点「撤销」，之后就无法恢复（云端也会删）。`)) return;
    data.orders = data.orders.filter((x) => x.id !== id);
    if (!saveData()) return;
    toast("已删除");
    offerUndo(`已删除「${o.name || "未命名"}」`, undoBefore);
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
    ledgerViewIndex = null;
    meta.updatedAt = new Date().toISOString();
    meta.filter = currentFilter;
    if (!persist()) return false;
    scheduleSync();
    rerenderBatchBlock(batchId);
    // v38（报告 B5）：这一批的钱变了，**派生视图**（看板 / 报表）必须跟着刷。原来只重绘当前批次块，
    // 于是「改进分项利润 → 不刷新、切报表」看到的还是旧商品榜与旧环图（账本已经是对的，两页对不上；
    // 恢复默认分摊那条路同样）。局部重绘照旧保留（避免滚动位置跳动），这里只补两个派生页；
    // 统计公式一个字不动。
    renderDash();
    renderReport();
    renderLedgerNotice();
    return true;
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
    const value = input.value;
    return withLedgerWrite(() => {
      if (!input.isConnected || value !== input.value) { toast("输入已变化，本次没有保存，请重新确认"); return; }
      return commitProfitEditImpl(input);
    });
  }
  function commitProfitEditImpl(input) {
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
  function resetBatchShares(batchId) { return withLedgerWrite(() => resetBatchSharesImpl(batchId)); }
  function resetBatchSharesImpl(batchId) {
    const g = batchGroups().get(batchId);
    const members = data.orders.filter((x) => x.batchId === batchId);
    if (!g || members.length < 2) return;
    const info = batchProfitInfo(g, members);
    if (!info.editable) { toast(batchReasonText(info.reason)); return; }
    const weights = members.map((o) => Math.max(0, toCents(o.cost)));
    const shares = splitByWeight(g.incomeCents, weights);
    if (!validShares(shares, g.incomeCents)) { toast("分摊校验未通过，账本没有改动"); return; }
    members.forEach((o, i) => {
      o.income = shares[i] / 100;
      o.batchIncomeShare = shares[i];
    });
    profitLocks.delete(batchId);
    if (!touchBatchAndRerender(batchId)) return;
    toast("已恢复按垫付占比的默认分摊");
  }

  // 退出本批：结错批时的救回口子。解开这一单的批次归属，**不动它自己的钱**——
  // 整批分摊到它头上的邮费/回款留在它自己的 fee/income 里，照旧算利润（v20 定的规矩）。
  // v23 补的那一半：它带走的份额要**从剩余成员的整批口径里扣掉**，整批录入值才恒等于
  // 「当前成员实际分摊之和」。v22 之前不扣，于是退出后表头永远报一句「整批口径仍含它们」式的
  // 假漂移（D-3），而这句陈述又把同一批的金额告警顶掉，用户分不清是退出还是钱被改坏了。
  function leaveBatch(id) { return withLedgerWrite(() => leaveBatchImpl(id)); }
  function leaveBatchImpl(id) {
    const undoBefore = clone(data.orders);
    const o = data.orders.find((x) => x.id === id);
    if (!o || !o.batchId) return;
    const mates = data.orders.filter((x) => x.batchId === o.batchId);
    const others = mates.filter((x) => x.id !== id);
    const g = batchGroups().get(o.batchId);
    if (g && g.conflictFields.length) { toast(batchReasonText("metadata")); return; }
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
      // v41：离开批次前把「寄出过」这件事留下——没有寄出日期的（升级前成批的老单）沿用批次日期，
      // 否则没单号的老成员一退批就会被当成没寄、掉回「待寄」。已有寄出日期的不动。
      if (!x.shipDate) x.shipDate = cleanShipDate(x.batchDate);
      x.batchId = ""; x.batchDate = ""; x.batchFee = 0; x.batchIncome = 0; x.batchCount = 0;
      x.batchFeeShare = 0; x.batchIncomeShare = 0;
    });
    if (!saveData()) return;
    toast(others.length === 1 ? "已退出，那一批也解散了" : "已退出本批，这一单变成单寄");
    offerUndo("已退出本批", undoBefore);
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
  // v41：opts.mode = "pay" ＝「回款」模式——账本页勾选（一整批 / 若干散单）或批次表头「回款」进来。
  // 同一个弹窗、同一条写账路径（submitBatchImpl），只是：范围在打开那一刻定死（名单不可再勾）、
  // 邮费格隐藏（留空＝不动）、必须填对方总回款。散单 ≥2 单时按既有规则当场合成一批。
  let batchMode = "full";
  function openBatchModal(preselectBatchId, opts = {}) {
    batchMode = opts.mode === "pay" ? "pay" : "full";
    const payIds = batchMode === "pay" && Array.isArray(opts.ids) ? new Set(opts.ids) : null;
    const pool = batchMode === "pay"
      ? data.orders.filter((o) => (payIds ? payIds.has(o.id) && o.status === "在途" : false))
      : data.orders.filter((o) => o.status === "在途");
    if (batchMode === "pay" && payIds && pool.length !== payIds.size) { toast("勾选的单已经变了，请重新勾选"); batchMode = "full"; return; }
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
    // 同批次的单排在一起、批次日期新的在前（先摊了邮费的那批最好找），没成批的殿后。
    // 比较器必须自洽：日期相等返回 0（原来 a.date<b.date?1:-1 在相等时两个方向都给 -1，
    // 是自相矛盾的比较器 ⇒ 同日两单的先后成了实现定义，还会跟账本页「先记的在上」对不上）。
    const rank = new Map();
    pool.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).forEach((o) => {
      if (!o.batchId || rank.has(o.batchId)) return;
      const g = groups.get(o.batchId);
      rank.set(o.batchId, g ? g.date : "");
    });
    pool.sort((a, b) => {
      const ra = a.batchId ? rank.get(a.batchId) : undefined;
      const rb = b.batchId ? rank.get(b.batchId) : undefined;
      if (ra === undefined && rb === undefined) return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
      if (ra === undefined) return 1;
      if (rb === undefined) return -1;
      if (ra !== rb) return ra < rb ? 1 : -1;
      return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    });
    batchItems = pool.map((o) => ({
      id: o.id, name: o.name, cost: o.cost, batchId: o.batchId,
      checked: preselectBatchId ? o.batchId === preselectBatchId : true,
    }));
    if (batchMode === "pay" && preselectBatchId) batchItems = batchItems.filter((it) => it.checked);
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
    const pay = batchMode === "pay";
    $("#batchModal").classList.toggle("pay-mode", pay);
    $("#batchTitle").textContent = pay ? "回款" : "批量结算";
    $("#batchModal .batch-sub").textContent = pay
      ? (preselectBatchId ? "这一整批一起回款：填对方打过来的总数，按垫付占比摊到每一单。"
        : "这几单一起回款，会合成一批：填对方打过来的总数，按垫付占比摊到每一单。")
      : "勾选本次一起寄出的在途单，邮费和回款按垫付占比分摊";
    $("#batchSubmit").textContent = pay ? "确认回款" : "结算";
    const paidIn = pay ? batchItems.map((it) => data.orders.find((o) => o.id === it.id))
      .filter((o) => o && o.status !== "在途") : [];
    const warn = $("#batchPayWarn");
    warn.hidden = paidIn.length === 0;
    warn.textContent = paidIn.length
      ? `这一批里有 ${paidIn.length} 单已经回过款（${paidIn.slice(0, 2).map((o) => o.name || "未命名").join("、")}${paidIn.length > 2 ? "…" : ""}）。`
        + `确认后整批按新总数重新分摊，它们的回款也会一起改成新分摊的数。只想给没回款的那几单记钱，请改用各自卡片上的「回款」。`
      : "";
    renderBatchList();
    openModal("#batchModal");
    batchBaseline = controlState($("#batchModal"));   // 04 期：渲染之后取基线
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
    const sel = selectedBatchInfo();
    const prev = sel.prev;
    // 2026-09-27 补强 D：日期说明与「这一批记着多少钱」分开判——既有批次**不管有没有记过钱**
    // 都要说清「批次日期保持原值、这格是本次到账日期」，否则勾选刚成批（还没钱）时误导照旧。
    const hint = $("#batchDateHint");
    if (hint) {
      if (prev) {
        hint.hidden = false;
        hint.innerHTML = `这一批的批次日期是 <b>${escapeHtml(prev.date || "（空）")}</b>，保持不变。`
          + `上面这格是<b>本次到账日期</b>：填正数回款就按它记；只改邮费不动任何日期。`;
      } else {
        hint.hidden = false;
        hint.innerHTML = `新建／重组批次：这格既是<b>批次日期</b>，也是<b>本次到账日期</b>（填正数回款时按它记）。`;
      }
    }
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

  // 04 期（独立复核 P0-2）：批量结算也要"确有未保存改动才提醒"。基线在弹窗渲染之后取
  //（勾选是控件状态，controlState 会带上 checked），所以"点开看一眼就关"不会被问。
  function batchLeaveGuard() {
    const modal = $("#batchModal");
    if (!modal.classList.contains("show")) return true;
    if (batchBaseline === null || controlState(modal) === batchBaseline) return true;
    return confirm("批量结算这里还没保存的改动，离开就丢了。\n确定离开？");
  }

  function closeBatchModal(force) {
    if (force !== true && !batchLeaveGuard()) return false;
    closeModal("#batchModal");
    batchItems = [];
    batchMode = "full";
    $("#batchModal").classList.remove("pay-mode");
    batchSession = null;   // v38：会话随弹窗关闭一起作废
    batchBaseline = null;
    return true;
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
          <input type="checkbox"${batchMode === "pay" ? " disabled" : ""} data-group="${escapeHtml(it.batchId)}"${onCount === idxs.length ? " checked" : ""}${onCount > 0 && onCount < idxs.length ? ` data-partial="1"` : ""}>
          <span class="bg-title">一起寄 · ${escapeHtml(g ? g.date : "")}</span>
          <span class="bi-cost">${idxs.length} 单</span>
        </label>`);
        if (tags.length > 0) parts.push(`<div class="bg-tags">${tags.join(" · ")}${onCount === idxs.length && batchMode !== "pay" ? `　再填金额＝把这一批改成那个数` : ""}</div>`);
      } else if (!it.batchId && !sepShown && seen.size > 0) {
        sepShown = true;
        parts.push(`<div class="bg-sep">未成批（单寄的单子）</div>`);
      }
      parts.push(`<label class="batch-item${it.batchId ? " in-group" : ""}">
        <input type="checkbox" data-idx="${i}"${it.checked ? " checked" : ""}${batchMode === "pay" ? " disabled" : ""}>
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
    if (batchMode === "pay" && sel.length > 0) {
      // v41：回款模式补一句利润预览（回款 − 垫付 − 各单现有邮费；与卡片利润同一口径）
      const feeCents = sel.reduce((a, it) => a + toCents((data.orders.find((o) => o.id === it.id) || {}).fee), 0);
      const raw = String($("#batchIncome").value || "").trim();
      const profit = raw !== "" && Number.isFinite(Number(raw)) ? toCents(raw) - totalCents - feeCents : null;
      $("#batchSummary").innerHTML = `${sel.length} 单 · 垫付 ${money(totalCents / 100)}${feeCents ? ` · 邮费 ${money(feeCents / 100)}` : ""}`
        + (profit === null ? "" : ` · 利润 <b class="${profit > 0 ? "pos" : profit < 0 ? "neg" : ""}">${money(profit / 100)}</b>`);
      return;
    }
    $("#batchSummary").textContent = sel.length === 0
      ? "还没勾选任何单子"
      : `已选 ${sel.length} 单 · 垫付合计 ${money(totalCents / 100)}`;
  }

  function submitBatch() { return withFormIntent($("#batchModal"), batchSession, () => batchSession, submitBatchImpl); }
  function submitBatchImpl() {
    const undoBefore = clone(data.orders);
    const sel = selectedBatchInfo();
    const selIds = new Set(sel.orders.map((o) => o.id));
    // v38（报告 B10 / D3）：**分摊一律用当前 data.orders 里的成员顺序** —— 与「恢复默认分摊」
    // （resetBatchShares）和分项利润编辑（commitProfitEdit）三处同源。原来这里用的是弹窗排过序的
    // 成员数组，而 splitByWeight 的尾差是**按下标**发的 ⇒ 同一批钱在「结算」与「恢复默认分摊」
    // 两处会把那 1 分发给不同的人（同日三单、整批 ¥3.34 实测：结算 111/111/112、恢复默认 112/111/111）。
    // 只改分摊顺序，**不动弹窗的显示排序**（那是另一码事）。
    const orders = data.orders.filter((o) => selIds.has(o.id));
    if (orders.length === 0) { toast("先勾选要结算的在途单"); return; }
    if (orders.some((o) => o.batchId && batchGroups().get(o.batchId).conflictFields.length)) {
      toast(batchReasonText("metadata")); return;
    }

    // v38（报告 B2）：批量结算弹窗同样绑账本代次 + 所选成员的快照。所选单任一在这期间被别的入口
    // 改过（或账本整包换过），这一批的分摊预期就不成立——整笔拒绝并说明，绝不按旧预期写。
    if (batchSession) {
      if (batchSession.generation !== ledgerGeneration) {
        toast("账本已更新，这次结算没保存，请重新打开核对");
        return;
      }
      const wanted = batchItems.filter((it) => it.checked).map((it) => it.id);
      const moved = orders.filter((o) => batchSession.snaps.get(o.id) !== orderSnap(o));
      if (wanted.some((id) => !orders.some((o) => o.id === id))) {
        toast("所选订单已变动，这次结算没保存，请重新打开核对"); return;
      }
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
      ["#batchDate", "本次到账日期"],
    ]) {
      const input = $(selector);
      if (!input.checkValidity()) {
        input.reportValidity();
        toast(`${label}填写有误，请检查后再结算`);
        return;
      }
    }
    if (!validAmountInputs([$("#batchFee"), $("#batchIncome")])) return;
    // 留空＝这一项一个字不动（保住「先只摊邮费、回款到了再补一趟」的两趟打法）；
    // 填数字＝把这一项**改成这个数**（不是加上去）；填 0＝删掉这一项。
    const feeGiven = batchMode !== "pay" && String($("#batchFee").value || "").trim() !== "";
    const incomeGiven = String($("#batchIncome").value || "").trim() !== "";
    if (batchMode === "pay" && !incomeGiven) { toast("先填对方打过来的总回款"); $("#batchIncome").focus(); return; }
    // 回款模式里填 0 会写成「回款 0、状态仍在途」，提示却像已回款——直接拦下（要删回款走「改本批回款」）
    if (batchMode === "pay" && !(toCents($("#batchIncome").value) > 0)) { toast("回款金额要大于 0"); $("#batchIncome").focus(); return; }
    const feeCents = feeGiven ? Math.max(0, toCents($("#batchFee").value)) : 0;
    const incomeCents = incomeGiven ? Math.max(0, toCents($("#batchIncome").value)) : 0;
    const weights = orders.map((o) => Math.max(0, toCents(o.cost)));
    const prev = sel.prev;
    const batchId = sel.reuseId || uid();
    // v41：回款模式把几张散单当场合成一批时，批次日期取它们**最早的寄出日期**（那才是一起寄的那天；
    // 邮费按批次日期归期）；都没记寄出日期才退回本次到账日期。既有批次保持原日期（规则不变）。
    const earliestShip = batchMode === "pay"
      ? orders.map((o) => o.shipDate || "").filter(Boolean).sort()[0] || "" : "";
    const batchDate = (prev && prev.date) || earliestShip || $("#batchDate").value || todayStr();

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
    const feeShares = feeGiven ? splitByWeight(feeCents, weights) : null;
    const incomeShares = incomeGiven ? splitByWeight(incomeCents, weights) : null;
    if ((feeShares && !validShares(feeShares, feeCents)) || (incomeShares && !validShares(incomeShares, incomeCents))) {
      toast("分摊校验未通过，账本没有改动"); return;
    }
    if (feeGiven) {
      const feeById = new Map(orders.map((o, i) => [o.id, feeShares[i]]));
      orders.forEach((o) => { o.fee = feeById.get(o.id) / 100; o.batchFeeShare = feeById.get(o.id); });
    }

    // 回款同理。总回款 > 0 才把单子置为已回款；填 0 是「删掉这一批的回款」（金额归 0，
    // 状态不因此回退——那一单收没收到钱是另一回事，要改状态去「编辑」里改）。
    if (incomeGiven) {
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

    const payMode = batchMode === "pay";
    if (!saveData()) return;
    closeBatchModal(true);   // 04 期：保存成功用显式 bypass
    const amounts = [];
    if (feeGiven) amounts.push(`邮费 ${money(feeCents / 100)}`);
    if (incomeGiven) amounts.push(`回款 ${money(incomeCents / 100)}`);
    // 直接把结果报出来：改的是已有的那一批（prev 存在）就说「已改成」，新建批次说「已结算」。
    // 纯重摊之后成员明细必然等于整批金额，没有「成员上另有…」这种残值要交代了。
    // v38：留空那两趟也不再写 0 —— 整批口径按**被带入成员的实际合计**建立（D2），
    // 所以措辞说「成员金额没动」（成员那一格确实一个字没动，整批口径跟它们对齐）。
    let msg;
    if (payMode) msg = `已回款 ${money(incomeCents / 100)} · ${orders.length} 单${!prev && orders.length > 1 ? "（合成一批）" : ""}`;
    else if (!feeGiven && !incomeGiven) msg = "这一批的成员与日期已记下，成员金额没动";
    else if (prev) msg = `已改成本批${amounts.join(" · ")} · ${orders.length} 单`;
    else msg = `已结算 ${orders.length} 单${orders.length > 1 ? `（一起寄 ${batchDate.slice(5)}）` : ""} · ${amounts.join(" · ")}`;
    toast(msg);
    offerUndo(msg, undoBefore);
  }

  // ---- 报单（v28：寄出后给收货商报「型号 颜色 数量」）----
  // 用户的痛点：寄出一批之后要向收货商报型号/颜色/数量，货多时得一个个手打。四条取舍：
  //  ① **不新增字段、不从 name 里猜着切型号和颜色**。名称里型号和颜色本来就是粘在一起的自由文本
  //     （「示例手环 4 曜石黑」与「示例手环二代曜石黑」两种写法并存），要切就得靠颜色词表 + 正则，
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

  function baodanApplyTracking(value, targetIds) {
    const ids = targetIds || baodanCompute().orders.map((o) => o.id);
    const session = baodanSession, revision = baodanRevision;
    return withLedgerWrite(() => {
      if (session !== baodanSession || revision !== baodanRevision) { toast("报单内容已变，单号没有保存，请重新核对"); return { ok: false }; }
      const live = ids.map((id) => data.orders.find((o) => o.id === id));
      if (!baodanSessionAlive() || live.some((o) => !o || baodanSession.snaps.get(o.id) !== orderSnap(o))) return { ok: false };
      const changed = live.some((o) => cleanTracking(o.tracking) !== value);
      if (changed) {
        live.forEach((o) => { o.tracking = value; });
        if (!saveData()) return { ok: false };
        live.forEach((o) => baodanSession.snaps.set(o.id, orderSnap(o)));
        baodanCandidates = baodanCandidates.map((o) => data.orders.find((x) => x.id === o.id) || o);
      }
      return { ok: true, changed, count: live.length };
    });
  }

  function markBaodanChanged() {
    baodanRevision += 1;
    if (baodanScope) $("#baodanModal .batch-sub").textContent = "内容已变，请重新复制后再去粘贴。";
  }

  function captureBaodanCopy(text, res, edited) {
    return { session: baodanSession, revision: baodanRevision, seq: ++baodanCopySeq,
      generation: ledgerGeneration, text, ids: res.orders.map((o) => o.id), tracking: res.tracking,
      qty: res.qty, kinds: res.kinds, trackingKinds: bdTrackingPick(res.orders).list.length, edited };
  }

  function baodanCopyAlive(copy) {
    return copy.session === baodanSession && copy.revision === baodanRevision && copy.seq === baodanCopySeq
      && copy.generation === ledgerGeneration && baodanSessionAlive();
  }

  async function commitBaodanTracking() {
    baodanTrackingTouched = true;
    markBaodanChanged();
    const box = $("#baodanTracking");
    box.value = cleanTracking(box.value);
    if (!baodanSessionAlive()) { toast("账本已更新，请重新打开报单核对"); return; }
    const written = await baodanApplyTracking(box.value);
    if (!written || !written.ok) return;
    const res = renderBaodan();
    if (!res.text.trim()) { toast("这个范围里没有可报的单"); return; }
    const copy = captureBaodanCopy(res.text, res, false);
    if (!await writeBaodanClipboard(copy)) return;
    toast(written.changed ? `单号已记到 ${written.count} 单 · 已重新复制` : "单号没变，账本没动 · 已重新复制");
  }

  function writeClipboard(text, box, stillCurrent = () => true) {
    // Serialize requests so an older permission prompt cannot overwrite a newer copy.
    const task = clipboardQueue.catch(() => {}).then(async () => {
      if (!stillCurrent()) return false;
      try { await navigator.clipboard.writeText(text); return true; }
      catch {
        if (!stillCurrent()) return false;
        let temporary = null;
        try {
          let target = box && box.value === text ? box : null;
          if (!target) {
            temporary = document.createElement("textarea");
            temporary.value = text; temporary.setAttribute("readonly", "");
            temporary.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
            document.body.appendChild(temporary); target = temporary;
          }
          target.select();
          return !!document.execCommand("copy");
        } catch { return false; }
        finally { if (temporary) temporary.remove(); }
      }
    });
    clipboardQueue = task.then(() => {}, () => {});
    return task;
  }

  async function writeBaodanClipboard(copy) {
    const hint = $("#baodanModal .batch-sub");
    hint.textContent = "正在复制报单，请稍候。";
    const ok = await writeClipboard(copy.text, $("#baodanText"), () => baodanCopyAlive(copy));
    if (!baodanCopyAlive(copy)) {
      if (copy.session === baodanSession && copy.seq === baodanCopySeq) {
        hint.textContent = "内容已变，请重新复制后再去粘贴。";
        toast("内容已变，请重新复制");
      }
      return false;
    }
    hint.textContent = ok
      ? "这份报单已复制，可以去微信粘贴；修改后请重新复制。"
      : "复制失败：请长按下面的文本框手动全选复制，核对后再去微信粘贴。";
    if (!ok) toast("复制失败：长按面板里的文本框手动全选");
    return ok;
  }

  async function openBaodan(scope) {
    baodanRevision += 1; baodanCopySeq += 1;
    const fromBatch = !!(scope && scope.type === "batch");
    // v41：第三种范围——「这几单」（寄出后自动报单 / 散单卡片上的「报单」）。范围在打开那一刻定死。
    const fromIds = !!(scope && scope.type === "ids");
    baodanScope = { type: fromBatch ? "batch" : fromIds ? "ids" : "filter", batchId: fromBatch ? scope.batchId : "" };
    const idSet = fromIds ? new Set(scope.ids || []) : null;
    baodanCandidates = fromBatch
      ? data.orders.filter((o) => o.batchId === baodanScope.batchId)
      : fromIds ? data.orders.filter((o) => idSet.has(o.id))
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
    if (head) baodanScope.headDate = fromBatch ? (head.batchDate || head.date) : fromIds ? (head.shipDate || head.batchDate || "") : "";
    baodanScope.title = fromBatch
      ? `一起寄出 · ${head ? (head.batchDate || head.date) : ""} · ${baodanCandidates.length} 单`
      : fromIds ? `寄出 · ${head ? (head.shipDate || head.batchDate || todayStr()) : ""} · ${baodanCandidates.length} 单`
        : `账本当前页签「${currentFilter}」· ${baodanCandidates.length} 单`;
    // v31：单号那一格预填**范围里最常见的非空单号**。这里只取预填值，**不存快照**——
    // 提示行按「本次勾选的单」现算（见 bdTrackingHint），这样写库统一之后它自己就消失了。
    baodanTrackingTouched = false;      // 新开一次面板＝这一格还没被用户动过（写账本的必要条件）
    const tkBox = $("#baodanTracking");
    if (tkBox) tkBox.value = bdTrackingPick(baodanCandidates).value;
    const { text } = renderBaodan();
    openModal("#baodanModal");
    // 范围里没有单：面板会写「这个范围里没有可报的单」，但也得给一句 toast —— 点完什么都没发生很像坏了
    if (!text) {
      $("#baodanModal .batch-sub").textContent = "这个范围里没有可报的单，未复制任何内容。";
      toast("这个范围里没有可报的单");
      return;
    }
    const res = baodanCompute();
    const copy = captureBaodanCopy(text, res, false);
    if (!await writeBaodanClipboard(copy)) return;
    toast(copy.trackingKinds > 1
      ? `已复制报单 · ${copy.qty} 件 / ${copy.kinds} 种 · 单号有 ${copy.trackingKinds} 种，先核对面板里的提示再报`
      : `已复制报单 · ${copy.qty} 件 / ${copy.kinds} 种 · 直接去微信粘贴`);
  }

  function closeBaodan() {
    baodanRevision += 1; baodanCopySeq += 1;
    closeModal("#baodanModal");
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
    if (!box.value.trim()) { toast(res.orders.length ? "文本框是空的，先写上要报的内容" : "先勾选要报的单"); return; }
    if (!baodanSessionAlive()) { toast("账本已更新，请重新打开报单核对"); return; }
    const copy = captureBaodanCopy(box.value, res, box.value !== res.text);
    const touched = baodanTrackingTouched;
    if (!await writeBaodanClipboard(copy)) return;
    if (touched) {
      const result = await baodanApplyTracking(copy.tracking, copy.ids);
      if (!result || !result.ok) { toast("文本已复制，单号未保存，请核对账本"); return; }
    }
    toast(copy.edited ? "已复制 · 你改过的那份" : `已复制报单 · ${copy.qty} 件 / ${copy.kinds} 种 · 直接去微信粘贴`);
  }

  // ---- 云同步（改动防抖推送，启动拉取）----
  // ---- Cloud orchestration: requests own an identity and a queue slot ----
  let syncTimer = null, syncPending = false, syncInFlight = null;
  let syncEpoch = 0;
  let suppressPullMerge = false;

  function saveData() {
    meta.updatedAt = new Date().toISOString();
    meta.filter = currentFilter;
    if (!persist()) return false;
    render();
    scheduleSync();
    return true;
  }

  function scheduleSync() {
    syncPending = true;
    clearTimeout(syncTimer);
    if (syncBlocked || localIssue) return;
    syncTimer = setTimeout(flushPendingSync, 450);
  }

  function flushPendingSync() {
    if (!syncPending || syncBlocked || localIssue) return;
    clearTimeout(syncTimer);
    syncToCloud();
  }

  function rememberSyncBase(value, owner = identityRaw()) {
    if (owner !== identityRaw()) return;
    syncBase = clone(value);
    try { localStorage.setItem(SYNC_BASE_KEY, JSON.stringify({ owner: JSON.parse(owner).userId, data: syncBase })); }
    catch { meta.lastSyncError = "云端已处理，本机同步基线未能保存；下次会重新核对"; }
  }

  function preserveConflict(incoming, reason) {
    try {
      localStorage.setItem(RECOVERY_KEY, JSON.stringify({ savedAt: new Date().toISOString(), reason,
        local: clone(data), remote: clone(incoming), localRaw: localStorage.getItem(DATA_KEY),
        snapshotRaw: localStorage.getItem(SNAPSHOT_KEY) }));
      return true;
    } catch {
      syncBlocked = "无法保留冲突副本，已暂停同步。请先导出本机账本，再重试。";
      renderLedgerNotice();
      return false;
    }
  }

  function conflictingIds(incoming) {
    const local = new Map(data.orders.map((o) => [o.id, orderSnap(o)]));
    const remote = new Map(incoming.orders.map((o) => [o.id, orderSnap(o)]));
    const base = new Map((syncBase ? syncBase.orders : []).map((o) => [o.id, orderSnap(o)]));
    const ids = [...new Set([...local.keys(), ...remote.keys(), ...base.keys()])];
    // Whole-ledger replacement also loses disjoint edits; do not imply a per-record merge.
    const bothChanged = syncBase && ids.some((id) => local.get(id) !== base.get(id))
      && ids.some((id) => remote.get(id) !== base.get(id));
    return ids.filter((id) => {
      const left = local.get(id), right = remote.get(id), previous = base.get(id);
      if (left === right) return false;
      if (!syncBase) return left !== undefined && right !== undefined;
      return bothChanged || (left !== previous && right !== previous);
    });
  }

  async function syncToCloud() {
    if (!window.luhuoSync || !window.luhuoSync.isConfigured() || localIssue || syncBlocked || ledgerProblem(data)) return;
    if (!checkWriteBoundary()) return;
    if (syncInFlight) { syncPending = true; return; }
    const request = { epoch: syncEpoch, identity: identityRaw(), data: clone(data), updatedAt: meta.updatedAt };
    syncInFlight = request;
    syncPending = false;
    window.luhuoSync.setStatus("syncing");
    const stale = () => request.epoch !== syncEpoch || request.identity !== identityRaw();
    try {
      const record = await window.luhuoSync.saveData(request.data, request.updatedAt || new Date().toISOString());
      if (stale() || !checkWriteBoundary()) return;
      meta.lastSyncedAt = (record.updatedAt || new Date().toISOString()).replace("T", " ").slice(0, 16);
      meta.lastSyncError = "";
      rememberSyncBase(request.data, request.identity);
      persistMeta();
      renderSyncBadge();
    } catch (error) {
      if (stale() || !checkWriteBoundary()) return;
      meta.lastSyncError = error && error.message ? error.message : String(error);
      persistMeta();
      renderSyncBadge();
    } finally {
      if (syncInFlight === request) syncInFlight = null;
      // A stale request may release its slot, but must not discard the new owner's work.
      if (syncPending && !localIssue && !syncBlocked) syncToCloud();
    }
  }

  async function readCloudRecord() {
    const epoch = syncEpoch, seq = ++pullSeq, owner = identityRaw();
    const stale = () => epoch !== syncEpoch || seq !== pullSeq || owner !== identityRaw();
    try {
      const remote = await window.luhuoSync.loadRecord();
      if (stale()) return { kind: "stale" };
      if (remote === null || remote === undefined) return { kind: "empty" };
      const problem = ledgerProblem(remote.data, true);
      if (problem) return { kind: "failed", error: problem };
      return { kind: "data", data: normalizeData(remote.data), updatedAt: remote.updatedAt || "", identity: owner,
        rawVersion: remote.data && remote.data.version };
    } catch (error) {
      if (stale()) return { kind: "stale" };
      return { kind: "failed", error: error && error.message ? error.message : String(error) };
    }
  }

  async function pullFromCloud() {
    if (!window.luhuoSync || !window.luhuoSync.isConfigured() || !checkWriteBoundary() || ledgerProblem(data)) return { kind: "blocked" };
    // Keep local edits queued until this read confirms what exists on the server.
    syncBlocked = "正在核对云端账本，本机可继续记账，请稍候。";
    window.luhuoSync.setStatus("syncing");
    const result = await readCloudRecord();
    if (result.kind === "stale") return result;
    if (!checkWriteBoundary()) return { kind: "stale" };
    if (result.kind === "failed") {
      syncBlocked = "尚未确认云端账本，已暂停上传。本机可继续记账，联网后请重试同步。";
      meta.lastSyncError = result.error;
      renderSyncBadge(); renderLedgerNotice();
      return result;
    }
    syncBlocked = "";
    meta.lastSyncError = "";
    if (result.kind === "empty") {
      if (data.orders.length) scheduleSync();
      else window.luhuoSync.setStatus("online", "云端暂无数据");
      renderLedgerNotice();
      return result;
    }
    const incoming = clone(result.data);
    const conflicts = conflictingIds(incoming);
    let preferRemote = false;
    if (conflicts.length) {
      if (!preserveConflict(incoming, "本机与云端账本存在不同修改")) return { kind: "blocked" };
      preferRemote = confirm(`本机与云端的账本不同，涉及 ${conflicts.length} 单，已保留两份核对副本。\n确定＝采用云端记录；本机原账仍在设置的核对副本中。云端没有的本机订单会另行询问是否并入。\n取消＝保留本机并暂停同步。`);
      if (!preferRemote) {
        syncBlocked = "账本有待核对的冲突，已保留两份副本并暂停同步。请到设置导出核对后重试。";
        renderLedgerNotice(); return { kind: "blocked" };
      }
    }
    if (preferRemote || !meta.updatedAt || result.updatedAt > meta.updatedAt) {
      const incomingIds = new Set(incoming.orders.map((o) => o.id));
      const localOnly = data.orders.filter((o) => !incomingIds.has(o.id));
      let merged = 0, declined = 0;
      if (localOnly.length && !suppressPullMerge) {
        const names = localOnly.slice(0, 3).map((o) => o.name || "未命名").join("、");
        const keep = confirm(`云端有更新的账本，本机还有 ${localOnly.length} 单是云端没有的：\n${names}${localOnly.length > 3 ? "…" : ""}\n\n点「确定」＝把它们并进账本（推荐）；点「取消」＝放弃这几单，改用云端版本。`);
        if (keep) { incoming.orders = incoming.orders.concat(localOnly); merged = localOnly.length; }
        else declined = localOnly.length;
      }
      const remoteBase = clone(result.data);
      const updatedAt = merged ? new Date().toISOString() : result.updatedAt;
      if (!await setLedger(incoming, updatedAt, { sync: merged > 0 })) return { kind: "blocked" };
      markLegacyLedger(result.rawVersion, incoming.orders);
      rememberSyncBase(remoteBase, result.identity);
      if (merged) toast(`已并入本机 ${merged} 单，正在安排同步`);
      else if (declined) toast(`已采用云端版本（本机 ${declined} 单未并入）`);
      else toast("已从云端取回最新账本");
    } else {
      rememberSyncBase(incoming, result.identity);
      scheduleSync();
    }
    meta.lastSyncError = "";
    persistMeta(); renderSyncBadge(); renderLedgerNotice();
    return result;
  }


  // ---- 设置 ----
  function renderSettings() {
    $("#syncEndpoint").textContent = window.luhuoSync ? window.luhuoSync.endpointLabel() : "-";
    $("#syncLast").textContent = meta.lastSyncedAt || "还没同步过";
    $("#syncErrLine").textContent = meta.lastSyncError || "";
    try { $("#syncCodeText").value = window.luhuoSync.getSyncCode(); } catch { $("#syncCodeText").value = ""; }
    $("#exportRecoveryBtn").hidden = !localStorage.getItem(RECOVERY_KEY) && !localIssue;
    let canRestore = false;
    try {
      const snapshot = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "null");
      canRestore = !!localIssue && snapshot && snapshot.owner === identityOwner() && !ledgerProblem(snapshot.data);
    } catch { /* The original raw data remains available for export. */ }
    $("#restoreSnapshotBtn").hidden = !canRestore;
  }

  function exportRecovery() {
    const recovery = { savedAt: new Date().toISOString(), current: data,
      legacyRaw: localStorage.getItem(DATA_KEY), snapshotRaw: localStorage.getItem(SNAPSHOT_KEY),
      conflictRaw: localStorage.getItem(RECOVERY_KEY) };
    const blob = new Blob([JSON.stringify(recovery, null, 2)], { type: "application/json" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob); anchor.download = `luhuo-recovery-${todayStr()}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 2000);
    toast("已导出核对副本，不含同步码");
  }

  async function applySyncCodeFromForm() {
    const code = $("#applySyncInput").value.trim();
    if (!code) { toast("先粘贴另一台设备的同步码"); return; }
    if (!confirm("导入同步码后，本机将与对方共用同一本账。\n先读取并核对云端，读取失败不会上传，继续？")) return;
    const context = await withStorageLock(() => {
      if (!checkWriteBoundary() || !ensureLocalSnapshot()) return null;
      const previousIdentity = identityRaw(), previousBase = syncBase, local = clone(data);
      try { window.luhuoSync.applySyncCode(code); }
      catch (error) { toast(error.message || "同步码无效"); return null; }
      const appliedIdentity = identityRaw(), epoch = ++syncEpoch;
      pairingEpoch = epoch; syncPending = false; clearTimeout(syncTimer);
      syncBlocked = "正在配对，请稍候；此时不会上传本机账本。";
      syncBase = null; captureStorageBaseline(); invalidateForNewLedger(); renderLedgerNotice();
      return { previousIdentity, previousBase, local, appliedIdentity, epoch, baseline: { ...storageBaseline } };
    });
    if (!context) return;
    const { previousIdentity, previousBase, local, appliedIdentity, epoch, baseline } = context;
    const stale = () => epoch !== syncEpoch || appliedIdentity !== identityRaw();
    const rollback = () => withStorageLock(() => {
      if (stale()) return false;
      if (localStorage.getItem(DATA_KEY) !== baseline.data || localStorage.getItem(SNAPSHOT_KEY) !== baseline.snapshot) {
        showLedgerIssue("配对期间本机账本已变动，请保留草稿后重新载入核对。"); return false;
      }
      try { localStorage.setItem(IDENTITY_KEY, previousIdentity); captureStorageBaseline(); syncBase = previousBase; return true; }
      catch { showLedgerIssue("配对未完成，身份状态未能恢复。请保留本机账本后重新载入核对。"); return false; }
    });
    let committed = false;
    try {
      const result = await readCloudRecord();
      if (stale() || result.kind === "stale") return;
      if (result.kind === "failed") {
        if (!await rollback()) return;
        meta.lastSyncError = result.error;
        syncBlocked = "配对读取失败，未上传任何账本。原本机账本已保留，请重新配对。";
        toast("配对未完成，未上传本机账本"); return;
      }
      if (!checkWriteBoundary()) { await rollback(); return; }
      const incoming = result.kind === "data" ? clone(result.data) : { version: LEDGER_VERSION, orders: [] };
      const conflicts = conflictingIds(incoming);
      if (conflicts.length && (!preserveConflict(incoming, "配对时存在不同记录")
        || !confirm(`有 ${conflicts.length} 单与云端不同。已保留两份恢复副本。\n确定采用云端对应记录并继续配对？取消会恢复原身份。`))) {
        if (await rollback()) syncBlocked = "配对已暂停，两份记录可在设置中导出核对。";
        return;
      }
      const ids = new Set(incoming.orders.map((o) => o.id));
      const extra = local.orders.filter((o) => !ids.has(o.id)); incoming.orders.push(...extra);
      syncBlocked = "";
      if (!await setLedger(incoming, extra.length || result.kind === "empty" ? new Date().toISOString() : result.updatedAt,
        { meta: { lastSyncedAt: null, lastSyncError: "" } })) { await rollback(); return; }
      committed = true;
      if (stale()) return;
      if (result.kind === "data") markLegacyLedger(result.rawVersion, result.data.orders);
      rememberSyncBase(result.kind === "data" ? result.data : { version: LEDGER_VERSION, orders: [] }, appliedIdentity);
      scheduleSync();
      toast(extra.length ? `已配对，并找回本机 ${extra.length} 单` : "同步码已导入"); renderSettings();
    } catch (error) {
      if (committed) { showLedgerIssue("账本已保存，界面状态暂时无法更新，请重新载入核对。"); return; }
      if (await rollback()) {
        syncBlocked = "配对未完成，未上传本机账本，请检查同步码后重试。";
        toast(error.message || "同步码无效");
      }
    } finally {
      if (pairingEpoch === epoch) pairingEpoch = null;
      if (epoch === syncEpoch) { renderLedgerNotice(); renderSyncBadge(); }
    }
  }

  function resetLocalIdentity() { return withStorageLock(resetLocalIdentityLocked); }
  function resetLocalIdentityLocked() {
    if (!checkWriteBoundary()) return;
    if (!confirm("重置后本机将生成全新空账本（云端旧账不受影响，但没有同步码就再也连不上）。\n确定重置？")) return;
    if (!confirm("再次确认：当前账本将替换为空账本。请先导出备份并保留旧同步码，确定？")) return;
    if (!ensureLocalSnapshot()) return;
    const previousIdentity = identityRaw();
    const previousBase = syncBase;
    ++syncEpoch; pairingEpoch = null;
    syncPending = false; clearTimeout(syncTimer);
    try {
      window.luhuoSync.resetIdentity();
      captureStorageBaseline();
      syncBlocked = ""; syncBase = null;
      if (!setLedgerNow({ version: LEDGER_VERSION, orders: [] }, null,
        { meta: { lastSyncedAt: null, lastSyncError: "", filter: "待寄" } })) {
        localStorage.setItem(IDENTITY_KEY, previousIdentity); syncBase = previousBase; captureStorageBaseline(); return;
      }
      currentFilter = "待寄"; selection.clear();
      render(); renderSettings(); toast("已重置为新账本");
    } catch {
      try { localStorage.setItem(IDENTITY_KEY, previousIdentity); captureStorageBaseline(); } catch { /* Remain blocked. */ }
      showLedgerIssue("重置未完成，原账本仍保留。请检查本机存储后重新载入。");
    }
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

  // v42：回报率＝利润 ÷ 垫付（只在垫付 > 0 时有意义；0 元购、收入单不显示）。按「分」算，保留 1 位小数。
  function roiText(profitCents, costCents) {
    if (!(costCents > 0)) return "";
    const pct = Math.round((profitCents / costCents) * 1000) / 10;
    return `${pct}%`;
  }

  // v42：导出给人看的表格（CSV）。UTF-8 带 BOM，Excel 打开中文不乱码；每格按 RFC 4180 转义；
  // 以 = + - @ 开头的文本前面补一个单引号，防止被表格软件当成公式执行（CSV 注入）。
  // 金额列写纯数字（两位小数），方便在表格里直接求和；这份文件不能导回网站，备份恢复请用 JSON。
  function exportCsv() {
    const cell = (v) => {
      let t = v === null || v === undefined ? "" : String(v);
      if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = "'" + t;
      return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const num = (v) => (Number.isFinite(Number(v)) ? (Math.round(Number(v) * 100) / 100).toFixed(2) : "");
    const head = ["下单日期", "商品", "数量", "渠道", "阶段", "垫付", "邮费", "回款", "回款日期", "利润", "回报率",
      "寄出日期", "快递单号", "一起寄批次日期", "备注"];
    const rows = data.orders.slice()
      .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1))
      .map((o) => {
        const hasInc = o.income !== null && o.income !== undefined;
        const profitCents = hasInc || isSettled(o) ? toCents(orderProfit(o)) : null;
        const stage = orderStage(o);
        return [o.date, o.name, o.qty, o.channel, stage === "遗留" ? statusLabel(o.status) : stage,
          num(o.cost), num(o.fee), hasInc ? num(o.income) : "", o.incomeDate || "",
          profitCents === null ? "" : (profitCents / 100).toFixed(2),
          profitCents === null ? "" : roiText(profitCents, toCents(o.cost)),
          o.shipDate || "", cleanTracking(o.tracking), o.batchDate || "", o.note].map(cell).join(",");
      });
    const csv = "\ufeff" + [head.map(cell).join(","), ...rows].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `撸货记账-${todayStr().replace(/-/g, "")}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(`已导出表格 · ${data.orders.length} 单`);
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(reader.result);
        const problem = ledgerProblem(parsed, true);
        if (problem) { toast(problem); return; }
        const incoming = normalizeData(parsed);
        if (!confirm(`导入 ${incoming.orders.length} 单，覆盖当前账本（${data.orders.length} 单）？\n建议先导出备份。`)) return;
        if (localIssue && !preserveConflict(incoming, "导入修正版本前的本机原数据")) return;
        if (!await setLedger(incoming, new Date().toISOString(), { sync: true, recovery: true })) return;
        markLegacyLedger(parsed.version, incoming.orders);
        toast("导入完成");
      } catch {
        toast("文件格式不对，导入失败");
      }
    };
    reader.readAsText(file);
  }

  // ---- 视图切换 / toast ----
  const modalOpeners = new Map();
  const modalStack = [];

  function topModal() {
    const id = [...modalStack].reverse().find((name) => $(name).classList.contains("show"));
    return id ? $(id) : $$(".modal.show").at(-1);
  }

  function refreshModalAccess() {
    const top = topModal();
    $$("main, header, .tabbar, #fab").forEach((node) => { node.inert = !!top; });
    $$(".modal").forEach((node) => {
      node.inert = !!top && node !== top;
      node.setAttribute("aria-hidden", node.classList.contains("show") ? "false" : "true");
    });
  }

  function openModal(selector) {
    const modal = $(selector);
    modalOpeners.set(selector, document.activeElement);
    const index = modalStack.indexOf(selector); if (index >= 0) modalStack.splice(index, 1);
    modalStack.push(selector); modal.classList.add("show"); refreshModalAccess();
    renderLedgerNotice();
    const first = [...modal.querySelectorAll("input, select, textarea, button")].find((node) => !node.disabled && node.getClientRects().length);
    if (first) first.focus({ preventScroll: true });
  }

  function closeModal(selector) {
    $(selector).classList.remove("show");
    const index = modalStack.indexOf(selector); if (index >= 0) modalStack.splice(index, 1);
    refreshModalAccess();
    const opener = modalOpeners.get(selector); modalOpeners.delete(selector);
    if (opener && opener.isConnected && opener.tabIndex >= 0 && !opener.closest("[inert]") && opener.getClientRects().length) opener.focus({ preventScroll: true });
    else if (!topModal()) $("#fab").focus({ preventScroll: true });
  }

  function dismissModal(modal) {
    const close = { formModal: closeForm, payModal: closePayForm, batchModal: closeBatchModal,
      baodanModal: closeBaodan, lookupModal: closeLookup, shipModal: closeShipForm, settingsModal: closeSettings };
    if (modal && close[modal.id]) return close[modal.id]();
  }

  function switchView(view) {
    // v41：底部只剩「账本 / 统计」。"dash"（旧看板）是 "report" 的别名：统计页＝总览（#view-dash）＋报表
    if (view === "dash") view = "report";
    $$(".view").forEach((v) => v.classList.toggle("active",
      v.id === "view-" + view || (view === "report" && v.id === "view-dash")));
    $$(".tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
    $$("#listMoreMenu").forEach((m) => { m.hidden = true; });
    if (view !== "list" && selection.size) { selection.clear(); renderList(); }
    window.scrollTo(0, 0);
  }

  // ---- v42：撤销（回款 / 整批回款与结算 / 寄出 / 删除 / 退出本批 / 改回待寄 之后 6 秒内） ----
  // 只在**账本此刻仍与那次操作刚完成时一模一样**时才允许撤销：期间有任何别的改动（另一笔记账、
  // 云端拉取换包、导入）都不撤——不在新账上硬套旧快照。撤销本身也走同一个写入事务与保存路径。
  let undoState = null, undoTimer = null;
  function offerUndo(label, before) {
    if (!Array.isArray(before)) return;
    undoState = { before, after: JSON.stringify(data.orders), generation: ledgerGeneration };
    const bar = $("#undoBar");
    if (!bar) return;
    $("#undoText").textContent = label;
    bar.hidden = false;
    document.body.classList.add("has-undo");
    clearTimeout(undoTimer);
    // 面板开着时撤销条在面板下面看不见——这段时间不计入那 6 秒（比如寄出后自动弹出的报单面板）
    const arm = () => { undoTimer = setTimeout(() => (topModal() ? arm() : hideUndo()), 6000); };
    arm();
  }
  function hideUndo() {
    clearTimeout(undoTimer);
    const bar = $("#undoBar");
    if (bar) bar.hidden = true;
    document.body.classList.remove("has-undo");
    undoState = null;
  }
  function doUndo() {
    const st = undoState;
    hideUndo();
    if (!st) return;
    return withLedgerWrite(() => {
      if (st.generation !== ledgerGeneration || JSON.stringify(data.orders) !== st.after) {
        toast("账本已经有新的改动，这一步没法撤销了");
        return false;
      }
      data.orders = clone(st.before);
      if (!saveData()) return false;
      toast("已撤销");
      return true;
    });
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
    openModal("#settingsModal");
  }
  function closeSettings() { closeModal("#settingsModal"); }

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
  // 卡片/表头上那些 data-act 按钮的**唯一**处理支——账本页 (#orderList) 与查账面板 (#lookupList)
  // 共用它，免得两条路各写一套、日子久了行为分叉。
  // v32：折叠开关（触发区只有表头第一行那个 button，它里面没有嵌套按钮）。注意判断顺序：落在别的
  // 按钮上时 closest 先命中的是那个按钮，下面这些分支各走各的，折叠只在真的点到 .bh-top 时发生——
  // 所以点「改本批邮费」不会顺手收起这一批。
  function handleCardAction(btn) {
    if (btn.dataset.act === "btoggle") { toggleBatchBlock(btn); return; }
    const { act, id } = btn.dataset;
    // v41：卡片「更多」只切这一张卡的显隐（不重渲染整列表，保住滚动位置）
    if (act === "more") {
      const box = btn.closest(".order-card") && btn.closest(".order-card").querySelector(".order-more");
      if (!box) return;
      box.hidden = !box.hidden;
      btn.setAttribute("aria-expanded", String(!box.hidden));
      btn.setAttribute("aria-label", box.hidden ? "更多操作" : "收起操作");
      btn.closest(".order-card").classList.toggle("more-open", !box.hidden);
      return;
    }
    if (act === "shipnew") { openShipForm({ kind: "new", ids: [id] }); return; }
    if (act === "unship") { unshipOrder(id); return; }
    if (act === "bd1") { openBaodan({ type: "ids", ids: [id] }); return; }
    if (act === "bpay") { openBatchModal(btn.dataset.batch || "", { mode: "pay" }); return; }
    if (act === "bship") { openShipForm({ kind: "batch", batchId: btn.dataset.batch || "" }); return; }
    if (act === "pay") openPayForm(id);
    else if (act === "dup") duplicateOrder(id);
    else if (act === "edit") openForm(data.orders.find((x) => x.id === id));
    else if (act === "unbatch") leaveBatch(id);
    // 02 期：补寄出信息（散单＝这一单；批内单＝这一整批，范围由 openShipForm 定死）
    else if (act === "ship") {
      const o = data.orders.find((x) => x.id === id);
      if (!o) return;
      openShipForm(o.batchId ? { kind: "batch", batchId: o.batchId } : { kind: "loose", id: o.id });
    }
    // 批次表头上的「改本批邮费」：直接开批量结算并预选这一批的全部成员（含已回款的）
    else if (act === "batchfee") openBatchModal(btn.dataset.batch || "");
    // v28：批次表头上的「报单」——范围就是这一批的全部成员（不看在不在途：报单发生在寄出后）
    else if (act === "baodan") openBaodan({ type: "batch", batchId: btn.dataset.batch || "" });
    // v35：分项利润行内编辑 + 恢复默认分摊（都只动这一批的回款分摊，整批总额不变）
    else if (act === "pedit") startProfitEdit(btn);
    else if (act === "breset") resetBatchShares(btn.dataset.batch || "");
    else if (act === "del") deleteOrder(id);
  }

  function bind() {
    const modalTitles = { formModal: "formTitle", payModal: "payTitle", batchModal: "batchTitle", baodanModal: "baodanTitle", lookupModal: "lookupTitle", shipModal: "shipTitle", settingsModal: "settingsTitle" };
    $$(".modal").forEach((modal) => {
      modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-labelledby", modalTitles[modal.id]); modal.tabIndex = -1;
      const title = modal.querySelector("h2"); if (title && !title.id) title.id = modalTitles[modal.id];
      if (modal.id !== "settingsModal") {
        const errorLine = document.createElement("p"); errorLine.className = "save-error";
        errorLine.hidden = true; errorLine.setAttribute("role", "status");
        title.insertAdjacentElement("afterend", errorLine);
      }
    });
    refreshModalAccess();
    $("#reloadLedgerBtn").addEventListener("click", () => {
      if (topModal() && !confirm("重新载入会关闭当前草稿，请先复制需要保留的内容。继续？")) return;
      window.location.reload();
    });
    $("#retrySyncBtn").addEventListener("click", () => syncBlocked.includes("配对") ? applySyncCodeFromForm() : pullFromCloud());
    $("#noticeExportBtn").addEventListener("click", () => localIssue ? exportRecovery() : exportJson());
    $("#exportRecoveryBtn").addEventListener("click", exportRecovery);
    $("#restoreSnapshotBtn").addEventListener("click", async () => {
      let snapshot;
      try { snapshot = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "null"); } catch { return; }
      if (!snapshot || snapshot.owner !== identityOwner() || ledgerProblem(snapshot.data)) return;
      if (!confirm("采用最近一次完整保存的账本？当前不同的原始数据会保留为核对副本。")) return;
      if (!preserveConflict(snapshot.data, "采用最近完整快照前的不同数据")) return;
      if (await setLedger(normalizeData(snapshot.data), snapshot.updatedAt, { recovery: true })) {
        syncBlocked = "已恢复完整快照，请核对后重试同步。"; renderSettings(); renderLedgerNotice(); toast("已采用完整快照，原始差异副本仍保留");
      }
    });
    window.addEventListener("storage", (event) => {
      // 04 期：草稿键单独处理——**别页推进了同一份草稿**时锁住本页的草稿写入、保留 DOM 输入、提示冲突；
      // 不合并、不最后写入获胜。（草稿键与账本键互不影响：草稿事件不触发账本被更新那条暂停。）
      if (event.storageArea === localStorage && event.key && event.key.indexOf(DRAFT_KEY_PREFIX + ":") === 0) {
        const owner = draftOwner();
        if (!owner || event.key !== draftKeyFor(owner) || !draftState || editingId) return;
        const cur = draftRead(owner);
        if (!cur) return;                       // 别页删掉了草稿：不自动处理，留给用户（不静默重建）
        if (String(cur.draftId) !== String(draftState.draftId)
          || Number(cur.revision) !== Number(draftState.revision)) {
          draftState.conflict = true;
          draftState.status = "conflict";
          draftRender();
        }
        return;
      }
      if (event.storageArea !== localStorage || (event.key !== null && ![DATA_KEY, SNAPSHOT_KEY, IDENTITY_KEY].includes(event.key))) return;
      if (!storageBaseline || (identityRaw() === storageBaseline.identity && localStorage.getItem(DATA_KEY) === storageBaseline.data && localStorage.getItem(SNAPSHOT_KEY) === storageBaseline.snapshot)) return;
      ++syncEpoch; pairingEpoch = null; invalidateForNewLedger();
      showLedgerIssue("其他页面已更换或更新账本。本页已停止写入，请先保留草稿，再重新载入。");
    });
    document.addEventListener("keydown", (event) => {
      const modal = topModal(); if (!modal) return;
      if (event.key === "Escape") { event.preventDefault(); dismissModal(modal); return; }
      if (event.key !== "Tab") return;
      const nodes = [...modal.querySelectorAll("button, input, select, textarea, a[href], [tabindex]")]
        .filter((node) => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (!first) { event.preventDefault(); modal.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    });
    $$(".tabbar button").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
    $("#settingsBtn").addEventListener("click", openSettings);
    $("#fab").addEventListener("click", () => openForm(null));

    // ---- v41：账本页顶部 ⋯ 菜单、勾选操作条、两条提示 ----
    const moreMenu = $("#listMoreMenu");
    $("#listMoreBtn").addEventListener("click", (ev) => {
      ev.stopPropagation();
      moreMenu.hidden = !moreMenu.hidden;
      $("#listMoreBtn").setAttribute("aria-expanded", String(!moreMenu.hidden));
    });
    moreMenu.addEventListener("click", () => { moreMenu.hidden = true; $("#listMoreBtn").setAttribute("aria-expanded", "false"); });
    document.addEventListener("click", (ev) => {
      if (!moreMenu.hidden && !ev.target.closest("#listMoreMenu, #listMoreBtn")) {
        moreMenu.hidden = true; $("#listMoreBtn").setAttribute("aria-expanded", "false");
      }
    });
    $("#orderList").addEventListener("change", (ev) => {
      const cb = ev.target.closest("input[data-sel]");
      if (!cb) return;
      if (cb.checked) selection.add(cb.dataset.sel); else selection.delete(cb.dataset.sel);
      renderSelBar();
    });
    $("#selClear").addEventListener("click", () => {
      selection.clear();
      $$("#orderList input[data-sel]").forEach((cb) => { cb.checked = false; });
      renderSelBar();
    });
    $("#selGo").addEventListener("click", runSelection);
    $("#selAll").addEventListener("click", () => {
      const keys = [...selectableKeys()];
      const allOn = keys.length > 0 && keys.every((k) => selection.has(k));
      selection.clear();
      if (!allOn) keys.forEach((k) => selection.add(k));
      $$("#orderList input[data-sel]").forEach((cb) => { cb.checked = selection.has(cb.dataset.sel); });
      renderSelBar();
    });
    $("#checkHint").addEventListener("click", () => { openLookup(); setLookupTab("check"); });
    $("#upgradeHintGo").addEventListener("click", () => {
      const list = upgradeCandidates();
      currentFilter = "待寄"; meta.filter = currentFilter; persistMeta();
      selection.clear();
      list.forEach((o) => selection.add("o:" + o.id));
      renderList();
      toast(`已勾上 ${list.length} 单，取消没寄的那几单，再点「寄出」`);
    });
    $("#upgradeHintDone").addEventListener("click", () => {
      meta.v41HintDone = true; persistMeta(); renderListHints();
    });
    $$("#shipTogetherRow .seg").forEach((b) => b.addEventListener("click", () => {
      shipTogether = b.dataset.together === "1";
      applyShipTogetherUi();
    }));
    $("#batchIncome").addEventListener("input", updateBatchSummary);
    $("#formDateToggle").addEventListener("click", () => {
      const f = $("#orderForm");
      f.querySelector(".fld-date").classList.add("open");
      updateDateToggle();
      setTimeout(() => { try { f.date.focus(); if (f.date.showPicker) f.date.showPicker(); } catch { /* 有的浏览器不让程序弹日期选择器 */ } }, 30);
    });
    $("#orderForm").date.addEventListener("change", updateDateToggle);
    $$("#orderForm .stepper button").forEach((b) => b.addEventListener("click", () => {
      const q = $("#orderForm").qty;
      const next = Math.max(1, (Math.round(numberValue(q.value)) || 1) + Number(b.dataset.step));
      q.value = next;
      q.dispatchEvent(new Event("input", { bubbles: true }));
    }));
    $("#formShipInfoBtn").addEventListener("click", async () => {
      const o = editingId && data.orders.find((x) => x.id === editingId);
      if (!o) return;
      const target = o.batchId ? { kind: "batch", batchId: o.batchId } : { kind: "loose", id: o.id };
      const closed = await closeForm();
      if (closed) openShipForm(target);
    });

    $("#filterChips").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-filter]");
      if (!btn) return;
      if (currentFilter !== btn.dataset.filter) selection.clear();
      currentFilter = btn.dataset.filter;
      meta.filter = currentFilter;
      persistMeta();
      renderList();
    });

    $("#orderList").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-act]");
      if (btn) { handleCardAction(btn); return; }
      // v42：点卡片空白处＝展开/收起这张卡的「更多」（按钮、勾选框、输入框、链接不算）
      if (ev.target.closest("button, input, label, a, select, textarea, .order-more")) return;
      if (window.getSelection && String(window.getSelection()).length) return;   // 正在选文字（复制单号）时不切
      const card = ev.target.closest(".order-card");
      const more = card && card.querySelector('.order-actions [data-act="more"]');
      if (more) handleCardAction(more);
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

    // ---- 01 期：查账面板（只读查找视图）的入口与交互 ----
    $("#lookupBtn").addEventListener("click", openLookup);
    $("#lookupClose").addEventListener("click", closeLookup);
    // 关键词：**只重绘结果区，绝不重建输入框本身**——所以焦点、软键盘与输入法候选都不会被打断。
    // 中文组词期间（isComposing / compositionstart→compositionend 之间）刻意**不重绘**，
    // 组词一结束再算一次：打字打到一半结果列表乱跳，是最容易把候选框打飞的做法。
    $("#lookupInput").addEventListener("compositionstart", () => { lookup.composing = true; });
    $("#lookupInput").addEventListener("compositionend", (ev) => {
      lookup.composing = false;
      lookup.q = ev.target.value;
      renderLookup();
    });
    $("#lookupInput").addEventListener("input", (ev) => {
      lookup.q = ev.target.value;
      if (lookup.composing || ev.isComposing) return;
      renderLookup();
    });
    // <input type="search"> 上点原生小叉会走 search 事件（不冒泡，得挂在元素自己身上）
    $("#lookupInput").addEventListener("search", (ev) => { lookup.q = ev.target.value; renderLookup(); });
    $("#lookupClear").addEventListener("click", () => {
      lookup.q = "";
      $("#lookupInput").value = "";
      // 清空后把焦点还给关键词框：接着就能打字，且不移动页面（focus 的默认滚动被 preventScroll 挡掉）
      $("#lookupInput").focus({ preventScroll: true });
      renderLookup();
    });
    $("#lookupStatus").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-lkstatus]");
      if (!btn) return;
      lookup.status = btn.dataset.lkstatus;   // 切状态**不重置**关键词与日期（三个条件取交集）
      renderLookup();
    });
    $("#lookupDateBtn").addEventListener("click", () => {
      lookup.panel = !lookup.panel;
      // 展开时从与当前范围相符的那一层开始：某年 → 看月；某月/某日 → 看日；全部/待核对 → 看年
      if (lookup.panel) {
        lookup.level = lookup.dateMode === "y" ? "month"
          : (lookup.dateMode === "ym" || lookup.dateMode === "ymd") ? "day" : "year";
      }
      renderLookup();
    });
    $("#lookupDates").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      const ds = btn.dataset;
      const go = (level) => { if (level) lookup.level = level; renderLookup(); };
      // 「全部日期」/「日期待核对」都把面板**带回年份层**：不复位 level 的话，面板会停在一个
      // 已经无意义的层上（比如选过 2026-01 再点全部日期，月层还拿着 y=2026、标题却能显示成 0-00）。
      if (ds.lkall) { lookupSetDate("all"); go("year"); return; }
      if (ds.lkbad) { lookupSetDate("bad"); go("year"); return; }
      if (ds.lkyear) { lookupSetDate("y", lookup.y); go("month"); return; }
      if (ds.lkmonth) { lookupSetDate("ym", lookup.y, lookup.m); go("day"); return; }
      if (ds.lkback) { go(ds.lkback); return; }
      // 点年份＝看整年并下钻到月；点月份＝看整月并下钻到日；点某日＝只看那一天
      if (ds.lky !== undefined) { lookupSetDate("y", Number(ds.lky)); go("month"); return; }
      if (ds.lkm !== undefined) { lookupSetDate("ym", lookup.y, Number(ds.lkm)); go("day"); return; }
      if (ds.lkd !== undefined) { lookupSetDate("ymd", lookup.y, lookup.m, Number(ds.lkd)); go(); return; }
    });
    // 结果区：卡片上的**单笔**动作走与账本页同一个 handleCardAction（范围无歧义）；
    // 「查看完整批次 / 只看命中」是查账面板自己的开关（内存态，不落库）。
    $("#lookupList").addEventListener("click", (ev) => {
      const whole = ev.target.closest("button[data-lkwhole]");
      if (whole) {
        const id = whole.dataset.lkwhole;
        if (lookup.expanded.has(id)) lookup.expanded.delete(id); else lookup.expanded.add(id);
        renderLookupList();
        return;
      }
      const btn = ev.target.closest("button[data-act]");
      if (btn) handleCardAction(btn);
    });

    // ---- 02 期：寄出信息面板 ----
    $("#shipCancel").addEventListener("click", closeShipForm);
    $("#shipSubmit").addEventListener("click", submitShip);
    // 单号那一格：写不写只看**当前值**（非空就写）或"是否点了清空"，所以这里输入只需要
    // 把"清空意图"撤掉——用户改回手输，意图就由值本身表达了。
    $("#shipTracking").addEventListener("input", () => { if (shipSession) shipSession.trackingClear = false; updateShipTrackingHint(); });
    $("#shipTrackingClear").addEventListener("click", (ev) => {
      ev.preventDefault();
      $("#shipTracking").value = "";
      if (shipSession) shipSession.trackingClear = true;     // 清空＝明确意图，不是"没改"
      updateShipTrackingHint();
      $("#shipTracking").focus({ preventScroll: true });
    });
    $("#shipFeeClear").addEventListener("click", (ev) => {
      ev.preventDefault();
      // 邮费那一格留空＝不改，所以「清空」不能也做成留空（那等于没按钮）。
      // 照 #payForm 回款那一格的既有做法：清空＝**置 0**（置 0 本来就是明确意图，常见于包邮）。
      $("#shipFee").value = "0";
      $("#shipFee").focus({ preventScroll: true });
    });

    // ---- 04 期：新单草稿 ----
    // 草稿条上的两个选择：继续那一单 / 丢弃草稿。**恢复只回填，仍然要用户自己点保存**。
    $("#formDraftBar").addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button[data-draft]");
      if (!btn) return;
      ev.preventDefault();
      const what = btn.dataset.draft;
      if (what === "continue") draftApplyToForm();
      else if (what === "newone") draftEnterNewOrder();
      else if (what === "discard") await draftDiscard();     // 04 审查第 4 项：等真实结果再说话
    });
    // 任何一格的输入/选择变动都尝试暂存（防抖 400ms）。**只在新单这条路上生效**（draftSchedule 自己判），
    // 编辑既有单完全不碰草稿。
    $("#orderForm").addEventListener("input", () => { if (!editingId) draftSchedule(); });
    $("#orderForm").addEventListener("change", () => { if (!editingId) draftSchedule(); });
    // ---- 03 期：连续录入与历史商品名建议 ----
    $("#formSaveNext").addEventListener("click", submitFormNext);
    // 近期名称建议：**只改名称这一格**——不碰金额、渠道、数量、日期、备注，也不自动提交。
    // 点完把光标留在这格后面，方便接着改（手机上不弹键盘，用户想改再点）。
    $("#formRecent").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-rn]");
      if (!btn) return;
      ev.preventDefault();
      const f = $("#orderForm");
      f.goods.value = btn.dataset.rn;
      nameAuto = false;      // 这是用户选的，不是我们替他补的默认值
      f.goods.focus({ preventScroll: true });
    });

    // ---- 05 期：查账 / 核对 两个页签，以及清单里的「去查看这一单」 ----
    $("#lkTabs").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-lktab]");
      if (btn) setLookupTab(btn.dataset.lktab);
    });
    $("#lkFocusBack").addEventListener("click", () => {
      lookup.focusId = "";
      lookup.focusBatchId = "";
      setLookupTab("check");                 // 回到核对清单（原路返回）
    });
    $("#checkList").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-chk-go], button[data-chk-batch]");
      if (!btn) return;
      // 只带路，不代写：真正的补录/编辑仍走 01/02 自己的入口与写守门
      checklistGoTo(btn.dataset.chkGo || "", btn.dataset.chkBatch || "");
    });

    $("#orderForm").addEventListener("submit", submitForm);
    $("#formCancel").addEventListener("click", () => closeForm());   // 04 期：取消要过离开保护（有改动才问）
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
    $("#payCancel").addEventListener("click", () => closePayForm());
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
      markBaodanChanged();
      const all = baodanCandidates.length > 0 && baodanSel.size === baodanCandidates.length;
      baodanSel = all ? new Set() : new Set(baodanCandidates.map((o) => o.id));
      renderBaodan();
    });
    $("#baodanList").addEventListener("change", (ev) => {
      const cb = ev.target.closest("input[data-bd]");
      if (!cb) return;
      markBaodanChanged();
      if (cb.checked) baodanSel.add(cb.dataset.bd); else baodanSel.delete(cb.dataset.bd);
      renderBaodan();        // 勾选一变：件数/种数/报单文本一起重算
    });
    // v31：单号那一格分两个时机：
    //   input  = 每敲一下：只重算文本第 2 行（看得见就行，不写账本——写账本要等用户离开这一格）
    //   change = 用户真的改完了（blur / 回车）：写账本（若值变了）→ 重算 → **重新复制剪贴板** → toast，
    //            这一套在 commitBaodanTracking 里。为什么必须是 change 而不是 input：打字途中的半截单号
    //            会一次次写进账本、还每次重算文本；而复制挂在 change 上，剪贴板才不会停在打开面板那一刻的旧文本
    $("#baodanTracking").addEventListener("input", () => { markBaodanChanged(); renderBaodan(); });
    $("#baodanText").addEventListener("input", markBaodanChanged);
    $("#baodanTracking").addEventListener("change", () => commitBaodanTracking());
    $("#batchCancel").addEventListener("click", () => closeBatchModal());
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
      if (ev.target === m) dismissModal(m);
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
    $("#monthProfit").addEventListener("click", (ev) => {
      const g = ev.target.closest("[data-ym]");
      if (g) pickProfitMonth(g.dataset.ym);
    });
    $("#monthProfit").addEventListener("keydown", (ev) => {
      const g = ev.target.closest("[data-ym]");
      if (g && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); pickProfitMonth(g.dataset.ym); }
    });
    $("#repPrev").addEventListener("click", () => { repCursor = shiftCursor(reportMode, repCursor, -1); renderReport(); });
    $("#repNext").addEventListener("click", () => { repCursor = shiftCursor(reportMode, repCursor, 1); renderReport(); });

    // 设置
    $("#copySyncCode").addEventListener("click", async () => {
      const box = $("#syncCodeText");
      const ok = await writeClipboard(box.value, box);
      toast(ok ? "同步码已复制" : "复制失败，请手动全选复制");
    });
    $("#applySyncBtn").addEventListener("click", applySyncCodeFromForm);
    $("#exportBtn").addEventListener("click", exportJson);
    $("#exportCsvBtn").addEventListener("click", exportCsv);
    $("#undoBtn").addEventListener("click", doUndo);
    // v42：点顶部同步状态＝立刻和云端核对一次（另一台设备刚记的账马上拉过来）；
    // 回到前台超过 1 分钟也自动核对一次（有弹窗开着时不打扰）。都走既有的 pullFromCloud，冲突与并入规则不变。
    let manualSyncing = false, lastPullAt = Date.now();
    const syncNow = async (silent) => {
      if (manualSyncing) return;
      if (!window.luhuoSync || !window.luhuoSync.isConfigured()) { if (!silent) toast("还没有配对同步码，去设置里配对"); return; }
      manualSyncing = true;
      const before = JSON.stringify(data.orders);
      try {
        const r = await pullFromCloud();
        lastPullAt = Date.now();
        if (syncPending && !syncBlocked && !localIssue) flushPendingSync();
        if (silent || !r) return;
        if (r.kind === "failed") toast("同步失败，联网后再点一次");
        else if (r.kind === "blocked") toast("同步暂停中，请看页面上方的提示");
        else if (JSON.stringify(data.orders) === before) toast("已是最新");
      } finally { manualSyncing = false; }
    };
    $("#syncStatus").addEventListener("click", () => syncNow(false));
    // v42：底部弹出的面板可以往下滑关闭（只在面板已滚到顶部、且不是在输入框里滑时生效）。
    // 关闭走各面板自己的关闭函数——有未保存改动时照旧先问一句；被拦下就弹回原位。
    $$(".modal .sheet").forEach((sheet) => {
      let y0 = null, dy = 0;
      sheet.addEventListener("touchstart", (ev) => {
        if (sheet.scrollTop > 0 || ev.touches.length !== 1 || ev.target.closest("input, textarea, select, .batch-list, #orderList")) { y0 = null; return; }
        y0 = ev.touches[0].clientY; dy = 0;
      }, { passive: true });
      sheet.addEventListener("touchmove", (ev) => {
        if (y0 === null) return;
        dy = ev.touches[0].clientY - y0;
        if (dy <= 0) { sheet.style.transform = ""; return; }
        sheet.style.transition = "none";
        sheet.style.transform = `translateY(${Math.min(dy, 400)}px)`;
      }, { passive: true });
      const end = async () => {
        if (y0 === null) return;
        y0 = null;
        sheet.style.transition = "transform .18s ease";
        const modal = sheet.closest(".modal");
        if (dy > 110 && modal) {
          await dismissModal(modal);
          if (modal.classList.contains("show")) sheet.style.transform = "";
          else setTimeout(() => { sheet.style.transform = ""; sheet.style.transition = ""; }, 200);
        } else sheet.style.transform = "";
        dy = 0;
      };
      sheet.addEventListener("touchend", end);
      sheet.addEventListener("touchcancel", end);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" || topModal() || Date.now() - lastPullAt < 60000) return;
      syncNow(true);
    });
    $("#importFile").addEventListener("change", (ev) => {
      if (ev.target.files[0]) importJson(ev.target.files[0]);
      ev.target.value = "";
    });
    $("#resetIdentityBtn").addEventListener("click", resetLocalIdentity);
    $("#closeSettings").addEventListener("click", closeSettings);

    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushPendingSync(); });
    window.addEventListener("pagehide", flushPendingSync);
  }

  // ---- 启动 ----
  async function start() {
    loadLocal();
    if (legacyLoaded && !meta.v41FirstSeen) { meta.v41FirstSeen = new Date().toISOString(); persistMeta(); }
    populateSelects();
    bind();
    render();
    switchView("list");
    await pullFromCloud();
  }

  start();
})();
