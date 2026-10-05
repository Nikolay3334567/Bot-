#!/usr/bin/env sh
cd "$(dirname "$0")"
python3 -m pip install -U --quiet yt-dlp imageio-ffmpeg
exec python3 ytam_helper.py
