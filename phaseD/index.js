// phaseD/index.js — umbrella export untuk Fase D
export * as phaseDConfig from './config.js';
export * as phaseDClient from './client.js';
export * as phaseDRoasting from './roasting.js';
export * as phaseDIntent from './nlIntent.js';
export * as phaseDRouter from './router.js';

// Convenience re-exports
export { getAIConfig, describeConfig } from './config.js';
export { chat as aiChat, chatJSON as aiChatJSON, pingAI, phaseDLog } from './client.js';
export { generateRoasting } from './roasting.js';
export { classifyIntent } from './nlIntent.js';
export {
    dispatchIntent,
    hasPendingConfirm,
    handlePendingConfirm,
    hasPendingGroupChoice,
    handlePendingGroupChoice
} from './router.js';
