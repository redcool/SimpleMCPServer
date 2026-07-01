@echo off
cd /d "%~dp0"
echo =============================================
echo  SimpleMcpServer - Quick Start
echo  (skips build - run start.bat if code changed)
echo =============================================
echo.
echo Starting MCP Server...
echo   Port: %UNITY_MCP_PORT% (default 45678)
echo   Press Ctrl+C to stop.
echo.
node dist/index.js
