// phaseC/flow.js
// -------------------------------------------------------------
// Extension untuk flow "buat jadwal" di chat pribadi.
//
// Alur baseline: choose-group → enter-schedule → createReminder.
// Kita SUPERSET flow itu — TIDAK mengubah state map baseline
// (privateScheduleState) melainkan menambah state kita sendiri
// (phaseCFlowState). Flow lama tetap jalan untuk "Jadwal Biasa".
//
// Kontrak (dipanggil dari index.js):
//   1. offerTypeChoice(ctx, jid)  → pertama kali user ketik "buat jadwal"
//   2. tryHandleTypeChoice(ctx, jid, text) → return true jika dikonsumsi
//   3. Setelah user pilih "Tugas", state kita takeover:
//        - pilih grup (pakai groups user existing)
//        - masukkan jadwal (pakai parser existing)
//        - masukkan poin
//        - create reminder + mark as task
// -------------------------------------------------------------

import { markReminderAsTask } from './tasks.js';
import { appendLog } from './store.js';

// Peta state khusus Fase C.
const state = new Map();

function set(jid, next) {
    state.set(jid, next);
}

function get(jid) {
    return state.get(jid);
}

function clear(jid) {
    state.delete(jid);
}

export function hasPhaseCFlow(jid) {
    return state.has(jid);
}

export function cancelPhaseCFlow(jid) {
    clear(jid);
}

export async function offerTypeChoice(ctx, jid) {
    set(jid, { step: 'choose-type' });
    await ctx.sock.sendMessage(jid, {
        text:
`🗂 *BUAT JADWAL*

Pilih jenis jadwal:
1. Jadwal Biasa
2. Jadikan Tugas (dengan poin)

Balas dengan *1* atau *2*.
Ketik *batal* untuk membatalkan.`
    });
}

// return true kalau text dikonsumsi.
export async function tryHandlePhaseCFlow(ctx, jid, text, senderPhone) {
    const st = get(jid);
    if (!st) return false;

    const lower = text.toLowerCase().trim();

    if (lower === 'batal') {
        clear(jid);
        await ctx.sock.sendMessage(jid, { text: '❌ Proses dibatalkan.' });
        return true;
    }

    // Step 1: pilih jenis
    if (st.step === 'choose-type') {
        if (lower === '1') {
            // Jatuhkan ke flow baseline (Jadwal Biasa)
            clear(jid);
            await ctx.sendGroupSelection(ctx.sock, jid, senderPhone);
            return true;
        }
        if (lower === '2') {
            // Fase C flow — pilih grup versi kita
            const { groupsForUser, allGroups } =
                await ctx.getUserParticipatingGroups(ctx.sock, senderPhone);

            if (groupsForUser.length === 0) {
                clear(jid);
                await ctx.sock.sendMessage(jid, {
                    text: allGroups.length > 0
                        ? '❌ Belum ada grup yang Anda ikuti bersama bot. Tambahkan bot ke grup terlebih dahulu.'
                        : '❌ Bot belum memiliki grup. Tambahkan bot ke grup terlebih dahulu.'
                });
                return true;
            }

            set(jid, { step: 'task-choose-group', groups: groupsForUser });

            let msg = '📋 *PILIH GRUP TUJUAN TUGAS*\n\n';
            groupsForUser.forEach((g, i) => { msg += `${i + 1}. ${g.name}\n`; });
            msg += '\nBalas dengan nomor grup. Ketik *batal* untuk membatalkan.';
            await ctx.sock.sendMessage(jid, { text: msg });
            return true;
        }
        await ctx.sock.sendMessage(jid, { text: '❌ Pilihan tidak valid. Balas *1* atau *2*.' });
        return true;
    }

    // Step 2: pilih grup untuk tugas
    if (st.step === 'task-choose-group') {
        const num = Number(text);
        if (!Number.isInteger(num) || num < 1 || num > st.groups.length) {
            await ctx.sock.sendMessage(jid, { text: '❌ Nomor grup tidak valid.' });
            return true;
        }
        const selected = st.groups[num - 1];
        set(jid, { step: 'task-enter-schedule', selectedGroup: selected });
        await ctx.sock.sendMessage(jid, {
            text:
`✅ Grup dipilih: *${selected.name}*

Kirim format jadwal tugas, contoh:
*setiap hari 08:00 briefing pagi*
*setiap senin 09:00 cek stok*
*setiap senin,rabu,jumat 09:00 laporan*
*setiap tanggal 8 08:00 laporan bulanan*

Ketik *batal* untuk membatalkan.`
        });
        return true;
    }

    // Step 3: masukkan jadwal
    if (st.step === 'task-enter-schedule') {
        const schedule = ctx.parseScheduleText(text);
        if (!schedule) {
            await ctx.sock.sendMessage(jid, {
                text: '❌ Format jadwal tidak dikenali. Coba lagi atau ketik *batal*.'
            });
            return true;
        }
        if (schedule.error) {
            await ctx.sock.sendMessage(jid, { text: `❌ ${schedule.error}` });
            return true;
        }
        st.schedule = schedule;
        st.step = 'task-enter-points';
        set(jid, st);
        await ctx.sock.sendMessage(jid, {
            text:
`✅ Jadwal siap.

Sekarang tentukan *poin* untuk tugas ini.
Balas dengan angka (1 sampai 1000).
Ketik *batal* untuk membatalkan.`
        });
        return true;
    }

    // Step 4: masukkan poin
    if (st.step === 'task-enter-points') {
        const points = Number(text);
        if (!Number.isInteger(points) || points < 1 || points > 1000) {
            await ctx.sock.sendMessage(jid, {
                text: '❌ Poin harus bilangan bulat antara 1 sampai 1000.'
            });
            return true;
        }

        const { selectedGroup, schedule } = st;
        const ownerJid = jid;

        const result = await ctx.createReminder(
            ctx.sock, jid, selectedGroup.id, schedule, ownerJid
        );

        if (!result) {
            // Duplikat / gagal → sudah dipesankan oleh createReminder
            clear(jid);
            return true;
        }

        // Tandai reminder terbaru sebagai Task.
        // createReminder di baseline tidak return objek reminder, jadi
        // kita ambil dari file: reminder terakhir yang cocok chatId/time/text.
        const created = ctx.findLatestReminder({
            chatId: selectedGroup.id,
            time: schedule.time,
            text: schedule.text
        });

        if (created) {
            markReminderAsTask(created, points, ownerJid);
            await ctx.sock.sendMessage(jid, {
                text:
`🎯 *TUGAS DIBUAT*

Grup: *${selectedGroup.name}*
Jadwal: ${schedule.time}
Poin: *${points}*

Anggota grup dapat menyelesaikan tugas dengan memberikan *reaction* pada pesan tugas.`
            });
            appendLog('FLOW', 'Task registered', `id=${created.id} chat=${selectedGroup.id} points=${points}`);
        } else {
            await ctx.sock.sendMessage(jid, {
                text: '⚠️ Jadwal tersimpan tapi meta task gagal dilampirkan. Silakan cek dengan admin.'
            });
        }

        clear(jid);
        return true;
    }

    return false;
}
