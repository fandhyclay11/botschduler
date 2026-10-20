// phaseD/roasting.js
// -------------------------------------------------------------
// D1 — AI-generated roasting untuk leaderboard laporan.
//
// Kontrak:
//   generateRoasting(entries) → string | null
//   - null berarti AI tidak menghasilkan output; caller HARUS fallback
//     ke roasting lokal existing (phaseC/roasting.js).
//   - Roasting ringan, playful, TIDAK menyerang tubuh/keluarga/agama/etnis.
// -------------------------------------------------------------

import { chat } from './client.js';

const SYSTEM_PROMPT = `Kamu adalah asisten yang menghasilkan roasting ringan dan motivasi playful untuk laporan leaderboard poin harian bot WhatsApp berbahasa Indonesia.

ATURAN KETAT:
- Bahasa Indonesia santai, ringan, playful.
- Roasting HANYA untuk 1-2 orang di peringkat BAWAH.
- Motivasi umum untuk semua di baris terakhir.
- DILARANG menyerang: tubuh, keluarga, agama, etnis, gender, orientasi, kondisi kesehatan, atau karakter pribadi.
- DILARANG kata kasar / makian.
- Maksimal 3 baris total. Setiap baris satu kalimat pendek.
- Boleh pakai emoji 1-2 per baris.
- Jangan menyebut nama orang di baris motivasi umum.

Output HANYA teks roasting + motivasi, tanpa preamble / komentar / kutip.`;

function buildUserPrompt(entries) {
    const list = entries
        .map((e, i) => `${i + 1}. ${e.name || e.id} — ${e.points} poin`)
        .join('\n');
    return `Leaderboard bulan ini (urut peringkat):\n${list}\n\nBuat roasting untuk 1-2 nama di peringkat paling bawah + motivasi umum di baris terakhir.`;
}

export async function generateRoasting(entries) {
    if (!Array.isArray(entries) || entries.length < 2) return null;

    const r = await chat([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(entries) }
    ], { temperature: 0.9, maxTokens: 200 });

    if (!r.ok) return null;
    const text = (r.text || '').trim();
    if (!text) return null;
    // Guard: kalau AI reply terlalu panjang / mengandung kata terlarang basic → drop
    if (text.length > 500) return null;
    return text;
}
