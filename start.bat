@echo off
REM CC Switch Bridge - Windows startup script

cd /d "%~dp0"

REM Check required files
if not exist "server.js" (
    echo [ERROR] server.js not found
    pause
    exit /b 1
)
if not exist "config.json" (
    echo [ERROR] config.json not found.
    echo Please copy config.example.json to config.json and edit it.
    pause
    exit /b 1
)

REM Auto-detect Node.js
where node >nul 2>&1
if %ERRORLEVEL% == 0 (
    set NODE=node
    goto :start
)

REM Try WorkBuddy bundled Node
for /d %%i in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if exist "%%i\node.exe" (
        set NODE=%%i\node.exe
        goto :start
    )
)

REM Try common paths
if exist "C:\Program Files\nodejs\node.exe" (
    set NODE=C:\Program Files\nodejs\node.exe
    goto :start
)

echo [ERROR] Node.js not found. Please install Node.js 18+
pause
exit /b 1

:start
echo [INFO] Using Node: %NODE%
echo [INFO] Starting CC Switch Bridge...
"%NODE%" server.js --config config.json
echo.
echo Service stopped. Press any key to close...
pause >nul
