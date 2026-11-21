"""Render eight actual-app frames and locally synthesized narration into a 120s tour."""
from pathlib import Path
import json
import os
import re
import shutil
import subprocess
import wave

ROOT = Path(__file__).resolve().parents[1]
FRAMES = ROOT / "output/video"
ffmpeg = os.environ.get("FFMPEG") or shutil.which("ffmpeg") or next((ROOT.parent / ".tools/media/imageio_ffmpeg/binaries").glob("ffmpeg*.exe"), None)
if not ffmpeg:
    raise SystemExit("Install FFmpeg or set FFMPEG.")
scenes = json.loads((ROOT / "public/narration.json").read_text(encoding="utf-8"))
shutil.copyfile(Path(os.environ.get("DEMO_FONT", "C:/Windows/Fonts/segoeui.ttf")), FRAMES / "caption-font.ttf")
captions = ["WEBVTT", ""]
segments = []
def stamp(seconds):
    milliseconds = round(seconds * 1000)
    return f"{milliseconds // 3600000:02}:{milliseconds // 60000 % 60:02}:{milliseconds // 1000 % 60:02}.{milliseconds % 1000:03}"
for i, scene in enumerate(scenes):
    audio = FRAMES / f"narration-{i}.wav"
    with wave.open(str(audio)) as wav:
        duration = wav.getnframes() / wav.getframerate()
    if duration > 14.8:
        raise SystemExit(f"Narration segment {i} is {duration:.2f}s; shorten its text or increase voice rate.")
    sentences = re.split(r"(?<=[.!?])\s+", scene["text"])
    total = sum(len(sentence) for sentence in sentences)
    at = i * 15
    for sentence in sentences:
        end = at + duration * len(sentence) / total
        captions.extend([f"{stamp(at)} --> {stamp(end)}", sentence, ""])
        at = end
    title = FRAMES / f"narrated-title-{i}.txt"
    title.write_text(scene["title"], encoding="utf-8")
    video_filter = (
        "scale=1920:1080:force_original_aspect_ratio=decrease:out_range=tv,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,"
        "drawbox=x=0:y=0:w=1920:h=82:color=black@0.94:t=fill,"
        f"drawtext=fontfile=output/video/caption-font.ttf:textfile=output/video/narrated-title-{i}.txt:fontcolor=white:fontsize=32:x=40:y=24"
    )
    segment = FRAMES / f"narrated-{i}.mp4"
    subprocess.run([str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", str(FRAMES / f"{scene['frame']}.jpg"), "-i", str(audio), "-vf", video_filter,
                    "-af", "apad,atrim=duration=15", "-t", "15", "-r", "24", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-color_range", "tv", "-c:a", "aac", "-b:a", "128k", str(segment)], cwd=ROOT, check=True)
    segments.append(segment)
manifest = FRAMES / "narrated-segments.txt"
manifest.write_text("\n".join(f"file '{s.name}'" for s in segments), encoding="utf-8")
destination = ROOT / "public/narrated-demo.mp4"
subprocess.run([str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(manifest), "-c", "copy", "-movflags", "+faststart", str(destination)], check=True)
(ROOT / "public/narration.vtt").write_text("\n".join(captions), encoding="utf-8")
print(f"Rendered 120-second narrated tour: {destination.stat().st_size:,} bytes, with English captions.")
