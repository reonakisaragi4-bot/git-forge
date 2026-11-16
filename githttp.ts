// The git smart-HTTP surface: `/{owner}/{repo}.git/info/refs` advertisements
// and the upload-pack (v2 and v0) and receive-pack (v0) endpoints. No git
// binary exists here; packs are built and parsed in pure JS (see gitcore.ts).
// A missing repository is 404 on info/refs; a malformed pkt-line POST is 400
// and never takes the server down.

import {
  PKT_FLUSH,
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLines,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  pktText,
  readPack,
  sidebandWrap,
  verifyPackChecksum,
  writePack,
  type GitObject,
  type ObjectLookup,
} from './gitcore.ts';
import { bufferReply, errorReply, isAuthorized, type Reply } from './reply.ts';
import { VIEWER_LOGIN } from './scenario.ts';
import type { RepoRecord, Store } from './store.ts';

export interface GitContext {
  store: Store;
  expectedToken: string;
}

export interface GitRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function wantsV2(headers: Record<string, string | string[] | undefined>): boolean {
  return headerValue(headers, 'git-protocol').trim() === 'version=2';
}

/** The repository a git route names, or the 404 reply when it is not the viewer's. */
function repoOr404(ctx: GitContext, owner: string, name: string): { repo: RepoRecord } | { reply: Reply } {
  if (owner !== VIEWER_LOGIN) return { reply: errorReply(404, 'Not Found') };
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return { reply: errorReply(404, 'Not Found') };
  return { repo };
}

/** The peeled commit of an annotated tag object, or the oid itself otherwise. */
function peelObject(repo: RepoRecord, oid: string): string {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return oid;
  const target = parseTag(object.data).object;
  return peelObject(repo, target);
}

/** All refs in advertisement order: refs sorted by name. */
function advertisedRefs(repo: RepoRecord): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function uploadPackV0Caps(repo: RepoRecord): string {
  return `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k shallow thin-pack ofs-delta multi_ack`;
}

function receivePackCaps(): string {
  return 'report-status side-band-64k delete-refs ofs-delta';
}

/** The v0 ref advertisement for one service. */
function v0Advertisement(repo: RepoRecord, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadPackV0Caps(repo) : receivePackCaps();
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = advertisedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    if (headTip !== undefined) lines.push(`${headTip} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const object = repo.objects.get(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        lines.push(`${peelObject(repo, ref.oid)} ${ref.name}^{}\n`);
      }
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The v2 capability advertisement (upload-pack only). */
function v2Advertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'agent=git-forge/1.0.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'server-option\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

function advertisementReply(repo: RepoRecord, service: 'git-upload-pack' | 'git-receive-pack', v2: boolean): Reply {
  const body = service === 'git-upload-pack' && v2 ? v2Advertisement() : v0Advertisement(repo, service);
  return bufferReply(200, body, `application/x-${service}-advertisement`);
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsReply(repo: RepoRecord, args: LsRefsArgs): Reply {
  const lines: Array<string | 'flush'> = [];
  const refs = advertisedRefs(repo);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (refs.length === 0) {
    if (args.unborn && keep('HEAD')) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  } else {
    if (args.symrefs && keep('HEAD')) {
      const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (headTip !== undefined) lines.push(`${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      const object = repo.objects.get(ref.oid);
      if (args.peel && object !== undefined && object.type === 'tag') {
        line += ` peeled:${peelObject(repo, ref.oid)}`;
      }
      lines.push(`${line}\n`);
    }
  }
  lines.push('flush');
  return bufferReply(200, encodePktLines(lines), 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------------------------------------
// fetch object-set computation
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  wants: string[];
  haves: string[];
  boundaries: string[];
  depth: number | null;
}

/** The commits at the deepest included generation that still have parents. */
function shallowBoundary(wants: readonly string[], depth: number, lookup: ObjectLookup): Set<string> {
  const boundary = new Set<string>();
  const seen = new Set<string>();
  const queue: Array<{ oid: string; generation: number }> = wants.map((oid) => ({ oid, generation: 0 }));
  while (queue.length > 0) {
    const { oid, generation } = queue.shift() as { oid: string; generation: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      queue.push({ oid: parseTag(object.data).object, generation });
      continue;
    }
    if (object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (generation + 1 >= depth) {
      if (parents.length > 0) boundary.add(oid);
      continue;
    }
    for (const parent of parents) queue.push({ oid: parent, generation: generation + 1 });
  }
  return boundary;
}

/** The objects a fetch must send, plus its shallow-info lines. */
function planFetch(repo: RepoRecord, plan: FetchPlan): {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
} {
  const lookup = lookupOf(repo);
  const haveClosure = collectReachable(plan.haves, lookup, { stopParents: new Set(plan.boundaries) });
  const wantSet = collectReachable(plan.wants, lookup, plan.depth === null ? {} : { depth: plan.depth });
  const objects = new Map<string, GitObject>();
  for (const [oid, object] of wantSet) {
    if (!haveClosure.has(oid)) objects.set(oid, object);
  }
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (plan.depth !== null) {
    shallow = [...shallowBoundary(plan.wants, plan.depth, lookup)].sort();
    const oldBoundaries = new Set(plan.boundaries);
    for (const old of oldBoundaries) {
      if (shallow.includes(old)) continue;
      const object = repo.objects.get(old);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => wantSet.has(parent))) unshallow.push(old);
    }
    unshallow.sort();
  }
  const acks: string[] = [];
  for (const have of plan.haves) {
    if (!isOid(have) || have === ZERO_OID || !repo.objects.has(have)) continue;
    if (plan.wants.some((want) => want === have || isAncestor(have, want, lookup))) acks.push(have);
  }
  return { objects, shallow, unshallow, acks };
}

function lookupOf(repo: RepoRecord): ObjectLookup {
  return (oid: string) => repo.objects.get(oid);
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

function fetchV2Reply(repo: RepoRecord, plan: FetchPlan): Reply {
  const { objects, shallow, unshallow, acks } = planFetch(repo, plan);
  const parts: Buffer[] = [];
  const ackLines: Array<string | 'delim'> = ['acknowledgments\n'];
  if (acks.length > 0) {
    for (const ack of acks) ackLines.push(`ACK ${ack}\n`);
    ackLines.push('ready\n');
  } else {
    ackLines.push('NAK\n');
  }
  ackLines.push('delim');
  parts.push(encodePktLines(ackLines));
  const hasPack = objects.size > 0;
  const hasShallowInfo = plan.depth !== null && (shallow.length > 0 || unshallow.length > 0);
  if (hasShallowInfo) {
    const shallowLines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of shallow) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of unshallow) shallowLines.push(`unshallow ${oid}\n`);
    shallowLines.push(hasPack ? 'delim' : 'flush');
    parts.push(encodePktLines(shallowLines));
  } else if (!hasPack) {
    parts.push(PKT_FLUSH);
  }
  if (hasPack) {
    parts.push(pktText('packfile\n'));
    parts.push(sidebandWrap(writePack(objects.values())));
    parts.push(PKT_FLUSH);
  }
  return bufferReply(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function fetchV0Reply(repo: RepoRecord, plan: FetchPlan): Reply {
  const { objects, shallow, unshallow, acks } = planFetch(repo, plan);
  const lines: string[] = [];
  if (acks.length > 0) {
    for (const ack of acks) lines.push(`ACK ${ack}\n`);
  } else {
    lines.push('NAK\n');
  }
  for (const oid of shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of unshallow) lines.push(`unshallow ${oid}\n`);
  const parts: Buffer[] = [encodePktLines(lines)];
  if (objects.size > 0) parts.push(sidebandWrap(writePack(objects.values())));
  parts.push(PKT_FLUSH);
  return bufferReply(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function parseV2Command(body: Buffer): { command: string; args: string[] } | null {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  let command: string | null = null;
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!afterDelim) {
      if (command === null && line.startsWith('command=')) command = line.slice('command='.length).replace(/\n$/, '');
      continue;
    }
    args.push(line.replace(/\n$/, ''));
  }
  if (command === null) return null;
  return { command, args };
}

function handleUploadPackV2(repo: RepoRecord, body: Buffer): Reply {
  const parsed = parseV2Command(body);
  if (parsed === null) return errorReply(400, 'Malformed protocol v2 request');
  if (parsed.command === 'ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const arg of parsed.args) {
      if (arg === 'peel') args.peel = true;
      else if (arg === 'symrefs') args.symrefs = true;
      else if (arg === 'unborn') args.unborn = true;
      else if (arg.startsWith('ref-prefix ')) args.prefixes.push(arg.slice('ref-prefix '.length));
    }
    return lsRefsReply(repo, args);
  }
  if (parsed.command === 'fetch') {
    const plan: FetchPlan = { wants: [], haves: [], boundaries: [], depth: null };
    for (const arg of parsed.args) {
      if (arg.startsWith('want ')) plan.wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) plan.haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) plan.boundaries.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) {
        const depth = Number(arg.slice(7).trim());
        if (Number.isFinite(depth) && depth > 0) plan.depth = Math.trunc(depth);
      }
    }
    if (plan.wants.length === 0) return errorReply(400, 'fetch needs at least one want');
    return fetchV2Reply(repo, plan);
  }
  return errorReply(400, `Unknown protocol v2 command: ${parsed.command}`);
}

function handleUploadPackV0(repo: RepoRecord, body: Buffer): Reply {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return errorReply(400, 'Malformed pkt-line request');
  }
  const plan: FetchPlan = { wants: [], haves: [], boundaries: [], depth: null };
  let seenFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenFlush) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        plan.wants.push(space < 0 ? rest : rest.slice(0, space));
      } else if (line.startsWith('shallow ')) plan.boundaries.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const depth = Number(line.slice(7).trim());
        if (Number.isFinite(depth) && depth > 0) plan.depth = Math.trunc(depth);
      }
    } else if (line.startsWith('have ')) {
      plan.haves.push(line.slice(5).trim());
    }
  }
  if (plan.wants.length === 0) return errorReply(400, 'fetch needs at least one want');
  return fetchV0Reply(repo, plan);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Split a receive-pack body into its command lines and the pack that follows. */
function splitReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } | null {
  const commands: PushCommand[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) return null;
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(head)) return null;
    const length = parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) return null;
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    const nul = payload.indexOf('\0');
    const line = (nul < 0 ? payload : payload.slice(0, nul)).replace(/\n$/, '');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match === null) return null;
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
    offset += length;
  }
  return { commands, pack: body.subarray(offset) };
}

function pushReportReply(results: Array<{ ref: string; ok: boolean; reason: string }>, unpackOk: boolean, unpackDetail: string): Reply {
  const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = encodePktLines(lines);
  return bufferReply(200, Buffer.concat([sidebandWrap(report), PKT_FLUSH]), 'application/x-git-receive-pack-result');
}

function handleReceivePack(repo: RepoRecord, body: Buffer): Reply {
  const split = splitReceivePack(body);
  if (split === null || split.commands.length === 0) return errorReply(400, 'Malformed receive-pack request');
  const { commands } = split;
  // Unpack first: a refused ref still leaves its objects in the store.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (split.pack.length > 0) {
    try {
      if (split.pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
      const checksum = verifyPackChecksum(split.pack);
      if (!checksum.ok) throw new Error('pack trailer checksum mismatch');
      const read = readPack(split.pack, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (error) {
      unpackOk = false;
      unpackDetail = error instanceof Error ? error.message : 'unpack failed';
      return pushReportReply([], false, unpackDetail);
    }
  }
  const lookup = lookupOf(repo);
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const newObject = repo.objects.get(command.newOid);
    if (newObject === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else if (command.ref.startsWith('refs/heads/') && newObject.type !== 'commit') {
        results.push({ ref: command.ref, ok: false, reason: 'not a commit' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: the old value must match and the new tip must fast-forward.
    if (current === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
    } else if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else if (command.newOid === current) {
      results.push({ ref: command.ref, ok: true, reason: '' });
    } else if (command.ref.startsWith('refs/heads/') && newObject.type !== 'commit') {
      results.push({ ref: command.ref, ok: false, reason: 'not a commit' });
    } else if (isAncestor(current, command.newOid, lookup)) {
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    } else {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    }
  }
  return pushReportReply(results, unpackOk, unpackDetail);
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

/** Route one git smart-HTTP request. Returns null when the path is not a git path. */
export function routeGit(ctx: GitContext, req: GitRequest): Reply | null {
  const segments = req.segments;
  if (segments.length < 2) return null;
  const repoSegment = segments[1] as string;
  if (!repoSegment.endsWith('.git')) return null;
  const owner = segments[0] as string;
  const repoName = repoSegment.slice(0, -4);
  const tail = segments.slice(2);
  if (!isAuthorized(req.headers, ctx.expectedToken)) return errorReply(401, 'Requires authentication');
  const found = repoOr404(ctx, owner, repoName);
  if ('reply' in found) return found.reply;
  const repo = found.repo;
  if (req.method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = req.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return errorReply(404, 'Not Found');
    return advertisementReply(repo, service, service === 'git-upload-pack' && wantsV2(req.headers));
  }
  if (req.method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    if (wantsV2(req.headers)) return handleUploadPackV2(repo, req.body);
    return handleUploadPackV0(repo, req.body);
  }
  if (req.method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    return handleReceivePack(repo, req.body);
  }
  return errorReply(404, 'Not Found');
}
