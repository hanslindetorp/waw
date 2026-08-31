// Fetches and caches the public WebAudioModules community plugin directory
// (per Hans's wam-insert-effects-instructions.md) — no backend of our own
// needed. The list changes rarely, so it's fetched once per session and
// mirrored into localStorage with a TTL, so a page reload within that
// window skips the network round-trip entirely.

const PLUGINS_JSON_URL = "https://www.webaudiomodules.com/community/plugins.json";
export const WAM_BASE_URL = "https://www.webaudiomodules.com/community/plugins/";

const CACHE_KEY = "waw:wam-catalog:v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // one day, per the instructions doc

// Tagged "Effect" in the source but are visualizers/meters that don't touch
// the signal — not real insert effects, per the instructions doc.
const VISUALIZER_IDENTIFIERS = new Set(["com.wimmics.livegain", "com.wimmics.oscilloscope", "com.wimmics.spectrogram", "com.wimmics.spectroscope"]);

let memoryCache = null; // the resolved insertEffects array, once fetched this session
let inFlight = null; // the in-progress fetch promise, so concurrent callers share one request

// Every insert effect, each with `pluginSrc`/`thumbnailUrl` already resolved
// to absolute URLs — grouped by category[1] via groupByCategory() below.
export async function getInsertEffects() {
	if (memoryCache) return memoryCache;
	if (inFlight) return inFlight;

	inFlight = loadFromCacheOrNetwork()
		.then((effects) => {
			memoryCache = effects;
			return effects;
		})
		.finally(() => {
			inFlight = null;
		});
	return inFlight;
}

// { groupName: [effect, ...] } — ungrouped entries (no category[1]) land
// under "Other", listed last.
export function groupByCategory(effects) {
	const groups = new Map();
	for (const effect of effects) {
		const groupName = effect.category?.[1] || "Other";
		if (!groups.has(groupName)) groups.set(groupName, []);
		groups.get(groupName).push(effect);
	}
	const entries = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	const otherIndex = entries.findIndex(([name]) => name === "Other");
	if (otherIndex > -1) entries.push(entries.splice(otherIndex, 1)[0]);
	return entries;
}

async function loadFromCacheOrNetwork() {
	const cached = readCache();
	if (cached) return cached;

	const res = await fetch(PLUGINS_JSON_URL);
	if (!res.ok) throw new Error(`Could not load WAM catalog: ${res.status} ${res.statusText}`);
	const allPlugins = await res.json();

	const effects = allPlugins
		.filter((p) => Array.isArray(p.category) && p.category.includes("Effect"))
		.filter((p) => !VISUALIZER_IDENTIFIERS.has(p.identifier))
		.map((p) => ({
			...p,
			pluginSrc: WAM_BASE_URL + p.path,
			thumbnailUrl: p.thumbnail ? WAM_BASE_URL + p.thumbnail : null
		}));

	writeCache(effects);
	return effects;
}

function readCache() {
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		if (!raw) return null;
		const { savedAt, effects } = JSON.parse(raw);
		if (typeof savedAt !== "number" || Date.now() - savedAt > CACHE_TTL_MS) return null;
		return Array.isArray(effects) ? effects : null;
	} catch {
		return null; // corrupt/unavailable localStorage is never fatal — just re-fetch
	}
}

function writeCache(effects) {
	try {
		localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), effects }));
	} catch {
		// Storage full/unavailable (private browsing, quota) — the in-memory
		// cache for this session still works fine without it.
	}
}
