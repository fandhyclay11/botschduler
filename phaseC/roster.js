// phaseC/roster.js
// -------------------------------------------------------------
// Roster user: mapping nomor telepon -> { name, role } plus mapping
// terpisah displayNames: { phone -> name } untuk override tampilan.
//
// Role adalah kode singkat (CIF/SSL/SJL/SCB/SCG). Urutan senioritas
// disimpan sebagai array roles[] di roster.json - index 0 = tertinggi.
//
// Roster ini terpisah dari users.json baseline. users.json = ADMIN/USER
// access control; roster.json = data organisasi untuk laporan grouped.
// Modul ini TIDAK MENULIS ke users.json. Sinkronisasi nama ke users.json
// (bila ada) adalah tanggung jawab pemanggil, mis. phaseD/router.js pada
// jalur AI "rekap user" - bukan tanggung jawab roster.
//
// Alur input tipikal:
//   - upsertMember(phone, name, role): isi/ubah entri roster lengkap.
//   - setDisplayName(phone, name): hanya ubah nama tampilan di
//     displayNames; TIDAK menambahkan role, TIDAK membuat USER baru,
//     TIDAK mengubah role lama. getNameByPhone / getMembersByRole /
//     snapshot poin akan memprioritaskan displayNames bila ada.
// -------------------------------------------------------------

import { FILES, readJson, writeJson, appendLog } from './store.js';

const DEFAULT_ROSTER = {
    roles: ['CIF', 'SSL', 'SJL', 'P.SHIFT', 'SCB', 'SCG'],
    roleLabels: {
        CIF: 'Chief of Store',
        SSL: 'Store Senior Leader',
        SJL: 'Store Junior Leader',
        'P.SHIFT': 'Pimpinan Shift',
        SCB: 'Store Crew Boy',
        SCG: 'Store Crew Girl'
    },
    members: {},
    displayNames: {}
};

// Auto-migrasi roster existing: pastikan P.SHIFT ada + urutan senioritas
// tetap benar (SJL -> P.SHIFT -> SCB). Aman dipanggil berkali-kali.
function migrateRosterShape(data) {
    let changed = false;
    if (!Array.isArray(data.roles)) {
        data.roles = DEFAULT_ROSTER.roles.slice();
        changed = true;
    }
    if (!data.roles.includes('P.SHIFT')) {
        // Sisipkan P.SHIFT setelah SJL kalau ada, kalau tidak sebelum SCB
        const idx = data.roles.indexOf('SJL');
        if (idx >= 0) data.roles.splice(idx + 1, 0, 'P.SHIFT');
        else {
            const scbIdx = data.roles.indexOf('SCB');
            if (scbIdx >= 0) data.roles.splice(scbIdx, 0, 'P.SHIFT');
            else data.roles.push('P.SHIFT');
        }
        changed = true;
    }
    if (!data.roleLabels || typeof data.roleLabels !== 'object') {
        data.roleLabels = { ...DEFAULT_ROSTER.roleLabels };
        changed = true;
    }
    if (!data.roleLabels['P.SHIFT']) {
        data.roleLabels['P.SHIFT'] = 'Pimpinan Shift';
        changed = true;
    }
    if (!data.members || typeof data.members !== 'object') {
        data.members = {};
        changed = true;
    }
    if (!data.displayNames || typeof data.displayNames !== 'object') {
        data.displayNames = {};
        changed = true;
    }
    return { data, changed };
}

function canonicalize(phone, normalizeUserId) {
    return normalizeUserId
        ? normalizeUserId(phone)
        : String(phone || '').replace(/\D/g, '');
}

function displayNameFor(data, canonical) {
    if (!canonical) return '';
    const override = data.displayNames && data.displayNames[canonical];
    if (override && String(override).trim()) return String(override).trim();
    const m = data.members && data.members[canonical];
    return m ? (m.name || '') : '';
}

function loadRoster() {
    const raw = readJson(FILES.roster, DEFAULT_ROSTER);
    const { data, changed } = migrateRosterShape(raw);
    if (changed) {
        writeJson(FILES.roster, data);
        appendLog('ROSTER', 'Migrasi shape roster', 'menambah P.SHIFT / label default');
    }
    return data;
}

function saveRoster(data) {
    writeJson(FILES.roster, data);
}

export function getRoster() {
    return loadRoster();
}

export function getRoles() {
    return loadRoster().roles.slice();
}

export function getRoleLabel(role) {
    const r = loadRoster();
    return r.roleLabels[role] || role;
}

export function isValidRole(role) {
    return loadRoster().roles.includes(String(role || '').toUpperCase());
}

// Cari role untuk canonical phone. Return string kode ('SSL') atau null.
export function getRoleByPhone(phone) {
    if (!phone) return null;
    const r = loadRoster();
    const m = r.members[phone];
    return m ? m.role : null;
}

// Cari nama roster untuk canonical phone. Prioritas:
//   1) displayNames override (bila ada dan non-kosong)
//   2) members[phone].name
//   3) '' (string kosong)
export function getNameByPhone(phone) {
    if (!phone) return '';
    const r = loadRoster();
    return displayNameFor(r, phone);
}

// Peta canonical phone -> nama override saja (tanpa fallback members).
// Dipakai layer poin untuk menimpa snapshot.name tanpa menyentuh file poin.
export function getDisplayNameOverrides() {
    const r = loadRoster();
    const out = {};
    for (const [phone, name] of Object.entries(r.displayNames || {})) {
        const trimmed = String(name || '').trim();
        if (trimmed) out[phone] = trimmed;
    }
    return out;
}

// Set override nama tampilan. TIDAK membuat entri members baru dan
// TIDAK mengubah role existing. Hanya menulis ke roster.json (bukan
// users.json). Return { ok, error?, phone, previous }.
export function setDisplayName(phone, name, normalizeUserId) {
    const canonical = canonicalize(phone, normalizeUserId);
    if (!canonical) return { ok: false, error: 'Nomor tidak valid.' };
    const nm = String(name || '').trim();
    if (!nm) return { ok: false, error: 'Nama kosong.' };

    const r = loadRoster();
    if (!r.displayNames || typeof r.displayNames !== 'object') r.displayNames = {};
    const previous = r.displayNames[canonical] || '';
    if (previous === nm) {
        return { ok: true, phone: canonical, previous, unchanged: true };
    }
    r.displayNames[canonical] = nm;
    saveRoster(r);
    appendLog('ROSTER', 'Display name di-set',
        `phone=${canonical} name=${nm}${previous ? ` (sebelumnya=${previous})` : ''}`);
    return { ok: true, phone: canonical, previous };
}

// Hapus override nama tampilan.
export function clearDisplayName(phone, normalizeUserId) {
    const canonical = canonicalize(phone, normalizeUserId);
    if (!canonical) return { ok: false, error: 'Nomor tidak valid.' };
    const r = loadRoster();
    if (!r.displayNames || !r.displayNames[canonical]) {
        return { ok: false, error: 'Tidak ada nama tampilan untuk nomor ini.' };
    }
    const previous = r.displayNames[canonical];
    delete r.displayNames[canonical];
    saveRoster(r);
    appendLog('ROSTER', 'Display name dihapus', `phone=${canonical} previous=${previous}`);
    return { ok: true, phone: canonical, previous };
}

// Cek: apakah phone terdaftar di roster manapun.
export function isMember(phone) {
    if (!phone) return false;
    return Boolean(loadRoster().members[phone]);
}

// Kelompokkan seluruh roster: { CIF: [...], SSL: [...], ... }
// Nama anggota menggunakan displayNames override bila tersedia.
export function getMembersByRole() {
    const r = loadRoster();
    const grouped = {};
    for (const role of r.roles) grouped[role] = [];
    for (const [phone, m] of Object.entries(r.members)) {
        const role = String(m.role || '').toUpperCase();
        if (!grouped[role]) continue;
        grouped[role].push({
            phone,
            name: displayNameFor(r, phone) || m.name || '',
            role
        });
    }
    return grouped;
}

// Tambah / update satu member. Return { ok, error?, added, updated }.
export function upsertMember(phone, name, role, normalizeUserId) {
    const canonical = normalizeUserId
        ? normalizeUserId(phone)
        : String(phone || '').replace(/\D/g, '');
    if (!canonical) return { ok: false, error: 'Nomor tidak valid.' };
    const nm = String(name || '').trim();
    if (!nm) return { ok: false, error: 'Nama kosong.' };
    const rl = String(role || '').toUpperCase().trim();

    const r = loadRoster();
    if (!r.roles.includes(rl)) {
        return { ok: false, error: `Jabatan tidak dikenal: ${role}. Valid: ${r.roles.join(', ')}` };
    }

    const existed = Boolean(r.members[canonical]);
    r.members[canonical] = {
        phone: canonical,
        name: nm,
        role: rl,
        addedAt: existed ? (r.members[canonical].addedAt || new Date().toISOString()) : new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    saveRoster(r);

    appendLog('ROSTER', existed ? 'Member diperbarui' : 'Member ditambahkan',
        `phone=${canonical} name=${nm} role=${rl}`);
    return { ok: true, added: !existed, updated: existed, phone: canonical };
}

// Hapus member.
export function removeMember(phone, normalizeUserId) {
    const canonical = normalizeUserId
        ? normalizeUserId(phone)
        : String(phone || '').replace(/\D/g, '');
    if (!canonical) return { ok: false, error: 'Nomor tidak valid.' };

    const r = loadRoster();
    if (!r.members[canonical]) return { ok: false, error: 'Member tidak ditemukan.' };
    delete r.members[canonical];
    saveRoster(r);

    appendLog('ROSTER', 'Member dihapus', `phone=${canonical}`);
    return { ok: true };
}
