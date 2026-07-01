const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");

// ============================================================
// KONFIGURASI
// ============================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
// ============================================================

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const PROMPT_TEMPLATE = `Kamu adalah AI parser transaksi keuangan. User mengirim pesan singkat berisi transaksi keuangan dalam bahasa Indonesia sehari-hari.

Tugasmu: ekstrak informasi dan balas HANYA dengan JSON valid berikut (tanpa markdown, tanpa teks tambahan apapun):

Untuk transaksi biasa:
{"tipe":"pengeluaran"|"pemasukan","kategori":"string","jumlah":angka_numerik,"deskripsi":"string singkat","emoji":"1 emoji relevan","dompet":"string","dompet_tujuan":"","tanggal":"string|null","balasan":"string respons singkat ramah dalam bahasa Indonesia"}

Untuk transfer antar dompet:
{"tipe":"transfer","kategori":"Transfer","jumlah":angka_numerik,"deskripsi":"string singkat","emoji":"🔄","dompet":"string nama dompet asal","dompet_tujuan":"string nama dompet tujuan","tanggal":"string|null","balasan":"string respons singkat ramah dalam bahasa Indonesia"}

Panduan kategori transaksi biasa:
- Pengeluaran: Makanan, Transport, Belanja, Kesehatan, Hiburan, Tagihan, Lainnya
- Pemasukan: Gaji, Bisnis, Transfer, Investasi, Lainnya

Panduan dompet:
- Jika user menyebut "cash", "tunai", "dompet" → isi "Cash"
- Jika user menyebut nama bank atau e-wallet (BCA, BSI, BRI, BNI, Mandiri, GoPay, OVO, Dana, ShopeePay, Seabank, Jago, Krom, dll) → isi nama tersebut
- Jika tidak disebutkan sama sekali → isi "Cash"

Panduan transfer:
- Jika user menyebut transfer/pindah/alokasi uang dari satu dompet ke dompet lain → tipe "transfer"
- "dompet" = dompet asal, "dompet_tujuan" = dompet tujuan
- Untuk transaksi biasa → "dompet_tujuan" = ""

Panduan tanggal:
- Jika user menyebut tanggal spesifik → isi "tanggal" dengan format DD/MM/YYYY
- Jika user menyebut "kemarin" → isi "tanggal" dengan "kemarin"
- Jika user menyebut "2 hari lalu", "3 hari lalu" dst → isi "tanggal" dengan "X hari lalu" (X = angkanya)
- Jika tidak ada info tanggal → isi "tanggal" dengan null

Aturan jumlah:
- rb / ribu = x1.000
- jt / juta = x1.000.000
- k = x1.000
- Angka tanpa satuan = nilai aslinya

Jika pesan tidak ada hubungannya dengan transaksi keuangan, balas dengan:
{"error":"bukan transaksi","balasan":"Halo! Kirim transaksi kamu ya, contoh: makan siang 25rb atau gaji masuk 3jt 😊"}`;

// ============================================================
// HELPER FUNCTIONS
// ============================================================

async function tanyaAI(teks) {
  const url = `https://api.groq.com/openai/v1/chat/completions`;
  const body = {
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: PROMPT_TEMPLATE },
      { role: "user", content: teks }
    ],
    temperature: 0.1,
    max_tokens: 300
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Groq error ${res.status}: ${JSON.stringify(data)}`);
  return data.choices[0].message.content;
}

// Hitung tanggal dari input AI
function hitungTanggal(tanggalStr) {
  const sekarang = new Date();
  const tz = { timeZone: "Asia/Jakarta" };

  if (!tanggalStr) return sekarang;

  if (tanggalStr === "kemarin") {
    const kemarin = new Date(sekarang);
    kemarin.setDate(kemarin.getDate() - 1);
    return kemarin;
  }

  // "X hari lalu"
  const hariLaluMatch = tanggalStr.match(/(\d+)\s*hari\s*lalu/i);
  if (hariLaluMatch) {
    const xHariLalu = new Date(sekarang);
    xHariLalu.setDate(xHariLalu.getDate() - parseInt(hariLaluMatch[1]));
    return xHariLalu;
  }

  // Format DD/MM/YYYY
  const formatMatch = tanggalStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (formatMatch) {
    return new Date(`${formatMatch[3]}-${formatMatch[2]}-${formatMatch[1]}`);
  }

  // Format "28 juni" atau "28 juni 2026"
  const bulanMap = {
    januari: 0, februari: 1, maret: 2, april: 3, mei: 4, juni: 5,
    juli: 6, agustus: 7, september: 8, oktober: 9, november: 10, desember: 11
  };
  const tglBulanMatch = tanggalStr.match(/(\d{1,2})\s+(\w+)(?:\s+(\d{4}))?/i);
  if (tglBulanMatch) {
    const tgl = parseInt(tglBulanMatch[1]);
    const bulan = bulanMap[tglBulanMatch[2].toLowerCase()];
    const tahun = tglBulanMatch[3] ? parseInt(tglBulanMatch[3]) : sekarang.getFullYear();
    if (bulan !== undefined) {
      return new Date(tahun, bulan, tgl);
    }
  }

  return sekarang;
}

// Dapatkan nama sheet bulan dari tanggal
function getNamaSheet(tanggal) {
  return tanggal.toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    month: "long",
    year: "numeric"
  });
}

// Dapatkan bagian tanggal
function getTanggalParts(tanggal) {
  const tgl = tanggal.toLocaleDateString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit", month: "2-digit", year: "numeric"
  });
  const jam = new Date().toLocaleTimeString("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit", minute: "2-digit"
  });
  const hari = tanggal.toLocaleDateString("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long"
  });
  return { tanggal: tgl, jam, hari };
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

function isValid(r) {
  return r[5] && ["Pemasukan", "Pengeluaran", "Transfer Masuk", "Transfer Keluar"].includes(r[5]);
}

function isTransfer(r) {
  return r[5] === "Transfer Masuk" || r[5] === "Transfer Keluar";
}

// Cek dan buat sheet bulan kalau belum ada
async function pastikanSheetAda(namaSheet) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID
  });

  const sheetSudahAda = spreadsheet.data.sheets.some(
    s => s.properties.title === namaSheet
  );

  if (!sheetSudahAda) {
    // Buat sheet baru
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{
          addSheet: {
            properties: { title: namaSheet }
          }
        }]
      }
    });

    // Tambah header
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${namaSheet}'!A1:I1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [["Tanggal", "Jam", "Hari", "Deskripsi", "Kategori", "Tipe", "Jumlah", "Dompet", "Transfer ID"]]
      }
    });

    console.log(`Sheet baru dibuat: ${namaSheet}`);
  }
}

async function ambilSemuaData(namaSheet) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${namaSheet}'!A:I`,
  });
  return res.data.values || [];
}

async function simpanKeSheets(data, tanggal) {
  const namaSheet = getNamaSheet(tanggal);
  await pastikanSheetAda(namaSheet);

  const { tanggal: tgl, jam, hari } = getTanggalParts(tanggal);

  let rows;
  if (data.tipe === "transfer") {
    const transferId = Date.now().toString();
    rows = [
      [tgl, jam, hari, `Transfer ke ${data.dompet_tujuan}`, "Transfer", "Transfer Keluar", data.jumlah, data.dompet, transferId],
      [tgl, jam, hari, `Transfer dari ${data.dompet}`, "Transfer", "Transfer Masuk", data.jumlah, data.dompet_tujuan, transferId],
    ];
  } else {
    rows = [[
      tgl, jam, hari,
      data.deskripsi,
      data.kategori,
      data.tipe.charAt(0).toUpperCase() + data.tipe.slice(1),
      data.jumlah,
      data.dompet || "Cash",
      "",
    ]];
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${namaSheet}'!A:I`,
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });

  return namaSheet;
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
    `💰 gaji masuk 3jt ke BSI\n` +
    `🔄 transfer BSI ke Seabank 1jt\n` +
    `📅 makan siang 25rb kemarin\n` +
    `📅 bensin 50rb 28 juni\n\n` +
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
  const namaSheet = getNamaSheet(new Date());

  try {
    await pastikanSheetAda(namaSheet);
    const rows = await ambilSemuaData(namaSheet);
    const data = rows.filter(r => r[5] === "Pemasukan" || r[5] === "Pengeluaran");

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
      `💰 *Saldo Kamu — ${namaSheet}*\n\n` +
      `${saldoIcon} *Saldo saat ini: ${formatRupiah(saldo)}*\n\n` +
      `📅 *Hari ini (${hariIniStr}):*\n` +
      `⬆️ Masuk: ${formatRupiah(hariIniMasuk)}\n` +
      `⬇️ Keluar: ${formatRupiah(hariIniKeluar)}\n\n` +
      `📊 *Bulan ini:*\n` +
      `⬆️ Total masuk: ${formatRupiah(totalMasuk)}\n` +
      `⬇️ Total keluar: ${formatRupiah(totalKeluar)}\n` +
      `📝 Total transaksi: ${data.length}`;

    bot.sendMessage(chatId, pesan, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Error handleSaldo:", err.message);
    bot.sendMessage(chatId, "Maaf, ada kendala teknis. Coba lagi ya! 🙏");
  }
}

async function handleLaporan(chatId) {
  bot.sendChatAction(chatId, "typing");
  const namaSheet = getNamaSheet(new Date());

  try {
    await pastikanSheetAda(namaSheet);
    const rows = await ambilSemuaData(namaSheet);
    const data = rows.filter(r => r[5] === "Pemasukan" || r[5] === "Pengeluaran");

    if (data.length === 0) {
      return bot.sendMessage(chatId, `📊 Belum ada transaksi di ${namaSheet} ini.`);
    }

    const kategoriKeluar = {};
    let totalMasuk = 0, totalKeluar = 0;

    for (const r of data) {
      const jumlah = parseJumlah(r[6]);
      const tipe = r[5];
      const kategori = r[4] || "Lainnya";

      if (tipe === "Pemasukan") {
        totalMasuk += jumlah;
      } else {
        totalKeluar += jumlah;
        kategoriKeluar[kategori] = (kategoriKeluar[kategori] || 0) + jumlah;
      }
    }

    const kategoriUrut = Object.entries(kategoriKeluar).sort((a, b) => b[1] - a[1]);
    let rincianKategori = "";
    for (const [kat, jml] of kategoriUrut) {
      const persen = totalKeluar > 0 ? Math.round((jml / totalKeluar) * 100) : 0;
      rincianKategori += `  • ${kat}: ${formatRupiah(jml)} (${persen}%)\n`;
    }

    const saldo = totalMasuk - totalKeluar;
    const saldoIcon = saldo >= 0 ? "🟢" : "🔴";

    const pesan =
      `📊 *Laporan ${namaSheet}*\n\n` +
      `⬆️ Total pemasukan: ${formatRupiah(totalMasuk)}\n` +
      `⬇️ Total pengeluaran: ${formatRupiah(totalKeluar)}\n` +
      `${saldoIcon} Selisih: ${formatRupiah(saldo)}\n\n` +
      `🗂 *Rincian pengeluaran:*\n${rincianKategori}\n` +
      `📝 Total transaksi: ${data.length}`;

    bot.sendMessage(chatId, pesan, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Error handleLaporan:", err.message);
    bot.sendMessage(chatId, "Maaf, ada kendala teknis. Coba lagi ya! 🙏");
  }
}

async function handleRiwayat(chatId) {
  bot.sendChatAction(chatId, "typing");
  const namaSheet = getNamaSheet(new Date());

  try {
    await pastikanSheetAda(namaSheet);
    const rows = await ambilSemuaData(namaSheet);
    const data = rows.filter(r => isValid(r));

    if (data.length === 0) {
      return bot.sendMessage(chatId, `Belum ada transaksi di ${namaSheet}.`);
    }

    const sepuluhTerakhir = data.slice(-10).reverse();

    let pesan = `🕐 *10 Transaksi Terakhir — ${namaSheet}*\n\n`;
    for (const r of sepuluhTerakhir) {
      const tipe = r[5];
      const icon = tipe === "Pemasukan" ? "⬆️" : tipe === "Transfer Masuk" || tipe === "Transfer Keluar" ? "🔄" : "⬇️";
      const jumlah = parseJumlah(r[6]);
      const dompet = r[7] || "Cash";
      pesan += `${icon} *${r[3]}*\n`;
      pesan += `    💵 ${formatRupiah(jumlah)} • 📁 ${r[4]} • 👛 ${dompet}\n`;
      pesan += `    🕐 ${r[0]} ${r[1]} (${r[2]})\n\n`;
    }

    bot.sendMessage(chatId, pesan, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Error handleRiwayat:", err.message);
    bot.sendMessage(chatId, "Maaf, ada kendala teknis. Coba lagi ya! 🙏");
  }
}

async function handleHapus(chatId) {
  bot.sendChatAction(chatId, "typing");
  const namaSheet = getNamaSheet(new Date());

  try {
    await pastikanSheetAda(namaSheet);
    const rows = await ambilSemuaData(namaSheet);

    let lastRowIndex = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (isValid(rows[i])) { lastRowIndex = i; break; }
    }

    if (lastRowIndex === -1) {
      return bot.sendMessage(chatId, "Tidak ada transaksi yang bisa dihapus.");
    }

    const lastRow = rows[lastRowIndex];
    hapusPending[chatId] = { lastRowIndex, namaSheet };

    const isTransferRow = isTransfer(lastRow);
    let pesanExtra = "";
    if (isTransferRow) {
      const transferId = lastRow[8];
      const pasangan = rows.find((r, i) => i !== lastRowIndex && r[8] === transferId);
      if (pasangan) pesanExtra = `\n⚠️ _Ini adalah transfer — baris pasangannya juga akan ikut dihapus_`;
    }

    const pesan =
      `🗑 *Hapus transaksi ini?*\n\n` +
      `📅 ${lastRow[0]} ${lastRow[1]} (${lastRow[2]})\n` +
      `📝 ${lastRow[3]}\n` +
      `📁 ${lastRow[4]}\n` +
      `👛 ${lastRow[7] || "Cash"}\n` +
      `💵 ${formatRupiah(parseJumlah(lastRow[6]))}` +
      pesanExtra;

    bot.sendMessage(chatId, pesan, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Ya, hapus", callback_data: "hapus_ya" },
          { text: "❌ Tidak", callback_data: "hapus_tidak" }
        ]]
      }
    });
  } catch (err) {
    console.error("Error handleHapus:", err.message);
    bot.sendMessage(chatId, "Maaf, ada kendala teknis. Coba lagi ya! 🙏");
  }
}

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  if (query.data === "hapus_ya") {
    const pending = hapusPending[chatId];

    if (!pending) {
      bot.answerCallbackQuery(query.id);
      return bot.editMessageText("⚠️ Sesi hapus sudah kedaluwarsa, coba /hapus lagi.", {
        chat_id: chatId, message_id: messageId
      });
    }

    const { lastRowIndex, namaSheet } = pending;
    const rows = await ambilSemuaData(namaSheet);
    const lastRow = rows[lastRowIndex];

    let indexToDelete = [lastRowIndex];
    if (isTransfer(lastRow) && lastRow[8]) {
      const transferId = lastRow[8];
      rows.forEach((r, i) => {
        if (i !== lastRowIndex && r[8] === transferId) indexToDelete.push(i);
      });
    }

    indexToDelete.sort((a, b) => b - a);
    for (const idx of indexToDelete) {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${namaSheet}'!A${idx + 1}:I${idx + 1}`,
      });
    }

    delete hapusPending[chatId];
    bot.answerCallbackQuery(query.id);
    bot.editMessageText(
      `✅ *Transaksi berhasil dihapus!*\n\n` +
      `📝 ${lastRow[3]}\n` +
      `💵 ${formatRupiah(parseJumlah(lastRow[6]))}` +
      (indexToDelete.length > 1 ? `\n_Baris pasangan transfer ikut dihapus_` : ""),
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
  const namaSheet = getNamaSheet(new Date());

  try {
    await pastikanSheetAda(namaSheet);
    const rows = await ambilSemuaData(namaSheet);
    const pengeluaran = rows.filter(r => r[5] === "Pengeluaran");

    if (pengeluaran.length === 0) {
      return bot.sendMessage(chatId, `📊 Belum ada pengeluaran di ${namaSheet} ini.`);
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
        title: { display: true, text: `Pengeluaran ${namaSheet}`, fontSize: 16 },
        legend: { position: "bottom" }
      }
    };

    const url = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=500&h=400&bkg=white`;
    await bot.sendPhoto(chatId, url, {
      caption: `🥧 *Pengeluaran ${namaSheet} per Kategori*\nTotal: ${formatRupiah(total)}`,
      parse_mode: "Markdown"
    });
  } catch (err) {
    console.error("Error handleGrafikKategori:", err.message);
    bot.sendMessage(chatId, "Maaf, ada kendala teknis. Coba lagi ya! 🙏");
  }
}

async function handleGrafikMingguan(chatId) {
  bot.sendChatAction(chatId, "upload_photo");
  const namaSheet = getNamaSheet(new Date());

  try {
    await pastikanSheetAda(namaSheet);
    const rows = await ambilSemuaData(namaSheet);
    const data = rows.filter(r => r[5] === "Pemasukan" || r[5] === "Pengeluaran");

    if (data.length === 0) {
      return bot.sendMessage(chatId, `📊 Belum ada transaksi di ${namaSheet} ini.`);
    }

    const minggu = {
      "Minggu 1": [0, 0], "Minggu 2": [0, 0],
      "Minggu 3": [0, 0], "Minggu 4": [0, 0]
    };

    for (const r of data) {
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
        title: { display: true, text: `Pemasukan vs Pengeluaran ${namaSheet}`, fontSize: 16 },
        scales: { yAxes: [{ ticks: { beginAtZero: true } }] },
        legend: { position: "bottom" }
      }
    };

    const url = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=500&h=400&bkg=white`;
    await bot.sendPhoto(chatId, url, {
      caption: `📊 *Pemasukan vs Pengeluaran per Minggu*\n${namaSheet}`,
      parse_mode: "Markdown"
    });
  } catch (err) {
    console.error("Error handleGrafikMingguan:", err.message);
    bot.sendMessage(chatId, "Maaf, ada kendala teknis. Coba lagi ya! 🙏");
  }
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
    const raw = await tanyaAI(teks);
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    if (parsed.error) {
      return bot.sendMessage(chatId, parsed.balasan);
    }

    // Hitung tanggal yang tepat
    const tanggal = hitungTanggal(parsed.tanggal);
    const namaSheet = getNamaSheet(tanggal);

    await simpanKeSheets(parsed, tanggal);

    let balasan;
    if (parsed.tipe === "transfer") {
      balasan =
        `🔄 *Transfer Tercatat!*\n\n` +
        `👛 Dari: ${parsed.dompet}\n` +
        `👛 Ke: ${parsed.dompet_tujuan}\n` +
        `💵 Jumlah: ${formatRupiah(parsed.jumlah)}\n` +
        `📅 Dicatat ke: ${namaSheet}\n\n` +
        `_${parsed.balasan}_`;
    } else {
      const tipeIcon = parsed.tipe === "pemasukan" ? "💰" : "💸";
      balasan =
        `${tipeIcon} *Tercatat!*\n\n` +
        `${parsed.emoji} ${parsed.deskripsi}\n` +
        `📁 Kategori: ${parsed.kategori}\n` +
        `📊 Tipe: ${parsed.tipe.charAt(0).toUpperCase() + parsed.tipe.slice(1)}\n` +
        `👛 Dompet: ${parsed.dompet || "Cash"}\n` +
        `💵 Jumlah: ${formatRupiah(parsed.jumlah)}\n` +
        `📅 Dicatat ke: ${namaSheet}\n\n` +
        `_${parsed.balasan}_`;
    }

    bot.sendMessage(chatId, balasan, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Error:", err.message);
    bot.sendMessage(chatId, "Maaf, ada kendala teknis. Coba kirim ulang ya! 🙏");
  }
});

console.log("🤖 Bot Receh aktif — sheet per bulan & input tanggal fleksibel!");
