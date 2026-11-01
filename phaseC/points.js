// phaseC/points.js
// -------------------------------------------------------------
// Sistem poin GLOBAL bulan berjalan.
// - Semua poin lintas grup masuk ke akun canonical user.
// - Awal bulan baru: akumulasi direset ke 0 otomatis saat write/read.
// - Identity canonical didefinisikan di identity.js (nomor tanpa
//   simbol, prefix 62 untuk Indonesia).
// - Nama disimpan sebagai display; boleh berubah.
// -------------------------------------------------------------

import { FILES, readJson, writeJson, appendLog } from './store.js';
import { getDisplayNameOverrides } from './roster.js';

function currentMonthKey(now = new Date()) {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

function loadRaw() {
    return readJson(FILES.points, { month: '', users: {} });
}

// Auto-reset kalau bulan sudah berganti.
function loadPointsForCurrentMonth() {
    const data = loadRaw();
    const month = currentMonthKey();

    if (data.month !== month) {
        appendLog('POINTS', 'Reset akumulasi bulan baru',
            `dari=${data.month || '(kosong)'} ke=${month}`);
        const fresh = { month, users: {} };
        writeJson(FILES.points, fresh);
        return fresh;
    }

    return data;
}

// Terapkan override nama tampilan (dari roster.displayNames) ke salinan
// snapshot tanpa menulis apa pun ke file poin. Nilai `points` tidak diubah.
function decorateWithOverrides(data) {
    const overrides = getDisplayNameOverrides();
    if (!overrides || Object.keys(overrides).length === 0) return data;
    const users = {};
    for (const [id, u] of Object.entries(data.users || {})) {
        const name = overrides[id] || u.name || '';
        users[id] = { ...u, name };
    }
    return { ...data, users };
}

export function getPointsSnapshot() {
    return decorateWithOverrides(loadPointsForCurrentMonth());
}

export function addPoints(canonicalId, displayName, amount) {
    if (!canonicalId || !Number.isFinite(amount)) return null;

    const data = loadPointsForCurrentMonth();

    if (!data.users[canonicalId]) {
        data.users[canonicalId] = {
            id: canonicalId,
            name: displayName || '',
            points: 0
        };
    }

    // Update nama kalau ada nama baru (nama adalah display, boleh berubah).
    if (displayName) {
        data.users[canonicalId].name = displayName;
    }

    data.users[canonicalId].points += Number(amount);
    // Poin tidak boleh minus.
    if (data.users[canonicalId].points < 0) {
        data.users[canonicalId].points = 0;
    }
    writeJson(FILES.points, data);

    appendLog('POINTS',
        `${amount >= 0 ? '+' : ''}${amount} poin`,
        `user=${canonicalId} name="${data.users[canonicalId].name}" total=${data.users[canonicalId].points}`);

    return data.users[canonicalId];
}

// Wrapper eksplisit untuk pengurangan poin. Nilai amount POSITIF, akan
// diterjemahkan ke pengurangan. Return { ok, before, after, name } atau
// { ok: false, error }.
export function subtractPoints(canonicalId, amount) {
    if (!canonicalId) return { ok: false, error: 'Nomor tidak valid.' };
    const n = Math.abs(Number(amount));
    if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, error: 'Jumlah poin tidak valid.' };
    }
    const data = loadPointsForCurrentMonth();
    const u = data.users[canonicalId];
    if (!u) return { ok: false, error: 'User tidak punya poin bulan ini.' };

    const before = u.points;
    const result = addPoints(canonicalId, u.name, -n);
    return {
        ok: true,
        before,
        after: result ? result.points : 0,
        name: u.name,
        removed: Math.min(n, before) // yang benar-benar terpotong (kalau kurang, ke-clamp ke 0)
    };
}

// Leaderboard: ranking global, DIFILTER berdasarkan list canonical
// anggota grup laporan. Kalau memberFilter null => semua user.
export function getLeaderboard(memberFilter = null) {
    const data = decorateWithOverrides(loadPointsForCurrentMonth());

    let entries = Object.values(data.users);

    if (Array.isArray(memberFilter)) {
        const allowed = new Set(memberFilter.filter(Boolean));
        entries = entries.filter(e => allowed.has(e.id));
    }

    return entries
        .filter(e => e.points > 0)
        .sort((a, b) => b.points - a.points);
}
