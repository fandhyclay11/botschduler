import test from 'node:test';
import assert from 'node:assert/strict';
import {
    dispatchIntent,
    hasPendingConfirm
} from './router.js';
import { removeMember, getNameByPhone, getRoleByPhone } from '../phaseC/roster.js';

// Mock context minimal. Hanya method yang dipakai dispatchIntent/executor
// yang di-stub. Tidak menyentuh jaringan / file sistem / WhatsApp.
function makeCtx(overrides = {}) {
    const sent = [];
    const ctx = {
        sock: {
            sendMessage: async (jid, msg) => { sent.push({ jid, msg }); return { key: { id: 'MSG1' } }; }
        },
        loadUsers: () => ({ admins: [{ phone: '62800000000', jid: '62800000000' }], users: [{ jid: '62811111111', phone: '62811111111' }] }),
        isAdmin: (users, phone) => users.admins.some(a => a.phone === phone || a.jid === phone),
        normalizeUserId: (v) => String(v || '').replace(/\D/g, ''),
        loadReminders: () => [],
        saveReminders: () => {},
        scheduleReminderChecker: () => {},
        sendPrivateScheduleList: async () => { sent.push({ action: 'list_jadwal' }); },
        getUserParticipatingGroups: async () => ({ groupsForUser: [], allGroups: [] }),
        parseScheduleText: () => null,
        createReminder: async () => true,
        findLatestReminder: () => null,
        phaseC: {
            listTasks: async () => { sent.push({ action: 'list_tugas' }); },
            showPoints: async () => { sent.push({ action: 'show_poin' }); },
            sendHelp: async () => { sent.push({ action: 'help' }); },
            markAsTask: () => {},
            sendReportsNow: async () => ({ ok: true, count: 1 }),
            addReportTime: () => ({ ok: true }),
            listReportGroupsCmd: async () => { sent.push({ action: 'laporan_grup_daftar' }); },
            listReportTimesCmd: async () => { sent.push({ action: 'laporan_jam_daftar' }); }
        },
        ...overrides
    };
    ctx._sent = sent;
    return ctx;
}

const JID = '62811111111@s.whatsapp.net';
const PHONE_USER = '62811111111';
const PHONE_ADMIN = '62800000000';

// --- 1. intent unknown / confidence rendah → handled=false ---

test('dispatchIntent: intent unknown → handled=false, tidak mengirim pesan', async () => {
    const ctx = makeCtx();
    const r = await dispatchIntent(ctx, JID, PHONE_USER, {
        intent: 'unknown', confidence: 0.3, params: {}
    }, 'cuaca hari ini');
    assert.equal(r.handled, false);
    assert.equal(ctx._sent.length, 0);
});

test('dispatchIntent: confidence < 0.55 → skip (handled=false)', async () => {
    const ctx = makeCtx();
    const r = await dispatchIntent(ctx, JID, PHONE_USER, {
        intent: 'lihat_jadwal', confidence: 0.4, params: {}
    }, 'liat sesuatu');
    assert.equal(r.handled, false);
    assert.equal(r.reason, 'low-confidence');
    assert.equal(ctx._sent.length, 0);
});

// --- 2. intent dengan param wajib hilang → tanya klarifikasi (TIDAK execute) ---

test('dispatchIntent: buat_tugas tanpa points → tanya klarifikasi, bukan eksekusi', async () => {
    const ctx = makeCtx();
    const r = await dispatchIntent(ctx, JID, PHONE_USER, {
        intent: 'buat_tugas',
        confidence: 0.95,
        params: { schedule: 'setiap senin 09:00 cek stok' }
    }, 'buat tugas setiap senin jam 9 cek stok');
    assert.equal(r.handled, true);
    assert.equal(r.reason, 'missing-params');
    assert.equal(ctx._sent.length, 1);
    assert.match(ctx._sent[0].msg.text, /❓/);
    assert.match(ctx._sent[0].msg.text, /poin/i);
});

test('dispatchIntent: buat_jadwal_biasa tanpa schedule → tanya klarifikasi', async () => {
    const ctx = makeCtx();
    const r = await dispatchIntent(ctx, JID, PHONE_USER, {
        intent: 'buat_jadwal_biasa', confidence: 0.8, params: {}
    }, 'buat jadwal');
    assert.equal(r.handled, true);
    assert.equal(r.reason, 'missing-params');
    assert.match(ctx._sent[0].msg.text, /setiap hari 08:00/);
});

test('dispatchIntent: admin_tambah_user tanpa phone → tanya nomor', async () => {
    const ctx = makeCtx();
    const r = await dispatchIntent(ctx, JID, PHONE_ADMIN, {
        intent: 'admin_tambah_user', confidence: 0.8, params: {}
    }, 'tambah user');
    assert.equal(r.handled, true);
    assert.equal(r.reason, 'missing-params');
    assert.match(ctx._sent[0].msg.text, /nomor/i);
});

test('dispatchIntent: laporan_jam_tambah tanpa HH:MM → tanya format waktu', async () => {
    const ctx = makeCtx();
    const r = await dispatchIntent(ctx, JID, PHONE_ADMIN, {
        intent: 'laporan_jam_tambah', confidence: 0.8, params: {}
    }, 'set jam laporan 20');
    assert.equal(r.handled, true);
    assert.equal(r.reason, 'missing-params');
    assert.match(ctx._sent[0].msg.text, /HH:MM/);
});

test('dispatchIntent: hapus_jadwal tanpa all/indexes via NL (bukan bare command) → tanya klarifikasi', async () => {
    const ctx = makeCtx();
    // rawText tidak boleh match guard bare command (/^hapus\s+(tugas|jadwal)?\s*$/).
    // Pakai kalimat panjang yang tetap jatuh ke intent hapus_jadwal via AI/local
    // tanpa params.
    const r = await dispatchIntent(ctx, JID, PHONE_USER, {
        intent: 'hapus_jadwal', confidence: 0.8, params: {}
    }, 'tolong hapus jadwal yang itu dong');
    assert.equal(r.handled, true);
    assert.equal(r.reason, 'missing-params');
    assert.match(ctx._sent[0].msg.text, /jadwal/i);
});

test('dispatchIntent: "hapus jadwal" bare → passthrough ke handler manual (guard existing)', async () => {
    const ctx = makeCtx();
    const r = await dispatchIntent(ctx, JID, PHONE_USER, {
        intent: 'hapus_jadwal', confidence: 0.8, params: {}
    }, 'hapus jadwal');
    assert.equal(r.handled, false);
    assert.equal(r.reason, 'bare-command-passthrough');
});

// --- 3. intent medium confidence (0.55-0.74) + param lengkap → pending confirm ---

test('dispatchIntent: confidence sedang + param lengkap → masuk pending-confirm', async () => {
    const ctx = makeCtx();
    const r = await dispatchIntent(ctx, JID, PHONE_USER, {
        intent: 'lihat_jadwal', confidence: 0.65, params: {}
    }, 'daftar jadwal mungkin');
    assert.equal(r.handled, true);
    assert.equal(ctx._sent.length, 1);
    assert.match(ctx._sent[0].msg.text, /Maksudmu/);
    assert.ok(hasPendingConfirm(JID));
});

// --- 4. intent high confidence + param lengkap → execute ---

test('dispatchIntent: lihat_jadwal high conf → langsung eksekusi (tanpa tanya)', async () => {
    // Pakai JID berbeda untuk hindari sisa pending-confirm dari test sebelumnya
    const jid = '628999@s.whatsapp.net';
    const ctx = makeCtx();
    const r = await dispatchIntent(ctx, jid, '628999', {
        intent: 'lihat_jadwal', confidence: 0.95, params: {}
    }, 'daftar jadwal');
    assert.equal(r.handled, true);
    assert.ok(ctx._sent.some(s => s.action === 'list_jadwal'));
});

test('dispatchIntent: lihat_poin high conf → eksekusi via phaseC.showPoints', async () => {
    const jid = '628998@s.whatsapp.net';
    const ctx = makeCtx();
    const r = await dispatchIntent(ctx, jid, '628998', {
        intent: 'lihat_poin', confidence: 0.95, params: {}
    }, 'poin saya');
    assert.equal(r.handled, true);
    assert.ok(ctx._sent.some(s => s.action === 'show_poin'));
});

// --- 5. guard: bare command tanpa argumen di-passthrough ke handler manual ---

test('dispatchIntent: "laporan grup tambah" bare → handled=false (passthrough ke manual)', async () => {
    const ctx = makeCtx();
    const r = await dispatchIntent(ctx, JID, PHONE_ADMIN, {
        intent: 'laporan_grup_daftar', confidence: 0.9, params: {}
    }, 'laporan grup tambah');
    assert.equal(r.handled, false);
    assert.equal(r.reason, 'bare-command-passthrough');
    assert.equal(ctx._sent.length, 0);
});

test('dispatchIntent: "admin tambah" bare → handled=false (passthrough)', async () => {
    const ctx = makeCtx();
    const r = await dispatchIntent(ctx, JID, PHONE_ADMIN, {
        intent: 'admin_tambah_user', confidence: 0.9, params: {}
    }, 'admin tambah');
    assert.equal(r.handled, false);
    assert.equal(r.reason, 'bare-command-passthrough');
});

// --- 6. akses: non-admin tidak boleh menjalankan action admin ---

test('dispatchIntent: USER biasa tidak bisa laporan_kirim (admin only)', async () => {
    const jid = '628997@s.whatsapp.net';
    const ctx = makeCtx();
    const r = await dispatchIntent(ctx, jid, PHONE_USER, {
        intent: 'laporan_kirim', confidence: 0.95, params: {}
    }, 'kirim laporan');
    assert.equal(r.handled, true);
    assert.match(ctx._sent[0].msg.text, /Hanya ADMIN/i);
});

test('dispatchIntent: USER biasa tidak bisa admin_tambah_user', async () => {
    const jid = '628996@s.whatsapp.net';
    const ctx = makeCtx();
    const r = await dispatchIntent(ctx, jid, PHONE_USER, {
        intent: 'admin_tambah_user', confidence: 0.95, params: { phone: '62812345678' }
    }, 'tambah user 62812345678');
    assert.equal(r.handled, true);
    assert.match(ctx._sent[0].msg.text, /Hanya ADMIN/i);
});

// --- 7. rekap_user: input nama HANYA memperbarui roster/leaderboard, ---
// ---    TIDAK boleh memberi akses bot ke nomor baru. ---

// Nomor dummy khusus test (tidak bentrok dengan data produksi). Dihapus dari
// roster setelah tes selesai supaya tidak mencemari data_phaseC/roster.json.
const REKAP_TEST_NUMBERS = [
    '628990000001', // calon nama baru (belum terdaftar sebagai USER)
    '628990000002', // sudah terdaftar sebagai USER (nama akan di-update)
    '628990000003'  // existing USER yang tidak disentuh (kontrol)
];

function makeRekapCtx({ existingUsers = [], existingAdmins = [{ phone: PHONE_ADMIN, jid: PHONE_ADMIN }] } = {}) {
    // Clone deep agar tes dapat memverifikasi state TANPA termutasi oleh
    // ctx.loadUsers() berikutnya (router memanggil loadUsers 2x: untuk guard
    // admin + untuk patch).
    const snapshot = { admins: existingAdmins, users: existingUsers };
    const saved = []; // setiap saveUsers push copy JSON
    const sent = [];
    const ctx = {
        sock: {
            sendMessage: async (jid, msg) => { sent.push({ jid, msg }); return { key: { id: 'MSG' } }; }
        },
        loadUsers: () => JSON.parse(JSON.stringify(snapshot)),
        saveUsers: (u) => {
            // Simulate persist: update snapshot + simpan copy
            snapshot.admins = JSON.parse(JSON.stringify(u.admins || []));
            snapshot.users = JSON.parse(JSON.stringify(u.users || []));
            saved.push(JSON.parse(JSON.stringify(u)));
        },
        isAdmin: (users, phone) =>
            (users.admins || []).some(a => a.phone === phone || a.jid === phone),
        normalizeUserId: (v) => String(v || '').replace(/\D/g, ''),
        phaseC: {}
    };
    return { ctx, saved, sent, snapshot };
}

test('rekap_user: memasukkan nama baru menyimpan nama di roster (leaderboard akan menampilkan nama baru)', async () => {
    const num = REKAP_TEST_NUMBERS[0];
    const { ctx } = makeRekapCtx();
    const r = await dispatchIntent(ctx, JID, PHONE_ADMIN, {
        intent: 'rekap_user',
        confidence: 0.95,
        params: { members: [{ name: 'Budi Test', phone: num, role: 'SSL' }] }
    }, `rekap user:\nBudi Test ${num} SSL`);

    assert.equal(r.handled, true);
    // Roster = sumber nama leaderboard
    assert.equal(getNameByPhone(num), 'Budi Test');
    assert.equal(getRoleByPhone(num), 'SSL');
});

test('rekap_user: memperbarui nama existing roster → nama leaderboard ikut berubah', async () => {
    const num = REKAP_TEST_NUMBERS[0];
    const { ctx } = makeRekapCtx();

    // Masukan awal
    await dispatchIntent(ctx, JID, PHONE_ADMIN, {
        intent: 'rekap_user', confidence: 0.95,
        params: { members: [{ name: 'Nama Lama', phone: num, role: 'SSL' }] }
    }, `rekap user:\nNama Lama ${num} SSL`);
    assert.equal(getNameByPhone(num), 'Nama Lama');

    // Update nama
    await dispatchIntent(ctx, JID, PHONE_ADMIN, {
        intent: 'rekap_user', confidence: 0.95,
        params: { members: [{ name: 'Nama Baru', phone: num, role: 'SSL' }] }
    }, `rekap user:\nNama Baru ${num} SSL`);
    assert.equal(getNameByPhone(num), 'Nama Baru');
});

test('rekap_user: nomor baru TIDAK ditambahkan ke daftar pengguna bot (users.json tidak membengkak)', async () => {
    const num = REKAP_TEST_NUMBERS[0];
    const { ctx, snapshot } = makeRekapCtx({
        existingUsers: [{ jid: PHONE_USER, phone: PHONE_USER, name: 'User Lama' }]
    });

    await dispatchIntent(ctx, JID, PHONE_ADMIN, {
        intent: 'rekap_user', confidence: 0.95,
        params: { members: [{ name: 'Pendatang', phone: num, role: 'SCB' }] }
    }, `rekap user:\nPendatang ${num} SCB`);

    // users.users TIDAK boleh ada entry baru untuk `num`.
    const found = snapshot.users.find(u => u.jid === num || u.phone === num);
    assert.equal(found, undefined,
        'nomor yang hanya di-rekap namanya tidak boleh ditambahkan ke users.json');
    // User lama tetap ada, tidak terhapus
    assert.equal(snapshot.users.length, 1);
    assert.equal(snapshot.users[0].phone, PHONE_USER);
});

test('rekap_user: nomor baru yang di-rekap TIDAK memperoleh akses bot (isAuthorized tetap false)', async () => {
    const num = REKAP_TEST_NUMBERS[0];
    const { ctx, snapshot } = makeRekapCtx();

    await dispatchIntent(ctx, JID, PHONE_ADMIN, {
        intent: 'rekap_user', confidence: 0.95,
        params: { members: [{ name: 'Pendatang', phone: num, role: 'SCB' }] }
    }, `rekap user:\nPendatang ${num} SCB`);

    // Simulasi pemeriksaan akses (sama seperti index.js:isAuthorized).
    const isAdmin = (snapshot.admins || []).some(a => a.phone === num || a.jid === num);
    const isUser = (snapshot.users || []).some(u => u.phone === num || u.jid === num);
    const authorized = isAdmin || isUser;
    assert.equal(authorized, false,
        'input nama tidak boleh otomatis memberi akses bot');
});

test('rekap_user: USER yang sudah terdaftar namanya di-update, peran/akses tidak berubah', async () => {
    const num = REKAP_TEST_NUMBERS[1];
    const existing = {
        jid: num, phone: num, name: 'Lama',
        addedAt: '2020-01-01T00:00:00.000Z',
        role: 'USER' // field role simulatif; harus tetap sama
    };
    const { ctx, snapshot } = makeRekapCtx({ existingUsers: [existing] });

    await dispatchIntent(ctx, JID, PHONE_ADMIN, {
        intent: 'rekap_user', confidence: 0.95,
        params: { members: [{ name: 'Baru', phone: num, role: 'SJL' }] }
    }, `rekap user:\nBaru ${num} SJL`);

    const u = snapshot.users.find(x => x.phone === num);
    assert.ok(u, 'user existing tetap ada');
    assert.equal(u.name, 'Baru', 'nama di users.json diperbarui');
    // Field lain tidak boleh berubah
    assert.equal(u.addedAt, '2020-01-01T00:00:00.000Z');
    assert.equal(u.role, 'USER');
    assert.equal(u.jid, num);
    // Tidak ada entry user tambahan
    assert.equal(snapshot.users.length, 1);
});

test('rekap_user: pengguna bot existing lain (yang tidak di-rekap) tetap utuh', async () => {
    const numRekap = REKAP_TEST_NUMBERS[0];
    const numKontrol = REKAP_TEST_NUMBERS[2];
    const kontrol = { jid: numKontrol, phone: numKontrol, name: 'Kontrol', addedAt: '2021-06-01T00:00:00.000Z' };
    const { ctx, snapshot } = makeRekapCtx({ existingUsers: [kontrol] });

    await dispatchIntent(ctx, JID, PHONE_ADMIN, {
        intent: 'rekap_user', confidence: 0.95,
        params: { members: [{ name: 'Siapa', phone: numRekap, role: 'SCB' }] }
    }, `rekap user:\nSiapa ${numRekap} SCB`);

    // User kontrol harus tetap persis
    const stillThere = snapshot.users.find(u => u.phone === numKontrol);
    assert.deepEqual(stillThere, kontrol,
        'user existing yang tidak terkait rekap tidak boleh berubah');
    assert.equal(snapshot.users.length, 1);
});

test('rekap_user: ADMIN existing tetap ADMIN (peran/akses admin tidak di-downgrade)', async () => {
    const { ctx, snapshot } = makeRekapCtx();
    const num = REKAP_TEST_NUMBERS[0];

    const adminBefore = JSON.parse(JSON.stringify(snapshot.admins));
    await dispatchIntent(ctx, JID, PHONE_ADMIN, {
        intent: 'rekap_user', confidence: 0.95,
        params: { members: [{ name: 'X', phone: num, role: 'SSL' }] }
    }, `rekap user:\nX ${num} SSL`);

    assert.deepEqual(snapshot.admins, adminBefore,
        'daftar admin tidak boleh berubah akibat rekap');
});

test('mekanisme pemberian akses existing (admin_tambah_user) tetap bekerja seperti biasa', async () => {
    // Pastikan jalur sah untuk menambah USER tetap menambahkan entry ke
    // users.users (regresi guard supaya perbaikan rekap tidak menyentuh jalur ini).
    const target = '62812345678';
    const { ctx, snapshot } = makeRekapCtx();
    const jid = '628995@s.whatsapp.net';

    const r = await dispatchIntent(ctx, jid, PHONE_ADMIN, {
        intent: 'admin_tambah_user',
        confidence: 0.95,
        params: { phone: target, name: 'User Sah' }
    }, `tambah user ${target} User Sah`);

    assert.equal(r.handled, true);
    const added = snapshot.users.find(u => u.jid === target || u.phone === target);
    assert.ok(added, 'admin_tambah_user harus menambahkan entry ke users.users');
    assert.equal(added.name, 'User Sah');
});

test('cleanup: hapus nomor dummy dari roster.json agar tidak mencemari data', () => {
    for (const num of REKAP_TEST_NUMBERS) {
        removeMember(num, (v) => String(v || '').replace(/\D/g, ''));
    }
    // Tidak assert — removeMember mengembalikan ok:false kalau tidak ada;
    // yang penting roster bersih.
    for (const num of REKAP_TEST_NUMBERS) {
        assert.equal(getNameByPhone(num), '');
    }
});
