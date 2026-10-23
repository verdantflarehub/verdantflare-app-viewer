package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/verdantflarehub/verdantflare-app-viewer/internal/viewer"
)

type fakeSource struct{}

func (fakeSource) ResolveProjectSet(_ context.Context, _ viewer.Identity, projectID, revisionID, setID string) (viewer.ResolvedSetPackage, error) {
	if projectID == "01a16250-d1aa-7667-add1-999999999999" {
		return viewer.ResolvedSetPackage{}, &viewer.UpstreamError{Status: 403, Code: "PERMISSION_DENIED"}
	}
	if setID == "" {
		setID = "saw-bathroom-v9"
	}
	return viewer.ResolvedSetPackage{
		SourceKind:    "project",
		ProjectID:     projectID,
		ProjectName:   "密室 · 电锯惊魂片场",
		RevisionID:    revisionID,
		SetID:         setID,
		AvailableSets: []string{setID},
		Access:        viewer.AccessScope{ProjectID: projectID, RevisionID: revisionID},
		Files: map[string]viewer.PackageFile{
			"set.json": {
				FileID:      "01a1691d-0000-7000-8000-000000000101",
				Path:        "set.json",
				ProjectPath: "sets/" + setID + "/set.json",
				Role:        "export",
				ContentRef: viewer.ContentRef{
					StoreID:    "01a0fae2-0000-7000-8000-000000000010",
					ArtifactID: "01a1691d-0000-7000-8000-000000000011",
					VersionID:  "01a1691d-0000-7000-8000-000000000012",
				},
			},
		},
	}, nil
}

func (fakeSource) ResolveWorldSet(_ context.Context, _ viewer.Identity, assetID, versionID string) (viewer.ResolvedSetPackage, error) {
	return viewer.ResolvedSetPackage{
		SourceKind:     "world",
		AssetID:        assetID,
		AssetName:      "密室片场世界资产",
		AssetVersionID: versionID,
		SetID:          "saw-bathroom-v9",
		AvailableSets:  []string{"saw-bathroom-v9"},
		Access:         viewer.AccessScope{AssetID: assetID, AssetVersionID: versionID},
		Files:          map[string]viewer.PackageFile{},
	}, nil
}

func (fakeSource) ListCatalog(_ context.Context, _ viewer.Identity) (viewer.CatalogResult, error) {
	return viewer.CatalogResult{
		Items: []viewer.CatalogEntry{
			{
				SourceKind: "project",
				Title:      "密室 · 电锯惊魂片场",
				Category:   "ai_short_drama",
				ProjectID:  "01a16250-d1aa-7667-add1-588f58042bbc",
				RevisionID: "01a1691d-bd00-7195-bb28-982913b20c14",
				SetIDs:     []string{"saw-bathroom-v9"},
			},
		},
	}, nil
}

func TestServerRoutesAndAuth(t *testing.T) {
	const (
		token     = "0123456789abcdef0123456789abcdef"
		stationID = "01a0fae2-dbb6-700e-bcf7-99a39c757706"
		userID    = "01a0fc01-0000-7000-8000-000000000001"
		orgID     = "01a0fbf9-0a33-7c31-90d0-a51e3b0a9781"
		reqID     = "01a16900-0000-7000-8000-000000000002"
		projID    = "01a16250-d1aa-7667-add1-588f58042bbc"
		revID     = "01a1691d-bd00-7195-bb28-982913b20c14"
		deniedID  = "01a16250-d1aa-7667-add1-999999999999"
	)

	srv, err := New(token, stationID, viewer.Service{Source: fakeSource{}}, nil)
	if err != nil {
		t.Fatalf("unexpected server.New error: %v", err)
	}

	// 1. Healthz
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on /healthz, got %d", rec.Code)
	}

	// 2. Unauthenticated request rejected
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/sets/catalog", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", rec.Code)
	}

	// 3. Authenticated Project Set Resolution
	req := httptest.NewRequest(http.MethodGet, "/api/v1/sets/project/"+projID+"/revisions/"+revID+"/sets/saw-bathroom-v9", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-User-Id", userID)
	req.Header.Set("X-Organization-Id", orgID)
	req.Header.Set("X-Station-Id", stationID)
	req.Header.Set("X-Request-Id", reqID)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on project set resolve, got %d: %s", rec.Code, rec.Body.String())
	}
	var out viewer.ResolvedSetPackage
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out.SetID != "saw-bathroom-v9" {
		t.Fatalf("unexpected resolved payload: %+v, err=%v", out, err)
	}

	// 4. Permission Denied Propagation
	reqDenied := httptest.NewRequest(http.MethodGet, "/api/v1/sets/project/"+deniedID+"/revisions/"+revID+"/sets/saw-bathroom-v9", nil)
	reqDenied.Header.Set("Authorization", "Bearer "+token)
	reqDenied.Header.Set("X-User-Id", userID)
	reqDenied.Header.Set("X-Organization-Id", orgID)
	reqDenied.Header.Set("X-Station-Id", stationID)
	reqDenied.Header.Set("X-Request-Id", reqID)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, reqDenied)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 on denied project set, got %d", rec.Code)
	}
}
