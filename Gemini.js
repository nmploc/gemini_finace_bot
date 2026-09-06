
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