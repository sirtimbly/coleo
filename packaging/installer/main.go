// Coleo's dependency-free release installer. Build with CGO_ENABLED=0.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

type Artifact struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
	Format string `json:"format"`
	Entry  string `json:"entry,omitempty"`
}
type Component struct {
	Version       string              `json:"version"`
	Artifacts     map[string]Artifact `json:"artifacts"`
	Runtime       string              `json:"runtime,omitempty"`
	Dependencies  []string            `json:"dependencies,omitempty"`
	Python        string              `json:"python,omitempty"`
	Wheel         string              `json:"wheel,omitempty"`
	Compatibility map[string]any      `json:"compatibility"`
	Signed        bool                `json:"signed,omitempty"`
	Notarized     bool                `json:"notarized,omitempty"`
}
type Manifest struct {
	SchemaVersion int                  `json:"schemaVersion"`
	Version       string               `json:"version"`
	Commit        string               `json:"commit"`
	Components    map[string]Component `json:"components"`
}
type Package struct {
	Version string   `json:"version"`
	Release string   `json:"release"`
	Commit  string   `json:"commit"`
	SHA256  string   `json:"sha256"`
	Path    string   `json:"path"`
	Roles   []string `json:"roles"`
	API     string   `json:"api,omitempty"`
}
type Receipt struct {
	SchemaVersion int                `json:"schemaVersion"`
	Packages      map[string]Package `json:"packages"`
}
type Options struct {
	Action, Component, Version, Prefix, Manifest, API string
	DryRun                                            bool
}

var versionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var httpClient = &http.Client{Timeout: 10 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
	if req.URL.Scheme != "https" && !(os.Getenv("COLEO_INSTALL_TEST_HTTP") == "1" && req.URL.Hostname() == "127.0.0.1") {
		return errors.New("redirect must use HTTPS")
	}
	if len(via) >= 10 {
		return errors.New("too many redirects")
	}
	return nil
}}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "Coleo installer:", err)
		os.Exit(1)
	}
}
func normalizeVersion(value string) string {
	if strings.HasPrefix(value, "coleo-v") {
		return strings.TrimPrefix(value, "coleo-v")
	}
	return strings.TrimPrefix(value, "v")
}
func parse(args []string) (Options, error) {
	home, _ := os.UserHomeDir()
	o := Options{Action: "install", Component: "server", Version: "latest", Prefix: filepath.Join(home, ".local"), API: "http://127.0.0.1:8080"}
	if v := os.Getenv("COLEO_VERSION"); v != "" {
		o.Version = normalizeVersion(v)
	}
	if v := os.Getenv("COLEO_INSTALL_PREFIX"); v != "" {
		o.Prefix = v
	}
	if len(args) > 0 && !strings.HasPrefix(args[0], "--") {
		if args[0] == "install" || args[0] == "upgrade" || args[0] == "uninstall" {
			o.Action = args[0]
			args = args[1:]
		}
		if len(args) > 0 && !strings.HasPrefix(args[0], "--") {
			o.Component = args[0]
			args = args[1:]
		}
	}
	for len(args) > 0 {
		flag := args[0]
		args = args[1:]
		if flag == "--dry-run" {
			o.DryRun = true
			continue
		}
		if len(args) == 0 {
			return o, fmt.Errorf("missing value for %s", flag)
		}
		value := args[0]
		args = args[1:]
		switch flag {
		case "--version":
			o.Version = normalizeVersion(value)
		case "--prefix":
			o.Prefix = value
		case "--manifest":
			o.Manifest = value
		case "--api-url":
			o.API = value
		default:
			return o, fmt.Errorf("unknown option %s", flag)
		}
	}
	if o.Component == "cli" {
		o.Component = "client"
	}
	if !contains([]string{"server", "agent", "client", "tui", "web", "macos"}, o.Component) {
		return o, errors.New("unknown component")
	}
	if o.Version != "latest" && !versionPattern.MatchString(o.Version) {
		return o, errors.New("invalid release version")
	}
	var err error
	o.Prefix, err = filepath.Abs(o.Prefix)
	if err != nil {
		return o, err
	}
	if strings.ContainsAny(o.Prefix, "\n\r") {
		return o, errors.New("prefix contains newline")
	}
	u, err := url.Parse(o.API)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return o, errors.New("API URL must be HTTP(S) without credentials, query, or fragment")
	}
	return o, nil
}
func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}
func family(c string) string {
	switch c {
	case "server", "agent":
		return "operator"
	case "client", "tui":
		return "client"
	}
	return c
}
func platform() (string, error) {
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x64"
	}
	if (runtime.GOOS != "darwin" && runtime.GOOS != "linux") || (arch != "x64" && arch != "arm64") {
		return "", errors.New("supported platforms: macOS and Linux glibc, x64/arm64")
	}
	if runtime.GOOS == "linux" {
		output, _ := exec.Command("ldd", "--version").CombinedOutput()
		if !strings.Contains(strings.ToLower(string(output)), "glibc") && !strings.Contains(string(output), "GNU libc") {
			return "", errors.New("Linux glibc is required (musl is unsupported)")
		}
	}
	return runtime.GOOS + "-" + arch, nil
}
func get(raw string) (io.ReadCloser, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "https" && !(os.Getenv("COLEO_INSTALL_TEST_HTTP") == "1" && u.Scheme == "http" && u.Hostname() == "127.0.0.1") {
		return nil, errors.New("downloads require HTTPS")
	}
	resp, err := httpClient.Get(raw)
	if err != nil {
		return nil, errors.New("download failed; check connectivity and release URL")
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		return nil, fmt.Errorf("download returned HTTP %d", resp.StatusCode)
	}
	return resp.Body, nil
}
func loadManifest(o Options) (Manifest, error) {
	var m Manifest
	base := "https://github.com/sirtimbly/coleo/releases/"
	if o.Manifest == "" {
		if o.Version == "latest" {
			r, err := get("https://api.github.com/repos/sirtimbly/coleo/releases/latest")
			if err != nil {
				return m, err
			}
			defer r.Close()
			var latest struct {
				Tag string `json:"tag_name"`
			}
			if err = json.NewDecoder(io.LimitReader(r, 1<<20)).Decode(&latest); err != nil {
				return m, err
			}
			o.Version = normalizeVersion(latest.Tag)
			if !versionPattern.MatchString(o.Version) {
				return m, errors.New("invalid latest release tag")
			}
		}
		o.Manifest = base + "download/coleo-v" + o.Version + "/coleo-release.json"
	}
	r, err := get(o.Manifest)
	if err != nil {
		return m, err
	}
	defer r.Close()
	if err = json.NewDecoder(io.LimitReader(r, 4<<20)).Decode(&m); err != nil {
		return m, err
	}
	if m.SchemaVersion != 1 || !versionPattern.MatchString(m.Version) || !regexp.MustCompile(`^[a-f0-9]{40}$`).MatchString(m.Commit) {
		return m, errors.New("invalid release manifest identity")
	}
	if o.Version != "latest" && m.Version != o.Version {
		return m, errors.New("manifest does not match requested release")
	}
	return m, nil
}
func selectArtifact(m Manifest, name, p string) (Component, Artifact, error) {
	c, ok := m.Components[name]
	if !ok {
		return c, Artifact{}, fmt.Errorf("%s is not published in release %s", name, m.Version)
	}
	a, ok := c.Artifacts[p]
	if !ok {
		a, ok = c.Artifacts["any"]
	}
	if !ok {
		return c, a, fmt.Errorf("%s is not published for %s", name, p)
	}
	if !versionPattern.MatchString(c.Version) || c.Compatibility["testedServer"] != m.Version || !hashPattern.MatchString(a.SHA256) || a.Size <= 0 || a.Size > 4<<30 {
		return c, a, errors.New("invalid artifact metadata")
	}
	if strings.Contains(a.URL, "/latest/") {
		return c, a, errors.New("artifact URL must be immutable")
	}
	return c, a, nil
}
func fetchArtifact(a Artifact, dest string) error {
	r, err := get(a.URL)
	if err != nil {
		return err
	}
	defer r.Close()
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(r, a.Size+1))
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if n != a.Size || hex.EncodeToString(h.Sum(nil)) != a.SHA256 {
		return errors.New("artifact size/SHA-256 mismatch; previous installation preserved")
	}
	return nil
}
func receipt(root string) (Receipt, error) {
	r := Receipt{SchemaVersion: 1, Packages: map[string]Package{}}
	b, err := os.ReadFile(filepath.Join(root, "current", "receipt.json"))
	if os.IsNotExist(err) {
		return r, nil
	}
	if err != nil {
		return r, err
	}
	if err = json.Unmarshal(b, &r); err != nil {
		return r, errors.New("invalid install receipt; refusing to overwrite")
	}
	if r.SchemaVersion != 1 || r.Packages == nil {
		return r, errors.New("unsupported install receipt")
	}
	for name, p := range r.Packages {
		if !contains([]string{"operator", "client", "web", "macos"}, name) || filepath.Dir(p.Path) != filepath.Join(root, "stores") {
			return r, errors.New("unsafe install receipt")
		}
		if len(p.Roles) == 0 {
			return r, errors.New("receipt has no owners")
		}
		for _, role := range p.Roles {
			if !contains([]string{"server", "agent", "client", "tui", "web", "macos"}, role) || (family(role) != name && !(name == "client" && role == "web")) {
				return r, errors.New("unsafe receipt owner")
			}
		}
	}
	return r, nil
}
func commands(r Receipt) map[string]string {
	out := map[string]string{}
	for fam, p := range r.Packages {
		switch fam {
		case "operator":
			for _, role := range p.Roles {
				out["coleo-"+role] = filepath.Join(p.Path, "coleo-"+role)
				if role == "server" {
					out["coleo"] = filepath.Join(p.Path, "coleo")
				}
			}
		case "client":
			for _, name := range []string{"coleo-client", "coleo-inbox"} {
				out[name] = filepath.Join(p.Path, name)
			}
		case "web":
			out["coleo-web"] = filepath.Join(p.Path, "coleo-web")
		}
	}
	return out
}
func publish(root, prefix string, old, next Receipt) error {
	snapshot, err := os.MkdirTemp(filepath.Join(root, "snapshots"), "generation-")
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			os.RemoveAll(snapshot)
		}
	}()
	if err = os.Mkdir(filepath.Join(snapshot, "bin"), 0755); err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	binary, err := os.ReadFile(self)
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(snapshot, "bin", "coleo-install"), binary, 0755); err != nil {
		return err
	}
	for name, target := range commands(next) {
		if err = os.Symlink(target, filepath.Join(snapshot, "bin", name)); err != nil {
			return err
		}
	}
	for _, fam := range []string{"web", "macos"} {
		if p, ok := next.Packages[fam]; ok {
			target := filepath.Join(p.Path, "payload")
			if fam == "macos" {
				target = filepath.Join(target, "ColeoInbox.app")
			}
			if err = os.Symlink(target, filepath.Join(snapshot, fam)); err != nil {
				return err
			}
		}
	}
	b, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(snapshot, "receipt.json"), b, 0600); err != nil {
		return err
	}
	created := []string{}
	defer func() {
		if !committed {
			for _, p := range created {
				os.Remove(p)
			}
		}
	}()
	links := commands(next)
	links["coleo-install"] = ""
	for name := range links {
		link := filepath.Join(prefix, "bin", name)
		target := filepath.Join(root, "current", "bin", name)
		if _, err = os.Lstat(link); err == nil {
			existing, e := os.Readlink(link)
			if e != nil || existing != target {
				return fmt.Errorf("refusing to replace unrelated executable: %s", link)
			}
		} else if !os.IsNotExist(err) {
			return err
		} else {
			if err = os.Symlink(target, link); err != nil {
				return err
			}
			created = append(created, link)
		}
	}
	tmp := filepath.Join(root, "next")
	os.Remove(tmp)
	if err = os.Symlink(snapshot, tmp); err != nil {
		return err
	}
	defer os.Remove(tmp)
	previous, _ := os.Readlink(filepath.Join(root, "current"))
	if err = os.Rename(tmp, filepath.Join(root, "current")); err != nil {
		return err
	}
	committed = true
	for name := range commands(old) {
		if _, ok := commands(next)[name]; !ok {
			link := filepath.Join(prefix, "bin", name)
			target, _ := os.Readlink(link)
			if target == filepath.Join(root, "current", "bin", name) {
				os.Remove(link)
			}
		}
	}
	for fam, p := range old.Packages {
		if n, ok := next.Packages[fam]; !ok || p.Path != n.Path {
			os.RemoveAll(p.Path)
		}
	}
	if filepath.Dir(previous) == filepath.Join(root, "snapshots") {
		os.RemoveAll(previous)
	}
	return nil
}
func run(args []string) error {
	if contains(args, "--help") {
		fmt.Println("installer [install|upgrade|uninstall] [server|agent|client|tui|web|macos] [--version VERSION] [--prefix PATH] [--manifest URL] [--api-url URL] [--dry-run]")
		return nil
	}
	o, err := parse(args)
	if err != nil {
		return err
	}
	root := filepath.Join(o.Prefix, "lib", "coleo")
	if !o.DryRun {
		if err = os.MkdirAll(root, 0700); err != nil {
			return err
		}
		lock := filepath.Join(root, "install.lock")
		if err = os.Mkdir(lock, 0700); err != nil {
			return errors.New("another installer holds install.lock; if interrupted, remove the stale lock after checking no installer is running")
		}
		defer os.Remove(lock)
		for _, dir := range []string{filepath.Join(o.Prefix, "bin"), filepath.Join(root, "stores"), filepath.Join(root, "snapshots")} {
			if err = os.MkdirAll(dir, 0755); err != nil {
				return err
			}
		}
	}
	old, err := receipt(root)
	if err != nil {
		return err
	}
	next := Receipt{SchemaVersion: 1, Packages: map[string]Package{}}
	for k, v := range old.Packages {
		next.Packages[k] = v
	}
	fam := family(o.Component)
	pkg, exists := old.Packages[fam]
	if o.Action == "uninstall" {
		if !exists || !contains(pkg.Roles, o.Component) {
			fmt.Println(o.Component + " is not explicitly installed; nothing removed.")
			return nil
		}
		removeOwner(&next, o.Component)
		roles := next.Packages[fam].Roles
		if o.DryRun {
			fmt.Printf("Would uninstall %s from %s; preserve configuration/data and remaining roles %v\n", o.Component, o.Prefix, roles)
			return nil
		}
		if err = publish(root, o.Prefix, old, next); err != nil {
			return err
		}
		fmt.Printf("Uninstalled %s. Configuration and data preserved. Remaining shared owners: %v\n", o.Component, roles)
		return nil
	}
	if o.Action == "upgrade" && (!exists || !contains(pkg.Roles, o.Component)) {
		return errors.New("component is not installed; use install first")
	}
	p, err := platform()
	if err != nil {
		return err
	}
	m, err := loadManifest(o)
	if err != nil {
		return err
	}
	c, _, err := selectArtifact(m, fam, p)
	if err != nil {
		return err
	}
	if c.Runtime != "" {
		if _, _, err = selectArtifact(m, c.Runtime, p); err != nil {
			return err
		}
	}
	families := []string{fam}
	if fam == "web" {
		if c.Runtime != "bun" || len(c.Dependencies) != 1 || c.Dependencies[0] != "client" {
			return errors.New("web requires Bun and the client dependency")
		}
		client, _, e := selectArtifact(m, "client", p)
		if e != nil {
			return e
		}
		if _, _, e = selectArtifact(m, client.Runtime, p); e != nil {
			return e
		}
		families = append(families, "client")
	}
	roles := append([]string{}, pkg.Roles...)
	if !contains(roles, o.Component) {
		roles = append(roles, o.Component)
	}
	sort.Strings(roles)
	if o.DryRun {
		fmt.Printf("Would %s %s (%s), release %s on %s into %s; shared owners %v; runtime %s\n", o.Action, o.Component, c.Version, m.Version, p, o.Prefix, roles, c.Runtime)
		return nil
	}
	stores := []string{}
	committed := false
	defer func() {
		if !committed {
			for _, store := range stores {
				os.RemoveAll(store)
			}
		}
	}()
	for _, target := range families {
		owners := append([]string{}, old.Packages[target].Roles...)
		if !contains(owners, o.Component) {
			owners = append(owners, o.Component)
		}
		sort.Strings(owners)
		metadata, artifact, e := selectArtifact(m, target, p)
		if e != nil {
			return e
		}
		store, e := os.MkdirTemp(filepath.Join(root, "stores"), target+"-")
		if e != nil {
			return e
		}
		stores = append(stores, store)
		if e = prepare(m, target, p, store, owners); e != nil {
			return e
		}
		next.Packages[target] = Package{Version: metadata.Version, Release: m.Version, Commit: m.Commit, SHA256: artifact.SHA256, Path: store, Roles: owners, API: o.API}
	}
	if err = publish(root, o.Prefix, old, next); err != nil {
		return err
	}
	committed = true
	fmt.Printf("Installed %s %s (release %s).\n", o.Component, c.Version, m.Version)
	for name := range commands(Receipt{Packages: map[string]Package{fam: next.Packages[fam]}}) {
		fmt.Println("Executable:", filepath.Join(o.Prefix, "bin", name))
	}
	fmt.Printf("PATH: export PATH=%s:\"$PATH\"\n", shellQuote(filepath.Join(o.Prefix, "bin")))
	switch o.Component {
	case "server":
		fmt.Println("Next: coleo-server configure; coleo-server start (API only); coleo-server brain start")
	case "agent":
		fmt.Println("Next: coleo-agent configure; coleo-agent start (configure NATS separately from the API)")
	case "client", "tui":
		fmt.Printf("Next: coleo-client connect %s --name default\n", shellQuote(o.API))
		if contains(roles, "tui") {
			fmt.Println("Open workspace: coleo-client tui")
		}
	case "web":
		fmt.Printf("Next: coleo-client connect %s --name default\nOpen workspace: coleo-client web\n", shellQuote(o.API))
	case "macos":
		fmt.Printf("Open: open %s\n", shellQuote(filepath.Join(root, "current", "macos")))
	}
	fmt.Printf("Upgrade: %s upgrade %s --prefix %s --version VERSION\nUninstall: %s uninstall %s --prefix %s\n", shellQuote(filepath.Join(o.Prefix, "bin", "coleo-install")), o.Component, shellQuote(o.Prefix), shellQuote(filepath.Join(o.Prefix, "bin", "coleo-install")), o.Component, shellQuote(o.Prefix))
	return nil
}
