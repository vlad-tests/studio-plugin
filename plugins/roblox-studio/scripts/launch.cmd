@echo off
setlocal DisableDelayedExpansion
if not defined CODEX_MCP_NODE_PATH goto missing_runtime
if not exist "%CODEX_MCP_NODE_PATH%" goto missing_runtime
"%CODEX_MCP_NODE_PATH%" "%~dp0..\server.mjs"
exit /b %errorlevel%

:missing_runtime
echo Roblox Studio MCP could not find the bundled Node.js runtime. Update or restart ChatGPT. 1>&2
exit /b 127
