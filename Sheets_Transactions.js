
// Xây dựng bản tóm tắt số liệu — đây là TOÀN BỘ ngữ cảnh gửi cho Gemini, không có gì khác.
// =====================================================
// TỐI ƯU HIỆU NĂNG (mục 8.1 + 8.4 trong hướng dẫn tối ưu)
// =====================================================
// Cache toàn bộ dữ liệu Transactions trong 60s — tránh mỗi hàm báo cáo tự đọc Sheet riêng.
// LƯU Ý: chỉ dùng cho các hàm ĐỌC/TỔNG HỢP (không phụ thuộc số thứ tự dòng thật).
// Các hàm cần đúng row index để sửa/xoá (getRecentTransactions, getTransactionByRow,
// deleteTransactionRow) KHÔNG dùng cache này — luôn đọc trực tiếp từ Sheet để tránh
// xoá nhầm dòng nếu dữ liệu vừa thay đổi.
function getAllTransactionsCached() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("all_transactions");
  if (cached) return JSON.parse(cached);

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName("Transactions");
  const data = (!sh || sh.getLastRow() <= 1) ? [] : sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues();
  // JSON.stringify tự chuyển Date -> chuỗi ISO; mọi nơi dùng lại đều bọc new Date(row[0])
  // nên không ảnh hưởng, vẫn parse đúng ngày giờ.
  try { cache.put("all_transactions", JSON.stringify(data), 60); } catch (e) { Logger.log("Cache put lỗi (bỏ qua): " + e); }
  return data;
}

function invalidateTransactionsCache() {
  try { CacheService.getScriptCache().remove("all_transactions"); } catch (e) { /* bỏ qua */ }
}

// Gộp logic lọc theo tháng — dùng chung cho mọi hàm báo cáo tháng thay vì mỗi hàm tự viết lại.
function getMonthlyTransactionData(monthOffset = 0) {
  const data = getAllTransactionsCached();
  const today = new Date();
  const target = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  const m = target.getMonth(), y = target.getFullYear();
  return data.filter(row => {
    const d = new Date(row[0]);
    return d.getMonth() === m && d.getFullYear() === y;
  });
}

// =====================================================
// GOOGLE SHEETS: TRANSACTIONS
// =====================================================
function ensureSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName("Transactions");
  if (!sh) {
    sh = ss.insertSheet("Transactions");
    sh.appendRow(["Thời gian", "Người dùng", "Loại", "Số tiền", "Ghi chú", "Danh mục"]);
  } else {
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    if (!headers.includes("Danh mục")) {
      sh.insertColumnAfter(5);
      sh.getRange(1, 6).setValue("Danh mục");
    }
  }
}

function appendToSheet(parsed, user, whenDate) {
  const txDate = whenDate || new Date();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sh = ss.getSheetByName(MASTER_SHEET_NAME) || ss.insertSheet(MASTER_SHEET_NAME);
    sh.appendRow([txDate, user, parsed.type, parsed.amount, parsed.note || "", parsed.category || "Khác"]);
    invalidateTransactionsCache();
  } finally {
    lock.releaseLock();
  }

  // Tự động đảm bảo tab tháng tương ứng tồn tại (hỗ trợ cả giao dịch nhập lùi ngày).
  // Đặt trong try/catch ngoài lock để không bao giờ làm gián đoạn việc lưu hay phản hồi Telegram.
  try {
    ensureMonthSheet(txDate);
  } catch (sheetErr) {
    Logger.log("[appendToSheet] Lỗi ensureMonthSheet (bỏ qua để không chặn bot): " + sheetErr);
  }
}

function getRecentTransactions(n) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName("Transactions");
  if (!sh || sh.getLastRow() <= 1) return [];
  const lastRow = sh.getLastRow();
  const firstRow = Math.max(2, lastRow - n + 1);
  const values = sh.getRange(firstRow, 1, lastRow - firstRow + 1, 6).getValues();
  const result = [];
  for (let i = values.length - 1; i >= 0; i--) {
    const row = values[i];
    result.push({
      row: firstRow + i,
      date: row[0], user: row[1], type: row[2],
      amount: Number(row[3]), note: row[4], category: row[5]
    });
  }
  return result;
}

function getTransactionByRow(row) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName("Transactions");
  if (!sh || row < 2 || row > sh.getLastRow()) return null;
  const r = sh.getRange(row, 1, 1, 6).getValues()[0];
  return { date: r[0], user: r[1], type: r[2], amount: Number(r[3]), note: r[4], category: r[5] };
}

function deleteTransactionRow(row) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sh = ss.getSheetByName("Transactions");
    if (!sh || row < 2 || row > sh.getLastRow()) return false;
    sh.deleteRow(row);
    invalidateTransactionsCache();
    return true;
  } catch (err) {
    Logger.log("Delete row error: " + err);
    return false;
  } finally {
    lock.releaseLock();
  }
}

function searchTransactions(keyword) {
  if (!keyword) {
    return "ℹ️ Dùng:\n<code>/search cà phê</code> (tìm theo từ khoá)\n<code>/search &gt;500k</code> (lớn hơn)\n<code>/search &lt;100k</code> (nhỏ hơn)\n<code>/search 100k-300k</code> (khoảng)";
  }
  const data = getAllTransactionsCached();
  if (data.length === 0) return "📭 Chưa có dữ liệu nào.";

  const trimmed = keyword.trim();
  let matches = null;
  let filterDescription = `"${keyword}"`;

  const rangeMatch = trimmed.match(/^([\d.,]+\s*(?:k|tr|triệu|trieu)?)\s*-\s*([\d.,]+\s*(?:k|tr|triệu|trieu)?)$/i);
  const compareMatch = trimmed.match(/^(>=|<=|>|<)\s*([\d.,]+\s*(?:k|tr|triệu|trieu)?)$/i);

  if (rangeMatch) {
    const lo = parseAmountShorthand(rangeMatch[1]);
    const hi = parseAmountShorthand(rangeMatch[2]);
    if (lo !== null && hi !== null) {
      const min = Math.min(lo, hi), max = Math.max(lo, hi);
      matches = data.filter(row => Number(row[3]) >= min && Number(row[3]) <= max);
      filterDescription = `${min.toLocaleString()}đ – ${max.toLocaleString()}đ`;
    }
  } else if (compareMatch) {
    const op = compareMatch[1];
    const val = parseAmountShorthand(compareMatch[2]);
    if (val !== null) {
      matches = data.filter(row => {
        const amt = Number(row[3]);
        if (op === ">") return amt > val;
        if (op === ">=") return amt >= val;
        if (op === "<") return amt < val;
        return amt <= val;
      });
      filterDescription = `${op} ${val.toLocaleString()}đ`;
    }
  }

  if (matches === null) {
    // Không khớp cú pháp lọc số tiền -> quay về tìm theo từ khoá văn bản như trước
    const kw = keyword.toLowerCase();
    matches = data.filter(row => {
      const note = String(row[4] || "").toLowerCase();
      const cat = String(row[5] || "").toLowerCase();
      return note.includes(kw) || cat.includes(kw);
    });
  }

  if (matches.length === 0) return `📭 Không tìm thấy giao dịch nào khớp với ${filterDescription}.`;

  const shown = matches.slice(-20); // giới hạn 20 kết quả gần nhất để tránh tin nhắn quá dài
  let result = `🔎 <b>Tìm ${filterDescription}</b> (${matches.length} kết quả${matches.length > 20 ? ", hiện 20 gần nhất" : ""}):\n\n`;
  shown.forEach(row => {
    const d = new Date(row[0]);
    const dateStr = `${d.getDate()}/${d.getMonth() + 1}`;
    result += `• ${dateStr} — ${row[2]} ${Number(row[3]).toLocaleString()}đ — ${row[4]} (${row[5]})\n`;
  });
  return result;
}