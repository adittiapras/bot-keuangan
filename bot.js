const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");

// ============================================================
// KONFIGURASI
// ============================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SHEET_NAME = "Catatan";
// ============================================================

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const PROMPT_TEMPLATE = `Kamu adalah AI parser transaksi keuangan. User mengirim pesan singkat berisi transaksi keuangan dalam bahasa Indonesia sehari-hari.

Tugasmu: ekstrak informasi dan balas HANYA dengan JSON valid berikut (tanpa markdown, tanpa teks tambahan apapun):

{"tipe":"pengeluaran"|"pemasukan"|"transfer","kategori":"string","jumlah":angka_numerik,"deskripsi":"string singkat","emoji":"1 emoji relevan","dompet":"string","dompet_tujuan":"string","balasan":"string respons singkat ramah dalam bahasa Indonesia"}

Panduan kategori:
- Pengeluaran: Makanan, Transport, Belanja, Kesehatan, Hiburan, Tagihan, Lainnya
- Pemasukan: Gaji, Bisnis, Transfer, Investasi, Lainnya

Panduan dompet:
- Jika user menyebut "cash", "tunai", "dompet" → isi "Cash"
- Jika user menyebut nama bank atau e-wallet (BCA, BSI, BRI, BNI, Mandiri, GoPay, OVO, Dana, ShopeePay, dll) → isi nama tersebut
- Jika tidak disebutkan sama sekali → isi "Cash"

Panduan transfer:
- Jika user menyebut transfer/pindah uang dari satu dompet ke dompet lain → tipe "transfer"
- "dompet" = dompet asal (yang berkurang)
- "dompet_tujuan" = dompet tujuan (yang bertambah)
- Untuk transaksi biasa (bukan transfer), "dompet_tujuan" = ""
- Contoh: "transfer bsi ke seabank 2jt" → dompet="BSI", dompet_tujuan="Seabank", tipe="transfer"

Aturan jumlah:
- rb / ribu = x1.000 (contoh: 25rb = 25000)
- jt / juta = x1.000.000 (contoh: 3jt = 3000000)
- k = x1.000 (contoh: 10k = 10000)
- Angka tanpa satuan = nilai aslinya (contoh: 50000 = 50000)

Jika pesan tidak ada hubungannya dengan transaksi keuangan, balas dengan:
{"error":"bukan transaksi","balasan":"Halo! Kirim transaksi kamu ya, contoh: makan siang 25rb atau gaji masuk 3jt 😊"}

Pesan user: `;

// ============================================================
// HELPER FUNCTIONS
// ============================================================

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

function getTanggalParts() {
  const sekarang = new Date();
  const tanggal = sekarang.toLocaleDateString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit", month: "2-digit", year: "numeric"
  });
  const jam = sekarang.toLocaleTimeString("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit", minute: "2-digit"
  });
  const hari = sekarang.toLocaleDateString("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long"
  });
  return { tanggal, jam, hari };
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

function parseJumlah(str) {
  if (!str) return 0;
  const bersih = str.toString().replace(/Rp/gi, "").replace(/\./g, "").replace(/,/g, "").trim();
  return parseFloat(bersih) || 0;
}

// Kolom: A=0:tanggal, B=1:jam, C=2:hari, D=3:deskripsi, E=4:kategori, F=5:tipe, G=6:jumlah, H=7:dompet
function isValid(r) {
  return r[5] && (r[5] === "Pemasukan" || r[5] === "Pengeluaran");
}

async function ambilSemuaData() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:H`,
  });
  return res.data.values || [];
}

async function simpanKeSheets(data) {
  const { tanggal, jam, hari } = getTanggalParts();

  let rows;

  if (data.tipe === "transfer") {
    // Catat 2 baris: keluar dari dompet asal, masuk ke dompet tujuan
    rows = [
      [
        tanggal, jam, hari,
        `Transfer ke ${data.dompet_tujuan}`,
        "Transfer",
        "Transfer Keluar",
        data.jumlah,
        data.dompet,
      ],
      [
        tanggal, jam, hari,
        `Transfer dari ${data.dompet}`,
        "Transfer",
        "Transfer Masuk",
        data.jumlah,
        data.dompet_tujuan,
      ]
    ];
  } else {
    rows = [[
      tanggal, jam, hari,
      data.deskripsi,
      data.kategori,
      data.tipe.charAt(0).toUpperCase() + data.tipe.slice(1),
      data.jumlah,
      data.dompet || "Cash",
    ]];
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:H`,
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });
}

const hapusPending = {};

// ============================================================
// COMMAND HANDLERS
// ============================================================

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
    `/riwayat — lihat 10 transaksi terakhir\n` +
    `/grafik — pie chart pengeluaran per kategori\n` +
    `/grafikmingguan — bar chart pemasukan vs pengeluaran\n` +
    `/hapus — batalkan transaksi terakhir\n` +
    `/help — tampilkan pesan ini lagi`;
  bot.sendMessage(chatId, pesan, { parse_mode: "Markdown" });
}

async function handleSaldo(chatId) {
  bot.sendChatAction(chatId, "typing");
  const rows = await ambilSemuaData();
  const data = rows.filter(r => isValid(r));

  let totalMasuk = 0, totalKeluar = 0;
  let hariIniMasuk = 0, hariIniKeluar = 0;

  const hariIniStr = new Date().toLocaleDateString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit", month: "2-digit", year: "numeric"
  });

  for (const r of data) {
    const jumlah = parseJumlah(r[6]);
    const tipe = r[5];
    const isHariIni = r[0] === hariIniStr;

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
    `📅 *Hari ini (${hariIniStr}):*\n` +
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
  const data = rows.filter(r => isValid(r));

  const sekarang = new Date();
  const bulanIni = sekarang.getMonth() + 1;
  const tahunIni = sekarang.getFullYear();

  const dataBulan = data.filter(r => {
    if (!r[0]) return false;
    const parts = r[0].split("/");
    return parseInt(parts[1]) === bulanIni && parseInt(parts[2]) === tahunIni;
  });

  if (dataBulan.length === 0) {
    return bot.sendMessage(chatId, `📊 Belum ada transaksi di ${getBulanIni()} ini.`);
  }

  const kategoriKeluar = {};
  const dompetSummary = {};
  let totalMasuk = 0, totalKeluar = 0;

  for (const r of dataBulan) {
    const jumlah = parseJumlah(r[6]);
    const tipe = r[5];
    const kategori = r[4] || "Lainnya";
    const dompet = r[7] || "Cash";

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
    const jumlahStr = saldo >= 0 ? formatRupiah(saldo) : `-${formatRupiah(Math.abs(saldo))}`;
    rincianDompet += `  ${icon} ${dompet}: ${jumlahStr}\n`;
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

async function handleRiwayat(chatId) {
  bot.sendChatAction(chatId, "typing");
  const rows = await ambilSemuaData();
  const data = rows.filter(r => isValid(r));

  if (data.length === 0) {
    return bot.sendMessage(chatId, "Belum ada transaksi tercatat.");
  }

  const sepuluhTerakhir = data.slice(-10).reverse();

  let pesan = `🕐 *10 Transaksi Terakhir*\n\n`;
  for (const r of sepuluhTerakhir) {
    const tipe = r[5];
    const icon = tipe === "Pemasukan" ? "⬆️" : "⬇️";
    const jumlah = parseJumlah(r[6]);
    const dompet = r[7] || "Cash";
    pesan += `${icon} *${r[3]}*\n`;
    pesan += `    💵 ${formatRupiah(jumlah)} • 📁 ${r[4]} • 👛 ${dompet}\n`;
    pesan += `    🕐 ${r[0]} ${r[1]} (${r[2]})\n\n`;
  }

  bot.sendMessage(chatId, pesan, { parse_mode: "Markdown" });
}

async function handleHapus(chatId) {
  bot.sendChatAction(chatId, "typing");
  const rows = await ambilSemuaData();

  let lastRowIndex = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isValid(rows[i])) { lastRowIndex = i; break; }
  }

  if (lastRowIndex === -1) {
    return bot.sendMessage(chatId, "Tidak ada transaksi yang bisa dihapus.");
  }

  const lastRow = rows[lastRowIndex];
  hapusPending[chatId] = lastRowIndex;

  const pesan =
    `🗑 *Hapus transaksi ini?*\n\n` +
    `📅 ${lastRow[0]} ${lastRow[1]} (${lastRow[2]})\n` +
    `📝 ${lastRow[3]}\n` +
    `📁 ${lastRow[4]}\n` +
    `👛 ${lastRow[7] || "Cash"}\n` +
    `💵 ${formatRupiah(parseJumlah(lastRow[6]))}`;

  bot.sendMessage(chatId, pesan, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Ya, hapus", callback_data: "hapus_ya" },
        { text: "❌ Tidak", callback_data: "hapus_tidak" }
      ]]
    }
  });
}

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  if (query.data === "hapus_ya") {
    const lastRowIndex = hapusPending[chatId];

    if (lastRowIndex === undefined) {
      bot.answerCallbackQuery(query.id);
      return bot.editMessageText("⚠️ Sesi hapus sudah kedaluwarsa, coba /hapus lagi.", {
        chat_id: chatId, message_id: messageId
      });
    }

    const rows = await ambilSemuaData();
    const lastRow = rows[lastRowIndex];
    const sheetRowNumber = lastRowIndex + 1;

    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A${sheetRowNumber}:H${sheetRowNumber}`,
    });

    delete hapusPending[chatId];
    bot.answerCallbackQuery(query.id);
    bot.editMessageText(
      `✅ *Transaksi berhasil dihapus!*\n\n` +
      `📝 ${lastRow[3]}\n` +
      `💵 ${formatRupiah(parseJumlah(lastRow[6]))}`,
      { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" }
    );

  } else if (query.data === "hapus_tidak") {
    delete hapusPending[chatId];
    bot.answerCallbackQuery(query.id);
    bot.editMessageText("👍 Oke, transaksi tidak jadi dihapus.", {
      chat_id: chatId, message_id: messageId
    });
  }
});

async function handleGrafikKategori(chatId) {
  bot.sendChatAction(chatId, "upload_photo");
  const rows = await ambilSemuaData();
  const data = rows.filter(r => isValid(r));

  const sekarang = new Date();
  const bulanIni = sekarang.getMonth() + 1;
  const tahunIni = sekarang.getFullYear();

  const pengeluaran = data.filter(r => {
    if (!r[0]) return false;
    const parts = r[0].split("/");
    return r[5] === "Pengeluaran" &&
      parseInt(parts[1]) === bulanIni &&
      parseInt(parts[2]) === tahunIni;
  });

  if (pengeluaran.length === 0) {
    return bot.sendMessage(chatId, `📊 Belum ada pengeluaran di ${getBulanIni()} ini.`);
  }

  const kategori = {};
  for (const r of pengeluaran) {
    const kat = r[4] || "Lainnya";
    kategori[kat] = (kategori[kat] || 0) + parseJumlah(r[6]);
  }

  const labels = Object.keys(kategori);
  const values = Object.values(kategori);
  const total = values.reduce((a, b) => a + b, 0);
  const warna = ["#FF6384","#36A2EB","#FFCE56","#4BC0C0","#9966FF","#FF9F40","#E7E9ED","#71B37C"];

  const chartConfig = {
    type: "pie",
    data: {
      labels: labels.map((l, i) => `${l} (${Math.round(values[i] / total * 100)}%)`),
      datasets: [{ data: values, backgroundColor: warna.slice(0, labels.length) }]
    },
    options: {
      title: { display: true, text: `Pengeluaran ${getBulanIni()}`, fontSize: 16 },
      legend: { position: "bottom" }
    }
  };

  const url = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=500&h=400&bkg=white`;
  await bot.sendPhoto(chatId, url, {
    caption: `🥧 *Pengeluaran ${getBulanIni()} per Kategori*\nTotal: ${formatRupiah(total)}`,
    parse_mode: "Markdown"
  });
}

async function handleGrafikMingguan(chatId) {
  bot.sendChatAction(chatId, "upload_photo");
  const rows = await ambilSemuaData();
  const data = rows.filter(r => isValid(r));

  const sekarang = new Date();
  const bulanIni = sekarang.getMonth() + 1;
  const tahunIni = sekarang.getFullYear();

  const dataBulan = data.filter(r => {
    if (!r[0]) return false;
    const parts = r[0].split("/");
    return parseInt(parts[1]) === bulanIni && parseInt(parts[2]) === tahunIni;
  });

  if (dataBulan.length === 0) {
    return bot.sendMessage(chatId, `📊 Belum ada transaksi di ${getBulanIni()} ini.`);
  }

  const minggu = {
    "Minggu 1": [0, 0], "Minggu 2": [0, 0],
    "Minggu 3": [0, 0], "Minggu 4": [0, 0]
  };

  for (const r of dataBulan) {
    const tgl = parseInt(r[0].split("/")[0]);
    const jumlah = parseJumlah(r[6]);
    const tipe = r[5];
    let mgg;
    if (tgl <= 7) mgg = "Minggu 1";
    else if (tgl <= 14) mgg = "Minggu 2";
    else if (tgl <= 21) mgg = "Minggu 3";
    else mgg = "Minggu 4";

    if (tipe === "Pemasukan") minggu[mgg][0] += jumlah;
    else minggu[mgg][1] += jumlah;
  }

  const labels = Object.keys(minggu);
  const chartConfig = {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Pemasukan", data: labels.map(m => minggu[m][0]), backgroundColor: "#4BC0C0" },
        { label: "Pengeluaran", data: labels.map(m => minggu[m][1]), backgroundColor: "#FF6384" }
      ]
    },
    options: {
      title: { display: true, text: `Pemasukan vs Pengeluaran ${getBulanIni()}`, fontSize: 16 },
      scales: { yAxes: [{ ticks: { beginAtZero: true } }] },
      legend: { position: "bottom" }
    }
  };

  const url = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=500&h=400&bkg=white`;
  await bot.sendPhoto(chatId, url, {
    caption: `📊 *Pemasukan vs Pengeluaran per Minggu*\n${getBulanIni()}`,
    parse_mode: "Markdown"
  });
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
  if (teks === "/laporan") return handleLaporan(chatId);
  if (teks === "/riwayat") return handleRiwayat(chatId);
  if (teks === "/grafik") return handleGrafikKategori(chatId);
  if (teks === "/grafikmingguan") return handleGrafikMingguan(chatId);
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

let balasan;
if (parsed.tipe === "transfer") {
  balasan =
    `🔄 *Transfer Tercatat!*\n\n` +
    `👛 Dari: ${parsed.dompet}\n` +
    `👛 Ke: ${parsed.dompet_tujuan}\n` +
    `💵 Jumlah: ${formatRupiah(parsed.jumlah)}\n\n` +
    `_${parsed.balasan}_`;
  } else {
    const tipeIcon = parsed.tipe === "pemasukan" ? "💰" : "💸";
    balasan =
      `${tipeIcon} *Tercatat!*\n\n` +
      `${parsed.emoji} ${parsed.deskripsi}\n` +
      `📁 Kategori: ${parsed.kategori}\n` +
      `📊 Tipe: ${parsed.tipe.charAt(0).toUpperCase() + parsed.tipe.slice(1)}\n` +
      `👛 Dompet: ${parsed.dompet || "Cash"}\n` +
      `💵 Jumlah: ${formatRupiah(parsed.jumlah)}\n\n` +
      `_${parsed.balasan}_`;
  }
  
  bot.sendMessage(chatId, balasan, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Error:", err.message);
    bot.sendMessage(chatId, "Maaf, ada kendala teknis. Coba kirim ulang ya! 🙏");
  }
});

console.log("🤖 Bot keuangan v4 aktif!");
