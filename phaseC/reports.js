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
import {
    getRoster,
    getRoles,
    getRoleLabel,
    getRoleByPhone,
    getNameByPhone,
    getMembersByRole,
    isMember
} from './roster.js';
import { appendLog } from './store.js';

const MEDALS = ['🥇', '🥈', '🥉'];
const NUM_EMOJI = ['4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const CHECK_INTERVAL_MS = 30_000;
const GRACE_MINUTES = 3;

// Anti-duplikasi runtime: key = `${date}|${groupId}|${hhmm}`
const sentTracker = new Set();
const inFlightTracker = new Set();
let schedulerTimer = null;
let schedulerCtx = null;

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

function renderLeaderboard(entries, dateLabel, memberIds) {
    // Grouped per jabatan (CIF → SCG). Dalam grup sort by poin desc.
    // Anggota terdaftar walau 0 poin: tetap tampil.
    // FILTER: hanya member roster yang canonical phone-nya ADA di memberIds
    //         (yaitu anggota grup laporan itu). Yang tidak di grup, di-skip.
    // SKIP: role yang setelah filter tidak punya anggota apapun — header
    //       role tidak muncul sama sekali (bukan "belum ada anggota").
    // Reactor tak terdaftar: blok "Belum Terdaftar" paling bawah.
    const roles = getRoles();
    const pointsById = new Map();
    for (const e of entries) pointsById.set(e.id, e);

    const memberSet = Array.isArray(memberIds) ? new Set(memberIds) : null;
    const grouped = getMembersByRole(); // { CIF: [{phone,name,role}], ... }

    let text = `📊 *LAPORAN HARIAN*\n${dateLabel}\n\n🏆 REKAP POIN BULAN INI\n`;

    for (const role of roles) {
        let members = grouped[role] || [];
        // Filter: hanya yg juga anggota grup laporan
        if (memberSet) {
            members = members.filter(m => memberSet.has(m.phone));
        }
        if (members.length === 0) continue; // skip role kosong sepenuhnya

        text += `\n*${role} — ${getRoleLabel(role)}*\n`;
        const withPoints = members.map(m => ({
            name: m.name || m.phone,
            phone: m.phone,
            points: (pointsById.get(m.phone)?.points) || 0
        })).sort((a, b) => b.points - a.points);

        withPoints.forEach((m, i) => {
            const prefix = i < 3 ? MEDALS[i] : (NUM_EMOJI[i - 3] || `${i + 1}.`);
            text += `${prefix} ${m.name} — ${m.points} poin\n`;
        });
    }

    // Blok "Belum Terdaftar" — reactor yang dapat poin tapi tidak ada di roster.
    // Tetap difilter: hanya yg canonical-nya juga anggota grup laporan.
    const unregistered = entries
        .filter(e => e.points > 0 && !isMember(e.id))
        .filter(e => !memberSet || memberSet.has(e.id))
        .sort((a, b) => b.points - a.points);
    if (unregistered.length > 0) {
        text += `\n*BELUM TERDAFTAR*\n`;
        unregistered.forEach((e, i) => {
            text += `• ${e.name || e.id} — ${e.points} poin\n`;
        });
    }

    // Penjelasan leaderboard selalu muncul setelah daftar poin dan
    // sebelum motivasi/roasting bot.
    text += `\n\n📝 *KETERANGAN LEADERBOARD*\n` +
        `Poin mencerminkan aktivitas, kedisiplinan, tanggung jawab, ` +
        `dan konsistensi dalam menyelesaikan tugas.\n` +
        `Rekap ini dapat menjadi salah satu bahan pertimbangan dalam ` +
        `evaluasi kinerja dan pengembangan atau promosi, namun bukan ` +
        `satu-satunya dasar penilaian. Penilaian tetap mempertimbangkan ` +
        `kualitas pekerjaan, sikap, kerja sama, kepatuhan terhadap ` +
        `prosedur, serta faktor lain yang relevan.\n`;

    const roast = buildRoasting(entries);
    if (roast) text += `\n💬 *MOTIVASI BOT*\n${roast}`;
    return text;
}

async function dispatchReport(ctx, groupId, dateLabel) {
    const memberIds = await fetchGroupMemberCanonicals(ctx, groupId);
    if (memberIds === null) {
        // Grup tidak terjangkau; skip aman.
        return false;
    }

    const entries = getLeaderboard(memberIds);
    const text = renderLeaderboard(entries, dateLabel, memberIds);

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
            if (sentTracker.has(key) || inFlightTracker.has(key)) continue;

            // Interval baru mungkin sudah menggantikan scheduler ini saat
            // tick lama masih berjalan. Jangan memulai pengiriman berikutnya
            // memakai socket yang sudah tidak aktif.
            if (schedulerCtx !== ctx) return;

            inFlightTracker.add(key);
            try {
                const ok = await dispatchReport(ctx, g.id, dateLabel);
                // Kegagalan fetch metadata atau kirim tetap dicoba lagi pada
                // tick berikutnya selama masih dalam grace period.
                if (ok) sentTracker.add(key);
            } finally {
                inFlightTracker.delete(key);
            }
        }
    }

    // Housekeeping: buang entri tracker yang bukan hari ini.
    for (const k of Array.from(sentTracker)) {
        if (!k.startsWith(`${date}|`)) sentTracker.delete(k);
    }
}

export function startReportScheduler(ctx) {
    // Koneksi WhatsApp dapat terbuka kembali berkali-kali. Ganti interval
    // sebelumnya agar jumlah scheduler tidak menumpuk.
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerCtx = ctx;

    appendLog('REPORT', 'Report scheduler start',
        `interval=${CHECK_INTERVAL_MS / 1000}s grace=${GRACE_MINUTES}min`);
    const timer = setInterval(() => {
        if (schedulerCtx !== ctx) return;
        tick(ctx).catch(err => appendLog('ERROR', 'Report tick error', err?.message || err));
    }, CHECK_INTERVAL_MS);
    schedulerTimer = timer;
    // Jalankan sekali di awal
    tick(ctx).catch(err => appendLog('ERROR', 'Report initial tick error', err?.message || err));
    return timer;
}

export function stopReportScheduler(sock) {
    // Abaikan close event dari socket lama jika scheduler sudah memakai
    // socket hasil reconnect yang lebih baru.
    if (sock && schedulerCtx?.sock !== sock) return false;

    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = null;
    schedulerCtx = null;
    appendLog('REPORT', 'Report scheduler stop');
    return true;
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
