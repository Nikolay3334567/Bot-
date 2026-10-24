@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
where go >nul 2>nul || (echo Go не найден. Установите: winget install GoLang.Go & pause & exit /b 1)
if not exist dist mkdir dist
set "CGO_ENABLED=0"
set "GOOS=windows"
set "FLAGS=-H=windowsgui -s -w"
set "ARCH=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "ARCH=%PROCESSOR_ARCHITEW6432%"

rem  build.bat        - only for this PC (fast)
rem  build.bat all    - both Windows builds (arm64 + amd64)
if /I "%~1"=="all" goto :all
if /I "%ARCH%"=="ARM64" (set "GOARCH=arm64") else (set "GOARCH=amd64")
echo Сборка для %GOARCH% ...
go build -trimpath -ldflags "%FLAGS%" -o "dist\ytam-launcher-windows-%GOARCH%.exe" . || goto :err
goto :ok

:all
set "GOARCH=arm64"
go build -trimpath -ldflags "%FLAGS%" -o "dist\ytam-launcher-windows-arm64.exe" . || goto :err
set "GOARCH=amd64"
go build -trimpath -ldflags "%FLAGS%" -o "dist\ytam-launcher-windows-amd64.exe" . || goto :err

:ok
echo Готово: папка dist
exit /b 0
:err
echo Ошибка сборки
pause
exit /b 1
