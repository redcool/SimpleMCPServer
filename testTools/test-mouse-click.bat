@echo off
chcp 65001 >nul
title mouse_click test (every 3s)
echo [mouse_click test] Starting — calls input.mouse_click (0.5,0.5) every 3 seconds
echo [mouse_click test] Press Ctrl+C to stop
echo.

:loop
echo [%date% %time%] Calling mouse_click...
powershell -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:45678/rpc' -Method Post -ContentType 'application/json' -Body '{\"jsonrpc\":\"2.0\",\"id\":\"click_%RANDOM%\",\"method\":\"tools/call\",\"params\":{\"name\":\"input.mouse_click\",\"arguments\":{\"x\":0.5,\"y\":0.5}}}' -TimeoutSec 25; if ($r.result.content[0].text -match 'success\"\s*:\s*true') { echo OK } else { echo FAIL: $($r.result.content[0].text) } } catch { echo TIMEOUT: $_ }"
echo.
timeout /t 3 /nobreak >nul
goto loop
