import { mkdir, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs', 'image_decoders']) {
  const target = `${root}public/vendor/pdfjs/${folder}`;
  await mkdir(target, { recursive: true });
  await cp(`${root}node_modules/pdfjs-dist/${folder}`, target, { recursive: true });
}
