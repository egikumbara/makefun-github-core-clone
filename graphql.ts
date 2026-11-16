// graphql.ts — a small GraphQL executor for the GitHub v4 shapes the conformance
// suite sends: repository/issue/pull-request reads, __type introspection, node(id:),
// cursor connections, the five mutations, and operation batching (handled by the
// caller, one document at a time). It parses the document text (no GraphQL library)
// and validates field names against a fixed schema, so an unknown field is a 200
// with an errors array naming it, exactly like GitHub.

import {
  VIEWER,
  decodeGlobalId,
  globalId,
  isoFromEpoch,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// schema: the field names each type exposes (drives introspection and validation)
// -------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'private',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: [
    'id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels',
    'comments', 'url', 'resourcePath', 'viewerCanUpdate', 'locked', 'assignees', 'milestone',
    'reactions', 'timelineItems', 'projectCards', 'closedAt',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged',
    'mergedAt', 'mergeCommitSha', 'files', 'headRef', 'baseRef', 'createdAt', 'updatedAt',
    'author', 'labels', 'comments', 'reviews', 'reviewRequests', 'additions', 'deletions',
    'changedFiles', 'isDraft', 'commits',
  ],
  User: ['id', 'login', 'name', 'email', 'url'],
  Ref: ['id', 'name', 'prefix', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId', 'actor'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId', 'subject'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'interfaces', 'possibleTypes', 'ofType', 'specifiedByURL'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Directive: ['name', 'description', 'locations', 'args', 'isRepeatable'],
};

const SEARCH_TYPE_VALUES = [
  'ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'WIKI',
  'PULL_REQUEST', 'PACKAGE', 'APP', 'ORGANIZATION',
];

// -------------------------------------------------------------------------------------------
// lexer
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$=![]@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      const text = input.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < input.length && isNameChar(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// -------------------------------------------------------------------------------------------
// parser
// -------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ name: string; value: ValueNode }>;
  readonly selection: SelectionNode[] | null;
}

export interface FragmentNode {
  readonly kind: 'fragment';
  readonly typeCondition: string | null;
  readonly selection: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface OperationNode {
  readonly kind: 'operation';
  readonly operation: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: string[];
  readonly selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value} in GraphQL document`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          kind: 'operation',
          operation: 'query',
          name: null,
          variables: [],
          selection: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = token.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        const next = this.peek();
        if (next.kind === 'name') name = this.next().value as string;
        const variables: string[] = [];
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
          this.next();
          while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
            if (this.peek().kind === 'eof') throw new Error('unterminated variable definitions');
            if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '$') {
              this.next();
              variables.push(this.expectName());
            } else {
              this.next();
            }
          }
          this.expectPunct(')');
        }
        operations.push({ kind: 'operation', operation, name, variables, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        // Fragments are parsed and skipped: the suite's documents do not use them.
        this.next();
        this.expectName();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          this.expectName();
        }
        this.parseSelectionSet();
        continue;
      }
      throw new Error(`unexpected token in GraphQL document: ${JSON.stringify(token)}`);
    }
    return operations;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        this.next(); // named fragment spread: no fragments are defined, so it selects nothing
        return { kind: 'fragment', typeCondition: null, selection: [] };
      }
      return { kind: 'fragment', typeCondition: null, selection: this.parseSelectionSet() };
    }
    const name = this.expectName();
    let alias: string | null = null;
    let fieldName = name;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = name;
      fieldName = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        if (this.peek().kind === 'eof') throw new Error('unterminated arguments');
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives (@...) are skipped.
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'eof') throw new Error('unterminated directive');
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name: fieldName, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        if (this.peek().kind === 'eof') throw new Error('unterminated list');
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        if (this.peek().kind === 'eof') throw new Error('unterminated object');
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

function isNodeValue(value: unknown): value is NodeValue {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { __typename?: unknown }).__typename === 'string'
  );
}

export interface GraphQLError {
  message: string;
  path?: Array<string | number>;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors: GraphQLError[];
}

type NodeValue =
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'User'; login: string; id: number }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'IssueComment'; repo: Repo; issueNumber: number; commentId: number; body: string }
  | { __typename: 'IssueConnection'; nodes: NodeValue[]; pageInfo: PageInfo; totalCount: number }
  | { __typename: 'PullRequestConnection'; nodes: NodeValue[]; pageInfo: PageInfo; totalCount: number }
  | { __typename: 'PullRequestChangedFileConnection'; nodes: NodeValue[]; pageInfo: PageInfo; totalCount: number }
  | { __typename: 'PullRequestChangedFile'; path: string; additions: number; deletions: number }
  | { __typename: 'Label'; name: string; color: string }
  | { __typename: 'IssueEdge'; node: NodeValue; cursor: string }
  | { __typename: 'PullRequestEdge'; node: NodeValue; cursor: string }
  | { __typename: 'PullRequestChangedFileEdge'; node: NodeValue; cursor: string }
  | { __typename: 'IssueCommentEdge'; node: NodeValue; cursor: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __typename: 'CreateIssuePayload'; issue: NodeValue | null }
  | { __typename: 'CloseIssuePayload'; issue: NodeValue | null }
  | { __typename: 'CreatePullRequestPayload'; pullRequest: NodeValue | null }
  | { __typename: 'MergePullRequestPayload'; pullRequest: NodeValue | null }
  | { __typename: 'AddCommentPayload'; commentEdge: NodeValue | null; subject: NodeValue | null }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Schema'; name: string };

interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface GraphQLContext {
  store: Store;
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => valueOf(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const num = Number(text.slice('cursor:'.length));
    return Number.isInteger(num) ? num : null;
  } catch {
    return null;
  }
}

export class GraphQLExecutor {
  private readonly ctx: GraphQLContext;
  constructor(ctx: GraphQLContext) { this.ctx = ctx; }

  execute(document: string, variables: Record<string, unknown>, operationName?: string): GraphQLResult {
    let operations: OperationNode[];
    try {
      operations = new Parser(lex(document)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    if (operations.length === 0) {
      return { data: null, errors: [{ message: 'No operation in document' }] };
    }
    let operation = operations[0];
    if (operationName !== undefined) {
      const named = operations.find((candidate) => candidate.name === operationName);
      if (named) operation = named;
    }
    const errors: GraphQLError[] = [];
    const data: Record<string, unknown> = {};
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    for (const selection of operation.selection) {
      this.executeSelection(selection, rootType, null, data, variables, errors, []);
    }
    return { data, errors };
  }

  private executeSelection(
    selection: SelectionNode,
    parentType: string,
    parent: NodeValue | Record<string, unknown> | null,
    out: Record<string, unknown>,
    variables: Record<string, unknown>,
    errors: GraphQLError[],
    path: Array<string | number>,
  ): void {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && parent !== null && !isNodeValue(parent)) return;
      if (selection.typeCondition !== null && parent !== null && isNodeValue(parent) && parent.__typename !== selection.typeCondition) return;
      for (const child of selection.selection) {
        this.executeSelection(child, parentType, parent, out, variables, errors, path);
      }
      return;
    }
    const field = selection;
    const responseKey = field.alias ?? field.name;
    const fieldPath = [...path, responseKey];
    // Plain objects (introspection entries like {name}) resolve by property lookup.
    if (parent !== null && !isNodeValue(parent)) {
      const plain = parent as Record<string, unknown>;
      if (field.name === '__typename') {
        out[responseKey] = parentType;
        return;
      }
      const value = plain[field.name];
      if (value === undefined) {
        out[responseKey] = null;
        return;
      }
      if (field.selection === null || field.selection.length === 0) {
        out[responseKey] = value;
        return;
      }
      if (value === null) {
        out[responseKey] = null;
        return;
      }
      if (Array.isArray(value)) {
        out[responseKey] = value.map((item) =>
          item !== null && typeof item === 'object'
            ? this.resolveObject(item as NodeValue | Record<string, unknown>, field.selection!, variables, errors, fieldPath)
            : item,
        );
        return;
      }
      if (typeof value === 'object') {
        out[responseKey] = this.resolveObject(value as NodeValue | Record<string, unknown>, field.selection, variables, errors, fieldPath);
        return;
      }
      out[responseKey] = value;
      return;
    }
    if (field.name === '__typename') {
      out[responseKey] = parent === null ? (parentType === 'Query' ? 'Query' : 'Mutation') : (parent as NodeValue).__typename;
      return;
    }
    const knownFields = SCHEMA_FIELDS[parentType] ?? [];
    if (!knownFields.includes(field.name)) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".`, path: fieldPath });
      return;
    }
    let value: unknown;
    try {
      value = this.resolveField(parentType, parent, field, variables);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[responseKey] = null;
      return;
    }
    if (value === undefined) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".`, path: fieldPath });
      return;
    }
    if (field.selection === null || field.selection.length === 0) {
      out[responseKey] = scalarOf(value);
      return;
    }
    if (value === null) {
      out[responseKey] = null;
      return;
    }
    if (Array.isArray(value)) {
      out[responseKey] = value.map((item) => this.resolveObject(item as NodeValue, field.selection!, variables, errors, fieldPath));
      return;
    }
    out[responseKey] = this.resolveObject(value as NodeValue, field.selection, variables, errors, fieldPath);
  }

  private resolveObject(
    value: NodeValue | Record<string, unknown>,
    selections: SelectionNode[],
    variables: Record<string, unknown>,
    errors: GraphQLError[],
    path: Array<string | number>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const parentType = isNodeValue(value) ? value.__typename : '__Plain';
    for (const selection of selections) {
      this.executeSelection(selection, parentType, value, out, variables, errors, path);
    }
    return out;
  }

  private resolveField(
    parentType: string,
    parent: NodeValue | null,
    field: FieldNode,
    variables: Record<string, unknown>,
  ): unknown {
    const store = this.ctx.store;
    const args = argsOf(field, variables);
    if (parent === null) {
      if (parentType === 'Query') return this.resolveQuery(field, args);
      return this.resolveMutation(field, args);
    }
    switch (parent.__typename) {
      case 'Repository':
        return this.resolveRepository(parent.repo, field, args);
      case 'Issue':
        return this.resolveIssue(parent.repo, parent.issue, field, args);
      case 'PullRequest':
        return this.resolvePullRequest(parent.repo, parent.pull, field, args);
      case 'User': {
        if (field.name === 'login') return parent.login;
        if (field.name === 'id') return parent.id;
        if (field.name === 'name') return VIEWER.name;
        if (field.name === 'email') return VIEWER.email;
        return undefined;
      }
      case 'Ref': {
        if (field.name === 'name') return parent.name;
        return undefined;
      }
      case 'IssueComment': {
        if (field.name === 'id') return globalId('C', parent.repo.id, parent.commentId);
        if (field.name === 'body') return parent.body;
        if (field.name === 'author') return { __typename: 'User', login: VIEWER.login, id: VIEWER.id } as NodeValue;
        return undefined;
      }
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'PullRequestChangedFileConnection': {
        if (field.name === 'nodes') return parent.nodes;
        if (field.name === 'totalCount') return parent.totalCount;
        if (field.name === 'pageInfo') {
          return { __typename: 'PageInfo', ...parent.pageInfo } as NodeValue;
        }
        if (field.name === 'edges') {
          return parent.nodes.map((node) => {
            const cursor = cursorOf(node);
            const edgeType =
              parent.__typename === 'IssueConnection'
                ? 'IssueEdge'
                : parent.__typename === 'PullRequestConnection'
                  ? 'PullRequestEdge'
                  : 'PullRequestChangedFileEdge';
            return { __typename: edgeType, node, cursor } as NodeValue;
          });
        }
        return undefined;
      }
      case 'PageInfo': {
        if (field.name === 'hasNextPage') return parent.hasNextPage;
        if (field.name === 'hasPreviousPage') return parent.hasPreviousPage;
        if (field.name === 'startCursor') return parent.startCursor;
        if (field.name === 'endCursor') return parent.endCursor;
        return undefined;
      }
      case 'IssueEdge':
      case 'PullRequestEdge':
      case 'PullRequestChangedFileEdge':
      case 'IssueCommentEdge': {
        if (field.name === 'node') return parent.node;
        if (field.name === 'cursor') return parent.cursor;
        return undefined;
      }
      case 'PullRequestChangedFile': {
        if (field.name === 'path') return parent.path;
        if (field.name === 'filename') return parent.path;
        if (field.name === 'additions') return parent.additions;
        if (field.name === 'deletions') return parent.deletions;
        return undefined;
      }
      case 'Label': {
        if (field.name === 'name') return parent.name;
        if (field.name === 'color') return parent.color;
        if (field.name === 'id') return `label:${parent.name}`;
        return undefined;
      }
      case 'CreateIssuePayload':
      case 'CloseIssuePayload': {
        if (field.name === 'issue') return parent.issue;
        return undefined;
      }
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload': {
        if (field.name === 'pullRequest') return parent.pullRequest;
        return undefined;
      }
      case 'AddCommentPayload': {
        if (field.name === 'commentEdge') return parent.commentEdge;
        if (field.name === 'comment') return parent.commentEdge === null ? null : (parent.commentEdge as { node: NodeValue }).node;
        if (field.name === 'subject') return parent.subject;
        return undefined;
      }
      case '__Type': {
        if (field.name === 'name') return parent.name;
        if (field.name === 'kind') {
          if (parent.name === 'SearchType') return 'ENUM';
          if (parent.name === 'String' || parent.name === 'Int' || parent.name === 'Float' || parent.name === 'Boolean' || parent.name === 'ID') return 'SCALAR';
          return 'OBJECT';
        }
        if (field.name === 'description') return null;
        if (field.name === 'fields') {
          const names = SCHEMA_FIELDS[parent.name] ?? [];
          return names.map((name) => ({ name }));
        }
        if (field.name === 'enumValues') {
          if (parent.name === 'SearchType') return SEARCH_TYPE_VALUES.map((name) => ({ name }));
          return [];
        }
        if (field.name === 'interfaces') return [];
        if (field.name === 'possibleTypes') return null;
        if (field.name === 'ofType') return null;
        if (field.name === 'specifiedByURL') return null;
        return undefined;
      }
      case '__Schema': {
        if (field.name === 'types') {
          return Object.keys(SCHEMA_FIELDS).map((name) => ({ name }));
        }
        if (field.name === 'queryType') return { name: 'Query' };
        if (field.name === 'mutationType') return { name: 'Mutation' };
        if (field.name === 'subscriptionType') return null;
        if (field.name === 'directives') return [];
        return undefined;
      }
      default:
        return undefined;
    }
  }

  private resolveQuery(field: FieldNode, args: Record<string, unknown>): unknown {
    const store = this.ctx.store;
    if (field.name === 'viewer') {
      return { __typename: 'User', login: VIEWER.login, id: VIEWER.id } as NodeValue;
    }
    if (field.name === 'repository') {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = store.getRepo(owner, name);
      if (!repo) return null;
      return { __typename: 'Repository', repo } as NodeValue;
    }
    if (field.name === 'node') {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      const repo = store.getRepoById(decoded.repoId);
      if (!repo) return null;
      if (decoded.kind === 'R') return { __typename: 'Repository', repo } as NodeValue;
      if (decoded.kind === 'I') {
        const issue = repo.issues.get(decoded.num);
        if (!issue) return null;
        return { __typename: 'Issue', repo, issue } as NodeValue;
      }
      if (decoded.kind === 'P') {
        const pull = repo.pulls.get(decoded.num);
        if (!pull) return null;
        return { __typename: 'PullRequest', repo, pull } as NodeValue;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = args.name;
      if (typeof name !== 'string') return null;
      if (!(name in SCHEMA_FIELDS) && name !== 'SearchType') return null;
      return { __typename: '__Type', name } as NodeValue;
    }
    if (field.name === '__schema') {
      return { __typename: '__Schema', name: '__Schema' } as NodeValue;
    }
    return undefined;
  }

  private resolveMutation(field: FieldNode, args: Record<string, unknown>): unknown {
    const store = this.ctx.store;
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (field.name === 'createIssue') {
      const repoId = decodeGlobalId(String(input.repositoryId ?? '') ?? '');
      const repo = repoId && repoId.kind === 'R' ? store.getRepoById(repoId.repoId) : null;
      if (!repo) throw new Error('createIssue: repository not found');
      const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } as NodeValue } as NodeValue;
    }
    if (field.name === 'closeIssue') {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      const repo = decoded && decoded.kind === 'I' ? store.getRepoById(decoded.repoId) : null;
      const issue = repo ? repo.issues.get(decoded!.num) : undefined;
      if (!repo || !issue) throw new Error('closeIssue: issue not found');
      store.patchIssue(repo, issue.number, { state: 'closed' });
      return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo, issue } as NodeValue } as NodeValue;
    }
    if (field.name === 'createPullRequest') {
      const repoId = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = repoId && repoId.kind === 'R' ? store.getRepoById(repoId.repoId) : null;
      if (!repo) throw new Error('createPullRequest: repository not found');
      const pull = store.createPull(
        repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } as NodeValue } as NodeValue;
    }
    if (field.name === 'mergePullRequest') {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      const repo = decoded && decoded.kind === 'P' ? store.getRepoById(decoded.repoId) : null;
      const pull = repo ? repo.pulls.get(decoded!.num) : undefined;
      if (!repo || !pull) throw new Error('mergePullRequest: pull request not found');
      store.mergePull(repo, pull);
      return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } as NodeValue } as NodeValue;
    }
    if (field.name === 'addComment') {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      const repo = decoded && decoded.kind === 'I' ? store.getRepoById(decoded.repoId) : null;
      const issue = repo ? repo.issues.get(decoded!.num) : undefined;
      if (!repo || !issue) throw new Error('addComment: subject not found');
      const comment = store.addComment(repo, issue.number, String(input.body ?? ''));
      const node: NodeValue = {
        __typename: 'IssueComment',
        repo,
        issueNumber: issue.number,
        commentId: comment.id,
        body: comment.body,
      };
      const edge: NodeValue = { __typename: 'IssueCommentEdge', node, cursor: encodeCursor(comment.id) };
      return { __typename: 'AddCommentPayload', commentEdge: edge, subject: { __typename: 'Issue', repo, issue } as NodeValue } as NodeValue;
    }
    return undefined;
  }

  private resolveRepository(repo: Repo, field: FieldNode, args: Record<string, unknown>): unknown {
    const store = this.ctx.store;
    switch (field.name) {
      case 'id':
        return globalId('R', repo.id, 0);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return { __typename: 'User', login: repo.owner, id: VIEWER.id } as NodeValue;
      case 'description':
        return repo.description;
      case 'private':
        return repo.isPrivate;
      case 'defaultBranchRef': {
        const tip = store.defaultBranchTip(repo);
        if (tip === null) return null;
        return { __typename: 'Ref', name: repo.defaultBranch } as NodeValue;
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'createdAt':
        return repo.createdAt;
      case 'updatedAt':
        return repo.updatedAt;
      case 'url':
        return `/${repo.owner}/${repo.name}`;
      case 'issue': {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const issue = repo.issues.get(number);
        if (!issue) return null;
        return { __typename: 'Issue', repo, issue } as NodeValue;
      }
      case 'issues': {
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const direction = orderBy.direction === 'ASC' ? 'asc' : orderBy.direction === 'DESC' ? 'desc' : 'asc';
        let list = [...repo.issues.values()];
        if (states !== null) {
          const wanted = new Set(states.map((state) => String(state).toLowerCase()));
          list = list.filter((issue) => wanted.has(issue.state));
        }
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        return paginateIssues(repo, list, args);
      }
      case 'pullRequest': {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const pull = repo.pulls.get(number);
        if (!pull) return null;
        return { __typename: 'PullRequest', repo, pull } as NodeValue;
      }
      case 'pullRequests': {
        const first = typeof args.first === 'number' ? args.first : 30;
        const list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
        const nodes: NodeValue[] = list.slice(0, Math.max(0, first)).map((pull) => ({ __typename: 'PullRequest', repo, pull }) as NodeValue);
        return {
          __typename: 'PullRequestConnection',
          nodes,
          totalCount: list.length,
          pageInfo: { hasNextPage: list.length > nodes.length, hasPreviousPage: false, startCursor: nodes.length ? encodeCursor(nodes[0].number) : null, endCursor: nodes.length ? encodeCursor(nodes[nodes.length - 1].number) : null },
        } as NodeValue;
      }
      default:
        return undefined;
    }
  }

  private resolveIssue(repo: Repo, issue: Issue, field: FieldNode, _args: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'id':
        return globalId('I', repo.id, issue.number);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      case 'author':
        return { __typename: 'User', login: VIEWER.login, id: VIEWER.id } as NodeValue;
      case 'labels':
        return issue.labels.map((name) => ({ __typename: 'Label', name, color: repo.labels.get(name)?.color ?? 'ededed' }) as NodeValue);
      case 'url':
        return `/${repo.owner}/${repo.name}/issues/${issue.number}`;
      default:
        return undefined;
    }
  }

  private resolvePullRequest(repo: Repo, pull: Pull, field: FieldNode, args: Record<string, unknown>): unknown {
    const store = this.ctx.store;
    switch (field.name) {
      case 'id':
        return globalId('P', repo.id, pull.number);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'headRefName':
        return pull.head;
      case 'baseRefName':
        return pull.base;
      case 'headRef':
        return { __typename: 'Ref', name: pull.head } as NodeValue;
      case 'baseRef':
        return { __typename: 'Ref', name: pull.base } as NodeValue;
      case 'mergeable':
        return store.pullMergeable(repo, pull);
      case 'merged':
        return pull.merged;
      case 'mergedAt':
        return pull.mergedAt;
      case 'mergeCommitSha':
        return pull.mergeCommitSha;
      case 'createdAt':
        return pull.createdAt;
      case 'updatedAt':
        return pull.updatedAt;
      case 'author':
        return { __typename: 'User', login: VIEWER.login, id: VIEWER.id } as NodeValue;
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 30;
        const files = store.pullFiles(repo, pull);
        const nodes: NodeValue[] = files.slice(0, Math.max(0, first)).map((file) => ({
          __typename: 'PullRequestChangedFile',
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
        }) as NodeValue);
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes,
          totalCount: files.length,
          pageInfo: { hasNextPage: files.length > nodes.length, hasPreviousPage: false, startCursor: null, endCursor: null },
        } as NodeValue;
      }
      default:
        return undefined;
    }
  }
}

function cursorOf(node: NodeValue): string {
  if (node.__typename === 'Issue') return encodeCursor(node.issue.number);
  if (node.__typename === 'PullRequest') return encodeCursor(node.pull.number);
  if (node.__typename === 'PullRequestChangedFile') return encodeCursor(0);
  return encodeCursor(0);
}

function paginateIssues(repo: Repo, ordered: Issue[], args: Record<string, unknown>): NodeValue {
  const first = typeof args.first === 'number' ? args.first : 30;
  const afterNum = decodeCursor(args.after);
  let start = 0;
  if (afterNum !== null) {
    const index = ordered.findIndex((issue) => issue.number === afterNum);
    if (index >= 0) start = index + 1;
  }
  const slice = ordered.slice(start, start + Math.max(0, first));
  const nodes: NodeValue[] = slice.map((issue) => ({ __typename: 'Issue', repo, issue }) as NodeValue);
  const hasNextPage = start + slice.length < ordered.length;
  return {
    __typename: 'IssueConnection',
    nodes,
    totalCount: ordered.length,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: nodes.length ? encodeCursor(slice[0].number) : null,
      endCursor: nodes.length ? encodeCursor(slice[slice.length - 1].number) : null,
    },
  } as NodeValue;
}

/** A resolved scalar: nodes pass through, everything else is returned as-is. */
function scalarOf(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    return value;
  }
  return value;
}

export { isoFromEpoch };
