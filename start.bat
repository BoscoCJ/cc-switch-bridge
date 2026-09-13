@echo off
REM CC Switch Bridge - Windows 前台启动脚本

cd /d "%~dp0"

REM 自动检测 Node.js
where node >nul 2>&1
if %ERRORLEVEL% == 0 (
    set NODE=node
    goto :start
)

REM 尝试 WorkBuddy 自带 Node
for /d %%i in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if exist "%%i\node.exe" (
        set NODE=%%i\node.exe
        goto :start
    )
)

REM 尝试常见路径
if exist "C:\Program Files\nodejs\node.exe" (
    set NODE=C:\Program Files\nodejs\node.exe
    goto :start
)

echo ❌ 未找到 Node.js，请先安装 Node.js 18+
pause
exit /b 1

:start
echo ✓ 使用 Node: %NODE%
echo ✓ 启动 CC Switch Bridge...
"%NODE%" server.js --config config.json
