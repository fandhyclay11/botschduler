export function cancelQueuedReminder(messageQueue, queuedDeliveryKeys, reminderId) {
    let removed = 0;
    for (let index = messageQueue.length - 1; index >= 0; index--) {
        const item = messageQueue[index];
        if (String(item.reminderId) !== String(reminderId)) continue;
        messageQueue.splice(index, 1);
        queuedDeliveryKeys.delete(item.deliveryKey);
        removed++;
    }
    return removed;
}

export function applyReminderScheduleEdit(
    reminder,
    schedule,
    messageQueue,
    queuedDeliveryKeys
) {
    reminder.text = schedule.text;
    reminder.time = schedule.time;
    reminder.recurrence = schedule.recurrence;
    for (const key of ['date', 'daysOfWeek', 'dayOfMonth']) delete reminder[key];
    if (schedule.date) reminder.date = schedule.date;
    if (schedule.daysOfWeek) reminder.daysOfWeek = schedule.daysOfWeek;
    if (schedule.dayOfMonth) reminder.dayOfMonth = schedule.dayOfMonth;
    for (const key of ['pendingDate', 'scheduledAt', 'sendAt', 'deliveryId', 'retryCount', 'retryAfter']) {
        delete reminder[key];
    }
    // Edit jadwal selalu diperlakukan sebagai pengiriman baru untuk hari ini,
    // sehingga jadwal yang sudah terkirim lebih awal tetap bisa dikirim ulang
    // pada waktu baru. Tanpa reset ini, pemeriksa reminder akan melewatkan
    // reminder karena `lastSent === today`.
    reminder.lastSent = null;
    return cancelQueuedReminder(messageQueue, queuedDeliveryKeys, reminder.id);
}

export function isWithinScheduleGrace(scheduledAt, now, graceMs) {
    const elapsed = now.getTime() - scheduledAt.getTime();
    return elapsed >= 0 && elapsed <= graceMs;
}

export function canQueueDelivery(deliveryKey, queuedDeliveryKeys, sendingDeliveryKeys, lastSent, date) {
    return lastSent !== date &&
        !queuedDeliveryKeys.has(deliveryKey) &&
        !sendingDeliveryKeys.has(deliveryKey);
}

export function shouldReplaceQueueTimer(currentAt, requestedAt) {
    return currentAt === null || requestedAt < currentAt;
}
