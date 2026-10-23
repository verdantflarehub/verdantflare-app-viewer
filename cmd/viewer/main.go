package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/verdantflarehub/verdantflare-app-viewer/internal/server"
	"github.com/verdantflarehub/verdantflare-app-viewer/internal/viewer"
)

func run() int {
	projectURL := os.Getenv("PROJECT_SERVICE_URL")
	if projectURL == "" {
		projectURL = "https://app-project.verdantflare-app.svc.cluster.local:8443"
	}
	worldURL := os.Getenv("WORLD_SERVICE_URL")
	if worldURL == "" {
		worldURL = "https://app-world.verdantflare-app.svc.cluster.local:8443"
	}
	caFile := os.Getenv("INTERNAL_CA_FILE")
	if caFile == "" {
		caFile = os.Getenv("SSL_CERT_FILE")
	}
	source, err := viewer.NewUpstreamSource(
		projectURL,
		os.Getenv("PROJECT_SERVICE_TOKEN"),
		worldURL,
		os.Getenv("WORLD_SERVICE_TOKEN"),
		caFile,
		nil,
	)
	if err != nil {
		slog.Error("viewer_configuration_invalid")
		return 1
	}
	assets := os.Getenv("VIEWER_ASSETS_DIR")
	if assets == "" {
		assets = "frontend/dist"
	}
	if _, err := os.Stat(assets + "/index.html"); err != nil {
		slog.Error("viewer_assets_unavailable")
		return 1
	}
	handler, err := server.New(
		os.Getenv("APP_SERVICE_TOKEN"),
		os.Getenv("STATION_ID"),
		viewer.Service{Source: source},
		os.DirFS(assets),
	)
	if err != nil {
		slog.Error("viewer_configuration_invalid")
		return 1
	}
	listen := os.Getenv("VIEWER_LISTEN")
	if listen == "" {
		listen = "0.0.0.0:8000"
	}
	s := &http.Server{
		Addr:              listen,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      20 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		<-ctx.Done()
		stop, release := context.WithTimeout(context.Background(), 10*time.Second)
		defer release()
		_ = s.Shutdown(stop)
	}()
	if err := s.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("viewer_server_stopped")
		return 1
	}
	return 0
}

func main() { os.Exit(run()) }
