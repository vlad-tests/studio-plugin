import { run } from '../../plugins/roblox-studio/server.mjs';

const { code, signal } = await run({ path: process.argv[2] });
if (signal) process.kill(process.pid, signal);
else process.exitCode = code;
