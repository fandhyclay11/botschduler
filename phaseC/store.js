// phaseC/store.js
// -------------------------------------------------------------
// File I/O layer khusus Fase C.
// Data Fase C DIPISAH dari reminders.json / users.json existing.
// Semua write atomic: tulis ke *.tmp lalu rename.
// -------------------------------------------------------------

import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.PHASEC_DATA_DIR || './data_phaseC';

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const FILES = {
    tasks: path.join(DATA_DIR, 'tasks.json'),
    occurrences: path.join(DATA_DIR, 'task_occurrences.json'),
    messageIndex: path.join(DATA_DIR, 'message_index.json'),
    points: path.join(DATA_DIR, 'points.json'),
    reportConfig: path.join(DATA_DIR, 'report_config.json'),
    roster: path.join(DATA_DIR, 'roster.json'),
    taskReminderConfig: path.join(DATA_DIR, 'task_reminder_config.json'),
    logs: path.join(DATA_DIR, 'phaseC.log')
};

function ensureFile(file, defaultValue) {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify(defaultValue, null, 2));
    }
}

ensureFile(FILES.tasks, {});
ensureFile(FILES.occurrences, {});
ensureFile(FILES.messageIndex, {});
ensureFile(FILES.points, { month: '', users: {} });
ensureFile(FILES.reportConfig, { groups: [], times: [] });
ensureFile(FILES.roster, {
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
});
ensureFile(FILES.taskReminderConfig, { enabledGroups: [] });

export function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        console.log(`⚠️ [phaseC] Gagal baca ${file}: ${error.message}`);
        return fallback;
    }
}

export function writeJson(file, data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}

export function appendLog(level, message, extra = '') {
    const line = `[${new Date().toISOString()}] [PHASE-C] [${level}] ${message}${extra ? ` | ${extra}` : ''}\n`;
    try {
        fs.appendFileSync(FILES.logs, line);
    } catch (error) {
        console.log(`⚠️ [phaseC] Gagal tulis log: ${error.message}`);
    }
    console.log(line.trim());
}
