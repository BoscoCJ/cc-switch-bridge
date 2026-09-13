@echo off
REM CC Switch Bridge - Stop script for Windows

echo Stopping CC Switch Bridge...

REM Find and kill node processes running server.js
for /f "tokens=2" %%i in ('tasklist /fi "imagename eq node.exe" /fo csv /nh 2^>nul ^| findstr /i "node"') do (
    wmic process where "ProcessId=%%i and CommandLine like '%%server.js%%'" get ProcessId 2>nul | findstr /r "[0-9]" >nul
    if not errorlevel 1 (
        taskkill /F /PID %%i >nul 2>&1
        echo Stopped process %%i
    )
)

REM Alternative: use netstat to find process on port 3000
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000.*LISTENING"') do (
    if not "%%a" == "0" (
        taskkill /F /PID %%a >nul 2>&1
        echo Stopped process on port 3000 (PID: %%a^)
    )
)

REM Clean up PID file
if exist "%~dp0bridge.pid" del "%~dp0bridge.pid"

echo Done.
timeout /t 2 >nul
