import { Matrix4, OrthographicCamera, Vector3, type Camera } from 'three';

// 3D の背景（D42、fibers / slices）で共通のもの。
// 立方体（-1..1）を、見えている範囲の真ん中に置き、アイソメトリック（平行投影で、縦軸まわり 45°・見下ろし 35.26°）で見る。
// 透視だと奥行きの向きがわかりにくかったので、3 つの面が同じだけ見える決まった角度にした。
// 当たった点は、立方体の真ん中を通って画面に平行な面に落とし、立方体の中の座標にする（回っていても、見たとおりの場所に当たる）。

/** アイソメトリックの角度 */
export const ISO_YAW = Math.PI / 4;
export const ISO_PITCH = Math.atan(1 / Math.SQRT2);

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
