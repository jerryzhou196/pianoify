# pianoify

Drop in a recording, hear it back as piano.

Drop a file or paste a YouTube link. It is decoded in the tab, drawn as a
waveform, and cropped to ten seconds — opening on the first thing you actually
played. That crop goes to [Mirelo](https://mirelo.ai)'s audio-to-MIDI API,
conditioned on `acoustic_piano`, which sends back the notes; the chords come
from a CPU-only Hugging Face Space running BTC. The roll fills in while the
model is still decoding, plays on a synthesized grand with a working damper
pedal, engraves Mirelo's MusicXML on a second tab, and crossfades against the
original recording.

## Running it

```sh
npm install
npm run dev      # http://localhost:5173
```

`MIRELO_KEY` has to be in the environment the dev server starts in — it is
already in `~/.zshrc`, so a normal shell has it; a `.env.local` works too. The
key is only ever read by the functions in `api/`, which the dev server mounts
itself (see `vite.config.ts`), so `npm run dev` needs no `vercel dev` and no
tunnel.

## Deploying it

A static Vite build plus four Node functions. `vercel.json` has the rest.

1. Set **`MIRELO_KEY`** in the project's environment variables. Not `VITE_`
   prefixed — `VITE_*` is inlined into a bundle any visitor can read.
2. Optionally set `VITE_CHORD_API_BASE` (see `.env.example`). It is inlined at
   build time, so changing it takes a redeploy, not just a settings save.
3. Add the deployed origin to the chord Space's `ALLOWED_ORIGINS`, or the
   chord request fails at the preflight. The yt-dlp service needs no such
   change — `vercel.json` rewrites `/ytdlp/*` to it, so the browser only ever
   talks to this origin.

## How it works

```
audio file, or a youtube link
   ↓  /ytdlp/download   (youtube only) the self-hosted yt-dlp service, reached
   ↓                    through this origin so no CORS allowlist is involved
   ↓  audio.ts          decode in the browser; peaks for the waveform; open the
   ↓                    trim handles on the first ten non-silent seconds
   ↓  (you drag)        the crop is cut to a mono 16-bit WAV
   ↓
   ├─ POST /api/asset      → measured, capped at 10s, uploaded to Mirelo
   ├─ POST /api/job        → Mirelo transcribes, conditioned on acoustic_piano
   ├─ GET  /api/job?id=…   → polled: progress, and notes as they are decoded
   └─ POST /analyze  (HF)  → chords, in parallel, from a different machine
   ↓
   ↓  hands.ts          split the notes between the hands; put a finger on each
   ↓  engine.ts         schedule them on a synthesized piano
   ↓  Roll.tsx          draw them falling onto the keyboard, as they arrive
```

### Why the key needs a server

Mirelo's key is a bearer token against a billed account, and this is a static
site, so there is nowhere in the browser to put one. `api/` is four small
functions that hold it: take a clip, start a job, poll a job, quote a price.

### Ten seconds, enforced where it counts

Mirelo bills 2.5 credits per second of input, so the length of a clip is a
number that costs money, and a cap the browser applies to itself is not a cap.
Mirelo's asset flow would let the tab PUT straight to a presigned S3 URL —
which is the right shape for large uploads, and is what this did first — but
then nothing between the browser and the bill ever sees how long the audio is.

So the clip comes through `/api/asset`, which parses the WAV header, works out
the duration from the sample rate and the size of the data chunk, and refuses
anything past ten seconds before it spends a slot. Ten seconds of mono PCM is
under a megabyte; the detour costs nothing and the cap holds no matter what the
client says. `src/config.ts` carries the same number so the trim handles never
open on a crop that would only be rejected — that copy is a courtesy, not the
limit.

### Where the clip starts

At the first thing you played. Not the loudest window, and not the busiest one:
either is a guess about which part of a recording matters, and a guess that
lands in the middle of a track is one you have to check before you can trust
it. "Not silence" is measured against the file's own loud passages, since a
quiet piano recording and a mastered pop track disagree by 30dB about what
quiet means, and the window opens at the first run of frames above that floor
long enough to be a sound rather than a click. Everything else is a drag away.

### Why async, and why nothing is blocked

Transcription runs at roughly 1.5× realtime, so even a ten-second clip is
fifteen seconds of waiting. The `/sync` endpoint would hold a function open for
all of it and show nothing until it returned; the async endpoint reports
`progress_percent` and hands back the notes decoded so far on every poll.

So the page does not wait. Notes are drawn as they land, the transport is live
the moment there are any, and the only thing on screen that says a
transcription is running is a strip in the corner of the roll with a cancel
button in it. Pressing play at 40% works, and the run finishing will not yank
the piece back to the start under you.

### YouTube

A YouTube link goes to a self-hosted yt-dlp service (FastAPI, `/ytdlp/` on
`jerryzhou.ca`), which copies YouTube's native AAC stream into an `.m4a`
without re-encoding. It is reached at a path on *this* origin — proxied by the
dev server, rewritten by `vercel.json` in production — so the browser makes no
cross-origin request and this app never has to appear in that service's CORS
allowlist. The service validates the YouTube host and the video id itself.

It is the slow part of the app: a download runs at roughly half the video's own
length and reports no progress until it is done, which is why the modal counts
the seconds out loud while it waits. Anything that is not a YouTube link goes
to `/api/fetch` instead — a fenced proxy: https only, no private address, an
audio content type, a size ceiling, and every redirect hop re-checked.

### Asking for piano

`instruments` is an exhaustive list, not a filter: Mirelo masks every
instrument outside it out of the model's vocabulary, so one that is not listed
cannot appear in the output at all. The docs warn that naming an instrument the
audio does not contain makes the model split a real part across two — here that
is exactly the point, and the split is toward the piano. Asking for
`acoustic_piano` is what turns a drum kit into left-hand chords instead of into
the General MIDI drum map played as pitches.

`timing` is the other knob, and it is the app's whole model menu, because Mirelo
publishes one audio-to-MIDI model. `performance` keeps the take as played;
`quantized` snaps onsets to the detected beats and is honoured only when that
grid is steady enough to move notes onto — the sheet-music caption reports what
was actually applied, and why, when the two differ.

### The pedal

`engine.ts` synthesizes rather than sampling — a sampled grand is a ~38MB
soundfont before the first note sounds, which is the wrong trade for a page
whose whole promise is immediacy. What a synthesized piano usually gets wrong
is the decay, so that is where the work went: inharmonic partials with
per-partial decay rates, a hammer transient, and a shared soundboard convolver
that the ringing strings feed.

The damper pedal is the part worth knowing about. A note stops when the
transcription says the key was released — unless the pedal is down, in which
case the string rings on until the next **chord change**, where the pedal comes
up and everything still ringing is damped. That is what a pianist actually
does, and it is the only reason a pedalled passage stays usable: held literally
for ten seconds it would accumulate into a chord of the entire clip. With no
chord track the lifts fall on the bar instead, and with no beat grid either,
every two seconds. It is the one thing the chord service does to the *audio*.

### Hands and fingering

Invented, on purpose, and marked as such in `src/hands.ts`. No audio-to-MIDI
model can say which hand played a note, because the information is not in the
sound. The split is a line that moves through the piece — each simultaneity
proposes a split at its widest interior gap, and the line follows at a bounded
rate, so it tracks a walking bass without lunging at one low melody note. The
fingering is two rules: fingers spread from the thumb outward inside a chord,
and the hand walks a finger per step between single notes, crossing on the
thumb when it runs out. Both are readings of the transcription, not facts about
a performance — but they are the difference between a wall of rectangles and
something you can see the shape of.

### Speed

The transport's speed control stretches the piece onto the clock in one place
(`clockTime`). The synthesized piano re-voices every note at the pitch it was
written at, so it stays in tune at 0.5×; the original recording is *resampled*,
so it drops an octave the way a slowed tape does. That is the honest trade for
a control whose job is to let you follow a fast passage, and it is why the
crossfade usually wants to be on the transcribed side when the speed is not 1.

### Chords

From the Space, or not at all — Mirelo transcribes notes, not harmony. They
show up as dashed rules across the roll labelled with the symbol (click one to
jump there), as the current symbol in the transport, and as the pedal lifts. A
sleeping chord service never turns a good transcription into an error.

## Layout

| | |
|---|---|
| `api/` | the four functions that hold `MIRELO_KEY` |
| `src/audio.ts` | decode, waveform, window selection, WAV encoding |
| `src/mirelo.ts` | upload, submit, poll, and what Mirelo's shapes mean |
| `src/chords.ts` | the chord service |
| `src/links.ts` | pasted links: YouTube, and everything else |
| `src/hands.ts` | hand splitting and fingering |
| `src/engine.ts` | the piano, the pedal, the transport |
| `src/roll.ts` | keyboard geometry and note colour |
| `src/App.tsx` | state, the animation loop, the layout |
| `src/styles.css` | the design, translated from the Claude Design project |

`src/styles.css` is the design system for this app, and its values come from
the Claude Design project it was drawn in (`Pianoify.dc.html`, project
`cab42753`). Retune it there and re-copy rather than diverging here, so the
running app and the design canvas do not drift.
