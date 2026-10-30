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
const GEMINI_MODEL = 'gemini-3.5-flash-lite';

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
// mặc định dùng 'gemini-3.5-flash' — bản đầy đủ làm lựa chọn an toàn dự phòng.
// Có thể thêm nhiều bậc dự phòng hơn nữa bằng cách nối thêm phần tử vào mảng này.
const GEMINI_MODEL_CHAIN = [
  GEMINI_MODEL,
  props.getProperty('GEMINI_MODEL_FALLBACK') || 'gemini-3.5-flash',
];

function buildGeminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
}

// Giữ lại GEMINI_URL (model chính) để tương thích ngược nếu có chỗ khác trong dự án còn tham chiếu tới.
const GEMINI_URL = buildGeminiUrl(GEMINI_MODEL);

const VALID_CATEGORIES = ["Ăn uống", "Di chuyển", "Giải trí", "Hóa đơn", "Mua sắm", "Sức khỏe", "Khác"];
const PENDING_TTL_SECONDS = 300; // 5 phút chờ xác nhận trước khi tự huỷ

// =====================================================
// NGƯỠNG CẢNH BÁO SỐ DƯ THẤP (VND)
// =====================================================
const LOW_BALANCE_LEVEL1_THRESHOLD   = 1000000; // Cấp 1: < 1.000.000đ
const LOW_BALANCE_LEVEL2_THRESHOLD   = 300000;  // Cấp 2: < 300.000đ
const LOW_BALANCE_CRITICAL_THRESHOLD = 0;       // Khẩn cấp: <= 0đ
const LOW_BALANCE_TIER_PROPERTY_KEY  = "LOW_BALANCE_LAST_ALERT_TIER";

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