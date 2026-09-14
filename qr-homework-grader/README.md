# QR Homework Grader

**Experiment:** encode an entire math worksheet — every problem, the answer key,
and admin metadata — into a single QR code printed in the corner of the page.
A student fills the sheet out by hand, someone snaps a photo, and a vision model
grades it. The model reads only the *student's handwriting* from the photo; it
gets the questions and the correct answers from the QR code, not by OCR-ing the
printed problems.

## Why put the ground truth in the QR?

Grading a photographed worksheet has two hard sub-problems:

1. **What was asked / what's correct** — the problems and the answer key.
2. **What the student wrote** — messy handwriting.

Re-reading (1) off the photo with OCR is error-prone and pointless: we *authored*
that content, so it's known exactly. Putting it in the QR turns grading into a
clean comparison — "student wrote X, key says Y" — and the vision model only has
to solve the genuinely hard part, (2). The paper shows just the questions; the
answer key travels in the QR, never printed.

## The loop

```
 build worksheet ──► compact JSON ──► gzip ──► base64url ──► QR (corner of page)
                                                                  │
                                                          print + hand out
                                                                  │
                                                       student fills it in
                                                                  │
                                                            photo taken
                                                                  │
   grade  ◄── compare answers ◄── ground truth (from QR) + read answers (vision)
```

## What's here now (v1)

`index.html` — a single self-contained page (no build step, no install; open it
in a browser). Three panels:

- **Build** — enter admin fields and problems, or auto-generate a practice set.
- **Worksheet** — a printable page with the questions and the QR in the corner.
  The answer key is *not* printed. `Ctrl/Cmd+P` → "Save as PDF".
- **Decode / Grade** — upload a photo or screenshot of the QR (or paste the
  payload) to recover the exact ground truth, then score a set of read answers
  against the key. This stands in for the vision model's job for now.

Libraries are vendored under `vendor/` (versions in `vendor/VERSIONS.txt`) so the
page is fully self-contained and works offline — no CDN, no build step:
[`pako`](https://github.com/nodeca/pako) (gzip),
[`qrcode-generator`](https://github.com/kazuhikoarase/qrcode-generator) (encode),
[`jsQR`](https://github.com/cozmo/jsQR) (decode). All MIT-licensed.

## Payload format

```
QR text = base64url( gzip( compact-JSON ) )
```

Compact JSON (short keys keep it small — but gzip does most of the work):

| key   | meaning                              |
|-------|--------------------------------------|
| `v`   | schema version (currently `1`)       |
| `id`  | assignment id                        |
| `t`   | title                                |
| `s`   | student id / name (optional)         |
| `cl`  | class / period                       |
| `tr`  | teacher                              |
| `dt`  | date issued (`YYYY-MM-DD`)           |
| `due` | due date                             |
| `pts` | total points                         |
| `p`   | problems: `[{n, q, a, pt}, ...]`     |

Per problem: `n` number, `q` question text, `a` correct answer, `pt` points
(optional, defaults to 1).

## Capacity — measured

Compact JSON, gzipped, in QR byte mode. QR version 40 holds 2331 bytes at
error-correction level **M** (~15% recoverable) and 1663 at level **Q** (~25%):

| problems | raw JSON | gzipped | fits @ Q? | smallest QR version @ M |
|---------:|---------:|--------:|:---------:|:-----------------------:|
| 10       | 582 B    | 277 B   | yes       | 12                      |
| 20       | 990 B    | 377 B   | yes       | 15                      |
| 30       | 1409 B   | 471 B   | yes       | 17                      |
| 50       | 2249 B   | 650 B   | yes       | 20                      |

Even 50 problems uses only half the available versions at level M, so there's
ample room to raise error correction for reliable scanning off a printed,
photographed page. Recommended default: **EC level Q**.

## Ideas / next steps

- Wire the Decode panel to an actual vision model call for the handwriting read.
- Print alignment/fiducial markers so a phone photo can be de-skewed reliably.
- Batch generation: one PDF of N personalized sheets (per-student `s` + `id`).
- Optional signing/HMAC so a QR can't be swapped or forged.
- Handle >QR-40 content by splitting across structured QR codes (rarely needed).
