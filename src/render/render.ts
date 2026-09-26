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
import { BALL_RADIUS, HZ, LINE_WIDTH, MAX_BALLS, MIN_LINE_LEN, WORLD_H, WORLD_W } from '../sim/constants';
import { lengthToNote } from '../sim/music';
import { segmentAngle, type Sim } from '../sim/sim';
import type { Segment, SimEvent } from '../sim/types';
import { GRAY, noteColor, OFF_WHITE, type ColorMode } from './palette';

// 描画は「renderStep 時点の世界」を表示する（decisions.md D3, D8-5）。
// sim は LOOKAHEAD ぶん先行しているので、イベントは renderStep に達してから反映する。

export type RenderParams = {
  colorMode: ColorMode;
  bloomStrength: number;
  afterimage: number;
  idleLine: number;
};

export type Preview = { active: boolean; ax: number; ay: number; bx: number; by: number };

const MAX_SEGMENTS = 256;
const MAX_RIPPLES = 64;
const MAX_EMITTERS = 8;

type Flash = { step: number; v: number };
type BallLook = { note: number; step: number; v: number };
type Ripple = { x: number; y: number; step: number; v: number; note: number };

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

const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(0, WORLD_W, 0, -WORLD_H, -10, 10);
  private readonly composer: EffectComposer;
  private readonly afterimage: AfterimagePass;
  private readonly bloom: UnrealBloomPass;

  private readonly balls = instanced(new CircleGeometry(1, 20), MAX_BALLS + 1, 3);
  private readonly lines = instanced(new PlaneGeometry(1, 1), MAX_SEGMENTS + 1, 2);
  private readonly caps = instanced(new CircleGeometry(1, 16), (MAX_SEGMENTS + 1) * 2, 2);
  private readonly ripples = instanced(new RingGeometry(0.93, 1, 48), MAX_RIPPLES, 1);
  private readonly emitters = instanced(new RingGeometry(0.6, 1, 32), MAX_EMITTERS, 1);

  private readonly segments = new Map<number, Segment>();
  private readonly lineFlash = new Map<number, Flash>();
  private readonly ballLook = new Map<number, BallLook>();
  private readonly emitPulse = new Map<number, number>();
  private readonly rippleBuf: Ripple[] = [];
  private rippleHead = 0;
  private pending: SimEvent[] = [];

  private previewNote = -1;
  private previewFlashAt = -Infinity;

  private readonly dummy = new Object3D();
  private readonly color = new Color();
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

    this.scene.add(this.ripples, this.emitters, this.lines, this.caps, this.balls);
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
        case 'emit':
          this.emitPulse.set(e.emitterId, e.step);
          break;
        case 'segmentAdded':
          this.segments.set(e.segment.id, e.segment as Segment);
          this.lineFlash.set(e.segment.id, { step: e.step, v: 0.5 });
          break;
        case 'segmentRemoved':
          this.segments.delete(e.segmentId);
          this.lineFlash.delete(e.segmentId);
          break;
      }
    }
    if (n > 0) this.pending.splice(0, n);
  }

  render(sim: Sim, rs: number, dt: number, preview: Preview): void {
    this.consume(rs);
    const p = this.params;

    this.bloom.strength = p.bloomStrength;
    this.afterimage.uniforms['damp']!.value = Math.pow(p.afterimage, dt * 60);

    this.drawBalls(sim, rs);
    this.drawLines(rs, preview);
    this.drawRipples(rs);
    this.drawEmitters(sim, rs);

    this.composer.render(dt);
  }

  private drawBalls(sim: Sim, rs: number): void {
    const s0 = Math.floor(rs);
    const a = rs - s0;
    const A = sim.snapshot(s0);
    const B = sim.snapshot(s0 + 1);
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
        let intensity = 0.55;
        let scale = BALL_RADIUS;
        if (look) {
          const t = Math.max(0, (rs - look.step) / HZ);
          intensity += (1.0 + 1.5 * look.v) * Math.exp(-t / 0.09);
          scale *= 1 + 0.35 * Math.exp(-t / 0.06);
          c.copy(noteColor(look.note, this.params.colorMode));
        } else {
          c.copy(OFF_WHITE);
        }
        d.position.set(x, -y, 0);
        d.rotation.set(0, 0, 0);
        d.scale.set(scale, scale, 1);
        d.updateMatrix();
        mesh.setMatrixAt(n, d.matrix);
        mesh.setColorAt(n, c.multiplyScalar(intensity));
        n++;
      }
      // 画面から消えたボールの見た目情報を掃除する
      if (s0 % 120 === 0 && this.ballLook.size > A.count) {
        const alive = new Set(A.ids.subarray(0, A.count));
        for (const id of this.ballLook.keys()) if (!alive.has(id)) this.ballLook.delete(id);
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.needsUpdate = true;
  }

  private putLine(i: number, ax: number, ay: number, bx: number, by: number, c: Color): void {
    const d = this.dummy;
    const len = Math.hypot(bx - ax, by - ay);
    d.position.set((ax + bx) / 2, -(ay + by) / 2, 0);
    d.rotation.set(0, 0, -Math.atan2(by - ay, bx - ax));
    d.scale.set(len, LINE_WIDTH, 1);
    d.updateMatrix();
    this.lines.setMatrixAt(i, d.matrix);
    this.lines.setColorAt(i, c);
    const r = LINE_WIDTH / 2;
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

  private drawLines(rs: number, preview: Preview): void {
    const c = this.color;
    const mode = this.params.colorMode;
    let n = 0;
    for (const seg of this.segments.values()) {
      const th = segmentAngle(seg, rs);
      const dx = Math.cos(th) * seg.halfLen;
      const dy = Math.sin(th) * seg.halfLen;
      let intensity = this.params.idleLine;
      let white = 0;
      const f = this.lineFlash.get(seg.id);
      if (f) {
        const t = Math.max(0, (rs - f.step) / HZ);
        if (t < 1.2) {
          intensity += (1.2 + 1.8 * f.v) * Math.exp(-t / 0.18);
          white = 0.25 * Math.exp(-t / 0.06);
        }
      }
      c.copy(noteColor(seg.note, mode)).lerp(OFF_WHITE, white).multiplyScalar(intensity);
      this.putLine(n++, seg.cx - dx, seg.cy - dy, seg.cx + dx, seg.cy + dy, c);
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
        c.copy(noteColor(note, this.params.colorMode)).multiplyScalar(breath + flash);
      }
      this.putLine(n++, preview.ax, preview.ay, preview.bx, preview.by, c);
    } else {
      this.previewNote = -1;
    }

    this.lines.count = n;
    this.caps.count = n * 2;
    for (const m of [this.lines, this.caps]) {
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor!.needsUpdate = true;
    }
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
    this.ripples.count = n;
    this.ripples.instanceMatrix.needsUpdate = true;
    this.ripples.instanceColor!.needsUpdate = true;
  }

  private drawEmitters(sim: Sim, rs: number): void {
    const d = this.dummy;
    const c = this.color;
    let n = 0;
    for (const em of sim.emitters) {
      if (n >= MAX_EMITTERS) break;
      const last = this.emitPulse.get(em.id);
      const t = last === undefined ? Infinity : Math.max(0, (rs - last) / HZ);
      d.position.set(em.x, -em.y, 0);
      d.rotation.set(0, 0, 0);
      d.scale.set(8, 8, 1);
      d.updateMatrix();
      this.emitters.setMatrixAt(n, d.matrix);
      this.emitters.setColorAt(n, c.copy(OFF_WHITE).multiplyScalar(0.3 + 1.0 * Math.exp(-t / 0.12)));
      n++;
    }
    this.emitters.count = n;
    this.emitters.instanceMatrix.needsUpdate = true;
    this.emitters.instanceColor!.needsUpdate = true;
  }
}
