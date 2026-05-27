const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");

// ============================================================
// KONFIGURASI
// ============================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SHEET_NAME = "Sheet1";
// ============================================================

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const PROMPT_TEMPLATE = `Kamu adalah AI parser transaksi keuangan. User mengirim pesan singkat berisi transaksi keuangan dalam bahasa Indonesia sehari-hari.

Tugasmu: ekstrak informasi dan balas HANYA dengan JSON valid berikut (tanpa markdown, tanpa teks tambahan apapun):

{"tipe":"pengeluaran"|"pemasukan","kategori":"string","jumlah":angka_numerik,"deskripsi":"string singkat","emoji":"1 emoji relevan","dompet":"string","balasan":"string respons singkat ramah dalam bahasa Indonesia"}

Panduan kategori:
- Pengeluaran: Makanan, Transport, Belanja, Kesehatan, Hiburan, Tagihan, Lainnya
- Pemasukan: Gaji, Bisnis, Transfer, Investasi, Lainnya

Panduan dompet:
- Jika user menyebut "cash", "tunai", "dompet" → isi "Cash"
- Jika user menyebut nama bank atau e-wallet (BCA, BSI, BRI, BNI, Mandiri, GoPay, OVO, Dana, ShopeePay, dll) → isi nama tersebut
- Jika tidak disebutkan sama sekali → isi "Cash"

Aturan jumlah:
- rb / ribu = x1.000 (contoh: 25rb = 25000)
- jt / juta = x1.000.000 (contoh: 3jt = 3000000)
- k = x1.000 (contoh: 10k = 10000)
- Angka tanpa satuan = nilai aslinya (contoh: 50000 = 50000)

Jika pesan tidak ada hubungannya dengan transaksi keuangan, balas dengan:
{"error":"bukan transaksi","balasan":"Halo! Kirim transaksi kamu ya, contoh: makan siang 25rb atau gaji masuk 3jt 😊"}

Pesan user: `;

async function tanyaGemini(teks) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: PROMPT_TEMPLATE + teks }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 300 }
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${JSON.stringify(data)}`);
  return data.candidates[0].content.parts[0].text;
}

async function ambilSemuaData() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:F`,
  });
  return res.data.values || [];
}

function getTanggal() {
  return new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getBulanIni() {
  return new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    month: "long", year: "numeric",
  });
}

function formatRupiah(angka) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency", currency: "IDR", minimumFractionDigits: 0,
  }).format(angka);
}

async function simpanKeSheets(data) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:F`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        getTanggal(),
        data.deskripsi,
        data.kategori,
        data.tipe.charAt(0).toUpperCase() + data.tipe.slice(1),
        data.jumlah,
        data.dompet || "Cash",
      ]],
    },
  });
}

async function handleStart(chatId) {
  const pesan =
    `Halo! 👋 Aku bot pencatat keuangan kamu.\n\n` +
    `📝 *Catat transaksi* — ketik bebas, contoh:\n` +
    `💸 makan siang 25rb\n` +
    `💸 bensin 50rb pakai BCA\n` +
    `💰 gaji masuk 3jt ke BSI\n\n` +
    `📊 *Command tersedia:*\n` +
    `/saldo — cek saldo & ringkasan hari ini\n` +
    `/laporan — laporan lengkap bulan ini\n` +
    `/hapus — batalkan transaksi terakhir\n` +
    `/help — tampilkan pesan ini lagi`;
  bot.sendMessage(chatId, pesan, { parse_mode: "Markdown" });
}

function parseJumlah(str) {
  if (!str) return 0;
  const bersih = str.toString().replace(/Rp/gi, "").replace(/\./g, "").replace(/,/g, "").trim();
  return parseFloat(bersih) || 0;
}

async function handleSaldo(chatId) {
  bot.sendChatAction(chatId, "typing");
  const rows = await ambilSemuaData();
  const data = rows.filter(r => r[3] && (r[3] === "Pemasukan" || r[3] === "Pengeluaran"));

  let totalMasuk = 0, totalKeluar = 0;
  let hariIniMasuk = 0, hariIniKeluar = 0;

  const hariIniStr = new Date().toLocaleDateString("id-ID", {
    timeZone: "Asia/Jakarta", day: "2-digit", month: "2-digit", year: "numeric"
  });

  for (const r of data) {
    const jumlah = parseJumlah(r[4]);
    const tipe = r[3];
    const tanggalRow = r[0] ? r[0].split(",")[0].trim() : "";

    // Cek apakah tanggal row mengandung tanggal hari ini
    const isHariIni = r[0] && r[0].includes(hariIniStr.split("/").reverse().join("/") ) || 
                      r[0] && r[0].includes(hariIniStr);

    if (tipe === "Pemasukan") {
      totalMasuk += jumlah;
      if (isHariIni) hariIniMasuk += jumlah;
    } else {
      totalKeluar += jumlah;
      if (isHariIni) hariIniKeluar += jumlah;
    }
  }

  const saldo = totalMasuk - totalKeluar;
  const saldoIcon = saldo >= 0 ? "🟢" : "🔴";

  const pesan =
    `💰 *Saldo Kamu*\n\n` +
    `${saldoIcon} *Saldo saat ini: ${formatRupiah(saldo)}*\n\n` +
    `📅 *Hari ini:*\n` +
    `⬆️ Masuk: ${formatRupiah(hariIniMasuk)}\n` +
    `⬇️ Keluar: ${formatRupiah(hariIniKeluar)}\n\n` +
    `📊 *Semua waktu:*\n` +
    `⬆️ Total masuk: ${formatRupiah(totalMasuk)}\n` +
    `⬇️ Total keluar: ${formatRupiah(totalKeluar)}\n` +
    `📝 Total transaksi: ${data.length}`;

  bot.sendMessage(chatId, pesan, { parse_mode: "Markdown" });
}

async function handleLaporan(chatId) {
  bot.sendChatAction(chatId, "typing");
  const rows = await ambilSemuaData();
  const data = rows.filter(r => r[3] && (r[3] === "Pemasukan" || r[3] === "Pengeluaran"));

  const sekarang = new Date();
  const bulanIni = sekarang.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", month: "long" });
  const tahunIni = sekarang.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", year: "numeric" });

  const dataBulan = data.filter(r => r[0] && r[0].includes(bulanIni) && r[0].includes(tahunIni));

  if (dataBulan.length === 0) {
    return bot.sendMessage(chatId, `📊 Belum ada transaksi di ${getBulanIni()} ini.`);
  }

  const kategoriKeluar = {};
  const dompetSummary = {};
  let totalMasuk = 0, totalKeluar = 0;

  for (const r of dataBulan) {
    const jumlah = parseJumlah(r[4]);
    const tipe = r[3];
    const kategori = r[2] || "Lainnya";
    const dompet = r[5] || "Cash";

    if (tipe === "Pemasukan") {
      totalMasuk += jumlah;
    } else {
      totalKeluar += jumlah;
      kategoriKeluar[kategori] = (kategoriKeluar[kategori] || 0) + jumlah;
    }
    dompetSummary[dompet] = (dompetSummary[dompet] || 0) + (tipe === "Pemasukan" ? jumlah : -jumlah);
  }

  const kategoriUrut = Object.entries(kategoriKeluar).sort((a, b) => b[1] - a[1]);
  let rincianKategori = "";
  for (const [kat, jml] of kategoriUrut) {
    const persen = totalKeluar > 0 ? Math.round((jml / totalKeluar) * 100) : 0;
    rincianKategori += `  • ${kat}: ${formatRupiah(jml)} (${persen}%)\n`;
  }

  let rincianDompet = "";
  for (const [dompet, saldo] of Object.entries(dompetSummary)) {
    const icon = saldo >= 0 ? "🟢" : "🔴";
    rincianDompet += `  ${icon} ${dompet}: ${formatRupiah(Math.abs(saldo))} ${saldo >= 0 ? "surplus" : "defisit"}\n`;
  }

  const saldo = totalMasuk - totalKeluar;
  const saldoIcon = saldo >= 0 ? "🟢" : "🔴";

  const pesan =
    `📊 *Laporan ${getBulanIni()}*\n\n` +
    `⬆️ Total pemasukan: ${formatRupiah(totalMasuk)}\n` +
    `⬇️ Total pengeluaran: ${formatRupiah(totalKeluar)}\n` +
    `${saldoIcon} Selisih: ${formatRupiah(saldo)}\n\n` +
    `🗂 *Rincian pengeluaran:*\n${rincianKategori}\n` +
    `👛 *Per dompet:*\n${rincianDompet}\n` +
    `📝 Total transaksi: ${dataBulan.length}`;

  bot.sendMessage(chatId, pesan, { parse_mode: "Markdown" });
}

async function handleHapus(chatId) {
  bot.sendChatAction(chatId, "typing");
  const rows = await ambilSemuaData();

  let lastRowIndex = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][3] === "Pemasukan" || rows[i][3] === "Pengeluaran") {
      lastRowIndex = i;
      break;
    }
  }

  if (lastRowIndex === -1) {
    return bot.sendMessage(chatId, "Tidak ada transaksi yang bisa dihapus.");
  }

  const lastRow = rows[lastRowIndex];
  const sheetRowNumber = lastRowIndex + 1;

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A${sheetRowNumber}:F${sheetRowNumber}`,
  });

  const pesan =
    `🗑 *Transaksi terakhir dihapus!*\n\n` +
    `📅 ${lastRow[0]}\n` +
    `📝 ${lastRow[1]}\n` +
    `📁 ${lastRow[2]}\n` +
    `👛 ${lastRow[5] || "Cash"}\n` +
    `💵 ${formatRupiah(parseJumlah(lastRow[4]))}`;

  bot.sendMessage(chatId, pesan, { parse_mode: "Markdown" });
}
async function handleDebug(chatId) {
  const rows = await ambilSemuaData();
  
  if (rows.length === 0) {
    return bot.sendMessage(chatId, "Sheets kosong, tidak ada data sama sekali.");
  }

  // Tampilkan 3 baris pertama data mentah
  let pesan = `🔍 *Debug Data*\n\nTotal baris: ${rows.length}\n\n`;
  
  const sample = rows.slice(0, 3);
  for (let i = 0; i < sample.length; i++) {
    const r = sample[i];
    pesan += `*Baris ${i + 1}:*\n`;
    pesan += `A: \`${r[0]}\`\n`;
    pesan += `B: \`${r[1]}\`\n`;
    pesan += `C: \`${r[2]}\`\n`;
    pesan += `D: \`${r[3]}\`\n`;
    pesan += `E: \`${r[4]}\`\n`;
    pesan += `F: \`${r[5]}\`\n\n`;
  }

  // Cek filter
  const filtered = rows.filter(r => r[3] && (r[3] === "Pemasukan" || r[3] === "Pengeluaran"));
  pesan += `Filter hasil: ${filtered.length} baris lolos\n`;

  if (filtered[0]) {
    const jumlah = parseFloat(filtered[0][4]);
    pesan += `Jumlah baris pertama: \`${filtered[0][4]}\` → parsed: \`${jumlah}\``;
  }

  bot.sendMessage(chatId, pesan, { parse_mode: "Markdown" });
}

// ============================================================
// MAIN
// ============================================================

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const teks = msg.text;

  if (!teks) return;

  if (teks === "/start" || teks === "/help") return handleStart(chatId);
  if (teks === "/saldo") return handleSaldo(chatId);
  if (teks === "/debug") return handleDebug(chatId);
  if (teks === "/laporan") return handleLaporan(chatId);
  if (teks === "/hapus") return handleHapus(chatId);

  bot.sendChatAction(chatId, "typing");

  try {
    const raw = await tanyaGemini(teks);
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    if (parsed.error) {
      return bot.sendMessage(chatId, parsed.balasan);
    }

    await simpanKeSheets(parsed);

    const tipeIcon = parsed.tipe === "pemasukan" ? "💰" : "💸";
    const balasan =
      `${tipeIcon} *Tercatat!*\n\n` +
      `${parsed.emoji} ${parsed.deskripsi}\n` +
      `📁 Kategori: ${parsed.kategori}\n` +
      `📊 Tipe: ${parsed.tipe.charAt(0).toUpperCase() + parsed.tipe.slice(1)}\n` +
      `👛 Dompet: ${parsed.dompet || "Cash"}\n` +
      `💵 Jumlah: ${formatRupiah(parsed.jumlah)}\n\n` +
      `_${parsed.balasan}_`;

    bot.sendMessage(chatId, balasan, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Error:", err.message);
    bot.sendMessage(chatId, "Maaf, ada kendala teknis. Coba kirim ulang ya! 🙏");
  }
});

console.log("🤖 Bot keuangan v3 aktif — dengan kolom dompet & format tanggal baru!");
