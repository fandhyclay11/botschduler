// phaseD/nlIntent.js
// -------------------------------------------------------------
// D2 — Natural Language intent classification.
//
// Fungsi: terima pesan user berbahasa natural (chat pribadi ke bot),
// klasifikasi ke intent yang sudah ada di bot + extract params.
//
// Alur klasifikasi hybrid:
//   1. Pre-classifier LOKAL (phaseD/nlNormalize.js) — zero network,
//      deterministik, mengenali variasi umum (typo, singkatan, sinonim
//      bahasa Indonesia sehari-hari, urutan kata berbeda).
//      Jika yakin (confidence >= 0.9), kembalikan hasil lokal tanpa
//      mengirim data ke LLM eksternal (hemat token + lebih aman).
//   2. Jika pre-classifier tidak yakin, panggil AI dengan prompt yang
//      diperketat + sertakan HINT lokal sebagai konteks minimum.
//   3. Post-validation: jika AI mengembalikan intent dengan param wajib
//      yang hilang, turunkan confidence agar router meminta klarifikasi
//      alih-alih menebak/mengarang.
//
// PENTING:
//   - AI TIDAK meng-eksekusi apapun. AI HANYA klasifikasi + extract.
//   - Eksekusi tetap lewat handler existing (createReminder, dsb).
//   - Konteks yang dikirim ke AI SELALU terbatas: hanya pesan user
//     dan kerangka intent. Tidak ada database, kredensial, atau
//     riwayat pengguna yang dikirim.
//   - Kalau AI ragu / off-topic → return { intent: 'unknown' } → caller
//     jatuhkan ke help text existing.
//
// Intent yang dikenali (mirror command existing):
//   - buat_jadwal_biasa       { schedule: "setiap X HH:MM teks", groupHint?: "" }
//   - buat_tugas              { schedule: "...", points: 10, groupHint?: "" }
//   - lihat_jadwal
//   - lihat_tugas
//   - lihat_poin
//   - hapus_jadwal            { indexes: [1,2] } atau { all: true }
//   - hapus_tugas             { indexes: [1,2] } atau { all: true }
//   - bantuan
//   - admin_tambah_user       { phone: "628xxx", name: "..." }
//   - admin_hapus_user        { phone: "628xxx" }
//   - admin_lihat_user
//   - admin_jadwal_semua
//   - admin_tugas_semua
//   - laporan_kirim
//   - laporan_grup_daftar
//   - laporan_jam_tambah      { time: "HH:MM" }
//   - laporan_jam_daftar
//   - unknown
// -------------------------------------------------------------

import { chatJSON } from './client.js';
import { localClassify, hasRequiredParams } from './nlNormalize.js';

const VALID_INTENTS = new Set([
    'buat_jadwal_biasa', 'buat_tugas', 'lihat_jadwal', 'lihat_tugas',
    'lihat_poin', 'hapus_jadwal', 'hapus_tugas', 'bantuan',
    'admin_tambah_user', 'admin_hapus_user', 'admin_lihat_user',
    'admin_jadwal_semua', 'admin_tugas_semua', 'laporan_kirim',
    'laporan_grup_daftar', 'laporan_jam_tambah', 'laporan_jam_daftar',
    'rekap_user', 'unknown'
]);

// Threshold: hasil lokal cukup kuat untuk skip AI.
const LOCAL_HIGH_CONFIDENCE = 0.9;

const SYSTEM_PROMPT = `Kamu adalah router intent untuk bot WhatsApp Scheduler berbahasa Indonesia.

Tugas: klasifikasi pesan user ke SATU intent + extract parameter. Output HARUS JSON valid tanpa komentar.

Skema JSON output:
{
  "intent": "<nama_intent>",
  "confidence": <0.0 sampai 1.0>,
  "params": { ... },
  "reason": "<alasan singkat, satu kalimat, bahasa Indonesia>"
}

Daftar intent yang valid (gunakan PERSIS nama ini):
- buat_jadwal_biasa      params: { schedule: string, groupHint?: string }
- buat_tugas             params: { schedule: string, points: number, groupHint?: string }
- lihat_jadwal           params: {}
- lihat_tugas            params: {}
- lihat_poin             params: {}
- hapus_jadwal           params: { indexes?: number[], all?: boolean }
- hapus_tugas            params: { indexes?: number[], all?: boolean }
- bantuan                params: {}
- admin_tambah_user      params: { phone: string, name?: string }
- admin_hapus_user       params: { phone: string }
- admin_lihat_user       params: {}
- admin_jadwal_semua     params: {}
- admin_tugas_semua      params: {}
- laporan_kirim          params: {}
- laporan_grup_daftar    params: {}
- laporan_jam_tambah     params: { time: string }
- laporan_jam_daftar     params: {}
- rekap_user             params: { members: [{name: string, phone: string, role: string}] }
- unknown                params: {}

Format "schedule" untuk buat_jadwal_biasa / buat_tugas HARUS satu string sesuai grammar bot:
- "setiap hari HH:MM <teks>"
- "setiap <hari> HH:MM <teks>"   (senin,selasa,rabu,kamis,jumat,sabtu,minggu; boleh dipisah koma)
- "setiap tanggal N HH:MM <teks>"

Konversi waktu natural:
- "jam 8 pagi" = "08:00"
- "jam 8 malam" = "20:00"
- "jam setengah 9" = "08:30"
- "jam 9" tanpa pagi/malam = "09:00"
- "besok" / "hari ini" diperlakukan sebagai "setiap hari" (bot hanya mendukung recurrence).

ATURAN MUTLAK UNTUK ISI PESAN (<teks> setelah HH:MM):
- Isi pesan HARUS disalin PERSIS dari pesan user, APA ADANYA.
- DILARANG meringkas, memparafrasekan, "memperbaiki" ejaan/tanda baca, menormalkan huruf besar/kecil, menerjemahkan, atau membuang bagian apa pun dari isi pesan.
- DILARANG menambahkan kata/kalimat yang tidak diketik user.
- DILARANG menghapus atau menormalkan: baris baru (\\n), emoji, bullet (-, *, •, 1., dsb), tanda baca, format WhatsApp (*bold*, _italic_, ~strike~, monospace triple-backtick), spasi di awal baris bullet, mention (@62xxx), dan tanda baca di dalam isi.
- Jika pesan memuat JUDUL + PIC + bullet instruksi + catatan + emoji + bahkan baris waktu di dalam isi pesan, SELURUHNYA adalah isi pesan dan harus disalin bulat-bulat.
- Deklarasi poin ("10 poin", "nilai 10 poin") HANYA metadata bila berada di baris pertama bersama waktu/pengulangan; bila muncul di dalam isi pesan tugas, perlakukan sebagai bagian isi.
- Jika kamu ragu di mana batas metadata jadwal berakhir dan isi pesan dimulai, atau ada waktu yang bertentangan (lebih dari satu HH:MM di posisi metadata), ISI schedule DENGAN STRING KOSONG dan turunkan confidence ke <=0.6 agar bot meminta klarifikasi.
- Fakta: bot akan tetap mengambil ulang isi pesan dari teks user asli, bukan dari schedule yang kamu kirim. Jadi field "schedule" cukup diisi "setiap … HH:MM" (boleh tanpa isi) — jangan menebak atau meringkas isi.

Contoh pemetaan (perhatikan body boleh dibiarkan sesuai teks user, bot akan merekonstruksinya):
- "besok jam 8 pagi ingatkan cek stok"        → buat_jadwal_biasa { schedule: "setiap hari 08:00 ingatkan cek stok" }
- "tiap senin jam 9 briefing"                 → buat_jadwal_biasa { schedule: "setiap senin 09:00 briefing" }
- "tiap tgl 1 jam 10 laporan bulanan"         → buat_jadwal_biasa { schedule: "setiap tanggal 1 10:00 laporan bulanan" }
- "setiap hari 06.19 poin 10\nTUGAS HARIAN\n- Cek stok\n- Lapor PIC" → buat_tugas { schedule: "setiap hari 06:19", points: 10 }  (isi pesan diambil bot dari teks user, JANGAN tulis ulang)
- "buat tugas cek laporan setiap senin jam 9 nilai 20 poin" → buat_tugas { schedule: "setiap senin 09:00 cek laporan", points: 20 }
- "liat jdwl saya"                            → lihat_jadwal
- "poin saya bulan ini"                       → lihat_poin
- "daftar jadwal"                             → lihat_jadwal
- "hapus jadwal nomor 1 dan 2"                → hapus_jadwal { indexes: [1,2] }
- "hapus semua tugas"                         → hapus_tugas { all: true }
- "hapus semua jadwal"                        → hapus_jadwal { all: true }
- "tambah user 628123 budi"                   → admin_tambah_user { phone: "628123", name: "Budi" }
- "kirim laporan sekarang"                    → laporan_kirim
- "jam laporan 20:00"                         → laporan_jam_tambah { time: "20:00" }
- Pesan berisi DAFTAR beberapa orang dengan nama+nomor+jabatan (CIF/SSL/SJL/SCB/SCG), contoh:
  "Rekap user:
   Budi 6281234 SSL
   Reza 6285678 SCB
   Saras 6289999 SCG"
  → rekap_user { members: [
      { name: "Budi", phone: "6281234", role: "SSL" },
      { name: "Reza", phone: "6285678", role: "SCB" },
      { name: "Saras", phone: "6289999", role: "SCG" }
    ] }
- Nilai role WAJIB salah satu: CIF, SSL, SJL, SCB, SCG. Kalau user tulis kepanjangan ("chief of store"), petakan ke kode singkat.
- Kalau ada 1 baris rekap saja, tetap pakai intent rekap_user dengan members berisi 1 orang.

ATURAN KETAT:
- JANGAN PERNAH menebak nomor telepon, nama user, nomor index, poin, atau jam yang tidak eksplisit disebut user.
- Kalau pesan TIDAK jelas mencocokkan salah satu intent → intent: "unknown", confidence <= 0.4.
- Kalau pesan cocok ke suatu intent tapi param WAJIB hilang (contoh: "buat tugas" tanpa jam/isi/poin), gunakan intent itu dengan confidence 0.55-0.65 + reason jelaskan yang kurang. Router akan menanyakan klarifikasi.
- Kalau pesan hanya basa-basi / sapaan / off-topic (contoh "halo", "pagi", "makasih"), balas intent "unknown".
- Kalau pesan menyebut fitur yang TIDAK ADA di daftar intent di atas (contoh "siapa yang online", "cuaca hari ini", "kirim foto"), balas intent "unknown" dengan reason "fitur tidak didukung".
- Response HANYA JSON, tanpa markdown fence, tanpa komentar.`;

// Return { intent, confidence, params, reason, source } | null
export async function classifyIntent(userText) {
    if (!userText || typeof userText !== 'string') return null;
    const trimmed = userText.trim();
    if (!trimmed) return null;

    // 1) Pre-classifier lokal — hemat panggilan AI untuk kasus yang jelas.
    const local = localClassify(trimmed);
    if (local && local.confidence >= LOCAL_HIGH_CONFIDENCE) {
        return finalize({
            intent: local.intent,
            confidence: local.confidence,
            params: local.params || {},
            reason: `pre-classifier lokal: ${local.reason}`,
            source: 'local'
        });
    }

    // 2) AI dengan prompt diperketat + hint lokal (jika ada).
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    if (local && local.intent && local.intent !== 'unknown') {
        // Kirim HANYA ringkasan intent kandidat — tidak ada data user
        // atau database. Membantu AI memilih intent yang benar tanpa
        // membocorkan konteks.
        messages.push({
            role: 'system',
            content: `Petunjuk pre-classifier (opsional, boleh diabaikan): kandidat intent "${local.intent}" dengan confidence ${local.confidence.toFixed(2)}.`
        });
    }
    messages.push({ role: 'user', content: trimmed });

    const r = await chatJSON(messages, { temperature: 0.1, maxTokens: 300 });

    if (!r.ok) {
        // AI gagal → fallback ke hasil lokal (kalau ada), walau confidence
        // rendah. Router akan memutuskan apakah bertanya atau skip.
        if (local) {
            return finalize({
                intent: local.intent,
                confidence: Math.min(local.confidence, 0.7),
                params: local.params || {},
                reason: `AI gagal, fallback lokal: ${local.reason}`,
                source: 'local-fallback'
            });
        }
        return null;
    }

    const d = r.data || {};
    const intent = typeof d.intent === 'string' ? d.intent : 'unknown';
    const confidenceRaw = Number(d.confidence);
    let confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0;
    const params = (d.params && typeof d.params === 'object') ? d.params : {};
    const reason = typeof d.reason === 'string' ? d.reason : '';

    const normalizedIntent = String(intent).trim().toLowerCase();
    const finalIntent = VALID_INTENTS.has(normalizedIntent) ? normalizedIntent : 'unknown';

    return finalize({
        intent: finalIntent,
        confidence,
        params,
        reason,
        source: 'ai'
    });
}

// Post-validation: pastikan intent + params konsisten dengan kemampuan bot.
// Turunkan confidence jika param wajib hilang supaya router menanyakan.
function finalize({ intent, confidence, params, reason, source }) {
    if (intent === 'unknown') {
        return { intent, confidence: Math.min(confidence, 0.4), params: {}, reason, source };
    }

    // Validasi param wajib. Jika hilang: cap confidence di 0.6 agar router
    // masuk mode konfirmasi/klarifikasi (0.55..0.74 → tanya).
    if (!hasRequiredParams(intent, params)) {
        return {
            intent,
            confidence: Math.min(confidence, 0.6),
            params,
            reason: reason || `parameter wajib untuk ${intent} belum lengkap`,
            source,
            missingParams: true
        };
    }

    return { intent, confidence, params, reason, source };
}
