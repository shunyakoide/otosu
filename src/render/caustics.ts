import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, LineSegments, ShaderMaterial, Vector2, Vector3, Vector4 } from 'three';
import type { BackdropLayer, LayerFrame } from './backdrop';
import { disposeMesh, HitRing } from './layer';

// 背景の光の膜（D33、caustics）。光線の格子を、うねる面（高さ h）の傾きで曲げ、行き着いた先に細い線を引く。
// 線は加算で重ねるので、光が集まるところほど明るく、膜が折れ重なったところに明るい尖り（カスプ）ができる。
// 全面ではなく、画面の中央にいくつかの膜がまとまって浮かぶ。
// 音に反応して形を変える: 当たるたびに、当たった点に対応する面から輪が広がって膜がゆがみ、
// 折れ（屈折の強さ）が一瞬強くなる。輪のところは音の色が少し混ざる。盛り上がり（energy）で折れが強く、速くなる。
// 形は頂点シェーダーで計算する（CPU は当たりを覚えるだけ）。時刻は renderStep から取るので、止めると膜も止まる。

/** 光線の格子: 横の線の本数と、1本の区切り数 */
const ROWS = 320;
const SEG = 220;
/** 模様の大きさ（見えている範囲の短いほうに対する半幅の割合） */
const SIZE = 0.36;
/** 屈折の強さ（大きいほど膜が折れる）、盛り上がりで増える分、当たりで一瞬増える分とその上限・収まる時間（秒） */
const FOLD = 1.5;
const FOLD_ENERGY = 0.5;
const FOLD_KICK = 0.35;
const FOLD_KICK_MAX = 0.7;
const FOLD_KICK_SEC = 0.9;
/** 1本の線の明るさ */
const ALPHA = 0.04;
/** 覚えておく当たりの数と、輪が消えるまで（秒） */
const MAX_HITS = 16;
const WAVE_SEC = 3;

const VERT = /* glsl */ `
#define N ${MAX_HITS}
attribute vec2 q;       // 光線の格子上の位置 [-1, 1]
attribute float seed;   // 線ごとの明るさ 0..1（規則的な縞に見えないよう、線ごとにばらつかせる）
uniform float time;
uniform float energy;
uniform float fold;
uniform float level;
uniform vec2 center;    // ワールド
uniform vec2 size;      // 半幅（ワールド）
uniform vec3 base;
uniform vec4 hits[N];   // 格子上の位置 xy, 経過秒, 強さ
uniform vec3 hitCol[N];
varying vec3 vCol;

// 1つの波の傾き: h = a sin(f (d・p) + s t + ph)
vec2 wave(vec2 p, float ang, float f, float a, float s, float ph, float t) {
  vec2 d = vec2(cos(ang), sin(ang));
  return d * (a * f * cos(f * dot(d, p) + s * t + ph));
}

void main() {
  float t = time * (0.55 + 0.35 * energy);
  // 格子をゆっくりゆがめてから波を重ねる（規則的に見えないように）
  vec2 p = q + 0.28 * vec2(sin(1.3 * q.y + 0.21 * t + 1.0), sin(1.1 * q.x - 0.17 * t + 2.0));
  vec2 g = vec2(0.0);
  g += wave(p, 0.30, 2.1, 0.100, 0.21, 0.0, t);
  g += wave(p, 1.90, 2.9, 0.070, -0.17, 1.3, t);
  g += wave(p, 2.80, 4.3, 0.045, 0.31, 2.1, t);
  g += wave(p, 4.10, 5.7, 0.030, -0.26, 4.0, t);
  g += wave(p, 5.20, 7.9, 0.022, 0.40, 0.7, t);
  g += wave(p, 0.90, 11.0, 0.014, -0.50, 5.3, t);
  g += wave(p, 3.40, 15.0, 0.007, 0.60, 2.9, t);

  // 当たりの輪
  vec3 hc = vec3(0.0);
  float lit = 0.0;
  for (int i = 0; i < N; i++) {
    vec4 e = hits[i];
    if (e.w <= 0.0) continue;
    vec2 d = q - e.xy;
    float r = length(d) + 1e-3;
    float x = r - e.z * 0.55;
    float env = e.w * exp(-e.z / 1.1) * exp(-x * x / 0.03);
    g += (d / r) * (0.28 * cos(x * 16.0) * env);
    hc += hitCol[i] * env;
    lit += env;
  }

  vec2 w = center + size * (q + fold * g);

  // まとまり: 縁に向かって消える（縁は不規則に）。膜ごとに明るさが違う
  float ang = atan(q.y, q.x);
  float edge = length(q) * (1.0 + 0.22 * sin(3.0 * ang + 0.2 * t) + 0.12 * sin(5.0 * ang - 0.3 * t + 1.0));
  float mask = 1.0 - smoothstep(0.45, 1.0, edge);
  float sheet = smoothstep(0.1, 1.1, sin(2.3 * q.x + 1.7 * q.y + 0.3 * t) + 0.6 * sin(3.1 * q.y - 2.0 * q.x - 0.2 * t));
  float a = ${ALPHA.toFixed(3)} * mask * (0.1 + 0.9 * sheet) * (0.15 + 1.7 * seed * seed) * (1.0 + 0.6 * energy);
  float k = 0.45 * clamp(lit * 1.5, 0.0, 1.0);
  vec3 col = mix(base, lit > 1e-4 ? hc / lit : base, k);
  vCol = col * a * (1.0 + 1.5 * k) * level;
  // ワールドは y 下向き、カメラは y 上向き
  gl_Position = projectionMatrix * modelViewMatrix * vec4(w.x, -w.y, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
varying vec3 vCol;
void main() { gl_FragColor = vec4(vCol, 1.0); }`;

/** 決まった値の乱数 0..1 */
function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** 背景の光の膜 */
export class Caustics implements BackdropLayer {
  readonly object: LineSegments;
  private readonly u = {
    time: { value: 0 },
    energy: { value: 0 },
    fold: { value: FOLD },
    level: { value: 0 },
    center: { value: new Vector2() },
    size: { value: new Vector2(300, 300) },
    base: { value: new Color() },
    hits: { value: Array.from({ length: MAX_HITS }, () => new Vector4()) },
    hitCol: { value: Array.from({ length: MAX_HITS }, () => new Vector3()) },
  };
  private readonly ring = new HitRing(MAX_HITS, WAVE_SEC);
  private readonly hCol: Color[] = Array.from({ length: MAX_HITS }, () => new Color());
  private kick = 0;

  constructor() {
    // 横の線（y を固定して x を進む）。線の位置を少しずらし、明るさをばらつかせる
    const q = new Float32Array(ROWS * (SEG + 1) * 2);
    const seed = new Float32Array(ROWS * (SEG + 1));
    const index = new Uint32Array(ROWS * SEG * 2);
    let v = 0;
    let k = 0;
    for (let l = 0; l < ROWS; l++) {
      const r1 = hash(l * 2 + 1);
      const r2 = hash(l * 2 + 2);
      const c = (l / (ROWS - 1)) * 2 - 1 + (r1 - 0.5) * (2 / ROWS);
      const start = v;
      for (let j = 0; j <= SEG; j++) {
        q[v * 2] = (j / SEG) * 2 - 1;
        q[v * 2 + 1] = c;
        seed[v] = r2;
        v++;
      }
      for (let j = 0; j < SEG; j++) {
        index[k++] = start + j;
        index[k++] = start + j + 1;
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('q', new BufferAttribute(q, 2));
    geo.setAttribute('seed', new BufferAttribute(seed, 1));
    // three は position を要る（使わない）
    geo.setAttribute('position', new BufferAttribute(new Float32Array(v * 3), 3));
    geo.setIndex(new BufferAttribute(index, 1));
    this.object = new LineSegments(geo, new ShaderMaterial({
      uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG,
      blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
    }));
    this.object.frustumCulled = false;
    this.object.renderOrder = -1;
  }

  /** 当たった（ワールド座標、時刻は秒）。color は音の色 */
  hit(x: number, y: number, at: number, strength: number, _pitch: number, color: Color): void {
    // 格子上の位置へ（模様の中に収める）
    const c = this.u.center.value;
    const s = this.u.size.value;
    let qx = (x - c.x) / s.x;
    let qy = (y - c.y) / s.y;
    const l = Math.hypot(qx, qy);
    if (l > 0.8) {
      qx *= 0.8 / l;
      qy *= 0.8 / l;
    }
    const i = this.ring.push(qx, qy, 0, at, strength, 0);
    this.hCol[i]!.copy(color);
    this.kick = Math.min(FOLD_KICK_MAX, this.kick + FOLD_KICK * strength);
  }

  update(f: LayerFrame): void {
    const { minX, maxX, maxY } = f.view;
    const w = maxX - minX;
    const h = maxY;
    const m = Math.min(w, h);
    const u = this.u;
    u.center.value.set((minX + maxX) / 2, h / 2);
    // 縦長・横長の画面では長いほうへ少し広げる
    u.size.value.set(SIZE * Math.min(w, m * 1.4), SIZE * Math.min(h, m * 1.4));
    this.kick *= Math.exp(-f.step / FOLD_KICK_SEC);
    u.time.value = f.time;
    u.energy.value = f.energy;
    u.fold.value = FOLD * (1 + FOLD_ENERGY * f.energy) + this.kick;
    u.level.value = f.level;
    u.base.value.copy(f.base);
    this.ring.fill(u.hits.value, f.time);
    for (let i = 0; i < MAX_HITS; i++) {
      const c = this.hCol[i]!;
      u.hitCol.value[i]!.set(c.r, c.g, c.b);
    }
  }

  dispose(): void {
    disposeMesh(this.object);
  }
}
