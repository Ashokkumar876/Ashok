@echo off
REM ============================================================
REM One-click launcher for Studio-Xml-Modification.ps1
REM Keep this .bat in the same folder as the .ps1 file.
REM -ExecutionPolicy Bypass applies only to this one run, so it works
REM even when the PC's execution policy would block the script.
REM ============================================================

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Studio-Xml-Modification.ps1"

echo.
pause
