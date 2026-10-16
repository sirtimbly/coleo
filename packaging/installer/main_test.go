package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func archive(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Size: int64(len(body)), Mode: 0755}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

type fixture struct {
	m           Manifest
	data        map[string][]byte
	url, prefix string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("COLEO_INSTALL_TEST_HTTP", "1")
	f := &fixture{m: Manifest{SchemaVersion: 1, Version: "1.2.3", Commit: strings.Repeat("a", 40), Components: map[string]Component{}}, data: map[string][]byte{}, prefix: filepath.Join(t.TempDir(), "prefix with ' quotes")}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/manifest" {
			json.NewEncoder(w).Encode(f.m)
			return
		}
		if b, ok := f.data[r.URL.Path]; ok {
			w.Write(b)
		} else {
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	f.url = server.URL
	f.add(t, "operator", map[string]string{"dist/index.js": "echo legacy\n", "dist/server.js": "echo server-1.2.3\n", "dist/agent.js": "echo agent-1.2.3\n"}, "bun", "")
	f.add(t, "bun", map[string]string{"bin/bun": "#!/bin/sh\nexec /bin/sh \"$@\"\n"}, "", "bin/bun")
	f.add(t, "client", map[string]string{"coleo_inbox-1.2.3-py3-none-any.whl": "fixture", "constraints.txt": "rich==14.2.0\n", "wheels/example.whl": "fixture"}, "uv", "")
	c := f.m.Components["client"]
	c.Python = "3.12.12"
	c.Wheel = "coleo_inbox-1.2.3-py3-none-any.whl"
	f.m.Components["client"] = c
	f.add(t, "uv", map[string]string{"uv": "#!/bin/sh\nset -eu\n[ \"${COLEO_FIXTURE_FAIL:-}\" != yes ] || exit 1\n/bin/mkdir -p \"$UV_PYTHON_INSTALL_DIR\" \"$UV_TOOL_BIN_DIR\"\nprintf '%s\\n' \"$*\" >> \"$UV_PYTHON_INSTALL_DIR/invocations\"\nif [ \"$1\" = tool ]; then\n  for name in coleo-client coleo-inbox; do\n    printf '#!/bin/sh\\necho client-1.2.3\\n' > \"$UV_TOOL_BIN_DIR/$name\"\n    /bin/chmod +x \"$UV_TOOL_BIN_DIR/$name\"\n  done\nfi\n"}, "", "uv")
	f.add(t, "web", map[string]string{"index.html": "<html>fixture</html>", "host.js": "echo web-1.2.3\n", "assets/app.js": "fixture"}, "bun", "")
	web := f.m.Components["web"]
	web.Dependencies = []string{"client"}
	f.m.Components["web"] = web
	return f
}
func (f *fixture) add(t *testing.T, name string, files map[string]string, rt, entry string) {
	b := archive(t, files)
	f.data["/"+name] = b
	hash := sha256.Sum256(b)
	f.m.Components[name] = Component{Version: "1.2.3", Runtime: rt, Compatibility: map[string]any{"testedServer": "1.2.3", "requiredCapabilities": []string{}}, Artifacts: map[string]Artifact{"any": {URL: f.url + "/" + name, SHA256: hex.EncodeToString(hash[:]), Size: int64(len(b)), Format: "tar.gz", Entry: entry}}}
}
func (f *fixture) run(args ...string) error {
	return run(append(args, "--prefix", f.prefix, "--manifest", f.url+"/manifest", "--version", "1.2.3"))
}
func (f *fixture) receipt(t *testing.T) Receipt {
	t.Helper()
	r, err := receipt(filepath.Join(f.prefix, "lib", "coleo"))
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func checkCommand(t *testing.T, f *fixture, name, want string) {
	t.Helper()
	b, err := exec.Command(filepath.Join(f.prefix, "bin", name), "--version").CombinedOutput()
	if err != nil || strings.TrimSpace(string(b)) != want {
		t.Fatalf("%s = %q, %v", name, b, err)
	}
}
func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestServerAndAgentSharedOwnership(t *testing.T) {
	f := newFixture(t)
	must(t, f.run()) // legacy invocation is server-only
	checkCommand(t, f, "coleo-server", "server-1.2.3")
	if _, err := os.Stat(filepath.Join(f.prefix, "bin", "coleo-client")); !os.IsNotExist(err) {
		t.Fatal("installed a client")
	}
	must(t, f.run("install", "agent"))
	r := f.receipt(t)
	if len(r.Packages["operator"].Roles) != 2 {
		t.Fatal(r)
	}
	must(t, f.run("uninstall", "server"))
	checkCommand(t, f, "coleo-agent", "agent-1.2.3")
	if _, err := os.Stat(filepath.Join(f.prefix, "bin", "coleo-server")); !os.IsNotExist(err) {
		t.Fatal("server still linked")
	}
	must(t, f.run("uninstall", "agent"))
	if len(f.receipt(t).Packages) != 0 {
		t.Fatal("package retained")
	}
}
func TestClientTUIAndManagedRuntime(t *testing.T) {
	f := newFixture(t)
	// No ambient Bun, Python, or uv. Only ldd is available for the Linux platform check.
	path := t.TempDir()
	if ldd, err := exec.LookPath("ldd"); err == nil {
		must(t, os.Symlink(ldd, filepath.Join(path, "ldd")))
	}
	t.Setenv("PATH", path)
	must(t, f.run("install", "client"))
	checkCommand(t, f, "coleo-client", "client-1.2.3")
	first := f.receipt(t).Packages["client"].Path
	log, err := os.ReadFile(filepath.Join(first, "python", "invocations"))
	must(t, err)
	if !strings.Contains(string(log), "python install --no-bin 3.12.12") || strings.Contains(string(log), "[tui]") {
		t.Fatal(string(log))
	}
	if !strings.Contains(string(log), "coleo-inbox @ file://") || !strings.Contains(string(log), "prefix%20with") {
		t.Fatal("wheel requirement must use a URL-escaped path")
	}
	must(t, f.run("install", "tui"))
	must(t, f.run("upgrade", "client"))
	pkg := f.receipt(t).Packages["client"]
	log, err = os.ReadFile(filepath.Join(pkg.Path, "python", "invocations"))
	must(t, err)
	if !strings.Contains(string(log), "[tui]") || len(pkg.Roles) != 2 {
		t.Fatal("client upgrade lost TUI")
	}
	must(t, f.run("uninstall", "client"))
	checkCommand(t, f, "coleo-inbox", "client-1.2.3")
	must(t, f.run("uninstall", "tui"))
	if _, err = os.Stat(pkg.Path); !os.IsNotExist(err) {
		t.Fatal("unowned runtime retained")
	}
}
func TestRollbackFailuresAndReinstall(t *testing.T) {
	f := newFixture(t)
	must(t, f.run("install", "client"))
	before := f.receipt(t).Packages["client"].Path
	t.Setenv("COLEO_FIXTURE_FAIL", "yes")
	if err := f.run("upgrade", "client"); err == nil {
		t.Fatal("expected runtime install failure")
	}
	if f.receipt(t).Packages["client"].Path != before {
		t.Fatal("changed receipt")
	}
	checkCommand(t, f, "coleo-client", "client-1.2.3")
	t.Setenv("COLEO_FIXTURE_FAIL", "")
	f.data["/client"] = []byte("corrupt")
	if err := f.run("upgrade", "client"); err == nil {
		t.Fatal("expected checksum failure")
	}
	checkCommand(t, f, "coleo-client", "client-1.2.3")
	delete(f.data, "/client")
	if err := f.run("upgrade", "client"); err == nil {
		t.Fatal("expected 404 failure")
	}
}
func TestDryRunAndPreservation(t *testing.T) {
	f := newFixture(t)
	must(t, f.run("install", "web", "--dry-run"))
	if _, err := os.Stat(f.prefix); !os.IsNotExist(err) {
		t.Fatal("dry-run wrote prefix")
	}
	config := filepath.Join(os.Getenv("HOME"), ".coleo")
	must(t, os.MkdirAll(config, 0700))
	must(t, os.WriteFile(filepath.Join(config, "config"), []byte("secret"), 0600))
	must(t, f.run("install", "web", "--api-url", "https://coleo.example"))
	r := f.receipt(t)
	if r.Packages["web"].API != "https://coleo.example" {
		t.Fatal(r)
	}
	must(t, f.run("uninstall", "web"))
	b, err := os.ReadFile(filepath.Join(config, "config"))
	must(t, err)
	if string(b) != "secret" {
		t.Fatal("configuration changed")
	}
	must(t, os.WriteFile(filepath.Join(f.prefix, "bin", "coleo-server"), []byte("unrelated"), 0755))
	if err = f.run("install", "server"); err == nil {
		t.Fatal("overwrote unrelated executable")
	}
	b, err = os.ReadFile(filepath.Join(f.prefix, "bin", "coleo-server"))
	must(t, err)
	if string(b) != "unrelated" {
		t.Fatal("overwritten")
	}
}

func TestBrokenStagedExecutableDoesNotReplaceCurrent(t *testing.T) {
	f := newFixture(t)
	must(t, f.run("install", "server"))
	before := f.receipt(t).Packages["operator"].Path
	f.add(t, "operator", map[string]string{
		"dist/index.js": "echo legacy\n", "dist/server.js": "exit 42\n", "dist/agent.js": "echo agent\n",
	}, "bun", "")
	if err := f.run("upgrade", "server"); err == nil {
		t.Fatal("accepted broken executable")
	}
	if f.receipt(t).Packages["operator"].Path != before {
		t.Fatal("changed receipt after failed validation")
	}
	checkCommand(t, f, "coleo-server", "server-1.2.3")
}
func TestArchiveTraversalAndLinks(t *testing.T) {
	for _, name := range []string{"../escape", "/absolute", "a/../../escape", "a\\evil"} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			file := filepath.Join(dir, "a.tar.gz")
			must(t, os.WriteFile(file, archive(t, map[string]string{name: "bad"}), 0600))
			if err := extract(file, "tar.gz", filepath.Join(dir, "out")); err == nil {
				t.Fatal("accepted unsafe archive")
			}
		})
	}
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tw := tar.NewWriter(gz)
	must(t, tw.WriteHeader(&tar.Header{Name: "link", Typeflag: tar.TypeSymlink, Linkname: "../escape"}))
	must(t, tw.Close())
	must(t, gz.Close())
	dir := t.TempDir()
	file := filepath.Join(dir, "link.tar.gz")
	must(t, os.WriteFile(file, b.Bytes(), 0600))
	if err := extract(file, "tar.gz", filepath.Join(dir, "out")); err == nil {
		t.Fatal("accepted symlink")
	}
}
func TestUnsupportedAndInvalidManifest(t *testing.T) {
	f := newFixture(t)
	if err := f.run("install", "macos"); err == nil || !strings.Contains(err.Error(), "not published") {
		t.Fatal(err)
	}
	f.m.Version = "2.0.0"
	if err := f.run("install", "server"); err == nil {
		t.Fatal("accepted mismatched release")
	}
	if _, err := parse([]string{"client", "--api-url", "https://user:secret@example.com"}); err == nil {
		t.Fatal("accepted credentials")
	}
}
