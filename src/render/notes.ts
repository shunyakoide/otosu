import {
  AdditiveBlending, CanvasTexture, Group, Mesh, MeshBasicMaterial, PlaneGeometry, type Color,
} from 'three';

// 当たった音の名前（D62、notes）。readout（D36）が「どこに当たったか」なら、こちらは「何が鳴ったか」。
// 当たった点に音名（E♭4 など）と MIDI の値が出て、上へ流れながら消える。chord で重ねた音は同じ表示に並べる。
// 時刻は renderStep から取るので、止めると止まる。

/** 同時に出す数、出ている秒、昇る距離（CSS px） */
const MAX_NOTES = 10;
const NOTE_SEC = 1.6;
const NOTE_RISE = 36;
/** 表示1つの大きさ（CSS px） */
const NOTE_W = 400;
const NOTE_H = 56;

const NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'] as const;

/** MIDI の音高 → 音名（C4 = 60。黒鍵は ♭ で書く: 曲に短調の A♭・E♭・B♭ があるため） */
export function noteName(midi: number): string {
  const m = Math.round(midi);
  return `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

type Item = {
  mesh: Mesh; canvas: HTMLCanvasElement; tex: CanvasTexture;
  at: number; x: number; y: number; step: number; group: number; names: string[]; midi: number; v: number; echo: number;
};

export type NoteHit = { x: number; y: number; step: number; group: number; midi: number; velocity: number; echo: number; voice: number };

export class Notes {
  readonly object = new Group();
  private readonly items: Item[] = [];
  private head = 0;

  constructor() {
    const plane = new PlaneGeometry(1, 1);
    for (let i = 0; i < MAX_NOTES; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = NOTE_W * 2;
      canvas.height = NOTE_H * 2;
      const tex = new CanvasTexture(canvas);
      const mesh = new Mesh(plane, new MeshBasicMaterial({
        map: tex, transparent: true, blending: AdditiveBlending, depthTest: false, depthWrite: false, opacity: 0,
      }));
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = -1;
      this.items.push({ mesh, canvas, tex, at: -Infinity, x: 0, y: 0, step: -1, group: -1, names: [], midi: 0, v: 0, echo: 0 });
      this.object.add(mesh);
    }
  }

  /** 当たった（ワールド座標、時刻は秒）。chord で重ねた音（voice > 0）は、同じ当たりの表示に書き足す */
  hit(e: NoteHit, at: number): void {
    if (e.voice > 0) {
      const last = this.items[(this.head + MAX_NOTES - 1) % MAX_NOTES]!;
      if (last.step === e.step && last.group === e.group) {
        last.names.push(noteName(e.midi));
        this.paint(last);
      }
      return;
    }
    const it = this.items[this.head]!;
    this.head = (this.head + 1) % MAX_NOTES;
    Object.assign(it, { at, x: e.x, y: e.y, step: e.step, group: e.group, names: [noteName(e.midi)], midi: e.midi, v: e.velocity, echo: e.echo });
    this.paint(it);
  }

  private paint(it: Item): void {
    const g = it.canvas.getContext('2d')!;
    g.clearRect(0, 0, it.canvas.width, it.canvas.height);
    g.save();
    g.scale(2, 2);
    g.fillStyle = g.strokeStyle = '#fff';
    g.textBaseline = 'alphabetic';
    // 左端を当たった点に置く。くり返し（echo / rise）は小さく、先頭に回数を付ける
    const x0 = NOTE_W / 2 + 8;
    const big = it.echo > 0 ? 13 : 20;
    g.font = `${big}px ui-monospace, Menlo, monospace`;
    const head = (it.echo > 0 ? `${'·'.repeat(it.echo)} ` : '') + it.names.join(' ');
    g.fillText(head, x0, NOTE_H / 2 + big * 0.35);
    g.globalAlpha = 0.7;
    g.font = '8px ui-monospace, Menlo, monospace';
    g.fillText(`MIDI ${it.midi}  VEL ${it.v.toFixed(2)}`, x0 + 1, NOTE_H / 2 + big * 0.35 + 12);
    // 当たった点から文字へ短い引き出し線
    g.globalAlpha = 0.6;
    g.lineWidth = 0.8;
    g.beginPath();
    g.moveTo(NOTE_W / 2, NOTE_H / 2);
    g.lineTo(x0 - 3, NOTE_H / 2);
    g.stroke();
    g.restore();
    it.tex.needsUpdate = true;
  }

  /** 毎フレーム呼ぶ。time = 表示している時刻（秒）、scale = CSS px / ワールド px */
  update(on: boolean, time: number, scale: number, base: Color): void {
    this.object.visible = on;
    if (!on) return;
    for (const it of this.items) {
      const age = time - it.at;
      const live = age >= 0 && age < NOTE_SEC;
      const q = live ? age / NOTE_SEC : 1;
      // 出るときは少し明るく、あとはゆっくり消える
      const a = live ? (0.55 + 0.45 * Math.max(0, 1 - age / 0.12)) * (1 - q) ** 1.3 * (it.echo > 0 ? 0.6 : 0.9) : 0;
      it.mesh.visible = a > 0.001;
      if (!it.mesh.visible) continue;
      const m = it.mesh.material as MeshBasicMaterial;
      m.opacity = a;
      m.color.copy(base);
      const rise = (NOTE_RISE * (1 - (1 - q) ** 2)) / scale;
      it.mesh.position.set(it.x, -it.y + rise, 0);
      it.mesh.scale.set(NOTE_W / scale, NOTE_H / scale, 1);
    }
  }

  dispose(): void {
    for (const it of this.items) {
      it.tex.dispose();
      (it.mesh.material as MeshBasicMaterial).dispose();
    }
    this.items[0]?.mesh.geometry.dispose();
  }
}
