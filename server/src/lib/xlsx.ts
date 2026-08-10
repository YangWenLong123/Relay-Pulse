import { deflateRawSync, inflateRawSync } from 'node:zlib';

export type SpreadsheetValue = string | number | boolean | null | undefined;

interface ZipEntry {
  name: string;
  data: Buffer;
}

function crc32(buffer: Buffer): number {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer {
  const output = Buffer.allocUnsafe(2);
  output.writeUInt16LE(value, 0);
  return output;
}

function u32(value: number): Buffer {
  const output = Buffer.allocUnsafe(4);
  output.writeUInt32LE(value >>> 0, 0);
  return output;
}

function zip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 6 });
    const checksum = crc32(entry.data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(checksum),
      u32(compressed.length), u32(entry.data.length), u16(name.length), u16(0), name, compressed
    ]);
    localParts.push(local);
    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(checksum),
      u32(compressed.length), u32(entry.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), name
    ]));
    offset += local.length;
  }

  const central = Buffer.concat(centralParts);
  const local = Buffer.concat(localParts);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(central.length), u32(local.length), u16(0)
  ]);
  return Buffer.concat([local, central, end]);
}

function columnName(index: number): string {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function cellXml(reference: string, value: SpreadsheetValue): string {
  if (value === null || value === undefined || value === '') return `<c r="${reference}"/>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
}

function worksheetXml(rows: SpreadsheetValue[][]): string {
  const rowXml = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => cellXml(`${columnName(columnIndex)}${rowIndex + 1}`, value)).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  const lastColumn = columnName(Math.max(0, (rows[0]?.length ?? 1) - 1));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="A1:${lastColumn}${Math.max(1, rows.length)}"/><sheetData>${rowXml}</sheetData></worksheet>`;
}

export function buildXlsx(rows: SpreadsheetValue[][]): Buffer {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`;
  const relationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="中转站" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="0"/><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleMedium9"/></styleSheet>`;
  return zip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    { name: '_rels/.rels', data: Buffer.from(relationships) },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRelationships) },
    { name: 'xl/styles.xml', data: Buffer.from(styles) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(worksheetXml(rows)) }
  ]);
}

function readZip(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = buffer.lastIndexOf(endSignature);
  if (endOffset >= 0 && endOffset + 22 <= buffer.length) {
    const centralOffset = buffer.readUInt32LE(endOffset + 16);
    const entryCount = buffer.readUInt16LE(endOffset + 10);
    let offset = centralOffset;
    for (let index = 0; index < entryCount && offset + 46 <= buffer.length; index += 1) {
      if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
      const method = buffer.readUInt16LE(offset + 10);
      const compressedSize = buffer.readUInt32LE(offset + 20);
      const nameLength = buffer.readUInt16LE(offset + 28);
      const extraLength = buffer.readUInt16LE(offset + 30);
      const commentLength = buffer.readUInt16LE(offset + 32);
      const localOffset = buffer.readUInt32LE(offset + 42);
      const nameStart = offset + 46;
      const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) entries.set(name, Buffer.from(compressed));
      else if (method === 8) entries.set(name, inflateRawSync(compressed));
      else throw new Error('Excel 文件使用了不支持的压缩方式');
      offset = nameStart + nameLength + extraLength + commentLength;
    }
    if (entries.size) return entries;
  }

  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) entries.set(name, Buffer.from(compressed));
    else if (method === 8) entries.set(name, inflateRawSync(compressed));
    else throw new Error('Excel 文件使用了不支持的压缩方式');
    offset = dataStart + compressedSize;
  }
  if (!entries.size) throw new Error('不是有效的 Excel 文件');
  return entries;
}

function xmlDecode(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity.toLowerCase() === 'amp') return '&';
    if (entity.toLowerCase() === 'lt') return '<';
    if (entity.toLowerCase() === 'gt') return '>';
    if (entity.toLowerCase() === 'quot') return '"';
    if (entity.toLowerCase() === 'apos') return "'";
    const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
}

function cellColumn(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? '';
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function sheetTarget(entries: Map<string, Buffer>): string {
  const workbook = entries.get('xl/workbook.xml');
  if (!workbook) throw new Error('Excel 文件缺少工作簿');
  const relationId = workbook.toString('utf8').match(/<sheet\b[^>]*r:id="([^"]+)"/)?.[1];
  const relations = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const target = relationId
    ? relations.match(new RegExp(`<Relationship\\b[^>]*Id="${relationId}"[^>]*Target="([^"]+)"`))?.[1]
    : undefined;
  if (!target) return 'xl/worksheets/sheet1.xml';
  return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
}

export function parseXlsxRows(buffer: Buffer): SpreadsheetValue[][] {
  const entries = readZip(buffer);
  const sheet = entries.get(sheetTarget(entries));
  if (!sheet) throw new Error('Excel 文件缺少工作表');
  const sharedStrings = entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const shared = [...sharedStrings.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    [...(match[1] ?? '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((item) => xmlDecode(item[1] ?? '')).join('')
  );
  const rows: SpreadsheetValue[][] = [];
  for (const rowMatch of sheet.toString('utf8').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: SpreadsheetValue[] = [];
    let fallbackColumn = 0;
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
      const attributes = cellMatch[1] ?? cellMatch[3] ?? '';
      const content = cellMatch[2] ?? '';
      const reference = attributes.match(/\br="([^"]+)"/)?.[1];
      const column = reference ? cellColumn(reference) : fallbackColumn;
      fallbackColumn = column + 1;
      const type = attributes.match(/\bt="([^"]+)"/)?.[1];
      const value = content.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
      if (type === 'inlineStr') row[column] = [...content.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((item) => xmlDecode(item[1] ?? '')).join('');
      else if (type === 's') row[column] = shared[Number(value)] ?? '';
      else if (type === 'b') row[column] = value === '1';
      else if (value === '') row[column] = '';
      else row[column] = Number.isFinite(Number(value)) ? Number(value) : xmlDecode(value);
    }
    rows.push(row.map((value) => value ?? ''));
  }
  if (!rows.length) throw new Error('Excel 工作表为空');
  return rows;
}
