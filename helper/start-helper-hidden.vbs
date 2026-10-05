' Starts the helper without a console window (used for autostart).
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
sh.Run "cmd /c python -m pip install -U --quiet yt-dlp imageio-ffmpeg & pythonw ytam_helper.py", 0, False
