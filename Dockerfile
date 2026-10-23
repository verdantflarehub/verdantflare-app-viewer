FROM node:24-bookworm-slim AS frontend
WORKDIR /src/frontend
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
COPY VERSION ../VERSION
RUN pnpm build

FROM scratch AS dashboard-artifact
COPY --from=frontend /src/frontend/dist/ /

FROM golang:1.26-bookworm AS backend
ARG APP_VERSION
WORKDIR /src
COPY go.mod ./
COPY cmd/ cmd/
COPY internal/ internal/
RUN test -n "$APP_VERSION" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w -X github.com/verdantflarehub/verdantflare-app-viewer/internal/buildinfo.Version=$APP_VERSION" -o /viewer ./cmd/viewer

FROM gcr.io/distroless/static-debian12:nonroot
ARG APP_VERSION
LABEL org.opencontainers.image.version=$APP_VERSION
WORKDIR /app
COPY --from=backend /viewer /viewer
COPY --from=frontend /src/frontend/dist/ frontend/dist/
ENV VIEWER_LISTEN=0.0.0.0:8000
EXPOSE 8000
ENTRYPOINT ["/viewer"]
