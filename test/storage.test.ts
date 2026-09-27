import { describe, expect, it } from 'vitest';
import { libraryNames, pickPrefs, sceneFromFile, sceneToFile } from '../src/ui/storage';
import type { SceneData } from '../src/sim/types';

const scene: SceneData = {
  v: 2, bpm: 90, pattern: [2, 3], rotate: false, rotationSpeed: 0.3,
  drift: { mode: 'drift', amp: 24 }, shapes: [['line', 1, false, 100, 200, 400, 260]], forms: ['line'],
};

describe('ui storage (D24)', () => {
  it('keeps only saved prefs whose type and choice match the defaults', () => {
    const defaults = { volume: -3, pad: true, color: 'pitch', ratio: 1 };
    const raw = { volume: -12, pad: 'yes', color: 'rainbow', ratio: 2, extra: 1, bogus: NaN };
    expect(pickPrefs(defaults, raw, { color: ['pitch', 'mono'], ratio: [1, 1.5, 2] })).toEqual({ volume: -12, ratio: 2 });
    expect(pickPrefs(defaults, { volume: Infinity })).toEqual({});
    expect(pickPrefs(defaults, null)).toEqual({});
  });

  it('round-trips a scene through a file and rejects broken files', () => {
    const back = sceneFromFile(sceneToFile('my scene', scene));
    expect(back?.name).toBe('my scene');
    expect(back?.scene.shapes).toEqual(scene.shapes);
    expect(sceneFromFile(JSON.stringify(scene))?.name).toBe('');
    expect(sceneFromFile('not json')).toBeNull();
    expect(sceneFromFile('{"kind":"otosu.scene","scene":{"v":9}}')).toBeNull();
  });

  it('lists saved scenes newest first', () => {
    const lib = { a: { code: '', savedAt: 1 }, b: { code: '', savedAt: 3 }, c: { code: '', savedAt: 2 } };
    expect(libraryNames(lib)).toEqual(['b', 'c', 'a']);
  });
});
