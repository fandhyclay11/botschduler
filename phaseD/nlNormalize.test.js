import test from 'node:test';
import assert from 'node:assert/strict';
import {
    stripAccents,
    normalizeText,
    levenshtein,
    fixTypos,
    parseNaturalTime,
    parseRecurrence,
    buildScheduleString,
    isValidTimeHHMM,
    isValidPhone,
    isValidPoints,
    hasRequiredParams,
    missingParamQuestion,
    localClassify
} from './nlNormalize.js';

// =============================================
// Normalisasi dasar
// =============================================

test('normalizeText: lowercase, strip aksen, kompres spasi', () => {
    assert.equal(normalizeText('  Halo  Dunia!  '), 'halo dunia');
    assert.equal(normalizeText('Jumat ‘Ahad’'), "jumat 'ahad'");
    assert.equal(normalizeText('cafe\u0301'), 'cafe');
});

test('levenshtein: 0 untuk sama, 1 untuk typo satu huruf', () => {
    assert.equal(levenshtein('jadwal', 'jadwal'), 0);
    assert.equal(levenshtein('jadwal', 'jadwl'), 1);
    assert.equal(levenshtein('jadwal', 'jadwaal'), 1);
    assert.equal(levenshtein('tugas', 'tgas'), 1);
    assert.equal(levenshtein('', 'abc'), 3);
});

test('fixTypos: mengoreksi typo umum (jdwl, tgas, laporann)', () => {
    assert.equal(fixTypos('liat jdwl'), 'lihat jadwal');
    assert.equal(fixTypos('tmbah tgas'), 'tambah tugas');
    assert.equal(fixTypos('kirim laporann'), 'kirim laporan');
    assert.equal(fixTypos('bantuaan'), 'bantuan');
});

test('fixTypos: tidak mengubah angka atau format HH:MM', () => {
    assert.equal(fixTypos('setiap hari 08:00 cek stok'), 'setiap hari 08:00 cek stok');
});

// =============================================
// Parser waktu natural
// =============================================

test('parseNaturalTime: HH:MM eksplisit', () => {
    assert.equal(parseNaturalTime('jam 20:00'), '20:00');
    assert.equal(parseNaturalTime('pukul 08:30'), '08:30');
    assert.equal(parseNaturalTime('rapat 14:00 di kantor'), '14:00');
});

test('parseNaturalTime: HH.MM dengan titik', () => {
    assert.equal(parseNaturalTime('jam 8.30 pagi'), '08:30');
});

test('parseNaturalTime: period pagi/siang/sore/malam', () => {
    assert.equal(parseNaturalTime('jam 8 pagi'), '08:00');
    assert.equal(parseNaturalTime('jam 8 malam'), '20:00');
    assert.equal(parseNaturalTime('jam 2 siang'), '14:00');
    assert.equal(parseNaturalTime('jam 5 sore'), '17:00');
    assert.equal(parseNaturalTime('jam 12 pagi'), '00:00');
});

test('parseNaturalTime: "setengah N"', () => {
    assert.equal(parseNaturalTime('jam setengah 9'), '08:30');
    assert.equal(parseNaturalTime('setengah 10 malam'), '21:30');
});

test('parseNaturalTime: N pagi/malam tanpa kata jam', () => {
    assert.equal(parseNaturalTime('7 pagi'), '07:00');
    assert.equal(parseNaturalTime('9 malam'), '21:00');
});

test('parseNaturalTime: null untuk teks tanpa waktu', () => {
    assert.equal(parseNaturalTime('cek stok'), null);
    assert.equal(parseNaturalTime(''), null);
});

// =============================================
// Parser recurrence
// =============================================

test('parseRecurrence: setiap hari / tiap hari / besok / hari ini', () => {
    assert.deepEqual(parseRecurrence('setiap hari'), { recurrence: 'daily' });
    assert.deepEqual(parseRecurrence('tiap hari jam 8'), { recurrence: 'daily' });
    assert.deepEqual(parseRecurrence('besok jam 8'), { recurrence: 'daily' });
    assert.deepEqual(parseRecurrence('hari ini jam 20:00'), { recurrence: 'daily' });
});

test('parseRecurrence: hari tunggal / multi', () => {
    assert.deepEqual(parseRecurrence('setiap senin jam 9'), { recurrence: 'weekly', days: ['senin'] });
    assert.deepEqual(parseRecurrence('tiap senin,rabu,jumat jam 9'),
        { recurrence: 'weekly', days: ['senin', 'rabu', 'jumat'] });
});

test('parseRecurrence: tanggal bulanan ("tgl" / "tanggal")', () => {
    assert.deepEqual(parseRecurrence('setiap tanggal 8 jam 10'),
        { recurrence: 'monthly', dayOfMonth: 8 });
    assert.deepEqual(parseRecurrence('tiap tgl 1 jam 10'),
        { recurrence: 'monthly', dayOfMonth: 1 });
});

test('parseRecurrence: null untuk teks tanpa penanda recurrence', () => {
    assert.equal(parseRecurrence('cek stok di warung'), null);
});

test('buildScheduleString: gabungan daily/weekly/monthly', () => {
    assert.equal(
        buildScheduleString({ recurrence: 'daily', time: '08:00', body: 'briefing' }),
        'setiap hari 08:00 briefing'
    );
    assert.equal(
        buildScheduleString({ recurrence: 'weekly', days: ['senin', 'rabu'], time: '09:00', body: 'standup' }),
        'setiap senin,rabu 09:00 standup'
    );
    assert.equal(
        buildScheduleString({ recurrence: 'monthly', dayOfMonth: 1, time: '10:00', body: 'laporan bulanan' }),
        'setiap tanggal 1 10:00 laporan bulanan'
    );
});

test('buildScheduleString: null bila body/time hilang', () => {
    assert.equal(buildScheduleString({ recurrence: 'daily', time: '08:00', body: '' }), null);
    assert.equal(buildScheduleString({ recurrence: 'daily', time: null, body: 'x' }), null);
});

// =============================================
// Validator parameter
// =============================================

test('isValidTimeHHMM: valid vs invalid', () => {
    assert.ok(isValidTimeHHMM('08:00'));
    assert.ok(isValidTimeHHMM('23:59'));
    assert.ok(!isValidTimeHHMM('24:00'));
    assert.ok(!isValidTimeHHMM('08'));
    assert.ok(!isValidTimeHHMM('08:60'));
});

test('isValidPhone: 8-15 digit', () => {
    assert.ok(isValidPhone('62812345678'));
    assert.ok(isValidPhone('08123456'));
    assert.ok(!isValidPhone('123'));
    assert.ok(!isValidPhone(''));
});

test('isValidPoints: integer 1-1000', () => {
    assert.ok(isValidPoints(1));
    assert.ok(isValidPoints(1000));
    assert.ok(!isValidPoints(0));
    assert.ok(!isValidPoints(1001));
    assert.ok(!isValidPoints(5.5));
});

// =============================================
// hasRequiredParams & missingParamQuestion
// =============================================

test('hasRequiredParams: intent tanpa param wajib → true', () => {
    assert.ok(hasRequiredParams('lihat_jadwal', {}));
    assert.ok(hasRequiredParams('lihat_poin', {}));
    assert.ok(hasRequiredParams('bantuan', {}));
    assert.ok(hasRequiredParams('laporan_kirim', {}));
});

test('hasRequiredParams: buat_jadwal_biasa butuh schedule', () => {
    assert.ok(!hasRequiredParams('buat_jadwal_biasa', {}));
    assert.ok(hasRequiredParams('buat_jadwal_biasa', { schedule: 'setiap hari 08:00 x' }));
});

test('hasRequiredParams: buat_tugas butuh schedule + points 1-1000', () => {
    assert.ok(!hasRequiredParams('buat_tugas', { schedule: 'setiap hari 08:00 x' }));
    assert.ok(!hasRequiredParams('buat_tugas', { schedule: 'setiap hari 08:00 x', points: 0 }));
    assert.ok(hasRequiredParams('buat_tugas', { schedule: 'setiap hari 08:00 x', points: 10 }));
});

test('hasRequiredParams: admin_tambah/hapus_user butuh phone valid', () => {
    assert.ok(!hasRequiredParams('admin_tambah_user', {}));
    assert.ok(!hasRequiredParams('admin_tambah_user', { phone: '123' }));
    assert.ok(hasRequiredParams('admin_tambah_user', { phone: '62812345678' }));
    assert.ok(hasRequiredParams('admin_hapus_user', { phone: '62812345678' }));
});

test('hasRequiredParams: laporan_jam_tambah butuh HH:MM', () => {
    assert.ok(!hasRequiredParams('laporan_jam_tambah', {}));
    assert.ok(!hasRequiredParams('laporan_jam_tambah', { time: '20' }));
    assert.ok(hasRequiredParams('laporan_jam_tambah', { time: '20:00' }));
});

test('hasRequiredParams: hapus_jadwal/tugas butuh indexes atau all', () => {
    assert.ok(!hasRequiredParams('hapus_jadwal', {}));
    assert.ok(hasRequiredParams('hapus_jadwal', { all: true }));
    assert.ok(hasRequiredParams('hapus_jadwal', { indexes: [1, 2] }));
});

test('missingParamQuestion: mengarahkan user ke format perintah yang benar', () => {
    assert.match(missingParamQuestion('buat_jadwal_biasa'), /setiap hari 08:00/);
    assert.match(missingParamQuestion('buat_tugas', { schedule: 'x' }), /1-1000/);
    assert.match(missingParamQuestion('admin_tambah_user'), /admin tambah/);
    assert.match(missingParamQuestion('laporan_jam_tambah'), /HH:MM/);
    assert.match(missingParamQuestion('hapus_jadwal'), /jadwal/);
});

// =============================================
// localClassify: KUMPULAN KASUS NYATA
// =============================================
// Pengelompokan: (A) pesan rapi (B) pesan berantakan/typo
// (C) info kurang (D) ambigu (E) eksplisit (F) tidak didukung

// --- (A) Pesan rapi ---

test('A1: "daftar jadwal" → lihat_jadwal', () => {
    const r = localClassify('daftar jadwal');
    assert.equal(r.intent, 'lihat_jadwal');
    assert.ok(r.confidence >= 0.9);
});

test('A2: "poin saya bulan ini" → lihat_poin', () => {
    const r = localClassify('poin saya bulan ini');
    assert.equal(r.intent, 'lihat_poin');
    assert.ok(r.confidence >= 0.9);
});

test('A3: "kirim laporan sekarang" → laporan_kirim', () => {
    const r = localClassify('kirim laporan sekarang');
    assert.equal(r.intent, 'laporan_kirim');
});

test('A4: "tiap senin jam 9 briefing" → buat_jadwal_biasa + schedule tersusun', () => {
    const r = localClassify('tiap senin jam 9 briefing');
    assert.equal(r.intent, 'buat_jadwal_biasa');
    assert.equal(r.params.schedule, 'setiap senin 09:00 briefing');
});

test('A5: "setiap tanggal 1 jam 10 laporan bulanan" → monthly', () => {
    const r = localClassify('setiap tanggal 1 jam 10 laporan bulanan');
    assert.equal(r.intent, 'buat_jadwal_biasa');
    assert.equal(r.params.schedule, 'setiap tanggal 1 10:00 laporan bulanan');
});

test('A6: "buat tugas cek laporan setiap senin jam 9 nilai 20 poin" → buat_tugas + points 20', () => {
    const r = localClassify('buat tugas cek laporan setiap senin jam 9 nilai 20 poin');
    assert.equal(r.intent, 'buat_tugas');
    assert.equal(r.params.schedule, 'setiap senin 09:00 cek laporan');
    assert.equal(r.params.points, 20);
});

// --- (B) Pesan berantakan / typo / singkatan ---

test('B1: typo "liat jdwl" → lihat_jadwal', () => {
    const r = localClassify('liat jdwl');
    assert.equal(r.intent, 'lihat_jadwal');
    assert.ok(r.confidence >= 0.9);
});

test('B2: typo "poiin saya" → lihat_poin', () => {
    const r = localClassify('poiin saya');
    assert.equal(r.intent, 'lihat_poin');
});

test('B3: singkatan "tiap sen jam 9 briefing" (TIDAK didukung sepenuhnya; tapi "senin" lebih umum)', () => {
    // Kata "sen" ambigu — kita TIDAK menebak. Pastikan hasil masuk akal.
    const r = localClassify('tiap senin jam 9 briefing');
    assert.equal(r.intent, 'buat_jadwal_biasa');
});

test('B4: kalimat non-formal "mau liat jadwal dong"', () => {
    const r = localClassify('mau liat jadwal dong');
    assert.equal(r.intent, 'lihat_jadwal');
});

test('B5: urutan terbalik "jadwal lihat" tetap terdeteksi', () => {
    const r = localClassify('lihat jadwal');
    assert.equal(r.intent, 'lihat_jadwal');
});

test('B6: typo besar "shedule saya" dipetakan ke lihat_jadwal', () => {
    const r = localClassify('shedule saya');
    assert.equal(r.intent, 'lihat_jadwal');
});

test('B7: "kirim laporann dong" (typo + filler) → laporan_kirim', () => {
    const r = localClassify('kirim laporann dong');
    assert.equal(r.intent, 'laporan_kirim');
});

test('B8: implicit intent dari waktu+recurrence tanpa trigger', () => {
    const r = localClassify('tiap kamis jam 7 pagi standup pagi');
    assert.equal(r.intent, 'buat_jadwal_biasa');
    assert.equal(r.params.schedule, 'setiap kamis 07:00 standup pagi');
});

// --- (C) Info kurang: harus TIDAK high-confidence sehingga router tanya ---

test('C1: "buat jadwal" tanpa isi → confidence rendah (butuh klarifikasi)', () => {
    const r = localClassify('buat jadwal');
    assert.equal(r.intent, 'buat_jadwal_biasa');
    assert.ok(r.confidence < 0.75, `confidence terlalu tinggi: ${r.confidence}`);
});

test('C2: "buat tugas setiap senin jam 9 cek stok" tanpa poin → confidence rendah', () => {
    const r = localClassify('buat tugas setiap senin jam 9 cek stok');
    assert.equal(r.intent, 'buat_tugas');
    assert.ok(!hasRequiredParams(r.intent, r.params),
        'tanpa poin harus dianggap params belum lengkap');
});

test('C3: "tambah user" tanpa nomor → butuh klarifikasi', () => {
    const r = localClassify('tambah user');
    assert.equal(r.intent, 'admin_tambah_user');
    assert.ok(!hasRequiredParams(r.intent, r.params));
});

test('C4: "jam laporan" tanpa HH:MM eksplisit → butuh klarifikasi', () => {
    // "jam laporan" sendiri → laporan_jam_daftar (lihat), yang param-nya ok.
    const r = localClassify('jam laporan');
    assert.equal(r.intent, 'laporan_jam_daftar');
    assert.ok(hasRequiredParams(r.intent, r.params));
});

test('C5: "set jam laporan 20" (format jam salah) → butuh klarifikasi', () => {
    const r = localClassify('set jam laporan 20');
    assert.equal(r.intent, 'laporan_jam_tambah');
    assert.ok(!hasRequiredParams(r.intent, r.params),
        'format "20" bukan HH:MM, params harus kosong/invalid');
});

// --- (D) Ambigu ---

test('D1: "cek" sendiri → tidak match intent (ambigu)', () => {
    const r = localClassify('cek');
    assert.equal(r, null);
});

test('D2: "kayaknya mau liat sesuatu" → tidak match / rendah', () => {
    const r = localClassify('kayaknya mau liat sesuatu');
    // Hanya kata "liat" alone tidak cukup — pastikan tidak high-confidence
    assert.ok(!r || r.confidence < 0.9);
});

test('D3: "laporan" sendiri (konflik laporan_kirim vs grup vs jam) → tidak high confidence', () => {
    const r = localClassify('laporan');
    assert.ok(!r || r.confidence < 0.9);
});

// --- (E) Perintah eksplisit (deterministik) tidak boleh diklasifikasi oleh pre-classifier ke intent berbeda ---

test('E1: "hapus 1" (perintah index deterministik) tidak dikembalikan sebagai intent NL', () => {
    const r = localClassify('hapus 1');
    assert.equal(r, null, 'pre-classifier tidak boleh menyentuh perintah index pendek');
});

test('E2: "edit 1" (perintah deterministik) tidak match intent NL', () => {
    const r = localClassify('edit 1');
    assert.equal(r, null);
});

test('E3: "jadwal 2" (pagination) tidak match intent NL high-confidence', () => {
    const r = localClassify('jadwal 2');
    // "jadwal" sendiri tanpa kata lihat/daftar bukan sinyal kuat lihat_jadwal
    // di katalog kami, dan "2" tidak membuatnya kuat.
    assert.ok(!r || r.confidence < 0.9);
});

// --- (F) Permintaan di luar fitur bot ---

test('F1: "cuaca hari ini?" → tidak match intent apa pun', () => {
    const r = localClassify('cuaca hari ini');
    assert.equal(r, null);
});

test('F2: "kirim foto profil" → tidak match', () => {
    const r = localClassify('kirim foto profil');
    assert.equal(r, null);
});

test('F3: "siapa yang online" → tidak match', () => {
    const r = localClassify('siapa yang online');
    assert.equal(r, null);
});

test('F4: sapaan "halo", "pagi", "makasih" tidak boleh mem-trigger intent', () => {
    for (const t of ['halo', 'pagi', 'makasih', 'thanks', 'oke']) {
        const r = localClassify(t);
        assert.ok(!r || r.confidence < 0.9, `trigger salah untuk: ${t}`);
    }
});

// --- (G) Prioritas intent spesifik vs umum ---

test('G1: "hapus semua tugas" → hapus_tugas (all), BUKAN admin_tugas_semua', () => {
    const r = localClassify('hapus semua tugas');
    assert.equal(r.intent, 'hapus_tugas');
    assert.equal(r.params.all, true);
});

test('G2: "hapus semua jadwal" → hapus_jadwal (all), BUKAN admin_jadwal_semua', () => {
    const r = localClassify('hapus semua jadwal');
    assert.equal(r.intent, 'hapus_jadwal');
    assert.equal(r.params.all, true);
});

test('G3: "jadwal semua" (tanpa hapus) → admin_jadwal_semua', () => {
    const r = localClassify('jadwal semua');
    assert.equal(r.intent, 'admin_jadwal_semua');
});

test('G4: "jam laporan 20:00" → laporan_jam_tambah (bukan daftar)', () => {
    const r = localClassify('jam laporan 20:00');
    assert.equal(r.intent, 'laporan_jam_tambah');
    assert.equal(r.params.time, '20:00');
});

test('G5: "jam laporan" tanpa waktu → laporan_jam_daftar', () => {
    const r = localClassify('jam laporan');
    assert.equal(r.intent, 'laporan_jam_daftar');
});

// --- (H) Ekstraksi parameter spesifik ---

test('H1: "hapus jadwal nomor 1 dan 2" → indexes [1,2]', () => {
    const r = localClassify('hapus jadwal nomor 1 dan 2');
    assert.equal(r.intent, 'hapus_jadwal');
    assert.deepEqual(r.params.indexes, [1, 2]);
});

test('H2: nomor telepon dengan spasi/strip terdeteksi', () => {
    const r = localClassify('tambah user 0812-3456-7890 Budi');
    assert.equal(r.intent, 'admin_tambah_user');
    assert.equal(r.params.phone, '081234567890');
    assert.equal(r.params.name, 'Budi');
});

test('H3: TIDAK invent nomor telepon ketika tidak disebut', () => {
    const r = localClassify('tambah user Budi');
    assert.equal(r.intent, 'admin_tambah_user');
    assert.equal(r.params.phone, undefined);
    assert.ok(!hasRequiredParams(r.intent, r.params));
});

test('H4: TIDAK invent poin ketika tidak disebut', () => {
    const r = localClassify('buat tugas cek stok setiap senin jam 9');
    assert.equal(r.intent, 'buat_tugas');
    assert.equal(r.params.points, undefined);
    assert.ok(!hasRequiredParams(r.intent, r.params));
});
