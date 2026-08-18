@echo off
title SimpleMcpServer
cd /d "%~dp0"
echo [%date% %time%] Starting MCP Server...
node dist/index.js
echo.
echo [%date% %time%] Server exited.
pause
