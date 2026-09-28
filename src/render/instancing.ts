import {
  AdditiveBlending, CustomBlending, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, MaxEquation, MeshBasicMaterial, Object3D,
  OneFactor, type BufferGeometry, type Color,
} from 'three';

// 前景（ボール・尾・図形の線・波紋・蔦など）の描き方で共通のもの。どれもインスタンスで描き、毎フレーム書いた数だけ送る。

export function additive(): MeshBasicMaterial {
  return new MeshBasicMaterial({
    blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
  });
}

export function maxBlend(): MeshBasicMaterial {
  return new MeshBasicMaterial({
    blending: CustomBlending, blendEquation: MaxEquation, blendSrc: OneFactor, blendDst: OneFactor,
    transparent: true, depthTest: false, depthWrite: false,
  });
}

export function instanced(geo: BufferGeometry, count: number, order: number, mat = additive()): InstancedMesh {
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
export function commit(mesh: InstancedMesh, n: number, extra: InstancedBufferAttribute[] = []): void {
  mesh.count = n;
  if (n === 0) return;
  for (const a of [mesh.instanceMatrix, mesh.instanceColor!, ...extra]) {
    a.clearUpdateRanges();
    a.addUpdateRange(0, n * a.itemSize);
    a.needsUpdate = true;
  }
}

/** a → b を結ぶ幅 width のクアッドを i 番目に置く（ワールドの y 下向きのまま渡す） */
export function putQuad(
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

const dummy = new Object3D();

/** 半径 r の円（輪）を (x, y) に置く（ワールドの y 下向きのまま渡す）。angle は描く座標（y 上向き）での回転 */
export function putDisc(mesh: InstancedMesh, i: number, x: number, y: number, r: number, c: Color, angle = 0): void {
  dummy.position.set(x, -y, 0);
  dummy.rotation.set(0, 0, angle);
  dummy.scale.set(r, r, 1);
  dummy.updateMatrix();
  mesh.setMatrixAt(i, dummy.matrix);
  mesh.setColorAt(i, c);
}
