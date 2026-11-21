"""Edit captured dashboard frames into a captioned portfolio walkthrough.

Capture inputs with the browser UI in output/video/. No synthetic UI is generated.
Run: python scripts/render-demo.py
"""
from pathlib import Path
import os
import shutil
import subprocess
import textwrap

ROOT = Path(__file__).resolve().parents[1]
FRAMES = ROOT / "output" / "video"
FFMPEG = os.environ.get("FFMPEG") or shutil.which("ffmpeg")
if not FFMPEG:
    bundled = ROOT.parent / ".tools/media/imageio_ffmpeg/binaries"
    FFMPEG = next(bundled.glob("ffmpeg*.exe"), None)
if not FFMPEG:
    raise SystemExit("Install FFmpeg or set FFMPEG to its executable.")

font = Path(os.environ.get("DEMO_FONT", "C:/Windows/Fonts/segoeui.ttf"))
if not font.exists():
    raise SystemExit("Set DEMO_FONT to a readable TrueType font.")
shutil.copyfile(font, FRAMES / "caption-font.ttf")
scenes = [
    ("intro", 5, "GLITCH HUNT | AI agents investigate game regressions. Edited walkthrough of the deployed app."),
    ("replay-0", 3, "A recorded live agent run: apply the same moves to baseline and candidate builds."),
    *[(f"replay-{i}", 0.7, "Replay the recorded inputs. The candidate gate loses its open state.") for i in range(1, 9)],
    ("replay-8", 4, "The baseline reaches the exit. An exhaustive verifier confirms the candidate cannot finish."),
    ("trace", 7, "Inspect the real model tool calls, observed state, token usage, and request latency."),
    ("healthy-route", 7, "Offline reference: the alternate route fits the move allowance. No regression found."),
    ("route-regression", 7, "Offline reference: a solvable detour exceeds the move allowance. Regression found."),
    ("intro", 5, "Durable jobs, checkpoint recovery, shared limits, and measured scaling. Try glitch-hunt.vercel.app"),
]
segments = []
for i, (frame, duration, caption) in enumerate(scenes):
    source = FRAMES / f"{frame}.jpg"
    if not source.exists():
        raise SystemExit(f"Missing captured frame: {source}")
    caption_path = FRAMES / f"caption-{i}.txt"
    caption_path.write_text("\n".join(textwrap.wrap(caption, 110)), encoding="utf-8")
    segment = FRAMES / f"segment-{i}.mp4"
    overlay = (
        "scale=1920:1080:force_original_aspect_ratio=decrease,"
        "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,"
        "drawbox=x=0:y=960:w=1920:h=120:color=black@0.95:t=fill,"
        f"drawtext=fontfile=output/video/caption-font.ttf:textfile=output/video/caption-{i}.txt:"
        "fontcolor=white:fontsize=30:line_spacing=6:x=(w-text_w)/2:y=978"
    )
    subprocess.run([
        str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-loop", "1",
        "-i", str(source), "-vf", overlay, "-t", str(duration), "-r", "24",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
        "-pix_fmt", "yuv420p", "-an", str(segment),
    ], cwd=ROOT, check=True)
    segments.append(segment)
manifest = FRAMES / "segments.txt"
manifest.write_text("\n".join(f"file '{p.name}'" for p in segments), encoding="utf-8")
destination = ROOT / "public" / "demo.mp4"
subprocess.run([
    str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-f", "concat",
    "-safe", "0", "-i", str(manifest), "-c", "copy", "-movflags", "+faststart", str(destination),
], check=True)
print(f"Rendered {destination.name}: {sum(s[1] for s in scenes):.1f}s, {destination.stat().st_size:,} bytes.")
