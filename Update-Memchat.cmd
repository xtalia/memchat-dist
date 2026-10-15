@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-Memchat.ps1" %*
set "MEMCHAT_EXIT=%ERRORLEVEL%"
if not "%MEMCHAT_NO_PAUSE%"=="1" pause
exit /b %MEMCHAT_EXIT%
