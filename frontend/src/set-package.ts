// Set Package v1.0 schema validator, camera/walk math, deep-link parser, and GLB binary parser.

export type Vec3 = [number, number, number]

export interface SetBounds {
  min: Vec3
  max: Vec3
  size: Vec3
}

export interface SetNavConfig {
  spawn_point: Vec3
  spawn_yaw_deg: number
  eye_height_m: number
  walk_speed_mps: number
  walk_bounds_min: Vec3
  walk_bounds_max: Vec3
}

export interface SetCamera {
  id: string
  blender_name: string
  label: string
  role: 'production' | 'overview' | 'detail'
  projection?: 'PERSP' | 'ORTHO'
  ortho_scale?: number
  hide_objects?: string[]
  shot_ref?: string
  position: Vec3
  target: Vec3
  up: Vec3
  focal_length_mm: number
  sensor_width_mm: number
  sensor_height_mm: number
  sensor_fit: 'HORIZONTAL' | 'VERTICAL' | 'AUTO'
  fov_y_deg: number
  aspect_ratio: number
  clip_near_m: number
  clip_far_m: number
  frame_range?: [number, number]
  thumbnail?: string
}

export interface SetLightingPreset {
  id: string
  label: string
  exposure: number
  ambient_color: string
  ambient_intensity: number
  key_light_color: string
  key_light_intensity: number
  key_light_dir: Vec3
  fog_density?: number
}

export interface SetFileChecksum {
  sha256: string
  bytes: number
  mime: string
}

export type SetPackageKind = 'world_empty' | 'project_state' | 'setup'

export interface SetLineageSegment {
  label: string
  /** World asset UUID (world_asset) or Project UUID (project_scene). */
  id?: string
  /** World asset version UUID or Project revision UUID. */
  version_id?: string
  material_key?: string
  state_key?: string
  setup_key?: string
}

export interface SetLineage {
  world_asset?: SetLineageSegment
  project_scene?: SetLineageSegment
  setup?: SetLineageSegment
}

export interface SetCastMember {
  node_prefix: string
  character_key: string
  label: string
  wardrobe_label: string
}

export interface SetPackageManifest {
  schema_version: '1.0' | '1.1'
  kind: SetPackageKind
  lineage: SetLineage
  cast: SetCastMember[]
  set_id: string
  title: string
  source_project_slug: string
  source_blend: string
  source_blend_sha256: string
  exported_at: string
  blender_version: string
  coordinate_system: 'gltf-y-up-meters'
  unit_scale: 1.0
  bounds: SetBounds
  nav: SetNavConfig
  default_camera_id: string
  cameras: SetCamera[]
  lighting_presets: SetLightingPreset[]
  files: Record<string, SetFileChecksum>
}

export interface ViewerRouteTarget {
  sourceKind: 'project' | 'world' | 'none'
  projectId: string
  revisionId: string
  assetId: string
  versionId: string
  setId: string
  cameraId: string
  rendererHint: 'auto' | 'webgl2'
}

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SET_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/

export function focalMmToFovYDeg(
  focalMm: number,
  sensorWidthMm: number,
  sensorHeightMm: number,
  aspect = 16 / 9,
  sensorFit = 'AUTO'
): number {
  const fit = (sensorFit || 'AUTO').toUpperCase()
  let effectiveHeightMm: number
  if (fit === 'VERTICAL') {
    effectiveHeightMm = sensorHeightMm
  } else {
    effectiveHeightMm = sensorWidthMm / aspect
  }
  const fovYRad = 2 * Math.atan(effectiveHeightMm / (2 * focalMm))
  return (fovYRad * 180) / Math.PI
}

function isVec3(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every(n => typeof n === 'number' && Number.isFinite(n))
  )
}

export function blenderToGltfVec3(pt: Vec3): Vec3 {
  return [Number(pt[0]), Number(pt[2]), -Number(pt[1])]
}

function rgbFloatToHex(rgb: unknown, fallback = '#243532'): string {
  if (!isVec3(rgb)) return fallback
  const toByte = (v: number) => {
    const clamped = Math.max(0, Math.min(1, v))
    const srgb = Math.pow(clamped, 1 / 2.2)
    return Math.round(Math.max(18, Math.min(255, srgb * 255)))
  }
  const r = toByte(rgb[0]).toString(16).padStart(2, '0')
  const g = toByte(rgb[1]).toString(16).padStart(2, '0')
  const b = toByte(rgb[2]).toString(16).padStart(2, '0')
  return `#${r}${g}${b}`
}

export function validateSetManifest(raw: unknown): SetPackageManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('set.json 必须为 JSON 对象。')
  }
  const doc = raw as Record<string, unknown>
  if (doc.schema_version !== '1.0' && doc.schema_version !== '1.1') {
    throw new Error(`不支持的片场包 schema_version: ${String(doc.schema_version)}`)
  }
  const schemaVersion = doc.schema_version as '1.0' | '1.1'
  if (schemaVersion === '1.0' && (doc.kind !== undefined || doc.lineage !== undefined || doc.cast !== undefined)) {
    throw new Error('schema_version 1.0 的片场包不得包含 v1.1 字段 kind / lineage / cast。')
  }

  const setId = String(doc.set_id || doc.package_id || '').trim()
  if (!setId || !SET_ID_RE.test(setId)) {
    throw new Error('set.json 缺少有效的 set_id / package_id。')
  }
  const title = typeof doc.title === 'string' ? doc.title.trim() : ''
  if (!title) {
    throw new Error('set.json 缺少有效的 title。')
  }

  const sourceObj = (doc.source && typeof doc.source === 'object' ? doc.source : {}) as Record<
    string,
    unknown
  >
  const unitsObj = (doc.units && typeof doc.units === 'object' ? doc.units : {}) as Record<
    string,
    unknown
  >
  const renderDefaults = (
    doc.render_defaults && typeof doc.render_defaults === 'object' ? doc.render_defaults : {}
  ) as Record<string, unknown>

  if (doc.coordinate_system !== undefined) {
    if (doc.coordinate_system !== 'gltf-y-up-meters' || Number(doc.unit_scale) !== 1.0) {
      throw new Error('set.json 坐标系或单位比例不符合契约 v1.0。')
    }
  } else if (unitsObj.system !== 'METRIC' || Number(unitsObj.scale_length) !== 1.0) {
    throw new Error('set.json units 必须为 METRIC 且 scale_length = 1.0。')
  }

  // Normalize bounds
  let normBounds: SetBounds
  const rawBounds = doc.bounds as Record<string, unknown> | undefined
  const roomBounds = doc.room_bounds as Record<string, unknown> | undefined
  if (rawBounds && isVec3(rawBounds.min) && isVec3(rawBounds.max) && isVec3(rawBounds.size)) {
    normBounds = {
      min: rawBounds.min,
      max: rawBounds.max,
      size: rawBounds.size,
    }
  } else if (roomBounds && isVec3(roomBounds.size_m)) {
    const bbox = (roomBounds.bbox_blender_m || {}) as Record<string, unknown>
    if (!isVec3(bbox.min) || !isVec3(bbox.max)) {
      throw new Error('set.json room_bounds.bbox_blender_m 无效。')
    }
    const p1 = blenderToGltfVec3(bbox.min)
    const p2 = blenderToGltfVec3(bbox.max)
    const bMin: Vec3 = [Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1]), Math.min(p1[2], p2[2])]
    const bMax: Vec3 = [Math.max(p1[0], p2[0]), Math.max(p1[1], p2[1]), Math.max(p1[2], p2[2])]
    normBounds = {
      min: bMin,
      max: bMax,
      size: [roomBounds.size_m[0], roomBounds.size_m[2], roomBounds.size_m[1]],
    }
  } else {
    throw new Error('set.json bounds / room_bounds 字段无效。')
  }

  // Normalize nav
  let normNav: SetNavConfig
  const rawNav = doc.nav as Record<string, unknown> | undefined
  const navigation = doc.navigation as Record<string, unknown> | undefined
  if (
    rawNav &&
    isVec3(rawNav.spawn_point) &&
    isVec3(rawNav.walk_bounds_min) &&
    isVec3(rawNav.walk_bounds_max) &&
    typeof rawNav.eye_height_m === 'number' &&
    typeof rawNav.walk_speed_mps === 'number'
  ) {
    normNav = {
      spawn_point: rawNav.spawn_point,
      spawn_yaw_deg: Number(rawNav.spawn_yaw_deg || 0),
      eye_height_m: rawNav.eye_height_m,
      walk_speed_mps: rawNav.walk_speed_mps,
      walk_bounds_min: rawNav.walk_bounds_min,
      walk_bounds_max: rawNav.walk_bounds_max,
    }
  } else if (navigation && typeof navigation === 'object') {
    const spawnB = (navigation.spawn_blender_m || {}) as Record<string, unknown>
    const boxesB = Array.isArray(navigation.walkable_boxes_blender_m)
      ? (navigation.walkable_boxes_blender_m as Record<string, unknown>[])
      : []
    if (!isVec3(spawnB.position) || boxesB.length < 1) {
      throw new Error('set.json navigation 配置无效。')
    }
    const eyeH = Number(spawnB.eye_height_m || 1.65)
    const spawnGltf = blenderToGltfVec3(spawnB.position)
    spawnGltf[1] += eyeH
    let wMin: Vec3 = [Infinity, Infinity, Infinity]
    let wMax: Vec3 = [-Infinity, -Infinity, -Infinity]
    for (const box of boxesB) {
      if (!isVec3(box.min) || !isVec3(box.max)) {
        throw new Error('set.json walkable_boxes_blender_m 边界无效。')
      }
      const c1 = blenderToGltfVec3(box.min)
      const c2 = blenderToGltfVec3(box.max)
      for (let k = 0; k < 3; k++) {
        wMin[k] = Math.min(wMin[k], c1[k], c2[k])
        wMax[k] = Math.max(wMax[k], c1[k], c2[k])
      }
    }
    normNav = {
      spawn_point: spawnGltf,
      spawn_yaw_deg: Number(spawnB.yaw_deg || 25),
      eye_height_m: eyeH,
      walk_speed_mps: 2.4,
      walk_bounds_min: wMin,
      walk_bounds_max: wMax,
    }
  } else {
    throw new Error('set.json nav / navigation 漫游配置无效。')
  }

  for (let i = 0; i < 3; i++) {
    if (normNav.walk_bounds_min[i] >= normNav.walk_bounds_max[i]) {
      throw new Error('set.json walk_bounds_min 必须严格小于 walk_bounds_max。')
    }
  }

  if (!Array.isArray(doc.cameras) || doc.cameras.length < 1) {
    throw new Error('set.json cameras 列表不能为空。')
  }
  const defaultAspect = Number(renderDefaults.aspect_ratio) > 0 ? Number(renderDefaults.aspect_ratio) : 16 / 9
  const seenCamIds = new Set<string>()
  const normCameras: SetCamera[] = []

  for (const item of doc.cameras) {
    if (!item || typeof item !== 'object') {
      throw new Error('set.json 包含无效机位项。')
    }
    const cam = item as Record<string, unknown>
    const id = String(cam.id || '')
    if (!id || seenCamIds.has(id)) {
      throw new Error(`set.json 包含重复或空机位 ID: ${id}`)
    }
    seenCamIds.add(id)

    let pos: Vec3
    let target: Vec3
    let up: Vec3 = [0, 1, 0]
    if (isVec3(cam.position) && isVec3(cam.target)) {
      pos = cam.position
      target = cam.target
      if (isVec3(cam.up)) up = cam.up
    } else if (isVec3(cam.location_blender_m) && isVec3(cam.target_blender_m)) {
      pos = blenderToGltfVec3(cam.location_blender_m)
      target = blenderToGltfVec3(cam.target_blender_m)
      // If looking straight down/up along Y axis, adjust up vector so lookAt doesn't degenerate
      const dx = Math.abs(target[0] - pos[0])
      const dz = Math.abs(target[2] - pos[2])
      if (dx < 1e-3 && dz < 1e-3) {
        up = [0, 0, -1]
      }
    } else {
      throw new Error(`机位 ${id} 缺少有效的空间向量。`)
    }

    const isOrtho = String(cam.projection || 'PERSP').toUpperCase() === 'ORTHO'
    const aspect = Number(cam.aspect_ratio) > 0 ? Number(cam.aspect_ratio) : defaultAspect
    const fit = String(cam.sensor_fit || 'AUTO').toUpperCase() as 'HORIZONTAL' | 'VERTICAL' | 'AUTO'
    let focal = Number(cam.focal_length_mm ?? cam.lens_mm ?? (isOrtho ? 24 : 0))
    let sw = Number(cam.sensor_width_mm ?? 36)
    let sh = Number(cam.sensor_height_mm ?? 24)
    let fovY = Number(cam.fov_y_deg ?? (isOrtho ? 42 : 0))

    if (!isOrtho) {
      if (!(focal > 0 && sw > 0 && sh > 0 && fovY > 0 && aspect > 0)) {
        throw new Error(`机位 ${id} 光学参数无效。`)
      }
      const expectedFovY = focalMmToFovYDeg(focal, sw, sh, aspect, fit)
      if (Math.abs(fovY - expectedFovY) > 0.05) {
        throw new Error(
          `机位 ${id} fov_y_deg (${fovY}) 与焦距换算值 (${expectedFovY.toFixed(4)}) 偏差超过 0.05°。`
        )
      }
    }

    const cat = String(cam.role || cam.category || 'production')
    const role: 'production' | 'overview' | 'detail' =
      cat === 'overview' || id.startsWith('OVR_') || isOrtho
        ? 'overview'
        : cat === 'match' || cat === 'detail' || id.startsWith('match_')
        ? 'detail'
        : 'production'

    const shotsArr = Array.isArray(cam.shots) ? cam.shots.map(String) : []
    const shotRef = typeof cam.shot_ref === 'string' ? cam.shot_ref : shotsArr.join(' / ')
    const hideObjects = Array.isArray(cam.hide_objects)
      ? cam.hide_objects.map(String).filter(Boolean)
      : []
    const orthoScale = isOrtho ? Number(cam.ortho_scale ?? 24) : undefined

    normCameras.push({
      id,
      blender_name: String(cam.blender_name || cam.object_name || id),
      label: String(cam.label || id),
      role,
      projection: isOrtho ? 'ORTHO' : 'PERSP',
      ortho_scale: orthoScale,
      hide_objects: hideObjects,
      shot_ref: shotRef || undefined,
      position: pos,
      target,
      up,
      focal_length_mm: focal,
      sensor_width_mm: sw,
      sensor_height_mm: sh,
      sensor_fit: fit,
      fov_y_deg: fovY,
      aspect_ratio: aspect,
      clip_near_m: Number(cam.clip_near_m ?? cam.clip_start_m ?? 0.05),
      clip_far_m: Number(cam.clip_far_m ?? cam.clip_end_m ?? 100),
      thumbnail: typeof cam.thumbnail === 'string'
        ? cam.thumbnail
        : typeof cam.reference_image === 'string'
        ? cam.reference_image
        : undefined,
    })
  }

  const defaultCamId = String(
    doc.default_camera_id || renderDefaults.default_camera_id || normCameras[0]?.id || ''
  )
  if (!defaultCamId || !seenCamIds.has(defaultCamId)) {
    throw new Error('set.json default_camera_id 未命中 cameras 列表。')
  }

  if (!Array.isArray(doc.lighting_presets) || doc.lighting_presets.length < 1) {
    throw new Error('set.json lighting_presets 不能为空。')
  }
  const normPresets: SetLightingPreset[] = []
  for (const item of doc.lighting_presets) {
    const p = item as Record<string, unknown>
    if (!p || typeof p.id !== 'string' || typeof p.label !== 'string') {
      throw new Error('set.json lighting_presets 包含无效预设。')
    }
    const ambColor =
      typeof p.ambient_color === 'string' && HEX_COLOR_RE.test(p.ambient_color)
        ? p.ambient_color
        : rgbFloatToHex(p.ambient_rgb, '#223834')
    const keyColor =
      typeof p.key_light_color === 'string' && HEX_COLOR_RE.test(p.key_light_color)
        ? p.key_light_color
        : p.id.includes('blackout')
        ? '#58f0b8'
        : p.id.includes('work')
        ? '#f3f1ea'
        : '#9ee6cf'
    const keyDir: Vec3 = isVec3(p.key_light_dir) ? p.key_light_dir : [-0.24, -0.94, -0.22]
    const ev = typeof p.exposure === 'number'
      ? p.exposure
      : typeof p.exposure_ev === 'number'
      ? Math.max(0.55, Math.min(1.6, Math.pow(2, p.exposure_ev * 0.45) * 1.15))
      : 1.0
    const lightsScale = typeof p.lights_scale === 'number' ? p.lights_scale : 1.0

    normPresets.push({
      id: p.id,
      label: p.label,
      exposure: ev,
      ambient_color: ambColor,
      ambient_intensity:
        typeof p.ambient_intensity === 'number'
          ? p.ambient_intensity
          : Math.max(0.22, Math.min(0.85, 0.38 * lightsScale)),
      key_light_color: keyColor,
      key_light_intensity:
        typeof p.key_light_intensity === 'number'
          ? p.key_light_intensity
          : Math.max(0.35, Math.min(1.8, 1.15 * lightsScale)),
      key_light_dir: keyDir,
      fog_density: typeof p.fog_density === 'number' ? p.fog_density : 0.018,
    })
  }

  // Normalize files (supports both Record<string, SetFileChecksum> and Array<{path, sha256, size, mime}>)
  const normFiles: Record<string, SetFileChecksum> = {}
  if (Array.isArray(doc.files)) {
    for (const item of doc.files) {
      const f = item as Record<string, unknown>
      const pathStr = String(f?.path || '')
      const sha = String(f?.sha256 || '')
      const bytes = Number(f?.bytes ?? f?.size ?? 0)
      if (!pathStr || !SHA256_RE.test(sha) || !(bytes > 0)) {
        throw new Error(`set.json files[${pathStr}] 校验和或字节数无效。`)
      }
      normFiles[pathStr] = {
        sha256: sha,
        bytes,
        mime: String(f?.mime || 'application/octet-stream'),
      }
    }
  } else if (doc.files && typeof doc.files === 'object') {
    for (const [relPath, rawEntry] of Object.entries(doc.files as Record<string, unknown>)) {
      const entry = rawEntry as Record<string, unknown>
      const sha = String(entry?.sha256 || '')
      const bytes = Number(entry?.bytes ?? entry?.size ?? 0)
      if (!entry || !SHA256_RE.test(sha) || !(bytes > 0)) {
        throw new Error(`set.json files[${relPath}] 校验和或字节数无效。`)
      }
      normFiles[relPath] = {
        sha256: sha,
        bytes,
        mime: String(entry?.mime || 'application/octet-stream'),
      }
    }
  }
  if (!normFiles['scene.glb'] || !normFiles['poster.png']) {
    throw new Error('set.json files 缺少 scene.glb 或 poster.png 记录。')
  }

  const blendSha =
    typeof doc.source_blend_sha256 === 'string' && SHA256_RE.test(doc.source_blend_sha256)
      ? doc.source_blend_sha256
      : typeof sourceObj.blend_sha256 === 'string' && SHA256_RE.test(sourceObj.blend_sha256)
      ? sourceObj.blend_sha256
      : normFiles['scene.glb'].sha256

  const layering = normalizeLayering(doc)

  return {
    schema_version: schemaVersion,
    kind: layering.kind,
    lineage: layering.lineage,
    cast: layering.cast,
    set_id: setId,
    title,
    source_project_slug: String(
      doc.source_project_slug || sourceObj.project_id || 'saw-bathroom-promo'
    ),
    source_blend: String(doc.source_blend || sourceObj.blend_path || 'blender/scene.blend'),
    source_blend_sha256: blendSha,
    exported_at: String(doc.exported_at || sourceObj.exported_at || ''),
    blender_version: String(doc.blender_version || sourceObj.blender_version || '4.5 LTS'),
    coordinate_system: 'gltf-y-up-meters',
    unit_scale: 1.0,
    bounds: normBounds,
    nav: normNav,
    default_camera_id: defaultCamId,
    cameras: normCameras,
    lighting_presets: normPresets,
    files: normFiles,
  }
}

const KIND_VALUES: SetPackageKind[] = ['world_empty', 'project_state', 'setup']
const ACTOR_PREFIX_RE = /^ACTOR_[A-Za-z0-9_]{1,60}$/

function lineageSegment(raw: unknown, idKey: string, versionKey: string): SetLineageSegment | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const s = raw as Record<string, unknown>
  const label = typeof s.label === 'string' ? s.label.trim() : ''
  if (!label) throw new Error('set.json lineage 段缺少 label。')
  const seg: SetLineageSegment = { label }
  if (typeof s[idKey] === 'string' && UUID_V7_RE.test(s[idKey] as string)) seg.id = s[idKey] as string
  if (typeof s[versionKey] === 'string' && UUID_V7_RE.test(s[versionKey] as string)) seg.version_id = s[versionKey] as string
  for (const k of ['material_key', 'state_key', 'setup_key'] as const) {
    if (typeof s[k] === 'string' && /^[A-Za-z0-9_-]+$/.test(s[k] as string)) seg[k] = s[k] as string
  }
  return seg
}

/** Set Package v1.1 §7: package kind, lineage chain and cast. v1.0 packages default to a setup without cast. */
export function normalizeLayering(doc: Record<string, unknown>): { kind: SetPackageKind; lineage: SetLineage; cast: SetCastMember[] } {
  const kind = doc.kind === undefined ? 'setup' : (doc.kind as SetPackageKind)
  if (!KIND_VALUES.includes(kind)) throw new Error(`set.json kind 无效：${String(doc.kind)}`)
  const rawLineage = (doc.lineage && typeof doc.lineage === 'object' ? doc.lineage : {}) as Record<string, unknown>
  const lineage: SetLineage = {}
  const world = lineageSegment(rawLineage.world_asset, 'asset_id', 'version_id')
  const scene = lineageSegment(rawLineage.project_scene, 'project_id', 'revision_id')
  const setup = lineageSegment(rawLineage.setup, 'setup_key', 'setup_key')
  if (world) lineage.world_asset = world
  if (scene) lineage.project_scene = scene
  if (setup) lineage.setup = setup
  if (kind === 'world_empty' && (scene || setup)) throw new Error('world_empty 片场包的 lineage 只能包含 world_asset。')
  if (kind === 'project_state' && setup) throw new Error('project_state 片场包的 lineage 不得包含 setup。')
  if (kind === 'setup' && doc.lineage !== undefined && (!scene || !setup)) {
    throw new Error('setup 片场包的 lineage 必须包含 project_scene 与 setup。')
  }

  const cast: SetCastMember[] = []
  if (doc.cast !== undefined) {
    if (kind !== 'setup') throw new Error('EMPTY_SET_HAS_ACTORS：空景片场包不得包含 cast。')
    if (!Array.isArray(doc.cast)) throw new Error('set.json cast 必须为数组。')
    const seen = new Set<string>()
    for (const item of doc.cast) {
      const c = (item || {}) as Record<string, unknown>
      const prefix = String(c.node_prefix || '')
      if (!ACTOR_PREFIX_RE.test(prefix) || seen.has(prefix)) throw new Error(`set.json cast.node_prefix 无效或重复：${prefix}`)
      seen.add(prefix)
      cast.push({
        node_prefix: prefix,
        character_key: String(c.character_key || ''),
        label: String(c.label || prefix.slice(6)),
        wardrobe_label: typeof c.wardrobe_label === 'string' ? c.wardrobe_label : '',
      })
    }
  }
  if (kind !== 'setup') {
    const groups = Array.isArray(doc.object_groups) ? (doc.object_groups as Array<Record<string, unknown>>) : []
    if (groups.some(g => typeof g?.prefix === 'string' && (g.prefix as string).startsWith('ACTOR_'))) {
      throw new Error('EMPTY_SET_HAS_ACTORS：空景片场包不得包含 ACTOR_ 对象分组。')
    }
  }
  return { kind, lineage, cast }
}

export function parseViewerRoute(routePath: string, browserHash = ''): ViewerRouteTarget {
  const rawPath = (routePath || '/').trim()
  const qIndex = rawPath.indexOf('?')
  const pathname = (qIndex >= 0 ? rawPath.slice(0, qIndex) : rawPath).replace(/\/+$/, '') || '/'
  const queryString = qIndex >= 0 ? rawPath.slice(qIndex + 1) : ''
  const params = new URLSearchParams(queryString)
  const pathSegments = pathname.split('/').filter(Boolean)

  let projectId = (params.get('project') || '').trim()
  const revisionId = (params.get('revision') || '').trim()
  let assetId = (params.get('asset') || '').trim()
  const versionId = (params.get('version') || '').trim()
  const setId = (params.get('set') || params.get('pkg') || '').trim()
  let cameraId = (params.get('cam') || '').trim()
  const rendererHint = params.get('renderer') === 'webgl2' ? 'webgl2' : 'auto'

  if (!projectId && pathSegments.length === 2 && pathSegments[0] === 'project') {
    projectId = pathSegments[1]
  }
  if (!assetId && pathSegments.length === 2 && pathSegments[0] === 'world') {
    assetId = pathSegments[1]
  }

  if (!cameraId && browserHash) {
    const camMatch = /(?:[?#&]|^)cam=([A-Za-z0-9._-]+)/.exec(browserHash)
    if (camMatch) {
      cameraId = camMatch[1]
    }
  }

  if (UUID_V7_RE.test(projectId) && UUID_V7_RE.test(revisionId)) {
    return {
      sourceKind: 'project',
      projectId,
      revisionId,
      assetId: '',
      versionId: '',
      setId: SET_ID_RE.test(setId) ? setId : '',
      cameraId,
      rendererHint,
    }
  }

  if (UUID_V7_RE.test(assetId) && UUID_V7_RE.test(versionId)) {
    return {
      sourceKind: 'world',
      projectId: '',
      revisionId: '',
      assetId,
      versionId,
      setId: SET_ID_RE.test(setId) ? setId : '',
      cameraId,
      rendererHint,
    }
  }

  return {
    sourceKind: 'none',
    projectId: '',
    revisionId: '',
    assetId: '',
    versionId: '',
    setId: SET_ID_RE.test(setId) ? setId : '',
    cameraId,
    rendererHint,
  }
}

export function buildViewerAppPath(target: {
  sourceKind: 'project' | 'world' | 'none'
  projectId?: string
  revisionId?: string
  assetId?: string
  versionId?: string
  setId?: string
  cameraId?: string
}): string {
  const params = new URLSearchParams()
  if (target.sourceKind === 'project' && target.projectId && target.revisionId) {
    params.set('project', target.projectId)
    params.set('revision', target.revisionId)
    if (target.setId) params.set('set', target.setId)
  } else if (target.sourceKind === 'world' && target.assetId && target.versionId) {
    params.set('asset', target.assetId)
    params.set('version', target.versionId)
  }
  if (target.cameraId) {
    params.set('cam', target.cameraId)
  }
  const q = params.toString()
  return q ? `/?${q}` : '/'
}

export function buildCameraDeepLink(
  origin: string,
  target: {
    sourceKind: 'project' | 'world' | 'none'
    projectId?: string
    revisionId?: string
    assetId?: string
    versionId?: string
    setId?: string
    cameraId: string
  }
): string {
  const appPath = buildViewerAppPath(target)
  const cleanOrigin = (origin || 'https://studio.dev.verdantflarehub.com').replace(/\/+$/, '')
  return `${cleanOrigin}/#/apps/viewer${appPath}`
}

export function clampWalkPosition(
  pos: Vec3,
  boundsMin: Vec3,
  boundsMax: Vec3,
  eyeHeightM: number,
  padding = 0.22
): Vec3 {
  const minX = Math.min(boundsMin[0] + padding, (boundsMin[0] + boundsMax[0]) * 0.5)
  const maxX = Math.max(boundsMax[0] - padding, (boundsMin[0] + boundsMax[0]) * 0.5)
  const minZ = Math.min(boundsMin[2] + padding, (boundsMin[2] + boundsMax[2]) * 0.5)
  const maxZ = Math.max(boundsMax[2] - padding, (boundsMin[2] + boundsMax[2]) * 0.5)
  const clampedX = Math.max(minX, Math.min(maxX, pos[0]))
  const clampedZ = Math.max(minZ, Math.min(maxZ, pos[2]))
  const clampedY = Math.max(boundsMin[1] + 0.1, Math.min(boundsMax[1] - 0.1, eyeHeightM))
  return [clampedX, clampedY, clampedZ]
}

export function stepFirstPersonWalk(
  pos: Vec3,
  yawRad: number,
  input: { forward: number; right: number },
  dtSec: number,
  speedMps: number,
  boundsMin: Vec3,
  boundsMax: Vec3,
  eyeHeightM: number
): Vec3 {
  const len = Math.hypot(input.forward, input.right)
  if (len <= 1e-5 || dtSec <= 0) {
    return clampWalkPosition(pos, boundsMin, boundsMax, eyeHeightM)
  }
  const f = input.forward / len
  const r = input.right / len
  const sinY = Math.sin(yawRad)
  const cosY = Math.cos(yawRad)
  // Forward in glTF -Z / yaw convention
  const dx = (-sinY * f + cosY * r) * speedMps * dtSec
  const dz = (-cosY * f - sinY * r) * speedMps * dtSec
  const next: Vec3 = [pos[0] + dx, eyeHeightM, pos[2] + dz]
  return clampWalkPosition(next, boundsMin, boundsMax, eyeHeightM)
}

export function interpolateCameraPose(
  camera: SetCamera,
  frame: number
): { position: Vec3; target: Vec3; frame: number } {
  if (!camera.frame_range || camera.frame_range.length !== 2) {
    return {
      position: [...camera.position] as Vec3,
      target: [...camera.target] as Vec3,
      frame: 1,
    }
  }
  const [startFrame, endFrame] = camera.frame_range
  const span = Math.max(1, endFrame - startFrame)
  const clampedFrame = Math.max(startFrame, Math.min(endFrame, Math.round(frame)))
  const t = (clampedFrame - startFrame) / span
  // Smooth dolly push-in along viewing vector (up to 28% closer to target at endFrame)
  const pushRatio = t * 0.28
  const dx = camera.target[0] - camera.position[0]
  const dy = camera.target[1] - camera.position[1]
  const dz = camera.target[2] - camera.position[2]
  return {
    position: [
      camera.position[0] + dx * pushRatio,
      camera.position[1] + dy * pushRatio,
      camera.position[2] + dz * pushRatio,
    ],
    target: [...camera.target] as Vec3,
    frame: clampedFrame,
  }
}

// --- Minimal Zero-Dependency glTF 2.0 Binary (.glb) Parser ---

export interface GlbMaterialInfo {
  name: string
  baseColorFactor: [number, number, number, number]
  metallicFactor: number
  roughnessFactor: number
  emissiveFactor: Vec3
  doubleSided: boolean
  baseColorTextureIndex: number | null
}

export interface GlbTextureInfo {
  name: string
  mimeType: string
  bytes: Uint8Array
}

export interface GlbPrimitiveData {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array | null
  indices: Uint32Array
  materialIndex: number
}

export interface GlbNodeMeshInstance {
  nodeName: string
  meshName: string
  worldMatrix: Float32Array
  primitives: GlbPrimitiveData[]
}

export interface ParsedGlbScene {
  version: number
  totalByteLength: number
  nodeCount: number
  meshCount: number
  materialCount: number
  textureCount: number
  triangleCount: number
  vertexCount: number
  materials: GlbMaterialInfo[]
  textures: GlbTextureInfo[]
  instances: GlbNodeMeshInstance[]
}

function mat4Identity(): Float32Array {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ])
}

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3]
    }
  }
  return out
}

function mat4FromTRS(
  t: number[] | undefined,
  q: number[] | undefined,
  s: number[] | undefined
): Float32Array {
  const tx = t?.[0] ?? 0
  const ty = t?.[1] ?? 0
  const tz = t?.[2] ?? 0
  const x = q?.[0] ?? 0
  const y = q?.[1] ?? 0
  const z = q?.[2] ?? 0
  const w = q?.[3] ?? 1
  const sx = s?.[0] ?? 1
  const sy = s?.[1] ?? 1
  const sz = s?.[2] ?? 1

  const x2 = x + x
  const y2 = y + y
  const z2 = z + z
  const xx = x * x2
  const xy = x * y2
  const xz = x * z2
  const yy = y * y2
  const yz = y * z2
  const zz = z * z2
  const wx = w * x2
  const wy = w * y2
  const wz = w * z2

  return new Float32Array([
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ])
}

export function parseGlbScene(buffer: ArrayBuffer): ParsedGlbScene {
  if (buffer.byteLength < 20) {
    throw new Error('GLB 文件过小，不是合法的 glTF 2.0 二进制容器。')
  }
  const view = new DataView(buffer)
  const magic = view.getUint32(0, true)
  const version = view.getUint32(4, true)
  const totalLength = view.getUint32(8, true)
  if (magic !== 0x46546c67 || version !== 2 || totalLength > buffer.byteLength) {
    throw new Error('GLB 头部魔数或版本校验失败。')
  }

  let offset = 12
  let jsonChunk: Record<string, unknown> | null = null
  let binChunk: Uint8Array | null = null

  while (offset + 8 <= totalLength) {
    const chunkLength = view.getUint32(offset, true)
    const chunkType = view.getUint32(offset + 4, true)
    offset += 8
    if (offset + chunkLength > totalLength) {
      throw new Error('GLB chunk 长度越界。')
    }
    if (chunkType === 0x4e4f534a) {
      const jsonText = new TextDecoder('utf-8').decode(new Uint8Array(buffer, offset, chunkLength))
      jsonChunk = JSON.parse(jsonText) as Record<string, unknown>
    } else if (chunkType === 0x004e4942) {
      binChunk = new Uint8Array(buffer, offset, chunkLength)
    }
    offset += chunkLength
  }

  if (!jsonChunk || !binChunk) {
    throw new Error('GLB 缺少 JSON 或 BIN 数据块。')
  }

  const accessors = (jsonChunk.accessors as Array<Record<string, unknown>>) || []
  const bufferViews = (jsonChunk.bufferViews as Array<Record<string, unknown>>) || []
  const meshes = (jsonChunk.meshes as Array<Record<string, unknown>>) || []
  const nodes = (jsonChunk.nodes as Array<Record<string, unknown>>) || []
  const materialsRaw = (jsonChunk.materials as Array<Record<string, unknown>>) || []
  const texturesRaw = (jsonChunk.textures as Array<Record<string, unknown>>) || []
  const imagesRaw = (jsonChunk.images as Array<Record<string, unknown>>) || []
  const scenes = (jsonChunk.scenes as Array<Record<string, unknown>>) || []
  const defaultSceneIdx = typeof jsonChunk.scene === 'number' ? jsonChunk.scene : 0

  const materials: GlbMaterialInfo[] = materialsRaw.map((m, idx) => {
    const pbr = (m.pbrMetallicRoughness as Record<string, unknown>) || {}
    const baseColor = Array.isArray(pbr.baseColorFactor) && pbr.baseColorFactor.length === 4
      ? (pbr.baseColorFactor.map(Number) as [number, number, number, number])
      : ([0.78, 0.8, 0.78, 1] as [number, number, number, number])
    const emissive = Array.isArray(m.emissiveFactor) && m.emissiveFactor.length === 3
      ? (m.emissiveFactor.map(Number) as Vec3)
      : ([0, 0, 0] as Vec3)
    const baseTex = pbr.baseColorTexture as Record<string, unknown> | undefined
    return {
      name: String(m.name || `Material_${idx}`),
      baseColorFactor: baseColor,
      metallicFactor: typeof pbr.metallicFactor === 'number' ? pbr.metallicFactor : 0.1,
      roughnessFactor: typeof pbr.roughnessFactor === 'number' ? pbr.roughnessFactor : 0.75,
      emissiveFactor: emissive,
      doubleSided: Boolean(m.doubleSided),
      baseColorTextureIndex: typeof baseTex?.index === 'number' ? baseTex.index : null,
    }
  })
  if (materials.length === 0) {
    materials.push({
      name: 'DefaultMaterial',
      baseColorFactor: [0.78, 0.8, 0.78, 1],
      metallicFactor: 0.1,
      roughnessFactor: 0.75,
      emissiveFactor: [0, 0, 0],
      doubleSided: false,
      baseColorTextureIndex: null,
    })
  }

  const textures: GlbTextureInfo[] = []
  for (let i = 0; i < texturesRaw.length; i++) {
    const tex = texturesRaw[i]
    const sourceIdx = typeof tex.source === 'number' ? tex.source : i
    const img = imagesRaw[sourceIdx]
    if (!img || typeof img.bufferView !== 'number') continue
    const bv = bufferViews[img.bufferView]
    if (!bv) continue
    const byteOffset = Number(bv.byteOffset || 0)
    const byteLength = Number(bv.byteLength || 0)
    if (byteOffset + byteLength <= binChunk.byteLength) {
      textures.push({
        name: String(img.name || tex.name || `Texture_${i}`),
        mimeType: String(img.mimeType || 'image/png'),
        bytes: binChunk.subarray(byteOffset, byteOffset + byteLength),
      })
    }
  }

  const componentCounts: Record<string, number> = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT4: 16,
  }

  function readFloatAccessor(accIdx: number): Float32Array {
    const acc = accessors[accIdx]
    if (!acc || typeof acc.bufferView !== 'number') return new Float32Array(0)
    const bv = bufferViews[acc.bufferView]
    const count = Number(acc.count || 0)
    const numComps = componentCounts[String(acc.type || 'SCALAR')] || 1
    const byteOffset = Number(bv.byteOffset || 0) + Number(acc.byteOffset || 0)
    const stride = Number(bv.byteStride || numComps * 4)
    const out = new Float32Array(count * numComps)
    const dv = new DataView(
      binChunk!.buffer,
      binChunk!.byteOffset + byteOffset,
      binChunk!.byteLength - byteOffset
    )
    for (let i = 0; i < count; i++) {
      const base = i * stride
      for (let c = 0; c < numComps; c++) {
        out[i * numComps + c] = dv.getFloat32(base + c * 4, true)
      }
    }
    return out
  }

  function readIndexAccessor(accIdx: number | undefined, vertexCount: number): Uint32Array {
    if (typeof accIdx !== 'number') {
      const seq = new Uint32Array(vertexCount)
      for (let i = 0; i < vertexCount; i++) seq[i] = i
      return seq
    }
    const acc = accessors[accIdx]
    if (!acc || typeof acc.bufferView !== 'number') return new Uint32Array(0)
    const bv = bufferViews[acc.bufferView]
    const count = Number(acc.count || 0)
    const compType = Number(acc.componentType || 5123)
    const byteOffset = Number(bv.byteOffset || 0) + Number(acc.byteOffset || 0)
    const dv = new DataView(
      binChunk!.buffer,
      binChunk!.byteOffset + byteOffset,
      binChunk!.byteLength - byteOffset
    )
    const out = new Uint32Array(count)
    for (let i = 0; i < count; i++) {
      if (compType === 5121) {
        out[i] = dv.getUint8(i)
      } else if (compType === 5123) {
        out[i] = dv.getUint16(i * 2, true)
      } else {
        out[i] = dv.getUint32(i * 4, true)
      }
    }
    return out
  }

  function computeFlatNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
    const normals = new Float32Array(positions.length)
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const i0 = indices[i] * 3
      const i1 = indices[i + 1] * 3
      const i2 = indices[i + 2] * 3
      const ax = positions[i1] - positions[i0]
      const ay = positions[i1 + 1] - positions[i0 + 1]
      const az = positions[i1 + 2] - positions[i0 + 2]
      const bx = positions[i2] - positions[i0]
      const by = positions[i2 + 1] - positions[i0 + 1]
      const bz = positions[i2 + 2] - positions[i0 + 2]
      let nx = ay * bz - az * by
      let ny = az * bx - ax * bz
      let nz = ax * by - ay * bx
      const len = Math.hypot(nx, ny, nz) || 1
      nx /= len
      ny /= len
      nz /= len
      for (const idx of [i0, i1, i2]) {
        normals[idx] = nx
        normals[idx + 1] = ny
        normals[idx + 2] = nz
      }
    }
    return normals
  }

  const parsedMeshes: GlbPrimitiveData[][] = meshes.map(m => {
    const prims = (m.primitives as Array<Record<string, unknown>>) || []
    return prims.map(prim => {
      const attrs = (prim.attributes as Record<string, number>) || {}
      const positions = typeof attrs.POSITION === 'number' ? readFloatAccessor(attrs.POSITION) : new Float32Array(0)
      const vCount = Math.floor(positions.length / 3)
      const indices = readIndexAccessor(typeof prim.indices === 'number' ? prim.indices : undefined, vCount)
      const normals =
        typeof attrs.NORMAL === 'number'
          ? readFloatAccessor(attrs.NORMAL)
          : computeFlatNormals(positions, indices)
      const uvs = typeof attrs.TEXCOORD_0 === 'number' ? readFloatAccessor(attrs.TEXCOORD_0) : null
      const materialIndex = typeof prim.material === 'number' ? prim.material : 0
      return {
        positions,
        normals,
        uvs,
        indices,
        materialIndex,
      }
    })
  })

  const instances: GlbNodeMeshInstance[] = []
  let triangleCount = 0
  let vertexCount = 0

  function traverseNode(nodeIdx: number, parentMatrix: Float32Array) {
    const node = nodes[nodeIdx]
    if (!node) return
    const localMatrix = Array.isArray(node.matrix) && node.matrix.length === 16
      ? new Float32Array(node.matrix.map(Number))
      : mat4FromTRS(
          node.translation as number[] | undefined,
          node.rotation as number[] | undefined,
          node.scale as number[] | undefined
        )
    const worldMatrix = mat4Multiply(parentMatrix, localMatrix)
    if (typeof node.mesh === 'number' && parsedMeshes[node.mesh]) {
      const prims = parsedMeshes[node.mesh]
      for (const p of prims) {
        triangleCount += Math.floor(p.indices.length / 3)
        vertexCount += Math.floor(p.positions.length / 3)
      }
      instances.push({
        nodeName: String(node.name || `Node_${nodeIdx}`),
        meshName: String(meshes[node.mesh]?.name || `Mesh_${node.mesh}`),
        worldMatrix,
        primitives: prims,
      })
    }
    const children = (node.children as number[]) || []
    for (const childIdx of children) {
      traverseNode(childIdx, worldMatrix)
    }
  }

  const rootNodes = (scenes[defaultSceneIdx]?.nodes as number[]) || nodes.map((_, i) => i)
  const rootSet = new Set(rootNodes)
  for (const idx of rootSet) {
    traverseNode(idx, mat4Identity())
  }

  return {
    version,
    totalByteLength: buffer.byteLength,
    nodeCount: nodes.length,
    meshCount: meshes.length,
    materialCount: materials.length,
    textureCount: textures.length,
    triangleCount,
    vertexCount,
    materials,
    textures,
    instances,
  }
}
