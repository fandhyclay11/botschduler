// phaseC/reports.js
// -------------------------------------------------------------
// Report engine: leaderboard harian (akumulasi bulan berjalan)
// dikirim ke setiap Report Group pada jam-jam yang dikonfigurasi.
//
// Filter anggota: leaderboard = poin GLOBAL, tapi hanya menampilkan
// canonical id yang saat ini menjadi anggota Report Group tersebut.
//
// Scheduler: interval 30 detik, mengecek apakah HH:MM saat ini
// termasuk waktu laporan aktif dan BELUM dikirim hari ini untuk
// grup + HH:MM tsb. Prinsip sama dengan reminderChecker existing —
// tidak membuat scheduler kedua yang duplikatif, hanya loop kecil
// independen agar reminderChecker existing tidak disentuh.
// -------------------------------------------------------------

import { getLeaderboard, getPointsSnapshot } from './points.js';
import { listReportGroups, listReportTimes } from './reportConfig.js';
import { buildRoasting } from './roasting.js';
import {
    canonicalFromParticipant,
    resolveCanonicalPhone,
    buildAliasTable
} from './identity.js';
import { appendLog } from './store.js';
// Fase D — AI roasting (opsional, fallback ke local template)
import { generateRoasting as aiGenerateRoasting } from '../phaseD/roasting.js';

const MEDALS = ['🥇', '🥈', '🥉'];
const NUM_EMOJI = ['4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const CHECK_INTERVAL_MS = 30_000;
const GRACE_MINUTES = 3;

// Anti-duplikasi runtime: key = `${date}|${groupId}|${hhmm}`
const sentTracker = new Set();

function nowParts() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return {
        now,
        date: `${y}-${m}-${d}`,
        hhmm: `${hh}:${mm}`,
        minutesOfDay: now.getHours() * 60 + now.getMinutes()
    };
}

function hhmmToMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
}

function formatDateID(date) {
    // "Senin, 8 September 2026"
    return date.toLocaleDateString('id-ID', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });
}

async function fetchGroupMemberCanonicals(ctx, groupId) {
    try {
        const meta = await ctx.sock.groupMetadata(groupId);
        const participants = Array.isArray(meta.participants) ? meta.participants : [];

        // Kumpulkan SEMUA kemungkinan canonical id untuk tiap member:
        //   - LID / phone / jid normalized apa adanya (via canonicalFromParticipant)
        //   - Phone canonical hasil resolve via users.json aliases
        // Ini penting karena poin bisa tersimpan sebagai LID (data lama) atau
        // sebagai phone (data baru), sementara identity WhatsApp bisa datang
        // dalam kedua bentuk. Tanpa union ini, filter membership bocor.
        const users = ctx.loadUsers ? ctx.loadUsers() : null;
        const aliasTable = buildAliasTable(users, ctx.normalizeUserId);

        const idSet = new Set();
        for (const p of participants) {
            const rawCandidates = [p.id, p.jid, p.phoneNumber, p.lid, p.alt]
                .filter(Boolean);

            // (a) semua kandidat mentah setelah normalisasi
            for (const c of rawCandidates) {
                const norm = ctx.normalizeUserId(c);
                if (norm) idSet.add(norm);
            }

            // (b) resolve ke phone canonical via users.json aliases
            const resolved = resolveCanonicalPhone(rawCandidates, users, ctx.normalizeUserId);
            if (resolved) idSet.add(resolved);

            // (c) juga tambahkan phone langsung dari aliasTable buat setiap
            //     kandidat yang cocok — biar coverage maksimal.
            for (const c of rawCandidates) {
                const norm = ctx.normalizeUserId(c);
                if (norm && aliasTable.has(norm)) idSet.add(aliasTable.get(norm));
            }
        }

        return Array.from(idSet);
    } catch (error) {
        appendLog('WARN', 'Gagal fetch group members', `group=${groupId} err=${error?.message || error}`);
        return null;
    }
}

async function renderLeaderboard(entries, dateLabel) {
    let text = `📊 *LAPORAN HARIAN*\n${dateLabel}\n\n🏆 REKAP POIN BULAN INI\n\n`;

    if (entries.length === 0) {
        text += '_Belum ada poin bulan ini._\n';
        return text;
    }

    entries.forEach((entry, index) => {
        const prefix = index < 3
            ? MEDALS[index]
            : (NUM_EMOJI[index - 3] || `${index + 1}.`);
        text += `${prefix} ${index + 1}. ${entry.name || entry.id} — ${entry.points} poin\n`;
    });

    // Coba AI dulu; kalau gagal / disabled, jatuhkan ke roasting lokal.
    let roast = null;
    try {
        roast = await aiGenerateRoasting(entries);
    } catch (e) {
        appendLog('WARN', 'AI roasting throw, fallback lokal', e?.message || e);
        roast = null;
    }
    if (!roast) roast = buildRoasting(entries);
    if (roast) text += `\n${roast}`;
    return text;
}

async function dispatchReport(ctx, groupId, dateLabel) {
    const memberIds = await fetchGroupMemberCanonicals(ctx, groupId);
    if (memberIds === null) {
        // Grup tidak terjangkau; skip aman.
        return false;
    }

    const entries = getLeaderboard(memberIds);
    const text = await renderLeaderboard(entries, dateLabel);

    try {
        await ctx.sock.sendMessage(groupId, { text });
        appendLog('REPORT', 'Laporan terkirim', `group=${groupId} entries=${entries.length}`);
        return true;
    } catch (error) {
        appendLog('ERROR', 'Gagal kirim laporan', `group=${groupId} err=${error?.message || error}`);
        return false;
    }
}

async function tick(ctx) {
    // Sentuh snapshot poin biar auto-reset bulan berjalan.
    getPointsSnapshot();

    const { now, date, minutesOfDay } = nowParts();
    const groups = listReportGroups();
    const times = listReportTimes();

    if (groups.length === 0 || times.length === 0) return;

    const dateLabel = formatDateID(now);

    for (const hhmm of times) {
        const target = hhmmToMinutes(hhmm);
        if (minutesOfDay < target) continue;
        if (minutesOfDay - target > GRACE_MINUTES) continue;

        for (const g of groups) {
            const key = `${date}|${g.id}|${hhmm}`;
            if (sentTracker.has(key)) continue;

            const ok = await dispatchReport(ctx, g.id, dateLabel);
            // Tandai walau gagal, agar tidak spam. Kalau perlu retry,
            // admin bisa pakai command "laporan kirim" manual.
            sentTracker.add(key);
            if (!ok) {
                appendLog('REPORT', 'Ditandai tersent walau gagal', `key=${key}`);
            }
        }
    }

    // Housekeeping: buang entri tracker yang bukan hari ini.
    for (const k of Array.from(sentTracker)) {
        if (!k.startsWith(`${date}|`)) sentTracker.delete(k);
    }
}

export function startReportScheduler(ctx) {
    appendLog('REPORT', 'Report scheduler start',
        `interval=${CHECK_INTERVAL_MS / 1000}s grace=${GRACE_MINUTES}min`);
    const timer = setInterval(() => {
        tick(ctx).catch(err => appendLog('ERROR', 'Report tick error', err?.message || err));
    }, CHECK_INTERVAL_MS);
    // Jalankan sekali di awal
    tick(ctx).catch(err => appendLog('ERROR', 'Report initial tick error', err?.message || err));
    return timer;
}

// Untuk perintah manual "laporan kirim sekarang".
export async function sendReportsNow(ctx) {
    const { now } = nowParts();
    const dateLabel = formatDateID(now);
    const groups = listReportGroups();
    if (groups.length === 0) return { ok: false, error: 'Belum ada grup laporan.' };
    for (const g of groups) {
        await dispatchReport(ctx, g.id, dateLabel);
    }
    return { ok: true, count: groups.length };
}
