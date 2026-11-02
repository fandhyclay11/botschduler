import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-task-reminder-test-'));
process.env.PHASEC_DATA_DIR = dataDir;

const { markReminderAsTask, recordTaskDelivery, loadOccurrences, loadMessageIndex, saveOccurrences, saveTasks, removeTaskMeta } = await import('./phaseC/tasks.js');
const { tryHandlePhaseCCommand } = await import('./phaseC/commands.js');
const { isTaskReminderEnabled, setTaskReminderEnabled, checkTaskReminders, TASK_REMINDER_INTERVAL_MS, TASK_REMINDER_QUEUE_INTERVAL_MS, getQueuedTaskReminderCount } = await import('./phaseC/taskReminders.js');

const groupA = '120001@g.us';
const groupB = '120002@g.us';
const adminPhone = '62811';
const localDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function todayAt(hour = 8) {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    return d;
}

function makeContext(outbox) {
    return {
        sock: { sendMessage: async (jid, msg) => { outbox.push({ jid, ...msg }); } },
        loadUsers: () => ({ admins: [adminPhone] }),
        isAdmin: (_users, phone) => phone === adminPhone,
        getParticipatingGroups: async () => [{ id: groupA, name: 'Grup A' }, { id: groupB, name: 'Grup B' }]
    };
}

function setupTask(id, groupId, deliveredAt) {
    const reminder = { id, chatId: groupId, text: `Tugas ${id}` };
    markReminderAsTask(reminder, 5, adminPhone);
    const date = localDate(deliveredAt);
    recordTaskDelivery({ reminderId: id, date, messageId: `msg-${id}`, chatId: groupId, text: reminder.text, deliveredAt: deliveredAt.toISOString() });
    return { reminder, occurrenceKey: `${id}:${date}` };
}

test('admin dapat memilih grup dan mengubah status dari chat pribadi; non-admin ditolak', async () => {
    const outbox = [];
    const ctx = makeContext(outbox);
    await tryHandlePhaseCCommand(ctx, 'private-admin', 'pengingat grup pilih', adminPhone);
    assert.match(outbox.at(-1).text, /pengingat aktif <nomor>/);
    await tryHandlePhaseCCommand(ctx, 'private-admin', 'pengingat aktif 1', adminPhone);
    assert.equal(isTaskReminderEnabled(groupA), true);
    assert.match(outbox.at(-1).text, /Status saat ini: \*aktif\*/);

    await tryHandlePhaseCCommand(ctx, 'private-user', 'pengingat nonaktif 1', '62822');
    assert.equal(isTaskReminderEnabled(groupA), true);
    assert.match(outbox.at(-1).text, /Hanya ADMIN/);
    assert.equal(await tryHandlePhaseCCommand(ctx, `${groupA}`, 'pengingat nonaktif 1', adminPhone), false);
});

test('pengaturan grup persisten dan pemeriksaan empat jam hanya antrekan grup aktif', () => {
    setTaskReminderEnabled(groupA, true);
    assert.equal(isTaskReminderEnabled(groupA), true); // dibaca ulang dari file persisten
    assert.equal(isTaskReminderEnabled(groupB), false);
    const deliveredAt = todayAt();
    const a = setupTask(101, groupA, deliveredAt);
    const b = setupTask(102, groupB, deliveredAt);
    const reminders = [a.reminder, b.reminder];
    assert.equal(checkTaskReminders({ now: new Date(deliveredAt.getTime() + 3 * 60 * 60 * 1000), reminders }), 0);
    assert.equal(checkTaskReminders({ now: new Date(deliveredAt.getTime() + TASK_REMINDER_INTERVAL_MS), reminders }), 1);
    assert.equal(loadOccurrences()[a.occurrenceKey].reminderQueuedCycle !== undefined, true);
    assert.equal(loadOccurrences()[b.occurrenceKey].reminderQueuedCycle, undefined);
    assert.equal(TASK_REMINDER_INTERVAL_MS, 4 * 60 * 60 * 1000);
});

test('menonaktifkan pengingat menghapus penanda dan item antrean grup', () => {
    const occurrence = Object.values(loadOccurrences()).find(o => o.chatId === groupA);
    assert.ok(occurrence?.reminderQueuedCycle);
    const before = getQueuedTaskReminderCount();
    assert.ok(before > 0);
    setTaskReminderEnabled(groupA, false);
    assert.equal(isTaskReminderEnabled(groupA), false);
    assert.equal(loadOccurrences()[`${occurrence.taskId}:${occurrence.date}`].reminderQueuedCycle, undefined);
    assert.equal(getQueuedTaskReminderCount(), 0);
});

test('hari berakhir, selesai, pembatalan, dan penggantian pesan meniadakan pengingat lama', () => {
    const deliveredAt = todayAt();
    setTaskReminderEnabled(groupA, true);
    const completed = setupTask(201, groupA, deliveredAt);
    let occ = loadOccurrences();
    occ[completed.occurrenceKey].completedBy = { '62822': 'User' };
    saveOccurrences(occ);
    assert.equal(checkTaskReminders({ now: new Date(deliveredAt.getTime() + TASK_REMINDER_INTERVAL_MS), reminders: [completed.reminder] }), 0);

    const cancelled = setupTask(202, groupA, deliveredAt);
    removeTaskMeta(202);
    assert.equal(checkTaskReminders({ now: new Date(deliveredAt.getTime() + TASK_REMINDER_INTERVAL_MS), reminders: [] }), 0);

    const replaced = setupTask(203, groupA, deliveredAt);
    let current = loadOccurrences();
    current[replaced.occurrenceKey].completedBy = { '62822': 'User' };
    saveOccurrences(current);
    recordTaskDelivery({ reminderId: 203, date: localDate(deliveredAt), messageId: 'msg-new', chatId: groupA, text: 'Tugas 203', deliveredAt: deliveredAt.toISOString() });
    assert.equal(loadMessageIndex()['msg-203'], undefined);
    assert.deepEqual(loadOccurrences()[replaced.occurrenceKey].completedBy, {});
    assert.equal(checkTaskReminders({ now: new Date(deliveredAt.getTime() + TASK_REMINDER_INTERVAL_MS), reminders: [replaced.reminder] }), 1);
    const tomorrow = new Date(deliveredAt.getTime());
    tomorrow.setDate(tomorrow.getDate() + 1);
    assert.equal(checkTaskReminders({ now: tomorrow, reminders: [replaced.reminder] }), 0);
    assert.equal(TASK_REMINDER_QUEUE_INTERVAL_MS, 15_000);
});

test('recovery antrekan satu siklus tanpa menggandakan item dan memakai jeda konservatif', () => {
    const deliveredAt = todayAt();
    setTaskReminderEnabled(groupA, false);
    setTaskReminderEnabled(groupB, true);
    const tasks = [301, 302, 303].map(id => setupTask(id, groupB, deliveredAt));
    const now = new Date(deliveredAt.getTime() + 9 * 60 * 60 * 1000);
    const reminders = tasks.map(task => task.reminder);
    assert.equal(checkTaskReminders({ now, reminders }), 3);
    const queued = getQueuedTaskReminderCount();
    assert.equal(checkTaskReminders({ now: new Date(now.getTime() + TASK_REMINDER_INTERVAL_MS), reminders }), 3);
    assert.equal(getQueuedTaskReminderCount(), queued);
    assert.equal(queued, 3);

    // Impor modul ulang membuat runtime queue baru, seperti proses bot restart;
    // marker persisted di occurrences membangun antrean kembali tanpa siklus ganda.
    return import('./phaseC/taskReminders.js?restart').then(restarted => {
        assert.equal(restarted.checkTaskReminders({ now: new Date(now.getTime() + TASK_REMINDER_INTERVAL_MS), reminders }), 3);
        assert.equal(restarted.getQueuedTaskReminderCount(), 3);
        assert.equal(restarted.checkTaskReminders({ now: new Date(now.getTime() + 60_000), reminders }), 3);
        assert.equal(restarted.getQueuedTaskReminderCount(), 3);
        assert.equal(TASK_REMINDER_QUEUE_INTERVAL_MS, 15_000);
    });
});

test.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
});
