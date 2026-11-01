// Payload stand-in for server/match/llmGate.js — shipped to `server/match/llmGate.js` by tools/package-client.mjs.
//
// 0.3.1 added the external-AI / LLM release gate, and server/match/Match.js imports it at the top of the module.
// The real file reads the checkout with node:fs / node:path / node:url (`existsSync`, `pathToFileURL`) and top-level
// awaits the external host in a dev checkout — a browser has none of that, so the page could never load the match
// engine. It also imports server/match/llmRelease.js, whose only exports are Node file manipulation.
//
// This is the release build's behaviour, which is what a packaged client is: upstream's own packager deletes the
// external-AI host (server/match/externalAI.js, externalConfig.js, ai/, …) and writes
// `server/release-without-llm`; llmGate then reports the integration as absent and the built-in bot plays. That is
// exactly what this module does, without touching the file system to find out.
//
// Match.js: `createExternalAI(match, opts)` → null, so no external host is ever attached.
// botStrategies.js: `llmIntegrationEnabledNow` is false and `EXTERNAL_BOT` is null → only the built-in strategies.
// Anything that still asks for `validateExternalConfig` throws the same error the upstream release does.

/** One line. No URLs, commands or tokens. */
export const LLM_IGNORED_LOG = '[llm] external AI is development-only and is not in this release; ignoring the external-AI configuration and using the built-in bot';

/** False in a release package — and in this payload, which ships no host. */
export const llmIntegrationEnabledNow = false;

/** Whether this build could load an external host at all (always false here; the parameter keeps the signature). */
export function llmIntegrationEnabled() {
  return false;
}

/** The registered external strategy — none in a release package. */
export const EXTERNAL_BOT = null;

let noted = false;

/** Log the ignore line once. `log.info` when the server has a logger; otherwise the console. */
export function noteLlmIgnored(log) {
  if (noted) return;
  noted = true;
  if (log && typeof log.info === 'function') log.info(LLM_IGNORED_LOG);
  else console.log(LLM_IGNORED_LOG);
}

/** True when a release package was given external-AI / LLM settings that must not take effect. */
export function releaseIgnoresExternalAi(env = (typeof process !== 'undefined' && process.env) || {}) {
  if (llmIntegrationEnabledNow) return false;
  if (env.SP_BOT_STRATEGY === 'external') return true;
  return Object.keys(env).some((key) => (key.startsWith('SP_EXTERNAL_AI_') || key.startsWith('SP_LLM_')) && env[key]);
}

/** Dev only: validate SP_EXTERNAL_AI_* before listen. A release never calls this, and has nothing to validate. */
export function validateExternalConfig() {
  throw new Error('External AI is not in this build');
}

/**
 * Attach the external host when this match selected it. There is no host here, so this is always null
 * (getBotStrategy has already mapped the id back to the built-in bot).
 * @param {{ bot?: { id?: string } }} match
 * @param {{ externalAI?: object, externalReplay?: boolean }} [opts]
 */
export function createExternalAI(match, opts) {
  return null;
}
