# otosu

English | [日本語](README.ja.md)

Drop, hit, glow, sound.

otosu is a generative music piece for the eye and ear: falling balls strike the lines and shapes you draw, and every hit becomes a note and a flash of light.
It aims to let anyone make music by feel, without playing an instrument, and to look good projected on a wall.

![otosu: a square, circle and triangle glow as balls hit them, with flowers blooming over an ASCII-pattern backdrop](docs/images/screenshot.jpg)

## Development

```bash
npm install
npm run dev
```

```bash
npm test       # physics determinism, no tunneling, MIDI export, and more
npm run lint   # Biome
npm run build  # type check and production build (dist/)
```

Built with Vite, TypeScript, three.js and Tone.js. The physics (balls against line segments) is hand-written and deterministic: the same layout always plays the same music.

## Controls

| Input | Action |
|---|---|
| Drag | Draw a line or shape (bigger shapes play lower notes; you hear the pitch softly as you draw) |
| 1–5 | Tools: line / pen (freehand) / circle / triangle / square. For shapes, drag outward from the center; the drag distance sets the size |
| Shift + drag | Draw a bumper (bounces balls hard) |
| Right-click (long-press on touch) | Shape menu: toggle the echo / rise / chord effects, or delete the shape |
| Space | Play / pause (pausing stops dropping new balls and lets the rest fade out) |
| M | Mute (built-in sound and MIDI output) |
| C | Clear all shapes |
| S | Copy the current layout as a URL (opening it plays the same music) |
| R | Start / stop recording a .mid file (saved when you stop) |
| F | Fullscreen |
| H | Hide the UI (for projection) |
| , | Open settings |
| Esc | Close the open popover |

The toolbar at the top of the screen has:

- play / pause
- the tools
- tempo (− / + buttons, or scroll)
- volume and mute
- clear all
- popovers: motion / light / sound / settings / scenes
- fullscreen (where supported)

| Popover | Contents |
|---|---|
| motion | Motion on/off (move), shape rotation (spin), and emitter movement (sway) with its style (glide / step) |
| light | Glow, trail style, effects on hit (drip / flowers and their kind: mixed, sunflower, spider lily, daisy, meadow / readout / crosshair / notes / scope / stars), and the backdrop |
| sound | Rhythm (emitter periods), song (chord progression), and a soft chord that keeps playing underneath (hum) |
| settings | Stereo width, sound-to-light offset (light delay), resolution, quality (auto or fixed), MIDI, and the list of keys |
| scenes | Save and load layouts, export / import them as files, copy a link |

Each shape plays a different instrument.

| Shape | Sound |
|---|---|
| Line | Bell (melody) |
| Pen | Plucked tone (kalimba-like) |
| Circle | Soft kick to tom, tuned to the chord root; bigger circles are lower |
| Triangle | Metal (chime / singing bowl), long decay |
| Square | Wooden click (woodblock-like) |

The harmony shifts every 8 bars. Pick a song in the sound popover:
- bright: C–F–C–G
- dusk: Cm–A♭–E♭–B♭ (minor)
- wistful: F–G–Em–Am
- still: the chord never changes

Line colors stay the same; only the pitches move. Your layout and settings are saved in the browser automatically and come back after a reload.

## MIDI output (GarageBand / DAWs)

### Record and import (easiest)
1. Press R (or `record .mid` under `MIDI` in settings) to start recording. Recording begins on the next beat.
2. Press R again to stop; `otosu-<date>-<time>.mid` is saved.
3. Drag and drop it into GarageBand to import it as a software instrument track.

### Send live (via the IAC Driver on macOS; requires a Chromium-based browser such as Chrome)
1. Open the Audio MIDI Setup app → Window → Show MIDI Studio.
2. Double-click "IAC Driver" and check "Device is online".
3. In settings, press `connect` under `MIDI` and allow access in the browser prompt (if no output is chosen yet, IAC is selected automatically when present).
4. Create a software instrument track in GarageBand and it will play otosu's notes (GarageBand listens to every MIDI input).
5. Circles (kick / tom) and squares (woodblock) are sent as GM drums on the `drums` channel (10 by default). Recorded .mid files do the same.
6. If the built-in sound doubles up with your DAW, turn off `built-in`. Use `offset` to compensate for DAW latency.

## Documentation

The design history is written in Japanese.

- [docs/concept.md](docs/concept.md) — concept, initial decisions, roadmap
- [docs/design/decisions.md](docs/design/decisions.md) — log of design decisions (D1 onward). It takes precedence when documents disagree
- [docs/design/](docs/design/) — early design proposals (steps 1 and 2), split into audio, visuals, and physics/architecture

## License

[MIT](LICENSE)
