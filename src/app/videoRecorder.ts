// 描画と内蔵音をページの中で動画に書き出す（D70）。
// iOS の画面収録では Web Audio の音が雑音になる（Safari 側の問題。<audio> 要素の音はきれいに録れる）ので、
// キャンバスの映像とリミッターの後の音を MediaRecorder で1本にまとめる。ツールバーなどの HTML の UI は映らない。

/** 使える最初の形式で書き出す。iOS の Safari は mp4 だけ */
const MIME_TYPES = [
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];
const FPS = 30;
/** 粒や網点は圧縮で潰れやすいので多めに */
const VIDEO_BPS = 8_000_000;
const AUDIO_BPS = 192_000;

export type RecorderState = 'idle' | 'recording' | 'ready';

export class VideoRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private file: File | null = null;
  state: RecorderState = 'idle';
  onChange: (state: RecorderState) => void = () => {};

  private readonly canvas: HTMLCanvasElement;
  private readonly audioStream: () => MediaStream | null;

  constructor(canvas: HTMLCanvasElement, audioStream: () => MediaStream | null) {
    this.canvas = canvas;
    this.audioStream = audioStream;
  }

  static supported(): boolean {
    return typeof MediaRecorder !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
  }

  /** 書き出しを始める。音が始まっていないなど、始められないときは理由を返す */
  start(): string | null {
    if (this.state === 'recording') return null;
    const audio = this.audioStream();
    if (!audio) return 'start the sound first';
    const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    if (!mimeType) return 'recording is not supported in this browser';
    const stream = new MediaStream([...this.canvas.captureStream(FPS).getVideoTracks(), ...audio.getAudioTracks()]);
    this.chunks = [];
    this.file = null;
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: VIDEO_BPS, audioBitsPerSecond: AUDIO_BPS });
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    rec.onstop = () => {
      // 映像のトラックだけ止める（音のトラックは次の録画でも使う）
      for (const t of stream.getVideoTracks()) t.stop();
      const type = rec.mimeType || mimeType;
      this.file = new File(this.chunks, fileName(type), { type });
      this.chunks = [];
      this.set('ready');
    };
    // 長く録ってもメモリに一度に溜めないよう、1 秒ごとに受け取る
    rec.start(1000);
    this.rec = rec;
    this.set('recording');
    return null;
  }

  stop(): void {
    if (this.state !== 'recording' || !this.rec) return;
    this.rec.stop();
    this.rec = null;
  }

  /**
   * 書き出した動画を保存する。タッチの端末は共有シート（写真に保存できる）、それ以外はダウンロード。
   * 共有シートはタップの中でしか開けないので、ボタンの click から呼ぶ
   */
  async save(): Promise<void> {
    const file = this.file;
    if (!file) return;
    const touch = matchMedia('(hover: none)').matches;
    if (touch && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
      } catch (err) {
        // 共有シートを閉じただけなら、もう一度押せるよう残しておく
        if (err instanceof DOMException && err.name === 'AbortError') return;
        throw err;
      }
    } else {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    this.file = null;
    this.set('idle');
  }

  /** 保存しないで捨てる */
  discard(): void {
    this.file = null;
    if (this.state === 'ready') this.set('idle');
  }

  private set(state: RecorderState): void {
    this.state = state;
    this.onChange(state);
  }
}

function fileName(mimeType: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `otosu-${stamp}.${mimeType.startsWith('video/mp4') ? 'mp4' : 'webm'}`;
}
