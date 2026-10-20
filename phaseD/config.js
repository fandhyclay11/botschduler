// phaseD/config.js
// -------------------------------------------------------------
// Config AI untuk Fase D. Dibaca dari (urut prioritas):
//   1. Environment variables
//   2. ./ai-config.json di root project
//   3. Default (disabled)
//
// Env vars yang dikenali:
//   AI_BASE_URL    — endpoint OpenAI-compatible (misal http://localhost:8080/v1)
//   AI_API_KEY     — bearer token
//   AI_MODEL       — nama model
//   AI_TIMEOUT_MS  — timeout per request (default 12000)
//   AI_ENABLED     — "true" / "false" (override; default: true kalau baseUrl+model ada)
//
// Kalau enabled=false, semua path AI otomatis fallback ke logic lokal.
// -------------------------------------------------------------

import fs from 'fs';
import path from 'path';

const CFG_FILE = path.resolve('./ai-config.json');

function fromEnv() {
    return {
        baseUrl: process.env.AI_BASE_URL || '',
        apiKey: process.env.AI_API_KEY || '',
        model: process.env.AI_MODEL || '',
        timeoutMs: Number(process.env.AI_TIMEOUT_MS || 0) || null,
        enabled: process.env.AI_ENABLED
    };
}

function fromFile() {
    if (!fs.existsSync(CFG_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    } catch (e) {
        console.log(`⚠️ [phaseD] Gagal parse ai-config.json: ${e.message}`);
        return {};
    }
}

// Merge env dulu, lalu file untuk field yang kosong.
export function getAIConfig() {
    const env = fromEnv();
    const file = fromFile();

    const baseUrl = env.baseUrl || file.baseUrl || '';
    const apiKey = env.apiKey || file.apiKey || '';
    const model = env.model || file.model || '';
    const timeoutMs = env.timeoutMs || file.timeoutMs || 12000;

    let enabled;
    if (env.enabled === 'true') enabled = true;
    else if (env.enabled === 'false') enabled = false;
    else if (typeof file.enabled === 'boolean') enabled = file.enabled;
    else enabled = Boolean(baseUrl && model); // auto: aktif jika minimal baseUrl+model ada

    return {
        baseUrl: baseUrl.replace(/\/+$/, ''),
        apiKey,
        model,
        timeoutMs,
        enabled
    };
}

// Untuk logging aman (jangan expose apiKey utuh).
export function describeConfig() {
    const c = getAIConfig();
    const mask = (s) => s ? `${s.slice(0, 4)}…${s.slice(-3)}` : '(kosong)';
    return `enabled=${c.enabled} baseUrl=${c.baseUrl || '(kosong)'} model=${c.model || '(kosong)'} key=${mask(c.apiKey)} timeout=${c.timeoutMs}ms`;
}
