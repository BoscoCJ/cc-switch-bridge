@echo off
REM CC Switch Bridge - Uninstall auto-start on Windows

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT=%STARTUP%\CC-Switch-Bridge.lnk"

if exist "%SHORTCUT%" (
    del "%SHORTCUT%"
    echo [OK] Auto-start uninstalled.
    echo Shortcut removed from: %STARTUP%
) else (
    echo [INFO] No auto-start shortcut found.
)

pause
