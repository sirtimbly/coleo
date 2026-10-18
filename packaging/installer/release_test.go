package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

type releaseTransport func(*http.Request) (*http.Response, error)

func (f releaseTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestReleaseTagNormalizationAndManifestURLs(t *testing.T) {
	const manifestURL = "https://github.com/sirtimbly/coleo/releases/download/coleo-v1.2.3/coleo-release.json"
	const latestURL = "https://api.github.com/repos/sirtimbly/coleo/releases/latest"
	m := Manifest{SchemaVersion: 1, Version: "1.2.3", Commit: strings.Repeat("a", 40)}
	manifest, err := json.Marshal(m)
	must(t, err)
	previous := httpClient
	t.Cleanup(func() { httpClient = previous })
	for _, input := range []string{"1.2.3", "v1.2.3", "coleo-v1.2.3", "latest"} {
		t.Run(input, func(t *testing.T) {
			var calls []string
			httpClient = &http.Client{Transport: releaseTransport(func(req *http.Request) (*http.Response, error) {
				calls = append(calls, req.URL.String())
				body := string(manifest)
				if req.URL.String() == latestURL {
					body = `{"tag_name":"coleo-v1.2.3"}`
				} else if req.URL.String() != manifestURL {
					t.Fatalf("noncanonical manifest URL: %s", req.URL)
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
			})}
			o, err := parse([]string{"install", "server", "--version", input})
			must(t, err)
			got, err := loadManifest(o)
			must(t, err)
			if got.Version != "1.2.3" {
				t.Fatal(got.Version)
			}
			wantCalls := 1
			if input == "latest" {
				wantCalls = 2
				if calls[0] != latestURL {
					t.Fatal(calls)
				}
			} else if o.Version != "1.2.3" {
				t.Fatal(o.Version)
			}
			if len(calls) != wantCalls || calls[len(calls)-1] != manifestURL {
				t.Fatal(calls)
			}
		})
	}
	t.Setenv("COLEO_VERSION", "coleo-v1.2.3")
	o, err := parse(nil)
	must(t, err)
	if o.Version != "1.2.3" {
		t.Fatal(o.Version)
	}
}
