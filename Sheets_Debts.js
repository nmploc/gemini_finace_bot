
// =====================================================
// THEO DÕI NỢ & KHOẢN PHẢI TRẢ (Nhóm D) — Sheet "Debts"
// =====================================================
function ensureDebtsSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName("Debts");
  if (!sh) {
    sh = ss.insertSheet("Debts");
    sh.appendRow(["Loại", "Tên", "Số tiền", "Hạn", "Đã xong"]);
  }
  return sh;
}

// Phân tích "dd/mm" hoặc "dd/mm/yyyy" thành Date (mặc định năm hiện tại nếu chỉ có dd/mm)
function parseSimpleDate(str) {
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  const day = parseInt(m[1], 10), month = parseInt(m[2], 10) - 1;
  let year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
  if (year < 100) year += 2000;
  const d = new Date(year, month, day);
  if (d.getMonth() !== month || d.getDate() !== day) return null;
  return d;
}

function handleDebtCommand(args) {
  ensureDebtsSheet();
  if (!args) {
    return "ℹ️ Dùng:\n<code>/debt vay Bạn A 500000 25/07</code> (tôi nợ)\n<code>/debt chovay Bạn B 300000 20/07</code> (người khác nợ tôi)";
  }
  const parts = args.trim().split(/\s+/);
  if (parts.length < 4) {
    return "ℹ️ Dùng: <code>/debt vay|chovay &lt;tên&gt; &lt;số tiền&gt; &lt;hạn dd/mm&gt;</code>";
  }
  const typeRaw = parts[0].toLowerCase();
  if (typeRaw !== "vay" && typeRaw !== "chovay") {
    return "ℹ️ Loại phải là <code>vay</code> (tôi nợ) hoặc <code>chovay</code> (người khác nợ tôi).";
  }
  const dueDate = parseSimpleDate(parts[parts.length - 1]);
  const amount = parseAmountShorthand(parts[parts.length - 2]);
  const name = parts.slice(1, -2).join(" ").trim();

  if (!name || amount === null || amount <= 0 || !dueDate) {
    return "ℹ️ Dùng: <code>/debt vay Bạn A 500000 25/07</code>";
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = ensureDebtsSheet();
    sh.appendRow([typeRaw, name, amount, dueDate, false]);
  } finally {
    lock.releaseLock();
  }
  const label = typeRaw === "vay" ? "Tôi nợ" : `${name} nợ tôi`;
  return `✅ Đã ghi: ${label} ${amount.toLocaleString()}đ, hạn ${formatDateTimeVN(dueDate).split(" ")[0]}.`;
}

function sendDebtsList(chatId) {
  const sh = ensureDebtsSheet();
  if (sh.getLastRow() <= 1) {
    sendMessage(chatId, "📭 Chưa có khoản nợ nào.\n\nDùng: <code>/debt vay Bạn A 500000 25/07</code>", "HTML");
    return;
  }
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  const unpaid = [];
  data.forEach((row, i) => {
    if (!row[4]) unpaid.push({ row: i + 2, type: row[0], name: row[1], amount: Number(row[2]), due: new Date(row[3]) });
  });

  if (unpaid.length === 0) {
    sendMessage(chatId, "🎉 Không còn khoản nợ nào chưa xử lý!", "HTML");
    return;
  }
  unpaid.sort((a, b) => a.due - b.due);

  const vay = unpaid.filter(d => d.type === "vay");
  const chovay = unpaid.filter(d => d.type === "chovay");
  const pad = (n) => String(n).padStart(2, "0");
  const fmtDate = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;

  let text = "📌 <b>Các khoản nợ chưa xử lý</b>\n\n";
  if (vay.length) {
    text += "<b>💸 Tôi nợ:</b>\n";
    vay.forEach(d => text += `• ${d.name}: ${d.amount.toLocaleString()}đ — hạn ${fmtDate(d.due)}\n`);
    text += `Tổng: ${vay.reduce((s, d) => s + d.amount, 0).toLocaleString()}đ\n\n`;
  }
  if (chovay.length) {
    text += "<b>💰 Người khác nợ tôi:</b>\n";
    chovay.forEach(d => text += `• ${d.name}: ${d.amount.toLocaleString()}đ — hạn ${fmtDate(d.due)}\n`);
    text += `Tổng: ${chovay.reduce((s, d) => s + d.amount, 0).toLocaleString()}đ\n`;
  }

  const buttons = unpaid.slice(0, 10).map(d => ([{
    text: `✅ Xong: ${d.name} (${d.amount.toLocaleString()}đ)`,
    callback_data: `debt_paid_${d.row}`
  }]));

  sendMessage(chatId, text.trim(), "HTML", buttons);
}

function markDebtPaid(row) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = ensureDebtsSheet();
    if (row < 2 || row > sh.getLastRow()) return false;
    sh.getRange(row, 5).setValue(true);
    return true;
  } finally {
    lock.releaseLock();
  }
}