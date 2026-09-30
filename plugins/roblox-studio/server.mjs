import { spawn } from 'node:child_process';
import { statSync, readFileSync } from 'node:fs';
import { win32, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { version } = JSON.parse(readFileSync(new URL('./.codex-plugin/plugin.json', import.meta.url), 'utf8'));
const setupURL = 'https://create.roblox.com/docs/studio/setup';
const toolName = 'diagnose_roblox_studio';
const protocols = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function studioPath(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP';
  if (platform === 'win32') {
    if (!env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is unset; cannot locate %LOCALAPPDATA%\\Roblox\\StudioMCP.bat');
    return win32.join(env.LOCALAPPDATA, 'Roblox', 'StudioMCP.bat');
  }
  throw new Error(`Roblox Studio is supported on macOS and Windows; this computer runs ${platform}`);
}

export function checkStudio(path) {
  let info;
  try {
    info = statSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`StudioMCP was not found at ${path}. Studio may be missing, outdated, or installed somewhere else.`);
    }
    throw new Error(`Cannot access StudioMCP at ${path}: ${error.message}`);
  }
  if (!info.isFile()) throw new Error(`Expected a StudioMCP file at ${path}, but found a non-regular file.`);
}

export function diagnose(path, startupIssue) {
  let status = startupIssue;
  if (path) {
    try {
      checkStudio(path);
      status += '\n\nStudioMCP is present now. Restart this plugin\'s MCP connection to try launching it.';
    } catch (error) {
      status = error.message;
    }
  }
  return `${status}\n\nSetup steps:
1. Visit ${setupURL} and download or update Roblox Studio.
2. Install Studio (on macOS, place RobloxStudio.app in /Applications).
3. Open Roblox Studio and log into your Roblox account.
4. Enable MCP Server in Studio's Assistant settings.
5. Keep Studio open, then reconnect the plugin or restart ChatGPT.

This diagnostic only checks the local StudioMCP file. It cannot inspect your login or Assistant settings.`;
}

export function handleLine(line, diagnostic) {
  const error = (id, code, message) => JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  let request;
  try {
    // Preserve numeric request IDs beyond JavaScript's safe-integer range.
    request = JSON.parse(line, (key, value, context) =>
      key === 'id' && typeof value === 'number' ? JSON.rawJSON(context.source) : value);
  } catch {
    return error(null, -32700, 'Parse error');
  }
  if (!isObject(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || !request.method) {
    return error(null, -32600, 'Invalid Request');
  }
  if (!Object.hasOwn(request, 'id')) return null; // Notifications never receive replies.
  const { id, method, params } = request;
  if (id !== null && typeof id !== 'string' && !JSON.isRawJSON(id)) {
    return error(null, -32600, 'Invalid request ID');
  }
  let result;
  switch (method) {
    case 'initialize': {
      if (!isObject(params) || typeof params.protocolVersion !== 'string' || !params.protocolVersion) {
        return error(id, -32602, 'protocolVersion is required');
      }
      result = {
        protocolVersion: protocols.includes(params.protocolVersion) ? params.protocolVersion : protocols.at(-1),
        capabilities: { tools: {} },
        serverInfo: { name: 'roblox-studio-setup', version },
        instructions: 'StudioMCP could not be launched. Use diagnose_roblox_studio for setup instructions.',
      };
      break;
    }
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      result = { tools: [{
        name: toolName,
        description: 'Diagnose the local Roblox Studio MCP installation and explain how to install Studio, sign in, and enable MCP Server in Assistant settings.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }] };
      break;
    case 'tools/call':
      if (!isObject(params) || params.name !== toolName) {
        return error(id, -32602, 'Unknown tool; use diagnose_roblox_studio');
      }
      if (Object.hasOwn(params, 'arguments') && (!isObject(params.arguments) || Object.keys(params.arguments).length !== 0)) {
        return error(id, -32602, 'diagnose_roblox_studio takes an empty arguments object');
      }
      result = { content: [{ type: 'text', text: diagnostic() }], isError: false };
      break;
    default:
      return error(id, -32601, 'Method not found');
  }
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

export async function serve(input, output, diagnostic) {
  const maxBytes = 4 * 1024 * 1024;
  let pending = Buffer.alloc(0);
  const reply = async line => {
    if (line.length > maxBytes) throw new Error('MCP message exceeds 4 MiB');
    const text = line.toString('utf8').trim();
    if (!text) return;
    const response = handleLine(text, diagnostic);
    if (response !== null) {
      await new Promise((resolve, reject) => output.write(response + '\n', error => error ? reject(error) : resolve()));
    }
  };
  // Buffer bytes until newline so fragmented UTF-8 is decoded only once.
  for await (const chunk of input) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    let end;
    while ((end = pending.indexOf(10)) !== -1) {
      await reply(pending.subarray(0, end));
      pending = pending.subarray(end + 1);
    }
    if (pending.length > maxBytes) throw new Error('MCP message exceeds 4 MiB');
  }
  if (pending.length) await reply(pending);
}

export function handoff(path, { platform = process.platform, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    let command = path;
    let args = [];
    const options = { stdio: 'inherit', env, windowsHide: true };
    if (platform === 'win32') {
      if (!env.SystemRoot) throw new Error('SystemRoot is unset; cannot locate Windows cmd.exe');
      command = win32.join(env.SystemRoot, 'System32', 'cmd.exe');
      // Expand the path once inside quotes. Preserve spaces, &, %, and !.
      args = ['/d', '/s', '/v:off', '/c', '""%ROBLOX_STUDIO_MCP_TARGET%""'];
      options.windowsVerbatimArguments = true;
      options.env = { ...env, ROBLOX_STUDIO_MCP_TARGET: path };
    }
    // Do not open/read stdin first. StudioMCP owns the inherited streams;
    // this process never parses or re-encodes its protocol messages.
    const child = spawn(command, args, options);
    let started = false;
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    child.once('spawn', () => { started = true; });
    child.on('error', error => {
      if (!started) { cleanup(); reject(error); }
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve({ code, signal }); // No fallback after a child has started.
    });
  });
}

export async function run({ path, platform = process.platform, env = process.env } = {}) {
  let issue;
  try {
    path ??= studioPath(platform, env);
    checkStudio(path);
    try {
      return await handoff(path, { platform, env });
    } catch (error) {
      throw new Error(`StudioMCP exists at ${path}, but could not be started: ${error.message}`);
    }
  } catch (error) {
    issue = error.message;
  }
  await serve(process.stdin, process.stdout, () => diagnose(path, issue));
  return { code: 0, signal: null };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { code, signal } = await run();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code;
  } catch (error) {
    console.error(`Roblox Studio MCP: ${error.message}`);
    process.exitCode = 1;
  }
}
