export function parseDatasetAnnotations(raw, label, intValue, httpError) {
  let annotations;
  try { annotations = JSON.parse(String(raw ?? '[]')); }
  catch { throw httpError(400, 'Anotasi belum dapat dibaca. Pilih foto dan gambar ulang kotak kategori.'); }
  if (!Array.isArray(annotations) || annotations.length > 80) throw httpError(400, 'Jumlah anotasi tidak valid.');
  if (label === 'RISK' && !annotations.length) throw httpError(400, 'Tambahkan paling sedikit satu kotak kategori pada foto berlabel RISK.');
  if (label === 'NO_LISTED_HAZARD_VISIBLE' && annotations.length) throw httpError(400, 'Label tanpa indikasi bahaya tidak boleh memiliki kotak kategori bahaya.');
  return annotations.map(box => {
    if (!box || typeof box !== 'object' || Array.isArray(box) || ['x','y','width','height'].some(key => box[key] == null || typeof box[key] !== 'number')) throw httpError(400, 'Lengkapi kategori dan koordinat kotak anotasi.');
    const hazardId = intValue(box.hazard_type_id, 'Kategori bahaya');
    const { x, y, width, height } = box;
    if (![x,y,width,height].every(Number.isFinite) || x < 0 || y < 0 || x >= 1 || y >= 1 || width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) throw httpError(400, 'Koordinat kotak anotasi harus berada di dalam foto.');
    return { hazardId, x, y, width: Math.min(width, 1-x), height: Math.min(height, 1-y) };
  });
}
