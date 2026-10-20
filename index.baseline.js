import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestWaWebVersion
} from '@whiskeysockets/baileys';

import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'fs';

// ========================================
// FILE PENYIMPANAN REMINDER
// ========================================

const REMINDER_FILE = './reminders.json';


// ========================================
// USER ACCESS CONTROL - PHASE B.5
// ========================================
// 1. Whitelist nomor pengguna
// 2. Role ADMIN / USER
// 3. User hanya melihat jadwal miliknya
// 4. Admin dapat melihat semua jadwal
// 5. Admin dapat menambah user
// 6. Admin dapat menghapus user

const USER_FILE = './users.json';

if (!fs.existsSync(USER_FILE)) {
    fs.writeFileSync(
        USER_FILE,
        JSON.stringify(
            {
                admins: [],
                users: []
            },
            null,
            2
        )
    );
}

function loadUsers() {
    try {
        const data = JSON.parse(
            fs.readFileSync(USER_FILE, 'utf8')
        );

        return {
            admins: Array.isArray(data?.admins) ? data.admins : [],
            users: Array.isArray(data?.users) ? data.users : []
        };
    } catch (error) {
        console.log('⚠️ Gagal membaca users.json');
        return { admins: [], users: [] };
    }
}

function saveUsers(users) {
    fs.writeFileSync(
        USER_FILE,
        JSON.stringify(users, null, 2)
    );
}

function normalizeUserId(value) {
    if (!value) return '';

    let digits = String(value)
        .trim()
        .split(':')[0]
        .split('@')[0]
        .replace(/\D/g, '');

    // Memudahkan input nomor Indonesia: 08xxx -> 628xxx.
    if (digits.startsWith('0')) {
        digits = `62${digits.slice(1)}`;
    }

    return digits;
}

function getUserPhone(value) {
    return normalizeUserId(value);
}

function findUserRecord(users, phone, aliases = []) {
    const candidates = [phone, ...aliases]
        .map(normalizeUserId)
        .filter(Boolean);

    return users.users.find(user =>
        candidates.includes(
            normalizeUserId(
                typeof user === 'string' ? user : user?.jid
            )
        )
    ) || null;
}

function isAdmin(users, phone, aliases = []) {
    const candidates = [phone, ...aliases]
        .filter(Boolean)
        .map(value => String(value).trim());

    const candidatePhones = candidates
        .map(normalizeUserId)
        .filter(Boolean);

    const candidateRaw = new Set(candidates);

    return users.admins.some(admin => {
        const record = typeof admin === 'string' ? { jid: admin } : (admin || {});
        const adminPhone = normalizeUserId(record.phone || record.jid);
        const adminJid = String(record.jid || '').trim();
        const adminAliases = Array.isArray(record.aliases) ? record.aliases : [];

        // Cocokkan nomor canonical terlebih dahulu.
        if (adminPhone && candidatePhones.includes(adminPhone)) return true;

        // Jika WhatsApp mengirim @lid, cocokkan JID mentah yang pernah
        // tersimpan saat setup. Ini mencegah ADMIN berubah menjadi USER.
        const storedRaw = [adminJid, ...adminAliases]
            .filter(Boolean)
            .map(value => String(value).trim());

        return storedRaw.some(value => candidateRaw.has(value));
    });
}

function isAuthorized(users, phone, aliases = []) {
    return isAdmin(users, phone, aliases) || Boolean(findUserRecord(users, phone, aliases));
}

// Migrasi otomatis untuk ADMIN/USER lama yang sempat tersimpan sebagai @lid.
// Versi sebelumnya menyimpan remoteJid saat setup, sementara validasi berikutnya
// memakai remoteJidAlt/nomor telepon. Akibatnya ADMIN yang sama bisa terbaca USER.
function migrateLegacyAdminIdentity(users, canonicalPhone, aliases = []) {
    const phone = normalizeUserId(canonicalPhone);
    if (!phone) return false;

    const aliasIds = aliases.map(normalizeUserId).filter(Boolean);
    let changed = false;

    for (const admin of users.admins) {
        if (typeof admin === 'string') continue;

        const storedId = normalizeUserId(admin?.jid);
        if (!storedId || storedId === phone) continue;

        if (aliasIds.includes(storedId)) {
            admin.jid = phone;
            admin.phone = phone;
            admin.aliases = Array.isArray(admin.aliases) ? admin.aliases : [];
            if (!admin.aliases.includes(storedId)) admin.aliases.push(storedId);
            admin.migratedAt = new Date().toISOString();
            changed = true;
        }
    }

    for (const user of users.users) {
        if (typeof user === 'string') continue;

        const storedId = normalizeUserId(user?.jid);
        if (!storedId || storedId === phone) continue;

        if (aliasIds.includes(storedId)) {
            user.jid = phone;
            user.phone = phone;
            user.migratedAt = new Date().toISOString();
            changed = true;
        }
    }

    if (changed) saveUsers(users);
    return changed;
}

function getUserRole(phone) {
    const users = loadUsers();
    if (isAdmin(users, phone)) return 'ADMIN';
    if (findUserRecord(users, phone)) return 'USER';
    return null;
}

function displayUserName(record) {
    if (!record) return '';
    if (typeof record === 'string') return '';
    return record.name ? ` — ${record.name}` : '';
}

function addUser(users, phone, name = '') {
    const normalized = normalizeUserId(phone);

    if (!normalized) {
        return { ok: false, error: 'Nomor WhatsApp tidak valid.' };
    }

    if (isAdmin(users, normalized)) {
        return { ok: false, error: 'Nomor tersebut sudah menjadi ADMIN.' };
    }

    if (findUserRecord(users, normalized)) {
        return { ok: false, error: 'Nomor tersebut sudah terdaftar.' };
    }

    users.users.push({
        jid: normalized,
        name: String(name || '').trim(),
        addedAt: new Date().toISOString()
    });

    return { ok: true };
}

function removeUser(users, phone) {
    const normalized = normalizeUserId(phone);

    if (isAdmin(users, normalized)) {
        return { ok: false, error: 'ADMIN tidak bisa dihapus dari daftar USER.' };
    }

    const before = users.users.length;
    users.users = users.users.filter(user =>
        normalizeUserId(
            typeof user === 'string' ? user : user?.jid
        ) !== normalized
    );

    if (users.users.length === before) {
        return { ok: false, error: 'Nomor tersebut tidak ditemukan.' };
    }

    return { ok: true };
}

// Kode setup hanya aktif selama belum ada ADMIN.
const INITIAL_SETUP_CODE = String(
    Math.floor(100000 + Math.random() * 900000)
);
let accessStatusPrinted = false;

function printAccessControlStatus() {
    if (accessStatusPrinted) return;
    accessStatusPrinted = true;

    const users = loadUsers();

    console.log(`👥 Access Control: ${users.admins.length} admin, ${users.users.length} user.`);

    if (users.admins.length === 0) {
        console.log('');
        console.log('🔐 BELUM ADA ADMIN.');
        console.log(`🔑 Kode setup ADMIN: ${INITIAL_SETUP_CODE}`);
        console.log('Kirim dari WhatsApp pribadi ke bot:');
        console.log(`setup ${INITIAL_SETUP_CODE}`);
        console.log('');
    }
}

if (!fs.existsSync(REMINDER_FILE)) {
    fs.writeFileSync(
        REMINDER_FILE,
        JSON.stringify([], null, 2)
    );
}

function loadReminders() {
    try {
        const data = JSON.parse(
            fs.readFileSync(REMINDER_FILE, 'utf8')
        );

        if (!Array.isArray(data)) return [];

        // Migrasi kompatibilitas: jadwal lama yang belum memiliki ownerJid
        // akan dimiliki ADMIN utama setelah Access Control diaktifkan.
        const users = loadUsers();
        const primaryAdmin = users.admins[0];
        const primaryAdminJid = primaryAdmin
            ? normalizeUserId(typeof primaryAdmin === 'string' ? primaryAdmin : primaryAdmin.jid)
            : '';

        if (primaryAdminJid) {
            let changed = false;

            for (const reminder of data) {
                if (!reminder.ownerJid) {
                    reminder.ownerJid = primaryAdminJid;
                    changed = true;
                }
            }

            if (changed) {
                fs.writeFileSync(
                    REMINDER_FILE,
                    JSON.stringify(data, null, 2)
                );
            }
        }

        return data;
    } catch (error) {
        console.log('⚠️ Gagal membaca reminders.json');
        return [];
    }
}

function saveReminders(reminders) {
    fs.writeFileSync(
        REMINDER_FILE,
        JSON.stringify(reminders, null, 2)
    );
}

// ========================================
// STATE PENJADWALAN VIA CHAT PRIBADI
// ========================================
// State ini hanya untuk proses memilih grup lalu
// memasukkan format jadwal.

const privateScheduleState = new Map();
const privateScheduleViews = new Map();

// ========================================
// UTILITAS
// ========================================

const WEEKDAY_MAP = {
    minggu: 0,
    ahad: 0,
    senin: 1,
    selasa: 2,
    rabu: 3,
    kamis: 4,
    jumat: 5,
    jumat: 5,
    sabtu: 6
};

const WEEKDAY_LABEL = [
    'Minggu',
    'Senin',
    'Selasa',
    'Rabu',
    'Kamis',
    'Jumat',
    'Sabtu'
];

function normalizeText(value) {
    return String(value || '')
        .trim()
        .replace(/\s+/g, ' ');
}

// Normalisasi khusus isi pesan jadwal.
// Berbeda dari normalizeText(), fungsi ini MEMPERTAHANKAN line break
// agar pesan panjang yang dicopy dari WhatsApp tetap rapi saat dikirim ulang.
function normalizeScheduleInput(value) {
    return String(value || '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => line.replace(/[ \t]+/g, ' ').trimEnd())
        .join('\n')
        .trim();
}

function formatTime(hour, minute) {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseTime(hourText, minuteText) {
    const hour = Number(hourText);
    const minute = Number(minuteText);

    if (
        !Number.isInteger(hour) ||
        !Number.isInteger(minute) ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59
    ) {
        return null;
    }

    return formatTime(hour, minute);
}

function getTodayParts() {
    const now = new Date();

    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');

    return {
        now,
        today: `${year}-${month}-${day}`,
        currentTime: `${hour}:${minute}`
    };
}

function isReminderDueToday(reminder, now = new Date()) {
    // Reminder lama otomatis dianggap sebagai harian.
    const recurrence = reminder.recurrence || 'daily';

    if (recurrence === 'daily') {
        return true;
    }

    if (recurrence === 'weekly') {
        const days = Array.isArray(reminder.daysOfWeek)
            ? reminder.daysOfWeek
            : [];

        return days.includes(now.getDay());
    }

    if (recurrence === 'monthly') {
        return Number(reminder.dayOfMonth) === now.getDate();
    }

    return false;
}

function recurrenceLabel(reminder) {
    const recurrence = reminder.recurrence || 'daily';

    if (recurrence === 'daily') {
        return 'Setiap hari';
    }

    if (recurrence === 'weekly') {
        const days = Array.isArray(reminder.daysOfWeek)
            ? reminder.daysOfWeek
            : [];

        return days
            .sort((a, b) => a - b)
            .map(day => WEEKDAY_LABEL[day] || day)
            .join(', ');
    }

    if (recurrence === 'monthly') {
        return `Setiap tanggal ${reminder.dayOfMonth}`;
    }

    return 'Berulang';
}

function buildReminder(
    chatId,
    time,
    text,
    recurrence = 'daily',
    extra = {}
) {
    return {
        id: Date.now() + Math.floor(Math.random() * 1000),
        chatId,
        time,
        text,
        recurrence,
        ...extra,
        lastSent: null,
        lastTemplateIndex: -1
    };
}

function isDuplicateReminder(reminders, candidate) {
    return reminders.some(reminder => {
        const sameChat = reminder.chatId === candidate.chatId;
        const sameTime = reminder.time === candidate.time;
        const sameText = normalizeText(reminder.text).toLowerCase() ===
            normalizeText(candidate.text).toLowerCase();
        const sameRecurrence = (reminder.recurrence || 'daily') ===
            (candidate.recurrence || 'daily');

        if (!sameChat || !sameTime || !sameText || !sameRecurrence) {
            return false;
        }

        if (candidate.recurrence === 'weekly') {
            const a = [...(reminder.daysOfWeek || [])].sort((x, y) => x - y);
            const b = [...(candidate.daysOfWeek || [])].sort((x, y) => x - y);
            return JSON.stringify(a) === JSON.stringify(b);
        }

        if (candidate.recurrence === 'monthly') {
            return Number(reminder.dayOfMonth) === Number(candidate.dayOfMonth);
        }

        return true;
    });
}

// ========================================
// PARSER FORMAT JADWAL
// ========================================
// Didukung:
// setiap hari 08:00 briefing
// setiap senin 08:00 briefing
// setiap senin,rabu,jumat 08:00 briefing
// setiap tanggal 8 08:00 laporan
//
// Untuk grup, command lama tetap dipertahankan.
// ========================================

function parseScheduleText(text) {
    // Pertahankan line break pada isi jadwal panjang.
    const input = normalizeScheduleInput(text);

    // SETIAP HARI
    let match = input.match(
        /^setiap\s+hari\s+(\d{1,2}):(\d{2})\s+([\s\S]+)$/i
    );

    if (match) {
        const time = parseTime(match[1], match[2]);

        if (!time) {
            return { error: 'Format waktu tidak valid.' };
        }

        return {
            recurrence: 'daily',
            time,
            text: match[3].trim()
        };
    }

    // SETIAP HARI DALAM MINGGU
    match = input.match(
        /^setiap\s+([a-zA-ZÀ-ÿ'\u2019,\s]+?)\s+(\d{1,2}):(\d{2})\s+([\s\S]+)$/i
    );

    if (match && !/^tanggal\b/i.test(match[1].trim())) {
        const rawDays = match[1]
            .split(',')
            .map(day => day.trim().toLowerCase())
            .filter(Boolean);

        const daysOfWeek = [];

        for (const rawDay of rawDays) {
            const day = WEEKDAY_MAP[rawDay];

            if (day === undefined) {
                return {
                    error:
                        `Hari "${rawDay}" tidak dikenali. Gunakan Senin-Sabtu atau Minggu.`
                };
            }

            if (!daysOfWeek.includes(day)) {
                daysOfWeek.push(day);
            }
        }

        const time = parseTime(match[2], match[3]);

        if (!time) {
            return { error: 'Format waktu tidak valid.' };
        }

        if (daysOfWeek.length === 0) {
            return { error: 'Hari belum dipilih.' };
        }

        return {
            recurrence: 'weekly',
            daysOfWeek,
            time,
            text: match[4].trim()
        };
    }

    // SETIAP TANGGAL BULANAN
    match = input.match(
        /^setiap\s+tanggal\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s+([\s\S]+)$/i
    );

    if (match) {
        const dayOfMonth = Number(match[1]);
        const time = parseTime(match[2], match[3]);

        if (
            !Number.isInteger(dayOfMonth) ||
            dayOfMonth < 1 ||
            dayOfMonth > 31
        ) {
            return { error: 'Tanggal harus antara 1 sampai 31.' };
        }

        if (!time) {
            return { error: 'Format waktu tidak valid.' };
        }

        return {
            recurrence: 'monthly',
            dayOfMonth,
            time,
            text: match[4].trim()
        };
    }

    return null;
}

// ========================================
// MESIN REMINDER - VERSI STABIL
// ========================================
// Scheduler tidak lagi tidur tepat sampai satu titik waktu.
// Bot mengecek reminder secara berkala sehingga keterlambatan
// beberapa detik / restart bot tidak membuat jadwal terlewat.

let reminderTimer = null;

const REMINDER_CHECK_INTERVAL = 5000; // cek setiap 5 detik
const REMINDER_GRACE_MINUTES = 2;     // toleransi jika bot terlambat/restart

// ========================================
// FASE B - RELIABILITY
// ========================================
// Variasi template, antrean, anti-double-send,
// rate limiter, retry terkendali, dan logging.

const RANDOM_DELAY_MINUTES = 1;
const RANDOM_DELAY_MAX_MINUTES = 5;
const MESSAGE_MIN_INTERVAL_MS = 8000; // minimal jeda antar pesan terjadwal
const MAX_SEND_RETRIES = 3;
const RETRY_DELAY_MS = 15000;
const LOG_FILE = './scheduler.log';

const messageQueue = [];
const queuedDeliveryKeys = new Set();
const sendingDeliveryKeys = new Set();
let queueTimer = null;
let queueWorkerRunning = false;
let lastScheduledMessageSentAt = 0;

function writeLog(level, message, extra = '') {
    const line = `[${new Date().toISOString()}] [${level}] ${message}${extra ? ` | ${extra}` : ''}`;

    console.log(line);

    try {
        fs.appendFileSync(LOG_FILE, `${line}\n`);
    } catch (error) {
        console.log('⚠️ Gagal menulis scheduler.log:', error.message);
    }
}

function generateDeliveryId(reminderId, date) {
    const random = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `REM-${reminderId}-${date}-${random}`;
}

function getRandomDelayMs() {
    const min = RANDOM_DELAY_MINUTES * 60 * 1000;
    const max = RANDOM_DELAY_MAX_MINUTES * 60 * 1000;
    return min + Math.floor(Math.random() * (max - min + 1));
}

const REMINDER_TEMPLATES = [
    (r) => `🔔 *REMINDER*\n\n📌 ${r.text}\n🔁 ${recurrenceLabel(r)}\n⏰ ${r.time}\n\nJangan lupa dikerjakan! 💪`,
    (r) => `🔔 *PENGINGAT*\n\n📌 ${r.text}\n⏰ ${r.time}\n🔁 ${recurrenceLabel(r)}\n\nSemangat, jangan sampai terlewat! 💪`,
    (r) => `📢 *JADWAL HARI INI*\n\n📌 ${r.text}\n⏰ ${r.time}\n\nWaktunya mengerjakan jadwal hari ini.`,
    (r) => `⏰ *WAKTUNYA TIBA*\n\n📌 ${r.text}\n🔁 ${recurrenceLabel(r)}\n\nSilakan dikerjakan. 👍`,
    (r) => `📋 *PENGINGAT JADWAL*\n\n${r.text}\n\n⏰ ${r.time}\n🔁 ${recurrenceLabel(r)}\n\nMohon ditindaklanjuti.`,
    (r) => `🔔 *JADWAL*\n\n📌 ${r.text}\n⏰ ${r.time}\n\nJangan sampai terlewat. 👍`
];

function chooseReminderTemplate(reminder) {
    const previous = Number.isInteger(reminder.lastTemplateIndex)
        ? reminder.lastTemplateIndex
        : -1;

    const choices = REMINDER_TEMPLATES
        .map((_, index) => index)
        .filter(index => index !== previous);

    const index = choices[Math.floor(Math.random() * choices.length)];
    reminder.lastTemplateIndex = index;

    return REMINDER_TEMPLATES[index](reminder);
}

function buildDeliveryKey(reminder, date) {
    return `${reminder.id}:${date}`;
}

function getScheduledDateTime(reminder, date) {
    const match = String(reminder.time || '').match(/^(\d{2}):(\d{2})$/);
    if (!match) return null;

    const target = new Date(`${date}T${reminder.time}:00`);
    if (Number.isNaN(target.getTime())) return null;

    return target;
}

function preparePendingDelivery(reminder, today) {
    if (reminder.pendingDate === today && reminder.sendAt) {
        return true;
    }

    const scheduledAt = getScheduledDateTime(reminder, today);
    if (!scheduledAt) return false;

    const sendAt = new Date(
        scheduledAt.getTime() + getRandomDelayMs()
    );

    reminder.pendingDate = today;
    reminder.scheduledAt = scheduledAt.toISOString();
    reminder.sendAt = sendAt.toISOString();
    reminder.deliveryId = generateDeliveryId(reminder.id, today);
    reminder.retryCount = 0;

    writeLog(
        'QUEUE',
        `Delivery disiapkan: ${reminder.deliveryId}`,
        `jadwal=${reminder.time}, kirim=${sendAt.toLocaleTimeString('id-ID')}`
    );

    return true;
}

function clearPendingDelivery(reminder) {
    delete reminder.pendingDate;
    delete reminder.scheduledAt;
    delete reminder.sendAt;
    delete reminder.deliveryId;
    delete reminder.retryCount;
    delete reminder.retryAfter;
}

function enqueueReminder(reminder, today) {
    const deliveryKey = buildDeliveryKey(reminder, today);

    if (reminder.lastSent === today) return false;
    if (queuedDeliveryKeys.has(deliveryKey)) return false;
    if (sendingDeliveryKeys.has(deliveryKey)) return false;

    const originalSendAt = new Date(reminder.sendAt).getTime();
    if (!Number.isFinite(originalSendAt)) return false;

    let sendAt = originalSendAt;

    if (reminder.retryAfter) {
        const retryAfter = new Date(reminder.retryAfter).getTime();
        if (Number.isFinite(retryAfter)) {
            sendAt = Math.max(sendAt, retryAfter);
            if (Date.now() < retryAfter) {
                // Tetap boleh masuk queue sekarang; worker akan menunggu sampai retryAfter.
            }
        }
    }

    messageQueue.push({
        deliveryKey,
        reminderId: reminder.id,
        date: today,
        sendAt
    });

    queuedDeliveryKeys.add(deliveryKey);

    writeLog(
        'QUEUE',
        `Masuk antrean: ${reminder.deliveryId}`,
        `panjang=${messageQueue.length}`
    );

    scheduleQueueWorker();
    return true;
}

function scheduleQueueWorker(delay = 0) {
    if (queueTimer) return;

    queueTimer = setTimeout(async () => {
        queueTimer = null;
        await processMessageQueue();
    }, Math.max(0, delay));
}

async function processMessageQueue() {
    if (queueWorkerRunning) return;
    queueWorkerRunning = true;

    try {
        while (messageQueue.length > 0) {
            messageQueue.sort((a, b) => a.sendAt - b.sendAt);

            const item = messageQueue[0];
            const now = Date.now();
            const waitUntil = Math.max(
                item.sendAt,
                lastScheduledMessageSentAt + MESSAGE_MIN_INTERVAL_MS
            );

            if (waitUntil > now) {
                scheduleQueueWorker(waitUntil - now);
                return;
            }

            messageQueue.shift();
            queuedDeliveryKeys.delete(item.deliveryKey);
            await sendQueuedReminder(item);
        }
    } finally {
        queueWorkerRunning = false;
    }
}

async function sendQueuedReminder(item) {
    const reminders = loadReminders();
    const reminder = reminders.find(r => String(r.id) === String(item.reminderId));

    if (!reminder) {
        writeLog('WARN', `Reminder tidak ditemukan: ${item.reminderId}`);
        return;
    }

    if (reminder.lastSent === item.date) {
        writeLog('SKIP', `Anti-double-send: ${reminder.deliveryId}`);
        return;
    }

    const deliveryKey = item.deliveryKey;
    if (sendingDeliveryKeys.has(deliveryKey)) return;
    sendingDeliveryKeys.add(deliveryKey);

    try {
        const sock = globalThis.__WA_SCHEDULER_SOCKET__;
        if (!sock) throw new Error('Socket WhatsApp belum tersedia.');

        const text = chooseReminderTemplate(reminder);
        const attempt = Number(reminder.retryCount || 0) + 1;

        writeLog(
            'SEND',
            `Mengirim ${reminder.deliveryId}`,
            `attempt=${attempt}, chat=${reminder.chatId}`
        );

        const result = await sock.sendMessage(reminder.chatId, { text });

        if (!result?.key?.id) {
            throw new Error('WhatsApp tidak mengembalikan ID pesan.');
        }

        reminder.lastSent = item.date;
        reminder.lastMessageId = result.key.id;
        reminder.lastDeliveryId = reminder.deliveryId;
        reminder.lastScheduledAt = reminder.scheduledAt || null;
        reminder.lastSentAt = new Date().toISOString();
        reminder.lastActualDelayMs = reminder.scheduledAt
            ? Date.now() - new Date(reminder.scheduledAt).getTime()
            : null;

        clearPendingDelivery(reminder);
        saveReminders(reminders);

        lastScheduledMessageSentAt = Date.now();

        writeLog(
            'SUCCESS',
            `Terkirim ${reminder.lastDeliveryId}`,
            `messageId=${result.key.id}`
        );
    } catch (error) {
        const attempt = Number(reminder.retryCount || 0) + 1;
        reminder.retryCount = attempt;

        if (attempt < MAX_SEND_RETRIES) {
            reminder.retryAfter = new Date(
                Date.now() + RETRY_DELAY_MS
            ).toISOString();

            saveReminders(reminders);

            writeLog(
                'RETRY',
                `Gagal ${reminder.deliveryId}`,
                `attempt=${attempt}/${MAX_SEND_RETRIES}, retry=${reminder.retryAfter}, error=${error?.message || error}`
            );

            enqueueReminder(reminder, item.date);
        } else {
            reminder.retryAfter = new Date(
                Date.now() + 24 * 60 * 60 * 1000
            ).toISOString();

            saveReminders(reminders);

            writeLog(
                'ERROR',
                `Gagal permanen hari ini ${reminder.deliveryId}`,
                `attempt=${attempt}, error=${error?.message || error}`
            );
        }
    } finally {
        sendingDeliveryKeys.delete(deliveryKey);
    }
}


function getMinutesOfDay(date) {
    return date.getHours() * 60 + date.getMinutes();
}

function getReminderMinute(reminder) {
    const match = String(reminder.time || '').match(/^(\d{2}):(\d{2})$/);

    if (!match) return null;

    const hour = Number(match[1]);
    const minute = Number(match[2]);

    if (
        !Number.isInteger(hour) ||
        !Number.isInteger(minute) ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59
    ) {
        return null;
    }

    return hour * 60 + minute;
}

function isReminderTimeReached(reminder, now) {
    const reminderMinute = getReminderMinute(reminder);
    if (reminderMinute === null) return false;

    const nowMinute = getMinutesOfDay(now);

    if (nowMinute === reminderMinute) return true;

    if (nowMinute > reminderMinute) {
        const diff = nowMinute - reminderMinute;
        return diff <= REMINDER_GRACE_MINUTES;
    }

    return false;
}

async function runReminderCheck(sock) {
    globalThis.__WA_SCHEDULER_SOCKET__ = sock;

    const { today, now } = getTodayParts();
    const reminders = loadReminders();
    let changed = false;

    for (const reminder of reminders) {
        if (reminder.lastSent === today) continue;
        if (!isReminderDueToday(reminder, now)) continue;

        const scheduledAt = getScheduledDateTime(reminder, today);
        if (!scheduledAt) continue;

        // Sebelum waktu jadwal: belum melakukan apa-apa.
        if (now.getTime() < scheduledAt.getTime()) continue;

        // Buat target pengiriman sekali saja: +1 sampai +5 menit.
        const wasPending = reminder.pendingDate === today && Boolean(reminder.sendAt);

        if (!preparePendingDelivery(reminder, today)) continue;
        if (!wasPending) changed = true;

        // Jika retry sebelumnya masih menunggu, biarkan retry handler yang mengatur.
        if (reminder.retryAfter) {
            const retryAfter = new Date(reminder.retryAfter).getTime();
            if (Number.isFinite(retryAfter) && now.getTime() < retryAfter) {
                continue;
            }
        }

        const sendAt = new Date(reminder.sendAt).getTime();

        if (now.getTime() >= sendAt) {
            if (enqueueReminder(reminder, today)) {
                changed = true;
            }
        }
    }

    if (changed) {
        saveReminders(reminders);
    }

    processMessageQueue().catch(error => {
        writeLog('ERROR', 'Queue worker error', error?.message || error);
    });
}

function scheduleReminderChecker(sock) {
    if (reminderTimer) {
        clearTimeout(reminderTimer);
        reminderTimer = null;
    }

    reminderTimer = setTimeout(async () => {
        reminderTimer = null;

        try {
            await runReminderCheck(sock);
        } catch (error) {
            writeLog(
                'ERROR',
                'Error pada mesin reminder',
                error?.message || error
            );
        } finally {
            scheduleReminderChecker(sock);
        }
    }, REMINDER_CHECK_INTERVAL);
}

function startReminderChecker(sock) {
    globalThis.__WA_SCHEDULER_SOCKET__ = sock;

    console.log('⏰ Mesin reminder aktif.');
    console.log(
        `⏱️ Reminder dicek setiap ${REMINDER_CHECK_INTERVAL / 1000} detik.`
    );
    console.log(
        `🎲 Delay pengiriman: +${RANDOM_DELAY_MINUTES}-${RANDOM_DELAY_MAX_MINUTES} menit dari jadwal.`
    );
    console.log(
        `🚦 Rate limiter: minimal ${MESSAGE_MIN_INTERVAL_MS / 1000} detik antar pesan terjadwal.`
    );
    console.log(
        `🔁 Retry terkendali: maksimal ${MAX_SEND_RETRIES} percobaan.`
    );

    scheduleReminderChecker(sock);
    processMessageQueue().catch(error => {
        writeLog('ERROR', 'Queue startup error', error?.message || error);
    });
}

// ========================================
// GROUP LIST - DYNAMIC PER USER
// ========================================
// User hanya melihat grup yang:
// 1. Bot ikuti, DAN
// 2. User tersebut juga menjadi anggota.
// Tidak ada lagi daftar grup global/admin.

function getParticipantIdentityCandidates(participant) {
    if (!participant) return [];

    return [
        participant.id,
        participant.jid,
        participant.phoneNumber,
        participant.lid,
        participant.alt
    ]
        .filter(Boolean)
        .map(value => String(value).trim());
}

function participantMatchesUser(participant, userPhone) {
    const targetPhone = normalizeUserId(userPhone);
    if (!targetPhone) return false;

    return getParticipantIdentityCandidates(participant)
        .some(candidate => normalizeUserId(candidate) === targetPhone);
}

async function getParticipatingGroups(sock) {
    try {
        const groups = await sock.groupFetchAllParticipating();

        return Object.values(groups)
            .map(group => ({
                id: group.id,
                name: group.subject || 'Tanpa nama',
                participants: Array.isArray(group.participants)
                    ? group.participants
                    : []
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
        console.log(
            '❌ Gagal mengambil daftar grup:',
            error.message
        );

        return [];
    }
}

async function getUserParticipatingGroups(sock, userPhone) {
    const allGroups = await getParticipatingGroups(sock);

    const groupsForUser = allGroups
        .filter(group =>
            group.participants.some(participant =>
                participantMatchesUser(participant, userPhone)
            )
        )
        .map(group => ({
            id: group.id,
            name: group.name
        }));

    return {
        allGroups,
        groupsForUser
    };
}

async function sendGroupSelection(sock, privateJid, userPhone) {
    const { allGroups, groupsForUser } =
        await getUserParticipatingGroups(sock, userPhone);

    if (groupsForUser.length === 0) {
        const botHasGroups = allGroups.length > 0;

        await sock.sendMessage(
            privateJid,
            {
                text: botHasGroups
                    ? `❌ *GRUP BELUM DITEMUKAN*\n\nSaya belum menemukan grup yang Anda ikuti dan bot juga menjadi anggota.\n\nSilakan *tambahkan bot ke grup* yang ingin digunakan untuk Scheduler.\n\nSetelah bot masuk ke grup, kirim *Buat jadwal* lagi.`
                    : `❌ *BOT BELUM MEMILIKI GRUP*\n\nBot belum menjadi anggota grup mana pun yang tersedia untuk Scheduler.\n\nSilakan *tambahkan bot ke grup* yang ingin digunakan.\n\nSetelah bot masuk ke grup, kirim *Buat jadwal* lagi.`
            }
        );
        return;
    }

    privateScheduleState.set(
        privateJid,
        {
            step: 'choose-group',
            groups: groupsForUser
        }
    );

    let response = '📋 *PILIH GRUP TUJUAN*\n\n';

    groupsForUser.forEach((group, index) => {
        response += `${index + 1}. ${group.name}\n`;
    });

    response += '\nBalas dengan nomor grup.\nKetik *batal* untuk membatalkan.';

    await sock.sendMessage(
        privateJid,
        {
            text: response
        }
    );
}

function formatPrivateScheduleList(reminders, groupNames = new Map()) {
    let response = '📋 *DAFTAR JADWAL BOT*\n\n';

    reminders.forEach((reminder, index) => {
        const groupName =
            groupNames.get(reminder.chatId) ||
            reminder.chatId;

        response +=
`${index + 1}. *${groupName}*
   ⏰ ${reminder.time}
   🔁 ${recurrenceLabel(reminder)}
   📌 ${reminder.text}

`;
    });

    return response.trim();
}

async function sendPrivateScheduleList(sock, privateJid, showAll = false) {
    const users = loadUsers();
    const phone = getUserPhone(privateJid);
    const admin = isAdmin(users, phone);

    let reminders = loadReminders();

    if (!admin || !showAll) {
        reminders = reminders.filter(reminder =>
            normalizeUserId(reminder.ownerJid) === phone
        );
    }

    if (reminders.length === 0) {
        privateScheduleViews.delete(privateJid);

        await sock.sendMessage(
            privateJid,
            {
                text: showAll && admin
                    ? '📭 Belum ada jadwal di seluruh bot.'
                    : '📭 Belum ada jadwal milik Anda.'
            }
        );

        return;
    }

    const groups = await getParticipatingGroups(sock);
    const groupNames = new Map(
        groups.map(group => [group.id, group.name])
    );

    privateScheduleViews.set(
        privateJid,
        reminders.map(reminder => reminder.id)
    );

    await sock.sendMessage(
        privateJid,
        {
            text:
                formatPrivateScheduleList(reminders, groupNames) +
                '\n\nGunakan *hapus 1* atau *hapus 1,2* untuk menghapus.'
        }
    );
}

async function createReminder(
    sock,
    replyJid,
    targetChatId,
    schedule,
    ownerJid
) {
    const reminders = loadReminders();

    const candidate = buildReminder(
        targetChatId,
        schedule.time,
        schedule.text,
        schedule.recurrence,
        schedule.recurrence === 'weekly'
            ? { daysOfWeek: schedule.daysOfWeek, ownerJid }
            : schedule.recurrence === 'monthly'
                ? { dayOfMonth: schedule.dayOfMonth, ownerJid }
                : { ownerJid }
    );

    if (isDuplicateReminder(reminders, candidate)) {
        await sock.sendMessage(
            replyJid,
            {
                text:
`⚠️ Jadwal tersebut sudah terdaftar.

📌 ${candidate.text}
🔁 ${recurrenceLabel(candidate)}
⏰ ${candidate.time}`
            }
        );

        return false;
    }

    reminders.push(candidate);
    saveReminders(reminders);
    scheduleReminderChecker(sock);

    await sock.sendMessage(
        replyJid,
        {
            text:
`✅ *JADWAL BERHASIL DIBUAT*

📌 ${candidate.text}
🔁 ${recurrenceLabel(candidate)}
⏰ ${candidate.time}

Jadwal akan dikirim otomatis ke grup tujuan.`
        }
    );

    console.log(
        `✅ Jadwal baru: ${candidate.time} - ${candidate.text} → ${candidate.chatId}`
    );

    return true;
}

// ========================================
// PROSES STATE CHAT PRIBADI
// ========================================

async function handlePrivateFlow(sock, jid, text) {
    const state = privateScheduleState.get(jid);

    if (!state) {
        return false;
    }

    if (text.toLowerCase() === 'batal') {
        privateScheduleState.delete(jid);

        await sock.sendMessage(
            jid,
            {
                text: '❌ Proses penjadwalan dibatalkan.'
            }
        );

        return true;
    }

    if (state.step === 'choose-group') {
        const number = Number(text);

        if (
            !Number.isInteger(number) ||
            number < 1 ||
            number > state.groups.length
        ) {
            await sock.sendMessage(
                jid,
                {
                    text: '❌ Nomor grup tidak valid. Balas dengan nomor dari daftar.'
                }
            );

            return true;
        }

        const selectedGroup = state.groups[number - 1];

        state.step = 'enter-schedule';
        state.selectedGroup = selectedGroup;

        privateScheduleState.set(jid, state);

        await sock.sendMessage(
            jid,
            {
                text:
`✅ Grup dipilih: *${selectedGroup.name}*

Sekarang kirim format jadwal, contoh:

*setiap hari 08:00 briefing pagi*
*setiap senin 09:00 cek stok*
*setiap senin,rabu,jumat 09:00 laporan*
*setiap tanggal 8 08:00 laporan bulanan*

Ketik *batal* untuk membatalkan.`
            }
        );

        return true;
    }

    if (state.step === 'enter-schedule') {
        const schedule = parseScheduleText(text);

        if (!schedule) {
            await sock.sendMessage(
                jid,
                {
                    text:
`❌ Format jadwal tidak dikenali.

Contoh:
*setiap hari 08:00 briefing pagi*
*setiap senin 09:00 cek stok*
*setiap senin,rabu,jumat 09:00 laporan*
*setiap tanggal 8 08:00 laporan bulanan*`
                }
            );

            return true;
        }

        if (schedule.error) {
            await sock.sendMessage(
                jid,
                {
                    text: `❌ ${schedule.error}`
                }
            );

            return true;
        }

        const selectedGroup = state.selectedGroup;

        await createReminder(
            sock,
            jid,
            selectedGroup.id,
            schedule,
            jid
        );

        privateScheduleState.delete(jid);

        return true;
    }

    return false;
}


// ========================================
// USER / ADMIN COMMANDS
// ========================================

async function handleAccessCommand(sock, jid, text, senderPhone) {
    const users = loadUsers();
    const phone = getUserPhone(senderPhone || jid);
    const lower = text.toLowerCase().trim();

    // Setup ADMIN hanya boleh dilakukan saat belum ada admin.
    if (!jid.endsWith('@g.us') && users.admins.length === 0 && /^setup\s+\d{6}$/i.test(text.trim())) {
        const code = text.trim().split(/\s+/)[1];

        if (code !== INITIAL_SETUP_CODE) {
            await sock.sendMessage(jid, {
                text: '❌ Kode setup salah.'
            });
            return true;
        }

        users.admins.push({
            jid: String(senderPhone || phone),
            phone: phone,
            aliases: [jid, senderPhone].filter(Boolean),
            name: 'Admin Utama',
            createdAt: new Date().toISOString()
        });
        saveUsers(users);

        await sock.sendMessage(jid, {
            text:
`✅ *ADMIN UTAMA BERHASIL DIBUAT*

Nomor: ${phone}
Role: ADMIN

Sekarang Anda bisa:
• *admin tambah 628xxx Nama*
• *admin hapus 628xxx*
• *admin daftar*
• *jadwal semua*`
        });

        console.log(`🔐 Admin utama dibuat: ${phone}`);
        return true;
    }

    // Command setup dari user biasa setelah admin sudah ada.
    if (/^setup\s+/i.test(text.trim())) {
        await sock.sendMessage(jid, {
            text: '❌ Setup ADMIN sudah ditutup karena ADMIN utama sudah terdaftar.'
        });
        return true;
    }

    if (lower === 'admin daftar' || lower === 'admin users') {
        if (!isAdmin(users, phone)) return false;

        let response = '👥 *DAFTAR PENGGUNA*\n\n';

        response += '*ADMIN:*\n';
        users.admins.forEach((admin, index) => {
            const adminJid = typeof admin === 'string' ? admin : admin.jid;
            const adminName = typeof admin === 'string' ? '' : displayUserName(admin);
            response += `${index + 1}. ${normalizeUserId(adminJid)}${adminName}\n`;
        });

        response += '\n*USER:*\n';

        if (users.users.length === 0) {
            response += 'Belum ada user.\n';
        } else {
            users.users.forEach((user, index) => {
                const userJid = typeof user === 'string' ? user : user.jid;
                response += `${index + 1}. ${normalizeUserId(userJid)}${displayUserName(user)}\n`;
            });
        }

        await sock.sendMessage(jid, { text: response.trim() });
        return true;
    }

    const addMatch = text.trim().match(/^admin\s+tambah\s+(\+?\d{8,15})(?:\s+(.+))?$/i);
    if (addMatch) {
        if (!isAdmin(users, phone)) {
            await sock.sendMessage(jid, {
                text: '❌ Hanya ADMIN yang boleh menambah user.'
            });
            return true;
        }

        const target = addMatch[1];
        const name = (addMatch[2] || '').trim();
        const result = addUser(users, target, name);

        if (!result.ok) {
            await sock.sendMessage(jid, { text: `❌ ${result.error}` });
            return true;
        }

        saveUsers(users);

        await sock.sendMessage(jid, {
            text:
`✅ *USER BERHASIL DITAMBAHKAN*

📱 ${target}${name ? `\n👤 ${name}` : ''}
🔐 Role: USER`
        });

        console.log(`👤 User ditambahkan oleh ${phone}: ${target}`);
        return true;
    }

    const removeMatch = text.trim().match(/^admin\s+hapus\s+(\+?\d{8,15})$/i);
    if (removeMatch) {
        if (!isAdmin(users, phone)) {
            await sock.sendMessage(jid, {
                text: '❌ Hanya ADMIN yang boleh menghapus user.'
            });
            return true;
        }

        const target = removeMatch[1];
        const result = removeUser(users, target);

        if (!result.ok) {
            await sock.sendMessage(jid, { text: `❌ ${result.error}` });
            return true;
        }

        saveUsers(users);

        await sock.sendMessage(jid, {
            text:
`🗑️ *USER BERHASIL DIHAPUS*

📱 ${target}
🔐 Akses Scheduler dicabut.`
        });

        console.log(`🗑️ User dihapus oleh ${phone}: ${target}`);
        return true;
    }

    if (lower === 'admin bantuan') {
        if (!isAdmin(users, phone)) return false;

        await sock.sendMessage(jid, {
            text:
`🔐 *ADMIN MENU*

• *admin tambah 628xxx Nama* → tambah USER
• *admin hapus 628xxx* → hapus USER
• *admin daftar* → lihat ADMIN & USER
• *jadwal* → jadwal milik sendiri
• *jadwal semua* → semua jadwal

USER biasa hanya bisa mengelola jadwal miliknya sendiri.`
        });
        return true;
    }

    return false;
}

async function sendUnauthorizedMessage(sock, jid, inGroup = false) {
    if (inGroup) {
        await sock.sendMessage(jid, {
            text: '❌ Anda belum memiliki akses ke Scheduler. Hubungi ADMIN bot.'
        });
    } else {
        await sock.sendMessage(jid, {
            text:
`❌ *AKSES DITOLAK*

Nomor Anda belum terdaftar sebagai USER.
Hubungi ADMIN bot untuk mendapatkan akses.`
        });
    }
}

// ========================================
// BOT
// ========================================

async function startBot() {
    printAccessControlStatus();

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState('./auth');

    const { version } = await fetchLatestWaWebVersion();

    console.log(
        `WhatsApp Web Version: ${version.join('.')}`
    );

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        markOnlineOnConnect: false
    });

    // ====================================
    // SIMPAN SESSION
    // ====================================

    sock.ev.on('creds.update', saveCreds);

    // ====================================
    // KONEKSI
    // ====================================

    sock.ev.on(
        'connection.update',
        (update) => {
            const {
                connection,
                lastDisconnect,
                qr
            } = update;

            if (qr) {
                console.log(
                    '\n📱 SCAN QR DENGAN WHATSAPP:\n'
                );

                qrcode.generate(qr, { small: true });
            }

            if (connection === 'open') {
                console.log(
                    '\n================================'
                );
                console.log(
                    '✅ BOT BERHASIL TERHUBUNG!'
                );
                console.log(
                    '================================\n'
                );

                startReminderChecker(sock);
            }

            if (connection === 'close') {
                const statusCode =
                    lastDisconnect
                        ?.error
                        ?.output
                        ?.statusCode;

                const shouldReconnect =
                    statusCode !== DisconnectReason.loggedOut;

                if (shouldReconnect) {
                    console.log(
                        '🔄 Koneksi terputus, mencoba kembali...'
                    );

                    startBot();
                } else {
                    console.log(
                        '❌ WhatsApp logout.'
                    );
                }
            }
        }
    );

    // ====================================
    // MENERIMA PESAN
    // ====================================

    sock.ev.on(
        'messages.upsert',
        async ({ messages }) => {
            for (const message of messages) {
                if (!message.message) continue;
                if (message.key.fromMe) continue;

                const jid = message.key.remoteJid;
                if (!jid) continue;

                // Identitas pengirim. WhatsApp sekarang bisa memberikan
                // JID @lid dan JID nomor (@s.whatsapp.net) sekaligus.
                // Selalu prioritaskan JID nomor agar role ADMIN/USER stabil.
                const identityCandidates = jid.endsWith('@g.us')
                    ? [
                        message.key.participantPn,
                        message.key.participant,
                        message.key.participantAlt
                    ]
                    : [
                        jid,
                        message.key.remoteJidAlt
                    ];

                const senderRaw =
                    identityCandidates.find(value =>
                        String(value || '').includes('@s.whatsapp.net')
                    ) ||
                    identityCandidates.find(Boolean) ||
                    '';

                const senderPhone = getUserPhone(senderRaw);
                console.log(`👤 Identity: jid=${jid} | raw=${senderRaw} | phone=${senderPhone} | alt=${message.key.remoteJidAlt || '-'} | participant=${message.key.participant || '-'}`);
                const identityAliases = [
                    jid,
                    senderRaw,
                    message.key.remoteJidAlt,
                    message.key.participantPn,
                    message.key.participantAlt,
                    message.key.participant
                ].filter(Boolean);

                // =================================
                // DETEKSI TAG / MENTION BOT
                // =================================

                const extended =
                    message.message?.extendedTextMessage;

                const contextInfo =
                    extended?.contextInfo;

                const mentionedJids =
                    contextInfo?.mentionedJid || [];

                const botIds = [];

                if (sock.user?.id) {
                    botIds.push(
                        sock.user.id
                            .split(':')[0]
                            .split('@')[0]
                    );
                }

                if (sock.user?.lid) {
                    botIds.push(
                        sock.user.lid
                            .split(':')[0]
                            .split('@')[0]
                    );
                }

                const normalizeJid = (value) => {
                    if (!value) return '';

                    return value
                        .split(':')[0]
                        .split('@')[0]
                        .replace(/\D/g, '');
                };

                const botWasMentioned =
                    mentionedJids.some(mentionedJid => {
                        const mentioned =
                            normalizeJid(mentionedJid);

                        return botIds.some(
                            botId =>
                                normalizeJid(botId) === mentioned
                        );
                    });

                // Grup tetap hanya diproses jika bot di-tag.
                if (
                    jid.endsWith('@g.us') &&
                    !botWasMentioned
                ) {
                    continue;
                }

                let text =
                    message.message?.conversation ||
                    message.message?.extendedTextMessage?.text ||
                    '';

                text = text.trim();

                if (!text) continue;

                console.log(
                    `📩 Pesan masuk: ${text}`
                );

                // Hapus mention bot dari teks.
                if (botWasMentioned) {
                    text = text
                        .replace(/@[^\s]+/g, '')
                        .trim();
                }

                // =================================
                // ACCESS CONTROL
                // =================================

                let users = loadUsers();

                // Jika ADMIN lama tersimpan menggunakan @lid, migrasikan
                // otomatis ke nomor telepon canonical yang diterima sekarang.
                migrateLegacyAdminIdentity(users, senderPhone, identityAliases);
                users = loadUsers();

                const accessCommandHandled =
                    await handleAccessCommand(sock, jid, text, senderPhone);

                if (accessCommandHandled) continue;

                users = loadUsers();
                const authorized = isAuthorized(users, senderPhone, identityAliases);

                if (!authorized) {
                    await sendUnauthorizedMessage(
                        sock,
                        jid,
                        jid.endsWith('@g.us')
                    );
                    continue;
                }

                const senderJid = senderPhone;

                // =================================
                // CHAT PRIBADI: PENJADWALAN BARU
                // =================================

                if (!jid.endsWith('@g.us')) {
                    const handledByFlow =
                        await handlePrivateFlow(
                            sock,
                            jid,
                            text
                        );

                    if (handledByFlow) continue;

                    const lowerText = text.toLowerCase();

                    if (
                        lowerText === 'buat jadwal' ||
                        lowerText === 'buat' ||
                        lowerText === 'jadwal baru'
                    ) {
                        await sendGroupSelection(sock, jid, senderPhone);
                        continue;
                    }

                    if (
                        lowerText === 'jadwal semua'
                    ) {
                        if (!isAdmin(users, senderPhone)) {
                            await sock.sendMessage(jid, {
                                text: '❌ Hanya ADMIN yang boleh melihat semua jadwal.'
                            });
                        } else {
                            await sendPrivateScheduleList(sock, jid, true);
                        }
                        continue;
                    }

                    if (
                        lowerText === 'jadwal' ||
                        lowerText === 'lihat jadwal'
                    ) {
                        await sendPrivateScheduleList(sock, jid, false);
                        continue;
                    }

                    const privateDelete =
                        text.match(/^hapus\s+(.+)$/i);

                    if (privateDelete) {
                        const target = privateDelete[1].trim();

                        if (target.toLowerCase() === 'semua') {
                            const reminders = loadReminders();
                            const admin = isAdmin(users, senderPhone);
                            const ownedReminders = admin
                                ? reminders
                                : reminders.filter(reminder =>
                                    normalizeUserId(reminder.ownerJid) === senderPhone
                                );

                            if (ownedReminders.length === 0) {
                                await sock.sendMessage(
                                    jid,
                                    {
                                        text: admin
                                            ? '📭 Belum ada jadwal untuk dihapus.'
                                            : '📭 Anda belum memiliki jadwal untuk dihapus.'
                                    }
                                );
                                continue;
                            }

                            const deleteIds = new Set(
                                ownedReminders.map(reminder => reminder.id)
                            );

                            const remaining = reminders.filter(
                                reminder => !deleteIds.has(reminder.id)
                            );

                            saveReminders(remaining);
                            privateScheduleViews.delete(jid);
                            scheduleReminderChecker(sock);

                            await sock.sendMessage(
                                jid,
                                {
                                    text:
`🗑️ *SEMUA JADWAL ${admin ? 'DI BOT' : 'MILIK ANDA'} DIHAPUS*

Total: ${ownedReminders.length} jadwal`
                                }
                            );

                            continue;
                        }

                        const viewIds =
                            privateScheduleViews.get(jid) || [];

                        const numbers = target
                            .split(',')
                            .map(value => Number(value.trim()) - 1)
                            .filter(Number.isInteger);

                        if (
                            viewIds.length === 0 ||
                            numbers.length === 0
                        ) {
                            await sock.sendMessage(
                                jid,
                                {
                                    text:
`❌ Belum ada daftar jadwal yang aktif.

Ketik *jadwal* terlebih dahulu, lalu *hapus 1* atau *hapus 1,2*.`
                                }
                            );
                            continue;
                        }

                        const uniqueIndexes = [...new Set(numbers)];

                        if (
                            uniqueIndexes.some(
                                index =>
                                    index < 0 ||
                                    index >= viewIds.length
                            )
                        ) {
                            await sock.sendMessage(
                                jid,
                                {
                                    text: '❌ Nomor jadwal tidak ditemukan. Ketik *jadwal* untuk memperbarui daftar.'
                                }
                            );
                            continue;
                        }

                        const deletedIds = new Set(
                            uniqueIndexes.map(
                                index => viewIds[index]
                            )
                        );

                        const reminders = loadReminders();
                        const deletedReminders = reminders.filter(
                            reminder => deletedIds.has(reminder.id)
                        );

                        if (deletedReminders.length === 0) {
                            await sock.sendMessage(
                                jid,
                                {
                                    text: '⚠️ Jadwal tersebut sudah tidak tersedia. Ketik *jadwal* untuk memperbarui daftar.'
                                }
                            );
                            continue;
                        }

                        const remaining = reminders.filter(
                            reminder => !deletedIds.has(reminder.id)
                        );

                        saveReminders(remaining);
                        privateScheduleViews.delete(jid);
                        scheduleReminderChecker(sock);

                        let response =
                            '🗑️ *JADWAL DIHAPUS*\n\n';

                        deletedReminders.forEach(reminder => {
                            response +=
`📌 ${reminder.text}
🔁 ${recurrenceLabel(reminder)}
⏰ ${reminder.time}

`;
                        });

                        await sock.sendMessage(
                            jid,
                            {
                                text: response.trim()
                            }
                        );

                        continue;
                    }

                    if (lowerText === 'halo') {
                        await sock.sendMessage(
                            jid,
                            {
                                text:
                                    '👋 Halo! Bot Scheduler aktif.\n\nKetik *buat jadwal* untuk membuat jadwal ke grup.'
                            }
                        );
                        continue;
                    }

                    await sock.sendMessage(
                        jid,
                        {
                            text:
`🤖 *BOT SCHEDULER*

Perintah:

• *buat jadwal* → pilih grup lalu buat jadwal
• *jadwal* → lihat jadwal milik sendiri
• *jadwal semua* → lihat semua jadwal (ADMIN)
• *hapus 1* → hapus jadwal nomor 1
• *hapus 1,2* → hapus beberapa jadwal
• *hapus semua* → hapus semua jadwal

Untuk membatalkan proses: *batal*`
                        }
                    );

                    continue;
                }

                // =================================
                // GRUP: FITUR LAMA TETAP ADA
                // =================================

                if (text.toLowerCase().includes('halo')) {
                    await sock.sendMessage(
                        jid,
                        {
                            text:
                                '👋 Halo! Bot Scheduler aktif.'
                        }
                    );
                    continue;
                }

                const schedule = parseScheduleText(text);

                if (schedule) {
                    if (schedule.error) {
                        await sock.sendMessage(
                            jid,
                            {
                                text:
                                    `❌ ${schedule.error}`
                            }
                        );
                        continue;
                    }

                    await createReminder(
                        sock,
                        jid,
                        jid,
                        schedule,
                        senderJid
                    );

                    continue;
                }

                // =================================
                // LIHAT / HAPUS JADWAL DI GRUP
                // =================================

                if (text.toLowerCase() === 'jadwal' || text.toLowerCase() === 'jadwal semua') {
                    const admin = isAdmin(users, senderPhone);
                    const showAll = text.toLowerCase() === 'jadwal semua';

                    if (showAll && !admin) {
                        await sock.sendMessage(jid, {
                            text: '❌ Hanya ADMIN yang boleh melihat semua jadwal.'
                        });
                        continue;
                    }

                    const reminders = loadReminders()
                        .filter(reminder =>
                            reminder.chatId === jid &&
                            (showAll || normalizeUserId(reminder.ownerJid) === senderPhone)
                        );

                    if (reminders.length === 0) {
                        await sock.sendMessage(
                            jid,
                            {
                                text:
                                    '📭 Belum ada reminder.'
                            }
                        );
                        continue;
                    }

                    let response =
                        '📋 *DAFTAR JADWAL*\n\n';

                    reminders.forEach((reminder, index) => {
                        response +=
`${index + 1}. ⏰ ${reminder.time}
   🔁 ${recurrenceLabel(reminder)}
   📌 ${reminder.text}

`;
                    });

                    await sock.sendMessage(
                        jid,
                        {
                            text: response.trim()
                        }
                    );

                    continue;
                }

                const deleteCommand =
                    text.match(/^hapus\s+(.+)$/i);

                if (deleteCommand) {
                    const target = deleteCommand[1].trim();
                    const reminders = loadReminders();
                    const admin = isAdmin(users, senderPhone);
                    const chatReminders = reminders.filter(
                        reminder =>
                            reminder.chatId === jid &&
                            (admin || normalizeUserId(reminder.ownerJid) === senderPhone)
                    );

                    if (target.toLowerCase() === 'semua') {
                        if (chatReminders.length === 0) {
                            await sock.sendMessage(
                                jid,
                                {
                                    text:
                                        '📭 Tidak ada reminder untuk dihapus.'
                                }
                            );
                            continue;
                        }

                        const remaining = reminders.filter(
                            reminder => reminder.chatId !== jid
                        );

                        saveReminders(remaining);
                        scheduleReminderChecker(sock);

                        await sock.sendMessage(
                            jid,
                            {
                                text:
`🗑️ *SEMUA JADWAL DIHAPUS*

Total: ${chatReminders.length} jadwal`
                            }
                        );

                        continue;
                    }

                    const numbers = target
                        .split(',')
                        .map(value => Number(value.trim()) - 1)
                        .filter(Number.isInteger);

                    if (numbers.length === 0) {
                        await sock.sendMessage(
                            jid,
                            {
                                text:
`❌ Format tidak valid.

Contoh:
@bot hapus 1
@bot hapus 1,2,3
@bot hapus semua`
                            }
                        );
                        continue;
                    }

                    const uniqueIndexes = [...new Set(numbers)];

                    if (
                        uniqueIndexes.some(
                            index =>
                                index < 0 ||
                                index >= chatReminders.length
                        )
                    ) {
                        await sock.sendMessage(
                            jid,
                            {
                                text:
`❌ Nomor jadwal tidak ditemukan.

Ketik:
@bot jadwal

untuk melihat daftar jadwal.`
                            }
                        );
                        continue;
                    }

                    const deletedReminders = uniqueIndexes.map(
                        index => chatReminders[index]
                    );

                    const deletedIds = new Set(
                        deletedReminders.map(reminder => reminder.id)
                    );

                    const remaining = reminders.filter(
                        reminder => !deletedIds.has(reminder.id)
                    );

                    saveReminders(remaining);
                    scheduleReminderChecker(sock);

                    let response =
                        '🗑️ *JADWAL DIHAPUS*\n\n';

                    deletedReminders.forEach(reminder => {
                        response +=
`📌 ${reminder.text}
🔁 ${recurrenceLabel(reminder)}
⏰ ${reminder.time}

`;
                    });

                    await sock.sendMessage(
                        jid,
                        {
                            text: response.trim()
                        }
                    );

                    continue;
                }
            }
        }
    );
}

// ========================================
// START BOT
// ========================================

startBot();
