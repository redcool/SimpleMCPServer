@echo off
cd /d "%~dp0"
echo =============================================
echo  SimpleMcpServer - E2E Test
echo =============================================
echo.
echo Make sure SimpleMcpServer and Unity Bridge are running.
echo.
echo Running MCP tools/list test...
echo.
node tests\test-e2e.cjs
echo.
pause
