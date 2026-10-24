// Bounded midpoint subdivision for the actual Float32 geometry uploaded to the Viewer.
import type { GlbNodeMeshInstance, ParsedGlbScene } from './set-package.ts'

export const MAX_SCENE_TRIANGLES = 500_000
export const MAX_SUBDIVISION_PASSES = 32
export const MAX_ADDED_SCENE_TRIANGLES = 250_000

type Primitive = {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array | null
  indices: Uint32Array
}

export function subdivideLargeTriangles(
  prim: Primitive,
  maxEdgeM = 14,
  limits: { maxPasses?: number; maxAddedTriangles?: number } = {},
): { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array } {
  const maxPasses = limits.maxPasses ?? MAX_SUBDIVISION_PASSES
  const maxAddedTriangles = limits.maxAddedTriangles ?? MAX_ADDED_SCENE_TRIANGLES
  const fail = (message: string): never => { throw new Error(`MESH_SUBDIVISION_LIMIT: ${message}`) }
  if (!Number.isFinite(maxEdgeM) || maxEdgeM <= 0 || !Number.isFinite(maxEdgeM * maxEdgeM)) {
    fail('edge threshold must be finite and positive')
  }
  if (!Number.isInteger(maxPasses) || maxPasses < 1 || maxPasses > MAX_SUBDIVISION_PASSES ||
      !Number.isInteger(maxAddedTriangles) || maxAddedTriangles < 0 ||
      maxAddedTriangles > MAX_ADDED_SCENE_TRIANGLES) fail('invalid subdivision budget')
  const vertexCount = prim.positions.length / 3
  if (!Number.isInteger(vertexCount) || prim.normals.length !== prim.positions.length ||
      prim.indices.length % 3 !== 0 || (prim.uvs && prim.uvs.length !== vertexCount * 2)) {
    fail('inconsistent primitive attribute lengths')
  }
  for (const value of prim.positions) if (!Number.isFinite(value)) fail('nonfinite position')
  for (const index of prim.indices) if (index >= vertexCount) fail('index outside positions')

  const maxEdgeSq = maxEdgeM * maxEdgeM
  const baseUvs = prim.uvs || new Float32Array(vertexCount * 2)
  const edgeSq = (positions: ArrayLike<number>, i0: number, i1: number): number =>
    (positions[i1 * 3] - positions[i0 * 3]) ** 2 +
    (positions[i1 * 3 + 1] - positions[i0 * 3 + 1]) ** 2 +
    (positions[i1 * 3 + 2] - positions[i0 * 3 + 2]) ** 2
  const hasLargeTriangle = (positions: ArrayLike<number>, indices: ArrayLike<number>): boolean => {
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2]
      if (Math.max(edgeSq(positions, a, b), edgeSq(positions, b, c), edgeSq(positions, c, a)) > maxEdgeSq) return true
    }
    return false
  }
  if (!hasLargeTriangle(prim.positions, prim.indices)) {
    return { positions: prim.positions, normals: prim.normals, uvs: baseUvs, indices: prim.indices }
  }

  const posArr = Array.from(prim.positions)
  const normArr = Array.from(prim.normals)
  const uvArr = Array.from(baseUvs)
  let curIndices = Array.from(prim.indices)
  let addedTriangles = 0
  for (let pass = 0; pass < maxPasses; pass++) {
    let splitCount = 0
    const nextIndices: number[] = []
    const midCache = new Map<string, number>()
    const getMidpoint = (i0: number, i1: number): number => {
      const k = i0 < i1 ? `${i0}_${i1}` : `${i1}_${i0}`
      const cached = midCache.get(k)
      if (cached !== undefined) return cached
      const p0 = i0 * 3, p1 = i1 * 3
      // Compute in the same precision as the eventual GPU position buffer.
      const midpoint = [0, 1, 2].map(j => Math.fround((posArr[p0 + j] + posArr[p1 + j]) * 0.5))
      if (midpoint.every((v, j) => v === posArr[p0 + j]) ||
          midpoint.every((v, j) => v === posArr[p1 + j])) fail('float32 midpoint cannot reduce edge')
      const newIdx = posArr.length / 3
      posArr.push(...midpoint)
      let nx = (normArr[p0] + normArr[p1]) * 0.5
      let ny = (normArr[p0 + 1] + normArr[p1 + 1]) * 0.5
      let nz = (normArr[p0 + 2] + normArr[p1 + 2]) * 0.5
      const nlen = Math.hypot(nx, ny, nz) || 1
      normArr.push(nx / nlen, ny / nlen, nz / nlen)
      const u0 = i0 * 2, u1 = i1 * 2
      uvArr.push((uvArr[u0] + uvArr[u1]) * 0.5, (uvArr[u0 + 1] + uvArr[u1 + 1]) * 0.5)
      midCache.set(k, newIdx)
      return newIdx
    }

    for (let i = 0; i < curIndices.length; i += 3) {
      const ia = curIndices[i], ib = curIndices[i + 1], ic = curIndices[i + 2]
      const ab = edgeSq(posArr, ia, ib), bc = edgeSq(posArr, ib, ic), ca = edgeSq(posArr, ic, ia)
      if (Math.max(ab, bc, ca) <= maxEdgeSq) {
        nextIndices.push(ia, ib, ic)
        continue
      }
      if (addedTriangles >= maxAddedTriangles) fail('additional triangle budget exhausted')
      addedTriangles++
      splitCount++
      if (ab >= bc && ab >= ca) {
        const im = getMidpoint(ia, ib)
        nextIndices.push(ia, im, ic, im, ib, ic)
      } else if (bc >= ab && bc >= ca) {
        const im = getMidpoint(ib, ic)
        nextIndices.push(ia, ib, im, ia, im, ic)
      } else {
        const im = getMidpoint(ic, ia)
        nextIndices.push(ia, ib, im, im, ib, ic)
      }
    }
    curIndices = nextIndices
    if (splitCount === 0) break
  }
  const positions = new Float32Array(posArr)
  const indices = new Uint32Array(curIndices)
  // The limit applies to the actual uploaded buffers, not an intermediate estimate.
  if (hasLargeTriangle(positions, indices)) fail('pass budget exhausted before edge bound')
  return { positions, normals: new Float32Array(normArr), uvs: new Float32Array(uvArr), indices }
}


/** Prepare every primitive before GPU uploads, sharing the whole-scene budget. */
export function subdivideSceneMeshes(
  scene: Pick<ParsedGlbScene, 'instances' | 'triangleCount'>,
): GlbNodeMeshInstance[] {
  if (!Number.isInteger(scene.triangleCount) || scene.triangleCount < 0 ||
      scene.triangleCount > MAX_SCENE_TRIANGLES) {
    throw new Error('MESH_SUBDIVISION_LIMIT: scene exceeds 500000 triangles')
  }
  const actualTriangles = scene.instances.reduce((sum, instance) => sum +
    instance.primitives.reduce((subtotal, primitive) => subtotal + primitive.indices.length / 3, 0), 0)
  if (actualTriangles !== scene.triangleCount) {
    throw new Error('MESH_SUBDIVISION_LIMIT: scene triangle count is inconsistent')
  }
  let remaining = Math.min(MAX_ADDED_SCENE_TRIANGLES, MAX_SCENE_TRIANGLES - scene.triangleCount)
  return scene.instances.map(instance => ({
    ...instance,
    primitives: instance.primitives.map(primitive => {
      const result = subdivideLargeTriangles(primitive, 14, { maxAddedTriangles: remaining })
      remaining -= (result.indices.length - primitive.indices.length) / 3
      return { ...primitive, ...result }
    }),
  }))
}
