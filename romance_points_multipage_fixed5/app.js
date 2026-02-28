/* Romance Points PWA
   - IndexedDB: actions / transactions
   - Balance line chart (cumulative)
   - Range: 7/30/365/custom
   - Actions: user-defined, daily limit, grey-out when reached
   - Payment: subtract
   - History: edit date/memo, logical delete
   - Backup: export/import JSON
*/
window.addEventListener("error", (e) => {
  console.error("GLOBAL ERROR:", e.message, e.filename, e.lineno);
});

const $ = (id) => document.getElementById(id);

// ---------- Date helpers ----------
function toISODate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function todayISO() {
  return toISODate(new Date());
}
function addDaysISO(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return toISODate(dt);
}
function daysBetweenInclusive(startISO, endISO) {
  const [sy, sm, sd] = startISO.split("-").map(Number);
  const [ey, em, ed] = endISO.split("-").map(Number);
  const s = new Date(sy, sm - 1, sd);
  const e = new Date(ey, em - 1, ed);
  const diff = Math.round((e - s) / (1000 * 60 * 60 * 24));
  return diff + 1;
}
function listDatesInclusive(startISO, endISO) {
  const n = daysBetweenInclusive(startISO, endISO);
  const out = [];
  for (let i = 0; i < n; i++) out.push(addDaysISO(startISO, i));
  return out;
}

// ---------- IndexedDB ----------
const DB_NAME = "romance_points_db";
const DB_VERSION = 3;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (ev) => {
      const d = req.result;

      // actions
      if (!d.objectStoreNames.contains("actions")) {
        const store = d.createObjectStore("actions", { keyPath: "id", autoIncrement: true });
        store.createIndex("by_active", "is_active", { unique: false });
        store.createIndex("by_deleted", "is_deleted", { unique: false });
        store.createIndex("by_sort", "sort_order", { unique: false });
      }
      if (!d.objectStoreNames.contains("action_options")) {
        const store = d.createObjectStore("action_options", { keyPath: "id", autoIncrement: true });
        store.createIndex("by_action", "action_id", { unique: false });
        store.createIndex("by_deleted", "is_deleted", { unique: false });
        store.createIndex("by_sort", "sort_order", { unique: false });
    }

      // transactions
      if (!d.objectStoreNames.contains("transactions")) {
        const store = d.createObjectStore("transactions", { keyPath: "id", autoIncrement: true });
        store.createIndex("by_date", "tx_date", { unique: false });
        store.createIndex("by_deleted", "is_deleted", { unique: false });
        store.createIndex("by_created", "created_ts", { unique: false });
      }

      // wishlist
      if (!d.objectStoreNames.contains("wishlist")) {
        const store = d.createObjectStore("wishlist", { keyPath: "id", autoIncrement: true });
        store.createIndex("by_deleted", "is_deleted", { unique: false });
        store.createIndex("by_created", "created_ts", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(storeNames, mode = "readonly") {
  const t = db.transaction(storeNames, mode);
  return t;
}

function idbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const t = tx([storeName], "readonly");
    const store = t.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const t = tx([storeName], "readwrite");
    const store = t.objectStore(storeName);
    const req = store.put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbAdd(storeName, value) {
  return new Promise((resolve, reject) => {
    const t = tx([storeName], "readwrite");
    const store = t.objectStore(storeName);
    const req = store.add(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(storeName, key) {
  return new Promise((resolve, reject) => {
    const t = tx([storeName], "readonly");
    const store = t.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbClear(storeName) {
  return new Promise((resolve, reject) => {
    const t = tx([storeName], "readwrite");
    const store = t.objectStore(storeName);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------- State ----------
let branchDraftOptions = []; // {label, points}

let chart = null;
let showDeleted = false;

let viewMode = localStorage.getItem("rp_view_mode") || "chart"; // chart | calendar

let selectedWishId = null;
let editingWishId = null;

let selectedTxId = null;
let editingActionId = null;

// ---------- Range ----------
function getSelectedRange() {
  const v = $("rangeSelect").value;
  const end = todayISO();

  if (v === "custom") {
    const s = $("startDate").value || end;
    const e = $("endDate").value || end;
    return { start: s <= e ? s : e, end: s <= e ? e : s };
  }

  const days = parseInt(v, 10);
  const start = addDaysISO(end, -(days - 1));
  return { start, end };
}

// ---------- Business logic ----------

function sumEarnedThisMonth(txs) {
  const curMonth = monthKey(todayISO());
  return txs
    .filter(
      (x) =>
        !x.is_deleted &&
        x.kind === "earn" &&
        monthKey(x.tx_date) === curMonth
    )
    .reduce((acc, x) => acc + x.amount, 0);
}

function sumAmounts(txs) {
  return txs.reduce((acc, x) => acc + (x.amount || 0), 0);
}

function countActionToday(txs, actionId) {
  const t = todayISO();
  return txs.filter(
    (x) =>
      !x.is_deleted &&
      x.tx_date === t &&
      x.source_type === "action" &&
      x.source_id === actionId
  ).length;
}

function monthKey(isoDate) {
  // "YYYY-MM"
  return isoDate.slice(0, 7);
}

function isLastDayOfMonth(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const next = new Date(y, m - 1, d);
  next.setDate(next.getDate() + 1);
  return next.getMonth() !== dt.getMonth();
}

function monthLabelJP(isoDate) {
  const [y, m] = isoDate.slice(0, 7).split("-");
  return `${y}年${Number(m)}月`;
}

function countActionThisMonth(txs, actionId) {
  const curMonth = monthKey(todayISO());
  return txs.filter(
    (x) =>
      !x.is_deleted &&
      monthKey(x.tx_date) === curMonth &&
      x.source_type === "action" &&
      x.source_id === actionId
  ).length;
}

function computeDailyNetMap(txs, start, end) {
  const dates = listDatesInclusive(start, end);
  const map = new Map();
  for (const d of dates) map.set(d, 0);

  for (const x of txs) {
    if (x.is_deleted) continue;
    if (x.tx_date < start || x.tx_date > end) continue;
    map.set(x.tx_date, (map.get(x.tx_date) || 0) + x.amount);
  }
  return map;
}

function openingBalanceBefore(txs, start) {
  let s = 0;
  for (const x of txs) {
    if (x.is_deleted) continue;
    if (x.tx_date < start) s += x.amount;
  }
  return s;
}

// ---------- UI render ----------
async function refreshAll() {
  const [actionsAll, txsAll, optsAll, wishesAll] = await Promise.all([
    idbGetAll("actions"),
    idbGetAll("transactions"),
    idbGetAll("action_options"),
    idbGetAll("wishlist"),
  ]);
  const actions = actionsAll
    .filter((a) => !a.is_deleted && a.is_active)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id);

  const txsVisible = showDeleted ? txsAll : txsAll.filter((t) => !t.is_deleted);

  // Balance
  const balance = sumAmounts(txsVisible);
  $("balanceValue").textContent = `${balance.toLocaleString()} RP`;

  // Actions (buttons)
  renderActions(actions, txsAll, optsAll);

  // Chart & History range
  const { start, end } = getSelectedRange();
  if (viewMode === "calendar") {
    $("balanceChart").hidden = true;
    $("calendarView").hidden = false;
    renderCalendar(txsAll, start, end);
  } else {
    $("balanceChart").hidden = false;
    $("calendarView").hidden = true;
    renderChart(txsAll, start, end);
  }
  renderHistory(txsAll, start, end);

  // Actions management list
  renderActionManager(actionsAll);

  // Wishlist
  renderWishlistGoals(wishesAll, txsAll);
  renderWishlistManage(wishesAll);
}

function renderActions(actions, txsAll, optsAll) {
  const area = $("actionsArea");
  area.innerHTML = "";

  if (actions.length === 0) {
    const div = document.createElement("div");
    div.className = "hint";
    div.textContent = "まずは下の「行動ボタン管理」から行動を追加してください。";
    area.appendChild(div);
    return;
  }

  for (const a of actions) {
  const usedToday = countActionToday(txsAll, a.id);
  const usedMonth = countActionThisMonth(txsAll, a.id);

  const dayLimit = a.daily_limit == null ? Infinity : a.daily_limit;
  const monthLimit = a.monthly_limit == null ? Infinity : a.monthly_limit;

  const reached = usedToday >= dayLimit || usedMonth >= monthLimit;

  // 分岐あり
  if (a.action_type === "branched") {
    const wrap = document.createElement("div");
    wrap.className = "card";
    wrap.style.padding = "10px";

    const title = document.createElement("div");
    title.style.fontWeight = "800";
    title.style.marginBottom = "8px";
    title.textContent = a.name;
    wrap.appendChild(title);

    const childArea = document.createElement("div");
    childArea.className = "actions";

    const children = (optsAll || [])
      .filter((o) => !o.is_deleted && o.action_id === a.id)
      .sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0) || x.id - y.id);

    for (const o of children) {
      const btn = document.createElement("button");
      btn.className = "btn btn-action";
      btn.disabled = reached;
      btn.textContent = `${o.label}  +${o.points}`; // 残り回数表示は無し

      btn.addEventListener("click", async () => {
        await addEarnTransaction({
          actionId: a.id,
          actionName: a.name,
          points: Number(o.points),
          memo: o.label,
        });
        await refreshAll();
      });

      childArea.appendChild(btn);
    }

    wrap.appendChild(childArea);
    area.appendChild(wrap);
    continue;
  }

  // シンプル（従来）
  const btn = document.createElement("button");
  btn.className = "btn btn-action";
  btn.disabled = reached;
  btn.textContent = `${a.name}  +${a.points}`;

  btn.addEventListener("click", async () => {
    await addEarnTransaction({
      actionId: a.id,
      actionName: a.name,
      points: Number(a.points),
      memo: "",
    });
    await refreshAll();
  });

  area.appendChild(btn);
}
}

async function addEarnTransaction({ actionId, actionName, points, memo }) {
  const txsAll = await idbGetAll("transactions");
  const earnedThisMonth = sumEarnedThisMonth(txsAll);

  let p = Math.floor(Number(points) || 0);
  if (earnedThisMonth >= 12500) {
    p = Math.floor(p / 2);
  }

  const extra = earnedThisMonth >= 12500 ? "（半減適用）" : "";
  const finalMemo = [memo, extra].filter(Boolean).join(" ").trim();

  await idbAdd("transactions", {
    created_ts: Date.now(),
    tx_date: todayISO(),
    amount: p,
    kind: "earn",
    source_type: "action",
    source_id: actionId,
    source_name: actionName,
    memo: finalMemo,
    is_deleted: false,
    deleted_ts: null,
  });
}

function renderChart(txsAll, start, end) {
  const labels = listDatesInclusive(start, end);
  const netMap = computeDailyNetMap(txsAll, start, end);
  const opening = openingBalanceBefore(txsAll, start);

  const points = [];
  let cur = opening;
  for (const d of labels) {
    cur += netMap.get(d) || 0;
    points.push(cur);
  }

  const ctx = $("balanceChart");
  if (!chart) {
    chart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [{ label: "残高", data: points, tension: 0.25 }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } },
      },
    });
  } else {
    chart.data.labels = labels;
    chart.data.datasets[0].data = points;
    chart.update();
  }
}

// ----- Calendar view -----
function sumEarnedOnDate(txsAll, isoDate) {
  return txsAll
    .filter((t) => !t.is_deleted && t.tx_date === isoDate && (t.amount || 0) > 0)
    .reduce((acc, t) => acc + (t.amount || 0), 0);
}

function listTxOnDate(txsAll, isoDate) {
  const rows = txsAll
    .filter((t) => !t.is_deleted && t.tx_date === isoDate)
    .sort((a, b) => (b.created_ts ?? 0) - (a.created_ts ?? 0));
  return rows;
}

function renderCalendar(txsAll, start, end) {
  // 月表示（end の月）
  const monthISO = end.slice(0, 7) + "-01";
  $("calendarHeader").textContent = monthLabelJP(monthISO);

  const grid = $("calendarGrid");
  grid.innerHTML = "";

  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  for (const w of weekdays) {
    const el = document.createElement("div");
    el.className = "cal-weekday";
    el.textContent = w;
    grid.appendChild(el);
  }

  const [y, m] = monthISO.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const startDow = first.getDay();
  const last = new Date(y, m, 0); // last day of month
  const daysInMonth = last.getDate();

  // 前月の埋め
  for (let i = 0; i < startDow; i++) {
    const blank = document.createElement("div");
    blank.className = "cal-cell muted";
    blank.innerHTML = "&nbsp;";
    grid.appendChild(blank);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const cell = document.createElement("div");
    cell.className = "cal-cell";

    const inRange = iso >= start && iso <= end;
    if (!inRange) cell.classList.add("muted");

    const dayEl = document.createElement("div");
    dayEl.className = "cal-day";
    dayEl.textContent = String(d);

    const earned = sumEarnedOnDate(txsAll, iso);
    const earnedEl = document.createElement("div");
    earnedEl.className = "cal-earned";
    earnedEl.textContent = earned > 0 ? `+${earned}` : "";

    cell.appendChild(dayEl);
    cell.appendChild(earnedEl);

    if (inRange) {
      cell.addEventListener("click", () => openDayDetail(txsAll, iso));
    }
    grid.appendChild(cell);
  }
}

function openDayDetail(txsAll, isoDate) {
  $("dayDetailPanel").hidden = false;
  $("dayDetailDate").textContent = isoDate;

  const list = $("dayDetailList");
  list.innerHTML = "";

  const rows = listTxOnDate(txsAll, isoDate);
  if (rows.length === 0) {
    const div = document.createElement("div");
    div.className = "hint";
    div.textContent = "この日の履歴はありません。";
    list.appendChild(div);
    return;
  }

  for (const t of rows) {
    const item = document.createElement("div");
    item.className = "history-item";

    const main = document.createElement("div");
    main.className = "history-main";

    const title = document.createElement("div");
    title.className = "history-title";
    title.textContent = t.source_type === "payment" ? "支払い" : (t.source_name || "（名称なし）");

    const sub = document.createElement("div");
    sub.className = "history-sub";
    sub.textContent = t.memo ? t.memo : "";

    main.appendChild(title);
    main.appendChild(sub);

    const amt = document.createElement("div");
    const plus = (t.amount || 0) >= 0;
    amt.className = `history-amount ${plus ? "plus" : "minus"}`;
    const sign = plus ? "+" : "";
    amt.textContent = `${sign}${t.amount}`;

    item.appendChild(main);
    item.appendChild(amt);
    list.appendChild(item);
  }
}

function renderHistory(txsAll, start, end) {
  const list = $("historyList");
  list.innerHTML = "";

  // 範囲内（または削除表示なら削除も含む）を created_ts desc
  let rows = txsAll.filter((t) => {
    if (!showDeleted && t.is_deleted) return false;
    return t.tx_date >= start && t.tx_date <= end;
  });

  rows.sort((a, b) => (b.created_ts ?? 0) - (a.created_ts ?? 0));

  if (rows.length === 0) {
    const div = document.createElement("div");
    div.className = "hint";
    div.textContent = "この期間の履歴はありません。";
    list.appendChild(div);
  } else {
    for (const t of rows) {
      const item = document.createElement("div");
      item.className = "history-item";
      item.style.opacity = t.is_deleted ? "0.55" : "1.0";

      const main = document.createElement("div");
      main.className = "history-main";

      const title = document.createElement("div");
      title.className = "history-title";
      title.textContent =
        t.source_type === "payment"
          ? `支払い`
          : (t.source_name || "（名称なし）");

      const sub = document.createElement("div");
      sub.className = "history-sub";
      const memoPart = t.memo ? ` / ${t.memo}` : "";
      sub.textContent = `${t.tx_date}${memoPart}`;

      main.appendChild(title);
      main.appendChild(sub);

      const amt = document.createElement("div");
      const plus = (t.amount || 0) >= 0;
      amt.className = `history-amount ${plus ? "plus" : "minus"}`;
      const sign = plus ? "+" : "";
      amt.textContent = `${sign}${t.amount}`;

      item.appendChild(main);
      item.appendChild(amt);

      item.addEventListener("click", () => {
        selectedTxId = t.id;
        openEditPanel(t);
      });

      list.appendChild(item);
    }
  }
}

function openEditPanel(txObj) {
  $("editPanel").hidden = false;
  $("editDate").value = txObj.tx_date || todayISO();
  $("editMemo").value = txObj.memo || "";
}

function closeEditPanel() {
  $("editPanel").hidden = true;
  selectedTxId = null;
}

// ---------- Actions manager ----------
function renderActionManager(actionsAll) {
  const area = $("actionsManageList");
  area.innerHTML = "";

  const rows = actionsAll
    .filter((a) => !a.is_deleted)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id);

  if (rows.length === 0) {
    const div = document.createElement("div");
    div.className = "hint";
    div.textContent = "まだ行動がありません。上のフォームから追加できます。";
    area.appendChild(div);
    return;
  }

  for (const a of rows) {
    const row = document.createElement("div");
    row.className = "history-item"; // 既存スタイル流用

    const main = document.createElement("div");
    main.className = "history-main";

    const title = document.createElement("div");
    title.className = "history-title";
    const limitLabel = a.daily_limit == null ? "∞" : String(a.daily_limit);
    const activeLabel = a.is_active ? "表示中" : "非表示";
    title.textContent = `${a.name}  (+${a.points}) / 上限:${limitLabel} / ${activeLabel}`;

    const sub = document.createElement("div");
    sub.className = "history-sub";
    sub.textContent = `ID:${a.id}`;

    main.appendChild(title);
    main.appendChild(sub);

    const controls = document.createElement("div");
    controls.style.display = "flex";
    controls.style.gap = "8px";
    controls.style.alignItems = "center";

    const toggle = document.createElement("button");
    toggle.className = "btn btn-ghost";
    toggle.textContent = a.is_active ? "非表示" : "表示";
    toggle.addEventListener("click", async (e) => {
      e.stopPropagation();
      await idbPut("actions", { ...a, is_active: !a.is_active });
      await refreshAll();
    });

    const edit = document.createElement("button");
    edit.className = "btn";
    edit.textContent = "編集";
    edit.addEventListener("click", (e) => {
  e.stopPropagation();
  console.log("[EDIT CLICK]", a);

  // 必須IDがあるかチェックして、無いならここでわかるようにする
  const required = ["actionName", "actionPoints", "actionLimit", "actionMonthlyLimit", "addAction"];
  const missing = required.filter((id) => !document.getElementById(id));
  if (missing.length) {
    console.error("Missing form ids:", missing);
    alert("編集フォームのHTMLに必要なidが見つからない: " + missing.join(", "));
    return;
  }

  $("actionName").value = a.name ?? "";
  $("actionPoints").value = a.points ?? "";
  $("actionLimit").value = a.daily_limit == null ? "inf" : String(a.daily_limit);
  $("actionMonthlyLimit").value = a.monthly_limit == null ? "inf" : String(a.monthly_limit);

  $("addAction").textContent = "行動を更新";
  editingActionId = a.id;

  // 「一番下にスクロール」より確実にフォームへ寄せる
  $("addAction").scrollIntoView({ behavior: "smooth", block: "center" });
});

    const del = document.createElement("button");
    del.className = "btn btn-danger";
    del.textContent = "削除";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("この行動を削除（論理）します。過去の履歴は残ります。OK？")) return;
      await idbPut("actions", { ...a, is_deleted: true, is_active: false });
      if (editingActionId === a.id) {
        editingActionId = null;
        $("addAction").textContent = "行動を追加";
        $("actionName").value = "";
        $("actionPoints").value = "";
        $("actionLimit").value = "inf";
      }
      await refreshAll();
    });

    const up = document.createElement("button");
    up.className = "btn btn-ghost";
    up.textContent = "↑";
    up.addEventListener("click", async (e) => {
        e.stopPropagation();
        await moveAction(a.id, -1); // 上へ
        await refreshAll();
    });
    const down = document.createElement("button");
    down.className = "btn btn-ghost";
    down.textContent = "↓";
    down.addEventListener("click", async (e) => {
        e.stopPropagation();
        await moveAction(a.id, +1); // 下へ
        await refreshAll();
    });

    controls.appendChild(up);
    controls.appendChild(down);
    controls.appendChild(toggle);
    controls.appendChild(edit);
    controls.appendChild(del);

    row.appendChild(main);
    row.appendChild(controls);

    area.appendChild(row);
  }
}

// ----- Wishlist & Forecast -----
function calcAvgDailyEarn(txsAll, lookbackDays = 30) {
  const end = todayISO();
  const start = addDaysISO(end, -(lookbackDays - 1));
  const dates = listDatesInclusive(start, end);
  let total = 0;
  for (const d of dates) total += sumEarnedOnDate(txsAll, d);
  return total / lookbackDays;
}

function simulateDaysToTarget({
  startBalance,
  target,
  avgDailyEarn,
  startDateISO,
  earnedThisMonthStart,
  maxDays = 3650,
}) {
  if (target <= startBalance) {
    return { days: 0, reachDate: startDateISO, finalBalance: startBalance };
  }
  if (!Number.isFinite(avgDailyEarn) || avgDailyEarn <= 0) {
    return { days: null, reachDate: null, finalBalance: startBalance };
  }

  let bal = startBalance;
  let day = 0;
  let curDate = startDateISO;
  let monthEarned = Math.max(0, earnedThisMonthStart || 0);

  for (day = 1; day <= maxDays; day++) {
    const isHalved = monthEarned >= 12500;
    const earn = isHalved ? Math.floor(avgDailyEarn / 2) : Math.floor(avgDailyEarn);
    bal += earn;
    monthEarned += earn;

    // 月末控除（残高が10,000超のときだけ）
    if (isLastDayOfMonth(curDate)) {
      if (bal > 10000) bal -= 5000;
      monthEarned = 0; // 次月へ
    }

    if (bal >= target) {
      return { days: day, reachDate: curDate, finalBalance: bal };
    }

    curDate = addDaysISO(curDate, 1);
  }

  return { days: null, reachDate: null, finalBalance: bal };
}


function renderWishlistGoals(wishesAll, txsAll) {
  const list = $("wishList");
  if (!list) return;
  list.innerHTML = "";

  const wishes = (wishesAll || [])
    .filter((w) => !w.is_deleted)
    .sort((a, b) => (b.created_ts ?? 0) - (a.created_ts ?? 0));

  if (wishes.length === 0) {
    const div = document.createElement("div");
    div.className = "hint";
    div.textContent = "（まだ目標がありません。編集ページから追加できます）";
    list.appendChild(div);
  } else {
    for (const w of wishes) {
      const row = document.createElement("div");
      row.className = "history-item";
      row.style.opacity = selectedWishId === w.id ? "1.0" : "0.92";

      const main = document.createElement("div");
      main.className = "history-main";

      const title = document.createElement("div");
      title.className = "history-title";
      title.textContent = w.name || "（名称なし）";

      const sub = document.createElement("div");
      sub.className = "history-sub";
      sub.textContent = `必要: ${Number(w.cost || 0).toLocaleString()} RP`;

      main.appendChild(title);
      main.appendChild(sub);

      row.appendChild(main);

      row.addEventListener("click", () => {
        selectedWishId = w.id;
        renderWishForecast(w, txsAll);
      });

      list.appendChild(row);
    }
  }

  // 選択中があれば予測更新
  const selected = wishes.find((w) => w.id === selectedWishId);
  if (selected) {
    renderWishForecast(selected, txsAll);
  } else {
    const panel = $("wishForecastPanel");
    if (panel) panel.hidden = true;
  }
}

function renderWishlistManage(wishesAll) {
  const list = $("wishManageList");
  if (!list) return;
  list.innerHTML = "";

  const wishes = (wishesAll || [])
    .filter((w) => !w.is_deleted)
    .sort((a, b) => (b.created_ts ?? 0) - (a.created_ts ?? 0));

  if (wishes.length === 0) {
    const div = document.createElement("div");
    div.className = "hint";
    div.textContent = "（まだ目標がありません）";
    list.appendChild(div);
    return;
  }

  for (const w of wishes) {
    const row = document.createElement("div");
    row.className = "history-item";
    row.style.opacity = editingWishId === w.id ? "1.0" : "0.92";

    const main = document.createElement("div");
    main.className = "history-main";

    const title = document.createElement("div");
    title.className = "history-title";
    title.textContent = w.name || "（名称なし）";

    const sub = document.createElement("div");
    sub.className = "history-sub";
    sub.textContent = `必要: ${Number(w.cost || 0).toLocaleString()} RP`;

    main.appendChild(title);
    main.appendChild(sub);

    const controls = document.createElement("div");
    controls.style.display = "flex";
    controls.style.gap = "8px";

    const editBtn = document.createElement("button");
    editBtn.className = "btn";
    editBtn.textContent = "編集";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      editingWishId = w.id;
      const n = $("wishEditName");
      const c = $("wishEditCost");
      if (n) n.value = w.name || "";
      if (c) c.value = Number(w.cost || 0);
      const del = $("deleteWish");
      if (del) del.disabled = false;
      renderWishlistManage(wishesAll);
    });

    controls.appendChild(editBtn);

    row.appendChild(main);
    row.appendChild(controls);

    row.addEventListener("click", () => {
      // クリックでも編集
      editingWishId = w.id;
      const n = $("wishEditName");
      const c = $("wishEditCost");
      if (n) n.value = w.name || "";
      if (c) c.value = Number(w.cost || 0);
      const del = $("deleteWish");
      if (del) del.disabled = false;
      renderWishlistManage(wishesAll);
    });

    list.appendChild(row);
  }
}

function renderWishForecast(wish, txsAll) {
  const balance = sumAmounts(txsAll.filter((t) => !t.is_deleted));
  const target = Math.floor(Number(wish.cost || 0));
  const diff = Math.max(0, target - balance);

  const avg = calcAvgDailyEarn(txsAll, 30);
  const earnedThisMonth = sumEarnedThisMonth(txsAll);

  const sim = simulateDaysToTarget({
    startBalance: balance,
    target,
    avgDailyEarn: avg,
    startDateISO: todayISO(),
    earnedThisMonthStart: earnedThisMonth,
  });

  $("wishForecastPanel").hidden = false;
  $("wishForecastTitle").textContent = `${wish.name}（${target.toLocaleString()} RP）`;

  const body = $("wishForecastBody");
  body.innerHTML = "";

  const row1 = document.createElement("div");
  row1.className = "row";
  row1.innerHTML = `<div class="pill">現在残高</div><div style="font-weight:800;">${balance.toLocaleString()} RP</div>`;

  const row2 = document.createElement("div");
  row2.className = "row";
  row2.innerHTML = `<div class="pill">不足</div><div style="font-weight:800;">${diff.toLocaleString()} RP</div>`;

  const row3 = document.createElement("div");
  row3.className = "row";
  row3.innerHTML = `<div class="pill">平均獲得/日（直近30日）</div><div style="font-weight:800;">${Math.floor(avg).toLocaleString()} RP</div>`;

  const row4 = document.createElement("div");
  row4.className = "row";

  if (sim.days == null) {
    row4.innerHTML = `<div class="pill">到達予測</div><div style="font-weight:800;">（データ不足）</div>`;
  } else {
    row4.innerHTML = `<div class="pill">到達予測</div><div style="font-weight:800;">あと${sim.days}日（${sim.reachDate}）</div>`;
  }

  body.appendChild(row1);
  body.appendChild(row2);
  body.appendChild(row3);
  body.appendChild(row4);
}

async function moveAction(actionId, direction) {
  // direction: -1 (up), +1 (down)
  const actionsAll = await idbGetAll("actions");
  const rows = actionsAll
    .filter((a) => !a.is_deleted) // 管理対象は削除されてないもの
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id);

  const idx = rows.findIndex((a) => a.id === actionId);
  if (idx === -1) return;

  const j = idx + direction;
  if (j < 0 || j >= rows.length) return; // 端なら動かない

  const a = rows[idx];
  const b = rows[j];

  // sort_order を入れ替える（無い場合もあるのでフォールバック）
  const aSort = a.sort_order ?? idx;
  const bSort = b.sort_order ?? j;

  await idbPut("actions", { ...a, sort_order: bSort });
  await idbPut("actions", { ...b, sort_order: aSort });
}

// ---------- Wire UI ----------
console.log("wireUI start");
console.log("addBranchOption:", document.getElementById("addBranchOption"));
console.log("createBranchedAction:", document.getElementById("createBranchedAction"));

function setPage(page) {
  const pages = {
    home: $("pageHome"),
    goals: $("pageGoals"),
    edit: $("pageEdit"),
  };

  // 強制的に表示/非表示（hidden属性とCSS両方で効かせる）
  for (const k of Object.keys(pages)) {
    const el = pages[k];
    if (!el) continue;
    const show = k === page;
    el.hidden = !show;
    el.classList.toggle("is-hidden", !show);
  }

  const btns = [$("navHome"), $("navGoals"), $("navEdit")].filter(Boolean);
  for (const b of btns) b.classList.remove("active");
  const activeBtn =
    page === "home" ? $("navHome") : page === "goals" ? $("navGoals") : $("navEdit");
  if (activeBtn) activeBtn.classList.add("active");

  localStorage.setItem("rp_page", page);

  // hashでページ状態を保持（戻るで移動できる）
  const newHash = `#${page}`;
  if (location.hash !== newHash) {
    // pushStateにすると履歴が増えすぎるのでreplace
    history.replaceState(null, "", newHash);
  }
}


function initNavigation() {
  const fromHash = (location.hash || "").replace("#", "");
  const saved = localStorage.getItem("rp_page") || "home";
  const initial =
    fromHash === "home" || fromHash === "goals" || fromHash === "edit" ? fromHash : saved;

  [$("navHome"), $("navGoals"), $("navEdit")].forEach((btn) => {
    if (!btn) return;
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      const page = btn.dataset.page || "home";
      setPage(page);
      // iOSで「押したまま」っぽい見た目になるのを防ぐ
      btn.blur();
    });
  });

  window.addEventListener("hashchange", () => {
    const h = (location.hash || "").replace("#", "");
    if (h === "home" || h === "goals" || h === "edit") setPage(h);
  });

  setPage(initial);
}


function setInitialDates() {
  const t = todayISO();
  $("paymentDate").value = t;

  // 期間選択の復元
  const savedRange = localStorage.getItem("rp_range_select") || "30";
  if ($("rangeSelect")) $("rangeSelect").value = savedRange;

  // カスタム日付の復元（無ければ今日）
  const savedStart = localStorage.getItem("rp_range_start") || t;
  const savedEnd = localStorage.getItem("rp_range_end") || t;
  $("startDate").value = savedStart;
  $("endDate").value = savedEnd;

  // カスタム表示の初期反映
  $("customRange").hidden = ($("rangeSelect").value !== "custom");
}

function wireUI() {
  // view mode
  if ($("viewMode")) {
    $("viewMode").value = viewMode;
    $("viewMode").addEventListener("change", async () => {
      viewMode = $("viewMode").value;
      localStorage.setItem("rp_view_mode", viewMode);
      await refreshAll();
    });
  }

  $("rangeSelect").addEventListener("change", async () => {
    const v = $("rangeSelect").value;
    localStorage.setItem("rp_range_select", v);
    $("customRange").hidden = v !== "custom";
    await refreshAll();
  });

  // カスタム日付変更は即保存（適用ボタンで反映）
  $("startDate").addEventListener("change", () => {
    localStorage.setItem("rp_range_start", $("startDate").value || todayISO());
  });
  $("endDate").addEventListener("change", () => {
    localStorage.setItem("rp_range_end", $("endDate").value || todayISO());
  });

  $("applyCustomRange").addEventListener("click", async () => {
    // 念のため custom を選択状態に固定
    $("rangeSelect").value = "custom";
    localStorage.setItem("rp_range_select", "custom");
    $("customRange").hidden = false;

    const s = $("startDate").value || todayISO();
    const e = $("endDate").value || todayISO();
    localStorage.setItem("rp_range_start", s);
    localStorage.setItem("rp_range_end", e);

    await refreshAll();
  });

  $("togglePayment").addEventListener("click", () => {
    $("paymentPanel").hidden = !$("paymentPanel").hidden;
  });

  if ($("closeDayDetail")) {
    $("closeDayDetail").addEventListener("click", () => {
      $("dayDetailPanel").hidden = true;
    });
  }

  $("submitPayment").addEventListener("click", async () => {
    const amtRaw = $("paymentAmount").value;
    const date = $("paymentDate").value || todayISO();
    const memo = ($("paymentMemo").value || "").trim();

    const amt = Number(amtRaw);
    if (!Number.isFinite(amt) || amt <= 0) {
      alert("金額（RP）を正しく入力してね（1以上）");
      return;
    }

    const txObj = {
      created_ts: Date.now(),
      tx_date: date,
      amount: -Math.floor(amt),
      kind: "spend",
      source_type: "payment",
      source_id: null,
      source_name: "支払い",
      memo,
      is_deleted: false,
      deleted_ts: null,
    };

    await idbAdd("transactions", txObj);

    // 入力リセット（メモだけ残したいならここ変える）
    $("paymentAmount").value = "";
    $("paymentMemo").value = "";
    await refreshAll();
  });

  $("showDeleted").addEventListener("click", async () => {
    showDeleted = !showDeleted;
    $("showDeleted").textContent = showDeleted ? "削除済みを非表示" : "削除済みも表示";
    await refreshAll();
    if (!showDeleted && selectedTxId) {
      // 選択中が削除済みだった場合などを考慮して閉じる
      closeEditPanel();
    }
  });

  $("saveEdit").addEventListener("click", async () => {
    if (!selectedTxId) return;
    const t = await idbGet("transactions", selectedTxId);
    if (!t) return;

    const newDate = $("editDate").value || t.tx_date;
    const newMemo = ($("editMemo").value || "").trim();

    await idbPut("transactions", { ...t, tx_date: newDate, memo: newMemo });
    await refreshAll();
  });

  $("deleteTx").addEventListener("click", async () => {
    if (!selectedTxId) return;
    const t = await idbGet("transactions", selectedTxId);
    if (!t) return;

    if (!confirm("この履歴を削除（論理）します。OK？")) return;

    await idbPut("transactions", { ...t, is_deleted: true, deleted_ts: Date.now() });
    closeEditPanel();
    await refreshAll();
  });

  $("addAction").addEventListener("click", async () => {
    const name = ($("actionName").value || "").trim();
    const pointsRaw = $("actionPoints").value;
    const limitRaw = $("actionLimit").value;
    const monthlyRaw = $("actionMonthlyLimit").value;

    const points = Number(pointsRaw);
    if (!name) {
      alert("項目名を入れてね");
      return;
    }
    if (!Number.isFinite(points) || points <= 0) {
      alert("ポイントは1以上の数字にしてね");
      return;
    }

    const daily_limit = limitRaw === "inf" ? null : parseInt(limitRaw, 10);
    const monthly_limit = monthlyRaw === "inf" ? null : parseInt(monthlyRaw, 10);

    if (editingActionId) {
      const old = await idbGet("actions", editingActionId);
      if (!old) return;

      await idbPut("actions", {
        ...old,
        name,
        points: Math.floor(points),
        daily_limit,
        monthly_limit,
      });

      editingActionId = null;
      $("addAction").textContent = "行動を追加";
    } else {
      // sort_order は末尾に追加
      const all = await idbGetAll("actions");
      const maxSort = all.reduce((m, a) => Math.max(m, a.sort_order ?? 0), 0);

      await idbAdd("actions", {
        name,
        points: Math.floor(points),
        daily_limit,
        monthly_limit,
        is_active: true,
        sort_order: maxSort + 1,
        created_ts: Date.now(),
        is_deleted: false,
        action_type: "simple",
      });
    }

    // フォームリセット
    $("actionName").value = "";
    $("actionPoints").value = "";
    $("actionLimit").value = "inf";
    $("actionMonthlyLimit").value = "inf";

    await refreshAll();
  });
  // Wishlist (Goals: selection clear / Edit: add & edit)

if ($("clearWishSelectionGoals")) {
  $("clearWishSelectionGoals").addEventListener("click", async () => {
    selectedWishId = null;
    const panel = $("wishForecastPanel");
    if (panel) panel.hidden = true;
    await refreshAll();
  });
}

if ($("newWish")) {
  $("newWish").addEventListener("click", async () => {
    editingWishId = null;
    const n = $("wishEditName");
    const c = $("wishEditCost");
    if (n) n.value = "";
    if (c) c.value = "";
    const del = $("deleteWish");
    if (del) del.disabled = true;
    await refreshAll();
  });
}

if ($("saveWish")) {
  $("saveWish").addEventListener("click", async () => {
    const name = ($("wishEditName").value || "").trim();
    const cost = Number($("wishEditCost").value);
    if (!name) return alert("名前を入れてね");
    if (!Number.isFinite(cost) || cost <= 0) return alert("必要ポイントは1以上で");

    if (editingWishId) {
      const old = await idbGet("wishlist", editingWishId);
      if (!old) return;
      await idbPut("wishlist", {
        ...old,
        name,
        cost: Math.floor(cost),
      });
    } else {
      await idbAdd("wishlist", {
        name,
        cost: Math.floor(cost),
        created_ts: Date.now(),
        is_deleted: false,
        deleted_ts: null,
      });
    }

    // reset form
    editingWishId = null;
    $("wishEditName").value = "";
    $("wishEditCost").value = "";
    const del = $("deleteWish");
    if (del) del.disabled = true;

    await refreshAll();
  });
}

if ($("deleteWish")) {
  $("deleteWish").addEventListener("click", async () => {
    if (!editingWishId) return;
    const old = await idbGet("wishlist", editingWishId);
    if (!old) return;
    if (!confirm("この目標を削除（論理）します。OK？")) return;
    await idbPut("wishlist", { ...old, is_deleted: true, deleted_ts: Date.now() });
    if (selectedWishId === editingWishId) selectedWishId = null;
    editingWishId = null;
    $("wishEditName").value = "";
    $("wishEditCost").value = "";
    $("deleteWish").disabled = true;
    await refreshAll();
  });
}

  // Backup
  $("exportBtn").addEventListener("click", async () => {
    const [actions, transactions, action_options, wishlist] = await Promise.all([
      idbGetAll("actions"),
      idbGetAll("transactions"),
      idbGetAll("action_options"),
      idbGetAll("wishlist"),
    ]);

    const payload = {
      version: 1,
      exported_at: new Date().toISOString(),
      actions,
      transactions,
      action_options,
      wishlist,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `romance_points_backup_${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  $("importBtn").addEventListener("click", () => {
    $("importFile").click();
  });

  $("importFile").addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      alert("JSONが読み込めませんでした");
      return;
    }

    if (!confirm("復元すると現在のデータを上書きします。OK？")) return;

    const actions = payload.actions ?? [];
    const transactions = payload.transactions ?? [];
    const action_options = payload.action_options ?? [];
    const wishlist = payload.wishlist ?? [];

    // 全消し→復元（ID保持したいので put を使う）
    await idbClear("actions");
    await idbClear("transactions");
    await idbClear("action_options");
    await idbClear("wishlist");

    // actions
    for (const a of actions) {
      // 古い形式の揺れに強く
      const norm = {
        id: a.id,
        name: a.name ?? "",
        points: Number(a.points ?? 0),
        daily_limit: a.daily_limit ?? null,
        is_active: a.is_active ?? true,
        sort_order: a.sort_order ?? 0,
        created_ts: a.created_ts ?? Date.now(),
        is_deleted: a.is_deleted ?? false,
      };
      await idbPut("actions", norm);
    }

    // transactions
    for (const t of transactions) {
      const norm = {
        id: t.id,
        created_ts: t.created_ts ?? Date.now(),
        tx_date: t.tx_date ?? todayISO(),
        amount: Number(t.amount ?? 0),
        kind: t.kind ?? (Number(t.amount ?? 0) >= 0 ? "earn" : "spend"),
        source_type: t.source_type ?? "manual",
        source_id: t.source_id ?? null,
        source_name: t.source_name ?? "",
        memo: t.memo ?? "",
        is_deleted: t.is_deleted ?? false,
        deleted_ts: t.deleted_ts ?? null,
      };
      await idbPut("transactions", norm);
    }

    // action options
    for (const o of action_options) {
      const norm = {
        id: o.id,
        action_id: o.action_id,
        label: o.label ?? "",
        points: Number(o.points ?? 0),
        sort_order: o.sort_order ?? 0,
        created_ts: o.created_ts ?? Date.now(),
        is_deleted: o.is_deleted ?? false,
        deleted_ts: o.deleted_ts ?? null,
      };
      await idbPut("action_options", norm);
    }

    // wishlist
    for (const w of wishlist) {
      const norm = {
        id: w.id,
        name: w.name ?? "",
        cost: Number(w.cost ?? 0),
        created_ts: w.created_ts ?? Date.now(),
        is_deleted: w.is_deleted ?? false,
        deleted_ts: w.deleted_ts ?? null,
      };
      await idbPut("wishlist", norm);
    }
    // input reset
    ev.target.value = "";
    closeEditPanel();
    await refreshAll();
  });
}

// ---------- Bootstrap ----------
(async function main() {
  db = await openDB();

  setInitialDates();
  initNavigation();
  wireUI();

  // 初回は履歴編集パネル閉じる
  closeEditPanel();

  // カスタムUI初期
  $("customRange").hidden = $("rangeSelect").value !== "custom";
  $("showDeleted").textContent = "削除済みも表示";

  await refreshAll();
})().catch((e) => {
  console.error(e);

  const msg =
    (e && e.message ? e.message : String(e)) +
    (e && e.stack ? "\n\n" + e.stack : "");

  alert("起動エラー:\n\n" + msg);
});