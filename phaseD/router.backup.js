// phaseD/router.js
// -------------------------------------------------------------
// D2 — Dispatch intent hasil classifyIntent() ke handler existing.
//
// Router HANYA memanggil fungsi baseline/phaseC yang sudah ada.
// Tidak menyentuh scheduler / queue / storage secara langsung.
//
// Kontrak:
//   dispatchIntent(ctx, jid, senderPhone, intent) → { handled: bool, reason?: string }
//     handled=true  → command sudah dieksekusi
//     handled=false → caller harus fallback ke help / prompt manual
//
// Ambang confidence:
//   >= 0.75  → eksekusi tanpa konfirmasi
//   0.55–0.75 → konfirmasi ke user (tanya dulu)
//   < 0.55   → tolak / minta rephrase
// -------------------------------------------------------------

import { phaseDLog } from './client.js';
import { upsertMember, getRoles } from '../phaseC/roster.js';

const CONFIDENCE_EXEC = 0.75;
const CONFIDENCE_ASK = 0.55;

// State konfirmasi pending per user (chat pribadi).
// Map<jid, { intent, expiresAt }>
const pendingConfirm = new Map();

// State pilihan grup untuk Natural Language (chat pribadi).
// Disimpan terpisah dari flow jadwal manual agar intent + parameter AI
// tetap utuh ketika user memilih salah satu dari banyak grup.
const pendingGroupChoice = new Map();

function isConfirmYes(text) {
    return /^(ya|iya|yes|y|ok|oke|okay|betul|benar|lanjut|gas)\.?$/i.test(text.trim());
}
function isConfirmNo(text) {
    return /^(tidak|no|n|gak|nggak|batal|cancel|salah)\.?$/i.test(text.trim());
}

export function hasPendingConfirm(jid) {
    const p = pendingConfirm.get(jid);
    if (!p) return false;
    if (Date.now() > p.expiresAt) {
        pendingConfirm.delete(jid);
        return false;
    }
    return true;
}

export async function handlePendingConfirm(ctx, jid, senderPhone, text) {
    const p = pendingConfirm.get(jid);
    if (!p) return { handled: false };
    pendingConfirm.delete(jid);

    if (isConfirmYes(text)) {
        return await executeIntent(ctx, jid, senderPhone, p.intent);
    }
    if (isConfirmNo(text)) {
        await ctx.sock.sendMessage(jid, { text: '❌ Dibatalkan.' });
        return { handled: true };
    }
    // Bukan yes/no → treat as new input, jangan eksekusi lama
    await ctx.sock.sendMessage(jid, {
        text: 'ℹ️ Konfirmasi sebelumnya dibatalkan karena kamu mengirim pesan baru.'
    });
    return { handled: false };
}

async function executeIntent(ctx, jid, senderPhone, intent) {
    const { intent: name, params = {} } = intent;
    phaseDLog('EXEC', `intent=${name}`, JSON.stringify(params).slice(0, 200));

    try {
        switch (name) {
            case 'buat_jadwal_biasa':
            case 'buat_tugas':
                return await execBuat(ctx, jid, senderPhone, intent);

            case 'lihat_jadwal':
                await ctx.sendPrivateScheduleList(ctx.sock, jid, false);
                return { handled: true };

            case 'lihat_tugas':
                await ctx.phaseC.listTasks(ctx, jid, senderPhone, false);
                return { handled: true };

            case 'lihat_poin':
                await ctx.phaseC.showPoints(ctx, jid);
                return { handled: true };

            case 'rekap_user':
                return await execRekapUser(ctx, jid, senderPhone, intent);

            case 'hapus_jadwal':
                return await execHapusJadwal(ctx, jid, senderPhone, params);

            case 'hapus_tugas':
                return await execHapusTugas(ctx, jid, senderPhone, params);

            case 'bantuan':
                await ctx.phaseC.sendHelp(ctx, jid, ctx.isAdmin(ctx.loadUsers(), senderPhone));
                return { handled: true };

            case 'admin_tambah_user':
                return await execAdminTambah(ctx, jid, senderPhone, params);

            case 'admin_hapus_user':
                return await execAdminHapus(ctx, jid, senderPhone, params);

            case 'admin_lihat_user':
                return await execAdminLihat(ctx, jid, senderPhone);

            case 'admin_jadwal_semua': {
                if (!ctx.isAdmin(ctx.loadUsers(), senderPhone)) {
                    await ctx.sock.sendMessage(jid, { text: '❌ Hanya ADMIN.' });
                    return { handled: true };
                }
                await ctx.sendPrivateScheduleList(ctx.sock, jid, true);
                return { handled: true };
            }

            case 'admin_tugas_semua': {
                if (!ctx.isAdmin(ctx.loadUsers(), senderPhone)) {
                    await ctx.sock.sendMessage(jid, { text: '❌ Hanya ADMIN.' });
                    return { handled: true };
                }
                await ctx.phaseC.listTasks(ctx, jid, senderPhone, true);
                return { handled: true };
            }

            case 'laporan_kirim': {
                if (!ctx.isAdmin(ctx.loadUsers(), senderPhone)) {
                    await ctx.sock.sendMessage(jid, { text: '❌ Hanya ADMIN.' });
                    return { handled: true };
                }
                await ctx.phaseC.sendReportsNow(ctx);
                await ctx.sock.sendMessage(jid, { text: '📤 Laporan dikirim.' });
                return { handled: true };
            }

            case 'laporan_grup_daftar':
                await ctx.phaseC.listReportGroupsCmd(ctx, jid);
                return { handled: true };

            case 'laporan_jam_tambah':
                return await execLaporanJamTambah(ctx, jid, senderPhone, params);

            case 'laporan_jam_daftar':
                await ctx.phaseC.listReportTimesCmd(ctx, jid);
                return { handled: true };

            default:
                return { handled: false, reason: 'intent-not-handled' };
        }
    } catch (error) {
        phaseDLog('ERROR', `exec ${name} throw`, error?.message || error);
        await ctx.sock.sendMessage(jid, { text: `❌ Gagal eksekusi: ${error?.message || error}` });
        return { handled: true };
    }
}

// --- Sub-executors ---

async function execBuat(ctx, jid, senderPhone, intent) {
    const { params = {} } = intent;
    const scheduleText = String(params.schedule || '').trim();
    if (!scheduleText) {
        await ctx.sock.sendMessage(jid, {
            text: '❌ Jadwal belum lengkap. Contoh: *setiap hari 08:00 briefing*'
        });
        return { handled: true };
    }

    const schedule = ctx.parseScheduleText(scheduleText);
    if (!schedule || schedule.error) {
        await ctx.sock.sendMessage(jid, {
            text: `❌ Format jadwal tidak dikenali: "${scheduleText}"`
        });
        return { handled: true };
    }

    const { groupsForUser } = await ctx.getUserParticipatingGroups(ctx.sock, senderPhone);
    if (groupsForUser.length === 0) {
        await ctx.sock.sendMessage(jid, {
            text: '❌ Belum ada grup yang kamu ikuti bersama bot. Tambahkan bot ke grup dulu.'
        });
        return { handled: true };
    }

    // Jika AI berhasil menemukan petunjuk nama grup, coba pilih otomatis
    // hanya bila hasilnya unik. Jangan pernah menebak bila ambigu.
    const groupHint = String(params.groupHint || '').trim().toLowerCase();
    if (groupHint) {
        const matches = groupsForUser.filter(g =>
            String(g.name || '').toLowerCase().includes(groupHint)
        );
        if (matches.length === 1) {
            return await executeBuatOnGroup(ctx, jid, senderPhone, intent, matches[0]);
        }
    }

    if (groupsForUser.length === 1) {
        return await executeBuatOnGroup(ctx, jid, senderPhone, intent, groupsForUser[0]);
    }

    // Multi-grup: simpan intent hasil AI agar user cukup memilih nomor grup.
    pendingGroupChoice.set(jid, {
        intent,
        senderPhone,
        groups: groupsForUser,
        expiresAt: Date.now() + 5 * 60 * 1000
    });

    let response = '📋 *PILIH GRUP TUJUAN*\n\n';
    groupsForUser.forEach((group, index) => {
        response += `${index + 1}. ${group.name}\n`;
    });
    response += '\nBalas dengan nomor grup.\nKetik *batal* untuk membatalkan.';

    await ctx.sock.sendMessage(jid, { text: response });
    return { handled: true };
}

async function executeBuatOnGroup(ctx, jid, senderPhone, intent, group) {
    const scheduleText = String(intent.params?.schedule || '').trim();
    const schedule = ctx.parseScheduleText(scheduleText);
    if (!schedule || schedule.error) {
        await ctx.sock.sendMessage(jid, {
            text: `❌ Format jadwal tidak dikenali: "${scheduleText}"`
        });
        return { handled: true };
    }

    const created = await ctx.createReminder(ctx.sock, jid, group.id, schedule, jid);
    if (!created) {
        await ctx.sock.sendMessage(jid, { text: '❌ Jadwal gagal dibuat.' });
        return { handled: true };
    }

    if (intent.intent === 'buat_tugas') {
        const points = Number(intent.params?.points) || 0;
        if (points <= 0) {
            await ctx.sock.sendMessage(jid, {
                text: '❌ Poin tugas belum valid. Contoh: "5 poin".'
            });
            return { handled: true };
        }

        const rem = ctx.findLatestReminder({
            chatId: group.id,
            time: schedule.time,
            text: schedule.text
        });
        if (!rem) {
            await ctx.sock.sendMessage(jid, {
                text: '❌ Jadwal berhasil dibuat, tetapi tugas belum bisa diberi poin.'
            });
            return { handled: true };
        }

        ctx.phaseC.markAsTask(rem, points, jid);
        await ctx.sock.sendMessage(jid, {
            text: `✅ Tugas dibuat di *${group.name}*\n⏰ ${schedule.time}\n⭐ Poin: ${points}`
        });
        return { handled: true };
    }

    await ctx.sock.sendMessage(jid, {
        text: `✅ Jadwal dibuat di *${group.name}*\n⏰ ${schedule.time}`
    });
    return { handled: true };
}

async function execHapusJadwal(ctx, jid, senderPhone, params) {
    if (params.all) {
        // Simulasi command "hapus semua" existing
        const admin = ctx.isAdmin(ctx.loadUsers(), senderPhone);
        const reminders = ctx.loadReminders();
        const target = admin
            ? reminders
            : reminders.filter(r => ctx.normalizeUserId(r.ownerJid) === senderPhone);
        if (target.length === 0) {
            await ctx.sock.sendMessage(jid, { text: '📭 Tidak ada jadwal untuk dihapus.' });
            return { handled: true };
        }
        const ids = new Set(target.map(r => r.id));
        ctx.saveReminders(reminders.filter(r => !ids.has(r.id)));
        ctx.scheduleReminderChecker(ctx.sock);
        await ctx.sock.sendMessage(jid, { text: `🗑️ ${target.length} jadwal dihapus.` });
        return { handled: true };
    }
    if (Array.isArray(params.indexes) && params.indexes.length > 0) {
        // NL delete-by-index rawan salah (index user tidak up-to-date).
        // Amanan: minta user pakai list dulu.
        await ctx.sock.sendMessage(jid, {
            text: `ℹ️ Untuk hapus by nomor, ketik *jadwal* dulu, lalu *hapus ${params.indexes.join(',')}*.`
        });
        return { handled: true };
    }
    await ctx.sock.sendMessage(jid, {
        text: 'ℹ️ Sebutkan nomor jadwal yang mau dihapus atau ketik "hapus semua".'
    });
    return { handled: true };
}

async function execHapusTugas(ctx, jid, senderPhone, params) {
    if (params.all) {
        await ctx.sock.sendMessage(jid, {
            text: 'ℹ️ Untuk hapus semua tugas, ketik *tugas* dulu untuk melihat daftar, lalu hapus manual dengan nomornya.'
        });
        return { handled: true };
    }
    if (Array.isArray(params.indexes) && params.indexes.length > 0) {
        await ctx.sock.sendMessage(jid, {
            text: `ℹ️ Untuk hapus tugas by nomor, ketik *tugas* dulu, lalu *hapus tugas ${params.indexes.join(',')}*.`
        });
        return { handled: true };
    }
    await ctx.sock.sendMessage(jid, { text: 'ℹ️ Sebutkan nomor tugas yang mau dihapus.' });
    return { handled: true };
}

async function execAdminTambah(ctx, jid, senderPhone, params) {
    if (!ctx.isAdmin(ctx.loadUsers(), senderPhone)) {
        await ctx.sock.sendMessage(jid, { text: '❌ Hanya ADMIN.' });
        return { handled: true };
    }
    const phone = String(params.phone || '').replace(/\D/g, '');
    if (!phone || phone.length < 8) {
        await ctx.sock.sendMessage(jid, { text: '❌ Nomor tidak valid.' });
        return { handled: true };
    }
    const name = String(params.name || '').trim();
    // Reuse alur addUser existing dengan menulis lewat file util yang sudah ada di phaseC ctx
    const users = ctx.loadUsers();
    if (ctx.isAdmin(users, phone)) {
        await ctx.sock.sendMessage(jid, { text: '❌ Sudah ADMIN.' });
        return { handled: true };
    }
    if (users.users.some(u => ctx.normalizeUserId(typeof u === 'string' ? u : u.jid) === phone)) {
        await ctx.sock.sendMessage(jid, { text: '❌ Sudah terdaftar.' });
        return { handled: true };
    }
    users.users.push({ jid: phone, name, addedAt: new Date().toISOString() });
    ctx.saveUsers(users);
    await ctx.sock.sendMessage(jid, {
        text: `✅ User ditambah: ${phone}${name ? ` — ${name}` : ''}`
    });
    return { handled: true };
}

async function execAdminHapus(ctx, jid, senderPhone, params) {
    if (!ctx.isAdmin(ctx.loadUsers(), senderPhone)) {
        await ctx.sock.sendMessage(jid, { text: '❌ Hanya ADMIN.' });
        return { handled: true };
    }
    const phone = String(params.phone || '').replace(/\D/g, '');
    if (!phone) {
        await ctx.sock.sendMessage(jid, { text: '❌ Nomor tidak valid.' });
        return { handled: true };
    }
    const users = ctx.loadUsers();
    if (ctx.isAdmin(users, phone)) {
        await ctx.sock.sendMessage(jid, { text: '❌ ADMIN tidak bisa dihapus.' });
        return { handled: true };
    }
    const before = users.users.length;
    users.users = users.users.filter(u =>
        ctx.normalizeUserId(typeof u === 'string' ? u : u.jid) !== phone
    );
    if (users.users.length === before) {
        await ctx.sock.sendMessage(jid, { text: '❌ Nomor tidak ditemukan.' });
        return { handled: true };
    }
    ctx.saveUsers(users);
    await ctx.sock.sendMessage(jid, { text: `🗑️ User ${phone} dihapus.` });
    return { handled: true };
}

async function execAdminLihat(ctx, jid, senderPhone) {
    if (!ctx.isAdmin(ctx.loadUsers(), senderPhone)) {
        await ctx.sock.sendMessage(jid, { text: '❌ Hanya ADMIN.' });
        return { handled: true };
    }
    const users = ctx.loadUsers();
    let msg = '👥 *DAFTAR PENGGUNA*\n\n*ADMIN:*\n';
    users.admins.forEach((a, i) => {
        const j = typeof a === 'string' ? a : a.jid;
        const n = typeof a === 'string' ? '' : (a.name ? ` — ${a.name}` : '');
        msg += `${i + 1}. ${ctx.normalizeUserId(j)}${n}\n`;
    });
    msg += '\n*USER:*\n';
    if (users.users.length === 0) msg += 'Belum ada.';
    else users.users.forEach((u, i) => {
        const j = typeof u === 'string' ? u : u.jid;
        const n = typeof u === 'string' ? '' : (u.name ? ` — ${u.name}` : '');
        msg += `${i + 1}. ${ctx.normalizeUserId(j)}${n}\n`;
    });
    await ctx.sock.sendMessage(jid, { text: msg.trim() });
    return { handled: true };
}

async function execLaporanJamTambah(ctx, jid, senderPhone, params) {
    if (!ctx.isAdmin(ctx.loadUsers(), senderPhone)) {
        await ctx.sock.sendMessage(jid, { text: '❌ Hanya ADMIN.' });
        return { handled: true };
    }
    const time = String(params.time || '').trim();
    const r = ctx.phaseC.addReportTime(time);
    await ctx.sock.sendMessage(jid, {
        text: r.ok ? `✅ Jam laporan ditambah: ${time}` : `❌ ${r.error}`
    });
    return { handled: true };
}

// ---- Public API ----

async function execRekapUser(ctx, jid, senderPhone, intent) {
    // Admin only
    if (!ctx.isAdmin(ctx.loadUsers(), senderPhone)) {
        await ctx.sock.sendMessage(jid, { text: '❌ Hanya ADMIN yang boleh rekap user.' });
        return { handled: true };
    }

    const members = Array.isArray(intent.params?.members) ? intent.params.members : [];
    if (members.length === 0) {
        await ctx.sock.sendMessage(jid, {
            text: '❌ Tidak ada data rekap yang bisa dibaca. Format:\nRekap user:\nNama 62xxx SSL\nNama 62xxx SCB'
        });
        return { handled: true };
    }

    const validRoles = getRoles();
    const okList = [];
    const failList = [];

    // Load users.json sekali, patch di memory, tulis sekali di akhir supaya
    // atomik + tidak race dengan handler lain.
    const users = ctx.loadUsers ? ctx.loadUsers() : { admins: [], users: [] };
    if (!Array.isArray(users.users)) users.users = [];

    for (const m of members) {
        const nm = String(m?.name || '').trim();
        const rawPhone = String(m?.phone || '').trim();
        const role = String(m?.role || '').toUpperCase().trim();
        const canonical = ctx.normalizeUserId(rawPhone);

        if (!nm || !canonical) {
            failList.push(`${nm || '(tanpa nama)'} ${rawPhone || '(tanpa nomor)'} — data tidak lengkap`);
            continue;
        }
        if (!validRoles.includes(role)) {
            failList.push(`${nm} ${canonical} — jabatan "${m?.role}" tidak valid`);
            continue;
        }

        const r = upsertMember(canonical, nm, role, ctx.normalizeUserId);
        if (!r.ok) {
            failList.push(`${nm} ${canonical} — ${r.error}`);
            continue;
        }

        // Sinkronkan nama ke users.json supaya displayName resolve utk laporan
        // + fix bug LID (nama muncul, bukan digit mentah).
        const idx = users.users.findIndex(u =>
            ctx.normalizeUserId(u.jid || u.phone) === canonical
        );
        if (idx >= 0) {
            users.users[idx].name = nm;
            if (!users.users[idx].phone) users.users[idx].phone = canonical;
        } else {
            users.users.push({
                jid: canonical,
                phone: canonical,
                name: nm,
                addedAt: new Date().toISOString(),
                source: 'phaseD-rekap'
            });
        }

        okList.push(`${nm} (${canonical}) — ${role}`);
    }

    if (ctx.saveUsers) ctx.saveUsers(users);

    let text = '📋 *REKAP USER*\n\n';
    if (okList.length > 0) {
        text += `✅ Berhasil (${okList.length}):\n`;
        okList.forEach(l => { text += `• ${l}\n`; });
    }
    if (failList.length > 0) {
        text += `\n❌ Gagal (${failList.length}):\n`;
        failList.forEach(l => { text += `• ${l}\n`; });
    }
    text += `\nGunakan *laporan kirim* untuk uji tampilan laporan.`;

    await ctx.sock.sendMessage(jid, { text: text.trim() });
    return { handled: true };
}

// Menangani balasan nomor setelah router meminta pilihan grup.
// Dipanggil dari main handler SEBELUM flow jadwal manual, sehingga angka
// tidak dianggap sebagai input jadwal biasa.
export function hasPendingGroupChoice(jid) {
    const p = pendingGroupChoice.get(jid);
    if (!p) return false;
    if (Date.now() > p.expiresAt) {
        pendingGroupChoice.delete(jid);
        return false;
    }
    return true;
}

export async function handlePendingGroupChoice(ctx, jid, senderPhone, text) {
    const p = pendingGroupChoice.get(jid);
    if (!p) return { handled: false };
    pendingGroupChoice.delete(jid);

    const raw = String(text || '').trim().toLowerCase();
    if (raw === 'batal') {
        await ctx.sock.sendMessage(jid, { text: '❌ Pemilihan grup dibatalkan.' });
        return { handled: true };
    }

    const number = Number(text);
    if (!Number.isInteger(number) || number < 1 || number > p.groups.length) {
        pendingGroupChoice.set(jid, p);
        await ctx.sock.sendMessage(jid, {
            text: `❌ Nomor grup tidak valid. Pilih 1-${p.groups.length}, atau ketik *batal*.`
        });
        return { handled: true };
    }

    const selectedGroup = p.groups[number - 1];
    phaseDLog('GROUP', `NL group selected`, `${selectedGroup.name} intent=${p.intent.intent}`);
    return await executeBuatOnGroup(ctx, jid, senderPhone, p.intent, selectedGroup);
}

// Return { handled: bool }
export async function dispatchIntent(ctx, jid, senderPhone, intent, rawText) {
    if (!intent || !intent.intent || intent.intent === 'unknown') {
        return { handled: false, reason: 'unknown-intent' };
    }

    // Guard: kalau pesan asli terlihat seperti command manual yang butuh
    // argumen tapi argumennya kosong, jangan biarkan AI misroute intent.
    // Contoh: "Laporan grup tambah" (tanpa groupId) tidak boleh dianggap
    // laporan_grup_daftar oleh AI — biar command handler manual yang
    // menolak dengan pesan format yang jelas.
    const raw = String(rawText || '').trim().toLowerCase();
    const looksLikeBareCommand =
        /^laporan\s+grup\s+(tambah|hapus)\s*$/.test(raw) ||
        /^laporan\s+jam\s+(tambah|hapus)\s*$/.test(raw) ||
        /^admin\s+(tambah|hapus)\s*$/.test(raw) ||
        /^hapus\s+(tugas|jadwal)?\s*$/.test(raw);
    if (looksLikeBareCommand) {
        phaseDLog('SKIP', 'bare command tanpa argumen, biarkan handler manual',
            `raw="${raw}" intent=${intent.intent}`);
        return { handled: false, reason: 'bare-command-passthrough' };
    }

    const conf = Number(intent.confidence) || 0;

    if (conf < CONFIDENCE_ASK) {
        phaseDLog('LOW', `confidence rendah, skip`, `${intent.intent}@${conf}`);
        return { handled: false, reason: 'low-confidence' };
    }

    if (conf < CONFIDENCE_EXEC) {
        // Simpan pending confirm
        pendingConfirm.set(jid, {
            intent,
            expiresAt: Date.now() + 2 * 60 * 1000 // 2 menit
        });
        const summary = summarizeIntent(intent);
        await ctx.sock.sendMessage(jid, {
            text: `🤔 Maksudmu:\n${summary}\n\nJawab *ya* untuk lanjut, *tidak* untuk batal.`
        });
        return { handled: true };
    }

    return await executeIntent(ctx, jid, senderPhone, intent);
}

function summarizeIntent(intent) {
    const p = intent.params || {};
    switch (intent.intent) {
        case 'buat_jadwal_biasa': return `📅 Buat jadwal biasa: *${p.schedule}*`;
        case 'buat_tugas': return `🎯 Buat tugas: *${p.schedule}* — ${p.points || 0} poin`;
        case 'lihat_jadwal': return `📋 Lihat daftar jadwal`;
        case 'lihat_tugas': return `📋 Lihat daftar tugas`;
        case 'lihat_poin': return `📊 Lihat poin bulan ini`;
        case 'hapus_jadwal': return p.all ? '🗑️ Hapus SEMUA jadwal' : `🗑️ Hapus jadwal ${(p.indexes || []).join(',')}`;
        case 'hapus_tugas': return p.all ? '🗑️ Hapus SEMUA tugas' : `🗑️ Hapus tugas ${(p.indexes || []).join(',')}`;
        case 'admin_tambah_user': return `➕ Tambah user ${p.phone}${p.name ? ` (${p.name})` : ''}`;
        case 'admin_hapus_user': return `➖ Hapus user ${p.phone}`;
        case 'admin_lihat_user': return `👥 Daftar admin & user`;
        case 'admin_jadwal_semua': return `📋 Lihat semua jadwal`;
        case 'admin_tugas_semua': return `📋 Lihat semua tugas`;
        case 'laporan_kirim': return `📤 Kirim laporan sekarang`;
        case 'laporan_grup_daftar': return `📋 Daftar grup laporan`;
        case 'laporan_jam_tambah': return `⏰ Tambah jam laporan ${p.time}`;
        case 'laporan_jam_daftar': return `⏰ Daftar jam laporan`;
        case 'bantuan': return `❓ Tampilkan menu bantuan`;
        default: return intent.intent;
    }
}
