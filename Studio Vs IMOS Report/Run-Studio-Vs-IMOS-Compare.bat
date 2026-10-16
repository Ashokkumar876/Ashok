@echo off
title Studio Vs IMOS Comparison
REM ============================================================
REM  Studio Vs IMOS Comparison - MAIN LAUNCHER
REM  This is the only file users need to run (double-click it).
REM
REM  Keep this .bat in the main "Studio Vs IMOS Report" folder.
REM  The PowerShell script lives in the "Setup" sub-folder.
REM  Folder locations are set at the top of the .ps1 script.
REM
REM  -ExecutionPolicy Bypass applies only to this run; no PC settings
REM  are changed and no administrator rights are needed.
REM ============================================================

set "SCRIPT=%~dp0Setup\Studio-Vs-IMOS-Compare.ps1"

if not exist "%SCRIPT%" (
    echo ERROR: The PowerShell script was not found:
    echo    %SCRIPT%
    echo.
    echo Make sure "Studio-Vs-IMOS-Compare.ps1" is inside the "Setup"
    echo folder next to this .bat file.
    echo.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"

echo.
if errorlevel 1 (
    echo Finished WITH ERRORS or UNMATCHED files - see the summary above.
) else (
    echo Finished successfully.
)
echo.
pause
