// phaseD/nlNormalize.js
// -------------------------------------------------------------
// Pre-classifier lokal untuk pemahaman natural language yang
// deterministik, zero-network, dan tanpa mengirim data ke LLM.
//
// Pre-classifier ini WAJIB konservatif: hanya return intent
// kalau yakin >= 0.9. Jika kurang yakin, caller fallback ke
// AI. Jika AI juga tidak yakin, router akan minta klarifikasi.
//
// Fitur utama:
//   1. Normalisasi teks (lowercase, strip aksen, trim spasi berlebih).
//   2. Kamus sinonim/singkatan: variasi kata umum → kanonikal.
//   3. Levenshtein distance 1 untuk typo pendek (jadwl → jadwal).
//   4. Parser waktu natural: "jam 8 pagi", "setengah 9", "20:30", "pukul 8".
//   5. Parser recurrence: "setiap hari / tiap senin / tgl 1".
//   6. Validator parameter: HH:MM, nomor telepon, points.
//   7. Intent detector dengan localConfidence (0..1).
//
// Semua function PURE (tanpa I/O network/filesystem) agar bisa
// di-unit-test tanpa dependency eksternal.
// -------------------------------------------------------------

// ---- Konstanta kamus ----

const WEEKDAY_WORDS = {
    minggu: 'minggu', ahad: 'minggu', mgu: 'minggu', mg: 'minggu',
    senin: 'senin', sen: 'senin', snn: 'senin',
    selasa: 'selasa', sel: 'selasa', slsa: 'selasa',
    rabu: 'rabu', rab: 'rabu', rb: 'rabu',
    kamis: 'kamis', kam: 'kamis', kms: 'kamis',
    jumat: 'jumat', 'jum\'at': 'jumat', jmt: 'jumat', jum: 'jumat', jmat: 'jumat',
    sabtu: 'sabtu', sab: 'sabtu', sbt: 'sabtu'
};

// Kata-kunci (sudah dinormalisasi) → intent calon.
// Ini bukan daftar lengkap — hanya SINYAL YANG JELAS.
const INTENT_KEYWORDS = {
    buat_jadwal_biasa: [
        'buat jadwal', 'buatkan jadwal', 'bikin jadwal', 'bikinkan jadwal',
        'tambah jadwal', 'tambahkan jadwal', 'jadwalkan', 'jadwal baru',
        'set jadwal', 'atur jadwal', 'reminder', 'pengingat', 'ingatkan',
        'remind'
    ],
    buat_tugas: [
        'buat tugas', 'buatkan tugas', 'bikin tugas', 'bikinkan tugas',
        'tambah tugas', 'tambahkan tugas', 'tugas baru', 'jadikan tugas',
        'set tugas', 'buat task', 'bikin task'
    ],
    lihat_jadwal: [
        'lihat jadwal', 'liat jadwal', 'daftar jadwal', 'list jadwal',
        'jadwal saya', 'jadwalku', 'show jadwal', 'tampilkan jadwal'
    ],
    admin_jadwal_semua: [
        'jadwal semua', 'semua jadwal', 'daftar jadwal semua',
        'liat jadwal semua', 'lihat jadwal semua', 'tampilkan semua jadwal'
    ],
    lihat_tugas: [
        'lihat tugas', 'liat tugas', 'daftar tugas', 'list tugas',
        'tugas saya', 'tugasku', 'tampilkan tugas', 'show tugas'
    ],
    admin_tugas_semua: [
        'tugas semua', 'semua tugas', 'daftar tugas semua',
        'liat tugas semua', 'lihat tugas semua'
    ],
    lihat_poin: [
        'poin', 'point', 'skor', 'score', 'leaderboard', 'peringkat',
        'poin saya', 'poin bulan ini', 'poinku', 'pointku', 'ranking'
    ],
    hapus_jadwal: [
        'hapus jadwal', 'hapus semua jadwal', 'batalkan jadwal', 'batal jadwal',
        'delete jadwal', 'remove jadwal', 'buang jadwal'
    ],
    hapus_tugas: [
        'hapus tugas', 'hapus semua tugas', 'batalkan tugas',
        'delete tugas', 'buang tugas', 'remove tugas'
    ],
    bantuan: [
        'bantuan', 'help', 'menu', 'daftar perintah', 'list perintah',
        'perintah apa', 'command apa', 'cara pakai', 'cara makai', 'how to',
        'apa aja fiturnya', 'apa saja fiturnya'
    ],
    admin_tambah_user: [
        'tambah user', 'tambahkan user', 'daftarkan user', 'add user',
        'register user', 'buat user'
    ],
    admin_hapus_user: [
        'hapus user', 'buang user', 'remove user', 'delete user',
        'cabut user', 'keluarkan user'
    ],
    admin_lihat_user: [
        'daftar user', 'list user', 'lihat user', 'liat user',
        'semua user', 'siapa saja user', 'tampilkan user',
        'daftar admin', 'siapa admin'
    ],
    laporan_kirim: [
        'kirim laporan', 'send laporan', 'laporan sekarang',
        'kirim rekap', 'kirim leaderboard', 'blast laporan'
    ],
    laporan_grup_daftar: [
        'daftar grup laporan', 'list grup laporan', 'grup laporan',
        'liat grup laporan', 'lihat grup laporan'
    ],
    laporan_jam_daftar: [
        'daftar jam laporan', 'list jam laporan', 'jam laporan',
        'liat jam laporan', 'lihat jam laporan'
    ],
    laporan_jam_tambah: [
        'tambah jam laporan', 'set jam laporan', 'jadwalkan laporan',
        'atur jam laporan', 'tambahkan jam laporan'
    ]
};

// Typo umum → kanonikal (digunakan setelah normalisasi dasar).
const TYPO_FIXES = {
    jadwl: 'jadwal', jdwl: 'jadwal', jadwal2: 'jadwal', jdwal: 'jadwal',
    shedule: 'jadwal', schedule: 'jadwal', skedul: 'jadwal',
    tgas: 'tugas', tgs: 'tugas', tgsk: 'tugas', tgaz: 'tugas',
    laporann: 'laporan', lapoan: 'laporan', lapran: 'laporan',
    lporan: 'laporan', rekp: 'rekap',
    poiin: 'poin', pin: 'poin', poen: 'poin',
    tmbah: 'tambah', tambh: 'tambah', tmbh: 'tambah',
    hps: 'hapus', hapuss: 'hapus', hpus: 'hapus',
    bantu: 'bantuan', bantuaan: 'bantuan',
    liaht: 'lihat', liht: 'lihat', lhat: 'lihat'
};

// ---- Normalisasi dasar ----

export function stripAccents(input) {
    return String(input || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function normalizeText(input) {
    const raw = stripAccents(String(input || ''))
        .toLowerCase()
        // Ganti karakter kutip pintar menjadi standar.
        .replace(/[’‘`]/g, "'")
        // Normalisasi punctuation sebagai whitespace, kecuali titik dua
        // (buat jam) dan tanda minus/koma yang dipakai parser.
        .replace(/[?!.;]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return raw;
}

// Levenshtein distance (iteratif, O(m*n)). Dipakai hanya untuk kata pendek.
export function levenshtein(a, b) {
    a = String(a || '');
    b = String(b || '');
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const m = a.length, n = b.length;
    const prev = new Array(n + 1);
    const curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(
                prev[j] + 1,
                curr[j - 1] + 1,
                prev[j - 1] + cost
            );
        }
        for (let j = 0; j <= n; j++) prev[j] = curr[j];
    }
    return prev[n];
}

// Perbaiki typo per-token dengan kamus TYPO_FIXES + Levenshtein 1 untuk
// kata kunci penting (hanya kata >=4 huruf agar tidak terlalu agresif).
const CORE_WORDS = [
    'jadwal', 'tugas', 'laporan', 'poin', 'bantuan', 'menu', 'help',
    'tambah', 'hapus', 'lihat', 'daftar', 'buat', 'batal', 'kirim',
    'edit', 'admin', 'user', 'grup', 'jam', 'tanggal', 'setiap',
    'hari', 'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu',
    'minggu', 'pagi', 'siang', 'sore', 'malam', 'pukul', 'nilai',
    'rekap'
];

export function fixTypos(text) {
    const tokens = normalizeText(text).split(' ');
    const fixed = tokens.map(tok => {
        if (!tok) return tok;
        // Jangan sentuh angka / token yang mengandung ':' atau '-'.
        if (/[\d:\-,]/.test(tok)) return tok;
        if (TYPO_FIXES[tok]) return TYPO_FIXES[tok];
        if (tok.length < 4) return tok;
        for (const core of CORE_WORDS) {
            if (Math.abs(core.length - tok.length) > 1) continue;
            if (core === tok) return tok;
            if (levenshtein(tok, core) === 1) return core;
        }
        return tok;
    });
    return fixed.join(' ').trim();
}

// ---- Parser waktu natural ----

const PERIOD_SHIFT = {
    pagi: 0,     // 1-11 → 1-11
    siang: 12,   // 12-5 → 12-17 (approximation; jam 1 siang = 13)
    sore: 12,
    malam: 12,
    'tgh malam': 0,
    tengah: 0
};

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// Kembalikan "HH:MM" (24h) atau null kalau tidak bisa diinterpretasi.
export function parseNaturalTime(input) {
    if (!input) return null;
    const t = normalizeText(input);

    // 1) Pola "HH:MM" atau "HH.MM" eksplisit
    let m = t.match(/\b(\d{1,2})[:.](\d{2})\b/);
    if (m) {
        const hh = Number(m[1]), mm = Number(m[2]);
        if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
            return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
        }
    }

    // 2) Pola "setengah N" (ID: setengah 9 = 08:30)
    m = t.match(/\b(?:jam|pukul)?\s*(?:setengah|1\/2)\s+(\d{1,2})(?:\s*(pagi|siang|sore|malam))?\b/);
    if (m) {
        let h = Number(m[1]) - 1;
        const period = m[2];
        if (h < 0) h = 23;
        if (period && (period === 'siang' || period === 'sore' || period === 'malam')) {
            if (h < 12) h += 12;
        }
        return `${String(clamp(h, 0, 23)).padStart(2, '0')}:30`;
    }

    // 3) Pola "jam/pukul N (menit M) (pagi/siang/sore/malam)"
    m = t.match(/\b(?:jam|pukul|jm)\s+(\d{1,2})(?:[: .](\d{1,2}))?(?:\s*(pagi|siang|sore|malam))?\b/);
    if (m) {
        let h = Number(m[1]);
        const minPart = m[2] ? Number(m[2]) : 0;
        const period = m[3];
        if (period === 'siang' || period === 'sore' || period === 'malam') {
            if (h >= 1 && h <= 11) h += 12;
        } else if (period === 'pagi') {
            if (h === 12) h = 0;
        }
        if (h >= 0 && h <= 23 && minPart >= 0 && minPart <= 59) {
            return `${String(h).padStart(2, '0')}:${String(minPart).padStart(2, '0')}`;
        }
    }

    // 4) Pola "N pagi/siang/sore/malam" tanpa kata jam
    m = t.match(/\b(\d{1,2})\s+(pagi|siang|sore|malam)\b/);
    if (m) {
        let h = Number(m[1]);
        const period = m[2];
        if (period === 'siang' || period === 'sore' || period === 'malam') {
            if (h >= 1 && h <= 11) h += 12;
        } else if (period === 'pagi' && h === 12) h = 0;
        if (h >= 0 && h <= 23) return `${String(h).padStart(2, '0')}:00`;
    }

    return null;
}

// Parser recurrence dasar — mengembalikan `recurrence` + days + dayOfMonth
// (semuanya opsional). Dipakai untuk membangun ulang schedule string
// dalam grammar bot: "setiap X HH:MM TEKS".
export function parseRecurrence(input) {
    const t = normalizeText(input);

    // "setiap tanggal N" atau "tgl N"
    let m = t.match(/\b(?:setiap\s+)?(?:tanggal|tgl)\s+(\d{1,2})\b/);
    if (m) {
        const d = Number(m[1]);
        if (d >= 1 && d <= 31) return { recurrence: 'monthly', dayOfMonth: d };
    }

    // "hari ini" / "besok" / "setiap hari" → diperlakukan sebagai daily
    // untuk tujuan klasifikasi intent (bot hanya mendukung recurrence).
    // Kata "besok"/"hari ini" diperlakukan sebagai sinyal daily agar user
    // tetap mendapat jadwal; namun pastikan ini diinformasikan di summary
    // konfirmasi sehingga user bisa membatalkan jika niatnya one-shot.
    if (/\b(?:besok|hari\s+ini|nanti|setiap\s+hari|tiap\s+hari)\b/.test(t)) {
        return { recurrence: 'daily' };
    }

    // "setiap <hari>[,<hari>...]" atau "tiap <hari>" atau "<hari> saja"
    m = t.match(/\b(?:setiap|tiap)\s+([a-z\s,']+?)(?=\s+(?:jam|pukul|\d{1,2}[:.]\d{2}|\d{1,2}\s*(?:pagi|siang|sore|malam))|\s*$)/);
    if (m) {
        const chunk = m[1].trim();
        if (chunk === 'hari') return { recurrence: 'daily' };
        const parts = chunk.split(/[,\s]+/).filter(Boolean);
        const days = [];
        for (const p of parts) {
            const canonical = WEEKDAY_WORDS[p];
            if (!canonical) return null;
            if (!days.includes(canonical)) days.push(canonical);
        }
        if (days.length > 0) return { recurrence: 'weekly', days };
    }

    // Hanya hari tanpa "setiap"
    const words = t.split(' ');
    const dayHits = words.filter(w => WEEKDAY_WORDS[w]);
    if (dayHits.length > 0 && dayHits.length === words.filter(w => /^[a-z']+$/.test(w)).length) {
        // Hanya kalau SELURUH kata non-angka adalah hari — mencegah
        // "senin saya libur" diklasifikasi weekly.
        return { recurrence: 'weekly', days: dayHits.map(d => WEEKDAY_WORDS[d]) };
    }

    if (/\bsetiap\s+hari\b/.test(t)) return { recurrence: 'daily' };

    return null;
}

// Bangun schedule string dalam grammar bot dari komponen.
// `body` adalah teks pesan asli (sudah dibersihkan kata-kata trigger).
export function buildScheduleString({ recurrence, days, dayOfMonth, time, body }) {
    if (!time || !body) return null;
    const bodyText = String(body).trim();
    if (!bodyText) return null;
    if (recurrence === 'daily') return `setiap hari ${time} ${bodyText}`;
    if (recurrence === 'weekly' && Array.isArray(days) && days.length > 0) {
        return `setiap ${days.join(',')} ${time} ${bodyText}`;
    }
    if (recurrence === 'monthly' && Number.isInteger(dayOfMonth)) {
        return `setiap tanggal ${dayOfMonth} ${time} ${bodyText}`;
    }
    return null;
}

// ---- Validator parameter ----

export function isValidTimeHHMM(s) {
    if (typeof s !== 'string') return false;
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return false;
    const h = Number(m[1]), mm = Number(m[2]);
    return h >= 0 && h <= 23 && mm >= 0 && mm <= 59;
}

export function isValidPhone(s) {
    if (!s) return false;
    const digits = String(s).replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15;
}

export function isValidPoints(n) {
    const v = Number(n);
    return Number.isInteger(v) && v >= 1 && v <= 1000;
}

// ---- Intent detector lokal ----

// Return { intent, confidence, params, matched, reason } atau null.
// Jika pre-classifier yakin >= 0.9, caller boleh skip AI.
export function localClassify(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return null;
    const normalized = normalizeText(text);
    const fixed = fixTypos(text);

    // Scoring sederhana: setiap keyword yang muncul utuh di `fixed`
    // menambah skor. Intent dengan skor terbesar menang.
    const scores = new Map();
    const hits = new Map();
    for (const [intent, phrases] of Object.entries(INTENT_KEYWORDS)) {
        let score = 0;
        const matched = [];
        for (const phrase of phrases) {
            if (fixed.includes(phrase)) {
                // Frase panjang lebih kuat sinyalnya.
                score += 1 + phrase.split(' ').length * 0.3;
                matched.push(phrase);
            }
        }
        if (score > 0) {
            scores.set(intent, score);
            hits.set(intent, matched);
        }
    }

    // Heuristik implisit: jika ada waktu + recurrence namun TIDAK ada
    // kata trigger apapun, anggap buat_jadwal_biasa (sinyal moderat).
    // Confidence sengaja tidak tinggi — router akan meminta konfirmasi,
    // sehingga user bisa membatalkan jika niatnya bukan membuat jadwal.
    let impliedFromTimeRec = false;
    if (scores.size === 0) {
        const hasTime = Boolean(parseNaturalTime(normalized));
        const hasRec = Boolean(parseRecurrence(normalized));
        if (hasTime && hasRec) {
            scores.set('buat_jadwal_biasa', 1);
            hits.set('buat_jadwal_biasa', ['(waktu+recurrence)']);
            impliedFromTimeRec = true;
        } else {
            return null;
        }
    }

    // Resolusi konflik: intent spesifik mengalahkan intent umum.
    //
    // Prioritas:
    //   - "hapus" + "tugas" + "semua"  →  hapus_tugas { all: true }
    //     (bukan admin_tugas_semua yang hanya melihat)
    //   - "jam laporan HH:MM" (ada waktu) → laporan_jam_tambah (bukan daftar)
    //   - "setiap/tiap/jam/pukul" + intent buat → buat_jadwal_biasa / buat_tugas
    // Kata "hapus" selalu memenangkan terhadap intent lihat/admin_*_semua.
    // Mencegah "hapus semua tugas" diklasifikasi sebagai admin_tugas_semua.
    if (/\bhapus\b|\bbatalkan\b|\bdelete\b|\bbuang\b|\bremove\b/.test(fixed)) {
        if (scores.has('admin_jadwal_semua')) scores.set('admin_jadwal_semua', 0);
        if (scores.has('admin_tugas_semua')) scores.set('admin_tugas_semua', 0);
        if (scores.has('lihat_jadwal') && !scores.has('hapus_jadwal')) scores.set('lihat_jadwal', 0);
        if (scores.has('lihat_tugas') && !scores.has('hapus_tugas')) scores.set('lihat_tugas', 0);
    }
    if (scores.has('laporan_jam_daftar') && parseNaturalTime(normalized)) {
        // Ada jam di pesan → kemungkinan user ingin TAMBAH, bukan LIHAT.
        // Beri boost ke laporan_jam_tambah agar menang.
        const prev = scores.get('laporan_jam_tambah') || 0;
        scores.set('laporan_jam_tambah', prev + 2);
    }

    const SPECIFICITY_RULES = [
        ['admin_jadwal_semua', 'lihat_jadwal'],
        ['admin_tugas_semua', 'lihat_tugas'],
        ['buat_tugas', 'buat_jadwal_biasa'],
        ['hapus_tugas', 'hapus_jadwal'],
        ['laporan_jam_tambah', 'laporan_jam_daftar']
    ];
    for (const [specific, general] of SPECIFICITY_RULES) {
        if (scores.has(specific) && scores.has(general)) {
            scores.set(general, 0);
        }
    }
    if (scores.has('lihat_tugas') && scores.has('lihat_jadwal')) {
        // Kata "tugas" lebih spesifik dari "jadwal".
        scores.set('lihat_jadwal', scores.get('lihat_jadwal') - 0.5);
    }

    // Pilih intent dengan skor tertinggi.
    let bestIntent = null;
    let bestScore = 0;
    for (const [intent, score] of scores) {
        if (score > bestScore) {
            bestScore = score;
            bestIntent = intent;
        }
    }
    if (!bestIntent || bestScore <= 0) return null;

    // Extract parameter sesuai intent.
    const params = {};

    if (bestIntent === 'buat_jadwal_biasa' || bestIntent === 'buat_tugas') {
        const time = parseNaturalTime(normalized);
        const rec = parseRecurrence(normalized);
        if (time && rec) {
            // Isi body = teks tanpa kata trigger / jam / recurrence.
            const body = extractScheduleBody(normalized, { time, recurrence: rec });
            const schedule = buildScheduleString({
                recurrence: rec.recurrence,
                days: rec.days,
                dayOfMonth: rec.dayOfMonth,
                time,
                body
            });
            if (schedule) params.schedule = schedule;
        }
        // Points untuk tugas
        if (bestIntent === 'buat_tugas') {
            const pm = normalized.match(/\b(\d+)\s*(?:poin|point|pts|pt)\b/);
            if (pm) {
                const v = Number(pm[1]);
                if (isValidPoints(v)) params.points = v;
            }
        }
    }

    if (bestIntent === 'hapus_jadwal' || bestIntent === 'hapus_tugas') {
        if (/\bsemua\b/.test(normalized)) params.all = true;
        const nums = Array.from(normalized.matchAll(/\b(\d+)\b/g)).map(x => Number(x[1]));
        const safeNums = nums.filter(n => n >= 1 && n <= 999);
        if (safeNums.length > 0) params.indexes = Array.from(new Set(safeNums));
    }

    if (bestIntent === 'admin_tambah_user' || bestIntent === 'admin_hapus_user') {
        const pm = normalized.match(/\b(\+?\d[\d\s-]{6,}\d)\b/);
        if (pm) {
            const digits = pm[1].replace(/\D/g, '');
            if (isValidPhone(digits)) params.phone = digits;
        }
        if (bestIntent === 'admin_tambah_user' && params.phone) {
            // Ambil nama dari teks SETELAH nomor asli (bukan setelah
            // digit-normalized, karena nomor bisa mengandung '-' / spasi).
            const after = normalized.slice((pm.index || 0) + pm[1].length);
            const name = after.split(/\s+/)
                .filter(w => /^[a-z']+$/.test(w))
                .join(' ')
                .trim();
            if (name) params.name = name.replace(/\b([a-z])/g, (c) => c.toUpperCase());
        }
    }

    if (bestIntent === 'laporan_jam_tambah') {
        const time = parseNaturalTime(normalized);
        if (time) params.time = time;
    }

    // Hitung confidence berbasis skor keyword.
    // Aturan:
    //   - Frasa multi-kata (>=2 kata) yang cocok = sinyal sangat kuat.
    //   - Skor >= 2.5 atau >=1 frasa multi-kata → 0.95.
    //   - 2+ frasa pendek cocok → 0.9.
    //   - Params lengkap tapi sinyal tunggal → 0.75.
    //   - Params belum lengkap → <= 0.65 (router akan tanya).
    const matched = hits.get(bestIntent) || [];
    const multiWordHits = matched.filter(m => m.split(' ').length >= 2).length;
    const paramsOK = hasRequiredParams(bestIntent, params);
    let confidence;
    if (bestScore >= 2.5 && paramsOK) confidence = 0.95;
    else if (multiWordHits >= 1 && paramsOK) confidence = 0.95;
    else if (matched.length >= 2 && paramsOK) confidence = 0.9;
    else if (paramsOK) confidence = 0.75;
    else if (multiWordHits >= 1 || matched.length >= 2) confidence = 0.65;
    else confidence = 0.5;

    // Intent yang hanya tersirat dari waktu+recurrence (tanpa kata kunci
    // eksplisit) selalu masuk mode konfirmasi, bukan auto-exec.
    if (impliedFromTimeRec && paramsOK) {
        confidence = Math.min(confidence, 0.7);
    }

    return {
        intent: bestIntent,
        confidence,
        params,
        matched,
        reason: `local keyword match: ${matched.join(' / ')}`
    };
}

// Cek apakah intent memiliki parameter wajib.
export function hasRequiredParams(intent, params = {}) {
    switch (intent) {
        case 'buat_jadwal_biasa':
            return Boolean(params.schedule);
        case 'buat_tugas':
            return Boolean(params.schedule) && isValidPoints(params.points);
        case 'hapus_jadwal':
        case 'hapus_tugas':
            return Boolean(params.all) || (Array.isArray(params.indexes) && params.indexes.length > 0);
        case 'admin_tambah_user':
            return isValidPhone(params.phone);
        case 'admin_hapus_user':
            return isValidPhone(params.phone);
        case 'laporan_jam_tambah':
            return isValidTimeHHMM(params.time);
        case 'rekap_user':
            return Array.isArray(params.members) && params.members.length > 0;
        default:
            return true; // intent tanpa param wajib
    }
}

// Daftar pertanyaan klarifikasi spesifik — digunakan router saat param
// wajib hilang alih-alih menebak.
export function missingParamQuestion(intent, params = {}) {
    switch (intent) {
        case 'buat_jadwal_biasa':
            return 'Jadwalnya kapan dan isinya apa? Contoh: *setiap hari 08:00 briefing pagi*';
        case 'buat_tugas':
            if (!params.schedule) {
                return 'Jadwal tugasnya kapan dan isinya apa? Contoh: *setiap senin 09:00 cek stok*';
            }
            return 'Berapa poin untuk tugas ini? Balas angka 1-1000.';
        case 'hapus_jadwal':
            return 'Mau hapus jadwal nomor berapa? Ketik *jadwal* dulu untuk melihat daftar, lalu balas *hapus 1* atau *hapus 1,2*.';
        case 'hapus_tugas':
            return 'Mau hapus tugas nomor berapa? Ketik *tugas* dulu untuk melihat daftar, lalu balas *hapus tugas 1* atau *hapus tugas 1,2*.';
        case 'admin_tambah_user':
            return 'Nomor WhatsApp user yang mau ditambah? Contoh: *admin tambah 628123456789 Nama*';
        case 'admin_hapus_user':
            return 'Nomor WhatsApp user yang mau dihapus? Contoh: *admin hapus 628123456789*';
        case 'laporan_jam_tambah':
            return 'Jam laporannya pukul berapa? Format HH:MM, contoh: *laporan jam tambah 20:00*';
        default:
            return 'Mohon lengkapi perintahnya. Ketik *menu* untuk daftar perintah.';
    }
}

// Buang kata trigger & timewords dari teks untuk mendapatkan body isi.
function extractScheduleBody(normalized, { time, recurrence }) {
    let text = normalized;

    // Hapus kata trigger
    const triggers = [
        'buatkan jadwal', 'buat jadwal', 'bikinkan jadwal', 'bikin jadwal',
        'tambah jadwal', 'tambahkan jadwal', 'jadwalkan', 'jadwal baru',
        'set jadwal', 'atur jadwal',
        'buatkan tugas', 'buat tugas', 'bikinkan tugas', 'bikin tugas',
        'tambah tugas', 'tambahkan tugas', 'jadikan tugas', 'tugas baru',
        'buat task', 'bikin task',
        'reminder', 'pengingat', 'ingatkan', 'remind',
        'tolong', 'minta', 'besok', 'hari ini', 'nanti'
    ];
    for (const t of triggers) text = text.replace(new RegExp(`\\b${t}\\b`, 'g'), ' ');

    // Hapus HH:MM / HH.MM
    text = text.replace(/\b\d{1,2}[:.]\d{2}\b/g, ' ');
    // Hapus "jam/pukul N (:M)? (pagi/siang/sore/malam)?"
    text = text.replace(/\b(?:jam|pukul|jm)\s+\d{1,2}(?:[: .]\d{1,2})?(?:\s*(?:pagi|siang|sore|malam))?\b/g, ' ');
    // Hapus "setengah N"
    text = text.replace(/\b(?:setengah|1\/2)\s+\d{1,2}(?:\s*(?:pagi|siang|sore|malam))?\b/g, ' ');
    // Hapus "N pagi/siang/sore/malam"
    text = text.replace(/\b\d{1,2}\s+(?:pagi|siang|sore|malam)\b/g, ' ');

    // Hapus kata recurrence
    if (recurrence?.recurrence === 'daily') {
        text = text.replace(/\bsetiap\s+hari\b/g, ' ').replace(/\btiap\s+hari\b/g, ' ');
    } else if (recurrence?.recurrence === 'weekly') {
        for (const day of recurrence.days || []) {
            text = text.replace(new RegExp(`\\b${day}\\b`, 'g'), ' ');
        }
        text = text.replace(/\bsetiap\b/g, ' ').replace(/\btiap\b/g, ' ');
    } else if (recurrence?.recurrence === 'monthly') {
        text = text.replace(/\b(?:setiap|tiap)?\s*(?:tanggal|tgl)\s+\d{1,2}\b/g, ' ');
        text = text.replace(/\b(?:setiap|tiap)\b/g, ' ');
    }

    // Hapus deklarasi poin (hanya untuk tugas)
    text = text.replace(/\b(?:nilai\s*)?\d+\s*(?:poin|point|pts|pt)\s*/g, ' ');

    // Hapus sisa kata "jam" / "pukul" yang berdiri sendiri.
    text = text.replace(/\b(?:jam|pukul|jm)\b/g, ' ');

    // Hapus kata filler
    const fillers = ['untuk', 'dengan', 'nilai', 'pakai', 'yang', 'please', 'ya', 'dong', 'buat', 'bikin', 'buatkan', 'bikinkan'];
    for (const f of fillers) text = text.replace(new RegExp(`\\b${f}\\b`, 'g'), ' ');

    return text.replace(/\s+/g, ' ').replace(/^[,:\-\s]+|[,:\-\s]+$/g, '').trim();
}
