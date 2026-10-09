import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { Inflate } from 'fflate';
import { COMPARISON_LIMITS } from './limits';
import { CompareError } from './types';

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const OFFICE_DOCUMENT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const MAIN_DOCUMENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const IMAGE_OR_TEXT_UNSUPPORTED = new Set([
  'w:altChunk', 'w:sdt', 'w:customXml', 'w:ins', 'w:del', 'w:moveFrom', 'w:moveTo',
  'w:drawing', 'w:pict', 'w:object', 'w:txbxContent', 'w:footnoteReference',
  'w:endnoteReference', 'w:commentReference', 'w:commentRangeStart', 'w:commentRangeEnd',
  'w:instrText', 'w:fldSimple', 'w:hyperlink', 'w:subDoc', 'w:object', 'w:oMath', 'w:oMathPara',
]);

export interface DocxBlock {
  index: number;
  kind: 'paragraph' | 'table-row';
  tableIndex?: number;
  rowIndex?: number;
  text: string;
  cells?: string[];
}

export interface ParsedDocx {
  blocks: DocxBlock[];
  warnings: string[];
  certainty: 'complete' | 'incomplete';
}

interface ZipEntry {
  rawName: string;
  canonicalName: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  dataOffset: number;
  dataEnd: number;
}

interface XmlNode {
  [key: string]: unknown;
}

interface XmlDocument {
  nodes: XmlNode[];
  root: XmlNode;
}

interface XmlBudget {
  totalBytes: number;
}

interface ContentTypeIndex {
  overrides: Map<string, string>;
  defaults: Map<string, string>;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    table[value] = crc >>> 0;
  }
  return table;
})();

/** Parse only the package XML needed to identify and extract the main document. */
export function parseDocxDocument(bytes: Uint8Array, remainingTextCharacters: number): ParsedDocx {
  const entries = readZipDirectory(bytes);
  const byName = new Map(entries.map((entry) => [entry.canonicalName, entry]));
  const xmlBudget: XmlBudget = { totalBytes: 0 };
  const contentTypesEntry = byName.get('[content_types].xml');
  const rootRelationshipsEntry = byName.get('_rels/.rels');
  if (!contentTypesEntry || !rootRelationshipsEntry) {
    throw new CompareError('DOCX_PACKAGE_INVALID', 'The DOCX package is missing required package metadata.');
  }

  const contentTypes = parseXmlPart(inflateEntry(bytes, contentTypesEntry, xmlBudget), xmlBudget, '[Content_Types].xml');
  const rootRelationships = parseXmlPart(inflateEntry(bytes, rootRelationshipsEntry, xmlBudget), xmlBudget, '_rels/.rels');
  const mainPart = resolveMainDocumentPart(contentTypes.root, rootRelationships.root, byName);
  const contentTypeIndex = indexContentTypes(contentTypes.root);
  const documentEntry = byName.get(mainPart.toLowerCase());
  if (!documentEntry) throw new CompareError('DOCX_PACKAGE_INVALID', 'The DOCX main document part is missing.');
  const documentXml = parseXmlPart(inflateEntry(bytes, documentEntry, xmlBudget), xmlBudget, 'main document XML');
  if (elementName(documentXml.root) !== 'w:document') {
    throw new CompareError('DOCX_UNSUPPORTED_FEATURE', 'The DOCX main part does not use the supported Transitional WordprocessingML document root.');
  }
  validateWordNamespaces(documentXml.root);

  const warnings = new Set<string>();
  inspectUnsupportedPackageParts(entries, contentTypeIndex, warnings);
  const documentRelationshipsPath = relationshipsPartPath(mainPart).toLowerCase();
  const documentRelationshipsEntry = byName.get(documentRelationshipsPath);
  if (documentRelationshipsEntry) {
    const relationships = parseXmlPart(inflateEntry(bytes, documentRelationshipsEntry, xmlBudget), xmlBudget, 'document relationships XML');
    inspectRelationships(relationships.root, mainPart, contentTypeIndex, warnings);
  }
  inspectUnsupportedXml(documentXml.root, warnings);

  const body = directChild(documentXml.root, 'w:body');
  if (!body) throw new CompareError('DOCX_XML_INVALID', 'The DOCX main document has no body element.');
  const blocks: DocxBlock[] = [];
  let tableIndex = 0;
  let textCharacters = 0;
  for (const child of children(body)) {
    const name = elementName(child);
    if (name === 'w:p') {
      const text = extractParagraph(child);
      textCharacters = addTextBudget(textCharacters, text, remainingTextCharacters);
      blocks.push({ index: blocks.length, kind: 'paragraph', text });
    } else if (name === 'w:tbl') {
      const currentTableIndex = tableIndex;
      tableIndex += 1;
      let rowIndex = 0;
      for (const row of children(child).filter((node) => elementName(node) === 'w:tr')) {
        const cells = children(row).filter((node) => elementName(node) === 'w:tc').map(extractCell);
        const text = cells.join('\t');
        textCharacters = addTextBudget(textCharacters, text, remainingTextCharacters);
        blocks.push({ index: blocks.length, kind: 'table-row', tableIndex: currentTableIndex, rowIndex, text, cells });
        rowIndex += 1;
      }
    } else if (name !== 'w:sectPr') {
      if (containsElementText(child)) warnings.add('Unsupported body content was omitted from the logical block comparison.');
    }
    if (blocks.length > COMPARISON_LIMITS.maxDocxBlocks) {
      throw new CompareError('DOCX_PACKAGE_INVALID', `A DOCX may contain at most ${COMPARISON_LIMITS.maxDocxBlocks} logical blocks.`);
    }
  }

  return {
    blocks,
    warnings: [...warnings],
    certainty: warnings.size > 0 ? 'incomplete' : 'complete',
  };
}

function readZipDirectory(bytes: Uint8Array): ZipEntry[] {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22 || bytes.byteLength > COMPARISON_LIMITS.maxInputBytesPerDocument) {
    throw new CompareError(bytes?.byteLength > COMPARISON_LIMITS.maxInputBytesPerDocument ? 'INPUT_TOO_LARGE' : 'DOCX_PACKAGE_INVALID', 'The DOCX ZIP package size is invalid.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const searchStart = Math.max(0, bytes.length - 22 - 65_535);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === bytes.length) { eocd = offset; break; }
    }
  }
  if (eocd < 0 || eocd + 22 > bytes.length) throw packageError();
  const diskNumber = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskCount = view.getUint16(eocd + 8, true);
  const totalCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (diskNumber !== 0 || centralDisk !== 0 || diskCount !== totalCount
    || totalCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
    || totalCount > COMPARISON_LIMITS.maxDocxEntries
    || centralOffset + centralSize !== eocd || centralOffset > bytes.length) throw packageError();

  const entries: ZipEntry[] = [];
  const rawNames = new Set<string>();
  const canonicalNames = new Set<string>();
  let offset = centralOffset;
  let declaredUncompressedTotal = 0;
  for (let index = 0; index < totalCount; index += 1) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== 0x02014b50) throw packageError();
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    const localOffset = view.getUint32(offset + 42, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || diskStart !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
      || localOffset === 0xffffffff || (flags & 0x0001) !== 0 || (flags & 0x0008) !== 0
      || (flags & ~0x0806) !== 0 || (method !== 0 && method !== 8)) throw packageError();
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const rawName = decodeZipName(nameBytes);
    const canonicalName = canonicalizeZipName(rawName);
    if (rawNames.has(rawName) || canonicalNames.has(canonicalName)) throw packageError();
    rawNames.add(rawName);
    canonicalNames.add(canonicalName);
    assertNoZip64Extra(bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength));
    declaredUncompressedTotal += uncompressedSize;
    if (declaredUncompressedTotal > COMPARISON_LIMITS.maxDocxUncompressedBytes) throw packageError();
    if (method === 0 && compressedSize !== uncompressedSize) throw packageError();

    if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== 0x04034b50) throw packageError();
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCrc = view.getUint32(localOffset + 14, true);
    const localCompressedSize = view.getUint32(localOffset + 18, true);
    const localUncompressedSize = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (localFlags !== flags || localMethod !== method || localCrc !== crc
      || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize
      || dataEnd > centralOffset || dataOffset > dataEnd) throw packageError();
    const localName = decodeZipName(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    if (localName !== rawName) throw packageError();
    assertNoZip64Extra(bytes.subarray(localOffset + 30 + localNameLength, dataOffset));
    entries.push({ rawName, canonicalName, flags, method, crc, compressedSize, uncompressedSize, localOffset, dataOffset, dataEnd });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) throw packageError();
  const ranges = entries.slice().sort((a, b) => a.localOffset - b.localOffset);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1].dataEnd > ranges[index].localOffset) throw packageError();
  }
  return entries;
}

function decodeZipName(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw packageError();
  }
}

function canonicalizeZipName(rawName: string): string {
  if (!rawName || rawName.includes('\0') || rawName.includes('\\') || rawName.startsWith('/') || /^[a-z]:/iu.test(rawName)) throw packageError();
  let once: string;
  let twice: string;
  try {
    once = decodeURIComponent(rawName);
    twice = decodeURIComponent(once);
  } catch {
    throw packageError();
  }
  for (const candidate of [rawName, once, twice]) {
    if (candidate.includes('\0') || candidate.includes('\\') || candidate.startsWith('/') || /^[a-z]:/iu.test(candidate)) throw packageError();
    const segments = candidate.split('/');
    if (segments.some((segment, index) => segment === '.' || segment === '..' || (segment.length === 0 && index < segments.length - 1))) throw packageError();
  }
  const normalized = once.normalize('NFC').toLowerCase();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function assertNoZip64Extra(extra: Uint8Array): void {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) throw packageError();
    const id = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    if (offset + 4 + size > extra.length || id === 0x0001) throw packageError();
    offset += 4 + size;
  }
}

function inflateEntry(bytes: Uint8Array, entry: ZipEntry, budget: XmlBudget): Uint8Array {
  if (entry.uncompressedSize > COMPARISON_LIMITS.maxDocxXmlPartBytes
    || budget.totalBytes + entry.uncompressedSize > COMPARISON_LIMITS.maxDocxXmlTotalBytes) {
    throw new CompareError('DOCX_PACKAGE_INVALID', 'A DOCX XML part exceeds the supported decompression limit.');
  }
  const compressed = bytes.subarray(entry.dataOffset, entry.dataEnd);
  const chunks: Uint8Array[] = [];
  let actual = 0;
  try {
    if (entry.method === 0) {
      chunks.push(compressed);
      actual = compressed.byteLength;
    } else {
      let failure: Error | undefined;
      const inflater = new Inflate((chunk, _final) => {
        if (failure) return;
        actual += chunk.byteLength;
        if (actual > entry.uncompressedSize || actual > COMPARISON_LIMITS.maxDocxXmlPartBytes
          || budget.totalBytes + actual > COMPARISON_LIMITS.maxDocxXmlTotalBytes) {
          failure = new Error('decompressed part limit');
          return;
        }
        chunks.push(chunk);
      });
      // fflate may grow its output buffer for the whole input passed to one
      // push before invoking the callback. Small input slices bound any one
      // over-limit expansion before the declared-size guard runs.
      for (let offset = 0; offset < compressed.length; offset += 1_024) {
        const end = Math.min(offset + 1_024, compressed.length);
        inflater.push(compressed.subarray(offset, end), end === compressed.length);
        if (failure) throw failure;
      }
      if (compressed.length === 0) inflater.push(compressed, true);
    }
    if (actual !== entry.uncompressedSize) throw new Error('ZIP declared size mismatch');
    if (crc32(chunks) !== entry.crc) throw new Error('ZIP CRC mismatch');
  } catch {
    throw packageError();
  }
  budget.totalBytes += actual;
  const output = new Uint8Array(actual);
  let cursor = 0;
  for (const chunk of chunks) { output.set(chunk, cursor); cursor += chunk.byteLength; }
  return output;
}

function crc32(chunks: Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const bytes of chunks) {
    for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseXmlPart(bytes: Uint8Array, budget: XmlBudget, label: string): XmlDocument {
  // The inflater accounts selected package parts before parsing; this label is
  // deliberately generic and is never copied into a user-facing warning.
  void budget;
  void label;
  let xml: string;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new CompareError('DOCX_XML_INVALID', 'A DOCX XML part is not valid UTF-8.'); }
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
  const declaration = /^\s*<\?xml\s+[^?]*encoding\s*=\s*["']([^"']+)["']/iu.exec(xml)?.[1];
  if (declaration && !/^utf-?8$/iu.test(declaration)) throw new CompareError('DOCX_XML_INVALID', 'Only UTF-8 DOCX XML parts are supported.');
  if (/<\s*!\s*(?:DOCTYPE|ENTITY)\b/iu.test(xml)) throw new CompareError('DOCX_XML_INVALID', 'DOCX XML must not contain DTDs or custom entity declarations.');
  preflightXmlStructure(xml);
  validateXmlReferences(xml);
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new CompareError('DOCX_XML_INVALID', 'A DOCX XML part is malformed.');
  let parsed: unknown;
  try {
    parsed = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      processEntities: false,
      htmlEntities: false,
      trimValues: false,
      parseTagValue: false,
      parseAttributeValue: false,
      maxNestedTags: COMPARISON_LIMITS.maxXmlDepth,
      commentPropName: '#comment',
      cdataPropName: '#cdata',
    }).parse(xml, true);
  } catch {
    throw new CompareError('DOCX_XML_INVALID', 'A DOCX XML part is malformed.');
  }
  const nodes = Array.isArray(parsed) ? parsed as XmlNode[] : [];
  const stack: Array<{ node: XmlNode; depth: number }> = nodes.map((node) => ({ node, depth: 1 }));
  let count = 0;
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    const name = elementName(current.node);
    if (!name || name.startsWith('#') || name.startsWith('?')) continue;
    count += 1;
    if (count > COMPARISON_LIMITS.maxXmlNodes || current.depth > COMPARISON_LIMITS.maxXmlDepth) {
      throw new CompareError('DOCX_XML_INVALID', 'A DOCX XML part exceeds the supported structural limits.');
    }
    for (const child of children(current.node)) stack.push({ node: child, depth: current.depth + 1 });
  }
  const root = nodes.find((node) => !elementName(node).startsWith('#') && !elementName(node).startsWith('?'));
  if (!root) throw new CompareError('DOCX_XML_INVALID', 'A DOCX XML part has no root element.');
  return { nodes, root };
}

function validateXmlReferences(xml: string): void {
  let index = 0;
  while (index < xml.length) {
    if (xml.startsWith('<!--', index)) {
      const end = xml.indexOf('-->', index + 4);
      if (end < 0) throw xmlError();
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', index)) {
      const end = xml.indexOf(']]>', index + 9);
      if (end < 0) throw xmlError();
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<?', index)) {
      const end = xml.indexOf('?>', index + 2);
      if (end < 0) throw xmlError();
      index = end + 2;
      continue;
    }
    if (xml[index] !== '&') { index += 1; continue; }
    const end = xml.indexOf(';', index + 1);
    if (end < 0) throw xmlError();
    const entity = xml.slice(index + 1, end);
    if (!['amp', 'lt', 'gt', 'quot', 'apos'].includes(entity)) {
      const decimal = /^#([0-9]+)$/u.exec(entity);
      const hexadecimal = /^#x([0-9a-f]+)$/iu.exec(entity);
      const codePoint = decimal ? Number(decimal[1]) : hexadecimal ? Number.parseInt(hexadecimal[1], 16) : -1;
      if (!isXmlCodePoint(codePoint)) throw xmlError();
    }
    index = end + 1;
  }
}

/** Bound the structural tree before either XMLValidator or XMLParser allocates it. */
function preflightXmlStructure(xml: string): void {
  let depth = 0;
  let nodes = 0;
  let index = 0;
  while (index < xml.length) {
    if (xml.startsWith('<!--', index)) {
      const end = xml.indexOf('-->', index + 4);
      if (end < 0) throw xmlError();
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', index)) {
      const end = xml.indexOf(']]>', index + 9);
      if (end < 0) throw xmlError();
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<?', index)) {
      const end = xml.indexOf('?>', index + 2);
      if (end < 0) throw xmlError();
      index = end + 2;
      continue;
    }
    if (xml[index] !== '<') { index += 1; continue; }
    if (xml.startsWith('</', index)) {
      const end = xml.indexOf('>', index + 2);
      if (end < 0 || depth === 0) throw xmlError();
      depth -= 1;
      index = end + 1;
      continue;
    }
    if (xml.startsWith('<!', index)) throw xmlError();

    let quote = '';
    let end = index + 1;
    for (; end < xml.length; end += 1) {
      const character = xml[end];
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    if (end >= xml.length || quote) throw xmlError();
    nodes += 1;
    if (nodes > COMPARISON_LIMITS.maxXmlNodes) {
      throw new CompareError('DOCX_XML_INVALID', 'A DOCX XML part exceeds the supported structural limits.');
    }
    let tail = end - 1;
    while (tail > index && /\s/u.test(xml[tail] ?? '')) tail -= 1;
    if (xml[tail] !== '/') {
      depth += 1;
      if (depth > COMPARISON_LIMITS.maxXmlDepth) {
        throw new CompareError('DOCX_XML_INVALID', 'A DOCX XML part exceeds the supported structural limits.');
      }
    }
    index = end + 1;
  }
  if (depth !== 0) throw xmlError();
}

function isXmlCodePoint(value: number): boolean {
  return value === 0x9 || value === 0xa || value === 0xd
    || (value >= 0x20 && value <= 0xd7ff)
    || (value >= 0xe000 && value <= 0xfffd)
    || (value >= 0x10000 && value <= 0x10ffff);
}

function resolveMainDocumentPart(typesRoot: XmlNode, relationshipsRoot: XmlNode, entries: Map<string, ZipEntry>): string {
  if (elementName(typesRoot) !== 'Types' || attrs(typesRoot)['@_xmlns'] !== TYPES_NS) throw packageError();
  if (elementName(relationshipsRoot) !== 'Relationships' || attrs(relationshipsRoot)['@_xmlns'] !== REL_NS) throw packageError();
  validatePackageNamespaceTree(typesRoot, TYPES_NS);
  validatePackageNamespaceTree(relationshipsRoot, REL_NS);
  let mainTarget: string | undefined;
  for (const relationship of children(relationshipsRoot).filter((node) => elementName(node) === 'Relationship')) {
    const values = attrs(relationship);
    if (values['@_Type'] !== OFFICE_DOCUMENT_REL) continue;
    if (values['@_TargetMode'] === 'External' || mainTarget) throw packageError();
    mainTarget = values['@_Target'];
  }
  if (!mainTarget) throw packageError();
  const mainPart = normalizeInternalTarget(mainTarget);
  if (!entries.has(mainPart.toLowerCase())) throw packageError();
  let mainContentType = '';
  for (const override of children(typesRoot).filter((node) => elementName(node) === 'Override')) {
    const values = attrs(override);
    if (normalizeInternalTarget(String(values['@_PartName'] ?? '')) === mainPart) mainContentType = String(values['@_ContentType'] ?? '');
    if (/macroEnabled|vbaProject/iu.test(String(values['@_ContentType'] ?? ''))) {
      throw new CompareError('DOCX_UNSUPPORTED_FEATURE', 'Macro-enabled Word documents are not supported.');
    }
  }
  for (const defaultType of children(typesRoot).filter((node) => elementName(node) === 'Default')) {
    if (/macroEnabled|vbaProject/iu.test(String(attrs(defaultType)['@_ContentType'] ?? ''))) {
      throw new CompareError('DOCX_UNSUPPORTED_FEATURE', 'Macro-enabled Word documents are not supported.');
    }
  }
  if (mainContentType !== MAIN_DOCUMENT_TYPE) {
    throw new CompareError('DOCX_UNSUPPORTED_FEATURE', 'This DOCX package does not declare a supported Transitional WordprocessingML main part.');
  }
  return mainPart;
}

function normalizeInternalTarget(target: string): string {
  if (!target || target.includes('\0') || target.includes('\\') || target.includes('?') || target.includes('#') || /^[a-z][a-z0-9+.-]*:/iu.test(target)) throw packageError();
  let decoded: string;
  try { decoded = decodeURIComponent(target); }
  catch { throw packageError(); }
  if (decoded.startsWith('/')) decoded = decoded.slice(1);
  const segments = decoded.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw packageError();
  return segments.join('/').normalize('NFC');
}

function relationshipsPartPath(partPath: string): string {
  const slash = partPath.lastIndexOf('/');
  const directory = slash < 0 ? '' : `${partPath.slice(0, slash + 1)}_rels/`;
  const name = partPath.slice(slash + 1);
  return `${directory}${name}.rels`;
}

function inspectRelationships(
  root: XmlNode,
  sourcePart: string,
  contentTypes: ContentTypeIndex,
  warnings: Set<string>,
): void {
  if (elementName(root) !== 'Relationships' || attrs(root)['@_xmlns'] !== REL_NS) throw packageError();
  validatePackageNamespaceTree(root, REL_NS);
  for (const relation of children(root).filter((node) => elementName(node) === 'Relationship')) {
    const values = attrs(relation);
    if (values['@_TargetMode'] === 'External') {
      warnings.add('External relationship targets were not loaded.');
      continue;
    }
    const type = String(values['@_Type'] ?? '');
    const relationshipWarning = warningForRelationshipType(type);
    if (relationshipWarning) {
      warnings.add(relationshipWarning);
      continue;
    }
    const target = resolveRelationshipTarget(sourcePart, String(values['@_Target'] ?? ''));
    const contentType = target ? contentTypeForPart(target, contentTypes) : '';
    if (isXmlContentType(contentType) && !isKnownTextSafeRelationship(type)) {
      warnings.add('Additional related XML content is not included in the document comparison.');
    }
  }
}

function validatePackageNamespaceTree(root: XmlNode, expectedNamespace: string): void {
  const stack: Array<{ node: XmlNode; inheritedNamespace: string }> = [{ node: root, inheritedNamespace: expectedNamespace }];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    const name = elementName(current.node);
    if (!name || name.startsWith('#') || name.startsWith('?')) continue;
    const declarations = attrs(current.node);
    const namespace = Object.prototype.hasOwnProperty.call(declarations, '@_xmlns')
      ? declarations['@_xmlns']
      : current.inheritedNamespace;
    if (name.includes(':') || namespace !== expectedNamespace) throw packageError();
    for (const child of children(current.node)) stack.push({ node: child, inheritedNamespace: namespace });
  }
}

function validateWordNamespaces(root: XmlNode): void {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    const name = elementName(current);
    const declarations = attrs(current);
    if (declarations['@_xmlns:w'] && declarations['@_xmlns:w'] !== WORD_NS) {
      throw new CompareError('DOCX_UNSUPPORTED_FEATURE', 'The DOCX uses an unsupported WordprocessingML namespace.');
    }
    if (name.startsWith('w:') && declarations['@_xmlns:w'] && declarations['@_xmlns:w'] !== WORD_NS) {
      throw new CompareError('DOCX_UNSUPPORTED_FEATURE', 'The DOCX uses an unsupported WordprocessingML namespace.');
    }
    for (const child of children(current)) stack.push(child);
  }
  if (attrs(root)['@_xmlns:w'] !== WORD_NS) {
    throw new CompareError('DOCX_UNSUPPORTED_FEATURE', 'Only Transitional WordprocessingML documents are supported.');
  }
}

function inspectUnsupportedPackageParts(entries: ZipEntry[], contentTypes: ContentTypeIndex, warnings: Set<string>): void {
  for (const entry of entries) {
    const name = entry.canonicalName;
    if (/^word\/header[^/]*\.xml$/iu.test(name)) warnings.add('DOCX header text is not included in the main-body comparison.');
    else if (/^word\/footer[^/]*\.xml$/iu.test(name)) warnings.add('DOCX footer text is not included in the main-body comparison.');
    else if (name === 'word/footnotes.xml') warnings.add('DOCX footnote text is not included in the main-body comparison.');
    else if (name === 'word/endnotes.xml') warnings.add('DOCX endnote text is not included in the main-body comparison.');
    else if (name === 'word/comments.xml') warnings.add('DOCX comment text is not included in the main-body comparison.');
    else if (name === 'word/numbering.xml') warnings.add('DOCX numbering labels are not included in the main-body comparison.');
    else if (/^(?:word\/embeddings\/|word\/activeX\/|customxml\/)/iu.test(name)) warnings.add('Embedded or custom XML content is not included in the comparison.');
    else if (/vbaProject\.bin$/iu.test(name)) throw new CompareError('DOCX_UNSUPPORTED_FEATURE', 'Macro-enabled Word documents are not supported.');
  }
  for (const contentType of contentTypes.overrides.values()) {
    const warning = warningForContentType(contentType);
    if (warning) warnings.add(warning);
  }
}

function indexContentTypes(root: XmlNode): ContentTypeIndex {
  const overrides = new Map<string, string>();
  const defaults = new Map<string, string>();
  for (const node of children(root)) {
    const values = attrs(node);
    if (elementName(node) === 'Override') {
      const partName = String(values['@_PartName'] ?? '');
      const contentType = String(values['@_ContentType'] ?? '');
      if (partName && contentType) overrides.set(normalizeInternalTarget(partName).toLowerCase(), contentType.toLowerCase());
    } else if (elementName(node) === 'Default') {
      const extension = String(values['@_Extension'] ?? '').replace(/^\./u, '').toLowerCase();
      const contentType = String(values['@_ContentType'] ?? '').toLowerCase();
      if (extension && contentType) defaults.set(extension, contentType);
    }
  }
  return { overrides, defaults };
}

function contentTypeForPart(partPath: string, index: ContentTypeIndex): string {
  const canonical = partPath.replace(/^\//u, '').toLowerCase();
  const override = index.overrides.get(canonical);
  if (override) return override;
  const extension = canonical.slice(canonical.lastIndexOf('.') + 1);
  return index.defaults.get(extension) ?? '';
}

function warningForContentType(contentType: string): string | undefined {
  if (/\.header\+xml$/u.test(contentType) || /wordprocessingml\.header\+xml$/u.test(contentType)) {
    return 'DOCX header text is not included in the main-body comparison.';
  }
  if (/wordprocessingml\.footer\+xml$/u.test(contentType)) return 'DOCX footer text is not included in the main-body comparison.';
  if (/wordprocessingml\.footnotes\+xml$/u.test(contentType)) return 'DOCX footnote text is not included in the main-body comparison.';
  if (/wordprocessingml\.endnotes\+xml$/u.test(contentType)) return 'DOCX endnote text is not included in the main-body comparison.';
  if (/wordprocessingml\.comments\+xml$/u.test(contentType)) return 'DOCX comment text is not included in the main-body comparison.';
  if (/wordprocessingml\.numbering\+xml$/u.test(contentType)) return 'DOCX numbering labels are not included in the main-body comparison.';
  if (/wordprocessingml\.glossarydocument\+xml$/u.test(contentType)) return 'Additional DOCX glossary text is not included in the comparison.';
  if (/customxml|chart\+xml|diagram\+xml|drawing\+xml/iu.test(contentType)) return 'Embedded or custom XML content is not included in the comparison.';
  return undefined;
}

function warningForRelationshipType(type: string): string | undefined {
  const suffix = type.slice(type.lastIndexOf('/') + 1).toLowerCase();
  if (suffix === 'header') return 'DOCX header text is not included in the main-body comparison.';
  if (suffix === 'footer') return 'DOCX footer text is not included in the main-body comparison.';
  if (suffix === 'footnotes') return 'DOCX footnote text is not included in the main-body comparison.';
  if (suffix === 'endnotes') return 'DOCX endnote text is not included in the main-body comparison.';
  if (suffix === 'comments' || suffix === 'commentsextensible' || suffix === 'commentsextended') {
    return 'DOCX comment text is not included in the main-body comparison.';
  }
  if (suffix === 'numbering') return 'DOCX numbering labels are not included in the main-body comparison.';
  if (suffix === 'glossarydocument') return 'Additional DOCX glossary text is not included in the comparison.';
  if (suffix === 'customxml') return 'Embedded or custom XML content is not included in the comparison.';
  if (suffix === 'hyperlink') return 'Hyperlink content is not included in the document comparison.';
  if (suffix === 'chart' || suffix === 'diagramData' || suffix === 'diagramDrawing') {
    return 'Embedded or custom XML content is not included in the comparison.';
  }
  return undefined;
}

function isKnownTextSafeRelationship(type: string): boolean {
  const suffix = type.slice(type.lastIndexOf('/') + 1).toLowerCase();
  return ['styles', 'settings', 'theme', 'fonttable', 'websettings', 'core-properties', 'extended-properties'].includes(suffix);
}

function isXmlContentType(contentType: string): boolean {
  return contentType === 'application/xml' || contentType === 'text/xml' || /\+xml$/u.test(contentType);
}

function resolveRelationshipTarget(sourcePart: string, target: string): string | undefined {
  if (!target || target.includes('\\') || target.includes('\0') || target.includes('?') || target.includes('#')
    || /^[a-z][a-z0-9+.-]*:/iu.test(target)) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(target); }
  catch { return undefined; }
  const segments = decoded.startsWith('/') ? [] : sourcePart.split('/').slice(0, -1);
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return undefined;
      segments.pop();
    } else segments.push(segment.normalize('NFC'));
  }
  return segments.join('/').toLowerCase();
}

function inspectUnsupportedXml(root: XmlNode, warnings: Set<string>): void {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    const name = elementName(current);
    if (IMAGE_OR_TEXT_UNSUPPORTED.has(name)) warnings.add(`${name.slice(2)} WordprocessingML content is not fully included in the comparison.`);
    if (name === 'w:numPr') warnings.add('DOCX numbering labels are not included in the main-body comparison.');
    if (name === 'w:tc' && children(current).some((child) => elementName(child) === 'w:tbl')) {
      warnings.add('Nested tables inside DOCX table cells are not included in the comparison.');
    }
    const directText = children(current).some((child) => (
      (elementName(child) === '#text' || elementName(child) === '#cdata')
      && String(child['#text'] ?? child['#cdata'] ?? '').length > 0
    ));
    if (directText && name !== 'w:t' && name !== 'w:delText' && !name.startsWith('#') && !name.startsWith('?')) {
      warnings.add('Unrecognized DOCX element text may be omitted from the comparison.');
    }
    if (name.includes(':') && !name.startsWith('w:') && !name.startsWith('?')) {
      warnings.add('Drawing, extension, or non-WordprocessingML content may contain text that is not included.');
    }
    for (const child of children(current)) stack.push(child);
  }
}

function extractCell(cell: XmlNode): string {
  const paragraphs = children(cell).filter((node) => elementName(node) === 'w:p').map(extractParagraph);
  return paragraphs.join('\n');
}

function extractParagraph(paragraph: XmlNode): string {
  let text = '';
  const stack = children(paragraph).slice().reverse();
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    const name = elementName(node);
    if (name === 'w:t') text += decodeXmlText(readText(node));
    else if (name === 'w:tab' || name === 'w:ptab') text += '\t';
    else if (name === 'w:br' || name === 'w:cr') text += '\n';
    else if (name === 'w:delText') { /* tracked deletions are warned and intentionally omitted */ }
    else {
      const nested = children(node);
      for (let index = nested.length - 1; index >= 0; index -= 1) stack.push(nested[index]);
    }
  }
  return text.replace(/\r\n?/gu, '\n');
}

function readText(node: XmlNode): string {
  return children(node)
    .filter((child) => elementName(child) === '#text' || elementName(child) === '#cdata')
    .map((child) => String(child['#text'] ?? child['#cdata'] ?? ''))
    .join('');
}

function decodeXmlText(text: string): string {
  return text.replace(/&([^;]+);/gu, (_match, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    const decimal = /^#([0-9]+)$/u.exec(entity);
    const hexadecimal = /^#x([0-9a-f]+)$/iu.exec(entity);
    return String.fromCodePoint(decimal ? Number(decimal[1]) : Number.parseInt(hexadecimal?.[1] ?? '', 16));
  });
}

function addTextBudget(current: number, text: string, remaining: number): number {
  const next = current + text.length;
  if (next > remaining || next > COMPARISON_LIMITS.maxTextCharactersTotal) {
    throw new CompareError('TEXT_LIMIT_EXCEEDED', 'The extracted document text is larger than the supported comparison limit.');
  }
  if (text.length > COMPARISON_LIMITS.maxPageTextCharacters) {
    throw new CompareError('TEXT_LIMIT_EXCEEDED', 'A DOCX logical block is larger than the supported text limit.');
  }
  return next;
}

function containsElementText(node: XmlNode): boolean {
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    if (elementName(current) === '#text' && String(current['#text'] ?? '').length > 0) return true;
    for (const child of children(current)) stack.push(child);
  }
  return false;
}

function children(node: XmlNode): XmlNode[] {
  const name = elementName(node);
  const value = node[name];
  return Array.isArray(value) ? value.filter((child): child is XmlNode => !!child && typeof child === 'object') : [];
}

function directChild(node: XmlNode, wanted: string): XmlNode | undefined {
  return children(node).find((child) => elementName(child) === wanted);
}

function elementName(node: XmlNode): string {
  return Object.keys(node).find((key) => key !== ':@') ?? '';
}

function attrs(node: XmlNode): Record<string, string> {
  const value = node[':@'];
  if (!value || typeof value !== 'object') return {};
  return value as Record<string, string>;
}

function packageError(): CompareError {
  return new CompareError('DOCX_PACKAGE_INVALID', 'The DOCX package is malformed, encrypted, or uses an unsupported ZIP feature.');
}

function xmlError(): CompareError {
  return new CompareError('DOCX_XML_INVALID', 'A DOCX XML part contains an unsupported entity reference.');
}
