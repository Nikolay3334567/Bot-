@echo off
chcp 65001 >nul
title YT -^> Anki audio helper
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python не найден. Установите Python 3 с https://www.python.org/downloads/ ^(галочка "Add python.exe to PATH"^).
  pause
  exit /b 1
)
echo Обновляю yt-dlp и ffmpeg...
python -m pip install -U --quiet yt-dlp imageio-ffmpeg
python ytam_helper.py
pause
