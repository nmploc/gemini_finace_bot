
// =====================================================
// MỤC TIÊU TIẾT KIỆM (Nhóm D) — Sheet "Goals", thuần tính toán không cần AI
// =====================================================
function ensureGoalsSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName("Goals");
  if (!sh) {
    sh = ss.insertSheet("Goals");
    sh.appendRow(["Tên mục tiêu", "Số tiền mục tiêu", "Số tháng", "Ngày bắt đầu", "Đã tiết kiệm"]);
  }
  return sh;
}

function handleGoalCommand(args) {
  ensureGoalsSheet();
  if (!args) return "ℹ️ Dùng: <code>/goal Laptop 35000000 8</code> (tên, số tiền mục tiêu, số tháng)";

  const parts = args.trim().split(/\s+/);
  if (parts.length < 3) return "ℹ️ Dùng: <code>/goal Laptop 35000000 8</code> (tên, số tiền mục tiêu, số tháng)";

  const months = parseInt(parts[parts.length - 1], 10);
  const amount = parseAmountShorthand(parts[parts.length - 2]);
  const name = parts.slice(0, -2).join(" ").trim();

  if (!name || amount === null || amount <= 0 || isNaN(months) || months <= 0) {
    return "ℹ️ Dùng: <code>/goal Laptop 35000000 8</code> (tên, số tiền mục tiêu, số tháng)";
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = ensureGoalsSheet();
    sh.appendRow([name, amount, months, new Date(), 0]);
  } finally {
    lock.releaseLock();
  }
  const monthlyNeeded = Math.round(amount / months);
  return `🎯 Đã tạo mục tiêu <b>${name}</b>: ${amount.toLocaleString()}đ trong ${months} tháng.\nCần tiết kiệm ~${monthlyNeeded.toLocaleString()}đ/tháng.\nDùng <code>/save ${name} &lt;số tiền&gt;</code> để ghi nhận khi bạn góp tiền.`;
}

function handleSaveContributionCommand(args) {
  if (!args) return "ℹ️ Dùng: <code>/save Laptop 2000000</code> (tên mục tiêu, số tiền vừa góp)";
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) return "ℹ️ Dùng: <code>/save Laptop 2000000</code>";

  const amount = parseAmountShorthand(parts[parts.length - 1]);
  const name = parts.slice(0, -1).join(" ").trim();
  if (!name || amount === null || amount <= 0) return "ℹ️ Dùng: <code>/save Laptop 2000000</code>";

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = ensureGoalsSheet();
    const data = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues() : [];
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][0]).toLowerCase() === name.toLowerCase()) {
        const newSaved = Number(data[i][4] || 0) + amount;
        sh.getRange(i + 2, 5).setValue(newSaved);
        const target = Number(data[i][1]);
        const percent = target > 0 ? ((newSaved / target) * 100).toFixed(0) : "0";
        return `✅ Đã góp ${amount.toLocaleString()}đ vào <b>${name}</b>.\nTổng đã tiết kiệm: ${newSaved.toLocaleString()}đ / ${target.toLocaleString()}đ (${percent}%)`;
      }
    }
    return `⚠️ Không tìm thấy mục tiêu "${name}". Dùng <code>/goals</code> để xem danh sách, hoặc tạo mới bằng <code>/goal</code>.`;
  } finally {
    lock.releaseLock();
  }
}

function getGoalsReport() {
  const sh = ensureGoalsSheet();
  if (sh.getLastRow() <= 1) {
    return "📭 Chưa có mục tiêu tiết kiệm nào.\n\nDùng: <code>/goal Laptop 35000000 8</code>";
  }
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  const today = new Date();
  let result = "🎯 <b>Mục tiêu tiết kiệm</b>\n\n";

  data.forEach(([name, target, months, startDate, saved]) => {
    target = Number(target); months = Number(months); saved = Number(saved || 0);
    const start = new Date(startDate);
    const elapsedMonths = Math.max(0, (today.getFullYear() - start.getFullYear()) * 12 + (today.getMonth() - start.getMonth()) + (today.getDate() - start.getDate()) / 30);
    const expectedByNow = Math.min(target, (target / months) * elapsedMonths);
    const percent = target > 0 ? (saved / target) * 100 : 0;
    const onTrack = saved >= expectedByNow * 0.9;
    const emoji = percent >= 100 ? "🏆" : onTrack ? "🟢" : "🟠";
    const status = percent >= 100 ? "Đã hoàn thành!" : (onTrack ? "Đúng tiến độ" : "Đang chậm hơn kế hoạch");

    result += `${emoji} <b>${name}</b>: ${saved.toLocaleString()}đ / ${target.toLocaleString()}đ (${percent.toFixed(0)}%)\n` +
      `   Mục tiêu ${months} tháng, cần ~${Math.round(target / months).toLocaleString()}đ/tháng — ${status}\n\n`;
  });

  return result.trim();
}