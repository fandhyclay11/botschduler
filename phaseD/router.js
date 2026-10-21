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
import { hasRequiredParams, missingParamQuestion } from './nlNormalize.js';

const CONFIDENCE_EXEC = 0.75;
const CONFIDENCE_ASK = 0.55;

// AI hanya menentukan intent/parameter metadata (waktu, pengulangan, poin).
// Untuk isi jadwal/tugas, JANGAN memakai teks hasil rewrite AI karena model
// dapat meringkas, memparafrasekan, menormalkan huruf besar/kecil,
// menghapus emoji/bullet/line break, atau membuang bagian pesan.
//
// Strategi:
//   1. Ambil metadata (recurrence + waktu) dari aiSchedule (atau dari rawText
//      bila aiSchedule kosong/ambigu).
//   2. Tentukan ambang akhir "baris metadata" di rawText, lalu salin SELURUH
//      sisa teks setelah ambang itu PERSIS seperti user mengetiknya
//      (line break, emoji, bullet, tanda bintang WA tetap utuh).
//   3. Jika baris metadata dan isi pesan berada di baris yang sama (user
//      mengetik satu kalimat tanpa baris baru), isi diambil setelah token
//      waktu terakhir di baris itu — tetap tanpa perubahan karakter.
//   4. Jika tidak ada petunjuk waktu yang jelas di rawText → return null →
//      caller akan minta klarifikasi, BUKAN pakai hasil AI yang berisiko
//      sudah diringkas.
//
// Deklarasi poin ("poin 10" / "10 poin" / "nilai 10 poin") hanya dibuang
// bila berada di BARIS METADATA (baris pertama bersama waktu). Jika
// penulisan poin ada di dalam isi pesan tugas, biarkan apa adanya.
function recoverOriginalSchedule(rawText, aiSchedule, isTask = false) {
    const raw = String(rawText || '').replace(/\r\n?/g, '\n');
    const rawTrim = raw.trim();
    const ai = String(aiSchedule || '').trim();
    if (!rawTrim) return ai || null;

    // --- 1. Ekstrak metadata (recurrence + HH:MM) ---
    //
    // Prioritaskan recurrence/waktu yang eksplisit di rawText agar bot
    // tidak terjebak pada hasil AI yang mungkin salah mengartikan waktu.

    // Deteksi recurrence di rawText.
    const recurrenceRe = /\b(setiap|tiap)\s+(hari|tanggal\s+\d{1,2}|(?:senin|selasa|rabu|kamis|jum[’'`]?at|sabtu|minggu|ahad)(?:\s*,\s*(?:senin|selasa|rabu|kamis|jum[’'`]?at|sabtu|minggu|ahad))*)\b/i;
    const recMatchRaw = rawTrim.match(recurrenceRe);

    // Deteksi SELURUH kemunculan waktu di rawText untuk cek konflik.
    const timeRe = /\b(?:jam\s+|pukul\s+)?(\d{1,2})[:.](\d{2})\b/gi;
    const timesInRaw = [];
    let tm;
    const scanText = rawTrim;
    while ((tm = timeRe.exec(scanText)) !== null) {
        const hh = Number(tm[1]);
        const mm = Number(tm[2]);
        if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
            timesInRaw.push({
                index: tm.index,
                match: tm[0],
                hhmm: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
            });
        }
    }

    // Fallback metadata dari aiSchedule.
    const aiMatch = ai.match(/^(setiap\s+(?:hari|tanggal\s+\d{1,2}|[a-zA-ZÀ-ÿ'’,\s]+?))\s+(\d{1,2}:\d{2})/i);
    const aiRecurrencePart = aiMatch ? aiMatch[1].trim() : '';
    const aiTime = aiMatch ? aiMatch[2] : '';

    // Posisi "baris metadata" di rawText. Preferensi:
    //   - Jika rawText memuat recurrence + waktu berdekatan (dalam 40 char),
    //     ambil akhir match waktu pertama setelah recurrence.
    //   - Jika hanya ada waktu (tanpa kata "setiap"), ambil akhir waktu
    //     pertama di baris pertama saja (bukan waktu yang ada di dalam isi
    //     pesan di baris berikutnya).
    //   - Jika tidak ada waktu sama sekali di rawText → return null.
    let metadataEnd = -1;
    let timeHHMM = '';
    let recurrencePart = '';

    if (recMatchRaw) {
        const recEnd = recMatchRaw.index + recMatchRaw[0].length;
        // Cari waktu PERTAMA setelah recurrence, tanpa jeda baris baru.
        const near = timesInRaw.find(t =>
            t.index >= recEnd &&
            t.index - recEnd <= 40 &&
            !rawTrim.slice(recEnd, t.index).includes('\n')
        );
        if (near) {
            metadataEnd = near.index + near.match.length;
            timeHHMM = near.hhmm;
            recurrencePart = recMatchRaw[0]
                .replace(/\btiap\b/i, 'setiap')
                .replace(/\s+/g, ' ')
                .trim();
        }
    }

    if (metadataEnd === -1 && timesInRaw.length > 0) {
        // Tidak ada kata "setiap" → gunakan waktu pertama di BARIS PERTAMA.
        const firstLineEnd = rawTrim.indexOf('\n');
        const firstLineLimit = firstLineEnd === -1 ? rawTrim.length : firstLineEnd;
        const firstLineTime = timesInRaw.find(t => t.index < firstLineLimit);
        if (firstLineTime) {
            metadataEnd = firstLineTime.index + firstLineTime.match.length;
            timeHHMM = firstLineTime.hhmm;
            // Ambil recurrencePart dari aiSchedule bila valid, jika tidak
            // default ke "setiap hari" (bot hanya mendukung recurrence).
            recurrencePart = aiRecurrencePart || 'setiap hari';
        }
    }

    if (metadataEnd === -1) {
        // Tidak ada waktu valid di rawText → jangan tebak, biar caller
        // minta klarifikasi. Fallback ke AI schedule juga tidak aman.
        return null;
    }

    // --- 2. Deteksi konflik waktu di SEGMEN metadata (ambigu) ---
    //
    // Hanya waktu yang berada SEBELUM/TEPAT di metadataEnd yang dianggap
    // bagian metadata. Waktu yang muncul di dalam isi pesan (setelah
    // metadataEnd) sepenuhnya bagian body dan BOLEH ada tanpa dianggap
    // konflik. Jadi konflik hanya terjadi jika di depan metadataEnd ada
    // lebih dari satu waktu berbeda yang berdekatan (misal user menulis
    // "setiap hari 08:00 09:00 briefing" → tidak jelas pilih yang mana).
    const timesBeforeMetadataEnd = timesInRaw.filter(t =>
        (t.index + t.match.length) <= metadataEnd
    );
    const distinctTimes = new Set(timesBeforeMetadataEnd.map(t => t.hhmm));
    if (distinctTimes.size > 1) {
        return { __ambiguous: 'multiple-times', times: Array.from(distinctTimes) };
    }

    // Juga anggap ambigu bila ada waktu kedua di baris pertama yang sangat
    // dekat (dalam 10 karakter) setelah waktu metadata — kemungkinan user
    // mengetik dua waktu di baris metadata secara berurutan. Tapi bila
    // waktu kedua terletak setelah kata (misal "08:00 briefing jam 09:00"
    // di satu baris), anggap bagian isi.
    const firstLineEndIdx = rawTrim.indexOf('\n');
    const firstLineRange = firstLineEndIdx === -1 ? rawTrim.length : firstLineEndIdx;
    const timesInFirstLineAfterMeta = timesInRaw.filter(t =>
        t.index >= metadataEnd && t.index < firstLineRange
    );
    for (const t of timesInFirstLineAfterMeta) {
        const gap = rawTrim.slice(metadataEnd, t.index).trim();
        if (!gap && t.hhmm !== timeHHMM) {
            return { __ambiguous: 'multiple-times', times: [timeHHMM, t.hhmm] };
        }
    }

    // --- 3. Ambil body = teks setelah metadata, PERSIS seperti aslinya ---
    //
    // Pertahankan line break, spasi di awal baris bullet, emoji, format WA.
    // Hanya buang whitespace horizontal awal baris pertama (karena biasanya
    // ada 1-2 spasi antara metadata dan isi) dan trailing whitespace.
    let body = raw.slice(metadataEnd);
    // Hapus hanya separator ringan di awal (spasi / tab) tapi JANGAN hapus
    // baris baru pertama — itu bagian format pesan user.
    body = body.replace(/^[ \t]+/, '');
    // Jika sisa diawali ": " atau "- " yang berfungsi memisahkan metadata
    // dari isi, pertahankan karena bisa saja memang format user. Konservatif.
    // Jangan trim trailing agar emoji/newline di akhir tidak hilang; cukup
    // buang whitespace tak terlihat di ujung (hanya spasi/tab di belakang).
    body = body.replace(/[ \t]+$/g, '');

    // Buang deklarasi poin HANYA bila berada di baris metadata (sebelum
    // body dimulai) — bukan di dalam isi pesan. Karena body sudah dipotong
    // dari setelah metadataEnd, deklarasi poin di baris metadata sudah
    // otomatis tidak ikut. Namun ada kasus user menulis "poin 10" SETELAH
    // waktu tapi sebelum isi (contoh: "setiap hari 06:19 poin 10\nIsi...").
    // Hilangkan HANYA jika ada di awal body dan diikuti separator newline
    // atau akhir baris metadata.
    const pointsLeadRe = /^\s*(?:[,;:\-–—]\s*)?(?:poin\s*[:=]?\s*\d+|\d+\s*poin|nilai\s*\d+\s*poin)\s*(?=\n|$)/i;
    body = body.replace(pointsLeadRe, '');
    // Juga hapus bila diikuti separator kecil lalu newline.
    body = body.replace(/^[ \t]*[\n]+/, '\n');

    // Trim HANYA whitespace horizontal + maksimum 1 newline leading agar
    // body tetap mulai dari isi user. Jangan sentuh line break di dalamnya.
    body = body.replace(/^[ \t]*\n?[ \t]*/, '');

    if (!body.trim()) {
        // Baris metadata ada tapi tidak ada isi apa pun → minta klarifikasi.
        return { __ambiguous: 'empty-body' };
    }

    // Rakit kembali: `${recurrencePart} HH:MM ${body}`.
    // parseScheduleText di baseline sudah mempertahankan line break pada
    // bagian setelah HH:MM (lihat normalizeScheduleInput).
    const rec = recurrencePart || aiRecurrencePart || 'setiap hari';
    const time = timeHHMM || aiTime;
    if (!time) return null;

    return `${rec} ${time} ${body}`;
}

// Diekspor khusus untuk pengujian unit. Jangan dipanggil dari runtime bot
// kecuali melalui jalur execBuat/executeBuatOnGroup.
export const __test_recoverOriginalSchedule = recoverOriginalSchedule;

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
        return await executeIntent(ctx, jid, senderPhone, p.intent, p.rawText);
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

async function executeIntent(ctx, jid, senderPhone, intent, rawText = '') {
    const { intent: name, params = {} } = intent;
    phaseDLog('EXEC', `intent=${name}`, JSON.stringify(params).slice(0, 200));

    try {
        switch (name) {
            case 'buat_jadwal_biasa':
            case 'buat_tugas':
                return await execBuat(ctx, jid, senderPhone, intent, rawText);

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

async function execBuat(ctx, jid, senderPhone, intent, rawText = '') {
    const { params = {} } = intent;
    const scheduleText = recoverOriginalSchedule(
        rawText,
        params.schedule,
        intent.intent === 'buat_tugas'
    );
    if (!scheduleText) {
        await ctx.sock.sendMessage(jid, {
            text: '❓ Jadwalnya kapan dan isinya apa? Contoh: *setiap hari 08:00 briefing pagi*\n\nTulis metadata (pengulangan + jam) di baris pertama, lalu isi pesan lengkap di baris berikutnya.'
        });
        return { handled: true };
    }
    if (typeof scheduleText === 'object' && scheduleText.__ambiguous) {
        const reason = scheduleText.__ambiguous === 'multiple-times'
            ? `Ada lebih dari satu waktu di baris metadata (${(scheduleText.times || []).join(' dan ')}). Pakai waktu yang mana?`
            : 'Metadata jadwal ada, tetapi isi pesan masih kosong. Mohon kirim ulang dengan isi pesan setelah waktu.';
        await ctx.sock.sendMessage(jid, {
            text: `❓ ${reason}\n\nContoh format:\n*setiap hari 08:00 poin 10*\n(isi pesan di baris berikutnya)`
        });
        phaseDLog('ASK', 'ambigu metadata jadwal', String(scheduleText.__ambiguous));
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
            return await executeBuatOnGroup(ctx, jid, senderPhone, intent, matches[0], rawText);
        }
    }

    if (groupsForUser.length === 1) {
        return await executeBuatOnGroup(ctx, jid, senderPhone, intent, groupsForUser[0], rawText);
    }

    // Multi-grup: simpan intent hasil AI agar user cukup memilih nomor grup.
    pendingGroupChoice.set(jid, {
        intent,
        rawText,
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

async function executeBuatOnGroup(ctx, jid, senderPhone, intent, group, rawText = '') {
    const scheduleText = recoverOriginalSchedule(
        rawText,
        intent.params?.schedule,
        intent.intent === 'buat_tugas'
    );
    if (!scheduleText || (typeof scheduleText === 'object' && scheduleText.__ambiguous)) {
        await ctx.sock.sendMessage(jid, {
            text: '❓ Metadata jadwal tidak jelas. Mohon kirim ulang dengan pengulangan + jam di baris pertama, lalu isi pesan di baris berikutnya.'
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
    return await executeBuatOnGroup(ctx, jid, senderPhone, p.intent, selectedGroup, p.rawText);
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

    // Jika AI/pre-classifier yakin intent-nya tapi parameter wajib hilang
    // (contoh: "buat tugas" tanpa jadwal/poin, "jam laporan tambah" tanpa
    // HH:MM, "hapus user" tanpa nomor), AJUKAN pertanyaan spesifik —
    // JANGAN tebak nilai yang hilang. Ini sesuai pedoman keamanan prompt.
    if (!hasRequiredParams(intent.intent, intent.params || {})) {
        const question = missingParamQuestion(intent.intent, intent.params || {});
        await ctx.sock.sendMessage(jid, {
            text: `❓ ${question}`
        });
        phaseDLog('ASK', `param wajib hilang, minta klarifikasi`,
            `${intent.intent} missing`);
        return { handled: true, reason: 'missing-params' };
    }

    if (conf < CONFIDENCE_EXEC) {
        // Simpan pending confirm
        pendingConfirm.set(jid, {
            intent,
            rawText,
            expiresAt: Date.now() + 2 * 60 * 1000 // 2 menit
        });
        const summary = summarizeIntent(intent, rawText);
        await ctx.sock.sendMessage(jid, {
            text: `🤔 Maksudmu:\n${summary}\n\nJawab *ya* untuk lanjut, *tidak* untuk batal.`
        });
        return { handled: true };
    }

    return await executeIntent(ctx, jid, senderPhone, intent, rawText);
}

function summarizeIntent(intent, rawText = '') {
    const p = intent.params || {};
    const isBuat = intent.intent === 'buat_jadwal_biasa' || intent.intent === 'buat_tugas';
    if (isBuat) {
        // Jangan tampilkan versi AI yang mungkin sudah diringkas sebagai
        // "isi pesan". Pakai hasil recoverOriginalSchedule yang berasal
        // dari rawText user; bila gagal, tunjukkan metadata saja.
        const recovered = recoverOriginalSchedule(rawText, p.schedule, intent.intent === 'buat_tugas');
        if (recovered && typeof recovered === 'string') {
            // Tampilkan metadata di satu baris + isi persis di bawahnya.
            const metaMatch = recovered.match(/^(setiap\s+\S+(?:,\s*\S+)*\s+\d{1,2}:\d{2})\s+([\s\S]+)$/i);
            const meta = metaMatch ? metaMatch[1] : recovered.split('\n')[0];
            const body = metaMatch ? metaMatch[2] : '';
            const pointsLine = intent.intent === 'buat_tugas' ? `\n⭐ Poin: ${p.points || 0}` : '';
            const bodyBlock = body ? `\n\n📝 Isi pesan (akan dikirim persis seperti ini):\n${body}` : '';
            const headline = intent.intent === 'buat_tugas' ? '🎯 Buat tugas' : '📅 Buat jadwal biasa';
            return `${headline}\n⏰ ${meta}${pointsLine}${bodyBlock}`;
        }
        // Fallback: tampilkan apa adanya dari AI tapi beri label jelas.
        return intent.intent === 'buat_tugas'
            ? `🎯 Buat tugas (ringkasan metadata): *${p.schedule || '-'}* — ${p.points || 0} poin\n⚠️ Isi pesan belum terbaca jelas, mohon konfirmasi.`
            : `📅 Buat jadwal biasa (ringkasan metadata): *${p.schedule || '-'}*\n⚠️ Isi pesan belum terbaca jelas, mohon konfirmasi.`;
    }
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
