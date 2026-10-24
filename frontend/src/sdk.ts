// Consumer types for the central app-dashboard-v1 contract.
export type Lifecycle = 'active' | 'hidden' | 'dispose'

export interface AppRoute {
  path: string
  revision: number
}

export interface AppContext {
  userId: string
  organizationId: string
  stationId: string
  projectId: string | null
  appId: string
  installationId: string
  contextRevision: string
}

export interface PreviewGallery {
  id: string
  index: number
  count: number
}

export interface AppSDK {
  version: string
  app: {
    request(
      input: { path: string; method: 'GET' | 'POST'; body?: unknown },
      options?: { signal?: AbortSignal }
    ): Promise<{ status: number; data: unknown; requestId: string }>
  }
  capabilities?: {
    has?(capability: string): boolean
    call(
      capability: string,
      input: Record<string, unknown>,
      options?: { signal?: AbortSignal }
    ): Promise<unknown>
  }
  media?: {
    preview(input: {
      bytes: ArrayBuffer
      mime: string
      title: string
      gallery?: PreviewGallery
    }): Promise<void>
    close?(): void
  }
  lifecycle: { subscribe(listener: (event: Lifecycle) => void): () => void }
  context: { get?(): Readonly<AppContext>; subscribe(listener: () => void): () => void }
  theme: { get(): 'light' | 'dark'; subscribe(listener: (theme: 'light' | 'dark') => void): () => void }
  navigation?: {
    get(): AppRoute
    subscribe(listener: (route: AppRoute) => void): () => void
    request?(input: { target: 'app' | 'appcenter'; path: string }): Promise<unknown>
    openApp?(input: { appId: string; path?: string }): Promise<unknown>
  }
}

export interface DashboardHost {
  ready(): void
  resize(height: number): void
  /** AppDashboard contract §3: optional on newer hosts; old hosts keep document layout. */
  setLayout?(mode: 'document' | 'fill'): void
  getScroll?(): number
  restoreScroll?(top: number): void
}

declare global {
  interface Window {
    $wujie?: {
      props?: {
        appSDK?: AppSDK
        dashboardHost?: DashboardHost
      }
    }
  }
}

export function hostProps(): { sdk: AppSDK; host: DashboardHost } | null {
  const props = typeof window !== 'undefined' ? window.$wujie?.props : undefined
  if (
    !props?.appSDK ||
    !props.dashboardHost ||
    !/^1\.(?:[1-9]\d*)\./.test(props.appSDK.version) ||
    !props.appSDK.theme
  ) {
    return null
  }
  return { sdk: props.appSDK, host: props.dashboardHost }
}

export function contextScope(sdk: AppSDK): string | null {
  const value = sdk.context.get?.()
  return value
    ? JSON.stringify([
        value.userId,
        value.organizationId,
        value.stationId,
        value.projectId,
        value.appId,
        value.installationId,
        value.contextRevision,
      ])
    : null
}

export interface ContentRef {
  store_id: string
  artifact_id: string
  version_id: string
}

export interface AccessScope {
  project_id?: string
  project_revision_id?: string
  asset_id?: string
  asset_version_id?: string
}

export interface PackageFileEntry {
  file_id: string
  path: string
  project_path: string
  role: string
  content_ref: ContentRef
}

export interface ResolvedSetPackage {
  source_kind: 'project' | 'world'
  project_id?: string
  project_name?: string
  revision_id?: string
  head_revision_id?: string
  asset_id?: string
  asset_name?: string
  asset_version_id?: string
  set_id: string
  available_sets: string[]
  access: AccessScope
  files: Record<string, PackageFileEntry>
}

export interface CatalogEntry {
  source_kind: 'project' | 'world'
  title: string
  category?: string
  project_id?: string
  revision_id?: string
  asset_id?: string
  asset_version_id?: string
  set_ids: string[]
}

export class ViewerLoadError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 500) {
    super(message)
    this.code = code
    this.status = status
  }
}

const UUID_V4_RE = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const HANDLE_PATH_RE = new RegExp(`^/studio/dashboards/${UUID_V4_RE}/content/${UUID_V4_RE}$`)

export function controlledContentPath(path: string, currentOrigin?: string): string {
  if (!HANDLE_PATH_RE.test(path)) {
    throw new ViewerLoadError('INVALID_CONTENT_HANDLE', '受控内容读取句柄格式无效。', 502)
  }
  const baseOrigin = currentOrigin || (typeof location !== 'undefined' ? location.origin : 'https://studio.local')
  const url = new URL(path, baseOrigin)
  if (url.origin !== baseOrigin || url.pathname !== path || url.search || url.hash) {
    throw new ViewerLoadError('INVALID_CONTENT_HANDLE', '受控内容读取地址与当前会话不匹配。', 502)
  }
  return url.pathname
}

export async function sha256Hex(input: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

interface ArtifactDownloadResponse {
  mode: string
  version: ContentRef & {
    mime: string
    size: number
    sha256: string
  }
  text?: string
  content_path?: string
}

export async function loadArtifactText(
  sdk: AppSDK,
  contentRef: ContentRef,
  access: AccessScope,
  expectedSha256?: string,
  signal?: AbortSignal
): Promise<string> {
  if (!sdk.capabilities?.call) {
    throw new ViewerLoadError('CAPABILITY_UNAVAILABLE', '当前宿主未授予 artifact.read 能力。', 403)
  }
  try {
    const raw = (await sdk.capabilities.call(
      'artifact.read',
      { mode: 'text', content_ref: contentRef, access },
      { signal }
    )) as ArtifactDownloadResponse
    if (
      raw?.mode !== 'text' ||
      typeof raw.text !== 'string' ||
      !raw.version ||
      raw.version.version_id !== contentRef.version_id
    ) {
      throw new ViewerLoadError('INVALID_ARTIFACT_PAYLOAD', '片场清单读取返回内容不完整。', 502)
    }
    const bytes = new TextEncoder().encode(raw.text)
    const actualHash = await sha256Hex(bytes)
    if (actualHash !== raw.version.sha256 || (expectedSha256 && actualHash !== expectedSha256)) {
      throw new ViewerLoadError('HASH_MISMATCH', '片场清单 SHA-256 完整性校验失败。', 502)
    }
    return raw.text
  } catch (err) {
    if (err instanceof ViewerLoadError) throw err
    const binary = await loadArtifactBinary(sdk, contentRef, access, expectedSha256, 4 * 1024 * 1024, signal)
    return new TextDecoder('utf-8', { fatal: true }).decode(binary.bytes)
  }
}

export async function loadArtifactBinary(
  sdk: AppSDK,
  contentRef: ContentRef,
  access: AccessScope,
  expectedSha256: string | undefined,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ bytes: ArrayBuffer; mime: string; sha256: string }> {
  if (!sdk.capabilities?.call) {
    throw new ViewerLoadError('CAPABILITY_UNAVAILABLE', '当前宿主未授予 artifact.read 能力。', 403)
  }
  const dl = (await sdk.capabilities.call(
    'artifact.read',
    { mode: 'download', content_ref: contentRef, access },
    { signal }
  )) as ArtifactDownloadResponse
  const v = dl?.version
  if (
    !v ||
    v.store_id !== contentRef.store_id ||
    v.artifact_id !== contentRef.artifact_id ||
    v.version_id !== contentRef.version_id ||
    typeof v.mime !== 'string' ||
    !Number.isSafeInteger(v.size) ||
    v.size < 0 ||
    v.size > maxBytes ||
    !/^[a-f0-9]{64}$/.test(v.sha256) ||
    typeof dl.content_path !== 'string'
  ) {
    throw new ViewerLoadError('INVALID_ARTIFACT_PAYLOAD', '片场资产元数据不匹配或超出体积上限。', 502)
  }
  const safePath = controlledContentPath(dl.content_path)
  const resp = await fetch(safePath, {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal,
  })
  if (!resp.ok) {
    throw new ViewerLoadError(
      resp.status === 403 ? 'PERMISSION_DENIED' : 'CONTENT_FETCH_FAILED',
      resp.status === 403 ? '当前身份无权读取此片场包资产。' : '片场资产下载失败，请重试。',
      resp.status
    )
  }
  const bytes = await resp.arrayBuffer()
  if (bytes.byteLength !== v.size || bytes.byteLength > maxBytes) {
    throw new ViewerLoadError('SIZE_MISMATCH', '片场资产字节长度与清单不一致。', 502)
  }
  const actualHash = await sha256Hex(bytes)
  if (actualHash !== v.sha256 || (expectedSha256 && actualHash !== expectedSha256)) {
    throw new ViewerLoadError('HASH_MISMATCH', '片场资产 SHA-256 哈希校验未通过。', 502)
  }
  return {
    bytes,
    mime: v.mime.split(';')[0].trim().toLowerCase(),
    sha256: actualHash,
  }
}
