import { FILES, readJson, writeJson, appendLog } from './store.js';
import { loadOccurrences, saveOccurrences, loadTasks } from './tasks.js';

export const TASK_REMINDER_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const TASK_REMINDER_QUEUE_INTERVAL_MS = 15 * 1000;
const CHECK_INTERVAL_MS = 30 * 1000;

function loadConfig() {
    const config = readJson(FILES.taskReminderConfig, { enabledGroups: [] });
    return { ...config, enabledGroups: Array.isArray(config?.enabledGroups) ? config.enabledGroups : [] };
}

export function isTaskReminderEnabled(groupId) {
    return loadConfig().enabledGroups.includes(String(groupId));
}

export function listTaskReminderGroups() {
    return loadConfig().enabledGroups.slice();
}

export function setTaskReminderEnabled(groupId, enabled) {
    const id = String(groupId || '');
    if (!id.endsWith('@g.us')) return { ok: false, error: 'ID grup tidak valid.' };
    const config = loadConfig();
    const groups = new Set(config.enabledGroups || []);
    if (enabled) groups.add(id);
    else groups.delete(id);
    config.enabledGroups = [...groups];
    writeJson(FILES.taskReminderConfig, config);

    if (!enabled) {
        removeQueuedTaskReminders(id);
        const occurrences = loadOccurrences();
        let changed = false;
        for (const occurrence of Object.values(occurrences)) {
            if (occurrence.chatId !== id) continue;
            delete occurrence.reminderQueuedCycle;
            changed = true;
        }
        if (changed) saveOccurrences(occurrences);
    }
    appendLog('TASK-REMINDER', enabled ? 'Pengingat diaktifkan' : 'Pengingat dinonaktifkan', `group=${id}`);
    return { ok: true, enabled: Boolean(enabled) };
}

function localDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function occurrenceHasCompletion(occurrence) {
    return Object.keys(occurrence.completedBy || {}).length > 0;
}

function isRelevant(occurrence, tasks, reminders, today) {
    if (!occurrence?.messageId || occurrence.date !== today || occurrence.cancelled || occurrence.superseded) return false;
    if (occurrenceHasCompletion(occurrence)) return false;
    const task = tasks[String(occurrence.taskId)];
    if (!task || !task.chatId || task.chatId !== occurrence.chatId) return false;
    return reminders.some(r => String(r.id) === String(occurrence.taskId) && r.chatId === occurrence.chatId);
}

const queue = [];
let timer = null;
let worker = false;
let socket = null;
let getStateProvider = null;
let lastSentAt = 0;

function scheduleWorker(delay = 0) {
    if (timer) return;
    timer = setTimeout(async () => {
        timer = null;
        await processQueue();
    }, Math.max(delay, 0));
}

async function processQueue(nowProvider = () => new Date()) {
    if (worker) return;
    worker = true;
    try {
        while (queue.length) {
            queue.sort((a, b) => a.queuedAt - b.queuedAt);
            const wait = Math.max(0, TASK_REMINDER_QUEUE_INTERVAL_MS - (nowProvider().getTime() - lastSentAt));
            if (wait > 0 && lastSentAt > 0) {
                scheduleWorker(wait);
                return;
            }
            const item = queue.shift();
            const today = localDateKey(nowProvider());
            const occurrence = loadOccurrences()[item.key];
            const tasks = loadTasks();
            const activeReminders = getStateProvider?.().reminders || [];
            const task = occurrence ? tasks[String(occurrence.taskId)] : null;
            if (!isTaskReminderEnabled(item.chatId) || !occurrence || occurrence.date !== today ||
                occurrence.reminderQueuedCycle !== item.cycle || occurrenceHasCompletion(occurrence) ||
                !occurrence.messageId || !task || task.chatId !== item.chatId ||
                !activeReminders.some(r => String(r.id) === String(occurrence.taskId) && r.chatId === item.chatId)) continue;
            if (!socket) continue;
            try {
                await socket.sendMessage(item.chatId, { text: 'Tugas Belum Diselesaikan!!!' }, {
                    quoted: { key: { remoteJid: item.chatId, id: occurrence.messageId }, message: { conversation: item.taskText || 'Tugas' } }
                });
                const current = loadOccurrences();
                const latest = current[item.key];
                if (latest && latest.reminderQueuedCycle === item.cycle) {
                    latest.reminderSentCycle = item.cycle;
                    delete latest.reminderQueuedCycle;
                    const prior = new Date(latest.nextReminderAt || item.cycle).getTime();
                    const next = prior + TASK_REMINDER_INTERVAL_MS;
                    latest.nextReminderAt = new Date(next <= nowProvider().getTime() ? nowProvider().getTime() + TASK_REMINDER_INTERVAL_MS : next).toISOString();
                    saveOccurrences(current);
                }
                lastSentAt = nowProvider().getTime();
            } catch (error) {
                appendLog('WARN', 'Gagal mengirim pengingat tugas', error?.message || error);
                // Jangan tandai terkirim; pemeriksaan berikutnya akan antrekan ulang.
                const current = loadOccurrences();
                if (current[item.key]) {
                    delete current[item.key].reminderQueuedCycle;
                    saveOccurrences(current);
                }
            }
        }
    } finally {
        worker = false;
        if (queue.length) scheduleWorker(TASK_REMINDER_QUEUE_INTERVAL_MS);
    }
}

export function checkTaskReminders({ now = new Date(), reminders = [], tasks = loadTasks(), occurrences = loadOccurrences() } = {}) {
    const today = localDateKey(now);
    const enabled = new Set(listTaskReminderGroups());
    const jobs = [];
    let changed = false;
    for (const [key, occurrence] of Object.entries(occurrences)) {
        if (!enabled.has(occurrence.chatId) || !isRelevant(occurrence, tasks, reminders, today)) continue;
        if (!occurrence.nextReminderAt) {
            const deliveredAt = new Date(occurrence.deliveredAt || `${occurrence.date}T00:00:00`).getTime();
            occurrence.nextReminderAt = new Date(deliveredAt + TASK_REMINDER_INTERVAL_MS).toISOString();
            changed = true;
        }
        const due = new Date(occurrence.nextReminderAt).getTime();
        if (occurrence.reminderQueuedCycle) {
            if (occurrence.reminderSentCycle !== occurrence.reminderQueuedCycle) {
                jobs.push({ key, cycle: occurrence.reminderQueuedCycle, chatId: occurrence.chatId, queuedAt: now.getTime(), taskText: tasks[String(occurrence.taskId)]?.text || '' });
            }
            continue;
        }
        if (!Number.isFinite(due) || now.getTime() < due || occurrence.reminderSentCycle === occurrence.nextReminderAt) continue;
        const cycle = occurrence.nextReminderAt;
        occurrence.reminderQueuedCycle = cycle;
        jobs.push({ key, cycle, chatId: occurrence.chatId, queuedAt: now.getTime(), taskText: tasks[String(occurrence.taskId)]?.text || '' });
        changed = true;
    }
    if (changed) saveOccurrences(occurrences);
    for (const job of jobs) {
        if (!queue.some(item => item.key === job.key && item.cycle === job.cycle)) queue.push(job);
    }
    if (queue.length && socket) scheduleWorker();
    return jobs.length;
}

export function startTaskReminderScheduler(sock, getState) {
    socket = sock;
    getStateProvider = getState;
    const check = () => {
        const state = getState();
        checkTaskReminders({ now: new Date(), reminders: state.reminders, tasks: loadTasks() });
    };
    check(); // satu pemeriksaan pemulihan saat koneksi aktif
    if (globalThis.__TASK_REMINDER_CHECKER__) clearInterval(globalThis.__TASK_REMINDER_CHECKER__);
    globalThis.__TASK_REMINDER_CHECKER__ = setInterval(check, CHECK_INTERVAL_MS);
}

export function stopTaskReminderScheduler() {
    if (globalThis.__TASK_REMINDER_CHECKER__) clearInterval(globalThis.__TASK_REMINDER_CHECKER__);
    globalThis.__TASK_REMINDER_CHECKER__ = null;
    if (timer) clearTimeout(timer);
    timer = null;
    socket = null;
    getStateProvider = null;
}

export function removeQueuedTaskReminders(groupId) {
    for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].chatId === groupId) queue.splice(i, 1);
    }
}

export function getQueuedTaskReminderCount() {
    return queue.length;
}
