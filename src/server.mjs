#!/usr/bin/env node
/**
 * Minimal MCP server exposing OpenViking retrieval.
 *
 * Design choices, deliberate:
 * - Read-only. No tool can add, modify, or delete OpenViking content, so an
 *   agent cannot silently turn captured conversation into "knowledge".
 * - No automatic capture. Nothing is written back unless a user asks the
 *   OpenViking CLI/API directly.
 * - No bundled memory plugin. Context injection and session capture are the
 *   official plugin's job; this server deliberately omits them.
 *
 * Transport: stdio (the form every MCP client supports).
 * Config: environment only, so no credential or path is committed.
 */

import { createInterface } from 'node:readline';

const SERVER_NAME = 'openviking-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2025-03-26';

const DEFAULT_BASE_URL = 'http://127.0.0.1:1933';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 20_000;

function config() {
  const baseUrl = (process.env.OPENVIKING_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutRaw = Number(process.env.OPENVIKING_TIMEOUT_MS);
  return {
    baseUrl,
    apiKey: process.env.OPENVIKING_API_KEY || '',
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS,
  };
}

/** Walk the cause chain (fetch wraps failures, sometimes in AggregateError). */
function collectCodes(error, seen = new Set()) {
  const codes = new Set();
  if (!error || typeof error !== 'object' || seen.has(error)) return codes;
  seen.add(error);
  if (typeof error.code === 'string') codes.add(error.code);
  if (Array.isArray(error.errors)) {
    for (const inner of error.errors) {
      for (const code of collectCodes(inner, seen)) codes.add(code);
    }
  }
  for (const code of collectCodes(error.cause, seen)) codes.add(code);
  return codes;
}

/** Collect cause-chain messages from shallowest to deepest. */
function collectMessages(error, seen = new Set()) {
  const messages = [];
  if (!error || typeof error !== 'object' || seen.has(error)) return messages;
  seen.add(error);
  if (typeof error.message === 'string') messages.push(error.message);
  if (Array.isArray(error.errors)) {
    for (const inner of error.errors) messages.push(...collectMessages(inner, seen));
  }
  messages.push(...collectMessages(error.cause, seen));
  return messages;
}

function describeError(error) {
  const codes = collectCodes(error);
  if (codes.has('ECONNREFUSED')) {
    return 'OpenViking server is not running or not reachable on the configured URL.';
  }
  if (codes.has('ENOTFOUND')) return 'OpenViking host could not be resolved.';
  if (codes.has('ETIMEDOUT') || error?.name === 'TimeoutError') return 'OpenViking request timed out.';
  if (error?.name === 'AbortError') return 'OpenViking request was aborted.';
  // fetch rejects blocked/privileged ports before any connection attempt.
  const messages = collectMessages(error);
  if (messages.some((text) => /bad port/i.test(text))) {
    return 'OPENVIKING_URL uses a port the runtime refuses to connect to; use the real OpenViking port.';
  }
  // Never surface a bare "fetch failed": it hides the real cause from the caller.
  const detail = [...codes].join(', ');
  if (detail) return `OpenViking request failed (${detail}).`;
  const deepest = messages.pop();
  return deepest || 'OpenViking request failed.';
}

async function request(path, { method = 'POST', body, query } = {}) {
  const cfg = config();
  const url = new URL(cfg.baseUrl + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cfg.apiKey) headers['X-API-Key'] = cfg.apiKey;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (error) {
    throw new Error(describeError(error));
  }

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const message = payload?.error?.message ?? payload?.detail ?? `HTTP ${response.status}`;
    throw new Error(`OpenViking ${method} ${path} failed: ${message}`);
  }
  return payload;
}

function clip(value, limit = MAX_TEXT_CHARS) {
  if (typeof value !== 'string') return value;
  return value.length > limit ? `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} characters]` : value;
}

function normalizeHits(payload) {
  // OpenViking returns { status, result: { memories: [], resources: [] } }.
  // Flatten both buckets, and keep tolerating older flat shapes.
  const scopes = [payload?.result, payload].filter((scope) => scope && typeof scope === 'object');
  const collected = [];
  for (const scope of scopes) {
    for (const key of ['resources', 'memories', 'results', 'hits', 'items']) {
      const bucket = scope[key];
      if (Array.isArray(bucket)) collected.push(...bucket);
    }
    if (collected.length > 0) break;
  }
  return collected.map((hit) => {
    const uri = hit.uri ?? hit.path ?? hit.id ?? '';
    const score = hit.score ?? hit.relevance ?? null;
    const level = hit.level ?? hit.context_level ?? null;
    const summary = hit.abstract ?? hit.summary ?? hit.overview ?? hit.snippet ?? hit.text ?? '';
    return { uri, score, level, summary: clip(String(summary)) };
  });
}

function renderHits(query, hits) {
  if (hits.length === 0) {
    return `No OpenViking results for "${query}". Try broader wording, or import more resources.`;
  }
  const lines = [`OpenViking results for "${query}" (${hits.length}):`];
  hits.forEach((hit, index) => {
    const score = typeof hit.score === 'number' ? hit.score.toFixed(3) : 'n/a';
    const level = hit.level ? ` · L${hit.level}` : '';
    lines.push(`\n${index + 1}. ${hit.uri} (score ${score}${level})`);
    if (hit.summary) lines.push(`   ${hit.summary.split('\n').join('\n   ')}`);
  });
  return lines.join('\n');
}

const TOOLS = [
  {
    name: 'ov_search',
    description:
      'Search the OpenViking knowledge base by meaning. Returns matching documents with their URI, relevance score and a short summary. Use it before writing SQL, DDL or node changes to check for existing standards and known pitfalls.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in natural language.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 8, description: 'Maximum number of results.' },
        target_uri: {
          type: 'string',
          description: 'Optional subtree to search, e.g. viking://resources/knowledge. Empty searches everything.',
        },
        score_threshold: { type: 'number', minimum: 0, maximum: 1, description: 'Optional minimum relevance score.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'ov_read',
    description:
      'Read the full text of one OpenViking document by URI (L2 content). Use it after ov_search when a hit looks relevant and you need the complete section.',
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'A viking:// URI returned by ov_search.' },
      },
      required: ['uri'],
      additionalProperties: false,
    },
  },
  {
    name: 'ov_overview',
    description:
      'Inspect OpenViking directory structure with generated summaries (L0/L1). Use it to survey what knowledge exists before deciding what to search or read.',
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'Directory URI, defaults to the resources root.' },
        depth: { type: 'integer', minimum: 1, maximum: 4, default: 2, description: 'How many levels to show.' },
      },
      additionalProperties: false,
    },
  },
];

/** Render the fs/tree result (an array of entries) as indented text. */
function renderTree(node, depth = 0) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    return node.map((entry) => renderTree(entry, depth)).filter(Boolean).join('\n');
  }
  const indent = '  '.repeat(depth);
  const name = node.rel_path ?? node.uri ?? '';
  const isDir = node.isDir ?? node.is_dir ?? false;
  const lines = [];
  if (name) lines.push(`${indent}${isDir ? '[dir] ' : ''}${name}`);
  const abstract = node.abstract ?? node.summary ?? '';
  if (abstract) {
    for (const line of String(abstract).split('\n')) lines.push(`${indent}  ${line}`);
  }
  const children = node.children ?? node.entries ?? [];
  if (Array.isArray(children) && children.length > 0) {
    lines.push(renderTree(children, depth + 1));
  }
  return lines.filter(Boolean).join('\n');
}

async function callTool(name, args) {
  const cfg = config();
  if (name === 'ov_search') {
    const payload = await request('/api/v1/search/find', {
      body: {
        query: args.query,
        target_uri: args.target_uri ?? '',
        limit: args.limit ?? 8,
        ...(args.score_threshold === undefined ? {} : { score_threshold: args.score_threshold }),
      },
    });
    const hits = normalizeHits(payload);
    return { hits, text: renderHits(args.query, hits) };
  }

  if (name === 'ov_read') {
    if (!/^viking:\/\//.test(args.uri ?? '')) throw new Error('uri must start with viking://');
    const payload = await request('/api/v1/content/read', { method: 'GET', query: { uri: args.uri } });
    // OpenViking wraps every response as { status, result }. For content/read,
    // `result` is the document body itself (a string), not an object.
    const body = typeof payload?.result === 'string' ? payload.result : payload?.result ?? payload;
    const content =
      typeof body === 'string'
        ? body
        : body?.content ?? body?.text ?? body?.data ?? '';
    return { text: clip(typeof content === 'string' ? content : JSON.stringify(content)), uri: args.uri };
  }

  if (name === 'ov_overview') {
    const uri = args.uri ?? 'viking://resources';
    if (!/^viking:\/\//.test(uri)) throw new Error('uri must start with viking://');
    const payload = await request('/api/v1/fs/tree', {
      method: 'GET',
      query: { uri, level: args.depth ?? 2 },
    });
    const tree = payload?.result ?? payload;
    const text = renderTree(tree);
    return { text: clip(text, 30_000), base_url: cfg.baseUrl };
  }

  throw new Error(`unknown tool: ${name}`);
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        'Read-only OpenViking retrieval. Call ov_search before writing SQL, DDL or scheduler changes; use ov_read for the full document; ov_overview to survey the hierarchy.',
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return undefined;
  if (method === 'tools/list') {
    return ok(id, {
      tools: TOOLS.map((tool) => ({ ...tool, annotations: READ_ONLY_ANNOTATIONS })),
    });
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    try {
      const outcome = await callTool(name, args);
      return ok(id, {
        content: [{ type: 'text', text: outcome.text }],
        structuredContent: outcome,
        isError: false,
      });
    } catch (error) {
      return ok(id, {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      });
    }
  }
  if (method === 'ping') return ok(id, {});
  return fail(id, -32601, `method not found: ${method}`);
}

function main() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return fail(null, -32700, 'invalid JSON');
    }
    void handle(message).catch((error) => fail(message?.id ?? null, -32603, error.message));
  });
}

main();
