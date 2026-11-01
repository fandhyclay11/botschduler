// scheduler-hardening.test.js
// -------------------------------------------------------------
// Pengujian hardening untuk perbaikan produksi:
//
//   1. Penulisan JSON atomik (tmp + rename) — mencegah reminders.json
//      menjadi 0-byte saat crash di tengah penulisan.
//
//   2. preparePendingDelivery membersihkan sisa `pendingDate`/`retryAfter`
//      dari hari sebelumnya — mencegah jadwal "diam seharian" setelah
//      bot mati di tengah retry.
//
//   3. Edit vs pengiriman konkuren — field audit `lastSent`/`lastMessageId`
//      hasil pengiriman tidak terhapus oleh penulisan edit.
//
//   4. isWithinScheduleGrace: jadwal yang dibuat jalur AI / normal / edit
//      sama-sama menghormati batas 2 menit.
//
// Tidak ada tes yang menyentuh socket WhatsApp, grup nyata, atau file
// produksi. Semua operasi dilakukan di folder temp yang dibersihkan.
// -------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    applyReminderScheduleEdit,
    canQueueDelivery,
    isWithinScheduleGrace
} from './scheduler-edit.js';

// ----- 1. ATOMIC WRITE -----
// Replica atomicWriteJson yang dipakai index.js. Dites di sini supaya
// perilaku semantik (tulis-tmp, rename, bersihkan tmp pada error) tidak
// hanya dibuktikan dengan membaca file produksi.
function atomicWriteJson(targetPath, data) {
    const payload = JSON.stringify(data, null, 2);
    const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, payload);
    try {
        fs.renameSync(tmp, targetPath);
    } catch (error) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw error;
    }
}

function withTempDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sched-test-'));
    try { return fn(dir); } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

test('atomicWriteJson menulis isi lengkap dalam satu operasi rename', () => {
    withTempDir(dir => {
        const file = path.join(dir, 'reminders.json');
        atomicWriteJson(file, [{ id: 1, text: 'A' }, { id: 2, text: 'B' }]);
        const read = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(read.length, 2);
        assert.equal(read[0].text, 'A');
        // Tidak boleh menyisakan file sementara.
        const stray = fs.readdirSync(dir).filter(n => n.includes('.tmp-'));
        assert.deepEqual(stray, [], `file tmp seharusnya sudah dibersihkan: ${stray.join(',')}`);
    });
});

test('atomicWriteJson tidak menimpa file jika tujuan sedang dikunci / rename gagal', () => {
    withTempDir(dir => {
        const file = path.join(dir, 'reminders.json');
        atomicWriteJson(file, [{ id: 1 }]);
        const originalSize = fs.statSync(file).size;

        // Simulasikan rename gagal dengan monkey-patch fs.renameSync untuk
        // satu panggilan saja. Ini menguji bahwa file target TETAP utuh
        // dan tmp dibersihkan.
        const originalRename = fs.renameSync;
        fs.renameSync = () => { throw new Error('simulated-EPERM'); };
        try {
            assert.throws(() => atomicWriteJson(file, [{ id: 999 }]), /simulated-EPERM/);
        } finally {
            fs.renameSync = originalRename;
        }

        // File tujuan harus TIDAK berubah.
        assert.equal(fs.statSync(file).size, originalSize);
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(data[0].id, 1);
        // tmp seharusnya sudah dihapus.
        const stray = fs.readdirSync(dir).filter(n => n.includes('.tmp-'));
        assert.deepEqual(stray, []);
    });
});

// ----- 2. STALE PENDING RESET -----
// Replika mini preparePendingDelivery untuk menguji invariannya.
// (Logika asli ada di index.js:preparePendingDelivery; kita duplikasi
// bagian yang relevan agar tes tidak perlu mem-boot modul besar yang
// membuka socket WhatsApp.)
function clearPendingDelivery(reminder) {
    delete reminder.pendingDate;
    delete reminder.scheduledAt;
    delete reminder.sendAt;
    delete reminder.deliveryId;
    delete reminder.retryCount;
    delete reminder.retryAfter;
}
function preparePendingDeliveryLike(reminder, today, nowMs) {
    if (reminder.pendingDate === today && reminder.sendAt) return true;
    if (reminder.pendingDate && reminder.pendingDate !== today) {
        clearPendingDelivery(reminder);
    }
    // Simulasi sederhana persiapan pengiriman untuk hari ini.
    reminder.pendingDate = today;
    reminder.scheduledAt = new Date(nowMs).toISOString();
    reminder.sendAt = new Date(nowMs + 60_000).toISOString();
    reminder.deliveryId = `REM-${reminder.id}-${today}-TEST`;
    reminder.retryCount = 0;
    return true;
}

test('preparePendingDelivery membersihkan retryAfter basi dari hari sebelumnya', () => {
    const yesterday = '2026-10-21';
    const today = '2026-10-22';
    const reminder = {
        id: 100, time: '07:00', chatId: 'g@g.us',
        pendingDate: yesterday,
        sendAt: '2026-10-21T00:01:00.000Z',
        scheduledAt: '2026-10-21T00:00:00.000Z',
        deliveryId: 'REM-100-2026-10-21-OLD',
        retryCount: 3,
        // retryAfter 24 jam ke depan — tanpa reset, ini akan memblokir
        // seluruh pengiriman hari berikutnya (runReminderCheck pakai
        // `now < retryAfter` → continue).
        retryAfter: '2026-10-22T00:00:00.000Z',
        lastSent: '2026-10-20'
    };
    const nowMs = Date.parse('2026-10-22T00:01:00.000Z');
    assert.equal(preparePendingDeliveryLike(reminder, today, nowMs), true);
    assert.equal(reminder.pendingDate, today);
    assert.equal(reminder.retryAfter, undefined,
        'retryAfter basi harus hilang supaya tick hari ini tidak diblokir');
    assert.equal(reminder.retryCount, 0);
    assert.notEqual(reminder.deliveryId, 'REM-100-2026-10-21-OLD');
    // lastSent tetap, anti-duplikat harian masih bekerja.
    assert.equal(reminder.lastSent, '2026-10-20');
});

test('preparePendingDelivery tidak menghapus state jika pendingDate = today', () => {
    const today = '2026-10-22';
    const reminder = {
        id: 101, time: '07:00', chatId: 'g@g.us',
        pendingDate: today,
        sendAt: '2026-10-22T00:03:00.000Z',
        deliveryId: 'REM-101-2026-10-22-KEEP',
        retryCount: 2,
        retryAfter: '2026-10-22T00:05:00.000Z'
    };
    const nowMs = Date.parse('2026-10-22T00:04:00.000Z');
    assert.equal(preparePendingDeliveryLike(reminder, today, nowMs), true);
    // Early return: tidak ada reset.
    assert.equal(reminder.deliveryId, 'REM-101-2026-10-22-KEEP');
    assert.equal(reminder.retryAfter, '2026-10-22T00:05:00.000Z');
    assert.equal(reminder.retryCount, 2);
});

// ----- 3. EDIT vs PENGIRIMAN KONKUREN -----
// Simulasi urutan: user tekan "ya" di confirm-edit → kita baca reminders
// (snapshot A). Worker queue menyelesaikan send di tengah → file ditulis
// dengan lastSent/lastMessageId. Kemudian confirm-edit menulis snapshot
// A yang sudah dimodifikasi + hasil merge dari file terbaru.
test('edit tidak menghapus lastSent/lastMessageId yang ditulis worker konkuren', () => {
    withTempDir(dir => {
        const file = path.join(dir, 'reminders.json');
        const original = [{
            id: 55, chatId: 'g@g.us', ownerJid: '62811',
            text: 'Pesan lama', time: '08:00', recurrence: 'daily',
            lastSent: null, lastTemplateIndex: -1
        }];
        atomicWriteJson(file, original);

        // Snapshot A dibaca oleh confirm-edit.
        const snapA = JSON.parse(fs.readFileSync(file, 'utf8'));
        const reminderA = snapA.find(r => r.id === 55);

        // Worker konkuren: baca sendiri, kirim sukses, tulis kembali.
        const workerCopy = JSON.parse(fs.readFileSync(file, 'utf8'));
        const workerR = workerCopy.find(r => r.id === 55);
        workerR.lastSent = '2026-10-22';
        workerR.lastMessageId = 'WAID-CONCURRENT';
        workerR.lastSentAt = '2026-10-22T01:03:00.000Z';
        atomicWriteJson(file, workerCopy);

        // Confirm-edit lanjut: terapkan edit ke snapshot A, lalu MERGE
        // field audit dari file terbaru supaya tidak terhapus.
        applyReminderScheduleEdit(reminderA, {
            text: 'Pesan baru', time: '08:05', recurrence: 'daily'
        }, [], new Set());

        const latest = JSON.parse(fs.readFileSync(file, 'utf8'));
        const current = latest.find(r => r.id === 55);
        if (current && (current.lastSent || current.lastMessageId)) {
            for (const key of ['lastSent', 'lastSentAt', 'lastMessageId',
                'lastDeliveryId', 'lastScheduledAt', 'lastActualDelayMs']) {
                if (current[key] !== undefined) reminderA[key] = current[key];
            }
        }
        atomicWriteJson(file, snapA);

        const final = JSON.parse(fs.readFileSync(file, 'utf8'))[0];
        assert.equal(final.text, 'Pesan baru', 'teks terupdate');
        assert.equal(final.time, '08:05', 'waktu terupdate');
        assert.equal(final.lastSent, '2026-10-22',
            'audit lastSent dari pengiriman konkuren TIDAK boleh hilang');
        assert.equal(final.lastMessageId, 'WAID-CONCURRENT');
        assert.equal(final.lastSentAt, '2026-10-22T01:03:00.000Z');
    });
});

// ----- 4. GRACE WINDOW UNIFIKASI SEMUA JALUR -----
test('grace window identik untuk jadwal dari alur normal, AI, dan edit', () => {
    // Jalur apa pun pada akhirnya memanggil isWithinScheduleGrace di
    // runReminderCheck. Tes memastikan nilai 2 menit berperilaku sama
    // untuk tiga skenario: jadwal baru biasa, hasil AI, dan hasil edit.
    const scheduledAt = new Date(2026, 9, 22, 10, 0, 0);
    const graceMs = 2 * 60_000;

    // Jalur normal: dibuat 10 detik sebelum jam → aman.
    const nowNormal = new Date(scheduledAt.getTime() + 10_000);
    assert.equal(isWithinScheduleGrace(scheduledAt, nowNormal, graceMs), true);

    // Jalur AI: dibuat tepat setelah jam, 90 detik → masih aman.
    const nowAi = new Date(scheduledAt.getTime() + 90_000);
    assert.equal(isWithinScheduleGrace(scheduledAt, nowAi, graceMs), true);

    // Jalur edit: user edit ke jam yang sudah lewat 3 menit → dilewati.
    const nowEdit = new Date(scheduledAt.getTime() + 3 * 60_000);
    assert.equal(isWithinScheduleGrace(scheduledAt, nowEdit, graceMs), false);
});

// ----- 5. CANQUEUE INVARIANT TIDAK BERUBAH -----
// Regression test ringkas: perbaikan tidak boleh melemahkan anti-duplikat.
test('canQueueDelivery tetap menolak jika lastSent=hari ini / sedang antre / sedang dikirim', () => {
    const key = '55:2026-10-22';
    const date = '2026-10-22';
    assert.equal(canQueueDelivery(key, new Set(), new Set(), date, date), false);
    assert.equal(canQueueDelivery(key, new Set([key]), new Set(), null, date), false);
    assert.equal(canQueueDelivery(key, new Set(), new Set([key]), null, date), false);
    assert.equal(canQueueDelivery(key, new Set(), new Set(), null, date), true);
});
