
// =====================================================
// DAILY AUTOMATION JOBS
// =====================================================
// Mục 5 trong hướng dẫn tối ưu: nhắc thông minh — không nhắc nếu đã ghi hôm nay,
// và gợi ý theo pattern (mục 4) nếu hôm nay thường hay phát sinh 1 danh mục nào đó.
function hasTransactionToday() {
  const data = getAllTransactionsCached();
  if (data.length === 0) return false;
  const today = new Date();
  return data.some(r => {
    const d = new Date(r[0]);
    return d.getDate() === today.getDate() && d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear();
  });
}

function getPatternHintForDay(dayOfWeek) {
  const buckets = buildWeekdayBuckets();
  const todayPatterns = Object.entries(buckets)
    .filter(([key]) => key.startsWith(dayOfWeek + "|"))
    .filter(([, v]) => v.count >= 4)
    .map(([key, v]) => ({ cat: key.split("|")[1], avg: v.sum / v.count }));
  if (todayPatterns.length === 0) return "";
  const top = todayPatterns.sort((a, b) => b.avg - a.avg)[0];
  return `🔔 Bạn thường hay chi <b>${top.cat}</b> vào hôm nay, đừng quên ghi lại nhé!`;
}

function dailyReminderJob() {
  const dayOfWeek = new Date().getDay();
  let message;

  if (hasTransactionToday()) {
    message = "✅ Hôm nay bạn đã ghi giao dịch rồi, làm tốt lắm!";
  } else {
    message = "💡 Đến giờ ghi chi tiêu rồi đó!\nBạn đã thêm khoản chi/thu nào hôm nay chưa? 📝";
    const hint = getPatternHintForDay(dayOfWeek);
    if (hint) message += "\n\n" + hint;
  }

  // Gộp thêm cảnh báo nợ/hoá đơn sắp đến hạn, nếu có — chỉ 1 lệnh gọi Sheets, không tốn Gemini.
  const dueSoon = getDueSoonReport();
  if (!dueSoon.startsWith("✅")) {
    message += "\n\n" + dueSoon;
  }

  const buttons = [[{ text: "📊 Báo cáo hôm nay", callback_data: "/reportday" }, { text: "🧾 Ghi ngay", callback_data: "/start" }]];
  sendMessage(ADMIN_CHAT_ID, message, "HTML", buttons);
}

function dailyReportJob() {
  const report = getDayReport(new Date());
  sendMessage(ADMIN_CHAT_ID, "⏰ 21:00 – " + report, "HTML");
}

function setupTriggers() {
  const targetHandlers = ['dailyReminderJob', 'dailyReportJob'];
  const existingTriggers = ScriptApp.getProjectTriggers();

  // 1. Chỉ xoá các trigger thuộc 2 handler này để tránh nhân bản hoặc tích tụ trigger cũ
  existingTriggers.forEach(t => {
    if (targetHandlers.includes(t.getHandlerFunction())) {
      ScriptApp.deleteTrigger(t);
    }
  });

  const tz = Session.getScriptTimeZone();

  // 2. Tạo trigger cho dailyReminderJob với nearMinute(0) và chỉ định múi giờ tường minh
  ScriptApp.newTrigger('dailyReminderJob')
    .timeBased()
    .everyDays(1)
    .atHour(REMIND_HOUR)
    .nearMinute(0)
    .inTimezone(tz)
    .create();

  // 3. Tạo trigger cho dailyReportJob với nearMinute(0) và chỉ định múi giờ tường minh
  ScriptApp.newTrigger('dailyReportJob')
    .timeBased()
    .everyDays(1)
    .atHour(REPORT_HOUR)
    .nearMinute(0)
    .inTimezone(tz)
    .create();

  Logger.log(`Đã tạo lại trigger thành công [Múi giờ: ${tz}]:`);
  Logger.log(`- dailyReminderJob: cấu hình ${REMIND_HOUR}:00 (cửa sổ chạy: ${REMIND_HOUR - 1}:45 – ${REMIND_HOUR}:15)`);
  Logger.log(`- dailyReportJob: cấu hình ${REPORT_HOUR}:00 (cửa sổ chạy: ${REPORT_HOUR - 1}:45 – ${REPORT_HOUR}:15)`);
}

// Chạy tay hàm này trong Apps Script editor để kiểm tra nhắc nhở hoạt động ngay,
// không cần đợi tới đúng giờ trigger. Nếu tin nhắn tới được Telegram -> lỗi trước đó
// chắc chắn là do TRIGGER (chưa tạo / sai múi giờ), không phải do code gửi tin.
function testReminderNow() {
  dailyReminderJob();
  Logger.log("Đã gửi thử tin nhắc nhở tới ADMIN_CHAT_ID = " + ADMIN_CHAT_ID);
}

// Liệt kê trigger đang tồn tại + múi giờ project — chạy hàm này rồi xem log để chẩn đoán
function checkTriggersStatus() {
  const triggers = ScriptApp.getProjectTriggers();
  Logger.log("Múi giờ project: " + Session.getScriptTimeZone() + " (nên là Asia/Ho_Chi_Minh)");
  Logger.log("Số trigger đang có: " + triggers.length);
  triggers.forEach(t => Logger.log("- " + t.getHandlerFunction() + " (" + t.getEventType() + ")"));
  if (triggers.length === 0) {
    Logger.log("=> CHƯA CÓ TRIGGER NÀO. Chạy hàm setupTriggers() để tạo.");
  }
}
