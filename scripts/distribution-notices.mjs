import { readFile, readdir, mkdir, writeFile, cp, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const inventory = [];
const bundledNames = new Set(['diff', 'pdfjs-dist', 'react', 'react-dom', 'scheduler', 'fflate', 'fast-xml-parser', 'fast-xml-builder', '@nodable/entities', 'anynum', 'is-unsafe', 'path-expression-matcher', 'strnum', 'xml-naming', 'tesseract.js', 'tesseract.js-core', 'bmp-js', 'idb-keyval', 'is-url', 'regenerator-runtime', 'wasm-feature-detect', 'zlibjs']);
for (const [relative, entry] of Object.entries(lock.packages)) {
  if (!relative) continue;
  const folder = path.join(root, relative);
  const name = relative.split('node_modules/').at(-1);
  let installed = false;
  try { installed = (await stat(folder)).isDirectory(); } catch {}
  const row = { name, version: entry.version, license: entry.license ?? 'UNDECLARED', developmentDependency: entry.dev === true, browserBundleCandidate: bundledNames.has(name), optional: entry.optional === true, installed, licenseFiles: [] };
  if (installed && bundledNames.has(name)) {
    const licenseNames = (await readdir(folder)).filter(name => /^(license|licence|copying|notice)([._-].*)?$/i.test(name));
    if (!licenseNames.length) {
      if (name !== '@nodable/entities' || entry.version !== '3.1.0') throw new Error(`No license text for browser dependency ${name}`);
      const preserved = 'third_party/npm/@nodable__entities/LICENSE';
      const bytes = await readFile(path.join(root, preserved));
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== '750cb3fb6362804957ef52caaf9b5c824015be44d494637330d7cd8834d31d40') throw new Error('Pinned upstream entities license mismatch');
      row.licenseFiles.push({ path: preserved, sha256: digest, upstreamCommit: 'ac48e7ea591da372be023a481875c747535812b3' });
    }
    for (const filename of licenseNames) {
      const from = path.join(folder, filename);
      if (!(await stat(from)).isFile()) continue;
      const toRelative = `third_party/npm/${name.replaceAll('/', '__')}/${filename}`;
      await mkdir(path.dirname(path.join(root, toRelative)), { recursive: true });
      await cp(from, path.join(root, toRelative));
      const bytes = await readFile(from);
      row.licenseFiles.push({ path: toRelative, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  inventory.push(row);
}
inventory.sort((a, b) => a.name.localeCompare(b.name));
await mkdir(path.join(root, 'third_party'), { recursive: true });
await writeFile(path.join(root, 'third_party/dependencies.json'), JSON.stringify({ schemaVersion: 1, scope: 'Pinned source dependencies; optional uninstalled platform bindings are not present in this build. Browser bundles and Electron distribution are inventoried separately below.', dependencies: inventory }, null, 2) + '\n');
console.log(JSON.stringify({ inventoryEntries: inventory.length, installedBrowserCandidates: inventory.filter(x => x.installed && x.browserBundleCandidate).length }));
