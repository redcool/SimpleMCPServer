@echo off
cd /d "%~dp0"
echo =============================================
echo  Unity SimpleMCPBridge - E2E Test
echo =============================================
echo.
echo Make sure Unity SimpleMCPBridge is running on port %UNITY_MCP_PORT%.
echo.
node tests/test-bridge.mjs
echo.
pause
