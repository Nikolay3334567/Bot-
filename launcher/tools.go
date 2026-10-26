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
	"sync"
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

// explicitDl: the user pressed a download button, so downloading is allowed even if autoDownload is off.
var explicitDl bool

// dlHook receives (bytes done, bytes total) while a download runs (used by the status page).
var dlHook func(done, total int64)

type progressReader struct {
	r           io.Reader
	done, total int64
	last        time.Time
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	p.done += int64(n)
	if dlHook != nil && (time.Since(p.last) > 150*time.Millisecond || err != nil) {
		p.last = time.Now()
		dlHook(p.done, p.total)
	}
	return n, err
}

func download(url, dest string) error {
	client := &http.Client{Timeout: 20 * time.Minute}
	var resp *http.Response
	var err error
	for attempt := 0; attempt < 3; attempt++ { // a flaky connection should not need a second click
		resp, err = client.Get(url)
		if err == nil && resp.StatusCode == 200 {
			break
		}
		if err == nil {
			err = fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
			resp.Body.Close()
			if resp.StatusCode == 404 {
				break
			}
		}
		time.Sleep(time.Duration(attempt+1) * 800 * time.Millisecond)
	}
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	tmp := dest + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, &progressReader{r: resp.Body, total: resp.ContentLength})
	f.Close()
	if err == nil && resp.ContentLength > 0 && n != resp.ContentLength {
		err = fmt.Errorf("скачано %d из %d байт", n, resp.ContentLength)
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	os.Remove(dest) // a running old copy cannot be replaced on Windows, but a stopped one can
	return os.Rename(tmp, dest)
}

func ensureYtdlp() (string, error) { return ensureYtdlpF(false) }

func workingYtdlp() string {
	for _, p := range findTools(cfg.YtdlpPath, "yt-dlp") {
		if toolWorks(p) {
			return p
		}
	}
	return ""
}

func workingFfmpeg() string {
	for _, p := range findTools(cfg.FfmpegPath, "ffmpeg") {
		if toolVersionRun(p, "-version") != "?" {
			return p
		}
	}
	return ""
}

func ensureYtdlpF(force bool) (string, error) {
	// Every yt-dlp* file found is test-run (--version); a build for the wrong CPU/Windows is skipped.
	for _, p := range findTools(cfg.YtdlpPath, "yt-dlp") {
		if force {
			break
		}
		if toolWorks(p) {
			return p, nil
		}
		logf("yt-dlp %s не запускается на этом ПК — пропускаю", p)
	}
	if !cfg.AutoDownload && !explicitDl {
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

func ensureFfmpeg() (string, error) { return ensureFfmpegF(false) }

func ensureFfmpegF(force bool) (string, error) {
	for _, p := range findTools(cfg.FfmpegPath, "ffmpeg") { // a broken / half-downloaded ffmpeg.exe is skipped
		if force {
			break
		}
		if toolVersionRun(p, "-version") != "?" {
			return p, nil
		}
		logf("ffmpeg %s не запускается — пропускаю", p)
	}
	if !cfg.AutoDownload && !explicitDl {
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

var (
	verCache = map[string]string{}
	verMu    sync.Mutex
)

// toolVersion runs `tool --version` once per path (the status page polls every 2 s).
func toolVersion(path string, arg string) string {
	if path == "" {
		return ""
	}
	verMu.Lock()
	v, ok := verCache[path+arg]
	verMu.Unlock()
	if ok && v != "?" {
		return v
	}
	v = toolVersionRun(path, arg)
	verMu.Lock()
	verCache[path+arg] = v
	verMu.Unlock()
	return v
}

func toolVersionRun(path string, arg string) string {
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

// ankiConnectUp asks AnkiConnect for its version on the configured port (and the usual alternatives).
func ankiConnectUp() (bool, string) {
	client := &http.Client{Timeout: 1200 * time.Millisecond}
	for _, port := range ankiPorts() {
		resp, err := client.Post(fmt.Sprintf("http://127.0.0.1:%d", port), "application/json", strings.NewReader(`{"action":"version","version":6}`))
		if err != nil {
			continue
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode == 200 {
			ankiLive = port
			return true, string(b)
		}
	}
	return false, ""
}

var ankiLive int // the port AnkiConnect answered on last time

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
