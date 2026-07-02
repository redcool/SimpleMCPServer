@echo off
cd /d "%~dp0"
echo =============================================
echo  SimpleMcpServer - Build ^& Start
echo =============================================
echo.
echo [1/2] Building TypeScript...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo Build failed! Fix errors and try again.
    pause
    exit /b 1
)
echo Build OK.
echo.
echo [2/2] Starting MCP Server...
echo   Config: config.json (default 127.0.0.1:45678)
echo   Press Ctrl+C to stop.
echo.
node dist/index.js
pause
