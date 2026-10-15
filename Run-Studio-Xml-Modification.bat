@echo off
REM ============================================================
REM One-click launcher for Studio-Xml-Modification.ps1
REM Finds the script in this .bat's folder, or in the folder above it
REM (e.g. when this .bat is kept in a "Setup Files" sub-folder).
REM -ExecutionPolicy Bypass applies only to this one run.
REM ============================================================

set "SCRIPT=%~dp0Studio-Xml-Modification.ps1"
if not exist "%SCRIPT%" set "SCRIPT=%~dp0..\Studio-Xml-Modification.ps1"

if not exist "%SCRIPT%" (
    echo ERROR: Studio-Xml-Modification.ps1 was not found in:
    echo    %~dp0
    echo    %~dp0..\
    echo Put this .bat in the same folder as the script, or in a sub-folder of it.
    echo.
    pause
    exit /b 1
)

echo Running: %SCRIPT%
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"

echo.
pause
