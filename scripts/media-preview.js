import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const maxOriginalBytes = 12 * 1024 * 1024;
const maxPreviewBytes = 512 * 1024;
const cacheFiles = 256;
const cacheBytes = 32 * 1024 * 1024;
const within = (directory, file) => { const relative = path.relative(directory, file); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const pythonSource = `from PIL import Image, ImageOps
from io import BytesIO
import sys
Image.MAX_IMAGE_PIXELS = 40000000
with Image.open(BytesIO(sys.stdin.buffer.read())) as source:
 if source.format not in {"JPEG", "PNG", "WEBP"} or source.width * source.height > 40000000:
  raise ValueError("Invalid image")
 source.draft("RGB", (320, 320))
 image = ImageOps.exif_transpose(source)
 image.thumbnail((320, 320), Image.Resampling.LANCZOS)
 if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
  rgba = image.convert("RGBA")
  flattened = Image.new("RGB", rgba.size, "white")
  flattened.paste(rgba, mask=rgba.getchannel("A"))
  image = flattened
 else:
  image = image.convert("RGB")
 output = BytesIO()
 image.save(output, format="JPEG", quality=74, optimize=True)
 sys.stdout.buffer.write(output.getvalue())
`;

/** Caller must check image visibility before asking for a private preview. */
export function createMediaPreview({ projectRoot, privateDir, uploadDir, python = 'python' }) {
  if (!projectRoot || !privateDir || !uploadDir) throw new TypeError('Media preview requires the project storage directories.');
  const flights = new Map();
  // One decoder at a time avoids a burst of Python processes when 24 cards appear.
  let queue = Promise.resolve(), trimQueue = Promise.resolve();
  const cacheRoot = path.resolve(privateDir, 'cache');
  const cacheDir = path.join(cacheRoot, 'thumbnails');
  async function safeSource(asset) {
    const uri = asset?.file_uri;
    if (typeof uri !== 'string' || uri.includes('\0') || path.isAbsolute(uri)) throw new Error('Lokasi foto tidak valid.');
    const file = path.resolve(privateDir, uri);
    if (!within(uploadDir, file)) throw new Error('Foto berada di luar penyimpanan unggahan.');
    const realRoot = await fs.realpath(projectRoot), realPrivate = await fs.realpath(privateDir), realUploads = await fs.realpath(uploadDir);
    if (!samePath(realPrivate, path.join(realRoot, 'data', 'private')) || !samePath(realUploads, path.join(realPrivate, 'uploads'))) throw new Error('Folder foto mengarah ke lokasi lain.');
    const info = await fs.lstat(file), realFile = await fs.realpath(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxOriginalBytes || !within(realUploads, realFile)) throw new Error('Berkas foto tidak valid.');
    return { file, info, realPrivate };
  }
  async function safeCache(realPrivate) {
    for (const directory of [cacheRoot, cacheDir]) {
      await fs.mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const info = await fs.lstat(directory), resolved = await fs.realpath(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(resolved, path.join(realPrivate, path.relative(privateDir, directory)))) throw new Error('Folder pratinjau mengarah ke lokasi lain.');
    }
    return cacheDir;
  }
  function decode(binary) {
    return new Promise((resolve, reject) => {
      const child = spawn(python, ['-c', pythonSource], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let finished = false, length = 0; const chunks = [];
      const timer = setTimeout(() => finish(new Error('Pratinjau foto memerlukan waktu terlalu lama.')), 15000);
      function finish(error, value) { if (finished) return; finished = true; clearTimeout(timer); if (error) { child.kill(); reject(error); } else resolve(value); }
      child.on('error', () => finish(new Error('Decoder pratinjau foto belum tersedia.')));
      child.stdout.on('data', chunk => { length += chunk.length; if (length > maxPreviewBytes) finish(new Error('Pratinjau foto terlalu besar.')); else chunks.push(chunk); });
      child.stderr.on('data', () => {}); // Never expose local Python diagnostic paths to the UI.
      child.stdin.on('error', () => {});
      child.on('close', code => { const buffer = Buffer.concat(chunks); if (code !== 0 || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) finish(new Error('Pratinjau foto belum dapat dibuat.')); else finish(null, buffer); });
      child.stdin.end(binary);
    });
  }
  async function readCache(file) {
    try { const info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > maxPreviewBytes) return null; const result = await fs.readFile(file); return result.length >= 4 && result[0] === 0xff && result[1] === 0xd8 ? result : null; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function trimCache() {
    const files = [];
    for (const name of await fs.readdir(cacheDir)) {
      if (!/^[a-f0-9]{64}\.jpg$/.test(name)) continue;
      const file = path.join(cacheDir, name);
      try { const info = await fs.lstat(file); if (info.isFile() && !info.isSymbolicLink()) files.push({ file, size: info.size, modified: info.mtimeMs }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    files.sort((left, right) => left.modified - right.modified);
    let total = files.reduce((sum, file) => sum + file.size, 0), remaining = files.length;
    for (const entry of files) { if (remaining <= cacheFiles && total <= cacheBytes) break; await fs.unlink(entry.file).catch(error => { if (error.code !== 'ENOENT') throw error; }); total -= entry.size; remaining -= 1; }
  }
  async function thumbnail(asset) {
    if (!Number.isSafeInteger(asset?.image_id) || asset.image_id < 1 || typeof asset.checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(asset.checksum)) throw new Error('Data foto pratinjau tidak valid.');
    const source = await safeSource(asset);
    const cache = await safeCache(source.realPrivate);
    const key = crypto.createHash('sha256').update(`${asset.image_id}:${asset.checksum || ''}:${source.info.size}:${source.info.mtimeMs}:320-jpeg-74-v1`).digest('hex');
    const file = path.join(cache, `${key}.jpg`);
    const cached = await readCache(file);
    if (cached) return cached;
    if (flights.has(key)) return flights.get(key);
    if (flights.size >= 64) throw new Error('Pratinjau sedang sibuk. Coba lagi setelah foto lain selesai dimuat.');
    const flight = queue.catch(() => {}).then(async () => {
      // Recheck storage after the queue: deletion could have completed while waiting.
      await safeSource(asset);
      const again = await readCache(file); if (again) return again;
      const original = await fs.readFile(source.file);
      if (original.length > maxOriginalBytes) throw new Error('Berkas foto terlalu besar.');
      if (asset.checksum && crypto.createHash('sha256').update(original).digest('hex') !== asset.checksum.toLowerCase()) throw new Error('Berkas foto berubah.');
      const buffer = await decode(original);
      await safeCache(source.realPrivate);
      const temporary = path.join(cache, `${key}.${crypto.randomUUID()}.tmp`);
      try { await fs.writeFile(temporary, buffer, { flag: 'wx' }); await fs.rename(temporary, file); }
      finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      trimQueue = trimQueue.catch(() => {}).then(trimCache); await trimQueue;
      return buffer;
    });
    queue = flight.then(() => {}, () => {});
    flights.set(key, flight);
    try { return await flight; } finally { flights.delete(key); }
  }
  return Object.freeze({ thumbnail });
}
