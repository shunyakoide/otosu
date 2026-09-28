import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, HalfFloatType, LinearFilter, LineSegments, Mesh, NearestFilter,
  NoBlending, PlaneGeometry, RGBAFormat, Scene, ShaderMaterial, Vector2, Vector4, WebGLRenderTarget, type Texture,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { BackdropLayer, LayerFrame } from './backdrop';

// 背景の粒子の流れ（D34、particles）。TouchDesigner の「GPU の粒子 ＋ フィードバック」のつくり。
// 粒子の位置は GPU のテクスチャに持ち、毎フレーム、渦を巻くノイズの流れ（curl noise）に乗せて動かす。
// 粒子は、ゆっくり漂う湧き出し口のまわりで生まれ、寿命が来ると生まれ直すので、いくつかの塊の流れになる。
// 動いた分を細い線で専用のバッファに描き足し、バッファは少しずつ薄くする（フィードバック）ので、軌跡が絹や煙の筋になる。
// 音に反応する: 当たるたびに、当たった点から粒子が噴き出し、そのまわりの流れを押しのけて渦を作る。
// 当たった点のそばの筋はその音の色になる。盛り上がり（energy）で流れが速くなる。
// 止めている間は、動かさず、薄くもしない（そのまま止まる）。

/** 粒子の数 = SIM × SIM */
const SIM = 160;
/** 湧き出し口の数 */
const SOURCES = 2;
/** 流れの範囲（見えている範囲の短いほうに対する半径の割合） */
const RADIUS = 0.5;
/** 流れの速さ（範囲の半径 / 秒）と、盛り上がりで増える分 */
const SPEED = 0.1;
const SPEED_ENERGY = 0.12;
/** 軌跡の残り方（60fps の1フレームあたり） */
const TRAIL_DAMP = 0.94;
/** 1本の線の明るさ */
const ALPHA = 0.05;
/** 覚えておく当たりの数と、効き目が消えるまで（秒） */
const MAX_HITS = 16;
const HIT_SEC = 2.5;

export const NOISE = /* glsl */ `
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453);
}
float rand(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dot(hash2(i), f), dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
             mix(dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), dot(hash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x), u.y);
}
`;

// 粒子の状態: xy = 位置（範囲の半径を 1 とする）、z = 残りの寿命 1..0、w = 粒子ごとの乱数
const SIM_FRAG = /* glsl */ `
#define N ${MAX_HITS}
#define S ${SOURCES}
uniform sampler2D state;
uniform float init;
uniform float dt;
uniform float time;
uniform float speed;
uniform vec4 hits[N];   // xy（範囲の中の位置）, 経過秒, 強さ
varying vec2 vUv;
${NOISE}

float field(vec2 p, float t) {
  return noise(p * 0.8 + vec2(t * 0.11, -t * 0.07)) + 0.45 * noise(p * 1.7 - vec2(t * 0.08, t * 0.13) + 5.0);
}
vec2 curl(vec2 p, float t) {
  float e = 0.02;
  float a = field(p + vec2(0.0, e), t) - field(p - vec2(0.0, e), t);
  float b = field(p + vec2(e, 0.0), t) - field(p - vec2(e, 0.0), t);
  return vec2(a, -b) / (2.0 * e);
}
vec2 source(int k, float t) {
  float fk = float(k);
  return 0.35 * vec2(cos(t * 0.05 + fk * 3.1 + 0.4), sin(t * 0.04 + fk * 2.7 + 1.1)) * vec2(1.2, 0.8);
}

vec2 spawn(float seed, float t) {
  float r1 = rand(vUv * 17.0 + t);
  float r2 = rand(vUv * 31.0 - t * 1.3);
  float r3 = rand(vUv * 7.0 + seed + t * 0.7);
  // 最近の当たりから噴き出す（強いほど多く）
  int k = int(r1 * float(N));
  for (int i = 0; i < N; i++) {
    if (i != k) continue;
    vec4 h = hits[i];
    if (h.w > 0.0 && h.z < 0.5 && r2 < h.w * 0.9) {
      float a = r3 * 6.2832;
      return h.xy + 0.03 * sqrt(r2) * vec2(cos(a), sin(a));
    }
  }
  // 湧き出し口のまわり
  int s = int(r2 * float(S));
  vec2 c = vec2(0.0);
  for (int i = 0; i < S; i++) if (i == s) c = source(i, t);
  float a = r3 * 6.2832;
  float r = 0.38 * sqrt(-2.0 * log(max(r1, 1e-3))) * 0.5;
  return c + r * vec2(cos(a), sin(a));
}

void main() {
  vec4 st = texture2D(state, vUv);
  float seed = init > 0.5 ? rand(vUv * 91.0) : st.w;
  vec2 p = st.xy;
  float life = st.z;
  if (init > 0.5) {
    p = spawn(seed, 0.0);
    life = rand(vUv * 3.0);
  }
  if (dt > 0.0) {
    life -= dt / (3.0 + 4.0 * seed);
    vec2 v = curl(p, time) * speed;
    // 外へ出すぎないよう、ゆるく中へ戻す
    float l = length(p);
    v -= p * max(l - 0.8, 0.0) * 0.6;
    // 当たり: 押しのけて渦を作る
    for (int i = 0; i < N; i++) {
      vec4 h = hits[i];
      if (h.w <= 0.0) continue;
      vec2 d = p - h.xy;
      float r2 = dot(d, d) + 1e-4;
      float env = h.w * exp(-h.z * 2.2) * exp(-r2 / 0.03);
      vec2 dir = d * inversesqrt(r2);
      v += (dir * 0.9 + vec2(-dir.y, dir.x) * 0.6) * env;
    }
    p += v * dt;
    if (life <= 0.0 || l > 1.6) {
      p = spawn(seed, time);
      life = 1.0;
    }
  }
  gl_FragColor = vec4(p, life, seed);
}`;

// 軌跡: 前の位置から今の位置へ線を引く
const LINE_VERT = /* glsl */ `
#define N ${MAX_HITS}
attribute vec2 ref;     // 粒子のテクスチャ座標
attribute float end;    // 0 = 前の位置、1 = 今の位置
uniform sampler2D prevState;
uniform sampler2D curState;
uniform vec2 center;
uniform float radius;
uniform float level;
uniform vec3 base;
uniform vec4 hits[N];
uniform vec3 hitCol[N];
varying vec3 vCol;

void main() {
  vec4 a = texture2D(prevState, ref);
  vec4 b = texture2D(curState, ref);
  vec4 st = end > 0.5 ? b : a;
  vec2 w = center + st.xy * radius;
  // 生まれ直した粒子（寿命が増えた）は線を引かない
  float born = b.z > a.z ? 0.0 : 1.0;
  float fadeLife = smoothstep(0.0, 0.15, b.z) * smoothstep(1.0, 0.85, b.z);
  vec3 hc = vec3(0.0);
  float lit = 0.0;
  for (int i = 0; i < N; i++) {
    vec4 h = hits[i];
    if (h.w <= 0.0) continue;
    vec2 d = b.xy - h.xy;
    float g = h.w * exp(-h.z * 1.2) * exp(-dot(d, d) / 0.04);
    hc += hitCol[i] * g;
    lit += g;
  }
  float k = clamp(lit * 1.5, 0.0, 1.0);
  vec3 col = mix(base, lit > 1e-4 ? hc / lit : base, k);
  vCol = col * ${ALPHA.toFixed(3)} * (0.5 + b.w) * born * fadeLife * (1.0 + 1.5 * k) * level;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(w.x, -w.y, 0.0, 1.0);
}`;

const LINE_FRAG = /* glsl */ `
varying vec3 vCol;
void main() { gl_FragColor = vec4(vCol, 1.0); }`;

export const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// 軌跡を薄くする
const FADE_FRAG = /* glsl */ `
uniform sampler2D src;
uniform float damp;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(src, vUv) * damp;
  // 暗くなった残りは切る（半精度で薄い影がいつまでも残らないように）
  gl_FragColor = c * step(0.004, max(c.r, max(c.g, c.b)));
}`;

// 画面へ: 軌跡のバッファをそのまま足す
const SHOW_FRAG = /* glsl */ `
uniform sampler2D trail;
uniform float level;
varying vec2 vUv;
void main() {
  // 重なって明るくなりすぎたところは頭打ちにする（ブルームで画面全体がかすまないように）
  vec3 c = texture2D(trail, vUv).rgb;
  float m = max(c.r, max(c.g, c.b));
  c *= m > 0.0 ? min(1.0, 0.55 * (1.0 - exp(-m * 2.0)) / (0.55 * m)) : 0.0;
  gl_FragColor = vec4(c * level, 1.0);
}`;

const simTarget = () => new WebGLRenderTarget(SIM, SIM, {
  type: HalfFloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false,
});
const trailTarget = () => new WebGLRenderTarget(1, 1, {
  type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false,
});

/** 背景の粒子の流れ */
export class Particles implements BackdropLayer {
  readonly object: Mesh;
  private simA = simTarget();
  private simB = simTarget();
  private trailA = trailTarget();
  private trailB = trailTarget();
  private started = false;
  private readonly hitsU = Array.from({ length: MAX_HITS }, () => new Vector4());
  private readonly hitColU = Array.from({ length: MAX_HITS }, () => new Color());
  private readonly simU = {
    state: { value: null as Texture | null },
    init: { value: 1 },
    dt: { value: 0 },
    time: { value: 0 },
    speed: { value: SPEED },
    hits: { value: this.hitsU },
  };
  private readonly simQuad = new FullScreenQuad(new ShaderMaterial({ uniforms: this.simU, vertexShader: QUAD_VERT, fragmentShader: SIM_FRAG, blending: NoBlending }));
  private readonly lineU = {
    prevState: { value: null as Texture | null },
    curState: { value: null as Texture | null },
    center: { value: new Vector2() },
    radius: { value: 300 },
    level: { value: 1 },
    base: { value: new Color() },
    hits: { value: this.hitsU },
    hitCol: { value: this.hitColU },
  };
  private readonly lines: LineSegments;
  private readonly lineScene = new Scene();
  private readonly size = new Vector2();
  private readonly fadeU = { src: { value: null as Texture | null }, damp: { value: TRAIL_DAMP } };
  private readonly fadeQuad = new FullScreenQuad(new ShaderMaterial({ uniforms: this.fadeU, vertexShader: QUAD_VERT, fragmentShader: FADE_FRAG, blending: NoBlending }));
  private readonly showU = { trail: { value: null as Texture | null }, level: { value: 1 } };

  private readonly hx = new Float32Array(MAX_HITS);
  private readonly hy = new Float32Array(MAX_HITS);
  private readonly hAt = new Float64Array(MAX_HITS).fill(-Infinity);
  private readonly hV = new Float32Array(MAX_HITS);
  private readonly hCol: Color[] = Array.from({ length: MAX_HITS }, () => new Color());
  private head = 0;
  private cx = 0;
  private cy = 0;
  private radius = 300;

  constructor() {
    // 粒子ごとに2頂点（前の位置と今の位置）
    const n = SIM * SIM;
    const ref = new Float32Array(n * 2 * 2);
    const end = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const u = ((i % SIM) + 0.5) / SIM;
      const v = (Math.floor(i / SIM) + 0.5) / SIM;
      ref.set([u, v, u, v], i * 4);
      end[i * 2 + 1] = 1;
    }
    const geo = new BufferGeometry();
    geo.setAttribute('ref', new BufferAttribute(ref, 2));
    geo.setAttribute('end', new BufferAttribute(end, 1));
    geo.setAttribute('position', new BufferAttribute(new Float32Array(n * 2 * 3), 3));
    this.lines = new LineSegments(geo, new ShaderMaterial({
      uniforms: this.lineU, vertexShader: LINE_VERT, fragmentShader: LINE_FRAG,
      blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
    }));
    this.lines.frustumCulled = false;
    this.lineScene.add(this.lines);

    this.object = new Mesh(new PlaneGeometry(2, 2), new ShaderMaterial({
      uniforms: this.showU, vertexShader: QUAD_VERT, fragmentShader: SHOW_FRAG,
      blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
    }));
    this.object.frustumCulled = false;
    this.object.renderOrder = -1;
  }

  hit(x: number, y: number, at: number, strength: number, _pitch: number, color: Color): void {
    const i = this.head;
    this.head = (i + 1) % MAX_HITS;
    // 流れの範囲の中の位置へ（範囲の外は縁に寄せる）
    let qx = (x - this.cx) / this.radius;
    let qy = (y - this.cy) / this.radius;
    const l = Math.hypot(qx, qy);
    if (l > 1) {
      qx /= l;
      qy /= l;
    }
    this.hx[i] = qx;
    this.hy[i] = qy;
    this.hAt[i] = at;
    this.hV[i] = strength;
    this.hCol[i]!.copy(color);
  }

  update(f: LayerFrame): void {
    const { renderer } = f;
    const { minX, maxX, maxY } = f.view;
    this.cx = (minX + maxX) / 2;
    this.cy = maxY / 2;
    this.radius = RADIUS * Math.min(maxX - minX, maxY);

    for (let i = 0; i < MAX_HITS; i++) {
      const age = f.time - this.hAt[i]!;
      const live = age >= 0 && age < HIT_SEC;
      this.hitsU[i]!.set(this.hx[i]!, this.hy[i]!, live ? age : 0, live ? this.hV[i]! : 0);
      this.hitColU[i]!.copy(this.hCol[i]!);
    }

    // 軌跡のバッファは画面と同じ大きさ（CSS px）
    const size = renderer.getSize(this.size);
    const w = Math.max(1, Math.round(size.x));
    const h = Math.max(1, Math.round(size.y));
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    if (this.trailA.width !== w || this.trailA.height !== h) {
      this.trailA.setSize(w, h);
      this.trailB.setSize(w, h);
      for (const t of [this.trailA, this.trailB]) {
        renderer.setRenderTarget(t);
        renderer.clear();
      }
    }

    const moving = !this.started || f.step > 0;
    if (moving) {
      // 粒子を動かす
      const dt = Math.min(f.step, 0.05);
      this.simU.state.value = this.simA.texture;
      this.simU.init.value = this.started ? 0 : 1;
      this.simU.dt.value = this.started ? dt : 0;
      this.simU.time.value = f.time;
      this.simU.speed.value = SPEED + SPEED_ENERGY * f.energy;
      renderer.setRenderTarget(this.simB);
      this.simQuad.render(renderer);
      [this.simA, this.simB] = [this.simB, this.simA];
      this.started = true;

      // 軌跡を薄くして、動いた分の線を描き足す
      this.fadeU.src.value = this.trailA.texture;
      this.fadeU.damp.value = Math.pow(TRAIL_DAMP, dt * 60);
      renderer.setRenderTarget(this.trailB);
      this.fadeQuad.render(renderer);
      this.lineU.prevState.value = this.simB.texture;
      this.lineU.curState.value = this.simA.texture;
      this.lineU.center.value.set(this.cx, this.cy);
      this.lineU.radius.value = this.radius;
      this.lineU.level.value = 1;
      this.lineU.base.value.copy(f.base);
      renderer.autoClear = false;
      renderer.render(this.lineScene, f.camera);
      [this.trailA, this.trailB] = [this.trailB, this.trailA];
    }
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);

    this.showU.trail.value = this.trailA.texture;
    this.showU.level.value = f.level;
  }

  dispose(): void {
    for (const t of [this.simA, this.simB, this.trailA, this.trailB]) t.dispose();
    this.simQuad.dispose();
    this.fadeQuad.dispose();
    this.lines.geometry.dispose();
    (this.lines.material as ShaderMaterial).dispose();
    this.object.geometry.dispose();
    (this.object.material as ShaderMaterial).dispose();
  }
}
