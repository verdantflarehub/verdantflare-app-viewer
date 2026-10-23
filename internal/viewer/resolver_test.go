package viewer

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestResolveProjectSetAndPermissionPropagation(t *testing.T) {
	const (
		validToken = "0123456789abcdef0123456789abcdef"
		projID     = "01a16250-d1aa-7667-add1-588f58042bbc"
		revID      = "01a1691d-bd00-7195-bb28-982913b20c14"
		deniedID   = "01a16250-d1aa-7667-add1-999999999999"
		userID     = "01a0fc01-0000-7000-8000-000000000001"
		orgID      = "01a0fbf9-0a33-7c31-90d0-a51e3b0a9781"
		stationID  = "01a0fae2-dbb6-700e-bcf7-99a39c757706"
		reqID      = "01a16900-0000-7000-8000-000000000002"
		storeID    = "01a0fae2-0000-7000-8000-000000000010"
		artSet     = "01a1691d-0000-7000-8000-000000000011"
		verSet     = "01a1691d-0000-7000-8000-000000000012"
		artGLB     = "01a1691d-0000-7000-8000-000000000013"
		verGLB     = "01a1691d-0000-7000-8000-000000000014"
		artPoster  = "01a1691d-0000-7000-8000-000000000015"
		verPoster  = "01a1691d-0000-7000-8000-000000000016"
		artCam     = "01a1691d-0000-7000-8000-000000000017"
		verCam     = "01a1691d-0000-7000-8000-000000000018"
	)

	projectServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+validToken ||
			r.Header.Get("X-User-Id") != userID ||
			r.Header.Get("X-Organization-Id") != orgID {
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(map[string]string{"code": "PERMISSION_DENIED"})
			return
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["project_id"] == deniedID {
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(map[string]string{"code": "PERMISSION_DENIED"})
			return
		}
		if r.URL.Path == "/internal/v1/project/open" && body["project_id"] == projID && body["revision_id"] == revID {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"project_id":       projID,
				"revision_id":      revID,
				"head_revision_id": revID,
				"manifest": map[string]any{
					"project_id": projID,
					"name":       "密室 · 电锯惊魂片场",
					"category":   "ai_short_drama",
					"files": []map[string]any{
						{
							"file_id":     "01a1691d-0000-7000-8000-000000000101",
							"path":        "sets/saw-bathroom-v9/set.json",
							"role":        "export",
							"content_ref": map[string]string{"store_id": storeID, "artifact_id": artSet, "version_id": verSet},
						},
						{
							"file_id":     "01a1691d-0000-7000-8000-000000000102",
							"path":        "sets/saw-bathroom-v9/scene.glb",
							"role":        "export",
							"content_ref": map[string]string{"store_id": storeID, "artifact_id": artGLB, "version_id": verGLB},
						},
						{
							"file_id":     "01a1691d-0000-7000-8000-000000000103",
							"path":        "sets/saw-bathroom-v9/poster.png",
							"role":        "export",
							"content_ref": map[string]string{"store_id": storeID, "artifact_id": artPoster, "version_id": verPoster},
						},
						{
							"file_id":     "01a1691d-0000-7000-8000-000000000104",
							"path":        "sets/saw-bathroom-v9/cameras/CAM_C1.png",
							"role":        "export",
							"content_ref": map[string]string{"store_id": storeID, "artifact_id": artCam, "version_id": verCam},
						},
					},
				},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer projectServer.Close()

	src, err := NewUpstreamSource(
		strings.Replace(projectServer.URL, "127.0.0.1", "localhost", 1),
		validToken,
		strings.Replace(projectServer.URL, "127.0.0.1", "localhost", 1),
		validToken,
		"",
		projectServer.Client(),
	)
	if err != nil {
		t.Fatalf("unexpected NewUpstreamSource error: %v", err)
	}

	identity := Identity{UserID: userID, OrganizationID: orgID, StationID: stationID, RequestID: reqID}
	resolved, err := src.ResolveProjectSet(context.Background(), identity, projID, revID, "saw-bathroom-v9")
	if err != nil {
		t.Fatalf("ResolveProjectSet failed: %v", err)
	}
	if resolved.SetID != "saw-bathroom-v9" || len(resolved.Files) != 4 {
		t.Fatalf("unexpected resolved package: %+v", resolved)
	}
	if resolved.Files["scene.glb"].ContentRef.VersionID != verGLB {
		t.Fatalf("unexpected scene.glb version_id: %s", resolved.Files["scene.glb"].ContentRef.VersionID)
	}

	_, err = src.ResolveProjectSet(context.Background(), identity, deniedID, revID, "saw-bathroom-v9")
	var upErr *UpstreamError
	if err == nil || !strings.Contains(err.Error(), "PERMISSION_DENIED") {
		t.Fatalf("expected PERMISSION_DENIED error, got: %v", err)
	}
	_ = upErr
}
