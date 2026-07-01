@echo off
cd /d "%~dp0"
setlocal enabledelayedexpansion

echo =============================================
echo   SimpleMcpServer ? Setup
echo =============================================
echo.

:: ---- Check Node.js ----
echo [1/4] Checking Node.js...
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo   Node.js not found!
    echo.
    echo   Please install Node.js 22+ from:
    echo   https://nodejs.org/
    echo.
    echo   After installing, re-run setup.bat.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo   Node.js %NODE_VER%
echo.

:: ---- Check npm ----
echo [2/4] Checking npm...
where npm >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo   npm not found!
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('npm --version') do set NPM_VER=%%i
echo   npm v%NPM_VER%
echo.

:: ---- Install dependencies ----
echo [3/4] Installing npm dependencies...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo   npm install failed!
    pause
    exit /b 1
)
echo   Dependencies installed.
echo.

:: ---- Build TypeScript ----
echo [4/4] Building TypeScript...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo   Build failed! Check for errors above.
    pause
    exit /b 1
)
echo   Build OK.
echo.

echo =============================================
echo   Setup complete!
echo =============================================
echo.
echo   Next steps:
echo.
echo   1. Open Unity project and start SimpleMCPBridge:
echo      Tools -^> SimpleMCPBridge -^> Start Bridge
echo.
echo   2. Start the MCP Server:
echo      start.bat
echo.
echo   3. (Optional) Run E2E test:
echo      start-test.bat
echo.
pause
