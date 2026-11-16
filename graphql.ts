// The GraphQL v4 surface: a small parser and executor for the documents gh
// and github-mcp-server send, over POST /api/graphql. No schema library: the
// documents are parsed into an AST and resolved against the store with a
// static field table. Unknown fields are HTTP 200 with an `errors` array
// naming the field; an unknown repository is data.repository = null with no
// errors; two operation documents in one body answer two results in order.

import { FIXED_TIMESTAMP, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN } from './scenario.ts';
import { errorReply, isAuthorized, jsonReply, type Reply } from './reply.ts';
import type { IssueRecord, PullRecord, RepoRecord, Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      // Block strings (""") and plain strings.
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'u' && j + 5 < input.length) {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      if (j >= input.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!@=$'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// AST and parser
// ---------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface ArgumentNode {
  name: string;
  value: ValueNode;
}

export type SelectionNode =
  | { kind: 'field'; alias: string | null; name: string; arguments: ArgumentNode[]; selections: SelectionNode[] }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

export interface OperationDefinition {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: Array<{ name: string; type: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

export interface FragmentDefinition {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

export type DefinitionNode = OperationDefinition | FragmentDefinition;

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = lex(input);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`expected name ${value ?? ''}, got ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') {
      definitions.push(this.parseDefinition());
    }
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variableDefinitions: [], selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      this.skipDirectives();
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    const operation = this.expectName() as 'query' | 'mutation' | 'subscription';
    if (operation !== 'query' && operation !== 'mutation' && operation !== 'subscription') {
      throw new Error(`unknown operation ${operation}`);
    }
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const variableDefinitions: OperationDefinition['variableDefinitions'] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefinitions.push({ name: varName, type, defaultValue });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    return { kind: 'operation', operation, name, variableDefinitions, selections: this.parseSelectionSet() };
  }

  private parseType(): string {
    let type: string;
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      type = `[${inner}]`;
    } else {
      type = this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selections: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, arguments: args, selections };
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    if (!(this.peek().kind === 'punct' && this.peek().value === '(')) return args;
    this.next();
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

/** Parse a GraphQL document string into definitions. */
export function parseDocument(input: string): DefinitionNode[] {
  return new Parser(input).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

export interface GqlContext {
  store: Store;
  host: string;
}

interface GqlError {
  message: string;
  path?: Array<string | number>;
}

type Variables = Record<string, unknown>;

function evaluateValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
    case 'float':
      return node.value;
    case 'string':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => evaluateValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evaluateValue(field.value, variables);
      return out;
    }
  }
}

function evaluateArguments(args: ArgumentNode[], variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = evaluateValue(arg.value, variables);
  return out;
}

interface FieldDef {
  type: string;
  resolve?: (parent: unknown, args: Record<string, unknown>, ctx: GqlContext) => unknown;
}

/** A value whose concrete GraphQL type differs from the static field type. */
interface TypedValue {
  __typename: string;
  __value: unknown;
}

function isTypedValue(value: unknown): value is TypedValue {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).__typename === 'string' &&
    '__value' in (value as Record<string, unknown>)
  );
}

function unwrap(value: unknown): { type: string | null; value: unknown } {
  if (isTypedValue(value)) return { type: value.__typename, value: value.__value };
  return { type: null, value };
}

/** The named type behind list/non-null wrappers: `[Issue]!` -> `Issue`. */
function namedType(type: string): string {
  let name = type;
  while (name.endsWith('!')) name = name.slice(0, -1);
  while (name.startsWith('[') && name.endsWith(']')) name = name.slice(1, -1);
  while (name.endsWith('!')) name = name.slice(0, -1);
  return name;
}

function cursorEncode(seq: number): string {
  return Buffer.from(`issue-cursor:${seq}`, 'utf8').toString('base64');
}

function cursorDecode(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^issue-cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface ConnectionResult<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  totalCount: number;
}

function paginateConnection<T extends { seq: number }>(
  items: readonly T[],
  args: Record<string, unknown>,
): ConnectionResult<T> {
  const afterSeq = cursorDecode(args.after);
  let filtered = afterSeq === null ? [...items] : items.filter((item) => item.seq < afterSeq);
  const totalCount = filtered.length;
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : filtered.length;
  const nodes = filtered.slice(0, first);
  const hasNextPage = filtered.length > nodes.length;
  return {
    nodes,
    totalCount,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: false,
      startCursor: nodes.length > 0 ? cursorEncode((nodes[0] as T).seq) : null,
      endCursor: nodes.length > 0 ? cursorEncode((nodes[nodes.length - 1] as T).seq) : null,
    },
  };
}

class Executor {
  private fragments = new Map<string, FragmentDefinition>();
  private errors: GqlError[] = [];
  private definitions: DefinitionNode[];
  private ctx: GqlContext;

  constructor(definitions: DefinitionNode[], ctx: GqlContext) {
    this.definitions = definitions;
    this.ctx = ctx;
    for (const definition of definitions) {
      if (definition.kind === 'fragment') this.fragments.set(definition.name, definition);
    }
  }

  execute(operation: OperationDefinition, variables: Variables): { data: Record<string, unknown> | null; errors: GqlError[] } {
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const data = this.executeSelections(operation.selections, {}, rootType, variables, []);
    return { data, errors: this.errors };
  }

  private executeSelections(
    selections: SelectionNode[],
    parent: unknown,
    parentType: string,
    variables: Variables,
    path: Array<string | number>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const visited = new Set<string>();
    for (const selection of selections) {
      if (selection.kind === 'field') {
        const key = selection.alias ?? selection.name;
        const dedup = `${key}:${selection.arguments.length}`;
        if (visited.has(dedup)) continue;
        visited.add(dedup);
        out[key] = this.executeField(selection, parent, parentType, variables, [...path, key]);
      } else if (selection.kind === 'inlineFragment') {
        if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
        const fragmentResult = this.executeSelections(selection.selections, parent, parentType, variables, path);
        Object.assign(out, fragmentResult);
      } else {
        const fragment = this.fragments.get(selection.name);
        if (fragment === undefined) {
          this.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
          continue;
        }
        if (fragment.typeCondition !== parentType) continue;
        const fragmentResult = this.executeSelections(fragment.selections, parent, parentType, variables, path);
        Object.assign(out, fragmentResult);
      }
    }
    return out;
  }

  private executeField(
    field: Extract<SelectionNode, { kind: 'field' }>,
    parent: unknown,
    parentType: string,
    variables: Variables,
    path: Array<string | number>,
  ): unknown {
    const name = field.name;
    if (name === '__typename') return parentType;
    const fields = SCHEMA[parentType];
    const definition = fields?.[name];
    if (definition === undefined) {
      this.errors.push({ message: `Cannot query field "${name}" on type "${parentType}".`, path });
      return null;
    }
    const args = evaluateArguments(field.arguments, variables);
    let value: unknown;
    try {
      value = definition.resolve !== undefined ? definition.resolve(parent, args, this.ctx) : (parent as Record<string, unknown> | null)?.[name] ?? null;
    } catch (error) {
      this.errors.push({ message: error instanceof Error ? error.message : String(error), path });
      return null;
    }
    if (field.selections.length === 0) return value;
    if (value === null || value === undefined) return null;
    const childType = namedType(definition.type);
    if (Array.isArray(value)) {
      return value.map((item, index) => {
        if (item === null || item === undefined) return null;
        const { type, value: unwrapped } = unwrap(item);
        return this.executeSelections(field.selections, unwrapped, type ?? childType, variables, [...path, index]);
      });
    }
    const { type, value: unwrapped } = unwrap(value);
    return this.executeSelections(field.selections, unwrapped, type ?? childType, variables, path);
  }
}

/** Execute one GraphQL operation body and return the response object. */
export function executeGraphQL(ctx: GqlContext, query: string, variables: Variables, operationName: string | null): Record<string, unknown> {
  let definitions: DefinitionNode[];
  try {
    definitions = parseDocument(query);
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const operations = definitions.filter((definition): definition is OperationDefinition => definition.kind === 'operation');
  let operation: OperationDefinition | undefined;
  if (operationName !== null) {
    operation = operations.find((candidate) => candidate.name === operationName);
  } else if (operations.length === 1) {
    operation = operations[0];
  }
  if (operation === undefined) {
    return { errors: [{ message: operationName !== null ? `Unknown operation named "${operationName}".` : 'Must provide an operation.' }] };
  }
  const mergedVariables: Variables = { ...variables };
  for (const definition of operation.variableDefinitions) {
    if (!(definition.name in mergedVariables) && definition.defaultValue !== null) {
      mergedVariables[definition.name] = evaluateValue(definition.defaultValue, mergedVariables);
    }
  }
  const executor = new Executor(definitions, ctx);
  const result = executor.execute(operation, mergedVariables);
  const response: Record<string, unknown> = { data: result.data };
  if (result.errors.length > 0) response.errors = result.errors;
  return response;
}

// ---------------------------------------------------------------------------------------------
// schema: field table over the store
// ---------------------------------------------------------------------------------------------

/** The global id of a repository / issue / pull / comment. */
export function globalId(kind: 'R' | 'I' | 'P' | 'C', id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

function parseGlobalId(id: unknown): { kind: string; id: number } | null {
  if (typeof id !== 'string') return null;
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([RIPC]):(\d+)$/.exec(text);
    if (match === null) return null;
    return { kind: match[1] as string, id: Number(match[2]) };
  } catch {
    return null;
  }
}

function findRepoByGlobalId(store: Store, id: unknown): RepoRecord | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'R') return null;
  return store.repoById(parsed.id) ?? null;
}

function findIssueByGlobalId(store: Store, id: unknown): { repo: RepoRecord; issue: IssueRecord } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'I') return null;
  for (const repo of store.repoOrder) {
    for (const issue of repo.issues.values()) {
      if (issue.id === parsed.id) return { repo, issue };
    }
  }
  return null;
}

function findPullByGlobalId(store: Store, id: unknown): { repo: RepoRecord; pull: PullRecord } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'P') return null;
  for (const repo of store.repoOrder) {
    for (const pull of repo.pulls.values()) {
      if (pull.id === parsed.id) return { repo, pull };
    }
  }
  return null;
}

function issueState(issue: IssueRecord): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRecord): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueSort(issues: IssueRecord[], orderBy: unknown): IssueRecord[] {
  const field = typeof orderBy === 'object' && orderBy !== null ? (orderBy as Record<string, unknown>).field : undefined;
  const direction = typeof orderBy === 'object' && orderBy !== null ? (orderBy as Record<string, unknown>).direction : undefined;
  const sorted = [...issues].sort((a, b) => a.seq - b.seq);
  if (field === 'CREATED_AT' || field === 'UPDATED_AT' || field === undefined) {
    if (direction === 'ASC') return sorted;
    return sorted.reverse();
  }
  return sorted.reverse();
}

const INTROSPECTION: Record<string, { fields: string[]; enumValues: string[] }> = {
  Issue: { fields: ['id', 'number', 'title', 'state', 'body'], enumValues: [] },
  PullRequest: { fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body'], enumValues: [] },
  Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'], enumValues: [] },
  SearchType: { fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  IssueState: { fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { fields: [], enumValues: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'] },
};

const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: {
      type: 'User',
      resolve: () => ({ login: VIEWER_LOGIN, id: VIEWER_ID, email: VIEWER_EMAIL }),
    },
    repository: {
      type: 'Repository',
      resolve: (_parent, args, ctx) => {
        const owner = args.owner;
        const name = args.name;
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        if (owner !== VIEWER_LOGIN) return null;
        return ctx.store.getRepo(owner, name) ?? null;
      },
    },
    node: {
      type: 'Node',
      resolve: (_parent, args, ctx) => {
        const parsed = parseGlobalId(args.id);
        if (parsed === null) return null;
        if (parsed.kind === 'R') {
          const repo = ctx.store.repoById(parsed.id);
          if (repo === null) return null;
          return { __typename: 'Repository', __value: repo };
        }
        if (parsed.kind === 'I') {
          const found = findIssueByGlobalId(ctx.store, args.id);
          if (found === null) return null;
          return { __typename: 'Issue', __value: found.issue };
        }
        if (parsed.kind === 'P') {
          const found = findPullByGlobalId(ctx.store, args.id);
          if (found === null) return null;
          return { __typename: 'PullRequest', __value: found.pull };
        }
        return null;
      },
    },
    __type: {
      type: '__Type',
      resolve: (_parent, args) => {
        const name = args.name;
        if (typeof name !== 'string') return null;
        const entry = INTROSPECTION[name];
        if (entry === undefined) return null;
        return { name, kind: entry.enumValues.length > 0 ? 'ENUM' : 'OBJECT', fields: entry.fields, enumValues: entry.enumValues };
      },
    },
  },
  Mutation: {
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(ctx.store, input.repositoryId);
        if (repo === null) throw new Error('Repository not found');
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const created = ctx.store.createIssue(repo, title, body, []);
        if ('error' in created) throw new Error(created.error);
        return { issue: created.issue };
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGlobalId(ctx.store, input.issueId);
        if (found === null) throw new Error('Issue not found');
        found.issue.state = 'closed';
        return { issue: found.issue };
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      resolve: (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(ctx.store, input.repositoryId);
        if (repo === null) throw new Error('Repository not found');
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const created = ctx.store.createPull(repo, title, body, head, base);
        if ('error' in created) throw new Error(created.error);
        return { pullRequest: created.pull };
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findPullByGlobalId(ctx.store, input.pullRequestId);
        if (found === null) throw new Error('Pull request not found');
        if (found.pull.state !== 'open') throw new Error('Pull request is not open');
        const merged = ctx.store.mergePull(found.repo, found.pull);
        if ('error' in merged) throw new Error(merged.error === 'conflict' ? 'Merge conflict' : merged.error);
        return { pullRequest: found.pull };
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGlobalId(ctx.store, input.subjectId);
        if (found === null) throw new Error('Subject not found');
        const body = typeof input.body === 'string' ? input.body : '';
        const created = ctx.store.createComment(found.repo, found.issue.number, body);
        if ('error' in created) throw new Error(created.error);
        return { commentEdge: { node: created.comment } };
      },
    },
  },
  Repository: {
    id: { type: 'ID', resolve: (parent) => globalId('R', (parent as RepoRecord).id) },
    databaseId: { type: 'Int', resolve: (parent) => (parent as RepoRecord).id },
    name: { type: 'String', resolve: (parent) => (parent as RepoRecord).name },
    nameWithOwner: { type: 'String', resolve: (parent) => `${(parent as RepoRecord).owner}/${(parent as RepoRecord).name}` },
    owner: { type: 'User', resolve: (parent) => ({ login: (parent as RepoRecord).owner, id: VIEWER_ID, email: VIEWER_EMAIL }) },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (parent) => {
        const repo = parent as RepoRecord;
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip === undefined ? null : { name: repo.defaultBranch };
      },
    },
    viewerPermission: { type: 'String', resolve: () => 'ADMIN' },
    hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
    issue: {
      type: 'Issue',
      resolve: (parent, args) => {
        const repo = parent as RepoRecord;
        const number = typeof args.number === 'number' ? args.number : -1;
        return repo.issues.get(number) ?? null;
      },
    },
    issues: {
      type: 'IssueConnection',
      resolve: (parent, args) => {
        const repo = parent as RepoRecord;
        let issues = [...repo.issues.values()];
        if (Array.isArray(args.states) && args.states.length > 0) {
          const wanted = new Set(args.states.map((state) => String(state).toLowerCase()));
          issues = issues.filter((issue) => wanted.has(issue.state));
        }
        return paginateConnection(issueSort(issues, args.orderBy), args);
      },
    },
    pullRequests: {
      type: 'PullRequestConnection',
      resolve: (parent, args) => {
        const repo = parent as RepoRecord;
        const pulls = [...repo.pulls.values()].filter((pull) => pull.state === 'open').sort((a, b) => b.seq - a.seq);
        const totalCount = pulls.length;
        const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : pulls.length;
        const nodes = pulls.slice(0, first);
        return {
          nodes,
          totalCount,
          pageInfo: {
            hasNextPage: pulls.length > nodes.length,
            hasPreviousPage: false,
            startCursor: nodes.length > 0 ? cursorEncode((nodes[0] as PullRecord).seq) : null,
            endCursor: nodes.length > 0 ? cursorEncode((nodes[nodes.length - 1] as PullRecord).seq) : null,
          },
        };
      },
    },
    pullRequest: {
      type: 'PullRequest',
      resolve: (parent, args) => {
        const repo = parent as RepoRecord;
        const number = typeof args.number === 'number' ? args.number : -1;
        return repo.pulls.get(number) ?? null;
      },
    },
  },
  Issue: {
    id: { type: 'ID', resolve: (parent) => globalId('I', (parent as IssueRecord).id) },
    number: { type: 'Int', resolve: (parent) => (parent as IssueRecord).number },
    title: { type: 'String', resolve: (parent) => (parent as IssueRecord).title },
    state: { type: 'IssueState', resolve: (parent) => issueState(parent as IssueRecord) },
    body: { type: 'String', resolve: (parent) => (parent as IssueRecord).body },
  },
  PullRequest: {
    id: { type: 'ID', resolve: (parent) => globalId('P', (parent as PullRecord).id) },
    number: { type: 'Int', resolve: (parent) => (parent as PullRecord).number },
    title: { type: 'String', resolve: (parent) => (parent as PullRecord).title },
    body: { type: 'String', resolve: (parent) => (parent as PullRecord).body },
    state: { type: 'PullRequestState', resolve: (parent) => pullState(parent as PullRecord) },
    merged: { type: 'Boolean', resolve: (parent) => (parent as PullRecord).merged },
    headRefName: { type: 'String', resolve: (parent) => (parent as PullRecord).headRef },
    baseRefName: { type: 'String', resolve: (parent) => (parent as PullRecord).baseRef },
    mergeable: {
      type: 'MergeableState',
      resolve: (parent, _args, ctx) => {
        const pull = parent as PullRecord;
        const repo = ctx.store.repoOfPull(pull);
        if (repo === null) return 'UNKNOWN';
        return ctx.store.pullMergeable(repo, pull);
      },
    },
    files: {
      type: 'PullRequestChangedFileConnection',
      resolve: (parent, args, ctx) => {
        const pull = parent as PullRecord;
        const repo = ctx.store.repoOfPull(pull);
        if (repo === null) return { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
        const changes = ctx.store.pullFiles(repo, pull);
        const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : changes.length;
        const nodes = changes.slice(0, first).map((change) => ({ path: change.path }));
        return {
          nodes,
          totalCount: changes.length,
          pageInfo: { hasNextPage: changes.length > nodes.length, hasPreviousPage: false, startCursor: null, endCursor: null },
        };
      },
    },
  },
  User: {
    login: { type: 'String', resolve: (parent) => (parent as { login: string }).login },
    id: { type: 'ID', resolve: (parent) => globalId('R', (parent as { id: number }).id) },
    name: { type: 'String', resolve: (parent) => (parent as { login: string }).login },
    email: { type: 'String', resolve: (parent) => (parent as { email?: string }).email ?? '' },
  },
  Ref: {
    name: { type: 'String', resolve: (parent) => (parent as { name: string }).name },
  },
  IssueConnection: {
    nodes: { type: '[Issue]', resolve: (parent) => (parent as ConnectionResult<IssueRecord>).nodes },
    totalCount: { type: 'Int', resolve: (parent) => (parent as ConnectionResult<IssueRecord>).totalCount },
    pageInfo: { type: 'PageInfo', resolve: (parent) => (parent as ConnectionResult<IssueRecord>).pageInfo },
  },
  PullRequestConnection: {
    nodes: { type: '[PullRequest]', resolve: (parent) => (parent as ConnectionResult<PullRecord>).nodes },
    totalCount: { type: 'Int', resolve: (parent) => (parent as ConnectionResult<PullRecord>).totalCount },
    pageInfo: { type: 'PageInfo', resolve: (parent) => (parent as ConnectionResult<PullRecord>).pageInfo },
  },
  PullRequestChangedFileConnection: {
    nodes: { type: '[PullRequestChangedFile]', resolve: (parent) => (parent as { nodes: Array<{ path: string }> }).nodes },
    totalCount: { type: 'Int', resolve: (parent) => (parent as { totalCount: number }).totalCount },
    pageInfo: { type: 'PageInfo', resolve: (parent) => (parent as { pageInfo: unknown }).pageInfo },
  },
  PullRequestChangedFile: {
    path: { type: 'String', resolve: (parent) => (parent as { path: string }).path },
  },
  PageInfo: {
    hasNextPage: { type: 'Boolean', resolve: (parent) => (parent as { hasNextPage: boolean }).hasNextPage },
    hasPreviousPage: { type: 'Boolean', resolve: (parent) => (parent as { hasPreviousPage: boolean }).hasPreviousPage },
    startCursor: { type: 'String', resolve: (parent) => (parent as { startCursor: string | null }).startCursor },
    endCursor: { type: 'String', resolve: (parent) => (parent as { endCursor: string | null }).endCursor },
  },
  Comment: {
    id: { type: 'ID', resolve: (parent) => globalId('C', (parent as { id: number }).id) },
    body: { type: 'String', resolve: (parent) => (parent as { body: string }).body },
  },
  CommentEdge: {
    node: { type: 'Comment', resolve: (parent) => (parent as { node: unknown }).node },
  },
  AddCommentPayload: {
    commentEdge: { type: 'CommentEdge', resolve: (parent) => (parent as { commentEdge: unknown }).commentEdge },
  },
  CreateIssuePayload: {
    issue: { type: 'Issue', resolve: (parent) => (parent as { issue: unknown }).issue },
  },
  CloseIssuePayload: {
    issue: { type: 'Issue', resolve: (parent) => (parent as { issue: unknown }).issue },
  },
  CreatePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (parent) => (parent as { pullRequest: unknown }).pullRequest },
  },
  MergePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (parent) => (parent as { pullRequest: unknown }).pullRequest },
  },
  __Type: {
    name: { type: 'String', resolve: (parent) => (parent as { name: string }).name },
    kind: { type: 'String', resolve: (parent) => (parent as { kind: string }).kind },
    fields: {
      type: '[__Field]',
      resolve: (parent) => (parent as { fields: string[] }).fields.map((name) => ({ name })),
    },
    enumValues: {
      type: '[__EnumValue]',
      resolve: (parent) => (parent as { enumValues: string[] }).enumValues.map((name) => ({ name })),
    },
  },
  __Field: {
    name: { type: 'String', resolve: (parent) => (parent as { name: string }).name },
  },
  __EnumValue: {
    name: { type: 'String', resolve: (parent) => (parent as { name: string }).name },
  },
  Node: {
    id: {
      type: 'ID',
      resolve: (parent) => {
        const value = parent as Record<string, unknown>;
        if (typeof value.id === 'number') return globalId('R', value.id);
        return '';
      },
    },
  },
};

// ---------------------------------------------------------------------------------------------
// HTTP route
// ---------------------------------------------------------------------------------------------

export interface GraphQLRequest {
  headers: Record<string, string | string[] | undefined>;
  bodyText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Route POST /api/graphql. Returns null when the path is different. */
export function routeGraphQL(ctx: GqlContext & { expectedToken: string }, method: string, segments: string[], req: GraphQLRequest): Reply | null {
  if (segments[0] !== 'api' || segments[1] !== 'graphql') return null;
  if (method !== 'POST') return errorReply(404, 'Not Found');
  if (!isAuthorized(req.headers, ctx.expectedToken)) return errorReply(401, 'Requires authentication');
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.bodyText);
  } catch {
    return errorReply(400, 'Invalid JSON body');
  }
  const operations: Array<Record<string, unknown>> = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [parsed as Record<string, unknown>];
  const results = operations.map((operation) => {
    if (!isRecord(operation) || typeof operation.query !== 'string') {
      return { errors: [{ message: 'Request must include a query string.' }] };
    }
    const variables = isRecord(operation.variables) ? (operation.variables as Variables) : {};
    const operationName = typeof operation.operationName === 'string' ? operation.operationName : null;
    return executeGraphQL(ctx, operation.query, variables, operationName);
  });
  return jsonReply(200, Array.isArray(parsed) ? results : results[0]);
}
