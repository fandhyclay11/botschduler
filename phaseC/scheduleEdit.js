// Helper murni untuk memilih dan mengubah jadwal dari daftar yang ditampilkan.

const EDITABLE_FIELDS = [
    'id', 'chatId', 'ownerJid', 'time', 'text', 'recurrence',
    'date', 'daysOfWeek', 'dayOfMonth'
];

function scheduleFingerprint(reminders) {
    return JSON.stringify(reminders.map(reminder =>
        Object.fromEntries(EDITABLE_FIELDS.map(key => [key, reminder[key]]))
    ));
}

export function createReminderView(reminders) {
    return {
        ids: reminders.map(reminder => String(reminder.id)),
        fingerprint: scheduleFingerprint(reminders)
    };
}

export function resolveReminderEditSelection(view, rawIndex, currentReminders) {
    if (!view || !Array.isArray(view.ids)) {
        return { ok: false, reason: 'no-view' };
    }

    const match = String(rawIndex || '').trim().match(/^\d+$/);
    if (!match) return { ok: false, reason: 'invalid-index' };

    const index = Number(match[0]) - 1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= view.ids.length) {
        return { ok: false, reason: 'invalid-index' };
    }

    if (scheduleFingerprint(currentReminders) !== view.fingerprint) {
        return { ok: false, reason: 'stale-view' };
    }

    const id = view.ids[index];
    const reminder = currentReminders.find(item => String(item.id) === id);
    if (!reminder) return { ok: false, reason: 'missing-reminder' };

    return { ok: true, reminder };
}

export function canEditReminder(reminder, {
    isAdmin,
    senderPhone,
    normalizeUserId,
    groupId = null
}) {
    if (!reminder) return false;
    if (groupId && reminder.chatId !== groupId) return false;
    if (isAdmin) return true;
    const owner = normalizeUserId(reminder.ownerJid);
    const sender = normalizeUserId(senderPhone);
    return Boolean(owner && sender && owner === sender);
}

export function applyScheduleEdit(reminder, schedule) {
    const updated = {
        ...reminder,
        time: schedule.time,
        text: schedule.text,
        recurrence: schedule.recurrence
    };

    // Buang hanya field recurrence lama, lalu pasang field yang relevan.
    delete updated.date;
    delete updated.daysOfWeek;
    delete updated.dayOfMonth;

    if (schedule.recurrence === 'once') updated.date = schedule.date;
    if (schedule.recurrence === 'weekly') updated.daysOfWeek = [...schedule.daysOfWeek];
    if (schedule.recurrence === 'monthly') updated.dayOfMonth = schedule.dayOfMonth;

    return updated;
}

export function cancelReminderEdit(stateMap, key, text) {
    if (String(text || '').trim().toLowerCase() !== 'batal') return false;
    stateMap.delete(key);
    return true;
}
