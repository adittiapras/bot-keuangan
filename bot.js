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

Untuk pengeluaran biasa:
{"tipe":"pengeluaran","kategori":"string","label":"Kebutuhan"|"Keinginan","jumlah":angka_numerik,"deskripsi":"string singkat","emoji":"1 emoji relevan","dompet":"string","dompet_tujuan":"","tanggal":"string|null","balasan":"string respons singkat ramah dalam bahasa Indonesia"}

Untuk pemasukan:
{"tipe":"pemasukan","kategori":"string","label":"","jumlah":angka_numerik,"deskripsi":"string singkat","emoji":"1 emoji relevan","dompet":"string","dompet_tujuan":"","tanggal":"string|null","balasan":"string respons singkat ramah dalam bahasa Indonesia"}

Untuk tabungan (kata kunci: nabung, menabung, saving, sisihkan):
{"tipe":"tabungan","kategori":"Tabungan","label":"Tabungan","jumlah":angka_numerik,"deskripsi":"string singkat","emoji":"🏦","dompet":"string","dompet_tujuan":"","tanggal":"string|null","balasan":"string respons singkat ramah dalam bahasa Indonesia"}

Untuk investasi (kata kunci: invest, investasi, deposito, reksadana, saham):
{"tipe":"investasi","kategori":"Investasi","label":"Investasi","jumlah":angka_numerik,"deskripsi":"string singkat","emoji":"📈","dompet":"string","dompet_tujuan":"","tanggal":"string|null","balasan":"string respons singkat ramah dalam bahasa Indonesia"}

Untuk transfer antar dompet:
{"tipe":"transfer","kategori":"Transfer","label":"","jumlah":angka_numerik,"deskripsi":"string singkat","emoji":"🔄","dompet":"string nama dompet asal","dompet_tujuan":"string nama dompet tujuan","tanggal":"string|null","balasan":"string respons singkat ramah dalam bahasa Indonesia"}

Panduan kategori pengeluaran:
- Makanan, Transport, Belanja, Kesehatan, Hiburan, Tagihan, Lainnya

Panduan label pengeluaran (AI tebak dulu, user bisa koreksi):
- Kebutuhan: makan pokok, transport kerja, tagihan, kesehatan, kebutuhan rumah
- Keinginan: makan di restoran/kafe, hiburan, belanja non-esensial, hobi

Panduan dompet:
- "cash", "tunai" → "Cash"
- Nama bank/e-wallet (BCA, BSI, BRI, BNI, Mandiri, GoPay, OVO, Dana, ShopeePay, Seabank, Jago, Krom, Flip, dll) → isi nama tersebut
- Tidak disebutkan → "Cash"

Panduan tanggal:
- Tanggal spesifik → format DD/MM/YYYY
- "kemarin" → "kemarin"
- "X hari lalu" → "X hari lalu"
- Tidak ada info tanggal → null

Aturan jumlah:
- rb/ribu = x1.000
- jt/juta = x1.000.000
- k = x1.000
- Angka tanpa satuan = nilai aslinya

Jika pesan tidak ada hubungannya dengan transaksi keuangan:
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

function hitungTanggal(tanggalStr) {
  const sekarang = new Date();
  if (!tanggalStr) return sekarang;

  if (tanggalStr === "kemarin") {
    const kemarin = new Date(sekarang);
    kemarin.setDate(kemarin.getDate() - 1);
    return kemarin;
  }

  const hariLaluMatch = tanggalStr.match(/(\d+)\s*hari\s*lalu/i);
  if (hariLaluMatch) {
    const x = new Date(sekarang);
    x.setDate(x.getDate() - parseInt(hariLaluMatch[1]));
    return x;
  }

  const formatMatch = tanggalStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (formatMatch) {
    return new Date(`${formatMatch[3]}-${formatMatch[2]}-${formatMatch[1]}`);
  }

  const bulanMap = {
    januari: 0, februari: 1, maret: 2, april: 3, mei: 4, juni: 5,
    juli: 6, agustus: 7, september: 8, oktober: 9, november: 10, desember: 11
  };
  const tglBulanMatch = tanggalStr.match(/(\d{1,2})\s+(\w+)(?:\s+(\d{4}))?/i);
  if (tglBulanMatch) {
    const tgl = parseInt(tglBulanMatch[1]);
    const bulan = bulanMap[tglBulanMatch[2].toLowerCase()];
    const tahun = tglBulanMatch[3] ? parseInt(tglBulanMatch[3]) : sekarang.getFullYear();
    if (bulan !== undefined) return new Date(tahun, bulan, tgl);
  }

  return sekarang;
}

function getNamaSheet(tanggal) {
  return tanggal.toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    month: "long",
    year: "numeric"
  });
}

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
  return r[6] && ["Pemasukan", "Pengeluaran", "Transfer Masuk", "Transfer Keluar", "Tabungan", "Investasi"].includes(r[6]);
}

function isTransfer(r) {
  return r[6] === "Transfer Masuk" || r[6] === "Transfer Keluar";
}

async function pastikanSheetAda(namaSheet) {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetSudahAda = spreadsheet.data.sheets.some(s => s.properties.title === namaSheet);

  if (!sheetSudahAda) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: namaSheet } } }]
      }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${namaSheet}'!A1:J1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [["Tanggal", "Jam", "Hari", "Deskripsi", "Kategori", "Label", "Tipe", "Jumlah", "Dompet", "Transfer ID"]]
      }
    });
    console.log(`Sheet baru dibuat: ${namaSheet}`);
  }
}

async function ambilSemuaData(namaSheet) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${namaSheet}'!A:J`,
  });
  return res.data.values || [];
}

async function simpanKeSheets(data, tanggal, labelOverride) {
  const namaSheet = getNamaSheet(tanggal);
  await pastikanSheetAda(namaSheet);

  const { tanggal: tgl, jam, hari } = getTanggalParts(tanggal);
  const label = labelOverride || data.label || "";

  let rows;
  if (data.tipe === "transfer") {
    const transferId = Date.now().toString();
    rows = [
      [tgl, jam, hari, `Transfer ke ${data.dompet_tujuan}`, "Transfer", "", "Transfer Keluar", data.jumlah, data.dompet, transferId],
      [tgl, jam, hari, `Transfer dari ${data.dompet}`, "Transfer", "", "Transfer Masuk", data.jumlah, data.dompet_tujuan, transferId],
    ];
  } else {
    rows = [[
      tgl, jam, hari,
      data.deskripsi,
      data.kategori,
      label,
      data.tipe.charAt(0).toUpperCase() + data.tipe.slice(1),
      data.jumlah,
      data.dompet || "Cash",
      "",
    ]];
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${namaSheet}'!A:J`,
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });

  return namaSheet;
}

// ============================================================
// PENDING STATE
// ============================================================
const labelPending = {};
const hapusPending = {};
const rekapPending = {};

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
    `🏦 nabung 500rb Seabank\n` +
    `📈 invest 300rb reksa dana\n` +
    `📅 makan siang 25rb kemarin\n\n` +
    `📊 *Command tersedia:*\n` +
    `/saldo — cek saldo & ringkasan hari ini\n` +
    `/laporan — laporan lengkap bulan ini\n` +
    `/laporan juni — laporan bulan tertentu\n` +
    `/riwayat — lihat 10 transaksi terakhir\n` +
    `/grafik — pie chart pengeluaran per kategori\n` +
    `/grafikmingguan — bar chart pemasukan vs pengeluaran\n` +
    `/rekap — rekap bulan lalu & pindahkan sisa saldo\n` +
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
    const data = rows.filter(r => r[6] === "Pemasukan" || r[6] === "Pengeluaran");

    let totalMasuk = 0, totalKeluar = 0;
    let hariIniMasuk = 0, hariIniKeluar = 0;

    const hariIniStr = new Date().toLocaleDateString("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit", month: "2-digit", year: "numeric"
    });

    for (const r of data) {
      const jumlah = parseJumlah(r[7]);
      const tipe = r[6];
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

async function handleLaporan(chatId, bulanInput) {
  bot.sendChatAction(chatId, "typing");

  let namaSheet;
  if (!bulanInput) {
    namaSheet = getNamaSheet(new Date());
  } else {
    const bulanMap = {
      januari: 0, februari: 1, maret: 2, april: 3, mei: 4, juni: 5,
      juli: 6, agustus: 7, september: 8, oktober: 9, november: 10, desember: 11
    };
    const input = bulanInput.toLowerCase().trim();
    const parts = input.split(" ");
    const namaBulan = parts[0];
    const tahun = parts[1] ? parseInt(parts[1]) : new Date().getFullYear();
    const bulanIndex = bulanMap[namaBulan];

    if (bulanIndex === undefined) {
      return bot.sendMessage(chatId,
        `❌ Format bulan tidak dikenali.\n\nContoh yang benar:\n/laporan juli\n/laporan juni 2026`
      );
    }

    namaSheet = getNamaSheet(new Date(tahun, bulanIndex, 1));
  }

  try {
    await pastikanSheetAda(namaSheet);
    const rows = await ambilSemuaData(namaSheet);

    const pengeluaran = rows.filter(r => r[6] === "Pengeluaran");
    const pemasukan = rows.filter(r => r[6] === "Pemasukan");
    const tabungan = rows.filter(r => r[6] === "Tabungan");
    const investasi = rows.filter(r => r[6] === "Investasi");

    const totalMasuk = pemasukan.reduce((a, r) => a + parseJumlah(r[7]), 0);
    const totalKeluar = pengeluaran.reduce((a, r) => a + parseJumlah(r[7]), 0);
    const totalTabungan = tabungan.reduce((a, r) => a + parseJumlah(r[7]), 0);
    const totalInvestasi = investasi.reduce((a, r) => a + parseJumlah(r[7]), 0);

    const totalKebutuhan = pengeluaran.filter(r => r[5] === "Kebutuhan").reduce((a, r) => a + parseJumlah(r[7]), 0);
    const totalKeinginan = pengeluaran.filter(r => r[5] === "Keinginan").reduce((a, r) => a + parseJumlah(r[7]), 0);

    const kategoriKeluar = {};
    for (const r of pengeluaran) {
      const kat = `${r[4]} (${r[5] || "-"})`;
      kategoriKeluar[kat] = (kategoriKeluar[kat] || 0) + parseJumlah(r[7]);
    }

    const kategoriUrut = Object.entries(kategoriKeluar).sort((a, b) => b[1] - a[1]);
    let rincianKategori = "";
    for (const [kat, jml] of kategoriUrut) {
      const persen = totalKeluar > 0 ? Math.round((jml / totalKeluar) * 100) : 0;
      rincianKategori += `  • ${kat}: ${formatRupiah(jml)} (${persen}%)\n`;
    }

    const saldo = totalMasuk - totalKeluar - totalTabungan - totalInvestasi;
    const saldoIcon = saldo >= 0 ? "🟢" : "🔴";

    const pKebutuhan = totalMasuk > 0 ? Math.round(totalKebutuhan / totalMasuk * 100) : 0;
    const pKeinginan = totalMasuk > 0 ? Math.round(totalKeinginan / totalMasuk * 100) : 0;
    const pTabungan = totalMasuk > 0 ? Math.round((totalTabungan + totalInvestasi) / totalMasuk * 100) : 0;

    if (totalMasuk === 0 && totalKeluar === 0 && totalTabungan === 0 && totalInvestasi === 0) {
      return bot.sendMessage(chatId, `📊 Belum ada transaksi di *${namaSheet}*.`, { parse_mode: "Markdown" });
    }

    const pesan =
      `📊 *Laporan ${namaSheet}*\n\n` +
      `⬆️ Pemasukan: ${formatRupiah(totalMasuk)}\n` +
      `⬇️ Pengeluaran: ${formatRupiah(totalKeluar)}\n` +
      `🏦 Tabungan: ${formatRupiah(totalTabungan)}\n` +
      `📈 Investasi: ${formatRupiah(totalInvestasi)}\n` +
      `${saldoIcon} Sisa: ${formatRupiah(saldo)}\n\n` +
      `🎯 *Alokasi dari Pemasukan:*\n` +
      `  🔵 Kebutuhan: ${formatRupiah(totalKebutuhan)} (${pKebutuhan}%)\n` +
      `  🟡 Keinginan: ${formatRupiah(totalKeinginan)} (${pKeinginan}%)\n` +
      `  🟢 Tabungan+Invest: ${formatRupiah(totalTabungan + totalInvestasi)} (${pTabungan}%)\n\n` +
      `🗂 *Rincian pengeluaran:*\n${rincianKategori}\n` +
      `📝 Total transaksi: ${rows.filter(r => isValid(r)).length}`;

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
      const tipe = r[6];
      const icon = tipe === "Pemasukan" ? "⬆️" :
        tipe === "Transfer Masuk" || tipe === "Transfer Keluar" ? "🔄" :
        tipe === "Tabungan" ? "🏦" :
        tipe === "Investasi" ? "📈" : "⬇️";
      const jumlah = parseJumlah(r[7]);
      const dompet = r[8] || "Cash";
      const label = r[5] ? ` • 🏷️ ${r[5]}` : "";
      pesan += `${icon} *${r[3]}*\n`;
      pesan += `    💵 ${formatRupiah(jumlah)} • 📁 ${r[4]}${label} • 👛 ${dompet}\n`;
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
      const transferId = lastRow[9];
      const pasangan = rows.find((r, i) => i !== lastRowIndex && r[9] === transferId);
      if (pasangan) pesanExtra = `\n⚠️ _Ini adalah transfer — baris pasangannya juga akan ikut dihapus_`;
    }

    const label = lastRow[5] ? ` • 🏷️ ${lastRow[5]}` : "";
    const pesan =
      `🗑 *Hapus transaksi ini?*\n\n` +
      `📅 ${lastRow[0]} ${lastRow[1]} (${lastRow[2]})\n` +
      `📝 ${lastRow[3]}\n` +
      `📁 ${lastRow[4]}${label}\n` +
      `👛 ${lastRow[8] || "Cash"}\n` +
      `💵 ${formatRupiah(parseJumlah(lastRow[7]))}` +
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

async function handleRekap(chatId, bulanInput) {
  bot.sendChatAction(chatId, "typing");

  let namaSheetTarget;

  if (!bulanInput) {
    // Default → bulan lalu
    const sekarang = new Date();
    const bulanLalu = new Date(sekarang.getFullYear(), sekarang.getMonth() - 1, 1);
    namaSheetTarget = getNamaSheet(bulanLalu);
  } else {
    // Parse input bulan
    const bulanMap = {
      januari: 0, februari: 1, maret: 2, april: 3, mei: 4, juni: 5,
      juli: 6, agustus: 7, september: 8, oktober: 9, november: 10, desember: 11
    };
    const input = bulanInput.toLowerCase().trim();
    const parts = input.split(" ");
    const namaBulan = parts[0];
    const tahun = parts[1] ? parseInt(parts[1]) : new Date().getFullYear();
    const bulanIndex = bulanMap[namaBulan];

    if (bulanIndex === undefined) {
      return bot.sendMessage(chatId,
        `❌ Format bulan tidak dikenali.\n\nContoh yang benar:\n/rekap → rekap bulan lalu\n/rekap juli → rekap Juli\n/rekap juni 2026 → rekap bulan spesifik`
      );
    }

    namaSheetTarget = getNamaSheet(new Date(tahun, bulanIndex, 1));
  }

  try {
    await pastikanSheetAda(namaSheetTarget);
    const rows = await ambilSemuaData(namaSheetTarget);

    const pemasukan = rows.filter(r => r[6] === "Pemasukan").reduce((a, r) => a + parseJumlah(r[7]), 0);
    const pengeluaran = rows.filter(r => r[6] === "Pengeluaran").reduce((a, r) => a + parseJumlah(r[7]), 0);
    const tabungan = rows.filter(r => r[6] === "Tabungan").reduce((a, r) => a + parseJumlah(r[7]), 0);
    const investasi = rows.filter(r => r[6] === "Investasi").reduce((a, r) => a + parseJumlah(r[7]), 0);
    const sisaSaldo = pemasukan - pengeluaran - tabungan - investasi;

    rekapPending[chatId] = {
      namaSheet: namaSheetTarget,
      sisaSaldo,
      bulan: namaSheetTarget,
      waitingRekening: false
    };

    const pesan =
      `📋 *Rekap ${namaSheetTarget}*\n\n` +
      `⬆️ Pemasukan: ${formatRupiah(pemasukan)}\n` +
      `⬇️ Pengeluaran: ${formatRupiah(pengeluaran)}\n` +
      `🏦 Tabungan: ${formatRupiah(tabungan)}\n` +
      `📈 Investasi: ${formatRupiah(investasi)}\n` +
      `💰 Sisa Saldo: ${formatRupiah(sisaSaldo)}\n\n` +
      `Mau pindahkan sisa saldo *${formatRupiah(sisaSaldo)}* ke tabungan utama?`;

    bot.sendMessage(chatId, pesan, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Ya, pindahkan", callback_data: "rekap_ya" },
          { text: "❌ Tidak", callback_data: "rekap_tidak" }
        ]]
      }
    });
  } catch (err) {
    console.error("Error handleRekap:", err.message);
    bot.sendMessage(chatId, "Maaf, ada kendala teknis. Coba lagi ya! 🙏");
  }
}

async function handleGrafikKategori(chatId) {
  bot.sendChatAction(chatId, "upload_photo");
  const namaSheet = getNamaSheet(new Date());

  try {
    await pastikanSheetAda(namaSheet);
    const rows = await ambilSemuaData(namaSheet);
    const pengeluaran = rows.filter(r => r[6] === "Pengeluaran");

    if (pengeluaran.length === 0) {
      return bot.sendMessage(chatId, `📊 Belum ada pengeluaran di ${namaSheet} ini.`);
    }

    const kategori = {};
    for (const r of pengeluaran) {
      const kat = r[4] || "Lainnya";
      kategori[kat] = (kategori[kat] || 0) + parseJumlah(r[7]);
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
    const data = rows.filter(r => r[6] === "Pemasukan" || r[6] === "Pengeluaran");

    if (data.length === 0) {
      return bot.sendMessage(chatId, `📊 Belum ada transaksi di ${namaSheet} ini.`);
    }

    const minggu = {
      "Minggu 1": [0, 0], "Minggu 2": [0, 0],
      "Minggu 3": [0, 0], "Minggu 4": [0, 0]
    };

    for (const r of data) {
      const tgl = parseInt(r[0].split("/")[0]);
      const jumlah = parseJumlah(r[7]);
      const tipe = r[6];
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
// CALLBACK QUERY HANDLER
// ============================================================

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  // ── Label Kebutuhan/Keinginan ──
  if (data === "label_kebutuhan" || data === "label_keinginan") {
    const pending = labelPending[chatId];
    if (!pending) {
      bot.answerCallbackQuery(query.id);
      return bot.editMessageText("⚠️ Sesi sudah kedaluwarsa, coba input ulang transaksinya.", {
        chat_id: chatId, message_id: messageId
      });
    }

    const label = data === "label_kebutuhan" ? "Kebutuhan" : "Keinginan";
    const { parsed, tanggal, namaSheet } = pending;

    await simpanKeSheets(parsed, tanggal, label);
    delete labelPending[chatId];

    bot.answerCallbackQuery(query.id);
    bot.editMessageText(
      `💸 *Tercatat sebagai ${label}!*\n\n` +
      `${parsed.emoji} ${parsed.deskripsi}\n` +
      `📁 Kategori: ${parsed.kategori}\n` +
      `🏷️ Label: ${label}\n` +
      `👛 Dompet: ${parsed.dompet || "Cash"}\n` +
      `💵 Jumlah: ${formatRupiah(parsed.jumlah)}\n` +
      `📅 Dicatat ke: ${namaSheet}\n\n` +
      `_${parsed.balasan}_`,
      { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" }
    );
    return;
  }

  // ── Hapus ──
  if (data === "hapus_ya") {
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
    if (isTransfer(lastRow) && lastRow[9]) {
      const transferId = lastRow[9];
      rows.forEach((r, i) => {
        if (i !== lastRowIndex && r[9] === transferId) indexToDelete.push(i);
      });
    }

    indexToDelete.sort((a, b) => b - a);
    for (const idx of indexToDelete) {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${namaSheet}'!A${idx + 1}:J${idx + 1}`,
      });
    }

    delete hapusPending[chatId];
    bot.answerCallbackQuery(query.id);
    bot.editMessageText(
      `✅ *Transaksi berhasil dihapus!*\n\n` +
      `📝 ${lastRow[3]}\n` +
      `💵 ${formatRupiah(parseJumlah(lastRow[7]))}` +
      (indexToDelete.length > 1 ? `\n_Baris pasangan transfer ikut dihapus_` : ""),
      { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" }
    );
    return;
  }

  if (data === "hapus_tidak") {
    delete hapusPending[chatId];
    bot.answerCallbackQuery(query.id);
    bot.editMessageText("👍 Oke, transaksi tidak jadi dihapus.", {
      chat_id: chatId, message_id: messageId
    });
    return;
  }

  // ── Rekap ──
  if (data === "rekap_ya") {
    const pending = rekapPending[chatId];
    if (!pending) {
      bot.answerCallbackQuery(query.id);
      return bot.editMessageText("⚠️ Sesi rekap sudah kedaluwarsa, coba /rekap lagi.", {
        chat_id: chatId, message_id: messageId
      });
    }

    rekapPending[chatId].waitingRekening = true;
    bot.answerCallbackQuery(query.id);
    bot.editMessageText(
      `💰 Sisa saldo *${formatRupiah(pending.sisaSaldo)}* akan dipindah ke tabungan utama.\n\nKetik nama rekening tujuan:`,
      { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" }
    );
    return;
  }

  if (data === "rekap_tidak") {
    delete rekapPending[chatId];
    bot.answerCallbackQuery(query.id);
    bot.editMessageText("👍 Oke, sisa saldo tidak dipindahkan.", {
      chat_id: chatId, message_id: messageId
    });
    return;
  }
});

// ============================================================
// MAIN MESSAGE HANDLER
// ============================================================

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const teks = msg.text;

  if (!teks) return;

  // Handle input rekening untuk rekap rollover
  if (rekapPending[chatId]?.waitingRekening) {
    const pending = rekapPending[chatId];
    const rekening = teks.trim();

    try {
      const tanggal = new Date();
      const { tanggal: tgl, jam, hari } = getTanggalParts(tanggal);

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${pending.namaSheet}'!A:J`,
        valueInputOption: "RAW",
        requestBody: {
          values: [[
            tgl, jam, hari,
            `Rollover ke ${rekening}`,
            "Rollover",
            "Rollover",
            "Rollover",
            pending.sisaSaldo,
            rekening,
            ""
          ]]
        }
      });

      delete rekapPending[chatId];

      bot.sendMessage(chatId,
        `✅ *Sisa saldo berhasil dipindahkan!*\n\n` +
        `💰 ${formatRupiah(pending.sisaSaldo)}\n` +
        `🏦 Rekening: ${rekening}\n` +
        `📅 Dari: ${pending.bulan}\n\n` +
        `_Data sudah masuk ke Sheet Tabungan._`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      console.error("Error rekap rollover:", err.message);
      bot.sendMessage(chatId, "Maaf, ada kendala teknis. Coba lagi ya! 🙏");
    }
    return;
  }

  // Routing commands
  if (teks === "/start" || teks === "/help") return handleStart(chatId);
  if (teks === "/saldo") return handleSaldo(chatId);
  if (teks === "/laporan" || teks.startsWith("/laporan ")) {
    const bulanInput = teks === "/laporan" ? null : teks.replace("/laporan ", "").trim();
    return handleLaporan(chatId, bulanInput);
  }
  if (teks === "/riwayat") return handleRiwayat(chatId);
  if (teks === "/grafik") return handleGrafikKategori(chatId);
  if (teks === "/grafikmingguan") return handleGrafikMingguan(chatId);
  if (teks === "/rekap" || teks.startsWith("/rekap ")) {
    const bulanInput = teks === "/rekap" ? null : teks.replace("/rekap ", "").trim();
    return handleRekap(chatId, bulanInput);
  }
  if (teks === "/hapus") return handleHapus(chatId);

  bot.sendChatAction(chatId, "typing");

  try {
    const raw = await tanyaAI(teks);
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    if (parsed.error) {
      return bot.sendMessage(chatId, parsed.balasan);
    }

    const tanggal = hitungTanggal(parsed.tanggal);
    const namaSheet = getNamaSheet(tanggal);

    // Pengeluaran → tanya label dulu
    if (parsed.tipe === "pengeluaran") {
      labelPending[chatId] = { parsed, tanggal, namaSheet };

      const labelAI = parsed.label || "Kebutuhan";
      const pesan =
        `💸 *${parsed.emoji} ${parsed.deskripsi}*\n` +
        `📁 ${parsed.kategori} • 👛 ${parsed.dompet || "Cash"} • 💵 ${formatRupiah(parsed.jumlah)}\n\n` +
        `AI menebak ini *${labelAI}* — betul?`;

      return bot.sendMessage(chatId, pesan, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Kebutuhan", callback_data: "label_kebutuhan" },
            { text: "🛍️ Keinginan", callback_data: "label_keinginan" }
          ]]
        }
      });
    }

    // Langsung simpan untuk tipe lain
    await simpanKeSheets(parsed, tanggal, parsed.label);

    let balasan;
    if (parsed.tipe === "transfer") {
      balasan =
        `🔄 *Transfer Tercatat!*\n\n` +
        `👛 Dari: ${parsed.dompet}\n` +
        `👛 Ke: ${parsed.dompet_tujuan}\n` +
        `💵 Jumlah: ${formatRupiah(parsed.jumlah)}\n` +
        `📅 Dicatat ke: ${namaSheet}\n\n` +
        `_${parsed.balasan}_`;
    } else if (parsed.tipe === "tabungan") {
      balasan =
        `🏦 *Tabungan Tercatat!*\n\n` +
        `${parsed.emoji} ${parsed.deskripsi}\n` +
        `👛 Dompet: ${parsed.dompet || "Cash"}\n` +
        `💵 Jumlah: ${formatRupiah(parsed.jumlah)}\n` +
        `📅 Dicatat ke: ${namaSheet}\n\n` +
        `_${parsed.balasan}_`;
    } else if (parsed.tipe === "investasi") {
      balasan =
        `📈 *Investasi Tercatat!*\n\n` +
        `${parsed.emoji} ${parsed.deskripsi}\n` +
        `👛 Dompet: ${parsed.dompet || "Cash"}\n` +
        `💵 Jumlah: ${formatRupiah(parsed.jumlah)}\n` +
        `📅 Dicatat ke: ${namaSheet}\n\n` +
        `_${parsed.balasan}_`;
    } else {
      balasan =
        `💰 *Pemasukan Tercatat!*\n\n` +
        `${parsed.emoji} ${parsed.deskripsi}\n` +
        `📁 Kategori: ${parsed.kategori}\n` +
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

console.log("🤖 Bot Receh aktif!");
