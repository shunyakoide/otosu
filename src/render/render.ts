import {
  Color, HalfFloatType, NeutralToneMapping, OrthographicCamera, Scene, WebGLRenderTarget, WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BALL_RADIUS, HZ, WORLD_H, WORLD_W, type Bounds } from '../sim/constants';
import type { SimEvent, Snapshot } from '../sim/types';
import { Backdrop, type BackdropKind } from './backdrop';
import { Balls, type SnapshotSource } from './balls';
import { Constellation } from './constellation';
import { Crosshair } from './crosshair';
import { Emitters } from './emitters';
import type { FlowerKind } from './flowers';
import { FlowPass, type FlowOptions } from './flow';
import { Glints } from './glints';
import { Hud } from './hud';
import { Notes } from './notes';
import { noteColor, type ColorMode } from './palette';
import { QualityGovernor, type QualityLevel } from './quality';
import { Ripples } from './ripples';
import { Scope, type WaveSource } from './scope';
import { arcPos } from './shape';
import { ShapeView, stagger, type Dying, type Preview } from './shape-view';
import { Vines } from './vines';

// 描画は「renderStep 時点の世界」を表示する（decisions.md D3, D8-5）。
// sim は LOOKAHEAD ぶん先行しているので、イベントは renderStep に達してから反映する。
// sim の Segment / Emitter は参照せず、イベントから図形（group）単位の自分用コピーを持つ（D9, D14）。
// ここはイベントの振り分けとフレームの段取りだけ。描くものはそれぞれのモジュール:
//   balls.ts（ボールと尾）/ shape-view.ts（図形の線・形ごとの光）/ outline.ts（線のまとめ描き・エフェクトの輪郭）
//   ripples.ts（波紋）/ glints.ts（きらめき）/ vines.ts + flowers.ts（蔦と花）/ emitters.ts（放出口）
//   backdrop.ts（背景）/ hud.ts（計器）/ crosshair.ts・notes.ts・scope.ts・constellation.ts（当たった点の表示）/ flow.ts（残像・グロー・書き出し）

export type { Preview, SnapshotSource };

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
  /** 衝突で花が咲く（D25）と、咲かせる花の種類 */
  flowers?: boolean;
  flowerKind?: FlowerKind;
  /** 背景（D33, D34）の種類と明るさ */
  backdrop?: BackdropKind;
  backdropLevel?: number;
  /** 当たった点の計器の表示（D36） */
  hud?: boolean;
  /** 当たった点の照準線・音名・波形・星座（D62） */
  crosshair?: boolean;
  noteNames?: boolean;
  scope?: boolean;
  constellation?: boolean;
};

const PICK_RADIUS = 12;

// スマホ・タブレット（D26）: 画面が小さいとワールド全体が遠く小さく見えるので、寄って表示し、線やボールを太く描く
/** 寄ったあとの縮尺（CSS px / ワールド px）の目安と、寄る倍率の上限 */
const TOUCH_SCALE = 0.5;
const TOUCH_ZOOM_MAX = 2.2;
/** 線・ボール・蔦を太く描く倍率（見た目だけ。当たり判定は変えない） */
const TOUCH_THICK = 1.6;
/** 指で図形を選ぶ半径（CSS px） */
const TOUCH_PICK_PX = 22;

// 連鎖の光（D15）: 通った図形を覚えておく数と、順に光らせ直す間隔
const CHAIN_PATH_MAX = 8;
const REPLAY_GAP = 8; // ステップ
const LEGACY_DAMP = 0.88;
/** 背景の水の色（色あり / white） */
const BACKDROP_WATER = new Color(0x8fcff5);
const BACKDROP_MONO = new Color(0xd8dde4);
/** square（木）の打点の波紋は短く小さく（D16） */
const WOOD_RIPPLE_SEC = 0.18;

/** 画面上端のツールバー用の帯（CSS px）の既定値。狭い画面でツールバーが折り返すと setTopBand で広げる */
export const TOP_BAND_PX = 52;

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private topBand = TOP_BAND_PX;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(0, WORLD_W, 0, -WORLD_H, -10, 10);
  private readonly composer: EffectComposer;
  /** 残像・グロー・画面への書き出し（D31, D65） */
  private readonly afterimage: FlowPass;

  // 作る順は同じ renderOrder の中での描く順になる（尾の MAX 合成 → 線の加算の順を変えないように）
  private readonly balls = new Balls();
  private readonly ripples = new Ripples();
  private readonly emitters = new Emitters();
  private readonly glints = new Glints();
  private readonly shapeView = new ShapeView(this.ripples, this.glints);
  private readonly vines = new Vines();
  private readonly backdrop = new Backdrop();
  private readonly hud = new Hud();
  private readonly crosshair = new Crosshair();
  private readonly notes = new Notes();
  private readonly scope = new Scope();
  private readonly constellation = new Constellation();

  /** ボールごとの、連鎖で通った図形（D15） */
  private readonly ballPath = new Map<number, number[]>();
  private pending: SimEvent[] = [];
  private lastRs = -1;

  // 盛り上がり（energy）と区間（section）
  private energyTarget = 0;
  private energyStep = -Infinity;
  private energy = 0;
  private sectionStep = -Infinity;

  private readonly flowOpts: FlowOptions = { drip: false, dripSpeed: 90, damp: LEGACY_DAMP };
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

    const rt = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.afterimage = new FlowPass(params.bloomStrength, 0.35, 0.8);
    this.composer.addPass(this.afterimage);

    const r = this.ripples;
    const out = this.shapeView.outline;
    this.scene.add(
      this.backdrop.object, this.hud.object, this.crosshair.object, this.constellation.object, this.scope.object, this.notes.object,
      this.vines.quads, this.vines.flowers.mesh, r.circles, r.triangles, r.squares,
      this.emitters.mesh, this.balls.trails, out.edges, out.caps, this.glints.mesh, this.balls.balls,
    );
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  /** メニューを開いている図形（-1 でなし）。ゆっくり明滅させ、どれを選んだかわかるようにする（D54） */
  get selected(): number {
    return this.shapeView.selected;
  }

  set selected(group: number) {
    this.shapeView.selected = group;
  }

  /** scope（D62）に出力の波形を渡す。音を始めたら main が設定する */
  set waveSource(src: WaveSource | null) {
    this.scope.source = src;
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

  /**
   * 表示中の図形のうち (x, y) に最も近いものの group（なければ -1）。
   * 辺から PICK_RADIUS 以内、または閉じた図形の内側。姿勢は直近に描画した renderStep のもの（B3）。
   */
  pickShape(x: number, y: number, radius = this.pickR): number {
    return this.shapeView.pick(x, y, radius, this.lastRs);
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

  private onHit(e: Extract<SimEvent, { kind: 'hit' }>): void {
    const at = e.step / HZ;
    // 音名は chord で重ねた音も並べる（D62）
    this.notes.hit(e, at);
    // chord で重ねた音は光らせない（本体の音が光る）
    if (e.voice > 0) return;
    // 背景の水に輪を立てる（くり返しは弱く）
    const v = e.velocity * (e.echo > 0 ? 0.5 : 1);
    this.backdrop.hit(e.x, e.y, e.step, v, e.note / 15, noteColor(e.note, this.params.colorMode));
    this.hud.hit(e.x, e.y, at, v);
    // 照準線・波形・星座はくり返しには出さない（同じ点に重なるだけなので）
    if (e.echo === 0) {
      this.crosshair.hit(e.x, e.y, at, e.velocity);
      this.scope.hit(e.x, e.y, at, e.velocity, e.midi);
      this.constellation.hit(e.x, e.y, at, e.velocity, e.section);
    }
    const shapes = this.shapeView.shapes;
    const s = shapes.get(e.group);
    if (s) this.shapeView.fxHit(s, e.step, e.velocity);
    // くり返し（echo / rise）: 図形が弱く光り、輪郭が広がるだけ（花・波紋・ボール・連鎖には数えない）
    if (e.echo > 0) {
      if (s) this.shapeView.trigger(s, e.step, e.velocity, e.form === 'circle' ? 0 : arcPos(s, e.step, e.x, e.y));
      return;
    }
    // circle は図形全体が光る（打点は使わない）
    if (s) this.shapeView.trigger(s, e.step, e.velocity, e.form === 'circle' ? 0 : arcPos(s, e.step, e.x, e.y));

    // 共鳴: 同じスロットの他の図形がほのかに光る（D11）
    for (const o of shapes.values()) {
      if (o.note === e.note && o.group !== e.group) {
        o.resStep = e.step;
        o.resV = e.velocity;
      }
    }

    this.balls.look.set(e.ballId, { note: e.note, step: e.step, v: e.velocity, chain: e.chain });

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
        const t = shapes.get(g);
        if (t) t.replayAt = e.step + REPLAY_GAP * (i + 1);
      });
    }

    this.energyTarget = e.energy;
    this.energyStep = e.step;

    if (s && (this.params.flowers ?? true) && e.segKind !== 'bumper' && e.velocity >= 0.1) {
      this.vines.grow(s, e.step, e.x, e.y, e.velocity, this.params.colorMode === 'mono', this.params.flowerKind ?? 'mixed');
    }

    // 打点の波紋（circle は重心の輪で代える。square は短く小さく）
    if (e.velocity >= 0.25 && e.form !== 'circle') {
      const wood = e.form === 'square';
      this.ripples.push({
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
        case 'emit':
          this.emitters.emit(e);
          break;
        case 'emitters':
          this.emitters.set(e);
          break;
        case 'section':
          this.sectionStep = e.step;
          break;
        case 'shapeAdded':
          this.shapeView.add(e);
          break;
        case 'shapeEffect': {
          const s = this.shapeView.shapes.get(e.group);
          if (s) s.effect = e.effect;
          break;
        }
        case 'shapePose': {
          const s = this.shapeView.shapes.get(e.group);
          if (s) {
            s.theta0 = e.theta0;
            s.rotStartStep = e.rotStartStep;
            s.omega = e.omega;
          }
          break;
        }
        case 'shapeRemoved': {
          // 描く対象から外し、消える動きを付ける
          const s = this.shapeView.drop(e.group);
          if (!s) break;
          this.vines.forget(e.group);
          if (e.step !== removedStep) {
            stagger(removed);
            removed = [];
            removedStep = e.step;
          }
          removed.push(this.shapeView.die(s, e.step));
          break;
        }
      }
    }
    stagger(removed);
    if (n > 0) this.pending.splice(0, n);
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
    this.afterimage.bloom.strength = p.bloomStrength * (1 + 0.2 * this.energy);
    // 流れ落ちる残像（D31）: 流すときは残像を長めに残す
    const fo = this.flowOpts;
    fo.drip = p.drip ?? false;
    fo.dripSpeed = p.dripSpeed ?? 90;
    fo.damp = geometryTrail ? p.afterimage : LEGACY_DAMP;
    this.afterimage.set(dt, fo, innerWidth, innerHeight);

    const head = src.snapshot(Math.floor(rs));
    const mode = p.colorMode;
    this.balls.draw(src, rs, this.thick, mode, geometryTrail);
    this.shapeView.draw(rs, dt, preview, mode, p.idleLine, this.thick, this.pickR);
    this.ripples.draw(rs, mode);
    if (p.flowers ?? true) this.vines.draw(rs, this.shapeView.shapes, mode, this.thick);
    else this.vines.clear();
    this.glints.draw(rs, this.shapeView.shapes, mode);
    this.emitters.draw(rs, dt, this.sectionStep);
    const base = mode === 'mono' ? BACKDROP_MONO : BACKDROP_WATER;
    this.backdrop.draw(p.backdrop ?? 'none', {
      renderer: this.renderer, camera: this.camera, rs, dt, energy: this.energy, level: p.backdropLevel ?? 1, base, view: this.view,
    });
    const time = rs / HZ;
    this.hud.update(p.hud ?? false, time, this.scale, base);
    this.crosshair.update(p.crosshair ?? false, time, this.view, -this.camera.top, base);
    this.notes.update(p.noteNames ?? false, time, this.scale, base);
    this.scope.update(p.scope ?? false, time, this.scale, base);
    this.constellation.update(p.constellation ?? false, time, base);
    this.gc(head);

    this.composer.render(dt);
    const q = this.governor.update(dt);
    if (q) this.applyQuality(q);
  }

  /** 画面から消えたボールの見た目情報を掃除する */
  private gc(A: Snapshot | undefined): void {
    const look = this.balls.look;
    if (!A || look.size + this.ballPath.size <= 2 * A.count + 64) return;
    const alive = new Set(A.ids.subarray(0, A.count));
    for (const id of look.keys()) if (!alive.has(id)) look.delete(id);
    for (const id of this.ballPath.keys()) if (!alive.has(id)) this.ballPath.delete(id);
  }
}
