import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent } from './nlIntent.js';
import { getAIConfig } from './config.js';

// Test ini hanya memverifikasi JALUR LOKAL dari classifyIntent — tanpa
// memanggil layanan AI eksternal. classifyIntent memiliki short-circuit:
// jika pre-classifier lokal yakin >= 0.9, hasilnya dikembalikan tanpa
// menyentuh network. Jika AI tidak dikonfigurasi, `chatJSON` otomatis
// mengembalikan { ok: false, reason: 'incomplete-config' } sehingga
// classifyIntent fallback ke lokal.

test('classifyIntent: pesan high-confidence lokal langsung sumber=local', async () => {
    const r = await classifyIntent('daftar jadwal');
    assert.ok(r, 'tidak null');
    assert.equal(r.intent, 'lihat_jadwal');
    assert.equal(r.source, 'local');
    assert.ok(r.confidence >= 0.9);
});

test('classifyIntent: typo "liat jdwl" tetap dikenali', async () => {
    const r = await classifyIntent('liat jdwl');
    assert.ok(r);
    assert.equal(r.intent, 'lihat_jadwal');
});

test('classifyIntent: schedule dari natural language dengan sinonim', async () => {
    const r = await classifyIntent('tiap senin jam 9 briefing');
    assert.ok(r);
    assert.equal(r.intent, 'buat_jadwal_biasa');
    // params.schedule mungkin diisi oleh pre-classifier atau diminta klarifikasi.
    assert.ok(r.params.schedule === 'setiap senin 09:00 briefing' || r.confidence < 0.75);
});

test('classifyIntent: input kosong atau non-string → null', async () => {
    assert.equal(await classifyIntent(''), null);
    assert.equal(await classifyIntent(null), null);
    assert.equal(await classifyIntent(123), null);
});

test('classifyIntent: tanpa AI config, fallback lokal untuk pesan yang jelas', async () => {
    const cfg = getAIConfig();
    // Kalau AI enabled, test ini menjadi integrasi dengan AI. Kita hanya
    // meng-assert jalur lokal — pastikan tidak melempar.
    const r = await classifyIntent('poin saya');
    if (cfg.enabled) {
        // AI aktif: jawaban bisa dari AI, yang penting valid.
        assert.ok(r);
        assert.ok(['lihat_poin', 'unknown', 'bantuan'].includes(r.intent));
    } else {
        assert.ok(r);
        assert.equal(r.intent, 'lihat_poin');
        assert.equal(r.source, 'local');
    }
});

test('classifyIntent: param wajib hilang → confidence di-cap, missingParams=true', async () => {
    // "buat tugas setiap senin jam 9 cek stok" — no points
    const r = await classifyIntent('buat tugas setiap senin jam 9 cek stok');
    // Pre-classifier lokal sudah memberi conf 0.75 untuk buat_tugas tanpa poin,
    // tapi finalize() akan menurunkannya ke <= 0.6 karena hasRequiredParams false.
    assert.ok(r);
    assert.equal(r.intent, 'buat_tugas');
    assert.ok(r.confidence <= 0.6, `confidence terlalu tinggi: ${r.confidence}`);
    assert.equal(r.missingParams, true);
});

test('classifyIntent: pesan sapaan / off-topic', async () => {
    // Hanya cek tidak melempar dan tidak mengklaim intent tinggi
    for (const t of ['halo', 'pagi', 'makasih', 'cuaca hari ini?']) {
        const r = await classifyIntent(t);
        // r boleh null atau unknown atau low-conf
        if (r) {
            assert.ok(r.confidence < 0.9,
                `pesan "${t}" tidak boleh high-confidence (${r.intent}@${r.confidence})`);
        }
    }
});

test('classifyIntent: "hapus semua tugas" prioritas hapus_tugas (bukan admin_tugas_semua)', async () => {
    const r = await classifyIntent('hapus semua tugas');
    assert.ok(r);
    assert.equal(r.intent, 'hapus_tugas');
    assert.equal(r.params.all, true);
});

test('classifyIntent: "jam laporan 20:00" → laporan_jam_tambah', async () => {
    const r = await classifyIntent('jam laporan 20:00');
    assert.ok(r);
    assert.equal(r.intent, 'laporan_jam_tambah');
    assert.equal(r.params.time, '20:00');
});
