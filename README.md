# Roblox Studio plugin

Repo-local marketplace: `.agents/plugins/marketplace.json`.
Plugin: `plugins/roblox-studio`.

No build or npm install is needed. The dependency-free JavaScript server uses
ChatGPT desktop's bundled Node.js runtime via `CODEX_MCP_NODE_PATH`. The manifest
uses a relative launcher path; the desktop host selects the companion `.cmd`
launcher on Windows, following the layout used by ChatGPT's bundled plugins.
End users need only a current ChatGPT desktop app with local MCP support.

The server checks exactly these locations:

- macOS: `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP`
- Windows: `%LOCALAPPDATA%\Roblox\mcp.bat`

If present, StudioMCP inherits stdin, stdout, and stderr unchanged (Windows runs
the batch file through `cmd.exe`). If missing or unable to launch, the server
exposes only `diagnose_roblox_studio`, with the problem and
[setup instructions](https://create.roblox.com/docs/studio/setup): install/update
Studio, sign in, and enable **MCP Server** in Assistant settings. Reconnect the
plugin after setup. The diagnostic rechecks the file but cannot inspect login
or settings.

Register this repo with `codex plugin marketplace add /absolute/path/to/studio-agent-plugin`,
then select Roblox Studio from its marketplace in the desktop app. Distribute the
whole plugin folder and preserve the executable bit on `scripts/launch`.

For development, run `node --test tests/server.test.mjs` with Node 22+ (also run in
CI on macOS and Windows). To use ChatGPT's runtime directly, substitute its Node
executable path for `node`. There are no external packages or generated binaries.
