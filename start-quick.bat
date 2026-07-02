@echo off
cd /d "%~dp0"
echo =============================================
echo  SimpleMcpServer - Quick Start
echo  (skips build - run start.bat if code changed)
echo =============================================
echo.
echo Starting MCP Server...
echo   Config: config.json (default 127.0.0.1:45678)
echo   Press Ctrl+C to stop.
echo.
node dist/index.js
