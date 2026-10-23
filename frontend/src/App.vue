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
const cameraTab = ref<'production' | 'overview'>('production')
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

const filteredCameras = computed<SetCamera[]>(() => {
  if (!manifest.value) return []
  if (cameraTab.value === 'production') {
    return manifest.value.cameras.filter(c => c.role === 'production' || c.role === 'detail')
  }
  return manifest.value.cameras.filter(c => c.role === 'overview')
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

function syncHeight(): void {
  const host = props.host || hostProps()?.host
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
    cameraTab.value = chosenCam.role === 'overview' ? 'overview' : 'production'
    currentFrame.value = chosenCam.frame_range ? chosenCam.frame_range[0] : 1
    browseMode.value = 'camera'
  }
  const sawPreset = m.lighting_presets.find(p => p.id === 'saw-fluorescent') || m.lighting_presets[0]
  if (sawPreset) {
    activePresetId.value = sawPreset.id
  }
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
      metrics.value = renderer.renderFrame({
        cameraPos: pose.position,
        cameraTarget: pose.target,
        cameraUp: pose.up,
        fovYDeg: pose.fovY,
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
  const camId = browseMode.value === 'camera' ? activeCameraId.value : browseMode.value.toUpperCase()
  const shot = await renderer.captureCleanScreenshot({
    cameraPos: pose.position,
    cameraTarget: pose.target,
    cameraUp: pose.up,
    fovYDeg: pose.fovY,
    near: pose.near,
    far: pose.far,
    preset: activePreset.value,
    width: 1920,
    height: 1080,
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

function openExternalApp(appId: 'project' | 'world', path: string): void {
  const sdk = props.sdk || hostProps()?.sdk
  void sdk?.navigation?.openApp?.({ appId, path })
}

function onKeyDown(e: KeyboardEvent): void {
  activeKeys.add(e.code)
}

function onKeyUp(e: KeyboardEvent): void {
  activeKeys.delete(e.code)
}

watch(activePresetId, () => {
  publishPerfReport()
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

  host?.ready()
  void loadFromTarget()
})

onBeforeUnmount(() => {
  abortController?.abort()
  cancelAnimationFrame(rafId)
  renderer?.dispose()
  clearObjectUrls()
  for (const stop of unsubscribers.splice(0)) stop()
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('pointerup', onPointerUp)
})
</script>

<template>
  <div class="viewer-shell" data-testid="viewer-shell">
    <!-- Top Bar: ClaudeStyle Breadcrumb from "片场查看器" with no back button -->
    <header class="viewer-topbar">
      <div class="breadcrumb-row">
        <span class="breadcrumb-root">片场查看器</span>
        <template v-if="manifest">
          <span class="breadcrumb-sep">/</span>
          <span class="breadcrumb-current" data-testid="set-title">
            {{ manifest.title }} · {{ manifest.set_id }}
          </span>
        </template>
        <span class="badge-mono">{{ sourceBadgeText }}</span>
        <span
          v-if="viewState === 'ready'"
          class="badge-mono accent"
          data-testid="renderer-backend"
        >
          {{ metrics.backend }}{{ metrics.fallbackActive ? ' (Fallback)' : '' }}
        </span>
      </div>

      <div class="topbar-actions">
        <button
          v-if="viewState === 'ready'"
          type="button"
          class="vf-btn"
          data-testid="btn-copy-deeplink"
          @click="copyDeepLink"
        >
          {{ deepLinkCopied ? '已复制深链' : `复制深链 ?cam=${activeCameraId || 'C1'}` }}
        </button>
        <button
          v-if="viewState === 'ready'"
          type="button"
          class="vf-btn primary"
          data-testid="btn-clean-screenshot"
          @click="takeCleanScreenshot"
        >
          纯净截图 1080p
        </button>
      </div>
    </header>

    <!-- Main Full-Width Workspace -->
    <div class="viewer-workspace">
      <main class="viewport-stage">
        <!-- Progressive Stage 1 Poster Backdrop -->
        <div
          v-if="posterUrl && viewState !== 'ready'"
          class="poster-backdrop"
          :style="{ backgroundImage: `url(${posterUrl})` }"
        />

        <!-- Loading State -->
        <section
          v-if="viewState === 'loading'"
          class="state-card"
          data-testid="state-loading"
        >
          <h2 class="state-title">正在装载 3D 片场包 (Stage {{ loadingStage }}/3)</h2>
          <p class="state-desc">{{ loadingMessage }}</p>
          <div class="progress-track">
            <div class="progress-fill" :style="{ width: `${loadingProgress}%` }" />
          </div>
          <div class="badge-mono">artifact.read · SHA-256 强校验</div>
        </section>

        <!-- Empty State -->
        <section
          v-else-if="viewState === 'empty'"
          class="state-card"
          data-testid="state-empty"
        >
          <h2 class="state-title">选择要检视的 3D 片场包</h2>
          <p class="state-desc">
            片场查看器通过固定项目修订或数字世界资产版本受控加载 Set Package v1.0（glTF 2.0 + 实拍机位 + 灯光预设）。
          </p>

          <div v-if="catalogItems.length > 0" class="catalog-list">
            <div
              v-for="item in catalogItems"
              :key="`${item.source_kind}-${item.project_id || item.asset_id}`"
              class="catalog-item"
            >
              <div>
                <div style="font-size: 13px; font-weight: 600">{{ item.title }}</div>
                <div class="camera-optics">
                  {{ item.source_kind === 'project' ? 'Project 固定修订' : 'World 资产版本' }} ·
                  {{ item.set_ids.join(', ') }}
                </div>
              </div>
              <button
                type="button"
                class="vf-btn primary"
                @click="openCatalogItem(item, item.set_ids[0])"
              >
                打开片场
              </button>
            </div>
          </div>

          <div style="display: flex; gap: 8px; flex-wrap: wrap">
            <button
              type="button"
              class="vf-btn primary"
              @click="openExternalApp('project', '/ai_short_drama')"
            >
              前往短剧项目选择片场
            </button>
            <button
              type="button"
              class="vf-btn"
              @click="openExternalApp('world', '/')"
            >
              前往数字世界资产库
            </button>
          </div>
        </section>

        <!-- Error State -->
        <section
          v-else-if="viewState === 'error'"
          class="state-card"
          data-testid="state-error"
        >
          <div class="badge-mono" style="margin-bottom: 10px; color: var(--danger)">
            {{ errorCode || 'ERROR' }}
          </div>
          <h2 class="state-title">无法打开片场包</h2>
          <p class="state-desc">{{ errorMessage }}</p>
          <div style="display: flex; gap: 8px">
            <button type="button" class="vf-btn primary" @click="loadFromTarget">
              重新加载
            </button>
            <button
              type="button"
              class="vf-btn"
              @click="openExternalApp('project', '/ai_short_drama')"
            >
              前往项目列表
            </button>
          </div>
        </section>

        <!-- Ready State: 3D Viewport Canvas + HUD + Safe Frame + Dock -->
        <template v-if="viewState === 'ready' && manifest">
          <canvas
            ref="canvasEl"
            class="viewport-canvas"
            data-testid="viewport-canvas"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @wheel.prevent="onWheel"
          />

          <!-- Optional Blender Reference Render Overlay for Alignment Inspection -->
          <img
            v-if="browseMode === 'camera' && overlayEnabled && activeReferenceUrl"
            :src="activeReferenceUrl"
            alt="Blender Reference Render"
            class="reference-overlay-img"
            :style="{ opacity: overlayOpacity }"
            data-testid="reference-overlay-img"
          >

          <!-- 16:9 Safe Frame when locked to a Blender Camera -->
          <div
            v-if="browseMode === 'camera' && activeCamera"
            class="safe-frame-wrap"
            data-testid="safe-frame"
          >
            <div class="safe-frame-box">
              <div class="safe-frame-grid-h" />
              <div class="safe-frame-grid-v" />
              <div class="safe-frame-badge" data-testid="safe-frame-badge">
                {{ activeCamera.blender_name }} · {{ activeCamera.focal_length_mm }}mm · FOV-Y
                {{ activeCamera.fov_y_deg.toFixed(2) }}°
                <template v-if="activeCamera.shot_ref">
                  · {{ activeCamera.shot_ref }}
                </template>
              </div>
            </div>
          </div>

          <!-- Top-Left Real-Time Telemetry HUD -->
          <div class="viewport-hud-top">
            <span class="hud-pill" data-testid="hud-mode">
              MODE: {{ browseMode.toUpperCase() }}
            </span>
            <span class="hud-pill" data-testid="hud-geometry">
              NODES: {{ metrics.nodes }} · TRIS: {{ metrics.triangles.toLocaleString() }}
            </span>
            <span class="hud-pill" data-testid="hud-fps">
              FPS: {{ metrics.fps }} · TTI: {{ firstScreenTtiMs }}ms
            </span>
            <span class="hud-pill" data-testid="hud-pos">
              POS: ({{ currentPose.position[0].toFixed(2) }}, {{ currentPose.position[1].toFixed(2) }},
              {{ currentPose.position[2].toFixed(2) }})m
            </span>
          </div>

          <!-- Bottom Floating Control Dock -->
          <div class="viewport-dock" data-testid="viewport-dock">
            <div class="dock-group">
              <button
                type="button"
                class="dock-btn"
                :class="{ active: browseMode === 'camera' }"
                data-testid="mode-camera"
                @click="switchMode('camera')"
              >
                机位锁定 Cam
              </button>
              <button
                type="button"
                class="dock-btn"
                :class="{ active: browseMode === 'orbit' }"
                data-testid="mode-orbit"
                @click="switchMode('orbit')"
              >
                环绕 Orbit
              </button>
              <button
                type="button"
                class="dock-btn"
                :class="{ active: browseMode === 'walk' }"
                data-testid="mode-walk"
                @click="switchMode('walk')"
              >
                漫游 Walk (WASD)
              </button>
            </div>

            <template v-if="browseMode === 'camera' && activeCamera?.frame_range">
              <div class="dock-divider" />
              <div class="scrubber-row" data-testid="frame-scrubber">
                <span>Fra {{ currentFrame }}</span>
                <input
                  v-model.number="currentFrame"
                  type="range"
                  :min="activeCamera.frame_range[0]"
                  :max="activeCamera.frame_range[1]"
                  step="1"
                >
                <span>/{{ activeCamera.frame_range[1] }}</span>
              </div>
            </template>

            <div class="dock-divider" />

            <div class="dock-group">
              <button
                v-for="preset in manifest.lighting_presets"
                :key="preset.id"
                type="button"
                class="dock-btn"
                :class="{ active: activePresetId === preset.id }"
                :data-testid="`preset-${preset.id}`"
                @click="activePresetId = preset.id"
              >
                {{ preset.label }}
              </button>
            </div>

            <template v-if="browseMode === 'camera' && activeReferenceUrl">
              <div class="dock-divider" />
              <div class="scrubber-row">
                <button
                  type="button"
                  class="dock-btn"
                  :class="{ active: overlayEnabled }"
                  data-testid="btn-toggle-overlay"
                  @click="overlayEnabled = !overlayEnabled"
                >
                  叠图对比
                </button>
                <input
                  v-if="overlayEnabled"
                  v-model.number="overlayOpacity"
                  type="range"
                  min="0.1"
                  max="0.95"
                  step="0.05"
                  style="width: 68px"
                >
              </div>
            </template>
          </div>
        </template>
      </main>

      <!-- Right Inspector Panel -->
      <aside class="viewer-inspector" data-testid="viewer-inspector">
        <template v-if="manifest">
          <!-- Set Package Summary -->
          <section class="inspector-section">
            <div class="section-header">
              <span class="section-title">片场工程参数</span>
              <span class="badge-mono">1.0m 比例尺</span>
            </div>
            <div class="meta-grid">
              <span class="meta-label">片场标识</span>
              <span class="meta-val">{{ manifest.set_id }}</span>
              <span class="meta-label">源工程哈希</span>
              <span class="meta-val">{{ manifest.source_blend_sha256.slice(0, 16) }}…</span>
              <span class="meta-label">空间尺寸</span>
              <span class="meta-val">
                {{ manifest.bounds.size[0].toFixed(1) }} × {{ manifest.bounds.size[2].toFixed(1) }} ×
                {{ manifest.bounds.size[1].toFixed(1) }} m
              </span>
              <span class="meta-label">漫游碰撞盒</span>
              <span class="meta-val">
                [{{ manifest.nav.walk_bounds_min[0].toFixed(1) }}..{{ manifest.nav.walk_bounds_max[0].toFixed(1) }},
                {{ manifest.nav.walk_bounds_min[2].toFixed(1) }}..{{ manifest.nav.walk_bounds_max[2].toFixed(1) }}] m
              </span>
            </div>
          </section>

          <!-- Blender Cameras -->
          <section class="inspector-section">
            <div class="section-header">
              <span class="section-title">Blender 机位 ({{ manifest.cameras.length }})</span>
              <span class="badge-mono">16:9 安全框</span>
            </div>

            <div class="camera-filter-tabs">
              <button
                type="button"
                class="vf-btn"
                :class="{ primary: cameraTab === 'production' }"
                data-testid="tab-production-cameras"
                @click="cameraTab = 'production'"
              >
                实拍机位
              </button>
              <button
                type="button"
                class="vf-btn"
                :class="{ primary: cameraTab === 'overview' }"
                data-testid="tab-overview-cameras"
                @click="cameraTab = 'overview'"
              >
                环视与验光
              </button>
            </div>

            <div class="camera-list" data-testid="camera-list">
              <button
                v-for="cam in filteredCameras"
                :key="cam.id"
                type="button"
                class="camera-card"
                :class="{ active: activeCameraId === cam.id && browseMode === 'camera' }"
                :data-testid="`camera-card-${cam.id}`"
                @click="selectCamera(cam)"
              >
                <div class="camera-card-top">
                  <span class="camera-id">{{ cam.id }} · {{ cam.blender_name }}</span>
                  <span v-if="cam.shot_ref" class="badge-mono">{{ cam.shot_ref }}</span>
                </div>
                <div class="camera-label">{{ cam.label }}</div>
                <div class="camera-optics">
                  {{ cam.focal_length_mm }}mm · FOV-Y {{ cam.fov_y_deg.toFixed(2) }}°
                  <template v-if="cam.frame_range">
                    · Fra {{ cam.frame_range[0] }}–{{ cam.frame_range[1] }}
                  </template>
                </div>
              </button>
            </div>
          </section>

          <!-- Clean Screenshots & Host Lightbox -->
          <section class="inspector-section">
            <div class="section-header">
              <span class="section-title">当前会话截图 ({{ captures.length }})</span>
              <span class="badge-mono">1920×1080 PNG</span>
            </div>
            <div v-if="captures.length === 0" class="state-desc" style="margin: 0">
              点击顶部「纯净截图 1080p」导出无 HUD 干净画面，并自动唤起 Studio 宿主全局灯箱。
            </div>
            <div v-else class="capture-list" data-testid="capture-list">
              <div v-for="shot in captures" :key="shot.id" class="capture-item">
                <img
                  :src="shot.dataUrl"
                  :alt="shot.title"
                  class="capture-thumb"
                  @click="openInHostLightbox(shot)"
                >
                <div style="flex: 1; min-width: 0">
                  <div style="font-size: 12px; font-weight: 600">{{ shot.cameraId }} · {{ shot.presetId }}</div>
                  <div class="camera-optics">{{ shot.createdAt }}</div>
                </div>
                <button type="button" class="vf-btn" @click="downloadCapture(shot)">
                  下载
                </button>
              </div>
            </div>
          </section>
        </template>
      </aside>
    </div>
  </div>
</template>
