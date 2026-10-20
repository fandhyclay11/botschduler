// phaseD/client.js
// -------------------------------------------------------------
// HTTP client OpenAI-compatible. Zero deps (pakai global fetch Node 18+).
// - Timeout per request (default dari config)
// - Retry ringan (1 kali) untuk network hiccup
// - Return {ok, text, raw} — caller cek ok sebelum pakai text
// - JSON mode helper: chatJSON() minta model reply strict JSON
// -------------------------------------------------------------

import { getAIConfig, describeConfig } from './config.js';
import fs from 'fs';
import path from 'path';

const LOG_FILE = path.resolve('./data_phaseC/phaseD.log');

function log(level, msg, extra = '') {
    const line = `[${new Date().toISOString()}] [PHASE-D] [${level}] ${msg}${extra ? ` | ${extra}` : ''}\n`;
    try { fs.appendFileSync(LOG_FILE, line); } catch {}
    console.log(line.trim());
}

async function withTimeout(promise, ms) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    try {
        return { ok: true, value: await promise(controller.signal) };
    } catch (err) {
        return { ok: false, error: err };
    } finally {
        clearTimeout(t);
    }
}

// Panggilan tunggal ke /chat/completions
async function callOnce(cfg, body) {
    const url = `${cfg.baseUrl}/chat/completions`;
    const doFetch = (signal) => fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {})
        },
        body: JSON.stringify(body),
        signal
    }).then(async (res) => {
        const raw = await res.text();
        if (!res.ok) {
            const err = new Error(`HTTP ${res.status} ${res.statusText}: ${raw.slice(0, 200)}`);
            err.status = res.status;
            throw err;
        }
        try {
            return JSON.parse(raw);
        } catch {
            const err = new Error(`Response bukan JSON: ${raw.slice(0, 200)}`);
            throw err;
        }
    });

    return withTimeout(doFetch, cfg.timeoutMs);
}

// Chat lengkap: 1 retry, semua exception ditangkap.
export async function chat(messages, opts = {}) {
    const cfg = getAIConfig();
    if (!cfg.enabled) {
        return { ok: false, reason: 'disabled', text: '', status: null };
    }
    if (!cfg.baseUrl || !cfg.model) {
        return { ok: false, reason: 'incomplete-config', text: '', status: null };
    }

    const body = {
        model: cfg.model,
        messages,
        temperature: opts.temperature ?? 0.8,
        max_tokens: opts.maxTokens ?? 400,
        ...(opts.responseFormat ? { response_format: opts.responseFormat } : {})
    };

    let lastStatus = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        const r = await callOnce(cfg, body);
        if (r.ok) {
            const content = r.value?.choices?.[0]?.message?.content || '';
            if (!content) {
                log('WARN', 'Response kosong', `attempt=${attempt}`);
                continue;
            }
            log('OK', `chat sukses`, `attempt=${attempt} chars=${content.length}`);
            return { ok: true, text: content, raw: r.value, status: 200 };
        }
        log('RETRY', `chat gagal attempt ${attempt}`, r.error?.message || r.error);
        // Simpan status HTTP agar chatJSON bisa melakukan fallback khusus
        // ketika provider tidak mendukung response_format.
        lastStatus = r.error?.status || null;
        // Kalau error 4xx (bukan network / rate limit), skip retry
        if (r.error?.status && r.error.status >= 400 && r.error.status < 500 && r.error.status !== 429) {
            break;
        }
    }
    return { ok: false, reason: 'call-failed', text: '', status: lastStatus };
}

// Helper: minta model reply strict JSON, parse otomatis.
// Kalau parse gagal, coba ambil substring pertama yang tampak JSON.
export async function chatJSON(messages, opts = {}) {
    // Mode utama: JSON response_format.
    let r = await chat(messages, { ...opts, responseFormat: { type: 'json_object' } });

    // Beberapa provider OpenAI-compatible (termasuk gateway/router tertentu)
    // menolak response_format dengan HTTP 400. Jangan matikan D2 hanya karena
    // fitur JSON mode tidak tersedia: ulangi tanpa response_format dan parser
    // lokal di bawah tetap memvalidasi/mengambil JSON dari teks model.
    if (!r.ok && r.status === 400) {
        log('WARN', 'Provider menolak response_format; retry tanpa JSON mode');
        r = await chat(messages, { ...opts, responseFormat: undefined });
    }

    if (!r.ok) return { ok: false, reason: r.reason, data: null, status: r.status };

    // Coba parse langsung
    try {
        return { ok: true, data: JSON.parse(r.text) };
    } catch {}

    // Fallback: extract JSON block dari respons yang berantakan
    const match = r.text.match(/\{[\s\S]*\}/);
    if (match) {
        try {
            return { ok: true, data: JSON.parse(match[0]) };
        } catch {}
    }

    log('WARN', 'chatJSON gagal parse', r.text.slice(0, 200));
    return { ok: false, reason: 'parse-failed', data: null, text: r.text };
}

// Sanity ping — untuk verifikasi setup config.
export async function pingAI() {
    log('INFO', 'ping start', describeConfig());
    const r = await chat([
        { role: 'system', content: 'Reply with exactly the word: PONG' },
        { role: 'user', content: 'ping' }
    ], { maxTokens: 10, temperature: 0 });
    log('INFO', 'ping result', `ok=${r.ok} text=${(r.text || '').slice(0, 40)}`);
    return r;
}

export { log as phaseDLog };
