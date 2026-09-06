
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