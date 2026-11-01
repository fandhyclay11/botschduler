// report-missed.js
// -------------------------------------------------------------
// Alat read-only untuk melihat jadwal yang HARI INI seharusnya
// terkirim tapi `lastSent` belum menunjukkan hari ini.
//
// Alat ini TIDAK:
//   - Mengirim pesan apa pun ke grup.
//   - Mengubah reminders.json / users.json / sesi WhatsApp.
//   - Memodifikasi `lastSent`, `pendingDate`, atau field lain.
//
// Cara pakai:
//   node report-missed.js            # pakai tanggal hari ini (lokal)
//   node report-missed.js 2026-10-22 # paksa tanggal spesifik
//
// Keluaran: daftar jadwal yang terindikasi terlewat beserta waktu,
// tujuan, status, dan `lastSent` terakhir supaya bisa ditinjau manual.
// -------------------------------------------------------------

import fs from 'fs';

const REMINDER_FILE = './reminders.json';
const LOG_FILE = './scheduler.log';

const WEEKDAY_LABEL = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

function recurrenceLabel(reminder) {
    const r = reminder.recurrence || 'daily';
    if (r === 'daily') return 'Setiap hari';
    if (r === 'weekly') {
        const days = Array.isArray(reminder.daysOfWeek) ? reminder.daysOfWeek : [];
        return days.sort((a, b) => a - b).map(d => WEEKDAY_LABEL[d] || d).join(', ');
    }
    if (r === 'monthly') return `Setiap tanggal ${reminder.dayOfMonth}`;
    if (r === 'once') return `Sekali ${reminder.date || '(tanpa tanggal)'}`;
    return 'Berulang';
}

function isDueOn(reminder, dateObj, isoDate) {
    const r = reminder.recurrence || 'daily';
    if (r === 'daily') return true;
    if (r === 'once') return String(reminder.date || '') === isoDate;
    if (r === 'weekly') {
        const days = Array.isArray(reminder.daysOfWeek) ? reminder.daysOfWeek : [];
        return days.includes(dateObj.getDay());
    }
    if (r === 'monthly') return Number(reminder.dayOfMonth) === dateObj.getDate();
    return false;
}

function parseTargetDate(arg) {
    if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) {
        return { iso: arg, obj: new Date(`${arg}T00:00:00`) };
    }
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return { iso: `${y}-${m}-${d}`, obj: now };
}

function readSchedulerLogWindow(dateIso) {
    // Baca log hari ini untuk mencari jejak RETRY / ERROR / SKIP yang
    // terkait reminder yang muncul di daftar. Pencarian best-effort,
    // tidak gagal kalau log tidak tersedia.
    try {
        const content = fs.readFileSync(LOG_FILE, 'utf8');
        return content
            .split('\n')
            .filter(line => line.includes(`[${dateIso}`) || line.includes(dateIso));
    } catch { return []; }
}

function findLogSignals(lines, reminder) {
    const idToken = String(reminder.id);
    const hits = lines.filter(l => l.includes(idToken));
    const retries = hits.filter(l => l.includes('[RETRY]')).length;
    const errors = hits.filter(l => l.includes('[ERROR]')).length;
    const skips = hits.filter(l => l.includes('[SKIP]')).length;
    const queued = hits.filter(l => l.includes('[QUEUE]')).length;
    const sent = hits.filter(l => l.includes('[SUCCESS]')).length;
    const lastLine = hits[hits.length - 1] || '';
    return { retries, errors, skips, queued, sent, lastLine };
}

function statusFor(reminder, isoDate, signals) {
    if (reminder.lastSent === isoDate) return 'TERKIRIM';
    if (signals.sent > 0) return 'TERKIRIM (log)';
    if (signals.errors > 0) return 'GAGAL PERMANEN hari ini';
    if (signals.retries > 0) return 'RETRY (masih dicoba)';
    if (signals.skips > 0) return 'DILEWATI (lewat grace window)';
    if (reminder.pendingDate === isoDate && reminder.sendAt) return 'DISIAPKAN, belum masuk antrean';
    if (signals.queued > 0) return 'MASUK ANTREAN';
    if (reminder.lastSent && reminder.lastSent !== isoDate) return 'BELUM TERKIRIM hari ini';
    if (!reminder.lastSent) return 'BELUM PERNAH TERKIRIM';
    return 'TIDAK DIKETAHUI';
}

function main() {
    const argDate = process.argv[2];
    const target = parseTargetDate(argDate);
    const { iso: isoDate, obj: dateObj } = target;

    let reminders;
    try {
        reminders = JSON.parse(fs.readFileSync(REMINDER_FILE, 'utf8'));
    } catch (error) {
        console.error(`❌ Gagal membaca ${REMINDER_FILE}: ${error.message}`);
        process.exit(1);
    }
    if (!Array.isArray(reminders)) {
        console.error('❌ reminders.json bukan array.');
        process.exit(1);
    }

    const logLines = readSchedulerLogWindow(isoDate);

    const due = reminders.filter(r => isDueOn(r, dateObj, isoDate));
    const missed = due.filter(r => r.lastSent !== isoDate);

    console.log('================================================================');
    console.log(`LAPORAN JADWAL — tanggal ${isoDate} (${WEEKDAY_LABEL[dateObj.getDay()]})`);
    console.log('================================================================');
    console.log(`Total jadwal   : ${reminders.length}`);
    console.log(`Jatuh tempo    : ${due.length}`);
    console.log(`Terkirim       : ${due.length - missed.length}`);
    console.log(`Belum terkirim : ${missed.length}`);
    console.log('----------------------------------------------------------------');

    if (missed.length === 0) {
        console.log('✅ Tidak ada jadwal yang terindikasi terlewat.');
        console.log('Alat ini TIDAK mengirim ulang pesan apa pun.');
        return;
    }

    missed
        .sort((a, b) => String(a.time).localeCompare(String(b.time)))
        .forEach((r, i) => {
            const signals = findLogSignals(logLines, r);
            const status = statusFor(r, isoDate, signals);
            console.log('');
            console.log(`${i + 1}. id=${r.id}`);
            console.log(`   ⏰ ${r.time}  |  ${recurrenceLabel(r)}`);
            console.log(`   📍 chat   : ${r.chatId}`);
            console.log(`   👤 owner  : ${r.ownerJid || '(tanpa owner)'}`);
            console.log(`   📝 teks   : ${String(r.text || '').split('\n')[0].slice(0, 80)}${(r.text || '').length > 80 ? '…' : ''}`);
            console.log(`   📊 status : ${status}`);
            console.log(`   📈 log    : queued=${signals.queued} sent=${signals.sent} retry=${signals.retries} error=${signals.errors} skip=${signals.skips}`);
            if (signals.lastLine) {
                console.log(`   🧾 last   : ${signals.lastLine.trim().slice(0, 160)}`);
            }
            if (r.lastSent) {
                console.log(`   🕘 last ok: ${r.lastSent}${r.lastSentAt ? ` (${r.lastSentAt})` : ''}`);
            }
        });

    console.log('');
    console.log('----------------------------------------------------------------');
    console.log('Catatan: alat ini READ-ONLY. Tidak mengirim ulang pesan.');
    console.log('Jika pesan hari ini sudah telanjur dilewati karena grace');
    console.log('window 2 menit, kirim ulang manual dari grup target. Hindari');
    console.log('mengubah `lastSent` di reminders.json agar anti-duplikat');
    console.log('harian tetap efektif untuk pengiriman berikutnya.');
    console.log('----------------------------------------------------------------');
}

main();
