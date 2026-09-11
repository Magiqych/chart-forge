@echo off
rem Launch the Chart Forge Player.
rem
rem Three ways to use this file:
rem
rem   1. Drag a .project.json or .chart.json onto it. Windows passes the file as %1 and
rem      the Player opens straight into it. This is the quickest one.
rem   2. Double-click it. The Player opens on its start screen, where a project can be
rem      opened by path; the last one opened is filled in for you.
rem   3. From a terminal:
rem         start-player.cmd "D:\path\to\song-v2.project.json"
rem
rem Everything is resolved from where this script lives (%~dp0), so the repository can be
rem moved or cloned anywhere without editing anything here.
rem
rem Unlike the Editor, the Player needs no build step, no npm install and no Rust
rem toolchain: it is Node's standard library and a browser. Nothing it does writes to the
rem chart, the project, or anything else on disk.

setlocal

if not exist "%~dp0player\server.mjs" (
    echo [start-player] Cannot find player\server.mjs next to this script.
    echo [start-player] Expected: %~dp0player\server.mjs
    echo [start-player] Keep start-player.cmd in the repository root.
    echo.
    pause
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo [start-player] node was not found on PATH.
    echo [start-player] Install Node.js from https://nodejs.org/ and open a new window.
    echo.
    pause
    exit /b 1
)

echo [start-player] Starting the Chart Forge Player...
echo [start-player] A browser window will open. Close this window to stop the Player.
echo.

rem %* passes the dropped or typed path through with its quotes intact, which matters:
rem these paths have spaces and non-ASCII characters in them.
node "%~dp0player\server.mjs" %*
set "PLAYER_EXIT=%ERRORLEVEL%"

rem Only stop on the way out when something went wrong, so a normal quit just closes.
if not "%PLAYER_EXIT%"=="0" (
    echo.
    echo [start-player] The Player exited with code %PLAYER_EXIT%.
    echo.
    pause
)

exit /b %PLAYER_EXIT%
