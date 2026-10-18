package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

func safePath(root, name string) (string, error) {
	if strings.Contains(name, "\\") || filepath.IsAbs(name) {
		return "", errors.New("unsafe archive path")
	}
	clean := filepath.Clean(name)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("archive path escapes destination")
	}
	return filepath.Join(root, clean), nil
}

// No archive links, devices, or special files are accepted, even if their target appears safe.
func extract(file, format, dest string) error {
	var total int64
	write := func(name string, mode os.FileMode, size int64, r io.Reader, dir bool) error {
		p, err := safePath(dest, name)
		if err != nil {
			return err
		}
		if dir {
			return os.MkdirAll(p, 0755)
		}
		total += size
		if size < 0 || total > 8<<30 {
			return errors.New("archive exceeds extraction limit")
		}
		if err = os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			return err
		}
		f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode.Perm()&0755)
		if err != nil {
			return err
		}
		n, err := io.Copy(f, io.LimitReader(r, size+1))
		ce := f.Close()
		if err != nil {
			return err
		}
		if n != size {
			return errors.New("archive entry size mismatch")
		}
		return ce
	}
	if format == "zip" {
		z, err := zip.OpenReader(file)
		if err != nil {
			return err
		}
		defer z.Close()
		for _, e := range z.File {
			if e.Mode()&os.ModeType != 0 && !e.FileInfo().IsDir() {
				return errors.New("archive links/special files are forbidden")
			}
			r, err := e.Open()
			if err != nil {
				return err
			}
			err = write(e.Name, e.Mode(), int64(e.UncompressedSize64), r, e.FileInfo().IsDir())
			r.Close()
			if err != nil {
				return err
			}
		}
		return nil
	}
	if format != "tar.gz" {
		return errors.New("unsupported archive format")
	}
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeDir {
			return errors.New("archive links/special files are forbidden")
		}
		if err = write(h.Name, os.FileMode(h.Mode), h.Size, tr, h.Typeflag == tar.TypeDir); err != nil {
			return err
		}
	}
}
func unpack(m Manifest, name, p, dest string) (Component, Artifact, error) {
	c, a, err := selectArtifact(m, name, p)
	if err != nil {
		return c, a, err
	}
	if err = os.MkdirAll(dest, 0755); err != nil {
		return c, a, err
	}
	f := dest + ".download"
	defer os.Remove(f)
	if err = fetchArtifact(a, f); err == nil {
		err = extract(f, a.Format, dest)
		// Apple's zip metadata carries stapled tickets/resource forks. Validate every
		// archive entry with our extractor first, then restore metadata with ditto.
		if err == nil && name == "macos" && runtime.GOOS == "darwin" && a.Format == "zip" {
			err = os.RemoveAll(dest)
			if err == nil {
				err = command("/usr/bin/ditto", nil, "-x", "-k", f, dest)
			}
		}
	}
	return c, a, err
}
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
func wrapper(path, exe string, args ...string) error {
	text := "#!/bin/sh\nexec " + shellQuote(exe)
	for _, a := range args {
		text += " " + shellQuote(a)
	}
	text += " \"$@\"\n"
	return os.WriteFile(path, []byte(text), 0755)
}
func command(exe string, env []string, args ...string) error {
	return commandAt("", exe, env, args...)
}
func commandAt(dir, exe string, env []string, args ...string) error {
	c := exec.Command(exe, args...)
	c.Dir = dir
	for _, value := range os.Environ() {
		// Ambient uv settings must not redirect managed runtimes/tools outside the prefix.
		if len(env) > 0 && (strings.HasPrefix(value, "UV_") || strings.HasPrefix(value, "PIP_") || strings.HasPrefix(value, "PYTHONPATH=") || strings.HasPrefix(value, "PYTHONHOME=") || strings.HasPrefix(value, "VIRTUAL_ENV=")) {
			continue
		}
		c.Env = append(c.Env, value)
	}
	c.Env = append(c.Env, env...)
	c.Stdout = os.Stderr
	c.Stderr = os.Stderr
	if err := c.Run(); err != nil {
		return fmt.Errorf("%s failed; previous installation preserved", filepath.Base(exe))
	}
	return nil
}
func prepare(m Manifest, fam, p, store string, roles []string) error {
	c, _, err := unpack(m, fam, p, filepath.Join(store, "payload"))
	if err != nil {
		return err
	}
	if fam == "operator" || fam == "client" || fam == "web" {
		expected := "bun"
		if fam == "client" {
			expected = "uv"
		}
		if c.Runtime != expected {
			return fmt.Errorf("%s runtime must be %s", fam, expected)
		}
		_, a, err := unpack(m, c.Runtime, p, filepath.Join(store, "runtime"))
		if err != nil {
			return err
		}
		exe, err := safePath(filepath.Join(store, "runtime"), a.Entry)
		if err != nil || a.Entry == "" {
			return errors.New("runtime entry missing/unsafe")
		}
		if err = os.Chmod(exe, 0755); err != nil {
			return err
		}
		if fam == "operator" {
			for _, name := range []string{"index", "server", "agent"} {
				entry := filepath.Join(store, "payload", "dist", name+".js")
				if _, err = os.Stat(entry); err != nil {
					return err
				}
			}
			if err = wrapper(filepath.Join(store, "coleo"), exe, filepath.Join(store, "payload", "dist", "index.js")); err != nil {
				return err
			}
			for _, role := range []string{"server", "agent"} {
				if err = wrapper(filepath.Join(store, "coleo-"+role), exe, filepath.Join(store, "payload", "dist", role+".js")); err != nil {
					return err
				}
			}
		} else if fam == "web" {
			for _, name := range []string{"index.html", "host.js"} {
				info, e := os.Stat(filepath.Join(store, "payload", name))
				if e != nil || !info.Mode().IsRegular() {
					return fmt.Errorf("web archive must contain %s at its root", name)
				}
			}
			if err = wrapper(filepath.Join(store, "coleo-web"), exe, filepath.Join(store, "payload", "host.js")); err != nil {
				return err
			}
		} else {
			if !regexp.MustCompile(`^3\.[0-9]+\.[0-9]+$`).MatchString(c.Python) {
				return errors.New("client requires exact Python runtime pin")
			}
			wheel, err := safePath(filepath.Join(store, "payload"), c.Wheel)
			if err != nil || !strings.HasSuffix(c.Wheel, ".whl") {
				return errors.New("client wheel path invalid")
			}
			spec := "coleo-inbox"
			if contains(roles, "tui") {
				spec += "[tui]"
			}
			// PEP 508 file URLs preserve spaces and metacharacters in user prefixes.
			spec += " @ " + (&url.URL{Scheme: "file", Path: wheel}).String()
			env := []string{"UV_TOOL_DIR=" + filepath.Join(store, "tools"), "UV_TOOL_BIN_DIR=" + filepath.Join(store, "bin"), "UV_PYTHON_INSTALL_DIR=" + filepath.Join(store, "python"), "UV_CACHE_DIR=" + filepath.Join(store, "cache"), "UV_PYTHON_PREFERENCE=only-managed", "UV_NO_CONFIG=1",
				"PATH=" + filepath.Join(store, "bin") + string(os.PathListSeparator) + os.Getenv("PATH")}
			if err = command(exe, env, "python", "install", "--no-bin", c.Python); err != nil {
				return err
			}
			// uv 0.11 splits absolute constraint paths at spaces. Resolve the flat
			// constraints/wheelhouse relative to payload instead (uv issue #12639).
			if err = commandAt(filepath.Join(store, "payload"), exe, env, "tool", "install", "--python", c.Python, "--no-index", "--find-links", "wheels", "--constraint", "constraints.txt", spec); err != nil {
				return err
			}
			for _, name := range []string{"coleo-client", "coleo-inbox"} {
				target := filepath.Join(store, "bin", name)
				if _, err = os.Stat(target); err != nil {
					return err
				}
				if err = wrapper(filepath.Join(store, name), target); err != nil {
					return err
				}
			}
			os.RemoveAll(filepath.Join(store, "cache"))
		}
		// Check the staged executable before publishing the new receipt/launch links.
		staged := Receipt{Packages: map[string]Package{fam: {Path: store, Roles: roles}}}
		for _, exe := range commands(staged) {
			if err = command(exe, nil, "--version"); err != nil {
				return err
			}
		}
	}
	if fam == "web" {
		if _, err = os.Stat(filepath.Join(store, "payload", "index.html")); err != nil {
			return errors.New("web archive must contain index.html at its root")
		}
	}
	if fam == "macos" {
		if runtime.GOOS != "darwin" {
			return errors.New("macOS app requires macOS 14+")
		}
		v, err := exec.Command("sw_vers", "-productVersion").Output()
		if err != nil {
			return err
		}
		var major int
		fmt.Sscanf(string(v), "%d", &major)
		if major < 14 {
			return errors.New("macOS 14+ required")
		}
		if !c.Signed || !c.Notarized {
			return errors.New("macOS release lacks signing/notarization evidence")
		}
		app := filepath.Join(store, "payload", "ColeoInbox.app")
		if err = command("codesign", nil, "--verify", "--deep", "--strict", app); err != nil {
			return err
		}
		if err = command("spctl", nil, "--assess", "--type", "execute", app); err != nil {
			return err
		}
	}
	return nil
}
