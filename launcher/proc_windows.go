//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// hide keeps child processes (yt-dlp, ffmpeg) from flashing console windows.
func hide(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
