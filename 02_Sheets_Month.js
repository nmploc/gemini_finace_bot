// =====================================================
// MONTHLY READ-ONLY TAB MIRRORING
// =====================================================
// Tự động tạo và quản lý các tab tháng (YYYY-MM) phản chiếu dữ liệu trực tiếp
// từ tab master 'Transactions' thông qua công thức QUERY của Google Sheets.
// - Không nhân bản dữ liệu (zero data duplication).
// - Không dùng trigger theo thời gian mới (zero new triggers).
// - Toàn bộ tính toán/lọc do engine Google Sheets đảm nhiệm.

/**
 * Lấy múi giờ chính thức của Spreadsheet (ưu tiên ss.getSpreadsheetTimeZone()).
 * Fallback về múi giờ script nếu không lấy được.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {string} Múi giờ, ví dụ "Asia/Ho_Chi_Minh"
 */
function getEffectiveSpreadsheetTimeZone(ss) {
  try {
    const tz = ss.getSpreadsheetTimeZone();
    if (tz) return tz;
  } catch (err) {
    Logger.log("[getEffectiveSpreadsheetTimeZone] Lỗi đọc múi giờ Spreadsheet: " + err);
  }
  return Session.getScriptTimeZone() || "Asia/Ho_Chi_Minh";
}

/**
 * Kiểm tra xem một tên tab có phải là tab tháng YYYY-MM hay không.
 * Dùng để loại bỏ các tab tháng khi duyệt danh sách sheet.
 * @param {string} sheetName
 * @returns {boolean}
 */
function isMonthSheetName(sheetName) {
  return MONTH_SHEET_REGEX.test(sheetName || "");
}

/**
 * Báo cáo múi giờ của Spreadsheet và Script — dùng để kiểm tra chẩn đoán.
 * @returns {{spreadsheetTimeZone: string, scriptTimeZone: string}}
 */
function reportSpreadsheetTimeZone() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const spreadsheetTimeZone = ss.getSpreadsheetTimeZone();
  const scriptTimeZone = Session.getScriptTimeZone();
  Logger.log(`[reportSpreadsheetTimeZone] Spreadsheet: ${spreadsheetTimeZone} | Script: ${scriptTimeZone}`);
  return { spreadsheetTimeZone, scriptTimeZone };
}

/**
 * Xây dựng công thức QUERY với literal date đã format sẵn trong JavaScript.
 *
 * LƯU Ý VỀ LITERAL DATE & DATETIME TRONG QUERY GOOGLE SHEETS:
 * 1. Dạng chính: date 'yyyy-MM-dd'
 *    Google Sheets Query engine coi literal date tương đương 00:00:00 ngày hôm đó.
 *    Do cột A chứa datetime (thời gian kèm giờ:phút:giây), biểu thức:
 *      A >= date 'YYYY-MM-01' AND A < date '<NEXT_MONTH_01>'
 *    khớp chính xác mọi giao dịch từ 00:00:00 ngày đầu tháng đến 23:59:59 ngày cuối tháng.
 * 2. Fallback datetime: Nếu môi trường yêu cầu tường minh kiểu datetime do cột A có giờ:
 *      SELECT * WHERE A >= datetime '${startStr} 00:00:00' AND A < datetime '${nextMonthStr} 00:00:00'
 * 3. Fallback FILTER (nếu QUERY gặp lỗi cú pháp vùng dữ liệu):
 *      =IFERROR(FILTER('${MASTER_SHEET_NAME}'!A2:F, '${MASTER_SHEET_NAME}'!A2:A >= DATE(yyyy, mm, 1), '${MASTER_SHEET_NAME}'!A2:A < DATE(next_yyyy, next_mm, 1)), "")
 *
 * @param {string} startStr 'yyyy-MM-01'
 * @param {string} nextMonthStr 'yyyy-MM-01' của tháng kế tiếp
 * @returns {string} Chuỗi công thức hoàn chỉnh để setFormula()
 */
function buildMonthQueryFormula(startStr, nextMonthStr) {
  return `=QUERY('${MASTER_SHEET_NAME}'!A2:F, "SELECT * WHERE A >= date '${startStr}' AND A < date '${nextMonthStr}'", 0)`;
}

/**
 * Đảm bảo tab tháng (YYYY-MM) tương ứng với ngày truyền vào đã tồn tại.
 * Hàm idempotent: nếu tab đã có thì không tạo lại và trả về tab hiện có.
 *
 * @param {Date|string|number} [date] Ngày của giao dịch (mặc định là thời điểm hiện tại)
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function ensureMonthSheet(date) {
  date = date || new Date();
  const dateObj = (date instanceof Date) ? date : new Date(date);
  const validDate = isNaN(dateObj.getTime()) ? new Date() : dateObj;

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const tz = getEffectiveSpreadsheetTimeZone(ss);
  const tabName = Utilities.formatDate(validDate, tz, MONTH_SHEET_FORMAT);

  // 1. Kiểm tra nếu tab đã tồn tại (idempotent)
  const existingSheet = ss.getSheetByName(tabName);
  if (existingSheet) {
    return existingSheet;
  }

  // 2. Tìm master sheet
  const master = ss.getSheetByName(MASTER_SHEET_NAME);
  if (!master) {
    throw new Error(`Master sheet "${MASTER_SHEET_NAME}" không tồn tại.`);
  }

  // 3. Tạo tab mới ngay sau tab master
  const masterIndex = master.getIndex(); // 1-based index
  const newSheet = ss.insertSheet(tabName, masterIndex);

  // 4. Sao chép hàng tiêu đề (hàng 1) từ master
  const headerValues = master.getRange(1, 1, 1, 6).getValues();
  newSheet.getRange(1, 1, 1, 6).setValues(headerValues);

  try {
    const headerFontWeights = master.getRange(1, 1, 1, 6).getFontWeights();
    newSheet.getRange(1, 1, 1, 6).setFontWeights(headerFontWeights);
  } catch (styleErr) {
    Logger.log("[ensureMonthSheet] Bỏ qua lỗi format header: " + styleErr);
  }

  // Cố định hàng 1 để tiện cuộn xem
  try {
    newSheet.setFrozenRows(1);
  } catch (freezeErr) {
    Logger.log("[ensureMonthSheet] Bỏ qua lỗi freeze row: " + freezeErr);
  }

  // 5. Đồng bộ định dạng số/ngày tháng theo các cột của master
  if (master.getLastRow() >= 2) {
    try {
      const formats = master.getRange(2, 1, 1, 6).getNumberFormats();
      const maxRows = newSheet.getMaxRows();
      if (maxRows > 1) {
        const formatMatrix = Array(maxRows - 1).fill(formats[0]);
        newSheet.getRange(2, 1, maxRows - 1, 6).setNumberFormats(formatMatrix);
      }
    } catch (fmtErr) {
      Logger.log("[ensureMonthSheet] Bỏ qua lỗi copy number formats: " + fmtErr);
    }
  }

  // 6. Tính ngày đầu tháng và ngày đầu tháng tiếp theo theo múi giờ Spreadsheet
  const yearStr = Utilities.formatDate(validDate, tz, "yyyy");
  const monthStr = Utilities.formatDate(validDate, tz, "MM");
  const startStr = `${yearStr}-${monthStr}-01`;

  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const nextYear = (month === 12) ? year + 1 : year;
  const nextMonth = (month === 12) ? 1 : month + 1;
  const nextMonthStr = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

  // 7. Ghi duy nhất 1 công thức QUERY tại A2 (sử dụng literal dates được tạo sẵn trong JS)
  const formula = buildMonthQueryFormula(startStr, nextMonthStr);
  newSheet.getRange("A2").setFormula(formula);

  // 8. Đặt ghi chú cảnh báo tại A2
  newSheet.getRange("A2").setNote("View only — edit in the master sheet");

  // 9. Thêm bảo vệ chỉ cảnh báo (warning-only protection)
  try {
    const protection = newSheet.protect().setDescription(`View only: ${tabName}`);
    protection.setWarningOnly(true);
  } catch (protectErr) {
    Logger.log("[ensureMonthSheet] Bỏ qua lỗi protect sheet: " + protectErr);
  }

  Logger.log(`[ensureMonthSheet] Đã tạo thành công tab tháng ${tabName} với công thức: ${formula}`);
  return newSheet;
}

/**
 * Chạy thủ công để tạo tất cả các tab tháng tương ứng với dữ liệu lịch sử trong sheet master.
 * Đọc trực tiếp cột A từ master sheet (không qua cache). Hàm hoàn toàn idempotent.
 *
 * @returns {{created: string[], existing: string[], total: number, tz: string}}
 */
function backfillMonthSheets() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const tz = getEffectiveSpreadsheetTimeZone(ss);
  Logger.log(`[backfillMonthSheets] Bắt đầu backfill. Múi giờ Spreadsheet: ${tz}`);

  const master = ss.getSheetByName(MASTER_SHEET_NAME);
  if (!master) {
    throw new Error(`Master sheet "${MASTER_SHEET_NAME}" không tồn tại.`);
  }

  const lastRow = master.getLastRow();
  if (lastRow <= 1) {
    Logger.log("[backfillMonthSheets] Master sheet không có dữ liệu giao dịch.");
    return { created: [], existing: [], total: 0, tz };
  }

  // Đọc trực tiếp cột A từ hàng 2 đến lastRow (không qua cache)
  const dateValues = master.getRange(2, 1, lastRow - 1, 1).getValues();
  const distinctMonths = new Set();
  const monthSampleDates = {};

  for (let i = 0; i < dateValues.length; i++) {
    const raw = dateValues[i][0];
    if (!raw) continue;
    const d = (raw instanceof Date) ? raw : new Date(raw);
    if (isNaN(d.getTime())) continue;

    const ym = Utilities.formatDate(d, tz, MONTH_SHEET_FORMAT);
    if (!distinctMonths.has(ym)) {
      distinctMonths.add(ym);
      monthSampleDates[ym] = d;
    }
  }

  const sortedMonths = Array.from(distinctMonths).sort();
  const created = [];
  const existing = [];

  for (const ym of sortedMonths) {
    if (ss.getSheetByName(ym)) {
      existing.push(ym);
    } else {
      ensureMonthSheet(monthSampleDates[ym]);
      created.push(ym);
    }
  }

  const summary = `[backfillMonthSheets] Hoàn thành. Đã tạo: ${created.length} (${created.join(", ") || "không có"}), Đã có từ trước: ${existing.length} (${existing.join(", ") || "không có"}). Tổng số tháng: ${sortedMonths.length}. Múi giờ: ${tz}`;
  Logger.log(summary);
  return { created, existing, total: sortedMonths.length, tz };
}

