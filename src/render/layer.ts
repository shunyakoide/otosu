import type { BufferGeometry, Material, Vector2, Vector4 } from 'three';
import type { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// 背景の層（D33〜D43）で共通の部品。

/** 形と素材を捨てる（Mesh / LineSegments / Points） */
export function disposeMesh(o: { geometry: BufferGeometry; material: Material | Material[] }): void {
  o.geometry.dispose();
  (o.material as Material).dispose();
}

/** FullScreenQuad.dispose は形しか捨てないので、素材も捨てる */
export function disposeQuad(q: FullScreenQuad): void {
  (q.material as Material).dispose();
  q.dispose();
}

// 背景が覚えておく、最近の当たりのリングバッファ。
// 位置（層ごとの座標）、時刻（秒）、強さ、音の高さを持ち、毎フレーム経過秒にしてシェーダーの hits に渡す。
// 消えた（HIT_SEC を過ぎた・まだ来ていない）当たりは経過 0・強さ 0 で渡す（シェーダーは強さ ≤ 0 を飛ばす）。
// 色・形などの層ごとの値は、push の返す番号で層の側が持つ。

export class HitRing {
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** 3D の層（立方体の中の座標）だけ使う */
  readonly z: Float32Array;
  readonly at: Float64Array;
  readonly v: Float32Array;
  /** 音の高さ 0..1 */
  readonly pitch: Float32Array;
  readonly size: number;
  private readonly sec: number;
  private head = 0;

  /** size = 覚えておく数、sec = 消えるまで（秒） */
  constructor(size: number, sec: number) {
    this.size = size;
    this.sec = sec;
    this.x = new Float32Array(size);
    this.y = new Float32Array(size);
    this.z = new Float32Array(size);
    this.at = new Float64Array(size).fill(-Infinity);
    this.v = new Float32Array(size);
    this.pitch = new Float32Array(size);
  }

  /** 次の枠（いちばん古い当たり）に書く。返り値は書いた枠の番号 */
  push(x: number, y: number, z: number, at: number, v: number, pitch: number): number {
    const i = this.head;
    this.head = (i + 1) % this.size;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.at[i] = at;
    this.v[i] = v;
    this.pitch[i] = pitch;
    return i;
  }

  /** hits[i] = (x, y, 経過秒, 強さ) */
  fill(hits: Vector4[], time: number): void {
    for (let i = 0; i < this.size; i++) {
      const age = time - this.at[i]!;
      const live = age >= 0 && age < this.sec;
      hits[i]!.set(this.x[i]!, this.y[i]!, live ? age : 0, live ? this.v[i]! : 0);
    }
  }

  /** 3D の層: hits[i] = (x, y, z, 経過秒)、hitsV[i] = (強さ, 音の高さ) */
  fill3(hits: Vector4[], hitsV: Vector2[], time: number): void {
    for (let i = 0; i < this.size; i++) {
      const age = time - this.at[i]!;
      const live = age >= 0 && age < this.sec;
      hits[i]!.set(this.x[i]!, this.y[i]!, this.z[i]!, live ? age : 0);
      hitsV[i]!.set(live ? this.v[i]! : 0, this.pitch[i]!);
    }
  }
}
