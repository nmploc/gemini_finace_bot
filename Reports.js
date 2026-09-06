
// =====================================================
// REPORTING FUNCTIONS
// =====================================================

// Báo cáo 1 ngày cụ thể — liệt kê từng giao dịch trong ngày đó, kèm tổng kết.
// targetDate mặc định là hôm nay nếu không truyền; dùng được cho bất kỳ ngày nào trong quá khứ.
function getDayReport(targetDate) {
  const pad = (n) => String(n).padStart(2, "0");
  const dateLabel = `${pad(targetDate.getDate())}/${pad(targetDate.getMonth() + 1)}/${targetDate.getFullYear()}`;
  const isToday = (() => {
    const now = new Date();
    return targetDate.getDate() === now.getDate() && targetDate.getMonth() === now.getMonth() && targetDate.getFullYear() === now.getFullYear();
  })();
  const title = `📅 <b>Báo cáo ngày ${dateLabel}${isToday ? " (hôm nay)" : ""}</b>`;

  const raw = getAllTransactionsCached();
  const dayTx = raw
    .filter(row => {
      const d = new Date(row[0]);
      return d.getDate() === targetDate.getDate() && d.getMonth() === targetDate.getMonth() && d.getFullYear() === targetDate.getFullYear();
    })
    .sort((a, b) => new Date(a[0]) - new Date(b[0]));

  if (dayTx.length === 0) {
    return `${title}\n\n📭 Không có giao dịch nào trong ngày này.`;
  }

  let totalThu = 0, totalChi = 0;
  const shown = dayTx.slice(0, 30); // giới hạn hiển thị để tránh tin nhắn quá dài trong trường hợp hiếm gặp
  const lines = shown.map(row => {
    const d = new Date(row[0]);
    const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const amt = Number(row[3] || 0);
    return `${row[2] === "thu" ? "💰" : "💸"} ${timeStr} — ${amt.toLocaleString()}đ — ${row[4] || "(không ghi chú)"} <i>(${row[5]})</i>`;
  });
  dayTx.forEach(row => {
    const amt = Number(row[3] || 0);
    if (row[2] === "thu") totalThu += amt; else totalChi += amt;
  });

  const balance = totalThu - totalChi;
  const balanceEmoji = balance >= 0 ? "🟢" : "🔴";
  const truncatedNote = dayTx.length > 30 ? `\n<i>(chỉ hiện 30/${dayTx.length} giao dịch đầu ngày)</i>` : "";

  return `${title}\n\n` +
    lines.join("\n") + truncatedNote +
    `\n\n💰 <b>Tổng thu:</b> ${totalThu.toLocaleString()}đ\n💸 <b>Tổng chi:</b> ${totalChi.toLocaleString()}đ\n${balanceEmoji} <b>Cân đối:</b> ${balance.toLocaleString()}đ`;
}

// Số dư CỘNG DỒN TOÀN THỜI GIAN (không giới hạn theo tháng) — vd: tháng này nhận 5tr lương,
// tiêu 3tr -> còn 2tr; tháng sau hỏi "còn bao nhiêu tiền" vẫn phải trả lời đúng 2tr (không reset về 0
// khi sang tháng mới), vì đây là số dư thực tế cộng dồn từ giao dịch đầu tiên tới hiện tại.
function getTotalBalance() {
  const data = getAllTransactionsCached();
  let totalThu = 0, totalChi = 0;
  data.forEach(row => {
    const [, , type, amt] = row;
    if (type === "thu") totalThu += Number(amt || 0);
    if (type === "chi") totalChi += Number(amt || 0);
  });
  return { totalThu, totalChi, balance: totalThu - totalChi };
}

function getBalanceReport() {
  const data = getAllTransactionsCached();
  if (data.length === 0) return "📭 Chưa ghi nhận giao dịch nào.";
  const { totalThu, totalChi, balance } = getTotalBalance();
  const emoji = balance >= 0 ? "🟢" : "🔴";
  return `💵 <b>Số dư hiện tại của bạn</b>\n\n` +
    `💰 Tổng thu (từ trước đến nay): ${totalThu.toLocaleString()}đ\n` +
    `💸 Tổng chi (từ trước đến nay): ${totalChi.toLocaleString()}đ\n\n` +
    `${emoji} <b>Còn lại: ${balance.toLocaleString()}đ</b>`;
}

function getFinanceReport(mode = "all") {
  const data = getAllTransactionsCached();
  if (data.length === 0) return "📭 Chưa ghi nhận giao dịch nào.";

  const today = new Date();
  const d = today.getDate(), m = today.getMonth(), y = today.getFullYear();
  let totalThu = 0, totalChi = 0;

  data.forEach(row => {
    const [ts, , type, amt] = row;
    if (!ts || !type || !amt) return;
    const date = new Date(ts);
    if (mode === "day" && (date.getDate() !== d || date.getMonth() !== m || date.getFullYear() !== y)) return;
    if (mode === "month" && (date.getMonth() !== m || date.getFullYear() !== y)) return;
    if (type === "thu") totalThu += Number(amt);
    if (type === "chi") totalChi += Number(amt);
  });

  const balance = totalThu - totalChi;
  const emoji = balance >= 0 ? "🟢" : "🔴";
  const title = mode === "day" ? "📅 <b>Báo cáo hôm nay</b>" : mode === "month" ? "🗓️ <b>Báo cáo tháng này</b>" : "📊 <b>Báo cáo tổng hợp</b>";
  const causeLine = mode === "month" ? getAutoCauseLine() : "";
  return `${title}\n\n💰 <b>Tổng thu:</b> ${totalThu.toLocaleString()}đ\n💸 <b>Tổng chi:</b> ${totalChi.toLocaleString()}đ\n${emoji} <b>Cân đối:</b> ${balance.toLocaleString()}đ\n\n${balance >= 0 ? "Tài chính ổn áp đó nha 😎" : "Chi hơi mạnh tay rồi 😅"}${causeLine}`;
}

function getCategoryReport() {
  const data = getAllTransactionsCached();
  if (data.length === 0) return "📭 Chưa có dữ liệu nào.";
  const totals = {};
  data.forEach(row => {
    const [ , , type, amt, , category ] = row;
    if (type === "chi") totals[category] = (totals[category] || 0) + Number(amt || 0);
  });
  const entries = Object.entries(totals);
  if (entries.length === 0) return "📭 Chưa có giao dịch chi tiêu nào.";
  entries.sort((a, b) => b[1] - a[1]);
  let result = "🏷️ <b>Báo cáo theo danh mục chi tiêu</b>\n\n";
  entries.forEach(([cat, val]) => result += `• ${cat}: ${val.toLocaleString()}đ\n`);
  return result;
}

function getTopCategoryReport() {
  const totals = getCategoryTotalsThisMonth();
  const entries = Object.entries(totals);
  if (entries.length === 0) return "📭 Tháng này chưa có chi tiêu nào.";
  entries.sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, e) => sum + e[1], 0);
  const [topCat, topVal] = entries[0];
  const percent = total > 0 ? ((topVal / total) * 100).toFixed(1) : "0.0";
  return `📈 <b>Danh mục chi tiêu nhiều nhất tháng này</b>\n\n🥇 <b>${topCat}</b>: ${topVal.toLocaleString()}đ\nChiếm khoảng ${percent}% tổng chi tiêu.\n\nTiếp tục quản lý tốt nhé 💪`;
}

function getCategoryTotalsThisMonth(monthOffset = 0) {
  const totals = {};
  const monthData = getMonthlyTransactionData(monthOffset);
  monthData.forEach(row => {
    const [ , , type, amt, , category] = row;
    if (type === "chi") totals[category] = (totals[category] || 0) + Number(amt || 0);
  });
  return totals;
}

function getCompareReport() {
  const data = getAllTransactionsCached();
  if (data.length === 0) return "📭 Chưa có dữ liệu để so sánh.";

  const sums = (monthOffset) => {
    const monthData = getMonthlyTransactionData(monthOffset);
    let thu = 0, chi = 0;
    monthData.forEach(row => {
      const [, , type, amt] = row;
      if (type === "thu") thu += Number(amt || 0);
      if (type === "chi") chi += Number(amt || 0);
    });
    return { thu, chi };
  };

  const cur = sums(0);
  const prev = sums(-1);
  const diffChi = cur.chi - prev.chi;
  const percentChi = prev.chi > 0 ? ((diffChi / prev.chi) * 100).toFixed(1) : (cur.chi > 0 ? "100.0" : "0.0");
  const arrow = diffChi > 0 ? "📈 tăng" : diffChi < 0 ? "📉 giảm" : "➡️ không đổi";

  return `📊 <b>So sánh chi tiêu tháng này vs tháng trước</b>\n\n` +
    `Tháng trước: ${prev.chi.toLocaleString()}đ\n` +
    `Tháng này: ${cur.chi.toLocaleString()}đ\n\n` +
    `${arrow} ${Math.abs(diffChi).toLocaleString()}đ (${Math.abs(percentChi)}%) so với tháng trước.` +
    getCategoryCompareLines() +
    getAutoCauseLine();
}

// So sánh chi tiêu theo TỪNG danh mục giữa tháng này và tháng trước — phần mở rộng của /compare
function getCategoryCompareLines() {
  const cur = getCategoryTotalsThisMonth(0);
  const prev = getCategoryTotalsThisMonth(-1);
  const allCategories = new Set([...Object.keys(cur), ...Object.keys(prev)]);
  if (allCategories.size === 0) return "";

  const lines = [];
  allCategories.forEach(cat => {
    const c = cur[cat] || 0;
    const p = prev[cat] || 0;
    if (c === 0 && p === 0) return;
    const diff = c - p;
    if (p === 0) {
      lines.push({ cat, text: `• ${cat}: mới phát sinh ${c.toLocaleString()}đ`, absDiff: c });
    } else {
      const pct = ((diff / p) * 100).toFixed(0);
      const arrow = diff > 0 ? "📈" : diff < 0 ? "📉" : "➡️";
      lines.push({ cat, text: `• ${cat}: ${arrow} ${diff >= 0 ? "+" : ""}${diff.toLocaleString()}đ (${diff >= 0 ? "+" : ""}${pct}%)`, absDiff: Math.abs(diff) });
    }
  });
  if (lines.length === 0) return "";
  lines.sort((a, b) => b.absDiff - a.absDiff);
  return "\n\n<b>Theo danh mục:</b>\n" + lines.map(l => l.text).join("\n");
}

// Mục 3 trong hướng dẫn tối ưu: "phân tích nguyên nhân" thuần công thức, không tốn Gemini.
// Tìm danh mục có mức TĂNG lớn nhất so với tháng trước, gắn thành 1 dòng nguyên nhân.
function getAutoCauseLine() {
  const cur = getCategoryTotalsThisMonth(0);
  const prev = getCategoryTotalsThisMonth(-1);
  let maxCat = null, maxDiff = 0;
  Object.keys(cur).forEach(cat => {
    const diff = (cur[cat] || 0) - (prev[cat] || 0);
    if (diff > maxDiff) { maxDiff = diff; maxCat = cat; }
  });
  if (!maxCat || maxDiff <= 0) return "";
  return `\n\n💡 Nguyên nhân chính: <b>${maxCat}</b> tăng ${maxDiff.toLocaleString()}đ so với tháng trước.`;
}

// =====================================================
// BÁO CÁO TUẦN (Nhóm A) — thuần tính toán, không tốn Gemini
// =====================================================
function getWeekBounds(refDate) {
  const d = new Date(refDate);
  const day = d.getDay(); // 0=CN, 1=T2 ... 6=T7
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diffToMonday, 0, 0, 0);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6, 23, 59, 59);
  return { monday, sunday };
}

function getWeekReport() {
  const data = getAllTransactionsCached();
  if (data.length === 0) return "📭 Chưa ghi nhận giao dịch nào.";

  const { monday, sunday } = getWeekBounds(new Date());
  let totalThu = 0, totalChi = 0;
  const catTotals = {};

  data.forEach(row => {
    const [ts, , type, amt, , cat] = row;
    const d = new Date(ts);
    if (d >= monday && d <= sunday) {
      if (type === "thu") totalThu += Number(amt || 0);
      if (type === "chi") {
        totalChi += Number(amt || 0);
        catTotals[cat] = (catTotals[cat] || 0) + Number(amt || 0);
      }
    }
  });

  const balance = totalThu - totalChi;
  const emoji = balance >= 0 ? "🟢" : "🔴";
  const pad = (n) => String(n).padStart(2, "0");
  const rangeStr = `${pad(monday.getDate())}/${pad(monday.getMonth() + 1)} - ${pad(sunday.getDate())}/${pad(sunday.getMonth() + 1)}`;

  let result = `📆 <b>Báo cáo tuần này</b> (${rangeStr})\n\n` +
    `💰 <b>Tổng thu:</b> ${totalThu.toLocaleString()}đ\n` +
    `💸 <b>Tổng chi:</b> ${totalChi.toLocaleString()}đ\n` +
    `${emoji} <b>Cân đối:</b> ${balance.toLocaleString()}đ\n`;

  const catEntries = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
  if (catEntries.length > 0) {
    result += `\n<b>Danh mục chi nhiều nhất tuần:</b>\n`;
    catEntries.slice(0, 3).forEach(([cat, val]) => result += `• ${cat}: ${val.toLocaleString()}đ\n`);
  }
  return result;
}

// =====================================================
// TOP 5 GIAO DỊCH LỚN NHẤT (Nhóm A) — trong tháng hiện tại
// =====================================================
function getTop5Report() {
  const thisMonth = getMonthlyTransactionData(0);
  if (thisMonth.length === 0) return "📭 Chưa có dữ liệu nào.";

  const chiList = thisMonth.filter(r => r[2] === "chi").sort((a, b) => Number(b[3]) - Number(a[3])).slice(0, 5);
  const thuList = thisMonth.filter(r => r[2] === "thu").sort((a, b) => Number(b[3]) - Number(a[3])).slice(0, 5);

  const fmtRow = (row) => {
    const d = new Date(row[0]);
    return `• ${d.getDate()}/${d.getMonth() + 1} — ${Number(row[3]).toLocaleString()}đ — ${row[4]} (${row[5]})`;
  };

  let result = "🏆 <b>Top giao dịch tháng này</b>\n\n<b>💸 Chi lớn nhất:</b>\n";
  result += chiList.length ? chiList.map(fmtRow).join("\n") : "Chưa có khoản chi nào.";
  result += "\n\n<b>💰 Thu lớn nhất:</b>\n";
  result += thuList.length ? thuList.map(fmtRow).join("\n") : "Chưa có khoản thu nào.";
  return result;
}

// =====================================================
// DỰ ĐOÁN CHI TIÊU CUỐI THÁNG & DỰ BÁO SỐ DƯ (Nhóm B) — công thức toán học, không cần AI
// =====================================================
// Tính toán thuần (dùng chung cho /forecast VÀ cho ngữ cảnh gửi Gemini ở /hoi)
function getForecastNumbers() {
  const monthData = getMonthlyTransactionData(0);
  if (monthData.length === 0) return null;

  const today = new Date();
  const m = today.getMonth(), y = today.getFullYear();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const daysPassed = today.getDate();
  const daysRemaining = daysInMonth - daysPassed;

  let spendSoFar = 0, incomeSoFar = 0;
  monthData.forEach(row => {
    const [, , type, amt] = row;
    if (type === "chi") spendSoFar += Number(amt || 0);
    if (type === "thu") incomeSoFar += Number(amt || 0);
  });
  if (daysPassed === 0) return null;

  const avgPerDay = spendSoFar / daysPassed;
  const projectedTotal = avgPerDay * daysInMonth;
  const projectedRemaining = avgPerDay * daysRemaining;
  const projectedBalance = incomeSoFar - projectedTotal;

  return { daysPassed, daysInMonth, daysRemaining, spendSoFar, incomeSoFar, avgPerDay, projectedTotal, projectedRemaining, projectedBalance };
}

function getForecastReport() {
  const f = getForecastNumbers();
  if (!f) return "📭 Chưa có đủ dữ liệu để dự đoán.";

  let result = `🔮 <b>Dự đoán cuối tháng</b> (dựa trên tốc độ chi ${f.daysPassed} ngày qua)\n\n` +
    `📅 Đã qua ${f.daysPassed}/${f.daysInMonth} ngày (còn ${f.daysRemaining} ngày)\n` +
    `💸 Đã chi: ${f.spendSoFar.toLocaleString()}đ (trung bình ${Math.round(f.avgPerDay).toLocaleString()}đ/ngày)\n` +
    `📈 Dự kiến chi thêm: ~${Math.round(f.projectedRemaining).toLocaleString()}đ\n` +
    `🎯 Dự kiến tổng chi cả tháng: ~${Math.round(f.projectedTotal).toLocaleString()}đ\n\n` +
    `${f.projectedBalance >= 0 ? "🟢" : "🔴"} Dự báo số dư cuối tháng: ~${Math.round(f.projectedBalance).toLocaleString()}đ\n\n` +
    `<i>* Đây là ước tính tuyến tính dựa trên tốc độ chi trung bình, không phải con số chắc chắn.</i>`;

  return result;
}

// =====================================================
// PHÁT HIỆN XU HƯỚNG 3 THÁNG GẦN NHẤT (Nhóm B)
// =====================================================
function getTrendReport() {
  const raw = getAllTransactionsCached();
  if (raw.length === 0) return "📭 Chưa có đủ dữ liệu để phân tích xu hướng.";

  const months = [0, -1, -2].map(offset => ({ offset, totals: getCategoryTotalsThisMonth(offset) }));
  const allCategories = new Set();
  months.forEach(m => Object.keys(m.totals).forEach(c => allCategories.add(c)));
  if (allCategories.size === 0) return "📭 Chưa có đủ dữ liệu để phân tích xu hướng.";

  const pad = (n) => String(n).padStart(2, "0");
  const monthLabels = months.map(m => {
    const d = new Date(); d.setMonth(d.getMonth() + m.offset);
    return `${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  });

  let result = `🧭 <b>Xu hướng chi tiêu 3 tháng gần nhất</b> (${monthLabels[2]} → ${monthLabels[0]})\n\n`;
  let hasTrend = false;

  allCategories.forEach(cat => {
    const v2 = months[2].totals[cat] || 0; // 2 tháng trước
    const v1 = months[1].totals[cat] || 0; // tháng trước
    const v0 = months[0].totals[cat] || 0; // tháng này
    if (v2 === 0 && v1 === 0 && v0 === 0) return;

    // Chỉ báo xu hướng khi tăng/giảm LIÊN TỤC qua 2 lần so sánh
    const increasing = v0 > v1 && v1 > v2 && v2 > 0;
    const decreasing = v0 < v1 && v1 < v2 && v0 > 0;
    if (increasing || decreasing) {
      hasTrend = true;
      const arrow = increasing ? "📈 Tăng liên tục" : "📉 Giảm liên tục";
      result += `${arrow} — <b>${cat}</b>: ${v2.toLocaleString()}đ → ${v1.toLocaleString()}đ → ${v0.toLocaleString()}đ\n`;
    }
  });

  if (!hasTrend) result += "Chưa phát hiện danh mục nào tăng/giảm liên tục rõ rệt trong 3 tháng qua.";
  return result;
}

// =====================================================
// PHÁT HIỆN ĐĂNG KÝ ĐỊNH KỲ (Nhóm B) — nhóm giao dịch cùng số tiền, lặp lại ~30 ngày/lần
// =====================================================
function getSubscriptionsReport() {
  const raw = getAllTransactionsCached();
  if (raw.length === 0) return "📭 Chưa có đủ dữ liệu.";

  const data = raw
    .filter(r => r[2] === "chi")
    .map(r => ({ date: new Date(r[0]), amount: Number(r[3]), note: r[4] }));

  // Nhóm theo (số tiền làm tròn gần nhất + ghi chú viết thường) để tìm các khoản lặp lại
  const groups = {};
  data.forEach(t => {
    const key = Math.round(t.amount / 1000) * 1000 + "|" + String(t.note || "").toLowerCase().trim();
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });

  const suspects = [];
  Object.values(groups).forEach(list => {
    if (list.length < 2) return;
    list.sort((a, b) => a.date - b.date);
    // Kiểm tra khoảng cách giữa các lần liên tiếp có đều đặn ~25-35 ngày không
    let regularCount = 0;
    for (let i = 1; i < list.length; i++) {
      const diffDays = (list[i].date - list[i - 1].date) / (1000 * 60 * 60 * 24);
      if (diffDays >= 25 && diffDays <= 35) regularCount++;
    }
    if (regularCount >= 1) {
      suspects.push({
        note: list[0].note || "(không ghi chú)",
        amount: list[0].amount,
        count: list.length,
        lastDate: list[list.length - 1].date
      });
    }
  });

  if (suspects.length === 0) {
    return "📭 Chưa phát hiện khoản chi định kỳ nào (cần ít nhất 2 lần chi cùng số tiền, cách nhau ~1 tháng).";
  }

  suspects.sort((a, b) => b.amount - a.amount);
  let result = "🔁 <b>Có thể là chi tiêu định kỳ (subscription)</b>\n\n";
  suspects.forEach(s => {
    result += `• ${s.note} — ${s.amount.toLocaleString()}đ/lần, đã ghi nhận ${s.count} lần\n`;
  });
  result += "\n<i>* Dựa trên các khoản chi cùng số tiền, lặp lại đều đặn ~1 tháng/lần.</i>";
  return result;
}

// =====================================================
// ĐIỂM SỨC KHỎE TÀI CHÍNH (Nhóm B) — công thức, không cần AI
// =====================================================
const ESSENTIAL_CATEGORIES = ["Hóa đơn", "Sức khỏe", "Di chuyển"];

// Tính toán thuần (dùng chung cho /score VÀ ngữ cảnh gửi Gemini ở /hoi)
function computeHealthScoreRaw() {
  const monthData = getMonthlyTransactionData(0);
  if (monthData.length === 0) return null;

  let thu = 0, chi = 0, essential = 0, nonEssential = 0;
  monthData.forEach(row => {
    const [, , type, amt, , cat] = row;
    if (type === "thu") thu += Number(amt || 0);
    if (type === "chi") {
      chi += Number(amt || 0);
      if (ESSENTIAL_CATEGORIES.includes(cat)) essential += Number(amt || 0);
      else nonEssential += Number(amt || 0);
    }
  });
  if (thu === 0 && chi === 0) return null;

  const savingsRate = thu > 0 ? (thu - chi) / thu : (chi > 0 ? -1 : 0);
  const savingsScore = Math.max(0, Math.min(40, (savingsRate / 0.3) * 40));

  const essentialRatio = chi > 0 ? essential / chi : 0;
  const essentialScore = Math.max(0, Math.min(30, essentialRatio * 30 + 10));

  const budgets = getBudgets();
  const budgetCats = Object.keys(budgets);
  let overBudgetCount = 0;
  budgetCats.forEach(cat => {
    if (getCategorySpendThisMonth(cat) > budgets[cat]) overBudgetCount++;
  });
  const budgetScore = budgetCats.length === 0 ? 10 : Math.max(0, 30 - overBudgetCount * 15);

  const total = Math.round(savingsScore + essentialScore + budgetScore);
  const rating = total >= 80 ? "Rất tốt" : total >= 60 ? "Ổn" : total >= 40 ? "Cần chú ý" : "Đáng lo";

  return { thu, chi, essential, nonEssential, savingsRate, savingsScore, essentialRatio, essentialScore, budgetCats, overBudgetCount, budgetScore, total, rating };
}

function getFinancialHealthScore() {
  const s = computeHealthScoreRaw();
  if (!s) return "📭 Chưa có đủ dữ liệu tháng này để chấm điểm.";

  const ratingEmoji = s.total >= 80 ? "🟢" : s.total >= 60 ? "🟡" : s.total >= 40 ? "🟠" : "🔴";

  let result = `❤️ <b>Điểm sức khỏe tài chính tháng này: ${s.total}/100</b> — ${ratingEmoji} ${s.rating}\n\n` +
    `💰 Tỷ lệ tiết kiệm: ${(s.savingsRate * 100).toFixed(0)}% (${s.savingsScore.toFixed(0)}/40 điểm)\n` +
    `🧾 Tỷ lệ chi thiết yếu: ${(s.essentialRatio * 100).toFixed(0)}% (${s.essentialScore.toFixed(0)}/30 điểm)\n` +
    `📋 Kiểm soát ngân sách: ${s.budgetCats.length === 0 ? "chưa đặt ngân sách" : (s.overBudgetCount + "/" + s.budgetCats.length + " danh mục vượt")} (${s.budgetScore.toFixed(0)}/30 điểm)\n\n`;

  if (s.savingsRate < 0.1) result += "💡 Gợi ý: tỷ lệ tiết kiệm đang thấp, thử xem lại các khoản chi không thiết yếu.\n";
  if (s.budgetCats.length === 0) result += "💡 Gợi ý: đặt ngân sách cho vài danh mục hay chi để kiểm soát tốt hơn (/budget).\n";

  result += "\n" + getEmergencyFundSuggestion(s.essential);

  return result;
}

// Gợi ý quỹ khẩn cấp = 3-6 tháng chi thiết yếu (dựa trên trung bình chi thiết yếu tháng này)
function getEmergencyFundSuggestion(essentialThisMonth) {
  if (!essentialThisMonth || essentialThisMonth <= 0) {
    return "🛟 <i>Chưa đủ dữ liệu chi thiết yếu tháng này để gợi ý quỹ khẩn cấp.</i>";
  }
  const low = essentialThisMonth * 3;
  const high = essentialThisMonth * 6;
  return `🛟 <b>Quỹ khẩn cấp gợi ý:</b> ${low.toLocaleString()}đ – ${high.toLocaleString()}đ\n` +
    `<i>(dựa trên 3-6 tháng chi thiết yếu, ước theo tháng này ~${essentialThisMonth.toLocaleString()}đ/tháng)</i>`;
}

// =====================================================
// PHÁT HIỆN GIAO DỊCH BẤT THƯỜNG (Nhóm B) — so với trung bình 30 ngày qua cùng danh mục
// =====================================================
function checkAnomalyAlert(category, newAmount) {
  const raw = getAllTransactionsCached();
  if (raw.length === 0) return null;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  const amounts = raw
    .filter(row => row[2] === "chi" && row[5] === category && new Date(row[0]) >= cutoff)
    .map(row => Number(row[3]));

  // Cần ít nhất 3 giao dịch trước đó mới đủ để tính trung bình có ý nghĩa — tránh cảnh báo giả với dữ liệu ít
  if (amounts.length < 3) return null;

  const avg = amounts.reduce((s, v) => s + v, 0) / amounts.length;
  if (avg <= 0) return null;

  const ratio = newAmount / avg;
  if (ratio >= 2.5) {
    return `🚩 <b>Bất thường:</b> khoản này gấp ${ratio.toFixed(1)} lần trung bình danh mục "${category}" 30 ngày qua (TB: ${Math.round(avg).toLocaleString()}đ).`;
  }
  return null;
}

// =====================================================
// LEVEL 5 — HỌC THÓI QUEN CHI TIÊU (mục 4, 6, 7 trong hướng dẫn tối ưu)
// Toàn bộ đều là thống kê thuần trên dữ liệu đã cache — không tốn Gemini.
// =====================================================

// Mục 4: pattern theo (thứ trong tuần + danh mục), xét 60 ngày gần nhất.
// Tách riêng hàm này để dùng chung cho /patterns VÀ cho nhắc nhở thông minh (mục 5).
function buildWeekdayBuckets() {
  const buckets = {}; // key: "5|Ăn uống" -> {sum, count}
  const raw = getAllTransactionsCached();
  if (raw.length === 0) return buckets;

  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 60);
  raw.filter(r => r[2] === "chi" && new Date(r[0]) >= cutoff).forEach(r => {
    const d = new Date(r[0]);
    const key = d.getDay() + "|" + r[5];
    if (!buckets[key]) buckets[key] = { sum: 0, count: 0 };
    buckets[key].sum += Number(r[3] || 0);
    buckets[key].count += 1;
  });
  return buckets;
}

function getWeekdayPatternReport() {
  const buckets = buildWeekdayBuckets();
  const dayNames = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
  const patterns = [];

  Object.entries(buckets).forEach(([key, v]) => {
    const [day, cat] = key.split("|");
    // Coi là pattern nếu xuất hiện >= 4 lần trong 60 ngày (~1 lần/tuần trở lên)
    if (v.count >= 4) {
      patterns.push({ day: Number(day), cat, avg: v.sum / v.count, count: v.count });
    }
  });

  if (patterns.length === 0) return "📭 Chưa phát hiện thói quen rõ rệt theo ngày trong tuần (cần thêm dữ liệu).";
  patterns.sort((a, b) => b.count - a.count);

  let result = "🗓️ <b>Thói quen chi tiêu theo ngày trong tuần</b> (60 ngày qua)\n\n";
  patterns.slice(0, 5).forEach(p => {
    result += `• ${dayNames[p.day]}: hay chi <b>${p.cat}</b> (~${Math.round(p.avg).toLocaleString()}đ, ${p.count} lần)\n`;
  });
  return result;
}

// Mục 6: gợi ý tiết kiệm dựa trên các khoản chi lặp lại nhiều lần trong tháng (vd Grab, cà phê...)
function getBehaviorSavingTips() {
  const monthData = getMonthlyTransactionData(0).filter(r => r[2] === "chi");
  if (monthData.length === 0) return "📭 Chưa đủ dữ liệu tháng này.";

  // Nhóm theo note viết thường (giữ nguyên cách viết gốc lần đầu để hiển thị)
  const groups = {};
  monthData.forEach(r => {
    const key = String(r[4] || "").toLowerCase().trim();
    if (!key) return;
    if (!groups[key]) groups[key] = { label: r[4], sum: 0, count: 0 };
    groups[key].sum += Number(r[3] || 0);
    groups[key].count += 1;
  });

  // Chỉ xét các khoản xuất hiện >= 5 lần trong tháng — đủ để coi là thói quen đáng lưu ý
  const frequent = Object.values(groups).filter(g => g.count >= 5).sort((a, b) => b.sum - a.sum);
  if (frequent.length === 0) return "📭 Chưa có khoản chi lặp lại đủ nhiều (≥5 lần/tháng) để gợi ý tiết kiệm.";

  let result = "💡 <b>Gợi ý tiết kiệm dựa trên thói quen tháng này</b>\n\n";
  frequent.slice(0, 3).forEach(g => {
    const save20 = Math.round(g.sum * 0.2);
    result += `• Bạn chi cho "<b>${g.label}</b>" ${g.count} lần, tổng ${g.sum.toLocaleString()}đ.\n` +
      `  Nếu giảm 20% tần suất, tiết kiệm ~${save20.toLocaleString()}đ/tháng.\n`;
  });
  return result;
}

// Mục 7: nêu số liệu khách quan (chi khuya, cuối tuần) — KHÔNG gán nhãn đạo đức, để người dùng tự đánh giá.
function getBadHabitReport() {
  const raw = getAllTransactionsCached();
  if (raw.length === 0) return "📭 Chưa đủ dữ liệu.";

  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
  const data = raw.filter(r => r[2] === "chi" && new Date(r[0]) >= cutoff);
  if (data.length === 0) return "📭 Chưa đủ dữ liệu.";

  let lateNightSum = 0, lateNightCount = 0;
  let weekendSum = 0, weekendCount = 0;
  let totalSum = 0;

  data.forEach(r => {
    const d = new Date(r[0]);
    const amt = Number(r[3] || 0);
    totalSum += amt;
    if (d.getHours() >= 22 || d.getHours() < 2) { lateNightSum += amt; lateNightCount++; }
    if (d.getDay() === 0 || d.getDay() === 6) { weekendSum += amt; weekendCount++; }
  });

  if (totalSum === 0) return "📭 Chưa đủ dữ liệu.";

  const lines = [];
  const lateNightPct = (lateNightSum / totalSum) * 100;
  const weekendPct = (weekendSum / totalSum) * 100;

  // Ngưỡng: >15% tổng chi diễn ra sau 22h, hoặc >40% tập trung cuối tuần, coi là đáng chú ý
  if (lateNightPct >= 15 && lateNightCount >= 3) {
    lines.push(`🌙 ${lateNightPct.toFixed(0)}% chi tiêu (${lateNightCount} lần) diễn ra sau 22h — ${lateNightSum.toLocaleString()}đ trong 30 ngày qua.`);
  }
  if (weekendPct >= 40 && weekendCount >= 3) {
    lines.push(`🎉 ${weekendPct.toFixed(0)}% chi tiêu tập trung vào cuối tuần — ${weekendSum.toLocaleString()}đ trong 30 ngày qua.`);
  }

  if (lines.length === 0) return "✅ Chưa phát hiện thói quen chi tiêu đáng chú ý trong 30 ngày qua.";
  return "📊 <b>Thói quen đáng chú ý (30 ngày qua)</b>\n\n" + lines.join("\n") +
    "\n\n<i>* Chỉ là số liệu khách quan để bạn tự đánh giá, không phải nhận xét.</i>";
}