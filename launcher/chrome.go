package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
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

// ---------- last watched video (reported by the extension) ----------

type lastVideo struct {
	ID    string  `json:"id"`
	T     float64 `json:"t"`
	Title string  `json:"title"`
	At    int64   `json:"at"`
}

var (
	last      lastVideo
	lastMu    sync.Mutex
	lastSaved time.Time
)

func statePath() string { return filepath.Join(appDir, "state.json") }

func loadLast() {
	b, err := os.ReadFile(statePath())
	if err != nil {
		return
	}
	lastMu.Lock()
	json.Unmarshal(b, &last)
	lastMu.Unlock()
}

// recordLast remembers where the user stopped. Disk writes are rate-limited.
func recordLast(id string, t float64, title string) {
	if !idRe.MatchString(id) {
		return
	}
	lastMu.Lock()
	defer lastMu.Unlock()
	if title == "" && last.ID == id {
		title = last.Title
	}
	last = lastVideo{ID: id, T: t, Title: title, At: time.Now().Unix()}
	if time.Since(lastSaved) < 4*time.Second {
		return
	}
	lastSaved = time.Now()
	b, _ := json.Marshal(last)
	os.WriteFile(statePath(), b, 0o644)
}

func lastCopy() lastVideo {
	lastMu.Lock()
	defer lastMu.Unlock()
	return last
}

// ---------- Chrome ----------

func chromeExe() string {
	if cfg.ChromePath != "" {
		if _, err := os.Stat(cfg.ChromePath); err == nil {
			return cfg.ChromePath
		}
	}
	var c []string
	switch runtime.GOOS {
	case "windows":
		c = []string{
			filepath.Join(os.Getenv("ProgramFiles"), "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(os.Getenv("ProgramFiles(x86)"), "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(os.Getenv("LOCALAPPDATA"), "Google", "Chrome", "Application", "chrome.exe"),
		}
	case "darwin":
		c = []string{"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
	default:
		for _, n := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser"} {
			if p, err := exec.LookPath(n); err == nil {
				c = append(c, p)
			}
		}
	}
	for _, p := range c {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func chromeUserData() string {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("LOCALAPPDATA"), "Google", "Chrome", "User Data")
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Google", "Chrome")
	}
	return filepath.Join(home, ".config", "google-chrome")
}

type chromeProfile struct {
	Dir   string `json:"dir"`
	Name  string `json:"name"`
	Email string `json:"email"`
	Last  bool   `json:"last"`
}

// chromeProfiles lists the profiles of the local Chrome ("Local State" → profile.info_cache).
func chromeProfiles() []chromeProfile {
	b, err := os.ReadFile(filepath.Join(chromeUserData(), "Local State"))
	if err != nil {
		return nil
	}
	var st struct {
		Profile struct {
			InfoCache map[string]struct {
				Name     string `json:"name"`
				UserName string `json:"user_name"`
			} `json:"info_cache"`
			LastUsed string `json:"last_used"`
		} `json:"profile"`
	}
	if json.Unmarshal(b, &st) != nil {
		return nil
	}
	var out []chromeProfile
	for dir, p := range st.Profile.InfoCache {
		out = append(out, chromeProfile{Dir: dir, Name: p.Name, Email: p.UserName, Last: dir == st.Profile.LastUsed})
	}
	sortProfiles(out)
	return out
}

func sortProfiles(p []chromeProfile) {
	for i := 1; i < len(p); i++ {
		for j := i; j > 0 && p[j].Dir < p[j-1].Dir; j-- {
			p[j], p[j-1] = p[j-1], p[j]
		}
	}
}

func chromeProfileDir() string {
	if cfg.ChromeProfile != "" {
		return cfg.ChromeProfile
	}
	for _, p := range chromeProfiles() {
		if p.Last {
			return p.Dir
		}
	}
	return "Default"
}

// chromeTarget is the page Chrome opens: the last video (at the second where it stopped), YouTube, or a custom URL.
func chromeTarget() string {
	switch cfg.ChromeMode {
	case "home":
		return "https://www.youtube.com/"
	case "custom":
		if u, err := url.Parse(cfg.ChromeURL); err == nil && (u.Scheme == "http" || u.Scheme == "https") {
			return cfg.ChromeURL
		}
	}
	l := lastCopy()
	if l.ID == "" {
		return "https://www.youtube.com/"
	}
	t := int(l.T) - 3 // a few seconds of run-up
	if t < 0 {
		t = 0
	}
	return fmt.Sprintf("https://www.youtube.com/watch?v=%s&t=%ds", l.ID, t)
}

var chromeOpenedAt time.Time

func openChrome() error {
	exe := chromeExe()
	if exe == "" {
		return errors.New("Chrome не найден: укажите путь в config.json (chromePath)")
	}
	if time.Since(chromeOpenedAt) < 3*time.Second { // a double click on the shortcut must not open two tabs
		return nil
	}
	chromeOpenedAt = time.Now()
	target := chromeTarget()
	args := []string{"--profile-directory=" + chromeProfileDir(), target}
	cmd := exec.Command(exe, args...)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	logf("открываю Chrome (%s): %s", chromeProfileDir(), target)
	return nil
}

// createShortcut puts "YouTube + Anki.lnk" on the desktop: it starts the launcher (if needed) and opens Chrome.
func createShortcut() (string, error) {
	if runtime.GOOS != "windows" {
		return "", errors.New("ярлык создаётся только в Windows")
	}
	exe, _ := os.Executable()
	icon := chromeExe()
	if icon == "" {
		icon = exe
	}
	q := func(s string) string { return strings.ReplaceAll(s, "'", "''") }
	script := fmt.Sprintf(`$d=[Environment]::GetFolderPath('Desktop');$p=Join-Path $d 'YouTube + Anki.lnk';`+
		`$s=(New-Object -ComObject WScript.Shell).CreateShortcut($p);$s.TargetPath='%s';$s.Arguments='--open';`+
		`$s.WorkingDirectory='%s';$s.WindowStyle=7;$s.IconLocation='%s,0';$s.Description='YouTube + Anki: лончер, Anki и Chrome';$s.Save();Write-Output $p`,
		q(exe), q(filepath.Dir(exe)), q(icon))
	cmd := exec.Command("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script)
	hide(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

// ---------- AnkiConnect port ----------

func ankiPorts() []int {
	ports := []int{cfg.AnkiPort}
	for _, p := range []int{8765, 18765, 28765} {
		if p != cfg.AnkiPort {
			ports = append(ports, p)
		}
	}
	return ports
}

// portDiag explains why a port cannot be used by AnkiConnect.
func portDiag(port int) map[string]any {
	res := map[string]any{"port": port, "state": "free"}
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err == nil {
		l.Close()
	} else {
		msg := strings.ToLower(err.Error())
		switch {
		case strings.Contains(msg, "access permissions") || strings.Contains(msg, "10013") || strings.Contains(msg, "permission denied") || strings.Contains(msg, "запрещ"):
			res["state"] = "blocked"
		case strings.Contains(msg, "already in use") || strings.Contains(msg, "10048") || strings.Contains(msg, "only one usage") || strings.Contains(msg, "занят") || strings.Contains(msg, "обычно разрешается"):
			res["state"] = "busy"
		default:
			res["state"] = "error"
			res["error"] = err.Error()
		}
	}
	if runtime.GOOS == "windows" {
		cmd := exec.Command("netsh", "interface", "ipv4", "show", "excludedportrange", "protocol=tcp")
		hide(cmd)
		if out, e := cmd.Output(); e == nil {
			re := regexp.MustCompile(`(?m)^\s*(\d+)\s+(\d+)`)
			for _, m := range re.FindAllStringSubmatch(string(out), -1) {
				a, _ := strconv.Atoi(m[1])
				b, _ := strconv.Atoi(m[2])
				if port >= a && port <= b {
					res["state"] = "blocked"
					res["excluded"] = fmt.Sprintf("%d–%d", a, b)
				}
			}
		}
	}
	return res
}

func ankiMetaPath() string {
	home, _ := os.UserHomeDir()
	var base string
	switch runtime.GOOS {
	case "windows":
		base = filepath.Join(os.Getenv("APPDATA"), "Anki2")
	case "darwin":
		base = filepath.Join(home, "Library", "Application Support", "Anki2")
	default:
		x := os.Getenv("XDG_DATA_HOME")
		if x == "" {
			x = filepath.Join(home, ".local", "share")
		}
		base = filepath.Join(x, "Anki2")
	}
	return filepath.Join(base, "addons21", "2055492159", "meta.json")
}

// fixAnkiPort moves AnkiConnect to a port Windows lets it use (writes webBindPort into the add-on's user config).
func fixAnkiPort(want int) (int, error) {
	meta := ankiMetaPath()
	dir := filepath.Dir(meta)
	if _, err := os.Stat(dir); err != nil {
		return 0, fmt.Errorf("AnkiConnect не найден (%s). Установите дополнение, код 2055492159", dir)
	}
	port := want
	if port == 0 {
		for _, p := range []int{18765, 28765, 38765, 48765} {
			if portDiag(p)["state"] == "free" {
				port = p
				break
			}
		}
	}
	if port == 0 {
		return 0, errors.New("не нашёл свободный порт")
	}
	m := map[string]any{}
	if b, err := os.ReadFile(meta); err == nil {
		json.Unmarshal(b, &m)
	}
	conf, _ := m["config"].(map[string]any)
	if conf == nil {
		conf = map[string]any{}
	}
	conf["webBindPort"] = port
	if _, ok := conf["webBindAddress"]; !ok {
		conf["webBindAddress"] = "127.0.0.1"
	}
	m["config"] = conf
	b, _ := json.MarshalIndent(m, "", "  ")
	if err := os.WriteFile(meta, b, 0o644); err != nil {
		return 0, err
	}
	cfg.AnkiPort = port
	saveConfig()
	logf("AnkiConnect: порт %d записан в %s — перезапустите Anki", port, meta)
	return port, nil
}

// restartAnki closes Anki gracefully (Windows) and starts it again.
func restartAnki() error {
	if runtime.GOOS == "windows" {
		cmd := exec.Command("taskkill", "/IM", "anki.exe")
		hide(cmd)
		cmd.Run()
		for i := 0; i < 40; i++ { // wait up to 10 s for it to close
			chk := exec.Command("tasklist", "/FI", "IMAGENAME eq anki.exe", "/NH")
			hide(chk)
			out, _ := chk.Output()
			if !strings.Contains(strings.ToLower(string(out)), "anki.exe") {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
	return startAnki()
}
