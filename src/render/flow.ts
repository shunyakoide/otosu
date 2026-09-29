import {
  HalfFloatType, LinearFilter, NoBlending, ShaderMaterial, UniformsUtils, Vector2, WebGLRenderTarget, type Texture, type WebGLRenderer,
} from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { LuminosityHighPassShader } from 'three/addons/shaders/LuminosityHighPassShader.js';
import { disposeQuad } from './layer';

// 残像（D31）。AfterimagePass と同じく前の絵を少し暗くして重ねる。
// drip をオンにすると、明るいところ（ボール・当たった光）だけを入れ、前の絵を少し上から読んで重ねるので、
// 当たった図形から光が垂れて流れ落ちる。流れる速さは数 px 幅の列ごとに違い、横にゆらぐ（水の筋に見えるように）。
// オフなら AfterimagePass と同じ見た目。
//
// 後処理の残り（グローと画面への書き出し）もここでまとめて描く（D65）。
// 以前は 残像 → 見せる絵 → UnrealBloomPass（元の絵に足し戻す）→ OutputPass と、全画面を 4 回書いていた。
// 見せる絵を作らずに、グローの明るいところの抜き出し（半分の解像度）と最後の書き出しで、その場で組み立てる。
// 全画面を書くのは 残像の蓄積と最後の書き出しの 2 回だけになる。見た目は同じ。

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

// 見せる絵: 今の絵と、残像（drip のときは薄く）の明るいほう
const SHOWN = /* glsl */ `
uniform sampler2D tNew;
uniform sampler2D tComp;
uniform float shown;
vec4 shownAt(vec2 uv) {
  return max(texture2D(tNew, uv), texture2D(tComp, uv) * shown);
}`;

// グローの明るいところの抜き出し（LuminosityHighPassShader と同じ。見せる絵から直接読む）
const BRIGHT = /* glsl */ `
${SHOWN}
uniform vec3 defaultColor;
uniform float defaultOpacity;
uniform float luminosityThreshold;
uniform float smoothWidth;
varying vec2 vUv;
void main() {
  vec4 texel = shownAt(vUv);
  float v = luminance(texel.xyz);
  float alpha = smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, v);
  gl_FragColor = mix(vec4(defaultColor.rgb, defaultOpacity), texel, alpha);
}`;

// 画面へ: 見せる絵にグローを足し、トーンマップして出力の色空間にする（OutputPass と同じ）。
// 画面に描くときは three がレンダラーの設定のトーンマップと色空間の関数を足すので、それを呼ぶだけ
const OUTPUT = /* glsl */ `
${SHOWN}
uniform sampler2D tBloom;
varying vec2 vUv;
void main() {
  gl_FragColor = shownAt(vUv) + texture2D(tBloom, vUv);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
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
    res: { value: new Vector2(1, 1) },
  };
  private readonly show = {
    tNew: { value: null as Texture | null },
    tComp: { value: null as Texture | null },
    shown: { value: 1 },
  };
  private comp = target();
  private old = target();
  private readonly accumQuad = new FullScreenQuad(new ShaderMaterial({ uniforms: this.u, vertexShader: CopyShader.vertexShader, fragmentShader: ACCUM }));
  /** グロー。ぼかしは UnrealBloomPass に任せ、明るいところの抜き出しを差し替え、最後の足し戻しは使わない */
  readonly bloom: UnrealBloomPass;
  /** UnrealBloomPass は最後に入力へ足し戻すので、その先を 1×1 のダミーにする */
  private readonly sink = new WebGLRenderTarget(1, 1, { depthBuffer: false });
  private readonly out = { ...this.show, tBloom: { value: null as Texture | null } };
  private readonly outQuad = new FullScreenQuad(new ShaderMaterial({
    uniforms: this.out,
    vertexShader: CopyShader.vertexShader,
    fragmentShader: OUTPUT,
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
  }));

  constructor(strength: number, radius: number, threshold: number) {
    super();
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), strength, radius, threshold);
    const bright = { ...UniformsUtils.clone(LuminosityHighPassShader.uniforms), ...this.show };
    Object.assign(bright, { luminosityThreshold: { value: threshold }, smoothWidth: { value: 0.01 } });
    this.bloom.highPassUniforms = bright;
    this.bloom.materialHighPassFilter.dispose();
    this.bloom.materialHighPassFilter = new ShaderMaterial({
      uniforms: bright, vertexShader: LuminosityHighPassShader.vertexShader, fragmentShader: BRIGHT,
    });
  }

  /** 毎フレーム呼ぶ。w, h は画面の大きさ（CSS px） */
  set(dt: number, o: FlowOptions, w: number, h: number): void {
    const u = this.u;
    u.time.value += dt;
    u.res.value.set(w, h);
    u.damp.value = (o.drip ? Math.max(o.damp, DRIP_DAMP) : o.damp) ** (dt * 60);
    u.gate.value = o.drip ? 1 : 0;
    u.shift.value = o.drip ? (o.dripSpeed * dt) / h : 0;
    u.streak.value = o.drip ? DRIP_STREAK : 0;
    u.sway.value = o.drip && dt > 0 ? DRIP_SWAY / w : 0;
    this.show.shown.value = o.drip ? DRIP_SHOWN : 1;
  }

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget, dt: number): void {
    this.u.tOld.value = this.old.texture;
    this.u.tNew.value = readBuffer.texture;
    renderer.setRenderTarget(this.comp);
    this.accumQuad.render(renderer);
    // 見せる絵（今の絵と残像）は、グローの抜き出しと最後の書き出しがそれぞれその場で作る
    this.show.tNew.value = readBuffer.texture;
    this.show.tComp.value = this.comp.texture;
    this.bloom.render(renderer, null as unknown as WebGLRenderTarget, this.sink, dt, false);
    this.out.tBloom.value = this.bloom.renderTargetsHorizontal[0]!.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.outQuad.render(renderer);
    [this.old, this.comp] = [this.comp, this.old];
  }

  override setSize(width: number, height: number): void {
    this.comp.setSize(width, height);
    this.old.setSize(width, height);
    this.bloom.setSize(width, height);
  }

  override dispose(): void {
    this.comp.dispose();
    this.old.dispose();
    this.sink.dispose();
    this.bloom.dispose();
    disposeQuad(this.accumQuad);
    disposeQuad(this.outQuad);
  }
}
