# 🤖 Bot Keuangan Telegram — 100% GRATIS

Bot Telegram pencatat keuangan otomatis menggunakan AI Gemini (Google) + Google Sheets.
Tidak ada biaya apapun, selamanya!

---

## Stack Teknologi (semua gratis)

| Komponen | Layanan | Biaya |
|---|---|---|
| Bot | Telegram Bot API | Gratis |
| AI / Otak | Google Gemini API | Gratis permanen |
| Catatan | Google Sheets | Gratis |
| Server | Railway | Gratis |
| **Total** | | **Rp 0 / bulan** |

---

## Yang Kamu Butuhkan

Sebelum mulai, pastikan kamu sudah punya:
- [ ] Token Bot Telegram (dari @BotFather)
- [ ] Spreadsheet ID Google Sheets
- [ ] File JSON kredensial Google (dari Google Cloud Console)
- [ ] Gemini API Key (dari Google AI Studio — GRATIS)

---

## Cara Dapat Gemini API Key (Gratis Selamanya)

1. Buka https://aistudio.google.com
2. Login dengan akun Google
3. Klik "Get API Key" di menu kiri
4. Klik "Create API Key"
5. Salin key yang muncul — simpan baik-baik!

Tidak perlu kartu kredit, tidak ada batas waktu, gratis selamanya
untuk pemakaian pribadi (1.500 request/hari).

---

## Cara Deploy ke Railway (Gratis)

### 1. Buat akun Railway
- Buka https://railway.app
- Daftar pakai akun GitHub (gratis)

### 2. Upload kode
- Di Railway, klik "New Project"
- Pilih "Deploy from GitHub repo"
- Upload folder bot-keuangan ini

### 3. Isi Environment Variables
Di Railway, masuk ke project → tab "Variables" → tambahkan:

| Nama Variable | Isinya |
|---|---|
| TELEGRAM_TOKEN | Token dari @BotFather |
| SPREADSHEET_ID | ID spreadsheet Google Sheets kamu |
| GEMINI_API_KEY | API key dari Google AI Studio |
| GOOGLE_CREDENTIALS | Copy-paste seluruh isi file JSON dari Google Cloud |

### 4. Deploy!
Railway akan otomatis menjalankan bot kamu. Selesai!

---

## Cara Pakai Bot

Buka Telegram → cari username bot kamu → ketik /start

Contoh pesan yang bisa dikirim:
- "makan siang 25rb"
- "beli bensin 50000"
- "gaji masuk 3jt"
- "transfer dari ortu 200rb"
- "bayar listrik 150rb"
- "jajan kopi sama temen 35000"

Bot akan otomatis:
1. Mengerti maksud pesanmu (pakai AI Gemini)
2. Mencatat ke Google Sheets
3. Membalas konfirmasi

---

## Struktur Google Sheets

Bot akan mengisi kolom berikut secara otomatis:

| A: Tanggal | B: Deskripsi | C: Kategori | D: Tipe | E: Jumlah |
|---|---|---|---|---|
| 27/05/2026 13.45 | Makan siang | Makanan | Pengeluaran | 25000 |
| 27/05/2026 14.00 | Gaji bulan Mei | Gaji | Pemasukan | 3000000 |

---

## Pertanyaan Umum

**Bot tidak merespons?**
Cek apakah Railway masih berjalan. Buka dashboard Railway dan lihat tab "Logs".

**Data tidak masuk ke Sheets?**
Pastikan email service account sudah di-share ke spreadsheet dengan akses Editor.

**Limit Gemini API habis?**
Batas hariannya 1.500 request — lebih dari cukup untuk pemakaian pribadi.
Limit akan reset otomatis setiap tengah malam.
