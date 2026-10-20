// phaseC/reactions.js
// -------------------------------------------------------------
// Handler untuk event messages.reaction dari Baileys.
//
// Alur:
// 1. Ambil reaction.key (pesan yang direact) → messageId
// 2. Cek messageIndex → occurrenceKey → occurrence + task
// 3. Cek user canonical (from reaction key/participant)
// 4. Kalau belum tercatat di occurrence.completedBy → +poin & catat
// 5. Kirim konfirmasi HANYA di grup tugas
// 6. Kalau sudah pernah dapat poin untuk occurrence ini → info sudah selesai
//
// Anti-duplikasi key: taskId + date + canonicalUserId (via completedBy map)
// -------------------------------------------------------------

import {
    loadMessageIndex,
    loadOccurrences,
    saveOccurrences,
    loadTasks
} from './tasks.js';
import { addPoints, getPointsSnapshot } from './points.js';
import {
    canonicalFromMessageKey,
    allCandidatesFromMessageKey,
    resolveCanonicalPhone,
    displayNameFromUsers
} from './identity.js';
import { getNameByPhone, isMember } from './roster.js';
import { appendLog } from './store.js';

// Cek apakah canonicalId terlihat seperti LID (bukan phone Indonesia).
// LID WhatsApp: 15+ digit murni, tidak diawali "62". Phone Indonesia
// terkanonisasi selalu diawali "62".
function looksLikeLid(id) {
    if (!id) return false;
    const s = String(id);
    if (!/^\d+$/.test(s)) return false;
    return !s.startsWith('62');
}

// Try resolve LID reactor ke phone via groupMetadata participants.
// Baileys v7 kadang menyertakan participantPn di participant object; kalau
// ketemu match dengan LID, phone-nya dipakai. Fungsi ini best-effort:
// gagal fetch → return null → caller fallback ke behavior lama.
async function resolveLidViaGroupMetadata(ctx, groupChatId, rawCandidates) {
    if (!ctx?.sock?.groupMetadata) return null;
    // Kumpulkan LID-form dari kandidat (misal "112580370682090@lid" atau
    // string 15-digit).
    const lidForms = new Set();
    for (const c of rawCandidates || []) {
        const s = String(c || '');
        if (!s) continue;
        // "xxx@lid"
        const m = s.match(/^(\d+)@lid$/i);
        if (m) lidForms.add(m[1]);
        // digit murni panjang & bukan phone Indo
        else if (/^\d{10,}$/.test(s) && !s.startsWith('62')) lidForms.add(s);
    }
    if (lidForms.size === 0) return null;

    try {
        const meta = await ctx.sock.groupMetadata(groupChatId);
        const participants = Array.isArray(meta?.participants) ? meta.participants : [];
        for (const p of participants) {
            const pLid = String(p?.lid || p?.id || '').replace(/@lid$/i, '').replace(/@.*$/, '');
            if (!pLid || !lidForms.has(pLid)) continue;
            // Kandidat phone di participant
            const phoneCands = [p.phoneNumber, p.jid, p.alt, p.id]
                .map(v => String(v || '').replace(/@.*$/, ''))
                .filter(Boolean);
            for (const pc of phoneCands) {
                const norm = ctx.normalizeUserId(pc);
                if (norm && norm.startsWith('62')) {
                    appendLog('REACT', 'LID resolved via groupMetadata',
                        `lid=${pLid} phone=${norm} group=${groupChatId}`);
                    return norm;
                }
            }
        }
    } catch (error) {
        appendLog('WARN', 'Gagal fetch groupMetadata untuk resolve LID',
            `group=${groupChatId} err=${error?.message || error}`);
    }
    return null;
}

// Baileys mengirim reaction sebagai messages.upsert dengan
// message.reactionMessage ATAU sebagai event 'messages.reaction'.
// Kita handle keduanya lewat ekstraktor tunggal.
function extractReactionInfo(evtItem) {
    // Bentuk 1: dari 'messages.reaction' event
    //   { key, reaction: { key, text, senderTimestampMs } }
    if (evtItem && evtItem.reaction && evtItem.reaction.key) {
        return {
            targetKey: evtItem.reaction.key,
            emoji: evtItem.reaction.text || '',
            reactorKey: evtItem.key || evtItem.reaction.key
        };
    }
    // Bentuk 2: dari 'messages.upsert' dengan reactionMessage embed
    if (evtItem && evtItem.message && evtItem.message.reactionMessage) {
        const rm = evtItem.message.reactionMessage;
        return {
            targetKey: rm.key,
            emoji: rm.text || '',
            reactorKey: evtItem.key
        };
    }
    return null;
}

export async function handleReactionEvent(ctx, evtItem) {
    const info = extractReactionInfo(evtItem);
    if (!info || !info.targetKey || !info.targetKey.id) return;

    // Emoji kosong = un-react → abaikan.
    if (!info.emoji) {
        appendLog('REACT', 'Un-react diabaikan', `msg=${info.targetKey.id}`);
        return;
    }

    const messageId = info.targetKey.id;
    const idx = loadMessageIndex();
    const occurrenceKey = idx[messageId];
    if (!occurrenceKey) return; // bukan pesan tugas

    const occurrences = loadOccurrences();
    const occurrence = occurrences[occurrenceKey];
    if (!occurrence) return;

    const tasks = loadTasks();
    const task = tasks[occurrence.taskId];
    if (!task) return;

    // Resolusi identitas: prefer canonical PHONE dari users.json (via alias),
    // fallback ke normalizeUserId first-candidate.
    const rawCandidates = allCandidatesFromMessageKey(info.reactorKey);
    const users = ctx.loadUsers ? ctx.loadUsers() : null;
    let canonicalId = resolveCanonicalPhone(rawCandidates, users, ctx.normalizeUserId);
    if (!canonicalId) {
        // fallback lama
        canonicalId = canonicalFromMessageKey(info.reactorKey, ctx.normalizeUserId);
    }

    const groupChatId = task.chatId;

    // Kalau canonical masih terlihat LID (bukan phone Indo), coba resolve via
    // groupMetadata → nyari participant yg LID-nya matching + ambil phone-nya.
    if (looksLikeLid(canonicalId)) {
        const resolved = await resolveLidViaGroupMetadata(ctx, groupChatId, rawCandidates);
        if (resolved) canonicalId = resolved;
    }

    if (!canonicalId) {
        appendLog('REACT', 'Canonical id kosong, reaction diabaikan',
            `msg=${messageId} raw=${JSON.stringify(info.reactorKey)}`);
        return;
    }

    // Reactor adalah bot sendiri? skip.
    const botCanonical = ctx.normalizeUserId(
        (ctx.sock?.user?.id || '').split(':')[0].split('@')[0]
    );
    if (botCanonical && canonicalId === botCanonical) return;

    // Nama tampilan: (1) roster → (2) users.json → (3) participant grup → (4) canonicalId
    let displayName = getNameByPhone(canonicalId);
    if (!displayName) {
        displayName = displayNameFromUsers(canonicalId, users, ctx.normalizeUserId);
    }
    if (!displayName) {
        displayName = await ctx.getDisplayName(canonicalId, groupChatId, rawCandidates).catch(() => '');
    }
    if (!displayName) displayName = canonicalId;

    // Anti-duplikasi: sudah pernah selesai untuk occurrence ini?
    if (occurrence.completedBy && occurrence.completedBy[canonicalId]) {
        // Anti-spam: pesan peringatan cuma dikirim SEKALI per user per occurrence.
        if (!occurrence.notified) occurrence.notified = {};
        if (occurrence.notified[canonicalId]) {
            // sudah pernah diingatkan → diam saja
            return;
        }
        occurrence.notified[canonicalId] = true;
        saveOccurrences(occurrences);

        try {
            await ctx.sock.sendMessage(groupChatId, {
                text: `ℹ️ ${occurrence.completedBy[canonicalId] || displayName} sudah menyelesaikan tugas ini sebelumnya.`,
            }, {
                quoted: {
                    key: info.targetKey,
                    message: {
                        conversation: task.text || 'Tugas'
                    }
                }
            });
        } catch (error) {
            appendLog('WARN', 'Gagal kirim info duplikasi', error?.message || error);
        }
        return;
    }

    // Beri poin.
    if (!occurrence.completedBy) occurrence.completedBy = {};
    occurrence.completedBy[canonicalId] = displayName;
    saveOccurrences(occurrences);

    addPoints(canonicalId, displayName, task.points);

    appendLog('REACT',
        `Tugas diselesaikan +${task.points}`,
        `occ=${occurrenceKey} user=${canonicalId} name="${displayName}"`);

    try {
        await ctx.sock.sendMessage(groupChatId, {
            text: `✅ Tugas telah diselesaikan oleh ${displayName}.\n⭐ ${displayName} mendapatkan +${task.points} poin.`,
        }, {
            quoted: {
                key: info.targetKey,
                message: {
                    conversation: task.text || 'Tugas'
                }
            }
        });
    } catch (error) {
        appendLog('WARN', 'Gagal kirim konfirmasi tugas', error?.message || error);
    }

    // Sentuh snapshot poin biar auto-reset bulan tetap konsisten
    getPointsSnapshot();
}
