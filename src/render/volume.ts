import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, Group, LineSegments, Points, ShaderMaterial, Vector2, Vector3, Vector4,
} from 'three';
import type { BackdropLayer, LayerFrame } from './backdrop';
import { CubeView } from './cube';
import { NOISE3, NOISED } from './glsl';
import { disposeMesh, HitRing } from './layer';

// 背景のノイズの塊（D43、volume）。線だけの立方体の中に、3D のノイズの塊を点の集まりで描く。
// 塊の形は「濃さ = ノイズ + 真ん中ほど濃い」がしきい値になる面（等値面）。点は面の近くのものだけを残し、
// 傾きの向きに2歩で面へ寄せるので、布が折れ重なったような膜になる。ノイズがゆっくり変わるので、膜がうねる。
// 点の明るさは、面の向き（見る向きに向いているほど明るい）と奥行きで決める。
// 音が当たると、当たった点のまわりの濃さが増えて膜がふくらみ、そこの点が外へはじける（光らせない。動きだけ）。
// 大きさは音の高さで変わる（低いほど大きい）。盛り上がり（energy）で塊が少しふくらみ、速く変わる。
// 立方体は平行投影で、アイソメトリックから少しずらした角度で見る（ちょうどアイソメトリックだと、線だけの立方体は手前と奥の角が重なって形がわかりにくい）。色は白黒だけ（D37）。時刻は renderStep から取るので、止めると止まる。

/** 点の数 */
const COUNT = 150_000;
/** 大きさ（立方体の辺の半分が、見えている範囲の短いほうの半分に占める割合）と、見る角度 */
const FIT = 0.4;
const YAW = 0.6;
const PITCH = 0.42;
/** ノイズの模様の大きさと、変わる速さ（ノイズの単位 / 秒） */
const FREQ = 1.6;
const SPEED = 0.07;
/** 面からどれだけ離れた点まで使うか（濃さの差） */
const BAND = 0.22;
/** 色と明るさ、点の大きさ（CSS px） */
const COLOR = 0xd8dde4;
const ALPHA = 0.3;
const DOT = 1.2;
const EDGE_ALPHA = 0.35;
/** 覚えておく当たりの数と、ふくらみが消えるまで（秒） */
const MAX_HITS = 12;
const HIT_SEC = 2.4;

const DOT_VERT = /* glsl */ `
#define N ${MAX_HITS}
attribute vec4 seed;    // xyz = 立方体の中の元の場所, w = 点ごとの乱数
uniform mat4 mvp;
uniform mat4 mv;
uniform float drift;
uniform float energy;
uniform float size;
uniform vec2 depth;     // 手前, 奥
uniform vec4 hits[N];   // xyz（立方体の中）, 経過秒
uniform vec2 hitsV[N];  // 強さ, 音の高さ 0..1
varying float vA;
${NOISE3}
${NOISED}

// 濃さと、その傾き
vec4 density(vec3 p) {
  vec3 q = p * ${FREQ.toFixed(2)} + vec3(0.0, drift, 0.6 * drift);
  vec4 a = noised(q);
  vec4 b = noised(q * 2.1 + 3.7);
  vec4 d = vec4(a.x - 0.5 + 0.45 * (b.x - 0.5), (a.yzw + 0.945 * b.yzw) * ${FREQ.toFixed(2)}) * 1.6;
  // 真ん中ほど濃い（濃さ 0 の面が塊の表面）
  d.x += 0.25 - 0.5 * dot(p, p);
  d.yzw += -1.0 * p;
  // 当たり: まわりの濃さが増える
  for (int i = 0; i < N; i++) {
    float s = hitsV[i].x;
    if (s <= 0.0) continue;
    float age = hits[i].w;
    float sig = mix(0.55, 0.28, hitsV[i].y);
    vec3 e = p - hits[i].xyz;
    float env = min(1.0, age * 8.0) * (1.0 - smoothstep(0.1, ${HIT_SEC.toFixed(2)}, age));
    float g = 0.9 * min(1.2, s) * env * exp(-dot(e, e) / (sig * sig));
    d.x += g;
    d.yzw += -2.0 * e / (sig * sig) * g;
  }
  return d;
}

void main() {
  vec3 p = seed.xyz;
  vec4 d = density(p);
  // 盛り上がると塊が少しふくらむ
  float off = d.x + 0.08 * energy;
  float w = exp(-pow(off / ${BAND.toFixed(3)}, 2.0));
  vA = 0.0;
  gl_PointSize = 0.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  if (w < 0.03) return;
  // 面へ2歩で寄せる（寄りきらなかった点は使わない）
  for (int k = 0; k < 2; k++) {
    float gg = max(dot(d.yzw, d.yzw), 0.05);
    p -= off * d.yzw / gg;
    d = density(p);
    off = d.x + 0.08 * energy;
  }
  if (abs(off) > 0.03) return;
  if (max(abs(p.x), max(abs(p.y), abs(p.z))) > 0.99) return;
  // 当たり: 点が外へはじける
  vec3 away = -normalize(d.yzw + 1e-5);
  vec3 push = vec3(0.0);
  for (int i = 0; i < N; i++) {
    float s = hitsV[i].x;
    if (s <= 0.0) continue;
    float age = hits[i].w;
    float r = length(p - hits[i].xyz);
    float sig = mix(0.55, 0.28, hitsV[i].y);
    float near = exp(-r * r / (sig * sig)) * min(1.2, s);
    // はじける: すぐ出て、ゆっくり戻る。点ごとに飛ぶ距離をばらつかせる
    float kick = age * 10.0 * exp(1.0 - age * 10.0) * 0.6 + exp(-age * 2.5) * 0.4;
    push += away * near * kick * (0.12 + 0.5 * seed.w * seed.w);
  }
  p += push;
  if (max(abs(p.x), max(abs(p.y), abs(p.z))) > 1.0) return;
  vec3 n = normalize(mat3(mv) * d.yzw + 1e-5);
  float face = 0.2 + 0.8 * abs(n.z) * abs(n.z);
  float z = -(mv * vec4(p, 1.0)).z;
  float fog = 1.0 - 0.6 * smoothstep(depth.x, depth.y, z);
  vA = face * fog * (0.6 + 0.8 * seed.w);
  gl_PointSize = size;
  gl_Position = mvp * vec4(p, 1.0);
}`;

const DOT_FRAG = /* glsl */ `
uniform vec3 base;
uniform float level;
varying float vA;
void main() {
  if (vA <= 0.0) discard;
  gl_FragColor = vec4(base * vA * ${ALPHA.toFixed(3)} * level, 1.0);
}`;

const EDGE_VERT = /* glsl */ `
uniform mat4 mvp;
void main() { gl_Position = mvp * vec4(position, 1.0); }`;

const EDGE_FRAG = /* glsl */ `
uniform vec3 base;
uniform float level;
void main() { gl_FragColor = vec4(base * ${EDGE_ALPHA.toFixed(3)} * level, 1.0); }`;

/** 背景のノイズの塊 */
export class Volume implements BackdropLayer {
  readonly object = new Group();
  private readonly view = new CubeView();
  private readonly dots: Points;
  private readonly edges: LineSegments;
  private readonly corners: Points;
  private readonly hitsU = Array.from({ length: MAX_HITS }, () => new Vector4());
  private readonly hitsVU = Array.from({ length: MAX_HITS }, () => new Vector2());
  private readonly u = {
    mvp: { value: this.view.mvp },
    mv: { value: this.view.mv },
    drift: { value: 0 },
    energy: { value: 0 },
    size: { value: DOT },
    depth: { value: new Vector2(4, 6) },
    base: { value: new Color(COLOR) },
    level: { value: 1 },
    hits: { value: this.hitsU },
    hitsV: { value: this.hitsVU },
  };
  private readonly edgeU = {
    mvp: { value: this.view.mvp },
    base: { value: new Color(COLOR) },
    level: { value: 1 },
  };
  private readonly cornerU = { ...this.edgeU, size: { value: 4 } };
  private readonly ring = new HitRing(MAX_HITS, HIT_SEC);
  private readonly hp = new Vector3();
  private readonly size = new Vector2();

  constructor() {
    const seed = new Float32Array(COUNT * 4);
    for (let i = 0; i < COUNT; i++) {
      seed.set([Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random()], i * 4);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('seed', new BufferAttribute(seed, 4));
    geo.setAttribute('position', new BufferAttribute(new Float32Array(COUNT * 3), 3));
    const blend = { blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false } as const;
    this.dots = new Points(geo, new ShaderMaterial({ uniforms: this.u, vertexShader: DOT_VERT, fragmentShader: DOT_FRAG, ...blend }));

    // 立方体の辺と角
    const c = [-1, 1];
    const corners: number[] = [];
    for (const x of c) for (const y of c) for (const z of c) corners.push(x, y, z);
    const lines: number[] = [];
    for (let a = 0; a < 8; a++) {
      for (let b = a + 1; b < 8; b++) {
        const diff = (a ^ b);
        if (diff === 1 || diff === 2 || diff === 4) lines.push(...corners.slice(a * 3, a * 3 + 3), ...corners.slice(b * 3, b * 3 + 3));
      }
    }
    const edgeGeo = new BufferGeometry();
    edgeGeo.setAttribute('position', new BufferAttribute(new Float32Array(lines), 3));
    this.edges = new LineSegments(edgeGeo, new ShaderMaterial({ uniforms: this.edgeU, vertexShader: EDGE_VERT, fragmentShader: EDGE_FRAG, ...blend }));
    const cornerGeo = new BufferGeometry();
    cornerGeo.setAttribute('position', new BufferAttribute(new Float32Array(corners), 3));
    this.corners = new Points(cornerGeo, new ShaderMaterial({
      uniforms: this.cornerU,
      vertexShader: `uniform mat4 mvp;\nuniform float size;\nvoid main() { gl_PointSize = size; gl_Position = mvp * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 base;\nuniform float level;\nvoid main() { if (length(gl_PointCoord - 0.5) > 0.5) discard; gl_FragColor = vec4(base * 0.8 * level, 1.0); }`,
      ...blend,
    }));

    for (const o of [this.dots, this.edges, this.corners]) {
      o.frustumCulled = false;
      o.renderOrder = -1;
      this.object.add(o);
    }
  }

  hit(x: number, y: number, at: number, strength: number, pitch: number, _color: Color): void {
    const p = this.view.toLocal(x, y, this.hp);
    this.ring.push(p.x, p.y, p.z, at, strength, pitch);
  }

  update(f: LayerFrame): void {
    const s = f.renderer.getSize(this.size);
    const pr = f.renderer.getPixelRatio();
    this.view.update(s.x / Math.max(1, s.y), YAW, PITCH, FIT, f.camera);
    // 時刻 × 速さにすると、盛り上がりが変わった瞬間に形がとぶので、フレームごとに足していく（D42）
    this.u.drift.value += f.step * SPEED * (1 + f.energy);
    this.u.energy.value = f.energy;
    this.u.size.value = DOT * pr;
    this.u.depth.value.set(this.view.dist - 1.4, this.view.dist + 1.4);
    this.u.level.value = f.level;
    this.edgeU.level.value = f.level;
    this.cornerU.size.value = 4 * pr;
    this.ring.fill3(this.hitsU, this.hitsVU, f.time);
  }

  dispose(): void {
    for (const o of [this.dots, this.edges, this.corners]) disposeMesh(o);
  }
}
