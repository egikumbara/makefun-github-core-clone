// server.ts — one HTTP server for the whole forge: git smart HTTP (upload-pack v2,
// receive-pack v0), REST v3, GraphQL v4 and MCP, over a single in-memory Store.
// No git binary, no outside service, no UI.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  looksLikePktLines,
  parseCommit,
  parseTag,
  parseTree,
  planFetch,
  pktLineDelim,
  pktLineFlush,
  readPack,
  writePack,
  type GitObject,
} from './git.ts';
import { GraphQLExecutor } from './graphql.ts';
import { MCP_TOOLS, McpMissingArg, dispatchTool } from './mcp.ts';
import {
  VIEWER,
  Store,
  StoreError,
  commentJson,
  globalId,
  isoFromEpoch,
  issueJson,
  pullJson,
  repoJson,
  type Repo,
} from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const AGENT = 'forge/1.0';

function sendJson(res: ServerResponse, requestId: string, status: number, body: unknown, extra?: Record<string, string>): void {
  const text = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': requestId,
    ...(extra ?? {}),
  });
  res.end(text);
}

function sendError(res: ServerResponse, requestId: string, status: number, message: string): void {
  sendJson(res, requestId, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body: empty body is {}; invalid JSON is a 400. */
function parseJsonBody(body: Buffer): unknown {
  const text = body.toString('utf8').trim();
  if (text === '') return {};
  return JSON.parse(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(\S+)$/.exec(header);
  return match !== null && match[1] !== '';
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: '' };
  return { name: match[1], email: match[2], date: isoFromEpoch(Number(match[3])) };
}

// -------------------------------------------------------------------------------------------
// git smart HTTP
// -------------------------------------------------------------------------------------------

function pkt(text: string): Buffer {
  return encodePktLine(text);
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

function peeledOid(store: Store, repo: Repo, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const object = store.getObject(repo, current);
    if (!object) return null;
    if (object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return null;
}

function v2Capabilities(): string[] {
  return ['agent=forge/1.0', 'ls-refs=unborn', 'fetch=shallow filter', 'object-format=sha1'];
}

function v0UploadCapabilities(): string {
  return 'side-band-64k ofs-delta thin-pack multi_ack multi_ack_detailed shallow agent=forge/1.0 symref=HEAD:refs/heads/main object-format=sha1';
}

function v0ReceiveCapabilities(): string {
  return 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main';
}

class GitHandler {
  private readonly store: Store;
  constructor(store: Store) { this.store = store; }

  infoRefs(req: IncomingMessage, res: ServerResponse, requestId: string, owner: string, repoName: string, service: 'git-upload-pack' | 'git-receive-pack'): void {
    const repo = this.store.getRepo(owner, repoName);
    if (!repo) {
      sendError(res, requestId, 404, 'Repository not found');
      return;
    }
    const isV2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
    const refs = this.store.sortedRefs(repo);
    const headTip = this.store.defaultBranchTip(repo);
    const parts: Buffer[] = [];
    if (service === 'git-upload-pack' && isV2) {
      parts.push(pkt('# service=git-upload-pack\n'), pktLineFlush());
      parts.push(pkt('version 2\n'));
      for (const cap of v2Capabilities()) parts.push(pkt(`${cap}\n`));
      parts.push(pktLineFlush());
    } else {
      const preamble = service === 'git-upload-pack' ? '# service=git-upload-pack\n' : '# service=git-receive-pack\n';
      const caps = service === 'git-upload-pack' ? v0UploadCapabilities() : v0ReceiveCapabilities();
      parts.push(pkt(preamble), pktLineFlush());
      if (refs.length === 0) {
        parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
      } else {
        const headLine = headTip === null ? null : `${headTip} HEAD\0${caps}\n`;
        if (headLine !== null) parts.push(pkt(headLine));
        for (const ref of refs) parts.push(pkt(`${ref.oid} ${ref.name}\n`));
        for (const ref of refs) {
          if (!ref.name.startsWith('refs/tags/')) continue;
          const peeled = peeledOid(this.store, repo, ref.oid);
          if (peeled !== null && peeled !== ref.oid) parts.push(pkt(`${peeled} ${ref.name}^{}\n`));
        }
      }
      parts.push(pktLineFlush());
    }
    res.writeHead(200, {
      'content-type': `application/x-${service}-advertisement`,
      'x-github-request-id': requestId,
    });
    res.end(Buffer.concat(parts));
  }

  uploadPack(req: IncomingMessage, res: ServerResponse, requestId: string, owner: string, repoName: string, body: Buffer): void {
    const repo = this.store.getRepo(owner, repoName);
    if (!repo) {
      sendError(res, requestId, 404, 'Repository not found');
      return;
    }
    if (body.length === 0 || !looksLikePktLines(body)) {
      sendError(res, requestId, 400, 'Malformed git request');
      return;
    }
    let packets;
    try {
      packets = decodePktLines(body).packets;
    } catch {
      sendError(res, requestId, 400, 'Malformed git request');
      return;
    }
    const isV2 = req.headers['git-protocol'] === 'version=2';
    if (isV2) {
      this.uploadPackV2(repo, res, requestId, packets);
    } else {
      this.uploadPackV0(repo, res, requestId, packets);
    }
  }

  private fetchPlanFrom(
    repo: Repo,
    wants: string[],
    haves: string[],
    shallow: string[],
    depth: number | undefined,
  ): { pack: Buffer; shallow: string[]; unshallow: string[] } {
    const plan = planFetch(wants, haves, shallow, depth, this.store.lookup(repo));
    return { pack: writePack(plan.objects), shallow: plan.shallow, unshallow: plan.unshallow };
  }

  private uploadPackV2(
    repo: Repo,
    res: ServerResponse,
    requestId: string,
    packets: ReturnType<typeof decodePktLines>['packets'],
  ): void {
    const lines: string[] = [];
    for (const packet of packets) {
      if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    }
    const command = (lines[0] ?? '').trim();
    if (command !== 'command=ls-refs' && command !== 'command=fetch') {
      sendError(res, requestId, 400, `Unknown v2 command: ${command}`);
      return;
    }
    if (command === 'command=ls-refs') {
      const args = lines.slice(1);
      const prefixes: string[] = [];
      let peel = false;
      let symrefs = false;
      for (const arg of args) {
        const text = arg.trim();
        if (text === 'peel') peel = true;
        else if (text === 'symrefs') symrefs = true;
        else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
      }
      const out: Buffer[] = [];
      const headTip = this.store.defaultBranchTip(repo);
      const refs = this.store.sortedRefs(repo);
      const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
      if (keep('HEAD')) {
        if (headTip === null) out.push(pkt('unborn HEAD symref-target:refs/heads/main\n'));
        else out.push(pkt(`${headTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
      }
      for (const ref of refs) {
        if (!keep(ref.name)) continue;
        let line = `${ref.oid} ${ref.name}`;
        if (ref.name.startsWith('refs/tags/') && peel) {
          const peeled = peeledOid(this.store, repo, ref.oid);
          if (peeled !== null && peeled !== ref.oid) line += ` peeled:${peeled}`;
        }
        out.push(pkt(`${line}\n`));
      }
      out.push(pktLineFlush());
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': requestId });
      res.end(Buffer.concat(out));
      return;
    }
    // command=fetch
    const args = lines.slice(1);
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | undefined;
    for (const arg of args) {
      const text = arg.trim();
      if (text.startsWith('want ')) wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
    }
    const plan = this.fetchPlanFrom(repo, wants, haves, shallow, depth);
    const parts: Buffer[] = [];
    parts.push(pkt('acknowledgments\n'));
    let acked = false;
    for (const have of haves) {
      if (this.store.getObject(repo, have)) {
        parts.push(pkt(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pkt('NAK\n'));
    parts.push(pkt('ready\n'));
    parts.push(pktLineDelim());
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pkt('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
      parts.push(pktLineDelim());
    }
    const wantedRefs: Array<{ oid: string; ref: string }> = [];
    for (const want of wants) {
      for (const ref of this.store.sortedRefs(repo)) {
        if (ref.oid === want) wantedRefs.push({ oid: want, ref: ref.name });
      }
    }
    if (wantedRefs.length > 0) {
      parts.push(pkt('wanted-refs\n'));
      for (const entry of wantedRefs) parts.push(pkt(`${entry.oid} ${entry.ref}\n`));
      parts.push(pktLineDelim());
    }
    parts.push(pkt('packfile\n'));
    for (const packet of sidebandPackets(plan.pack)) parts.push(packet);
    parts.push(pktLineFlush());
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': requestId });
    res.end(Buffer.concat(parts));
  }

  private uploadPackV0(
    repo: Repo,
    res: ServerResponse,
    requestId: string,
    packets: ReturnType<typeof decodePktLines>['packets'],
  ): void {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | undefined;
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').trim();
      if (text.startsWith('want ')) {
        const rest = text.slice(5).trim();
        const oid = rest.split(' ')[0];
        if (isObjectId(oid)) wants.push(oid);
      } else if (text.startsWith('have ')) {
        const oid = text.slice(5).trim();
        if (isObjectId(oid)) haves.push(oid);
      } else if (text.startsWith('shallow ')) {
        shallow.push(text.slice(8).trim());
      } else if (text.startsWith('deepen ')) {
        depth = Number(text.slice(7).trim());
      }
    }
    if (wants.length === 0) {
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': requestId });
      res.end(Buffer.concat([pkt('NAK\n'), pktLineFlush()]));
      return;
    }
    const plan = this.fetchPlanFrom(repo, wants, haves, shallow, depth);
    const parts: Buffer[] = [];
    let acked = false;
    for (const have of haves) {
      if (this.store.getObject(repo, have)) {
        parts.push(pkt(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pkt('NAK\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    for (const packet of sidebandPackets(plan.pack)) parts.push(packet);
    parts.push(pktLineFlush());
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': requestId });
    res.end(Buffer.concat(parts));
  }

  receivePack(req: IncomingMessage, res: ServerResponse, requestId: string, owner: string, repoName: string, body: Buffer): void {
    const repo = this.store.getRepo(owner, repoName);
    if (!repo) {
      sendError(res, requestId, 404, 'Repository not found');
      return;
    }
    if (body.length === 0 || !looksLikePktLines(body)) {
      sendError(res, requestId, 400, 'Malformed git request');
      return;
    }
    let decoded;
    try {
      decoded = decodePktLines(body);
    } catch {
      sendError(res, requestId, 400, 'Malformed git request');
      return;
    }
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    for (const packet of decoded.packets) {
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      let text = packet.payload.toString('utf8');
      const nul = text.indexOf('\0');
      if (nul >= 0) text = text.slice(0, nul);
      const line = text.replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length < 3) continue;
      const [oldOid, newOid, ref] = parts;
      if (isObjectId(oldOid) && isObjectId(newOid) && ref.startsWith('refs/')) {
        commands.push({ oldOid, newOid, ref });
      }
    }
    if (commands.length === 0) {
      sendError(res, requestId, 400, 'No ref commands in push');
      return;
    }
    const packBytes = body.subarray(decoded.consumed);
    const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
    let unpackOk = true;
    let unpackDetail = 'ok';
    if (needsPack) {
      if (packBytes.length === 0) {
        unpackOk = false;
        unpackDetail = 'missing packfile';
      } else {
        try {
          const read = readPack(packBytes, { resolveBase: this.store.lookup(repo) });
          for (const [oid, object] of read.objects) {
            this.store.putObject(repo, object.type, object.data);
            void oid;
          }
        } catch (err) {
          unpackOk = false;
          unpackDetail = err instanceof Error ? err.message : 'unpack failed';
        }
      }
    }
    const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
    if (unpackOk) {
      for (const command of commands) {
        const current = this.store.refTarget(repo, command.ref);
        if (command.newOid === ZERO_OID) {
          if (current === undefined) results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
          else if (command.oldOid !== current) results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
          else {
            this.store.deleteRef(repo, command.ref);
            results.push({ ref: command.ref, ok: true, reason: '' });
          }
          continue;
        }
        if (command.oldOid === ZERO_OID) {
          if (current !== undefined) {
            results.push({ ref: command.ref, ok: false, reason: 'already exists' });
            continue;
          }
        } else {
          if (current === undefined) {
            results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
            continue;
          }
          if (command.oldOid !== current) {
            results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
            continue;
          }
        }
        if (!this.store.getObject(repo, command.newOid)) {
          results.push({ ref: command.ref, ok: false, reason: 'object not found' });
          continue;
        }
        if (command.oldOid !== ZERO_OID && !isAncestor(command.oldOid, command.newOid, this.store.lookup(repo))) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        this.store.setRef(repo, command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
    } else {
      for (const command of commands) {
        results.push({ ref: command.ref, ok: false, reason: unpackDetail });
      }
    }
    const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
    for (const result of results) {
      reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
    }
    const parts: Buffer[] = [];
    for (const line of reportLines) {
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), pkt(line)])));
    }
    parts.push(pktLineFlush());
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'x-github-request-id': requestId });
    res.end(Buffer.concat(parts));
  }
}

// -------------------------------------------------------------------------------------------
// REST v3
// -------------------------------------------------------------------------------------------

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; link: string | null; total: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  const total = items.length;
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  return { page: pageItems as T[], link: null, total };
}

function linkHeader(req: IncomingMessage, pathname: string, query: URLSearchParams, perPage: number, page: number, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (lastPage <= 1) return null;
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${pathname}`;
  const links: string[] = [];
  if (page < lastPage) links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  if (page > 1) links.push(`<${base}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
  links.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
  links.push(`<${base}?per_page=${perPage}&page=${lastPage}>; rel="last"`);
  void query;
  return links.join(', ');
}

class RestHandler {
  private readonly store: Store;
  constructor(store: Store) { this.store = store; }

  private requireRepo(owner: string, name: string): Repo {
    const repo = this.store.getRepo(owner, name);
    if (!repo) throw new StoreError(404, 'Not Found');
    return repo;
  }

  private parseNumber(value: string | undefined): number | null {
    if (value === undefined) return null;
    const num = Number(value);
    return Number.isInteger(num) && num > 0 ? num : null;
  }

  handle(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
    method: string,
    segments: string[],
    query: URLSearchParams,
    body: unknown,
  ): void {
    // /api/v3/ root and /api/v3/meta need no auth; everything else does.
    const isRoot = segments.length === 0;
    const isMeta = segments.length === 1 && segments[0] === 'meta';
    if (!isRoot && !isMeta && !authed(req)) {
      sendError(res, requestId, 401, 'Requires authentication');
      return;
    }
    if (method === 'GET' && isRoot) {
      sendJson(res, requestId, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_url: '/api/v3/users/{user}',
      }, { 'x-oauth-scopes': 'repo, user' });
      return;
    }
    if (method === 'GET' && isMeta) {
      sendJson(res, requestId, 200, { installed_version: '1.0.0' });
      return;
    }
    if (segments[0] === 'user') return this.handleUser(req, res, requestId, method, segments.slice(1), query, body);
    if (segments[0] === 'repos') return this.handleRepos(req, res, requestId, method, segments.slice(1), query, body);
    sendError(res, requestId, 404, 'Not Found');
  }

  private handleUser(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
    method: string,
    segments: string[],
    query: URLSearchParams,
    body: unknown,
  ): void {
    if (segments.length === 0 && method === 'GET') {
      sendJson(res, requestId, 200, {
        login: VIEWER.login,
        id: VIEWER.id,
        name: VIEWER.name,
        email: VIEWER.email,
        type: 'User',
      });
      return;
    }
    if (segments.length === 1 && segments[0] === 'repos' && method === 'GET') {
      const repos = this.store.listViewerRepos();
      const perPageRaw = Number(query.get('per_page') ?? '30');
      const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
      const pageRaw = Number(query.get('page') ?? '1');
      const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
      const start = (page - 1) * perPage;
      const items = repos.slice(start, start + perPage).map((repo) => repoJson(repo));
      const link = linkHeader(req, '/api/v3/user/repos', query, perPage, page, repos.length);
      sendJson(res, requestId, 200, items, link === null ? {} : { link });
      return;
    }
    if (segments.length === 1 && segments[0] === 'repos' && method === 'POST') {
      const input = isRecord(body) ? body : {};
      const name = typeof input.name === 'string' ? input.name : '';
      const description = typeof input.description === 'string' ? input.description : '';
      const isPrivate = input.private === true;
      const repo = this.store.createRepo(name, description, isPrivate);
      sendJson(res, requestId, 201, repoJson(repo));
      return;
    }
    sendError(res, requestId, 404, 'Not Found');
  }

  private handleRepos(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
    method: string,
    segments: string[],
    query: URLSearchParams,
    body: unknown,
  ): void {
    if (segments.length < 2) {
      sendError(res, requestId, 404, 'Not Found');
      return;
    }
    const [owner, name, ...rest] = segments;
    const repo = this.store.getRepo(owner, name);
    if (rest.length === 0) {
      if (method === 'GET') {
        if (!repo) throw new StoreError(404, 'Not Found');
        sendJson(res, requestId, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        if (!repo) throw new StoreError(404, 'Not Found');
        const input = isRecord(body) ? body : {};
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.isPrivate = input.private;
        repo.updatedAt = isoFromEpoch(this.store.nextTick());
        sendJson(res, requestId, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        if (!repo) throw new StoreError(404, 'Not Found');
        this.store.deleteRepo(owner, name);
        res.writeHead(204, { 'x-github-request-id': requestId });
        res.end();
        return;
      }
      sendError(res, requestId, 404, 'Not Found');
      return;
    }
    if (!repo) throw new StoreError(404, 'Not Found');
    const head = rest[0];
    if (head === 'branches') return this.handleBranches(req, res, requestId, method, repo, rest.slice(1));
    if (head === 'commits') return this.handleCommits(req, res, requestId, method, repo, query);
    if (head === 'git') return this.handleGitData(req, res, requestId, method, repo, rest.slice(1), body);
    if (head === 'contents') return this.handleContents(req, res, requestId, method, repo, rest.slice(1), query, body);
    if (head === 'labels') return this.handleLabels(req, res, requestId, method, repo, body);
    if (head === 'issues') return this.handleIssues(req, res, requestId, method, repo, rest.slice(1), query, body);
    if (head === 'pulls') return this.handlePulls(req, res, requestId, method, repo, rest.slice(1), query, body);
    sendError(res, requestId, 404, 'Not Found');
  }

  private handleBranches(
    _req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
    method: string,
    repo: Repo,
    rest: string[],
  ): void {
    if (method !== 'GET') {
      sendError(res, requestId, 404, 'Not Found');
      return;
    }
    if (rest.length === 0) {
      const branches = this.store.listBranches(repo).map((branch) => ({
        name: branch.name,
        commit: { sha: branch.sha },
        protected: false,
      }));
      sendJson(res, requestId, 200, branches);
      return;
    }
    const branchName = rest.join('/');
    const found = this.store.listBranches(repo).find((branch) => branch.name === branchName);
    if (!found) throw new StoreError(404, 'Branch not found');
    sendJson(res, requestId, 200, { name: found.name, commit: { sha: found.sha }, protected: false });
  }

  private handleCommits(
    _req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
    method: string,
    repo: Repo,
    query: URLSearchParams,
  ): void {
    if (method !== 'GET') {
      sendError(res, requestId, 404, 'Not Found');
      return;
    }
    const ref = query.get('sha') ?? undefined;
    const commits = this.store.listCommits(repo, ref).map((entry) => {
      const author = parseIdent(entry.commit.author);
      const committer = parseIdent(entry.commit.committer);
      const message = entry.commit.message.endsWith('\n') ? entry.commit.message.slice(0, -1) : entry.commit.message;
      return {
        sha: entry.sha,
        commit: {
          message,
          author: { name: author.name, email: author.email, date: author.date },
          committer: { name: committer.name, email: committer.email, date: committer.date },
        },
        author: { login: VIEWER.login, id: VIEWER.id },
        committer: { login: VIEWER.login, id: VIEWER.id },
        parents: entry.commit.parents.map((sha) => ({ sha })),
      };
    });
    sendJson(res, requestId, 200, commits);
  }

  private handleGitData(
    _req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
    method: string,
    repo: Repo,
    rest: string[],
    body: unknown,
  ): void {
    if (rest[0] === 'refs' && method === 'GET' && rest.length === 1) {
      const refs = this.store.sortedRefs(repo).map((ref) => ({ ref: ref.name, object: { sha: ref.oid } }));
      sendJson(res, requestId, 200, refs);
      return;
    }
    if (rest[0] === 'refs' && method === 'POST' && rest.length === 1) {
      const input = isRecord(body) ? body : {};
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      this.store.createRef(repo, ref, sha);
      const object = this.store.getObject(repo, sha);
      sendJson(res, requestId, 201, { ref, object: { sha, type: object?.type ?? 'commit' } });
      return;
    }
    if (rest[0] === 'refs' && method === 'GET' && rest.length >= 3 && (rest[1] === 'heads' || rest[1] === 'tags')) {
      const refName = `refs/${rest[1]}/${rest.slice(2).join('/')}`;
      const oid = this.store.refTarget(repo, refName);
      if (oid === undefined) throw new StoreError(404, 'Reference not found');
      const object = this.store.getObject(repo, oid);
      sendJson(res, requestId, 200, { ref: refName, object: { sha: oid, type: object?.type ?? 'commit' } });
      return;
    }
    sendError(res, requestId, 404, 'Not Found');
  }

  private handleContents(
    _req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
    method: string,
    repo: Repo,
    rest: string[],
    query: URLSearchParams,
    body: unknown,
  ): void {
    const path = rest.join('/');
    if (method === 'GET') {
      const ref = query.get('ref') ?? undefined;
      const read = this.store.readPath(repo, ref, path);
      if (!read) throw new StoreError(404, 'Not Found');
      if (read.kind === 'file') {
        sendJson(res, requestId, 200, {
          type: 'file',
          encoding: 'base64',
          name: read.name,
          path: read.path,
          sha: read.sha,
          size: read.size,
          content: read.content.toString('base64'),
        });
        return;
      }
      sendJson(res, requestId, 200, read.entries);
      return;
    }
    if (method === 'PUT') {
      const input = isRecord(body) ? body : {};
      const message = typeof input.message === 'string' ? input.message : 'Update file';
      const contentB64 = typeof input.content === 'string' ? input.content : '';
      const branch = typeof input.branch === 'string' ? input.branch : undefined;
      const sha = typeof input.sha === 'string' ? input.sha : undefined;
      const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
      const result = this.store.commitFile(repo, branch, path, content, message, sha);
      const name = path.split('/').pop() ?? path;
      sendJson(res, requestId, result.created ? 201 : 200, {
        content: { name, path, sha: result.contentSha, size: content.length, type: 'file', encoding: 'base64', content: content.toString('base64') },
        commit: { sha: result.commitSha, message },
      });
      return;
    }
    if (method === 'DELETE') {
      const input = isRecord(body) ? body : {};
      const message = typeof input.message === 'string' ? input.message : 'Delete file';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      const branch = typeof input.branch === 'string' ? input.branch : undefined;
      const commitSha = this.store.deleteFile(repo, branch, path, message, sha);
      sendJson(res, requestId, 200, { commit: { sha: commitSha, message } });
      return;
    }
    sendError(res, requestId, 404, 'Not Found');
  }

  private handleLabels(
    _req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
    method: string,
    repo: Repo,
    body: unknown,
  ): void {
    if (method === 'GET') {
      sendJson(res, requestId, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })));
      return;
    }
    if (method === 'POST') {
      const input = isRecord(body) ? body : {};
      const name = typeof input.name === 'string' ? input.name : '';
      const color = typeof input.color === 'string' ? input.color : 'ededed';
      const label = this.store.createLabel(repo, name, color);
      sendJson(res, requestId, 201, { name: label.name, color: label.color, description: '' });
      return;
    }
    sendError(res, requestId, 404, 'Not Found');
  }

  private handleIssues(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
    method: string,
    repo: Repo,
    rest: string[],
    query: URLSearchParams,
    body: unknown,
  ): void {
    if (rest.length === 0) {
      if (method === 'POST') {
        const input = isRecord(body) ? body : {};
        const title = typeof input.title === 'string' ? input.title : '';
        const issueBody = typeof input.body === 'string' ? input.body : '';
        const labels = Array.isArray(input.labels) ? input.labels.filter((entry): entry is string => typeof entry === 'string') : [];
        const issue = this.store.createIssue(repo, title, issueBody, labels);
        sendJson(res, requestId, 201, issueJson(repo, issue));
        return;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        const list = this.store.listIssues(repo, state, sort === 'created' && direction === 'asc' ? 'asc' : 'desc');
        const perPageRaw = Number(query.get('per_page') ?? '30');
        const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
        const pageRaw = Number(query.get('page') ?? '1');
        const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
        const start = (page - 1) * perPage;
        const items = list.slice(start, start + perPage).map((issue) => issueJson(repo, issue));
        sendJson(res, requestId, 200, items);
        return;
      }
      sendError(res, requestId, 404, 'Not Found');
      return;
    }
    const number = this.parseNumber(rest[0]);
    if (number === null) {
      sendError(res, requestId, 404, 'Not Found');
      return;
    }
    if (rest.length === 1) {
      if (method === 'GET') {
        const issue = this.store.getIssue(repo, number);
        if (!issue) throw new StoreError(404, 'Not Found');
        sendJson(res, requestId, 200, issueJson(repo, issue));
        return;
      }
      if (method === 'PATCH') {
        const input = isRecord(body) ? body : {};
        const patch: { state?: string; title?: string; body?: string } = {};
        if (typeof input.state === 'string') patch.state = input.state;
        if (typeof input.title === 'string') patch.title = input.title;
        if (typeof input.body === 'string') patch.body = input.body;
        const issue = this.store.patchIssue(repo, number, patch);
        sendJson(res, requestId, 200, issueJson(repo, issue));
        return;
      }
      sendError(res, requestId, 404, 'Not Found');
      return;
    }
    if (rest.length === 2 && rest[1] === 'comments') {
      if (method === 'POST') {
        const input = isRecord(body) ? body : {};
        const commentBody = typeof input.body === 'string' ? input.body : '';
        const comment = this.store.addComment(repo, number, commentBody);
        sendJson(res, requestId, 201, commentJson(repo, number, comment));
        return;
      }
      if (method === 'GET') {
        const issue = this.store.getIssue(repo, number);
        if (!issue) throw new StoreError(404, 'Not Found');
        sendJson(res, requestId, 200, issue.comments.map((comment) => commentJson(repo, number, comment)));
        return;
      }
    }
    sendError(res, requestId, 404, 'Not Found');
  }

  private handlePulls(
    _req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
    method: string,
    repo: Repo,
    rest: string[],
    query: URLSearchParams,
    body: unknown,
  ): void {
    if (rest.length === 0) {
      if (method === 'POST') {
        const input = isRecord(body) ? body : {};
        const title = typeof input.title === 'string' ? input.title : '';
        const pullBody = typeof input.body === 'string' ? input.body : '';
        const head = typeof input.head === 'string' ? input.head : '';
        const base = typeof input.base === 'string' ? input.base : '';
        const pull = this.store.createPull(repo, title, pullBody, head, base);
        sendJson(res, requestId, 201, pullJson(repo, pull, this.store));
        return;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const list = this.store.listPulls(repo, state);
        const perPageRaw = Number(query.get('per_page') ?? '30');
        const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
        const pageRaw = Number(query.get('page') ?? '1');
        const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
        const start = (page - 1) * perPage;
        const items = list.slice(start, start + perPage).map((pull) => pullJson(repo, pull, this.store));
        sendJson(res, requestId, 200, items);
        return;
      }
      sendError(res, requestId, 404, 'Not Found');
      return;
    }
    const number = this.parseNumber(rest[0]);
    if (number === null) {
      sendError(res, requestId, 404, 'Not Found');
      return;
    }
    if (rest.length === 1 && method === 'GET') {
      const pull = this.store.getPull(repo, number);
      if (!pull) throw new StoreError(404, 'Not Found');
      sendJson(res, requestId, 200, pullJson(repo, pull, this.store));
      return;
    }
    if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
      const pull = this.store.getPull(repo, number);
      if (!pull) throw new StoreError(404, 'Not Found');
      const files = this.store.pullFiles(repo, pull).map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      }));
      sendJson(res, requestId, 200, files);
      return;
    }
    if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
      const pull = this.store.getPull(repo, number);
      if (!pull) throw new StoreError(404, 'Not Found');
      const merged = this.store.mergePull(repo, pull);
      sendJson(res, requestId, 200, { sha: merged.sha, merged: true, message: merged.message });
      return;
    }
    sendError(res, requestId, 404, 'Not Found');
  }
}

// -------------------------------------------------------------------------------------------
// GraphQL + MCP
// -------------------------------------------------------------------------------------------

function handleGraphQL(store: Store, req: IncomingMessage, res: ServerResponse, requestId: string, body: Buffer): void {
  if (!authed(req)) {
    sendError(res, requestId, 401, 'Requires authentication');
    return;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonBody(body);
  } catch {
    sendError(res, requestId, 400, 'Invalid JSON in request body');
    return;
  }
  const executor = new GraphQLExecutor({ store });
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'No query provided' }] };
    }
    const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
    const result = executor.execute(entry.query, variables, operationName);
    const out: Record<string, unknown> = { data: result.data };
    if (result.errors.length > 0) out.errors = result.errors;
    return out;
  };
  if (Array.isArray(parsed)) {
    sendJson(res, requestId, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, requestId, 200, runOne(parsed));
}

function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse, requestId: string, method: string, body: Buffer): void {
  if (method !== 'POST') {
    sendError(res, requestId, 405, 'Method not allowed');
    return;
  }
  if (!authed(req)) {
    sendError(res, requestId, 401, 'Requires authentication');
    return;
  }
  const text = body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendJson(res, requestId, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    return;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    sendJson(res, requestId, 400, {
      jsonrpc: '2.0',
      id: isRecord(parsed) && 'id' in parsed ? (parsed.id as string | number | null) : null,
      error: { code: -32600, message: 'Invalid Request' },
    });
    return;
  }
  const id = 'id' in parsed ? (parsed.id as string | number | null) : null;
  const reply = (payload: unknown): void => {
    sendJson(res, requestId, 200, payload);
  };
  const result = (value: unknown): void => reply({ jsonrpc: '2.0', id, result: value });
  const rpcError = (code: number, message: string): void => reply({ jsonrpc: '2.0', id, error: { code, message } });

  if (parsed.method === 'server/discover') {
    result({
      resultType: 'server/discover',
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: {} },
      instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP tools.',
      serverInfo: { name: 'forge', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'forge', version: '1.0.0' } },
    });
    return;
  }
  if (parsed.method === 'initialize') {
    const params = isRecord(parsed.params) ? parsed.params : {};
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const protocolVersion = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(requested) ? requested : '2025-11-25';
    result({
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    });
    return;
  }
  if (typeof parsed.method === 'string' && parsed.method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': requestId });
    res.end();
    return;
  }
  if (parsed.method === 'ping') {
    result({});
    return;
  }
  if (parsed.method === 'tools/list') {
    result({ tools: MCP_TOOLS });
    return;
  }
  if (parsed.method === 'tools/call') {
    const params = isRecord(parsed.params) ? parsed.params : {};
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    try {
      const outcome = dispatchTool(store, name, args);
      result(outcome);
    } catch (err) {
      if (err instanceof McpMissingArg) {
        if (err.arg.startsWith('__unknown_tool__:')) {
          rpcError(-32602, `Unknown tool: ${err.arg.slice('__unknown_tool__:'.length)}`);
        } else {
          rpcError(-32602, err.message);
        }
        return;
      }
      rpcError(-32603, err instanceof Error ? err.message : 'Internal error');
    }
    return;
  }
  rpcError(-32601, `Method not found: ${parsed.method}`);
}

// -------------------------------------------------------------------------------------------
// the app
// -------------------------------------------------------------------------------------------

export function createApp(): Server {
  const store = new Store();
  const git = new GitHandler(store);
  const rest = new RestHandler(store);
  let requestCounter = 0;

  const server = createServer((req, res) => {
    const requestId = `req-${(requestCounter += 1)}`;
    const handle = async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const pathname = url.pathname;
        const method = (req.method ?? 'GET').toUpperCase();
        const segments = pathname.split('/').filter((segment) => segment !== '').map((segment) => {
          try {
            return decodeURIComponent(segment);
          } catch {
            return segment;
          }
        });

        if (pathname === '/healthz' && method === 'GET') {
          sendJson(res, requestId, 200, { status: 'ok' });
          return;
        }

        // git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 2 && segments[1].endsWith('.git')) {
          const owner = segments[0];
          const repoName = segments[1].slice(0, -4);
          const tail = segments.slice(2);
          if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
            const service = url.searchParams.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendError(res, requestId, 400, 'Unknown git service');
              return;
            }
            git.infoRefs(req, res, requestId, owner, repoName, service);
            return;
          }
          if (method === 'POST' && tail.length === 1 && (tail[0] === 'git-upload-pack' || tail[0] === 'git-receive-pack')) {
            const body = await readBody(req);
            if (tail[0] === 'git-upload-pack') git.uploadPack(req, res, requestId, owner, repoName, body);
            else git.receivePack(req, res, requestId, owner, repoName, body);
            return;
          }
          sendError(res, requestId, 404, 'Not Found');
          return;
        }

        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendError(res, requestId, 405, 'Method not allowed');
            return;
          }
          const body = await readBody(req);
          handleGraphQL(store, req, res, requestId, body);
          return;
        }

        if (pathname === '/mcp') {
          const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
          handleMcp(store, req, res, requestId, method, body);
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'v3') {
          const restSegments = segments.slice(2);
          let body: unknown = {};
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            try {
              body = parseJsonBody(raw);
            } catch {
              sendError(res, requestId, 400, 'Invalid JSON in request body');
              return;
            }
          }
          try {
            rest.handle(req, res, requestId, method, restSegments, url.searchParams, body);
          } catch (err) {
            if (err instanceof StoreError) sendError(res, requestId, err.status, err.message);
            else throw err;
          }
          return;
        }

        sendError(res, requestId, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) {
          sendError(res, requestId, 500, err instanceof Error ? err.message : 'Internal error');
        } else {
          res.end();
        }
      }
    };
    void handle();
  });

  return server;
}

export { hashObject };
