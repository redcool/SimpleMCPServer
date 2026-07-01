@echo off
cd /d "%~dp0"
echo =============================================
echo  SimpleMcpServer - Build & Start
echo =============================================
echo.
echo [1/2] Building TypeScript...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo Build failed! Fix errors and try again.
    exit /b 1
)
echo Build OK.
echo.
echo [2/2] Starting MCP Server...
echo   Port: %UNITY_MCP_PORT% (default 45678)
echo   Press Ctrl+C to stop.
echo.
node dist/index.js
