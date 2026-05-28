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
    `/riwayat — lihat 10 transaksi terakhir\n` +
    `/grafik — pie chart pengeluaran per kategori\n` +
    `/grafikmingguan — bar chart pemasukan vs pengeluaran\n` +
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

  // Ambil hari, bulan, tahun hari ini dalam bahasa Indonesia
  const sekarang = new Date();
  const hariIniTgl = sekarang.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "numeric" });
  const hariIniBulan = sekarang.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", month: "long" });
  const hariIniTahun = sekarang.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", year: "numeric" });

  for (const r of data) {
    const jumlah = parseJumlah(r[4]);
    const tipe = r[3];
    const tanggalRow = r[0] || "";

    // Format di Sheets: "Kamis, 28 Mei 2026 pukul 18.57"
    // Cukup cek apakah mengandung tanggal + bulan + tahun hari ini
    const isHariIni =
      tanggalRow.includes(hariIniTgl) &&
      tanggalRow.includes(hariIniBulan) &&
      tanggalRow.includes(hariIniTahun);

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
  const data = rows.filter(r => r[3] && (r[3] === "Pemasukan" || r[3] === "Pengeluaran"));

  if (data.length === 0) {
    return bot.sendMessage(chatId, "Belum ada transaksi tercatat.");
  }

  // Ambil 10 terakhir, dibalik biar yang terbaru di atas
  const sepuluhTerakhir = data.slice(-10).reverse();

  let pesan = `🕐 *10 Transaksi Terakhir*\n\n`;
  for (const r of sepuluhTerakhir) {
    const tipe = r[3];
    const icon = tipe === "Pemasukan" ? "⬆️" : "⬇️";
    const jumlah = parseJumlah(r[4]);
    const dompet = r[5] || "Cash";
    pesan += `${icon} *${r[1]}*\n`;
    pesan += `    💵 ${formatRupiah(jumlah)} • 📁 ${r[2]} • 👛 ${dompet}\n`;
    pesan += `    🕐 ${r[0]}\n\n`;
  }

  bot.sendMessage(chatId, pesan, { parse_mode: "Markdown" });
}

// Simpan data transaksi yang mau dihapus sementara (per user)
const hapusPending = {};

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

  // Simpan dulu index-nya, tunggu konfirmasi
  hapusPending[chatId] = lastRowIndex;

  const pesan =
    `🗑 *Hapus transaksi ini?*\n\n` +
    `📅 ${lastRow[0]}\n` +
    `📝 ${lastRow[1]}\n` +
    `📁 ${lastRow[2]}\n` +
    `👛 ${lastRow[5] || "Cash"}\n` +
    `💵 ${formatRupiah(parseJumlah(lastRow[4]))}`;

  // Kirim dengan tombol Ya / Tidak
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

// Handle tombol konfirmasi
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
      range: `${SHEET_NAME}!A${sheetRowNumber}:F${sheetRowNumber}`,
    });

    delete hapusPending[chatId];
    bot.answerCallbackQuery(query.id);
    bot.editMessageText(
      `✅ *Transaksi berhasil dihapus!*\n\n` +
      `📝 ${lastRow[1]}\n` +
      `💵 ${formatRupiah(parseJumlah(lastRow[4]))}`,
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
  const data = rows.filter(r => r[3] && (r[3] === "Pemasukan" || r[3] === "Pengeluaran"));

  const sekarang = new Date();
  const bulanIni = sekarang.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", month: "long" });
  const tahunIni = sekarang.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", year: "numeric" });

  const dataBulan = data.filter(r => r[0] && r[0].includes(bulanIni) && r[0].includes(tahunIni));
  const pengeluaran = dataBulan.filter(r => r[3] === "Pengeluaran");

  if (pengeluaran.length === 0) {
    return bot.sendMessage(chatId, `📊 Belum ada pengeluaran di ${bulanIni} ${tahunIni}.`);
  }

  // Hitung per kategori
  const kategori = {};
  for (const r of pengeluaran) {
    const kat = r[2] || "Lainnya";
    kategori[kat] = (kategori[kat] || 0) + parseJumlah(r[4]);
  }

  const labels = Object.keys(kategori);
  const values = Object.values(kategori);
  const total = values.reduce((a, b) => a + b, 0);

  // Warna untuk tiap slice
  const warna = [
    "#FF6384", "#36A2EB", "#FFCE56", "#4BC0C0",
    "#9966FF", "#FF9F40", "#E7E9ED", "#71B37C"
  ];

  const chartConfig = {
    type: "pie",
    data: {
      labels: labels.map((l, i) => `${l} (${Math.round(values[i] / total * 100)}%)`),
      datasets: [{
        data: values,
        backgroundColor: warna.slice(0, labels.length),
      }]
    },
    options: {
      title: {
        display: true,
        text: `Pengeluaran ${bulanIni} ${tahunIni}`,
        fontSize: 16,
      },
      legend: { position: "bottom" }
    }
  };

  const url = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=500&h=400&bkg=white`;

  await bot.sendPhoto(chatId, url, {
    caption: `🥧 *Pengeluaran ${bulanIni} ${tahunIni} per Kategori*\nTotal: ${formatRupiah(total)}`,
    parse_mode: "Markdown"
  });
}

async function handleGrafikMingguan(chatId) {
  bot.sendChatAction(chatId, "upload_photo");
  const rows = await ambilSemuaData();
  const data = rows.filter(r => r[3] && (r[3] === "Pemasukan" || r[3] === "Pengeluaran"));

  const sekarang = new Date();
  const bulanIni = sekarang.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", month: "long" });
  const tahunIni = sekarang.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", year: "numeric" });

  const dataBulan = data.filter(r => r[0] && r[0].includes(bulanIni) && r[0].includes(tahunIni));

  if (dataBulan.length === 0) {
    return bot.sendMessage(chatId, `📊 Belum ada transaksi di ${bulanIni} ${tahunIni}.`);
  }

  // Kelompokkan per minggu (Minggu 1-5)
  const minggu = { "Minggu 1": [0,0], "Minggu 2": [0,0], "Minggu 3": [0,0], "Minggu 4": [0,0] };

  for (const r of dataBulan) {
    if (!r[0]) continue;
    // Ambil tanggal dari format "Kamis, 28 Mei 2026 pukul 18.57"
    const matches = r[0].match(/(\d+)\s+\w+\s+\d{4}/);
    if (!matches) continue;
    const tgl = parseInt(matches[0]);
    const jumlah = parseJumlah(r[4]);
    const tipe = r[3];

    let mgg;
    if (tgl <= 7) mgg = "Minggu 1";
    else if (tgl <= 14) mgg = "Minggu 2";
    else if (tgl <= 21) mgg = "Minggu 3";
    else mgg = "Minggu 4";

    if (tipe === "Pemasukan") minggu[mgg][0] += jumlah;
    else minggu[mgg][1] += jumlah;
  }

  const labels = Object.keys(minggu);
  const pemasukan = labels.map(m => minggu[m][0]);
  const pengeluaran = labels.map(m => minggu[m][1]);

  const chartConfig = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Pemasukan",
          data: pemasukan,
          backgroundColor: "#4BC0C0",
        },
        {
          label: "Pengeluaran",
          data: pengeluaran,
          backgroundColor: "#FF6384",
        }
      ]
    },
    options: {
      title: {
        display: true,
        text: `Pemasukan vs Pengeluaran ${bulanIni} ${tahunIni}`,
        fontSize: 16,
      },
      scales: {
        yAxes: [{ ticks: { beginAtZero: true } }]
      },
      legend: { position: "bottom" }
    }
  };

  const url = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=500&h=400&bkg=white`;

  await bot.sendPhoto(chatId, url, {
    caption: `📊 *Pemasukan vs Pengeluaran per Minggu*\n${bulanIni} ${tahunIni}`,
    parse_mode: "Markdown"
  });
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
  if (teks === "/riwayat") return handleRiwayat(chatId);
  if (teks === "/grafik") return handleGrafikKategori(chatId);
  if (teks === "/grafikmingguan") return handleGrafikMingguan(chatId);

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
