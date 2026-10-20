// phaseC/identity.js
// -------------------------------------------------------------
// Canonical identity util untuk Fase C.
//
// PENTING: Kita TIDAK menduplikasi normalizeUserId dari baseline.
// Fungsi ini di-inject dari index.js via ctx.normalizeUserId agar
// aturan normalisasi TETAP KONSISTEN dengan baseline (LID/@lid/
// prefix 62/0 handling sama persis).
// -------------------------------------------------------------

// Turunkan canonical id dari list kandidat identitas mentah.
// Mengembalikan string kosong kalau tidak ada yang valid.
export function canonicalFromCandidates(candidates, normalizeUserId) {
    if (!Array.isArray(candidates)) return '';
    for (const c of candidates) {
        const norm = normalizeUserId(c);
        if (norm) return norm;
    }
    return '';
}

// Ekstrak canonical id + display name dari objek participant Baileys.
// participant biasa punya field { id, jid, phoneNumber, lid, alt, notify, name }.
export function canonicalFromParticipant(participant, normalizeUserId) {
    if (!participant) return { id: '', name: '' };
    const id = canonicalFromCandidates(
        [
            participant.id,
            participant.jid,
            participant.phoneNumber,
            participant.lid,
            participant.alt
        ],
        normalizeUserId
    );
    const name = participant.notify || participant.name || '';
    return { id, name };
}

// Ambil canonical id dari message.key untuk reaction/sender.
export function canonicalFromMessageKey(key, normalizeUserId) {
    if (!key) return '';
    return canonicalFromCandidates(
        [
            key.participantPn,
            key.participant,
            key.participantAlt,
            key.remoteJidAlt,
            key.remoteJid
        ],
        normalizeUserId
    );
}

// Ambil SEMUA kandidat mentah (belum dinormalisasi) dari message.key.
// Berguna untuk resolusi LID → phone via users.json.
export function allCandidatesFromMessageKey(key) {
    if (!key) return [];
    return [
        key.participantPn,
        key.participant,
        key.participantAlt,
        key.remoteJidAlt,
        key.remoteJid
    ].filter(Boolean);
}

// Petakan tabel alias dari users.json:
//   Map<normalizedId, canonicalPhone>
// - Kunci: phone canonical + setiap alias (termasuk @lid) yang tercatat.
// - Nilai: canonical phone yang terdaftar di users.json.
// Fungsi ini murni: tidak baca file, tinggal terima objek users.
export function buildAliasTable(users, normalizeUserId) {
    const table = new Map();
    if (!users) return table;

    const walk = (record) => {
        if (typeof record === 'string') {
            const p = normalizeUserId(record);
            if (p) table.set(p, p);
            return;
        }
        if (!record) return;
        const phone = normalizeUserId(record.phone || record.jid);
        if (!phone) return;
        table.set(phone, phone);
        const aliases = Array.isArray(record.aliases) ? record.aliases : [];
        for (const a of aliases) {
            const norm = normalizeUserId(a);
            if (norm) table.set(norm, phone);
        }
    };

    (users.admins || []).forEach(walk);
    (users.users || []).forEach(walk);

    return table;
}

// Cari canonical phone dari daftar kandidat mentah.
// - Kalau salah satu kandidat cocok dengan entri users.json (phone atau alias),
//   kembalikan phone-nya (canonical).
// - Kalau tidak ada yang cocok, fallback ke normalizeUserId(kandidat pertama).
export function resolveCanonicalPhone(candidates, users, normalizeUserId) {
    if (!Array.isArray(candidates) || candidates.length === 0) return '';
    const table = buildAliasTable(users, normalizeUserId);
    for (const cand of candidates) {
        const norm = normalizeUserId(cand);
        if (!norm) continue;
        if (table.has(norm)) return table.get(norm);
    }
    // Fallback: first normalized non-empty
    for (const cand of candidates) {
        const norm = normalizeUserId(cand);
        if (norm) return norm;
    }
    return '';
}

// Cari display name di users.json untuk canonical phone.
export function displayNameFromUsers(canonicalId, users, normalizeUserId) {
    if (!canonicalId || !users) return '';
    const scan = (record) => {
        if (typeof record === 'string') return '';
        if (!record) return '';
        const phone = normalizeUserId(record.phone || record.jid);
        if (phone === canonicalId) return record.name || '';
        const aliases = Array.isArray(record.aliases) ? record.aliases : [];
        for (const a of aliases) {
            if (normalizeUserId(a) === canonicalId) return record.name || '';
        }
        return '';
    };
    for (const a of (users.admins || [])) {
        const n = scan(a);
        if (n) return n;
    }
    for (const u of (users.users || [])) {
        const n = scan(u);
        if (n) return n;
    }
    return '';
}
