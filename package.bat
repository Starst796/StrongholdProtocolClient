@echo off
rem Release entry point: run this by hand after the game repo (..\Stronghold-Protocol) has been updated.
rem It aligns this repo's version to the game's APP_VERSION, builds the desktop client + Android apk,
rem commits the result and writes the packages to build\dist\. See docs\PACKAGING.md (section 13).
setlocal
cd /d "%~dp0"

set "NODE=node"
where node >nul 2>nul
if not errorlevel 1 goto run
set "NODE=%~dp0..\Stronghold-Protocol\.tools\node\node.exe"
if exist "%NODE%" goto run
echo [x] Node.js 22+ not found. Install it, or put the game repo's vendored node at ..\Stronghold-Protocol\.tools\node\node.exe 1>&2
exit /b 1

:run
"%NODE%" tools\package-release.mjs %*
exit /b %errorlevel%
