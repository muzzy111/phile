@echo off
rem Double-click to install the Phile workspace mod for Claude Code.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-claude-mod.ps1" %*
echo.
pause
