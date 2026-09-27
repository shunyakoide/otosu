import { HalfFloatType, LinearFilter, NoBlending, ShaderMaterial, WebGLRenderTarget, type Texture, type WebGLRenderer } from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';

// 残像（D31）。AfterimagePass と同じく前の絵を少し暗くして重ねる。
// drip をオンにすると、明るいところ（ボール・当たった光）だけを入れ、前の絵を少し上から読んで重ねるので、
// 当たった図形から光が垂れて流れ落ちる。流れる速さは数 px 幅の列ごとに違い、横にゆらぐ（水の筋に見えるように）。
// オフなら AfterimagePass と同じ見た目。

export type FlowOptions = {
  drip: boolean;
  /** 流れ落ちる速さ（px/s） */
  dripSpeed: number;
  /** 残像の残り方（60fps の1フレームあたり） */
  damp: number;
};

/** この明るさ（輝度）から流れに入り始め、GATE_HI で全部入る */
const GATE_LO = '0.45';
const GATE_HI = '0.95';
/** drip の残像の残り方の下限（60fps の1フレームあたり）、見せる明るさ、列ごとの速さの違い、横ゆれ（px） */
const DRIP_DAMP = 0.97;
const DRIP_SHOWN = 0.55;
const DRIP_STREAK = 0.9;
const DRIP_SWAY = 0.8;

// 入れるもの（今の絵）と、前の絵を少しずらして暗くしたものの明るいほう
const ACCUM = /* glsl */ `
uniform sampler2D tOld;
uniform sampler2D tNew;
uniform float damp;
uniform float gate;    // 1: 明るいところだけを入れる
uniform float shift;   // 1フレームで流れる量（uv）
uniform float streak;  // 列ごとの速さの違い
uniform float sway;    // 横ゆれの幅（uv）
uniform float time;
uniform vec2 res;      // 画面の大きさ（CSS px）
varying vec2 vUv;

float hash(float n) { return fract(sin(n) * 43758.5453); }
float noise(float x) {
  float i = floor(x), f = fract(x);
  return mix(hash(i), hash(i + 1.0), f * f * (3.0 - 2.0 * f));
}

void main() {
  vec4 src = texture2D(tNew, vUv);
  float luma = dot(src.rgb, vec3(0.2126, 0.7152, 0.0722));
  src *= mix(1.0, smoothstep(${GATE_LO}, ${GATE_HI}, luma), gate);
  float col = vUv.x * res.x;
  float speed = 1.0 + streak * (noise(col / 7.0 + time * 0.15) * noise(col / 31.0 - time * 0.05) * 2.0 - 0.5);
  float dx = sway * (noise(vUv.y * res.y / 40.0 + time * 0.8) - 0.5);
  vec4 old = texture2D(tOld, vUv + vec2(dx, shift * speed));
  // 暗くなった残りは切る（半精度で薄い影がいつまでも残らないように）
  old *= damp * step(0.02, max(old.r, max(old.g, old.b)));
  gl_FragColor = max(src, old);
}`;

// 画面へ: 今の絵と、残像（drip のときは薄く）の明るいほう
const SHOW = /* glsl */ `
uniform sampler2D tNew;
uniform sampler2D tComp;
uniform float shown;
varying vec2 vUv;
void main() {
  gl_FragColor = max(texture2D(tNew, vUv), texture2D(tComp, vUv) * shown);
}`;

const target = () =>
  // ずらして読むので線形で補間する（なめらかに流れ、筋が少しにじむ）
  new WebGLRenderTarget(1, 1, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false });

export class FlowPass extends Pass {
  private readonly u = {
    tOld: { value: null as Texture | null },
    tNew: { value: null as Texture | null },
    damp: { value: 0.9 },
    gate: { value: 0 },
    shift: { value: 0 },
    streak: { value: 0 },
    sway: { value: 0 },
    time: { value: 0 },
    res: { value: [1, 1] },
  };
  private readonly show = {
    tNew: { value: null as Texture | null },
    tComp: { value: null as Texture | null },
    shown: { value: 1 },
  };
  private comp = target();
  private old = target();
  private readonly accumQuad = new FullScreenQuad(new ShaderMaterial({ uniforms: this.u, vertexShader: CopyShader.vertexShader, fragmentShader: ACCUM }));
  private readonly showQuad = new FullScreenQuad(new ShaderMaterial({
    uniforms: this.show,
    vertexShader: CopyShader.vertexShader,
    fragmentShader: SHOW,
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
  }));

  /** 毎フレーム呼ぶ。w, h は画面の大きさ（CSS px） */
  set(dt: number, o: FlowOptions, w: number, h: number): void {
    const u = this.u;
    u.time.value += dt;
    u.res.value = [w, h];
    u.damp.value = Math.pow(o.drip ? Math.max(o.damp, DRIP_DAMP) : o.damp, dt * 60);
    u.gate.value = o.drip ? 1 : 0;
    u.shift.value = o.drip ? (o.dripSpeed * dt) / h : 0;
    u.streak.value = o.drip ? DRIP_STREAK : 0;
    u.sway.value = o.drip && dt > 0 ? DRIP_SWAY / w : 0;
    this.show.shown.value = o.drip ? DRIP_SHOWN : 1;
  }

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    this.u.tOld.value = this.old.texture;
    this.u.tNew.value = readBuffer.texture;
    renderer.setRenderTarget(this.comp);
    this.accumQuad.render(renderer);
    this.show.tNew.value = readBuffer.texture;
    this.show.tComp.value = this.comp.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (!this.renderToScreen && this.clear) renderer.clear();
    this.showQuad.render(renderer);
    [this.old, this.comp] = [this.comp, this.old];
  }

  override setSize(width: number, height: number): void {
    this.comp.setSize(width, height);
    this.old.setSize(width, height);
  }

  override dispose(): void {
    this.comp.dispose();
    this.old.dispose();
    (this.accumQuad.material as ShaderMaterial).dispose();
    (this.showQuad.material as ShaderMaterial).dispose();
    this.accumQuad.dispose();
    this.showQuad.dispose();
  }
}
