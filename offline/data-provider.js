// Browser implementation of the game server's server/data.js, for the in-page (offline) server.
//
// server/data.js reads data/*.json synchronously from disk and exposes a process-wide singleton plus id getters.
// A payload has no filesystem, so the same JSON files (mirrored into the payload under /data/) are fetched and
// merged into an equivalent singleton. tools/package-client.mjs generates the payload's /server/data.js from this
// module, so the lobby / match engine import it exactly as they import the server's file.
//
// Contract kept from server/data.js: own-property id lookups (ids can come from client intents), null for unknown
// ids / missing files, deep-frozen data, and the same getter names.

/** Recursively freeze an object graph (iterative; safe for deep JSON). Returns the same object. */
export function deepFreeze(root) {
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const o = stack.pop();
    if (o === null || typeof o !== 'object' || seen.has(o)) continue;
    seen.add(o);
    for (const v of Object.values(o)) if (v !== null && typeof v === 'object') stack.push(v);
    Object.freeze(o);
  }
  return root;
}

/** Data files that are `{ [id]: record }` maps, with the getter name exported for each (server/data.js). */
export const INDEXED_FILES = Object.freeze({
  chess: 'getChess', bonds: 'getBond', garrisons: 'getGarrison', items: 'getItem', bands: 'getBand',
  effects: 'getEffect', enemies: 'getEnemy', waves: 'getWave', stages: 'getStage', bosses: 'getBoss', tokens: 'getToken',
});

const EMPTY = Object.freeze({});

/** Own-property record lookup in a plain-object map; null for anything else. */
function ownRecord(map, id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  if (!map || typeof map !== 'object' || Array.isArray(map) || !Object.hasOwn(map, id)) return null;
  const rec = map[id];
  return rec !== null && typeof rec === 'object' ? rec : null;
}

/**
 * Build a data module with server/data.js' API over one JSON file per name.
 *
 * In the browser it fetches `/data/*.json`; in the Electron main process (the "open to LAN" host) the files are read
 * from disk and injected as `preloaded`, so the same payload module works in both (see desktop/host-server.mjs).
 * @param {{ base?: string, files?: string[], fetchFn?: typeof fetch, preloaded?: object|null,
 *   log?: { warn: Function, error: Function } }} [opts]
 */
export function createDataModule({ base = '/data/', files = [], fetchFn = (...a) => globalThis.fetch(...a), preloaded = null, log = console } = {}) {
  const DATA_FILES = Object.freeze([...files]);
  /** @type {Readonly<Record<string, any>> | null} */
  let singleton = preloaded ? deepFreeze(preloaded) : null;
  let inflight = null;

  /** Fetch every data file once; resolves to the deep-frozen merged object (idempotent). */
  function loadData() {
    if (singleton) return Promise.resolve(singleton);
    if (inflight) return inflight;
    inflight = (async () => {
      const out = {};
      await Promise.all(DATA_FILES.map(async (name) => {
        try {
          const res = await fetchFn(`${base}${name}.json`, { cache: 'no-cache' });
          if (res && res.ok) out[name] = await res.json();
          else log.warn?.(`[data] ${name}.json → ${res ? res.status : 'no response'}`);
        } catch (e) {
          log.warn?.(`[data] skipping ${name}.json: ${e && e.message}`);
        }
      }));
      const missing = DATA_FILES.filter((k) => !(k in out));
      if (missing.length) log.warn?.(`[data] missing data files: ${missing.map((k) => k + '.json').join(', ')}`);
      singleton = deepFreeze(out);
      return singleton;
    })();
    return inflight;
  }

  const getData = () => singleton || EMPTY;
  function resetData() { singleton = null; inflight = null; }

  /** Load synchronously from an already-parsed object (the Node host injects the files it read from disk). */
  function setData(obj) { singleton = obj ? deepFreeze(obj) : null; inflight = null; return singleton; }

  function lookup(file, id, data = getData()) {
    if (!data || typeof data !== 'object' || typeof file !== 'string' || !Object.hasOwn(data, file)) return null;
    return ownRecord(data[file], id);
  }

  const getChess = (id, data) => lookup('chess', id, data);
  const getBond = (id, data) => lookup('bonds', id, data);
  const getGarrison = (id, data) => lookup('garrisons', id, data);
  const getItem = (id, data) => lookup('items', id, data);
  const getBand = (id, data) => lookup('bands', id, data);
  const getEffect = (id, data) => lookup('effects', id, data);
  const getEnemy = (key, data) => lookup('enemies', key, data);
  const getWave = (id, data) => lookup('waves', id, data);
  const getStage = (id, data) => lookup('stages', id, data);
  const getBoss = (id, data) => lookup('bosses', id, data);
  const getToken = (id, data) => lookup('tokens', id, data);

  function getConfig(data = getData()) {
    const cfg = data && typeof data === 'object' && Object.hasOwn(data, 'config') ? data.config : null;
    return cfg !== null && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : null;
  }

  function getMode(modeId, data = getData()) {
    const cfg = getConfig(data);
    return cfg ? ownRecord(cfg.modes, modeId) : null;
  }

  return {
    DATA_FILES,
    DATA_DIR: base,
    ROOT: '/',
    deepFreeze,
    INDEXED_FILES,
    loadData,
    getData,
    setData,
    resetData,
    lookup,
    getChess, getBond, getGarrison, getItem, getBand, getEffect,
    getEnemy, getWave, getStage, getBoss, getToken, getConfig, getMode,
  };
}
