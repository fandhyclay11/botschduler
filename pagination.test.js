import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SCHEDULE_PAGE_SIZE,
    getTotalPages,
    clampPage,
    getPageSlice,
    buildPaginationFooter,
    parsePageArgument
} from './pagination.js';

function makeIds(n) {
    return Array.from({ length: n }, (_, i) => `rem-${i + 1}`);
}

test('page size default adalah 20', () => {
    assert.equal(SCHEDULE_PAGE_SIZE, 20);
});

test('getTotalPages: nol item tetap mengembalikan 1 halaman', () => {
    assert.equal(getTotalPages(0), 1);
});

test('getTotalPages: 1 item = 1 halaman, 20 item = 1 halaman, 21 item = 2 halaman, 41 item = 3 halaman', () => {
    assert.equal(getTotalPages(1), 1);
    assert.equal(getTotalPages(20), 1);
    assert.equal(getTotalPages(21), 2);
    assert.equal(getTotalPages(40), 2);
    assert.equal(getTotalPages(41), 3);
});

test('clampPage menjepit nilai di luar rentang dan menolak non-angka', () => {
    assert.equal(clampPage(0, 21), 1);
    assert.equal(clampPage(-5, 21), 1);
    assert.equal(clampPage(1, 21), 1);
    assert.equal(clampPage(2, 21), 2);
    assert.equal(clampPage(3, 21), 2, 'melebihi halaman terakhir → halaman terakhir');
    assert.equal(clampPage(NaN, 21), 1);
    assert.equal(clampPage('abc', 21), 1);
    assert.equal(clampPage(1.9, 21), 1);
});

test('getPageSlice: daftar kosong tetap mengembalikan page 1 dengan items kosong', () => {
    const slice = getPageSlice([], 1);
    assert.deepEqual(slice.items, []);
    assert.equal(slice.page, 1);
    assert.equal(slice.totalPages, 1);
    assert.equal(slice.totalItems, 0);
    assert.equal(slice.startIndex, 0);
    assert.equal(slice.endIndex, 0);
});

test('getPageSlice: 1 item → semua di satu halaman', () => {
    const slice = getPageSlice(makeIds(1), 1);
    assert.deepEqual(slice.items, ['rem-1']);
    assert.equal(slice.totalPages, 1);
});

test('getPageSlice: tepat 20 item → semua di halaman 1, totalPages=1', () => {
    const slice = getPageSlice(makeIds(20), 1);
    assert.equal(slice.items.length, 20);
    assert.equal(slice.totalPages, 1);
    assert.equal(slice.startIndex, 0);
    assert.equal(slice.endIndex, 20);
});

test('getPageSlice: 21 item → halaman 1 berisi 20, halaman 2 berisi 1', () => {
    const items = makeIds(21);
    const p1 = getPageSlice(items, 1);
    const p2 = getPageSlice(items, 2);
    assert.equal(p1.totalPages, 2);
    assert.equal(p1.items.length, 20);
    assert.deepEqual(p1.items[0], 'rem-1');
    assert.deepEqual(p1.items[19], 'rem-20');
    assert.equal(p2.items.length, 1);
    assert.deepEqual(p2.items, ['rem-21']);
    assert.equal(p2.startIndex, 20);
    assert.equal(p2.endIndex, 21);
});

test('getPageSlice: 45 item → 3 halaman (20, 20, 5)', () => {
    const items = makeIds(45);
    const p1 = getPageSlice(items, 1);
    const p2 = getPageSlice(items, 2);
    const p3 = getPageSlice(items, 3);
    assert.equal(p1.totalPages, 3);
    assert.equal(p1.items.length, 20);
    assert.equal(p2.items.length, 20);
    assert.deepEqual(p2.items[0], 'rem-21');
    assert.deepEqual(p2.items[19], 'rem-40');
    assert.equal(p3.items.length, 5);
    assert.deepEqual(p3.items, ['rem-41', 'rem-42', 'rem-43', 'rem-44', 'rem-45']);
});

test('getPageSlice: halaman di luar rentang dijepit ke halaman terakhir', () => {
    const items = makeIds(45);
    const slice = getPageSlice(items, 99);
    assert.equal(slice.page, 3);
    assert.equal(slice.items.length, 5);
});

test('buildPaginationFooter: tidak ada footer saat total ≤ page size', () => {
    assert.equal(buildPaginationFooter(getPageSlice([], 1)), '');
    assert.equal(buildPaginationFooter(getPageSlice(makeIds(1), 1)), '');
    assert.equal(buildPaginationFooter(getPageSlice(makeIds(20), 1)), '');
});

test('buildPaginationFooter: halaman pertama hanya menampilkan opsi berikutnya', () => {
    const footer = buildPaginationFooter(getPageSlice(makeIds(45), 1), 'jadwal');
    assert.match(footer, /Halaman 1\/3 — total 45 jadwal\./);
    assert.doesNotMatch(footer, /sebelumnya/);
    assert.match(footer, /\*jadwal 2\* untuk halaman berikutnya/);
});

test('buildPaginationFooter: halaman tengah menampilkan keduanya', () => {
    const footer = buildPaginationFooter(getPageSlice(makeIds(45), 2), 'jadwal');
    assert.match(footer, /Halaman 2\/3 — total 45 jadwal\./);
    assert.match(footer, /\*jadwal 1\* untuk halaman sebelumnya/);
    assert.match(footer, /\*jadwal 3\* untuk halaman berikutnya/);
});

test('buildPaginationFooter: halaman terakhir hanya menampilkan opsi sebelumnya', () => {
    const footer = buildPaginationFooter(getPageSlice(makeIds(45), 3), 'jadwal');
    assert.match(footer, /Halaman 3\/3 — total 45 jadwal\./);
    assert.match(footer, /\*jadwal 2\* untuk halaman sebelumnya/);
    assert.doesNotMatch(footer, /berikutnya/);
});

test('buildPaginationFooter: label listCommand bisa disesuaikan (mis. "jadwal semua")', () => {
    const footer = buildPaginationFooter(getPageSlice(makeIds(25), 1), 'jadwal semua');
    assert.match(footer, /\*jadwal semua 2\* untuk halaman berikutnya/);
});

test('parsePageArgument: argumen kosong → halaman 1', () => {
    assert.equal(parsePageArgument(''), 1);
    assert.equal(parsePageArgument('   '), 1);
    assert.equal(parsePageArgument(undefined), 1);
});

test('parsePageArgument: argumen angka valid dikonversi ke integer', () => {
    assert.equal(parsePageArgument('1'), 1);
    assert.equal(parsePageArgument('7'), 7);
});

test('parsePageArgument: argumen non-angka dan ≤0 dianggap invalid', () => {
    assert.equal(parsePageArgument('abc'), null);
    assert.equal(parsePageArgument('2a'), null);
    assert.equal(parsePageArgument('0'), null);
    assert.equal(parsePageArgument('-1'), null);
});

// --- Perilaku pemilihan jadwal lintas halaman ---
// Simulasi: setelah daftar ditampilkan, bot menyimpan `ids` lengkap
// (bukan hanya halaman). `edit N` / `hapus N` memakai index global
// (1..total) sehingga lintas-halaman tetap merujuk jadwal yang benar.

function pickReminderIdByGlobalNumber(allIds, humanNumber) {
    const idx = Number(humanNumber) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= allIds.length) return null;
    return allIds[idx];
}

test('pilih jadwal lintas halaman: nomor global menunjuk id yang benar meskipun pengguna di halaman berbeda', () => {
    const allIds = makeIds(45);

    // Pengguna di halaman 1, memilih nomor 7 (ada di halaman 1).
    assert.equal(pickReminderIdByGlobalNumber(allIds, 7), 'rem-7');

    // Pengguna di halaman 2 (menampilkan item 21..40), memilih nomor 23
    // yang terlihat di layar — tetap merujuk rem-23 (bukan rem-3).
    assert.equal(pickReminderIdByGlobalNumber(allIds, 23), 'rem-23');

    // Pengguna di halaman terakhir (41..45) memilih 42.
    assert.equal(pickReminderIdByGlobalNumber(allIds, 42), 'rem-42');

    // Nomor di luar rentang total ditolak.
    assert.equal(pickReminderIdByGlobalNumber(allIds, 46), null);
    assert.equal(pickReminderIdByGlobalNumber(allIds, 0), null);
});

// --- Simulasi end-to-end tampilan daftar jadwal yang dikirim bot ---
// Meniru fungsi `formatPrivateScheduleList` di index.js: nomor global,
// tanpa menyentuh socket WhatsApp atau I/O.

function renderPrivateScheduleList(reminders, page, groupNames = new Map()) {
    const slice = getPageSlice(reminders, page, SCHEDULE_PAGE_SIZE);
    let body = '📋 *DAFTAR JADWAL BOT*\n\n';
    slice.items.forEach((reminder, offset) => {
        const humanNumber = slice.startIndex + offset + 1;
        const groupName = groupNames.get(reminder.chatId) || reminder.chatId;
        body +=
`${humanNumber}. *${groupName}*
   ⏰ ${reminder.time}
   🔁 ${reminder.recurrence || 'daily'}
   📌 ${reminder.text}

`;
    });
    const footer = buildPaginationFooter(slice, 'jadwal');
    return { slice, body: body.trim(), footer };
}

function makeReminders(n) {
    return Array.from({ length: n }, (_, i) => ({
        id: 1000 + i,
        chatId: 'g@g.us',
        text: `Pesan ${i + 1}`,
        time: '08:00',
        recurrence: 'daily'
    }));
}

test('daftar 0 jadwal: tidak dipanggil renderer, caller mengirim pesan kosong', () => {
    // Perilaku bot: jika reminders kosong, pesan kosong dikirim dan
    // renderer tidak dipanggil. Tes ini memverifikasi kontraknya:
    // getPageSlice tetap valid untuk array kosong tanpa footer.
    const slice = getPageSlice([], 1);
    assert.equal(slice.totalItems, 0);
    assert.equal(buildPaginationFooter(slice, 'jadwal'), '');
});

test('daftar 1 jadwal: nomor 1, tanpa footer', () => {
    const { body, footer } = renderPrivateScheduleList(makeReminders(1), 1);
    assert.match(body, /^1\.\s/m);
    assert.equal(footer, '');
});

test('daftar 20 jadwal: nomor 1..20 di satu halaman, tanpa footer', () => {
    const { body, footer, slice } = renderPrivateScheduleList(makeReminders(20), 1);
    assert.equal(slice.totalPages, 1);
    assert.match(body, /^1\. /m);
    assert.match(body, /^20\. /m);
    assert.equal(footer, '');
});

test('daftar 21 jadwal: halaman 1 nomor 1..20 + footer berikutnya; halaman 2 hanya nomor 21', () => {
    const reminders = makeReminders(21);
    const p1 = renderPrivateScheduleList(reminders, 1);
    assert.equal(p1.slice.totalPages, 2);
    assert.match(p1.body, /^1\. /m);
    assert.match(p1.body, /^20\. /m);
    assert.doesNotMatch(p1.body, /^21\. /m);
    assert.match(p1.footer, /Halaman 1\/2 — total 21 jadwal\./);
    assert.match(p1.footer, /\*jadwal 2\* untuk halaman berikutnya/);
    assert.doesNotMatch(p1.footer, /sebelumnya/);

    const p2 = renderPrivateScheduleList(reminders, 2);
    assert.doesNotMatch(p2.body, /^20\. /m);
    assert.match(p2.body, /^21\. /m);
    assert.match(p2.footer, /Halaman 2\/2 — total 21 jadwal\./);
    assert.match(p2.footer, /\*jadwal 1\* untuk halaman sebelumnya/);
    assert.doesNotMatch(p2.footer, /berikutnya/);
});

test('daftar >40 jadwal (45): halaman pertama, tengah, dan terakhir sesuai spesifikasi', () => {
    const reminders = makeReminders(45);

    const first = renderPrivateScheduleList(reminders, 1);
    assert.equal(first.slice.totalPages, 3);
    assert.match(first.body, /^1\. /m);
    assert.match(first.body, /^20\. /m);
    assert.doesNotMatch(first.body, /^21\. /m);
    assert.match(first.footer, /Halaman 1\/3 — total 45 jadwal\./);
    assert.doesNotMatch(first.footer, /sebelumnya/);
    assert.match(first.footer, /berikutnya/);

    const middle = renderPrivateScheduleList(reminders, 2);
    assert.match(middle.body, /^21\. /m);
    assert.match(middle.body, /^40\. /m);
    assert.doesNotMatch(middle.body, /^20\. /m);
    assert.doesNotMatch(middle.body, /^41\. /m);
    assert.match(middle.footer, /sebelumnya/);
    assert.match(middle.footer, /berikutnya/);

    const last = renderPrivateScheduleList(reminders, 3);
    assert.match(last.body, /^41\. /m);
    assert.match(last.body, /^45\. /m);
    assert.doesNotMatch(last.body, /^46\. /m);
    assert.match(last.footer, /sebelumnya/);
    assert.doesNotMatch(last.footer, /berikutnya/);
});

test('pemilihan jadwal untuk edit/hapus dari halaman berbeda tetap merujuk id yang benar', () => {
    // Simulasi state bot: setelah menampilkan daftar (halaman berapa pun),
    // viewIds berisi SELURUH id dalam urutan daftar. Perintah
    // `edit N` / `hapus N` memakai index 1-based global.
    const reminders = makeReminders(45);
    const viewIds = reminders.map(r => r.id);

    // Simulasi: pengguna di halaman 1 memilih "edit 5" → id ke-5.
    assert.equal(viewIds[5 - 1], reminders[4].id);

    // Simulasi: pengguna pindah ke halaman 2 (lewat `jadwal 2`),
    // melihat jadwal bernomor 21..40, lalu mengetik "hapus 25,27".
    const deleteGlobalNumbers = [25, 27];
    const deletedIds = deleteGlobalNumbers.map(n => viewIds[n - 1]);
    assert.deepEqual(deletedIds, [reminders[24].id, reminders[26].id]);

    // Simulasi: pengguna di halaman terakhir memilih "edit 45".
    assert.equal(viewIds[45 - 1], reminders[44].id);

    // Guard: nomor di luar rentang (46) harus ditolak oleh caller.
    assert.equal(viewIds[46 - 1], undefined);
});

test('pemilihan jadwal dengan nomor dari halaman yang BELUM dibuka pengguna tetap valid', () => {
    // Kebutuhan: index merujuk ke daftar lengkap, bukan hanya ke slice.
    // Ini mencegah bug "edit 23" dieksekusi sebagai jadwal ke-3 di halaman 2.
    const reminders = makeReminders(45);
    const viewIds = reminders.map(r => r.id);
    const sliceP1 = getPageSlice(reminders, 1);
    const sliceP2 = getPageSlice(reminders, 2);

    // Pengguna masih di halaman 1 (slice menampilkan 1..20), tetapi
    // perintah "edit 23" (karena pengguna hafal/ingat screenshot lama)
    // tetap mendapat jadwal ke-23 — bukan error / salah target.
    const chosen = viewIds[23 - 1];
    const atP2 = sliceP2.items[23 - 1 - sliceP2.startIndex];
    assert.equal(chosen, atP2.id,
        'index global 23 harus sama dengan item index 2 di slice halaman 2');
    assert.notEqual(chosen, sliceP1.items[(23 - 1) % 20].id,
        'tidak boleh keliru mengambil item di posisi relatif halaman');
});
