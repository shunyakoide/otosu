import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, Group, LineBasicMaterial, LineSegments, Mesh,
  MeshBasicMaterial, PlaneGeometry, type Color,
} from 'three';

// 当たった点の計器の表示（D36、hud）。背景とは別に、Light の hud でオン・オフする。
// 当たった点に、正方形の細い枠（角の括弧 / 枠線）と座標の数字が点滅して出て、ゆっくり消える。
// 続けて当たると、前の表示と細い線でつながる。時刻は renderStep から取るので、止めると止まる。

/** 同時に出す数、出ている秒、次を出すまでの最短の間（秒） */
const MAX_HUD = 6;
const HUD_SEC = 1.6;
const HUD_GAP = 0.2;
/** 表示1つの大きさ（CSS px） */
const HUD_W = 200;
const HUD_H = 100;

type Item = { mesh: Mesh; canvas: HTMLCanvasElement; tex: CanvasTexture; at: number; x: number; y: number };

/** 当たった点の計器の表示 */
export class Hud {
  readonly object = new Group();
  private readonly items: Item[] = [];
  private head = 0;
  private last = -Infinity;
  /** 表示どうしをつなぐ線（j 番目 = 1つ前の表示から j 番目の表示へ） */
  private readonly links: LineSegments;
  private readonly linkFrom = new Float32Array(MAX_HUD * 2).fill(NaN);

  constructor() {
    const plane = new PlaneGeometry(1, 1);
    for (let i = 0; i < MAX_HUD; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = HUD_W * 2;
      canvas.height = HUD_H * 2;
      const tex = new CanvasTexture(canvas);
      const mesh = new Mesh(plane, new MeshBasicMaterial({
        map: tex, transparent: true, blending: AdditiveBlending, depthTest: false, depthWrite: false, opacity: 0,
      }));
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = -1;
      this.items.push({ mesh, canvas, tex, at: -Infinity, x: 0, y: 0 });
      this.object.add(mesh);
    }
    const lg = new BufferGeometry();
    lg.setAttribute('position', new BufferAttribute(new Float32Array(MAX_HUD * 2 * 3), 3));
    lg.setAttribute('color', new BufferAttribute(new Float32Array(MAX_HUD * 2 * 3), 3));
    this.links = new LineSegments(lg, new LineBasicMaterial({
      vertexColors: true, transparent: true, blending: AdditiveBlending, depthTest: false, depthWrite: false,
    }));
    this.links.frustumCulled = false;
    this.links.renderOrder = -1;
    this.object.add(this.links);
  }

  /** 当たった（ワールド座標、時刻は秒） */
  hit(x: number, y: number, at: number, strength: number): void {
    if (at - this.last < HUD_GAP) return;
    this.last = at;
    const prev = this.items[(this.head + MAX_HUD - 1) % MAX_HUD]!;
    const j = this.head;
    this.head = (j + 1) % MAX_HUD;
    const it = this.items[j]!;
    // 前の表示がまだ出ていれば、そこから線を引く
    const linked = at - prev.at < HUD_SEC * 0.7;
    this.linkFrom[j * 2] = linked ? prev.x : NaN;
    this.linkFrom[j * 2 + 1] = linked ? prev.y : NaN;
    Object.assign(it, { at, x, y });

    const g = it.canvas.getContext('2d')!;
    g.clearRect(0, 0, it.canvas.width, it.canvas.height);
    g.save();
    g.scale(2, 2);
    g.translate(HUD_W / 2, HUD_H / 2);
    g.strokeStyle = g.fillStyle = '#fff';
    g.lineWidth = 0.8;
    const r = 10 + 22 * Math.min(1, strength);
    // 形は当たるたびに変える: 正方形の角の括弧 / 正方形の枠線。真ん中に小さな正方形
    g.beginPath();
    if (Math.random() < 0.5) {
      const c = r * 0.35;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        g.moveTo(sx * r, sy * (r - c));
        g.lineTo(sx * r, sy * r);
        g.lineTo(sx * (r - c), sy * r);
      }
    } else {
      g.rect(-r, -r, r * 2, r * 2);
    }
    g.rect(-1.5, -1.5, 3, 3);
    g.stroke();
    g.font = '8px ui-monospace, Menlo, monospace';
    g.textBaseline = 'middle';
    g.globalAlpha = 0.85;
    g.fillText(`(X ${Math.round(x)} Y ${Math.round(y)})`, r + 6, -r * 0.6);
    g.restore();
    it.tex.needsUpdate = true;
  }

  /** 毎フレーム呼ぶ。time = 表示している時刻（秒）、scale = CSS px / ワールド px */
  update(on: boolean, time: number, scale: number, base: Color): void {
    this.object.visible = on;
    if (!on) return;
    const pos = this.links.geometry.getAttribute('position') as BufferAttribute;
    const col = this.links.geometry.getAttribute('color') as BufferAttribute;
    for (let j = 0; j < MAX_HUD; j++) {
      const it = this.items[j]!;
      const age = time - it.at;
      const live = age >= 0 && age < HUD_SEC;
      // 出るときに数回点滅して、あとはゆっくり消える
      const blink = age < 0.18 ? (Math.floor(age * 30) % 2 === 0 ? 1 : 0.25) : 1;
      const a = live ? blink * Math.pow(1 - age / HUD_SEC, 1.5) * 0.7 : 0;
      it.mesh.visible = a > 0.001;
      const m = it.mesh.material as MeshBasicMaterial;
      m.opacity = a;
      m.color.copy(base);
      it.mesh.position.set(it.x, -it.y, 0);
      it.mesh.scale.set(HUD_W / scale, HUD_H / scale, 1);

      const fx = this.linkFrom[j * 2]!;
      const fy = this.linkFrom[j * 2 + 1]!;
      const none = Number.isNaN(fx);
      const la = none ? 0 : a * 0.5;
      pos.setXYZ(j * 2, none ? it.x : fx, -(none ? it.y : fy), 0);
      pos.setXYZ(j * 2 + 1, it.x, -it.y, 0);
      col.setXYZ(j * 2, base.r * la, base.g * la, base.b * la);
      col.setXYZ(j * 2 + 1, base.r * la, base.g * la, base.b * la);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  dispose(): void {
    for (const it of this.items) {
      it.tex.dispose();
      (it.mesh.material as MeshBasicMaterial).dispose();
    }
    this.items[0]?.mesh.geometry.dispose();
    this.links.geometry.dispose();
    (this.links.material as LineBasicMaterial).dispose();
  }
}
