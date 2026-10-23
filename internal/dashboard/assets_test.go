package dashboard

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
	"testing/fstest"
)

func sumHex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func TestLoadValidDashboardAssets(t *testing.T) {
	html := []byte("<!doctype html><html><body>viewer</body></html>")
	js := []byte("console.log('viewer')")
	css := []byte("body { margin: 0; }")

	indexPayload, _ := json.Marshal(map[string]any{
		"schemaVersion": 1,
		"files": map[string]string{
			"assets/app.css": sumHex(css),
			"assets/app.js":  sumHex(js),
			"index.html":     sumHex(html),
		},
	})
	declPayload, _ := json.Marshal(map[string]any{
		"schemaVersion": 1,
		"appId":         "viewer",
		"appVersion":    "0.1.0",
		"dashboard": map[string]any{
			"entryRef":             "dashboard/index.html",
			"artifactDigest":       "sha256:" + sumHex(indexPayload),
			"adapter":              "wujie",
			"sdkMajor":             1,
			"minimumSdkVersion":    "1.1.0",
			"requiredCapabilities": []string{"app.request", "navigation.request"},
			"optionalCapabilities": []string{"artifact.read", "navigation.openApp"},
			"appApiPolicyRef":      "viewer-dashboard-v1",
			"keepAlive":            true,
		},
	})

	fsys := fstest.MapFS{
		"index.html":                 {Data: html},
		"assets/app.js":              {Data: js},
		"assets/app.css":             {Data: css},
		"asset-index.json":           {Data: indexPayload},
		"dashboard-declaration.json": {Data: declPayload},
	}

	assets, err := Load(fsys, "0.1.0")
	if err != nil {
		t.Fatalf("expected valid assets, got error: %v", err)
	}
	data, mime, ok := assets.File("index.html")
	if !ok || mime != "text/html; charset=utf-8" || string(data) != string(html) {
		t.Fatalf("unexpected index.html result: ok=%v mime=%s", ok, mime)
	}
	if _, _, ok := assets.File("../secret"); ok {
		t.Fatal("expected traversal path to be rejected")
	}
}

func TestLoadRejectsTamperedAsset(t *testing.T) {
	html := []byte("<!doctype html><html><body>viewer</body></html>")
	indexPayload, _ := json.Marshal(map[string]any{
		"schemaVersion": 1,
		"files": map[string]string{
			"index.html": sumHex(html),
		},
	})
	declPayload, _ := json.Marshal(map[string]any{
		"schemaVersion": 1,
		"appId":         "viewer",
		"appVersion":    "0.1.0",
		"dashboard": map[string]any{
			"entryRef":             "dashboard/index.html",
			"artifactDigest":       "sha256:" + sumHex(indexPayload),
			"adapter":              "wujie",
			"sdkMajor":             1,
			"minimumSdkVersion":    "1.1.0",
			"requiredCapabilities": []string{"app.request", "navigation.request"},
			"optionalCapabilities": []string{"artifact.read", "navigation.openApp"},
			"appApiPolicyRef":      "viewer-dashboard-v1",
			"keepAlive":            true,
		},
	})

	fsys := fstest.MapFS{
		"index.html":                 {Data: []byte("tampered")},
		"asset-index.json":           {Data: indexPayload},
		"dashboard-declaration.json": {Data: declPayload},
	}

	if _, err := Load(fsys, "0.1.0"); err == nil {
		t.Fatal("expected tampered asset to fail integrity check")
	}
}
