# Bot Chi Tiêu Gemini 💰

Bot Telegram quản lý chi tiêu cá nhân, chạy hoàn toàn trên **Google Apps Script** (miễn phí, không cần server riêng), dùng **Gemini API** để hiểu câu nhập tự nhiên bằng tiếng Việt và **Google Sheets** làm nơi lưu dữ liệu.

> Gõ chuyện thường ngày như `ăn sáng 35k`, `nhận lương 10 triệu` — bot tự hiểu, hỏi xác nhận, rồi ghi vào sổ. Không cần form, không cần app riêng.

---

## 1. Mục tiêu & triết lý thiết kế

- **Cá nhân, đơn giản, miễn phí**: mã nguồn dạng module (11 files Apps Script) + 1 Google Sheet + 1 Telegram Bot + 1 Gemini API key (free tier).
- **Tiết kiệm token AI tối đa**: phần lớn tính năng (báo cáo, dự đoán, phát hiện bất thường, điểm sức khỏe tài chính...) là **công thức tính toán thuần**, không gọi AI. Gemini chỉ được dùng ở đúng 2 chỗ:
  1. Parse giao dịch từ câu nhập tự nhiên (bắt buộc, mỗi giao dịch 1 lần gọi).
  2. Lệnh `/hoi` — hỏi đáp tự do (có cache + giới hạn 30 lượt/ngày).
- **An toàn dữ liệu**: token/key không hardcode, đọc từ Script Properties. Ghi/xoá Sheet có `LockService` để tránh race condition khi 2 request chạy gần nhau.
- **Chống lỗi khi Google đổi model**: từng bị lỗi hàng loạt vì dùng alias `-latest` bị Google tự động "hot-swap" sang model mới chưa ổn định → chuyển sang ghim cứng model + có dây chuyền dự phòng tự động.

---

## 2. Kiến trúc & công nghệ

| Thành phần | Vai trò |
|---|---|
| **Google Apps Script** | Runtime duy nhất — nhận webhook, xử lý logic, gọi API ngoài |
| **Telegram Bot API** | Giao diện người dùng (chat, nút bấm inline, reply keyboard) |
| **Gemini API** (`generateContent`) | Parse giao dịch tự nhiên + trả lời hỏi đáp tự do |
| **Google Sheets** | Cơ sở dữ liệu: 5 sheet (`Transactions`, `Budgets`, `Goals`, `Debts`, `Bills`) |
| **CacheService** | Cache tạm: giao dịch chờ xác nhận (5 phút), toàn bộ transaction (60 giây), câu trả lời `/hoi` (3 phút) |
| **PropertiesService** | Lưu cấu hình (token/key) + quota `/hoi` theo ngày |
| **QuickChart.io** | Vẽ biểu đồ tròn chi tiêu theo danh mục (miễn phí, ngoài quota Gemini) |
| **Trigger theo giờ** | Nhắc ghi chi tiêu lúc 20:00, báo cáo cuối ngày lúc 21:00 |

### Cấu hình bắt buộc (Script Properties)
`BOT_TOKEN`, `GEMINI_KEY`, `SHEET_ID`, `ADMIN_CHAT_ID` — thiếu 1 trong 4 sẽ bị chặn ngay từ đầu `doPost` với log rõ ràng, không lỗi mù mờ.

### Model Gemini & cơ chế dự phòng
```
GEMINI_MODEL_CHAIN = [ 'gemini-3.5-flash' (ghim cứng), 'gemini-2.5-flash' (dự phòng) ]
```
- `fetchGeminiWithRetry`: retry tối đa 2 lần với backoff (1s, 2s) khi gặp **503/429** (lỗi tạm thời của MỘT model).
- `fetchGeminiWithModelFallback`: nếu 1 model trong chain vẫn lỗi **404/429/503** sau khi retry → tự động chuyển sang model kế tiếp trong chain. Lỗi 400/401/403 (sai cấu hình/API key) thì dừng ngay, không đổi model vì đổi cũng lỗi y hệt.
- Có thể override model dự phòng qua Script Property `GEMINI_MODEL_FALLBACK` mà không cần sửa code.

---

## 3. Cấu trúc dự án & Phân chia module (11 files)

Toàn bộ code ban đầu từ file đơn khối `FinanceBot_VI.js` (2,566 dòng) đã được phân tách thành **11 module `.js` chuyên biệt** trên Google Apps Script, được tổ chức theo đúng nguyên tắc đơn nhiệm.

> ⚠️ **Lưu ý về Runtime Google Apps Script**:
> - Tất cả các file trong project dùng chung **một global scope phẳng** (không dùng `import`/`export`/`require`).
> - Apps Script nạp file theo thứ tự bảng chữ cái (alphabetical order). Tiền tố số `00_` đảm bảo `00_Config.js` luôn được thực thi đầu tiên để khởi tạo các hằng số, cấu hình và bảng tham chiếu dùng chung cho toàn bộ hệ thống.

### Bảng phân nhiệm & Function Mapping (113 thành phần đã đối soát 100%)

| File | Trách nhiệm chính | Danh sách hàm & hằng số (113 thành phần) |
|---|---|---|
| `00_Config.js` *(25)* | Cấu hình, đọc Script Properties, model fallback chain, danh mục chi tiêu, định nghĩa bàn phím, thuật toán Levenshtein gợi ý lệnh & đăng ký menu lệnh bot | `props`, `BOT_TOKEN`, `GEMINI_KEY`, `SHEET_ID`, `ADMIN_CHAT_ID`, `TG_API`, `REMIND_HOUR`, `REPORT_HOUR`, `GEMINI_MODEL`, `GEMINI_MODEL_CHAIN`, `buildGeminiUrl`, `GEMINI_URL`, `VALID_CATEGORIES`, `PENDING_TTL_SECONDS`, `MAIN_KEYBOARD`, `BUTTON_COMMAND_MAP`, `normalizeButtonLabel`, `BUTTON_COMMAND_MAP_NORMALIZED`, `isCommand`, `ALL_COMMANDS`, `VALID_COMMAND_WORDS`, `levenshteinDistance`, `findClosestCommand`, `utf8ByteLength`, `registerBotCommands` |
| `01_Router.js` *(5)* | Điều phối webhook chính (`doPost`), xử lý callback inline button, gửi giao diện xem trước & chọn nhanh danh mục, endpoint kiểm tra sức khỏe bot (`doGet`) | `doPost`, `handleCallbackQuery`, `sendTransactionPreview`, `sendCategoryPicker`, `doGet` |
| `Gemini.js` *(17)* | Trích xuất thời gian, giao tiếp Gemini API với retry & fallback chain, prompt cấu trúc JSON parse giao dịch; xử lý lệnh `/hoi` (freeform Q&A), quản lý quota 30 câu/ngày và cơ chế hoàn quota khi gặp lỗi mạng | `parseDateTimeFromText`, `formatDateTimeVN`, `fetchGeminiWithRetry`, `MODEL_FALLBACK_CODES`, `buildGeminiPayloadOptions`, `fetchGeminiWithModelFallback`, `parseAndReactWithGemini`, `MAX_QUESTION_LENGTH`, `HOI_CACHE_TTL_SECONDS`, `buildAIContextSummary`, `askGeminiFreeform`, `HOI_DAILY_LIMIT`, `HOI_QUOTA_KEY_PREFIX`, `checkHoiQuota`, `cleanupOldHoiQuotaKeys`, `handleHoiCommand`, `refundHoiQuota` |
| `Sheets_Transactions.js` *(9)* | Tương tác bảng `Transactions`: cache dữ liệu 60s, ghi nhận thu/chi mới (kèm `LockService`), tra cứu giao dịch gần nhất, xoá dòng theo ID hàng, tìm kiếm theo từ khoá/khoảng tiền | `getAllTransactionsCached`, `invalidateTransactionsCache`, `getMonthlyTransactionData`, `ensureSheet`, `appendToSheet`, `getRecentTransactions`, `getTransactionByRow`, `deleteTransactionRow`, `searchTransactions` |
| `Sheets_Budget.js` *(9)* | Tương tác bảng `Budgets`: thiết lập hạn mức tháng, bộ phân tích số tiền viết tắt (`parseAmountShorthand` hỗ trợ `1.5tr`, `500k`...), tính % đã tiêu và cảnh báo 4 mốc (50%, 80%, 100%) | `ensureBudgetSheet`, `getBudgets`, `setBudget`, `parseAmountShorthand`, `handleBudgetCommand`, `getCategorySpendThisMonth`, `getBudgetRemaining`, `checkBudgetAlert`, `getBudgetStatusText` |
| `Sheets_Goals.js` *(4)* | Tương tác bảng `Goals`: tạo mục tiêu tiết kiệm, ghi nhận số tiền tích lũy và xuất báo cáo tiến độ thực hiện | `ensureGoalsSheet`, `handleGoalCommand`, `handleSaveContributionCommand`, `getGoalsReport` |
| `Sheets_Debts.js` *(5)* | Tương tác bảng `Debts`: quản lý khoản vay & cho vay, parse hạn thanh toán, hiển thị danh sách nợ tồn đọng kèm nút xác nhận đã trả | `ensureDebtsSheet`, `parseSimpleDate`, `handleDebtCommand`, `sendDebtsList`, `markDebtPaid` |
| `Sheets_Bills.js` *(4)* | Tương tác bảng `Bills`: quản lý các hoá đơn định kỳ hàng tháng, báo cáo danh sách hoá đơn và tổng hợp các khoản nợ/hoá đơn sắp đến hạn trong 3 ngày tới | `ensureBillsSheet`, `handleBillCommand`, `getBillsReport`, `getDueSoonReport` |
| `Reports.js` *(26)* | Báo cáo tài chính thuần công thức (0 token AI): tổng kết ngày/tuần/tháng, số dư lũy kế, top danh mục, phân tích so sánh tháng trước; thuật toán dự báo cuối tháng, phát hiện chi định kỳ, chấm điểm sức khỏe tài chính /100, thói quen chi tiêu & cảnh báo bất thường | `getDayReport`, `getTotalBalance`, `getBalanceReport`, `getFinanceReport`, `getCategoryReport`, `getTopCategoryReport`, `getCategoryTotalsThisMonth`, `getCompareReport`, `getCategoryCompareLines`, `getAutoCauseLine`, `getWeekBounds`, `getWeekReport`, `getTop5Report`, `getForecastNumbers`, `getForecastReport`, `getTrendReport`, `getSubscriptionsReport`, `ESSENTIAL_CATEGORIES`, `computeHealthScoreRaw`, `getFinancialHealthScore`, `getEmergencyFundSuggestion`, `checkAnomalyAlert`, `buildWeekdayBuckets`, `getWeekdayPatternReport`, `getBehaviorSavingTips`, `getBadHabitReport` |
| `Telegram.js` *(2)* | Gửi thông điệp Telegram qua Bot API (hỗ trợ định dạng HTML/Markdown, inline keyboard) và render biểu đồ tròn danh mục qua QuickChart | `sendCategoryChart`, `sendMessage` |
| `Triggers.js` *(7)* | Hệ thống tự động theo thời gian: kiểm tra giao dịch trong ngày, nhắc nhở lúc 20:00 (kèm pattern chi tiêu và hạn nợ/bill), gửi báo cáo 21:00, cài đặt và kiểm tra trạng thái Project Triggers | `hasTransactionToday`, `getPatternHintForDay`, `dailyReminderJob`, `dailyReportJob`, `setupTriggers`, `testReminderNow`, `checkTriggersStatus` |

---

## 4. Luồng xử lý chính (Workflow)

### 3.1. Luồng ghi giao dịch tự nhiên (luồng quan trọng nhất)

```
Người dùng gõ "ăn sáng 35k"
        │
        ▼
Telegram gửi webhook → doPost(e)
        │
        ├─ Kiểm tra đủ 4 Script Properties chưa? (nếu thiếu → dừng, log rõ)
        ├─ Log tin nhắn đến (chatId, nội dung)
        ├─ Nếu là nút bấm Reply Keyboard → map sang lệnh slash tương ứng
        ├─ Thử khớp với ~30 lệnh có sẵn (/report, /budget, /goal, /debt, /bill, /hoi, /undo...)
        ├─ Nếu bắt đầu bằng "/" nhưng không khớp lệnh nào → gợi ý sửa lỗi gõ (Levenshtein)
        │
        ▼ (không khớp lệnh nào — coi là giao dịch tự nhiên)
Trích ngày/giờ tuỳ chỉnh bằng regex thuần (không tốn token AI)
        │
        ▼
Gọi Gemini (fetchGeminiWithModelFallback) với JSON Schema ép cấu trúc
        │
        ├─ Lỗi kỹ thuật (hết cả chain) → báo lỗi kết nối, không đổ lỗi người dùng
        ├─ Không phải giao dịch → "Tôi chưa hiểu rõ, thử diễn đạt khác nhé?"
        │
        ▼ (parse thành công)
Cache giao dịch "pending" theo chatId (TTL 5 phút)
        │
        ├─ confidence = "low" → hỏi ngược: hiện bàn phím chọn 1 trong 7 danh mục
        └─ confidence = "high" → hiện preview: [✅ Lưu] [✏️ Sửa DM] [❌ Huỷ]
                │
                ▼ (bấm "✅ Lưu")
        handleCallbackQuery → confirm_save
                │
                ├─ Kiểm tra bất thường (so với TB 30 ngày cùng danh mục) — TRƯỚC khi ghi
                ├─ Ghi vào Sheet "Transactions" (có Lock, invalidate cache)
                ├─ Kiểm tra cảnh báo ngân sách (50% / 80% / 100%)
                └─ Trả lời xác nhận + cảnh báo (nếu có)
```

### 3.2. Luồng `/hoi` (hỏi đáp tự do — nơi DUY NHẤT tốn thêm token ngoài parse giao dịch)

```
/hoi Sao tháng này mình tiêu nhiều vậy?
        │
        ├─ Quá 300 ký tự? → từ chối, yêu cầu rút gọn
        ├─ Câu hỏi giống hệt đã hỏi trong 3 phút gần đây? → trả lời từ cache, KHÔNG gọi Gemini
        ├─ Đã hỏi đủ 30 lần hôm nay? → từ chối, hẹn mai
        │
        ▼
buildAIContextSummary() — tổng hợp SỐ LIỆU ĐÃ TÍNH SẴN (không đẩy dữ liệu thô của Sheet):
  thu/chi tháng này, số dư cộng dồn toàn thời gian, top 3 danh mục,
  % thay đổi so với tháng trước, tình trạng ngân sách, dự đoán cuối tháng, điểm sức khỏe TC
        │
        ▼
askGeminiFreeform() — gửi context + câu hỏi, dùng chung cơ chế model fallback
        │
        ├─ Lỗi kỹ thuật → hoàn lại 1 lượt quota vừa trừ (refundHoiQuota)
        └─ Thành công → cache câu trả lời 3 phút, trả lời người dùng
```

### 3.3. Luồng tự động hằng ngày (Trigger)

- **20:00 — `dailyReminderJob`**: nếu hôm nay CHƯA ghi giao dịch nào → nhắc, kèm gợi ý theo thói quen (ví dụ "thứ 6 bạn hay chi Ăn uống") dựa trên pattern 60 ngày gần nhất, cộng thêm danh sách nợ/hoá đơn sắp đến hạn trong 3 ngày tới (nếu có). Nếu đã ghi rồi → khen.
- **21:00 — `dailyReportJob`**: gửi báo cáo tổng kết giao dịch trong ngày (liệt kê từng khoản).

### 3.4. Luồng xoá giao dịch

`/undo` → liệt kê 5 giao dịch gần nhất kèm nút → chọn 1 → hỏi xác nhận lần nữa → xoá đúng dòng trong Sheet (đọc trực tiếp, KHÔNG qua cache, để tránh xoá nhầm dòng nếu dữ liệu vừa đổi). `/delete` là bản rút gọn: xoá thẳng giao dịch cuối cùng không cần chọn.

---

## 5. Danh sách tính năng đầy đủ (theo nhóm phát triển A–D)

### Nhóm A — Báo cáo 0 token (thuần công thức)
| Lệnh | Chức năng |
|---|---|
| `/sodu` | Số dư cộng dồn toàn thời gian (không reset theo tháng) |
| `/reportday [ngày]` | Liệt kê từng giao dịch trong 1 ngày (mặc định hôm nay), có thể tra cứu ngày bất kỳ: `/reportday 25/07` |
| `/reportweek`, `/reportmonth`, `/report` | Tổng thu/chi theo tuần / tháng / toàn thời gian |
| `/reportcategory` | Tổng chi theo từng danh mục |
| `/topcategory` | Danh mục chi nhiều nhất tháng này (kèm % trên tổng) |
| `/top5` | Top 5 khoản chi + top 5 khoản thu lớn nhất tháng |
| `/compare` | So sánh chi tiêu tháng này vs tháng trước, kèm theo từng danh mục + nguyên nhân chính |
| `/search` | Tìm theo từ khoá, hoặc theo số tiền: `>500k`, `<100k`, `100k-300k` |
| Gợi ý sửa lệnh gõ sai | Levenshtein distance, ví dụ gõ `/star` → gợi ý `/start` |

### Nhóm B — Phân tích thông minh (vẫn thuần công thức, không cần AI)
| Lệnh | Chức năng |
|---|---|
| `/forecast` | Dự đoán tổng chi & số dư cuối tháng (ngoại suy tuyến tính theo tốc độ chi hiện tại) |
| `/trend` | Xu hướng tăng/giảm liên tục của từng danh mục trong 3 tháng gần nhất |
| `/subscriptions` | Phát hiện chi tiêu định kỳ khả nghi (cùng số tiền, lặp lại ~30 ngày/lần) |
| `/score` | Điểm sức khỏe tài chính /100 (tỷ lệ tiết kiệm, tỷ lệ chi thiết yếu, kiểm soát ngân sách) + gợi ý quỹ khẩn cấp |
| `/patterns` | Thói quen chi theo ngày trong tuần (60 ngày gần nhất) |
| `/savingtips` | Gợi ý tiết kiệm dựa trên khoản chi lặp lại ≥5 lần/tháng |
| `/habits` | Thống kê khách quan: % chi sau 22h, % chi cuối tuần (không phán xét) |
| Cảnh báo bất thường | Tự động khi ghi giao dịch mới, nếu gấp ≥2.5 lần TB 30 ngày cùng danh mục |
| `/chart` | Biểu đồ tròn chi tiêu theo danh mục tháng này (QuickChart) |

### Nhóm C — Có dùng thêm Gemini (duy nhất, có giới hạn)
| Lệnh | Chức năng |
|---|---|
| `/hoi <câu hỏi>` | Hỏi đáp tự do dựa trên số liệu thực tế, tối đa 30 câu/ngày, cache 3 phút, tự hoàn quota nếu lỗi kỹ thuật |

### Nhóm D — Mục tiêu & nghĩa vụ tài chính
| Lệnh | Chức năng |
|---|---|
| `/goal <tên> <số tiền> <số tháng>` | Tạo mục tiêu tiết kiệm |
| `/save <tên> <số tiền>` | Ghi nhận góp tiền vào mục tiêu |
| `/goals` | Xem tiến độ (đúng tiến độ / chậm / hoàn thành) |
| `/debt vay\|chovay <tên> <số tiền> <hạn dd/mm>` | Ghi khoản nợ (tôi nợ / người khác nợ tôi) |
| `/debts` | Danh sách nợ chưa xử lý, có nút "✅ Xong" |
| `/bill <tên> <số tiền> <ngày trong tháng>` | Thêm hoá đơn định kỳ |
| `/bills` | Danh sách hoá đơn định kỳ |
| `/duesoon` | Gộp nợ + hoá đơn sắp đến hạn trong 3 ngày (kể cả quá hạn) |

### Ngân sách (`/budget`)
- `/budget` không tham số → xem tình trạng tất cả danh mục đã đặt ngân sách.
- `/budget <danh mục> <số tiền>` → đặt/cập nhật ngân sách tháng.
- Cảnh báo tự động theo 4 mốc: <50% (thông tin), ≥50% (nhắc nhẹ), ≥80% (sắp hết), ≥100% (vượt).

### Cơ bản
`/start`, `/help` (hướng dẫn + đăng ký menu lệnh Telegram lần đầu), `/whoami` (xem chat ID).

---

## 6. Cấu trúc dữ liệu (Google Sheets)

| Sheet | Cột |
|---|---|
| `Transactions` | Thời gian, Người dùng, Loại (thu/chi), Số tiền, Ghi chú, Danh mục |
| `Budgets` | Danh mục, Ngân sách tháng |
| `Goals` | Tên mục tiêu, Số tiền mục tiêu, Số tháng, Ngày bắt đầu, Đã tiết kiệm |
| `Debts` | Loại (vay/chovay), Tên, Số tiền, Hạn, Đã xong |
| `Bills` | Tên, Số tiền ước tính, Ngày trong tháng |

7 danh mục cố định: *Ăn uống, Di chuyển, Giải trí, Hóa đơn, Mua sắm, Sức khỏe, Khác*.

---

## 7. Các lớp phòng thủ kỹ thuật đáng chú ý

- **Lock khi ghi/xoá Sheet** (`LockService`) — tránh 2 request ghi đè nhau.
- **Cache 60s cho đọc, KHÔNG cache cho ghi/xoá theo dòng** — báo cáo dùng cache để nhanh, nhưng `/undo`, `/delete` luôn đọc trực tiếp Sheet để không xoá nhầm dòng nếu dữ liệu vừa đổi.
- **Chuẩn hoá emoji nút bấm** (`normalizeButtonLabel`) — một số nền tảng gửi thiếu ký tự ẩn variation-selector trong emoji, làm so khớp chuỗi tuyệt đối bị trật; đã fix bằng cách luôn strip trước khi so khớp.
- **`isCommand()` so khớp có ranh giới từ** — sửa bug: lệnh có tham số (`/goal Laptop...`) sẽ không khớp phép so sánh `===` tuyệt đối, phải dùng so khớp tiền tố + khoảng trắng.
- **Parse số tiền dạng tắt** (`parseAmountShorthand`) — hỗ trợ `1tr`, `1.5tr`, `1500k`, `1.500.000`, `2,000,000`; có xử lý phân biệt dấu chấm thập phân vs phân cách hàng nghìn kiểu Việt Nam để tránh sai lệch hàng triệu lần.
- **Quota `/hoi` dùng PropertiesService, không dùng CacheService** — vì `CacheService.put()` giới hạn TTL tối đa 6 giờ, không đủ cho quota theo ngày (24h).
- **Không đẩy dữ liệu Sheet thô vào prompt Gemini** — luôn dùng số liệu đã tính sẵn, giữ prompt ngắn, giảm token và giảm rủi ro rò rỉ dữ liệu không cần thiết.

---

## 8. Sự cố đã gặp & bài học

| Sự cố | Nguyên nhân | Cách khắc phục |
|---|---|---|
| Bot báo lỗi "sự cố kết nối Gemini" hàng loạt | Dùng alias `gemini-flash-latest`, bị Google tự động "hot-swap" sang model mới (`gemini-3.7-flash`) ngay khi vừa ra mắt, chưa đủ capacity → 503 hàng loạt | Bỏ alias, ghim cứng model ổn định + thêm `GEMINI_MODEL_CHAIN` dự phòng, retry có backoff cho lỗi tạm thời |
| Nút bấm không phản hồi | `doPost` ban đầu không xử lý `update.callback_query` | Thêm `handleCallbackQuery()` |
| Ngân sách đặt tiền sai gấp ~750.000 lần | `"1.500.000"` bị `parseFloat` hiểu nhầm là 1.5 (dừng ở dấu chấm thứ 2) | Viết lại `parseAmountShorthand` để phân biệt dấu chấm thập phân vs phân cách hàng nghìn |
| Nút bấm Reply Keyboard không map đúng lệnh | So khớp chuỗi tuyệt đối bị trật vì thiếu ký tự ẩn trong emoji | `normalizeButtonLabel()` |

---

## 9. Cài đặt nhanh (tóm tắt)

1. Tạo Telegram Bot qua BotFather → lấy `BOT_TOKEN`.
2. Lấy `ADMIN_CHAT_ID` bằng lệnh `/whoami` sau khi deploy lần đầu.
3. Tạo Google Sheet trống → lấy `SHEET_ID` từ URL.
4. Lấy `GEMINI_KEY` từ Google AI Studio.
5. Vào Apps Script > Project Settings > Script Properties, thêm đúng 4 property trên (phân biệt hoa/thường).
6. Deploy dưới dạng Web App, gắn URL làm webhook Telegram (`setWebhook`).
7. Chạy `setupTriggers()` một lần để tạo trigger nhắc nhở (20:00) và báo cáo (21:00).
8. Gõ `/start` trong Telegram để kiểm tra.

---

## 10. Giới hạn hiện tại / hướng phát triển tiếp

- Chỉ hỗ trợ 1 người dùng chính (không phân quyền nhiều user độc lập trong cùng 1 Sheet).
- 7 danh mục cố định, chưa cho phép người dùng tự thêm danh mục mới.
- Chưa có xuất báo cáo file (PDF/Excel) — chỉ xem trong chat.
- `/subscriptions`, `/patterns` cần đủ lịch sử dữ liệu (≥2 lần lặp lại / ≥60 ngày) mới có kết quả ý nghĩa.
