package main

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// ---------- locating / downloading yt-dlp and ffmpeg ----------

func exeName(n string) string {
	if runtime.GOOS == "windows" {
		return n + ".exe"
	}
	return n
}

// findTool looks for a program: explicit path, next to the launcher, ./bin, then PATH.
func toolWorks(p string) bool {
	cmd := exec.Command(p, "--version")
	hide(cmd)
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		return false
	}
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err == nil
	case <-time.After(30 * time.Second):
		cmd.Process.Kill()
		return false
	}
}

func findTool(explicit string, names ...string) string {
	if l := findTools(explicit, names...); len(l) > 0 {
		return l[0]
	}
	return ""
}

func findTools(explicit string, names ...string) []string {
	var out []string
	if explicit != "" {
		if _, err := os.Stat(explicit); err == nil {
			out = append(out, explicit)
		}
	}
	dirs := []string{appDir, filepath.Join(appDir, "bin")}
	for _, d := range dirs {
		entries, _ := os.ReadDir(d)
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			low := strings.ToLower(e.Name())
			for _, n := range names {
				// matches yt-dlp.exe, yt-dlp_arm64.exe, yt-dlp_x86.exe ...
				if strings.HasPrefix(low, n) && (strings.HasSuffix(low, ".exe") || runtime.GOOS != "windows") && !strings.HasSuffix(low, ".part") && !strings.Contains(low, "launcher") {
					out = append(out, filepath.Join(d, e.Name()))
				}
			}
		}
	}
	for _, n := range names {
		if p, err := exec.LookPath(n); err == nil {
			out = append(out, p)
		}
	}
	return out
}

func download(url, dest string) error {
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	tmp := dest + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	f.Close()
	return os.Rename(tmp, dest)
}

func ensureYtdlp() (string, error) {
	// Every yt-dlp* file found is test-run (--version); a build for the wrong CPU/Windows is skipped.
	for _, p := range findTools(cfg.YtdlpPath, "yt-dlp") {
		if toolWorks(p) {
			return p, nil
		}
		logf("yt-dlp %s не запускается на этом ПК — пропускаю", p)
	}
	if !cfg.AutoDownload {
		return "", errors.New("yt-dlp не найден. Положите yt-dlp.exe рядом с лончером (или в папку bin) либо включите autoDownload")
	}
	var assets []string
	switch {
	case runtime.GOOS == "windows" && runtime.GOARCH == "arm64":
		assets = []string{"yt-dlp_arm64.exe", "yt-dlp_win_arm64.exe", "yt-dlp.exe"} // x64 build also runs on ARM Windows
	case runtime.GOOS == "windows":
		assets = []string{"yt-dlp.exe"}
	case runtime.GOOS == "darwin":
		assets = []string{"yt-dlp_macos"}
	default:
		assets = []string{"yt-dlp_linux"}
	}
	var last error
	for _, a := range assets {
		dest := filepath.Join(appDir, "bin", exeName("yt-dlp"))
		logf("скачиваю %s …", a)
		if err := download("https://github.com/yt-dlp/yt-dlp/releases/latest/download/"+a, dest); err != nil {
			last = err
			continue
		}
		os.Chmod(dest, 0o755)
		logf("yt-dlp скачан: %s", dest)
		return dest, nil
	}
	return "", fmt.Errorf("не удалось скачать yt-dlp: %v", last)
}

func ensureFfmpeg() (string, error) {
	if p := findTool(cfg.FfmpegPath, "ffmpeg"); p != "" {
		return p, nil
	}
	if !cfg.AutoDownload {
		return "", errors.New("ffmpeg не найден. Положите ffmpeg.exe рядом с лончером (или в папку bin) либо включите autoDownload")
	}
	if runtime.GOOS != "windows" {
		return "", errors.New("ffmpeg не найден: установите его (apt/brew install ffmpeg)")
	}
	names := []string{"ffmpeg-master-latest-win64-gpl.zip"}
	if runtime.GOARCH == "arm64" {
		names = []string{"ffmpeg-master-latest-winarm64-gpl.zip", "ffmpeg-master-latest-win64-gpl.zip"}
	}
	var last error
	for _, host := range []string{"BtbN", "yt-dlp"} {
		for _, n := range names {
			zipPath := filepath.Join(appDir, "bin", "ffmpeg.zip")
			logf("скачиваю ffmpeg (%s/%s) …", host, n)
			if err := download("https://github.com/"+host+"/FFmpeg-Builds/releases/download/latest/"+n, zipPath); err != nil {
				last = err
				continue
			}
			dest := filepath.Join(appDir, "bin", "ffmpeg.exe")
			err := unzipFile(zipPath, "bin/ffmpeg.exe", dest)
			os.Remove(zipPath)
			if err != nil {
				last = err
				continue
			}
			logf("ffmpeg установлен: %s", dest)
			return dest, nil
		}
	}
	return "", fmt.Errorf("не удалось скачать ffmpeg: %v", last)
}

func unzipFile(zipPath, suffix, dest string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		if strings.HasSuffix(strings.ToLower(f.Name), suffix) {
			rc, err := f.Open()
			if err != nil {
				return err
			}
			defer rc.Close()
			out, err := os.Create(dest)
			if err != nil {
				return err
			}
			defer out.Close()
			_, err = io.Copy(out, rc)
			return err
		}
	}
	return errors.New("в архиве нет " + suffix)
}

func toolVersion(path string, arg string) string {
	if path == "" {
		return ""
	}
	cmd := exec.Command(path, arg)
	hide(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "?"
	}
	line := strings.SplitN(strings.TrimSpace(string(out)), "\n", 2)[0]
	return strings.TrimSpace(line)
}

// ---------- Anki ----------

func findAnki() string {
	if cfg.AnkiPath != "" {
		if _, err := os.Stat(cfg.AnkiPath); err == nil {
			return cfg.AnkiPath
		}
	}
	var cands []string
	switch runtime.GOOS {
	case "windows":
		cands = []string{
			filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "Anki", "anki.exe"),
			filepath.Join(os.Getenv("ProgramFiles"), "Anki", "anki.exe"),
			filepath.Join(os.Getenv("ProgramFiles(x86)"), "Anki", "anki.exe"),
		}
	case "darwin":
		cands = []string{"/Applications/Anki.app/Contents/MacOS/anki"}
	default:
		if p, err := exec.LookPath("anki"); err == nil {
			cands = []string{p}
		}
	}
	for _, c := range cands {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

func ankiConnectUp() (bool, string) {
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := client.Post("http://127.0.0.1:8765", "application/json", strings.NewReader(`{"action":"version","version":6}`))
	if err != nil {
		return false, ""
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return true, string(b)
}

func startAnki() error {
	if up, _ := ankiConnectUp(); up {
		return nil
	}
	p := findAnki()
	if p == "" {
		return errors.New("Anki не найден: укажите путь в config.json (ankiPath)")
	}
	cmd := exec.Command(p)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	logf("запускаю Anki: %s", p)
	return nil
}

// ---------- autostart (Windows Run key) ----------

const runKey = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

func autostartEnabled() bool {
	if runtime.GOOS != "windows" {
		return false
	}
	cmd := exec.Command("reg", "query", runKey, "/v", "YTAMLauncher")
	hide(cmd)
	return cmd.Run() == nil
}

func setAutostart(on bool) error {
	if runtime.GOOS != "windows" {
		return errors.New("автозапуск поддерживается только в Windows")
	}
	exe, _ := os.Executable()
	var cmd *exec.Cmd
	if on {
		cmd = exec.Command("reg", "add", runKey, "/v", "YTAMLauncher", "/t", "REG_SZ", "/d", `"`+exe+`" --background`, "/f")
	} else {
		cmd = exec.Command("reg", "delete", runKey, "/v", "YTAMLauncher", "/f")
	}
	hide(cmd)
	return cmd.Run()
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	hide(cmd)
	cmd.Start()
}
