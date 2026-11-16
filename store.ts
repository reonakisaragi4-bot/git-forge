// The forge's store: every repository, ref, object, issue, pull request, label
// and comment lives here, in memory, in Maps. One Store per process. All ids
// and timestamps are deterministic functions of the request order (counters
// and a fixed timestamp), never the wall clock or randomness, so a live pass
// and its replay build byte-identical state.

import {
  buildCommit,
  buildTree,
  collectReachable,
  diffTrees,
  flattenTree,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  type FileChange,
  type GitObject,
  type ObjType,
} from './gitcore.ts';
import { COMMIT_EPOCH_SEC, FIXED_TIMESTAMP, VIEWER_EMAIL, VIEWER_LOGIN } from './scenario.ts';

export interface CommentRecord {
  id: number;
  body: string;
  user: string;
}

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  comments: CommentRecord[];
  seq: number;
}

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  user: string;
  seq: number;
}

export interface LabelRecord {
  name: string;
  color: string;
  description: string;
}

export interface RepoRecord {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, LabelRecord>;
  issues: Map<number, IssueRecord>;
  pulls: Map<number, PullRecord>;
  nextNumber: number;
  commitClock: number;
  seq: number;
}

/** The identity string of a commit's author line, at a deterministic second. */
function identityAt(epochSec: number): string {
  return `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${epochSec} +0000`;
}

export class Store {
  readonly repos = new Map<string, RepoRecord>();
  readonly repoOrder: RepoRecord[] = [];
  private nextRepoId = 10000;
  private nextIssueId = 20000;
  private nextCommentId = 30000;
  private nextSeq = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRecord | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** Find a repository by its numeric id, or null. */
  repoById(id: number): RepoRecord | null {
    for (const repo of this.repoOrder) {
      if (repo.id === id) return repo;
    }
    return null;
  }

  /** The repository that owns a pull request record, or null. */
  repoOfPull(pull: PullRecord): RepoRecord | null {
    for (const repo of this.repoOrder) {
      if (repo.pulls.get(pull.number) === pull) return repo;
    }
    return null;
  }

  createRepo(name: string, isPrivate: boolean, description: string): { repo: RepoRecord } | { error: string } {
    if (this.repos.has(this.key(VIEWER_LOGIN, name))) return { error: 'Repository already exists' };
    const repo: RepoRecord = {
      id: this.nextRepoId,
      name,
      owner: VIEWER_LOGIN,
      description,
      isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      commitClock: 0,
      seq: this.nextSeq,
    };
    this.nextRepoId += 1;
    this.nextSeq += 1;
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    this.repoOrder.push(repo);
    return { repo };
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(this.key(owner, name));
    if (repo === undefined) return false;
    this.repos.delete(this.key(owner, name));
    const index = this.repoOrder.indexOf(repo);
    if (index >= 0) this.repoOrder.splice(index, 1);
    return true;
  }

  /** An object lookup bound to one repository. */
  lookup(repo: RepoRecord): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** Store an object, returning its id. */
  putObject(repo: RepoRecord, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** The tip of a ref, or null when the ref does not exist. */
  refTip(repo: RepoRecord, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /** The commit a branch name (or ref, or oid) resolves to, or null. */
  resolveBranch(repo: RepoRecord, branch: string): string | null {
    if (branch.startsWith('refs/heads/')) return repo.refs.get(branch) ?? null;
    const direct = repo.refs.get(`refs/heads/${branch}`);
    if (direct !== undefined) return direct;
    if (repo.objects.has(branch)) return branch;
    return null;
  }

  /** The next commit timestamp for this repository (deterministic, monotonic). */
  nextCommitEpoch(repo: RepoRecord): number {
    const epoch = COMMIT_EPOCH_SEC + repo.commitClock;
    repo.commitClock += 1;
    return epoch;
  }

  /** Build a commit object on `parents` with `tree`, store it, return its id. */
  makeCommit(repo: RepoRecord, tree: string, parents: readonly string[], message: string): string {
    const epoch = this.nextCommitEpoch(repo);
    const identity = identityAt(epoch);
    const data = buildCommit({ tree, parents, author: identity, committer: identity, message: message.endsWith('\n') ? message : `${message}\n` });
    return this.putObject(repo, 'commit', data);
  }

  /**
   * Set or remove one path in a tree, rebuilding the trees along the path.
   * Returns the new root tree id and every tree object it created.
   */
  setPathInTree(
    repo: RepoRecord,
    rootTree: string | null,
    path: string,
    blobOid: string | null,
  ): { treeOid: string; created: GitObject[] } {
    const created: GitObject[] = [];
    const segments = path.split('/').filter((segment) => segment !== '');
    const build = (treeOid: string | null, depth: number): string | null => {
      const entries = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
      const segment = segments[depth] as string;
      const isLeaf = depth === segments.length - 1;
      const next = new Map<string, { mode: string; oid: string }>();
      for (const entry of entries) next.set(entry.name, { mode: entry.mode, oid: entry.oid });
      if (isLeaf) {
        if (blobOid === null) next.delete(segment);
        else next.set(segment, { mode: '100644', oid: blobOid });
      } else {
        const child = entries.find((entry) => entry.name === segment);
        const childTree = build(child !== undefined && child.mode === '40000' ? child.oid : null, depth + 1);
        if (childTree === null) next.delete(segment);
        else next.set(segment, { mode: '40000', oid: childTree });
      }
      if (next.size === 0) return null;
      const treeEntries = [...next.entries()].map(([name, entry]) => ({ mode: entry.mode, name, oid: entry.oid }));
      const data = buildTree(treeEntries);
      const oid = hashObject('tree', data);
      if (!repo.objects.has(oid)) {
        repo.objects.set(oid, { type: 'tree', data });
        created.push({ type: 'tree', data });
      }
      return oid;
    };
    const root = build(rootTree, 0);
    // An empty repository tree is the empty tree object.
    if (root === null) {
      const data = buildTree([]);
      const oid = hashObject('tree', data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
      return { treeOid: oid, created };
    }
    return { treeOid: root, created };
  }

  /**
   * Commit one file change on a branch (the contents API's write). When the
   * branch does not exist it is created from the default branch's tip (or as
   * a root commit when the repository is unborn). Returns the commit and blob
   * ids, or an error string.
   */
  commitFile(
    repo: RepoRecord,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitOid: string; blobOid: string | null } | { error: string } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    let baseTree: string | null = null;
    const parents: string[] = [];
    if (tip !== null) {
      const commitObject = repo.objects.get(tip);
      if (commitObject === undefined || commitObject.type !== 'commit') return { error: 'branch tip is not a commit' };
      baseTree = parseCommit(commitObject.data).tree;
      parents.push(tip);
    }
    let blobOid: string | null = null;
    if (content !== null) blobOid = this.putObject(repo, 'blob', content);
    const { treeOid } = this.setPathInTree(repo, baseTree, path, blobOid);
    const commitOid = this.makeCommit(repo, treeOid, parents, message);
    repo.refs.set(ref, commitOid);
    return { commitOid, blobOid };
  }

  /** The flat file map of a branch tip (empty when the branch is unborn). */
  branchFiles(repo: RepoRecord, branch: string): Map<string, { oid: string; mode: string }> {
    const tip = this.resolveBranch(repo, branch);
    if (tip === null) return new Map();
    const commitObject = repo.objects.get(tip);
    if (commitObject === undefined || commitObject.type !== 'commit') return new Map();
    return flattenTree(parseCommit(commitObject.data).tree, this.lookup(repo));
  }

  /** Read one file's bytes from a branch tip, or null when absent. */
  readBranchFile(repo: RepoRecord, branch: string, path: string): Buffer | null {
    const files = this.branchFiles(repo, branch);
    const entry = files.get(path);
    if (entry === undefined) return null;
    const object = repo.objects.get(entry.oid);
    if (object === undefined || object.type !== 'blob') return null;
    return object.data;
  }

  /** The tree id of a branch tip, or null when the branch is unborn. */
  branchTree(repo: RepoRecord, branch: string): string | null {
    const tip = this.resolveBranch(repo, branch);
    if (tip === null) return null;
    const commitObject = repo.objects.get(tip);
    if (commitObject === undefined || commitObject.type !== 'commit') return null;
    return parseCommit(commitObject.data).tree;
  }

  /** All branch names, sorted. */
  branchNames(repo: RepoRecord): string[] {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  /** All refs (branches and tags), sorted by name. */
  allRefs(repo: RepoRecord): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()]
      .map(([name, oid]) => ({ name, oid }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The commit history of a ref, newest first. */
  commitHistory(repo: RepoRecord, ref: string): string[] {
    const tip = this.resolveBranch(repo, ref) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    if (tip === null) return [];
    const order: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      order.push(oid);
      const view = parseCommit(object.data);
      for (let i = view.parents.length - 1; i >= 0; i -= 1) stack.push(view.parents[i] as string);
    }
    return order;
  }

  // -------------------------------------------------------------------------------------------
  // labels, issues, comments
  // -------------------------------------------------------------------------------------------

  createLabel(repo: RepoRecord, name: string, color: string, description: string): { label: LabelRecord } | { error: string } {
    if (repo.labels.has(name)) return { error: 'Label already exists' };
    const label: LabelRecord = { name, color, description };
    repo.labels.set(name, label);
    return { label };
  }

  createIssue(repo: RepoRecord, title: string, body: string, labels: readonly string[]): { issue: IssueRecord } | { error: string } {
    for (const name of labels) {
      if (!repo.labels.has(name)) return { error: `Label does not exist: ${name}` };
    }
    const issue: IssueRecord = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      user: VIEWER_LOGIN,
      comments: [],
      seq: this.nextSeq,
    };
    this.nextIssueId += 1;
    this.nextSeq += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return { issue };
  }

  createComment(repo: RepoRecord, issueNumber: number, body: string): { comment: CommentRecord } | { error: string } {
    const issue = repo.issues.get(issueNumber);
    if (issue === undefined) return { error: 'Issue not found' };
    const comment: CommentRecord = { id: this.nextCommentId, body, user: VIEWER_LOGIN };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return { comment };
  }

  /** Issues in creation order (seq ascending). */
  issuesInOrder(repo: RepoRecord): IssueRecord[] {
    return [...repo.issues.values()].sort((a, b) => a.seq - b.seq);
  }

  // -------------------------------------------------------------------------------------------
  // pull requests and merging
  // -------------------------------------------------------------------------------------------

  createPull(
    repo: RepoRecord,
    title: string,
    body: string,
    head: string,
    base: string,
  ): { pull: PullRecord } | { error: string } {
    const headTip = this.resolveBranch(repo, head);
    if (headTip === null) return { error: `Head branch not found: ${head}` };
    const baseTip = this.resolveBranch(repo, base);
    if (baseTip === null) return { error: `Base branch not found: ${base}` };
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
        return { error: 'A pull request is already open for this head and base' };
      }
    }
    const pull: PullRecord = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      user: VIEWER_LOGIN,
      seq: this.nextSeq,
    };
    this.nextIssueId += 1;
    this.nextSeq += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return { pull };
  }

  /** Pull requests in creation order (seq ascending). */
  pullsInOrder(repo: RepoRecord): PullRecord[] {
    return [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
  }

  /** The file changes of a pull request: base tip tree vs head tip tree. */
  pullFiles(repo: RepoRecord, pull: PullRecord): FileChange[] {
    const baseTree = this.branchTree(repo, pull.baseRef);
    const headTree = this.branchTree(repo, pull.headRef);
    if (baseTree === null || headTree === null) return [];
    return diffTrees(baseTree, headTree, this.lookup(repo));
  }

  /** Whether a pull request would merge cleanly, from a three-way check. */
  pullMergeable(repo: RepoRecord, pull: PullRecord): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const headTip = this.resolveBranch(repo, pull.headRef);
    const baseTip = this.resolveBranch(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return 'UNKNOWN';
    const base = mergeBase(headTip, baseTip, this.lookup(repo));
    if (base === null) return 'CONFLICTING';
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(headTip);
    const tipCommit = repo.objects.get(baseTip);
    if (baseCommit === undefined || headCommit === undefined || tipCommit === undefined) return 'UNKNOWN';
    const baseTree = parseCommit(baseCommit.data).tree;
    const headTree = parseCommit(headCommit.data).tree;
    const tipTree = parseCommit(tipCommit.data).tree;
    const headChanges = diffTrees(baseTree, headTree, this.lookup(repo));
    const tipFiles = flattenTree(tipTree, this.lookup(repo));
    const baseFiles = flattenTree(baseTree, this.lookup(repo));
    for (const change of headChanges) {
      const tipEntry = tipFiles.get(change.path);
      const baseEntry = baseFiles.get(change.path);
      const tipOid = tipEntry?.oid ?? null;
      const baseOid = baseEntry?.oid ?? null;
      if (tipOid !== baseOid && tipOid !== change.newOid) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /**
   * Squash-merge an open pull request onto its base branch: one commit whose
   * tree is the base tree with the head's changes applied. Returns the merge
   * commit id, or an error string ('conflict' for a three-way conflict).
   */
  mergePull(repo: RepoRecord, pull: PullRecord): { commitOid: string } | { error: string } {
    if (pull.state !== 'open') return { error: 'Pull request is not open' };
    if (this.pullMergeable(repo, pull) === 'CONFLICTING') return { error: 'conflict' };
    const headTip = this.resolveBranch(repo, pull.headRef);
    const baseTip = this.resolveBranch(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return { error: 'Branch not found' };
    const base = mergeBase(headTip, baseTip, this.lookup(repo));
    const headCommit = repo.objects.get(headTip);
    const tipCommit = repo.objects.get(baseTip);
    if (headCommit === undefined || tipCommit === undefined) return { error: 'Commit not found' };
    const headTree = parseCommit(headCommit.data).tree;
    const tipTree = parseCommit(tipCommit.data).tree;
    const baseTree = base === null ? tipTree : parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
    const changes = diffTrees(baseTree, headTree, this.lookup(repo));
    let treeOid = tipTree;
    for (const change of changes) {
      const result = this.setPathInTree(repo, treeOid, change.path, change.newOid);
      treeOid = result.treeOid;
    }
    const message = `Merge pull request #${pull.number} from ${VIEWER_LOGIN}/${pull.headRef}\n\n${pull.title}`;
    const commitOid = this.makeCommit(repo, treeOid, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_TIMESTAMP;
    pull.mergeCommitSha = commitOid;
    return { commitOid };
  }

  // -------------------------------------------------------------------------------------------
  // global (Relay) ids
  // -------------------------------------------------------------------------------------------

  repoGlobalId(repo: RepoRecord): string {
    return Buffer.from(`R:${repo.owner}/${repo.name}`, 'utf8').toString('base64');
  }

  issueGlobalId(repo: RepoRecord, issue: IssueRecord): string {
    return Buffer.from(`I:${repo.owner}/${repo.name}#${issue.number}`, 'utf8').toString('base64');
  }

  pullGlobalId(repo: RepoRecord, pull: PullRecord): string {
    return Buffer.from(`P:${repo.owner}/${repo.name}#${pull.number}`, 'utf8').toString('base64');
  }

  commentGlobalId(repo: RepoRecord, issueNumber: number, comment: CommentRecord): string {
    return Buffer.from(`C:${repo.owner}/${repo.name}#${issueNumber}:${comment.id}`, 'utf8').toString('base64');
  }

  /** Decode a global id into its kind and coordinates, or null when it is not one. */
  parseGlobalId(id: string): { kind: string; owner: string; repo: string; number: number; commentId: number } | null {
    let text: string;
    try {
      text = Buffer.from(id, 'base64').toString('utf8');
    } catch {
      return null;
    }
    const match = /^([RIPC]):([^/]+)\/([^#]+)(?:#(\d+)(?::(\d+))?)?$/.exec(text);
    if (match === null) return null;
    return {
      kind: match[1] as string,
      owner: match[2] as string,
      repo: match[3] as string,
      number: match[4] === undefined ? 0 : Number(match[4]),
      commentId: match[5] === undefined ? 0 : Number(match[5]),
    };
  }
}

/** A fresh, empty store. */
export function createStore(): Store {
  return new Store();
}

