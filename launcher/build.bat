@echo off
chcp 65001 >nul
cd /d "%~dp0"
where go >nul 2>nul || (echo Go не найден. Установите: winget install GoLang.Go & pause & exit /b 1)
if not exist dist mkdir dist
set CGO_ENABLED=0
set GOOS=windows
set GOARCH=arm64
go build -trimpath -ldflags "-H=windowsgui" -o dist\ytam-launcher-windows-arm64.exe . || goto :err
set GOARCH=amd64
go build -trimpath -ldflags "-H=windowsgui" -o dist\ytam-launcher-windows-amd64.exe . || goto :err
echo Готово: папка dist
pause
exit /b 0
:err
echo Ошибка сборки
pause
