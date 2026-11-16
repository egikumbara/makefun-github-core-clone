// store.ts — the forge's in-memory state: repositories, git objects, refs, issues,
// pull requests, labels and comments. Everything is deterministic: timestamps come
// from a fixed-epoch counter that advances only on mutation, never from the clock.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  commitAncestors,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type ObjectLookup,
  type TreeEntry,
} from './git.ts';

// The token owner's identity, fixed by the contest's seeded scenario.
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const FORGE_IDENTITY = 'ada iversen <adaiversen@example.invalid>';
const TICK_EPOCH = 1700000000;

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TREE_BYTES = 16 * 1024 * 1024;

/** Format unix seconds as an ISO-8601 UTC string without touching the clock. */
export function isoFromEpoch(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const secs = seconds - days * 86400;
  const hh = Math.floor(secs / 3600);
  const mm = Math.floor((secs - hh * 3600) / 60);
  const ss = secs - hh * 3600 - mm * 60;
  // civil-from-days (Howard Hinnant's algorithm)
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;
  const pad = (n: number, w: number): string => String(n).padStart(w, '0');
  return `${pad(year, 4)}-${pad(m, 2)}-${pad(d, 2)}T${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}Z`;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Issue {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  readonly createdAt: string;
  updatedAt: string;
}

export interface Pull {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly head: string;
  readonly base: string;
  readonly headSha: string;
  readonly baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface StoredObject extends GitObject {
  readonly seq: number;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  readonly createdAt: string;
  updatedAt: string;
  readonly objects: Map<string, StoredObject>;
  readonly refs: Map<string, string>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  readonly labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  objSeq: number;
}

export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export class StoreError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function globalId(kind: 'R' | 'I' | 'P' | 'C', repoId: number, num: number): string {
  return b64url(`${kind}:${repoId}:${num}`);
}

export function decodeGlobalId(id: string): { kind: string; repoId: number; num: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length !== 3) return null;
    const repoId = Number(parts[1]);
    const num = Number(parts[2]);
    if (!Number.isInteger(repoId) || !Number.isInteger(num)) return null;
    return { kind: parts[0], repoId, num };
  } catch {
    return null;
  }
}

export class Store {
  private readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private repoSeq = 0;
  private tick = TICK_EPOCH;

  /** The next deterministic timestamp (seconds), advancing the counter. */
  nextTick(): number {
    const value = this.tick;
    this.tick += 1;
    return value;
  }

  nextIso(): string {
    return isoFromEpoch(this.nextTick());
  }

  // -----------------------------------------------------------------------------------------
  // repositories
  // -----------------------------------------------------------------------------------------

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
      throw new StoreError(422, `Invalid repository name: ${name}`);
    }
    const key = `${VIEWER.login}/${name}`;
    if (this.repos.has(key)) throw new StoreError(422, 'Repository already exists');
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: VIEWER.login,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: this.repoSeq++,
      createdAt: isoFromEpoch(this.tick),
      updatedAt: isoFromEpoch(this.tick),
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      objSeq: 0,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  getRepoById(id: number): Repo | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  // -----------------------------------------------------------------------------------------
  // git objects
  // -----------------------------------------------------------------------------------------

  lookup(repo: Repo): ObjectLookup {
    return (oid) => repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data, seq: repo.objSeq++ });
    }
    return oid;
  }

  getObject(repo: Repo, oid: string): StoredObject | undefined {
    return repo.objects.get(oid);
  }

  refTarget(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  /** Resolve a branch name, ref name or oid to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string | undefined): string | null {
    if (ref === undefined) ref = repo.defaultBranch;
    if (isObjectId(ref)) {
      const object = repo.objects.get(ref);
      if (!object) return null;
      if (object.type === 'commit') return ref;
      if (object.type === 'tag') return parseTag(object.data).object;
      return null;
    }
    const direct = repo.refs.get(ref);
    if (direct !== undefined) return direct;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) {
      const object = repo.objects.get(tag);
      if (object && object.type === 'tag') return parseTag(object.data).object;
      return tag;
    }
    return null;
  }

  defaultBranchTip(repo: Repo): string | null {
    return this.resolveRef(repo, repo.defaultBranch);
  }

  /** All refs, HEAD first, then sorted by name. */
  sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
    const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
    refs.sort((a, b) => {
      const rank = (name: string): number => (name.startsWith('refs/heads/') ? 0 : name.startsWith('refs/tags/') ? 1 : 2);
      const ra = rank(a.name);
      const rb = rank(b.name);
      if (ra !== rb) return ra - rb;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return refs;
  }

  // -----------------------------------------------------------------------------------------
  // trees
  // -----------------------------------------------------------------------------------------

  /** Flatten a tree to path -> {oid, mode}, recursively. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /**
   * Build a new tree from a base tree plus path changes (Buffer = new blob content,
   * null = delete). Creates every blob and tree object it needs.
   */
  buildTreeFromChanges(repo: Repo, baseTreeOid: string | null, changes: Map<string, Buffer | null>): string {
    const flat = baseTreeOid === null ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(repo, baseTreeOid);
    for (const [path, content] of changes) {
      if (content === null) flat.delete(path);
      else flat.set(path, { oid: this.putObject(repo, 'blob', content), mode: '100644' });
    }
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const makeNode = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = makeNode();
    for (const [path, entry] of [...flat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i];
        if (!node.dirs.has(segment)) node.dirs.set(segment, makeNode());
        node = node.dirs.get(segment)!;
      }
      node.files.set(segments[segments.length - 1], entry.oid);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit object on top of `parents` with `treeOid`. */
  makeCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
    const timestamp = this.nextTick();
    const data = buildCommit({
      tree: treeOid,
      parents,
      message,
      author: FORGE_IDENTITY,
      committer: FORGE_IDENTITY,
      timestamp,
    });
    return this.putObject(repo, 'commit', data);
  }

  // -----------------------------------------------------------------------------------------
  // contents API
  // -----------------------------------------------------------------------------------------

  commitFile(
    repo: Repo,
    branch: string | undefined,
    path: string,
    content: Buffer,
    message: string,
    expectedSha: string | undefined,
  ): { commitSha: string; contentSha: string; created: boolean } {
    if (content.length > MAX_FILE_BYTES) throw new StoreError(422, 'File is too large');
    const refName = `refs/heads/${branch ?? repo.defaultBranch}`;
    const currentTip = repo.refs.get(refName);
    let baseTree: string | null = null;
    let existingSha: string | null = null;
    if (currentTip !== undefined) {
      const commit = repo.objects.get(currentTip);
      if (!commit || commit.type !== 'commit') throw new StoreError(409, 'Branch tip is not a commit');
      baseTree = parseCommit(commit.data).tree;
      const flat = this.flattenTree(repo, baseTree);
      const entry = flat.get(path);
      existingSha = entry ? entry.oid : null;
    }
    if (existingSha !== null) {
      if (expectedSha === undefined || expectedSha.toLowerCase() !== existingSha.toLowerCase()) {
        throw new StoreError(409, 'sha does not match the current file');
      }
    } else if (expectedSha !== undefined) {
      throw new StoreError(422, 'sha was supplied but the file does not exist');
    }
    const contentSha = hashObject('blob', content);
    const changes = new Map<string, Buffer | null>([[path, content]]);
    const treeOid = this.buildTreeFromChanges(repo, baseTree, changes);
    const parents = currentTip === undefined ? [] : [currentTip];
    const commitSha = this.makeCommit(repo, treeOid, parents, message);
    repo.refs.set(refName, commitSha);
    repo.updatedAt = isoFromEpoch(this.tick);
    return { commitSha, contentSha, created: existingSha === null };
  }

  deleteFile(repo: Repo, branch: string | undefined, path: string, message: string, sha: string): string {
    const refName = `refs/heads/${branch ?? repo.defaultBranch}`;
    const currentTip = repo.refs.get(refName);
    if (currentTip === undefined) throw new StoreError(404, 'Branch not found');
    const commit = repo.objects.get(currentTip);
    if (!commit || commit.type !== 'commit') throw new StoreError(409, 'Branch tip is not a commit');
    const baseTree = parseCommit(commit.data).tree;
    const flat = this.flattenTree(repo, baseTree);
    const entry = flat.get(path);
    if (!entry) throw new StoreError(404, 'File not found');
    if (sha.toLowerCase() !== entry.oid.toLowerCase()) throw new StoreError(409, 'sha does not match the current file');
    const changes = new Map<string, Buffer | null>([[path, null]]);
    const treeOid = this.buildTreeFromChanges(repo, baseTree, changes);
    const commitSha = this.makeCommit(repo, treeOid, [currentTip], message);
    repo.refs.set(refName, commitSha);
    repo.updatedAt = isoFromEpoch(this.tick);
    return commitSha;
  }

  /** Read a path at a ref: a file ({kind:'file'}) or a directory listing ({kind:'dir'}). */
  readPath(
    repo: Repo,
    ref: string | undefined,
    path: string,
  ):
    | { kind: 'file'; name: string; path: string; sha: string; size: number; content: Buffer }
    | { kind: 'dir'; entries: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }> }
    | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return null;
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return null;
    const treeOid = parseCommit(commit.data).tree;
    if (path === '' || path === '/') {
      const object = repo.objects.get(treeOid);
      if (!object) return null;
      const entries = parseTree(object.data).map((entry) => ({
        type: (entry.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
        name: entry.name,
        path: entry.name,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      }));
      return { kind: 'dir', entries };
    }
    const flat = this.flattenTree(repo, treeOid);
    const file = flat.get(path);
    if (file) {
      const blob = repo.objects.get(file.oid);
      if (!blob) return null;
      const name = path.split('/').pop() ?? path;
      return { kind: 'file', name, path, sha: file.oid, size: blob.data.length, content: blob.data };
    }
    // A directory: walk the tree to the directory's tree object.
    const segments = path.split('/');
    let oid = treeOid;
    for (const segment of segments) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
      if (!entry || entry.mode !== '40000') return null;
      oid = entry.oid;
    }
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return null;
    const entries = parseTree(object.data).map((entry) => ({
      type: (entry.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
      name: entry.name,
      path: `${path}/${entry.name}`,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    }));
    return { kind: 'dir', entries };
  }

  /** Commits reachable from `ref`, newest first (by insertion order). */
  listCommits(repo: Repo, ref: string | undefined): Array<{ sha: string; commit: CommitView; seq: number }> {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return [];
    const ancestors = commitAncestors(tip, this.lookup(repo));
    const out: Array<{ sha: string; commit: CommitView; seq: number }> = [];
    for (const sha of ancestors) {
      const object = repo.objects.get(sha);
      if (!object || object.type !== 'commit') continue;
      out.push({ sha, commit: parseCommit(object.data), seq: object.seq });
    }
    out.sort((a, b) => b.seq - a.seq);
    return out;
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [name, oid] of repo.refs) {
      if (name.startsWith('refs/heads/')) out.push({ name: name.slice('refs/heads/'.length), sha: oid });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  createRef(repo: Repo, ref: string, sha: string): void {
    if (!ref.startsWith('refs/') || ref.includes('..') || /[\s~^:?*[\\]/.test(ref)) {
      throw new StoreError(422, `Invalid ref: ${ref}`);
    }
    if (repo.refs.has(ref)) throw new StoreError(422, 'Reference already exists');
    if (!repo.objects.has(sha)) throw new StoreError(422, 'Object does not exist');
    repo.refs.set(ref, sha);
  }

  // -----------------------------------------------------------------------------------------
  // labels
  // -----------------------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    if (name === '') throw new StoreError(422, 'Label name is required');
    if (repo.labels.has(name)) throw new StoreError(422, 'Label already exists');
    const label: Label = { name, color: color || 'ededed' };
    repo.labels.set(name, label);
    return label;
  }

  // -----------------------------------------------------------------------------------------
  // issues
  // -----------------------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): Issue {
    if (title === '') throw new StoreError(422, 'Title is required');
    for (const label of labels) {
      if (!repo.labels.has(label)) throw new StoreError(422, `Label '${label}' does not exist`);
    }
    const now = this.nextIso();
    const issue: Issue = {
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  listIssues(repo: Repo, state: string, sortDirection: 'asc' | 'desc'): Issue[] {
    let list = [...repo.issues.values()];
    if (state === 'open') list = list.filter((issue) => issue.state === 'open');
    else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
    list.sort((a, b) => (sortDirection === 'asc' ? a.number - b.number : b.number - a.number));
    return list;
  }

  patchIssue(repo: Repo, number: number, patch: { state?: string; title?: string; body?: string }): Issue {
    const issue = repo.issues.get(number);
    if (!issue) throw new StoreError(404, 'Issue not found');
    if (patch.state !== undefined) {
      if (patch.state !== 'open' && patch.state !== 'closed') throw new StoreError(422, 'Invalid state');
      issue.state = patch.state;
    }
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    issue.updatedAt = this.nextIso();
    return issue;
  }

  addComment(repo: Repo, number: number, body: string): IssueComment {
    const issue = repo.issues.get(number);
    if (!issue) throw new StoreError(404, 'Issue not found');
    if (body === '') throw new StoreError(422, 'Comment body is required');
    const now = this.nextIso();
    const comment: IssueComment = { id: repo.nextCommentId++, body, createdAt: now, updatedAt: now };
    issue.comments.push(comment);
    return comment;
  }

  // -----------------------------------------------------------------------------------------
  // pull requests
  // -----------------------------------------------------------------------------------------

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull {
    if (title === '') throw new StoreError(422, 'Title is required');
    const headTip = repo.refs.get(`refs/heads/${head}`);
    if (headTip === undefined) throw new StoreError(422, `Head branch '${head}' does not exist`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (baseTip === undefined) throw new StoreError(422, `Base branch '${base}' does not exist`);
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.head === head && pull.base === base) {
        throw new StoreError(422, 'A pull request already exists for this head and base');
      }
    }
    const now = this.nextIso();
    const pull: Pull = {
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      head,
      base,
      headSha: headTip,
      baseSha: baseTip,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.get(number);
  }

  listPulls(repo: Repo, state: string): Pull[] {
    let list = [...repo.pulls.values()];
    if (state === 'open') list = list.filter((pull) => pull.state === 'open');
    else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
    list.sort((a, b) => b.number - a.number);
    return list;
  }

  /** The diff between the base tip tree and the head tip tree of a pull request. */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (headTip === undefined || baseTip === undefined) return [];
    const headCommit = repo.objects.get(headTip);
    const baseCommit = repo.objects.get(baseTip);
    if (!headCommit || !baseCommit || headCommit.type !== 'commit' || baseCommit.type !== 'commit') return [];
    return this.diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
  }

  diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): FileChange[] {
    const base = this.flattenTree(repo, baseTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: FileChange[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const content = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
        const lines = countLines(content);
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (!b && h) {
        const content = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
        const lines = countLines(content);
        out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (b && h && b.oid !== h.oid) {
        const oldContent = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
        const newContent = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
        const { additions, deletions } = lineDiff(oldContent, newContent);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' for a pull request. */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const conflict = this.mergeConflict(repo, pull);
    if (conflict === null) return 'UNKNOWN';
    return conflict ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** null when the merge cannot be computed; otherwise whether it conflicts. */
  mergeConflict(repo: Repo, pull: Pull): boolean | null {
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (headTip === undefined || baseTip === undefined) return null;
    if (headTip === baseTip) return false;
    const base = mergeBase(headTip, baseTip, this.lookup(repo));
    if (base === null) return true;
    if (isAncestor(headTip, baseTip, this.lookup(repo))) return false; // already merged
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(headTip);
    const currentCommit = repo.objects.get(baseTip);
    if (!baseCommit || !headCommit || !currentCommit) return null;
    if (baseCommit.type !== 'commit' || headCommit.type !== 'commit' || currentCommit.type !== 'commit') return null;
    const baseTree = this.flattenTree(repo, parseCommit(baseCommit.data).tree);
    const headTree = this.flattenTree(repo, parseCommit(headCommit.data).tree);
    const currentTree = this.flattenTree(repo, parseCommit(currentCommit.data).tree);
    const paths = new Set([...baseTree.keys(), ...headTree.keys(), ...currentTree.keys()]);
    for (const path of paths) {
      const b = baseTree.get(path)?.oid ?? null;
      const h = headTree.get(path)?.oid ?? null;
      const c = currentTree.get(path)?.oid ?? null;
      const headChanged = h !== b;
      const currentChanged = c !== b;
      if (headChanged && currentChanged && h !== c) return true;
    }
    return false;
  }

  /** Squash-merge an open pull request. Throws StoreError(404/405) on failure. */
  mergePull(repo: Repo, pull: Pull): { sha: string; message: string } {
    if (pull.state !== 'open') throw new StoreError(405, 'Pull request is not open');
    const conflict = this.mergeConflict(repo, pull);
    if (conflict === null) throw new StoreError(405, 'Pull request cannot be merged');
    if (conflict) throw new StoreError(405, 'Merge conflict');
    const headTip = repo.refs.get(`refs/heads/${pull.head}`)!;
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`)!;
    const base = mergeBase(headTip, baseTip, this.lookup(repo));
    const baseCommit = base === null ? null : repo.objects.get(base);
    const headCommit = repo.objects.get(headTip)!;
    const currentCommit = repo.objects.get(baseTip)!;
    const baseTree = baseCommit && baseCommit.type === 'commit' ? this.flattenTree(repo, parseCommit(baseCommit.data).tree) : new Map();
    const headTree = this.flattenTree(repo, parseCommit(headCommit.data).tree);
    const currentTree = this.flattenTree(repo, parseCommit(currentCommit.data).tree);
    // Apply the head's changes onto the current tree.
    const changes = new Map<string, Buffer | null>();
    const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
    for (const path of paths) {
      const b = baseTree.get(path)?.oid ?? null;
      const h = headTree.get(path)?.oid ?? null;
      if (h === b) continue;
      if (h === null) changes.set(path, null);
      else {
        const blob = repo.objects.get(h);
        if (blob) changes.set(path, blob.data);
      }
    }
    void currentTree;
    const currentTreeOid = parseCommit(currentCommit.data).tree;
    const resultTree = this.buildTreeFromChanges(repo, currentTreeOid, changes);
    const message = pull.title;
    const sha = this.makeCommit(repo, resultTree, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nextIso();
    pull.mergeCommitSha = sha;
    pull.updatedAt = isoFromEpoch(this.tick);
    repo.updatedAt = isoFromEpoch(this.tick);
    return { sha, message: `Merge pull request #${pull.number} from ${VIEWER.login}/${pull.head}` };
  }

  // -----------------------------------------------------------------------------------------
  // reachability helpers for the git layer
  // -----------------------------------------------------------------------------------------

  /** Objects reachable from the repo's ref tips (used by pushRefs-style accounting). */
  reachableFromRefs(repo: Repo): Set<string> {
    const tips = [...repo.refs.values()];
    return collectReachable(tips, this.lookup(repo));
  }
}

// -------------------------------------------------------------------------------------------
// line diffs
// -------------------------------------------------------------------------------------------

function splitLines(content: Buffer): string[] {
  const text = content.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function countLines(content: Buffer): number {
  return splitLines(content).length;
}

/** LCS-based line diff; falls back to a count-based estimate for large files. */
export function lineDiff(oldContent: Buffer, newContent: Buffer): { additions: number; deletions: number } {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const MAX = 400;
  if (oldLines.length > MAX || newLines.length > MAX) {
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    let additions = 0;
    for (const line of newLines) if (!oldSet.has(line)) additions += 1;
    let deletions = 0;
    for (const line of oldLines) if (!newSet.has(line)) deletions += 1;
    return { additions, deletions };
  }
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      deletions += 1;
      i += 1;
    } else {
      additions += 1;
      j += 1;
    }
  }
  deletions += n - i;
  additions += m - j;
  return { additions, deletions };
}

// -------------------------------------------------------------------------------------------
// REST view builders
// -------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('R', repo.id, 0),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: globalId('I', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

export function commentJson(repo: Repo, issueNumber: number, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('C', repo.id, comment.id),
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    issue_number: issueNumber,
  };
}

export function pullJson(repo: Repo, pull: Pull, store: Store): Record<string, unknown> {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  return {
    id: repo.id * 100000 + pull.number,
    node_id: globalId('P', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    head: { ref: pull.head, sha: headTip, label: `${VIEWER.login}:${pull.head}`, user: { login: VIEWER.login, id: VIEWER.id } },
    base: { ref: pull.base, sha: baseTip, label: `${VIEWER.login}:${pull.base}`, user: { login: VIEWER.login, id: VIEWER.id } },
    merged: pull.merged,
    mergeable: pull.state === 'open' ? store.pullMergeable(repo, pull) === 'MERGEABLE' : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}
