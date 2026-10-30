
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

    // Đánh giá và gửi cảnh báo số dư thấp nếu vượt ngưỡng (không chặn/làm chậm lưu giao dịch)
    try {
      checkAndSendLowBalanceAlert(chatId);
    } catch (alertErr) {
      Logger.log("Lỗi gửi cảnh báo số dư thấp (bỏ qua): " + alertErr);
    }

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

function doGet() {
  return HtmlService.createTextOutput("✅ Bot Chi Tiêu Gemini đang chạy bình thường.");
}