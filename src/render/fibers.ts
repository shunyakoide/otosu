import {
  AdditiveBlending, BufferAttribute, Color, FloatType, HalfFloatType, InstancedBufferAttribute, InstancedBufferGeometry, Mesh,
  NearestFilter, NoBlending, PlaneGeometry, RGBAFormat, Scene, ShaderMaterial, Vector2, Vector3, Vector4, WebGLRenderTarget,
  type Texture, type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { BackdropLayer, LayerFrame } from './backdrop';
import { CubeView, ISO_PITCH, ISO_YAW, NOISE3 } from './cube';
import { QUAD_VERT } from './particles';

// 背景の流線（D42、fibers）。立方体の中の curl noise（渦を巻くノイズの流れ）の流線を、細い筒で描く。
// 升目に並べた点から、流れに沿って前と後ろへたどった線なので、近い線はそろって流れ、束になって波打つ。
// 流れの向きが見る向きと重なる所では、線の端が升目の点に見える。
// 線の形は毎フレーム GPU でたどり直す（線ごと・節ごとに1テクセル）。流れはゆっくり変わる。
// 光は線の向きで決める（髪の毛の当たり方）。奥ほど暗い。立方体の外に出た所は切る。
// 奥の線が手前に隠れるよう、専用のバッファに深さつきで描いてから、画面に足す。
// 音が当たると、当たった点から球の波が広がり、波の通る所の流れが外へ押されて線がなびき、明るくなる。
// 波の広がる速さは音の高さで変わる（高いほど速い）。色は白黒だけ（D37）。時刻は renderStep から取るので、止めると止まる。

/** 1辺に並べる線の数（全部で GRID^3） */
const GRID = 12;
/** 線の節の数と、長さ・太さ（立方体の辺の半分を 1 とする） */
const SEG = 16;
const LEN = 0.75;
const WIDTH = 0.012;
/** 流れの模様の細かさと、変わる速さ */
const FREQ = 0.7;
const SPEED = 0.04;
/** 大きさ（立方体の辺の半分が、見えている範囲の短いほうの半分に占める割合） */
const FIT = 0.4;
/** 色と明るさ */
const COLOR = 0xd8dde4;
const BRIGHT = 0.38;
/** 描き込み先の解像度の上限（CSS px に対する倍率） */
const MAX_RATIO = 1.5;
/** 覚えておく当たりの数と、波が消えるまで（秒） */
const MAX_HITS = 12;
const HIT_SEC = 2.4;

/** 線の形のテクスチャ: 横 = 線の x × 節、縦 = 線の y と z */
const TEX_W = GRID * (SEG + 1);
const TEX_H = GRID * GRID;

// 線をたどる: 1テクセル = 1本の線の1つの節の位置
const TRACE_FRAG = /* glsl */ `
#define N ${MAX_HITS}
uniform float drift;   // 流れが変わった量（盛り上がりで速く進む）
uniform vec3 axis;
uniform vec4 hits[N];   // xyz（立方体の中）, 経過秒
uniform vec2 hitsV[N];  // 強さ, 音の高さ 0..1
${NOISE3}

// 値のノイズと、その傾き（0..1, 傾き）
vec4 noised(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  vec3 u = f * f * (3.0 - 2.0 * f);
  vec3 du = 6.0 * f * (1.0 - f);
  float a = hash3(i), b = hash3(i + vec3(1.0, 0.0, 0.0)), c = hash3(i + vec3(0.0, 1.0, 0.0)), d = hash3(i + vec3(1.0, 1.0, 0.0));
  float e = hash3(i + vec3(0.0, 0.0, 1.0)), g = hash3(i + vec3(1.0, 0.0, 1.0)), h = hash3(i + vec3(0.0, 1.0, 1.0)), k = hash3(i + vec3(1.0, 1.0, 1.0));
  float k1 = b - a, k2 = c - a, k3 = e - a, k4 = a - b - c + d, k5 = a - c - e + h, k6 = a - b - e + g, k7 = -a + b + c - d + e - g - h + k;
  return vec4(a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z,
    du * vec3(k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z, k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x, k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y));
}

vec3 flow(vec3 p, out float glow) {
  float t = drift;
  vec3 q = p * ${FREQ.toFixed(2)} + vec3(0.0, t, 0.5 * t);
  vec3 a = noised(q).yzw;
  vec3 b = noised(q + vec3(31.4, 7.1, 2.3)).yzw;
  vec3 c = noised(q + vec3(-5.2, 19.7, 11.9)).yzw;
  // curl（湧き出しのない流れ）。細かい渦を少し足す
  vec3 v = vec3(c.y - b.z, a.z - c.x, b.x - a.y);
  vec3 q2 = q * 2.3 + 4.1;
  vec3 a2 = noised(q2).yzw;
  vec3 b2 = noised(q2 + vec3(13.3, 3.7, 8.9)).yzw;
  vec3 c2 = noised(q2 + vec3(2.9, 17.1, 5.3)).yzw;
  v += 0.08 * vec3(c2.y - b2.z, a2.z - c2.x, b2.x - a2.y);
  glow = 0.0;
  float m = length(v) + 1e-4;
  for (int i = 0; i < N; i++) {
    float s = hitsV[i].x;
    if (s <= 0.0) continue;
    vec3 d = p - hits[i].xyz;
    float r = length(d);
    float age = hits[i].w;
    float front = age * mix(0.5, 1.4, hitsV[i].y);
    float w = exp(-pow((r - front) / 0.2, 2.0)) * min(1.2, s) * (1.0 - smoothstep(0.3, ${HIT_SEC.toFixed(2)}, age));
    vec3 n = d / max(r, 1e-3);
    v += (1.8 * n + 0.8 * cross(n, axis)) * w * m;
    glow += w;
  }
  return v / (length(v) + 1e-5);
}

float rnd1(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 px = floor(gl_FragCoord.xy);
  float gx = floor(px.x / ${(SEG + 1).toFixed(1)});
  float k = px.x - gx * ${(SEG + 1).toFixed(1)};
  float gy = mod(px.y, ${GRID.toFixed(1)});
  float gz = floor(px.y / ${GRID.toFixed(1)});
  // 根元: 升目の点を少しだけずらす
  vec3 id = vec3(gx, gy, gz);
  vec3 j = vec3(rnd1(id.xy + id.z * 7.1), rnd1(id.yz + id.x * 3.3), rnd1(id.zx + id.y * 5.7)) - 0.5;
  vec3 p = ((id + 0.5 + 0.25 * j) / ${GRID.toFixed(1)}) * 2.0 - 1.0;
  // 真ん中の節から、前（k が大きい）と後ろへたどる
  float n = k - ${(SEG / 2).toFixed(1)};
  float h = ${(LEN / SEG).toFixed(4)} * sign(n);
  float glow = 0.0;
  float g;
  for (int i = 0; i < ${SEG / 2}; i++) {
    if (float(i) >= abs(n)) break;
    vec3 v = flow(p, g);
    // 中点法（曲がりをなめらかに）
    vec3 v2 = flow(p + v * h * 0.5, g);
    p += v2 * h;
    glow = max(glow, g);
  }
  flow(p, g);
  gl_FragColor = vec4(p, max(glow, g));
}`;

const VERT = /* glsl */ `
attribute float along;  // 線の節 0 .. SEG
attribute float side;   // 帯の幅の -1 .. 1
attribute vec2 cell;    // 線の形のテクスチャでの線の場所（x = 線の x、y = 行）
uniform sampler2D shape;
uniform mat4 mvp;
uniform mat4 mv;
uniform vec2 halfRes;   // 描き込み先の大きさの半分（px）
uniform float focal;
uniform float minPx;
varying float vSide;
varying float vDepth;
varying float vGlow;
varying vec3 vT;
varying vec3 vP;

vec4 at(float k) {
  return texelFetch(shape, ivec2(int(cell.x) * ${SEG + 1} + int(clamp(k, 0.0, ${SEG.toFixed(1)})), int(cell.y)), 0);
}

void main() {
  vec4 s = at(along);
  vec3 P = s.xyz;
  vec3 T = at(along + 1.0).xyz - at(along - 1.0).xyz;
  T = length(T) > 1e-5 ? normalize(T) : vec3(0.0, 1.0, 0.0);
  vec4 c0 = mvp * vec4(P, 1.0);
  vec4 c1 = mvp * vec4(P + T * 0.02, 1.0);
  vec2 dir = (c1.xy / c1.w - c0.xy / c0.w) * halfRes;
  dir = length(dir) > 1e-5 ? normalize(dir) : vec2(1.0, 0.0);
  float wpx = max(${WIDTH.toFixed(4)} * focal * halfRes.y / c0.w, minPx);
  // 端は丸く見えるよう、少し延ばす
  float end = along < 0.5 ? -1.0 : (along > ${(SEG - 0.5).toFixed(1)} ? 1.0 : 0.0);
  c0.xy += (vec2(-dir.y, dir.x) * side + dir * end) * wpx / halfRes * c0.w;
  gl_Position = c0;
  vT = normalize(mat3(mv) * T);
  vSide = side;
  vDepth = -(mv * vec4(P, 1.0)).z;
  vGlow = s.w;
  vP = P;
}`;

const FRAG = /* glsl */ `
uniform vec3 base;
uniform vec2 depth;     // 手前, 奥
varying float vSide;
varying float vDepth;
varying float vGlow;
varying vec3 vT;
varying vec3 vP;
void main() {
  // 立方体の外に出た所は切る（輪郭をまっすぐにする）
  vec3 a = abs(vP);
  if (max(a.x, max(a.y, a.z)) > 1.0) discard;
  vec3 T = normalize(vT);
  vec3 L = normalize(vec3(-0.45, 0.75, 0.5));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float tl = dot(T, L);
  float th = dot(T, H);
  float diff = sqrt(max(0.0, 1.0 - tl * tl));
  float spec = pow(sqrt(max(0.0, 1.0 - th * th)), 32.0);
  // 筒の丸み: 真ん中が明るく、縁が暗い
  float rnd = sqrt(max(0.0, 1.0 - vSide * vSide));
  float fog = 1.0 - 0.7 * smoothstep(depth.x, depth.y, vDepth);
  float c = (0.08 + 0.7 * diff * rnd + 0.6 * spec * rnd * rnd) * fog + 0.35 * min(1.0, vGlow) * rnd;
  gl_FragColor = vec4(base * c, 1.0);
}`;

// 画面へ: 描き込み先をそのまま足す
const SHOW_FRAG = /* glsl */ `
uniform sampler2D src;
uniform float level;
varying vec2 vUv;
void main() { gl_FragColor = vec4(texture2D(src, vUv).rgb * level, 1.0); }`;

/** 線の形を入れる型（float に描けなければ半精度） */
function shapeType(renderer: WebGLRenderer) {
  return renderer.extensions.has('EXT_color_buffer_float') ? FloatType : HalfFloatType;
}

/** 背景の流線 */
export class Fibers implements BackdropLayer {
  readonly object: Mesh;
  private readonly view = new CubeView();
  private readonly target = new WebGLRenderTarget(1, 1, { samples: 4 });
  private shape: WebGLRenderTarget | null = null;
  private readonly scene = new Scene();
  private readonly lines: Mesh;
  private readonly hitsU = Array.from({ length: MAX_HITS }, () => new Vector4());
  private readonly hitsVU = Array.from({ length: MAX_HITS }, () => new Vector2());
  private readonly traceU = {
    drift: { value: 0 },
    axis: { value: new Vector3(0, 0, 1) },
    hits: { value: this.hitsU },
    hitsV: { value: this.hitsVU },
  };
  private readonly trace = new FullScreenQuad(new ShaderMaterial({
    uniforms: this.traceU, vertexShader: QUAD_VERT, fragmentShader: TRACE_FRAG, blending: NoBlending,
  }));
  private readonly u = {
    shape: { value: null as Texture | null },
    mvp: { value: this.view.mvp },
    mv: { value: this.view.mv },
    halfRes: { value: new Vector2(1, 1) },
    focal: { value: 1 },
    minPx: { value: 1 },
    base: { value: new Color(COLOR) },
    depth: { value: new Vector2(4, 6) },
  };
  private readonly showU = { src: { value: this.target.texture }, level: { value: 1 } };
  private readonly hp = Array.from({ length: MAX_HITS }, () => new Vector3());
  private readonly hAt = new Float64Array(MAX_HITS).fill(-Infinity);
  private readonly hV = new Float32Array(MAX_HITS);
  private readonly hPitch = new Float32Array(MAX_HITS);
  private head = 0;
  private readonly size = new Vector2();
  private readonly clear = new Color();
  private drawn = false;

  constructor() {
    // 1本の線 = 節ごとに左右2頂点の帯
    const geo = new InstancedBufferGeometry();
    const along = new Float32Array((SEG + 1) * 2);
    const side = new Float32Array((SEG + 1) * 2);
    const index: number[] = [];
    for (let k = 0; k <= SEG; k++) {
      along[k * 2] = along[k * 2 + 1] = k;
      side[k * 2] = -1;
      side[k * 2 + 1] = 1;
      if (k < SEG) index.push(k * 2 + 1, k * 2, k * 2 + 2, k * 2 + 1, k * 2 + 2, k * 2 + 3);
    }
    geo.setAttribute('along', new BufferAttribute(along, 1));
    geo.setAttribute('side', new BufferAttribute(side, 1));
    geo.setAttribute('position', new BufferAttribute(new Float32Array(along.length * 3), 3));
    geo.setIndex(index);
    const cell = new Float32Array(GRID ** 3 * 2);
    for (let i = 0; i < GRID ** 3; i++) cell.set([i % GRID, Math.floor(i / GRID)], i * 2);
    geo.setAttribute('cell', new InstancedBufferAttribute(cell, 2));
    geo.instanceCount = GRID ** 3;
    this.lines = new Mesh(geo, new ShaderMaterial({ uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG }));
    this.lines.frustumCulled = false;
    this.scene.add(this.lines);

    this.object = new Mesh(new PlaneGeometry(2, 2), new ShaderMaterial({
      uniforms: this.showU, vertexShader: QUAD_VERT, fragmentShader: SHOW_FRAG,
      blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
    }));
    this.object.frustumCulled = false;
    this.object.renderOrder = -1;
  }

  hit(x: number, y: number, at: number, strength: number, pitch: number, _color: Color): void {
    const i = this.head;
    this.head = (i + 1) % MAX_HITS;
    this.view.toLocal(x, y, this.hp[i]!);
    this.hAt[i] = at;
    this.hV[i] = strength;
    this.hPitch[i] = pitch;
  }

  update(f: LayerFrame): void {
    const { renderer } = f;
    const css = renderer.getSize(this.size);
    const ratio = Math.min(renderer.getPixelRatio(), MAX_RATIO);
    const w = Math.max(1, Math.round(css.x * ratio));
    const h = Math.max(1, Math.round(css.y * ratio));
    const resized = this.target.width !== w || this.target.height !== h;
    if (resized) this.target.setSize(w, h);
    this.showU.level.value = f.level * BRIGHT;
    // 止めている間は描き直さない
    if (this.drawn && !resized && f.step === 0) return;

    this.shape ??= new WebGLRenderTarget(TEX_W, TEX_H, {
      type: shapeType(renderer), format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false,
    });
    this.view.update(w / h, ISO_YAW, ISO_PITCH, FIT, f.camera);
    this.view.axis(this.traceU.axis.value);
    // 時刻 × 速さにすると、盛り上がりが変わった瞬間に流れがとぶので、フレームごとに足していく
    this.traceU.drift.value += f.step * SPEED * (1 + f.energy);
    for (let i = 0; i < MAX_HITS; i++) {
      const age = f.time - this.hAt[i]!;
      const live = age >= 0 && age < HIT_SEC;
      const p = this.hp[i]!;
      this.hitsU[i]!.set(p.x, p.y, p.z, live ? age : 0);
      this.hitsVU[i]!.set(live ? this.hV[i]! : 0, this.hPitch[i]!);
    }
    this.u.shape.value = this.shape.texture;
    this.u.halfRes.value.set(w / 2, h / 2);
    this.u.focal.value = this.view.focal;
    this.u.minPx.value = 0.6 * ratio;
    this.u.depth.value.set(this.view.dist - 1.4, this.view.dist + 1.4);

    const prevTarget = renderer.getRenderTarget();
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clear);
    // 線の形をたどってから、線を描く
    renderer.setRenderTarget(this.shape);
    this.trace.render(renderer);
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(this.scene, f.camera);
    renderer.setClearColor(this.clear, prevAlpha);
    renderer.setRenderTarget(prevTarget);
    this.drawn = true;
  }

  dispose(): void {
    this.target.dispose();
    this.shape?.dispose();
    this.trace.dispose();
    this.lines.geometry.dispose();
    (this.lines.material as ShaderMaterial).dispose();
    this.object.geometry.dispose();
    (this.object.material as ShaderMaterial).dispose();
  }
}
