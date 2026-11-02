# WA Scheduler — Fase A + B + C (Rapi)

Bot WhatsApp scheduler + task/poin/leaderboard, berbasis Baileys v7.

## Cara Pakai

1. **Install Node.js LTS** (v18+ / v20+ / v22) dari https://nodejs.org
2. **Kalau ini folder baru / pindah mesin**, jalankan sekali:
   ```
   node migrate.js
   ```
   Migrasi ini idempotent (aman diulang). Fungsinya: bersihkan data lama, gabung poin LID→phone, hapus report group ID invalid.
3. **Double-click `start.bat`** — otomatis `npm install` kalau belum ada, lalu jalankan bot.
4. Kalau window `start.bat` langsung tertutup dan gak tahu error-nya → pakai **`debug.bat`** (window tetap terbuka apapun).
5. **Scan QR** yang muncul di terminal dengan WhatsApp (Perangkat Tertaut → Tautkan Perangkat).
6. Setelah `✅ BOT BERHASIL TERHUBUNG!`:
   - **Setup ADMIN pertama** (kalau belum) — bot cetak `Kode setup ADMIN: 123456` di terminal. Kirim ke bot dari WhatsApp pribadi: `setup 123456`
   - Selanjutnya pakai command di bawah.

## Command Utama

### Chat pribadi ke bot (semua USER)
- `buat jadwal` → pilih **1. Jadwal Biasa** atau **2. Jadikan Tugas** (dengan poin)
- `jadwal` → daftar jadwal milik sendiri
- `edit 1` → edit jadwal nomor 1 dari daftar; kirim format jadwal baru, lalu balas `ya` untuk menyimpan atau `batal`
- `tugas` → daftar tugas milik sendiri
- `hapus 1` / `hapus 1,2` / `hapus semua` → hapus jadwal
- `hapus tugas 1` / `hapus tugas 1,2` → hapus tugas (**poin yang sudah didapat TIDAK ikut hilang**)
- `poin` → snapshot poin bulan ini (top 20)
- `tugas bantuan` → help Fase C

### ADMIN only (chat pribadi)
- `admin tambah 628xxx Nama` / `admin hapus 628xxx` / `admin daftar`
- `jadwal semua` / `tugas semua`
- **Report / Laporan Leaderboard:**
  - `laporan grup pilih` → tampilkan daftar grup bot, dapat nomor
  - `laporan grup daftar` — grup laporan aktif saat ini
  - `laporan grup tambah <nomor|groupId lengkap>` — misal `laporan grup tambah 3` atau `laporan grup tambah 12036xxx@g.us`
  - `laporan grup hapus <nomor|groupId>`
  - `laporan jam daftar` / `laporan jam tambah HH:MM` / `laporan jam hapus HH:MM`
  - `laporan kirim` — test kirim leaderboard sekarang ke semua grup laporan
- `pengingat grup pilih` → pilih grup dan lihat status pengingat tugas
- `pengingat aktif <nomor>` / `pengingat nonaktif <nomor>` → atur pengingat grup yang dipilih
- `pengingat grup daftar` → lihat status pengingat semua grup

### Format Jadwal (untuk Biasa & Tugas)
```
setiap hari 08:00 briefing pagi
setiap senin 09:00 cek stok
setiap senin,rabu,jumat 09:00 laporan
setiap tanggal 8 08:00 laporan bulanan
```

### Menyelesaikan Tugas
Saat bot mengirim pesan tugas ke grup, anggota tinggal **kasih reaction** (emoji apa saja) pada pesan itu. Bot otomatis:
- Kasih poin ke user (akumulasi **global** lintas grup)
- Balas konfirmasi di grup: `✅ Tugas telah diselesaikan oleh <Nama>`
- Anti-duplikasi: 1 user cuma bisa +poin sekali per occurrence

Poin auto-reset di awal bulan.

## Struktur Data

**Baseline (Fase A + B, tidak berubah):**
- `reminders.json` — daftar jadwal + tugas
- `users.json` — ADMIN/USER
- `scheduler.log` — log baseline
- `auth/` — session WhatsApp

**Fase C (terpisah di folder sendiri):**
- `data_phaseC/tasks.json` — meta task (poin, owner, dsb)
- `data_phaseC/task_occurrences.json` — per-occurrence penyelesaian
- `data_phaseC/message_index.json` — mapping messageId → occurrence
- `data_phaseC/points.json` — akumulasi poin bulan berjalan
- `data_phaseC/report_config.json` — grup + jam laporan
- `data_phaseC/task_reminder_config.json` — status pengingat per grup
- `data_phaseC/phaseC.log` — log Fase C

## Struktur File

```
wa-scheduler/
├── index.js               # Bot utama (Fase A+B+C, tidak ada duplikasi)
├── index.baseline.js      # Backup sebelum Fase C (tidak dipakai runtime)
├── package.json / package-lock.json
├── start.bat              # Launcher Windows
├── debug.bat              # Launcher DEBUG (window tetap terbuka)
├── migrate.js             # Cleanup + migrasi data (idempotent)
├── smoke.test.js          # Test isolasi modul Fase C (tanpa bot)
├── README.md
└── phaseC/
    ├── index.js
    ├── store.js
    ├── identity.js
    ├── tasks.js
    ├── points.js
    ├── reportConfig.js
    ├── reactions.js
    ├── reports.js
    ├── roasting.js
    ├── flow.js
    └── commands.js
```

Folder `_stale_backup/` (kalau ada) = file lama yang sudah tidak dipakai; boleh dihapus setelah bot terverifikasi jalan.

## Perubahan dari Versi Sebelumnya

1. **Bersihkan duplikasi** — `tasks.json`, `points.json`, `report_settings.json` di root (dari sistem PhaseC lama sebelum versi ini) sudah dipindah ke `_stale_backup/`. Sistem aktif pakai `data_phaseC/*.json`.
2. **Fix nama tampil** — sebelumnya `239058097827896` (LID mentah), sekarang resolve ke nama dari `users.json` (`Admin Utama`) atau `notify` dari participant grup.
3. **Fix `laporan grup tambah`** — sekarang menolak string bebas (`WORKLIST` → di-append `@g.us` jadi ID sampah). Harus pakai nomor dari `laporan grup pilih` atau groupId lengkap.
4. **Migrasi points/occurrences** — data akumulasi 10 poin milik LID `239058097827896` sudah digabung ke phone canonical `6282345085382` dengan nama `Admin Utama`.

## Troubleshooting

- **`start.bat` langsung tertutup** → jalankan `debug.bat`, screenshot pesannya
- **QR tidak muncul** → hapus folder `auth/`, jalankan lagi
- **Bot decrypt error `Bad MAC`** → session korup, hapus `auth/` + unlink device di HP → scan QR baru
- **Bot tidak balas mention di grup** → pastikan bot sudah di-add ke grup
- **Reaction tidak dihitung** → pastikan pesan yang di-react adalah **pesan tugas** yang dikirim bot, bukan pesan biasa; dan bukan un-react (emoji kosong)
- **Reset paksa akumulasi poin** → hapus `data_phaseC/points.json`, bot generate ulang saat start
- **Ganti bulan** → otomatis; kalau mau reset paksa mid-month, edit `data_phaseC/points.json` field `month` jadi bulan lain

## Test Isolasi

```
node smoke.test.js
```

Test ini tidak menyalakan bot; hanya verifikasi CRUD modul Fase C.
