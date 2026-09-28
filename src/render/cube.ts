import { Matrix4, OrthographicCamera, Vector3, type Camera } from 'three';

// 3D の背景（D42、fibers / slices）で共通のもの。
// 立方体（-1..1）を、見えている範囲の真ん中に置き、アイソメトリック（平行投影で、縦軸まわり 45°・見下ろし 35.26°）で見る。
// 透視だと奥行きの向きがわかりにくかったので、3 つの面が同じだけ見える決まった角度にした。
// 当たった点は、立方体の真ん中を通って画面に平行な面に落とし、立方体の中の座標にする（回っていても、見たとおりの場所に当たる）。

/** アイソメトリックの角度 */
export const ISO_YAW = Math.PI / 4;
export const ISO_PITCH = Math.atan(1 / Math.SQRT2);

/** 3D のノイズ（-1..1） */
export const NOISE3 = /* glsl */ `
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise3(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return 2.0 * mix(
    mix(mix(hash3(i), hash3(i + vec3(1.0, 0.0, 0.0)), f.x), mix(hash3(i + vec3(0.0, 1.0, 0.0)), hash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0.0, 0.0, 1.0)), hash3(i + vec3(1.0, 0.0, 1.0)), f.x), mix(hash3(i + vec3(0.0, 1.0, 1.0)), hash3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z) - 1.0;
}
`;

/** 値のノイズと、その傾き（NOISE3 のあとに置く） */
export const NOISED = /* glsl */ `
// 値のノイズと、その傾き（0..1, 傾き）
vec4 noised(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  vec3 u = f * f * (3.0 - 2.0 * f);
  vec3 du = 6.0 * f * (1.0 - f);
  float a = hash3(i), b = hash3(i + vec3(1.0, 0.0, 0.0)), c = hash3(i + vec3(0.0, 1.0, 0.0)), d = hash3(i + vec3(1.0, 1.0, 0.0));
  float e = hash3(i + vec3(0.0, 0.0, 1.0)), g = hash3(i + vec3(1.0, 0.0, 1.0)), h = hash3(i + vec3(0.0, 1.0, 1.0)), k = hash3(i + vec3(1.0, 1.0, 1.0));
  float k1 = b - a, k2 = c - a, k3 = e - a, k4 = a - b - c + d, k5 = a - c - e + h, k6 = a - b - e + g, k7 = -a + b + c - d + e - g - h + k;
  return vec4(a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z,
    du * vec3(k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z, k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x, k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y));
}
`;

/** 立方体を見るカメラ */
export class CubeView {
  /** 立方体の中の座標 → クリップ座標 / カメラの座標 */
  readonly mvp = new Matrix4();
  readonly mv = new Matrix4();
  /** 投影行列の縦の倍率（太さを px にするのに使う） */
  focal = 1;
  /** カメラから立方体の真ん中まで */
  readonly dist = 5;
  private readonly cam = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private readonly model = new Matrix4();
  private readonly inv = new Matrix4();
  private readonly tmp = new Matrix4();
  private readonly v = new Vector3();
  private world: Camera | null = null;

  /**
   * aspect = 横 / 縦。fit = 立方体の辺の半分が、見えている範囲の短いほうの半分に占める割合。
   * world = 画面のカメラ（当たった点を画面の位置にするのに使う）
   */
  update(aspect: number, yaw: number, pitch: number, fit: number, world: Camera): void {
    // 見えている範囲の半分（短いほうが 1 / fit）
    const h = 1 / (fit * Math.min(1, aspect));
    const c = this.cam;
    c.top = h;
    c.bottom = -h;
    c.right = h * aspect;
    c.left = -h * aspect;
    c.near = this.dist - 3;
    c.far = this.dist + 3;
    c.position.set(0, 0, this.dist);
    c.updateMatrixWorld();
    c.updateProjectionMatrix();
    this.model.makeRotationX(pitch).multiply(this.tmp.makeRotationY(yaw));
    this.inv.copy(this.model).transpose();
    this.mv.multiplyMatrices(c.matrixWorldInverse, this.model);
    this.mvp.multiplyMatrices(c.projectionMatrix, this.mv);
    this.focal = c.projectionMatrix.elements[5]!;
    this.world = world;
  }

  /** 当たった点（ワールド）を立方体の中の座標へ */
  toLocal(x: number, y: number, out: Vector3): Vector3 {
    if (!this.world) return out.set(0, 0, 0);
    const n = this.v.set(x, -y, 0).project(this.world);
    return out.set(n.x * this.cam.right, n.y * this.cam.top, 0).applyMatrix4(this.inv);
  }

  /** 見ている向き（カメラへ向かう向き）を立方体の中の座標で */
  axis(out: Vector3): Vector3 {
    return out.set(0, 0, 1).applyMatrix4(this.inv);
  }
}
