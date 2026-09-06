@echo off
rem Launch the Chart Forge Editor by double-clicking this file.
rem
rem Everything is resolved from where this script lives (%~dp0), so the repository can
rem be moved or cloned anywhere without editing anything here.
rem
rem Vite is deliberately not started separately: editor/src-tauri/tauri.conf.json sets
rem beforeDevCommand to "npm run dev", so `tauri dev` brings the dev server up itself.
rem Starting it here as well would leave a second server holding port 5173.

setlocal

pushd "%~dp0editor" 2>nul
if errorlevel 1 (
    echo [start-editor] Cannot find the editor directory next to this script.
    echo [start-editor] Expected: %~dp0editor
    echo [start-editor] Keep start-editor.cmd in the repository root.
    echo.
    pause
    exit /b 1
)

if not exist "package.json" (
    echo [start-editor] editor\package.json is missing.
    echo [start-editor] This does not look like a complete Chart Forge checkout.
    echo.
    popd
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [start-editor] npm was not found on PATH.
    echo [start-editor] Install Node.js from https://nodejs.org/ and open a new window.
    echo.
    popd
    pause
    exit /b 1
)

rem The desktop shell compiles a Rust binary, so cargo has to be there too. Checking now
rem gives a clear message instead of a compiler error several seconds in.
where cargo >nul 2>nul
if errorlevel 1 (
    echo [start-editor] cargo was not found on PATH.
    echo [start-editor] The desktop shell needs the Rust toolchain: https://rustup.rs/
    echo [start-editor] After installing, open a new window so PATH is picked up.
    echo.
    popd
    pause
    exit /b 1
)

rem Only on a fresh checkout. npm ci is the right call here because it installs exactly
rem what package-lock.json pins, and it is slow enough not to want on every launch.
if not exist "node_modules" (
    echo [start-editor] First run: installing dependencies with npm ci...
    call npm ci
    if errorlevel 1 (
        echo.
        echo [start-editor] npm ci failed. See the output above.
        echo.
        popd
        pause
        exit /b 1
    )
)

echo [start-editor] Starting the Chart Forge Editor...
rem `call` matters: npm is a batch file, and without it control never returns here.
call npm run tauri dev
set "EDITOR_EXIT=%ERRORLEVEL%"

popd

rem Only stop on the way out when something went wrong, so a normal quit just closes.
if not "%EDITOR_EXIT%"=="0" (
    echo.
    echo [start-editor] The editor exited with code %EDITOR_EXIT%.
    echo.
    pause
)

exit /b %EDITOR_EXIT%
