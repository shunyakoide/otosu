import {
  AdditiveBlending, CircleGeometry, CustomBlending, MaxEquation, OneFactor, Color, HalfFloatType, InstancedBufferAttribute, InstancedMesh,
  MeshBasicMaterial, NeutralToneMapping, Object3D, OrthographicCamera, PlaneGeometry, RingGeometry,
  Scene, Vector2, WebGLRenderTarget, WebGLRenderer, DynamicDrawUsage, type BufferGeometry,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { closestOnSegment } from '../sim/collide';
import { BALL_RADIUS, HZ, LINE_WIDTH, MAX_BALLS, MIN_LINE_LEN, WORLD_H, WORLD_W, type Bounds } from '../sim/constants';
import { lengthToNote } from '../sim/music';
import type { SegKind, ShapeAddedEvent, ShapeForm, SimEvent, Snapshot } from '../sim/types';
import { GRAY, noteColor, OFF_WHITE, type ColorMode } from './palette';

// 描画は「renderStep 時点の世界」を表示する（decisions.md D3, D8-5）。
// sim は LOOKAHEAD ぶん先行しているので、イベントは renderStep に達してから反映する。
// sim の Segment / Emitter は参照せず、イベントから図形（group）単位の自分用コピーを持つ（D9, D14）。

export type TrailMode = 'geometry' | 'afterimage';

export type RenderParams = {
  colorMode: ColorMode;
  bloomStrength: number;
  afterimage: number;
  idleLine: number;
  /** 'geometry' = 履歴から尾を描く（ステップ2）/ 'afterimage' = ステップ1の見た目（尾なし・damp 0.88） */
  trail?: TrailMode;
};

/** 描画中の図形とホバー（座標は論理ワールド）。input.ts が書き、render が読む */
export type Preview = {
  active: boolean;
  /** 頂点列 [x0, y0, x1, y1, ...] */
  points: number[];
  closed: boolean;
  bumper: boolean;
  /** 周長（音程の決定に使う） */
  perimeter: number;
  hover: { active: boolean; x: number; y: number };
};

/** ボール位置の履歴だけを使う（sim の他の状態は見ない） */
export type SnapshotSource = { snapshot(step: number): Snapshot | undefined };

export const PICK_RADIUS = 12;

const MAX_VERTS = 64;
const MAX_EDGE_INST = 2048;
const MAX_CAPS = 2048;
const MAX_RIPPLES = 64;
const MAX_EMITTERS = 8;

// 尾（step2 案1）＋ 連鎖の光（D15）
const TRAIL_STEPS = 30;
const TRAIL_STRIDE = 2;
const CHAIN_EXTRA_STEPS = 12;
const CHAIN_EXTRA_MAX = 4;
const TRAIL_QUADS_MAX = (TRAIL_STEPS + CHAIN_EXTRA_STEPS * CHAIN_EXTRA_MAX) / TRAIL_STRIDE;
const CHAIN_FADE_SEC = 1.0;
/** 尾の1クアッドの明るさの上限（重なりの加算でブルームが滲まないように） */
const TRAIL_CAP = 0.9;
/** これより短い区間はクアッドにしない（px） */
const TRAIL_MIN_LEN = 4;
const CHAIN_PATH_MAX = 8;
const REPLAY_GAP = 8; // ステップ
const LEGACY_DAMP = 0.88;

// 削除（step2 案3）
const DIE_SEC = 0.2;
const WIPE_SEC = 0.3;
const WIPE_DELAY_SEC = 0.15;
const HOVER_TAU = 0.05;
const EMITTER_TAU = 0.2;

// バンパー: 二重線
const BUMPER_OFFSET = 2.5;
const BUMPER_WIDTH = 2;

// 形ごとの光（D16）。音と光は 1:1: 光るのは HitEvent の step だけ
// circle（キック）: 図形全体が脈打つ（速い立ち上がり → 減衰）＋重心から輪が広がる。大きい円ほどゆっくり大きく
const KICK_ATTACK = 0.015;
/** 脈の減衰の時定数: 小さい円 KICK_DECAY_MIN → 半径 KICK_BIG_R 以上で +KICK_DECAY_BIG */
const KICK_DECAY_MIN = 0.3;
const KICK_DECAY_BIG = 0.25;
const KICK_BIG_R = 200;
/** 脈のときの明るさの上乗せ（0.35 + 0.55v）· 包絡（最大 ~0.85） */
const KICK_GAIN = 0.35;
const KICK_GAIN_V = 0.55;
/** 重心まわりの拡大（(0.5 + v) · KICK_SCALE · 包絡） */
const KICK_SCALE = 0.03;
/** 輪: 図形の半径から grow = KICK_RING_GROW + KICK_RING_GROW_K·半径 だけ広がる。長さ dur = KICK_RING_SEC + KICK_RING_SEC_BIG·(大きさ) */
const KICK_RING_GROW = 20;
const KICK_RING_GROW_K = 0.6;
const KICK_RING_SEC = 0.7;
const KICK_RING_SEC_BIG = 0.8;
const KICK_RING_GAIN = 0.45;
// triangle（金属）: 辺に沿って細かいきらめきが散り、長く残る
const METAL_TAU = 2.5;
/** 図形全体の長い余韻（控えめ） */
const METAL_GLOW = 0.12;
const MAX_GLINTS = 768;
/** 1回の衝突のきらめきの数 = GLINT_BASE + GLINT_PER_V·v */
const GLINT_BASE = 10;
const GLINT_PER_V = 14;
/** 半分は打点のまわり（周長 × ±GLINT_SPREAD）、残りは周全体に */
const GLINT_SPREAD = 0.12;
/** 出てくるまでの遅れ（最大、秒）: 散らばって順に灯る */
const GLINT_STAGGER = 0.9;
const GLINT_TAU_MIN = 1.2;
const GLINT_TAU_MAX = 2.8;
/** 1粒の明るさの上限（小さい点なのでブルームで大きく滲まない程度） */
const GLINT_GAIN = 1.0;
/** 辺からの法線方向のずれ（±px） */
const GLINT_JITTER = 2.5;
// square（木）: 短く鋭い閃光、余韻ほぼなし。一瞬だけ外側に細い輪郭が弾ける
const WOOD_FLASH = 0.045;
const WOOD_TAU = 0.15;
const WOOD_ECHO_SEC = 0.12;
const WOOD_ECHO_GROW = 0.06;
const WOOD_RIPPLE_SEC = 0.18;

type BallLook = { note: number; step: number; v: number; chain: number };
/** 波紋: 半径 r0 から grow だけ dur 秒で広がる。明るさ gain·(1−p)² */
type Ripple = { x: number; y: number; step: number; note: number; r0: number; grow: number; dur: number; gain: number };
type Hit = { step: number; v: number; s: number; tau: number };
type Shape = {
  group: number;
  kind: SegKind;
  form: ShapeForm;
  note: number;
  closed: boolean;
  /** 重心から頂点までの平均距離（circle のキックの大きさ） */
  radius: number;
  gx: number;
  gy: number;
  /** 重心からの相対頂点（φ = 0） */
  rel: Float32Array;
  n: number;
  /** 辺ごとの周上の開始位置と長さ */
  s0: Float32Array;
  elen: Float32Array;
  perimeter: number;
  theta0: number;
  rotStartStep: number;
  omega: number;
  hit: Hit | null;
  resStep: number;
  resV: number;
  replayAt: number;
};
type Dying = { shape: Shape; phi: number; step: number; delay: number; dur: number };
type EmitterView = { x: number; y: number; tx: number; ty: number; pulse: number };

function additive(): MeshBasicMaterial {
  return new MeshBasicMaterial({
    blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
  });
}

function maxBlend(): MeshBasicMaterial {
  return new MeshBasicMaterial({
    blending: CustomBlending, blendEquation: MaxEquation, blendSrc: OneFactor, blendDst: OneFactor,
    transparent: true, depthTest: false, depthWrite: false,
  });
}

function instanced(geo: BufferGeometry, count: number, order: number, mat = additive()): InstancedMesh {
  const mesh = new InstancedMesh(geo, mat, count);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
  mesh.instanceColor.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  mesh.count = 0;
  return mesh;
}

function commit(mesh: InstancedMesh, n: number, extra: InstancedBufferAttribute[] = []): void {
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor!.needsUpdate = true;
  for (const a of extra) a.needsUpdate = true;
}

/**
 * 辺のマテリアル（弦が鳴る）。インスタンスごとに
 *   aA = (辺の周上の開始位置 s0, 辺の長さ, 打点の周上の位置, 揺れの変位 px)
 *   aB = (全体の明るさ, 打点の光の強さ, 打点の光の広がり σ, 閉じた図形なら周長・開いていれば 0)
 * instanceColor は色味だけ（明るさ 1）。打点からの周上の距離 d で exp(−d/σ) の光を足す。
 */
function stringMaterial(): MeshBasicMaterial {
  const mat = additive();
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aA;
attribute vec4 aB;
varying vec4 vA;
varying vec4 vB;
varying float vU;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vA = aA;
vB = aB;
vU = position.x + 0.5;
#ifdef USE_INSTANCING
float wScale = max(length(instanceMatrix[1].xyz), 1e-3);
#else
float wScale = 1.0;
#endif
transformed.y += aA.w * sin(PI * vU) / wScale;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec4 vA;
varying vec4 vB;
varying float vU;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float sPos = vA.x + vU * vA.y;
float dHit = abs(sPos - vA.z);
if (vB.w > 0.0) dHit = min(dHit, vB.w - dHit);
float gHit = exp(-dHit / max(vB.z, 1.0));
diffuseColor.rgb = diffuseColor.rgb * (vB.x + vB.y * gHit) + vec3(0.08 * vB.y * exp(-dHit / 6.0));`);
  };
  return mat;
}

const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);
/** 図形の回転角 φ(step)（sim の shapeAngle と同じ式） */
const shapeAngle = (s: Shape, step: number) => s.theta0 + (s.omega * (step - s.rotStartStep)) / HZ;
/** 弦の余韻の時定数: 低音（note 0）ほど長い 1.5s → 高音（note 15）0.4s */
const stringTau = (note: number) => 1.5 - (1.1 * Math.min(15, Math.max(0, note))) / 15;
/** 円の大きさ 0..1 */
const kickSize = (r: number) => Math.min(1, Math.max(0, r / KICK_BIG_R));
/** 見た目だけに使う決定論的な乱数 [0, 1)（ステップ・図形・番号から） */
function hash01(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b) ^ Math.imul((c | 0) + 0x165667b1, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** 画面上端のツールバー用の帯（CSS px）。index.html の #toolbar と合わせる */
export const TOP_BAND_PX = 52;

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(0, WORLD_W, 0, -WORLD_H, -10, 10);
  private readonly composer: EffectComposer;
  private readonly afterimage: AfterimagePass;
  private readonly bloom: UnrealBloomPass;

  private readonly balls = instanced(new CircleGeometry(1, 20), MAX_BALLS + 1, 3);
  // 尾は MAX 合成: クアッドの重なりが加算されて白飛び・ブルームの大きな滲みにならないように
  private readonly trails = instanced(new PlaneGeometry(1, 1), (MAX_BALLS + 1) * TRAIL_QUADS_MAX, 2, maxBlend());
  private readonly edges = instanced(new PlaneGeometry(1, 1, 16, 1), MAX_EDGE_INST, 2, stringMaterial());
  private readonly aA = new InstancedBufferAttribute(new Float32Array(MAX_EDGE_INST * 4), 4);
  private readonly aB = new InstancedBufferAttribute(new Float32Array(MAX_EDGE_INST * 4), 4);
  private readonly caps = instanced(new CircleGeometry(1, 16), MAX_CAPS, 2);
  private readonly ripples = instanced(new RingGeometry(0.93, 1, 48), MAX_RIPPLES, 1);
  private readonly emitterMesh = instanced(new RingGeometry(0.6, 1, 32), MAX_EMITTERS, 1);
  private readonly glints = instanced(new CircleGeometry(1, 8), MAX_GLINTS, 3);

  // きらめき（triangle）のリングバッファ。gStep = Infinity は空き
  private readonly gGroup = new Int32Array(MAX_GLINTS);
  private readonly gStep = new Float64Array(MAX_GLINTS).fill(Infinity);
  private readonly gArc = new Float32Array(MAX_GLINTS);
  private readonly gDelay = new Float32Array(MAX_GLINTS);
  private readonly gTau = new Float32Array(MAX_GLINTS);
  private readonly gFreq = new Float32Array(MAX_GLINTS);
  private readonly gPhase = new Float32Array(MAX_GLINTS);
  private readonly gSize = new Float32Array(MAX_GLINTS);
  private readonly gOff = new Float32Array(MAX_GLINTS);
  private readonly gGain = new Float32Array(MAX_GLINTS);
  private glintHead = 0;
  private readonly pt = { x: 0, y: 0, nx: 0, ny: 0 };

  private readonly shapes = new Map<number, Shape>();
  private readonly dying = new Map<number, Dying>();
  private readonly hoverAmt = new Map<number, number>();
  private readonly ballLook = new Map<number, BallLook>();
  private readonly ballPath = new Map<number, number[]>();
  private readonly emitters = new Map<number, EmitterView>();
  private readonly rippleBuf: Ripple[] = [];
  private rippleHead = 0;
  private pending: SimEvent[] = [];

  // 盛り上がり（energy）と区間（section）
  private energyTarget = 0;
  private energyStep = -Infinity;
  private energy = 0;
  private sectionStep = -Infinity;

  // 毎フレーム new しないための作業領域
  private readonly verts = new Float32Array(MAX_VERTS * 2);
  private readonly trailSnaps: (Snapshot | undefined)[] = new Array(TRAIL_QUADS_MAX + 1);
  private readonly trailPtr = new Int32Array(TRAIL_QUADS_MAX + 1);
  private nEdge = 0;
  private nCap = 0;

  private previewNote = -1;
  private previewFlashAt = -Infinity;
  private lastRs = -1;

  private readonly dummy = new Object3D();
  private readonly color = new Color();
  private readonly tint = new Color();
  private readonly near = { dist: 0, nx: 0, ny: 0 };
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private view: Bounds = { minX: 0, maxX: WORLD_W, maxY: WORLD_H };

  private readonly params: RenderParams;

  constructor(parent: HTMLElement, params: RenderParams) {
    this.params = params;
    this.renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1));
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = NeutralToneMapping;
    this.canvas = this.renderer.domElement;
    parent.appendChild(this.canvas);

    this.aA.setUsage(DynamicDrawUsage);
    this.aB.setUsage(DynamicDrawUsage);
    this.edges.geometry.setAttribute('aA', this.aA);
    this.edges.geometry.setAttribute('aB', this.aB);

    const rt = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.afterimage = new AfterimagePass(params.afterimage);
    this.composer.addPass(this.afterimage);
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), params.bloomStrength, 0.35, 0.8);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.scene.add(this.ripples, this.emitterMesh, this.trails, this.edges, this.caps, this.glints, this.balls);
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  setPixelRatio(r: number): void {
    this.renderer.setPixelRatio(r);
    this.resize();
  }

  /** 画面座標 → 論理ワールド座標 */
  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    return { x: (clientX - this.offsetX) / this.scale, y: (clientY - this.offsetY) / this.scale };
  }

  /** 表示されている範囲（ワールド座標） */
  get viewBounds(): Bounds {
    return this.view;
  }

  get worldScale(): number {
    return this.scale;
  }

  /**
   * 表示中の図形のうち (x, y) に最も近いものの group（なければ -1）。
   * 辺から PICK_RADIUS 以内、または閉じた図形の内側。姿勢は直近に描画した renderStep のもの（B3）。
   */
  pickShape(x: number, y: number, radius = PICK_RADIUS): number {
    let bestId = -1;
    let best = radius;
    for (const s of this.shapes.values()) {
      const v = this.pose(s, shapeAngle(s, this.lastRs), 1);
      const ne = s.closed ? s.n : s.n - 1;
      let inside = false;
      for (let i = 0; i < ne; i++) {
        const j = (i + 1) % s.n;
        const ax = v[i * 2]!, ay = v[i * 2 + 1]!, bx = v[j * 2]!, by = v[j * 2 + 1]!;
        closestOnSegment(x, y, ax, ay, bx, by, this.near);
        if (this.near.dist < best) {
          best = this.near.dist;
          bestId = s.group;
        }
        if (s.closed && (ay > y) !== (by > y) && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) inside = !inside;
      }
      // 内側は、他の図形の辺の近くより優先度を下げる
      if (inside && bestId < 0) {
        best = radius * 0.99;
        bestId = s.group;
      }
    }
    return bestId;
  }

  /** 互換: main が pickSegment を呼んでいても図形の group を返す */
  pickSegment(x: number, y: number): number {
    return this.pickShape(x, y);
  }

  private resize(): void {
    const w = innerWidth;
    const h = innerHeight;
    // 上端はツールバーの帯としてあけ、ワールドはその下から始める（D24）
    const s = Math.min(w / WORLD_W, (h - TOP_BAND_PX) / WORLD_H);
    this.scale = s;
    // 16:9 のワールドは左右中央・上寄せ。余りはウィンドウ全体を使う（縦長なら下、横長なら左右。D23）
    this.offsetX = (w - WORLD_W * s) / 2;
    this.offsetY = TOP_BAND_PX;
    const viewW = w / s;
    const viewH = (h - TOP_BAND_PX) / s;
    this.camera.left = -(viewW - WORLD_W) / 2;
    this.camera.right = this.camera.left + viewW;
    this.camera.top = TOP_BAND_PX / s;
    this.camera.bottom = -viewH;
    this.view = { minX: this.camera.left, maxX: this.camera.right, maxY: viewH };
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  /** sim のイベントを受け取る。反映は renderStep に達してから */
  push(events: readonly SimEvent[]): void {
    for (const e of events) this.pending.push(e);
  }

  // ---- イベント ----

  private addShape(e: ShapeAddedEvent): void {
    const n = Math.min(e.points.length, MAX_VERTS);
    const rel = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      rel[i * 2] = e.points[i]![0];
      rel[i * 2 + 1] = e.points[i]![1];
    }
    const ne = e.closed ? n : n - 1;
    const s0 = new Float32Array(Math.max(ne, 0));
    const elen = new Float32Array(Math.max(ne, 0));
    let p = 0;
    for (let i = 0; i < ne; i++) {
      const j = (i + 1) % n;
      s0[i] = p;
      elen[i] = Math.hypot(rel[j * 2]! - rel[i * 2]!, rel[j * 2 + 1]! - rel[i * 2 + 1]!);
      p += elen[i]!;
    }
    let radius = 0;
    for (let i = 0; i < n; i++) radius += Math.hypot(rel[i * 2]!, rel[i * 2 + 1]!);
    radius = n > 0 ? radius / n : 0;
    const shape: Shape = {
      group: e.group, kind: e.segKind, form: e.form, note: e.note, closed: e.closed, radius, gx: e.gx, gy: e.gy,
      rel, n, s0, elen, perimeter: p,
      theta0: 0, rotStartStep: e.step, omega: 0,
      hit: null,
      resStep: -Infinity, resV: 0, replayAt: -Infinity,
    };
    this.shapes.set(e.group, shape);
    // 置いた瞬間（確定音）: 形の光で鳴らす。line / pen は始点から光が走る
    this.trigger(shape, e.step, 0.5, 0);
  }

  /** 図形を形の性格で光らせる（衝突・確定音の共通） */
  private trigger(s: Shape, step: number, v: number, arc: number): void {
    switch (s.form) {
      case 'circle': {
        const k = kickSize(s.radius);
        s.hit = { step, v, s: 0, tau: KICK_DECAY_MIN + KICK_DECAY_BIG * k };
        // 重心から広がる淡い輪（大きい円ほどゆっくり大きく）
        this.pushRipple({
          x: s.gx, y: s.gy, step, note: s.note, r0: s.radius,
          grow: KICK_RING_GROW + KICK_RING_GROW_K * s.radius,
          dur: KICK_RING_SEC + KICK_RING_SEC_BIG * k,
          gain: KICK_RING_GAIN * (0.4 + v),
        });
        break;
      }
      case 'triangle':
        s.hit = { step, v, s: arc, tau: METAL_TAU };
        this.spawnGlints(s, step, v, arc);
        break;
      case 'square':
        s.hit = { step, v, s: arc, tau: WOOD_TAU };
        break;
      default:
        s.hit = { step, v, s: arc, tau: stringTau(s.note) };
    }
  }

  private pushRipple(r: Ripple): void {
    if (this.rippleBuf.length < MAX_RIPPLES) this.rippleBuf.push(r);
    else this.rippleBuf[this.rippleHead] = r;
    this.rippleHead = (this.rippleHead + 1) % MAX_RIPPLES;
  }

  /** きらめきを辺に散らす。位置・遅れ・瞬きはステップと図形からのハッシュで決まる */
  private spawnGlints(s: Shape, step: number, v: number, arc: number): void {
    if (s.perimeter <= 0) return;
    const cnt = GLINT_BASE + Math.round(GLINT_PER_V * v);
    for (let k = 0; k < cnt; k++) {
      const i = this.glintHead;
      this.glintHead = (this.glintHead + 1) % MAX_GLINTS;
      const b = k * 8;
      const near = (k & 1) === 0;
      let a = near
        ? arc + (hash01(step, s.group, b) - 0.5) * 2 * GLINT_SPREAD * s.perimeter
        : hash01(step, s.group, b) * s.perimeter;
      a %= s.perimeter;
      if (a < 0) a += s.perimeter;
      this.gGroup[i] = s.group;
      this.gStep[i] = step;
      this.gArc[i] = a;
      this.gDelay[i] = hash01(step, s.group, b + 1) * GLINT_STAGGER * (near ? 0.3 : 1);
      this.gTau[i] = GLINT_TAU_MIN + hash01(step, s.group, b + 2) * (GLINT_TAU_MAX - GLINT_TAU_MIN);
      this.gFreq[i] = 2 + 7 * hash01(step, s.group, b + 3);
      this.gPhase[i] = 2 * Math.PI * hash01(step, s.group, b + 4);
      this.gSize[i] = 0.9 + 1.1 * hash01(step, s.group, b + 5);
      this.gOff[i] = (hash01(step, s.group, b + 6) - 0.5) * 2 * GLINT_JITTER;
      this.gGain[i] = GLINT_GAIN * (0.5 + 0.5 * v) * (0.6 + 0.4 * hash01(step, s.group, b + 7));
    }
  }

  /** 周上の位置 arc の点と辺の法線（回転角 φ）を this.pt に書く */
  private pointAt(s: Shape, phi: number, arc: number): void {
    const ne = s.closed ? s.n : s.n - 1;
    const o = this.pt;
    if (ne <= 0) {
      o.x = s.gx; o.y = s.gy; o.nx = 0; o.ny = 0;
      return;
    }
    let i = 0;
    while (i < ne - 1 && arc > s.s0[i]! + s.elen[i]!) i++;
    const j = (i + 1) % s.n;
    const el = s.elen[i]!;
    const u = el > 0 ? Math.min(1, Math.max(0, (arc - s.s0[i]!) / el)) : 0;
    const x0 = s.rel[i * 2]!, y0 = s.rel[i * 2 + 1]!;
    const ex = s.rel[j * 2]! - x0, ey = s.rel[j * 2 + 1]! - y0;
    const lx = x0 + u * ex, ly = y0 + u * ey;
    const cs = Math.cos(phi), sn = Math.sin(phi);
    o.x = s.gx + cs * lx - sn * ly;
    o.y = s.gy + sn * lx + cs * ly;
    const tx = el > 0 ? ex / el : 0, ty = el > 0 ? ey / el : 0;
    o.nx = -(sn * tx + cs * ty);
    o.ny = cs * tx - sn * ty;
  }

  /** 打点 (x, y) の周上の位置 */
  private arcPos(s: Shape, step: number, x: number, y: number): number {
    const v = this.pose(s, shapeAngle(s, step), 1);
    const ne = s.closed ? s.n : s.n - 1;
    let best = Infinity;
    let pos = 0;
    for (let i = 0; i < ne; i++) {
      const j = (i + 1) % s.n;
      const ax = v[i * 2]!, ay = v[i * 2 + 1]!;
      const ex = v[j * 2]! - ax, ey = v[j * 2 + 1]! - ay;
      const ll = ex * ex + ey * ey;
      const u = ll > 0 ? Math.min(1, Math.max(0, ((x - ax) * ex + (y - ay) * ey) / ll)) : 0;
      const d = Math.hypot(x - ax - u * ex, y - ay - u * ey);
      if (d < best) {
        best = d;
        pos = s.s0[i]! + u * s.elen[i]!;
      }
    }
    return pos;
  }

  private onHit(e: Extract<SimEvent, { kind: 'hit' }>): void {
    const s = this.shapes.get(e.group);
    // circle は図形全体が光る（打点は使わない）
    if (s) this.trigger(s, e.step, e.velocity, e.form === 'circle' ? 0 : this.arcPos(s, e.step, e.x, e.y));

    // 共鳴: 同じスロットの他の図形がほのかに光る（D11）
    for (const o of this.shapes.values()) {
      if (o.note === e.note && o.group !== e.group) {
        o.resStep = e.step;
        o.resV = e.velocity;
      }
    }

    this.ballLook.set(e.ballId, { note: e.note, step: e.step, v: e.velocity, chain: e.chain });

    // 連鎖: 通った図形を覚え、5 連鎖（以後 3 つごと）で順に光らせ直す
    let path = this.ballPath.get(e.ballId);
    if (!path || e.chain <= 1) {
      path = [];
      this.ballPath.set(e.ballId, path);
    }
    path.push(e.group);
    if (path.length > CHAIN_PATH_MAX) path.shift();
    if (e.chain >= 5 && (e.chain - 5) % 3 === 0) {
      path.forEach((g, i) => {
        const t = this.shapes.get(g);
        if (t) t.replayAt = e.step + REPLAY_GAP * (i + 1);
      });
    }

    this.energyTarget = e.energy;
    this.energyStep = e.step;

    // 打点の波紋（circle は重心の輪で代える。square は短く小さく）
    if (e.velocity >= 0.25 && e.form !== 'circle') {
      const wood = e.form === 'square';
      this.pushRipple({
        x: e.x, y: e.y, step: e.step, note: e.note, r0: BALL_RADIUS,
        grow: wood ? 12 + 20 * e.velocity : 20 + 40 * e.velocity,
        dur: wood ? WOOD_RIPPLE_SEC : 0.5,
        gain: 1.2 * e.velocity,
      });
    }
  }

  private consume(rs: number): void {
    let n = 0;
    let removedStep = -1;
    let removed: Dying[] = [];
    for (const e of this.pending) {
      if (e.step > rs) break;
      n++;
      switch (e.kind) {
        case 'hit':
          this.onHit(e);
          break;
        case 'emit': {
          const em = this.emitters.get(e.emitterId);
          if (em) {
            em.tx = e.x;
            em.ty = e.y;
            em.pulse = e.step;
          } else {
            this.emitters.set(e.emitterId, { x: e.x, y: e.y, tx: e.x, ty: e.y, pulse: e.step });
          }
          break;
        }
        case 'emitters': {
          const next = new Map<number, EmitterView>();
          for (const c of e.emitters) {
            const old = this.emitters.get(c.id);
            next.set(c.id, old
              ? { ...old, tx: c.x, ty: c.y }
              : { x: c.x, y: c.y, tx: c.x, ty: c.y, pulse: -Infinity });
          }
          this.emitters.clear();
          for (const [id, v] of next) this.emitters.set(id, v);
          break;
        }
        case 'section':
          this.sectionStep = e.step;
          break;
        case 'shapeAdded':
          this.addShape(e);
          break;
        case 'shapePose': {
          const s = this.shapes.get(e.group);
          if (s) {
            s.theta0 = e.theta0;
            s.rotStartStep = e.rotStartStep;
            s.omega = e.omega;
          }
          break;
        }
        case 'shapeRemoved': {
          const s = this.shapes.get(e.group);
          if (!s) break;
          this.shapes.delete(e.group);
          this.hoverAmt.delete(e.group);
          if (e.step !== removedStep) {
            this.stagger(removed);
            removed = [];
            removedStep = e.step;
          }
          const d: Dying = { shape: s, phi: shapeAngle(s, e.step), step: e.step, delay: 0, dur: DIE_SEC };
          removed.push(d);
          this.dying.set(s.group, d);
          break;
        }
      }
    }
    this.stagger(removed);
    if (n > 0) this.pending.splice(0, n);
  }

  /** 同じステップで複数の図形が消えた（clear / loadScene）ときは左から右へ拭うように消す */
  private stagger(group: Dying[]): void {
    if (group.length < 2) return;
    for (const d of group) {
      d.delay = WIPE_DELAY_SEC * Math.min(1, Math.max(0, d.shape.gx / WORLD_W));
      d.dur = WIPE_SEC;
    }
  }

  // ---- フレーム ----

  render(src: SnapshotSource, rs: number, dt: number, preview: Preview): void {
    this.consume(rs);
    this.lastRs = rs;
    const p = this.params;
    const geometryTrail = (p.trail ?? 'geometry') === 'geometry';

    // 盛り上がり: 最後の衝突から 2s を過ぎたらゆっくり 0 へ。表示は 1.5s で平滑化
    const since = (rs - this.energyStep) / HZ;
    const target = this.energyTarget * (since < 2 ? 1 : Math.exp(-(since - 2) / 2));
    this.energy += (target - this.energy) * (1 - Math.exp(-dt / 1.5));
    this.bloom.strength = p.bloomStrength * (1 + 0.2 * this.energy);
    const damp = geometryTrail ? p.afterimage : LEGACY_DAMP;
    this.afterimage.uniforms['damp']!.value = Math.pow(damp, dt * 60);

    const head = src.snapshot(Math.floor(rs));
    this.drawBalls(src, rs);
    if (geometryTrail) this.drawTrails(src, rs);
    else commit(this.trails, 0);
    this.drawShapes(rs, dt, preview);
    this.drawRipples(rs);
    this.drawGlints(rs);
    this.drawEmitters(rs, dt);
    this.gc(head);

    this.composer.render(dt);
  }

  // ---- ボールと尾 ----

  /** ステップ s 時点のボールの強度（衝突直後に明るく、指数で減衰） */
  private ballIntensity(look: BallLook | undefined, s: number): number {
    if (!look || s < look.step) return 0.55;
    const t = (s - look.step) / HZ;
    return 0.55 + (1.0 + 1.5 * look.v) * Math.exp(-t / 0.09);
  }

  private ballColor(look: BallLook | undefined): Color {
    return look ? noteColor(look.note, this.params.colorMode) : OFF_WHITE;
  }

  private drawBalls(src: SnapshotSource, rs: number): void {
    const s0 = Math.floor(rs);
    const a = rs - s0;
    const A = src.snapshot(s0);
    const B = src.snapshot(s0 + 1);
    const mesh = this.balls;
    const d = this.dummy;
    const c = this.color;
    let n = 0;
    if (A) {
      let j = 0;
      for (let i = 0; i < A.count; i++) {
        const id = A.ids[i]!;
        let x = A.xs[i]!;
        let y = A.ys[i]!;
        if (B) {
          while (j < B.count && B.ids[j]! < id) j++;
          if (j < B.count && B.ids[j] === id) {
            x += (B.xs[j]! - x) * a;
            y += (B.ys[j]! - y) * a;
          }
        }
        const look = this.ballLook.get(id);
        let scale = BALL_RADIUS;
        if (look && rs >= look.step) scale *= 1 + 0.35 * Math.exp(-(rs - look.step) / HZ / 0.06);
        d.position.set(x, -y, 0);
        d.rotation.set(0, 0, 0);
        d.scale.set(scale, scale, 1);
        d.updateMatrix();
        mesh.setMatrixAt(n, d.matrix);
        mesh.setColorAt(n, c.copy(this.ballColor(look)).multiplyScalar(this.ballIntensity(look, rs)));
        n++;
      }
    }
    commit(mesh, n);
  }

  /**
   * 尾: 直近のステップの位置を TRAIL_STRIDE おきに取り、クアッドでつなぐ（step2 案1）。
   * 連鎖 chain ≥ 3 のボールは尾を長く明るくし、最後の衝突から約 1s で元に戻す（D15）。
   */
  private drawTrails(src: SnapshotSource, rs: number): void {
    const s0 = Math.floor(rs);
    const a = rs - s0;
    const A = src.snapshot(s0);
    const B = src.snapshot(s0 + 1);
    const snaps = this.trailSnaps;
    const ptr = this.trailPtr;
    for (let q = 1; q <= TRAIL_QUADS_MAX; q++) {
      snaps[q] = src.snapshot(s0 - q * TRAIL_STRIDE);
      ptr[q] = 0;
    }
    const mesh = this.trails;
    const c = this.color;
    let n = 0;
    if (A) {
      let jb = 0;
      for (let i = 0; i < A.count; i++) {
        const id = A.ids[i]!;
        let px = A.xs[i]!;
        let py = A.ys[i]!;
        if (B) {
          while (jb < B.count && B.ids[jb]! < id) jb++;
          if (jb < B.count && B.ids[jb] === id) {
            px += (B.xs[jb]! - px) * a;
            py += (B.ys[jb]! - py) * a;
          }
        }
        const look = this.ballLook.get(id);
        const base = this.ballColor(look);
        let extra = 0;
        if (look && look.chain >= 3 && rs >= look.step) {
          extra = Math.min(look.chain - 2, CHAIN_EXTRA_MAX) * Math.exp(-(rs - look.step) / HZ / CHAIN_FADE_SEC);
        }
        const steps = TRAIL_STEPS + CHAIN_EXTRA_STEPS * extra;
        const quads = Math.min(TRAIL_QUADS_MAX, Math.ceil(steps / TRAIL_STRIDE));
        const gain = 0.6 * (1 + 0.25 * extra);
        const cap = TRAIL_CAP * (1 + 0.1 * extra);
        for (let q = 1; q <= quads; q++) {
          const S = snaps[q];
          if (!S) break;
          let j = ptr[q]!;
          while (j < S.count && S.ids[j]! < id) j++;
          ptr[q] = j;
          if (j >= S.count || S.ids[j] !== id) break; // この時点ではまだ生まれていない
          const qx = S.xs[j]!;
          const qy = S.ys[j]!;
          // ゆっくり動く・小刻みに跳ねるボールでは点が重なり、加算で白飛びする。短い区間は次の点とまとめる
          if (Math.abs(qx - px) + Math.abs(qy - py) < TRAIL_MIN_LEN) continue;
          const km = (q - 0.5) * TRAIL_STRIDE; // クアッド中点の「何ステップ前か」
          const f = Math.min(1, km / steps);
          // 尾のクアッドはボールや隣と重なって加算されるので、上限を設けてブルームの大きな滲みを防ぐ
          const intensity = Math.min(this.ballIntensity(look, s0 - km) * gain, cap) * Math.pow(1 - f, 1.5);
          const width = 2 * BALL_RADIUS * (0.8 - 0.6 * f);
          c.copy(base).multiplyScalar(intensity);
          this.putQuad(mesh, n++, px, py, qx, qy, width, c);
          px = qx;
          py = qy;
        }
      }
    }
    commit(mesh, n);
  }

  private putQuad(
    mesh: InstancedMesh, i: number, ax: number, ay: number, bx: number, by: number, width: number, c: Color,
  ): void {
    const d = this.dummy;
    d.position.set((ax + bx) / 2, -(ay + by) / 2, 0);
    d.rotation.set(0, 0, -Math.atan2(by - ay, bx - ax));
    d.scale.set(Math.hypot(bx - ax, by - ay), width, 1);
    d.updateMatrix();
    mesh.setMatrixAt(i, d.matrix);
    mesh.setColorAt(i, c);
  }

  // ---- 図形 ----

  /** 回転角 φ・縮尺 k での頂点（ワールド）を this.verts に書く */
  private pose(s: Shape, phi: number, k: number): Float32Array {
    const v = this.verts;
    const cs = Math.cos(phi) * k;
    const sn = Math.sin(phi) * k;
    for (let i = 0; i < s.n; i++) {
      const x = s.rel[i * 2]!;
      const y = s.rel[i * 2 + 1]!;
      v[i * 2] = s.gx + cs * x - sn * y;
      v[i * 2 + 1] = s.gy + sn * x + cs * y;
    }
    return v;
  }

  /** 辺を1本置く（弦のパラメータ付き） */
  private putEdge(
    ax: number, ay: number, bx: number, by: number, width: number, tint: Color,
    s0: number, len: number, sHit: number, vib: number, base: number, spot: number, sigma: number, closedP: number,
  ): void {
    const i = this.nEdge;
    if (i >= MAX_EDGE_INST) return;
    this.nEdge++;
    this.putQuad(this.edges, i, ax, ay, bx, by, width, tint);
    this.aA.setXYZW(i, s0, len, sHit, vib);
    this.aB.setXYZW(i, base, spot, sigma, closedP);
  }

  private putCap(x: number, y: number, r: number, c: Color): void {
    const i = this.nCap;
    if (i >= MAX_CAPS) return;
    this.nCap++;
    const d = this.dummy;
    d.position.set(x, -y, 0);
    d.rotation.set(0, 0, 0);
    d.scale.set(r, r, 1);
    d.updateMatrix();
    this.caps.setMatrixAt(i, d.matrix);
    this.caps.setColorAt(i, c);
  }

  /**
   * 頂点列 v（n 点）を辺として描く。バンパーは二重線。開いた図形は両端に丸キャップ。
   * 打点の光（spot, sigma, sHit）は周に沿って測る（閉じた図形は周回する）。
   */
  private drawOutline(
    v: Float32Array, n: number, closed: boolean, bumper: boolean,
    tint: Color, width: number, base: number, spot: number, sigma: number, sHit: number, vib: number,
  ): void {
    const ne = closed ? n : n - 1;
    let perim = 0;
    if (closed) {
      for (let i = 0; i < ne; i++) {
        const j = (i + 1) % n;
        perim += Math.hypot(v[j * 2]! - v[i * 2]!, v[j * 2 + 1]! - v[i * 2 + 1]!);
      }
    }
    let acc = 0;
    for (let i = 0; i < ne; i++) {
      const j = (i + 1) % n;
      const ax = v[i * 2]!, ay = v[i * 2 + 1]!, bx = v[j * 2]!, by = v[j * 2 + 1]!;
      const len = Math.hypot(bx - ax, by - ay);
      const start = acc;
      acc += len;
      if (bumper) {
        const nx = len > 0 ? -(by - ay) / len : 0;
        const ny = len > 0 ? (bx - ax) / len : 0;
        const w = BUMPER_WIDTH + (width - LINE_WIDTH) / 2;
        this.putEdge(ax - nx * BUMPER_OFFSET, ay - ny * BUMPER_OFFSET, bx - nx * BUMPER_OFFSET, by - ny * BUMPER_OFFSET,
          w, tint, start, len, sHit, vib, base, spot, sigma, perim);
        this.putEdge(ax + nx * BUMPER_OFFSET, ay + ny * BUMPER_OFFSET, bx + nx * BUMPER_OFFSET, by + ny * BUMPER_OFFSET,
          w, tint, start, len, sHit, vib, base, spot, sigma, perim);
      } else {
        this.putEdge(ax, ay, bx, by, width, tint, start, len, sHit, vib, base, spot, sigma, perim);
      }
    }
    if (!closed && n >= 2) {
      const r = bumper ? BUMPER_OFFSET + BUMPER_WIDTH / 2 : width / 2;
      const sg = Math.max(sigma, 1);
      const c = this.color;
      c.copy(tint).multiplyScalar(base + spot * Math.exp(-Math.abs(sHit) / sg));
      this.putCap(v[0]!, v[1]!, r, c);
      c.copy(tint).multiplyScalar(base + spot * Math.exp(-Math.abs(acc - sHit) / sg));
      this.putCap(v[(n - 1) * 2]!, v[(n - 1) * 2 + 1]!, r, c);
    }
  }

  private updateHover(dt: number, preview: Preview): void {
    const h = preview.hover;
    const target = !preview.active && h.active ? this.pickShape(h.x, h.y) : -1;
    const k = 1 - Math.exp(-dt / HOVER_TAU);
    if (target >= 0 && !this.hoverAmt.has(target)) this.hoverAmt.set(target, 0);
    for (const [id, v] of this.hoverAmt) {
      const nv = v + ((id === target ? 1 : 0) - v) * k;
      if (id !== target && nv < 0.01) this.hoverAmt.delete(id);
      else this.hoverAmt.set(id, nv);
    }
  }

  private drawShapes(rs: number, dt: number, preview: Preview): void {
    this.updateHover(dt, preview);
    this.nEdge = 0;
    this.nCap = 0;
    const mode = this.params.colorMode;
    const idle = this.params.idleLine;
    const tint = this.tint;

    for (const s of this.shapes.values()) {
      let base = idle;
      let spot = 0;
      let sigma = 1;
      let sHit = 0;
      let vib = 0;
      let white = 0;
      let k = 1;
      let echo = 0;
      let echoK = 1;
      const h = s.hit;
      if (h) {
        const t = Math.max(0, (rs - h.step) / HZ);
        if (t > 3 * h.tau && t > 1.2) {
          s.hit = null;
        } else if (s.form === 'circle') {
          // キック: 図形全体が脈打つ（速い立ち上がり → h.tau で減衰）。打点の光・揺れはなし
          const env = (1 - Math.exp(-t / KICK_ATTACK)) * Math.exp(-t / h.tau);
          base += (KICK_GAIN + KICK_GAIN_V * h.v) * env;
          k = 1 + KICK_SCALE * (0.5 + h.v) * env;
          white = 0.15 * env;
        } else if (s.form === 'triangle') {
          // 金属: 短い閃き + 打点の細い光がゆっくり滲む + 長く淡い余韻（きらめきの粒は drawGlints）
          base += (0.3 + 0.4 * h.v) * Math.exp(-t / 0.08) + METAL_GLOW * h.v * Math.exp(-t / h.tau);
          spot = (0.5 + 0.9 * h.v) * Math.exp(-t / 0.3);
          sigma = Math.min(4 + 60 * t, s.perimeter);
          sHit = h.s;
          white = 0.3 * Math.exp(-t / 0.05);
        } else if (s.form === 'square') {
          // 木: 短く鋭い閃光、余韻ほぼなし。外側に細い輪郭が一瞬弾ける
          base += (0.6 + 0.8 * h.v) * Math.exp(-t / WOOD_FLASH);
          spot = (0.8 + 1.2 * h.v) * Math.exp(-t / 0.05);
          sigma = 14;
          sHit = h.s;
          white = 0.4 * Math.exp(-t / 0.035);
          if (t < WOOD_ECHO_SEC) {
            const q = t / WOOD_ECHO_SEC;
            echo = 0.6 * h.v * (1 - q) ** 2;
            echoK = 1 + WOOD_ECHO_GROW * easeOutCubic(q);
          }
        } else {
          // 線全体の短いフラッシュ + 低音ほど長く残る余韻
          base += (0.4 + 0.6 * h.v) * Math.exp(-t / 0.18) + 0.2 * h.v * Math.exp(-t / h.tau);
          // 打点の光: 周に沿って σ = 6 + 500t で広がる
          spot = (1.0 + 1.6 * h.v) * Math.exp(-t / (0.35 * h.tau));
          sigma = Math.min(6 + 500 * t, s.perimeter);
          sHit = h.s;
          // 弦の揺れ: 低音ほどゆっくり（12Hz → 6Hz）、余韻とともに減衰
          const f = 12 - 0.4 * s.note;
          const amp = (s.kind === 'bumper' ? 3.2 : 2.5) * h.v;
          vib = amp * Math.exp(-t / (0.5 * h.tau)) * Math.sin(2 * Math.PI * f * t);
          white = 0.25 * Math.exp(-t / 0.06);
        }
      }
      // 共鳴: 衝突の光よりはっきり弱く（最大 +0.22）
      if (rs >= s.resStep) base += 0.15 * (0.5 + s.resV) * Math.exp(-(rs - s.resStep) / HZ / 0.3);
      // 連鎖の光らせ直し
      if (rs >= s.replayAt) {
        const t = (rs - s.replayAt) / HZ;
        base += 0.9 * Math.exp(-t / 0.15);
        white = Math.max(white, 0.3 * Math.exp(-t / 0.08));
      }
      const hv = this.hoverAmt.get(s.group) ?? 0;
      base = Math.max(base, 0.3 + 0.3 * hv);
      tint.copy(noteColor(s.note, mode)).lerp(OFF_WHITE, white);
      const phi = shapeAngle(s, rs);
      const v = this.pose(s, phi, k);
      this.drawOutline(v, s.n, s.closed, s.kind === 'bumper', tint, LINE_WIDTH + 1.5 * hv,
        base, spot, sigma, sHit, vib);
      if (echo > 0.01) {
        const ve = this.pose(s, phi, echoK);
        this.drawOutline(ve, s.n, s.closed, false, tint, 1, echo, 0, 1, 0, 0);
      }
    }

    // 消えかけの図形: 遅延のあいだは待機の明るさ、その後 0.8·(1−p)² で消しながら重心へ 10% 縮める
    for (const [id, d] of this.dying) {
      const p = ((rs - d.step) / HZ - d.delay) / d.dur;
      if (p >= 1) {
        this.dying.delete(id);
        continue;
      }
      const q = Math.max(0, p);
      const base = p < 0 ? idle : 0.8 * (1 - q) ** 2;
      const s = d.shape;
      const v = this.pose(s, d.phi, 1 - 0.1 * easeOutCubic(q));
      tint.copy(noteColor(s.note, mode));
      this.drawOutline(v, s.n, s.closed, s.kind === 'bumper', tint, LINE_WIDTH, base, 0, 1, 0, 0);
    }

    this.drawPreview(preview);

    commit(this.edges, this.nEdge, [this.aA, this.aB]);
    commit(this.caps, this.nCap);
  }

  private drawPreview(preview: Preview): void {
    const pts = preview.points;
    const n = Math.min(pts.length / 2, MAX_VERTS) | 0;
    if (!preview.active || n < 2) {
      this.previewNote = -1;
      return;
    }
    const tint = this.tint;
    const now = performance.now() / 1000;
    let base = 1;
    if (preview.perimeter < MIN_LINE_LEN) {
      tint.copy(GRAY);
      this.previewNote = -1;
    } else {
      const note = lengthToNote(preview.perimeter).index;
      if (note !== this.previewNote) {
        if (this.previewNote >= 0) this.previewFlashAt = now;
        this.previewNote = note;
      }
      base = 0.35 + 0.15 * Math.sin(2 * Math.PI * 2 * now) + 0.8 * Math.exp(-(now - this.previewFlashAt) / 0.08);
      tint.copy(noteColor(note, this.params.colorMode));
    }
    const v = this.verts;
    for (let i = 0; i < n * 2; i++) v[i] = pts[i]!;
    this.drawOutline(v, n, preview.closed, preview.bumper, tint, LINE_WIDTH, base, 0, 1, 0, 0);
  }

  // ---- 波紋・放出口 ----

  private drawRipples(rs: number): void {
    const d = this.dummy;
    const c = this.color;
    let n = 0;
    for (const r of this.rippleBuf) {
      const p = (rs - r.step) / HZ / r.dur;
      if (p < 0 || p >= 1) continue;
      const radius = r.r0 + r.grow * easeOutCubic(p);
      d.position.set(r.x, -r.y, 0);
      d.rotation.set(0, 0, 0);
      d.scale.set(radius, radius, 1);
      d.updateMatrix();
      this.ripples.setMatrixAt(n, d.matrix);
      this.ripples.setColorAt(n, c.copy(noteColor(r.note, this.params.colorMode)).multiplyScalar(r.gain * (1 - p) ** 2));
      n++;
    }
    commit(this.ripples, n);
  }

  /** triangle のきらめき: 辺の上の小さな点が瞬きながら長く残る */
  private drawGlints(rs: number): void {
    const d = this.dummy;
    const c = this.color;
    const mode = this.params.colorMode;
    const pt = this.pt;
    let n = 0;
    for (let i = 0; i < MAX_GLINTS; i++) {
      const t = (rs - this.gStep[i]!) / HZ - this.gDelay[i]!;
      if (!(t >= 0)) continue;
      const tau = this.gTau[i]!;
      const s = this.shapes.get(this.gGroup[i]!);
      if (!s || t > 3 * tau) {
        this.gStep[i] = Infinity;
        continue;
      }
      let tw = 0.5 + 0.5 * Math.sin(2 * Math.PI * this.gFreq[i]! * t + this.gPhase[i]!);
      tw *= tw;
      tw *= tw;
      const env = (1 - Math.exp(-t / 0.02)) * Math.exp(-t / tau);
      const intensity = this.gGain[i]! * env * (0.2 + 0.8 * tw);
      if (intensity < 0.01) continue;
      this.pointAt(s, shapeAngle(s, rs), this.gArc[i]!);
      const off = this.gOff[i]!;
      const r = this.gSize[i]! * (0.7 + 0.3 * tw);
      d.position.set(pt.x + pt.nx * off, -(pt.y + pt.ny * off), 0);
      d.rotation.set(0, 0, 0);
      d.scale.set(r, r, 1);
      d.updateMatrix();
      this.glints.setMatrixAt(n, d.matrix);
      this.glints.setColorAt(n, c.copy(noteColor(s.note, mode)).lerp(OFF_WHITE, 0.6).multiplyScalar(intensity));
      n++;
    }
    commit(this.glints, n);
  }

  /**
   * 放出口は emitters / emit イベントの位置から描く（B4）。
   * 常に 4s 周期でゆっくり呼吸し、区間（section）が変わると 1〜2s かけて大きく膨らむ（D11 パッドの光）。
   */
  private drawEmitters(rs: number, dt: number): void {
    const d = this.dummy;
    const c = this.color;
    const k = 1 - Math.exp(-dt / EMITTER_TAU);
    const sec = Math.max(0, rs / HZ);
    const breath = 0.5 - 0.5 * Math.cos((2 * Math.PI * sec) / 4);
    const ts = (rs - this.sectionStep) / HZ;
    const swell = ts >= 0 ? (1 - Math.exp(-ts / 0.25)) * Math.exp(-ts / 1.2) : 0;
    let n = 0;
    for (const em of this.emitters.values()) {
      if (n >= MAX_EMITTERS) break;
      em.x += (em.tx - em.x) * k;
      em.y += (em.ty - em.y) * k;
      const t = Math.max(0, (rs - em.pulse) / HZ);
      const r = 8 * (1 + 0.08 * breath + 0.5 * swell);
      d.position.set(em.x, -em.y, 0);
      d.rotation.set(0, 0, 0);
      d.scale.set(r, r, 1);
      d.updateMatrix();
      this.emitterMesh.setMatrixAt(n, d.matrix);
      const intensity = 0.3 + 0.1 * breath + 0.6 * swell + 1.0 * Math.exp(-t / 0.12);
      this.emitterMesh.setColorAt(n, c.copy(OFF_WHITE).multiplyScalar(intensity));
      n++;
    }
    commit(this.emitterMesh, n);
  }

  /** 画面から消えたボールの見た目情報を掃除する */
  private gc(A: Snapshot | undefined): void {
    if (!A || this.ballLook.size + this.ballPath.size <= 2 * A.count + 64) return;
    const alive = new Set(A.ids.subarray(0, A.count));
    for (const id of this.ballLook.keys()) if (!alive.has(id)) this.ballLook.delete(id);
    for (const id of this.ballPath.keys()) if (!alive.has(id)) this.ballPath.delete(id);
  }
}
