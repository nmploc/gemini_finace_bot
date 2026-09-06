// =====================================================
// CONFIGURATION
// =====================================================
// Đọc từ Project Settings > Script Properties (không hardcode token/key trong code).
// Cách thêm: Apps Script > biểu tượng ⚙️ Project Settings > Script Properties > Add script property.
// Cần thêm đúng 4 property với TÊN CHÍNH XÁC (phân biệt hoa/thường) như bên dưới:
//   BOT_TOKEN, GEMINI_KEY, SHEET_ID, ADMIN_CHAT_ID
const props = PropertiesService.getScriptProperties();
const BOT_TOKEN      = props.getProperty('BOT_TOKEN');
const GEMINI_KEY     = props.getProperty('GEMINI_KEY');
const SHEET_ID       = props.getProperty('SHEET_ID');
const ADMIN_CHAT_ID  = props.getProperty('ADMIN_CHAT_ID');

const TG_API     = 'https://api.telegram.org/bot' + BOT_TOKEN;
const REMIND_HOUR = 20;
const REPORT_HOUR = 21;

// ĐÃ HẠ CẤP: dùng bản Flash ổn định (3.5) thay vì alias "gemini-flash-latest".
// Lý do: alias "-latest" từng tự động trỏ sang "gemini-3.7-flash" ngay lúc bản đó mới
// ra mắt và chưa đủ capacity, khiến toàn bộ request bị Google trả về lỗi 503 ServiceUnavailable
// hàng loạt (xác nhận qua Google AI Studio > Usage: Total API Errors toàn 503, đúng lúc
// Input/Output Tokens per model chuyển từ 3.5/3.6 Flash sang 3.7 Flash).
// Nếu muốn đổi bản, sửa TRỰC TIẾP ở đây (không dùng "-latest") để kiểm soát được thời điểm nâng cấp,
// tránh bị Google tự đẩy sang bản mới chưa ổn định.
const GEMINI_MODEL = 'gemini-3.5-flash';

// =====================================================
// GEMINI MODEL FALLBACK CHAIN (MỚI)
// =====================================================
// Thay vì chỉ hardcode 1 model duy nhất (rủi ro: nếu Google khai tử/giới hạn đúng model đó,
// toàn bộ bot ngừng hoạt động cho tới khi sửa code thủ công), giờ dùng 1 DÃY model theo thứ tự
// ưu tiên: model chính (mới hơn) trước, model dự phòng (cũ hơn, đã được chứng minh ổn định) sau.
// Khi model chính trả lỗi thuộc nhóm "model không dùng được" (xem MODEL_FALLBACK_CODES bên dưới),
// tự động lùi xuống thử model kế tiếp trong chain — không cần can thiệp thủ công.
//
// GEMINI_MODEL_FALLBACK có thể override qua Script Properties (không bắt buộc); nếu không đặt,
// mặc định dùng 'gemini-2.5-flash' — bản cũ hơn GEMINI_MODEL, xem như lựa chọn an toàn dự phòng.
// Có thể thêm nhiều bậc dự phòng hơn nữa bằng cách nối thêm phần tử vào mảng này.
const GEMINI_MODEL_CHAIN = [
  GEMINI_MODEL,
  props.getProperty('GEMINI_MODEL_FALLBACK') || 'gemini-2.5-flash',
];

function buildGeminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
}

// Giữ lại GEMINI_URL (model chính) để tương thích ngược nếu có chỗ khác trong dự án còn tham chiếu tới.
const GEMINI_URL = buildGeminiUrl(GEMINI_MODEL);

const VALID_CATEGORIES = ["Ăn uống", "Di chuyển", "Giải trí", "Hóa đơn", "Mua sắm", "Sức khỏe", "Khác"];
const PENDING_TTL_SECONDS = 300; // 5 phút chờ xác nhận trước khi tự huỷ

// Reply Keyboard cố định — chỉ là UI Telegram, KHÔNG gọi Gemini.
const MAIN_KEYBOARD = [
  ["💵 Số dư", "📊 Hôm nay", "📆 Tuần này", "🗓️ Tháng này"],
  ["🏷️ Theo danh mục", "📈 Top danh mục", "🏆 Top giao dịch"],
  ["📉 So sánh tháng", "🔮 Dự đoán", "❤️ Sức khoẻ TC"],
  ["💰 Ngân sách", "🎯 Mục tiêu", "📌 Nợ & Hoá đơn"],
  ["↩️ Xoá gần nhất", "📊 Biểu đồ"]
];

// Ánh xạ nhãn nút bấm -> lệnh slash tương ứng
const BUTTON_COMMAND_MAP = {
  "💵 Số dư": "/sodu",
  "📊 Hôm nay": "/reportday",
  "📆 Tuần này": "/reportweek",
  "🗓️ Tháng này": "/reportmonth",
  "🏷️ Theo danh mục": "/reportcategory",
  "📈 Top danh mục": "/topcategory",
  "🏆 Top giao dịch": "/top5",
  "📉 So sánh tháng": "/compare",
  "🔮 Dự đoán": "/forecast",
  "❤️ Sức khoẻ TC": "/score",
  "🎯 Mục tiêu": "/goals",
  "📌 Nợ & Hoá đơn": "/duesoon",
  "💰 Ngân sách": "/budget",
  "↩️ Xoá gần nhất": "/undo",
  "📊 Biểu đồ": "/chart"
};

// Một số emoji (🗓️ 🏷️ ↩️...) gồm 2 ký tự Unicode: ký tự gốc + "variation selector" ẩn
// (U+FE0E/U+FE0F) để quyết định hiển thị dạng chữ hay dạng màu. Tuỳ nền tảng, Telegram
// có thể gửi lại nút bấm THIẾU ký tự ẩn này, khiến so khớp chuỗi tuyệt đối bị trật.
// -> Luôn bỏ các ký tự ẩn này trước khi so khớp, ở cả 2 phía.
function normalizeButtonLabel(s) {
  return (s || "").replace(/[\uFE0E\uFE0F]/g, "").trim();
}

const BUTTON_COMMAND_MAP_NORMALIZED = {};
Object.keys(BUTTON_COMMAND_MAP).forEach(label => {
  BUTTON_COMMAND_MAP_NORMALIZED[normalizeButtonLabel(label)] = BUTTON_COMMAND_MAP[label];
});

// So khớp lệnh có ranh giới từ đúng. "command" trong doPost là TOÀN BỘ tin nhắn đã lowercase,
// không chỉ từ đầu tiên — nên "/goal Laptop 1tr 8" !== "/goal" theo kiểu so khớp tuyệt đối.
// Dùng hàm này cho MỌI lệnh có thể kèm tham số, để vừa nhận diện được lệnh trơn (không tham số)
// vừa không bị nhầm với lệnh khác có cùng tiền tố (vd "/goal" vs "/goals").
function isCommand(command, name) {
  return command === name || command.startsWith(name + " ");
}

// =====================================================
// DANH SÁCH ĐẦY ĐỦ TẤT CẢ LỆNH — dùng cho:
//  (1) đăng ký menu lệnh gốc của Telegram (gợi ý autocomplete khi gõ "/")
//  (2) gợi ý sửa khi gõ nhầm (vd "/star" -> "/start")
// =====================================================
const ALL_COMMANDS = [
  { command: "start", description: "Bắt đầu / xem hướng dẫn" },
  { command: "help", description: "Xem hướng dẫn sử dụng" },
  { command: "whoami", description: "Xem Chat ID" },
  { command: "report", description: "Báo cáo tổng hợp" },
  { command: "sodu", description: "Số dư hiện tại (cộng dồn toàn thời gian)" },
  { command: "reportday", description: "Báo cáo hôm nay (hoặc 1 ngày bất kỳ)", example: "/reportday 25/07" },
  { command: "reportweek", description: "Báo cáo tuần này" },
  { command: "reportmonth", description: "Báo cáo tháng này" },
  { command: "reportcategory", description: "Báo cáo theo danh mục" },
  { command: "topcategory", description: "Danh mục chi nhiều nhất tháng" },
  { command: "top5", description: "Top 5 giao dịch lớn nhất" },
  { command: "forecast", description: "Dự đoán chi tiêu & số dư cuối tháng" },
  { command: "trend", description: "Xu hướng chi tiêu 3 tháng gần nhất" },
  { command: "subscriptions", description: "Phát hiện chi tiêu định kỳ" },
  { command: "score", description: "Điểm sức khỏe tài chính" },
  { command: "patterns", description: "Thói quen chi tiêu theo ngày trong tuần" },
  { command: "savingtips", description: "Gợi ý tiết kiệm theo thói quen" },
  { command: "habits", description: "Thói quen đáng chú ý (chi khuya, cuối tuần)" },
  { command: "compare", description: "So sánh tháng này với tháng trước" },
  { command: "chart", description: "Biểu đồ chi tiêu theo danh mục" },
  { command: "search", description: "Tìm giao dịch (từ khoá hoặc số tiền)", example: "/search cà phê" },
  { command: "budget", description: "Xem hoặc đặt ngân sách theo danh mục", example: "/budget Ăn uống 1500000" },
  { command: "goal", description: "Tạo mục tiêu tiết kiệm mới", example: "/goal Laptop 35000000 8" },
  { command: "goals", description: "Xem tiến độ các mục tiêu tiết kiệm" },
  { command: "save", description: "Góp tiền vào 1 mục tiêu tiết kiệm", example: "/save Laptop 2000000" },
  { command: "debt", description: "Ghi khoản nợ (vay hoặc cho vay)", example: "/debt vay BanA 500000 25/07" },
  { command: "debts", description: "Xem các khoản nợ chưa xử lý" },
  { command: "bill", description: "Thêm hoá đơn định kỳ hằng tháng", example: "/bill Tiền điện 500000 25" },
  { command: "bills", description: "Xem danh sách hoá đơn định kỳ" },
  { command: "duesoon", description: "Xem khoản nợ/hoá đơn sắp đến hạn" },
  { command: "hoi", description: "Hỏi đáp tự do với AI về tài chính", example: "/hoi sao tháng này tiêu nhiều vậy?" },
  { command: "undo", description: "Chọn giao dịch gần đây để xoá" },
  { command: "delete", description: "Xoá nhanh giao dịch gần nhất" },
];

const VALID_COMMAND_WORDS = ALL_COMMANDS.map(c => "/" + c.command);

// Khoảng cách chỉnh sửa Levenshtein thuần JS — không phụ thuộc thư viện ngoài,
// chạy được cả trong Apps Script lẫn Node (dùng để test).
function levenshteinDistance(a, b) {
  const dp = [];
  for (let i = 0; i <= a.length; i++) dp.push([i]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// Tìm lệnh hợp lệ gần đúng nhất với 1 từ gõ sai. Ngưỡng co giãn theo độ dài
// (từ càng dài, cho phép sai nhiều ký tự hơn một chút), tối đa 3 ký tự khác biệt.
function findClosestCommand(word) {
  let best = null, bestDist = Infinity;
  VALID_COMMAND_WORDS.forEach(c => {
    const d = levenshteinDistance(word, c);
    if (d < bestDist) { bestDist = d; best = c; }
  });
  if (!best) return null;
  const threshold = Math.max(1, Math.min(3, Math.floor(best.length / 4) + 1));
  return bestDist > 0 && bestDist <= threshold ? best : null;
}

// Tính số byte UTF-8 của chuỗi — KHÔNG dùng Buffer (không tồn tại trong Apps Script).
// Dùng để kiểm tra giới hạn 64 byte của callback_data trong Telegram.
function utf8ByteLength(str) {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.codePointAt(i);
    if (code > 0xffff) i++; // ký tự thuộc surrogate pair, chiếm 2 vị trí trong str
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

// Đăng ký danh sách lệnh với Telegram — hiện gợi ý autocomplete khi người dùng gõ "/"
// trong ô nhập tin nhắn (menu native của Telegram, không cần code UI riêng).
function registerBotCommands() {
  const payloadCommands = ALL_COMMANDS.map(c => ({ command: c.command, description: c.description }));
  const res = UrlFetchApp.fetch(`${TG_API}/setMyCommands`, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ commands: payloadCommands }),
    muteHttpExceptions: true,
  });
  const ok = res.getResponseCode() === 200;
  if (!ok) Logger.log("setMyCommands lỗi: " + res.getContentText());
  return ok;
}

// =====================================================
// WEBHOOK ENTRY POINT
// =====================================================
function doPost(e) {
  try {
    // Kiểm tra thiếu cấu hình ngay từ đầu -> báo lỗi rõ ràng thay vì lỗi khó hiểu ở đâu đó bên dưới.
    const missing = ["BOT_TOKEN", "GEMINI_KEY", "SHEET_ID", "ADMIN_CHAT_ID"].filter(k => !props.getProperty(k));
    if (missing.length > 0) {
      Logger.log("Thiếu Script Properties: " + missing.join(", ") + ". Vào Project Settings > Script Properties để thêm.");
      return HtmlService.createHtmlOutput("missing_config");
    }

    const update = JSON.parse(e.postData.contents);

    if (update.callback_query) {
      return handleCallbackQuery(update.callback_query);
    }

    const msg = update.message;
    if (!msg || msg.from?.is_bot) return HtmlService.createHtmlOutput("ignored");

    const chatId = msg.chat.id;
    const rawText = msg.text?.trim();
    if (!rawText) return HtmlService.createHtmlOutput("no text");

    // LOG: ghi nhận MỌI tin nhắn đến từ Telegram ngay khi vào doPost, trước khi dispatch bất kỳ lệnh nào.
    // Giúp xác nhận request có thực sự tới Apps Script hay không khi debug qua Executions,
    // và biết chính xác người dùng nào (chatId) gửi nội dung gì.
    Logger.log(`[doPost] Nhận tin nhắn từ chatId=${chatId} (${msg.from?.first_name || "?"}): "${rawText}"`);

    // Nếu người dùng bấm nút trên Reply Keyboard, ánh xạ sang lệnh slash tương ứng.
    // So khớp qua bảng đã chuẩn hoá (bỏ ký tự ẩn trong emoji) để không bị trật do khác nền tảng.
    const normalizedRawText = normalizeButtonLabel(rawText);
    const isButtonPress = Object.prototype.hasOwnProperty.call(BUTTON_COMMAND_MAP_NORMALIZED, normalizedRawText);
    let command = isButtonPress ? BUTTON_COMMAND_MAP_NORMALIZED[normalizedRawText] : rawText.split('@')[0].toLowerCase();

    if (isButtonPress) {
      Logger.log(`[doPost] Nút bấm "${rawText}" -> ánh xạ lệnh "${command}"`);
    }

    // =====================================================
    // BASIC COMMANDS
    // =====================================================
    if (command === "/start" || command === "/help") {
      ensureSheet();
      ensureBudgetSheet();
      ensureGoalsSheet();
      ensureDebtsSheet();
      ensureBillsSheet();

      // Đăng ký menu lệnh gốc của Telegram 1 lần duy nhất — sau đó gõ "/" trong ô nhập tin nhắn
      // sẽ tự hiện gợi ý autocomplete toàn bộ lệnh kèm mô tả, không cần gọi lại mỗi lần /start.
      if (!props.getProperty("COMMANDS_REGISTERED")) {
        if (registerBotCommands()) props.setProperty("COMMANDS_REGISTERED", "true");
      }

      const helpText =
        "👋 Xin chào *" + (msg.from.first_name || "bạn") + "!*\n\n" +
        "Tôi là **Bot Chi Tiêu Gemini** 💰 – trợ lý tài chính cá nhân của bạn.\n\n" +
        "📘 Gõ tự nhiên:\n" +
        "• `ăn sáng 35k`\n• `mua cà phê 25k`\n• `nhận lương 10 triệu`\n\n" +
        "Tôi sẽ hỏi xác nhận trước khi ghi vào sổ.\n\n" +
        "📊 Lệnh nhanh (hoặc dùng nút bên dưới):\n" +
        "• `/sodu` – Số dư hiện tại (cộng dồn từ trước đến nay, không reset theo tháng)\n" +
        "• `/report`, `/reportday [ngày]`, `/reportweek`, `/reportmonth`\n" +
        "  (vd `/reportday 25/07` để xem lại 1 ngày bất kỳ, liệt kê từng giao dịch)\n" +
        "• `/reportcategory`, `/topcategory`, `/top5` – Top giao dịch lớn nhất\n" +
        "• `/compare` – So sánh tháng này với tháng trước (kèm theo danh mục)\n" +
        "• `/forecast` – Dự đoán chi tiêu & số dư cuối tháng\n" +
        "• `/trend` – Xu hướng chi tiêu 3 tháng gần nhất\n" +
        "• `/subscriptions` – Phát hiện chi tiêu định kỳ\n" +
        "• `/patterns` – Thói quen chi tiêu theo ngày trong tuần\n" +
        "• `/savingtips` – Gợi ý tiết kiệm dựa trên thói quen\n" +
        "• `/habits` – Thói quen đáng chú ý (chi khuya, cuối tuần)\n" +
        "• `/score` – Điểm sức khỏe tài chính (kèm gợi ý quỹ khẩn cấp)\n" +
        "• `/chart` – Biểu đồ chi tiêu theo danh mục\n" +
        "• `/search <từ khoá>` hoặc `/search >500k`, `/search 100k-300k`\n" +
        "• `/budget` hoặc `/budget <danh mục> <số tiền>` – Ngân sách\n" +
        "• `/goal <tên> <số tiền> <số tháng>` – Tạo mục tiêu tiết kiệm\n" +
        "• `/save <tên mục tiêu> <số tiền>` – Góp tiền vào mục tiêu\n" +
        "• `/goals` – Xem tiến độ các mục tiêu\n" +
        "• `/debt vay <tên> <số tiền> <hạn dd/mm>` – Ghi khoản tôi nợ\n" +
        "• `/debt chovay <tên> <số tiền> <hạn dd/mm>` – Ghi khoản người khác nợ tôi\n" +
        "• `/debts` – Xem các khoản nợ chưa trả/thu\n" +
        "• `/bill <tên> <số tiền> <ngày trong tháng>` – Thêm hoá đơn định kỳ\n" +
        "• `/bills` – Xem danh sách hoá đơn định kỳ\n" +
        "• `/duesoon` – Xem khoản sắp đến hạn (nợ + hoá đơn)\n" +
        "• `/hoi <câu hỏi>` – Hỏi đáp tự do, vd `/hoi sao tháng này tiêu nhiều vậy?`\n" +
        "• `/undo` – Chọn giao dịch gần đây để xoá\n" +
        "• `/delete` – Xoá nhanh giao dịch gần nhất (không cần chọn)\n" +
        "• `/whoami` – Xem Chat ID\n\n" +
        "⏰ Nhắc ghi chi tiêu lúc " + REMIND_HOUR + ":00 (kèm khoản sắp đến hạn nếu có), báo cáo lúc " + REPORT_HOUR + ":00 mỗi ngày.";
      sendMessage(chatId, helpText, "Markdown", null, MAIN_KEYBOARD);
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/whoami") {
      sendMessage(chatId, `🪪 Chat ID của bạn là: <code>${chatId}</code>`, "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (["/report", "/reportweek", "/reportmonth", "/reportcategory", "/topcategory"].includes(command)) {
      if (command === "/reportcategory") {
        sendMessage(chatId, getCategoryReport(), "HTML");
        return HtmlService.createHtmlOutput("ok");
      }
      if (command === "/topcategory") {
        sendMessage(chatId, getTopCategoryReport(), "HTML");
        return HtmlService.createHtmlOutput("ok");
      }
      if (command === "/reportweek") {
        sendMessage(chatId, getWeekReport(), "HTML");
        return HtmlService.createHtmlOutput("ok");
      }
      const mode = command === "/reportmonth" ? "month" : "all";
      sendMessage(chatId, getFinanceReport(mode), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    // /reportday có thể kèm tham số ngày: "/reportday" (hôm nay), "/reportday 25/07" (năm hiện tại),
    // "/reportday 25/07/2025" (năm chỉ định). Tách riêng vì cần đọc tham số, không dùng exact-match.
    if (isCommand(command, "/reportday")) {
      const args = isButtonPress ? "" : rawText.replace(/^\/reportday(@\w+)?\s*/i, "").trim();
      let targetDate = new Date();
      if (args) {
        const parsed = parseSimpleDate(args);
        if (!parsed) {
          sendMessage(chatId, "ℹ️ Ngày không hợp lệ. Dùng: <code>/reportday 25/07</code> hoặc <code>/reportday 25/07/2025</code>", "HTML");
          return HtmlService.createHtmlOutput("ok");
        }
        targetDate = parsed;
      }
      sendMessage(chatId, getDayReport(targetDate), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/top5") {
      sendMessage(chatId, getTop5Report(), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/forecast") {
      sendMessage(chatId, getForecastReport(), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/trend") {
      sendMessage(chatId, getTrendReport(), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/subscriptions") {
      sendMessage(chatId, getSubscriptionsReport(), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/sodu") {
      sendMessage(chatId, getBalanceReport(), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/score") {
      sendMessage(chatId, getFinancialHealthScore(), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/patterns") {
      sendMessage(chatId, getWeekdayPatternReport(), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/savingtips") {
      sendMessage(chatId, getBehaviorSavingTips(), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/habits") {
      sendMessage(chatId, getBadHabitReport(), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/compare") {
      sendMessage(chatId, getCompareReport(), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/chart") {
      sendCategoryChart(chatId);
      return HtmlService.createHtmlOutput("ok");
    }

    if (command.startsWith("/search")) {
      // Nếu đến từ nút bấm thì chắc chắn không có tham số kèm theo — không cố cắt chuỗi nút bấm.
      const keyword = isButtonPress ? "" : rawText.replace(/^\/search(@\w+)?\s*/i, "").trim();
      sendMessage(chatId, searchTransactions(keyword), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command.startsWith("/budget")) {
      const args = isButtonPress ? "" : rawText.replace(/^\/budget(@\w+)?\s*/i, "").trim();
      sendMessage(chatId, handleBudgetCommand(args), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    // =====================================================
    // NHÓM D — Mục tiêu tiết kiệm / Nợ & khoản phải trả / Hoá đơn định kỳ
    // =====================================================
    // LƯU Ý: dùng isCommand() (so khớp tiền tố có ranh giới từ) thay vì === cho các lệnh
    // có tham số, vì "command" ở đây là TOÀN BỘ câu đã lowercase, không chỉ từ đầu tiên.
    // Dùng === sẽ luôn FALSE khi có tham số theo sau (bug đã phát hiện và sửa ở đây).
    if (isCommand(command, "/goal")) {
      const args = isButtonPress ? "" : rawText.replace(/^\/goal(@\w+)?\s*/i, "").trim();
      sendMessage(chatId, handleGoalCommand(args), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/goals") {
      sendMessage(chatId, getGoalsReport(), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (isCommand(command, "/save")) {
      const args = isButtonPress ? "" : rawText.replace(/^\/save(@\w+)?\s*/i, "").trim();
      sendMessage(chatId, handleSaveContributionCommand(args), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (isCommand(command, "/debt")) {
      const args = isButtonPress ? "" : rawText.replace(/^\/debt(@\w+)?\s*/i, "").trim();
      sendMessage(chatId, handleDebtCommand(args), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/debts") {
      sendDebtsList(chatId);
      return HtmlService.createHtmlOutput("ok");
    }

    if (isCommand(command, "/bill")) {
      const args = isButtonPress ? "" : rawText.replace(/^\/bill(@\w+)?\s*/i, "").trim();
      sendMessage(chatId, handleBillCommand(args), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/bills") {
      sendMessage(chatId, getBillsReport(), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (command === "/duesoon") {
      sendMessage(chatId, getDueSoonReport(), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    if (isCommand(command, "/hoi")) {
      const question = isButtonPress ? "" : rawText.replace(/^\/hoi(@\w+)?\s*/i, "").trim();
      sendMessage(chatId, handleHoiCommand(question), "HTML");
      return HtmlService.createHtmlOutput("ok");
    }

    // =====================================================
    // UNDO — chọn giao dịch trong 5 giao dịch gần nhất
    // =====================================================
    if (command === "/undo") {
      const list = getRecentTransactions(5);
      if (list.length === 0) {
        sendMessage(chatId, "⚠️ Không có giao dịch nào để xoá.");
        return HtmlService.createHtmlOutput("ok");
      }
      const buttons = list.map(t => ([{
        text: `🗑 ${t.type === "chi" ? "Chi" : "Thu"} ${t.amount.toLocaleString()}đ - ${t.note || t.category}`,
        callback_data: `undo_pick_${t.row}`
      }]));
      sendMessage(chatId, "❗ Chọn giao dịch muốn xoá:", "HTML", buttons);
      return HtmlService.createHtmlOutput("ok");
    }

    // /delete — xoá nhanh giao dịch cuối cùng ngay (trước đây tên là /confirm, đã đổi tên cho rõ nghĩa)
    if (command === "/delete") {
      const list = getRecentTransactions(1);
      if (list.length === 0) {
        sendMessage(chatId, "⚠️ Không có gì để xoá.");
      } else {
        const ok = deleteTransactionRow(list[0].row);
        sendMessage(chatId, ok ? "✅ Đã xoá giao dịch gần nhất!" : "⚠️ Xoá thất bại, thử lại bằng /undo.");
      }
      return HtmlService.createHtmlOutput("ok");
    }

    // =====================================================
    // GỢI Ý SỬA LỆNH GÕ NHẦM — vd "/star" -> gợi ý "/start"
    // Không tốn Gemini: chỉ so khớp chuỗi thuần (Levenshtein), và CHỈ áp dụng khi
    // tin nhắn rõ ràng bắt đầu bằng "/" nhưng không khớp bất kỳ lệnh nào ở trên.
    // =====================================================
    if (!isButtonPress && rawText.startsWith("/")) {
      const firstWord = rawText.split(/\s+/)[0].toLowerCase();
      const suggestion = findClosestCommand(firstWord);
      if (suggestion && suggestion !== firstWord) {
        const restOfText = rawText.slice(firstWord.length).trim();
        const correctedFull = restOfText ? `${suggestion} ${restOfText}` : suggestion;
        // Giới hạn độ dài để vừa callback_data (Telegram giới hạn 64 byte, tiếng Việt có dấu
        // chiếm nhiều byte hơn 1 ký tự) — nếu quá dài thì chỉ gợi ý bằng chữ, không có nút bấm.
        if (utf8ByteLength("typo_fix:" + correctedFull) <= 64) {
          sendMessage(chatId, `❓ Có phải bạn muốn dùng <code>${suggestion}</code> không?`, "HTML",
            [[{ text: `✅ Dùng ${suggestion}`, callback_data: `typo_fix:${correctedFull}` }]]);
        } else {
          sendMessage(chatId, `❓ Có phải bạn muốn dùng <code>${suggestion}</code>? Gõ lại đầy đủ giúp mình nhé.`, "HTML");
        }
        return HtmlService.createHtmlOutput("typo_suggested");
      }
    }

    // =====================================================
    // AI-BASED TRANSACTION PARSING (GEMINI) — CÓ XÁC NHẬN TRƯỚC KHI GHI
    // =====================================================
    // Trích ngày/giờ tuỳ chỉnh bằng regex thuần (không gọi AI, không tốn quota).
    // Nếu người dùng không ghi ngày/giờ, customDate = null -> mặc định dùng thời điểm lưu (như cũ).
    const { date: customDate, cleanedText } = parseDateTimeFromText(rawText);

    Logger.log(`[doPost] Không khớp lệnh nào -> gửi Gemini để phân tích giao dịch: "${cleanedText || rawText}"`);
    const result = parseAndReactWithGemini(cleanedText || rawText, msg.from.first_name || "Người dùng");

    if (!result.ok) {
      // Lỗi kỹ thuật (API/mạng) — KHÔNG đổ lỗi cho câu người dùng gõ, tránh gây hiểu lầm.
      Logger.log(`[doPost] Gemini parse thất bại (reason=${result.reason}) -> báo lỗi cho chatId=${chatId}`);
      sendMessage(chatId, "⚠️ Bot đang gặp sự cố kết nối tới Gemini, thử lại sau ít phút nhé.\nNếu lặp lại nhiều lần, kiểm tra mục Executions trong Apps Script để xem chi tiết lỗi.");
      return HtmlService.createHtmlOutput("api_error");
    }
    if (!result.isTransaction) {
      sendMessage(chatId, "🤔 Tôi chưa hiểu rõ giao dịch này, bạn thử diễn đạt khác nhé?");
      return HtmlService.createHtmlOutput("unclear");
    }

    const parsed = result.data;
    parsed.user = msg.from.first_name || "User";
    parsed.txDate = customDate ? customDate.toISOString() : null;
    CacheService.getScriptCache().put("pending_" + chatId, JSON.stringify(parsed), PENDING_TTL_SECONDS);

    // Mục 2: AI hỏi ngược khi không chắc — hỏi thẳng danh mục trước khi hiện preview xác nhận thường.
    if (parsed.confidence === "low") {
      sendCategoryPicker(chatId, `❓ Khoản <b>${parsed.amount.toLocaleString()}đ</b> này thuộc danh mục nào? (mình chưa chắc lắm)`);
      return HtmlService.createHtmlOutput("ok");
    }

    sendTransactionPreview(chatId, parsed);
    return HtmlService.createHtmlOutput("ok");

  } catch (err) {
    Logger.log("Error: " + err + "\n" + err.stack);
    try { sendMessage(ADMIN_CHAT_ID, "🚨 Bot error: " + err); } catch (_) {}
    return HtmlService.createHtmlOutput("error");
  }
}

// =====================================================
// CALLBACK QUERY
// =====================================================
// Dùng chung cho: preview lần đầu, sau khi bấm "Sửa DM", và sau khi chọn danh mục từ hỏi ngược confidence thấp.
function sendTransactionPreview(chatId, parsed) {
  const customDate = parsed.txDate ? new Date(parsed.txDate) : null;
  const dateLine = customDate ? `📅 Thời gian: <b>${formatDateTimeVN(customDate)}</b>\n` : "";
  const preview =
    `❓ <b>Xác nhận giao dịch:</b>\n` +
    dateLine +
    `💸 ${parsed.type} ${parsed.amount.toLocaleString()}đ — ${parsed.note || ""}\n` +
    `🏷️ Danh mục: <b>${parsed.category || "Khác"}</b>\n\n` +
    `${parsed.reaction || ""}`;
  const confirmButtons = [
    [
      { text: "✅ Lưu", callback_data: "confirm_save" },
      { text: "✏️ Sửa DM", callback_data: "confirm_edit_cat" }
    ],
    [{ text: "❌ Huỷ", callback_data: "confirm_cancel" }]
  ];
  sendMessage(chatId, preview, "HTML", confirmButtons);
}

// Hiện bàn phím chọn 1 trong các VALID_CATEGORIES — dùng cho cả nút "Sửa DM" và hỏi ngược confidence thấp.
function sendCategoryPicker(chatId, promptText) {
  const catButtons = VALID_CATEGORIES.map(c => ([{ text: c, callback_data: `set_cat_${c}` }]));
  catButtons.push([{ text: "❌ Huỷ", callback_data: "confirm_cancel" }]); // tái dùng callback Huỷ có sẵn
  sendMessage(chatId, promptText, "HTML", catButtons);
}

function handleCallbackQuery(cq) {
  const chatId = cq.message.chat.id;
  const data = cq.data;

  // LOG: ghi nhận mọi lượt bấm nút inline đến từ Telegram, trước khi xử lý — giúp debug
  // khi 1 luồng xác nhận/xoá không hoạt động như mong đợi.
  Logger.log(`[handleCallbackQuery] chatId=${chatId} (${cq.from?.first_name || "?"}) bấm callback_data="${data}"`);

  UrlFetchApp.fetch(`${TG_API}/answerCallbackQuery`, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ callback_query_id: cq.id }),
    muteHttpExceptions: true,
  });

  if (data === "/reportday") {
    sendMessage(chatId, getDayReport(new Date()), "HTML");
  } else if (data === "/start") {
    sendMessage(chatId, "✍️ Gõ tự nhiên khoản chi/thu của bạn, ví dụ: `ăn trưa 40k`", "Markdown");

  } else if (data.startsWith("typo_fix:")) {
    // Người dùng xác nhận dùng lệnh đã gợi ý -> giả lập 1 tin nhắn mới với text đã sửa
    // và chạy lại toàn bộ doPost, tái sử dụng nguyên vẹn logic dispatch có sẵn.
    const correctedText = data.replace("typo_fix:", "");
    const fakeUpdate = { message: { chat: { id: chatId }, from: { first_name: cq.from?.first_name || "User" }, text: correctedText } };
    return doPost({ postData: { contents: JSON.stringify(fakeUpdate) } });

  } else if (data === "confirm_save") {
    const cache = CacheService.getScriptCache();
    const raw = cache.get("pending_" + chatId);
    if (!raw) {
      sendMessage(chatId, "⌛ Giao dịch đã hết hạn xác nhận (quá 5 phút), bạn gõ lại nhé.");
      return HtmlService.createHtmlOutput("ok");
    }
    const parsed = JSON.parse(raw);
    const whenDate = parsed.txDate ? new Date(parsed.txDate) : new Date();

    // Kiểm tra bất thường DỰA TRÊN dữ liệu cũ (trước khi thêm giao dịch mới vào Sheet)
    const anomalyAlert = parsed.type === "chi" ? checkAnomalyAlert(parsed.category, parsed.amount) : null;

    appendToSheet(parsed, parsed.user || "User", whenDate);
    cache.remove("pending_" + chatId);

    let msgText = `✅ Đã ghi: <b>${parsed.type}</b> ${parsed.amount.toLocaleString()}đ — ${parsed.note || ""}\n🏷️ Danh mục: <b>${parsed.category || "Khác"}</b>`;
    if (parsed.txDate) {
      msgText += `\n📅 Thời gian: ${formatDateTimeVN(whenDate)}`;
    }
    if (anomalyAlert) msgText += "\n\n" + anomalyAlert;
    if (parsed.type === "chi") {
      const alert = checkBudgetAlert(parsed.category);
      if (alert) msgText += "\n\n" + alert;
    }
    sendMessage(chatId, msgText, "HTML");

  } else if (data === "confirm_cancel") {
    CacheService.getScriptCache().remove("pending_" + chatId);
    sendMessage(chatId, "❌ Đã huỷ. Bạn có thể gõ lại giao dịch với nội dung khác.");

  } else if (data === "confirm_edit_cat") {
    const raw = CacheService.getScriptCache().get("pending_" + chatId);
    if (!raw) {
      sendMessage(chatId, "⌛ Giao dịch đã hết hạn xác nhận (quá 5 phút), bạn gõ lại nhé.");
      return HtmlService.createHtmlOutput("ok");
    }
    sendCategoryPicker(chatId, "✏️ Chọn danh mục đúng:");

  } else if (data.startsWith("set_cat_")) {
    const newCat = data.replace("set_cat_", "");
    if (!VALID_CATEGORIES.includes(newCat)) {
      sendMessage(chatId, "⚠️ Danh mục không hợp lệ.");
      return HtmlService.createHtmlOutput("ok");
    }
    const cache = CacheService.getScriptCache();
    const raw = cache.get("pending_" + chatId);
    if (!raw) {
      sendMessage(chatId, "⌛ Giao dịch đã hết hạn xác nhận (quá 5 phút), bạn gõ lại nhé.");
      return HtmlService.createHtmlOutput("ok");
    }
    const parsed = JSON.parse(raw);
    parsed.category = newCat;
    cache.put("pending_" + chatId, JSON.stringify(parsed), PENDING_TTL_SECONDS);
    sendTransactionPreview(chatId, parsed);

  } else if (data.startsWith("undo_pick_")) {
    const row = Number(data.replace("undo_pick_", ""));
    const t = getTransactionByRow(row);
    if (!t) {
      sendMessage(chatId, "⚠️ Giao dịch không còn tồn tại (có thể đã bị xoá).");
      return HtmlService.createHtmlOutput("ok");
    }
    const confirmText =
      `❗ <b>Xác nhận xoá:</b>\n📅 ${t.date}\n💬 ${t.note}\n💸 ${t.type} ${t.amount.toLocaleString()}đ (${t.category || "Chưa phân loại"})`;
    const buttons = [[
      { text: "🗑 Xác nhận xoá", callback_data: `undo_confirm_${row}` },
      { text: "◀️ Huỷ", callback_data: "undo_cancel" }
    ]];
    sendMessage(chatId, confirmText, "HTML", buttons);

  } else if (data.startsWith("undo_confirm_")) {
    const row = Number(data.replace("undo_confirm_", ""));
    const ok = deleteTransactionRow(row);
    sendMessage(chatId, ok ? "✅ Đã xoá giao dịch!" : "⚠️ Xoá thất bại (dữ liệu có thể đã thay đổi), thử /undo lại.");

  } else if (data === "undo_cancel") {
    sendMessage(chatId, "◀️ Đã huỷ thao tác xoá.");

  } else if (data.startsWith("debt_paid_")) {
    const row = Number(data.replace("debt_paid_", ""));
    const ok = markDebtPaid(row);
    sendMessage(chatId, ok ? "✅ Đã đánh dấu hoàn tất!" : "⚠️ Không tìm thấy khoản này (có thể đã được xử lý trước đó).");
  }

  return HtmlService.createHtmlOutput("ok");
}

// =====================================================
// TRÍCH NGÀY/GIỜ TỪ CÂU NHẬP (regex thuần — KHÔNG gọi AI, không tốn quota Gemini)
// =====================================================
// Hỗ trợ: "ngày 16/07/26", "16/7/2026", "16-07-26" (năm 2 hoặc 4 số)
//         "lúc 12:00", "12:00", "12h30", "12h"
// Nếu chỉ có ngày (không giờ) -> giữ giờ hiện tại. Nếu chỉ có giờ -> giữ ngày hôm nay.
// Nếu không tìm thấy gì hợp lệ -> trả về null (nơi gọi sẽ mặc định dùng thời điểm hiện tại).
function parseDateTimeFromText(text) {
  if (!text) return { date: null, cleanedText: text };

  let cleaned = text;
  let day, month, year, hour = null, minute = null;

  const dateRegex = /(?:ngày\s+)?\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/i;
  const dateMatch = cleaned.match(dateRegex);
  if (dateMatch) {
    day = parseInt(dateMatch[1], 10);
    month = parseInt(dateMatch[2], 10);
    year = parseInt(dateMatch[3], 10);
    if (year < 100) year += 2000;
    cleaned = cleaned.replace(dateMatch[0], " ");
  }

  const timeRegex = /(?:lúc\s+)?\b(\d{1,2})(?::([0-5]\d)|[hH]([0-5]\d)?)\b/;
  const timeMatch = cleaned.match(timeRegex);
  if (timeMatch) {
    hour = parseInt(timeMatch[1], 10);
    minute = timeMatch[2] !== undefined ? parseInt(timeMatch[2], 10)
      : (timeMatch[3] !== undefined ? parseInt(timeMatch[3], 10) : 0);
    cleaned = cleaned.replace(timeMatch[0], " ");
  }

  cleaned = cleaned.replace(/\s+/g, " ").trim();

  if (day === undefined && hour === null) {
    return { date: null, cleanedText: text }; // không có ngày/giờ nào -> giữ nguyên văn gốc
  }

  const now = new Date();
  const finalYear  = day !== undefined ? year : now.getFullYear();
  const finalMonth = day !== undefined ? month - 1 : now.getMonth();
  const finalDay   = day !== undefined ? day : now.getDate();
  const finalHour  = hour !== null ? hour : now.getHours();
  const finalMinute = minute !== null ? minute : now.getMinutes();

  if (finalMonth < 0 || finalMonth > 11 || finalDay < 1 || finalDay > 31 || finalHour > 23 || finalMinute > 59) {
    return { date: null, cleanedText: text }; // giá trị vô lý -> bỏ qua, coi như không có
  }

  const result = new Date(finalYear, finalMonth, finalDay, finalHour, finalMinute, 0);
  // Chặn ngày không tồn tại thật (vd 31/02) — JS Date tự "tràn" sang tháng sau, ta phát hiện và huỷ.
  if (result.getMonth() !== finalMonth || result.getDate() !== finalDay) {
    return { date: null, cleanedText: text };
  }

  return { date: result, cleanedText: cleaned };
}

function formatDateTimeVN(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// =====================================================
// GEMINI HTTP RETRY WRAPPER
// =====================================================
// Bọc UrlFetchApp.fetch riêng cho Gemini: chỉ retry khi gặp lỗi 503 ServiceUnavailable
// (model đang quá tải tạm thời phía Google) hoặc 429 (rate limit tạm thời) — KHÔNG retry
// các lỗi khác (400/401/404...) vì đó là lỗi cấu hình/model không tồn tại, retry cùng model
// sẽ không giải quyết được gì và chỉ tốn thời gian (404/400 được xử lý ở lớp fallback model,
// xem fetchGeminiWithModelFallback bên dưới).
// Dùng backoff tăng dần (1s, 2s...) để tránh dội thêm tải vào lúc server đang quá tải.
function fetchGeminiWithRetry(url, options, maxRetries = 2) {
  let lastRes = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    lastRes = res;

    if (code !== 503 && code !== 429) {
      if (attempt > 0) {
        Logger.log(`[fetchGeminiWithRetry] Thành công sau ${attempt} lần retry (HTTP ${code}).`);
      }
      return res; // không phải lỗi tạm thời -> trả về ngay (thành công hoặc lỗi khác không nên retry)
    }

    if (attempt < maxRetries) {
      const waitMs = 1000 * (attempt + 1); // 1s, rồi 2s
      Logger.log(`[fetchGeminiWithRetry] HTTP ${code} (quá tải/rate limit), thử lại lần ${attempt + 1}/${maxRetries} sau ${waitMs}ms...`);
      Utilities.sleep(waitMs);
    } else {
      Logger.log(`[fetchGeminiWithRetry] Vẫn HTTP ${code} sau ${maxRetries} lần retry, trả về lỗi cho nơi gọi.`);
    }
  }
  return lastRes;
}

// =====================================================
// GEMINI MODEL FALLBACK WRAPPER (MỚI)
// =====================================================
// Gọi Gemini qua toàn bộ GEMINI_MODEL_CHAIN, theo thứ tự ưu tiên: model chính trước, model dự
// phòng (cũ hơn, ổn định hơn) sau. Với MỖI model, vẫn áp dụng retry 503/429 của
// fetchGeminiWithRetry ở trên trước khi coi model đó là "không dùng được" và chuyển sang model
// kế tiếp trong chain.
//
// Chỉ fallback sang model khác khi lỗi thuộc nhóm "bản thân model này không dùng được":
//   404 — model bị đổi tên/khai tử/không tồn tại với API key hiện tại
//   429 — vượt hạn mức riêng của model đó (dù đã retry ở lớp trong vẫn còn 429)
//   503 — model quá tải kéo dài (dù đã retry ở lớp trong vẫn còn 503)
// KHÔNG fallback với 400 (payload/schema sai) hay 401/403 (API key sai/không có quyền) vì đây là
// lỗi cấu hình chung, đổi sang model khác cũng sẽ lỗi y hệt — chỉ tổ tốn thêm 1 lượt gọi vô ích.
const MODEL_FALLBACK_CODES = [404, 429, 503];

function buildGeminiPayloadOptions(payload) {
  return {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
}

// Trả về { res, modelUsed }. Nơi gọi dùng res như bình thường (getResponseCode/getContentText),
// và có thể log/hiển thị modelUsed nếu muốn biết có đang chạy bằng model dự phòng hay không.
function fetchGeminiWithModelFallback(payload) {
  const options = buildGeminiPayloadOptions(payload);
  let lastRes = null;

  for (let i = 0; i < GEMINI_MODEL_CHAIN.length; i++) {
    const model = GEMINI_MODEL_CHAIN[i];
    const url = buildGeminiUrl(model);
    const res = fetchGeminiWithRetry(url, options);
    const code = res.getResponseCode();
    lastRes = res;

    if (code === 200) {
      if (i > 0) {
        Logger.log(`[fetchGeminiWithModelFallback] Model chính "${GEMINI_MODEL_CHAIN[0]}" không dùng được, đã fallback THÀNH CÔNG sang "${model}".`);
      }
      return { res, modelUsed: model };
    }

    const isLastModel = i === GEMINI_MODEL_CHAIN.length - 1;
    if (MODEL_FALLBACK_CODES.includes(code) && !isLastModel) {
      Logger.log(`[fetchGeminiWithModelFallback] Model "${model}" lỗi HTTP ${code} (model không dùng được) -> thử model dự phòng kế tiếp trong chain...`);
      continue;
    }

    // Lỗi không thuộc diện fallback (vd 400/401) HOẶC đã hết model trong chain -> dừng lại,
    // trả lỗi cuối cùng để nơi gọi xử lý như cũ (báo lỗi kỹ thuật cho người dùng).
    if (!MODEL_FALLBACK_CODES.includes(code)) {
      Logger.log(`[fetchGeminiWithModelFallback] Model "${model}" lỗi HTTP ${code} (không thuộc diện fallback) -> dừng lại, không thử model khác.`);
    } else {
      Logger.log(`[fetchGeminiWithModelFallback] Đã thử hết ${GEMINI_MODEL_CHAIN.length} model trong chain, vẫn lỗi HTTP ${code}.`);
    }
    return { res, modelUsed: model };
  }

  return { res: lastRes, modelUsed: GEMINI_MODEL_CHAIN[GEMINI_MODEL_CHAIN.length - 1] };
}

// =====================================================
// GEMINI PARSER HANDLER
// =====================================================
// Trả về { ok, isTransaction, data, reason }.
//   ok=false        -> lỗi kỹ thuật (API lỗi/mạng lỗi/response dị dạng, đã thử hết model trong chain)
//                       — KHÔNG phải lỗi của câu người dùng gõ.
//   ok=true, isTransaction=false -> Gemini hiểu prompt nhưng xác định câu này không phải giao dịch thu/chi.
//   ok=true, isTransaction=true  -> parse thành công, data chứa giao dịch.
function parseAndReactWithGemini(text, userName) {
  try {
    const prompt = `
Bạn là trợ lý tài chính cá nhân thân thiện, có khả năng phân loại chi tiêu.
Phân tích câu người dùng nhập về chi tiêu hoặc thu nhập.
Câu của người dùng: "${text}"
Tên người dùng: "${userName}"
Nếu câu không liên quan đến thu/chi tiền, hãy trả amount = 0.
Nếu không chắc chắn về danh mục (câu mơ hồ, có thể thuộc nhiều nhóm khác nhau), hãy trả confidence="low".
Nếu chắc chắn về danh mục, trả confidence="high".
`;
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            type: { type: "STRING", enum: ["thu", "chi"] },
            amount: { type: "NUMBER" },
            note: { type: "STRING" },
            category: { type: "STRING", enum: VALID_CATEGORIES },
            confidence: { type: "STRING", enum: ["high", "low"] },
            reaction: { type: "STRING" }
          },
          required: ["type", "amount", "confidence"]
        }
      }
    };

    Logger.log(`[parseAndReactWithGemini] Gửi request (chain: ${GEMINI_MODEL_CHAIN.join(" -> ")}) cho câu: "${text}"`);

    const { res, modelUsed } = fetchGeminiWithModelFallback(payload);

    const code = res.getResponseCode();
    const bodyText = res.getContentText();

    if (code !== 200) {
      // Lỗi phổ biến: 429 (vượt hạn mức free tier tạm thời), 404 (model bị đổi tên/khai tử),
      // 400 (payload sai), 503 (Google quá tải) — đã thử fallback qua toàn bộ GEMINI_MODEL_CHAIN
      // ở fetchGeminiWithModelFallback nhưng vẫn lỗi. Log đầy đủ để xem trong Apps Script > Executions.
      Logger.log("[parseAndReactWithGemini] Gemini HTTP " + code + " (model=" + modelUsed + "): " + bodyText);
      return { ok: false, reason: "http_" + code };
    }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch (e) {
      Logger.log("[parseAndReactWithGemini] Gemini trả về không phải JSON hợp lệ: " + bodyText);
      return { ok: false, reason: "invalid_json" };
    }

    // Gemini có thể chặn prompt vì bộ lọc an toàn — không phải model "không hiểu" mà là bị chặn.
    if (data.promptFeedback && data.promptFeedback.blockReason) {
      Logger.log("[parseAndReactWithGemini] Gemini chặn prompt: " + JSON.stringify(data.promptFeedback));
      return { ok: false, reason: "blocked" };
    }

    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
      Logger.log("[parseAndReactWithGemini] Gemini response thiếu nội dung. Full response: " + bodyText);
      return { ok: false, reason: "empty_response" };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      Logger.log("[parseAndReactWithGemini] Gemini trả text không đúng schema JSON: " + raw);
      return { ok: false, reason: "schema_mismatch" };
    }

    if (parsed.amount) parsed.amount = Number(parsed.amount) || 0;
    if (!parsed.confidence) parsed.confidence = "high"; // phòng hờ nếu Gemini không trả field này

    Logger.log(`[parseAndReactWithGemini] Parse thành công (model=${modelUsed}): type=${parsed.type}, amount=${parsed.amount}, category=${parsed.category}, confidence=${parsed.confidence}`);

    if (!parsed.amount || !parsed.type) {
      return { ok: true, isTransaction: false, data: parsed };
    }
    return { ok: true, isTransaction: true, data: parsed };

  } catch (e) {
    Logger.log("[parseAndReactWithGemini] Exception: " + e + "\n" + (e.stack || ""));
    return { ok: false, reason: "exception" };
  }
}

// =====================================================
// NHÓM C — CHAT HỎI ĐÁP TỰ DO (/hoi) — nơi DUY NHẤT cần thêm lượt gọi Gemini
// =====================================================
// Nguyên tắc bắt buộc để giữ token thấp:
// 1. Chỉ kích hoạt qua lệnh rõ ràng /hoi — KHÔNG chặn mọi tin nhắn để "đoán" ý định.
// 2. KHÔNG bao giờ đẩy dữ liệu thô (nguyên Sheet) vào prompt — luôn dùng số liệu đã
//    tính sẵn từ các hàm hiện có (getCategoryTotalsThisMonth, getForecastNumbers,
//    computeHealthScoreRaw...), chỉ vài dòng tóm tắt.
// 3. Giới hạn độ dài câu hỏi để tránh input quá dài.
// 4. Cache câu hỏi giống hệt trong ít phút để tránh gọi trùng khi người dùng lỡ gửi lại.

const MAX_QUESTION_LENGTH = 300;
const HOI_CACHE_TTL_SECONDS = 180; // 3 phút

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

function buildAIContextSummary() {
  const lines = [];

  // Tổng quan tháng này
  const totals = getCategoryTotalsThisMonth(0);
  const monthData = getMonthlyTransactionData(0);
  let thu = 0, chi = 0;
  monthData.forEach(row => {
    if (row[2] === "thu") thu += Number(row[3] || 0);
    if (row[2] === "chi") chi += Number(row[3] || 0);
  });
  lines.push(`Tháng này: Thu ${thu.toLocaleString()}đ, Chi ${chi.toLocaleString()}đ, Cân đối ${(thu - chi).toLocaleString()}đ.`);

  // Số dư CỘNG DỒN toàn thời gian — quan trọng để /hoi trả lời đúng khi người dùng hỏi
  // "tôi còn bao nhiêu tiền" (số dư thực tế mang từ tháng trước sang, không phải chỉ số dư tháng này).
  const { balance: totalBalance } = getTotalBalance();
  lines.push(`Số dư hiện tại (cộng dồn từ trước đến nay, không reset theo tháng): ${totalBalance.toLocaleString()}đ.`);

  // Top 3 danh mục chi
  const topCats = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topCats.length > 0) {
    lines.push("Top danh mục chi: " + topCats.map(([c, v]) => `${c} ${v.toLocaleString()}đ`).join(", ") + ".");
  }

  // So với tháng trước (chỉ tổng, giữ gọn)
  const prevTotals = getCategoryTotalsThisMonth(-1);
  const prevChi = Object.values(prevTotals).reduce((s, v) => s + v, 0);
  if (prevChi > 0) {
    const diffPct = (((chi - prevChi) / prevChi) * 100).toFixed(0);
    lines.push(`So với tháng trước: chi ${diffPct >= 0 ? "tăng" : "giảm"} ${Math.abs(diffPct)}%.`);
  }

  // Ngân sách (nếu có)
  const budgets = getBudgets();
  const budgetCats = Object.keys(budgets);
  if (budgetCats.length > 0) {
    const budgetLines = budgetCats.slice(0, 5).map(cat => {
      const spend = getCategorySpendThisMonth(cat);
      const pct = budgets[cat] > 0 ? Math.round((spend / budgets[cat]) * 100) : 0;
      return `${cat} ${pct}%`;
    });
    lines.push("Ngân sách đã dùng: " + budgetLines.join(", ") + ".");
  }

  // Dự đoán cuối tháng
  const forecast = getForecastNumbers();
  if (forecast) {
    lines.push(`Dự kiến cuối tháng: tổng chi ~${Math.round(forecast.projectedTotal).toLocaleString()}đ, số dư ~${Math.round(forecast.projectedBalance).toLocaleString()}đ.`);
  }

  // Điểm sức khỏe tài chính
  const score = computeHealthScoreRaw();
  if (score) {
    lines.push(`Điểm sức khỏe tài chính: ${score.total}/100 (${score.rating}), tỷ lệ tiết kiệm ${(score.savingsRate * 100).toFixed(0)}%.`);
  }

  return lines.join("\n");
}

// Gọi Gemini với NGỮ CẢNH ĐÃ TÓM TẮT (không phải dữ liệu thô) + câu hỏi người dùng.
// Trả về { ok, answer } hoặc { ok: false, reason }.
function askGeminiFreeform(question) {
  try {
    const context = buildAIContextSummary();
    const prompt =
      `Bạn là cố vấn tài chính cá nhân, trả lời bằng tiếng Việt, ngắn gọn (2-4 câu), ` +
      `dựa HOÀN TOÀN vào số liệu tóm tắt dưới đây — không bịa thêm số liệu không có trong đó. ` +
      `Nếu số liệu không đủ để trả lời, nói rõ là chưa đủ dữ liệu. ` +
      `Lưu ý: nếu người dùng hỏi "còn bao nhiêu tiền" / "số dư" / "còn lại" mà không nói rõ "tháng này", ` +
      `hãy dùng dòng "Số dư hiện tại (cộng dồn...)" — KHÔNG dùng dòng "Cân đối" của riêng tháng này, ` +
      `vì số dư thực tế mang cả từ các tháng trước sang.\n\n` +
      `Số liệu tài chính hiện tại:\n${context}\n\n` +
      `Câu hỏi của người dùng: "${question}"`;

    const payload = { contents: [{ parts: [{ text: prompt }] }] };

    Logger.log(`[askGeminiFreeform] Gửi câu hỏi (chain: ${GEMINI_MODEL_CHAIN.join(" -> ")}): "${question}"`);

    const { res, modelUsed } = fetchGeminiWithModelFallback(payload);

    const code = res.getResponseCode();
    const bodyText = res.getContentText();
    if (code !== 200) {
      Logger.log("[askGeminiFreeform] Gemini /hoi HTTP " + code + " (model=" + modelUsed + "): " + bodyText);
      return { ok: false, reason: "http_" + code };
    }

    let data;
    try { data = JSON.parse(bodyText); } catch (e) {
      Logger.log("[askGeminiFreeform] Gemini /hoi trả về không phải JSON: " + bodyText);
      return { ok: false, reason: "invalid_json" };
    }

    if (data.promptFeedback && data.promptFeedback.blockReason) {
      Logger.log("[askGeminiFreeform] Gemini /hoi chặn prompt: " + JSON.stringify(data.promptFeedback));
      return { ok: false, reason: "blocked" };
    }

    const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!answer) {
      Logger.log("[askGeminiFreeform] Gemini /hoi response thiếu nội dung: " + bodyText);
      return { ok: false, reason: "empty_response" };
    }

    Logger.log(`[askGeminiFreeform] Trả lời thành công (model=${modelUsed}).`);
    return { ok: true, answer: answer.trim() };
  } catch (e) {
    Logger.log("[askGeminiFreeform] Exception: " + e + "\n" + (e.stack || ""));
    return { ok: false, reason: "exception" };
  }
}

const HOI_DAILY_LIMIT = 30; // đủ dùng cho 1 người/ngày, tránh rủi ro vượt hạn mức Gemini bất ngờ
const HOI_QUOTA_KEY_PREFIX = "hoi_quota_";

// Giới hạn số lần GỌI GEMINI THẬT SỰ mỗi ngày cho /hoi — không tính các lượt được trả lời từ cache.
// LƯU Ý: dùng PropertiesService chứ KHÔNG dùng CacheService, vì CacheService.put() ở Apps Script
// chỉ nhận TTL tối đa 21600 giây (6 giờ) — truyền 86400 (24h) sẽ ném lỗi ngay lập tức và làm
// toàn bộ /hoi crash. PropertiesService không có TTL nên cần tự dọn key cũ (xem cleanupOldHoiQuotaKeys).
function checkHoiQuota() {
  const props = PropertiesService.getScriptProperties();
  const todayKey = HOI_QUOTA_KEY_PREFIX + new Date().toDateString();
  cleanupOldHoiQuotaKeys(todayKey); // luôn dọn, kể cả khi hạn mức hôm nay đã hết
  const count = Number(props.getProperty(todayKey) || 0);
  if (count >= HOI_DAILY_LIMIT) return false;
  props.setProperty(todayKey, String(count + 1));
  return true;
}

// Dọn các key quota của ngày cũ — PropertiesService không tự hết hạn như Cache nên cần chủ động
// xoá, tránh tích luỹ vô hạn theo thời gian (mỗi ngày chỉ tạo 1 key nên không gấp, nhưng dọn cho sạch).
function cleanupOldHoiQuotaKeys(keepKey) {
  try {
    const props = PropertiesService.getScriptProperties();
    const all = props.getProperties();
    Object.keys(all).forEach(k => {
      if (k.startsWith(HOI_QUOTA_KEY_PREFIX) && k !== keepKey) {
        props.deleteProperty(k);
      }
    });
  } catch (e) {
    Logger.log("Dọn hoi_quota key cũ lỗi (bỏ qua): " + e);
  }
}

function handleHoiCommand(question) {
  if (!question) {
    return "ℹ️ Dùng: <code>/hoi Sao tháng này mình tiêu nhiều vậy?</code>";
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return `⚠️ Câu hỏi hơi dài (giới hạn ${MAX_QUESTION_LENGTH} ký tự), bạn rút gọn lại giúp mình nhé.`;
  }

  // Cache câu trả lời cho câu hỏi giống hệt trong vài phút — tránh gọi trùng Gemini không cần thiết.
  const cache = CacheService.getScriptCache();
  const cacheKey = "hoi_" + question.trim().toLowerCase().substring(0, 150);
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached + "\n\n<i>(câu trả lời cho câu hỏi này vừa được trả lời gần đây)</i>";
  }

  if (!checkHoiQuota()) {
    return `⚠️ Bạn đã hỏi đủ ${HOI_DAILY_LIMIT} câu hôm nay rồi, mai hỏi tiếp nhé! (giới hạn để tránh vượt hạn mức Gemini)`;
  }

  const result = askGeminiFreeform(question);
  if (!result.ok) {
    // Gọi Gemini thất bại (lỗi kỹ thuật, đã thử hết model trong chain) -> hoàn lại 1 lượt quota
    // vừa trừ ở checkHoiQuota(), vì người dùng không nhận được câu trả lời nào cho lượt này.
    refundHoiQuota();
    return "⚠️ Bot đang gặp sự cố kết nối tới Gemini, thử lại sau ít phút nhé.";
  }

  const formatted = "🤖 " + result.answer;
  cache.put(cacheKey, formatted, HOI_CACHE_TTL_SECONDS);
  return formatted;
}

// Hoàn lại 1 lượt quota /hoi khi lượt gọi Gemini bị lỗi kỹ thuật (không phải lỗi của người dùng).
// Không dùng chung logic với checkHoiQuota để tránh trường hợp hiếm: đúng lúc đổi ngày giữa
// lúc trừ và lúc hoàn -> chỉ hoàn khi key của "hôm nay" (theo lúc gọi hàm này) còn tồn tại và > 0.
function refundHoiQuota() {
  try {
    const props = PropertiesService.getScriptProperties();
    const todayKey = HOI_QUOTA_KEY_PREFIX + new Date().toDateString();
    const count = Number(props.getProperty(todayKey) || 0);
    if (count > 0) props.setProperty(todayKey, String(count - 1));
  } catch (e) {
    Logger.log("Hoàn hoi_quota lỗi (bỏ qua, không ảnh hưởng luồng chính): " + e);
  }
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
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sh = ss.getSheetByName("Transactions") || ss.insertSheet("Transactions");
    sh.appendRow([whenDate || new Date(), user, parsed.type, parsed.amount, parsed.note || "", parsed.category || "Khác"]);
    invalidateTransactionsCache();
  } finally {
    lock.releaseLock();
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

// =====================================================
// BIỂU ĐỒ (QuickChart.io — miễn phí, không tính vào quota Gemini)
// =====================================================
function sendCategoryChart(chatId) {
  const totals = getCategoryTotalsThisMonth();
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    sendMessage(chatId, "📭 Tháng này chưa có chi tiêu để vẽ biểu đồ.");
    return;
  }
  const labels = entries.map(([cat]) => cat);
  const values = entries.map(([, val]) => val);

  const chartConfig = {
    type: "pie",
    data: {
      labels: labels,
      datasets: [{ data: values }]
    },
    options: {
      plugins: {
        title: { display: true, text: "Chi tiêu theo danh mục — tháng này" }
      }
    }
  };

  const chartUrl = "https://quickchart.io/chart?width=500&height=400&c=" + encodeURIComponent(JSON.stringify(chartConfig));

  const payload = { chat_id: chatId, photo: chartUrl, caption: "📊 Chi tiêu theo danh mục tháng này" };
  const res = UrlFetchApp.fetch(`${TG_API}/sendPhoto`, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    Logger.log("sendPhoto failed: " + res.getContentText());
    sendMessage(chatId, "⚠️ Không thể tạo biểu đồ lúc này, thử lại sau nhé.");
  }
}

// =====================================================
// TELEGRAM MESSAGE SENDER
// =====================================================
function sendMessage(chatId, text, mode = "HTML", inlineButtons = null, replyKeyboard = null) {
  const payload = { chat_id: chatId, text, parse_mode: mode };
  if (inlineButtons) {
    payload.reply_markup = { inline_keyboard: inlineButtons };
  } else if (replyKeyboard) {
    payload.reply_markup = { keyboard: replyKeyboard, resize_keyboard: true };
  }
  const res = UrlFetchApp.fetch(`${TG_API}/sendMessage`, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    Logger.log(`[sendMessage] Gửi thất bại tới chatId=${chatId}: ` + res.getContentText());
  } else {
    // LOG: xác nhận tin nhắn đã gửi thành công tới Telegram — hữu ích để biết doPost đã
    // chạy tới cuối luồng, không chỉ dừng lại ở việc nhận request.
    Logger.log(`[sendMessage] Đã gửi thành công tới chatId=${chatId} (${text.length} ký tự).`);
  }
}

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

function doGet() {
  return HtmlService.createTextOutput("✅ Bot Chi Tiêu Gemini đang chạy bình thường.");
}

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyReminderJob').timeBased().everyDays(1).atHour(REMIND_HOUR).create();
  ScriptApp.newTrigger('dailyReportJob').timeBased().everyDays(1).atHour(REPORT_HOUR).create();
  Logger.log("Đã tạo trigger. Múi giờ project hiện tại: " + Session.getScriptTimeZone());
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