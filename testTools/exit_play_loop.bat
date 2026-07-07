@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo 每3秒发送一次 exit_play_mode (按 Ctrl+C 停止)
echo.

:RPC_INIT
rem 发送 initialize
curl.exe -s -X POST http://127.0.0.1:45678/rpc -H "Content-Type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}" >nul 2>&1
timeout /t 1 /nobreak >nul

:LOOP
rem 发送 exit_play_mode
curl.exe -s -X POST http://127.0.0.1:45678/rpc -H "Content-Type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"scene.exit_play_mode\",\"arguments\":{}}}"

echo.
echo --- 等待 3 秒 ---
timeout /t 3 /nobreak >nul
goto LOOP
