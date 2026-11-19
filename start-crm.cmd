@echo off
setlocal
pushd "%~dp0"

if not exist "%~dp0start-crm.ps1" (
    echo ERROR: start-crm.ps1 was not found in "%~dp0".
    set "EXIT_CODE=1"
    goto :failed
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-crm.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" goto :failed

popd
exit /b 0

:failed
if "%EXIT_CODE%"=="0" set "EXIT_CODE=1"
echo.
echo Smart CRM startup failed with exit code %EXIT_CODE%.
echo Read the error above, then press any key to close this window.
pause >nul
popd
exit /b %EXIT_CODE%
