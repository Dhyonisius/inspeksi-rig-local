import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const normalize = value => String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
const aliases = { workingplatorm: 'workingplatform' };
const areaKey = value => aliases[normalize(value)] || normalize(value);

export function createRigReviewContext({ privateDir }) {
  const file = path.join(privateDir, 'rig-pdf', 'review-context.json');
  const manifestFile = path.join(privateDir, 'rig-pdf', 'prepared', 'manifest.json');
  let stamp = null, cached = null;
  async function load() {
    try {
      const [info, manifestInfo] = await Promise.all([fs.lstat(file), fs.lstat(manifestFile)]);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024 || !manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 20 * 1024 * 1024) return null;
      const current = `${info.size}:${info.mtimeMs}:${manifestInfo.size}:${manifestInfo.mtimeMs}`;
      if (stamp === current) return cached;
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      const digest = crypto.createHash('sha256').update(await fs.readFile(manifestFile)).digest('hex');
      if (value.schema_version !== 1 || value.source !== 'PROTECT_RIG_PDF' || value.human_reviewed !== false || value.manifest_sha256 !== digest || !value.items || typeof value.items !== 'object') return null;
      cached = value; stamp = current; return value;
    } catch { return null; }
  }
  return async function defaults(item, areas, aiDraft) {
    if (item.source_kind !== 'PDF' || item.reviewed_at || String(item.curated_description || '').trim()) return null;
    const context = await load(), entry = context?.items[item.checksum];
    if (!Array.isArray(entry?.candidates)) return null;
    const candidates = entry.candidates.filter(row => typeof row?.area_name === 'string' && row.area_name.length <= 160
      && typeof row.name === 'string' && row.name.length <= 400 && typeof row.pdf_name === 'string' && row.pdf_name.length <= 255
      && Number.isSafeInteger(row.page) && row.page > 0).map(row => ({ ...row,
        work_area_id: areas.find(area => areaKey(area.name) === areaKey(row.area_name))?.work_area_id || null }));
    if (!candidates.length) return null;
    const distinct = [...new Map(candidates.map(row => [[areaKey(row.area_name), row.name, row.pdf_sha256, row.item_page, row.filename].join('\0'), row])).values()];
    const areaIds = new Set(candidates.map(row => row.work_area_id));
    const workAreaId = areaIds.size === 1 && !areaIds.has(null) ? candidates[0].work_area_id : null;
    const ai = typeof aiDraft?.description === 'string' ? { model: aiDraft.model || 'AI lokal', description: aiDraft.description.slice(0, 600) } : null;
    const pdfText = [...new Set(distinct.slice(0, 5).map(row => row.name.trim()).filter(Boolean))].join('\n');
    const description = [pdfText.slice(0, ai ? 570 : 1120), ai?.description].filter(Boolean).join('\n').slice(0, 1200);
    return { source: 'PDF_AND_EXISTING_AI', work_area_id: workAreaId, description,
      candidates: distinct.slice(0, 80), ai, ambiguous: distinct.length > 1, human_reviewed: false,
      note: distinct.length > 1 ? 'Foto ini memiliki beberapa item checklist asal. Pilih konteks PDF yang sesuai dan periksa isian sebelum menyimpan.'
        : 'Area dan deskripsi diisi dari PDF. Informasi AI yang tersedia disertakan sebagai usulan untuk Anda crosscheck.' };
  };
}
