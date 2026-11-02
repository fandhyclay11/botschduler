import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestWaWebVersion
} from '@whiskeysockets/baileys';

import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'fs';

// ========================================
// FASE C — modul tambahan, tidak menyentuh
// scheduler/queue/reliability existing.
// ========================================
import * as phaseC from './phaseC/index.js';
import * as phaseD from './phaseD/index.js';
import {
    applyReminderScheduleEdit,
    canQueueDelivery,
    isWithinScheduleGrace,
    shouldReplaceQueueTimer
} from './scheduler-edit.js';
import {
    SCHEDULE_PAGE_SIZE,
    getPageSlice,
    buildPaginationFooter,
    parsePageArgument
} from './pagination.js';
import {
    COMMAND_CATALOG,
    buildMenuMessage,
    isMenuTrigger,
    parseMenuArgument
} from './menu.js';

// ========================================
// PENGAMAN PROSES
// ========================================
// Node 15+ MENGHENTIKAN proses ketika ada unhandledRejection. Baileys
// menerbitkan banyak promise asynchronous (reconnect, kirim pesan, update
// kredensial). Satu rejection yang tidak tertangani — misalnya karena
// `startBot()` dipanggil ulang dari handler `connection: close` tanpa
// `await`/`.catch` — dapat mematikan proses secara diam-diam. Setelah itu
// autostart hanya efektif jika pengawas (Task Scheduler / layanan)
// me-restart proses; jika tidak, scheduler tidak jalan sampai pagi.
//
// Kita cegah proses mati dengan mencatat error dan tetap melanjutkan.
// Semua kesalahan tetap terekam di scheduler.log untuk analisis.
process.on('unhandledRejection', (reason) => {
    try {
        const message = reason instanceof Error
            ? (reason.stack || reason.message)
            : String(reason);
        logProcessError('unhandledRejection', message);
    } catch { /* best effort */ }
});

process.on('uncaughtException', (error) => {
    try {
        const message = error instanceof Error
            ? (error.stack || error.message)
            : String(error);
        logProcessError('uncaughtException', message);
    } catch { /* best effort */ }
});

function logProcessError(kind, message) {
    const line = `[${new Date().toISOString()}] [${kind}] ${message}\n`;
    try {
        fs.appendFileSync('./scheduler.log', line);
    } catch { /* ignore */ }
    try {
        console.error(line);
    } catch { /* ignore */ }
}

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
    atomicWriteJson(USER_FILE, users);
}

// Tulis JSON secara atomik: tulis ke file temporer, lalu rename ke tujuan.
// Mencegah file produksi menjadi 0 byte / terpotong ketika proses mati
// di tengah penulisan (crash, kill, atau kehabisan daya). loadReminders()
// yang gagal parse akan mengembalikan [] dan membuat seluruh jadwal
// "hilang" tanpa jejak, jadi atomic write adalah pencegahan utama.
function atomicWriteJson(targetPath, data) {
    const payload = JSON.stringify(data, null, 2);
    const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, payload);
    try {
        fs.renameSync(tmp, targetPath);
    } catch (error) {
        // Jika rename gagal (mis. file target terkunci sesaat di Windows),
        // bersihkan tmp agar tidak menumpuk, lalu lempar ulang supaya
        // pemanggil tahu tulisan gagal.
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw error;
    }
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
                atomicWriteJson(REMINDER_FILE, data);
            }
        }

        return data;
    } catch (error) {
        // Catat kegagalan parse ke scheduler.log supaya tidak hilang
        // bersama console. Mengembalikan [] berarti seluruh jadwal
        // terlihat hilang; itu konsekuensi serius, jadi laporan harus
        // tegas dan dapat ditelusuri.
        try {
            fs.appendFileSync(
                './scheduler.log',
                `[${new Date().toISOString()}] [ERROR] loadReminders gagal parse: ${error?.message || error}\n`
            );
        } catch { /* ignore */ }
        console.log('⚠️ Gagal membaca reminders.json');
        return [];
    }
}

function saveReminders(reminders) {
    atomicWriteJson(REMINDER_FILE, reminders);
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

    if (recurrence === 'once') {
        return String(reminder.date || '') === getTodayParts().today;
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

    // SEKALI (one-shot): sekali YYYY-MM-DD HH:MM teks
    let match = input.match(
        /^sekali\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s+([\s\S]+)$/i
    );

    if (match) {
        const time = parseTime(match[2], match[3]);
        if (!time) return { error: 'Format waktu tidak valid.' };
        const date = match[1];
        const parsed = new Date(`${date}T00:00:00Z`);
        if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
            return { error: 'Tanggal tidak valid. Gunakan YYYY-MM-DD.' };
        }
        return { recurrence: 'once', date, time, text: match[4].trim() };
    }

    // SETIAP HARI
    match = input.match(
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
// Jendela retry total untuk kegagalan sementara: 24 jam sejak waktu
// jadwal yang semestinya kirim. Setelah batas ini terlampaui, satu
// occurrence (reminderId + tanggal) ditandai KEDALUWARSA dan tidak
// dicoba lagi otomatis — mencegah bot "mengejar" pesan basi berhari-hari.
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
// Backoff bertahap untuk kegagalan sementara. Interval diperpanjang
// perlahan sampai ~15 menit, kemudian ditahan di 15 menit sampai
// `giveUpAt`. Nilai sengaja kecil di awal supaya kalau koneksi WA
// baru saja goyang, retry berikutnya cepat; nilai akhir cukup lebar
// supaya kalau penyebabnya rate-limit / server down, tidak membanjiri.
const RETRY_BACKOFF_MS = [
    15_000,   // 15 detik
    30_000,   // 30 detik
    60_000,   // 1 menit
    2 * 60_000,
    5 * 60_000,
    10 * 60_000,
    15 * 60_000
];
const LOG_FILE = './scheduler.log';
const EXPIRED_DELIVERY_FILE = './expired-deliveries.json';

const messageQueue = [];
const queuedDeliveryKeys = new Set();
const sendingDeliveryKeys = new Set();
const lateScheduleSkipKeys = new Set();
// Kumpulan `deliveryKey` yang sudah dinyatakan kedaluwarsa (> 24 jam
// sejak waktu jadwal). Dimuat dari EXPIRED_DELIVERY_FILE saat startup
// agar restart tidak membangkitkan ulang occurrence basi.
const expiredDeliveryKeys = new Set();
let queueTimer = null;
let queueTimerAt = null;
let queueWorkerRunning = false;
let lastScheduledMessageSentAt = 0;

// --- Error classification -------------------------------------------
// Kegagalan sementara (transient) berhak dicoba kembali dalam jendela
// 24 jam. Kegagalan permanen BUKAN kandidat retry: percuma mencoba
// kalau bot ditendang dari grup atau pesan tujuan sudah dihapus.
// Daftar pola dipilih berdasarkan error yang pernah ditulis Baileys
// ke scheduler.log kami (misal "Connection Closed", "forbidden",
// "not-authorized", "item-not-found"). Jika pola tidak dikenal,
// perlakukan sebagai transient (konservatif — kita lebih memilih
// mencoba ulang daripada menjatuhkan pesan).
const PERMANENT_ERROR_PATTERNS = [
    /forbidden/i,
    /not-authorized/i,
    /item-not-found/i,
    /recipient-not-in-group/i,
    /blocked/i,
    /not-acceptable/i,
    /jid-malformed/i
];

function classifyDeliveryError(error) {
    const message = String(error?.message || error || '').trim();
    if (!message) return { kind: 'transient', reason: 'unknown' };
    for (const pattern of PERMANENT_ERROR_PATTERNS) {
        if (pattern.test(message)) {
            return { kind: 'permanent', reason: message };
        }
    }
    return { kind: 'transient', reason: message };
}

function nextRetryDelayMs(attempt) {
    const idx = Math.min(Math.max(attempt - 1, 0), RETRY_BACKOFF_MS.length - 1);
    return RETRY_BACKOFF_MS[idx];
}

// Hitung batas akhir "boleh retry" untuk satu reminder occurrence.
// Mengacu pada `scheduledAt` persisten supaya restart tetap benar;
// jika tidak ada, pakai sekarang + 24h sebagai fallback aman.
function computeGiveUpAt(reminder) {
    const base = reminder?.scheduledAt
        ? new Date(reminder.scheduledAt).getTime()
        : Date.now();
    if (!Number.isFinite(base)) return Date.now() + RETRY_WINDOW_MS;
    return base + RETRY_WINDOW_MS;
}

function loadExpiredDeliveryKeys() {
    try {
        if (!fs.existsSync(EXPIRED_DELIVERY_FILE)) return;
        const data = JSON.parse(fs.readFileSync(EXPIRED_DELIVERY_FILE, 'utf8'));
        if (!Array.isArray(data)) return;
        for (const key of data) {
            if (typeof key === 'string' && key.length > 0) {
                expiredDeliveryKeys.add(key);
            }
        }
    } catch (error) {
        try {
            fs.appendFileSync(
                LOG_FILE,
                `[${new Date().toISOString()}] [WARN] expired-deliveries.json gagal dibaca: ${error?.message || error}\n`
            );
        } catch { /* ignore */ }
    }
}

function persistExpiredDeliveryKeys() {
    try {
        atomicWriteJson(EXPIRED_DELIVERY_FILE, Array.from(expiredDeliveryKeys));
    } catch (error) {
        try {
            fs.appendFileSync(
                LOG_FILE,
                `[${new Date().toISOString()}] [WARN] expired-deliveries.json gagal ditulis: ${error?.message || error}\n`
            );
        } catch { /* ignore */ }
    }
}

function markDeliveryExpired(deliveryKey) {
    if (!deliveryKey) return;
    if (expiredDeliveryKeys.has(deliveryKey)) return;
    expiredDeliveryKeys.add(deliveryKey);
    persistExpiredDeliveryKeys();
}

// Reset occurrence saat ini supaya tidak membawa jejak retry basi.
// Dipanggil ketika suatu pengiriman dilabeli kedaluwarsa / gagal
// permanen — field pending/retry dibersihkan tetapi `lastSent` yang
// nyata (jika ada) dibiarkan.
function markReminderOccurrenceFailed(reminder, kind, reason) {
    reminder.lastDeliveryError = {
        kind,
        reason: String(reason || '').slice(0, 500),
        at: new Date().toISOString(),
        date: reminder.pendingDate || null,
        deliveryId: reminder.deliveryId || null
    };
    clearPendingDelivery(reminder);
}

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
    (r) => `${r.text}\n🔁 ${recurrenceLabel(r)}\n⏰ ${r.time}\n\nJangan lupa dikerjakan! 💪`,
    (r) => `${r.text}\n⏰ ${r.time}\n🔁 ${recurrenceLabel(r)}\n\nSemangat, jangan sampai terlewat! 💪`,
    (r) => `${r.text}\n⏰ ${r.time}\n\nWaktunya mengerjakan jadwal hari ini.`,
    (r) => `${r.text}\n🔁 ${recurrenceLabel(r)}\n\nSilakan dikerjakan. 👍`,
    (r) => `${r.text}\n\n⏰ ${r.time}\n🔁 ${recurrenceLabel(r)}\n\nMohon ditindaklanjuti.`,
    (r) => `${r.text}\n⏰ ${r.time}\n\nJangan sampai terlewat. 👍`
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

    const scheduleDate = reminder.recurrence === 'once' && reminder.date
        ? reminder.date
        : date;
    const target = new Date(`${scheduleDate}T${reminder.time}:00`);
    if (Number.isNaN(target.getTime())) return null;

    return target;
}

function preparePendingDelivery(reminder, today) {
    if (reminder.pendingDate === today && reminder.sendAt) {
        return true;
    }

    // Bersihkan sisa state dari hari sebelumnya. Jika bot mati di hari
    // kemarin sesudah menyiapkan delivery (pendingDate=yesterday,
    // retryAfter=yesterday+15s atau +24h), state itu akan menghalangi
    // persiapan ulang hari ini:
    //   - `reminder.retryAfter` dari hari kemarin masih dicek di
    //     runReminderCheck() dan membuat jadwal diam seharian.
    //   - `reminder.pendingDate=yesterday` tidak dibuang di tempat lain,
    //     sehingga sisa `deliveryId` lama akan dipakai untuk logging
    //     dan membingungkan audit.
    // Reset ini aman: lastSent tetap, jadi anti-duplikat harian masih
    // bekerja.
    if (reminder.pendingDate && reminder.pendingDate !== today) {
        clearPendingDelivery(reminder);
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

    // Jadwal yang sudah lewat jendela 24 jam dicatat sebagai kedaluwarsa
    // dan TIDAK boleh masuk antrean lagi (termasuk setelah restart).
    if (expiredDeliveryKeys.has(deliveryKey)) return false;

    if (!canQueueDelivery(
        deliveryKey,
        queuedDeliveryKeys,
        sendingDeliveryKeys,
        reminder.lastSent,
        today
    )) return false;

    const originalSendAt = new Date(reminder.sendAt).getTime();
    if (!Number.isFinite(originalSendAt)) return false;

    let sendAt = originalSendAt;

    if (reminder.retryAfter) {
        const retryAfter = new Date(reminder.retryAfter).getTime();
        if (Number.isFinite(retryAfter)) {
            // Hormati delay retry: `sendAt` dipakai sebagai jadwal
            // efektif, dan `processMessageQueue` akan menunda worker
            // sampai Math.max(sendAt, lastSent+MIN_INTERVAL) tiba.
            sendAt = Math.max(sendAt, retryAfter);
        }
    }

    // Jangan antrekan kalau waktu kirim efektif sudah melewati jendela
    // 24 jam dari waktu jadwal — tandai kedaluwarsa di sini juga.
    const giveUpAt = computeGiveUpAt(reminder);
    if (sendAt > giveUpAt) {
        markDeliveryExpired(deliveryKey);
        writeLog('EXPIRE', `Occurrence kedaluwarsa saat enqueue: ${reminder.deliveryId || reminder.id}`,
            `jadwal=${reminder.scheduledAt || '-'}, batas=${new Date(giveUpAt).toISOString()}`);
        return false;
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
    const requestedAt = Date.now() + Math.max(0, delay);
    if (queueTimer && !shouldReplaceQueueTimer(queueTimerAt, requestedAt)) return;
    if (queueTimer) clearTimeout(queueTimer);

    queueTimer = setTimeout(async () => {
        queueTimer = null;
        queueTimerAt = null;
        await processMessageQueue();
    }, Math.max(0, requestedAt - Date.now()));
    queueTimerAt = requestedAt;
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

        // ==== FASE C hook: catat pengiriman task untuk mapping reaction ====
        try {
            phaseC.recordTaskDelivery({
                reminderId: reminder.id,
                date: item.date,
                messageId: result.key.id,
                chatId: reminder.chatId,
                text: reminder.text
            });
        } catch (e) {
            writeLog('WARN', 'phaseC.recordTaskDelivery gagal', e?.message || e);
        }

        writeLog(
            'SUCCESS',
            `Terkirim ${reminder.lastDeliveryId}`,
            `messageId=${result.key.id}`
        );
    } catch (error) {
        // Klasifikasikan error:
        //   - permanent → tidak masuk akal retry (bot ditendang, dll).
        //     Tandai occurrence hari ini sebagai gagal, lanjut hari lain
        //     (edit/pindah grup oleh admin yang akan memulihkannya).
        //   - transient → coba ulang dengan backoff bertahap sampai
        //     batas 24 jam dari `scheduledAt` tercapai.
        const classification = classifyDeliveryError(error);
        const attempt = Number(reminder.retryCount || 0) + 1;
        reminder.retryCount = attempt;

        if (classification.kind === 'permanent') {
            // Permanen: jangan antrekan ulang. Tetap simpan audit error.
            markDeliveryExpired(item.deliveryKey);
            markReminderOccurrenceFailed(reminder, 'permanent', classification.reason);
            try { saveReminders(reminders); } catch { /* ignore */ }
            writeLog(
                'ERROR',
                `Gagal permanen ${item.deliveryKey}`,
                `attempt=${attempt}, error=${classification.reason}`
            );
            return;
        }

        // Transient: hitung kapan retry berikutnya, tetapi tidak melebihi
        // batas 24 jam dari `scheduledAt`.
        const giveUpAt = computeGiveUpAt(reminder);
        const nowMs = Date.now();
        if (nowMs >= giveUpAt) {
            markDeliveryExpired(item.deliveryKey);
            markReminderOccurrenceFailed(reminder, 'expired', classification.reason);
            try { saveReminders(reminders); } catch { /* ignore */ }
            writeLog(
                'EXPIRE',
                `Occurrence melewati jendela 24 jam: ${item.deliveryKey}`,
                `attempt=${attempt}, error=${classification.reason}`
            );
            return;
        }

        const delay = nextRetryDelayMs(attempt);
        const retryAt = Math.min(nowMs + delay, giveUpAt);
        reminder.retryAfter = new Date(retryAt).toISOString();
        // sendAt dipindah ke jadwal retry agar enqueue berikutnya tidak
        // dieksekusi lebih awal.
        reminder.sendAt = reminder.retryAfter;
        reminder.lastDeliveryError = {
            kind: 'transient',
            reason: String(classification.reason || '').slice(0, 500),
            at: new Date().toISOString(),
            attempt
        };

        try { saveReminders(reminders); } catch { /* ignore */ }

        writeLog(
            'RETRY',
            `Gagal ${reminder.deliveryId || item.deliveryKey}`,
            `attempt=${attempt}, retry=${reminder.retryAfter}, giveUpAt=${new Date(giveUpAt).toISOString()}, error=${classification.reason}`
        );

        // Antrekan ulang dengan sendAt baru.
        enqueueReminder(reminder, item.date);
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
        const skipKey = buildDeliveryKey(reminder, today);

        // Guard 24 jam: kalau sudah lewat batas, tandai kedaluwarsa
        // sekali dan hentikan proses untuk occurrence ini.
        const occurrenceAgeMs = now.getTime() - scheduledAt.getTime();
        if (!wasPending && occurrenceAgeMs > RETRY_WINDOW_MS) {
            if (!expiredDeliveryKeys.has(skipKey)) {
                markDeliveryExpired(skipKey);
                writeLog(
                    'EXPIRE',
                    `Occurrence >24 jam, tidak dikirim ulang: ${reminder.id}`,
                    `jadwal=${reminder.time}, usia=${Math.round(occurrenceAgeMs / 60_000)} menit`
                );
            }
            continue;
        }

        // Di dalam jendela 24 jam tapi di luar grace 2 menit:
        //   - Jadwal yang sudah "pending" (sendAt sudah ditetapkan) tetap
        //     dijalankan — queue worker yang mengatur waktunya.
        //   - Jadwal yang BELUM pending dan baru ditemukan saat recovery
        //     restart sekarang DIANGKAT jadi pending supaya tetap dikirim
        //     dalam 24 jam, dengan sendAt = sekarang + delay acak kecil
        //     agar tidak membanjiri grup langsung setelah bot menyala.
        //   - lateScheduleSkipKeys dibiarkan untuk logging historis, tetapi
        //     tidak lagi memblokir queue.
        const outsideGrace = !isWithinScheduleGrace(
            scheduledAt, now, REMINDER_GRACE_MINUTES * 60 * 1000
        );
        if (!wasPending && outsideGrace) {
            if (!lateScheduleSkipKeys.has(skipKey)) {
                lateScheduleSkipKeys.add(skipKey);
                writeLog(
                    'LATE',
                    `Jadwal lewat grace, akan diantrekan ulang: ${reminder.id}`,
                    `jadwal=${reminder.time}, usia=${Math.round(occurrenceAgeMs / 60_000)} menit`
                );
            }
            // Siapkan pending delivery untuk recovery: sendAt = sekarang
            // + jitter pendek supaya pemulihan massal pasca-restart tidak
            // membanjiri grup tujuan.
            const recoverySendAt = new Date(now.getTime() + getRandomDelayMs());
            reminder.pendingDate = today;
            reminder.scheduledAt = scheduledAt.toISOString();
            reminder.sendAt = recoverySendAt.toISOString();
            reminder.deliveryId = generateDeliveryId(reminder.id, today);
            reminder.retryCount = 0;
            delete reminder.retryAfter;
            changed = true;
        } else if (!preparePendingDelivery(reminder, today)) {
            continue;
        } else if (!wasPending) {
            changed = true;
        }

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

function formatPrivateScheduleList(slice, groupNames = new Map()) {
    let response = '📋 *DAFTAR JADWAL BOT*\n\n';

    slice.items.forEach((reminder, offset) => {
        // Nomor yang ditampilkan adalah nomor GLOBAL (1..total), bukan
        // 1..pageSize. Dengan demikian `edit N` / `hapus N` tetap merujuk
        // ke jadwal yang sama meskipun pengguna berpindah halaman.
        const humanNumber = slice.startIndex + offset + 1;
        const groupName =
            groupNames.get(reminder.chatId) ||
            reminder.chatId;

        response +=
`${humanNumber}. *${groupName}*
   ⏰ ${reminder.time}
   🔁 ${recurrenceLabel(reminder)}
   📌 ${reminder.text}

`;
    });

    return response.trim();
}

async function sendPrivateScheduleList(sock, privateJid, showAll = false, page = 1) {
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

    const slice = getPageSlice(reminders, page, SCHEDULE_PAGE_SIZE);
    const listCommand = showAll && admin ? 'jadwal semua' : 'jadwal';
    const footer = buildPaginationFooter(slice, listCommand);

    // Simpan `ids` LENGKAP (bukan hanya halaman) agar `edit N` dan
    // `hapus N` menggunakan index global yang konsisten lintas halaman.
    privateScheduleViews.set(
        privateJid,
        reminders.map(reminder => reminder.id)
    );

    const parts = [formatPrivateScheduleList(slice, groupNames)];
    if (footer) parts.push(footer);
    parts.push('Gunakan *edit 1* untuk mengubah, atau *hapus 1* / *hapus 1,2* untuk menghapus.');

    await sock.sendMessage(
        privateJid,
        { text: parts.join('\n\n') }
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
                : schedule.recurrence === 'once'
                    ? { date: schedule.date, ownerJid }
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
// FASE C — helper penunjang integrasi
// (tidak mengubah fungsi baseline di atas)
// ========================================

// View map untuk perintah "hapus tugas N" di chat pribadi.
const phaseCTaskViews = new Map();

function findLatestReminderMatching({ chatId, time, text }) {
    const reminders = loadReminders();
    const normalizedTarget = normalizeText(text).toLowerCase();
    const matching = reminders.filter(r =>
        r.chatId === chatId &&
        r.time === time &&
        normalizeText(r.text).toLowerCase() === normalizedTarget
    );
    if (matching.length === 0) return null;
    return matching.reduce((a, b) => (Number(a.id) > Number(b.id) ? a : b));
}

async function getChatNameMap(sock) {
    const map = new Map();
    try {
        const groups = await sock.groupFetchAllParticipating();
        for (const g of Object.values(groups)) {
            map.set(g.id, g.subject || 'Tanpa nama');
        }
    } catch (e) {
        // biarkan kosong; caller sudah fallback ke chatId
    }
    return map;
}

async function getDisplayNameForCanonical(sock, canonicalId, groupId, rawCandidates = []) {
    // Coba dari participant grup dulu (paling akurat).
    try {
        if (groupId && groupId.endsWith('@g.us')) {
            const meta = await sock.groupMetadata(groupId);
            const participants = Array.isArray(meta.participants) ? meta.participants : [];

            // Set semua raw candidate (jid string) yang mungkin cocok participant.id
            const rawSet = new Set((rawCandidates || []).map(v => String(v).trim()).filter(Boolean));

            for (const p of participants) {
                // Cocokkan via canonical normalized
                const cand = [p.id, p.jid, p.phoneNumber, p.lid, p.alt]
                    .filter(Boolean)
                    .map(v => normalizeUserId(v));
                if (cand.includes(canonicalId)) {
                    return p.notify || p.name || '';
                }
                // Cocokkan via raw jid string (kalau participant.id disimpan sbg @lid)
                const rawIds = [p.id, p.jid, p.lid, p.alt].filter(Boolean).map(String);
                if (rawIds.some(r => rawSet.has(r))) {
                    return p.notify || p.name || '';
                }
            }
        }
    } catch (e) {
        // ignore
    }
    return '';
}

function buildPhaseCCtx(sock) {
    return {
        sock,
        // helpers baseline (di-inject, tidak diduplikasi)
        normalizeUserId,
        isAdmin,
        loadUsers,
        loadReminders,
        saveReminders,
        scheduleReminderChecker,
        parseScheduleText,
        recurrenceLabel,
        getParticipatingGroups,
        getUserParticipatingGroups,
        sendGroupSelection,
        createReminder,
        // helpers khusus Fase C
        findLatestReminder: findLatestReminderMatching,
        getChatNameMap,
        getDisplayName: (canonicalId, groupId, rawCandidates) =>
            getDisplayNameForCanonical(sock, canonicalId, groupId, rawCandidates),
        setPhaseCTaskView: (jid, ids) => phaseCTaskViews.set(jid, ids),
        getPhaseCTaskView: (jid) => phaseCTaskViews.get(jid),
        clearPhaseCTaskView: (jid) => phaseCTaskViews.delete(jid)
    };
}

// Fase D context — superset dari phaseC ctx + saveUsers + phaseC handlers
// yang dipanggil oleh router.js
function buildPhaseDCtx(sock) {
    const c = buildPhaseCCtx(sock);
    return {
        ...c,
        saveUsers: (users) => {
            fs.writeFileSync(USER_FILE, JSON.stringify(users, null, 2));
        },
        sendPrivateScheduleList,
        phaseC: {
            listTasks: phaseC.phaseCCommands.listTasks,
            showPoints: phaseC.phaseCCommands.showPoints,
            listReportGroupsCmd: phaseC.phaseCCommands.listReportGroupsCmd,
            listReportTimesCmd: phaseC.phaseCCommands.listReportTimesCmd,
            sendHelp: phaseC.phaseCCommands.sendHelp,
            markAsTask: phaseC.phaseCTasks.markAsTask,
            sendReportsNow: phaseC.phaseCReports.sendReportsNow,
            addReportTime: phaseC.phaseCReportConfig.addReportTime
        }
    };
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

    if (state.step === 'edit-schedule') {
        const schedule = parseScheduleText(text);
        if (!schedule || schedule.error) {
            await sock.sendMessage(jid, { text: schedule?.error || '❌ Format jadwal tidak dikenali. Gunakan format yang sama seperti saat membuat jadwal.' });
            return true;
        }
        state.pendingSchedule = schedule;
        state.step = 'confirm-edit';
        privateScheduleState.set(jid, state);
        const preview = { ...state.originalReminder, ...schedule };
        await sock.sendMessage(jid, { text:
`Perubahan jadwal:

📌 ${state.originalReminder.text} → ${schedule.text}
🔁 ${recurrenceLabel(state.originalReminder)} → ${recurrenceLabel(preview)}
⏰ ${state.originalReminder.time} → ${schedule.time}${schedule.date ? `\n📅 ${state.originalReminder.date || ''} → ${schedule.date}` : ''}

Ketik *ya* untuk menyimpan atau *batal* untuk membatalkan.` });
        return true;
    }

    if (state.step === 'confirm-edit') {
        if (!['ya', 'y', 'iya', 'konfirmasi'].includes(text.trim().toLowerCase())) {
            await sock.sendMessage(jid, { text: 'Ketik *ya* untuk menyimpan atau *batal* untuk membatalkan.' });
            return true;
        }
        const reminders = loadReminders();
        const reminder = reminders.find(item => String(item.id) === String(state.reminderId) && normalizeUserId(item.ownerJid) === getUserPhone(jid));
        if (!reminder) {
            privateScheduleState.delete(jid);
            await sock.sendMessage(jid, { text: '⚠️ Jadwal tersebut sudah tidak ditemukan.' });
            return true;
        }
        const { today } = getTodayParts();
        if (sendingDeliveryKeys.has(buildDeliveryKey(reminder, today))) {
            privateScheduleState.delete(jid);
            await sock.sendMessage(jid, { text: '⚠️ Jadwal sedang dikirim dan tidak dapat diedit saat ini.' });
            return true;
        }
        privateScheduleState.delete(jid);
        const schedule = state.pendingSchedule;
        const removedQueuedDeliveries = applyReminderScheduleEdit(
            reminder, schedule, messageQueue, queuedDeliveryKeys
        );
        if (removedQueuedDeliveries > 0 && queueTimer) {
            clearTimeout(queueTimer);
            queueTimer = null;
            queueTimerAt = null;
            if (messageQueue.length > 0) scheduleQueueWorker();
        }
        // Race-protection: antara `loadReminders()` di atas dan
        // `saveReminders` di bawah, worker queue bisa saja menyelesaikan
        // pengiriman untuk `reminder` yang sama (worker memuat reminders
        // sendiri dan menulis `lastSent` + `lastMessageId`).
        // Jika kita menulis `reminders` yang kita baca lebih dulu, kolom
        // audit itu akan terhapus — dan guard anti-duplikat harian hilang.
        // Baca ulang file setelah edit lalu merge: pertahankan hasil
        // kirim terbaru, timpa field jadwal dari hasil edit kita.
        try {
            const latest = loadReminders();
            const current = latest.find(item => String(item.id) === String(reminder.id));
            if (current && (current.lastSent || current.lastMessageId)) {
                for (const key of ['lastSent', 'lastSentAt', 'lastMessageId',
                    'lastDeliveryId', 'lastScheduledAt', 'lastActualDelayMs']) {
                    if (current[key] !== undefined) reminder[key] = current[key];
                }
                // Index di `reminders` memakai id yang sama, jadi
                // reminder di array sudah ter-update by reference.
            }
        } catch (mergeError) {
            writeLog(
                'WARN',
                'merge edit dengan pengiriman konkuren gagal',
                mergeError?.message || mergeError
            );
        }
        saveReminders(reminders);

        // Edit = occurrence baru untuk hari ini. Bersihkan status "sudah
        // dilewati"/"kedaluwarsa" milik jadwal yang SAMA agar guard lama
        // tidak memblokir pengiriman versi hasil edit.
        const editedKey = buildDeliveryKey(reminder, today);
        if (lateScheduleSkipKeys.has(editedKey)) {
            lateScheduleSkipKeys.delete(editedKey);
        }
        if (expiredDeliveryKeys.has(editedKey)) {
            expiredDeliveryKeys.delete(editedKey);
            persistExpiredDeliveryKeys();
        }

        scheduleReminderChecker(sock);

        // Evaluasi SEGERA, bukan menunggu tick 5 detik berikutnya. Ini
        // memastikan edit yang jatuh tepat di dalam grace window tetap
        // diproses sebelum jendela habis, dan edit yang waktunya sudah
        // lewat tetap diangkat ke antrean retry 24 jam (lihat
        // runReminderCheck).
        let editedScheduledAt = null;
        try {
            editedScheduledAt = getScheduledDateTime(reminder, today);
        } catch { /* ignore */ }

        const editNow = getTodayParts().now;
        const lateEditBeyondWindow = editedScheduledAt &&
            editNow.getTime() - editedScheduledAt.getTime() > RETRY_WINDOW_MS;

        if (!lateEditBeyondWindow) {
            try {
                await runReminderCheck(sock);
            } catch (checkError) {
                writeLog(
                    'WARN',
                    'runReminderCheck setelah edit gagal',
                    checkError?.message || checkError
                );
            }
        }

        const todayNote = lateEditBeyondWindow
            ? `\n\n⚠️ Waktu *${reminder.time}* untuk hari ini sudah lewat lebih dari 24 jam, jadi tidak akan dikirim hari ini. Jadwal tetap aktif untuk periode berikutnya.`
            : '';

        await sock.sendMessage(jid, { text: `✅ Jadwal berhasil diperbarui.\n\n📌 ${reminder.text}\n🔁 ${recurrenceLabel(reminder)}\n⏰ ${reminder.time}${todayNote}` });
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

    // Muat daftar occurrence yang sudah dinyatakan kedaluwarsa supaya
    // reminder yang terlewat >24 jam tidak dibangkitkan ulang hanya
    // karena bot direstart.
    loadExpiredDeliveryKeys();

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

                // Koneksi stabil kembali: reset hitungan backoff.
                globalThis.__WA_RECONNECT_ATTEMPTS__ = 0;

                startReminderChecker(sock);
                try {
                    phaseC.startTaskReminderScheduler(sock, () => ({ reminders: loadReminders() }));
                    console.log('🔔 Pengingat tugas: scheduler aktif.');
                } catch (e) {
                    writeLog('ERROR', 'task reminder scheduler gagal start', e?.message || e);
                }

                // ==== FASE C: start report scheduler (loop kecil independen) ====
                try {
                    phaseC.startReportScheduler(buildPhaseCCtx(sock));
                    console.log('📊 Fase C: report scheduler aktif.');
                } catch (e) {
                    writeLog('ERROR', 'phaseC report scheduler gagal start', e?.message || e);
                }
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

                    // Bersihkan state scheduler milik koneksi lama supaya
                    // tidak dua timer berjalan bersamaan setelah reconnect.
                    // Semua state ini akan dibangun ulang oleh event
                    // `connection: open` berikutnya.
                    try {
                        if (reminderTimer) {
                            clearTimeout(reminderTimer);
                            reminderTimer = null;
                        }
                        if (queueTimer) {
                            clearTimeout(queueTimer);
                            queueTimer = null;
                            queueTimerAt = null;
                        }
                        // queueWorkerRunning dibiarkan apa adanya: jika
                        // worker sedang `await sock.sendMessage(...)` dan
                        // socket lama tiba-tiba close, worker akan masuk
                        // catch & retry, lalu `finally` membersihkan
                        // sendingDeliveryKeys. Me-reset `true -> false`
                        // bisa menyebabkan dua worker paralel.
                        phaseC.stopReportScheduler(sock);
                        phaseC.stopTaskReminderScheduler();
                    } catch (cleanupError) {
                        writeLog(
                            'WARN',
                            'cleanup scheduler saat reconnect gagal',
                            cleanupError?.message || cleanupError
                        );
                    }

                    // Jadwalkan reconnect dengan backoff eksponensial
                    // sederhana (maks 60s) supaya jaringan goyang tidak
                    // memicu loop reconnect berfrekuensi tinggi.
                    const attempt = Math.min(
                        globalThis.__WA_RECONNECT_ATTEMPTS__ = (globalThis.__WA_RECONNECT_ATTEMPTS__ || 0) + 1,
                        6
                    );
                    const delayMs = Math.min(60_000, 500 * 2 ** attempt);
                    setTimeout(() => {
                        startBot().catch(error => {
                            writeLog(
                                'ERROR',
                                'startBot gagal setelah reconnect',
                                error?.message || error
                            );
                        });
                    }, delayMs);
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
                    // === FASE C: flow tugas mengalir lebih dulu ===
                    const phaseCCtx = buildPhaseCCtx(sock);
                    if (phaseC.hasPhaseCFlow(jid)) {
                        const consumed = await phaseC.tryHandlePhaseCFlow(
                            phaseCCtx, jid, text, senderPhone
                        );
                        if (consumed) continue;
                    }

                    // === FASE D: pilihan grup dari Natural Language ===
                    // Jika bot sedang menunggu nomor grup, angka diproses sebagai
                    // pilihan menu, bukan command/AI.
                    if (typeof phaseD.hasPendingGroupChoice === 'function' &&
                        phaseD.hasPendingGroupChoice(jid)) {
                        const dCtx = buildPhaseDCtx(sock);
                        const res = await phaseD.handlePendingGroupChoice(
                            dCtx, jid, senderPhone, text
                        );
                        if (res.handled) continue;
                    }

                    // Flow command asli selalu mendapat prioritas sebelum AI.
                    const handledByFlow =
                        await handlePrivateFlow(
                            sock,
                            jid,
                            text
                        );

                    if (handledByFlow) continue;

                    const lowerText = text.toLowerCase();

                    const editCommand = text.trim().match(/^edit\s+(\d+)$/i);
                    if (editCommand) {
                        const viewIds = privateScheduleViews.get(jid) || [];
                        const index = Number(editCommand[1]) - 1;
                        if (index < 0 || index >= viewIds.length) {
                            await sock.sendMessage(jid, { text: '❌ Nomor jadwal tidak ditemukan. Ketik *jadwal* untuk melihat daftar terbaru.' });
                            continue;
                        }
                        const reminder = loadReminders().find(item => String(item.id) === String(viewIds[index]) && normalizeUserId(item.ownerJid) === getUserPhone(jid));
                        if (!reminder) {
                            await sock.sendMessage(jid, { text: '⚠️ Jadwal tersebut sudah tidak ditemukan. Ketik *jadwal* untuk memperbarui daftar.' });
                            continue;
                        }
                        privateScheduleState.set(jid, { step: 'edit-schedule', reminderId: reminder.id, originalReminder: { ...reminder } });
                        await sock.sendMessage(jid, { text: 'Kirim isi pesan dan waktu baru dalam satu input dengan format jadwal yang sama.\nContoh: *setiap hari 08:00 briefing pagi*\n\nKetik *batal* untuk membatalkan.' });
                        continue;
                    }

                    // === Menu bantuan (menu / help / bantuan [page]) ===
                    // Daftar perintah difilter sesuai peran pengguna, dengan
                    // paginasi 20 perintah per halaman.
                    if (isMenuTrigger(text)) {
                        const parsed = parseMenuArgument(text);
                        const page = (parsed && parsed.page) || 1;
                        const menuMsg = buildMenuMessage(COMMAND_CATALOG, {
                            isAdmin: isAdmin(users, senderPhone),
                            isAuthorized: isAuthorized(users, senderPhone, identityAliases),
                            hasAdmin: users.admins.length > 0,
                            aiEnabled: Boolean(phaseD.getAIConfig?.().enabled),
                            scope: 'private'
                        }, page);
                        await sock.sendMessage(jid, { text: menuMsg.text });
                        continue;
                    }

                    if (
                        lowerText === 'buat jadwal' ||
                        lowerText === 'buat' ||
                        lowerText === 'jadwal baru'
                    ) {
                        // === FASE C: tawarkan Jadwal Biasa / Jadikan Tugas ===
                        await phaseC.offerTypeChoice(phaseCCtx, jid);
                        continue;
                    }

                    // === FASE C: perintah tambahan (tugas/poin/laporan) ===
                    const phaseCHandled = await phaseC.tryHandlePhaseCCommand(
                        phaseCCtx, jid, text, senderPhone
                    );
                    if (phaseCHandled) continue;

                    // === FASE D: command khusus AI (ping / status) ===
                    const lowerD = text.toLowerCase().trim();
                    if (lowerD === 'ai ping' || lowerD === 'ai status') {
                        const desc = phaseD.describeConfig();
                        await sock.sendMessage(jid, { text: `🤖 AI config: ${desc}\n⏳ testing...` });
                        const r = await phaseD.pingAI();
                        await sock.sendMessage(jid, {
                            text: r.ok
                                ? `✅ AI OK. Reply: "${(r.text || '').slice(0, 60)}"`
                                : `❌ AI gagal: ${r.reason || 'unknown'}`
                        });
                        continue;
                    }

                    // === FASE D: pending confirmation (dari intent low-confidence) ===
                    if (phaseD.hasPendingConfirm(jid)) {
                        const dCtx = buildPhaseDCtx(sock);
                        const res = await phaseD.handlePendingConfirm(dCtx, jid, senderPhone, text);
                        if (res.handled) continue;
                        // else: konfirmasi expired → lanjut ke NL classifier
                    }

                    // === FASE D: Natural Language intent classifier ===
                    // Hanya coba kalau AI enabled, teks non-command yg kelihatan
                    // seperti kalimat (mengandung spasi & bukan cuma angka).
                    const aiCfg = phaseD.getAIConfig();
                    const normalizedPrivateCommand = text.trim().toLowerCase();
                    const deterministicPrivateCommand =
                        normalizedPrivateCommand === 'buat jadwal' ||
                        normalizedPrivateCommand === 'buat' ||
                        normalizedPrivateCommand === 'jadwal baru' ||
                        /^(?:lihat\s+)?jadwal(?:\s+\d+)?$/i.test(normalizedPrivateCommand) ||
                        /^edit\s+\d+$/i.test(normalizedPrivateCommand) ||
                        /^jadwal\s+semua(?:\s+\d+)?$/i.test(normalizedPrivateCommand) ||
                        normalizedPrivateCommand === 'tugas' ||
                        normalizedPrivateCommand === 'laporan' ||
                        normalizedPrivateCommand === 'ai ping' ||
                        normalizedPrivateCommand === 'ai status' ||
                        normalizedPrivateCommand === 'batal' ||
                        /^(menu|help|bantuan)(?:\s+\d+)?$/i.test(normalizedPrivateCommand) ||
                        /^hapus\s+(semua|\d+(?:\s*,\s*\d+)*)$/i.test(normalizedPrivateCommand) ||
                        /^hapus\s+tugas\s+(semua|\d+(?:\s*,\s*\d+)*)$/i.test(normalizedPrivateCommand);

                    const looksLikeNL =
                        aiCfg.enabled &&
                        !deterministicPrivateCommand &&
                        /\s/.test(text) &&
                        !/^\d+([,\s]\d+)*$/.test(text.trim());
                    if (looksLikeNL) {
                        try {
                            const intent = await phaseD.classifyIntent(text);
                            if (intent && intent.intent !== 'unknown') {
                                const dCtx = buildPhaseDCtx(sock);
                                const dispatch = await phaseD.dispatchIntent(dCtx, jid, senderPhone, intent, text);
                                if (dispatch.handled) continue;
                            }
                        } catch (e) {
                            writeLog('WARN', 'phaseD NL classify gagal', e?.message || e);
                        }
                        // Kalau AI gagal / intent unknown → fall-through ke help baseline
                    }

                    const jadwalSemuaMatch = lowerText.match(/^jadwal\s+semua(?:\s+(\d+))?$/);
                    if (jadwalSemuaMatch) {
                        if (!isAdmin(users, senderPhone)) {
                            await sock.sendMessage(jid, {
                                text: '❌ Hanya ADMIN yang boleh melihat semua jadwal.'
                            });
                        } else {
                            const page = parsePageArgument(jadwalSemuaMatch[1]) || 1;
                            await sendPrivateScheduleList(sock, jid, true, page);
                        }
                        continue;
                    }

                    const jadwalListMatch = lowerText.match(/^(?:lihat\s+)?jadwal(?:\s+(\d+))?$/);
                    if (jadwalListMatch) {
                        const page = parsePageArgument(jadwalListMatch[1]) || 1;
                        await sendPrivateScheduleList(sock, jid, false, page);
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

Perintah utama:

• *buat jadwal* → pilih grup lalu buat jadwal
• *jadwal* → lihat jadwal milik sendiri (20 per halaman)
• *jadwal 2* → lihat halaman ke-2 bila jadwal >20
• *edit 1* → edit jadwal nomor 1 dari daftar *jadwal*
• *hapus 1* / *hapus 1,2* / *hapus semua*

Ketik *menu* untuk daftar lengkap perintah sesuai akses Anda.
Untuk membatalkan proses: *batal*`
                        }
                    );

                    continue;
                }

                // =================================
                // GRUP: FITUR LAMA TETAP ADA
                // =================================

                // Menu bantuan di grup juga, dengan filter peran yang sama.
                if (isMenuTrigger(text)) {
                    const parsed = parseMenuArgument(text);
                    const page = (parsed && parsed.page) || 1;
                    const menuMsg = buildMenuMessage(COMMAND_CATALOG, {
                        isAdmin: isAdmin(users, senderPhone),
                        isAuthorized: isAuthorized(users, senderPhone, identityAliases),
                        hasAdmin: users.admins.length > 0,
                        aiEnabled: Boolean(phaseD.getAIConfig?.().enabled),
                        scope: 'group'
                    }, page);
                    await sock.sendMessage(jid, { text: menuMsg.text });
                    continue;
                }

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

                const groupScheduleMatch = text.toLowerCase().match(/^jadwal(?:\s+semua)?(?:\s+(\d+))?$/);
                if (groupScheduleMatch) {
                    const admin = isAdmin(users, senderPhone);
                    const showAll = /\bsemua\b/.test(text.toLowerCase());

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

                    const page = parsePageArgument(groupScheduleMatch[1]) || 1;
                    const slice = getPageSlice(reminders, page, SCHEDULE_PAGE_SIZE);
                    const listCommand = showAll ? 'jadwal semua' : 'jadwal';
                    const footer = buildPaginationFooter(slice, listCommand);

                    let response =
                        '📋 *DAFTAR JADWAL*\n\n';

                    slice.items.forEach((reminder, offset) => {
                        const humanNumber = slice.startIndex + offset + 1;
                        response +=
`${humanNumber}. ⏰ ${reminder.time}
   🔁 ${recurrenceLabel(reminder)}
   📌 ${reminder.text}

`;
                    });

                    const body = response.trim();
                    const outText = footer ? `${body}\n\n${footer}` : body;

                    await sock.sendMessage(
                        jid,
                        {
                            text: outText
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

    // ====================================
    // DIAGNOSTIK ACK / RECEIPT (T3 — Opsi A)
    // ====================================
    // Scheduler kita hanya mencatat `[SUCCESS]` saat `sock.sendMessage()`
    // resolve dengan `key.id`. Itu HANYA bukti bahwa stanza berhasil
    // dititipkan ke WebSocket (lihat relayMessage → sendNode →
    // sendRawMessage di Baileys). Bukan bukti server menerima, apalagi
    // bukti peer menerima.
    //
    // Status asli pesan datang asinkron lewat dua event:
    //   - 'messages.update' → status enum WAMessageStatus (dari
    //       proto.WebMessageInfo.Status):
    //         0 ERROR  — stanza ditolak server
    //         1 PENDING — belum diakui server
    //         2 SERVER_ACK — server menerima
    //         3 DELIVERY_ACK — minimal satu peer menerima (1-to-1) /
    //                         distribusi grup diterima server
    //         4 READ — peer membaca
    //         5 PLAYED — media diputar
    //   - 'message-receipt.update' → receipt per-peer untuk pesan grup
    //
    // Kita hanya MEN-LOG event ini (tidak memengaruhi queue/retry/scheduler).
    // Tujuannya memberi bukti objektif saat investigasi "pesan tidak sampai"
    // sambil mempertahankan kontrak scheduler yang sudah stabil.
    sock.ev.on('messages.update', (updates) => {
        if (!Array.isArray(updates)) return;
        for (const u of updates) {
            try {
                const st = u.update?.status;
                const stub = u.update?.messageStubType;
                // Kita hanya tertarik ke event yang membawa informasi ack
                // atau penolakan. Update kosong (mis. editan metadata lain)
                // di-skip supaya log tidak berisik.
                if (st === undefined && stub === undefined) continue;
                writeLog(
                    'ACK',
                    `status=${st ?? '-'} stub=${stub ?? '-'}`,
                    `messageId=${u.key?.id || '-'} chat=${u.key?.remoteJid || '-'} fromMe=${u.key?.fromMe ?? '-'}`
                );
            } catch (error) {
                // Jangan biarkan exception di observer merusak koneksi.
                try {
                    writeLog('WARN', 'messages.update listener error',
                        error?.message || error);
                } catch { /* ignore */ }
            }
        }
    });

    sock.ev.on('message-receipt.update', (receipts) => {
        if (!Array.isArray(receipts)) return;
        for (const r of receipts) {
            try {
                // Baileys mengirim objek per peer. Jenis receipt dideduksi
                // dari field timestamp yang ada: read > played > deliv.
                let type = 'deliv';
                if (r.receipt?.readTimestamp) type = 'read';
                else if (r.receipt?.playedTimestamp) type = 'play';
                writeLog(
                    'RECEIPT',
                    `type=${type}`,
                    `messageId=${r.key?.id || '-'} chat=${r.key?.remoteJid || '-'} from=${r.receipt?.userJid || '-'}`
                );
            } catch (error) {
                try {
                    writeLog('WARN', 'message-receipt.update listener error',
                        error?.message || error);
                } catch { /* ignore */ }
            }
        }
    });

    // ====================================
    // FASE C — REACTION LISTENER
    // ====================================
    // Baileys mengirim reaction via event 'messages.reaction'.
    // Beberapa versi juga mengirim ulang lewat 'messages.upsert' dengan
    // message.reactionMessage — kita amankan keduanya.

    sock.ev.on('messages.reaction', async (reactions) => {
        const list = Array.isArray(reactions) ? reactions : [reactions];
        for (const r of list) {
            try {
                await phaseC.handleReactionEvent(buildPhaseCCtx(sock), r);
            } catch (error) {
                writeLog('ERROR', 'phaseC reaction handler gagal',
                    error?.message || error);
            }
        }
    });

    // Fallback: kalau reaction datang via upsert.reactionMessage,
    // tetap salurkan ke handler yang sama.
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const m of messages) {
            if (!m?.message?.reactionMessage) continue;
            try {
                await phaseC.handleReactionEvent(buildPhaseCCtx(sock), m);
            } catch (error) {
                writeLog('ERROR', 'phaseC reaction fallback gagal',
                    error?.message || error);
            }
        }
    });
}

// ========================================
// START BOT
// ========================================

startBot().catch(error => {
    // Jika startup gagal (mis. auth corrupt, versi WA Web gagal
    // di-fetch), catat ke scheduler.log sebelum proses mati supaya
    // ada jejak untuk diagnosa saat autostart me-restart.
    try {
        logProcessError('startBot-bootstrap', error?.stack || error?.message || String(error));
    } catch { /* ignore */ }
    throw error;
});
