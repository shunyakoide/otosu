import { AdditiveBlending, CanvasTexture, Color, LinearFilter, Mesh, PlaneGeometry, ShaderMaterial, Vector2, Vector4 } from 'three';
import type { BackdropLayer, LayerFrame } from './backdrop';
import { NOISE, QUAD_VERT } from './glsl';
import { disposeMesh, HitRing } from './layer';

// 背景の文字の網（D39、ascii）。画面を縦長の升目に分け、升目ごとに文字を1つ置く。
// 文字は濃淡の場で決まる（薄い ` . : - = + * # % @` 濃い）。場はゆっくり流れるノイズと、当たった点のにじみの和。
// 音が当たると、そこから輪が広がり、輪の上の文字はでたらめに入れ替わりながら明るく光る（文字が流れる）。
// 輪の広がる速さは音の高さで変わる（高いほど速い）。色は白黒だけ（D37）。
// 文字は canvas に並べて描いた1枚のテクスチャから取る。時刻は renderStep から取るので、止めると止まる。

/** 濃さの順に並べた文字 */
const RAMP = ' .:-=+*#%@';
/** 入れ替わりに使う文字 */
const NOISE_CHARS = '01<>/\\|[]{}';
const GLYPHS = RAMP + NOISE_CHARS;
/** 升目の大きさ（CSS px） */
const CELL_W = 9;
const CELL_H = 14;
/** 色と明るさ */
const COLOR = 0xd8dde4;
const ALPHA = 0.32;
/** ノイズの模様の大きさ（見えている範囲の短いほうに対する割合）と流れる速さ */
const SCALE = 0.4;
const SPEED = 0.06;
/** 覚えておく当たりの数と、消えるまで（秒） */
const MAX_HITS = 16;
const HIT_SEC = 2.6;

const FRAG = /* glsl */ `
#define N ${MAX_HITS}
uniform sampler2D atlas;
uniform vec2 res;       // 描く先の大きさ（デバイス px）
uniform vec2 cell;      // 升目（デバイス px）
uniform vec4 view;      // minX, maxX, maxY, unit（ワールド）
uniform float time;
uniform float energy;
uniform float level;
uniform vec3 base;
uniform vec4 hits[N];   // xy（ワールド）, 経過秒, 強さ
uniform float hitsP[N]; // 音の高さ 0..1
${NOISE}

void main() {
  vec2 id = floor(gl_FragCoord.xy / cell);
  vec2 f = gl_FragCoord.xy / cell - id;
  vec2 uv = (id + 0.5) * cell / res;
  vec2 w = vec2(mix(view.x, view.y, uv.x), (1.0 - uv.y) * view.z);
  vec2 q = w / view.w;
  float t = time * ${SPEED.toFixed(3)} * (1.0 + energy);

  // ゆっくり流れる濃淡
  float n = noise(q * 1.4 + vec2(0.4 * t, t)) + 0.5 * noise(q * 3.1 - vec2(t, 0.3 * t) + 7.3);
  float v = smoothstep(0.05, 0.7, n + 0.1 * energy) * 0.7;
  // 当たり: 輪が広がり、輪の上は文字が入れ替わる
  float scr = 0.0;
  for (int i = 0; i < N; i++) {
    vec4 h = hits[i];
    if (h.w <= 0.0) continue;
    float r = length((w - h.xy) / view.w);
    float fade = 1.0 - smoothstep(0.2, ${HIT_SEC.toFixed(2)}, h.z);
    float front = h.z * mix(0.35, 0.8, hitsP[i]);
    float ring = exp(-pow((r - front) / 0.035, 2.0));
    float core = exp(-r * r / (0.02 + 0.04 * h.w)) * exp(-h.z * 1.5);
    v += (0.5 * ring + core) * fade * min(1.2, h.w);
    scr += ring * fade * min(1.0, h.w);
  }
  v = clamp(v, 0.0, 1.0);

  float k = floor(v * ${(RAMP.length - 1).toFixed(1)} + 0.5);
  // 輪の上では、文字が時刻ごとにでたらめに入れ替わる
  float tick = floor(time * 18.0);
  if (rand(id + tick * 0.173) < scr * 0.7) k = ${RAMP.length.toFixed(1)} + floor(rand(id * 1.7 + tick * 0.31) * ${NOISE_CHARS.length.toFixed(1)});
  if (k < 0.5) discard;
  float g = texture2D(atlas, vec2((k + f.x) / ${GLYPHS.length.toFixed(1)}, f.y)).r;
  float a = ${ALPHA.toFixed(3)} * (0.35 + 0.9 * v + 1.2 * scr);
  gl_FragColor = vec4(base * g * a * level, 1.0);
}`;

/** 文字を横に並べたテクスチャ */
function makeAtlas(): CanvasTexture {
  const gw = 32;
  const gh = 48;
  const canvas = document.createElement('canvas');
  canvas.width = gw * GLYPHS.length;
  canvas.height = gh;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#fff';
  g.font = `${gh * 0.62}px ui-monospace, Menlo, monospace`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 0; i < GLYPHS.length; i++) g.fillText(GLYPHS[i]!, gw * (i + 0.5), gh * 0.52);
  const tex = new CanvasTexture(canvas);
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

/** 背景の文字の網 */
export class Ascii implements BackdropLayer {
  readonly object: Mesh;
  private readonly hitsU = Array.from({ length: MAX_HITS }, () => new Vector4());
  private readonly u = {
    atlas: { value: makeAtlas() },
    res: { value: new Vector2(1, 1) },
    cell: { value: new Vector2(CELL_W, CELL_H) },
    view: { value: new Vector4(0, 1, 1, 1) },
    time: { value: 0 },
    energy: { value: 0 },
    level: { value: 1 },
    base: { value: new Color(COLOR) },
    hits: { value: this.hitsU },
    hitsP: { value: new Array<number>(MAX_HITS).fill(0) },
  };
  private readonly ring = new HitRing(MAX_HITS, HIT_SEC);

  constructor() {
    this.object = new Mesh(new PlaneGeometry(2, 2), new ShaderMaterial({
      uniforms: this.u, vertexShader: QUAD_VERT, fragmentShader: FRAG,
      blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
    }));
    this.object.frustumCulled = false;
    this.object.renderOrder = -1;
  }

  hit(x: number, y: number, at: number, strength: number, pitch: number, _color: Color): void {
    this.ring.push(x, y, 0, at, strength, pitch);
  }

  update(f: LayerFrame): void {
    const { minX, maxX, maxY } = f.view;
    const pr = f.renderer.getPixelRatio();
    f.renderer.getDrawingBufferSize(this.u.res.value);
    this.u.cell.value.set(Math.max(4, Math.round(CELL_W * pr)), Math.max(6, Math.round(CELL_H * pr)));
    this.u.view.value.set(minX, maxX, maxY, SCALE * Math.min(maxX - minX, maxY));
    this.u.time.value = f.time;
    this.u.energy.value = f.energy;
    this.u.level.value = f.level;
    this.ring.fill(this.hitsU, f.time);
    for (let i = 0; i < MAX_HITS; i++) this.u.hitsP.value[i] = this.ring.pitch[i]!;
  }

  dispose(): void {
    this.u.atlas.value.dispose();
    disposeMesh(this.object);
  }
}
