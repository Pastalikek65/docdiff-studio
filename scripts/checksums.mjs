import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const release = new URL('../release/', import.meta.url);
const names = (await readdir(release)).filter(name => /\.(?:zip|tar\.gz)$/.test(name)).sort();
if (!names.length) throw new Error('No platform archive exists.');
const rows = [];
for (const name of names) {
  const sha = createHash('sha256').update(await readFile(new URL(name, release))).digest('hex');
  rows.push(`${sha}  ${name}`);
}
await writeFile(new URL('SHA256SUMS.txt', release), rows.join('\n') + '\n');
console.log(`Checksummed ${names.length} platform archive(s).`);
