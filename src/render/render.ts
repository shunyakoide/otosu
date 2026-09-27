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
import { BALL_RADIUS, HZ, LINE_WIDTH, MAX_BALLS, MIN_LINE_LEN, WORLD_H, WORLD_W } from '../sim/constants';
import { lengthToNote } from '../sim/music';
import type { SegKind, ShapeAddedEvent, SimEvent, Snapshot } from '../sim/types';
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

type BallLook = { note: number; step: number; v: number; chain: number };
type Ripple = { x: number; y: number; step: number; v: number; note: number };
type Hit = { step: number; v: number; s: number; tau: number };
type Shape = {
  group: number;
  kind: SegKind;
  note: number;
  closed: boolean;
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

    this.scene.add(this.ripples, this.emitterMesh, this.trails, this.edges, this.caps, this.balls);
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
    const s = Math.min(w / WORLD_W, h / WORLD_H);
    this.scale = s;
    this.offsetX = (w - WORLD_W * s) / 2;
    this.offsetY = (h - WORLD_H * s) / 2;
    const viewW = w / s;
    const viewH = h / s;
    this.camera.left = -(viewW - WORLD_W) / 2;
    this.camera.right = this.camera.left + viewW;
    this.camera.top = (viewH - WORLD_H) / 2;
    this.camera.bottom = this.camera.top - viewH;
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
    this.shapes.set(e.group, {
      group: e.group, kind: e.segKind, note: e.note, closed: e.closed, gx: e.gx, gy: e.gy,
      rel, n, s0, elen, perimeter: p,
      theta0: 0, rotStartStep: e.step, omega: 0,
      // 置いた瞬間: 始点から光が走る
      hit: { step: e.step, v: 0.5, s: 0, tau: stringTau(e.note) },
      resStep: -Infinity, resV: 0, replayAt: -Infinity,
    });
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
    if (s) s.hit = { step: e.step, v: e.velocity, s: this.arcPos(s, e.step, e.x, e.y), tau: stringTau(s.note) };

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

    if (e.velocity >= 0.25) {
      const r = { x: e.x, y: e.y, step: e.step, v: e.velocity, note: e.note };
      if (this.rippleBuf.length < MAX_RIPPLES) this.rippleBuf.push(r);
      else this.rippleBuf[this.rippleHead] = r;
      this.rippleHead = (this.rippleHead + 1) % MAX_RIPPLES;
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
      const h = s.hit;
      if (h) {
        const t = Math.max(0, (rs - h.step) / HZ);
        if (t > 3 * h.tau && t > 1.2) {
          s.hit = null;
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
      const v = this.pose(s, shapeAngle(s, rs), 1);
      this.drawOutline(v, s.n, s.closed, s.kind === 'bumper', tint, LINE_WIDTH + 1.5 * hv,
        base, spot, sigma, sHit, vib);
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
      const p = (rs - r.step) / HZ / 0.5;
      if (p < 0 || p >= 1) continue;
      const radius = BALL_RADIUS + (20 + 40 * r.v) * easeOutCubic(p);
      d.position.set(r.x, -r.y, 0);
      d.rotation.set(0, 0, 0);
      d.scale.set(radius, radius, 1);
      d.updateMatrix();
      this.ripples.setMatrixAt(n, d.matrix);
      this.ripples.setColorAt(n, c.copy(noteColor(r.note, this.params.colorMode)).multiplyScalar(1.2 * r.v * (1 - p) ** 2));
      n++;
    }
    commit(this.ripples, n);
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
