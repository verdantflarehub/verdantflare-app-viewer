package server

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"strings"

	"github.com/verdantflarehub/verdantflare-app-viewer/internal/buildinfo"
	"github.com/verdantflarehub/verdantflare-app-viewer/internal/dashboard"
	"github.com/verdantflarehub/verdantflare-app-viewer/internal/viewer"
)

type Server struct {
	credential string
	stationID  string
	viewer     viewer.Service
	assets     *dashboard.Assets
}

func New(credential, stationID string, service viewer.Service, assets fs.FS) (*Server, error) {
	if len(credential) < 32 ||
		strings.ContainsAny(credential, " \t\r\n") ||
		!viewer.ValidUUID(stationID) ||
		service.Source == nil {
		return nil, errors.New("invalid Viewer configuration")
	}
	var handler *dashboard.Assets
	if assets != nil {
		var err error
		handler, err = dashboard.Load(assets, buildinfo.Version)
		if err != nil {
			return nil, errors.New("invalid Viewer dashboard assets")
		}
	}
	return &Server{
		credential: credential,
		stationID:  stationID,
		viewer:     service,
		assets:     handler,
	}, nil
}

func reply(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func fail(w http.ResponseWriter, status int, code string) {
	reply(w, status, map[string]string{"code": code})
}

func writeUpstreamError(w http.ResponseWriter, err error) {
	var upstream *viewer.UpstreamError
	if errors.As(err, &upstream) {
		fail(w, upstream.Status, upstream.Code)
		return
	}
	fail(w, http.StatusBadGateway, "UPSTREAM_UNAVAILABLE")
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.URL.Path == "/healthz" && r.Method == http.MethodGet {
		reply(w, http.StatusOK, map[string]string{"status": "ok", "version": buildinfo.Version})
		return
	}
	if len(r.Header.Values("Authorization")) != 1 ||
		subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.credential)) != 1 {
		fail(w, http.StatusUnauthorized, "UNAUTHENTICATED")
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		fail(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
		return
	}
	if r.URL.RawQuery != "" || r.URL.ForceQuery || r.URL.RawPath != "" || r.Header.Get("Content-Encoding") != "" {
		fail(w, http.StatusBadRequest, "INVALID_REQUEST")
		return
	}
	if r.URL.Path == "/internal/dashboard/declaration" || r.URL.Path == "/internal/dashboard/index" {
		if s.assets == nil {
			fail(w, http.StatusServiceUnavailable, "DASHBOARD_UNAVAILABLE")
			return
		}
		data := s.assets.Declaration()
		if r.URL.Path == "/internal/dashboard/index" {
			data = s.assets.Index()
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(data)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/dashboard/") {
		if s.assets == nil {
			fail(w, http.StatusNotFound, "NOT_FOUND")
			return
		}
		data, mime, ok := s.assets.File(strings.TrimPrefix(r.URL.Path, "/dashboard/"))
		if !ok {
			fail(w, http.StatusNotFound, "NOT_FOUND")
			return
		}
		w.Header().Set("Content-Type", mime)
		_, _ = w.Write(data)
		return
	}

	reqID := r.Header.Get("X-Request-Id")
	if reqID == "" {
		reqID = r.Header.Get("X-Station-Id")
	}
	identity := viewer.Identity{
		UserID:         r.Header.Get("X-User-Id"),
		OrganizationID: r.Header.Get("X-Organization-Id"),
		StationID:      r.Header.Get("X-Station-Id"),
		RequestID:      reqID,
	}
	if len(r.Header.Values("X-User-Id")) != 1 ||
		len(r.Header.Values("X-Organization-Id")) != 1 ||
		len(r.Header.Values("X-Station-Id")) != 1 ||
		!viewer.ValidIdentity(identity) ||
		identity.StationID != s.stationID {
		fail(w, http.StatusForbidden, "FORBIDDEN")
		return
	}

	if r.URL.Path == "/api/v1/sets/catalog" {
		res, err := s.viewer.Source.ListCatalog(r.Context(), identity)
		if err != nil {
			writeUpstreamError(w, err)
			return
		}
		reply(w, http.StatusOK, res)
		return
	}

	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
	// /api/v1/sets/project/:project_id/revisions/:revision_id
	if len(parts) == 7 && parts[0] == "api" && parts[1] == "v1" && parts[2] == "sets" && parts[3] == "project" && parts[5] == "revisions" {
		res, err := s.viewer.Source.ResolveProjectSet(r.Context(), identity, parts[4], parts[6], "")
		if err != nil {
			writeUpstreamError(w, err)
			return
		}
		reply(w, http.StatusOK, res)
		return
	}
	// /api/v1/sets/project/:project_id/revisions/:revision_id/sets/:set_id
	if len(parts) == 9 && parts[0] == "api" && parts[1] == "v1" && parts[2] == "sets" && parts[3] == "project" && parts[5] == "revisions" && parts[7] == "sets" {
		res, err := s.viewer.Source.ResolveProjectSet(r.Context(), identity, parts[4], parts[6], parts[8])
		if err != nil {
			writeUpstreamError(w, err)
			return
		}
		reply(w, http.StatusOK, res)
		return
	}
	// /api/v1/sets/world/:asset_id/versions/:version_id
	if len(parts) == 7 && parts[0] == "api" && parts[1] == "v1" && parts[2] == "sets" && parts[3] == "world" && parts[5] == "versions" {
		res, err := s.viewer.Source.ResolveWorldSet(r.Context(), identity, parts[4], parts[6])
		if err != nil {
			writeUpstreamError(w, err)
			return
		}
		reply(w, http.StatusOK, res)
		return
	}

	fail(w, http.StatusNotFound, "NOT_FOUND")
}
