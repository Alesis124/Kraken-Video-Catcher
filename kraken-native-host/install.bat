@echo off
setlocal enabledelayedexpansion
set DIR=%~dp0
if "%DIR:~-1%"=="\" set DIR=%DIR:~0,-1%

echo ============================================
echo  Instalador del Native Host - Kraken Catcher
echo ============================================
echo.

where python >nul 2>nul
if errorlevel 1 (
    echo [!] No se encontro Python en el PATH.
    echo     Instala Python 3 ^(marcando "Add to PATH"^) y vuelve a ejecutar este instalador.
    pause
    exit /b 1
)

echo [1/3] Instalando dependencias de Python ^(requests, pycryptodome^)...
python -m pip install --quiet --upgrade requests pycryptodome
if errorlevel 1 (
    echo [!] Fallo instalando dependencias. Revisa la salida de pip arriba.
    pause
    exit /b 1
)

echo.
echo [2/3] Necesito el ID de la extension.
echo       Abre chrome://extensions , activa "Modo de desarrollador" si no lo esta,
echo       y copia el ID que aparece bajo "Kraken Video Catcher".
echo.
set /p EXTID="ID de la extension: "

if "%EXTID%"=="" (
    echo [!] No se introdujo ningun ID. Cancelando.
    pause
    exit /b 1
)

set HOSTBAT=%DIR%\host.bat
set MANIFEST=%DIR%\com.krakencatcher.host.json
set HOSTBAT_ESCAPED=%HOSTBAT:\=\\%

echo [3/3] Escribiendo manifiesto y registrando en el Registro de Windows...

> "%MANIFEST%" (
    echo {
    echo   "name": "com.krakencatcher.host",
    echo   "description": "Kraken Video Catcher - Native Host",
    echo   "path": "%HOSTBAT_ESCAPED%",
    echo   "type": "stdio",
    echo   "allowed_origins": ["chrome-extension://%EXTID%/"]
    echo }
)

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.krakencatcher.host" /ve /t REG_SZ /d "%MANIFEST%" /f >nul

if errorlevel 1 (
    echo [!] Fallo al escribir en el Registro.
    pause
    exit /b 1
)

echo.
echo ============================================
echo  Instalacion completada correctamente.
echo ============================================
echo  Manifiesto:  %MANIFEST%
echo  Host:        %HOSTBAT%
echo.
echo  Ahora recarga la extension en chrome://extensions
echo  ^(icono de recargar^) y prueba a descargar un video.
echo.
pause
