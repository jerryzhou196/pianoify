# pianoify

Drop in a recording, hear it back as piano.

The fifteen most musical seconds of whatever you open are sent to a GPU running
[muscriptor](https://github.com/muscriptor/muscriptor), which transcribes the
notes; the chords come back from a CPU-only Hugging Face Space running BTC. The
page draws both on a falling piano roll, plays them on a synthesized grand with
a working damper pedal, and crossfades the result against the original
recording.

## Running it

```sh
npm install
npm run dev      # http://localhost:5173
```

That works against the deployed backends with no further setup. It has to go
through Vite's dev proxy to do so — both backends are CORS-gated on exact
origins, and `localhost:5173` is in neither allowlist — which is what
`.env.development` and the `server.proxy` block in `vite.config.ts` are for.
Point the proxy at a backend of your own with `DEV_TRANSCRIBE_BACKEND` /
`DEV_CHORD_BACKEND` in a `.env.local`.

## Deploying it

A static Vite build; `vercel.json` has the whole configuration. What it needs
that a static site normally doesn't:

1. Set `VITE_TRANSCRIBE_API_BASE` and `VITE_CHORD_API_BASE` to absolute origins
   (see `.env.example`). They are inlined at build time, so changing them takes
   a redeploy, not just a settings save.
2. **Add the deployed origin to the GPU box's CORS allowlist**, or every
   request fails at the preflight with a bare `TypeError`. On the box:

   ```sh
   # /workspace/.env — comma-separated, exact origins, no wildcards
   MUSCRIPTOR_ALLOWED_ORIGINS=https://muscriptor-iota.vercel.app,https://<pianoify origin>
   ```

   then `supervisorctl restart muscriptor` and wait ~30s for the model to
   reload. This does not require redeploying the API. The chord Space is gated
   the same way, by `ALLOWED_ORIGINS` in its Space settings.

## How it works

```
audio file
   ↓  clip.ts        decode, score every 15s window, keep the most musical one,
   ↓                 re-encode it as mono 16-bit WAV
   ├─ POST /transcribe  (GPU, SSE)     → piano notes streamed as start/end
   │     instruments=acoustic_piano       pairs, then a beat grid and chords
   └─ POST /analyze     (HF Space)     → the same chords, from a service that
                                         also ran its own beat tracking
   ↓  engine.ts       schedule both onto a synthesized piano
   ↓  Roll.tsx        draw both on the roll
```

### Why only fifteen seconds

Nothing on the server enforces it — `/transcribe` will take a fifteen-*minute*
file. It is a latency budget. Transcription is autoregressive and runs at
roughly 0.6s of GPU per second of audio, behind a single global queue, with the
client holding the connection open throughout. A three-minute upload is a
three-minute wait; fifteen seconds of the part worth hearing comes back in
about twenty and leaves the page something you can play with. `clip.ts` picks
the window by counting frames above a file-relative noise floor, so it lands on
the part with the most playing in it rather than the loudest transient — and it
refuses a file that is silent end to end instead of spending GPU time
confirming it.

### Asking for piano

`instruments` on `/transcribe` is a hard constraint — the server masks out
every program and drum token outside the listed groups during generation — and
it matters more than it looks. Unset, the model decodes whatever it hears: on a
pop track, 265 notes of which 140 were **drums**. A drum event's `pitch` is a
kit number (36 kick, 38 snare, 42 hi-hat), so playing that stream on a piano
means playing the General MIDI drum map as pitches, which is where the
low-register mud came from. Asking for `acoustic_piano` returns the model's
piano reduction instead — 123 notes, all piano, and ~20% faster for having
fewer tokens to choose between.

### The pedal

`engine.ts` synthesizes rather than sampling — a sampled grand is a ~38MB
soundfont before the first note sounds, which is the wrong trade for a page
whose whole promise is immediacy. What a synthesized piano usually gets wrong
is the decay, so that is where the work went: inharmonic partials with
per-partial decay rates, a hammer transient, and a shared soundboard convolver
that the ringing strings feed.

The damper pedal is the part worth knowing about. With it up, a note stops when
the transcription says the key was released. With it down, the key release does
nothing and the string rings on — until the next **chord change**, where the
pedal comes up and everything still ringing is damped. That is what a pianist
actually does, and it is the only reason "pedal down" is usable: held literally
for fifteen seconds it would accumulate into a chord of the entire clip. With
no chord track the lifts fall on the bar instead, and with no beat grid either,
every two seconds.

### Chords

Asked for from both backends. The standalone Space wins when it answers,
because it ran beat tracking of its own and its boundaries are snapped to a
grid it measured; the ones `/transcribe` embeds in its final event are the
fallback for when the Space is asleep. A sleeping chord service never turns a
good transcription into an error.

They show up three ways: as dashed bands across the roll labelled with the
symbol (click one to jump there), as the current symbol in the roll's rail, and
— with `chords · on` — as a held pad under the transcription, marking the keys
it holds along the front edge of the keyboard so they read differently from the
notes being played.

## Layout

| | |
|---|---|
| `src/config.ts` | backend origins and the clip length |
| `src/clip.ts` | window selection and WAV encoding |
| `src/api.ts` | the SSE protocol and the chord service |
| `src/engine.ts` | the piano, the pedal, the transport |
| `src/roll.ts` | keyboard geometry |
| `src/App.tsx` | state, the animation loop, the layout |
| `src/ds/classical.css` | the design system, vendored — edit it upstream |

`src/ds/classical.css` is a verbatim copy from the Claude Design project this
was designed in. Retune the system there and re-copy rather than editing it
here, so the running app and the design canvas do not drift.
