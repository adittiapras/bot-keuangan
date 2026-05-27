const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ============================================================
// KONFIGURASI — isi dengan data kamu
// ============================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SHEET_NAME = "Sheet1";
// ============================================================

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Setup Google Sheets
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// Prompt untuk AI
const SYSTEM_PROMPT = `Kamu adalah AI parser transaksi keuangan. User mengirim pesan singkat berisi transaksi keuangan dalam bahasa Indonesia sehari-hari.

Tugasmu: ekstrak informasi dan balas HANYA dengan JSON valid berikut (tanpa markdown, tanpa teks tambahan apapun):

{"tipe":"pengeluaran"|"pemasukan","kategori":"string","jumlah":angka_numerik,"deskripsi":"string singkat","emoji":"1 emoji relevan","balasan":"string respons singkat ramah dalam bahasa Indonesia"}

Panduan kategori:
- Pengeluaran: Makanan, Transport, Belanja, Kesehatan, Hiburan, Tagihan, Lainnya
- Pemasukan: Gaji, Bisnis, Transfer, Investasi, Lainnya

Aturan jumlah:
- rb / ribu = x1.000 (contoh: 25rb = 25000)
- jt / juta = x1.000.000 (contoh: 3jt = 3000000)
- Angka tanpa satuan = nilai aslinya (contoh: 50000 = 50000)

Jika pesan tidak ada hubungannya dengan transaksi keuangan, balas dengan:
{"error":"bukan transaksi","balasan":"Halo! Kirim transaksi kamu ya, contoh: makan siang 25rb atau gaji masuk 3jt 😊"}`;

// Format tanggal Indonesia
function getTanggal() {
  return new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Format angka ke Rupiah
function formatRupiah(angka) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
  }).format(angka);
}

// Simpan ke Google Sheets
async function simpanKeSheets(data) {
  const tanggal = getTanggal();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:E`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [
        [
          tanggal,
          data.deskripsi,
          data.kategori,
          data.tipe.charAt(0).toUpperCase() + data.tipe.slice(1),
          data.jumlah,
        ],
      ],
    },
  });
}

// Handle pesan masuk
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const teks = msg.text;

  // Abaikan command /start
  if (teks === "/start") {
    return bot.sendMessage(
      chatId,
      `Halo! 👋 Aku bot pencatat keuangan kamu.\n\nCara pakai:\nKetik transaksi kamu dengan bebas, contoh:\n\n💸 *makan siang 25rb*\n💸 *beli bensin 50000*\n💰 *gaji masuk 3jt*\n💰 *transfer dari ortu 200rb*\n\nSemua otomatis tercatat di Google Sheets kamu! 📊`,
      { parse_mode: "Markdown" }
    );
  }

  // Tampilkan indikator "mengetik"
  bot.sendChatAction(chatId, "typing");

  try {
    // Kirim ke Gemini untuk diparse
    const prompt = SYSTEM_PROMPT + "\n\nPesan user: " + teks;
    const result = await model.generateContent(prompt);
    const raw = result.response.text();
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    // Kalau bukan transaksi
    if (parsed.error) {
      return bot.sendMessage(chatId, parsed.balasan);
    }

    // Simpan ke Google Sheets
    await simpanKeSheets(parsed);

    // Balas ke user
    const tipeIcon = parsed.tipe === "pemasukan" ? "💰" : "💸";
    const balasan =
      `${tipeIcon} *Tercatat!*\n\n` +
      `${parsed.emoji} ${parsed.deskripsi}\n` +
      `📁 Kategori: ${parsed.kategori}\n` +
      `📊 Tipe: ${parsed.tipe.charAt(0).toUpperCase() + parsed.tipe.slice(1)}\n` +
      `💵 Jumlah: ${formatRupiah(parsed.jumlah)}\n\n` +
      `_${parsed.balasan}_`;

    bot.sendMessage(chatId, balasan, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Error:", err);
    bot.sendMessage(
      chatId,
      "Maaf, ada kendala teknis. Coba kirim ulang ya! 🙏"
    );
  }
});

console.log("🤖 Bot keuangan aktif dan siap digunakan!");
