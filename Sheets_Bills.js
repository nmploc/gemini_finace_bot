
// =====================================================
// HOÁ ĐƠN ĐỊNH KỲ (Nhóm D) — Sheet "Bills", chỉ để nhắc, không theo dõi trạng thái trả
// =====================================================
function ensureBillsSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName("Bills");
  if (!sh) {
    sh = ss.insertSheet("Bills");
    sh.appendRow(["Tên", "Số tiền ước tính", "Ngày trong tháng"]);
  }
  return sh;
}

function handleBillCommand(args) {
  ensureBillsSheet();
  if (!args) return "ℹ️ Dùng: <code>/bill Tiền điện 500000 25</code> (tên, số tiền ước tính, ngày trong tháng 1-31)";
  const parts = args.trim().split(/\s+/);
  if (parts.length < 3) return "ℹ️ Dùng: <code>/bill Tiền điện 500000 25</code>";

  const day = parseInt(parts[parts.length - 1], 10);
  const amount = parseAmountShorthand(parts[parts.length - 2]);
  const name = parts.slice(0, -2).join(" ").trim();

  if (!name || amount === null || amount <= 0 || isNaN(day) || day < 1 || day > 31) {
    return "ℹ️ Dùng: <code>/bill Tiền điện 500000 25</code> (ngày phải từ 1-31)";
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = ensureBillsSheet();
    sh.appendRow([name, amount, day]);
  } finally {
    lock.releaseLock();
  }
  return `✅ Đã thêm hoá đơn định kỳ <b>${name}</b>: ~${amount.toLocaleString()}đ, hạn ngày ${day} hằng tháng.`;
}

function getBillsReport() {
  const sh = ensureBillsSheet();
  if (sh.getLastRow() <= 1) return "📭 Chưa có hoá đơn định kỳ nào.\n\nDùng: <code>/bill Tiền điện 500000 25</code>";
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
  let result = "🧾 <b>Hoá đơn định kỳ hằng tháng</b>\n\n";
  data.sort((a, b) => Number(a[2]) - Number(b[2]));
  data.forEach(([name, amount, day]) => {
    result += `• ${name}: ~${Number(amount).toLocaleString()}đ — ngày ${day} hằng tháng\n`;
  });
  return result;
}

// Gộp khoản nợ + hoá đơn sắp đến hạn trong 3 ngày tới (kể cả quá hạn) — dùng cho /duesoon và nhắc hằng ngày
function getDueSoonReport() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const in3days = new Date(today); in3days.setDate(in3days.getDate() + 3);

  const lines = [];

  // Nợ (vay/chovay) chưa xử lý, hạn trong vòng 3 ngày tới hoặc đã quá hạn
  const debtSh = ensureDebtsSheet();
  if (debtSh.getLastRow() > 1) {
    const debts = debtSh.getRange(2, 1, debtSh.getLastRow() - 1, 5).getValues();
    debts.forEach(([type, name, amount, due, paid]) => {
      if (paid) return;
      const dueDate = new Date(due);
      dueDate.setHours(0, 0, 0, 0);
      if (dueDate <= in3days) {
        const overdue = dueDate < today;
        const label = type === "vay" ? `Tôi nợ ${name}` : `${name} nợ tôi`;
        lines.push(`${overdue ? "🔴 QUÁ HẠN" : "🔔"} ${label}: ${Number(amount).toLocaleString()}đ (hạn ${formatDateTimeVN(dueDate).split(" ")[0]})`);
      }
    });
  }

  // Hoá đơn định kỳ có ngày đến hạn trong 3 ngày tới của THÁNG NÀY
  const billSh = ensureBillsSheet();
  if (billSh.getLastRow() > 1) {
    const bills = billSh.getRange(2, 1, billSh.getLastRow() - 1, 3).getValues();
    const todayDay = today.getDate();
    bills.forEach(([name, amount, day]) => {
      day = Number(day);
      const diff = day - todayDay;
      if (diff >= 0 && diff <= 3) {
        lines.push(`🔔 Hoá đơn ${name}: ~${Number(amount).toLocaleString()}đ (ngày ${day} hằng tháng)`);
      }
    });
  }

  if (lines.length === 0) return "✅ Không có khoản nợ/hoá đơn nào sắp đến hạn trong 3 ngày tới.";
  return "📌 <b>Sắp đến hạn</b>\n\n" + lines.join("\n");
}