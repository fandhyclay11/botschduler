// phaseC/tasks.js
// -------------------------------------------------------------
// CRUD Task (super-set dari Reminder). Task PAKAI mesin recurrence
// existing — di sini kita cuma menyimpan META TAMBAHAN (poin, isTask,
// dst) DENGAN KEY = reminder.id existing.
//
// Struktur tasks.json:
//   {
//     "<reminderId>": {
//         id, ownerJid, chatId, points, createdAt
//     }
//   }
//
// Occurrence key: "<taskId>:<yyyy-mm-dd>"
// Struktur task_occurrences.json:
//   {
//     "<taskId>:<yyyy-mm-dd>": {
//         taskId, date, messageId, completedBy: { "<canonicalUserId>": "<name>" }
//     }
//   }
//
// message_index.json memetakan messageId -> occurrenceKey untuk
// lookup cepat saat reaction masuk.
// -------------------------------------------------------------

import { FILES, readJson, writeJson, appendLog } from './store.js';

export function loadTasks() {
    return readJson(FILES.tasks, {});
}

export function saveTasks(tasks) {
    writeJson(FILES.tasks, tasks);
}

export function loadOccurrences() {
    return readJson(FILES.occurrences, {});
}

export function saveOccurrences(occ) {
    writeJson(FILES.occurrences, occ);
}

export function loadMessageIndex() {
    return readJson(FILES.messageIndex, {});
}

export function saveMessageIndex(idx) {
    writeJson(FILES.messageIndex, idx);
}

export function occurrenceKey(taskId, date) {
    return `${taskId}:${date}`;
}

export function isTask(reminderId) {
    const tasks = loadTasks();
    return Boolean(tasks[String(reminderId)]);
}

export function getTaskMeta(reminderId) {
    const tasks = loadTasks();
    return tasks[String(reminderId)] || null;
}

// Dipanggil setelah createReminder sukses.
export function markReminderAsTask(reminder, points, ownerJid) {
    const tasks = loadTasks();
    tasks[String(reminder.id)] = {
        id: reminder.id,
        ownerJid: ownerJid || reminder.ownerJid || '',
        chatId: reminder.chatId,
        points: Number(points) || 0,
        createdAt: new Date().toISOString()
    };
    saveTasks(tasks);
    appendLog('TASK', `Task dibuat`, `id=${reminder.id} points=${points} chat=${reminder.chatId}`);
}

// Alias generik untuk konsumer eksternal (phaseD/router).
export const markAsTask = markReminderAsTask;

// Dipanggil saat reminder terkirim (message sudah punya key.id).
// Menyimpan mapping messageId <-> occurrence.
export function recordTaskDelivery({ reminderId, date, messageId }) {
    if (!isTask(reminderId)) return;

    const key = occurrenceKey(reminderId, date);
    const occ = loadOccurrences();

    if (!occ[key]) {
        occ[key] = {
            taskId: String(reminderId),
            date,
            messageId,
            completedBy: {}
        };
    } else {
        occ[key].messageId = messageId;
    }

    saveOccurrences(occ);

    const idx = loadMessageIndex();
    idx[messageId] = key;
    saveMessageIndex(idx);

    appendLog('OCC', `Occurrence tercatat`, `key=${key} msg=${messageId}`);
}

// Hapus Task saja (tidak menyentuh reminder existing — itu dihapus
// oleh alur hapus jadwal existing). Poin yang sudah diperoleh tetap.
export function removeTaskMeta(reminderId) {
    const tasks = loadTasks();
    if (!tasks[String(reminderId)]) return false;
    delete tasks[String(reminderId)];
    saveTasks(tasks);
    appendLog('TASK', `Task meta dihapus`, `id=${reminderId}`);
    return true;
}
