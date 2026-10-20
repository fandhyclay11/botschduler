// phaseC/roster.js
// -------------------------------------------------------------
// Roster user: mapping nomor telepon → { name, role }.
// Role adalah kode singkat (CIF/SSL/SJL/SCB/SCG). Urutan senioritas
// disimpan sebagai array roles[] di roster.json — index 0 = tertinggi.
//
// Roster ini terpisah dari users.json baseline. users.json = ADMIN/USER
// access control. roster.json = data organisasi untuk laporan grouped.
//
// Alur input: AI parse pesan rekap → array {name, phone, role} →
// upsertMember() batch. Nama dari roster juga disalin ke users.json
// (sebagai entry USER + alias phone) supaya bug LID otomatis reda —
// karena setiap phone di roster otomatis punya display name di users.
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
    members: {}
};

// Auto-migrasi roster existing: pastikan P.SHIFT ada + urutan senioritas
// tetap benar (SJL → P.SHIFT → SCB). Aman dipanggil berkali-kali.
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
    return { data, changed };
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

// Cari nama roster untuk canonical phone. Return string atau ''.
export function getNameByPhone(phone) {
    if (!phone) return '';
    const r = loadRoster();
    const m = r.members[phone];
    return m ? (m.name || '') : '';
}

// Cek: apakah phone terdaftar di roster manapun.
export function isMember(phone) {
    if (!phone) return false;
    return Boolean(loadRoster().members[phone]);
}

// Kelompokkan seluruh roster: { CIF: [...], SSL: [...], ... }
export function getMembersByRole() {
    const r = loadRoster();
    const grouped = {};
    for (const role of r.roles) grouped[role] = [];
    for (const [phone, m] of Object.entries(r.members)) {
        const role = String(m.role || '').toUpperCase();
        if (!grouped[role]) continue;
        grouped[role].push({ phone, name: m.name || '', role });
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
