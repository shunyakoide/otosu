import { AdditiveBlending, Color, Mesh, PlaneGeometry, ShaderMaterial, Vector2, Vector4, type Texture } from 'three';
import type { BackdropLayer, LayerFrame } from './backdrop';
import { NOISE, QUAD_VERT } from './glsl';
import { CellField, disposeMesh, HitRing } from './layer';

// 背景の網点（D38、bitmap）。画面を正方形の升目に分け、升目ごとに角の丸い四角の点を置く。
// 点の大きさは、ゆっくり動く濃淡の場で決まる（濃いほど大きく、隣とつながってぼやける）。
// 濃淡の場は、ゆっくり流れる低い周波数のノイズと、音が当たった点から広がる丸いにじみの和。
// にじみの大きさは強さで、広がる速さは音の高さで変わる（高いほど小さく速い）。
// 色は白黒の濃淡（D37）。薄いところは暗い灰の小さな点、濃いところは白へ。
// 升目の中は同じ値なので、なめらかな場が段々の点になって見える。時刻は renderStep から取るので、止めると止まる。

/** 升目の大きさ（CSS px） */
const CELL = 11;
/** 色の段階（薄い → 濃い）と明るさ */
const DEEP = 0x303030;
const MID = 0x9a9a9a;
const PALE = 0xffffff;
const ALPHA = 0.26;
/** ノイズの模様の大きさ（見えている範囲の短いほうに対する割合）と流れる速さ */
const SCALE = 0.45;
const SPEED = 0.05;
/** 覚えておく当たりの数と、にじみが消えるまで（秒） */
const MAX_HITS = 16;
const HIT_SEC = 3.2;

/** 升目ごとの濃さ（D66: 升目1つにつき1回だけ計算する） */
const FIELD = /* glsl */ `
#define N ${MAX_HITS}
uniform vec2 res;       // 描く先の大きさ（デバイス px）
uniform float cell;     // 升目（デバイス px）
uniform vec4 view;      // minX, maxX, maxY, unit（ワールド）
uniform float time;
uniform float energy;
uniform vec4 hits[N];   // xy（ワールド）, 経過秒, 強さ
uniform float hitsP[N]; // 音の高さ 0..1
${NOISE}

// 升目の真ん中での濃さ 0..1
float field(vec2 c) {
  vec2 uv = c / res;
  vec2 w = vec2(mix(view.x, view.y, uv.x), (1.0 - uv.y) * view.z);
  vec2 q = w / view.w;
  float t = time * ${SPEED.toFixed(3)} * (1.0 + energy);
  // ゆっくり流れる、ところどころ濃い場
  float n = noise(q * 1.3 + vec2(t, -0.7 * t)) + 0.5 * noise(q * 2.7 - vec2(0.6 * t, t) + 3.1);
  float v = smoothstep(0.02, 0.55, n + 0.12 * energy);
  for (int i = 0; i < N; i++) {
    vec4 h = hits[i];
    if (h.w <= 0.0) continue;
    vec2 d = (w - h.xy) / view.w;
    // 丸いにじみ
    float r = length(d);
    float sp = mix(0.14, 0.34, hitsP[i]);
    float grow = (0.06 + 0.22 * h.w) * (1.0 - exp(-h.z * (1.0 + 3.0 * hitsP[i])));
    float env = 1.0 - smoothstep(0.4, ${HIT_SEC.toFixed(2)}, h.z);
    float ring = exp(-pow(max(0.0, r - grow * 0.4) / sp, 2.0) * 4.0) * (1.0 - 0.35 * smoothstep(0.0, grow + 1e-3, r));
    v += ring * env * 0.7 * min(1.0, h.w);
  }
  return clamp(v, 0.0, 1.0);
}

vec4 cellValue(vec2 id) {
  return vec4(field((id + 0.5) * cell));
}`;

const FRAG = /* glsl */ `
uniform sampler2D fieldTex;
uniform float cell;
uniform float level;
uniform vec3 deep;
uniform vec3 mid;
uniform vec3 pale;

void main() {
  vec2 id = floor(gl_FragCoord.xy / cell);
  vec2 f = gl_FragCoord.xy / cell - id - 0.5;
  float v = texelFetch(fieldTex, ivec2(id), 0).x;
  if (v < 0.03) discard;
  // 点の半幅（升目を 1 とする）。濃いと升目いっぱいになり、縁がぼやける
  float s = 0.08 + 0.44 * v;
  float soft = 0.04 + 0.22 * v * v;
  float rr = 0.12 + 0.2 * v;
  vec2 b = abs(f) - (s - rr);
  float dist = length(max(b, 0.0)) + min(max(b.x, b.y), 0.0) - rr;
  float m = 1.0 - smoothstep(-soft, soft * 0.5, dist);
  // 濃淡: 薄いところは暗い灰、濃くなるにつれて明るい灰、白へ
  vec3 col = v < 0.6 ? mix(deep, mid, v / 0.6) : mix(mid, pale, pow((v - 0.6) / 0.4, 1.5));
  gl_FragColor = vec4(col * ${ALPHA.toFixed(3)} * (0.35 + 1.1 * v) * m * level, 1.0);
}`;

/** 背景の網点 */
export class Bitmap implements BackdropLayer {
  readonly object: Mesh;
  private readonly hitsU = Array.from({ length: MAX_HITS }, () => new Vector4());
  private readonly u = {
    res: { value: new Vector2(1, 1) },
    cell: { value: CELL },
    view: { value: new Vector4(0, 1, 1, 1) },
    time: { value: 0 },
    energy: { value: 0 },
    level: { value: 1 },
    deep: { value: new Color(DEEP) },
    mid: { value: new Color(MID) },
    pale: { value: new Color(PALE) },
    hits: { value: this.hitsU },
    hitsP: { value: new Array<number>(MAX_HITS).fill(0) },
    fieldTex: { value: null as Texture | null },
  };
  private readonly ring = new HitRing(MAX_HITS, HIT_SEC);
  private readonly field = new CellField(this.u, FIELD);

  constructor() {
    this.object = new Mesh(new PlaneGeometry(2, 2), new ShaderMaterial({
      uniforms: this.u, vertexShader: QUAD_VERT, fragmentShader: FRAG,
      blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
    }));
    this.object.frustumCulled = false;
    this.object.renderOrder = -1;
    this.u.fieldTex.value = this.field.texture;
  }

  hit(x: number, y: number, at: number, strength: number, pitch: number, _color: Color): void {
    this.ring.push(x, y, 0, at, strength, pitch);
  }

  update(f: LayerFrame): void {
    const { minX, maxX, maxY } = f.view;
    f.renderer.getDrawingBufferSize(this.u.res.value);
    this.u.cell.value = Math.max(4, Math.round(CELL * f.renderer.getPixelRatio()));
    this.u.view.value.set(minX, maxX, maxY, SCALE * Math.min(maxX - minX, maxY));
    this.u.time.value = f.time;
    this.u.energy.value = f.energy;
    this.u.level.value = f.level;
    this.ring.fill(this.hitsU, f.time);
    for (let i = 0; i < MAX_HITS; i++) this.u.hitsP.value[i] = this.ring.pitch[i]!;
    const { x: w, y: h } = this.u.res.value;
    const c = this.u.cell.value;
    this.field.render(f.renderer, Math.ceil(w / c), Math.ceil(h / c));
  }

  dispose(): void {
    this.field.dispose();
    disposeMesh(this.object);
  }
}
