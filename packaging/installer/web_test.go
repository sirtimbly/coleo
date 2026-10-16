package main

import (
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWebOwnershipAndResources(t *testing.T) {
	f := newFixture(t)
	path := t.TempDir()
	if ldd, err := exec.LookPath("ldd"); err == nil {
		must(t, os.Symlink(ldd, filepath.Join(path, "ldd")))
	}
	t.Setenv("PATH", path)
	must(t, f.run("install", "web"))
	checkCommand(t, f, "coleo-web", "web-1.2.3")
	checkCommand(t, f, "coleo-client", "client-1.2.3")
	if _, ok := f.receipt(t).Packages["operator"]; ok {
		t.Fatal("web installed operator")
	}
	for _, name := range []string{"host.js", "index.html", "assets/app.js"} {
		_, err := os.Stat(filepath.Join(f.receipt(t).Packages["web"].Path, "payload", name))
		must(t, err)
	}
	must(t, f.run("install", "client"))
	must(t, f.run("uninstall", "client"))
	checkCommand(t, f, "coleo-web", "web-1.2.3")
	checkCommand(t, f, "coleo-client", "client-1.2.3")
	must(t, f.run("install", "client"))
	must(t, f.run("install", "tui"))
	must(t, f.run("install", "server"))
	must(t, f.run("upgrade", "web"))
	if !contains(f.receipt(t).Packages["client"].Roles, "tui") {
		t.Fatal("web upgrade lost TUI")
	}
	must(t, f.run("uninstall", "web"))
	checkCommand(t, f, "coleo-client", "client-1.2.3")
	checkCommand(t, f, "coleo-server", "server-1.2.3")
	if _, err := os.Stat(filepath.Join(f.prefix, "bin", "coleo-web")); !os.IsNotExist(err) {
		t.Fatal("web launcher retained")
	}
	if got := f.receipt(t).Packages["client"].Roles; len(got) != 2 {
		t.Fatal(got)
	}
}

func TestWebDependencyFailureRollsBack(t *testing.T) {
	f := newFixture(t)
	must(t, f.run("install", "web"))
	before := f.receipt(t)
	t.Setenv("COLEO_FIXTURE_FAIL", "yes")
	if err := f.run("upgrade", "web"); err == nil {
		t.Fatal("accepted failed client provisioning")
	}
	after := f.receipt(t)
	for _, name := range []string{"web", "client"} {
		if before.Packages[name].Path != after.Packages[name].Path {
			t.Fatal("changed receipt")
		}
	}
	checkCommand(t, f, "coleo-web", "web-1.2.3")
	t.Setenv("COLEO_FIXTURE_FAIL", "")
	must(t, f.run("uninstall", "web"))
	if len(f.receipt(t).Packages) != 0 {
		t.Fatal("unowned client retained")
	}
}

func TestInstalledRealWebHost(t *testing.T) {
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("Bun is required to build real host fixture")
	}
	bundle := filepath.Join(t.TempDir(), "host.js")
	build := exec.Command(bun, "build", "../../clients/web/host.ts", "--target=bun", "--outfile", bundle)
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %s: %v", out, err)
	}
	host, err := os.ReadFile(bundle)
	must(t, err)
	runtime, err := os.ReadFile(bun)
	must(t, err)
	f := newFixture(t)
	f.add(t, "bun", map[string]string{"bun": string(runtime)}, "", "bun")
	f.add(t, "web", map[string]string{"host.js": string(host), "index.html": "<html>installed web</html>", "assets/app.js": "installed asset"}, "bun", "")
	web := f.m.Components["web"]
	web.Dependencies = []string{"client"}
	f.m.Components["web"] = web
	must(t, f.run("install", "web"))
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	must(t, err)
	address := listener.Addr().String()
	must(t, listener.Close())
	_, port, err := net.SplitHostPort(address)
	must(t, err)
	cmd := exec.Command(filepath.Join(f.prefix, "bin", "coleo-web"), "--host", "127.0.0.1", "--port", port)
	cmd.Env = append(os.Environ(), "COLEO_API_URL=http://127.0.0.1:1")
	must(t, cmd.Start())
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	client := &http.Client{Timeout: time.Second}
	for attempt := 0; attempt < 100; attempt++ {
		response, e := client.Get("http://" + address + "/")
		if e == nil {
			body, e := io.ReadAll(response.Body)
			response.Body.Close()
			must(t, e)
			if !strings.Contains(string(body), "installed web") {
				t.Fatal(string(body))
			}
			asset, e := client.Get("http://" + address + "/assets/app.js")
			must(t, e)
			body, e = io.ReadAll(asset.Body)
			asset.Body.Close()
			must(t, e)
			if string(body) != "installed asset" {
				t.Fatal(string(body))
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("installed web host did not start")
}
