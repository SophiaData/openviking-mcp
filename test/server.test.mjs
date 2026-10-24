import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'src', 'server.mjs');

/** Talk to the server over stdio and collect responses by id. */
function startServer(env = {}) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const pending = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });
  let nextId = 0;
  return {
    child,
    send(method, params) {
      const id = ++nextId;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    stop() {
      child.kill();
    },
  };
}

test('initialize advertises the three read-only tools', async () => {
  const client = startServer();
  try {
    const init = await client.send('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    assert.equal(init.result.serverInfo.name, 'openviking-mcp');

    const list = await client.send('tools/list', {});
    const names = list.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['ov_overview', 'ov_read', 'ov_search']);
    for (const tool of list.result.tools) {
      assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} must be read-only`);
      assert.equal(tool.annotations.destructiveHint, false);
    }
  } finally {
    client.stop();
  }
});

test('search against an unreachable server reports an explicit error', async () => {
  // A high, unlistened port produces a real ECONNREFUSED. Port 1 would instead
  // be rejected by fetch as a "bad port", which is a different failure mode.
  const client = startServer({ OPENVIKING_URL: 'http://127.0.0.1:19399', OPENVIKING_TIMEOUT_MS: '3000' });
  try {
    await client.send('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    const response = await client.send('tools/call', {
      name: 'ov_search',
      arguments: { query: 'anything' },
    });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /not running or not reachable/);
  } finally {
    client.stop();
  }
});

test('read rejects a non-viking URI without contacting the server', async () => {
  const client = startServer();
  try {
    await client.send('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    const response = await client.send('tools/call', {
      name: 'ov_read',
      arguments: { uri: 'file:///etc/passwd' },
    });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /must start with viking:\/\//);
  } finally {
    client.stop();
  }
});
