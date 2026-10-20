// migrate.js — one-shot data cleanup untuk Fase C.
// Aman dijalankan berulang (idempotent).
//
// Yang dilakukan:
//   1. report_config.json: buang entri groups yang bukan groupId valid (misal "WORKLIST@g.us")
//   2. points.json: gabungkan user yang key-nya LID ke canonical phone dari users.json (aliases)
//   3. task_occurrences.json: rewrite key completedBy LID → canonical phone
//   4. tasks.json: normalisasi ownerJid ke phone kalau ketemu di users.json

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(process.cwd());
const P = {
    users:       path.join(ROOT, 'users.json'),
    reportCfg:   path.join(ROOT, 'data_phaseC', 'report_config.json'),
    points:      path.join(ROOT, 'data_phaseC', 'points.json'),
    occurrences: path.join(ROOT, 'data_phaseC', 'task_occurrences.json'),
    tasks:       path.join(ROOT, 'data_phaseC', 'tasks.json')
};

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return fallback; }
}
function writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function normalizePhone(value) {
    if (!value) return '';
    let d = String(value).trim().split(':')[0].split('@')[0].replace(/\D/g, '');
    if (d.startsWith('0')) d = `62${d.slice(1)}`;
    return d;
}

function isValidGroupId(v) { return /^[0-9\-]+@g\.us$/.test(String(v || '').trim()); }

// Bangun tabel alias → canonical phone
function buildAliasTable(users) {
    const table = new Map();
    if (!users) return table;
    const walk = (r) => {
        if (typeof r === 'string') {
            const p = normalizePhone(r);
            if (p) table.set(p, p);
            return;
        }
        if (!r) return;
        const phone = normalizePhone(r.phone || r.jid);
        if (!phone) return;
        table.set(phone, phone);
        (r.aliases || []).forEach(a => {
            const n = normalizePhone(a);
            if (n) table.set(n, phone);
        });
    };
    (users.admins || []).forEach(walk);
    (users.users || []).forEach(walk);
    return table;
}

function resolveCanonical(rawId, aliasTable) {
    const norm = normalizePhone(rawId);
    if (!norm) return '';
    if (aliasTable.has(norm)) return aliasTable.get(norm);
    return norm;
}

const users = readJson(P.users, { admins: [], users: [] });
const aliasTable = buildAliasTable(users);

let report = {
    reportCfg_removed: [],
    points_merged: [],
    occurrences_rewritten: 0,
    tasks_owner_migrated: 0
};

// 1. report_config.json
if (fs.existsSync(P.reportCfg)) {
    const cfg = readJson(P.reportCfg, { groups: [], times: [] });
    const before = (cfg.groups || []).length;
    const kept = (cfg.groups || []).filter(g => {
        const ok = isValidGroupId(g.id);
        if (!ok) report.reportCfg_removed.push(g.id);
        return ok;
    });
    if (kept.length !== before) {
        cfg.groups = kept;
        writeJson(P.reportCfg, cfg);
    }
}

// 2. points.json — merge LID keys ke canonical phone
if (fs.existsSync(P.points)) {
    const pts = readJson(P.points, { month: '', users: {} });
    const merged = {};
    for (const [oldKey, rec] of Object.entries(pts.users || {})) {
        const canonical = resolveCanonical(oldKey, aliasTable);
        if (!canonical) continue;
        if (canonical !== oldKey) {
            report.points_merged.push({ from: oldKey, to: canonical });
        }
        if (!merged[canonical]) {
            merged[canonical] = { id: canonical, name: '', points: 0 };
        }
        merged[canonical].points += Number(rec?.points || 0);
        // Nama: kalau nama record adalah just angka LID, jangan dipakai.
        const nm = String(rec?.name || '').trim();
        if (nm && !/^\d{6,}$/.test(nm)) merged[canonical].name = nm;
    }
    // Fallback nama dari users.json
    for (const canonical of Object.keys(merged)) {
        if (merged[canonical].name) continue;
        const findName = (list) => {
            for (const r of (list || [])) {
                if (typeof r === 'string') continue;
                if (!r) continue;
                const phone = normalizePhone(r.phone || r.jid);
                if (phone === canonical) return r.name || '';
                if ((r.aliases || []).some(a => normalizePhone(a) === canonical)) return r.name || '';
            }
            return '';
        };
        merged[canonical].name = findName(users.admins) || findName(users.users) || canonical;
    }
    pts.users = merged;
    writeJson(P.points, pts);
}

// 3. task_occurrences.json — rewrite completedBy keys
if (fs.existsSync(P.occurrences)) {
    const occ = readJson(P.occurrences, {});
    for (const key of Object.keys(occ)) {
        const cb = occ[key].completedBy || {};
        const newCb = {};
        for (const [oldK, name] of Object.entries(cb)) {
            const canonical = resolveCanonical(oldK, aliasTable);
            if (!canonical) continue;
            if (canonical !== oldK) report.occurrences_rewritten++;
            // Nama: kalau nama =~ /^\d{6,}$/ (LID/phone raw), coba ambil dari users.
            let goodName = String(name || '').trim();
            if (!goodName || /^\d{6,}$/.test(goodName)) {
                const scan = (r) => {
                    if (typeof r === 'string') return '';
                    if (!r) return '';
                    const phone = normalizePhone(r.phone || r.jid);
                    if (phone === canonical) return r.name || '';
                    if ((r.aliases || []).some(a => normalizePhone(a) === canonical)) return r.name || '';
                    return '';
                };
                goodName = (users.admins || []).map(scan).find(Boolean)
                        || (users.users || []).map(scan).find(Boolean)
                        || canonical;
            }
            newCb[canonical] = goodName;
        }
        occ[key].completedBy = newCb;
    }
    writeJson(P.occurrences, occ);
}

// 4. tasks.json — normalisasi ownerJid ke phone (kalau alias tercatat)
if (fs.existsSync(P.tasks)) {
    const tasks = readJson(P.tasks, {});
    for (const key of Object.keys(tasks)) {
        const t = tasks[key];
        const canonical = resolveCanonical(t.ownerJid, aliasTable);
        if (canonical && canonical !== normalizePhone(t.ownerJid)) {
            t.ownerJid = canonical;
            report.tasks_owner_migrated++;
        } else if (canonical) {
            t.ownerJid = canonical;
        }
    }
    writeJson(P.tasks, tasks);
}

console.log(JSON.stringify(report, null, 2));
console.log('== migrate.js selesai ==');
