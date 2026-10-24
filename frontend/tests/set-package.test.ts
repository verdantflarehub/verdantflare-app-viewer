import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  buildCameraDeepLink,
  buildViewerAppPath,
  clampWalkPosition,
  focalMmToFovYDeg,
  interpolateCameraPose,
  parseGlbScene,
  parseViewerRoute,
  stepFirstPersonWalk,
  validateSetManifest,
} from '../src/set-package.ts'
import {
  type AppSDK,
  controlledContentPath,
  loadArtifactText,
  sha256Hex,
} from '../src/sdk.ts'

const SAW_PKG_DIR = resolve(
  import.meta.dirname,
  '../../../verdantflare-design/.output/video/saw-bathroom-promo/set-package/saw-bathroom-v9'
)

const ANXI_PKG_DIR = resolve(
  import.meta.dirname,
  '../../../verdantflare-design/.output/video/anxi-whip-inspector/blender-20261024/candidates/pkg-b'
)

test('Real T2.2 Saw Bathroom Set Package (set.json + scene.glb) passes manifest & GLB parser validation', async () => {
  const rawSetJson = await readFile(resolve(SAW_PKG_DIR, 'set.json'), 'utf8')
  const manifest = validateSetManifest(JSON.parse(rawSetJson))
  assert.equal(manifest.schema_version, '1.0')
  assert.equal(manifest.set_id, 'saw-bathroom-v9')
  assert.equal(manifest.cameras.length, 17)
  assert.equal(manifest.lighting_presets.length, 4)

  const glbBytes = await readFile(resolve(SAW_PKG_DIR, 'scene.glb'))
  const glbArrayBuffer = glbBytes.buffer.slice(
    glbBytes.byteOffset,
    glbBytes.byteOffset + glbBytes.byteLength
  )
  const actualGlbHash = await sha256Hex(glbArrayBuffer)
  assert.equal(actualGlbHash, manifest.files['scene.glb'].sha256)

  const parsed = parseGlbScene(glbArrayBuffer)
  assert.equal(parsed.version, 2)
  assert.ok(parsed.nodeCount >= 170 && parsed.nodeCount <= 180)
  assert.ok(parsed.triangleCount > 1000 && parsed.triangleCount <= 800000)
  assert.equal(parsed.materialCount, 29)
  assert.equal(parsed.textureCount, 5)
  assert.equal(parsed.textures.length, 5)
})

test('Real Anxi Street Set Package (pkg-b) preserves source.blend_sha256, hide_objects, and ORTHO camera', async () => {
  const rawSetJson = await readFile(resolve(ANXI_PKG_DIR, 'set.json'), 'utf8')
  const manifest = validateSetManifest(JSON.parse(rawSetJson))
  assert.equal(manifest.set_id, 'pkg-b')
  assert.equal(
    manifest.source_blend_sha256,
    '6bd1f34634355c99eb8cf2b84dd5b51cf6a6dbd25e14e34a9796d5bf606ac9f7'
  )
  assert.equal(manifest.cameras.length, 7)

  const gateFront = manifest.cameras.find(c => c.id === 'gate_front')
  assert.ok(gateFront)
  assert.equal(gateFront.projection, 'PERSP')
  assert.deepEqual(gateFront.hide_objects, ['GUIDE_diagnostic__ink', 'GUIDE_diagnostic__marker'])

  const topCam = manifest.cameras.find(c => c.id === 'top')
  assert.ok(topCam)
  assert.equal(topCam.projection, 'ORTHO')
  assert.equal(topCam.ortho_scale, 245)
  assert.deepEqual(topCam.hide_objects, [])
})

test('Viewer route parser and deep-link builder support ?cam= and #cam= and renderer=webgl2', () => {
  const projId = '01a16250-d1aa-7667-add1-588f58042bbc'
  const revId = '01a1691d-bd00-7195-bb28-982913b20c14'
  const r1 = parseViewerRoute(
    `/?project=${projId}&revision=${revId}&set=saw-bathroom-v9&cam=C4`,
    ''
  )
  assert.equal(r1.sourceKind, 'project')
  assert.equal(r1.projectId, projId)
  assert.equal(r1.revisionId, revId)
  assert.equal(r1.setId, 'saw-bathroom-v9')
  assert.equal(r1.cameraId, 'C4')
  assert.equal(r1.rendererHint, 'auto')

  const r2 = parseViewerRoute(
    `/?project=${projId}&revision=${revId}&set=saw-bathroom-v9&renderer=webgl2`,
    '#/apps/viewer/?cam=N2'
  )
  assert.equal(r2.cameraId, 'N2')
  assert.equal(r2.rendererHint, 'webgl2')

  const path = buildViewerAppPath({
    sourceKind: 'project',
    projectId: projId,
    revisionId: revId,
    setId: 'saw-bathroom-v9',
    cameraId: 'D1',
  })
  assert.equal(
    path,
    `/?project=${projId}&revision=${revId}&set=saw-bathroom-v9&cam=D1`
  )

  const deepLink = buildCameraDeepLink('https://studio.dev.verdantflarehub.com', {
    sourceKind: 'project',
    projectId: projId,
    revisionId: revId,
    setId: 'saw-bathroom-v9',
    cameraId: 'D1',
  })
  assert.equal(
    deepLink,
    `https://studio.dev.verdantflarehub.com/#/apps/viewer/?project=${projId}&revision=${revId}&set=saw-bathroom-v9&cam=D1`
  )
})

test('First-Person Walk AABB collision clamping and Camera D1 Fra 1..120 interpolation', () => {
  const boundsMin: [number, number, number] = [-3.3, 0.0, -4.2]
  const boundsMax: [number, number, number] = [3.3, 3.1, 4.2]
  const clamped = clampWalkPosition([10, 1.65, -10], boundsMin, boundsMax, 1.65, 0.22)
  assert.ok(clamped[0] <= 3.3 - 0.22 + 1e-6)
  assert.ok(clamped[2] >= -4.2 + 0.22 - 1e-6)
  assert.equal(clamped[1], 1.65)

  const stepped = stepFirstPersonWalk(
    [0, 1.65, 0],
    0,
    { forward: 1, right: 0 },
    10,
    2.4,
    boundsMin,
    boundsMax,
    1.65
  )
  assert.ok(stepped[2] >= -4.2 + 0.22 - 1e-6)

  const d1Cam = {
    id: 'D1',
    blender_name: 'CAM_D1',
    label: '推轨特写',
    role: 'detail' as const,
    position: [0, 1.2, 2.0] as [number, number, number],
    target: [0, 1.2, 0.0] as [number, number, number],
    up: [0, 1, 0] as [number, number, number],
    focal_length_mm: 50,
    sensor_width_mm: 36,
    sensor_height_mm: 24,
    sensor_fit: 'AUTO' as const,
    fov_y_deg: focalMmToFovYDeg(50, 36, 24, 16 / 9, 'AUTO'),
    aspect_ratio: 16 / 9,
    clip_near_m: 0.05,
    clip_far_m: 100,
    frame_range: [1, 120] as [number, number],
  }
  const f1 = interpolateCameraPose(d1Cam, 1)
  const f120 = interpolateCameraPose(d1Cam, 120)
  assert.deepEqual(f1.position, [0, 1.2, 2.0])
  assert.ok(f120.position[2] < f1.position[2])
})

test('controlledContentPath and artifact.read SHA-256 verification enforce integrity', async () => {
  const validHandle =
    '/studio/dashboards/11111111-2222-4333-8444-555555555555/content/66666666-7777-4888-9999-aaaaaaaaaaaa'
  assert.equal(
    controlledContentPath(validHandle, 'https://studio.dev.verdantflarehub.com'),
    validHandle
  )
  assert.throws(() => controlledContentPath('/etc/passwd', 'https://studio.dev.verdantflarehub.com'))

  const sampleText = '{"schema_version":"1.0"}'
  const sampleHash = await sha256Hex(new TextEncoder().encode(sampleText))
  const contentRef = {
    store_id: '01a0fae2-0000-7000-8000-000000000010',
    artifact_id: '01a1691d-0000-7000-8000-000000000011',
    version_id: '01a1691d-0000-7000-8000-000000000012',
  }
  const fakeSdk = {
    version: '1.2.0',
    app: { request: async () => ({ status: 200, data: {}, requestId: '1' }) },
    capabilities: {
      call: async () => ({
        mode: 'text',
        text: sampleText,
        version: {
          ...contentRef,
          mime: 'application/json',
          size: sampleText.length,
          sha256: sampleHash,
        },
      }),
    },
    lifecycle: { subscribe: () => () => {} },
    context: { subscribe: () => () => {} },
    theme: { get: () => 'dark' as const, subscribe: () => () => {} },
  } satisfies AppSDK

  const loaded = await loadArtifactText(
    fakeSdk,
    contentRef,
    { project_id: contentRef.store_id, project_revision_id: contentRef.version_id },
    sampleHash
  )
  assert.equal(loaded, sampleText)

  await assert.rejects(() =>
    loadArtifactText(
      fakeSdk,
      contentRef,
      { project_id: contentRef.store_id, project_revision_id: contentRef.version_id },
      '0'.repeat(64)
    )
  )
})
