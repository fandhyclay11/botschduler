import test from 'node:test';
import assert from 'node:assert/strict';
import {
    COMMAND_CATALOG,
    MENU_PAGE_SIZE,
    buildMenuMessage,
    filterCommandsForUser,
    isMenuTrigger,
    parseMenuArgument
} from './menu.js';

// --- Trigger parsing ---

test('isMenuTrigger mengenali menu / help / bantuan beserta nomor halaman', () => {
    for (const t of ['menu', 'MENU', 'help', 'Help', 'bantuan', 'Bantuan', 'menu 2', 'help 3', 'bantuan 1']) {
        assert.equal(isMenuTrigger(t), true, `harus true: ${t}`);
    }
});

test('isMenuTrigger menolak kata lain atau argumen non-angka', () => {
    for (const t of ['menuku', 'buat jadwal', 'menuu', 'menu abc', 'help -1', '']) {
        assert.equal(isMenuTrigger(t), false, `harus false: ${t}`);
    }
});

test('parseMenuArgument mengembalikan trigger dan halaman valid', () => {
    assert.deepEqual(parseMenuArgument('menu'), { trigger: 'menu', page: 1 });
    assert.deepEqual(parseMenuArgument('MENU 3'), { trigger: 'menu', page: 3 });
    assert.deepEqual(parseMenuArgument('bantuan 2'), { trigger: 'bantuan', page: 2 });
    assert.deepEqual(parseMenuArgument('help'), { trigger: 'help', page: 1 });
    assert.equal(parseMenuArgument('menuk'), null);
    assert.equal(parseMenuArgument('menu abc'), null);
});

// --- Katalog ---

test('katalog hanya berisi perintah dengan role dan scope valid', () => {
    const validRoles = new Set(['public', 'user', 'admin', 'ai', 'setup']);
    const validScopes = new Set(['private', 'group', 'both']);
    for (const entry of COMMAND_CATALOG) {
        assert.ok(entry.command && typeof entry.command === 'string', `command string: ${JSON.stringify(entry)}`);
        assert.ok(entry.description && typeof entry.description === 'string', `description: ${JSON.stringify(entry)}`);
        assert.ok(entry.group && typeof entry.group === 'string', `group: ${JSON.stringify(entry)}`);
        assert.ok(validRoles.has(entry.role), `role ${entry.role} invalid`);
        assert.ok(validScopes.has(entry.scope), `scope ${entry.scope} invalid`);
    }
});

test('katalog menyertakan command menu/help di kelompok Umum', () => {
    const menuEntry = COMMAND_CATALOG.find(e => e.command === 'menu');
    assert.ok(menuEntry, 'command menu wajib ada');
    assert.equal(menuEntry.role, 'public');
    assert.equal(menuEntry.scope, 'both');
    assert.equal(menuEntry.group, 'Umum');
});

test('katalog TIDAK mencantumkan command yang hanya aktif via NL (mis. rekap user)', () => {
    for (const entry of COMMAND_CATALOG) {
        assert.doesNotMatch(entry.command.toLowerCase(), /^rekap/, 'rekap user hanya intent AI, bukan command teks');
    }
});

// --- Filter akses ---

test('filterCommandsForUser: TAMU hanya melihat perintah public', () => {
    const list = filterCommandsForUser(COMMAND_CATALOG, {
        isAdmin: false, isAuthorized: false, hasAdmin: true, aiEnabled: false, scope: 'private'
    });
    assert.ok(list.length > 0);
    for (const e of list) assert.equal(e.role, 'public');
});

test('filterCommandsForUser: USER TIDAK melihat perintah admin', () => {
    const list = filterCommandsForUser(COMMAND_CATALOG, {
        isAdmin: false, isAuthorized: true, hasAdmin: true, aiEnabled: false, scope: 'private'
    });
    for (const e of list) {
        assert.notEqual(e.role, 'admin', `USER tidak boleh melihat admin command: ${e.command}`);
        assert.notEqual(e.role, 'ai', `USER tanpa AI config tidak melihat AI command: ${e.command}`);
    }
    // Minimal perintah user yang harus ada
    const commands = list.map(e => e.command);
    assert.ok(commands.includes('buat jadwal'));
    assert.ok(commands.includes('jadwal'));
    assert.ok(commands.includes('edit 1'));
    assert.ok(commands.includes('hapus 1'));
    assert.ok(commands.includes('tugas'));
    assert.ok(commands.includes('poin'));
    assert.ok(commands.includes('menu'));
});

test('filterCommandsForUser: ADMIN melihat perintah user + admin', () => {
    const list = filterCommandsForUser(COMMAND_CATALOG, {
        isAdmin: true, isAuthorized: true, hasAdmin: true, aiEnabled: false, scope: 'private'
    });
    const commands = list.map(e => e.command);
    assert.ok(commands.includes('admin daftar'));
    assert.ok(commands.includes('admin tambah 628xxx Nama'));
    assert.ok(commands.includes('jadwal semua'));
    assert.ok(commands.includes('laporan kirim'));
    assert.ok(commands.includes('poin kurang 628xxx 10'));
    // Tetap termasuk perintah USER
    assert.ok(commands.includes('buat jadwal'));
    assert.ok(commands.includes('tugas'));
});

test('filterCommandsForUser: AI command hanya muncul saat aiEnabled=true dan user authorized', () => {
    const authNoAI = filterCommandsForUser(COMMAND_CATALOG, {
        isAdmin: false, isAuthorized: true, hasAdmin: true, aiEnabled: false, scope: 'private'
    }).map(e => e.command);
    assert.ok(!authNoAI.includes('ai ping'));
    assert.ok(!authNoAI.includes('ai status'));

    const authWithAI = filterCommandsForUser(COMMAND_CATALOG, {
        isAdmin: false, isAuthorized: true, hasAdmin: true, aiEnabled: true, scope: 'private'
    }).map(e => e.command);
    assert.ok(authWithAI.includes('ai ping'));
    assert.ok(authWithAI.includes('ai status'));

    // Tamu meskipun AI enabled tetap tidak dapat AI command
    const tamuAI = filterCommandsForUser(COMMAND_CATALOG, {
        isAdmin: false, isAuthorized: false, hasAdmin: true, aiEnabled: true, scope: 'private'
    }).map(e => e.command);
    assert.ok(!tamuAI.includes('ai ping'));
});

test('filterCommandsForUser: perintah setup hanya muncul saat hasAdmin=false', () => {
    const beforeSetup = filterCommandsForUser(COMMAND_CATALOG, {
        isAdmin: false, isAuthorized: false, hasAdmin: false, aiEnabled: false, scope: 'private'
    }).map(e => e.command);
    assert.ok(beforeSetup.includes('setup <6 digit kode>'));

    const afterSetup = filterCommandsForUser(COMMAND_CATALOG, {
        isAdmin: false, isAuthorized: false, hasAdmin: true, aiEnabled: false, scope: 'private'
    }).map(e => e.command);
    assert.ok(!afterSetup.includes('setup <6 digit kode>'),
        'setup tidak boleh muncul setelah ADMIN terdaftar');
});

test('filterCommandsForUser: scope group hanya menampilkan perintah grup atau both', () => {
    const list = filterCommandsForUser(COMMAND_CATALOG, {
        isAdmin: true, isAuthorized: true, hasAdmin: true, aiEnabled: true, scope: 'group'
    });
    for (const e of list) {
        assert.ok(e.scope === 'both' || e.scope === 'group',
            `scope group tidak boleh menampilkan ${e.command} (scope=${e.scope})`);
    }
});

test('filterCommandsForUser: scope private tidak menampilkan perintah khusus grup', () => {
    const list = filterCommandsForUser(COMMAND_CATALOG, {
        isAdmin: true, isAuthorized: true, hasAdmin: true, aiEnabled: true, scope: 'private'
    });
    for (const e of list) {
        assert.ok(e.scope === 'both' || e.scope === 'private',
            `scope private tidak boleh menampilkan ${e.command} (scope=${e.scope})`);
    }
});

// --- Build message ---

test('buildMenuMessage: tamu tanpa akses tetap melihat menu & halo tanpa error', () => {
    const r = buildMenuMessage(COMMAND_CATALOG, {
        isAdmin: false, isAuthorized: false, hasAdmin: true, aiEnabled: false, scope: 'private'
    }, 1);
    assert.ok(r.totalItems >= 2);
    assert.match(r.text, /Peran: TAMU/);
    assert.match(r.text, /\*menu\*/);
    assert.match(r.text, /\*halo\*/);
    // Tidak boleh ada admin command
    assert.doesNotMatch(r.text, /admin tambah/);
    assert.doesNotMatch(r.text, /laporan kirim/);
    assert.doesNotMatch(r.text, /\*ai ping\*/);
});

test('buildMenuMessage: USER melihat Peran USER dan tidak ada seksi Admin/Laporan/AI', () => {
    const r = buildMenuMessage(COMMAND_CATALOG, {
        isAdmin: false, isAuthorized: true, hasAdmin: true, aiEnabled: true, scope: 'private'
    }, 1);
    assert.match(r.text, /Peran: USER/);
    assert.doesNotMatch(r.text, /\*Admin:\*/);
    assert.doesNotMatch(r.text, /\*Laporan:\*/);
    // ai command tidak muncul buat user biasa (hanya admin yg butuh? -> role 'ai' = authorized)
    // Dengan desain saat ini, role 'ai' hanya mensyaratkan authorized, jadi USER MENDAPAT AI command.
    assert.match(r.text, /\*ai ping\*/);
});

test('buildMenuMessage: ADMIN + AI melihat lebih banyak perintah dari USER', () => {
    const user = buildMenuMessage(COMMAND_CATALOG, {
        isAdmin: false, isAuthorized: true, hasAdmin: true, aiEnabled: false, scope: 'private'
    }, 1);
    const admin = buildMenuMessage(COMMAND_CATALOG, {
        isAdmin: true, isAuthorized: true, hasAdmin: true, aiEnabled: true, scope: 'private'
    }, 1);
    assert.ok(admin.totalItems > user.totalItems);
    assert.match(admin.text, /Peran: ADMIN/);
});

// --- Pagination ---

test('buildMenuMessage: pagination maksimal 20 per halaman', () => {
    assert.equal(MENU_PAGE_SIZE, 20);
    const admin = buildMenuMessage(COMMAND_CATALOG, {
        isAdmin: true, isAuthorized: true, hasAdmin: true, aiEnabled: true, scope: 'private'
    }, 1);
    // Jumlah bullet "• *..." di halaman 1 tidak melebihi 20
    const bullets = (admin.text.match(/^• \*/gm) || []).length;
    assert.ok(bullets <= MENU_PAGE_SIZE, `bullet=${bullets}`);
});

test('buildMenuMessage: footer menampilkan "Halaman X/Y — total N perintah." saat multi-halaman', () => {
    // Buat katalog sintetis >20 agar deterministik
    const synthetic = Array.from({ length: 25 }, (_, i) => ({
        command: `cmd${i + 1}`,
        description: `desc ${i + 1}`,
        group: 'Jadwal',
        scope: 'private',
        role: 'public'
    }));
    const p1 = buildMenuMessage(synthetic, { scope: 'private' }, 1);
    const p2 = buildMenuMessage(synthetic, { scope: 'private' }, 2);
    assert.equal(p1.totalPages, 2);
    assert.equal(p1.totalItems, 25);
    assert.match(p1.text, /Halaman 1\/2 — total 25 perintah\./);
    assert.match(p1.text, /\*menu 2\* untuk halaman berikutnya/);
    assert.doesNotMatch(p1.text, /halaman sebelumnya/);

    assert.match(p2.text, /Halaman 2\/2 — total 25 perintah\./);
    assert.match(p2.text, /\*menu 1\* untuk halaman sebelumnya/);
    assert.doesNotMatch(p2.text, /halaman berikutnya/);
});

test('buildMenuMessage: tidak ada footer saat semua perintah muat 1 halaman', () => {
    const r = buildMenuMessage(COMMAND_CATALOG, {
        isAdmin: false, isAuthorized: true, hasAdmin: true, aiEnabled: false, scope: 'private'
    }, 1);
    assert.equal(r.totalPages, 1);
    assert.doesNotMatch(r.text, /Halaman \d+\/\d+/);
});

test('buildMenuMessage: halaman di luar rentang dijepit ke halaman terakhir', () => {
    const synthetic = Array.from({ length: 25 }, (_, i) => ({
        command: `c${i + 1}`, description: 'x', group: 'Umum', scope: 'private', role: 'public'
    }));
    const r = buildMenuMessage(synthetic, { scope: 'private' }, 99);
    assert.equal(r.page, 2);
    assert.equal(r.totalPages, 2);
});

test('buildMenuMessage: ketika tidak ada perintah tersedia, pesan jelas dikirim', () => {
    const r = buildMenuMessage([], { scope: 'private' }, 1);
    assert.equal(r.totalItems, 0);
    assert.match(r.text, /_Tidak ada perintah yang tersedia/);
});

// --- Konsistensi dengan handler nyata di index.js ---
// Verifikasi bahwa command yang dicantumkan katalog adalah command teks
// yang memang ditangani (bukan konfigurasi internal / kredensial).

test('katalog tidak mengandung kredensial atau konfigurasi internal', () => {
    for (const e of COMMAND_CATALOG) {
        const low = (e.command + ' ' + e.description).toLowerCase();
        assert.doesNotMatch(low, /api[_\s-]?key/, `jangan expose api key: ${e.command}`);
        assert.doesNotMatch(low, /token/, `jangan expose token: ${e.command}`);
        assert.doesNotMatch(low, /password|secret/, `jangan expose rahasia: ${e.command}`);
        assert.doesNotMatch(low, /\bsession\b/, `jangan expose session WhatsApp: ${e.command}`);
    }
});

test('katalog memuat semua perintah utama yang didokumentasikan README', () => {
    const commands = COMMAND_CATALOG.map(e => e.command.toLowerCase());
    const mustHave = [
        'buat jadwal', 'jadwal', 'edit 1', 'tugas', 'poin',
        'admin tambah 628xxx nama', 'admin hapus 628xxx', 'admin daftar',
        'jadwal semua', 'tugas semua',
        'laporan grup pilih', 'laporan grup daftar',
        'laporan jam daftar', 'laporan jam tambah hh:mm',
        'laporan kirim',
        'menu', 'halo'
    ];
    for (const needle of mustHave) {
        assert.ok(commands.includes(needle), `katalog harus memuat: ${needle}`);
    }
});

// --- Integrasi tingkat handler (tanpa menyentuh socket WhatsApp) ---
// Mensimulasikan logika di index.js: ketika isMenuTrigger true, bot
// MEMANGGIL buildMenuMessage dengan opsi akses yang sesuai dan
// mengirim teks hasilnya. Ini memverifikasi kontrak integrasi bot.

function simulateMenuHandler({ text, isAdmin, isAuthorized, hasAdmin, aiEnabled, scope }) {
    if (!isMenuTrigger(text)) return { triggered: false };
    const parsed = parseMenuArgument(text);
    const page = (parsed && parsed.page) || 1;
    const msg = buildMenuMessage(COMMAND_CATALOG, {
        isAdmin, isAuthorized, hasAdmin, aiEnabled, scope
    }, page);
    return { triggered: true, page, text: msg.text, totalPages: msg.totalPages, totalItems: msg.totalItems };
}

test('integrasi: ADMIN mengetik "menu" → dapat halaman 1 dengan Peran ADMIN', () => {
    const r = simulateMenuHandler({
        text: 'menu', isAdmin: true, isAuthorized: true, hasAdmin: true, aiEnabled: false, scope: 'private'
    });
    assert.equal(r.triggered, true);
    assert.equal(r.page, 1);
    assert.match(r.text, /Peran: ADMIN/);
});

test('integrasi: ADMIN mengetik "help 2" → dapat halaman 2 bila ada', () => {
    const r = simulateMenuHandler({
        text: 'help 2', isAdmin: true, isAuthorized: true, hasAdmin: true, aiEnabled: true, scope: 'private'
    });
    assert.equal(r.triggered, true);
    assert.equal(r.page, 2);
});

test('integrasi: USER mengetik "bantuan" tidak dapat admin command', () => {
    const r = simulateMenuHandler({
        text: 'bantuan', isAdmin: false, isAuthorized: true, hasAdmin: true, aiEnabled: false, scope: 'private'
    });
    assert.equal(r.triggered, true);
    assert.match(r.text, /Peran: USER/);
    assert.doesNotMatch(r.text, /\*admin tambah/);
    assert.doesNotMatch(r.text, /\*laporan kirim\*/);
});

test('integrasi: perintah non-menu tidak memicu handler', () => {
    for (const t of ['buat jadwal', 'jadwal', 'tugas', 'tugas bantuan', 'admin bantuan', 'halo']) {
        const r = simulateMenuHandler({
            text: t, isAdmin: true, isAuthorized: true, hasAdmin: true, aiEnabled: false, scope: 'private'
        });
        assert.equal(r.triggered, false, `jangan trigger: ${t}`);
    }
});
