package viewer

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
)

var (
	uuidV7Pattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	setIDPattern  = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`)
	cameraPNGPath = regexp.MustCompile(`^cameras/[A-Za-z0-9._-]+\.png$`)
)

type Identity struct {
	UserID         string
	OrganizationID string
	StationID      string
	RequestID      string
}

func ValidUUID(s string) bool {
	return uuidV7Pattern.MatchString(s)
}

func ValidSetID(s string) bool {
	return setIDPattern.MatchString(s)
}

func ValidIdentity(id Identity) bool {
	return ValidUUID(id.UserID) && ValidUUID(id.OrganizationID) && ValidUUID(id.StationID) && ValidUUID(id.RequestID)
}

type UpstreamError struct {
	Status int
	Code   string
}

func (e *UpstreamError) Error() string { return e.Code }

type ContentRef struct {
	StoreID    string `json:"store_id"`
	ArtifactID string `json:"artifact_id"`
	VersionID  string `json:"version_id"`
}

func (r ContentRef) Valid() bool {
	return ValidUUID(r.StoreID) && ValidUUID(r.ArtifactID) && ValidUUID(r.VersionID)
}

type PackageFile struct {
	FileID     string     `json:"file_id"`
	Path       string     `json:"path"`
	ProjectPath string    `json:"project_path"`
	Role       string     `json:"role"`
	ContentRef ContentRef `json:"content_ref"`
}

type AccessScope struct {
	ProjectID      string `json:"project_id,omitempty"`
	RevisionID     string `json:"project_revision_id,omitempty"`
	AssetID        string `json:"asset_id,omitempty"`
	AssetVersionID string `json:"asset_version_id,omitempty"`
}

type ResolvedSetPackage struct {
	SourceKind     string                 `json:"source_kind"`
	ProjectID      string                 `json:"project_id,omitempty"`
	ProjectName    string                 `json:"project_name,omitempty"`
	RevisionID     string                 `json:"revision_id,omitempty"`
	HeadRevisionID string                 `json:"head_revision_id,omitempty"`
	AssetID        string                 `json:"asset_id,omitempty"`
	AssetName      string                 `json:"asset_name,omitempty"`
	AssetVersionID string                 `json:"asset_version_id,omitempty"`
	SetID          string                 `json:"set_id"`
	AvailableSets  []string               `json:"available_sets"`
	Access         AccessScope            `json:"access"`
	Files          map[string]PackageFile `json:"files"`
}

type CatalogEntry struct {
	SourceKind     string   `json:"source_kind"`
	Title          string   `json:"title"`
	Category       string   `json:"category,omitempty"`
	ProjectID      string   `json:"project_id,omitempty"`
	RevisionID     string   `json:"revision_id,omitempty"`
	AssetID        string   `json:"asset_id,omitempty"`
	AssetVersionID string   `json:"asset_version_id,omitempty"`
	SetIDs         []string `json:"set_ids"`
}

type CatalogResult struct {
	Items []CatalogEntry `json:"items"`
}

type Source interface {
	ResolveProjectSet(ctx context.Context, identity Identity, projectID, revisionID, setID string) (ResolvedSetPackage, error)
	ResolveWorldSet(ctx context.Context, identity Identity, assetID, versionID string) (ResolvedSetPackage, error)
	ListCatalog(ctx context.Context, identity Identity) (CatalogResult, error)
}

type Service struct {
	Source Source
}

type UpstreamSource struct {
	projectOrigin string
	projectToken  string
	worldOrigin   string
	worldToken    string
	client        *http.Client
}

func validEndpoint(raw, token string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || len(token) < 32 || strings.ContainsAny(token, " \t\r\n") {
		return "", errors.New("invalid upstream endpoint or token")
	}
	ip := net.ParseIP(u.Hostname())
	loopback := u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback())
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return "", errors.New("upstream endpoint must use HTTPS or loopback HTTP")
	}
	return strings.TrimSuffix(raw, "/"), nil
}

func NewUpstreamSource(projectURL, projectToken, worldURL, worldToken, caFile string, customClient *http.Client) (*UpstreamSource, error) {
	projBase, err := validEndpoint(projectURL, projectToken)
	if err != nil {
		return nil, err
	}
	worldBase, err := validEndpoint(worldURL, worldToken)
	if err != nil {
		return nil, err
	}
	client := customClient
	if client == nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = nil
		if caFile != "" {
			pem, err := os.ReadFile(caFile)
			if err != nil {
				return nil, err
			}
			pool, err := x509.SystemCertPool()
			if err != nil || pool == nil {
				pool = x509.NewCertPool()
			}
			if !pool.AppendCertsFromPEM(pem) {
				return nil, errors.New("invalid internal CA certificate")
			}
			transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool}
		}
		client = &http.Client{
			Timeout:   15 * time.Second,
			Transport: transport,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	return &UpstreamSource{
		projectOrigin: projBase,
		projectToken:  projectToken,
		worldOrigin:   worldBase,
		worldToken:    worldToken,
		client:        client,
	}, nil
}

type manifestFile struct {
	ID      string     `json:"file_id"`
	Path    string     `json:"path"`
	Role    string     `json:"role"`
	Content ContentRef `json:"content_ref"`
}

func (s *UpstreamSource) callUpstream(ctx context.Context, identity Identity, baseURL, token, path string, payload any) ([]byte, error) {
	if !ValidIdentity(identity) {
		return nil, &UpstreamError{Status: 403, Code: "FORBIDDEN"}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, &UpstreamError{Status: 400, Code: "INVALID_ARGUMENT"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, &UpstreamError{Status: 502, Code: "UPSTREAM_UNAVAILABLE"}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Organization-Id", identity.OrganizationID)
	req.Header.Set("X-User-Id", identity.UserID)
	req.Header.Set("X-Request-Id", identity.RequestID)

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, &UpstreamError{Status: 502, Code: "UPSTREAM_UNAVAILABLE"}
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, (4<<20)+1))
	if err != nil || len(data) > 4<<20 {
		return nil, &UpstreamError{Status: 502, Code: "UPSTREAM_INVALID"}
	}
	if resp.StatusCode == http.StatusOK {
		return data, nil
	}
	switch resp.StatusCode {
	case http.StatusBadRequest:
		return nil, &UpstreamError{Status: 400, Code: "INVALID_ARGUMENT"}
	case http.StatusUnauthorized, http.StatusForbidden:
		return nil, &UpstreamError{Status: 403, Code: "PERMISSION_DENIED"}
	case http.StatusNotFound:
		return nil, &UpstreamError{Status: 404, Code: "NOT_FOUND"}
	case http.StatusConflict:
		return nil, &UpstreamError{Status: 409, Code: "CONTENT_NOT_READY"}
	default:
		return nil, &UpstreamError{Status: 502, Code: "UPSTREAM_UNAVAILABLE"}
	}
}

func extractSetPackages(files []manifestFile, fallbackSetID string) (map[string]map[string]PackageFile, []string) {
	prefixes := map[string]string{}
	for _, f := range files {
		if !ValidUUID(f.ID) || !f.Content.Valid() {
			continue
		}
		if f.Path == "set.json" {
			id := fallbackSetID
			if !ValidSetID(id) {
				id = "default"
			}
			prefixes[id] = ""
		} else if strings.HasPrefix(f.Path, "sets/") && strings.HasSuffix(f.Path, "/set.json") {
			trimmed := strings.TrimSuffix(strings.TrimPrefix(f.Path, "sets/"), "/set.json")
			if !strings.Contains(trimmed, "/") && ValidSetID(trimmed) {
				prefixes[trimmed] = "sets/" + trimmed + "/"
			}
		}
	}

	packages := map[string]map[string]PackageFile{}
	var available []string
	for setID, prefix := range prefixes {
		pkgFiles := map[string]PackageFile{}
		for _, f := range files {
			if !ValidUUID(f.ID) || !f.Content.Valid() {
				continue
			}
			if prefix != "" && !strings.HasPrefix(f.Path, prefix) {
				continue
			}
			rel := strings.TrimPrefix(f.Path, prefix)
			if rel == "set.json" || rel == "scene.glb" || rel == "poster.png" || cameraPNGPath.MatchString(rel) {
				pkgFiles[rel] = PackageFile{
					FileID:      f.ID,
					Path:        rel,
					ProjectPath: f.Path,
					Role:        f.Role,
					ContentRef:  f.Content,
				}
			}
		}
		if _, hasSet := pkgFiles["set.json"]; hasSet {
			if _, hasGLB := pkgFiles["scene.glb"]; hasGLB {
				if _, hasPoster := pkgFiles["poster.png"]; hasPoster {
					packages[setID] = pkgFiles
					available = append(available, setID)
				}
			}
		}
	}
	sort.Strings(available)
	return packages, available
}

func (s *UpstreamSource) ResolveProjectSet(ctx context.Context, identity Identity, projectID, revisionID, setID string) (ResolvedSetPackage, error) {
	if !ValidUUID(projectID) || !ValidUUID(revisionID) || (setID != "" && !ValidSetID(setID)) {
		return ResolvedSetPackage{}, &UpstreamError{Status: 400, Code: "INVALID_ARGUMENT"}
	}
	raw, err := s.callUpstream(ctx, identity, s.projectOrigin, s.projectToken, "/internal/v1/project/open", map[string]string{
		"project_id":  projectID,
		"revision_id": revisionID,
	})
	if err != nil {
		return ResolvedSetPackage{}, err
	}
	var openResp struct {
		ProjectID      string `json:"project_id"`
		RevisionID     string `json:"revision_id"`
		HeadRevisionID string `json:"head_revision_id"`
		Manifest       struct {
			ProjectID string         `json:"project_id"`
			Name      string         `json:"name"`
			Category  string         `json:"category"`
			Files     []manifestFile `json:"files"`
		} `json:"manifest"`
	}
	if json.Unmarshal(raw, &openResp) != nil || openResp.ProjectID != projectID || openResp.RevisionID != revisionID {
		return ResolvedSetPackage{}, &UpstreamError{Status: 502, Code: "UPSTREAM_INVALID"}
	}
	packages, available := extractSetPackages(openResp.Manifest.Files, "default")
	if len(available) == 0 {
		return ResolvedSetPackage{}, &UpstreamError{Status: 404, Code: "SET_PACKAGE_NOT_FOUND"}
	}
	chosen := setID
	if chosen == "" {
		chosen = available[0]
	}
	pkgFiles, ok := packages[chosen]
	if !ok {
		return ResolvedSetPackage{}, &UpstreamError{Status: 404, Code: "SET_PACKAGE_NOT_FOUND"}
	}
	return ResolvedSetPackage{
		SourceKind:     "project",
		ProjectID:      openResp.ProjectID,
		ProjectName:    openResp.Manifest.Name,
		RevisionID:     openResp.RevisionID,
		HeadRevisionID: openResp.HeadRevisionID,
		SetID:          chosen,
		AvailableSets:  available,
		Access: AccessScope{
			ProjectID:  openResp.ProjectID,
			RevisionID: openResp.RevisionID,
		},
		Files: pkgFiles,
	}, nil
}

func (s *UpstreamSource) ResolveWorldSet(ctx context.Context, identity Identity, assetID, versionID string) (ResolvedSetPackage, error) {
	if !ValidUUID(assetID) || !ValidUUID(versionID) {
		return ResolvedSetPackage{}, &UpstreamError{Status: 400, Code: "INVALID_ARGUMENT"}
	}
	raw, err := s.callUpstream(ctx, identity, s.worldOrigin, s.worldToken, "/internal/v1/world/get", map[string]string{
		"asset_id":         assetID,
		"asset_version_id": versionID,
	})
	if err != nil {
		return ResolvedSetPackage{}, err
	}
	var worldResp struct {
		AssetID   string `json:"asset_id"`
		VersionID string `json:"asset_version_id"`
		Manifest  struct {
			AssetID   string         `json:"asset_id"`
			Name      string         `json:"name"`
			AssetType string         `json:"asset_type"`
			Files     []manifestFile `json:"files"`
		} `json:"manifest"`
	}
	if json.Unmarshal(raw, &worldResp) != nil || worldResp.AssetID != assetID || worldResp.VersionID != versionID {
		return ResolvedSetPackage{}, &UpstreamError{Status: 502, Code: "UPSTREAM_INVALID"}
	}
	packages, available := extractSetPackages(worldResp.Manifest.Files, "world-set")
	if len(available) == 0 {
		return ResolvedSetPackage{}, &UpstreamError{Status: 404, Code: "SET_PACKAGE_NOT_FOUND"}
	}
	chosen := available[0]
	return ResolvedSetPackage{
		SourceKind:     "world",
		AssetID:        worldResp.AssetID,
		AssetName:      worldResp.Manifest.Name,
		AssetVersionID: worldResp.VersionID,
		SetID:          chosen,
		AvailableSets:  available,
		Access: AccessScope{
			AssetID:        worldResp.AssetID,
			AssetVersionID: worldResp.VersionID,
		},
		Files: packages[chosen],
	}, nil
}

func (s *UpstreamSource) ListCatalog(ctx context.Context, identity Identity) (CatalogResult, error) {
	if !ValidIdentity(identity) {
		return CatalogResult{}, &UpstreamError{Status: 403, Code: "FORBIDDEN"}
	}
	items := []CatalogEntry{}

	if rawProj, err := s.callUpstream(ctx, identity, s.projectOrigin, s.projectToken, "/internal/v1/project/list", map[string]any{"limit": 25}); err == nil {
		var list struct {
			Items []struct {
				ProjectID      string `json:"project_id"`
				HeadRevisionID string `json:"head_revision_id"`
				Name           string `json:"name"`
				Category       string `json:"category"`
			} `json:"items"`
		}
		if json.Unmarshal(rawProj, &list) == nil {
			for _, item := range list.Items {
				if !ValidUUID(item.ProjectID) || !ValidUUID(item.HeadRevisionID) {
					continue
				}
				resolved, err := s.ResolveProjectSet(ctx, identity, item.ProjectID, item.HeadRevisionID, "")
				if err == nil && len(resolved.AvailableSets) > 0 {
					items = append(items, CatalogEntry{
						SourceKind: "project",
						Title:      item.Name,
						Category:   item.Category,
						ProjectID:  item.ProjectID,
						RevisionID: item.HeadRevisionID,
						SetIDs:     resolved.AvailableSets,
					})
				}
			}
		}
	}

	if rawWorld, err := s.callUpstream(ctx, identity, s.worldOrigin, s.worldToken, "/internal/v1/world/list", map[string]any{"limit": 25}); err == nil {
		var list struct {
			Items []struct {
				AssetID       string `json:"asset_id"`
				HeadVersionID string `json:"head_asset_version_id"`
				Name          string `json:"name"`
				AssetType     string `json:"asset_type"`
			} `json:"items"`
		}
		if json.Unmarshal(rawWorld, &list) == nil {
			for _, item := range list.Items {
				if !ValidUUID(item.AssetID) || !ValidUUID(item.HeadVersionID) {
					continue
				}
				resolved, err := s.ResolveWorldSet(ctx, identity, item.AssetID, item.HeadVersionID)
				if err == nil && len(resolved.AvailableSets) > 0 {
					items = append(items, CatalogEntry{
						SourceKind:     "world",
						Title:          item.Name,
						Category:       item.AssetType,
						AssetID:        item.AssetID,
						AssetVersionID: item.HeadVersionID,
						SetIDs:         resolved.AvailableSets,
					})
				}
			}
		}
	}

	return CatalogResult{Items: items}, nil
}
