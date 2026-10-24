import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { parseGlbScene, type GlbMeshPrimitive } from '../src/set-package.ts'
import { MAX_SCENE_TRIANGLES, subdivideLargeTriangles, subdivideSceneMeshes } from '../src/mesh-subdivision.ts'

const packagePath = resolve(import.meta.dirname, '../../../verdantflare-design/.output/video/anxi-whip-inspector/previs-20261024/c-package/pkg-c/scene.glb')

type Primitive = Parameters<typeof subdivideLargeTriangles>[0]
function maxEdge(p: Primitive): number {
  let value = 0
  for (let i = 0; i < p.indices.length; i += 3) {
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const ia = p.indices[i + a] * 3, ib = p.indices[i + b] * 3
      value = Math.max(value, Math.hypot(...[0, 1, 2].map(j => p.positions[ia + j] - p.positions[ib + j])))
    }
  }
  return value
}
function makeTriangle(length = 512): Primitive {
  return { positions: new Float32Array([0, 0, 0, length, 0, 0, 0, 0, length]),
    normals: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) }
}

test('real C terrain meets the bound and original actor buffers remain untouched', async () => {
  const bytes = await readFile(packagePath)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '75ff6f3862ed3f1d4927f4bacc080fd25bc3af819764c616c3613862095c3c50')
  const parsed = parseGlbScene(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const terrain = parsed.instances.find(x => x.nodeName === 'SET_terrain__earth')!.primitives[0]
  const snapshot = structuredClone(terrain)
  assert.ok(maxEdge(terrain) > 140)
  const result = subdivideSceneMeshes(parsed)
  const preparedTerrain = result.find(x => x.nodeName === 'SET_terrain__earth')!.primitives[0]
  assert.ok(maxEdge(preparedTerrain) <= 14)
  assert.deepEqual(terrain, snapshot)
  let actualTriangles = 0
  for (let i = 0; i < result.length; i++) {
    assert.equal(result[i].worldMatrix, parsed.instances[i].worldMatrix)
    for (let j = 0; j < result[i].primitives.length; j++) {
      const after = result[i].primitives[j]
      const before = parsed.instances[i].primitives[j]
      assert.ok(maxEdge(after) <= 14)
      assert.equal(after.materialIndex, before.materialIndex)
      actualTriangles += after.indices.length / 3
      if (result[i].nodeName.startsWith('ACTOR_')) {
        assert.equal(after.positions, before.positions)
        assert.equal(after.normals, before.normals)
        assert.equal(after.indices, before.indices)
      }
    }
  }
  assert.ok(actualTriangles <= MAX_SCENE_TRIANGLES)
  assert.equal(parsed.triangleCount, 188233)
})

test('long textured triangle keeps input, area, winding, normals and affine UVs', () => {
  const input = makeTriangle()
  const snapshot = structuredClone(input)
  const result = subdivideLargeTriangles(input)
  assert.ok(maxEdge(result) <= 14)
  assert.deepEqual(input, snapshot)
  for (let i = 0; i < result.positions.length / 3; i++) {
    assert.equal(result.positions[i * 3 + 1], 0)
    assert.equal(result.uvs[i * 2], result.positions[i * 3] / 512)
    assert.equal(result.uvs[i * 2 + 1], result.positions[i * 3 + 2] / 512)
    assert.deepEqual([...result.normals.slice(i * 3, i * 3 + 3)], [0, -1, 0])
  }
  let twiceArea = 0
  for (let i = 0; i < result.indices.length; i += 3) {
    const [a, b, c] = [...result.indices.slice(i, i + 3)].map(j => j * 3)
    const area = (result.positions[b] - result.positions[a]) * (result.positions[c + 2] - result.positions[a + 2]) -
      (result.positions[b + 2] - result.positions[a + 2]) * (result.positions[c] - result.positions[a])
    assert.ok(area > 0)
    twiceArea += area
  }
  assert.equal(twiceArea, 512 ** 2)
})

test('exactly fourteen metres passes without copying; a larger edge is split', () => {
  const input = { positions: new Float32Array([0, 0, 0, 14, 0, 0, 7, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), uvs: null, indices: new Uint32Array([0, 1, 2]) }
  const unchanged = subdivideLargeTriangles(input)
  assert.equal(unchanged.positions, input.positions)
  assert.equal(unchanged.indices, input.indices)
  assert.equal(unchanged.uvs.length, 6)
  input.positions[3] = 14.0001
  assert.ok(subdivideLargeTriangles(input).indices.length > 3)
})

test('finite pass, aggregate triangle, precision and invalid-input limits fail closed', () => {
  const input = makeTriangle()
  const snapshot = structuredClone(input)
  assert.throws(() => subdivideLargeTriangles(input, 14, { maxPasses: 2 }), /pass budget/)
  assert.throws(() => subdivideLargeTriangles(input, 14, { maxAddedTriangles: 8 }), /triangle budget/)
  assert.throws(() => subdivideLargeTriangles(input, 14, { maxAddedTriangles: 0 }), /triangle budget/)
  assert.deepEqual(input, snapshot)
  const invalid = makeTriangle()
  invalid.positions[0] = NaN
  assert.throws(() => subdivideLargeTriangles(invalid), /nonfinite/)
  invalid.positions[0] = 0
  invalid.indices[2] = 100
  assert.throws(() => subdivideLargeTriangles(invalid), /index outside/)
  assert.throws(() => subdivideLargeTriangles(input, Infinity), /threshold/)
  const imprecise = makeTriangle(128)
  for (let i = 0; i < imprecise.positions.length; i += 3) imprecise.positions[i] += 2 ** 30
  assert.throws(() => subdivideLargeTriangles(imprecise), /midpoint cannot reduce/)
})

test('scene preparation enforces 500000 total triangles across all primitives', () => {
  const small = makeTriangle(1)
  const pad = (count: number): GlbMeshPrimitive => {
    const indices = new Uint32Array(count * 3)
    for (let i = 0; i < count; i++) indices.set([0, 1, 2], i * 3)
    return { ...small, indices, materialIndex: 0 }
  }
  const scene = (primitives: GlbMeshPrimitive[]) => ({
    triangleCount: primitives.reduce((sum, p) => sum + p.indices.length / 3, 0),
    instances: [{ nodeName: 'budget-fixture', meshName: 'budget-fixture', worldMatrix: new Float32Array(16), primitives }],
  })
  const exact = scene([pad(MAX_SCENE_TRIANGLES)])
  assert.equal(subdivideSceneMeshes(exact)[0].primitives[0].indices, exact.instances[0].primitives[0].indices)
  assert.throws(() => subdivideSceneMeshes(scene([pad(MAX_SCENE_TRIANGLES + 1)])), /scene exceeds/)
  // Each 16m right triangle needs more than one additional triangle; together
  // they cannot fit in the five slots remaining after the existing scene.
  const large = { ...makeTriangle(16), materialIndex: 0 }
  const combined = scene([large, large, pad(MAX_SCENE_TRIANGLES - 7)])
  assert.throws(() => subdivideSceneMeshes(combined), /triangle budget/)
  assert.throws(() => subdivideSceneMeshes({ ...scene([large]), triangleCount: 0 }), /inconsistent/)
})
