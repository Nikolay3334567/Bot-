// YT -> Anki Miner launcher: a small local helper for the browser extension.
//
//   - downloads a video's audio once with yt-dlp and cuts exact clips with ffmpeg
//   - starts Anki (AnkiConnect must be installed) and can start with Windows
//   - serves a status page at http://127.0.0.1:8766/
//
// Standard library only. Build: see build.sh / README.
package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed status.html
var assets embed.FS

type Config struct {
	Port         int      `json:"port"`
	LaunchAnki   bool     `json:"launchAnki"`
	AnkiPath     string   `json:"ankiPath"`
	AutoDownload bool     `json:"autoDownload"`
	YtdlpPath    string   `json:"ytdlpPath"`
	FfmpegPath   string   `json:"ffmpegPath"`
	YtdlpArgs    []string `json:"ytdlpArgs"`
	KeepFiles    int      `json:"keepFiles"`
	OpenStatus   bool     `json:"openStatusPage"`
}

var (
	cfg     = Config{Port: 8766, LaunchAnki: true, AutoDownload: true, KeepFiles: 40, OpenStatus: true}
	appDir  string
	cache   string
	logMu   sync.Mutex
	logBuf  []string
	logFile *os.File
)

func logf(format string, a ...any) {
	line := time.Now().Format("15:04:05 ") + fmt.Sprintf(format, a...)
	logMu.Lock()
	logBuf = append(logBuf, line)
	if len(logBuf) > 200 {
		logBuf = logBuf[len(logBuf)-200:]
	}
	if logFile != nil {
		fmt.Fprintln(logFile, line)
	}
	logMu.Unlock()
	fmt.Println(line)
}

func loadConfig() {
	path := filepath.Join(appDir, "config.json")
	b, err := os.ReadFile(path)
	if err == nil {
		json.Unmarshal(b, &cfg)
	} else {
		saveConfig() // write defaults so the user can edit them
	}
	if v := os.Getenv("YTAM_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.Port = n
		}
	}
	if v := os.Getenv("YTAM_YTDLP"); v != "" {
		cfg.YtdlpPath = v
	}
	if v := os.Getenv("YTAM_FFMPEG"); v != "" {
		cfg.FfmpegPath = v
	}
}

func saveConfig() {
	b, _ := json.MarshalIndent(cfg, "", "  ")
	os.WriteFile(filepath.Join(appDir, "config.json"), b, 0o644)
}

// ---------- audio jobs ----------

var idRe = regexp.MustCompile(`^[A-Za-z0-9_-]{6,20}$`)

type job struct {
	State    string  `json:"state"` // downloading | ready | error
	Progress float64 `json:"progress"`
	Error    string  `json:"error"`
	file     string
	failedAt time.Time
	done     chan struct{}
}

var (
	jobs   = map[string]*job{}
	jobsMu sync.Mutex
)

func cachedFile(id string) string {
	entries, _ := os.ReadDir(cache)
	for _, e := range entries {
		n := e.Name()
		if strings.HasPrefix(n, id+".") && !strings.HasSuffix(n, ".part") && !strings.HasSuffix(n, ".ytdl") && !strings.HasSuffix(n, ".temp") {
			return filepath.Join(cache, n)
		}
	}
	return ""
}

func prepare(id string) *job {
	jobsMu.Lock()
	defer jobsMu.Unlock()
	if j, ok := jobs[id]; ok {
		if j.State == "downloading" {
			return j
		}
		// After a failure wait before trying again (the extension asks for every card).
		if j.State == "error" && time.Since(j.failedAt) < 60*time.Second {
			return j
		}
		if j.State == "ready" {
			if _, err := os.Stat(j.file); err == nil {
				return j
			}
		}
	}
	if f := cachedFile(id); f != "" {
		j := &job{State: "ready", Progress: 1, file: f, done: make(chan struct{})}
		close(j.done)
		jobs[id] = j
		os.Chtimes(f, time.Now(), time.Now())
		return j
	}
	j := &job{State: "downloading", done: make(chan struct{})}
	jobs[id] = j
	go runDownload(id, j)
	return j
}

var pctRe = regexp.MustCompile(`(\d+(?:\.\d+)?)%`)

func runDownload(id string, j *job) {
	defer close(j.done)
	fail := func(msg string) {
		j.State, j.Error, j.failedAt = "error", msg, time.Now()
		logf("✗ %s: %s", id, msg)
	}
	ytdlp, err := ensureYtdlp()
	if err != nil {
		fail(err.Error())
		return
	}
	ffmpeg, _ := ensureFfmpeg()
	args := []string{"-f", "bestaudio[ext=m4a]/bestaudio/best", "-o", filepath.Join(cache, "%(id)s.%(ext)s"),
		"--no-playlist", "--no-warnings", "--newline", "--retries", "5", "--fragment-retries", "5"}
	if ffmpeg != "" {
		args = append(args, "--ffmpeg-location", ffmpeg)
	}
	args = append(args, cfg.YtdlpArgs...)
	args = append(args, "https://www.youtube.com/watch?v="+id)
	logf("↓ %s", id)
	cmd := exec.Command(ytdlp, args...)
	hide(cmd)
	stdout, _ := cmd.StdoutPipe()
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		fail(err.Error())
		return
	}
	buf := make([]byte, 4096)
	for {
		n, err := stdout.Read(buf)
		if n > 0 {
			if m := pctRe.FindAllStringSubmatch(string(buf[:n]), -1); len(m) > 0 {
				if p, e := strconv.ParseFloat(m[len(m)-1][1], 64); e == nil {
					j.Progress = p / 100
				}
			}
		}
		if err != nil {
			break
		}
	}
	if err := cmd.Wait(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		if i := strings.LastIndex(msg, "ERROR:"); i >= 0 {
			msg = msg[i:]
		}
		if strings.Contains(strings.ToLower(msg), "javascript runtime") || strings.Contains(strings.ToLower(msg), "n challenge") {
			msg += " — установите Deno (winget install DenoLand.Deno) и перезапустите лончер"
		}
		fail(msg)
		return
	}
	f := cachedFile(id)
	if f == "" {
		fail("yt-dlp завершился без файла")
		return
	}
	j.file, j.State, j.Progress = f, "ready", 1
	logf("✓ %s готово (%s)", id, filepath.Base(f))
	cleanup()
}

func cleanup() {
	entries, _ := os.ReadDir(cache)
	type fi struct {
		p string
		t time.Time
	}
	var files []fi
	for _, e := range entries {
		if info, err := e.Info(); err == nil && !e.IsDir() {
			files = append(files, fi{filepath.Join(cache, e.Name()), info.ModTime()})
		}
	}
	sort.Slice(files, func(a, b int) bool { return files[a].t.After(files[b].t) })
	for i := cfg.KeepFiles; i < len(files); i++ {
		os.Remove(files[i].p)
	}
}

func cutPCM(file string, start, end float64, rate int) ([]byte, error) {
	ffmpeg, err := ensureFfmpeg()
	if err != nil {
		return nil, err
	}
	if start < 0 {
		start = 0
	}
	dur := end - start
	if dur < 0.05 {
		dur = 0.05
	}
	cmd := exec.Command(ffmpeg, "-nostdin", "-loglevel", "error", "-ss", fmt.Sprintf("%.3f", start), "-i", file,
		"-t", fmt.Sprintf("%.3f", dur), "-vn", "-ac", "1", "-ar", strconv.Itoa(rate), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1")
	hide(cmd)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("ffmpeg: %s", strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

// ---------- HTTP ----------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

// hostOK blocks DNS-rebinding: only 127.0.0.1 / localhost Host headers are served.
func hostOK(r *http.Request) bool {
	h, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		h = r.Host
	}
	return h == "127.0.0.1" || h == "localhost" || h == "[::1]"
}

func status() map[string]any {
	yt := findTool(cfg.YtdlpPath, "yt-dlp")
	ff := findTool(cfg.FfmpegPath, "ffmpeg")
	up, _ := ankiConnectUp()
	jobsMu.Lock()
	var active []map[string]any
	for id, j := range jobs {
		active = append(active, map[string]any{"id": id, "state": j.State, "progress": j.Progress, "error": j.Error})
	}
	jobsMu.Unlock()
	entries, _ := os.ReadDir(cache)
	var size int64
	for _, e := range entries {
		if i, err := e.Info(); err == nil {
			size += i.Size()
		}
	}
	logMu.Lock()
	lines := append([]string(nil), logBuf...)
	logMu.Unlock()
	return map[string]any{
		"ok": true, "os": runtime.GOOS + "/" + runtime.GOARCH,
		"ytdlp": yt, "ytdlpVersion": toolVersion(yt, "--version"),
		"ffmpeg": ff, "ffmpegVersion": toolVersion(ff, "-version"),
		"ankiConnect": up, "ankiPath": findAnki(),
		"autostart": autostartEnabled(), "config": cfg, "cache": cache, "cacheMB": size / 1024 / 1024,
		"jobs": active, "log": lines,
	}
}

func api(w http.ResponseWriter, r *http.Request) {
	// Mutating endpoints: same origin only, custom header (blocks cross-site requests).
	if r.Method == http.MethodPost && (r.Header.Get("X-YTAM") != "1" || (r.Header.Get("Origin") != "" && !strings.Contains(r.Header.Get("Origin"), r.Host))) {
		writeJSON(w, 403, map[string]string{"error": "forbidden"})
		return
	}
	switch strings.TrimPrefix(r.URL.Path, "/api/") {
	case "status":
		writeJSON(w, 200, status())
	case "install":
		go func() {
			if _, err := ensureYtdlp(); err != nil {
				logf("✗ %v", err)
			}
			if _, err := ensureFfmpeg(); err != nil {
				logf("✗ %v", err)
			}
		}()
		writeJSON(w, 200, map[string]bool{"ok": true})
	case "update-ytdlp":
		go func() {
			yt := findTool(cfg.YtdlpPath, "yt-dlp")
			if yt == "" {
				logf("yt-dlp не найден")
				return
			}
			logf("обновляю yt-dlp …")
			cmd := exec.Command(yt, "-U")
			hide(cmd)
			out, err := cmd.CombinedOutput()
			logf("yt-dlp -U: %s (%v)", strings.TrimSpace(string(out)), err)
		}()
		writeJSON(w, 200, map[string]bool{"ok": true})
	case "start-anki":
		if err := startAnki(); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	case "autostart":
		on := r.URL.Query().Get("on") == "1"
		if err := setAutostart(on); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	case "config":
		var nc Config
		b, _ := io.ReadAll(io.LimitReader(r.Body, 1<<16))
		if err := json.Unmarshal(b, &nc); err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		nc.Port = cfg.Port // port changes need a restart; edit config.json
		cfg = nc
		saveConfig()
		writeJSON(w, 200, map[string]bool{"ok": true})
	case "clear-cache":
		entries, _ := os.ReadDir(cache)
		for _, e := range entries {
			os.Remove(filepath.Join(cache, e.Name()))
		}
		jobsMu.Lock()
		jobs = map[string]*job{}
		jobsMu.Unlock()
		writeJSON(w, 200, map[string]bool{"ok": true})
	case "quit":
		writeJSON(w, 200, map[string]bool{"ok": true})
		go func() { time.Sleep(200 * time.Millisecond); os.Exit(0) }()
	default:
		writeJSON(w, 404, map[string]string{"error": "unknown"})
	}
}

func handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		b, _ := assets.ReadFile("status.html")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(b)
	})
	// Local copy of the website (site/ folder next to the launcher or one level up).
	for _, d := range []string{filepath.Join(appDir, "site"), filepath.Join(appDir, "..", "site")} {
		if st, err := os.Stat(d); err == nil && st.IsDir() {
			mux.Handle("/site/", http.StripPrefix("/site/", http.FileServer(http.Dir(d))))
			break
		}
	}
	mux.HandleFunc("/ping", func(w http.ResponseWriter, r *http.Request) {
		s := status()
		writeJSON(w, 200, map[string]any{"ok": true, "ytdlp": s["ytdlpVersion"], "ffmpeg": s["ffmpeg"] != "", "ankiConnect": s["ankiConnect"], "cache": cache})
	})
	mux.HandleFunc("/prepare", func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("v")
		if !idRe.MatchString(id) {
			writeJSON(w, 400, map[string]string{"error": "bad video id"})
			return
		}
		j := prepare(id)
		writeJSON(w, 200, map[string]any{"state": j.State, "progress": j.Progress, "error": j.Error})
	})
	mux.HandleFunc("/pcm", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		id := q.Get("v")
		if !idRe.MatchString(id) {
			writeJSON(w, 400, map[string]string{"error": "bad video id"})
			return
		}
		start, e1 := strconv.ParseFloat(q.Get("start"), 64)
		end, e2 := strconv.ParseFloat(q.Get("end"), 64)
		if e1 != nil || e2 != nil {
			writeJSON(w, 400, map[string]string{"error": "bad range"})
			return
		}
		rate, _ := strconv.Atoi(q.Get("rate"))
		if rate < 8000 || rate > 48000 {
			rate = 24000
		}
		j := prepare(id)
		wait := 180 * time.Second
		if v, err := strconv.ParseFloat(q.Get("wait"), 64); err == nil {
			wait = time.Duration(v * float64(time.Second))
		}
		select {
		case <-j.done:
		case <-time.After(wait):
		}
		if j.State != "ready" {
			msg := j.Error
			if msg == "" {
				msg = "audio is still downloading"
			}
			writeJSON(w, 503, map[string]string{"error": msg})
			return
		}
		pcm, err := cutPCM(j.file, start, end, rate)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(pcm)
	})
	mux.HandleFunc("/api/", api)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !hostOK(r) {
			http.Error(w, "forbidden", 403)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func main() {
	exe, _ := os.Executable()
	appDir = filepath.Dir(exe)
	if v := os.Getenv("YTAM_DIR"); v != "" {
		appDir = v
	}
	background := false
	for _, a := range os.Args[1:] {
		switch a {
		case "--background":
			background = true
		case "--install-autostart":
			fmt.Println("autostart:", setAutostart(true))
			return
		case "--remove-autostart":
			fmt.Println("autostart:", setAutostart(false))
			return
		}
	}
	loadConfig()
	cache = filepath.Join(appDir, "cache")
	os.MkdirAll(cache, 0o755)
	logFile, _ = os.OpenFile(filepath.Join(appDir, "launcher.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)

	addr := fmt.Sprintf("127.0.0.1:%d", cfg.Port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		// Already running: just show its status page.
		openBrowser("http://" + addr + "/")
		return
	}
	logf("YT → Anki launcher on http://%s  (%s/%s)", addr, runtime.GOOS, runtime.GOARCH)
	if cfg.LaunchAnki {
		go func() {
			if err := startAnki(); err != nil {
				logf("Anki: %v", err)
			}
		}()
	}
	if cfg.AutoDownload {
		go func() { // fetch missing tools in the background so the first video is fast
			if _, err := ensureYtdlp(); err != nil {
				logf("✗ %v", err)
			}
			if _, err := ensureFfmpeg(); err != nil {
				logf("✗ %v", err)
			}
		}()
	}
	if cfg.OpenStatus && !background {
		go func() { time.Sleep(600 * time.Millisecond); openBrowser("http://" + addr + "/") }()
	}
	if err := http.Serve(ln, handler()); err != nil {
		logf("server: %v", err)
	}
}
