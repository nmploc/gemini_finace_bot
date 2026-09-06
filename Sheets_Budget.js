
// =====================================================
// GOOGLE SHEETS: BUDGETS
// =====================================================
function ensureBudgetSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName("Budgets");
  if (!sh) {
    sh = ss.insertSheet("Budgets");
    sh.appendRow(["Danh mục", "Ngân sách tháng"]);
  }
  return sh;
}

function getBudgets() {
  const sh = ensureBudgetSheet();
  if (sh.getLastRow() <= 1) return {};
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  const map = {};
  data.forEach(([cat, limit]) => { if (cat) map[cat] = Number(limit) || 0; });
  return map;
}

function setBudget(category, amount) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = ensureBudgetSheet();
    const data = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues() : [];
    for (let i = 0; i < data.length; i++) {
      if (data[i][0] === category) {
        sh.getRange(i + 2, 2).setValue(amount);
        return;
      }
    }
    sh.appendRow([category, amount]);
  } finally {
    lock.releaseLock();
  }
}

// Hỗ trợ "1tr", "1.5tr", "1500k", "1500000", "2,000,000" (dấu phẩy ngăn hàng nghìn kiểu Mỹ)
// và "1.500.000" (dấu chấm ngăn hàng nghìn kiểu Việt Nam).
//
// SỬA LỖI: bản cũ chỉ strip dấu phẩy rồi parseFloat trực tiếp -> "1.500.000" bị hiểu nhầm thành
// 1.5 (parseFloat dừng ở dấu chấm thứ 2) rồi làm tròn thành 2 — sai gấp ~750.000 lần so với ý người
// dùng. Quy tắc mới: dấu chấm chỉ được coi là PHẦN THẬP PHÂN khi xuất hiện đúng 1 lần và có tối đa
// 2 chữ số theo sau (vd "1.5tr", "2.25tr"); mọi trường hợp khác (nhiều dấu chấm, hoặc 3 chữ số sau
// dấu chấm cuối như "1.500.000") coi toàn bộ dấu chấm là phân cách hàng nghìn và loại bỏ.
function parseAmountShorthand(str) {
  let s = str.trim().toLowerCase().replace(/,/g, "");

  const unitMatch = s.match(/(k|tr|triệu|trieu)$/);
  const unit = unitMatch ? unitMatch[0] : null;
  if (unit) s = s.slice(0, -unit.length).trim();

  if (!/^[\d.]+$/.test(s)) return null;

  const dotCount = (s.match(/\./g) || []).length;
  const looksLikeDecimal = dotCount === 1 && /\.\d{1,2}$/.test(s);
  if (dotCount > 0 && !looksLikeDecimal) {
    s = s.replace(/\./g, ""); // "1.500.000" hoặc "1.500" (3 số sau chấm) -> phân cách hàng nghìn
  }

  let num = parseFloat(s);
  if (isNaN(num)) return null;
  if (unit === "k") num *= 1000;
  if (unit === "tr" || unit === "triệu" || unit === "trieu") num *= 1000000;
  return Math.round(num);
}

function handleBudgetCommand(args) {
  ensureBudgetSheet();
  if (!args) return getBudgetStatusText();

  const parts = args.trim().split(/\s+/);
  const amountStr = parts[parts.length - 1];
  const amount = parseAmountShorthand(amountStr);
  if (amount === null) {
    return "ℹ️ Dùng: <code>/budget Ăn uống 1500000</code> (hoặc <code>1.5tr</code>, <code>1500k</code>)";
  }
  const categoryInput = parts.slice(0, -1).join(" ").trim();
  const category = VALID_CATEGORIES.find(c => c.toLowerCase() === categoryInput.toLowerCase());
  if (!category) {
    return "⚠️ Danh mục không hợp lệ. Chọn 1 trong:\n" + VALID_CATEGORIES.map(c => "• " + c).join("\n");
  }
  setBudget(category, amount);
  return `✅ Đã đặt ngân sách <b>${category}</b>: ${amount.toLocaleString()}đ / tháng.`;
}

function getCategorySpendThisMonth(category) {
  const monthData = getMonthlyTransactionData(0);
  let total = 0;
  monthData.forEach(row => {
    const [, , type, amt, , cat] = row;
    if (type === "chi" && cat === category) total += Number(amt || 0);
  });
  return total;
}

// Tính toán đầy đủ: đã chi, hạn mức, còn lại, % đã dùng — dùng chung cho mọi nơi hiển thị ngân sách
function getBudgetRemaining(category) {
  const budgets = getBudgets();
  const limit = budgets[category];
  if (!limit) return null;
  const spend = getCategorySpendThisMonth(category);
  const remaining = limit - spend;
  const percent = limit > 0 ? (spend / limit) * 100 : 0;
  return { limit, spend, remaining, percent };
}

// Luôn trả về dòng trạng thái ngân sách (kèm số tiền còn lại), không chỉ khi gần/vượt hạn mức.
// Trả về null nếu danh mục đó chưa được đặt ngân sách.
function checkBudgetAlert(category) {
  const info = getBudgetRemaining(category);
  if (!info) return null;
  const { limit, spend, remaining, percent } = info;

  if (percent >= 100) {
    return `🚨 <b>Vượt ngân sách "${category}"!</b>\nĐã chi: ${spend.toLocaleString()}đ / ${limit.toLocaleString()}đ (${percent.toFixed(0)}%)\nVượt: ${Math.abs(remaining).toLocaleString()}đ`;
  }
  if (percent >= 80) {
    return `⚠️ Sắp hết ngân sách "${category}"\nĐã chi: ${spend.toLocaleString()}đ / ${limit.toLocaleString()}đ (${percent.toFixed(0)}%)\n💰 Còn lại: ${remaining.toLocaleString()}đ`;
  }
  if (percent >= 50) {
    return `🔔 Nhắc nhẹ — đã dùng quá nửa ngân sách "${category}": ${spend.toLocaleString()}đ / ${limit.toLocaleString()}đ (${percent.toFixed(0)}%)\n💰 Còn lại: ${remaining.toLocaleString()}đ`;
  }
  return `💰 Ngân sách "${category}": còn lại ${remaining.toLocaleString()}đ / ${limit.toLocaleString()}đ (đã dùng ${percent.toFixed(0)}%)`;
}

function getBudgetStatusText() {
  const budgets = getBudgets();
  const entries = Object.entries(budgets);
  if (entries.length === 0) {
    return "📭 Chưa đặt ngân sách nào.\n\nDùng: <code>/budget Ăn uống 1500000</code>";
  }
  let result = "💰 <b>Ngân sách tháng này</b>\n\n";
  entries.forEach(([cat, limit]) => {
    const spend = getCategorySpendThisMonth(cat);
    const remaining = limit - spend;
    const percent = limit > 0 ? ((spend / limit) * 100).toFixed(0) : "0";
    const emoji = spend >= limit ? "🔴" : spend >= limit * 0.8 ? "🟡" : "🟢";
    const remainingText = remaining >= 0
      ? `Còn lại: ${remaining.toLocaleString()}đ`
      : `Vượt: ${Math.abs(remaining).toLocaleString()}đ`;
    result += `${emoji} <b>${cat}</b>: ${spend.toLocaleString()}đ / ${limit.toLocaleString()}đ (${percent}%)\n   ${remainingText}\n`;
  });
  return result;
}