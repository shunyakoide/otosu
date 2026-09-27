import {
  AdditiveBlending, CircleGeometry, CustomBlending, MaxEquation, OneFactor, Color, HalfFloatType, InstancedBufferAttribute, InstancedMesh,
  MeshBasicMaterial, NeutralToneMapping, Object3D, OrthographicCamera, PlaneGeometry, RingGeometry,
  Scene, Vector2, WebGLRenderTarget, WebGLRenderer, DynamicDrawUsage, type BufferGeometry,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { closestOnSegment } from '../sim/collide';
import { BALL_RADIUS, HZ, LINE_WIDTH, MAX_BALLS, MIN_LINE_LEN, WORLD_H, WORLD_W, type Bounds } from '../sim/constants';
import { chordSlots, lengthToNote, riseSlot } from '../sim/music';
import type { SegKind, ShapeAddedEvent, ShapeEffect, ShapeForm, SimEvent, Snapshot } from '../sim/types';
import { FLOWER_HOLD_SEC, Flowers } from './flowers';
import { FlowPass } from './flow';
import { GRAY, noteColor, OFF_WHITE, type ColorMode } from './palette';
import { QualityGovernor, type QualityLevel } from './quality';

// 描画は「renderStep 時点の世界」を表示する（decisions.md D3, D8-5）。
// sim は LOOKAHEAD ぶん先行しているので、イベントは renderStep に達してから反映する。
// sim の Segment / Emitter は参照せず、イベントから図形（group）単位の自分用コピーを持つ（D9, D14）。

export type TrailMode = 'geometry' | 'afterimage';

export type RenderParams = {
  colorMode: ColorMode;
  bloomStrength: number;
  afterimage: number;
  /** 残像のエフェクト（D31）: 当たった図形から光が垂れる（drip）のオン・オフと、垂れる速さ（px/s） */
  drip?: boolean;
  dripSpeed?: number;
  idleLine: number;
  /** 'geometry' = 履歴から尾を描く（ステップ2）/ 'afterimage' = ステップ1の見た目（尾なし・damp 0.88） */
  trail?: TrailMode;
  /** 衝突で花が咲く（D25） */
  flowers?: boolean;
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

// スマホ・タブレット（D26）: 画面が小さいとワールド全体が遠く小さく見えるので、寄って表示し、線やボールを太く描く
/** 寄ったあとの縮尺（CSS px / ワールド px）の目安と、寄る倍率の上限 */
const TOUCH_SCALE = 0.5;
const TOUCH_ZOOM_MAX = 2.2;
/** 線・ボール・蔦を太く描く倍率（見た目だけ。当たり判定は変えない） */
const TOUCH_THICK = 1.6;
/** 指で図形を選ぶ半径（CSS px） */
const TOUCH_PICK_PX = 22;

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

// 蔦と花（D25）: 衝突した点から図形に沿って蔦が伸び、通ったところに花が順に咲く
const MAX_VINES = 96;
const MAX_VINE_QUADS = 12288;
/** 伸びる速さ（px/s）と、片側に伸びる長さ = VINE_REACH + VINE_REACH_V · 衝突の強さ */
const VINE_SPEED = 220;
const VINE_REACH = 90;
const VINE_REACH_V = 320;
/** 同じ図形で次の蔦を伸ばすまでの最短間隔（秒） */
const VINE_GAP_SEC = 0.4;
/** まだ茎に付いている花や葉からこの距離（px、周に沿って）以内には、新しく咲かせない（重なって濁らないように） */
const VINE_CROWD_FLOWER = 32;
const VINE_CROWD_LEAF = 14;
/** 図形の線をまたいで巻きつく揺れ（px）と波長（px） */
const VINE_AMP = 5;
const VINE_WAVE = 70;
/** 蔦を描く刻み（px）と太さ（px） */
const VINE_STEP = 5;
const VINE_WIDTH = 1.4;
const VINE_GAIN = 0.32;
/** 花の間隔（px）: VINE_FLOWER_GAP × (0.8..1.3) */
const VINE_FLOWER_GAP = 70;
/** 花の半径（px）と明るさ: 基準 + 衝突の強さに比例 */
const VINE_FLOWER_R = 46;
const VINE_FLOWER_R_V = 30;
const VINE_FLOWER_GAIN = 0.2;
const VINE_FLOWER_GAIN_V = 0.12;
/** 当たった所に咲く花の大きさ（倍） */
const VINE_FLOWER_HIT_SCALE = 1.6;
/** 茎の長さ（花の大きさに対して）。花は蔦からこの分だけ外へ離れて咲き、付け根の2枚の葉がその間をつなぐ（茎の線は描かない） */
const VINE_STEM = 0.7;
/** 葉: 間隔（px）、長さ（花の大きさに対して）、明るさ、伸びる向きの蔦からの傾き（ラジアン） */
const LEAF_GAP = 34;
const LEAF_LEN = 0.95;
const LEAF_GAIN = 0.32;
const LEAF_ANGLE = 0.75;
const VINE_COLOR = new Color(0x6fcf7a);

/**
 * エフェクトの輪郭（D32）。エフェクトの付いた図形は、まわりに淡い輪郭を何重かまとい、種類ごとに見分けられるよう動きと色を変える。
 * echo: 同心の輪が外へ広がりながら消えていく（波紋）。rise: 同じ形が上へ昇りながら消えていく（色は上がっていく音の色）。
 * chord: 動かない点線の輪郭を重ねる（色は重ねる音の色。mono でも点線で分かる）。
 * 開いた図形（線・ペン）では echo と chord は両側に、rise は上側だけに出す（上へずれるだけの rise と見分けられるように）
 */
const FX_ECHO_RINGS = 3;
const FX_ECHO_GAP = 11;
const FX_ECHO_SEC = 2.4;
const FX_RISE_COPIES = 3;
const FX_RISE_GAP = 9;
const FX_RISE_SEC = 1.8;
const FX_CHORD_GAP = 6;
/** chord の点線: 点の長さ・間隔（px）。mono でも echo・rise と見分けられるように */
const FX_DOT = 2.5;
const FX_DOT_GAP = 5;
/** 輪郭の明るさ（待機の線に対する割合）と太さ（px） */
const FX_GAIN = 1.6;
const FX_WIDTH = 1.5;
/** 当たるたびに輪郭が外へ広がる: 距離・秒・明るさ */
const FX_WAVE_REACH = 44;
const FX_WAVE_SEC = 0.9;
const FX_WAVE_GAIN = 0.9;
const MAX_FX_WAVES = 64;

/** at = 咲き始めるステップ（落ち始めたら図形に付いて動かすのをやめる） */
type VineFlower = { handle: number; arc: number; off: number; at: number };
/** 図形の周上で、花や葉が咲いている場所と期間（ステップ） */
type Bloomed = { arc: number; from: number; until: number; leaf: boolean };

type Vine = {
  group: number; step: number; phi0: number; arc0: number; reach: number; seed: number; note: number;
  /** 蔦が消え始めるまでの秒数 */
  life: number;
  flowers: VineFlower[];
};

type BallLook = { note: number; step: number; v: number; chain: number };
/** 波紋: 半径 r0 から grow だけ dur 秒で広がる。明るさ gain·(1−p)² */
type Ripple = { x: number; y: number; step: number; note: number; r0: number; grow: number; dur: number; gain: number };
type Hit = { step: number; v: number; s: number; tau: number };
type Shape = {
  group: number;
  kind: SegKind;
  form: ShapeForm;
  effect: ShapeEffect;
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
type FxWave = { group: number; step: number; v: number };
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

/** 描く数を決め、書いた先頭 n 個だけを GPU に送る（上限まで丸ごと送ると毎フレーム MB 単位になる） */
function commit(mesh: InstancedMesh, n: number, extra: InstancedBufferAttribute[] = []): void {
  mesh.count = n;
  if (n === 0) return;
  for (const a of [mesh.instanceMatrix, mesh.instanceColor!, ...extra]) {
    a.clearUpdateRanges();
    a.addUpdateRange(0, n * a.itemSize);
    a.needsUpdate = true;
  }
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

/** 画面上端のツールバー用の帯（CSS px）の既定値。狭い画面でツールバーが折り返すと setTopBand で広げる */
export const TOP_BAND_PX = 52;

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private topBand = TOP_BAND_PX;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(0, WORLD_W, 0, -WORLD_H, -10, 10);
  private readonly composer: EffectComposer;
  private readonly afterimage = new FlowPass();
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
  private readonly flowers = new Flowers(1);
  private readonly vineQuads = instanced(new PlaneGeometry(1, 1), MAX_VINE_QUADS, 1);
  private readonly vines: Vine[] = [];
  private readonly vineAt = new Map<number, number>();
  private readonly bloomed = new Map<number, Bloomed[]>();

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
  private readonly fxWaves: FxWave[] = [];
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
  /** 線・ボールを太く描く倍率と、図形を選ぶ半径（ワールド px） */
  private thick = 1;
  private pickR = PICK_RADIUS;
  private offsetX = 0;
  private offsetY = 0;
  private view: Bounds = { minX: 0, maxX: WORLD_W, maxY: WORLD_H };

  private readonly params: RenderParams;
  /** 設定の解像度（キャンバス）と、重いときに下げる後処理の画質（D27） */
  private pixelRatio = 1;
  private readonly governor = new QualityGovernor();

  constructor(parent: HTMLElement, params: RenderParams) {
    this.params = params;
    this.renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false });
    this.renderer.setPixelRatio(this.pixelRatio);
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
    this.composer.addPass(this.afterimage);
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), params.bloomStrength, 0.35, 0.8);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.scene.add(this.vineQuads, this.flowers.mesh, this.ripples, this.emitterMesh, this.trails, this.edges, this.caps, this.glints, this.balls);
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  /** ツールバーの帯の高さ（CSS px）。変わったときだけ作り直す */
  setTopBand(px: number): void {
    if (px === this.topBand) return;
    this.topBand = px;
    this.resize();
  }

  setPixelRatio(r: number): void {
    if (r === this.pixelRatio) return;
    this.pixelRatio = r;
    this.renderer.setPixelRatio(r);
    this.resize();
    // 後処理も同じ解像度で描く（EffectComposer は作ったときの値を持ち続ける）。画質は測り直す
    this.applyQuality(this.governor.reset());
  }

  /** 今の画質の段階（0 が最高） */
  get qualityLevel(): number {
    return this.governor.level;
  }

  private applyQuality(q: QualityLevel): void {
    for (const t of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (t.samples === q.samples) continue;
      t.samples = q.samples;
      t.dispose(); // 次に使うときに作り直される
    }
    this.composer.setPixelRatio(this.pixelRatio * q.scale);
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
  pickShape(x: number, y: number, radius = this.pickR): number {
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
    const band = this.topBand;
    const fit = Math.min(w / WORLD_W, (h - band) / WORLD_H);
    const touch = matchMedia('(hover: none)').matches;
    // タッチでは寄る（ワールドの上端・左右中央は保つ。はみ出た分は見えない = ボールも消える範囲）
    const s = touch ? fit * Math.min(TOUCH_ZOOM_MAX, Math.max(1, TOUCH_SCALE / fit)) : fit;
    this.scale = s;
    this.thick = touch ? TOUCH_THICK : 1;
    this.pickR = touch ? Math.max(PICK_RADIUS, TOUCH_PICK_PX / s) : PICK_RADIUS;
    // 16:9 のワールドは左右中央・上寄せ。余りはウィンドウ全体を使う（縦長なら下、横長なら左右。D23）
    this.offsetX = (w - WORLD_W * s) / 2;
    this.offsetY = band;
    const viewW = w / s;
    const viewH = (h - band) / s;
    this.camera.left = -(viewW - WORLD_W) / 2;
    this.camera.right = this.camera.left + viewW;
    this.camera.top = band / s;
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
      group: e.group, kind: e.segKind, form: e.form, effect: e.effect, note: e.note, closed: e.closed, radius, gx: e.gx, gy: e.gy,
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
    // chord で重ねた音は光らせない（本体の音が光る）
    if (e.voice > 0) return;
    const s = this.shapes.get(e.group);
    if (s && s.effect !== 'none') {
      if (this.fxWaves.length >= MAX_FX_WAVES) this.fxWaves.shift();
      this.fxWaves.push({ group: s.group, step: e.step, v: e.velocity });
    }
    // くり返し（echo / rise）: 図形が弱く光り、輪郭が広がるだけ（花・波紋・ボール・連鎖には数えない）
    if (e.echo > 0) {
      if (s) this.trigger(s, e.step, e.velocity, e.form === 'circle' ? 0 : this.arcPos(s, e.step, e.x, e.y));
      return;
    }
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

    if (s && (this.params.flowers ?? true) && e.segKind !== 'bumper' && e.velocity >= 0.1) this.growVine(s, e.step, e.x, e.y, e.velocity);

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
        case 'shapeEffect': {
          const s = this.shapes.get(e.group);
          if (s) s.effect = e.effect;
          break;
        }
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
          const s = this.dropShape(e.group);
          if (!s) break;
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

  /** 図形を描く対象から外す（消える動きは呼んだ側で決める） */
  private dropShape(group: number): Shape | undefined {
    const s = this.shapes.get(group);
    if (!s) return undefined;
    this.shapes.delete(group);
    this.hoverAmt.delete(group);
    this.flowers.forget(group);
    this.vineAt.delete(group);
    this.bloomed.delete(group);
    return s;
  }

  /**
   * 止めている間の編集（D30）: 図形の追加・削除・向きは renderStep を待たずにすぐ反映する。
   * 描画の時刻が止まっているので、消す図形は消える動きなしで消す
   */
  applyEditsNow(): void {
    const rest: SimEvent[] = [];
    for (const e of this.pending) {
      if (e.kind === 'shapeAdded') this.addShape(e);
      else if (e.kind === 'shapeRemoved') this.dropShape(e.group);
      else if (e.kind === 'shapeEffect') {
        const s = this.shapes.get(e.group);
        if (s) s.effect = e.effect;
      }
      else if (e.kind === 'shapePose') {
        const s = this.shapes.get(e.group);
        if (s) {
          s.theta0 = e.theta0;
          s.rotStartStep = e.rotStartStep;
          s.omega = e.omega;
        }
      } else rest.push(e);
    }
    this.pending = rest;
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
    // 流れ落ちる残像（D31）: 流すときは残像を長めに残す
    this.afterimage.set(dt, {
      drip: p.drip ?? false,
      dripSpeed: p.dripSpeed ?? 90,
      damp: geometryTrail ? p.afterimage : LEGACY_DAMP,
    }, innerWidth, innerHeight);

    const head = src.snapshot(Math.floor(rs));
    this.drawBalls(src, rs);
    if (geometryTrail) this.drawTrails(src, rs);
    else commit(this.trails, 0);
    this.drawShapes(rs, dt, preview);
    this.drawRipples(rs);
    if (p.flowers ?? true) {
      this.drawVines(rs);
      this.flowers.draw(rs);
    } else {
      this.vines.length = 0;
      commit(this.vineQuads, 0);
      this.flowers.clear();
    }
    this.drawGlints(rs);
    this.drawEmitters(rs, dt);
    this.gc(head);

    this.composer.render(dt);
    const q = this.governor.update(dt);
    if (q) this.applyQuality(q);
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
        let scale = BALL_RADIUS * this.thick;
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
          const width = 2 * BALL_RADIUS * this.thick * (0.8 - 0.6 * f);
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
    // 行列を直接書く（Object3D を通すと四元数を経由して遅い）。x 軸を a→b（y は反転）、y 軸を幅に
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    const ux = len > 0 ? dx / len : 1, uy = len > 0 ? dy / len : 0;
    const m = mesh.instanceMatrix.array as Float32Array;
    const o = i * 16;
    m[o] = dx; m[o + 1] = -dy; m[o + 2] = 0; m[o + 3] = 0;
    m[o + 4] = uy * width; m[o + 5] = ux * width; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = 1; m[o + 11] = 0;
    m[o + 12] = (ax + bx) / 2; m[o + 13] = -(ay + by) / 2; m[o + 14] = 0; m[o + 15] = 1;
    const col = mesh.instanceColor!.array as Float32Array;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
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

  /** エフェクトの付いた図形がいつもまとう輪郭（D32）。a = 一番明るい輪郭の明るさ */
  private drawFxRings(s: Shape, phi: number, rs: number, a: number, mode: ColorMode, tint: Color): void {
    const t = rs / HZ;
    if (s.effect === 'echo') {
      // 等間隔の輪が外へ流れ、外ほど暗く、端で消える
      tint.copy(noteColor(s.note, mode));
      const p = (t / FX_ECHO_SEC) % 1;
      for (let i = 0; i < FX_ECHO_RINGS; i++) {
        const u = (i + p) / FX_ECHO_RINGS;
        const fade = Math.min(1, u * 4) * (1 - u) ** 1.5;
        this.drawFxSides(s, phi, 4 + u * FX_ECHO_RINGS * FX_ECHO_GAP, tint, a * fade);
      }
    } else if (s.effect === 'rise') {
      // 同じ形が上へ昇り、上ほど暗く、上がっていく音の色になる
      const p = (t / FX_RISE_SEC) % 1;
      for (let i = 0; i < FX_RISE_COPIES; i++) {
        const u = (i + p) / FX_RISE_COPIES;
        const n = riseSlot(s.form, s.note, i + 1);
        tint.copy(noteColor(n < 0 ? s.note : n, mode));
        const fade = Math.min(1, u * 4) * (1 - u) ** 1.5;
        this.drawOutline(this.contour(s, phi, 0, 4 + u * FX_RISE_COPIES * FX_RISE_GAP), s.n, s.closed, false, tint, FX_WIDTH, a * fade, 0, 1, 0, 0);
      }
    } else if (s.effect === 'chord') {
      // 重ねる音の色の細い輪郭が、ぴったり寄り添って動かない
      chordSlots(s.form, s.note).forEach((n, i) => {
        tint.copy(noteColor(n, mode));
        this.drawFxSides(s, phi, FX_CHORD_GAP * (i + 1), tint, a * (i === 0 ? 1.3 : 1), true);
      });
    }
  }

  /** 外へ d px の輪郭（dotted なら点線）。開いた図形は両側に */
  private drawFxSides(s: Shape, phi: number, d: number, tint: Color, a: number, dotted = false): void {
    const draw = (v: Float32Array) => dotted
      ? this.drawDotted(v, s.n, s.closed, tint, a)
      : this.drawOutline(v, s.n, s.closed, false, tint, FX_WIDTH, a, 0, 1, 0, 0);
    draw(this.contour(s, phi, d, 0));
    if (!s.closed) draw(this.contour(s, phi, -d, 0));
  }

  /** 点線の輪郭。周に沿って FX_DOT の点を FX_DOT_GAP おきに置く */
  private drawDotted(v: Float32Array, n: number, closed: boolean, tint: Color, a: number): void {
    const k = this.thick;
    const ne = closed ? n : n - 1;
    const period = FX_DOT + FX_DOT_GAP;
    let acc = 0;
    for (let i = 0; i < ne; i++) {
      const j = (i + 1) % n;
      const ax = v[i * 2]!, ay = v[i * 2 + 1]!;
      const dx = v[j * 2]! - ax, dy = v[j * 2 + 1]! - ay;
      const len = Math.hypot(dx, dy);
      if (len <= 0) continue;
      // この辺の中で、次の点が始まる位置から置いていく（辺をまたいでも間隔がそろうように）
      for (let t = (period - (acc % period)) % period; t < len; t += period) {
        const t1 = Math.min(len, t + FX_DOT);
        this.putEdge(ax + dx * t / len, ay + dy * t / len, ax + dx * t1 / len, ay + dy * t1 / len, 2 * k, tint,
          0, 1, 0, 0, a, 0, 1, 0);
      }
      acc += len;
    }
  }

  /**
   * 図形を外へ d px 広げ、上へ lift px ずらした輪郭（D32）。閉じた図形は重心から拡大、
   * 開いた図形（線・ペン）は両端を結ぶ向きに垂直な、上側へ平行にずらす
   */
  private contour(s: Shape, phi: number, d: number, lift: number): Float32Array {
    const v = this.pose(s, phi, s.closed ? 1 + d / Math.max(s.radius, 8) : 1);
    let ox = 0;
    let oy = -lift;
    if (!s.closed && s.n >= 2) {
      const ex = v[(s.n - 1) * 2]! - v[0]!;
      const ey = v[(s.n - 1) * 2 + 1]! - v[1]!;
      const l = Math.hypot(ex, ey) || 1;
      let nx = -ey / l;
      let ny = ex / l;
      if (ny > 0) {
        nx = -nx;
        ny = -ny;
      }
      ox += nx * d;
      oy += ny * d;
    }
    if (ox !== 0 || oy !== 0) {
      for (let i = 0; i < s.n; i++) {
        v[i * 2] += ox;
        v[i * 2 + 1] += oy;
      }
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
    const k = this.thick;
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
        const w = (BUMPER_WIDTH + (width - LINE_WIDTH) / 2) * k;
        const o = BUMPER_OFFSET * k;
        this.putEdge(ax - nx * o, ay - ny * o, bx - nx * o, by - ny * o, w, tint, start, len, sHit, vib, base, spot, sigma, perim);
        this.putEdge(ax + nx * o, ay + ny * o, bx + nx * o, by + ny * o, w, tint, start, len, sHit, vib, base, spot, sigma, perim);
      } else {
        this.putEdge(ax, ay, bx, by, width * k, tint, start, len, sHit, vib, base, spot, sigma, perim);
      }
    }
    if (!closed && n >= 2) {
      const r = (bumper ? BUMPER_OFFSET + BUMPER_WIDTH / 2 : width / 2) * k;
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
      if (s.effect !== 'none') this.drawFxRings(s, phi, rs, idle * FX_GAIN, mode, tint);
    }

    // 当たるたびに外へ広がる輪郭（D32）。rise は上へ昇り、chord は重ねる音の色で広がる
    let w = 0;
    for (const f of this.fxWaves) {
      const q = (rs - f.step) / HZ / FX_WAVE_SEC;
      const s = this.shapes.get(f.group);
      if (q >= 1 || !s) continue;
      this.fxWaves[w++] = f;
      if (q < 0 || s.effect === 'none') continue;
      const e = easeOutCubic(q);
      const a = FX_WAVE_GAIN * (0.3 + f.v) * (1 - q) ** 2;
      const phi = shapeAngle(s, rs);
      if (s.effect === 'rise') {
        tint.copy(noteColor(Math.max(riseSlot(s.form, s.note, 1), s.note), mode));
        this.drawOutline(this.contour(s, phi, 0, FX_WAVE_REACH * e), s.n, s.closed, false, tint, FX_WIDTH, a, 0, 1, 0, 0);
      } else if (s.effect === 'chord') {
        chordSlots(s.form, s.note).forEach((n, i) => {
          tint.copy(noteColor(n, mode));
          this.drawFxSides(s, phi, 3 + (0.5 + 0.5 * i) * FX_WAVE_REACH * e, tint, a, true);
        });
      } else {
        tint.copy(noteColor(s.note, mode));
        this.drawFxSides(s, phi, 3 + FX_WAVE_REACH * e, tint, a);
      }
    }
    this.fxWaves.length = w;

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

  // ---- 蔦と花 ----

  /** 蔦の、起点から周に沿って d（符号付き）だけ進んだ点での線からのずれ */
  private vineOff(v: Vine, d: number): number {
    const k = (2 * Math.PI) / VINE_WAVE;
    return VINE_AMP * (Math.sin(d * k + v.seed * 6.28) + 0.35 * Math.sin(d * k * 2.3 + v.seed * 11));
  }

  /** 周上の位置を図形の範囲に収める（閉じた図形は一周で戻る）。開いた図形の外なら NaN */
  private wrapArc(s: Shape, a: number): number {
    if (s.closed) return ((a % s.perimeter) + s.perimeter) % s.perimeter;
    return a < 0 || a > s.perimeter ? NaN : a;
  }

  /** 衝突した点から蔦を伸ばし、通るところに咲く花を先に予約する（開く時刻は蔦が届く時刻） */
  private growVine(s: Shape, step: number, x: number, y: number, v: number): void {
    if (s.perimeter <= 0) return;
    const last = this.vineAt.get(s.group);
    if (last !== undefined && step >= last && (step - last) / HZ < VINE_GAP_SEC) return;
    this.vineAt.set(s.group, step);
    const arc0 = this.arcPos(s, step, x, y);
    let reach = VINE_REACH + VINE_REACH_V * v;
    if (s.closed) reach = Math.min(reach, s.perimeter / 2);
    const r = (k: number, j: number) => hash01(s.group, step, 300 + k * 8 + j);
    // 同じ所に続けて当たっても、まだ咲いている所には重ねない（散ったあとにまた咲く）
    const hold = Math.round(FLOWER_HOLD_SEC * HZ);
    const busy = (this.bloomed.get(s.group) ?? []).filter((b) => b.from <= step && step < b.until);
    const taken: Bloomed[] = [];
    const free = (arc: number, at: number, leaf: boolean): boolean => {
      const gap = leaf ? VINE_CROWD_LEAF : VINE_CROWD_FLOWER;
      for (const b of busy) {
        if (b.leaf !== leaf || at < b.from || at >= b.until) continue;
        let d = Math.abs(arc - b.arc);
        if (s.closed) d = Math.min(d, s.perimeter - d);
        if (d < gap) return false;
      }
      taken.push({ arc, from: at, until: at + hold, leaf });
      return true;
    };
    const vine: Vine = {
      group: s.group, step, phi0: shapeAngle(s, step), arc0, reach, seed: r(0, 0), note: s.note, life: reach / VINE_SPEED + FLOWER_HOLD_SEC, flowers: [],
    };
    const phi = shapeAngle(s, step);
    const base = noteColor(s.note, 'pitch');
    const mono = this.params.colorMode === 'mono';
    const size = VINE_FLOWER_R + VINE_FLOWER_R_V * v;
    const gain = VINE_FLOWER_GAIN + VINE_FLOWER_GAIN_V * v;
    let k = 0;
    const leafC = new Color().copy(VINE_COLOR).lerp(base, 0.25);
    if (mono) leafC.copy(OFF_WHITE);
    /** 周上 d（符号付き）の位置に1輪。scale は大きさ、dn・da は蔦からの法線・周方向のずれ（px） */
    const put = (d: number, scale: number, dn: number, da: number) => {
      const arc = this.wrapArc(s, arc0 + d + da);
      if (Number.isNaN(arc)) return;
      this.pointAt(s, phi, arc);
      const pt = this.pt;
      const side = dn >= 0 ? 1 : -1;
      const off = this.vineOff(vine, d) + dn;
      const at = step + Math.round((Math.abs(d) / VINE_SPEED) * HZ);
      if (!free(arc, at, false)) return;
      const stem = VINE_STEM * size * scale * (0.6 + 0.8 * r(k, 0));
      const handle = this.flowers.bloom(s.group, at, k, pt.x + pt.nx * off, pt.y + pt.ny * off, {
        radius: size * scale, gain,
        faceX: pt.nx * side, faceY: pt.ny * side,
        tilt: 0.2 + 1.2 * r(k, 1),
        stem,
      }, base, mono);
      vine.flowers.push({ handle, arc, off, at });
      k++;
      // 茎の代わりに、花の付け根から左右へ葉を2枚（花はその間から伸びる）
      const fx = pt.nx * side, fy = pt.ny * side;
      for (const sgn of [1, -1]) {
        const a = sgn * (0.55 + 0.4 * r(k, 6));
        const ca = Math.cos(a), sa = Math.sin(a);
        const lh = this.flowers.leaf(s.group, at, k, pt.x + pt.nx * off, pt.y + pt.ny * off, {
          len: (stem * 1.2 + size * scale * 0.3) * (0.8 + 0.4 * r(k, 7)),
          gain: LEAF_GAIN,
          dirX: fx * ca - fy * sa,
          dirY: fx * sa + fy * ca,
          roll: 0.2 + 0.9 * r(k, 5),
        }, leafC);
        vine.flowers.push({ handle: lh, arc, off, at });
        k++;
      }
    };
    // 葉: 蔦に沿って左右交互に。伸びる向きへ少し倒して出る
    for (const dir of [1, -1]) {
      let side = r(k, 3) < 0.5 ? 1 : -1;
      for (let d = LEAF_GAP * (0.3 + 0.7 * r(k, 2)); d <= reach; d += LEAF_GAP * (0.7 + 0.6 * r(k, 2))) {
        const arc = this.wrapArc(s, arc0 + dir * d);
        if (Number.isNaN(arc)) break;
        this.pointAt(s, phi, arc);
        const pt = this.pt;
        const off = this.vineOff(vine, dir * d);
        // 周の進む向き（法線を -90° 回したもの）
        const tx = pt.ny, ty = -pt.nx;
        const ca = Math.cos(LEAF_ANGLE), sa = Math.sin(LEAF_ANGLE);
        const at = step + Math.round((d / VINE_SPEED) * HZ);
        if (!free(arc, at, true)) {
          side = -side;
          k++;
          continue;
        }
        const handle = this.flowers.leaf(s.group, at, k, pt.x + pt.nx * off, pt.y + pt.ny * off, {
          len: size * LEAF_LEN * (0.7 + 0.6 * r(k, 4)),
          gain: LEAF_GAIN,
          dirX: pt.nx * side * ca + tx * dir * sa,
          dirY: pt.ny * side * ca + ty * dir * sa,
          roll: 0.2 + 0.9 * r(k, 5),
        }, leafC);
        vine.flowers.push({ handle, arc, off, at });
        side = -side;
        k++;
      }
    }

    // 当たった所に大きな1輪
    put(0, VINE_FLOWER_HIT_SCALE, r(0, 3) < 0.5 ? 1 : -1, 0);
    for (const dir of [1, -1]) {
      let d = VINE_FLOWER_GAP * (0.5 + 0.5 * r(k, 2));
      while (d <= reach) {
        // 房: 主の1輪に、小さな花を 0〜2 輪添える
        const side = r(k, 3) < 0.5 ? 1 : -1;
        put(dir * d, 0.6 + 0.8 * r(k, 4), side * 2, 0);
        const extra = r(k, 5) < 0.6 ? (r(k, 6) < 0.35 ? 2 : 1) : 0;
        for (let j = 0; j < extra; j++) {
          put(dir * d, 0.35 + 0.3 * r(k, 4), -side * (2 + 8 * r(k, 6)), (r(k, 7) - 0.5) * VINE_FLOWER_GAP * 0.8);
        }
        d += VINE_FLOWER_GAP * (0.7 + 0.6 * r(k, 2));
      }
    }
    this.bloomed.set(s.group, busy.concat(taken));
    if (this.vines.length >= MAX_VINES) this.vines.shift();
    this.vines.push(vine);
  }

  private drawVines(rs: number): void {
    const mode = this.params.colorMode;
    const c = this.color;
    const pt = this.pt;
    let n = 0;
    let w = 0;
    for (const vine of this.vines) {
      const t = (rs - vine.step) / HZ;
      const s = this.shapes.get(vine.group);
      if (!s || t > vine.life + 3 * 0.9) continue;
      this.vines[w++] = vine;
      if (t < 0) continue;
      const phi = shapeAngle(s, rs);
      // 回っている図形に付いた花は位置を直す
      // 回っている図形に付いた花・葉は、落ちるまで位置と向きを直す
      if (s.omega !== 0) {
        for (const f of vine.flowers) {
          if ((rs - f.at) / HZ > FLOWER_HOLD_SEC) continue;
          this.pointAt(s, phi, f.arc);
          this.flowers.setPos(f.handle, pt.x + pt.nx * f.off, pt.y + pt.ny * f.off, phi - vine.phi0);
        }
      }
      const front = Math.min(vine.reach, t * VINE_SPEED);
      const fade = Math.exp(-Math.max(0, t - vine.life) / 0.9);
      c.copy(VINE_COLOR).lerp(noteColor(vine.note, mode), 0.35);
      if (mode === 'mono') c.copy(OFF_WHITE);
      for (const dir of [1, -1]) {
        let px = NaN, py = NaN;
        for (let d = 0; d <= front && n < MAX_VINE_QUADS; d += VINE_STEP) {
          const arc = this.wrapArc(s, vine.arc0 + dir * d);
          if (Number.isNaN(arc)) break;
          this.pointAt(s, phi, arc);
          const off = this.vineOff(vine, dir * d);
          const x = pt.x + pt.nx * off, y = pt.y + pt.ny * off;
          if (!Number.isNaN(px)) {
            // 先端ほど細く明るい（伸びている間だけ）
            const tip = front < vine.reach ? Math.exp(-(front - d) / 12) : 0;
            const width = VINE_WIDTH * this.thick * (0.5 + 0.5 * Math.min(1, (front - d) / 40 + 0.3));
            this.putQuad(this.vineQuads, n++, px, py, x, y, width, this.tint.copy(c).multiplyScalar(VINE_GAIN * fade * (1 + 1.5 * tip)));
          }
          px = x;
          py = y;
        }
      }
    }
    this.vines.length = w;
    commit(this.vineQuads, n);
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
