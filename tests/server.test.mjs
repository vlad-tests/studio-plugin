import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { checkStudio, diagnose, handleLine, serve, studioPath } from '../plugins/roblox-studio/server.mjs';

const plugin = resolve('plugins/roblox-studio');
const runner = resolve('tests/fixtures/runner.mjs');
const request = (method, params, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const parse = line => JSON.parse(line);
const call = request('tools/call', { name: 'diagnose_roblox_studio', arguments: {} });
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'studio-plugin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function withEnv(overrides) {
  const env = { ...process.env };
  // Windows environment names are case-insensitive, even when the source
  // object contains both PATH/Path or SystemRoot/SYSTEMROOT.
  for (const key of Object.keys(overrides)) {
    for (const existing of Object.keys(env)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
    }
    env[key] = overrides[key];
  }
  return env;
}
function execute(path, input, env = {}) {
  return spawnSync(process.execPath, [runner, path], {
    input, timeout: 10000, maxBuffer: 1024 * 1024,
    env: withEnv({ PATH: '', ...env }),
  });
}

test('checks the exact macOS and Windows locations', () => {
  assert.equal(studioPath('darwin', {}), '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP');
  assert.equal(studioPath('win32', { LOCALAPPDATA: 'C:\\Users\\Test User\\AppData\\Local' }), 'C:\\Users\\Test User\\AppData\\Local\\Roblox\\StudioMCP.bat');
  assert.throws(() => studioPath('win32', {}), /LOCALAPPDATA is unset/);
  assert.throws(() => studioPath('linux', {}), /supported on macOS and Windows/);
});

test('missing installation serves a complete MCP conversation with exactly one tool', t => {
  const path = join(temporary(t), 'missing', 'StudioMCP');
  const input = [
    request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    request('tools/list', undefined, 'tools'), call, request('ping'),
  ].join('\r\n');
  const result = execute(path, input);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stderr.toString(), '');
  const responses = result.stdout.toString().trim().split('\n').map(parse);
  assert.equal(responses.length, 4);
  assert.equal(responses[0].result.protocolVersion, '2025-06-18');
  assert.equal(responses[1].id, 'tools');
  assert.deepEqual(responses[1].result.tools.map(t => t.name), ['diagnose_roblox_studio']);
  for (const text of [path, 'https://create.roblox.com/docs/studio/setup', 'log into', 'Assistant settings', 'restart ChatGPT']) {
    assert.ok(responses[2].result.content[0].text.includes(text), text);
  }
});

test('validates requests, ignores notifications, and preserves large numeric IDs', () => {
  for (const [input, code] of [
    ['{', -32700], ['[]', -32600], ['null', -32600],
    [JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'ping' }), -32600],
    [request('ping', undefined, true), -32600],
    [request('unknown'), -32601], [request('initialize'), -32602],
    [request('tools/call', { name: 'other' }), -32602],
    [request('tools/call', { name: 'diagnose_roblox_studio', arguments: { x: 1 } }), -32602],
    [request('tools/call', { name: 'diagnose_roblox_studio', arguments: null }), -32602],
  ]) assert.equal(parse(handleLine(input, () => '')).error.code, code, input);
  assert.equal(handleLine('{"jsonrpc":"2.0","method":"notifications/cancelled"}', () => ''), null);
  assert.match(handleLine('{"jsonrpc":"2.0","id":9007199254740993,"method":"ping"}', () => ''), /"id":9007199254740993/);
});

test('negotiates supported and unknown protocol versions', () => {
  for (const protocol of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', '2099-01-01']) {
    const response = parse(handleLine(request('initialize', { protocolVersion: protocol }), () => ''));
    assert.equal(response.result.protocolVersion, protocol === '2099-01-01' ? '2025-11-25' : protocol);
  }
});

test('diagnosis rechecks newly installed files and rejects directories', t => {
  const dir = temporary(t);
  assert.throws(() => checkStudio(dir), /non-regular file/);
  const path = join(dir, 'StudioMCP');
  assert.match(diagnose(path, 'initial issue'), /not found/);
  writeFileSync(path, 'fixture');
  assert.match(diagnose(path, 'initial issue'), /present now/);
});

test('handles split UTF-8, CRLF, multiple messages, and a final line without newline', async () => {
  const input = Buffer.from(request('ping', undefined, 'café') + '\r\n' + request('ping'));
  const chunks = Array.from(input, byte => Buffer.from([byte]));
  let output = '';
  await serve(Readable.from(chunks), new Writable({ write(chunk, _, done) { output += chunk; done(); } }), () => '');
  assert.deepEqual(output.trim().split('\n').map(parse).map(r => r.id), ['café', 1]);
});

test('limits oversized fallback requests', async () => {
  await assert.rejects(serve(Readable.from([Buffer.alloc(4 * 1024 * 1024 + 1, 65)]), new Writable(), () => ''), /exceeds 4 MiB/);
});

function echoFixture(t) {
  const dir = join(temporary(t), 'Studio MCP & 100% ! (test) café');
  mkdirSync(dir);
  const path = join(dir, process.platform === 'win32' ? 'StudioMCP.bat' : 'StudioMCP');
  writeFileSync(path, process.platform === 'win32'
    ? '@echo off\r\n"%STUDIO_TEST_NODE%" "%STUDIO_TEST_ECHO%"\r\n'
    : '#!/bin/sh\nexec "$STUDIO_TEST_NODE" "$STUDIO_TEST_ECHO"\n', { mode: 0o755 });
  return { path, env: { STUDIO_TEST_NODE: process.execPath, STUDIO_TEST_ECHO: resolve('tests/fixtures/echo.mjs') } };
}

test('handoff preserves arbitrary bytes, stderr, EOF, and nonzero exit status', t => {
  const { path, env } = echoFixture(t);
  const payload = Buffer.concat(Array.from({ length: 5000 }, () => Buffer.from([0, 255, 13, 10, 65])));
  const result = execute(path, payload, env);
  assert.equal(result.status, 23, result.stderr.toString());
  assert.deepEqual(result.stdout, payload);
  assert.equal(result.stderr.toString(), 'fixture stderr\n');
});

test('launch failure falls back without consuming the first MCP request', t => {
  const path = join(temporary(t), 'StudioMCP');
  writeFileSync(path, 'not executable', { mode: 0o644 });
  const result = execute(path, call, process.platform === 'win32' ? { SystemRoot: '' } : {});
  assert.equal(result.status, 0, result.stderr.toString());
  assert.match(parse(result.stdout).result.content[0].text, /could not be started/);
});

test('forwards termination and preserves the child signal on macOS', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const { path, env } = echoFixture(t);
  const child = spawn(process.execPath, [runner, path], { env: { ...process.env, ...env } });
  t.after(() => child.kill());
  const exit = once(child, 'exit');
  await once(child.stderr, 'data');
  child.kill('SIGTERM');
  assert.deepEqual(await exit, [null, 'SIGTERM']);
});

function launchPlugin(t, runtime) {
  const dir = join(temporary(t), 'Plugin & 100% ! (test) café');
  cpSync(plugin, dir, { recursive: true });
  // Exercise the real launcher in an isolated package, without depending on
  // whether Studio happens to be installed on the developer/CI machine.
  writeFileSync(join(dir, 'server.mjs'), 'console.log(JSON.stringify({runtime:process.execPath}));');
  const config = JSON.parse(readFileSync(join(dir, '.mcp.json'))).mcpServers['roblox-studio'];
  assert.ok(config.env_vars.includes('CODEX_MCP_NODE_PATH'));
  const env = withEnv({ PATH: '', CODEX_MCP_NODE_PATH: runtime });
  if (process.platform === 'win32') {
    return spawnSync(join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/s', '/v:off', '/c', '""%STUDIO_TEST_LAUNCHER%""'], {
      cwd: dir, env: { ...env, STUDIO_TEST_LAUNCHER: resolve(dir, config.command + '.cmd') },
      windowsVerbatimArguments: true, encoding: 'utf8', timeout: 10000,
    });
  }
  return spawnSync(config.command, config.args, { cwd: dir, env, encoding: 'utf8', timeout: 10000 });
}

test('manifest launcher uses the provided runtime with no node on PATH', t => {
  const result = launchPlugin(t, process.execPath);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parse(result.stdout).runtime, process.execPath);
});

test('missing bundled runtime fails clearly on stderr without stdout noise', t => {
  const result = launchPlugin(t, '');
  assert.equal(result.status, 127, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Update or restart ChatGPT/);
});
