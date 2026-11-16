// mcp.ts — the Model Context Protocol tools over the same store the REST and
// GraphQL surfaces use. Tool names, descriptions and input schemas are fixed
// constants, so two tools/list answers are byte-identical.

import {
  VIEWER,
  issueJson,
  pullJson,
  repoJson,
  Store,
  StoreError,
  type Repo,
} from './store.ts';

export interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, Record<string, unknown>>>;
    readonly required: readonly string[];
    readonly additionalProperties: boolean;
  };
}

function tool(
  name: string,
  description: string,
  properties: Readonly<Record<string, Record<string, unknown>>>,
  required: readonly string[],
): McpToolDef {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  };
}

const str = (description: string): Record<string, unknown> => ({ type: 'string', description });
const bool = (description: string): Record<string, unknown> => ({ type: 'boolean', description });
const num = (description: string): Record<string, unknown> => ({ type: 'integer', description });
const strArray = (description: string): Record<string, unknown> => ({ type: 'array', items: { type: 'string' }, description });

export const MCP_TOOLS: readonly McpToolDef[] = Object.freeze([
  tool(
    'create_repo',
    'Create a new repository owned by the authenticated user.',
    {
      owner: str('The login of the repository owner.'),
      name: str('The name of the repository.'),
      description: str('A short description of the repository.'),
      private: bool('Whether the repository is private.'),
    },
    ['name'],
  ),
  tool(
    'get_repo',
    'Get one repository by owner and name.',
    {
      owner: str('The login of the repository owner.'),
      repo: str('The name of the repository.'),
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: str('The login of the repository owner.'),
      repo: str('The name of the repository.'),
      title: str('The title of the issue.'),
      body: str('The body of the issue.'),
      labels: strArray('Label names to attach; every label must already exist.'),
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List the issues of a repository.',
    {
      owner: str('The login of the repository owner.'),
      repo: str('The name of the repository.'),
      state: str('Filter by state: open, closed or all.'),
    },
    ['owner', 'repo'],
  ),
  tool(
    'get_issue',
    'Get one issue by number.',
    {
      owner: str('The login of the repository owner.'),
      repo: str('The name of the repository.'),
      issue_number: num('The issue number.'),
    },
    ['owner', 'repo', 'issue_number'],
  ),
  tool(
    'create_pull_request',
    'Open a pull request from a head branch into a base branch.',
    {
      owner: str('The login of the repository owner.'),
      repo: str('The name of the repository.'),
      title: str('The title of the pull request.'),
      body: str('The body of the pull request.'),
      head: str('The head branch name.'),
      base: str('The base branch name.'),
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'list_pull_requests',
    'List the pull requests of a repository.',
    {
      owner: str('The login of the repository owner.'),
      repo: str('The name of the repository.'),
      state: str('Filter by state: open, closed or all.'),
    },
    ['owner', 'repo'],
  ),
  tool(
    'merge_pull_request',
    'Squash-merge an open pull request.',
    {
      owner: str('The login of the repository owner.'),
      repo: str('The name of the repository.'),
      pull_number: num('The pull request number.'),
    },
    ['owner', 'repo', 'pull_number'],
  ),
]);

export class McpMissingArg extends Error {
  readonly arg: string;
  constructor(arg: string) {
    super(`Missing required argument: ${arg}`);
    this.arg = arg;
    this.name = 'McpMissingArg';
  }
}

function pick(args: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined) return args[name];
  }
  return undefined;
}

function reqString(args: Record<string, unknown>, names: readonly string[], label: string): string {
  const value = pick(args, names);
  if (typeof value !== 'string' || value === '') throw new McpMissingArg(label);
  return value;
}

function optString(args: Record<string, unknown>, names: readonly string[]): string {
  const value = pick(args, names);
  return typeof value === 'string' ? value : '';
}

function reqNumber(args: Record<string, unknown>, names: readonly string[], label: string): number {
  const value = pick(args, names);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  throw new McpMissingArg(label);
}

function resolveRepo(store: Store, args: Record<string, unknown>): Repo {
  const owner = optString(args, ['owner', 'owner_login', 'org', 'user_login', 'login']);
  const repoName = reqString(args, ['repo', 'repository', 'repo_name', 'repository_name'], 'repo');
  let name = repoName;
  let ownerLogin = owner === '' ? VIEWER.login : owner;
  const fullName = pick(args, ['full_name', 'repo_full_name', 'repository_full_name']);
  if (typeof fullName === 'string' && fullName.includes('/')) {
    const [o, r] = fullName.split('/', 2);
    ownerLogin = o;
    name = r;
  }
  const repo = store.getRepo(ownerLogin, name);
  if (!repo) throw new StoreError(404, `Repository ${ownerLogin}/${name} not found`);
  return repo;
}

export interface McpToolResult {
  readonly content: Array<{ type: 'text'; text: string }>;
  readonly structuredContent: unknown;
  readonly isError?: boolean;
}

function okResult(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function errorResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], structuredContent: { error: message }, isError: true };
}

/** Run one tool. Throws McpMissingArg when a required argument is absent. */
export function dispatchTool(store: Store, name: string, args: Record<string, unknown>): McpToolResult {
  const def = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!def) throw new McpMissingArg(`__unknown_tool__:${name}`);
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = reqString(args, ['name', 'repo', 'repository', 'repo_name'], 'name');
        const description = optString(args, ['description', 'about', 'summary', 'body']);
        const isPrivate = pick(args, ['private', 'is_private']) === true;
        const repo = store.createRepo(repoName, description, isPrivate);
        return okResult(repoJson(repo));
      }
      case 'get_repo': {
        const repo = resolveRepo(store, args);
        return okResult(repoJson(repo));
      }
      case 'create_issue': {
        const repo = resolveRepo(store, args);
        const title = reqString(args, ['title', 'issue_title', 'subject'], 'title');
        const body = optString(args, ['body', 'issue_body', 'description', 'content', 'text']);
        const labelsRaw = pick(args, ['labels']);
        const labels = Array.isArray(labelsRaw) ? labelsRaw.filter((entry): entry is string => typeof entry === 'string') : [];
        const issue = store.createIssue(repo, title, body, labels);
        return okResult(issueJson(repo, issue));
      }
      case 'list_issues': {
        const repo = resolveRepo(store, args);
        const state = optString(args, ['state', 'status']) || 'open';
        const issues = store.listIssues(repo, state, 'desc');
        return okResult({ issues: issues.map((issue) => issueJson(repo, issue)) });
      }
      case 'get_issue': {
        const repo = resolveRepo(store, args);
        const number = reqNumber(args, ['issue_number', 'number', 'index'], 'issue_number');
        const issue = repo.issues.get(number);
        if (!issue) throw new StoreError(404, `Issue #${number} not found`);
        return okResult(issueJson(repo, issue));
      }
      case 'create_pull_request': {
        const repo = resolveRepo(store, args);
        const title = reqString(args, ['title', 'pr_title', 'pull_request_title', 'subject'], 'title');
        const body = optString(args, ['body', 'description', 'content', 'text']);
        const head = reqString(args, ['head', 'head_ref', 'head_branch', 'source_branch', 'from_branch', 'branch'], 'head');
        const base = reqString(args, ['base', 'base_ref', 'base_branch', 'target_branch', 'into_branch'], 'base');
        const pull = store.createPull(repo, title, body, head, base);
        return okResult(pullJson(repo, pull, store));
      }
      case 'list_pull_requests': {
        const repo = resolveRepo(store, args);
        const state = optString(args, ['state', 'status']) || 'open';
        const pulls = store.listPulls(repo, state);
        return okResult({ pull_requests: pulls.map((pull) => pullJson(repo, pull, store)) });
      }
      case 'merge_pull_request': {
        const repo = resolveRepo(store, args);
        const number = reqNumber(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'index'], 'pull_number');
        const pull = repo.pulls.get(number);
        if (!pull) throw new StoreError(404, `Pull request #${number} not found`);
        const merged = store.mergePull(repo, pull);
        return okResult({ merged: true, sha: merged.sha, message: merged.message, pull_request: pullJson(repo, pull, store) });
      }
      default:
        throw new McpMissingArg(`__unknown_tool__:${name}`);
    }
  } catch (err) {
    if (err instanceof StoreError) return errorResult(err.message);
    throw err;
  }
}
