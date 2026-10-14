// Tags on newer Ollama versions include capabilities; older versions expose
// them through /api/show. Cache only by model digest so replacement is noticed.
export function createVisionModelList({ baseUrl, fetch: request = globalThis.fetch, now = Date.now, cacheMs = 60_000 }) {
  const capabilitiesCache = new Map();
  return async function listVisionModels() {
    const response = await request(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`Ollama menjawab HTTP ${response.status}.`);
    const body = await response.json();
    if (!Array.isArray(body.models)) throw new Error('Daftar model Ollama belum dapat dibaca.');
    const models = body.models.filter(model => model && typeof model === 'object');
    const entries = await Promise.all(models.map(async model => {
      const name = String(model.name || model.model || '').slice(0, 120);
      if (!name) return null;
      let capabilities = model.capabilities;
      if (!Array.isArray(capabilities)) {
        const key = `${name}:${model.digest || model.modified_at || ''}`;
        const cached = capabilitiesCache.get(key);
        if (cached && cached.until > now()) capabilities = cached.capabilities;
        else {
          try {
            const info = await request(`${baseUrl}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(3000) });
            if (!info.ok) return null;
            const detail = await info.json();
            if (!Array.isArray(detail.capabilities)) return null;
            capabilities = detail.capabilities;
            capabilitiesCache.set(key, { capabilities, until: now() + cacheMs });
          } catch { return null; }
        }
      }
      if (!capabilities.includes('vision')) return null;
      return { name, family: String(model.details?.family || '').slice(0, 60), parameter_size: String(model.details?.parameter_size || '').slice(0, 40), size: Number(model.size || 0) };
    }));
    for (const [key, cached] of capabilitiesCache) if (cached.until <= now()) capabilitiesCache.delete(key);
    return entries.filter(Boolean);
  };
}
