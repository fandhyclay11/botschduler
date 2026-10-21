import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyReminderScheduleEdit,
    canQueueDelivery,
    isWithinScheduleGrace,
    shouldReplaceQueueTimer
} from './scheduler-edit.js';

test('editing a queued reminder removes old delivery and permits a new delivery for today', () => {
    const today = '2026-10-21';
    const oldKey = `41:${today}`;
    const queue = [{ reminderId: 41, deliveryKey: oldKey, date: today, sendAt: 100 }];
    const queuedKeys = new Set([oldKey]);
    const reminder = {
        id: 41, chatId: 'group@g.us', ownerJid: '62811',
        text: 'Pesan lama', time: '08:00', recurrence: 'daily',
        lastSent: null, pendingDate: today, scheduledAt: '2026-10-21T01:00:00.000Z',
        sendAt: '2026-10-21T01:03:00.000Z', deliveryId: 'old-delivery',
        retryCount: 1, retryAfter: '2026-10-21T01:04:00.000Z'
    };

    const removed = applyReminderScheduleEdit(reminder, {
        text: 'Pesan baru', time: '08:05', recurrence: 'daily'
    }, queue, queuedKeys);

    assert.equal(removed, 1);
    assert.equal(reminder.id, 41);
    assert.equal(reminder.text, 'Pesan baru');
    assert.equal(reminder.time, '08:05');
    assert.equal(reminder.pendingDate, undefined);
    assert.equal(reminder.sendAt, undefined);
    assert.equal(queue.length, 0, 'old scheduled send is removed');
    assert.equal(queuedKeys.has(oldKey), false, 'dedupe key for the old send is cleared');
    assert.equal(canQueueDelivery(oldKey, queuedKeys, new Set(), null, today), true);

    queue.push({ reminderId: reminder.id, deliveryKey: oldKey, date: today, sendAt: 200 });
    queuedKeys.add(oldKey);
    assert.equal(queue[0].sendAt, 200, 'only the new delivery remains queued');
});

test('editing a reminder that already sent today resets lastSent so the new time can still fire', () => {
    const today = '2026-10-21';
    const key = `77:${today}`;
    const reminder = {
        id: 77, chatId: 'group@g.us', ownerJid: '62811',
        text: 'Pesan pagi', time: '08:00', recurrence: 'daily',
        lastSent: today, lastSentAt: '2026-10-21T01:03:00.000Z',
        lastMessageId: 'WAID-OLD'
    };

    const removed = applyReminderScheduleEdit(reminder, {
        text: 'Pesan diubah', time: '10:01', recurrence: 'daily'
    }, [], new Set());

    assert.equal(removed, 0, 'no queued delivery to cancel');
    assert.equal(reminder.lastSent, null,
        'lastSent harus di-reset supaya waktu baru hari ini masih bisa dikirim');
    // Audit trail dari pengiriman sebelumnya boleh dipertahankan.
    assert.equal(reminder.lastSentAt, '2026-10-21T01:03:00.000Z');
    assert.equal(reminder.lastMessageId, 'WAID-OLD');
    // Jalur guard baseline (lihat index.js: `if (reminder.lastSent === today) continue;`)
    // sekarang tidak akan memblokir reminder yang baru diedit.
    assert.notEqual(reminder.lastSent, today);
    assert.equal(canQueueDelivery(key, new Set(), new Set(), reminder.lastSent, today), true);
});

test('editing a reminder to a time that passed moments ago still fits the recovery grace window', () => {
    // Simulasi: user mengedit jadwal ke 10:00 pada 10:00:30 lokal.
    const scheduledAt = new Date(2026, 9, 21, 10, 0, 0);
    const nowJustAfter = new Date(scheduledAt.getTime() + 30_000);
    assert.equal(isWithinScheduleGrace(scheduledAt, nowJustAfter, 2 * 60_000), true);

    // Simulasi: user mengedit ke waktu yang sudah lewat jauh (>2 menit).
    // Perilaku proyek: lewati jadwal terlambat agar tidak membanjiri grup.
    const nowTooLate = new Date(scheduledAt.getTime() + 3 * 60_000);
    assert.equal(isWithinScheduleGrace(scheduledAt, nowTooLate, 2 * 60_000), false);
});

test('a new schedule is eligible within the existing two-minute recovery window', () => {
    const scheduledAt = new Date(2026, 9, 21, 8, 5, 0);
    assert.equal(isWithinScheduleGrace(
        scheduledAt, new Date(scheduledAt.getTime() + 90_000), 2 * 60_000
    ), true);
    assert.equal(isWithinScheduleGrace(
        scheduledAt, new Date(scheduledAt.getTime() + 120_001), 2 * 60_000
    ), false);
    assert.equal(isWithinScheduleGrace(
        scheduledAt, new Date(scheduledAt.getTime() - 1), 2 * 60_000
    ), false);
});

test('the existing anti-duplicate rule still blocks an already sent or queued delivery', () => {
    const key = '41:2026-10-21';
    assert.equal(canQueueDelivery(key, new Set(), new Set(), '2026-10-21', '2026-10-21'), false);
    assert.equal(canQueueDelivery(key, new Set([key]), new Set(), null, '2026-10-21'), false);
    assert.equal(canQueueDelivery(key, new Set(), new Set([key]), null, '2026-10-21'), false);
});

test('a newly queued earlier delivery moves the worker timer forward', () => {
    const now = 1_000_000;
    assert.equal(shouldReplaceQueueTimer(now + 120_000, now), true);
    assert.equal(shouldReplaceQueueTimer(now + 120_000, now + 180_000), false);
    assert.equal(shouldReplaceQueueTimer(null, now + 60_000), true);
});
