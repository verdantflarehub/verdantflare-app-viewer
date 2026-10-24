<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  type AppSDK,
  type CatalogEntry,
  type DashboardHost,
  type ResolvedSetPackage,
  ViewerLoadError,
  contextScope,
  hostProps,
  loadArtifactBinary,
  loadArtifactText,
  sha256Hex,
} from './sdk.ts'
import {
  type ParsedGlbScene,
  type SetCamera,
  type SetLightingPreset,
  type SetPackageManifest,
  type Vec3,
  buildCameraDeepLink,
  buildViewerAppPath,
  clampWalkPosition,
  interpolateCameraPose,
  parseGlbScene,
  parseViewerRoute,
  stepFirstPersonWalk,
  validateSetManifest,
} from './set-package.ts'
import { type BrowseMode, GlbViewportRenderer, type ViewportMetrics } from './glb-renderer.ts'

type ViewState = 'loading' | 'empty' | 'error' | 'ready'

interface CapturedShot {
  id: string
  title: string
  cameraId: string
  presetId: string
  dataUrl: string
  bytes: ArrayBuffer
  createdAt: string
}

const props = defineProps<{
  sdk?: AppSDK | null
  host?: DashboardHost | null
}>()

const viewState = ref<ViewState>('loading')
const loadingStage = ref<number>(1)
const loadingProgress = ref<number>(18)
const loadingMessage = ref<string>('正在通过受控通道解析片场固定修订与清单...')
const errorCode = ref<string>('')
const errorMessage = ref<string>('')

const resolvedPkg = ref<ResolvedSetPackage | null>(null)
const manifest = ref<SetPackageManifest | null>(null)
const parsedScene = ref<ParsedGlbScene | null>(null)
const catalogItems = ref<CatalogEntry[]>([])

const posterUrl = ref<string>('')
const cameraThumbUrls = ref<Record<string, string>>({})

const browseMode = ref<BrowseMode>('camera')
const activeCameraId = ref<string>('')
type InspectorTab = 'cam' | 'cast' | 'light' | 'layer' | 'shot' | 'info'
function isNarrowDesktopViewport(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const outerW = window.top?.innerWidth || window.innerWidth
    return outerW < 1600
  } catch {
    return window.innerWidth < 1340
  }
}

const inspectorTab = ref<InspectorTab>('cam')
const isNarrow = ref<boolean>(isNarrowDesktopViewport())
const inspectorCollapsed = ref<boolean>(isNarrow.value)

function onViewportResize(): void {
  const narrow = isNarrowDesktopViewport()
  if (narrow !== isNarrow.value) {
    isNarrow.value = narrow
    inspectorCollapsed.value = narrow
  }
}
const castVisible = ref<boolean>(true)
const showPerf = ref<boolean>(false)
const filmPage = ref<number>(0)
const panelCamPage = ref<number>(0)
const stageWidth = ref<number>(1100)
const layoutMode = ref<'document' | 'fill'>('document')
const PANEL_CAMS_PER_PAGE = 6
const activePresetId = ref<string>('saw-fluorescent')
const currentFrame = ref<number>(1)
const overlayEnabled = ref<boolean>(false)
const overlayOpacity = ref<number>(0.45)
const deepLinkCopied = ref<boolean>(false)

// Orbit / Walk camera state
const orbitYaw = ref<number>(0.55)
const orbitPitch = ref<number>(0.34)
const orbitDistance = ref<number>(4.2)
const orbitTarget = ref<Vec3>([0, 1.15, 0])

const walkPos = ref<Vec3>([0, 1.65, 1.5])
const walkYaw = ref<number>(0)
const walkPitch = ref<number>(0)
const activeKeys = new Set<string>()

const canvasEl = ref<HTMLCanvasElement | null>(null)
const safeFrameBoxEl = ref<HTMLElement | null>(null)
let renderer: GlbViewportRenderer | null = null
let rafId = 0
let lastTickMs = 0
let pointerDown = false
let lastPointerX = 0
let lastPointerY = 0
let abortController: AbortController | null = null
const objectUrls = new Set<string>()
const unsubscribers: Array<() => void> = []

const metrics = ref<ViewportMetrics>({
  backend: 'WebGL2',
  fallbackActive: false,
  fps: 60,
  frameTimeMs: 16.6,
  drawCalls: 0,
  triangles: 0,
  nodes: 0,
  textures: 0,
})
const firstScreenTtiMs = ref<number>(0)
const sceneReadyMs = ref<number>(0)
const captures = ref<CapturedShot[]>([])

const activeCamera = computed<SetCamera | null>(() => {
  if (!manifest.value) return null
  return (
    manifest.value.cameras.find(c => c.id === activeCameraId.value) ||
    manifest.value.cameras.find(c => c.id === manifest.value?.default_camera_id) ||
    manifest.value.cameras[0] ||
    null
  )
})

const activePreset = computed<SetLightingPreset>(() => {
  const presets = manifest.value?.lighting_presets || []
  return (
    presets.find(p => p.id === activePresetId.value) ||
    presets[0] || {
      id: 'studio-neutral',
      label: '标准工作光',
      exposure: 1.0,
      ambient_color: '#dce5e0',
      ambient_intensity: 0.72,
      key_light_color: '#fff9ed',
      key_light_intensity: 1.35,
      key_light_dir: [-0.42, -0.78, -0.46],
      fog_density: 0.012,
    }
  )
})

// Production / detail cameras first, overview & diagnostic cameras after; one ordered list for strip and panel.
const orderedCameras = computed<SetCamera[]>(() => {
  if (!manifest.value) return []
  const rank = (c: SetCamera) => (c.role === 'overview' ? 1 : 0)
  return [...manifest.value.cameras].sort((a, b) => rank(a) - rank(b))
})

// Canvas workbench rule (design spec §4.5): long lists page instead of scrolling.
const filmPerPage = computed<number>(() => Math.max(3, Math.floor((stageWidth.value - 120) / 150)))
const filmPageCount = computed<number>(() => Math.max(1, Math.ceil(orderedCameras.value.length / filmPerPage.value)))
const filmCameras = computed<SetCamera[]>(() => {
  const page = Math.min(filmPage.value, filmPageCount.value - 1)
  return orderedCameras.value.slice(page * filmPerPage.value, page * filmPerPage.value + filmPerPage.value)
})
const panelCamPageCount = computed<number>(() => Math.max(1, Math.ceil(orderedCameras.value.length / PANEL_CAMS_PER_PAGE)))
const panelCameras = computed<SetCamera[]>(() => {
  const page = Math.min(panelCamPage.value, panelCamPageCount.value - 1)
  return orderedCameras.value.slice(page * PANEL_CAMS_PER_PAGE, page * PANEL_CAMS_PER_PAGE + PANEL_CAMS_PER_PAGE)
})
const hasCast = computed<boolean>(() => (manifest.value?.cast.length || 0) > 0)

interface LineageChip { key: 'world' | 'scene' | 'setup'; label: string; current: boolean; linkable: boolean }
const lineageChips = computed<LineageChip[]>(() => {
  const l = manifest.value?.lineage
  if (!l) return []
  const chips: LineageChip[] = []
  if (l.world_asset) chips.push({ key: 'world', label: l.world_asset.label, current: false, linkable: Boolean(l.world_asset.id && l.world_asset.version_id) })
  if (l.project_scene) chips.push({ key: 'scene', label: l.project_scene.label, current: false, linkable: Boolean(l.project_scene.id && l.project_scene.material_key && l.project_scene.state_key) })
  if (l.setup) chips.push({ key: 'setup', label: l.setup.label, current: false, linkable: Boolean(l.project_scene?.id && l.setup.setup_key) })
  if (chips.length) chips[chips.length - 1].current = true
  return chips
})

const activeReferenceUrl = computed<string>(() => {
  const cam = activeCamera.value
  if (!cam?.thumbnail) return ''
  return cameraThumbUrls.value[cam.thumbnail] || ''
})

const sourceBadgeText = computed<string>(() => {
  if (resolvedPkg.value?.source_kind === 'project') {
    return `PROJECT REV · ${resolvedPkg.value.revision_id?.slice(0, 8) || 'FIXED'}`
  }
  if (resolvedPkg.value?.source_kind === 'world') {
    return `WORLD ASSET · ${resolvedPkg.value.asset_version_id?.slice(0, 8) || 'FIXED'}`
  }
  return 'SET PACKAGE v1.0'
})

const currentPose = computed<{ position: Vec3; target: Vec3; up: Vec3; fovY: number; near: number; far: number }>(() => {
  const cam = activeCamera.value
  if (browseMode.value === 'camera' && cam) {
    const interp = interpolateCameraPose(cam, currentFrame.value)
    return {
      position: interp.position,
      target: interp.target,
      up: cam.up,
      fovY: cam.fov_y_deg,
      near: cam.clip_near_m,
      far: cam.clip_far_m,
    }
  }
  if (browseMode.value === 'walk') {
    const p = walkPos.value
    const lookX = p[0] - Math.sin(walkYaw.value) * Math.cos(walkPitch.value)
    const lookY = p[1] + Math.sin(walkPitch.value)
    const lookZ = p[2] - Math.cos(walkYaw.value) * Math.cos(walkPitch.value)
    return {
      position: p,
      target: [lookX, lookY, lookZ],
      up: [0, 1, 0],
      fovY: 50,
      near: 0.05,
      far: 120,
    }
  }
  // Orbit mode
  const t = orbitTarget.value
  const d = orbitDistance.value
  const cp = Math.cos(orbitPitch.value)
  const sp = Math.sin(orbitPitch.value)
  const sy = Math.sin(orbitYaw.value)
  const cy = Math.cos(orbitYaw.value)
  return {
    position: [t[0] + d * cp * sy, t[1] + d * sp, t[2] + d * cp * cy],
    target: t,
    up: [0, 1, 0],
    fovY: 46,
    near: 0.05,
    far: 120,
  }
})

function registerObjectUrl(blob: Blob): string {
  const url = URL.createObjectURL(blob)
  objectUrls.add(url)
  return url
}

function clearObjectUrls(): void {
  for (const u of objectUrls) {
    URL.revokeObjectURL(u)
  }
  objectUrls.clear()
  posterUrl.value = ''
  cameraThumbUrls.value = {}
}

function currentHost() {
  return props.host || hostProps()?.host || null
}

/** AppDashboard contract §3: set-browsing pages fill the viewport; the index page stays a scrolling document. */
function applyHostLayout(mode: 'document' | 'fill'): void {
  layoutMode.value = mode
  currentHost()?.setLayout?.(mode)
  syncHeight()
}

function syncHeight(): void {
  const host = currentHost()
  if (layoutMode.value === 'fill' && host?.setLayout) return
  host?.resize(Math.max(document.documentElement.scrollHeight, 760))
}

function currentRouteString(): string {
  const sdk = props.sdk || hostProps()?.sdk
  const sdkPath = sdk?.navigation?.get?.()?.path
  if (sdkPath) return sdkPath
  if (typeof location !== 'undefined') {
    return location.search || '/'
  }
  return '/'
}

function currentBrowserHash(): string {
  return typeof location !== 'undefined' ? location.hash || '' : ''
}

async function ensureCameraThumbnailLoaded(cam: SetCamera | null): Promise<void> {
  if (!cam?.thumbnail || cameraThumbUrls.value[cam.thumbnail]) return
  const sdk = props.sdk || hostProps()?.sdk
  const pkg = resolvedPkg.value
  const m = manifest.value
  if (!m) return

  // Local package preview mode
  const localBase = getLocalPackageBaseUrl()
  if (localBase) {
    try {
      const resp = await fetch(`${localBase}/${cam.thumbnail}`)
      if (resp.ok) {
        const blob = await resp.blob()
        cameraThumbUrls.value = {
          ...cameraThumbUrls.value,
          [cam.thumbnail]: registerObjectUrl(blob),
        }
      }
    } catch {
      // Optional thumbnail
    }
    return
  }

  if (!sdk || !pkg) return
  const fileEntry = pkg.files[cam.thumbnail]
  const expected = m.files[cam.thumbnail]?.sha256
  if (!fileEntry) return
  try {
    const bin = await loadArtifactBinary(
      sdk,
      fileEntry.content_ref,
      pkg.access,
      expected,
      10 * 1024 * 1024,
      abortController?.signal
    )
    const blob = new Blob([bin.bytes], { type: bin.mime || 'image/png' })
    cameraThumbUrls.value = {
      ...cameraThumbUrls.value,
      [cam.thumbnail]: registerObjectUrl(blob),
    }
  } catch {
    // Reference render is optional
  }
}

function getLocalPackageBaseUrl(): string | null {
  if (typeof window === 'undefined') return null
  const w = window as Window & { __VIEWER_LOCAL_PACKAGE_URL__?: string }
  if (w.__VIEWER_LOCAL_PACKAGE_URL__) return w.__VIEWER_LOCAL_PACKAGE_URL__.replace(/\/+$/, '')
  const sp = new URLSearchParams(location.search)
  const param = sp.get('localPackageUrl')
  return param ? param.replace(/\/+$/, '') : null
}

async function loadFromLocalPackage(baseUrl: string, initialCameraId: string, rendererHint: 'auto' | 'webgl2'): Promise<void> {
  const t0 = performance.now()
  viewState.value = 'loading'
  loadingStage.value = 1
  loadingProgress.value = 25
  loadingMessage.value = '阶段 1/3：正在加载 set.json 清单与首屏海报...'

  const setResp = await fetch(`${baseUrl}/set.json`, { cache: 'no-store' })
  if (!setResp.ok) {
    throw new ViewerLoadError('SET_PACKAGE_NOT_FOUND', `无法加载本地片场清单 (${setResp.status})`, setResp.status)
  }
  const setJsonText = await setResp.text()
  const validated = validateSetManifest(JSON.parse(setJsonText))
  manifest.value = validated
  resolvedPkg.value = {
    source_kind: 'project',
    project_id: '01a16250-d1aa-7667-add1-588f58042bbc',
    project_name: validated.title,
    revision_id: '01a1691d-bd00-7195-bb28-982913b20c14',
    set_id: validated.set_id,
    available_sets: [validated.set_id],
    access: {
      project_id: '01a16250-d1aa-7667-add1-588f58042bbc',
      project_revision_id: '01a1691d-bd00-7195-bb28-982913b20c14',
    },
    files: {},
  }

  // Poster
  const posterResp = await fetch(`${baseUrl}/poster.png`, { cache: 'no-store' })
  if (posterResp.ok) {
    const posterBytes = await posterResp.arrayBuffer()
    const posterHash = await sha256Hex(posterBytes)
    if (validated.files['poster.png'] && posterHash !== validated.files['poster.png'].sha256) {
      throw new ViewerLoadError('HASH_MISMATCH', 'poster.png SHA-256 校验失败。', 502)
    }
    posterUrl.value = registerObjectUrl(new Blob([posterBytes], { type: 'image/png' }))
  }

  applyInitialManifestState(validated, initialCameraId)
  firstScreenTtiMs.value = Math.round(performance.now() - t0)

  // Stage 2: scene.glb
  loadingStage.value = 2
  loadingProgress.value = 68
  loadingMessage.value = '阶段 2/3：正在流式解析 scene.glb 几何与内嵌 PBR 贴图...'
  const glbResp = await fetch(`${baseUrl}/scene.glb`, { cache: 'no-store' })
  if (!glbResp.ok) {
    throw new ViewerLoadError('CONTENT_FETCH_FAILED', 'scene.glb 加载失败。', glbResp.status)
  }
  const glbBytes = await glbResp.arrayBuffer()
  const glbHash = await sha256Hex(glbBytes)
  if (validated.files['scene.glb'] && glbHash !== validated.files['scene.glb'].sha256) {
    throw new ViewerLoadError('HASH_MISMATCH', 'scene.glb SHA-256 哈希校验未通过。', 502)
  }
  const scene = parseGlbScene(glbBytes)
  parsedScene.value = scene

  loadingStage.value = 3
  loadingProgress.value = 100
  viewState.value = 'ready'
  await nextTick()
  await mountViewportRenderer(scene, validated.cameras, rendererHint)
  sceneReadyMs.value = Math.round(performance.now() - t0)
  void ensureCameraThumbnailLoaded(activeCamera.value)
  publishPerfReport()
}

function applyInitialManifestState(m: SetPackageManifest, requestedCamId: string): void {
  const matchedCam = m.cameras.find(c => c.id === requestedCamId)
  const chosenCam = matchedCam || m.cameras.find(c => c.id === m.default_camera_id) || m.cameras[0]
  if (chosenCam) {
    activeCameraId.value = chosenCam.id
    const idx = orderedCameras.value.findIndex(c => c.id === chosenCam.id)
    filmPage.value = idx >= 0 ? Math.floor(idx / filmPerPage.value) : 0
    panelCamPage.value = idx >= 0 ? Math.floor(idx / PANEL_CAMS_PER_PAGE) : 0
    currentFrame.value = chosenCam.frame_range ? chosenCam.frame_range[0] : 1
    browseMode.value = 'camera'
  }
  const initialPreset = m.lighting_presets.find(p => p.id === 'saw-fluorescent') || m.lighting_presets[0]
  if (initialPreset) {
    activePresetId.value = initialPreset.id
  }
  castVisible.value = true
  if (!m.cast.length && inspectorTab.value === 'cast') inspectorTab.value = 'cam'
  walkPos.value = clampWalkPosition(
    m.nav.spawn_point,
    m.nav.walk_bounds_min,
    m.nav.walk_bounds_max,
    m.nav.eye_height_m
  )
  walkYaw.value = (m.nav.spawn_yaw_deg * Math.PI) / 180
  walkPitch.value = 0
}

async function loadFromTarget(): Promise<void> {
  abortController?.abort()
  abortController = new AbortController()
  clearObjectUrls()
  errorCode.value = ''
  errorMessage.value = ''

  const routeTarget = parseViewerRoute(currentRouteString(), currentBrowserHash())
  const localBase = getLocalPackageBaseUrl()
  applyHostLayout(routeTarget.sourceKind === 'none' && !localBase ? 'document' : 'fill')
  if (localBase) {
    try {
      await loadFromLocalPackage(localBase, routeTarget.cameraId, routeTarget.rendererHint)
    } catch (err) {
      handleLoadError(err)
    }
    return
  }

  const sdk = props.sdk || hostProps()?.sdk
  if (!sdk) {
    errorCode.value = 'HOST_UNAVAILABLE'
    errorMessage.value = '请从 Studio 应用中心或项目短剧页打开片场查看器。'
    viewState.value = 'error'
    return
  }

  if (routeTarget.sourceKind === 'none') {
    viewState.value = 'loading'
    loadingStage.value = 1
    loadingProgress.value = 40
    loadingMessage.value = '正在查询当前账号可读的片场包目录...'
    try {
      const res = await sdk.app.request(
        { method: 'GET', path: '/api/v1/sets/catalog' },
        { signal: abortController.signal }
      )
      if (res.status === 200 && res.data && typeof res.data === 'object') {
        const items = (res.data as { items?: CatalogEntry[] }).items
        catalogItems.value = Array.isArray(items) ? items : []
      }
      viewState.value = 'empty'
      syncHeight()
    } catch (err) {
      handleLoadError(err)
    }
    return
  }

  const t0 = performance.now()
  viewState.value = 'loading'
  loadingStage.value = 1
  loadingProgress.value = 20
  loadingMessage.value = '阶段 1/3：正在按当前用户权限解析固定版本片场包...'

  try {
    const apiPath =
      routeTarget.sourceKind === 'project'
        ? routeTarget.setId
          ? `/api/v1/sets/project/${routeTarget.projectId}/revisions/${routeTarget.revisionId}/sets/${routeTarget.setId}`
          : `/api/v1/sets/project/${routeTarget.projectId}/revisions/${routeTarget.revisionId}`
        : `/api/v1/sets/world/${routeTarget.assetId}/versions/${routeTarget.versionId}`

    const resolveResp = await sdk.app.request(
      { method: 'GET', path: apiPath },
      { signal: abortController.signal }
    )
    if (resolveResp.status !== 200 || !resolveResp.data) {
      const errCode = (resolveResp.data as { code?: string })?.code || 'RESOLVE_FAILED'
      throw new ViewerLoadError(
        errCode,
        resolveResp.status === 403
          ? '当前账号没有访问该项目修订或世界资产的读权限。'
          : resolveResp.status === 404
            ? '目标版本未包含片场包（Set Package v1.0）。'
            : '片场包解析服务暂不可用，请稍后重试。',
        resolveResp.status
      )
    }

    const pkg = resolveResp.data as ResolvedSetPackage
    resolvedPkg.value = pkg
    const setFile = pkg.files['set.json']
    const glbFile = pkg.files['scene.glb']
    const posterFile = pkg.files['poster.png']
    if (!setFile || !glbFile || !posterFile) {
      throw new ViewerLoadError('INCOMPLETE_SET_PACKAGE', '片场包缺少必需的 set.json、scene.glb 或 poster.png。', 422)
    }

    loadingProgress.value = 42
    loadingMessage.value = '阶段 1/3：正在经 artifact.read 读取并校验 set.json 与 poster.png...'

    const setJsonText = await loadArtifactText(
      sdk,
      setFile.content_ref,
      pkg.access,
      undefined,
      abortController.signal
    )
    const validated = validateSetManifest(JSON.parse(setJsonText))
    manifest.value = validated

    // Load poster.png and verify against set.json.files['poster.png'].sha256
    const posterBin = await loadArtifactBinary(
      sdk,
      posterFile.content_ref,
      pkg.access,
      validated.files['poster.png']?.sha256,
      10 * 1024 * 1024,
      abortController.signal
    )
    posterUrl.value = registerObjectUrl(new Blob([posterBin.bytes], { type: posterBin.mime || 'image/png' }))
    applyInitialManifestState(validated, routeTarget.cameraId)
    firstScreenTtiMs.value = Math.round(performance.now() - t0)

    // Stage 2: Load scene.glb
    loadingStage.value = 2
    loadingProgress.value = 74
    loadingMessage.value = '阶段 2/3：正在经 artifact.read 下载并校验 scene.glb...'
    const glbBin = await loadArtifactBinary(
      sdk,
      glbFile.content_ref,
      pkg.access,
      validated.files['scene.glb']?.sha256,
      50 * 1024 * 1024,
      abortController.signal
    )
    const scene = parseGlbScene(glbBin.bytes)
    parsedScene.value = scene

    loadingStage.value = 3
    loadingProgress.value = 100
    viewState.value = 'ready'
    await nextTick()
    await mountViewportRenderer(scene, validated.cameras, routeTarget.rendererHint)
    sceneReadyMs.value = Math.round(performance.now() - t0)
    void ensureCameraThumbnailLoaded(activeCamera.value)
    publishPerfReport()
    syncHeight()
  } catch (err) {
    handleLoadError(err)
  }
}

function handleLoadError(err: unknown): void {
  if ((err as { name?: string })?.name === 'AbortError') return
  if (err instanceof ViewerLoadError) {
    errorCode.value = err.code
    errorMessage.value = err.message
  } else {
    errorCode.value = 'VIEWER_ERROR'
    errorMessage.value = err instanceof Error ? err.message : '加载片场包时发生未知错误。'
  }
  viewState.value = 'error'
  syncHeight()
}

async function mountViewportRenderer(
  scene: ParsedGlbScene,
  cameras: SetCamera[],
  rendererHint: 'auto' | 'webgl2'
): Promise<void> {
  if (!canvasEl.value) return
  renderer?.dispose()
  renderer = new GlbViewportRenderer(canvasEl.value)
  await renderer.init(rendererHint)
  await renderer.loadScene(scene, cameras)
  startRenderLoop()
}

function startRenderLoop(): void {
  cancelAnimationFrame(rafId)
  lastTickMs = performance.now()
  const tick = (now: number) => {
    const dtSec = Math.min(0.1, Math.max(0.001, (now - lastTickMs) / 1000))
    lastTickMs = now
    if (browseMode.value === 'walk' && manifest.value) {
      const forward = (activeKeys.has('KeyW') || activeKeys.has('ArrowUp') ? 1 : 0) -
        (activeKeys.has('KeyS') || activeKeys.has('ArrowDown') ? 1 : 0)
      const right = (activeKeys.has('KeyD') || activeKeys.has('ArrowRight') ? 1 : 0) -
        (activeKeys.has('KeyA') || activeKeys.has('ArrowLeft') ? 1 : 0)
      if (forward !== 0 || right !== 0) {
        walkPos.value = stepFirstPersonWalk(
          walkPos.value,
          walkYaw.value,
          { forward, right },
          dtSec,
          manifest.value.nav.walk_speed_mps,
          manifest.value.nav.walk_bounds_min,
          manifest.value.nav.walk_bounds_max,
          manifest.value.nav.eye_height_m
        )
      }
    }
    if (renderer && viewState.value === 'ready') {
      const pose = currentPose.value
      const cam = browseMode.value === 'camera' ? activeCamera.value : null
      const camAspect = cam?.aspect_ratio && cam.aspect_ratio > 0 ? cam.aspect_ratio : 16 / 9
      let overscanY = 1.0
      if (cam && canvasEl.value) {
        const cW = canvasEl.value.clientWidth || 1280
        const cH = canvasEl.value.clientHeight || 720
        const measuredBoxH = safeFrameBoxEl.value?.clientHeight || 0
        if (measuredBoxH > 20) {
          overscanY = Math.max(1.0, cH / measuredBoxH)
        } else {
          const wrapW = Math.max(100, cW - 56)
          const wrapH = Math.max(100, cH - 56)
          const boxH = Math.min(wrapH, wrapW / camAspect)
          overscanY = Math.max(1.0, cH / Math.max(1, boxH))
        }
      }
      const isIndoor = manifest.value
        ? Math.max(manifest.value.bounds.size[0], manifest.value.bounds.size[2]) <= 25
        : true
      metrics.value = renderer.renderFrame({
        cameraPos: pose.position,
        cameraTarget: pose.target,
        cameraUp: pose.up,
        fovYDeg: pose.fovY,
        projection: cam?.projection || 'PERSP',
        orthoScale: cam?.ortho_scale,
        cameraAspect: camAspect,
        overscanY,
        hiddenObjects: cam ? cam.hide_objects || [] : [],
        hiddenPrefixes: hasCast.value && !castVisible.value ? ['ACTOR_'] : [],
        indoorTileGrid: isIndoor,
        near: pose.near,
        far: pose.far,
        preset: activePreset.value,
        showHelpers: browseMode.value !== 'camera',
      })
      publishPerfReport()
    }
    rafId = requestAnimationFrame(tick)
  }
  rafId = requestAnimationFrame(tick)
}

function publishPerfReport(): void {
  if (typeof window === 'undefined') return
  const w = window as Window & { __VIEWER_PERF_REPORT__?: Record<string, unknown> }
  w.__VIEWER_PERF_REPORT__ = {
    setId: manifest.value?.set_id || '',
    firstScreenTtiMs: firstScreenTtiMs.value,
    sceneReadyMs: sceneReadyMs.value,
    backend: metrics.value.backend,
    fallbackActive: metrics.value.fallbackActive,
    fps: metrics.value.fps,
    frameTimeMs: metrics.value.frameTimeMs,
    drawCalls: metrics.value.drawCalls,
    triangles: metrics.value.triangles,
    nodes: metrics.value.nodes,
    textures: metrics.value.textures,
    activeCameraId: activeCameraId.value,
    activePresetId: activePresetId.value,
  }
}

function selectCamera(cam: SetCamera): void {
  activeCameraId.value = cam.id
  browseMode.value = 'camera'
  currentFrame.value = cam.frame_range ? cam.frame_range[0] : 1
  void ensureCameraThumbnailLoaded(cam)

  const sdk = props.sdk || hostProps()?.sdk
  const pkg = resolvedPkg.value
  const nextPath = buildViewerAppPath({
    sourceKind: pkg?.source_kind || 'none',
    projectId: pkg?.project_id,
    revisionId: pkg?.revision_id,
    assetId: pkg?.asset_id,
    versionId: pkg?.asset_version_id,
    setId: pkg?.set_id,
    cameraId: cam.id,
  })
  void sdk?.navigation?.request?.({ target: 'app', path: nextPath })
  publishPerfReport()
}

function switchMode(mode: BrowseMode): void {
  if (mode === 'orbit' && browseMode.value === 'camera' && activeCamera.value) {
    orbitTarget.value = [...activeCamera.value.target] as Vec3
    const dx = activeCamera.value.position[0] - activeCamera.value.target[0]
    const dy = activeCamera.value.position[1] - activeCamera.value.target[1]
    const dz = activeCamera.value.position[2] - activeCamera.value.target[2]
    orbitDistance.value = Math.max(1.2, Math.hypot(dx, dy, dz))
    orbitYaw.value = Math.atan2(dx, dz)
    orbitPitch.value = Math.asin(Math.max(-0.85, Math.min(0.85, dy / orbitDistance.value)))
  } else if (mode === 'walk' && manifest.value) {
    walkPos.value = clampWalkPosition(
      manifest.value.nav.spawn_point,
      manifest.value.nav.walk_bounds_min,
      manifest.value.nav.walk_bounds_max,
      manifest.value.nav.eye_height_m
    )
  }
  browseMode.value = mode
}

function onPointerDown(e: PointerEvent): void {
  pointerDown = true
  lastPointerX = e.clientX
  lastPointerY = e.clientY
  if (browseMode.value === 'camera') {
    // Dragging in locked camera transitions smoothly to Orbit around the camera's target
    switchMode('orbit')
  }
}

function onPointerMove(e: PointerEvent): void {
  if (!pointerDown) return
  const dx = e.clientX - lastPointerX
  const dy = e.clientY - lastPointerY
  lastPointerX = e.clientX
  lastPointerY = e.clientY

  if (browseMode.value === 'orbit') {
    orbitYaw.value -= dx * 0.0065
    orbitPitch.value = Math.max(-1.25, Math.min(1.25, orbitPitch.value + dy * 0.0065))
  } else if (browseMode.value === 'walk') {
    walkYaw.value -= dx * 0.005
    walkPitch.value = Math.max(-1.1, Math.min(1.1, walkPitch.value - dy * 0.005))
  }
}

function onPointerUp(): void {
  pointerDown = false
}

function onWheel(e: WheelEvent): void {
  if (browseMode.value === 'camera') {
    switchMode('orbit')
  }
  if (browseMode.value === 'orbit') {
    orbitDistance.value = Math.max(0.8, Math.min(18, orbitDistance.value + e.deltaY * 0.003))
  }
}

async function copyDeepLink(): Promise<void> {
  const pkg = resolvedPkg.value
  const camId = activeCameraId.value || manifest.value?.default_camera_id || 'C1'
  const link = buildCameraDeepLink(
    typeof location !== 'undefined' ? location.origin : 'https://studio.dev.verdantflarehub.com',
    {
      sourceKind: pkg?.source_kind || 'project',
      projectId: pkg?.project_id,
      revisionId: pkg?.revision_id,
      assetId: pkg?.asset_id,
      versionId: pkg?.asset_version_id,
      setId: pkg?.set_id || manifest.value?.set_id,
      cameraId: camId,
    }
  )
  try {
    await navigator.clipboard?.writeText(link)
  } catch {
    // Clipboard API fallback
  }
  deepLinkCopied.value = true
  setTimeout(() => {
    deepLinkCopied.value = false
  }, 1800)
}

async function takeCleanScreenshot(): Promise<void> {
  if (!renderer || !manifest.value) return
  const pose = currentPose.value
  const cam = browseMode.value === 'camera' ? activeCamera.value : null
  const camAspect = cam?.aspect_ratio && cam.aspect_ratio > 0 ? cam.aspect_ratio : 16 / 9
  const isIndoor = Math.max(manifest.value.bounds.size[0], manifest.value.bounds.size[2]) <= 25
  const camId = browseMode.value === 'camera' ? activeCameraId.value : browseMode.value.toUpperCase()
  const shot = await renderer.captureCleanScreenshot({
    cameraPos: pose.position,
    cameraTarget: pose.target,
    cameraUp: pose.up,
    fovYDeg: pose.fovY,
    projection: cam?.projection || 'PERSP',
    orthoScale: cam?.ortho_scale,
    cameraAspect: camAspect,
    hiddenObjects: cam ? cam.hide_objects || [] : [],
    hiddenPrefixes: hasCast.value && !castVisible.value ? ['ACTOR_'] : [],
    indoorTileGrid: isIndoor,
    near: pose.near,
    far: pose.far,
    preset: activePreset.value,
    width: 1920,
    height: Math.round(1920 / camAspect),
  })
  const title = `${manifest.value.title} · ${camId} · ${activePreset.value.label}`
  const item: CapturedShot = {
    id: `${Date.now()}`,
    title,
    cameraId: camId,
    presetId: activePreset.value.id,
    dataUrl: shot.dataUrl,
    bytes: shot.bytes,
    createdAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
  }
  captures.value = [item, ...captures.value.slice(0, 7)]
  await openInHostLightbox(item)
}

async function openInHostLightbox(item: CapturedShot): Promise<void> {
  const sdk = props.sdk || hostProps()?.sdk
  if (sdk?.media?.preview) {
    await sdk.media.preview({
      bytes: item.bytes,
      mime: 'image/png',
      title: item.title.slice(0, 256),
    })
  }
}

function downloadCapture(item: CapturedShot): void {
  const a = document.createElement('a')
  a.href = item.dataUrl
  a.download = `${manifest.value?.set_id || 'set'}_${item.cameraId}_${item.presetId}.png`
  a.click()
}

function openCatalogItem(entry: CatalogEntry, setId: string): void {
  const sdk = props.sdk || hostProps()?.sdk
  const nextPath = buildViewerAppPath({
    sourceKind: entry.source_kind,
    projectId: entry.project_id,
    revisionId: entry.revision_id,
    assetId: entry.asset_id,
    versionId: entry.asset_version_id,
    setId,
  })
  if (sdk?.navigation?.request) {
    void sdk.navigation.request({ target: 'app', path: nextPath }).then(() => loadFromTarget())
  }
}

function openLineage(chip: LineageChip): void {
  const l = manifest.value?.lineage
  if (!l || !chip.linkable || chip.current) return
  if (chip.key === 'world' && l.world_asset?.id && l.world_asset.version_id) {
    openExternalApp('world', `/scene/${l.world_asset.id}?version=${l.world_asset.version_id}`)
    return
  }
  const scene = l.project_scene
  if (!scene?.id || !scene.material_key || !scene.state_key) return
  const revision = scene.version_id ? `?revision=${scene.version_id}` : ''
  const base = `/ai_short_drama/${scene.id}/materials/location/${scene.material_key}/${scene.state_key}`
  openExternalApp('project', chip.key === 'setup' && l.setup?.setup_key ? `${base}/setups/${l.setup.setup_key}${revision}` : `${base}${revision}`)
}

function stepCamera(delta: number): void {
  const list = orderedCameras.value
  if (!list.length) return
  const idx = Math.max(0, list.findIndex(c => c.id === activeCameraId.value))
  const next = list[Math.min(list.length - 1, Math.max(0, idx + delta))]
  if (next && next.id !== activeCameraId.value) {
    selectCamera(next)
    filmPage.value = Math.floor(list.indexOf(next) / filmPerPage.value)
  }
}

function openInspector(tab: InspectorTab): void {
  if (tab === 'cast' && !hasCast.value) return
  inspectorTab.value = tab
  inspectorCollapsed.value = false
}

function openExternalApp(appId: 'project' | 'world', path: string): void {
  const sdk = props.sdk || hostProps()?.sdk
  void sdk?.navigation?.openApp?.({ appId, path })
}

function onKeyDown(e: KeyboardEvent): void {
  const tag = (e.target as HTMLElement | null)?.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
  activeKeys.add(e.code)
  if (viewState.value !== 'ready') return
  if (e.key === ']') stepCamera(1)
  else if (e.key === '[') stepCamera(-1)
  else if (e.code === 'KeyF') showPerf.value = !showPerf.value
}

function onKeyUp(e: KeyboardEvent): void {
  activeKeys.delete(e.code)
}

watch(activePresetId, () => {
  publishPerfReport()
})

watch([filmCameras, panelCameras, inspectorTab], () => {
  for (const cam of filmCameras.value) void ensureCameraThumbnailLoaded(cam)
  if (inspectorTab.value === 'cam') for (const cam of panelCameras.value) void ensureCameraThumbnailLoaded(cam)
})

let stageObserver: ResizeObserver | null = null
const stageEl = ref<HTMLElement | null>(null)
watch(stageEl, el => {
  stageObserver?.disconnect()
  if (!el || typeof ResizeObserver === 'undefined') return
  stageObserver = new ResizeObserver(entries => {
    const w = entries[0]?.contentRect.width
    if (w) stageWidth.value = w
    onViewportResize()
  })
  stageObserver.observe(el)
})

onMounted(() => {
  const resolved = hostProps()
  const sdk = props.sdk ?? resolved?.sdk ?? null
  const host = props.host ?? resolved?.host ?? null

  if (sdk) {
    document.body.dataset.theme = sdk.theme.get()
    unsubscribers.push(
      sdk.theme.subscribe(t => {
        document.body.dataset.theme = t
      })
    )
    const initialScope = contextScope(sdk)
    unsubscribers.push(
      sdk.context.subscribe(() => {
        if (contextScope(sdk) !== initialScope) {
          void loadFromTarget()
        }
      })
    )
    if (sdk.navigation) {
      unsubscribers.push(
        sdk.navigation.subscribe(() => {
          void loadFromTarget()
        })
      )
    }
    unsubscribers.push(
      sdk.lifecycle.subscribe(ev => {
        if (ev === 'dispose') {
          cancelAnimationFrame(rafId)
          renderer?.dispose()
          clearObjectUrls()
        }
      })
    )
  } else {
    document.body.dataset.theme = 'dark'
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('resize', onViewportResize)
  try {
    window.top?.addEventListener('resize', onViewportResize)
  } catch {
    // cross-origin guard
  }
  onViewportResize()

  host?.ready()
  void loadFromTarget()
})

onBeforeUnmount(() => {
  stageObserver?.disconnect()
  if (layoutMode.value === 'fill') currentHost()?.setLayout?.('document')
  abortController?.abort()
  cancelAnimationFrame(rafId)
  renderer?.dispose()
  clearObjectUrls()
  for (const stop of unsubscribers.splice(0)) stop()
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('resize', onViewportResize)
  try {
    window.top?.removeEventListener('resize', onViewportResize)
  } catch {
    // cross-origin guard
  }
})
</script>

<template>
  <div class="viewer-shell" :class="{ 'is-fill': layoutMode === 'fill' }" data-testid="viewer-shell">
    <!-- 48px single-row top bar: breadcrumb from app name, lineage chain, actions. No back button. -->
    <header class="viewer-topbar">
      <nav class="breadcrumb-row" aria-label="面包屑">
        <span class="breadcrumb-root">片场查看器</span>
        <template v-if="manifest">
          <span class="breadcrumb-sep">/</span>
          <span class="breadcrumb-current" aria-current="page" data-testid="set-title">{{ manifest.title }}</span>
        </template>
      </nav>

      <div v-if="manifest" class="lineage-row" data-testid="lineage">
        <template v-if="lineageChips.length">
          <template v-for="(chip, i) in lineageChips" :key="chip.key">
            <span v-if="i > 0" class="lineage-sep" aria-hidden="true">›</span>
            <button
              type="button"
              class="lineage-chip"
              :class="{ current: chip.current }"
              :disabled="chip.current || !chip.linkable"
              :aria-current="chip.current ? 'page' : undefined"
              :data-testid="`lineage-${chip.key}`"
              @click="openLineage(chip)"
            >
              {{ chip.label }}
            </button>
          </template>
        </template>
        <span v-else class="lineage-chip current">{{ sourceBadgeText }}</span>
      </div>

      <div class="topbar-actions">
        <button
          v-if="viewState === 'ready'"
          type="button"
          class="vf-btn"
          data-testid="btn-copy-deeplink"
          @click="copyDeepLink"
        >
          {{ deepLinkCopied ? '已复制深链' : '复制深链' }}
        </button>
        <button
          v-if="viewState === 'ready'"
          type="button"
          class="vf-btn primary"
          data-testid="btn-clean-screenshot"
          @click="takeCleanScreenshot"
        >
          截图
        </button>
      </div>
    </header>

    <div class="viewer-workspace" :class="{ 'inspector-collapsed': inspectorCollapsed, 'is-narrow': isNarrow }">
      <main ref="stageEl" class="viewport-stage">
        <div class="viewport-area">
          <div
            v-if="posterUrl && viewState !== 'ready'"
            class="poster-backdrop"
            :style="{ backgroundImage: `url(${posterUrl})` }"
          />

          <section v-if="viewState === 'loading'" class="state-card" data-testid="state-loading">
            <h2 class="state-title">正在装载片场（{{ loadingStage }}/3）</h2>
            <p class="state-desc">{{ loadingMessage }}</p>
            <div class="progress-track"><div class="progress-fill" :style="{ width: `${loadingProgress}%` }" /></div>
            <div class="badge-mono">artifact.read · SHA-256 校验</div>
          </section>

          <section v-else-if="viewState === 'empty'" class="state-card" data-testid="state-empty">
            <h2 class="state-title">选择要检视的片场</h2>
            <p class="state-desc">片场查看器按固定项目修订或数字世界资产版本打开片场包。</p>
            <div v-if="catalogItems.length > 0" class="catalog-list">
              <div
                v-for="item in catalogItems"
                :key="`${item.source_kind}-${item.project_id || item.asset_id}`"
                class="catalog-item"
              >
                <div>
                  <div class="catalog-title">{{ item.title }}</div>
                  <div class="camera-optics">
                    {{ item.source_kind === 'project' ? 'Project 固定修订' : 'World 资产版本' }} · {{ item.set_ids.join(', ') }}
                  </div>
                </div>
                <button type="button" class="vf-btn primary" @click="openCatalogItem(item, item.set_ids[0])">打开片场</button>
              </div>
            </div>
            <div class="state-actions">
              <button type="button" class="vf-btn primary" @click="openExternalApp('project', '/ai_short_drama')">前往短剧项目</button>
              <button type="button" class="vf-btn" @click="openExternalApp('world', '/')">前往数字世界</button>
            </div>
          </section>

          <section v-else-if="viewState === 'error'" class="state-card" data-testid="state-error">
            <div class="badge-mono danger">{{ errorCode || 'ERROR' }}</div>
            <h2 class="state-title">无法打开片场包</h2>
            <p class="state-desc">{{ errorMessage }}</p>
            <div class="state-actions">
              <button type="button" class="vf-btn primary" @click="loadFromTarget">重新加载</button>
              <button type="button" class="vf-btn" @click="openExternalApp('project', '/ai_short_drama')">前往项目列表</button>
            </div>
          </section>

          <template v-if="viewState === 'ready' && manifest">
            <canvas
              ref="canvasEl"
              class="viewport-canvas"
              data-testid="viewport-canvas"
              @pointerdown="onPointerDown"
              @pointermove="onPointerMove"
              @wheel.prevent="onWheel"
            />

            <!-- Safe frame is centred in the canvas so the overscan frustum stays 1:1 with the reference render. -->
            <div v-if="browseMode === 'camera' && activeCamera" class="safe-frame-wrap" data-testid="safe-frame">
              <div
                ref="safeFrameBoxEl"
                class="safe-frame-box"
                :style="{ aspectRatio: String(activeCamera.aspect_ratio || 16 / 9) }"
              >
                <img
                  v-if="overlayEnabled && activeReferenceUrl"
                  :src="activeReferenceUrl"
                  alt="Blender 基准渲染"
                  class="reference-overlay-img"
                  :style="{ opacity: overlayOpacity }"
                  data-testid="reference-overlay-img"
                >
                <div class="safe-frame-grid-h" />
                <div class="safe-frame-grid-v" />
              </div>
            </div>

            <div class="hud-chip hud-tl" data-testid="safe-frame-badge">
              <template v-if="browseMode === 'camera' && activeCamera">
                {{ activeCamera.id }} ·
                <template v-if="activeCamera.projection === 'ORTHO'">ORTHO · Scale {{ (activeCamera.ortho_scale || 24).toFixed(1) }}m</template>
                <template v-else>{{ activeCamera.focal_length_mm }}mm · FOV-Y {{ activeCamera.fov_y_deg.toFixed(2) }}°</template>
                <template v-if="activeCamera.shot_ref"> · {{ activeCamera.shot_ref }}</template>
              </template>
              <template v-else>{{ browseMode === 'orbit' ? '环绕' : '漫游 WASD' }}</template>
            </div>
            <div v-if="showPerf" class="hud-chip hud-tr" data-testid="hud-perf">
              {{ metrics.backend }}{{ metrics.fallbackActive ? ' (Fallback)' : '' }} · {{ metrics.fps }} fps ·
              {{ metrics.nodes }} 节点 · {{ metrics.triangles.toLocaleString() }} 三角面
            </div>

            <div class="viewport-dock" data-testid="viewport-dock">
              <div class="seg" role="group" aria-label="浏览模式">
                <button type="button" :class="{ on: browseMode === 'camera' }" data-testid="mode-camera" @click="switchMode('camera')">机位锁定</button>
                <button type="button" :class="{ on: browseMode === 'orbit' }" data-testid="mode-orbit" @click="switchMode('orbit')">环绕</button>
                <button type="button" :class="{ on: browseMode === 'walk' }" data-testid="mode-walk" @click="switchMode('walk')">漫游</button>
              </div>

              <template v-if="browseMode === 'camera' && activeCamera?.frame_range">
                <div class="dock-divider" />
                <label class="scrubber-row" data-testid="frame-scrubber">
                  <span>Fra {{ currentFrame }}</span>
                  <input
                    v-model.number="currentFrame"
                    type="range"
                    :min="activeCamera.frame_range[0]"
                    :max="activeCamera.frame_range[1]"
                    step="1"
                  >
                </label>
              </template>

              <div class="dock-divider" />
              <select v-model="activePresetId" class="dock-select" aria-label="灯光预设" data-testid="preset-select">
                <option v-for="preset in manifest.lighting_presets" :key="preset.id" :value="preset.id">{{ preset.label }}</option>
              </select>

              <button
                v-if="hasCast"
                type="button"
                class="dock-toggle"
                :class="{ on: castVisible }"
                data-testid="btn-toggle-cast"
                @click="castVisible = !castVisible"
              >
                {{ castVisible ? '人物 · 显示' : '人物 · 隐藏' }}
              </button>

              <template v-if="browseMode === 'camera' && activeReferenceUrl">
                <button
                  type="button"
                  class="dock-toggle"
                  :class="{ on: overlayEnabled }"
                  data-testid="btn-toggle-overlay"
                  @click="overlayEnabled = !overlayEnabled"
                >
                  叠图对比
                </button>
                <input
                  v-if="overlayEnabled"
                  v-model.number="overlayOpacity"
                  class="dock-range"
                  type="range"
                  min="0.1"
                  max="0.95"
                  step="0.05"
                  aria-label="叠图透明度"
                >
              </template>
              <button
                type="button"
                class="dock-toggle"
                :class="{ on: showPerf }"
                title="性能指标（F）"
                data-testid="btn-toggle-perf"
                @click="showPerf = !showPerf"
              >
                F
              </button>
            </div>
          </template>
        </div>

        <!-- Camera film strip: paged, never scrolls ([ / ] switch cameras). -->
        <div v-if="viewState === 'ready' && manifest" class="film-strip" data-testid="film-strip">
          <button type="button" class="film-page" aria-label="上一页机位" :disabled="filmPage <= 0" @click="filmPage--">‹</button>
          <div class="film-frames">
            <button
              v-for="cam in filmCameras"
              :key="cam.id"
              type="button"
              class="film-frame"
              :class="{ on: activeCameraId === cam.id && browseMode === 'camera' }"
              :data-testid="`camera-card-${cam.id}`"
              :title="cam.label"
              @click="selectCamera(cam)"
            >
              <img v-if="cam.thumbnail && cameraThumbUrls[cam.thumbnail]" :src="cameraThumbUrls[cam.thumbnail]" alt="">
              <span>{{ cam.id }}</span>
            </button>
          </div>
          <button type="button" class="film-page" aria-label="下一页机位" :disabled="filmPage >= filmPageCount - 1" @click="filmPage++">›</button>
          <span class="film-count">{{ Math.min(filmPage, filmPageCount - 1) + 1 }}/{{ filmPageCount }}</span>
        </div>
      </main>

      <aside class="viewer-inspector" :class="{ collapsed: inspectorCollapsed }" data-testid="viewer-inspector">
        <div class="inspector-rail" role="tablist" aria-label="检视面板">
          <button type="button" :class="{ on: inspectorTab === 'cam' && !inspectorCollapsed }" data-testid="tab-cam" @click="openInspector('cam')">机位</button>
          <button type="button" :class="{ on: inspectorTab === 'cast' && !inspectorCollapsed }" :disabled="!hasCast" data-testid="tab-cast" @click="openInspector('cast')">人物</button>
          <button type="button" :class="{ on: inspectorTab === 'light' && !inspectorCollapsed }" data-testid="tab-light" @click="openInspector('light')">灯光</button>
          <button type="button" :class="{ on: inspectorTab === 'layer' && !inspectorCollapsed }" data-testid="tab-layer" @click="openInspector('layer')">图层</button>
          <button type="button" :class="{ on: inspectorTab === 'shot' && !inspectorCollapsed }" data-testid="tab-shot" @click="openInspector('shot')">截图</button>
          <button type="button" :class="{ on: inspectorTab === 'info' && !inspectorCollapsed }" data-testid="tab-info" @click="openInspector('info')">信息</button>
          <button type="button" class="rail-collapse" :title="inspectorCollapsed ? '展开面板' : '收起面板'" data-testid="btn-collapse-inspector" @click="inspectorCollapsed = !inspectorCollapsed">
            {{ inspectorCollapsed ? '«' : '»' }}
          </button>
        </div>

        <div v-if="manifest && !inspectorCollapsed" class="inspector-pane">
          <template v-if="inspectorTab === 'cam'">
            <div class="pane-title">机位 <span class="badge-mono">{{ manifest.cameras.length }}</span></div>
            <div class="pane-grid" data-testid="camera-list">
              <button
                v-for="cam in panelCameras"
                :key="cam.id"
                type="button"
                class="film-frame"
                :class="{ on: activeCameraId === cam.id && browseMode === 'camera' }"
                :title="cam.label"
                @click="selectCamera(cam)"
              >
                <img v-if="cam.thumbnail && cameraThumbUrls[cam.thumbnail]" :src="cameraThumbUrls[cam.thumbnail]" alt="">
                <span>{{ cam.id }}</span>
              </button>
            </div>
            <div v-if="activeCamera" class="pane-row">
              <span>{{ activeCamera.label }}<small>
                <template v-if="activeCamera.projection === 'ORTHO'">ORTHO · Scale {{ (activeCamera.ortho_scale || 24).toFixed(1) }}m</template>
                <template v-else>{{ activeCamera.focal_length_mm }}mm · FOV-Y {{ activeCamera.fov_y_deg.toFixed(2) }}°</template>
                <template v-if="activeCamera.shot_ref"> · {{ activeCamera.shot_ref }}</template>
              </small></span>
            </div>
            <div class="pane-pager">
              <button type="button" class="vf-btn" :disabled="panelCamPage <= 0" @click="panelCamPage--">上一页</button>
              <span>{{ Math.min(panelCamPage, panelCamPageCount - 1) + 1 }}/{{ panelCamPageCount }}</span>
              <button type="button" class="vf-btn" :disabled="panelCamPage >= panelCamPageCount - 1" @click="panelCamPage++">下一页</button>
            </div>
          </template>

          <template v-else-if="inspectorTab === 'cast'">
            <div class="pane-title">登场人物 <span class="badge-mono">{{ manifest.cast.length }}</span></div>
            <div v-for="member in manifest.cast.slice(0, 8)" :key="member.node_prefix" class="pane-row">
              <span>{{ member.label }}<small>{{ member.wardrobe_label || member.node_prefix }}</small></span>
            </div>
            <p class="pane-note">“人物”开关隐藏全部 ACTOR_ 替身，用于同机位对比空景。</p>
          </template>

          <template v-else-if="inspectorTab === 'light'">
            <div class="pane-title">灯光预设</div>
            <button
              v-for="preset in manifest.lighting_presets.slice(0, 8)"
              :key="preset.id"
              type="button"
              class="pane-row selectable"
              :class="{ on: activePresetId === preset.id }"
              :data-testid="`preset-${preset.id}`"
              @click="activePresetId = preset.id"
            >
              <span>{{ preset.label }}</span>
            </button>
          </template>

          <template v-else-if="inspectorTab === 'layer'">
            <div class="pane-title">图层</div>
            <div class="pane-row"><span>场景与道具</span><span class="badge-mono accent">显示</span></div>
            <div class="pane-row">
              <span>ACTOR_ 人物替身</span>
              <span class="badge-mono" :class="{ accent: hasCast && castVisible }">{{ hasCast ? (castVisible ? '显示' : '隐藏') : '无' }}</span>
            </div>
            <div class="pane-row"><span>机位隐藏对象</span><span class="badge-mono">{{ activeCamera?.hide_objects?.length || 0 }}</span></div>
          </template>

          <template v-else-if="inspectorTab === 'shot'">
            <div class="pane-title">本次截图 <span class="badge-mono">{{ captures.length }}</span></div>
            <p v-if="captures.length === 0" class="pane-note">点顶栏“截图”导出无界面画面；点缩略图在宿主灯箱放大。</p>
            <div v-else class="pane-grid" data-testid="capture-list">
              <button
                v-for="shot in captures.slice(0, 6)"
                :key="shot.id"
                type="button"
                class="film-frame"
                :title="shot.title"
                @click="openInHostLightbox(shot)"
              >
                <img :src="shot.dataUrl" :alt="shot.title">
                <span>{{ shot.cameraId }}</span>
              </button>
            </div>
            <button v-if="captures.length" type="button" class="vf-btn" @click="downloadCapture(captures[0])">下载最新截图</button>
          </template>

          <template v-else>
            <div class="pane-title">片场信息</div>
            <dl class="meta-grid">
              <dt class="meta-label">片场标识</dt><dd class="meta-val">{{ manifest.set_id }}</dd>
              <dt class="meta-label">源工程哈希</dt><dd class="meta-val">{{ manifest.source_blend_sha256.slice(0, 16) }}…</dd>
              <dt class="meta-label">来源</dt><dd class="meta-val">{{ sourceBadgeText }}</dd>
              <dt class="meta-label">空间尺寸</dt>
              <dd class="meta-val">{{ manifest.bounds.size[0].toFixed(1) }} × {{ manifest.bounds.size[2].toFixed(1) }} × {{ manifest.bounds.size[1].toFixed(1) }} m</dd>
              <dt class="meta-label">渲染</dt>
              <dd class="meta-val" data-testid="renderer-backend">{{ metrics.backend }}{{ metrics.fallbackActive ? ' (Fallback)' : '' }} · {{ metrics.fps }} fps</dd>
              <dt class="meta-label">几何</dt><dd class="meta-val">{{ metrics.nodes }} 节点 · {{ metrics.triangles.toLocaleString() }} 三角面</dd>
              <dt class="meta-label">首屏</dt><dd class="meta-val">{{ firstScreenTtiMs }} ms</dd>
            </dl>
          </template>
        </div>
      </aside>
    </div>
  </div>
</template>
