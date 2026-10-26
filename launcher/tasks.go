package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// A task is something the user started with a button (install tools, update yt-dlp, ...).
// The status page shows it while it runs and keeps its result, so a click is never "silent".
type task struct {
	Name     string  `json:"name"`
	State    string  `json:"state"` // running | done | error
	Msg      string  `json:"msg"`
	Progress float64 `json:"progress"` // 0..1 of the current download, -1 = unknown
	At       int64   `json:"at"`
}

var (
	tasksMu sync.Mutex
	tasks   = map[string]*task{}
)

func setMsg(t *task, msg string, p float64) {
	tasksMu.Lock()
	t.Msg, t.Progress = msg, p
	tasksMu.Unlock()
}

func tasksCopy() map[string]task {
	tasksMu.Lock()
	defer tasksMu.Unlock()
	out := map[string]task{}
	for k, v := range tasks {
		out[k] = *v
	}
	return out
}

// runTask starts fn in the background unless a task with this name is already running.
func runTask(name string, fn func(t *task) error) bool {
	tasksMu.Lock()
	if old := tasks[name]; old != nil && old.State == "running" {
		tasksMu.Unlock()
		return false
	}
	t := &task{Name: name, State: "running", Msg: "Запускаю…", Progress: -1, At: time.Now().Unix()}
	tasks[name] = t
	tasksMu.Unlock()
	go func() {
		err := fn(t)
		tasksMu.Lock()
		t.At = time.Now().Unix()
		t.Progress = -1
		if err != nil {
			t.State, t.Msg = "error", err.Error()
		} else {
			t.State = "done"
		}
		tasksMu.Unlock()
		if err != nil {
			logf("✗ %s: %v", name, err)
		} else {
			logf("✓ %s: %s", name, t.Msg)
		}
	}()
	return true
}

// withProgress runs a download-ish step and mirrors its byte counter into the task.
func withProgress(t *task, label string, step func() error) error {
	dlHook = func(done, total int64) {
		if total > 0 {
			setMsg(t, fmt.Sprintf("%s… %d%% (%d из %d МБ)", label, done*100/total, done>>20, total>>20), float64(done)/float64(total))
		} else {
			setMsg(t, fmt.Sprintf("%s… %d МБ", label, done>>20), -1)
		}
	}
	defer func() { dlHook = nil }()
	setMsg(t, label+"…", -1)
	return step()
}

// installTools checks yt-dlp and ffmpeg and downloads what is missing (or everything, when force).
func installTools(t *task, force bool) error {
	explicitDl = true
	defer func() { explicitDl = false }()
	var parts []string
	// yt-dlp
	if p := workingYtdlp(); p != "" && !force {
		parts = append(parts, "yt-dlp уже установлен ("+toolVersionRun(p, "--version")+")")
	} else {
		if err := withProgress(t, "Скачиваю yt-dlp", func() error { _, e := ensureYtdlpF(force); return e }); err != nil {
			return err
		}
		verMu.Lock()
		verCache = map[string]string{}
		verMu.Unlock()
		parts = append(parts, "yt-dlp скачан ("+toolVersionRun(workingYtdlp(), "--version")+")")
	}
	// ffmpeg
	if p := workingFfmpeg(); p != "" && !force {
		parts = append(parts, "ffmpeg уже установлен")
		_ = p
	} else {
		if err := withProgress(t, "Скачиваю ffmpeg (около 100 МБ)", func() error { _, e := ensureFfmpegF(force); return e }); err != nil {
			parts = append(parts, "ffmpeg: "+err.Error())
			setMsg(t, strings.Join(parts, " · "), -1)
			return err
		}
		parts = append(parts, "ffmpeg скачан")
	}
	setMsg(t, strings.Join(parts, " · "), -1)
	return nil
}

// updateYtdlp brings yt-dlp up to date: standalone copies update themselves; a copy installed some other way
// (pip, PATH) is replaced by a fresh one in the launcher's own bin folder, which is always preferred.
func updateYtdlp(t *task) error {
	explicitDl = true
	defer func() { explicitDl = false }()
	cur := workingYtdlp()
	old := ""
	if cur != "" {
		old = toolVersionRun(cur, "--version")
	}
	own := cur != "" && strings.HasPrefix(filepath.Clean(cur), filepath.Clean(appDir))
	if own {
		setMsg(t, "Обновляю yt-dlp (был "+old+")…", -1)
		cmd := exec.Command(cur, "-U")
		hide(cmd)
		out, err := cmd.CombinedOutput()
		line := lastLine(string(out))
		verMu.Lock()
		verCache = map[string]string{}
		verMu.Unlock()
		nv := toolVersionRun(cur, "--version")
		if err == nil && nv != "?" {
			if nv == old {
				setMsg(t, "yt-dlp уже последней версии ("+nv+")", -1)
			} else {
				setMsg(t, "yt-dlp обновлён: "+old+" → "+nv, -1)
			}
			return nil
		}
		logf("yt-dlp -U: %s (%v) — скачиваю заново", line, err)
	}
	if err := withProgress(t, "Скачиваю свежий yt-dlp", func() error { _, e := ensureYtdlpF(true); return e }); err != nil {
		return err
	}
	verMu.Lock()
	verCache = map[string]string{}
	verMu.Unlock()
	setMsg(t, "yt-dlp обновлён: "+old+" → "+toolVersionRun(workingYtdlp(), "--version"), -1)
	return nil
}

func lastLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndex(s, "\n"); i >= 0 {
		return strings.TrimSpace(s[i+1:])
	}
	return s
}

// ---------- yt-dlp upkeep: YouTube changes every few weeks, an old yt-dlp simply stops working ----------

var ytdlpDateRe = regexp.MustCompile(`(\d{4})\.(\d{1,2})\.(\d{1,2})`)

func ytdlpDate(ver string) time.Time {
	m := ytdlpDateRe.FindStringSubmatch(ver)
	if m == nil {
		return time.Time{}
	}
	y, _ := strconv.Atoi(m[1])
	mo, _ := strconv.Atoi(m[2])
	d, _ := strconv.Atoi(m[3])
	return time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.UTC)
}

func ytdlpOutdated(path string) bool {
	d := ytdlpDate(toolVersion(path, "--version"))
	return !d.IsZero() && time.Since(d) > 45*24*time.Hour
}

var (
	autoUpdMu   sync.Mutex
	lastAutoUpd time.Time
)

// autoUpdateYtdlp replaces an old / broken yt-dlp by a fresh copy (at most every 20 minutes).
// Returns true when something new was installed, so the failed download is worth retrying.
func autoUpdateYtdlp(reason string) bool {
	if cfg.YtdlpPath != "" || (!cfg.AutoDownload && !explicitDl) {
		return false
	}
	autoUpdMu.Lock()
	if time.Since(lastAutoUpd) < 20*time.Minute {
		autoUpdMu.Unlock()
		return false
	}
	lastAutoUpd = time.Now()
	autoUpdMu.Unlock()
	cur := workingYtdlp()
	old := ""
	if cur != "" {
		old = toolVersionRun(cur, "--version")
	}
	logf("yt-dlp: %s — скачиваю свежую версию (была %s)", reason, old)
	explicitDl = true
	defer func() { explicitDl = false }()
	if _, err := ensureYtdlpF(true); err != nil {
		logf("✗ не удалось обновить yt-dlp: %v", err)
		return false
	}
	verMu.Lock()
	verCache = map[string]string{}
	verMu.Unlock()
	nv := toolVersionRun(workingYtdlp(), "--version")
	logf("✓ yt-dlp: %s → %s", old, nv)
	return nv != old
}

func denoPath() string {
	for _, d := range []string{filepath.Join(appDir, "bin"), appDir} {
		p := filepath.Join(d, exeName("deno"))
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	if p, err := exec.LookPath("deno"); err == nil {
		return p
	}
	return ""
}

// ensureDeno downloads the Deno JavaScript runtime that yt-dlp needs to solve YouTube's challenges.
func ensureDeno() (string, error) {
	if p := denoPath(); p != "" {
		return p, nil
	}
	if !cfg.AutoDownload && !explicitDl {
		return "", errors.New("Deno не найден (нужен yt-dlp для YouTube); включите автоскачивание в настройках лончера")
	}
	arch := map[string]string{"amd64": "x86_64", "arm64": "aarch64"}[runtime.GOARCH]
	var asset string
	switch runtime.GOOS {
	case "windows":
		asset = "deno-" + arch + "-pc-windows-msvc.zip"
	case "darwin":
		asset = "deno-" + arch + "-apple-darwin.zip"
	default:
		asset = "deno-" + arch + "-unknown-linux-gnu.zip"
	}
	zipPath := filepath.Join(appDir, "bin", "deno.zip")
	logf("скачиваю Deno (%s) …", asset)
	if err := download("https://github.com/denoland/deno/releases/latest/download/"+asset, zipPath); err != nil {
		return "", fmt.Errorf("не удалось скачать Deno: %v", err)
	}
	defer os.Remove(zipPath)
	dest := filepath.Join(appDir, "bin", exeName("deno"))
	if err := unzipFile(zipPath, exeName("deno"), dest); err != nil {
		return "", err
	}
	os.Chmod(dest, 0o755)
	logf("✓ Deno установлен: %s", dest)
	return dest, nil
}
