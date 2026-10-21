// Katalog perintah bot + builder tampilan menu bantuan.
//
// Satu sumber kebenaran untuk daftar perintah yang DAPAT dieksekusi bot.
// Perintah yang hanya dipicu lewat natural language (AI intent) dan tidak
// punya trigger teks eksplisit tidak dimasukkan — agar help tidak
// menyesatkan pengguna.
//
// Setiap entri memiliki:
//   - command : contoh perintah yang diketik user (string pendek)
//   - description : fungsi singkat
//   - group : kategori ('Jadwal', 'Tugas', 'Laporan', 'Admin', 'AI', 'Umum')
//   - scope : 'private' | 'group' | 'both'
//   - role : 'public' | 'user' | 'admin' | 'ai' | 'setup'
//
// Filter akses:
//   - 'public' selalu tampil.
//   - 'user' hanya untuk pengguna yang sudah authorized (USER/ADMIN).
//   - 'admin' hanya untuk ADMIN.
//   - 'ai' hanya ketika konfigurasi AI aktif.
//   - 'setup' hanya ketika belum ada ADMIN terdaftar.

import {
    SCHEDULE_PAGE_SIZE,
    getPageSlice,
    buildPaginationFooter,
    parsePageArgument
} from './pagination.js';

export const MENU_PAGE_SIZE = SCHEDULE_PAGE_SIZE; // 20

// Satu sumber kebenaran — jaga sinkron dengan handler teks di index.js
// dan phaseC/commands.js.
export const COMMAND_CATALOG = [
    // --- Jadwal (umum, dipakai USER & ADMIN) ---
    { command: 'buat jadwal', description: 'mulai alur buat jadwal (pilih grup lalu format jadwal)', group: 'Jadwal', scope: 'private', role: 'user' },
    { command: 'jadwal', description: 'lihat daftar jadwal milik sendiri (20 per halaman)', group: 'Jadwal', scope: 'private', role: 'user' },
    { command: 'jadwal 2', description: 'buka halaman ke-2 daftar jadwal (ganti angka sesuai halaman)', group: 'Jadwal', scope: 'private', role: 'user' },
    { command: 'edit 1', description: 'edit jadwal nomor 1 dari daftar jadwal', group: 'Jadwal', scope: 'private', role: 'user' },
    { command: 'hapus 1', description: 'hapus jadwal nomor 1 dari daftar', group: 'Jadwal', scope: 'both', role: 'user' },
    { command: 'hapus 1,2', description: 'hapus beberapa jadwal sekaligus', group: 'Jadwal', scope: 'both', role: 'user' },
    { command: 'hapus semua', description: 'hapus semua jadwal milik sendiri', group: 'Jadwal', scope: 'both', role: 'user' },
    { command: 'batal', description: 'batalkan proses yang sedang berjalan', group: 'Jadwal', scope: 'private', role: 'user' },

    // --- Jadwal di grup (bot harus di-tag) ---
    { command: '@bot jadwal', description: 'lihat daftar jadwal di grup ini', group: 'Jadwal', scope: 'group', role: 'user' },
    { command: '@bot setiap hari HH:MM teks', description: 'buat jadwal harian langsung di grup', group: 'Jadwal', scope: 'group', role: 'user' },

    // --- Tugas (Fase C) ---
    { command: 'tugas', description: 'lihat daftar tugas milik sendiri', group: 'Tugas', scope: 'private', role: 'user' },
    { command: 'hapus tugas 1', description: 'hapus tugas nomor 1 (poin yang sudah didapat tetap)', group: 'Tugas', scope: 'private', role: 'user' },
    { command: 'hapus tugas 1,2', description: 'hapus beberapa tugas sekaligus', group: 'Tugas', scope: 'private', role: 'user' },
    { command: 'poin', description: 'lihat snapshot poin bulan berjalan (top 20)', group: 'Tugas', scope: 'private', role: 'user' },

    // --- Admin: pengguna ---
    { command: 'admin daftar', description: 'lihat daftar ADMIN & USER', group: 'Admin', scope: 'private', role: 'admin' },
    { command: 'admin tambah 628xxx Nama', description: 'tambah USER baru', group: 'Admin', scope: 'private', role: 'admin' },
    { command: 'admin hapus 628xxx', description: 'hapus USER', group: 'Admin', scope: 'private', role: 'admin' },
    { command: 'admin bantuan', description: 'tampilkan menu ADMIN', group: 'Admin', scope: 'private', role: 'admin' },

    // --- Admin: jadwal/tugas semua ---
    { command: 'jadwal semua', description: 'lihat semua jadwal di bot', group: 'Admin', scope: 'both', role: 'admin' },
    { command: 'jadwal semua 2', description: 'buka halaman ke-2 daftar jadwal semua', group: 'Admin', scope: 'both', role: 'admin' },
    { command: 'tugas semua', description: 'lihat semua tugas seluruh USER', group: 'Admin', scope: 'private', role: 'admin' },

    // --- Admin: poin ---
    { command: 'poin kurang 628xxx 10', description: 'kurangi 10 poin dari seorang user', group: 'Admin', scope: 'private', role: 'admin' },

    // --- Admin: laporan ---
    { command: 'laporan grup pilih', description: 'tampilkan daftar grup bot untuk dipilih sebagai grup laporan', group: 'Laporan', scope: 'private', role: 'admin' },
    { command: 'laporan grup daftar', description: 'lihat grup laporan aktif', group: 'Laporan', scope: 'private', role: 'admin' },
    { command: 'laporan grup tambah <nomor|groupId>', description: 'tambah grup laporan (pakai nomor dari pilih atau groupId lengkap)', group: 'Laporan', scope: 'private', role: 'admin' },
    { command: 'laporan grup hapus <nomor|groupId>', description: 'hapus grup laporan', group: 'Laporan', scope: 'private', role: 'admin' },
    { command: 'laporan jam daftar', description: 'lihat jam-jam laporan aktif', group: 'Laporan', scope: 'private', role: 'admin' },
    { command: 'laporan jam tambah HH:MM', description: 'tambah jam laporan otomatis', group: 'Laporan', scope: 'private', role: 'admin' },
    { command: 'laporan jam hapus HH:MM', description: 'hapus jam laporan', group: 'Laporan', scope: 'private', role: 'admin' },
    { command: 'laporan kirim', description: 'kirim laporan ke semua grup laporan sekarang (test manual)', group: 'Laporan', scope: 'private', role: 'admin' },

    // --- AI (hanya saat AI config enabled) ---
    { command: 'ai status', description: 'tampilkan konfigurasi AI (tanpa kredensial)', group: 'AI', scope: 'private', role: 'ai' },
    { command: 'ai ping', description: 'tes koneksi ke endpoint AI', group: 'AI', scope: 'private', role: 'ai' },

    // --- Setup awal (hanya saat belum ada ADMIN) ---
    { command: 'setup <6 digit kode>', description: 'daftarkan ADMIN utama dengan kode yang dicetak bot di terminal', group: 'Umum', scope: 'private', role: 'setup' },

    // --- Umum ---
    { command: 'menu', description: 'tampilkan menu bantuan ini', group: 'Umum', scope: 'both', role: 'public' },
    { command: 'halo', description: 'sapa bot', group: 'Umum', scope: 'both', role: 'public' }
];

// Trigger teks yang dianggap sebagai permintaan menu/help.
export const MENU_TRIGGERS = ['menu', 'help', 'bantuan'];

export function isMenuTrigger(text) {
    const trimmed = String(text || '').trim().toLowerCase();
    if (!trimmed) return false;
    // "menu", "help", "bantuan", "menu 2", "help 3", "bantuan 1"
    const match = trimmed.match(/^(menu|help|bantuan)(?:\s+(\d+))?$/);
    return Boolean(match);
}

export function parseMenuArgument(text) {
    const trimmed = String(text || '').trim().toLowerCase();
    const match = trimmed.match(/^(menu|help|bantuan)(?:\s+(\d+))?$/);
    if (!match) return null;
    return {
        trigger: match[1],
        page: parsePageArgument(match[2])
    };
}

// Filter katalog berdasarkan akses pengguna.
//
// Opsi:
//   isAdmin        : bool  → user adalah ADMIN
//   isAuthorized   : bool  → user terdaftar sebagai USER atau ADMIN
//   hasAdmin       : bool  → bot sudah memiliki ADMIN utama
//   aiEnabled      : bool  → config AI aktif
//   scope          : 'private' | 'group'
export function filterCommandsForUser(catalog, options) {
    const {
        isAdmin = false,
        isAuthorized = false,
        hasAdmin = true,
        aiEnabled = false,
        scope = 'private'
    } = options || {};

    return catalog.filter(entry => {
        // scope: 'both' selalu lolos, selain itu harus sama
        if (entry.scope !== 'both' && entry.scope !== scope) return false;

        switch (entry.role) {
            case 'public':
                return true;
            case 'setup':
                // Setup hanya ditampilkan saat belum ada ADMIN dan hanya di chat pribadi.
                return !hasAdmin && (entry.scope === 'both' || entry.scope === 'private');
            case 'user':
                return isAuthorized;
            case 'admin':
                return isAdmin;
            case 'ai':
                return aiEnabled && isAuthorized;
            default:
                return false;
        }
    });
}

// Bangun teks menu untuk satu halaman.
//
// Return { text, page, totalPages, totalItems }.
// Jika totalItems === 0, hanya header + hint "tidak ada perintah" dikirim.
export function buildMenuMessage(catalog, options = {}, page = 1) {
    const commands = filterCommandsForUser(catalog, options);
    const slice = getPageSlice(commands, page, MENU_PAGE_SIZE);

    const roleLabel = options.isAdmin
        ? 'ADMIN'
        : options.isAuthorized
            ? 'USER'
            : (!options.hasAdmin ? 'SETUP' : 'TAMU');

    const headerLines = ['📖 *MENU BANTUAN BOT SCHEDULER*', `Peran: ${roleLabel}`];
    if (slice.totalItems > 0) {
        headerLines.push(`Perintah tersedia: ${slice.totalItems}`);
    }
    const header = headerLines.join('\n');

    if (slice.totalItems === 0) {
        return {
            text: `${header}\n\n_Tidak ada perintah yang tersedia untuk peran Anda saat ini._`,
            page: 1,
            totalPages: 1,
            totalItems: 0
        };
    }

    // Kelompokkan item di halaman ini berdasarkan `group`,
    // tetap mempertahankan urutan definisi dalam katalog.
    const groupsOrder = [];
    const byGroup = new Map();
    for (const entry of slice.items) {
        if (!byGroup.has(entry.group)) {
            byGroup.set(entry.group, []);
            groupsOrder.push(entry.group);
        }
        byGroup.get(entry.group).push(entry);
    }

    const body = groupsOrder.map(groupName => {
        const lines = byGroup.get(groupName)
            .map(e => `• *${e.command}* — ${e.description}`)
            .join('\n');
        return `*${groupName}:*\n${lines}`;
    }).join('\n\n');

    const footer = buildPaginationFooter(slice, 'menu', 'perintah');
    const parts = [header, body];
    if (footer) parts.push(footer);

    return {
        text: parts.join('\n\n'),
        page: slice.page,
        totalPages: slice.totalPages,
        totalItems: slice.totalItems
    };
}
