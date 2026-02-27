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
const DB_VERSION = 2;
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
  const [actionsAll, txsAll, optsAll] = await Promise.all([
  idbGetAll("actions"),
  idbGetAll("transactions"),
  idbGetAll("action_options"),
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
  renderChart(txsAll, start, end);
  renderHistory(txsAll, start, end);

  // Actions management list
  renderActionManager(actionsAll);
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
        await idbAdd("transactions", {
          created_ts: Date.now(),
          tx_date: todayISO(),
          amount: Number(o.points),
          kind: "earn",
          source_type: "action",
          source_id: a.id,
          source_name: a.name,
          memo: o.label, // 履歴で「自炊 / 残り物」みたいにする用
          is_deleted: false,
          deleted_ts: null,
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
    await addActionTransaction(a);
    await refreshAll();
  });

  area.appendChild(btn);
}
}

async function addActionTransaction(action) {
  const txObj = {
    created_ts: Date.now(),
    tx_date: todayISO(), // 今日固定
    amount: Number(action.points),
    kind: "earn",
    source_type: "action",
    source_id: action.id,
    source_name: action.name,
    memo: "",
    is_deleted: false,
    deleted_ts: null,
  };
  await idbAdd("transactions", txObj);
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
function setInitialDates() {
  const t = todayISO();
  $("paymentDate").value = t;

  // カスタム初期値（今日）
  $("startDate").value = t;
  $("endDate").value = t;
}

function wireUI() {
  $("rangeSelect").addEventListener("change", async () => {
    const v = $("rangeSelect").value;
    $("customRange").hidden = v !== "custom";
    await refreshAll();
  });

  $("applyCustomRange").addEventListener("click", async () => {
    await refreshAll();
  });

  $("togglePayment").addEventListener("click", () => {
    $("paymentPanel").hidden = !$("paymentPanel").hidden;
  });

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

  // Backup
  $("exportBtn").addEventListener("click", async () => {
    const [actions, transactions] = await Promise.all([
      idbGetAll("actions"),
      idbGetAll("transactions"),
    ]);

    const payload = {
      version: 1,
      exported_at: new Date().toISOString(),
      actions,
      transactions,
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

    // 全消し→復元（ID保持したいので put を使う）
    await idbClear("actions");
    await idbClear("transactions");

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
// --- Tabs ---
const setTab = (mode) => {
  const simple = mode === "simple";
  $("panelSimple").hidden = !simple;
  $("panelBranched").hidden = simple;
  $("tabSimple").className = simple ? "btn" : "btn btn-ghost";
  $("tabBranched").className = simple ? "btn btn-ghost" : "btn";
};
setTab("simple");

$("tabSimple").addEventListener("click", () => setTab("simple"));
$("tabBranched").addEventListener("click", () => setTab("branched"));

// --- Branch draft options UI ---
function renderBranchDraft() {
  const list = $("branchOptionsList");
  list.innerHTML = "";
  if (branchDraftOptions.length === 0) {
    const d = document.createElement("div");
    d.className = "hint";
    d.textContent = "まだ分岐がありません（例：普通100、残り物50）";
    list.appendChild(d);
    return;
  }

  branchDraftOptions.forEach((o, idx) => {
    const item = document.createElement("div");
    item.className = "history-item";

    const main = document.createElement("div");
    main.className = "history-main";
    const title = document.createElement("div");
    title.className = "history-title";
    title.textContent = `${o.label}  +${o.points}`;
    main.appendChild(title);

    const del = document.createElement("button");
    del.className = "btn btn-danger";
    del.textContent = "削除";
    del.addEventListener("click", () => {
      branchDraftOptions.splice(idx, 1);
      renderBranchDraft();
    });

    item.appendChild(main);
    item.appendChild(del);
    list.appendChild(item);
  });
}

$("addBranchOption").addEventListener("click", () => {
  const label = ($("branchOptionLabel").value || "").trim();
  const pts = Number($("branchOptionPoints").value);
  if (!label) return alert("分岐ラベルを入れてね");
  if (!Number.isFinite(pts) || pts <= 0) return alert("ポイントは1以上で");

  branchDraftOptions.push({ label, points: Math.floor(pts) });
  $("branchOptionLabel").value = "";
  $("branchOptionPoints").value = "";
  renderBranchDraft();
});

$("clearBranchOptions").addEventListener("click", () => {
  branchDraftOptions = [];
  renderBranchDraft();
});

$("createBranchedAction").addEventListener("click", async () => {
  const name = ($("branchActionName").value || "").trim();
  if (!name) return alert("親の項目名を入れてね");
  if (branchDraftOptions.length < 2) return alert("分岐を2つ以上追加してね（例：普通/残り物）");

  const dRaw = $("branchDailyLimit").value;
  const mRaw = $("branchMonthlyLimit").value;
  const daily_limit = dRaw === "inf" ? null : parseInt(dRaw, 10);
  const monthly_limit = mRaw === "inf" ? null : parseInt(mRaw, 10);

  // 親 action を作成
  const all = await idbGetAll("actions");
  const maxSort = all.reduce((mx, a) => Math.max(mx, a.sort_order ?? 0), 0);

  const actionId = await idbAdd("actions", {
    name,
    points: 0, // branchedでは使わない（互換のため保持）
    daily_limit,
    monthly_limit,
    action_type: "branched",
    is_active: true,
    sort_order: maxSort + 1,
    created_ts: Date.now(),
    is_deleted: false,
  });

  // 子 options を作成
  for (let i = 0; i < branchDraftOptions.length; i++) {
    const o = branchDraftOptions[i];
    await idbAdd("action_options", {
      action_id: actionId,
      label: o.label,
      points: o.points,
      sort_order: i + 1,
      is_deleted: false,
    });
  }

  // リセット
  $("branchActionName").value = "";
  $("branchDailyLimit").value = "inf";
  $("branchMonthlyLimit").value = "inf";
  branchDraftOptions = [];
  renderBranchDraft();
  setTab("simple");

  await refreshAll();
});

// 初期表示
renderBranchDraft();

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