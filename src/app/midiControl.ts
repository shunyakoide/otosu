import { Midi } from '../midi/midi';
import { HZ } from '../sim/constants';
import type { Sim } from '../sim/sim';
import type { Section } from '../ui/panel';
import type { Params } from './params';
import type { EngineState } from './state';
import { download, stamp } from '../util';

// MIDI の出力と .mid の録音（D10, D19）。settings の MIDI の区切りもここで作る。

const RECORD_LABEL = '● record .mid';
const STOP_LABEL = '■ stop & save .mid';

export class MidiControl {
  readonly midi: Midi;
  private outputs: { id: string; name: string }[] = [];
  private connectBtn: HTMLButtonElement | null = null;
  private recordBtn: HTMLButtonElement | null = null;
  private readonly params: Params;
  private readonly state: EngineState;
  private readonly sim: Sim;

  constructor(params: Params, state: EngineState, sim: Sim) {
    this.params = params;
    this.state = state;
    this.sim = sim;
    this.midi = new Midi({
      get channel() { return params.midiChannel; },
      get drumChannel() { return params.midiDrumChannel; },
      get noteLength() { return params.midiNoteLength; },
      get offsetMs() { return params.midiOffsetMs; },
    });
  }

  /** settings の MIDI の区切り。onConnected は出力の一覧が変わったとき（表示を合わせる用） */
  fill(pane: Section, onConnected: () => void): void {
    const { params, midi } = this;
    pane.toggle(params, 'internalSound', 'built-in');
    pane.select(params, 'midiOutput', 'output', () => [{ value: '', label: '(none)' }, ...this.outputs.map((o) => ({ value: o.id, label: o.name }))], (id) => midi.select(id || null));
    pane.slider(params, 'midiChannel', { label: 'channel', min: 1, max: 16, step: 1, onChange: () => midi.allNotesOff() });
    pane.slider(params, 'midiDrumChannel', { label: 'drums ○ □', min: 1, max: 16, step: 1, onChange: () => midi.allNotesOff() });
    pane.slider(params, 'midiNoteLength', { label: 'note length', min: 0.05, max: 2, step: 0.05, format: (v) => `${v.toFixed(2)} s` });
    pane.slider(params, 'midiOffsetMs', { label: 'offset', min: -100, max: 200, step: 1, format: (v) => `${v} ms` });
    [this.connectBtn, this.recordBtn] = pane.actions([
      { label: 'connect', onClick: () => void this.connect().then(onConnected) },
      { label: RECORD_LABEL, title: 'record to a MIDI file (R)', onClick: () => this.toggleRecording() },
    ]) as [HTMLButtonElement, HTMLButtonElement];
  }

  private async connect(): Promise<void> {
    const { params, midi } = this;
    let label: string;
    try {
      this.outputs = await midi.connect();
      const iac = this.outputs.find((o) => /IAC/i.test(o.name));
      if (!params.midiOutput && iac) params.midiOutput = iac.id;
      midi.select(params.midiOutput || null);
      label = this.outputs.length ? `connected (${this.outputs.length})` : 'no outputs found';
    } catch (err) {
      console.warn('[otosu] MIDI', err);
      label = Midi.supported ? 'permission denied' : 'unsupported (use Chrome)';
    }
    if (this.connectBtn) this.connectBtn.textContent = label;
  }

  toggleRecording(): void {
    if (!this.state.started) return;
    const { midi, sim } = this;
    if (!midi.isRecording) {
      // 次の拍の頭から記録する（DAW で小節線が合うように）
      const em = sim.emitters[0];
      const spb = (HZ * 60) / sim.bpm;
      const anchor = em ? em.anchorStep : 0;
      const start = anchor + Math.ceil((sim.step - anchor) / spb) * spb;
      midi.startRecording(start, sim.bpm);
      this.showRecording(true);
      return;
    }
    const data = midi.stopRecording();
    this.showRecording(false);
    if (!data) return;
    download(new Blob([data as BlobPart], { type: 'audio/midi' }), `otosu-${stamp()}.mid`);
  }

  /** 録音中なら、そこまでを保存して止める（テンポを変える・配置を読み込むとき。小節線が崩れるので。D10） */
  stopRecording(): void {
    if (this.midi.isRecording) this.toggleRecording();
  }

  private showRecording(on: boolean): void {
    if (!this.recordBtn) return;
    this.recordBtn.textContent = on ? STOP_LABEL : RECORD_LABEL;
    this.recordBtn.classList.toggle('rec', on);
  }
}
