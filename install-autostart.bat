@echo off
REM CC Switch Bridge - Install auto-start on Windows
REM Creates a shortcut in the Startup folder

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SCRIPT_DIR=%~dp0"
set "VBS_PATH=%SCRIPT_DIR%run-silent.vbs"

REM Create shortcut in Startup folder
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut('%STARTUP%\CC-Switch-Bridge.lnk'); $sc.TargetPath = 'wscript.exe'; $sc.Arguments = '\"%VBS_PATH%\"'; $sc.WorkingDirectory = '%SCRIPT_DIR%'; $sc.Description = 'CC Switch Bridge'; $sc.Save()"

if %ERRORLEVEL% == 0 (
    echo [OK] Auto-start installed.
    echo Shortcut created in: %STARTUP%
    echo CC Switch Bridge will start silently on next login.
) else (
    echo [ERROR] Failed to create shortcut.
)

pause
