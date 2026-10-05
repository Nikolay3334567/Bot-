@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
(
  echo Set sh = CreateObject^("WScript.Shell"^)
  echo sh.Run """%~dp0start-helper-hidden.vbs""", 0, False
) > "%STARTUP%\ytam-helper.vbs"
echo Готово: помощник будет запускаться вместе с Windows (без окна).
echo Запускаю его сейчас...
wscript "%~dp0start-helper-hidden.vbs"
pause
