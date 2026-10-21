import test from 'node:test';
import assert from 'node:assert/strict';
import {
    dispatchIntent,
    hasPendingConfirm
} from './router.js';

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
