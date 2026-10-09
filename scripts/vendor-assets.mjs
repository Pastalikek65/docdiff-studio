import { mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const pdfAssets = [];
async function inventoryPdfAssets(directory, relative = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await inventoryPdfAssets(path.join(directory, entry.name), next);
    else if (entry.isFile()) {
      const bytes = await readFile(path.join(directory, entry.name));
      pdfAssets.push({ path: next, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    } else throw new Error(`Unexpected PDF.js asset type: ${next}`);
  }
}
for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs', 'image_decoders']) {
  const target = `${root}public/vendor/pdfjs/${folder}`;
  await mkdir(target, { recursive: true });
  await cp(`${root}node_modules/pdfjs-dist/${folder}`, target, { recursive: true });
  await inventoryPdfAssets(target, folder);
}
const pdfPackage = JSON.parse(await readFile(path.join(root, 'node_modules/pdfjs-dist/package.json'), 'utf8'));
await writeFile(path.join(root, 'public/vendor/pdfjs/assets.json'), JSON.stringify({ schemaVersion: 1, pdfjsVersion: pdfPackage.version, files: pdfAssets }, null, 2) + '\n');

// OCR assets are supplied at build time. A running app never downloads a model.
const ocrRoot = path.join(root, 'public/vendor/ocr');
const coreRoot = path.join(root, 'node_modules/tesseract.js-core');
const wrapperRoot = path.join(root, 'node_modules/tesseract.js');
for (const directory of [coreRoot, wrapperRoot]) {
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  if (metadata.version !== '7.0.0') throw new Error(`Unexpected OCR dependency version: ${metadata.name}`);
}
const provenance = JSON.parse(await readFile(path.join(root, 'third_party/ocr/provenance.json'), 'utf8'));
for (const entry of provenance.files) {
  const bytes = await readFile(path.join(root, entry.path));
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw new Error(`Pinned OCR source/notice mismatch: ${entry.path}`);
  }
}
await mkdir(path.join(ocrRoot, 'core'), { recursive: true });
await mkdir(path.join(ocrRoot, 'lang'), { recursive: true });
const copied = [];
async function copyOcrAsset(from, relative) {
  const bytes = await readFile(from);
  await cp(from, path.join(ocrRoot, relative));
  copied.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await copyOcrAsset(path.join(wrapperRoot, 'dist/worker.min.js'), 'worker.min.js');
await copyOcrAsset(path.join(wrapperRoot, 'dist/worker.min.js.LICENSE.txt'), 'worker.min.js.LICENSE.txt');
const workerInventory = JSON.parse(await readFile(path.join(root, 'third_party/ocr/worker-dependencies.json'), 'utf8'));
if (copied[0].sha256 !== workerInventory.workerSha256) throw new Error('Pinned upstream OCR worker mismatch');
const variants = ['', '-lstm', '-simd', '-simd-lstm', '-relaxedsimd', '-relaxedsimd-lstm'];
for (const variant of variants) {
  for (const extension of ['.wasm.js', '.wasm']) {
    const name = `tesseract-core${variant}${extension}`;
    await copyOcrAsset(path.join(coreRoot, name), `core/${name}`);
  }
}
await copyOcrAsset(path.join(root, 'third_party/ocr/tessdata-fast/eng.traineddata'), 'lang/eng.traineddata');
await copyOcrAsset(path.join(root, 'third_party/ocr/tessdata-fast/LICENSE'), 'lang/LICENSE');
for (const file of await readdir(coreRoot)) {
  if (/^(LICENSE|NOTICE)([._-].*)?$/i.test(file)) await copyOcrAsset(path.join(coreRoot, file), `core/${file}`);
}
await writeFile(path.join(ocrRoot, 'assets.json'), JSON.stringify({ schemaVersion: 1, tesseractVersion: '7.0.0', coreVersion: '7.0.0', language: 'eng', modelCommit: '87416418657359cb625c412a48b6e1d6d41c29bd', files: copied }, null, 2) + '\n');
console.log(JSON.stringify({ offlineOcrAssets: copied.length, coreVariants: variants.length, modelBytes: copied.find(file => file.path === 'lang/eng.traineddata').bytes }));
