// smoke.test.js — verifikasi Fase C dapat di-import & operasi dasar berjalan.
// TIDAK menyalakan bot; hanya sanity check module-level.

import * as phaseC from './phaseC/index.js';
import {
    loadTasks, saveTasks, markReminderAsTask, isTask, removeTaskMeta,
    recordTaskDelivery, loadOccurrences, loadMessageIndex
} from './phaseC/tasks.js';
import { addPoints, getPointsSnapshot, getLeaderboard } from './phaseC/points.js';
import {
    listReportGroups, addReportGroup, removeReportGroup,
    listReportTimes, addReportTime, removeReportTime
} from './phaseC/reportConfig.js';
import { buildRoasting } from './phaseC/roasting.js';

console.log('== import ok ==');
console.log('phaseC keys:', Object.keys(phaseC).sort().join(', '));

// 1. Task lifecycle
const fakeReminder = { id: 999999, chatId: '120000@g.us', ownerJid: '62811' };
markReminderAsTask(fakeReminder, 10, fakeReminder.ownerJid);
console.log('isTask(999999) =', isTask(999999));

recordTaskDelivery({ reminderId: 999999, date: '2026-09-09', messageId: 'MSG_TEST_1' });
const occ = loadOccurrences();
const idx = loadMessageIndex();
console.log('occurrence entry present?', Boolean(occ['999999:2026-09-09']));
console.log('message index entry?', idx['MSG_TEST_1']);

// 2. Points
addPoints('62811', 'Budi', 25);
addPoints('62822', 'Siti', 40);
addPoints('62811', 'Budi', 15); // Budi total 40
const snap = getPointsSnapshot();
console.log('points snapshot month =', snap.month);
console.log('users =', JSON.stringify(snap.users));

const lb = getLeaderboard();
console.log('leaderboard =', lb.map(e => `${e.name}:${e.points}`).join(', '));

const lbFiltered = getLeaderboard(['62811']); // filter hanya Budi
console.log('leaderboard filtered (only 62811) =',
    lbFiltered.map(e => `${e.name}:${e.points}`).join(', '));

// 3. Report config
console.log('addReportGroup =', addReportGroup('120001@g.us', 'Grup Laporan A'));
console.log('addReportGroup dup =', addReportGroup('120001@g.us', 'Grup Laporan A'));
console.log('addReportTime =', addReportTime('14:00'));
console.log('addReportTime bad =', addReportTime('25:99'));
console.log('report groups =', listReportGroups().map(g => g.name));
console.log('report times =', listReportTimes());
console.log('removeReportGroup =', removeReportGroup('120001@g.us'));
console.log('removeReportTime =', removeReportTime('14:00'));

// 4. Roasting non-empty
const roast = buildRoasting([
    { id: 'a', name: 'A', points: 100 },
    { id: 'b', name: 'B', points: 80 },
    { id: 'c', name: 'C', points: 30 }
]);
console.log('roast sample =', roast.replace(/\n/g, ' | '));

// 5. Cleanup task meta (jangan tinggalkan garbage)
removeTaskMeta(999999);
console.log('cleanup done, isTask(999999) =', isTask(999999));

console.log('== ALL SMOKE OK ==');
