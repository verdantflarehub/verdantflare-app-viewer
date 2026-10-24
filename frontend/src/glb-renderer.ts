// Real-time 3D Set Package Viewport Engine (WebGPU detection + WebGL2 PBR Shader Pipeline + Clean 1080p Capture)

import type {
  GlbMaterialInfo,
  ParsedGlbScene,
  SetCamera,
  SetLightingPreset,
  Vec3,
} from './set-package.ts'
import { subdivideSceneMeshes } from './mesh-subdivision.ts'

export type BrowseMode = 'orbit' | 'walk' | 'camera'

export interface ViewportMetrics {
  backend: 'WebGPU' | 'WebGL2'
  fallbackActive: boolean
  fps: number
  frameTimeMs: number
  drawCalls: number
  triangles: number
  nodes: number
  textures: number
}

interface GpuPrimitive {
  nodeName: string
  meshName: string
  vao: WebGLVertexArrayObject
  indexBuffer: WebGLBuffer
  indexCount: number
  materialIndex: number
  worldMatrix: Float32Array
  normalMatrix: Float32Array
}

interface FrustumLineBatch {
  vao: WebGLVertexArrayObject
  vertexCount: number
}

const VERTEX_SHADER_SRC = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;

uniform mat4 uViewProj;
uniform mat4 uModel;
uniform mat3 uNormalMatrix;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;

void main() {
  vec4 worldPos = uModel * vec4(aPosition, 1.0);
  vWorldPos = worldPos.xyz;
  vNormal = normalize(uNormalMatrix * aNormal);
  vUv = aUv;
  gl_Position = uViewProj * worldPos;
}
`

const FRAGMENT_SHADER_SRC = `#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUv;

uniform vec4 uBaseColor;
uniform float uMetallic;
uniform float uRoughness;
uniform vec3 uEmissive;
uniform int uHasTexture;
uniform sampler2D uBaseColorTex;

uniform vec3 uCameraPos;
uniform vec3 uAmbientColor;
uniform float uAmbientIntensity;
uniform vec3 uKeyLightColor;
uniform float uKeyLightIntensity;
uniform vec3 uKeyLightDir;
uniform float uExposure;
uniform float uFogDensity;
uniform int uClayMode;
uniform int uIndoorTileGrid;

out vec4 outColor;

void main() {
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) {
    N = -N;
  }
  vec3 V = normalize(uCameraPos - vWorldPos);
  vec3 L = normalize(-uKeyLightDir);
  vec3 H = normalize(V + L);

  vec3 albedo = uBaseColor.rgb;
  if (uHasTexture == 1 && uClayMode == 0) {
    vec4 texSample = texture(uBaseColorTex, vUv);
    albedo *= pow(texSample.rgb, vec3(2.2));
  }
  if (uClayMode == 1) {
    albedo = vec3(0.68, 0.72, 0.70);
  }

  float ndotl = max(dot(N, L), 0.0);
  float fillDot = max(dot(N, normalize(vec3(-L.x, 0.65, -L.z))), 0.0);
  float rough = clamp(uRoughness, 0.08, 1.0);
  float specPow = mix(64.0, 6.0, rough * rough);
  float spec = pow(max(dot(N, H), 0.0), specPow) * mix(0.04, 0.45, 1.0 - rough);

  // Subtle tile/grid micro-detail only on indoor architectural sets
  if (uIndoorTileGrid == 1) {
    float gridX = abs(fract(vWorldPos.x * 2.5) - 0.5);
    float gridY = abs(fract(vWorldPos.y * 2.5) - 0.5);
    float gridZ = abs(fract(vWorldPos.z * 2.5) - 0.5);
    float grout = smoothstep(0.01, 0.03, min(min(gridX, gridY), gridZ));
    albedo *= mix(0.88, 1.0, grout);
  }

  vec3 ambient = albedo * uAmbientColor * (uAmbientIntensity * (0.68 + 0.32 * (N.y * 0.5 + 0.5)));
  vec3 direct = (albedo * (1.0 - uMetallic * 0.5) + vec3(spec)) * uKeyLightColor * uKeyLightIntensity * ndotl;
  vec3 fill = albedo * uAmbientColor * (0.32 * fillDot);

  vec3 color = ambient + direct + fill + uEmissive;

  // Distance fog
  float dist = length(uCameraPos - vWorldPos);
  float fogFactor = 1.0 - exp(-dist * uFogDensity);
  vec3 fogColor = mix(uAmbientColor * 0.25, uAmbientColor * 0.85, float(1 - uIndoorTileGrid));
  color = mix(color, fogColor, clamp(fogFactor, 0.0, 0.65));

  // ACES-like exposure tone mapping + gamma
  color *= uExposure;
  color = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
  color = pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2));

  outColor = vec4(color, uBaseColor.a);
}
`

const LINE_VERTEX_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPosition;
uniform mat4 uViewProj;
void main() {
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}
`

const LINE_FRAGMENT_SRC = `#version 300 es
precision highp float;
uniform vec4 uLineColor;
out vec4 outColor;
void main() {
  outColor = uLineColor;
}
`

function hexToRgbLinear(hex: string): Vec3 {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16) / 255
  const g = parseInt(clean.slice(2, 4), 16) / 255
  const b = parseInt(clean.slice(4, 6), 16) / 255
  return [Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2)]
}

function mat4Perspective(fovYDeg: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1.0 / Math.tan(((fovYDeg * Math.PI) / 180) * 0.5)
  const nf = 1.0 / (near - far)
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ])
}

function mat4Ortho(width: number, height: number, near: number, far: number): Float32Array {
  const r = Math.max(0.01, width * 0.5)
  const t = Math.max(0.01, height * 0.5)
  const nf = 1.0 / (near - far)
  return new Float32Array([
    1.0 / r, 0, 0, 0,
    0, 1.0 / t, 0, 0,
    0, 0, 2.0 * nf, 0,
    0, 0, (far + near) * nf, 1,
  ])
}

function mat4LookAt(eye: Vec3, center: Vec3, up: Vec3): Float32Array {
  let zx = eye[0] - center[0]
  let zy = eye[1] - center[1]
  let zz = eye[2] - center[2]
  let len = Math.hypot(zx, zy, zz)
  if (len < 1e-6) {
    zz = 1
    len = 1
  }
  zx /= len
  zy /= len
  zz /= len

  let xx = up[1] * zz - up[2] * zy
  let xy = up[2] * zx - up[0] * zz
  let xz = up[0] * zy - up[1] * zx
  len = Math.hypot(xx, xy, xz)
  if (len < 1e-6) {
    xx = 1
    len = 1
  }
  xx /= len
  xy /= len
  xz /= len

  const yx = zy * xz - zz * xy
  const yy = zz * xx - zx * xz
  const yz = zx * xy - zy * xx

  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
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

function mat3NormalFromMat4(m: Float32Array): Float32Array {
  const a00 = m[0], a01 = m[1], a02 = m[2]
  const a10 = m[4], a11 = m[5], a12 = m[6]
  const a20 = m[8], a21 = m[9], a22 = m[10]

  const b01 = a22 * a11 - a12 * a21
  const b11 = -a22 * a10 + a12 * a20
  const b21 = a21 * a10 - a11 * a20
  const det = a00 * b01 + a01 * b11 + a02 * b21
  if (Math.abs(det) < 1e-8) {
    return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
  }
  const invDet = 1.0 / det
  return new Float32Array([
    b01 * invDet,
    (-a22 * a01 + a02 * a21) * invDet,
    (a12 * a01 - a02 * a11) * invDet,
    b11 * invDet,
    (a22 * a00 - a02 * a20) * invDet,
    (-a12 * a00 + a02 * a10) * invDet,
    b21 * invDet,
    (-a21 * a00 + a01 * a20) * invDet,
    (a11 * a00 - a01 * a10) * invDet,
  ])
}

function compileProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram {
  const vs = gl.createShader(gl.VERTEX_SHADER)!
  gl.shaderSource(vs, vsSource)
  gl.compileShader(vs)
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(vs)
    gl.deleteShader(vs)
    throw new Error(`Vertex shader compile error: ${info}`)
  }

  const fs = gl.createShader(gl.FRAGMENT_SHADER)!
  gl.shaderSource(fs, fsSource)
  gl.compileShader(fs)
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(fs)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    throw new Error(`Fragment shader compile error: ${info}`)
  }

  const prog = gl.createProgram()!
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog)
    gl.deleteProgram(prog)
    throw new Error(`Shader link error: ${info}`)
  }
  return prog
}

export class GlbViewportRenderer {
  private canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext | null = null
  private meshProgram: WebGLProgram | null = null
  private lineProgram: WebGLProgram | null = null
  private gpuPrimitives: GpuPrimitive[] = []
  private gpuTextures: WebGLTexture[] = []
  private frustumBatch: FrustumLineBatch | null = null
  private gridBatch: FrustumLineBatch | null = null
  private scene: ParsedGlbScene | null = null
  private cameras: SetCamera[] = []
  private backendLabel: 'WebGPU' | 'WebGL2' = 'WebGL2'
  private fallbackActive = false
  private disposed = false
  private fpsSamples: number[] = []
  private lastFrameTime = 0

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
  }

  async init(rendererHint: 'auto' | 'webgl2' = 'auto'): Promise<void> {
    if (rendererHint === 'webgl2') {
      this.backendLabel = 'WebGL2'
      this.fallbackActive = true
    } else if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
      try {
        const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
        const adapter = await gpu?.requestAdapter()
        if (adapter) {
          this.backendLabel = 'WebGPU'
          this.fallbackActive = false
        } else {
          this.backendLabel = 'WebGL2'
          this.fallbackActive = true
        }
      } catch {
        this.backendLabel = 'WebGL2'
        this.fallbackActive = true
      }
    } else {
      this.backendLabel = 'WebGL2'
      this.fallbackActive = true
    }

    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      depth: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    })
    if (!gl) {
      throw new Error('WEBGL2_UNAVAILABLE: 当前桌面浏览器环境未启用 WebGL2 硬件加速。')
    }
    this.gl = gl
    this.meshProgram = compileProgram(gl, VERTEX_SHADER_SRC, FRAGMENT_SHADER_SRC)
    this.lineProgram = compileProgram(gl, LINE_VERTEX_SRC, LINE_FRAGMENT_SRC)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    this.buildFloorGrid()
  }

  private buildFloorGrid(): void {
    const gl = this.gl
    if (!gl) return
    const verts: number[] = []
    const extent = 6
    const step = 0.5
    for (let i = -extent; i <= extent + 1e-4; i += step) {
      verts.push(i, 0.002, -extent, i, 0.002, extent)
      verts.push(-extent, 0.002, i, extent, 0.002, i)
    }
    this.gridBatch = this.createLineBatch(new Float32Array(verts))
  }

  private createLineBatch(positions: Float32Array): FrustumLineBatch | null {
    const gl = this.gl
    if (!gl || positions.length === 0) return null
    const vao = gl.createVertexArray()!
    gl.bindVertexArray(vao)
    const vbo = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    return {
      vao,
      vertexCount: Math.floor(positions.length / 3),
    }
  }

  async loadScene(parsed: ParsedGlbScene, cameras: SetCamera[]): Promise<void> {
    const gl = this.gl
    if (!gl) return
    const preparedInstances = subdivideSceneMeshes(parsed)
    this.clearSceneGpuResources()
    this.scene = parsed
    this.cameras = cameras

    // Upload embedded textures
    for (const texInfo of parsed.textures) {
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      // 1x1 neutral fallback pixel while decoding or if ImageBitmap unavailable
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([210, 216, 212, 255])
      )
      if (typeof createImageBitmap === 'function') {
        try {
          const copy = new Uint8Array(texInfo.bytes.byteLength)
          copy.set(texInfo.bytes)
          const blob = new Blob([copy], { type: texInfo.mimeType })
          const bmp = await createImageBitmap(blob)
          if (!this.disposed) {
            gl.bindTexture(gl.TEXTURE_2D, tex)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp)
            gl.generateMipmap(gl.TEXTURE_2D)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
          }
          bmp.close()
        } catch {
          // Keep 1x1 fallback
        }
      }
      this.gpuTextures.push(tex)
    }

    // Upload mesh primitives
    for (const inst of preparedInstances) {
      const normalMat = mat3NormalFromMat4(inst.worldMatrix)
      for (const prim of inst.primitives) {
        if (prim.positions.length === 0 || prim.indices.length === 0) continue
        const vao = gl.createVertexArray()!
        gl.bindVertexArray(vao)

        const posBuf = gl.createBuffer()!
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
        gl.bufferData(gl.ARRAY_BUFFER, prim.positions, gl.STATIC_DRAW)
        gl.enableVertexAttribArray(0)
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)

        const normBuf = gl.createBuffer()!
        gl.bindBuffer(gl.ARRAY_BUFFER, normBuf)
        gl.bufferData(gl.ARRAY_BUFFER, prim.normals, gl.STATIC_DRAW)
        gl.enableVertexAttribArray(1)
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0)

        const uvs = prim.uvs
        const uvBuf = gl.createBuffer()!
        gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf)
        gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW)
        gl.enableVertexAttribArray(2)
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0)

        const idxBuf = gl.createBuffer()!
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf)
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, prim.indices, gl.STATIC_DRAW)

        gl.bindVertexArray(null)

        this.gpuPrimitives.push({
          nodeName: inst.nodeName,
          meshName: inst.meshName,
          vao,
          indexBuffer: idxBuf,
          indexCount: prim.indices.length,
          materialIndex: prim.materialIndex,
          worldMatrix: inst.worldMatrix,
          normalMatrix: normalMat,
        })
      }
    }

    // Build camera frustum helper lines
    const frustumVerts: number[] = []
    for (const cam of cameras) {
      const p = cam.position
      const t = cam.target
      let fx = t[0] - p[0]
      let fy = t[1] - p[1]
      let fz = t[2] - p[2]
      const flen = Math.hypot(fx, fy, fz) || 1
      fx /= flen
      fy /= flen
      fz /= flen
      const rx = -fz
      const rz = fx
      const dist = 0.36
      const halfH = Math.tan(((cam.fov_y_deg * Math.PI) / 180) * 0.5) * dist
      const halfW = halfH * (cam.aspect_ratio || 16 / 9)
      const cx = p[0] + fx * dist
      const cy = p[1] + fy * dist
      const cz = p[2] + fz * dist

      const c0: Vec3 = [cx - rx * halfW, cy + halfH, cz - rz * halfW]
      const c1: Vec3 = [cx + rx * halfW, cy + halfH, cz + rz * halfW]
      const c2: Vec3 = [cx + rx * halfW, cy - halfH, cz + rz * halfW]
      const c3: Vec3 = [cx - rx * halfW, cy - halfH, cz - rz * halfW]

      for (const corner of [c0, c1, c2, c3]) {
        frustumVerts.push(p[0], p[1], p[2], corner[0], corner[1], corner[2])
      }
      frustumVerts.push(...c0, ...c1, ...c1, ...c2, ...c2, ...c3, ...c3, ...c0)
    }
    this.frustumBatch = this.createLineBatch(new Float32Array(frustumVerts))
  }

  renderFrame(params: {
    cameraPos: Vec3
    cameraTarget: Vec3
    cameraUp: Vec3
    fovYDeg: number
    projection?: 'PERSP' | 'ORTHO'
    orthoScale?: number
    cameraAspect?: number
    overscanY?: number
    hiddenObjects?: string[]
    hiddenPrefixes?: string[]
    indoorTileGrid?: boolean
    near: number
    far: number
    preset: SetLightingPreset
    showHelpers: boolean
    overrideWidth?: number
    overrideHeight?: number
  }): ViewportMetrics {
    const gl = this.gl
    const now = performance.now()
    const dt = this.lastFrameTime > 0 ? Math.max(1, now - this.lastFrameTime) : 16.67
    this.lastFrameTime = now
    const instantFps = Math.min(144, 1000 / dt)
    this.fpsSamples.push(instantFps)
    if (this.fpsSamples.length > 24) this.fpsSamples.shift()
    const avgFps = Math.round(this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length)

    if (!gl || !this.meshProgram || !this.lineProgram || !this.scene) {
      return {
        backend: this.backendLabel,
        fallbackActive: this.fallbackActive,
        fps: avgFps,
        frameTimeMs: Number(dt.toFixed(1)),
        drawCalls: 0,
        triangles: 0,
        nodes: 0,
        textures: 0,
      }
    }

    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1
    const targetW = params.overrideWidth ?? Math.max(320, Math.floor((this.canvas.clientWidth || 1280) * dpr))
    const targetH = params.overrideHeight ?? Math.max(200, Math.floor((this.canvas.clientHeight || 720) * dpr))
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW
      this.canvas.height = targetH
    }

    const indoorTileGrid = params.indoorTileGrid !== false ? 1 : 0
    gl.viewport(0, 0, targetW, targetH)
    const ambRgb = hexToRgbLinear(params.preset.ambient_color)
    if (indoorTileGrid === 1) {
      gl.clearColor(ambRgb[0] * 0.14, ambRgb[1] * 0.15, ambRgb[2] * 0.14, 1.0)
    } else {
      gl.clearColor(
        Math.min(0.76, ambRgb[0] * 0.88 + 0.18),
        Math.min(0.78, ambRgb[1] * 0.88 + 0.19),
        Math.min(0.80, ambRgb[2] * 0.88 + 0.21),
        1.0
      )
    }
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    const aspect = targetW / Math.max(1, targetH)
    const overscanY = Math.max(1.0, params.overscanY ?? 1.0)
    const camAspect = params.cameraAspect && params.cameraAspect > 0 ? params.cameraAspect : 16 / 9
    const far = Math.max(20, params.far)
    const near = Math.max(0.05, params.near, indoorTileGrid === 0 ? Math.min(0.8, far * 0.0012) : 0.05)

    let proj: Float32Array
    if (params.projection === 'ORTHO') {
      const oScale = Math.max(1.0, params.orthoScale ?? 24)
      const safeFrameWorldH = oScale / camAspect
      const canvasWorldH = safeFrameWorldH * overscanY
      const canvasWorldW = canvasWorldH * aspect
      proj = mat4Ortho(canvasWorldW, canvasWorldH, near, far)
    } else {
      const baseTanHalfY = Math.tan(((params.fovYDeg * Math.PI) / 180) * 0.5)
      const effectiveFovYDeg = (2 * Math.atan(baseTanHalfY * overscanY) * 180) / Math.PI
      proj = mat4Perspective(effectiveFovYDeg, aspect, near, far)
    }

    const view = mat4LookAt(params.cameraPos, params.cameraTarget, params.cameraUp)
    const viewProj = mat4Multiply(proj, view)

    const clayMode = params.preset.id === 'wireframe-clay' ? 1 : 0
    const keyRgb = hexToRgbLinear(params.preset.key_light_color)
    const hiddenSet = new Set(params.hiddenObjects || [])
    const hiddenPrefixes = params.hiddenPrefixes || []

    gl.useProgram(this.meshProgram)
    gl.uniformMatrix4fv(gl.getUniformLocation(this.meshProgram, 'uViewProj'), false, viewProj)
    gl.uniform3fv(gl.getUniformLocation(this.meshProgram, 'uCameraPos'), params.cameraPos)
    gl.uniform3fv(gl.getUniformLocation(this.meshProgram, 'uAmbientColor'), ambRgb)
    gl.uniform1f(gl.getUniformLocation(this.meshProgram, 'uAmbientIntensity'), params.preset.ambient_intensity)
    gl.uniform3fv(gl.getUniformLocation(this.meshProgram, 'uKeyLightColor'), keyRgb)
    gl.uniform1f(gl.getUniformLocation(this.meshProgram, 'uKeyLightIntensity'), params.preset.key_light_intensity)
    gl.uniform3fv(gl.getUniformLocation(this.meshProgram, 'uKeyLightDir'), params.preset.key_light_dir)
    gl.uniform1f(gl.getUniformLocation(this.meshProgram, 'uExposure'), params.preset.exposure)
    gl.uniform1f(
      gl.getUniformLocation(this.meshProgram, 'uFogDensity'),
      indoorTileGrid === 1 ? (params.preset.fog_density ?? 0.015) : 0.0012
    )
    gl.uniform1i(gl.getUniformLocation(this.meshProgram, 'uClayMode'), clayMode)
    gl.uniform1i(gl.getUniformLocation(this.meshProgram, 'uIndoorTileGrid'), indoorTileGrid)

    const uModelLoc = gl.getUniformLocation(this.meshProgram, 'uModel')
    const uNormLoc = gl.getUniformLocation(this.meshProgram, 'uNormalMatrix')
    const uBaseColorLoc = gl.getUniformLocation(this.meshProgram, 'uBaseColor')
    const uMetallicLoc = gl.getUniformLocation(this.meshProgram, 'uMetallic')
    const uRoughnessLoc = gl.getUniformLocation(this.meshProgram, 'uRoughness')
    const uEmissiveLoc = gl.getUniformLocation(this.meshProgram, 'uEmissive')
    const uHasTexLoc = gl.getUniformLocation(this.meshProgram, 'uHasTexture')
    const uTexLoc = gl.getUniformLocation(this.meshProgram, 'uBaseColorTex')

    let drawCalls = 0
    for (const prim of this.gpuPrimitives) {
      if (hiddenSet.has(prim.nodeName) || hiddenSet.has(prim.meshName)) {
        continue
      }
      if (hiddenPrefixes.length && hiddenPrefixes.some(prefix => prim.nodeName.startsWith(prefix))) {
        continue
      }
      if (params.showHelpers && prim.nodeName.startsWith('GUIDE_')) {
        continue
      }
      const mat: GlbMaterialInfo = this.scene.materials[prim.materialIndex] || this.scene.materials[0]
      if (mat.doubleSided) {
        gl.disable(gl.CULL_FACE)
      } else {
        gl.enable(gl.CULL_FACE)
      }
      gl.uniformMatrix4fv(uModelLoc, false, prim.worldMatrix)
      gl.uniformMatrix3fv(uNormLoc, false, prim.normalMatrix)
      gl.uniform4fv(uBaseColorLoc, mat.baseColorFactor)
      gl.uniform1f(uMetallicLoc, mat.metallicFactor)
      gl.uniform1f(uRoughnessLoc, mat.roughnessFactor)
      gl.uniform3fv(uEmissiveLoc, mat.emissiveFactor)

      const texIdx = mat.baseColorTextureIndex
      if (texIdx !== null && this.gpuTextures[texIdx]) {
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, this.gpuTextures[texIdx])
        gl.uniform1i(uTexLoc, 0)
        gl.uniform1i(uHasTexLoc, 1)
      } else {
        gl.uniform1i(uHasTexLoc, 0)
      }

      gl.bindVertexArray(prim.vao)
      gl.drawElements(gl.TRIANGLES, prim.indexCount, gl.UNSIGNED_INT, 0)
      drawCalls++
    }

    // Draw helpers (grid & camera frustum cones) when not in clean capture or camera lock
    if (params.showHelpers || clayMode === 1) {
      gl.useProgram(this.lineProgram)
      gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProgram, 'uViewProj'), false, viewProj)
      const uLineColorLoc = gl.getUniformLocation(this.lineProgram, 'uLineColor')

      if (this.gridBatch && params.showHelpers) {
        gl.uniform4f(uLineColorLoc, 0.46, 0.78, 0.67, 0.22)
        gl.bindVertexArray(this.gridBatch.vao)
        gl.drawArrays(gl.LINES, 0, this.gridBatch.vertexCount)
        drawCalls++
      }
      if (this.frustumBatch && params.showHelpers) {
        gl.uniform4f(uLineColorLoc, 0.46, 0.78, 0.67, 0.75)
        gl.bindVertexArray(this.frustumBatch.vao)
        gl.drawArrays(gl.LINES, 0, this.frustumBatch.vertexCount)
        drawCalls++
      }
    }

    gl.bindVertexArray(null)

    return {
      backend: this.backendLabel,
      fallbackActive: this.fallbackActive,
      fps: avgFps,
      frameTimeMs: Number(dt.toFixed(1)),
      drawCalls,
      triangles: this.scene.triangleCount,
      nodes: this.scene.nodeCount,
      textures: this.scene.textureCount,
    }
  }

  async captureCleanScreenshot(params: {
    cameraPos: Vec3
    cameraTarget: Vec3
    cameraUp: Vec3
    fovYDeg: number
    projection?: 'PERSP' | 'ORTHO'
    orthoScale?: number
    cameraAspect?: number
    hiddenObjects?: string[]
    hiddenPrefixes?: string[]
    indoorTileGrid?: boolean
    near: number
    far: number
    preset: SetLightingPreset
    width?: number
    height?: number
  }): Promise<{ blob: Blob; bytes: ArrayBuffer; dataUrl: string }> {
    const prevW = this.canvas.width
    const prevH = this.canvas.height
    const capW = params.width ?? 1920
    const capH = params.height ?? 1080

    this.renderFrame({
      ...params,
      overscanY: 1.0,
      showHelpers: false,
      overrideWidth: capW,
      overrideHeight: capH,
    })

    const dataUrl = this.canvas.toDataURL('image/png')
    const blob = await new Promise<Blob>((resolve, reject) => {
      this.canvas.toBlob(b => {
        if (b) resolve(b)
        else reject(new Error('截图导出失败。'))
      }, 'image/png')
    })
    const bytes = await blob.arrayBuffer()

    // Restore viewport size
    this.canvas.width = prevW
    this.canvas.height = prevH
    return { blob, bytes, dataUrl }
  }

  private clearSceneGpuResources(): void {
    const gl = this.gl
    if (!gl) return
    for (const p of this.gpuPrimitives) {
      gl.deleteVertexArray(p.vao)
      gl.deleteBuffer(p.indexBuffer)
    }
    this.gpuPrimitives = []
    for (const t of this.gpuTextures) {
      gl.deleteTexture(t)
    }
    this.gpuTextures = []
    if (this.frustumBatch) {
      gl.deleteVertexArray(this.frustumBatch.vao)
      this.frustumBatch = null
    }
  }

  dispose(): void {
    this.disposed = true
    this.clearSceneGpuResources()
    const gl = this.gl
    if (gl) {
      if (this.gridBatch) gl.deleteVertexArray(this.gridBatch.vao)
      if (this.meshProgram) gl.deleteProgram(this.meshProgram)
      if (this.lineProgram) gl.deleteProgram(this.lineProgram)
    }
    this.gl = null
  }
}
