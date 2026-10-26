package main

import (
	"fmt"
	"os/exec"
	"path/filepath"
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
