import { HZ } from '../sim/constants';
import type { HitEvent } from '../sim/types';
import { writeSmf, type SmfNote } from './smf';

// ステップ3: MIDI 出力（decisions.md D10）。
// - ライブ: Web MIDI で外部（Mac は IAC Driver → GarageBand / DAW）へ。note on は内蔵音と同じ時刻に予約送信する
// - 録音: 衝突を step 基準で記録し、.mid として書き出す（Web MIDI 非対応のブラウザでも使える）

export type MidiParams = {
  channel: number;
  noteLength: number;
  offsetMs: number;
};

type PendingOff = { at: number; key: number; note: number; channel: number; onAt: number };

/** AudioContext 時刻 → performance.now 時刻の対応（出力遅延込み = 内蔵音が聞こえる時刻） */
export type TimeMap = (audioTime: number) => number;

export class Midi {
  private access: MIDIAccess | null = null;
  private output: MIDIOutput | null = null;
  /** (チャンネル, 音高) ごとの最後の note on 時刻（performance.now 基準）。連打で古い note off が新しい音を切らないように */
  private readonly lastOn = new Map<number, number>();
  private offs: PendingOff[] = [];

  private recording = false;
  private recStartStep = 0;
  private recNotes: SmfNote[] = [];
  private recBpm = 90;

  private readonly params: MidiParams;

  constructor(params: MidiParams) {
    this.params = params;
  }

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  }

  /** 出力ポートの一覧を取得する（ブラウザの許可ダイアログが出る） */
  async connect(): Promise<{ id: string; name: string }[]> {
    if (!Midi.supported) throw new Error('Web MIDI is not supported in this browser');
    this.access ??= await navigator.requestMIDIAccess();
    return this.outputs();
  }

  outputs(): { id: string; name: string }[] {
    if (!this.access) return [];
    return [...this.access.outputs.values()].map((o) => ({ id: o.id, name: o.name ?? o.id }));
  }

  select(id: string | null): void {
    this.allNotesOff();
    this.output = (id && this.access?.outputs.get(id)) || null;
  }

  get connected(): boolean {
    return this.output !== null;
  }

  private velocityOf(e: HitEvent): number {
    return Math.min(127, Math.max(1, Math.round(e.velocity * 127)));
  }

  /** 録音にだけ入れる（遅れて捨てた衝突も step 基準で正しい位置に記録できる） */
  record(e: HitEvent): void {
    if (!this.recording) return;
    this.recNotes.push({
      time: (e.step - this.recStartStep) / HZ,
      duration: this.params.noteLength,
      note: e.midi,
      velocity: this.velocityOf(e),
      channel: this.params.channel,
    });
  }

  /** ライブで送る。audioTime は内蔵音の発音時刻（AudioContext 時刻） */
  play(e: HitEvent, audioTime: number, toPerf: TimeMap): void {
    const out = this.output;
    if (!out) return;
    const ch = (this.params.channel - 1) & 0x0f;
    const key = (ch << 7) | e.midi;
    const at = Math.max(performance.now(), toPerf(audioTime) + this.params.offsetMs);
    const prev = this.lastOn.get(key);
    if (prev !== undefined && prev <= at) {
      // 同じ音が鳴っている最中の再発音: 直前で切ってから鳴らす
      out.send([0x80 | ch, e.midi, 0], Math.max(performance.now(), at - 1));
    }
    out.send([0x90 | ch, e.midi, this.velocityOf(e)], at);
    this.lastOn.set(key, at);
    this.offs.push({ at: at + this.params.noteLength * 1000, key, note: e.midi, channel: ch, onAt: at });
  }

  /** 毎フレーム呼ぶ。期限の来た note off を送る（予約送信にすると、連打した新しい音まで切ってしまうため） */
  update(): void {
    if (!this.offs.length) return;
    const now = performance.now();
    const keep: PendingOff[] = [];
    for (const o of this.offs) {
      if (o.at > now) {
        keep.push(o);
        continue;
      }
      // その後に同じ音が鳴り直していれば、この note off は送らない
      if (this.lastOn.get(o.key) === o.onAt) {
        this.output?.send([0x80 | o.channel, o.note, 0]);
        this.lastOn.delete(o.key);
      }
    }
    this.offs = keep;
  }

  allNotesOff(): void {
    const out = this.output;
    this.offs = [];
    this.lastOn.clear();
    if (!out) return;
    for (let ch = 0; ch < 16; ch++) out.send([0xb0 | ch, 123, 0]);
  }

  // ---- 録音 ----

  get isRecording(): boolean {
    return this.recording;
  }

  /** startStep は拍の頭に揃えたステップ（DAW で小節線が合うように） */
  startRecording(startStep: number, bpm: number): void {
    this.recording = true;
    this.recStartStep = startStep;
    this.recBpm = bpm;
    this.recNotes = [];
  }

  /** 録音を止めて SMF を返す。1音もなければ null */
  stopRecording(): Uint8Array | null {
    this.recording = false;
    const notes = this.recNotes.filter((n) => n.time >= 0);
    this.recNotes = [];
    return notes.length ? writeSmf(notes, this.recBpm) : null;
  }
}
