package main

import (
	"bufio"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Speech-band loudness of a whole video, computed once from the downloaded audio.
//
// The extension uses it to find where the speech of every phrase really ends BEFORE the video gets there, so it
// never has to listen to the playing video (no capture, no extra audio graph, nothing that can crackle).
// One byte per 10 ms: round(level_dB * 2.5), level = 10*log10(mean(y^2)+1) of the band-passed 16-bit signal —
// the same scale the extension's own live detector used.

const (
	envRate  = 16000
	envFrame = envRate / 100 // 10 ms
)

type biq struct{ b0, b1, b2, a1, a2, x1, x2, y1, y2 float64 }

func newBiquad(hp bool, fc, fs float64) *biq {
	q := 0.7071
	w := 2 * math.Pi * fc / fs
	c, al := math.Cos(w), math.Sin(w)/(2*q)
	var b0, b1 float64
	if hp {
		b0, b1 = (1+c)/2, -(1 + c)
	} else {
		b0, b1 = (1-c)/2, 1-c
	}
	a0 := 1 + al
	return &biq{b0: b0 / a0, b1: b1 / a0, b2: b0 / a0, a1: -2 * c / a0, a2: (1 - al) / a0}
}

func (f *biq) step(x float64) float64 {
	y := f.b0*x + f.b1*f.x1 + f.b2*f.x2 - f.a1*f.y1 - f.a2*f.y2
	f.x2, f.x1, f.y2, f.y1 = f.x1, x, f.y1, y
	return y
}

func envDir() string {
	d := filepath.Join(cache, "env")
	os.MkdirAll(d, 0o755)
	return d
}

var (
	envMu    sync.Mutex
	envBuild = map[string]chan struct{}{} // file → done (one computation per video at a time)
)

// envelope returns the loudness curve of the audio file (cached on disk next to the audio).
func envelope(id, file string, lo, hi int) ([]byte, error) {
	name := filepath.Join(envDir(), fmt.Sprintf("%s_%d_%d.bin", id, lo, hi))
	if b, err := os.ReadFile(name); err == nil && len(b) > 0 {
		return b, nil
	}
	envMu.Lock()
	if ch, ok := envBuild[name]; ok {
		envMu.Unlock()
		<-ch
		return os.ReadFile(name)
	}
	ch := make(chan struct{})
	envBuild[name] = ch
	envMu.Unlock()
	defer func() {
		envMu.Lock()
		delete(envBuild, name)
		envMu.Unlock()
		close(ch)
	}()

	t0 := time.Now()
	b, err := computeEnvelope(file, float64(lo), float64(hi))
	if err != nil {
		return nil, err
	}
	tmp := name + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		os.Rename(tmp, name)
	}
	logf("≈ огибающая звука %s: %d отсчётов за %.1f с", id, len(b), time.Since(t0).Seconds())
	cleanupEnv()
	return b, nil
}

func computeEnvelope(file string, lo, hi float64) ([]byte, error) {
	ffmpeg, err := ensureFfmpeg()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(ffmpeg, "-nostdin", "-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-ar", fmt.Sprint(envRate),
		"-f", "s16le", "-acodec", "pcm_s16le", "pipe:1")
	hide(cmd)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	fs := float64(envRate)
	filters := []*biq{newBiquad(true, lo, fs), newBiquad(true, lo, fs), newBiquad(false, math.Min(hi, fs*0.45), fs)}
	r := bufio.NewReaderSize(stdout, 1<<16)
	buf := make([]byte, envFrame*2)
	var out []byte
	for {
		if _, err := io.ReadFull(r, buf); err != nil {
			break
		}
		var e float64
		for i := 0; i < envFrame; i++ {
			x := float64(int16(uint16(buf[2*i]) | uint16(buf[2*i+1])<<8))
			for _, f := range filters {
				x = f.step(x)
			}
			e += x * x
		}
		lvl := 10 * math.Log10(e/envFrame+1)
		v := math.Round(lvl * 2.5)
		if v > 255 {
			v = 255
		}
		out = append(out, byte(v))
	}
	io.Copy(io.Discard, r)
	if err := cmd.Wait(); err != nil && len(out) == 0 {
		return nil, fmt.Errorf("ffmpeg: %s", strings.TrimSpace(stderr.String()))
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("в аудио нет звука")
	}
	return out, nil
}

// cleanupEnv keeps the newest 200 curves.
func cleanupEnv() {
	entries, _ := os.ReadDir(envDir())
	type fi struct {
		p string
		t time.Time
	}
	var files []fi
	for _, e := range entries {
		if info, err := e.Info(); err == nil && !e.IsDir() {
			files = append(files, fi{filepath.Join(envDir(), e.Name()), info.ModTime()})
		}
	}
	if len(files) <= 200 {
		return
	}
	sort.Slice(files, func(a, b int) bool { return files[a].t.After(files[b].t) })
	for _, f := range files[200:] {
		os.Remove(f.p)
	}
}
