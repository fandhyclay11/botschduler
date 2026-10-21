// phaseD/schedulePreserve.test.js
// -------------------------------------------------------------
// Pengujian khusus: AI tidak boleh meringkas/mengubah isi pesan jadwal.
//
// Fokus:
//   1. recoverOriginalSchedule() HARUS mengembalikan isi pesan user
//      PERSIS seperti aslinya — line break, bullet, emoji, format WA,
//      dan baris waktu di dalam isi semuanya terjaga.
//   2. Deklarasi poin di baris metadata (bersama waktu + pengulangan)
//      TIDAK boleh ikut ke isi pesan.
//   3. Metadata ambigu (lebih dari satu waktu di baris metadata) →
//      bot MINTA KLARIFIKASI, bukan menebak.
//   4. Alur end-to-end via dispatchIntent: pesan panjang → createReminder
//      dipanggil dengan `schedule.text` yang IDENTIK dengan isi pesan user.
// -------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { __test_recoverOriginalSchedule as recoverOriginalSchedule, dispatchIntent } from './router.js';

// Impor parseScheduleText asli dari baseline untuk simulasi akurat.
// Kita tidak ingin mocking agar line-break-preservation benar-benar diuji.
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);

// parseScheduleText tidak diekspor dari index.js, jadi kita implementasikan
// ulang pemanggil kecil yang sama persis dengan baseline untuk tes isolasi.
// (Perilaku penting: trim .text pakai .trim(), input dinormalisasi dengan
// line-break dipertahankan.)
function normalizeScheduleInput(value) {
    return String(value || '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => line.replace(/[ \t]+/g, ' ').trimEnd())
        .join('\n')
        .trim();
}
function parseScheduleTextMock(text) {
    const input = normalizeScheduleInput(text);
    let m = input.match(/^setiap\s+hari\s+(\d{1,2}):(\d{2})\s+([\s\S]+)$/i);
    if (m) return { recurrence: 'daily', time: `${m[1].padStart(2, '0')}:${m[2]}`, text: m[3].trim() };
    m = input.match(/^setiap\s+tanggal\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s+([\s\S]+)$/i);
    if (m) return { recurrence: 'monthly', dayOfMonth: Number(m[1]), time: `${m[2].padStart(2, '0')}:${m[3]}`, text: m[4].trim() };
    m = input.match(/^setiap\s+([a-zA-ZÀ-ÿ'\u2019,\s]+?)\s+(\d{1,2}):(\d{2})\s+([\s\S]+)$/i);
    if (m && !/^tanggal\b/i.test(m[1].trim())) {
        return { recurrence: 'weekly', days: m[1], time: `${m[2].padStart(2, '0')}:${m[3]}`, text: m[4].trim() };
    }
    return null;
}

// ============================================================
// 1. UNIT TEST: recoverOriginalSchedule
// ============================================================

test('recover: pesan sederhana satu baris → body persis', () => {
    const raw = 'setiap hari 08:00 briefing pagi';
    const got = recoverOriginalSchedule(raw, 'setiap hari 08:00 briefing', false);
    assert.equal(got, 'setiap hari 08:00 briefing pagi');
});

test('recover: body dengan huruf kapital/tanda baca TIDAK dinormalisasi', () => {
    const raw = 'setiap hari 08:00 Briefing PAGI! Jangan telat.';
    const ai = 'setiap hari 08:00 briefing pagi'; // AI meringkas
    const got = recoverOriginalSchedule(raw, ai, false);
    assert.ok(typeof got === 'string', `expected string, got ${JSON.stringify(got)}`);
    assert.ok(got.endsWith('Briefing PAGI! Jangan telat.'),
        `body harus persis asli, dapat: ${got}`);
});

test('recover: pesan tugas panjang (judul, PIC, bullet, instruksi, emoji, baris waktu di isi, format WA *bold*)', () => {
    const raw = [
        'Setiap hari 06.19 poin 10',
        'TUGAS HARIAN TIM OPERASIONAL 🚀',
        '*PIC:* Budi Santoso',
        '*Deadline:* 08.00',
        '',
        'Instruksi:',
        '- Cek stok gudang 📦',
        '- Update laporan harian _(format excel)_',
        '- Kirim ke grup *SCB* paling lambat jam 09.00',
        '',
        '⚠️ Jangan lupa foto bukti setor!'
    ].join('\n');
    const aiSummary = 'setiap hari 06:19 cek stok dan update laporan';
    const got = recoverOriginalSchedule(raw, aiSummary, true);
    assert.ok(typeof got === 'string', `expected string, got ${JSON.stringify(got)}`);

    const parsed = parseScheduleTextMock(got);
    assert.ok(parsed, `parseScheduleText gagal untuk: ${got}`);
    assert.equal(parsed.recurrence, 'daily');
    assert.equal(parsed.time, '06:19');

    // Isi WAJIB mengandung seluruh baris penting apa adanya.
    assert.match(parsed.text, /TUGAS HARIAN TIM OPERASIONAL 🚀/);
    assert.match(parsed.text, /\*PIC:\* Budi Santoso/);
    assert.match(parsed.text, /\*Deadline:\* 08\.00/);
    assert.match(parsed.text, /- Cek stok gudang 📦/);
    assert.match(parsed.text, /- Update laporan harian _\(format excel\)_/);
    assert.match(parsed.text, /- Kirim ke grup \*SCB\* paling lambat jam 09\.00/);
    assert.match(parsed.text, /⚠️ Jangan lupa foto bukti setor!/);

    // Deklarasi poin dari baris metadata TIDAK boleh ikut body.
    assert.ok(!/^poin\s*10/i.test(parsed.text),
        `poin dari metadata bocor ke body: ${parsed.text}`);

    // Line break utama tetap terjaga (minimal 6 newline untuk 7+ baris).
    const nl = (parsed.text.match(/\n/g) || []).length;
    assert.ok(nl >= 6, `line break hilang, hanya ${nl} newline`);
});

test('recover: pesan tugas dengan "nilai 10 poin" di baris metadata → poin dibuang, isi utuh', () => {
    const raw = [
        'setiap senin 09:00 nilai 10 poin',
        'Rapat mingguan',
        '- Review minggu lalu',
        '- Rencana minggu depan'
    ].join('\n');
    const got = recoverOriginalSchedule(raw, 'setiap senin 09:00 rapat mingguan', true);
    assert.ok(typeof got === 'string');
    const parsed = parseScheduleTextMock(got);
    assert.ok(parsed, `parseScheduleText gagal: ${got}`);
    assert.equal(parsed.time, '09:00');
    assert.match(parsed.text, /Rapat mingguan/);
    assert.match(parsed.text, /- Review minggu lalu/);
    assert.match(parsed.text, /- Rencana minggu depan/);
    assert.ok(!/nilai\s*10\s*poin/i.test(parsed.text.split('\n')[0]),
        `poin bocor ke body baris pertama: ${parsed.text}`);
});

test('recover: "poin 10" sebagai BAGIAN isi pesan tugas (bukan di baris metadata) → tetap ada', () => {
    const raw = [
        'setiap hari 07:00 poin 5',
        'Challenge hari ini:',
        'Siapa yang pertama lapor dapat bonus poin 10!'
    ].join('\n');
    const got = recoverOriginalSchedule(raw, '', true);
    assert.ok(typeof got === 'string');
    const parsed = parseScheduleTextMock(got);
    assert.ok(parsed);
    // "poin 10" di baris isi JANGAN dihapus.
    assert.match(parsed.text, /bonus poin 10!/);
    // "poin 5" di baris metadata JANGAN muncul di body.
    assert.ok(!/^poin\s*5/i.test(parsed.text.split('\n')[0]),
        `poin metadata bocor: ${parsed.text}`);
});

test('recover: tidak ada waktu valid → return null (minta klarifikasi)', () => {
    const got = recoverOriginalSchedule('tolong ingatkan saya', 'setiap hari 08:00 ingatkan', false);
    assert.equal(got, null);
});

test('recover: metadata ada tapi isi kosong → __ambiguous empty-body', () => {
    const got = recoverOriginalSchedule('setiap hari 08:00', 'setiap hari 08:00 ', false);
    assert.ok(typeof got === 'object' && got && got.__ambiguous === 'empty-body',
        `expected empty-body ambiguous, got ${JSON.stringify(got)}`);
});

test('recover: dua waktu berbeda berdekatan di baris metadata → __ambiguous multiple-times', () => {
    const got = recoverOriginalSchedule('setiap hari 08:00 09:00 briefing', '', false);
    assert.ok(typeof got === 'object' && got && got.__ambiguous === 'multiple-times',
        `expected multiple-times ambiguous, got ${JSON.stringify(got)}`);
});

test('recover: waktu kedua di dalam isi pesan (satu baris) → BUKAN ambigu, body utuh', () => {
    // User menulis dua waktu: 08:00 metadata, 09:00 bagian isi.
    // Pemisah "briefing jam" di antara waktu → treated as part of body.
    const raw = 'setiap hari 08:00 briefing lalu follow up jam 09:00';
    const got = recoverOriginalSchedule(raw, '', false);
    assert.equal(typeof got, 'string', `expected string, got ${JSON.stringify(got)}`);
    const parsed = parseScheduleTextMock(got);
    assert.ok(parsed);
    assert.equal(parsed.time, '08:00');
    assert.match(parsed.text, /briefing lalu follow up jam 09:00/);
});

test('recover: pesan dengan recurrence weekly multi-hari + body panjang', () => {
    const raw = [
        'setiap senin,rabu,jumat 09:30',
        'Review mingguan',
        '*PIC:* Reza & Saras',
        '📊 Agenda:',
        '1. Ringkasan metrik',
        '2. Blocker',
        '3. Action items'
    ].join('\n');
    const got = recoverOriginalSchedule(raw, '', false);
    assert.equal(typeof got, 'string');
    const parsed = parseScheduleTextMock(got);
    assert.ok(parsed, `parse gagal: ${got}`);
    assert.equal(parsed.recurrence, 'weekly');
    assert.equal(parsed.time, '09:30');
    assert.match(parsed.text, /Review mingguan/);
    assert.match(parsed.text, /\*PIC:\* Reza & Saras/);
    assert.match(parsed.text, /📊 Agenda:/);
    assert.match(parsed.text, /1\. Ringkasan metrik/);
    assert.match(parsed.text, /3\. Action items/);
});

test('recover: pesan tanpa kata "setiap" tapi ada waktu di baris pertama → default daily, body utuh', () => {
    const raw = [
        '08:00 briefing',
        'detail: pastikan hadir semua'
    ].join('\n');
    const got = recoverOriginalSchedule(raw, 'setiap hari 08:00 briefing', false);
    assert.equal(typeof got, 'string', `got: ${JSON.stringify(got)}`);
    const parsed = parseScheduleTextMock(got);
    assert.ok(parsed);
    assert.equal(parsed.time, '08:00');
    assert.match(parsed.text, /briefing/);
    assert.match(parsed.text, /detail: pastikan hadir semua/);
});

test('recover: AI mengirim schedule yang SANGAT berbeda isinya → bot TETAP pakai teks asli', () => {
    const raw = 'setiap hari 10:00 Rapat finansial Q4 - bawa laptop dan dokumen OJK';
    const ai = 'setiap hari 10:00 rapat'; // AI meringkas drastis
    const got = recoverOriginalSchedule(raw, ai, false);
    assert.ok(typeof got === 'string');
    assert.match(got, /Rapat finansial Q4 - bawa laptop dan dokumen OJK/);
    assert.ok(!/^setiap hari 10:00 rapat$/.test(got),
        `bot pakai versi AI yang sudah diringkas: ${got}`);
});

// ============================================================
// 2. INTEGRASI dispatchIntent: createReminder harus menerima text persis
// ============================================================

const JID = '62811111111@s.whatsapp.net';
const PHONE = '62811111111';

function makeCtxWithGroup() {
    const sent = [];
    const createdWith = [];
    const ctx = {
        sock: {
            sendMessage: async (jid, msg) => { sent.push({ jid, msg }); return { key: { id: 'MSG1' } }; }
        },
        loadUsers: () => ({ admins: [], users: [{ jid: PHONE, phone: PHONE }] }),
        isAdmin: () => false,
        normalizeUserId: (v) => String(v || '').replace(/\D/g, ''),
        loadReminders: () => [],
        saveReminders: () => {},
        scheduleReminderChecker: () => {},
        sendPrivateScheduleList: async () => {},
        getUserParticipatingGroups: async () => ({
            groupsForUser: [{ id: '120363000000000000@g.us', name: 'Grup Ops' }],
            allGroups: []
        }),
        parseScheduleText: parseScheduleTextMock,
        createReminder: async (sock, replyJid, targetChatId, schedule) => {
            createdWith.push({ targetChatId, schedule });
            return true;
        },
        findLatestReminder: () => ({ id: 1, text: '' }),
        phaseC: {
            markAsTask: () => {},
            listTasks: async () => {}, showPoints: async () => {},
            sendHelp: async () => {}, sendReportsNow: async () => ({}),
            addReportTime: () => ({ ok: true }),
            listReportGroupsCmd: async () => {}, listReportTimesCmd: async () => {}
        }
    };
    ctx._sent = sent;
    ctx._createdWith = createdWith;
    return ctx;
}

test('dispatchIntent: pesan tugas panjang → createReminder menerima text IDENTIK dengan isi user', async () => {
    const ctx = makeCtxWithGroup();
    const raw = [
        'Setiap hari 06.19 poin 10',
        'TUGAS HARIAN TIM OPERASIONAL 🚀',
        '*PIC:* Budi Santoso',
        '- Cek stok gudang 📦',
        '- Update laporan harian _(format excel)_',
        '- Kirim ke grup *SCB* paling lambat jam 09.00'
    ].join('\n');
    const intent = {
        intent: 'buat_tugas',
        confidence: 0.95,
        params: {
            // Simulasi AI yang MERINGKAS (ini yang tidak boleh dipakai bot).
            schedule: 'setiap hari 06:19 cek stok',
            points: 10
        }
    };
    const r = await dispatchIntent(ctx, JID, PHONE, intent, raw);
    assert.equal(r.handled, true);
    assert.equal(ctx._createdWith.length, 1, `expected createReminder 1x; got ${JSON.stringify(ctx._createdWith)}`);
    const { schedule } = ctx._createdWith[0];
    assert.equal(schedule.time, '06:19');
    // Isi WAJIB apa adanya.
    assert.match(schedule.text, /TUGAS HARIAN TIM OPERASIONAL 🚀/);
    assert.match(schedule.text, /\*PIC:\* Budi Santoso/);
    assert.match(schedule.text, /- Cek stok gudang 📦/);
    assert.match(schedule.text, /- Kirim ke grup \*SCB\* paling lambat jam 09\.00/);
    // "poin 10" dari baris metadata TIDAK boleh ikut.
    assert.ok(!/^poin\s*10/i.test(schedule.text.split('\n')[0]));
    // AI's "cek stok" versi ringkas tidak boleh jadi satu-satunya isi.
    assert.ok(schedule.text.length > 'cek stok'.length);
});

test('dispatchIntent: metadata ambigu (dua waktu di baris pertama) → minta klarifikasi, TIDAK membuat jadwal', async () => {
    const ctx = makeCtxWithGroup();
    const raw = 'setiap hari 08:00 09:00 briefing pagi';
    const intent = {
        intent: 'buat_jadwal_biasa',
        confidence: 0.9,
        params: { schedule: 'setiap hari 08:00 briefing pagi' }
    };
    const r = await dispatchIntent(ctx, JID, PHONE, intent, raw);
    assert.equal(r.handled, true);
    assert.equal(ctx._createdWith.length, 0, 'TIDAK boleh ada reminder dibuat saat ambigu');
    assert.ok(ctx._sent.some(s => /❓/.test(s.msg?.text || '')),
        `harus kirim pertanyaan klarifikasi; got: ${JSON.stringify(ctx._sent)}`);
    assert.ok(ctx._sent.some(s => /waktu/i.test(s.msg?.text || '') || /jam/i.test(s.msg?.text || '')),
        `pesan klarifikasi harus menyebut waktu/jam`);
});

test('dispatchIntent: pesan tanpa waktu valid → minta klarifikasi, tidak mencoba membuat jadwal', async () => {
    const ctx = makeCtxWithGroup();
    const raw = 'tolong buatkan jadwal untuk briefing nanti ya';
    const intent = {
        intent: 'buat_jadwal_biasa',
        confidence: 0.85,
        params: { schedule: 'setiap hari 08:00 briefing' } // AI tebak
    };
    const r = await dispatchIntent(ctx, JID, PHONE, intent, raw);
    assert.equal(r.handled, true);
    assert.equal(ctx._createdWith.length, 0, 'bot tidak boleh menebak waktu');
    assert.ok(ctx._sent.some(s => /❓/.test(s.msg?.text || '')),
        'harus kirim pertanyaan klarifikasi');
});

test('dispatchIntent: pesan recurrence weekly multi-hari + body panjang → text persis', async () => {
    const ctx = makeCtxWithGroup();
    const raw = [
        'setiap senin,rabu,jumat 09:30',
        'Review Mingguan Q4',
        '*PIC:* Reza & Saras',
        '📊 Agenda:',
        '1. Ringkasan metrik',
        '2. Blocker list',
        '3. Action items'
    ].join('\n');
    const intent = {
        intent: 'buat_jadwal_biasa',
        confidence: 0.95,
        params: { schedule: 'setiap senin,rabu,jumat 09:30 review mingguan' }
    };
    const r = await dispatchIntent(ctx, JID, PHONE, intent, raw);
    assert.equal(r.handled, true);
    assert.equal(ctx._createdWith.length, 1);
    const { schedule } = ctx._createdWith[0];
    assert.equal(schedule.time, '09:30');
    assert.match(schedule.text, /Review Mingguan Q4/);
    assert.match(schedule.text, /\*PIC:\* Reza & Saras/);
    assert.match(schedule.text, /📊 Agenda:/);
    assert.match(schedule.text, /1\. Ringkasan metrik/);
    assert.match(schedule.text, /3\. Action items/);
});
