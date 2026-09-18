// Conditional-write Blob simulator shared by isolated security tests.
function memoryBlob() {
  const records = new Map(); let revision = 0;
  return {
    records,
    async get(name) { const entry = records.get(name); return entry ? { statusCode: 200, stream: new Response(entry.value).body, blob: { etag: entry.etag } } : null; },
    async head(name) { return { etag: records.get(name)?.etag }; },
    async put(name, value, options) {
      const existing = records.get(name);
      if (existing && (!options.allowOverwrite || options.ifMatch !== existing.etag)) throw new Error('precondition');
      if (!existing && options.ifMatch) throw new Error('precondition');
      if (options.access !== 'private' || options.addRandomSuffix !== false) throw new Error('Unsafe test storage options');
      records.set(name, { value, etag: String(++revision) });
    }
  };
}
module.exports = { memoryBlob };
