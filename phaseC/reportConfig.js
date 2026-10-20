// phaseC/reportConfig.js
// -------------------------------------------------------------
// Konfigurasi grup laporan + jam laporan.
// -------------------------------------------------------------

import { FILES, readJson, writeJson, appendLog } from './store.js';

function loadCfg() {
    return readJson(FILES.reportConfig, { groups: [], times: [] });
}

function saveCfg(cfg) {
    writeJson(FILES.reportConfig, cfg);
}

// -------- REPORT GROUPS --------

export function listReportGroups() {
    return loadCfg().groups.slice();
}

export function addReportGroup(groupId, name = '') {
    const cfg = loadCfg();
    if (cfg.groups.some(g => g.id === groupId)) {
        return { ok: false, error: 'Grup laporan tersebut sudah terdaftar.' };
    }
    cfg.groups.push({ id: groupId, name, addedAt: new Date().toISOString() });
    saveCfg(cfg);
    appendLog('REPORT', 'Report group ditambah', `id=${groupId} name=${name}`);
    return { ok: true };
}

export function removeReportGroup(groupId) {
    const cfg = loadCfg();
    const before = cfg.groups.length;
    cfg.groups = cfg.groups.filter(g => g.id !== groupId);
    if (cfg.groups.length === before) {
        return { ok: false, error: 'Grup laporan tidak ditemukan.' };
    }
    saveCfg(cfg);
    appendLog('REPORT', 'Report group dihapus', `id=${groupId}`);
    return { ok: true };
}

// -------- REPORT TIMES (HH:MM string list) --------

export function listReportTimes() {
    return loadCfg().times.slice().sort();
}

function isValidHHMM(value) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || '').trim());
}

export function addReportTime(hhmm) {
    if (!isValidHHMM(hhmm)) {
        return { ok: false, error: 'Format jam tidak valid. Gunakan HH:MM (24 jam).' };
    }
    const cfg = loadCfg();
    if (cfg.times.includes(hhmm)) {
        return { ok: false, error: 'Jam laporan tersebut sudah terdaftar.' };
    }
    cfg.times.push(hhmm);
    cfg.times.sort();
    saveCfg(cfg);
    appendLog('REPORT', 'Report time ditambah', `hhmm=${hhmm}`);
    return { ok: true };
}

export function removeReportTime(hhmm) {
    const cfg = loadCfg();
    const before = cfg.times.length;
    cfg.times = cfg.times.filter(t => t !== hhmm);
    if (cfg.times.length === before) {
        return { ok: false, error: 'Jam laporan tidak ditemukan.' };
    }
    saveCfg(cfg);
    appendLog('REPORT', 'Report time dihapus', `hhmm=${hhmm}`);
    return { ok: true };
}
