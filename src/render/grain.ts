import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, Points, ShaderMaterial, Vector2, Vector4,
} from 'three';
import type { BackdropLayer, LayerFrame } from './backdrop';
import { NOISE } from './particles';

// 背景の粒（D35、grain）。TouchDesigner の作品「Trajectory」の、点の集まりで形を見せる描き方。
// 粒は画面全体に散らばり、ふだんはそれぞれの場所のまわりを、粒ごとにばらばらにわずかに動く。
// 音が当たると、その近くの粒同士が寄り集まって形（輪か線）になり、音が消えるとまた元の場所へほどける。
// 形の大きさは音の高さで変わり（高いほど小さく締まる）、寄せる範囲は当たりの強さで広がる。
// 粒の位置は、元の場所と当たりの記録から頂点シェーダーで毎フレーム計算する（粒の状態を持たない）。
// 色は設定によらず白黒だけ。点は毎フレーム少し瞬くので、フィルムの粒のようになる。時刻は renderStep から取るので、止めると止まる。
// 当たった点の計器の表示は hud.ts（D36）。

/** 粒の数 */
const COUNT = 256 * 256;
/** 座標の単位（見えている範囲の短いほうに対する割合）。形の大きさなどはこの単位 */
const UNIT = 0.55;
/** 色（色の設定によらず白黒だけ） */
const COLOR = 0xd8dde4;
/** 1粒の明るさと大きさ（CSS px） */
const ALPHA = 0.07;
const DOT = 0.8;
/** ふだんの動きの大きさ（元の場所からの距離、unit を 1 とする）と、盛り上がりで増える分 */
const JITTER = 0.018;
const JITTER_ENERGY = 0.012;
/** 覚えておく当たりの数と、形がほどけきるまで（秒） */
const MAX_HITS = 16;
const HIT_SEC = 2.2;

const DOT_VERT = /* glsl */ `
#define N ${MAX_HITS}
attribute vec2 ref;     // 粒ごとの乱数
uniform vec2 center;
uniform float unit;
uniform vec2 extent;    // 見えている範囲の半分（unit を 1 とする）
uniform float level;
uniform float size;
uniform float time;
uniform float jitter;
uniform vec3 base;
uniform vec4 hits[N];   // xy（unit を 1 とする位置）, 経過秒, 強さ
uniform vec4 hitsB[N];  // x = 音の高さ 0..1、y = 形（< 0.5 輪 / それ以外 線）、z = 向き・揺らぎの乱数
varying vec3 vCol;
${NOISE}

void main() {
  // 元の場所（画面全体に均等に散らす）
  vec2 home = (vec2(rand(ref * 1.37), rand(ref * 2.91 + 0.5)) * 2.0 - 1.0) * extent * 1.03;
  // 粒ごとにばらばらの速さ・向き・大きさで、元の場所のまわりをふらふら動く
  vec4 r = vec4(rand(ref * 3.1), rand(ref * 4.7), rand(ref * 6.3), rand(ref * 9.9));
  vec2 fq = 0.25 + 0.9 * r.xy;
  vec2 ph = r.zw * 6.2832;
  vec2 wob = vec2(sin(time * fq.x + ph.x) + 0.5 * sin(time * fq.y * 2.3 + ph.y),
                  sin(time * fq.y + ph.y) + 0.5 * sin(time * fq.x * 1.9 + ph.x)) / 1.5;
  home += jitter * (0.3 + 0.7 * rand(ref * 12.7)) * wob;
  float grain = rand(ref * 5.3);

  vec2 acc = vec2(0.0);
  float wsum = 0.0;
  for (int i = 0; i < N; i++) {
    vec4 h = hits[i];
    if (h.w <= 0.0) continue;
    vec4 b = hitsB[i];
    vec2 d = home - h.xy;
    // 寄せる範囲は強さで広がる
    float reach = 0.18 + 0.2 * h.w;
    float infl = exp(-dot(d, d) / (reach * reach));
    if (infl < 0.01) continue;
    // すばやく寄って、しばらく保ち、ゆっくりほどける
    float env = smoothstep(0.0, 0.12, h.z) * (1.0 - smoothstep(0.35, ${HIT_SEC.toFixed(2)}, h.z));
    float w = infl * env;
    // 形の大きさは音の高さで変わる（高いほど小さい）
    float r0 = mix(0.16, 0.05, b.x) * (0.7 + 0.5 * h.w);
    vec2 tgt;
    if (b.y < 0.5) {
      // 輪: 近くの粒を、当たった点を囲む揺らいだ輪へ
      float a = atan(d.y, d.x);
      float r = r0 * (1.0 + 0.25 * noise(vec2(a * 1.5, b.z * 9.0 + h.z * 0.5)));
      tgt = h.xy + vec2(cos(a), sin(a)) * r;
    } else {
      // 線: 当たった点を通る短い線へ（向きは当たるごとに変わる）
      float ang = b.z * 6.2832;
      vec2 t = vec2(cos(ang), sin(ang));
      float along = clamp(dot(d, t), -r0 * 2.5, r0 * 2.5);
      tgt = h.xy + t * along + vec2(-t.y, t.x) * 0.012 * noise(vec2(along * 20.0, b.z * 5.0));
    }
    // 形にも少し厚みを残して、ざらつかせる
    tgt += (vec2(rand(ref * 7.1), rand(ref * 8.3)) - 0.5) * 0.018;
    acc += (tgt - home) * w;
    wsum += w;
  }
  vec2 p = home + acc / max(1.0, wsum);
  float k = clamp(wsum, 0.0, 1.0);
  // 瞬き（時刻から作るので、止めると止まる）
  float flick = 0.3 + 1.4 * rand(ref * 53.0 + floor(time * 24.0) * 0.137);
  vCol = base * ${ALPHA.toFixed(3)} * (0.4 + grain) * flick * (1.0 + 1.5 * k) * level;
  vec2 w = center + p * unit;
  gl_PointSize = size;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(w.x, -w.y, 0.0, 1.0);
}`;

const DOT_FRAG = /* glsl */ `
varying vec3 vCol;
void main() { gl_FragColor = vec4(vCol, 1.0); }`;

/** 背景の粒 */
export class Grain implements BackdropLayer {
  readonly object: Points;
  private readonly hitsU = Array.from({ length: MAX_HITS }, () => new Vector4());
  private readonly hitsBU = Array.from({ length: MAX_HITS }, () => new Vector4());
  private readonly u = {
    center: { value: new Vector2() },
    unit: { value: 300 },
    extent: { value: new Vector2(1, 1) },
    level: { value: 1 },
    size: { value: DOT },
    time: { value: 0 },
    jitter: { value: JITTER },
    base: { value: new Color(COLOR) },
    hits: { value: this.hitsU },
    hitsB: { value: this.hitsBU },
  };

  private readonly hx = new Float32Array(MAX_HITS);
  private readonly hy = new Float32Array(MAX_HITS);
  private readonly hAt = new Float64Array(MAX_HITS).fill(-Infinity);
  private readonly hV = new Float32Array(MAX_HITS);
  private readonly hPitch = new Float32Array(MAX_HITS);
  private readonly hForm = new Float32Array(MAX_HITS);
  private readonly hSeed = new Float32Array(MAX_HITS);
  private head = 0;
  private cx = 0;
  private cy = 0;
  private unit = 300;

  constructor() {
    const ref = new Float32Array(COUNT * 2);
    for (let i = 0; i < COUNT; i++) ref.set([Math.random() * 100, Math.random() * 100], i * 2);
    const geo = new BufferGeometry();
    geo.setAttribute('ref', new BufferAttribute(ref, 2));
    geo.setAttribute('position', new BufferAttribute(new Float32Array(COUNT * 3), 3));
    this.object = new Points(geo, new ShaderMaterial({
      uniforms: this.u, vertexShader: DOT_VERT, fragmentShader: DOT_FRAG,
      blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
    }));
    this.object.frustumCulled = false;
    this.object.renderOrder = -1;
  }

  hit(x: number, y: number, at: number, strength: number, pitch: number, _color: Color): void {
    const i = this.head;
    this.head = (i + 1) % MAX_HITS;
    this.hx[i] = (x - this.cx) / this.unit;
    this.hy[i] = (y - this.cy) / this.unit;
    this.hAt[i] = at;
    this.hV[i] = Math.min(1.5, strength);
    this.hPitch[i] = pitch;
    this.hForm[i] = Math.random();
    this.hSeed[i] = Math.random();
  }

  update(f: LayerFrame): void {
    const { minX, maxX, maxY } = f.view;
    this.cx = (minX + maxX) / 2;
    this.cy = maxY / 2;
    this.unit = UNIT * Math.min(maxX - minX, maxY);

    for (let i = 0; i < MAX_HITS; i++) {
      const age = f.time - this.hAt[i]!;
      const live = age >= 0 && age < HIT_SEC;
      this.hitsU[i]!.set(this.hx[i]!, this.hy[i]!, live ? age : 0, live ? this.hV[i]! : 0);
      this.hitsBU[i]!.set(this.hPitch[i]!, this.hForm[i]!, this.hSeed[i]!, 0);
    }
    this.u.center.value.set(this.cx, this.cy);
    this.u.unit.value = this.unit;
    this.u.extent.value.set((maxX - minX) / 2 / this.unit, maxY / 2 / this.unit);
    this.u.level.value = f.level;
    this.u.size.value = Math.max(1, DOT * f.renderer.getPixelRatio());
    this.u.time.value = f.time;
    this.u.jitter.value = JITTER + JITTER_ENERGY * f.energy;
  }

  dispose(): void {
    this.object.geometry.dispose();
    (this.object.material as ShaderMaterial).dispose();
  }
}
