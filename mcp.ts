// The MCP surface: JSON-RPC 2.0 Streamable HTTP at POST /mcp. The modern
// handshake is `server/discover` (revision 2026-07-28) with a legacy
// `initialize` + `notifications/initialized` fallback. tools/list returns one
// frozen tools array, byte-identical on every call. Tools act on the same
// store as REST and GraphQL, so ids are stable across surfaces.

import { VIEWER_LOGIN } from './scenario.ts';
import { emptyReply, errorReply, isAuthorized, jsonReply, type Reply } from './reply.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import type { IssueRecord, PullRecord, RepoRecord, Store } from './store.ts';

export interface McpContext {
  store: Store;
  expectedToken: string;
  host: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: boolean;
  };
}

function tool(name: string, description: string, properties: Record<string, Record<string, unknown>>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

const REPO_PROPS: Record<string, Record<string, unknown>> = {
  owner: { type: 'string', description: 'The owner of the repository.' },
  repo: { type: 'string', description: 'The name of the repository.' },
};

/** The frozen tool list: one constant, serialized identically on every call. */
export const TOOLS: readonly ToolDef[] = [
  tool('create_repo', 'Create a new repository for the authenticated user.', {
    name: { type: 'string', description: 'The name of the repository.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', { ...REPO_PROPS }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    ...REPO_PROPS,
    title: { type: 'string', description: 'The title of the issue.' },
    body: { type: 'string', description: 'The body of the issue.' },
    labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply to the issue.' },
  }, ['owner', 'repo', 'title']),
  tool('get_issue', 'Get one issue in a repository by number.', {
    ...REPO_PROPS,
    issue_number: { type: 'integer', description: 'The issue number.' },
  }, ['owner', 'repo', 'issue_number']),
  tool('list_issues', 'List issues in a repository.', {
    ...REPO_PROPS,
    state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'The issue state to list.' },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request from a head branch onto a base branch.', {
    ...REPO_PROPS,
    title: { type: 'string', description: 'The title of the pull request.' },
    head: { type: 'string', description: 'The head branch.' },
    base: { type: 'string', description: 'The base branch.' },
    body: { type: 'string', description: 'The body of the pull request.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('list_pull_requests', 'List pull requests in a repository.', {
    ...REPO_PROPS,
    state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'The pull request state to list.' },
  }, ['owner', 'repo']),
  tool('merge_pull_request', 'Merge an open pull request with a squash commit.', {
    ...REPO_PROPS,
    pull_number: { type: 'integer', description: 'The pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
];

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];
const SERVER_INFO = { name: 'git-forge', version: '1.0.0' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function numberArg(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

function okResult(value: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function errorResult(message: string): ToolResult {
  const value = { error: message };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true };
}

function findTool(name: string): ToolDef | undefined {
  const wanted = name.toLowerCase();
  return TOOLS.find((candidate) => {
    const candidateName = candidate.name.toLowerCase();
    return candidateName === wanted || candidateName.endsWith(wanted) || wanted.endsWith(candidateName);
  });
}

function repoOrError(ctx: McpContext, args: Record<string, unknown>): { repo: RepoRecord } | { error: string } {
  const owner = stringArg(args, 'owner');
  const repoName = stringArg(args, 'repo');
  if (owner === '' || repoName === '') return { error: 'owner and repo are required' };
  if (owner !== VIEWER_LOGIN) return { error: 'Not Found' };
  const repo = ctx.store.getRepo(owner, repoName);
  if (repo === undefined) return { error: 'Not Found' };
  return { repo };
}

function callTool(ctx: McpContext, name: string, args: Record<string, unknown>): ToolResult {
  const definition = findTool(name);
  if (definition === undefined) throw { code: -32602, message: `Unknown tool: ${name}` };
  for (const required of definition.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return errorResult(`Missing required argument: ${required}`);
    }
  }
  switch (definition.name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      const created = ctx.store.createRepo(repoName, args.private === true, stringArg(args, 'description'));
      if ('error' in created) return errorResult(created.error);
      return okResult(repoJson(created.repo, ctx.host));
    }
    case 'get_repo': {
      const found = repoOrError(ctx, args);
      if ('error' in found) return errorResult(found.error);
      return okResult(repoJson(found.repo, ctx.host));
    }
    case 'create_issue': {
      const found = repoOrError(ctx, args);
      if ('error' in found) return errorResult(found.error);
      const labels: string[] = Array.isArray(args.labels) ? args.labels.filter((label): label is string => typeof label === 'string') : [];
      const created = ctx.store.createIssue(found.repo, stringArg(args, 'title'), stringArg(args, 'body'), labels);
      if ('error' in created) return errorResult(created.error);
      return okResult(issueJson(found.repo, created.issue, ctx.host));
    }
    case 'get_issue': {
      const found = repoOrError(ctx, args);
      if ('error' in found) return errorResult(found.error);
      const number = numberArg(args, 'issue_number');
      if (number === null) return errorResult('issue_number is required');
      const issue = found.repo.issues.get(number);
      if (issue === undefined) return errorResult('Not Found');
      return okResult(issueJson(found.repo, issue, ctx.host));
    }
    case 'list_issues': {
      const found = repoOrError(ctx, args);
      if ('error' in found) return errorResult(found.error);
      const state = stringArg(args, 'state') || 'open';
      let issues: IssueRecord[] = ctx.store.issuesInOrder(found.repo);
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      else if (state !== 'all') return errorResult('Invalid state');
      const listed = issues.map((issue) => issueJson(found.repo, issue, ctx.host));
      return okResult({ issues: listed, total_count: listed.length });
    }
    case 'create_pull_request': {
      const found = repoOrError(ctx, args);
      if ('error' in found) return errorResult(found.error);
      const created = ctx.store.createPull(found.repo, stringArg(args, 'title'), stringArg(args, 'body'), stringArg(args, 'head'), stringArg(args, 'base'));
      if ('error' in created) return errorResult(created.error);
      return okResult(pullJson(found.repo, created.pull, ctx.host));
    }
    case 'list_pull_requests': {
      const found = repoOrError(ctx, args);
      if ('error' in found) return errorResult(found.error);
      const state = stringArg(args, 'state') || 'open';
      let pulls: PullRecord[] = ctx.store.pullsInOrder(found.repo);
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      else if (state !== 'all') return errorResult('Invalid state');
      const listed = pulls.map((pull) => pullJson(found.repo, pull, ctx.host));
      return okResult({ pull_requests: listed, total_count: listed.length });
    }
    case 'merge_pull_request': {
      const found = repoOrError(ctx, args);
      if ('error' in found) return errorResult(found.error);
      const number = numberArg(args, 'pull_number');
      if (number === null) return errorResult('pull_number is required');
      const pull = found.repo.pulls.get(number);
      if (pull === undefined) return errorResult('Not Found');
      if (pull.state !== 'open') return errorResult('Pull request is not open');
      const merged = ctx.store.mergePull(found.repo, pull);
      if ('error' in merged) return errorResult(merged.error === 'conflict' ? 'Merge conflict' : merged.error);
      return okResult({ sha: merged.commitOid, merged: true, message: `Merge pull request #${pull.number} from ${found.repo.owner}/${pull.headRef}` });
    }
    default:
      return errorResult(`Tool not implemented: ${definition.name}`);
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------------------------

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function handleRequest(ctx: McpContext, request: unknown): { status: number; body: Record<string, unknown> | null } {
  if (!isRecord(request)) return { status: 200, body: rpcError(null, -32600, 'Invalid Request') };
  const id = request.id ?? null;
  const method = request.method;
  if (typeof method !== 'string') return { status: 200, body: rpcError(id, -32600, 'Invalid Request') };
  const params = isRecord(request.params) ? request.params : {};

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        protocolVersion: '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      }),
    };
  }
  if (method === 'initialize') {
    const protocolVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(protocolVersion) ? protocolVersion : '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }),
    };
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    // A notification carries no id and is answered with an empty 202.
    return { status: 202, body: null };
  }
  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    try {
      const result = callTool(ctx, toolName, args);
      return { status: 200, body: rpcResult(id, result) };
    } catch (error) {
      if (isRecord(error) && typeof error.code === 'number') {
        return { status: 200, body: rpcError(id, error.code, typeof error.message === 'string' ? error.message : 'Invalid params') };
      }
      return { status: 200, body: rpcError(id, -32603, error instanceof Error ? error.message : 'Internal error') };
    }
  }
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}

/** Route POST /mcp (and DELETE for session teardown). Returns null for other paths. */
export function routeMcp(ctx: McpContext, method: string, segments: string[], headers: Record<string, string | string[] | undefined>, bodyText: string): Reply | null {
  if (segments[0] !== 'mcp' || segments.length !== 1) return null;
  if (method === 'DELETE') {
    return emptyReply(200);
  }
  if (method !== 'POST') return errorReply(405, 'Method Not Allowed');
  if (!isAuthorized(headers, ctx.expectedToken)) {
    return jsonReply(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Requires authentication' } });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return jsonReply(400, rpcError(null, -32700, 'Parse error'));
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((request) => handleRequest(ctx, request).body).filter((body) => body !== null);
    return jsonReply(200, results);
  }
  const handled = handleRequest(ctx, parsed);
  if (handled.body === null) {
    return emptyReply(handled.status);
  }
  return jsonReply(handled.status, handled.body);
}
