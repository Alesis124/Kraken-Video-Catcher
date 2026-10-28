@echo off
setlocal
set DIR=%~dp0

where pythonw >nul 2>nul
if %ERRORLEVEL%==0 (
    pythonw "%DIR%host.py" %*
) else (
    python "%DIR%host.py" %*
)
