// 背景（D33〜D43）のシェーダーで共通の GLSL。
// NOISE・NOISE3・NOISED は Inigo Quilez の勾配ノイズ・値ノイズをもとにしている:
//   NOISE   https://www.shadertoy.com/view/XdXGW8 (Noise - gradient - 2D)
//   NOISE3  https://www.shadertoy.com/view/4sfGzS (Noise - value - 3D)
//   NOISED  https://www.shadertoy.com/view/XsXfRH (Noise - value - 3D - deriv)
// その部分は次のライセンスに従う。
//
// The MIT License
// Copyright © 2013-2017 Inigo Quilez
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
// to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above
// copyright notice and this permission notice shall be included in all copies or substantial portions of the
// Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
// LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
// SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.

/** 画面いっぱいの四角（PlaneGeometry(2, 2) / FullScreenQuad）。vUv を渡す */
export const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/** 決まった値の乱数 0..1 */
export const RAND = /* glsl */ `
float rand(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
`;

/** 2D の勾配ノイズ（-1..1 前後）と rand */
export const NOISE = /* glsl */ `
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453);
}
${RAND}float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dot(hash2(i), f), dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
             mix(dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), dot(hash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x), u.y);
}
`;

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
