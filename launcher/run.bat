@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title YT-Anki launcher

rem ---- 1. which build fits this PC -----------------------------------------
set "ARCH=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "ARCH=%PROCESSOR_ARCHITEW6432%"
set "SUFFIX=amd64"
if /I "%ARCH%"=="ARM64" set "SUFFIX=arm64"
if /I "%ARCH%"=="x86" (
  echo Это 32-битная Windows - лончер её не поддерживает.
  goto :fail
)
set "EXE=%~dp0dist\ytam-launcher-windows-%SUFFIX%.exe"
if not exist "%EXE%" set "EXE=%~dp0ytam-launcher-windows-%SUFFIX%.exe"

rem ---- 2. no exe yet: build it if Go is installed ---------------------------
if not exist "%EXE%" (
  where go >nul 2>nul
  if errorlevel 1 (
    echo Не найден файл ytam-launcher-windows-%SUFFIX%.exe и нет Go для сборки.
    echo Скачайте exe из папки launcher\dist репозитория или установите Go:  winget install GoLang.Go
    goto :fail
  )
  echo Собираю лончер для %SUFFIX% ...
  if not exist dist mkdir dist
  set "CGO_ENABLED=0"
  set "GOOS=windows"
  set "GOARCH=%SUFFIX%"
  go build -trimpath -ldflags "-H=windowsgui -s -w" -o "dist\ytam-launcher-windows-%SUFFIX%.exe" .
  if errorlevel 1 (
    echo Сборка не удалась.
    goto :fail
  )
  set "EXE=%~dp0dist\ytam-launcher-windows-%SUFFIX%.exe"
)

rem ---- 3. remove the "downloaded from the internet" flag (SmartScreen) -----
powershell -NoProfile -ExecutionPolicy Bypass -Command "Unblock-File -LiteralPath '%EXE%'" >nul 2>nul

rem ---- 4. stop an old copy (so an updated exe really starts) ---------------
curl -s -m 2 -X POST -H "X-YTAM: 1" http://127.0.0.1:8766/api/quit >nul 2>nul
taskkill /F /IM "ytam-launcher-windows-%SUFFIX%.exe" >nul 2>nul
ping -n 2 127.0.0.1 >nul

rem ---- 5. start, then wait until it really answers --------------------------
echo Запускаю %EXE%
start "" "%EXE%" --background
set /a TRIES=0
:wait
set /a TRIES+=1
curl -s -m 2 http://127.0.0.1:8766/ping >nul 2>nul && goto :up
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8766/ping).StatusCode}catch{exit 1}" >nul 2>nul && goto :up
if %TRIES% GEQ 25 goto :down
ping -n 2 127.0.0.1 >nul
goto :wait

:up
echo.
echo  Готово: лончер работает - http://127.0.0.1:8766/
echo  Страница состояния откроется в браузере. Это окно можно закрыть.
start "" http://127.0.0.1:8766/
ping -n 4 127.0.0.1 >nul
exit /b 0

:down
echo.
echo  Лончер не ответил за 25 секунд. Последние строки журнала:
if exist launcher.log (powershell -NoProfile -Command "Get-Content -Tail 15 -LiteralPath 'launcher.log'") else echo  launcher.log не создан: exe не запустился, проверьте антивирус
:fail
echo.
pause
exit /b 1
