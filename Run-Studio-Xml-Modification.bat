@echo off
title Studio XML Modification
REM ============================================================
REM  Studio XML Modification - MAIN LAUNCHER
REM  This is the only file users need to run (double-click it).
REM
REM  Keep this .bat in the main "Studio Xml Validation" folder.
REM  The PowerShell script lives in the "Setup Files" sub-folder.
REM  The input/output folders and the CSV are taken from the folder
REM  this .bat is in, so the whole folder can be moved to any PC/drive.
REM
REM  -ExecutionPolicy Bypass applies only to this run; no PC settings
REM  are changed and no administrator rights are needed.
REM ============================================================

set "MAIN_DIR=%~dp0"
set "SCRIPT=%MAIN_DIR%Setup Files\Studio-Xml-Modification.ps1"

if not exist "%SCRIPT%" (
    echo ERROR: The PowerShell script was not found:
    echo    %SCRIPT%
    echo.
    echo Make sure "Studio-Xml-Modification.ps1" is inside the "Setup Files"
    echo folder next to this .bat file.
    echo.
    pause
    exit /b 1
)

echo ============================================================
echo  Studio XML Modification
echo ============================================================
echo.

REM "%MAIN_DIR%." avoids a trailing backslash escaping the closing quote.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -BasePath "%MAIN_DIR%."

echo.
if errorlevel 1 (
    echo Finished WITH ERRORS - see the summary above.
) else (
    echo Finished successfully.
)
echo.
pause
