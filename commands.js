// phaseC/commands.js
// -------------------------------------------------------------
// Command handler tambahan untuk Fase C.
// Dipanggil di dalam messages.upsert PRIVATE branch pada index.js,
// SEBELUM help fallback baseline. Return true = command dikonsumsi.
//
// Command list:
//   tugas               → daftar tugas (owner atau semua kalau ADMIN + "tugas semua")
//   tugas semua         → ADMIN: daftar semua tugas
//   hapus tugas N       → hapus meta task + reminder-nya (poin tetap)
//   hapus tugas N,M     → multi
//   poin                → snapshot poin bulan berjalan (top 20)
//   laporan grup tambah <groupId|nomor> → ADMIN
//   laporan grup daftar → ADMIN
//   laporan grup hapus <groupId|nomor>  → ADMIN
//   laporan jam tambah HH:MM             → ADMIN
//   laporan jam daftar                    → ADMIN
//   laporan jam hapus HH:MM               → ADMIN
//   laporan kirim                          → ADMIN (test manual)
//   tugas bantuan | fase c bantuan | phase c help → help
// -------------------------------------------------------------

import {
    loadTasks,
    removeTaskMeta
} from './tasks.js';
import { getPointsSnapshot } from './points.js';
import {
    listReportGroups, addReportGroup, removeReportGroup,
    listReportTimes, addReportTime, removeReportTime
} from './reportConfig.js';
import { sendReportsNow } from './reports.js';
import { appendLog } from './store.js';

function isAdminSender(ctx, users, senderPhone) {
    return ctx.isAdmin(users, senderPhone);
}

// ----- daftar tugas -----
async function cmdListTasks(ctx, jid, senderPhone, showAll) {
    const users = ctx.loadUsers();
    const admin = isAdminSender(ctx, users, senderPhone);
    if (showAll && !admin) {
        await ctx.sock.sendMessage(jid, {
            text: '❌ Hanya ADMIN yang boleh melihat semua tugas.'
        });
        return;
    }

    const tasksMap = loadTasks();
    const reminders = ctx.loadReminders();
    const chatNames = await ctx.getChatNameMap(ctx.sock).catch(() => new Map());

    const list = reminders
        .filter(r => tasksMap[String(r.id)])
        .filter(r => showAll || ctx.normalizeUserId(r.ownerJid) === senderPhone);

    if (list.length === 0) {
        await ctx.sock.sendMessage(jid, {
            text: showAll ? '📭 Belum ada tugas di seluruh bot.' : '📭 Anda belum memiliki tugas.'
        });
        return;
    }

    let text = '🎯 *DAFTAR TUGAS*\n\n';
    list.forEach((r, i) => {
        const meta = tasksMap[String(r.id)];
        const chatName = chatNames.get(r.chatId) || r.chatId;
        text += `${i + 1}. *${chatName}*\n`;
        text += `   ⏰ ${r.time}\n`;
        text += `   🔁 ${ctx.recurrenceLabel(r)}\n`;
        text += `   📌 ${r.text}\n`;
        text += `   🏅 ${meta.points} poin\n\n`;
    });
    text += 'Untuk hapus: *hapus tugas 1* atau *hapus tugas 1,2*';

    // Simpan mapping view untuk hapus-by-index
    ctx.setPhaseCTaskView(jid, list.map(r => r.id));

    await ctx.sock.sendMessage(jid, { text: text.trim() });
}

// ----- hapus tugas -----
async function cmdDeleteTasks(ctx, jid, senderPhone, indexStr) {
    const users = ctx.loadUsers();
    const admin = isAdminSender(ctx, users, senderPhone);

    const viewIds = ctx.getPhaseCTaskView(jid) || [];
    if (viewIds.length === 0) {
        await ctx.sock.sendMessage(jid, {
            text: '❌ Belum ada daftar tugas aktif. Ketik *tugas* dulu.'
        });
        return;
    }

    const nums = indexStr.split(',').map(v => Number(v.trim()) - 1).filter(Number.isInteger);
    if (nums.length === 0) {
        await ctx.sock.sendMessage(jid, { text: '❌ Format tidak valid.' });
        return;
    }

    const unique = [...new Set(nums)];
    if (unique.some(i => i < 0 || i >= viewIds.length)) {
        await ctx.sock.sendMessage(jid, {
            text: '❌ Nomor tugas tidak ditemukan. Ketik *tugas* untuk refresh.'
        });
        return;
    }

    const targetIds = unique.map(i => viewIds[i]);
    const reminders = ctx.loadReminders();
    const targetSet = new Set(targetIds.map(String));
    const targets = reminders.filter(r => targetSet.has(String(r.id)));

    // Otorisasi: bukan admin harus owner
    if (!admin) {
        for (const r of targets) {
            if (ctx.normalizeUserId(r.ownerJid) !== senderPhone) {
                await ctx.sock.sendMessage(jid, {
                    text: '❌ Anda hanya boleh menghapus tugas milik sendiri.'
                });
                return;
            }
        }
    }

    // Hapus meta task
    for (const id of targetIds) removeTaskMeta(id);

    // Hapus reminder existing (poin tetap ada di points.json)
    const remaining = reminders.filter(r => !targetSet.has(String(r.id)));
    ctx.saveReminders(remaining);
    ctx.scheduleReminderChecker(ctx.sock);
    ctx.clearPhaseCTaskView(jid);

    let msg = '🗑️ *TUGAS DIHAPUS*\n\n';
    targets.forEach(r => {
        msg += `📌 ${r.text}\n⏰ ${r.time}\n🔁 ${ctx.recurrenceLabel(r)}\n\n`;
    });
    msg += '_Poin yang sudah diperoleh tetap ada._';
    await ctx.sock.sendMessage(jid, { text: msg.trim() });
    appendLog('CMD', 'Task deleted', `ids=${targetIds.join(',')} by=${senderPhone}`);
}

// ----- poin snapshot -----
async function cmdPoints(ctx, jid) {
    const snap = getPointsSnapshot();
    const users = Object.values(snap.users)
        .filter(u => u.points > 0)
        .sort((a, b) => b.points - a.points)
        .slice(0, 20);

    if (users.length === 0) {
        await ctx.sock.sendMessage(jid, {
            text: `📊 *POIN BULAN ${snap.month}*\n\n_Belum ada poin bulan ini._`
        });
        return;
    }
    let text = `📊 *POIN BULAN ${snap.month}*\n\n`;
    users.forEach((u, i) => {
        text += `${i + 1}. ${u.name || u.id} — ${u.points} poin\n`;
    });
    await ctx.sock.sendMessage(jid, { text: text.trim() });
}

// ----- laporan grup helpers -----
// Referensi grup untuk command laporan bisa berupa:
//   1) Nomor urut dari `laporan grup pilih` (state disimpan sementara)
//   2) groupId lengkap "xxxxx@g.us"
// String bebas seperti "WORKLIST" DITOLAK — tidak akan otomatis di-append "@g.us".
function isValidGroupId(value) {
    return /^[0-9\-]+@g\.us$/.test(String(value || '').trim());
}

// State picker admin: Map<jid, groups[]>
const reportGroupPickers = new Map();

function resolveGroupRef(ctx, jid, ref) {
    const trimmed = String(ref || '').trim();
    if (!trimmed) return null;

    // A) Nomor urut dari picker "laporan grup pilih"
    if (/^\d+$/.test(trimmed)) {
        const picker = reportGroupPickers.get(jid);
        if (picker && picker.length > 0) {
            const idx = Number(trimmed) - 1;
            if (idx >= 0 && idx < picker.length) return picker[idx];
        }
    }

    // B) groupId lengkap
    if (isValidGroupId(trimmed)) {
        return { id: trimmed, name: '' };
    }

    return null;
}

async function fetchAllGroupsForAdmin(ctx) {
    return ctx.getParticipatingGroups(ctx.sock);
}

async function cmdReportGroupPick(ctx, jid) {
    const groups = await fetchAllGroupsForAdmin(ctx);
    if (groups.length === 0) {
        await ctx.sock.sendMessage(jid, {
            text: '📭 Bot belum menjadi anggota grup mana pun.'
        });
        return;
    }
    reportGroupPickers.set(jid, groups.map(g => ({ id: g.id, name: g.name })));
    let text = '📋 *PILIH GRUP LAPORAN (dari grup bot)*\n\n';
    groups.forEach((g, i) => { text += `${i + 1}. ${g.name}\n`; });
    text += '\nGunakan: *laporan grup tambah <nomor>*';
    await ctx.sock.sendMessage(jid, { text });
}

async function cmdReportGroupList(ctx, jid) {
    const groups = listReportGroups();
    if (groups.length === 0) {
        await ctx.sock.sendMessage(jid, { text: '📭 Belum ada grup laporan.' });
        return;
    }
    let text = '📋 *DAFTAR GRUP LAPORAN*\n\n';
    groups.forEach((g, i) => {
        text += `${i + 1}. ${g.name || '(tanpa nama)'} — \`${g.id}\`\n`;
    });
    await ctx.sock.sendMessage(jid, { text: text.trim() });
}

async function cmdReportGroupAdd(ctx, jid, ref) {
    const target = resolveGroupRef(ctx, jid, ref);
    if (!target) {
        await ctx.sock.sendMessage(jid, {
            text:
`❌ Referensi grup tidak valid.
Gunakan salah satu:
1. *laporan grup pilih* → lalu *laporan grup tambah <nomor>*
2. *laporan grup tambah 12036xxx@g.us* (groupId lengkap)`
        });
        return;
    }
    // Konfirmasi bot memang anggota grup tsb (biar tidak nyimpen ID sampah).
    const allGroups = await fetchAllGroupsForAdmin(ctx);
    const meta = allGroups.find(g => g.id === target.id);
    if (!meta) {
        await ctx.sock.sendMessage(jid, {
            text: `❌ Bot bukan anggota grup ini (\`${target.id}\`). Tambahkan bot dulu.`
        });
        return;
    }
    const result = addReportGroup(target.id, meta.name || target.name || '');
    if (!result.ok) {
        await ctx.sock.sendMessage(jid, { text: `❌ ${result.error}` });
        return;
    }
    await ctx.sock.sendMessage(jid, {
        text: `✅ Grup laporan ditambah: *${meta.name || target.id}*`
    });
}

async function cmdReportGroupRemove(ctx, jid, ref) {
    const existing = listReportGroups();
    // Untuk remove, izinkan nomor dari daftar laporan aktif juga.
    const trimmed = String(ref || '').trim();
    let targetId = null;
    if (/^\d+$/.test(trimmed)) {
        const idx = Number(trimmed) - 1;
        if (idx >= 0 && idx < existing.length) targetId = existing[idx].id;
    } else if (isValidGroupId(trimmed)) {
        targetId = trimmed;
    }
    if (!targetId) {
        await ctx.sock.sendMessage(jid, {
            text: '❌ Referensi grup tidak valid. Gunakan nomor dari *laporan grup daftar* atau groupId lengkap.'
        });
        return;
    }
    const result = removeReportGroup(targetId);
    await ctx.sock.sendMessage(jid, {
        text: result.ok
            ? `🗑️ Grup laporan dihapus: \`${targetId}\``
            : `❌ ${result.error}`
    });
}

// ----- laporan jam -----
async function cmdReportTimeList(ctx, jid) {
    const times = listReportTimes();
    if (times.length === 0) {
        await ctx.sock.sendMessage(jid, { text: '📭 Belum ada jam laporan.' });
        return;
    }
    await ctx.sock.sendMessage(jid, {
        text: `⏰ *JAM LAPORAN AKTIF*\n\n${times.map(t => `• ${t}`).join('\n')}`
    });
}

async function cmdReportTimeAdd(ctx, jid, hhmm) {
    const result = addReportTime(hhmm);
    await ctx.sock.sendMessage(jid, {
        text: result.ok ? `✅ Jam laporan ditambah: *${hhmm}*` : `❌ ${result.error}`
    });
}

async function cmdReportTimeRemove(ctx, jid, hhmm) {
    const result = removeReportTime(hhmm);
    await ctx.sock.sendMessage(jid, {
        text: result.ok ? `🗑️ Jam laporan dihapus: *${hhmm}*` : `❌ ${result.error}`
    });
}

async function cmdReportSendNow(ctx, jid) {
    const result = await sendReportsNow(ctx);
    await ctx.sock.sendMessage(jid, {
        text: result.ok
            ? `📤 Laporan dikirim ke ${result.count} grup.`
            : `❌ ${result.error}`
    });
}

// ----- help -----
async function cmdHelp(ctx, jid, admin) {
    let text =
`🎯 *FASE C — BANTUAN*

*Tugas:*
• *buat jadwal* → pilih Jadwal Biasa atau Jadikan Tugas
• *tugas* → daftar tugas milik sendiri
• *hapus tugas 1* atau *hapus tugas 1,2* → hapus tugas
• *poin* → snapshot poin bulan ini

Anggota grup menyelesaikan tugas dengan *reaction* pada pesan tugas.`;

    if (admin) {
        text +=
`

*ADMIN — Laporan:*
• *tugas semua* → semua tugas seluruh user
• *laporan grup pilih* → tampilkan daftar grup bot (pakai nomornya)
• *laporan grup daftar*
• *laporan grup tambah <nomor|groupId>*
• *laporan grup hapus <nomor|groupId>*
• *laporan jam daftar*
• *laporan jam tambah HH:MM*
• *laporan jam hapus HH:MM*
• *laporan kirim* → kirim laporan sekarang (test)`;
    }
    await ctx.sock.sendMessage(jid, { text });
}

// ------------- ENTRY POINT -------------
export async function tryHandlePhaseCCommand(ctx, jid, text, senderPhone) {
    // Fase C command hanya di chat pribadi.
    if (jid.endsWith('@g.us')) return false;

    const lower = text.toLowerCase().trim();
    const users = ctx.loadUsers();
    const admin = isAdminSender(ctx, users, senderPhone);

    if (lower === 'tugas' || lower === 'lihat tugas') {
        await cmdListTasks(ctx, jid, senderPhone, false);
        return true;
    }
    if (lower === 'tugas semua') {
        await cmdListTasks(ctx, jid, senderPhone, true);
        return true;
    }

    const delMatch = text.match(/^hapus\s+tugas\s+(.+)$/i);
    if (delMatch) {
        await cmdDeleteTasks(ctx, jid, senderPhone, delMatch[1]);
        return true;
    }

    if (lower === 'poin' || lower === 'poin bulan ini') {
        await cmdPoints(ctx, jid);
        return true;
    }

    if (lower === 'tugas bantuan' || lower === 'fase c bantuan' || lower === 'phase c help') {
        await cmdHelp(ctx, jid, admin);
        return true;
    }

    // ---- ADMIN only ----
    if (!admin) return false;

    const rgAdd = text.match(/^laporan\s+grup\s+tambah\s+(.+)$/i);
    if (rgAdd) { await cmdReportGroupAdd(ctx, jid, rgAdd[1]); return true; }

    const rgDel = text.match(/^laporan\s+grup\s+hapus\s+(.+)$/i);
    if (rgDel) { await cmdReportGroupRemove(ctx, jid, rgDel[1]); return true; }

    if (lower === 'laporan grup daftar' || lower === 'laporan grup list') {
        await cmdReportGroupList(ctx, jid); return true;
    }

    if (lower === 'laporan grup pilih') {
        await cmdReportGroupPick(ctx, jid); return true;
    }

    const rtAdd = text.match(/^laporan\s+jam\s+tambah\s+(\d{1,2}:\d{2})$/i);
    if (rtAdd) { await cmdReportTimeAdd(ctx, jid, rtAdd[1]); return true; }

    const rtDel = text.match(/^laporan\s+jam\s+hapus\s+(\d{1,2}:\d{2})$/i);
    if (rtDel) { await cmdReportTimeRemove(ctx, jid, rtDel[1]); return true; }

    if (lower === 'laporan jam daftar' || lower === 'laporan jam list') {
        await cmdReportTimeList(ctx, jid); return true;
    }

    if (lower === 'laporan kirim' || lower === 'laporan sekarang') {
        await cmdReportSendNow(ctx, jid); return true;
    }

    return false;
}

// -------------------------------------------------------------
// Public API untuk phaseD/router (NL) — re-export helper internal
// dengan nama yang lebih generik. Tidak mengubah fungsi lama.
// -------------------------------------------------------------
export {
    cmdListTasks as listTasks,
    cmdPoints as showPoints,
    cmdReportGroupList as listReportGroupsCmd,
    cmdReportTimeList as listReportTimesCmd,
    cmdReportGroupPick as pickReportGroupCmd,
    cmdHelp as sendHelp
};
