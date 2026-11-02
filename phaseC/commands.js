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
//   nama <phone> <display name>            → ADMIN: set nama tampilan leaderboard
//   nama tampilan <phone> <display name>   → ADMIN: alias dari "nama ..."
//   rekap user: (multiline)                → ADMIN: deterministik, tanpa AI;
//                                            format baris berikut: Nama 628xxx ROLE
//   tugas bantuan | fase c bantuan | phase c help → help
//
// Catatan penting:
//   - "nama ..." TIDAK menambah entri users.json (akses), TIDAK membuat
//     anggota roster baru, TIDAK mengubah role existing. Hanya menulis ke
//     roster.displayNames.
//   - "rekap user:" dieksekusi via roster.upsertMember() dan TIDAK pernah
//     menulis users.json. Nonadmin mendapatkan penolakan eksplisit;
//     format invalid dibalas dengan panduan format, tidak jatuh ke AI.
// -------------------------------------------------------------

import {
    loadTasks,
    removeTaskMeta
} from './tasks.js';
import { getPointsSnapshot, subtractPoints } from './points.js';
import {
    listReportGroups, addReportGroup, removeReportGroup,
    listReportTimes, addReportTime, removeReportTime
} from './reportConfig.js';
import { sendReportsNow } from './reports.js';
import { appendLog } from './store.js';
import { isTaskReminderEnabled, listTaskReminderGroups, setTaskReminderEnabled } from './taskReminders.js';
import {
    setDisplayName,
    getRoles,
    upsertMember
} from './roster.js';

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

// ----- pengurangan poin (ADMIN) -----
async function cmdSubtractPoints(ctx, jid, senderPhone, phone, amount) {
    if (!isAdminSender(ctx, ctx.loadUsers(), senderPhone)) {
        await ctx.sock.sendMessage(jid, { text: '❌ Hanya ADMIN.' });
        return;
    }
    const canonical = ctx.normalizeUserId(phone);
    const result = subtractPoints(canonical, amount);
    await ctx.sock.sendMessage(jid, {
        text: result.ok
            ? `✅ Poin ${result.name || canonical} dikurangi ${result.removed}. Total: ${result.after} poin.`
            : `❌ ${result.error}`
    });
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
const taskReminderGroupPickers = new Map();

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

async function cmdTaskReminderGroupPick(ctx, jid) {
    const groups = await fetchAllGroupsForAdmin(ctx);
    if (!groups.length) {
        await ctx.sock.sendMessage(jid, { text: '📭 Bot belum menjadi anggota grup mana pun.' });
        return;
    }
    taskReminderGroupPickers.set(jid, groups.map(g => ({ id: g.id, name: g.name })));
    let text = '📋 *PILIH GRUP PENGINGAT TUGAS*\n\n';
    groups.forEach((g, i) => { text += `${i + 1}. ${g.name} — ${isTaskReminderEnabled(g.id) ? 'aktif' : 'nonaktif'}\n`; });
    text += '\nPilih dengan: *pengingat aktif <nomor>* atau *pengingat nonaktif <nomor>*';
    await ctx.sock.sendMessage(jid, { text });
}

async function cmdTaskReminderList(ctx, jid) {
    const groups = await fetchAllGroupsForAdmin(ctx);
    if (!groups.length) {
        await ctx.sock.sendMessage(jid, { text: '📭 Bot belum menjadi anggota grup mana pun.' });
        return;
    }
    const enabled = new Set(listTaskReminderGroups());
    let text = '🔔 *STATUS PENGINGAT TUGAS*\n\n';
    groups.forEach(g => { text += `• ${g.name}: ${enabled.has(g.id) ? 'aktif' : 'nonaktif'}\n`; });
    await ctx.sock.sendMessage(jid, { text: text.trim() });
}

async function cmdTaskReminderSet(ctx, jid, enabled, ref) {
    const value = String(ref || '').trim();
    const groups = taskReminderGroupPickers.get(jid) || [];
    const selected = /^\d+$/.test(value) ? groups[Number(value) - 1] : null;
    const current = await fetchAllGroupsForAdmin(ctx);
    const targetId = selected?.id || (/^[0-9-]+@g\.us$/.test(value) ? value : '');
    const target = current.find(g => g.id === targetId) || null;
    if (!target) {
        await ctx.sock.sendMessage(jid, { text: '❌ Grup tidak ditemukan. Ketik *pengingat grup pilih* lalu gunakan nomornya.' });
        return;
    }
    const result = setTaskReminderEnabled(target.id, enabled);
    await ctx.sock.sendMessage(jid, {
        text: result.ok
            ? `✅ Pengingat tugas ${enabled ? 'diaktifkan' : 'dinonaktifkan'} untuk *${target.name || target.id}*. Status saat ini: *${enabled ? 'aktif' : 'nonaktif'}*.`
            : `❌ ${result.error}`
    });
}

// ----- nama tampilan (ADMIN) -----
// Deterministik, bypass AI. Hanya menulis ke roster.displayNames.
// Tidak mengubah role, tidak menambah entri users.json, tidak membuat
// anggota roster baru.
async function cmdSetDisplayName(ctx, jid, senderPhone, phoneArg, nameArg) {
    if (!isAdminSender(ctx, ctx.loadUsers(), senderPhone)) {
        await ctx.sock.sendMessage(jid, {
            text: 'Hanya ADMIN yang boleh mengatur nama tampilan.'
        });
        return;
    }
    const rawPhone = String(phoneArg || '').trim();
    const rawName = String(nameArg || '').trim();
    if (!rawPhone || !rawName) {
        await ctx.sock.sendMessage(jid, {
            text:
`Format tidak valid.
Gunakan:
  nama <nomor> <nama tampilan>
  nama tampilan <nomor> <nama tampilan>
Contoh:
  nama 628123456789 Budi Santoso`
        });
        return;
    }
    const canonical = ctx.normalizeUserId(rawPhone);
    if (!canonical) {
        await ctx.sock.sendMessage(jid, {
            text: 'Nomor tidak valid. Gunakan format 62xxxxxxxxxx.'
        });
        return;
    }
    const result = setDisplayName(canonical, rawName, ctx.normalizeUserId);
    if (!result.ok) {
        await ctx.sock.sendMessage(jid, { text: result.error || 'Gagal menyimpan nama.' });
        return;
    }
    const suffix = result.previous
        ? ` (sebelumnya: ${result.previous})`
        : '';
    await ctx.sock.sendMessage(jid, {
        text: `Nama tampilan untuk ${canonical} disimpan: ${rawName}${suffix}`
    });
    appendLog('CMD', 'Set display name',
        `by=${senderPhone} phone=${canonical} name=${rawName}`);
}

// ----- rekap user deterministik (ADMIN) -----
// Grammar baris pertama: "rekap user:" (opsional titik dua), lalu
// baris-baris "<Nama ...> <62xxxx> <ROLE>". Setiap baris diparse
// deterministik - tidak memanggil AI. Dieksekusi via upsertMember
// (hanya menulis ke roster.json). Tidak pernah menulis users.json.
function parseRekapUserBlock(text, validRoles) {
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return { ok: false, error: 'Blok rekap kosong.' };
    const first = lines[0].toLowerCase().replace(/\s+/g, ' ').trim();
    if (!/^rekap\s+user\s*:?$/.test(first)) {
        return { ok: false, error: 'Baris pertama harus "rekap user:".' };
    }
    const body = lines.slice(1);
    if (body.length === 0) {
        return { ok: false, error: 'Tidak ada baris data setelah "rekap user:".' };
    }
    const validUpper = new Set(validRoles.map(r => String(r).toUpperCase()));
    const items = [];
    const errors = [];
    body.forEach((raw, idx) => {
        const parts = raw.split(/\s+/);
        if (parts.length < 3) {
            errors.push(`Baris ${idx + 1}: format kurang (butuh Nama 62xxx ROLE).`);
            return;
        }
        const role = parts[parts.length - 1].toUpperCase();
        const phone = parts[parts.length - 2];
        const name = parts.slice(0, parts.length - 2).join(' ').trim();
        if (!name) {
            errors.push(`Baris ${idx + 1}: nama kosong.`);
            return;
        }
        if (!/^\d{6,}$/.test(phone)) {
            errors.push(`Baris ${idx + 1}: nomor "${phone}" tidak valid.`);
            return;
        }
        if (!validUpper.has(role)) {
            errors.push(`Baris ${idx + 1}: jabatan "${role}" tidak dikenal.`);
            return;
        }
        items.push({ name, phone, role });
    });
    return { ok: true, items, errors };
}

function isRekapUserTrigger(text) {
    return /^\s*rekap\s+user\b/i.test(String(text || ''));
}

async function cmdRekapUser(ctx, jid, senderPhone, text) {
    if (!isAdminSender(ctx, ctx.loadUsers(), senderPhone)) {
        await ctx.sock.sendMessage(jid, {
            text: 'Hanya ADMIN yang boleh rekap user.'
        });
        return;
    }
    const validRoles = getRoles();
    const parsed = parseRekapUserBlock(text, validRoles);
    if (!parsed.ok) {
        await ctx.sock.sendMessage(jid, {
            text:
`Format rekap user tidak valid: ${parsed.error}
Gunakan:
rekap user:
Nama Lengkap 628xxxxxxxxxx ROLE
Nama Lain 628xxxxxxxxxx ROLE

Jabatan valid: ${validRoles.join(', ')}`
        });
        return;
    }
    const okList = [];
    const failList = [...parsed.errors];
    for (const m of parsed.items) {
        const canonical = ctx.normalizeUserId(m.phone);
        if (!canonical) {
            failList.push(`${m.name} ${m.phone} - nomor tidak valid.`);
            continue;
        }
        const r = upsertMember(canonical, m.name, m.role, ctx.normalizeUserId);
        if (!r.ok) {
            failList.push(`${m.name} ${canonical} - ${r.error}`);
            continue;
        }
        okList.push(`${m.name} (${canonical}) - ${m.role}`);
    }
    let msg = 'REKAP USER\n';
    if (okList.length > 0) {
        msg += `\nBerhasil (${okList.length}):\n`;
        okList.forEach(l => { msg += `- ${l}\n`; });
    }
    if (failList.length > 0) {
        msg += `\nGagal (${failList.length}):\n`;
        failList.forEach(l => { msg += `- ${l}\n`; });
    }
    if (okList.length === 0 && failList.length === 0) {
        msg += '\nTidak ada data yang diproses.';
    }
    await ctx.sock.sendMessage(jid, { text: msg.trim() });
    appendLog('CMD', 'Rekap user (deterministik)',
        `by=${senderPhone} ok=${okList.length} fail=${failList.length}`);
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
• *laporan kirim* → kirim laporan sekarang (test)

*ADMIN — Nama tampilan & rekap:*
• *nama 628xxx Nama Lengkap* → set nama tampilan di leaderboard
• *nama tampilan 628xxx Nama Lengkap* → alias dari perintah di atas
• *rekap user:* (multiline) → set nama + jabatan secara deterministik
  Baris berikut: Nama Lengkap 628xxxxxxxxx ROLE`;
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

    // ---- Deterministik: rekap user multiline (admin-only, tapi dideteksi
    //      di sini supaya nonadmin tetap mendapat penolakan eksplisit dan
    //      bukan jatuh ke AI). ----
    if (isRekapUserTrigger(text)) {
        await cmdRekapUser(ctx, jid, senderPhone, text);
        return true;
    }

    // ---- Deterministik: set nama tampilan (admin-only, dengan explicit
    //      denial untuk nonadmin). "nama tampilan 628x ..." dicek dulu
    //      agar kata "tampilan" tidak masuk ke bagian nama. ----
    const namaTampilanMatch = text.match(/^nama\s+tampilan\s+(\d{6,})\s+(.+)$/i);
    if (namaTampilanMatch) {
        await cmdSetDisplayName(ctx, jid, senderPhone, namaTampilanMatch[1], namaTampilanMatch[2]);
        return true;
    }
    const namaMatch = text.match(/^nama\s+(\d{6,})\s+(.+)$/i);
    if (namaMatch) {
        await cmdSetDisplayName(ctx, jid, senderPhone, namaMatch[1], namaMatch[2]);
        return true;
    }
    // Bentuk invalid tapi berniat memanggil "nama ..." - jangan jatuh ke AI,
    // keluarkan pesan format.
    if (/^nama(\s+tampilan)?\b/i.test(text.trim()) &&
        !/^nama(\s+tampilan)?\s+\d{6,}\s+.+$/i.test(text.trim())) {
        if (!admin) {
            await ctx.sock.sendMessage(jid, {
                text: 'Hanya ADMIN yang boleh mengatur nama tampilan.'
            });
            return true;
        }
        await ctx.sock.sendMessage(jid, {
            text:
`Format tidak valid.
Gunakan:
  nama <nomor> <nama tampilan>
  nama tampilan <nomor> <nama tampilan>
Contoh:
  nama 628123456789 Budi Santoso`
        });
        return true;
    }

    // ---- ADMIN only ----
    if (/^pengingat(?:\s|$)/i.test(lower) && !admin) {
        await ctx.sock.sendMessage(jid, { text: '❌ Hanya ADMIN yang boleh mengubah pengingat tugas.' });
        return true;
    }
    if (!admin) return false;

    if (lower === 'pengingat grup pilih' || lower === 'pengingat pilih') {
        await cmdTaskReminderGroupPick(ctx, jid); return true;
    }
    if (lower === 'pengingat grup daftar' || lower === 'pengingat daftar') {
        await cmdTaskReminderList(ctx, jid); return true;
    }
    const reminderEnable = text.match(/^pengingat\s+(?:grup\s+)?aktif\s+(.+)$/i);
    if (reminderEnable) { await cmdTaskReminderSet(ctx, jid, true, reminderEnable[1]); return true; }
    const reminderDisable = text.match(/^pengingat\s+(?:grup\s+)?nonaktif\s+(.+)$/i);
    if (reminderDisable) { await cmdTaskReminderSet(ctx, jid, false, reminderDisable[1]); return true; }

    const deductMatch = text.match(/^(?:poin\s+kurang|kurangi\s+poin)\s+(\d{6,})\s+(\d+)$/i);
    if (deductMatch) {
        await cmdSubtractPoints(ctx, jid, senderPhone, deductMatch[1], Number(deductMatch[2]));
        return true;
    }

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

// ------------- ADAPTER UNTUK FASE D ROUTER -------------
// phaseD/router.js memanggil ctx.phaseC.<helper> lewat buildPhaseDCtx() di
// index.js. Handler internal (cmdListTasks, cmdPoints, dsb) di file ini
// bersifat lokal — tidak diexport. Adapter di bawah menyediakan nama yang
// dipakai router tanpa mengubah baseline internal.
export const listTasks = cmdListTasks;
export const showPoints = cmdPoints;
export const listReportGroupsCmd = cmdReportGroupList;
export const listReportTimesCmd = cmdReportTimeList;
export const sendHelp = cmdHelp;
