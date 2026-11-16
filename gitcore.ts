// The git object layer: SHA-1 ids, pkt-line framing, packfiles, and the
// tree/commit/tag object formats. Pure functions over Buffers; no I/O, no
// clock, no randomness. The store (store.ts) keeps the objects this layer
// hashes, parses and builds.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: ObjType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export type Packet =
  | { kind: 'data'; payload: Buffer; raw: Buffer }
  | { kind: 'flush'; raw: Buffer }
  | { kind: 'delim'; raw: Buffer }
  | { kind: 'response-end'; raw: Buffer };

/** One pkt-line for `payload` (a payload over 65516 bytes is split by the caller). */
export function pktLine(payload: Uint8Array): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const total = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(total.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** A text pkt-line: the line's bytes plus its trailing newline. */
export function pktText(line: string): Buffer {
  return pktLine(Buffer.from(line.endsWith('\n') ? line : `${line}\n`, 'utf8'));
}

/** Parse a whole buffer of pkt-lines. Throws on a malformed length prefix. */
export function decodePktLines(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line length');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line length out of range');
    packets.push({
      kind: 'data',
      payload: buffer.subarray(offset + 4, offset + length),
      raw: buffer.subarray(offset, offset + length),
    });
    offset += length;
  }
  return packets;
}

/** The data payloads of a pkt-line buffer, in order (flush/delim dropped). */
export function pktDataLines(buffer: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (const packet of decodePktLines(buffer)) {
    if (packet.kind === 'data') out.push(packet.payload);
  }
  return out;
}

/** Split a byte stream into pkt-lines (flush at the end); payloads are chunked at 65516 bytes. */
export function encodePktLines(lines: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') {
      parts.push(PKT_FLUSH);
      continue;
    }
    if (line === 'delim') {
      parts.push(PKT_DELIM);
      continue;
    }
    const body = typeof line === 'string' ? Buffer.from(line, 'utf8') : line;
    for (let offset = 0; offset < body.length; offset += 65516) {
      parts.push(pktLine(body.subarray(offset, offset + 65516)));
    }
    if (body.length === 0) parts.push(pktLine(Buffer.alloc(0)));
  }
  return Buffer.concat(parts);
}

/** One sideband packet: a pkt-line whose payload is a band byte plus data. */
export function sidebandPacket(band: 1 | 2 | 3, data: Uint8Array): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const payload = Buffer.concat([Buffer.from([band]), body]);
  return pktLine(payload);
}

/** Wrap bytes in band-1 sideband packets, chunked so no pkt-line exceeds 65520 bytes. */
export function sidebandWrap(data: Uint8Array): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < body.length; offset += 65515) {
    parts.push(sidebandPacket(1, body.subarray(offset, offset + 65515)));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// trees, commits, tags
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) throw new Error('tree entry is truncated');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object from its fields. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Read a pack entry's type/size varint at `offset`. */
function readPackEntryHeader(pack: Buffer, offset: number): {
  typeCode: number;
  size: number;
  next: number;
  first: number;
} {
  if (offset >= pack.length) throw new Error('pack entry has no size header');
  let byte = pack[offset] ?? 0;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let pos = offset + 1;
  while ((byte & 0x80) !== 0) {
    if (pos >= pack.length) throw new Error('pack entry size varint is truncated');
    byte = pack[pos] ?? 0;
    pos += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { typeCode: (first >> 4) & 0x07, size, next: pos, first };
}

/** Read an ofs-delta's base offset (the distance back from the entry). */
function readOfsDeltaBase(pack: Buffer, offset: number): { distance: number; next: number } {
  if (offset >= pack.length) throw new Error('ofs-delta has no base offset');
  let byte = pack[offset] ?? 0;
  let pos = offset + 1;
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    if (pos >= pack.length) throw new Error('ofs-delta base offset is truncated');
    byte = pack[pos] ?? 0;
    pos += 1;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { distance: value, next: pos };
}

/** Write a pack entry's type/size varint. */
function writePackEntryHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining >>>= 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Apply a delta (git's binary delta format) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[pos] ?? 0;
      pos += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size does not match');
  const resultSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos] ?? 0;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          offset |= (delta[pos] ?? 0) << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          size |= (delta[pos] ?? 0) << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (produced !== resultSize) throw new Error('delta result size does not match');
  return Buffer.concat(parts);
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
  declaredCount: number;
  version: number;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolved?: Buffer;
  resolvedType?: ObjType;
  oid?: string;
}

/** Parse a packfile, resolving any deltas against objects in the same pack or `resolveBase`. */
export function readPack(
  pack: Uint8Array,
  options: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): PackReadResult {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackEntryHeader(buffer, offset);
    offset = header.next;
    const entry: RawPackEntry = { offset: entryOffset, typeCode: header.typeCode, size: header.size, data: Buffer.alloc(0) };
    if (header.typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.distance <= 0 || base.distance > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base distance ${base.distance}`);
      }
      entry.baseOffset = entryOffset - base.distance;
    } else if (header.typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[header.typeCode] === undefined) {
      throw new Error(`pack entry ${index} has unknown type code ${header.typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid ?? '';
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (external === undefined) {
          throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        }
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as ObjType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount, declaredCount, version };
}

/** Verify a packfile's SHA-1 trailer against its bytes. */
export function verifyPackChecksum(pack: Uint8Array): { ok: boolean; expected: string; actual: string } {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 20) return { ok: false, expected: '', actual: '' };
  const body = buffer.subarray(0, buffer.length - 20);
  const expected = createHash('sha1').update(body).digest('hex');
  const actual = buffer.subarray(buffer.length - 20).toString('hex');
  return { ok: expected === actual, expected, actual };
}

/** Build a packfile (version 2, no deltas) from whole objects. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------------------------
// reachability, tree diffs, merge
// ---------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Walk a commit's parents (depth-first, newest first) without revisiting. */
export function commitAncestors(start: string, lookup: ObjectLookup): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const stack: string[] = [start];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    order.push(oid);
    const view = parseCommit(object.data);
    for (let i = view.parents.length - 1; i >= 0; i -= 1) stack.push(view.parents[i] as string);
  }
  return order;
}

/** Whether `ancestor` is reachable from `descendant` (or equal to it). */
export function isAncestor(ancestor: string, descendant: string, lookup: ObjectLookup): boolean {
  if (ancestor === descendant) return true;
  return commitAncestors(descendant, lookup).includes(ancestor);
}

/** The nearest common ancestor of two commits (first found walking both histories). */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  if (a === b) return a;
  const aAncestors = new Set(commitAncestors(a, lookup));
  for (const oid of commitAncestors(b, lookup)) {
    if (aAncestors.has(oid)) return oid;
  }
  return null;
}

/**
 * Every object reachable from `tips`, in a stable order: commits newest first
 * (by walk order), then their trees and blobs. Tags resolve to their target.
 * `depth` caps commit generations (1 = only the tips themselves); trees and
 * blobs are always walked fully. `exclude` oids are pruned with their closure.
 * `stopParents` commits keep their trees and blobs but do not descend to
 * their parents (a shallow boundary: the client holds the commit, not its
 * history).
 */
export function collectReachable(
  tips: readonly string[],
  lookup: ObjectLookup,
  options: { depth?: number; exclude?: ReadonlySet<string>; stopParents?: ReadonlySet<string> } = {},
): Map<string, GitObject> {
  const found = new Map<string, GitObject>();
  const exclude = options.exclude ?? new Set<string>();
  const stopParents = options.stopParents ?? new Set<string>();
  const queue: Array<{ oid: string; generation: number }> = [];
  for (const tip of tips) queue.push({ oid: tip, generation: 0 });
  const seenCommits = new Set<string>();
  const seenTrees = new Set<string>();
  while (queue.length > 0) {
    const { oid, generation } = queue.shift() as { oid: string; generation: number };
    if (exclude.has(oid) || found.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    found.set(oid, object);
    if (object.type === 'commit') {
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      const view = parseCommit(object.data);
      queue.push({ oid: view.tree, generation });
      if (!stopParents.has(oid) && (options.depth === undefined || generation + 1 < options.depth)) {
        for (const parent of view.parents) queue.push({ oid: parent, generation: generation + 1 });
      }
    } else if (object.type === 'tree') {
      if (seenTrees.has(oid)) continue;
      seenTrees.add(oid);
      for (const entry of parseTree(object.data)) queue.push({ oid: entry.oid, generation });
    } else if (object.type === 'tag') {
      queue.push({ oid: parseTag(object.data).object, generation });
    }
  }
  return found;
}

/** The flat path -> {oid, mode} map of a tree, recursing into subtrees. */
export function flattenTree(treeOid: string, lookup: ObjectLookup): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  oldMode: string | null;
  newMode: string | null;
}

/** The file-level diff between two trees (base -> head), sorted by path. */
export function diffTrees(baseTree: string, headTree: string, lookup: ObjectLookup): FileChange[] {
  const base = flattenTree(baseTree, lookup);
  const head = flattenTree(headTree, lookup);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = base.get(path);
    const newEntry = head.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      changes.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid, oldMode: null, newMode: newEntry.mode });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      changes.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null, oldMode: oldEntry.mode, newMode: null });
    } else if (oldEntry !== undefined && newEntry !== undefined && (oldEntry.oid !== newEntry.oid || oldEntry.mode !== newEntry.mode)) {
      changes.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid, oldMode: oldEntry.mode, newMode: newEntry.mode });
    }
  }
  return changes;
}

/** Count added/deleted lines between two blob contents (a crude line diff). */
export function countLineChanges(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  const newCounts = new Map<string, number>();
  for (const line of newLines) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) additions += Math.max(0, count - (oldCounts.get(line) ?? 0));
  for (const [line, count] of oldCounts) deletions += Math.max(0, count - (newCounts.get(line) ?? 0));
  return { additions, deletions };
}

/** The ref name a branch or tag short name resolves to, or null when it is not a ref. */
export function refNameFor(ref: string): string | null {
  if (ref.startsWith('refs/')) return ref;
  return null;
}

/** Whether a ref name is a branch ref. */
export function isBranchRef(ref: string): boolean {
  return ref.startsWith('refs/heads/');
}

/** Whether a ref name is a tag ref. */
export function isTagRef(ref: string): boolean {
  return ref.startsWith('refs/tags/');
}
