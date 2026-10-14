export function sessionCookieValue(header, name) {
  const part = String(header || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  if (!part) return '';
  try { return decodeURIComponent(part.slice(name.length + 1)); }
  catch { return ''; }
}

export async function jsonObjectBody(request, httpError) {
  let body;
  try { body = await request.json(); }
  catch { throw httpError(400, 'Isi permintaan tidak valid.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Isi permintaan harus berupa objek JSON.');
  return body;
}
