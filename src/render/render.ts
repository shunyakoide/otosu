import {
  AdditiveBlending, CircleGeometry, Color, HalfFloatType, InstancedBufferAttribute, InstancedMesh,
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
import type { SimEvent, Snapshot } from '../sim/types';
import { GRAY, noteColor, OFF_WHITE, type ColorMode } from './palette';

// 描画は「renderStep 時点の世界」を表示する（decisions.md D3, D8-5）。
// sim は LOOKAHEAD ぶん先行しているので、イベントは renderStep に達してから反映する。
// sim の Segment / Emitter は参照せず、イベントから自分用のコピーを持つ（D9, B2, B4）。

export type TrailMode = 'geometry' | 'afterimage';

export type RenderParams = {
  colorMode: ColorMode;
  bloomStrength: number;
  afterimage: number;
  idleLine: number;
  /** 'geometry' = 履歴から尾を描く（ステップ2）/ 'afterimage' = ステップ1の見た目（尾なし・damp 0.88） */
  trail?: TrailMode;
};

/** 描画中のドラッグとホバー（座標は論理ワールド） */
export type Preview = {
  active: boolean; ax: number; ay: number; bx: number; by: number;
  hover?: { active: boolean; x: number; y: number };
};

/** ボール位置の履歴だけを使う（sim の他の状態は見ない） */
export type SnapshotSource = { snapshot(step: number): Snapshot | undefined };

export const PICK_RADIUS = 12;

const MAX_SEGMENTS = 512;
const MAX_RIPPLES = 64;
const MAX_EMITTERS = 8;

// 尾（step2-visual.md 案1）
const TRAIL_STEPS = 30;
const TRAIL_STRIDE = 2;
const TRAIL_QUADS = TRAIL_STEPS / TRAIL_STRIDE;
const LEGACY_DAMP = 0.88;

// 削除（案3）
const DIE_SEC = 0.2;
const WIPE_SEC = 0.3;
const WIPE_DELAY_SEC = 0.15;
const HOVER_TAU = 0.05;
const EMITTER_TAU = 0.2;

type Flash = { step: number; v: number };
type BallLook = { note: number; step: number; v: number };
type Ripple = { x: number; y: number; step: number; v: number; note: number };
type Line = {
  id: number; cx: number; cy: number; halfLen: number;
  theta0: number; rotStartStep: number; omega: number; note: number;
};
type Dying = { line: Line; theta: number; step: number; delay: number; dur: number };
type EmitterView = { x: number; y: number; tx: number; ty: number; pulse: number };

function additive(): MeshBasicMaterial {
  return new MeshBasicMaterial({
    blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
  });
}

function instanced(geo: BufferGeometry, count: number, order: number): InstancedMesh {
  const mesh = new InstancedMesh(geo, additive(), count);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
  mesh.instanceColor.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  mesh.count = 0;
  return mesh;
}

function commit(mesh: InstancedMesh, n: number): void {
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor!.needsUpdate = true;
}

const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);
const lineAngle = (l: Line, step: number) => l.theta0 + (l.omega * (step - l.rotStartStep)) / HZ;

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(0, WORLD_W, 0, -WORLD_H, -10, 10);
  private readonly composer: EffectComposer;
  private readonly afterimage: AfterimagePass;
  private readonly bloom: UnrealBloomPass;

  private readonly balls = instanced(new CircleGeometry(1, 20), MAX_BALLS + 1, 3);
  private readonly trails = instanced(new PlaneGeometry(1, 1), (MAX_BALLS + 1) * TRAIL_QUADS, 2);
  private readonly lines = instanced(new PlaneGeometry(1, 1), MAX_SEGMENTS + 1, 2);
  private readonly caps = instanced(new CircleGeometry(1, 16), (MAX_SEGMENTS + 1) * 2, 2);
  private readonly ripples = instanced(new RingGeometry(0.93, 1, 48), MAX_RIPPLES, 1);
  private readonly emitterMesh = instanced(new RingGeometry(0.6, 1, 32), MAX_EMITTERS, 1);

  private readonly segments = new Map<number, Line>();
  private readonly dying = new Map<number, Dying>();
  private readonly lineFlash = new Map<number, Flash>();
  private readonly hoverAmt = new Map<number, number>();
  private readonly ballLook = new Map<number, BallLook>();
  private readonly emitters = new Map<number, EmitterView>();
  private readonly rippleBuf: Ripple[] = [];
  private rippleHead = 0;
  private pending: SimEvent[] = [];

  // 尾のマージ用（毎フレーム new しない）
  private readonly trailSnaps: (Snapshot | undefined)[] = new Array(TRAIL_QUADS + 1);
  private readonly trailPtr = new Int32Array(TRAIL_QUADS + 1);

  private previewNote = -1;
  private previewFlashAt = -Infinity;
  private lastRs = -1;

  private readonly dummy = new Object3D();
  private readonly color = new Color();
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

    const rt = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.afterimage = new AfterimagePass(params.afterimage);
    this.composer.addPass(this.afterimage);
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), params.bloomStrength, 0.35, 0.8);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.scene.add(this.ripples, this.emitterMesh, this.trails, this.lines, this.caps, this.balls);
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
   * 表示中の線のうち、(x, y) から PICK_RADIUS 以内で最も近いものの id（なければ -1）。
   * 姿勢は直近に描画した renderStep のもの（B3）。消えかけの線は対象外。
   */
  pickSegment(x: number, y: number, radius = PICK_RADIUS): number {
    let bestId = -1;
    let best = radius;
    for (const l of this.segments.values()) {
      const th = lineAngle(l, this.lastRs);
      const dx = Math.cos(th) * l.halfLen;
      const dy = Math.sin(th) * l.halfLen;
      closestOnSegment(x, y, l.cx - dx, l.cy - dy, l.cx + dx, l.cy + dy, this.near);
      if (this.near.dist < best) {
        best = this.near.dist;
        bestId = l.id;
      }
    }
    return bestId;
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

  private consume(rs: number): void {
    let n = 0;
    let removedStep = -1;
    let removed: Dying[] = [];
    for (const e of this.pending) {
      if (e.step > rs) break;
      n++;
      switch (e.kind) {
        case 'hit': {
          this.lineFlash.set(e.lineId, { step: e.step, v: e.velocity });
          this.ballLook.set(e.ballId, { note: e.note, step: e.step, v: e.velocity });
          if (e.velocity >= 0.25) {
            const r = { x: e.x, y: e.y, step: e.step, v: e.velocity, note: e.note };
            if (this.rippleBuf.length < MAX_RIPPLES) this.rippleBuf.push(r);
            else this.rippleBuf[this.rippleHead] = r;
            this.rippleHead = (this.rippleHead + 1) % MAX_RIPPLES;
          }
          break;
        }
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
        case 'segmentAdded': {
          const s = e.segment;
          this.segments.set(s.id, {
            id: s.id, cx: s.cx, cy: s.cy, halfLen: s.halfLen,
            theta0: s.theta0, rotStartStep: s.rotStartStep, omega: s.omega, note: s.note,
          });
          this.lineFlash.set(s.id, { step: e.step, v: 0.5 });
          break;
        }
        case 'segmentPose': {
          const l = this.segments.get(e.segmentId);
          if (l) {
            l.theta0 = e.theta0;
            l.rotStartStep = e.rotStartStep;
            l.omega = e.omega;
          }
          break;
        }
        case 'segmentRemoved': {
          const l = this.segments.get(e.segmentId);
          if (!l) break;
          this.segments.delete(e.segmentId);
          this.lineFlash.delete(e.segmentId);
          this.hoverAmt.delete(e.segmentId);
          if (e.step !== removedStep) {
            this.stagger(removed);
            removed = [];
            removedStep = e.step;
          }
          const d: Dying = { line: l, theta: lineAngle(l, e.step), step: e.step, delay: 0, dur: DIE_SEC };
          removed.push(d);
          this.dying.set(l.id, d);
          break;
        }
      }
    }
    this.stagger(removed);
    if (n > 0) this.pending.splice(0, n);
  }

  /** 同じステップで複数の線が消えた（clear / loadScene）ときは左から右へ拭うように消す */
  private stagger(group: Dying[]): void {
    if (group.length < 2) return;
    for (const d of group) {
      d.delay = WIPE_DELAY_SEC * Math.min(1, Math.max(0, d.line.cx / WORLD_W));
      d.dur = WIPE_SEC;
    }
  }

  render(src: SnapshotSource, rs: number, dt: number, preview: Preview): void {
    this.consume(rs);
    this.lastRs = rs;
    const p = this.params;
    const geometryTrail = (p.trail ?? 'geometry') === 'geometry';

    this.bloom.strength = p.bloomStrength;
    const damp = geometryTrail ? p.afterimage : LEGACY_DAMP;
    this.afterimage.uniforms['damp']!.value = Math.pow(damp, dt * 60);

    const head = src.snapshot(Math.floor(rs));
    this.drawBalls(src, rs);
    if (geometryTrail) this.drawTrails(src, rs);
    else commit(this.trails, 0);
    this.drawLines(rs, dt, preview);
    this.drawRipples(rs);
    this.drawEmitters(rs, dt);
    this.gcBallLook(head);

    this.composer.render(dt);
  }

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
   * 尾: 直近 TRAIL_STEPS ステップの位置を TRAIL_STRIDE おきに取り、クアッドでつなぐ（案1）。
   * 点 k=0 は補間済みの現在位置、k>0 は snapshot(s0 − k)。どのスナップショットも id 昇順なのでマージで引く。
   */
  private drawTrails(src: SnapshotSource, rs: number): void {
    const s0 = Math.floor(rs);
    const a = rs - s0;
    const A = src.snapshot(s0);
    const B = src.snapshot(s0 + 1);
    const snaps = this.trailSnaps;
    const ptr = this.trailPtr;
    for (let q = 1; q <= TRAIL_QUADS; q++) {
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
        for (let q = 1; q <= TRAIL_QUADS; q++) {
          const S = snaps[q];
          if (!S) break;
          let j = ptr[q]!;
          while (j < S.count && S.ids[j]! < id) j++;
          ptr[q] = j;
          if (j >= S.count || S.ids[j] !== id) break; // この時点ではまだ生まれていない
          const qx = S.xs[j]!;
          const qy = S.ys[j]!;
          const km = (q - 0.5) * TRAIL_STRIDE; // クアッド中点の「何ステップ前か」
          const f = km / TRAIL_STEPS;
          const intensity = this.ballIntensity(look, s0 - km) * 0.6 * Math.pow(1 - f, 1.5);
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

  private putLine(i: number, ax: number, ay: number, bx: number, by: number, c: Color, width = LINE_WIDTH): void {
    this.putQuad(this.lines, i, ax, ay, bx, by, width, c);
    const d = this.dummy;
    const r = width / 2;
    d.rotation.set(0, 0, 0);
    d.scale.set(r, r, 1);
    d.position.set(ax, -ay, 0);
    d.updateMatrix();
    this.caps.setMatrixAt(i * 2, d.matrix);
    this.caps.setColorAt(i * 2, c);
    d.position.set(bx, -by, 0);
    d.updateMatrix();
    this.caps.setMatrixAt(i * 2 + 1, d.matrix);
    this.caps.setColorAt(i * 2 + 1, c);
  }

  private updateHover(dt: number, preview: Preview): void {
    const h = preview.hover;
    const target = !preview.active && h?.active ? this.pickSegment(h.x, h.y) : -1;
    const k = 1 - Math.exp(-dt / HOVER_TAU);
    if (target >= 0 && !this.hoverAmt.has(target)) this.hoverAmt.set(target, 0);
    for (const [id, v] of this.hoverAmt) {
      const nv = v + ((id === target ? 1 : 0) - v) * k;
      if (id !== target && nv < 0.01) this.hoverAmt.delete(id);
      else this.hoverAmt.set(id, nv);
    }
  }

  private drawLines(rs: number, dt: number, preview: Preview): void {
    this.updateHover(dt, preview);
    const c = this.color;
    const mode = this.params.colorMode;
    const idle = this.params.idleLine;
    let n = 0;

    for (const l of this.segments.values()) {
      if (n >= MAX_SEGMENTS) break;
      const th = lineAngle(l, rs);
      const dx = Math.cos(th) * l.halfLen;
      const dy = Math.sin(th) * l.halfLen;
      let intensity = idle;
      let white = 0;
      const f = this.lineFlash.get(l.id);
      if (f) {
        const t = Math.max(0, (rs - f.step) / HZ);
        if (t < 1.2) {
          intensity += (1.2 + 1.8 * f.v) * Math.exp(-t / 0.18);
          white = 0.25 * Math.exp(-t / 0.06);
        }
      }
      const hv = this.hoverAmt.get(l.id) ?? 0;
      intensity = Math.max(intensity, 0.3 + 0.3 * hv);
      c.copy(noteColor(l.note, mode)).lerp(OFF_WHITE, white).multiplyScalar(intensity);
      this.putLine(n++, l.cx - dx, l.cy - dy, l.cx + dx, l.cy + dy, c, LINE_WIDTH + 1.5 * hv);
    }

    // 消えかけの線: 遅延のあいだは待機の明るさ、その後 0.8·(1−p)² で消しながら中心へ 10% 縮める
    for (const [id, d] of this.dying) {
      const p = ((rs - d.step) / HZ - d.delay) / d.dur;
      if (p >= 1) {
        this.dying.delete(id);
        continue;
      }
      if (n >= MAX_SEGMENTS) continue;
      const q = Math.max(0, p);
      const intensity = p < 0 ? idle : 0.8 * (1 - q) ** 2;
      const half = d.line.halfLen * (1 - 0.1 * easeOutCubic(q));
      const dx = Math.cos(d.theta) * half;
      const dy = Math.sin(d.theta) * half;
      c.copy(noteColor(d.line.note, mode)).multiplyScalar(intensity);
      this.putLine(n++, d.line.cx - dx, d.line.cy - dy, d.line.cx + dx, d.line.cy + dy, c);
    }

    if (preview.active) {
      const len = Math.hypot(preview.bx - preview.ax, preview.by - preview.ay);
      const now = performance.now() / 1000;
      if (len < MIN_LINE_LEN) {
        c.copy(GRAY);
        this.previewNote = -1;
      } else {
        const note = lengthToNote(len).index;
        if (note !== this.previewNote) {
          if (this.previewNote >= 0) this.previewFlashAt = now;
          this.previewNote = note;
        }
        const breath = 0.35 + 0.15 * Math.sin(2 * Math.PI * 2 * now);
        const flash = 0.8 * Math.exp(-(now - this.previewFlashAt) / 0.08);
        c.copy(noteColor(note, mode)).multiplyScalar(breath + flash);
      }
      this.putLine(n++, preview.ax, preview.ay, preview.bx, preview.by, c);
    } else {
      this.previewNote = -1;
    }

    commit(this.lines, n);
    commit(this.caps, n * 2);
  }

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

  /** 放出口は emitters / emit イベントの位置から描く。位置の変化はゆっくり追従させる（B4） */
  private drawEmitters(rs: number, dt: number): void {
    const d = this.dummy;
    const c = this.color;
    const k = 1 - Math.exp(-dt / EMITTER_TAU);
    let n = 0;
    for (const em of this.emitters.values()) {
      if (n >= MAX_EMITTERS) break;
      em.x += (em.tx - em.x) * k;
      em.y += (em.ty - em.y) * k;
      const t = Math.max(0, (rs - em.pulse) / HZ);
      d.position.set(em.x, -em.y, 0);
      d.rotation.set(0, 0, 0);
      d.scale.set(8, 8, 1);
      d.updateMatrix();
      this.emitterMesh.setMatrixAt(n, d.matrix);
      this.emitterMesh.setColorAt(n, c.copy(OFF_WHITE).multiplyScalar(0.3 + 1.0 * Math.exp(-t / 0.12)));
      n++;
    }
    commit(this.emitterMesh, n);
  }

  /** 画面から消えたボールの見た目情報を掃除する */
  private gcBallLook(A: Snapshot | undefined): void {
    if (!A || this.ballLook.size <= A.count + 64) return;
    const alive = new Set(A.ids.subarray(0, A.count));
    for (const id of this.ballLook.keys()) if (!alive.has(id)) this.ballLook.delete(id);
  }
}
