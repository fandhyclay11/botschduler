// phaseD/nlIntent.js
// -------------------------------------------------------------
// D2 — Natural Language intent classification.
//
// Fungsi: terima pesan user berbahasa natural (chat pribadi ke bot),
// klasifikasi ke intent yang sudah ada di bot + extract params.
//
// PENTING:
//   - AI TIDAK meng-eksekusi apapun. AI HANYA klasifikasi + extract.
//   - Eksekusi tetap lewat handler existing (createReminder, dsb).
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

Contoh pemetaan:
- "besok jam 8 pagi ingatkan cek stok"        → buat_jadwal_biasa { schedule: "setiap hari 08:00 cek stok" }
- "tiap senin jam 9 briefing"                 → buat_jadwal_biasa { schedule: "setiap senin 09:00 briefing" }
- "tiap tgl 1 jam 10 laporan bulanan"         → buat_jadwal_biasa { schedule: "setiap tanggal 1 10:00 laporan bulanan" }
- "buat tugas cek laporan setiap senin jam 9 nilai 20 poin" → buat_tugas { schedule: "setiap senin 09:00 cek laporan", points: 20 }
- "poin saya bulan ini"                       → lihat_poin
- "daftar jadwal"                             → lihat_jadwal
- "hapus jadwal nomor 1 dan 2"                → hapus_jadwal { indexes: [1,2] }
- "hapus semua tugas"                         → hapus_tugas { all: true }
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
- Kalau pesan TIDAK jelas mencocokkan salah satu intent → intent: "unknown", confidence rendah.
- Kalau pesan cocok tapi param kurang (misal buat tugas tanpa poin), tetap kembalikan intent-nya dengan confidence < 0.6 dan reason menjelaskan yang kurang.
- Waktu "jam 8 pagi" = "08:00", "jam 8 malam" = "20:00", "jam setengah 9" = "08:30".
- Jangan pernah invent nomor telepon / nama user / index.
- Response HANYA JSON, tanpa markdown fence.`;

// Return { intent, confidence, params, reason } | null (kalau AI gagal)
export async function classifyIntent(userText) {
    if (!userText || typeof userText !== 'string') return null;
    const trimmed = userText.trim();
    if (!trimmed) return null;

    const r = await chatJSON([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: trimmed }
    ], { temperature: 0.1, maxTokens: 300 });

    if (!r.ok) return null;

    const d = r.data || {};
    const intent = typeof d.intent === 'string' ? d.intent : 'unknown';
    const confidenceRaw = Number(d.confidence);
    const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0;
    const params = (d.params && typeof d.params === 'object') ? d.params : {};
    const reason = typeof d.reason === 'string' ? d.reason : '';

    // Normalisasi intent agar typo/case sederhana dari model tidak langsung
    // menjatuhkan pesan natural-language ke /help.
    const normalizedIntent = String(intent).trim().toLowerCase();
    const validIntents = new Set([
        'buat_jadwal_biasa', 'buat_tugas', 'lihat_jadwal', 'lihat_tugas',
        'lihat_poin', 'hapus_jadwal', 'hapus_tugas', 'bantuan',
        'admin_tambah_user', 'admin_hapus_user', 'admin_lihat_user',
        'admin_jadwal_semua', 'admin_tugas_semua', 'laporan_kirim',
        'laporan_grup_daftar', 'laporan_jam_tambah', 'laporan_jam_daftar',
        'rekap_user', 'unknown'
    ]);

    return {
        intent: validIntents.has(normalizedIntent) ? normalizedIntent : 'unknown',
        confidence,
        params,
        reason
    };
}
