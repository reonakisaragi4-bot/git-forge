// The REST v3 surface: repositories, branches, commits, git refs, contents,
// labels, issues, comments and pull requests, under /api/v3. Every reply is
// JSON with a string `message` on errors; unknown routes are 404 JSON;
// malformed JSON bodies are 400. A repository belongs to the token owner's
// login, so the same name under another owner is a 404, never a 403.

import { FIXED_TIMESTAMP, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN } from './scenario.ts';
import { countLineChanges, flattenTree, parseCommit, parseTree } from './gitcore.ts';
import { errorReply, isAuthorized, jsonReply, emptyReply, type Reply } from './reply.ts';
import type { IssueRecord, LabelRecord, PullRecord, RepoRecord, Store } from './store.ts';

export interface RestContext {
  store: Store;
  expectedToken: string;
  host: string;
}

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  malformedBody: boolean;
  headers: Record<string, string | string[] | undefined>;
}

/** Split a path into its decoded segments, dropping empty ones. */
export function splitPath(path: string): string[] {
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bodyString(body: unknown, field: string): string {
  if (!isRecord(body)) return '';
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

function bodyBoolean(body: unknown, field: string, fallback: boolean): boolean {
  if (!isRecord(body)) return fallback;
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

/** The public repository object. */
export function repoJson(repo: RepoRecord, host: string): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP,
    pushed_at: FIXED_TIMESTAMP,
    html_url: `http://${host}/${repo.owner}/${repo.name}`,
    clone_url: `http://${host}/${repo.owner}/${repo.name}.git`,
    git_url: `git://${host}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@${host}:${repo.owner}/${repo.name}.git`,
    fork: false,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    license: null,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: LabelRecord): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(repo: RepoRecord, issue: IssueRecord, host: string): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? { name, color: 'ededed', description: '' } : labelJson(label);
    }),
    user: { login: issue.user, id: VIEWER_ID, type: 'User' },
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP,
    closed_at: issue.state === 'closed' ? FIXED_TIMESTAMP : null,
    html_url: `http://${host}/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(repo: RepoRecord, issue: IssueRecord, comment: { id: number; body: string; user: string }, host: string): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.user, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP,
    html_url: `http://${host}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

export function pullJson(repo: RepoRecord, pull: PullRecord, host: string): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: repo.owner, id: VIEWER_ID, type: 'User' } },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: repo.owner, id: VIEWER_ID, type: 'User' } },
    user: { login: pull.user, id: VIEWER_ID, type: 'User' },
    draft: false,
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP,
    closed_at: pull.state === 'closed' ? FIXED_TIMESTAMP : null,
    html_url: `http://${host}/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

/** One page of a list, with a Link header for the next page when there is one. */
function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
  path: string,
  host: string,
): { page: T[]; link: string | null } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  let link: string | null = null;
  if (page < lastPage) {
    const next = new URLSearchParams(query);
    next.set('page', String(page + 1));
    next.set('per_page', String(perPage));
    const last = new URLSearchParams(query);
    last.set('page', String(lastPage));
    last.set('per_page', String(perPage));
    link = `<http://${host}${path}?${next.toString()}>; rel="next", <http://${host}${path}?${last.toString()}>; rel="last"`;
  }
  return { page: [...slice], link };
}

function pageHeaders(link: string | null): Record<string, string> {
  return link === null ? {} : { link };
}

/** The repository a route names, or the 404 reply when it is not the viewer's. */
function repoOr404(ctx: RestContext, owner: string, name: string): { repo: RepoRecord } | { reply: Reply } {
  if (owner !== VIEWER_LOGIN) return { reply: errorReply(404, 'Not Found') };
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return { reply: errorReply(404, 'Not Found') };
  return { repo };
}

// ---------------------------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------------------------

function listUserRepos(ctx: RestContext, req: RestRequest): Reply {
  const repos = ctx.store.repoOrder;
  const { page, link } = paginate(repos, req.query, '/api/v3/user/repos', ctx.host);
  return jsonReply(200, page.map((repo) => repoJson(repo, ctx.host)), pageHeaders(link));
}

function createUserRepo(ctx: RestContext, req: RestRequest): Reply {
  if (req.malformedBody) return errorReply(400, 'Invalid JSON body');
  const name = bodyString(req.body, 'name');
  if (name === '') return errorReply(422, 'name is required');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return errorReply(422, 'Invalid repository name');
  const created = ctx.store.createRepo(name, bodyBoolean(req.body, 'private', false), bodyString(req.body, 'description'));
  if ('error' in created) return errorReply(422, created.error);
  return jsonReply(201, repoJson(created.repo, ctx.host));
}

function getRepo(ctx: RestContext, owner: string, name: string): Reply {
  const found = repoOr404(ctx, owner, name);
  if ('reply' in found) return found.reply;
  return jsonReply(200, repoJson(found.repo, ctx.host));
}

function patchRepo(ctx: RestContext, req: RestRequest, owner: string, name: string): Reply {
  if (req.malformedBody) return errorReply(400, 'Invalid JSON body');
  const found = repoOr404(ctx, owner, name);
  if ('reply' in found) return found.reply;
  const repo = found.repo;
  if (isRecord(req.body) && typeof req.body.description === 'string') repo.description = req.body.description;
  if (isRecord(req.body) && typeof req.body.private === 'boolean') repo.isPrivate = req.body.private;
  if (isRecord(req.body) && typeof req.body.default_branch === 'string' && req.body.default_branch !== '') {
    repo.defaultBranch = req.body.default_branch;
  }
  return jsonReply(200, repoJson(repo, ctx.host));
}

function deleteRepo(ctx: RestContext, owner: string, name: string): Reply {
  if (owner !== VIEWER_LOGIN) return errorReply(404, 'Not Found');
  if (!ctx.store.deleteRepo(owner, name)) return errorReply(404, 'Not Found');
  return emptyReply(204);
}

function listBranches(ctx: RestContext, owner: string, name: string): Reply {
  const found = repoOr404(ctx, owner, name);
  if ('reply' in found) return found.reply;
  const repo = found.repo;
  return jsonReply(
    200,
    ctx.store.branchNames(repo).map((branch) => ({
      name: branch,
      commit: { sha: repo.refs.get(`refs/heads/${branch}`) ?? '' },
      protected: false,
    })),
  );
}

function getBranch(ctx: RestContext, owner: string, name: string, branch: string): Reply {
  const found = repoOr404(ctx, owner, name);
  if ('reply' in found) return found.reply;
  const repo = found.repo;
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) return errorReply(404, 'Branch not found');
  return jsonReply(200, { name: branch, commit: { sha }, protected: false });
}

function listCommits(ctx: RestContext, req: RestRequest, owner: string, name: string): Reply {
  const found = repoOr404(ctx, owner, name);
  if ('reply' in found) return found.reply;
  const repo = found.repo;
  const ref = req.query.get('sha') ?? repo.defaultBranch;
  const history = ctx.store.commitHistory(repo, ref);
  return jsonReply(
    200,
    history.map((sha) => {
      const object = repo.objects.get(sha);
      const view = object === undefined ? null : parseCommit(object.data);
      return {
        sha,
        commit: {
          // The stored commit message ends with the newline git appends; the
          // API presents it without that trailing newline.
          message: (view?.message ?? '').endsWith('\n') ? (view?.message ?? '').slice(0, -1) : (view?.message ?? ''),
          author: { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: FIXED_TIMESTAMP },
          committer: { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: FIXED_TIMESTAMP },
        },
        author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        parents: (view?.parents ?? []).map((parent) => ({ sha: parent })),
      };
    }),
  );
}

function createRef(ctx: RestContext, req: RestRequest, owner: string, name: string): Reply {
  if (req.malformedBody) return errorReply(400, 'Invalid JSON body');
  const found = repoOr404(ctx, owner, name);
  if ('reply' in found) return found.reply;
  const repo = found.repo;
  const ref = bodyString(req.body, 'ref');
  const sha = bodyString(req.body, 'sha');
  if (ref === '' || sha === '') return errorReply(422, 'ref and sha are required');
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return errorReply(422, 'Invalid ref');
  if (repo.refs.has(ref)) return errorReply(422, 'Reference already exists');
  const object = repo.objects.get(sha);
  if (object === undefined) return errorReply(422, 'Object does not exist');
  if (ref.startsWith('refs/heads/') && object.type !== 'commit') return errorReply(422, 'Branch must point at a commit');
  repo.refs.set(ref, sha);
  return jsonReply(201, { ref, object: { sha, type: object.type } });
}

function listRefs(ctx: RestContext, owner: string, name: string): Reply {
  const found = repoOr404(ctx, owner, name);
  if ('reply' in found) return found.reply;
  const repo = found.repo;
  return jsonReply(
    200,
    ctx.store.allRefs(repo).map((ref) => ({ ref: ref.name, object: { sha: ref.oid } })),
  );
}

function getRef(ctx: RestContext, owner: string, name: string, kind: string, refName: string): Reply {
  const found = repoOr404(ctx, owner, name);
  if ('reply' in found) return found.reply;
  const repo = found.repo;
  const ref = `refs/${kind}/${refName}`;
  const sha = repo.refs.get(ref);
  if (sha === undefined) return errorReply(404, 'Not Found');
  return jsonReply(200, { ref, object: { sha } });
}

function base64Of(content: string): Buffer | null {
  const cleaned = content.replace(/\s+/g, '');
  if (cleaned === '') return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return null;
  return Buffer.from(cleaned, 'base64');
}

function putContent(ctx: RestContext, req: RestRequest, owner: string, name: string, path: string): Reply {
  if (req.malformedBody) return errorReply(400, 'Invalid JSON body');
  const found = repoOr404(ctx, owner, name);
  if ('reply' in found) return found.reply;
  const repo = found.repo;
  const message = bodyString(req.body, 'message');
  const content = bodyString(req.body, 'content');
  if (message === '' || content === '') return errorReply(422, 'message and content are required');
  const bytes = base64Of(content);
  if (bytes === null) return errorReply(422, 'content is not valid base64');
  const branch = bodyString(req.body, 'branch') || repo.defaultBranch;
  const sha = bodyString(req.body, 'sha');
  const existing = ctx.store.readBranchFile(repo, branch, path);
  const existingSha = existing === null ? null : ctx.store.branchFiles(repo, branch).get(path)?.oid ?? null;
  if (existing !== null) {
    if (sha === '') return errorReply(422, 'sha is required to update a file');
    if (sha !== existingSha) return errorReply(409, 'sha does not match the current file');
  } else if (sha !== '') {
    return errorReply(422, 'sha does not match any existing file');
  }
  const committed = ctx.store.commitFile(repo, branch, path, bytes, message);
  if ('error' in committed) return errorReply(422, committed.error);
  const status = existing === null ? 201 : 200;
  const blobSha = committed.blobOid ?? '';
  return jsonReply(status, {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: blobSha,
      size: bytes.length,
      type: 'file',
      encoding: 'base64',
      content: bytes.toString('base64'),
    },
    commit: {
      sha: committed.commitOid,
      message,
      author: { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: FIXED_TIMESTAMP },
      committer: { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: FIXED_TIMESTAMP },
    },
  });
}

function getContent(ctx: RestContext, req: RestRequest, owner: string, name: string, path: string): Reply {
  const found = repoOr404(ctx, owner, name);
  if ('reply' in found) return found.reply;
  const repo = found.repo;
  const ref = req.query.get('ref') ?? repo.defaultBranch;
  const tip = ctx.store.resolveBranch(repo, ref) ?? (repo.objects.has(ref) ? ref : null);
  if (tip === null) return errorReply(404, 'Not Found');
  const commitObject = repo.objects.get(tip);
  if (commitObject === undefined || commitObject.type !== 'commit') return errorReply(404, 'Not Found');
  const treeOid = parseCommit(commitObject.data).tree;
  const files = flattenTree(treeOid, ctx.store.lookup(repo));
  const entry = files.get(path);
  if (entry !== undefined) {
    const object = repo.objects.get(entry.oid);
    if (object === undefined || object.type !== 'blob') return errorReply(404, 'Not Found');
    return jsonReply(200, {
      type: 'file',
      encoding: 'base64',
      size: object.data.length,
      name: path.split('/').pop() ?? path,
      path,
      content: object.data.toString('base64'),
      sha: entry.oid,
    });
  }
  // A directory: its immediate children, files and subdirectories.
  const prefix = path === '' ? '' : `${path}/`;
  const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string; size?: number }>();
  for (const [filePath, fileEntry] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const object = repo.objects.get(fileEntry.oid);
      children.set(rest, { type: 'file', name: rest, path: filePath, sha: fileEntry.oid, size: object?.data.length ?? 0 });
    } else {
      const dirName = rest.slice(0, slash);
      if (!children.has(dirName)) {
        // The subtree id for this directory: walk the tree to find it.
        const dirSha = subtreeOid(repo, treeOid, `${prefix}${dirName}`);
        children.set(dirName, { type: 'dir', name: dirName, path: `${prefix}${dirName}`, sha: dirSha ?? '' });
      }
    }
  }
  if (children.size === 0) return errorReply(404, 'Not Found');
  return jsonReply(200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
}

/** The tree id of a directory path inside a tree, or null. */
function subtreeOid(repo: RepoRecord, treeOid: string, dirPath: string): string | null {
  const segments = dirPath.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

function deleteContent(ctx: RestContext, req: RestRequest, owner: string, name: string, path: string): Reply {
  if (req.malformedBody) return errorReply(400, 'Invalid JSON body');
  const found = repoOr404(ctx, owner, name);
  if ('reply' in found) return found.reply;
  const repo = found.repo;
  const message = bodyString(req.body, 'message') || 'Delete file';
  const branch = bodyString(req.body, 'branch') || repo.defaultBranch;
  const sha = bodyString(req.body, 'sha');
  const existing = ctx.store.readBranchFile(repo, branch, path);
  if (existing === null) return errorReply(404, 'Not Found');
  const existingSha = ctx.store.branchFiles(repo, branch).get(path)?.oid ?? null;
  if (sha !== '' && sha !== existingSha) return errorReply(409, 'sha does not match the current file');
  const committed = ctx.store.commitFile(repo, branch, path, null, message);
  if ('error' in committed) return errorReply(422, committed.error);
  return jsonReply(200, { commit: { sha: committed.commitOid } });
}

// ---------------------------------------------------------------------------------------------
// labels, issues, pulls
// ---------------------------------------------------------------------------------------------

function createLabel(ctx: RestContext, req: RestRequest, owner: string, name: string): Reply {
  if (req.malformedBody) return errorReply(400, 'Invalid JSON body');
  const found = repoOr404(ctx, owner, name);
  if ('reply' in found) return found.reply;
  const labelName = bodyString(req.body, 'name');
  if (labelName === '') return errorReply(422, 'name is required');
  const created = ctx.store.createLabel(found.repo, labelName, bodyString(req.body, 'color') || 'ededed', bodyString(req.body, 'description'));
  if ('error' in created) return errorReply(422, created.error);
  return jsonReply(201, { name: created.label.name, color: created.label.color, description: created.label.description });
}

function listLabels(ctx: RestContext, owner: string, name: string): Reply {
  const found = repoOr404(ctx, owner, name);
  if ('reply' in found) return found.reply;
  return jsonReply(200, [...found.repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description })));
}

function createIssue(ctx: RestContext, req: RestRequest, owner: string, name: string): Reply {
  if (req.malformedBody) return errorReply(400, 'Invalid JSON body');
  const found = repoOr404(ctx, owner, name);
  if ('reply' in found) return found.reply;
  const title = bodyString(req.body, 'title');
  if (title === '') return errorReply(422, 'title is required');
  const body = bodyString(req.body, 'body');
  const labels: string[] = [];
  if (isRecord(req.body) && Array.isArray(req.body.labels)) {
    for (const entry of req.body.labels) {
      if (typeof entry === 'string') labels.push(entry);
      else if (isRecord(entry) && typeof entry.name === 'string') labels.push(entry.name);
    }
  }
  const created = ctx.store.createIssue(found.repo, title, body, labels);
  if ('error' in created) return errorReply(422, created.error);
  return jsonReply(201, issueJson(found.repo, created.issue, ctx.host));
}

function listIssues(ctx: RestContext, req: RestRequest, owner: string, name: string): Reply {
  const found = repoOr404(ctx, owner, name);
  if ('reply' in found) return found.reply;
  const repo = found.repo;
  const state = req.query.get('state') ?? 'open';
  let issues = ctx.store.issuesInOrder(repo);
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  else if (state !== 'all') return errorReply(422, 'Invalid state');
  const sort = req.query.get('sort') ?? 'created';
  const direction = req.query.get('direction') ?? 'desc';
  if (sort === 'created') {
    issues = [...issues].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  const { page, link } = paginate(issues, req.query, `/api/v3/repos/${owner}/${name}/issues`, ctx.host);
  return jsonReply(200, page.map((issue) => issueJson(repo, issue, ctx.host)), pageHeaders(link));
}

function issueByNumber(ctx: RestContext, owner: string, name: string, number: number): { repo: RepoRecord; issue: IssueRecord } | { reply: Reply } {
  const found = repoOr404(ctx, owner, name);
  if ('reply' in found) return found;
  const issue = found.repo.issues.get(number);
  if (issue === undefined) return { reply: errorReply(404, 'Not Found') };
  return { repo: found.repo, issue };
}

function getIssue(ctx: RestContext, owner: string, name: string, number: number): Reply {
  const found = issueByNumber(ctx, owner, name, number);
  if ('reply' in found) return found.reply;
  return jsonReply(200, issueJson(found.repo, found.issue, ctx.host));
}

function patchIssue(ctx: RestContext, req: RestRequest, owner: string, name: string, number: number): Reply {
  if (req.malformedBody) return errorReply(400, 'Invalid JSON body');
  const found = issueByNumber(ctx, owner, name, number);
  if ('reply' in found) return found.reply;
  const issue = found.issue;
  if (isRecord(req.body) && typeof req.body.state === 'string') {
    if (req.body.state !== 'open' && req.body.state !== 'closed') return errorReply(422, 'Invalid state');
    issue.state = req.body.state;
  }
  if (isRecord(req.body) && typeof req.body.title === 'string') issue.title = req.body.title;
  if (isRecord(req.body) && typeof req.body.body === 'string') issue.body = req.body.body;
  return jsonReply(200, issueJson(found.repo, issue, ctx.host));
}

function createComment(ctx: RestContext, req: RestRequest, owner: string, name: string, number: number): Reply {
  if (req.malformedBody) return errorReply(400, 'Invalid JSON body');
  const found = issueByNumber(ctx, owner, name, number);
  if ('reply' in found) return found.reply;
  const body = bodyString(req.body, 'body');
  if (body === '') return errorReply(422, 'body is required');
  const created = ctx.store.createComment(found.repo, number, body);
  if ('error' in created) return errorReply(422, created.error);
  return jsonReply(201, commentJson(found.repo, found.issue, created.comment, ctx.host));
}

function listComments(ctx: RestContext, owner: string, name: string, number: number): Reply {
  const found = issueByNumber(ctx, owner, name, number);
  if ('reply' in found) return found.reply;
  return jsonReply(200, found.issue.comments.map((comment) => commentJson(found.repo, found.issue, comment, ctx.host)));
}

function createPull(ctx: RestContext, req: RestRequest, owner: string, name: string): Reply {
  if (req.malformedBody) return errorReply(400, 'Invalid JSON body');
  const found = repoOr404(ctx, owner, name);
  if ('reply' in found) return found.reply;
  const title = bodyString(req.body, 'title');
  const head = bodyString(req.body, 'head');
  const base = bodyString(req.body, 'base') || found.repo.defaultBranch;
  if (title === '' || head === '') return errorReply(422, 'title and head are required');
  const created = ctx.store.createPull(found.repo, title, bodyString(req.body, 'body'), head, base);
  if ('error' in created) return errorReply(422, created.error);
  return jsonReply(201, pullJson(found.repo, created.pull, ctx.host));
}

function listPulls(ctx: RestContext, req: RestRequest, owner: string, name: string): Reply {
  const found = repoOr404(ctx, owner, name);
  if ('reply' in found) return found.reply;
  const repo = found.repo;
  const state = req.query.get('state') ?? 'open';
  let pulls = ctx.store.pullsInOrder(repo);
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  else if (state !== 'all') return errorReply(422, 'Invalid state');
  const { page, link } = paginate(pulls, req.query, `/api/v3/repos/${owner}/${name}/pulls`, ctx.host);
  return jsonReply(200, page.map((pull) => pullJson(repo, pull, ctx.host)), pageHeaders(link));
}

function pullByNumber(ctx: RestContext, owner: string, name: string, number: number): { repo: RepoRecord; pull: PullRecord } | { reply: Reply } {
  const found = repoOr404(ctx, owner, name);
  if ('reply' in found) return found;
  const pull = found.repo.pulls.get(number);
  if (pull === undefined) return { reply: errorReply(404, 'Not Found') };
  return { repo: found.repo, pull };
}

function getPull(ctx: RestContext, owner: string, name: string, number: number): Reply {
  const found = pullByNumber(ctx, owner, name, number);
  if ('reply' in found) return found.reply;
  return jsonReply(200, pullJson(found.repo, found.pull, ctx.host));
}

function listPullFiles(ctx: RestContext, owner: string, name: string, number: number): Reply {
  const found = pullByNumber(ctx, owner, name, number);
  if ('reply' in found) return found.reply;
  const repo = found.repo;
  const changes = ctx.store.pullFiles(repo, found.pull);
  return jsonReply(
    200,
    changes.map((change) => {
      const oldText = change.oldOid === null ? '' : (repo.objects.get(change.oldOid)?.data.toString('utf8') ?? '');
      const newText = change.newOid === null ? '' : (repo.objects.get(change.newOid)?.data.toString('utf8') ?? '');
      const counts = countLineChanges(oldText, newText);
      const status = change.status === 'added' ? 'added' : change.status === 'removed' ? 'removed' : 'modified';
      return {
        filename: change.path,
        status,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      };
    }),
  );
}

function mergePull(ctx: RestContext, req: RestRequest, owner: string, name: string, number: number): Reply {
  if (req.malformedBody) return errorReply(400, 'Invalid JSON body');
  const found = pullByNumber(ctx, owner, name, number);
  if ('reply' in found) return found.reply;
  const repo = found.repo;
  const pull = found.pull;
  if (pull.state !== 'open') return errorReply(405, 'Pull request is not open');
  const merged = ctx.store.mergePull(repo, pull);
  if ('error' in merged) {
    if (merged.error === 'conflict') return errorReply(405, 'Merge conflict');
    return errorReply(422, merged.error);
  }
  return jsonReply(200, {
    sha: merged.commitOid,
    merged: true,
    message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`,
  });
}

// ---------------------------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------------------------

function parseNumber(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/** Route one REST request. Returns null when the path is not under /api/v3. */
export function routeRest(ctx: RestContext, req: RestRequest): Reply | null {
  const segments = req.segments;
  if (segments[0] !== 'api' || segments[1] !== 'v3') return null;
  const rest = segments.slice(2);
  const method = req.method;

  // The API root and meta are public; everything else needs the bearer token.
  const publicRoute = (method === 'GET' && rest.length === 0) || (method === 'GET' && rest.length === 1 && rest[0] === 'meta');
  if (!publicRoute && !isAuthorized(req.headers, ctx.expectedToken)) {
    return errorReply(401, 'Requires authentication');
  }
  if (req.malformedBody && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
    // Malformed bodies are answered 400 by the handlers that read them; the
    // user/repos route is the one the protocol group probes.
    if (rest[0] === 'user' && rest[1] === 'repos') return errorReply(400, 'Invalid JSON body');
  }

  if (method === 'GET' && rest.length === 0) {
    return jsonReply(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    return jsonReply(200, { installed_version: '1.0.0' });
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    return jsonReply(200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_LOGIN, email: VIEWER_EMAIL });
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') return listUserRepos(ctx, req);
    if (method === 'POST') return createUserRepo(ctx, req);
    return errorReply(404, 'Not Found');
  }
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    const tail = rest.slice(3);
    if (tail.length === 0) {
      if (method === 'GET') return getRepo(ctx, owner, name);
      if (method === 'PATCH') return patchRepo(ctx, req, owner, name);
      if (method === 'DELETE') return deleteRepo(ctx, owner, name);
      return errorReply(404, 'Not Found');
    }
    if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') return listBranches(ctx, owner, name);
    if (tail[0] === 'branches' && tail.length === 2 && method === 'GET') return getBranch(ctx, owner, name, tail[1] as string);
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') return listCommits(ctx, req, owner, name);
    if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 2) {
      if (method === 'POST') return createRef(ctx, req, owner, name);
      if (method === 'GET') return listRefs(ctx, owner, name);
      return errorReply(404, 'Not Found');
    }
    if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 4 && method === 'GET') {
      return getRef(ctx, owner, name, tail[2] as string, tail[3] as string);
    }
    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      if (method === 'PUT') return putContent(ctx, req, owner, name, path);
      if (method === 'GET') return getContent(ctx, req, owner, name, path);
      if (method === 'DELETE') return deleteContent(ctx, req, owner, name, path);
      return errorReply(404, 'Not Found');
    }
    if (tail[0] === 'labels' && tail.length === 1) {
      if (method === 'POST') return createLabel(ctx, req, owner, name);
      if (method === 'GET') return listLabels(ctx, owner, name);
      return errorReply(404, 'Not Found');
    }
    if (tail[0] === 'issues' && tail.length === 1) {
      if (method === 'POST') return createIssue(ctx, req, owner, name);
      if (method === 'GET') return listIssues(ctx, req, owner, name);
      return errorReply(404, 'Not Found');
    }
    if (tail[0] === 'issues' && tail.length === 2) {
      const number = parseNumber(tail[1] as string);
      if (number === null) return errorReply(404, 'Not Found');
      if (method === 'GET') return getIssue(ctx, owner, name, number);
      if (method === 'PATCH') return patchIssue(ctx, req, owner, name, number);
      return errorReply(404, 'Not Found');
    }
    if (tail[0] === 'issues' && tail.length === 3 && tail[2] === 'comments') {
      const number = parseNumber(tail[1] as string);
      if (number === null) return errorReply(404, 'Not Found');
      if (method === 'POST') return createComment(ctx, req, owner, name, number);
      if (method === 'GET') return listComments(ctx, owner, name, number);
      return errorReply(404, 'Not Found');
    }
    if (tail[0] === 'pulls' && tail.length === 1) {
      if (method === 'POST') return createPull(ctx, req, owner, name);
      if (method === 'GET') return listPulls(ctx, req, owner, name);
      return errorReply(404, 'Not Found');
    }
    if (tail[0] === 'pulls' && tail.length === 2) {
      const number = parseNumber(tail[1] as string);
      if (number === null) return errorReply(404, 'Not Found');
      if (method === 'GET') return getPull(ctx, owner, name, number);
      return errorReply(404, 'Not Found');
    }
    if (tail[0] === 'pulls' && tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      const number = parseNumber(tail[1] as string);
      if (number === null) return errorReply(404, 'Not Found');
      return listPullFiles(ctx, owner, name, number);
    }
    if (tail[0] === 'pulls' && tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      const number = parseNumber(tail[1] as string);
      if (number === null) return errorReply(404, 'Not Found');
      return mergePull(ctx, req, owner, name, number);
    }
  }
  return errorReply(404, 'Not Found');
}
