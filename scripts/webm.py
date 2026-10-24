"""Each fixed video as browsers can decode it: VP9 in WebM, lossless over the source's decoded
YUV 4:2:0 planes, at its own frame rate, so the page reads the frames the reference reads (Chrome
has no MPEG-4 Part 2 decoder). Writes `<media dir>/<video stem>.webm`.

    python webm.py <conversations.json> <media dir>
"""

import json
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg


def main():
    conversations, media = (Path(arg) for arg in sys.argv[1:3])
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    turns = (turn for conversation in json.loads(conversations.read_text()).values() for turn in conversation["turns"])
    for turn in turns:
        for path in turn.get("videos", []):
            source = media / path
            target = source.with_suffix(".webm")
            command = [ffmpeg, "-loglevel", "error", "-y", "-i", str(source), "-an", "-c:v", "libvpx-vp9",
                       "-lossless", "1", "-pix_fmt", "yuv420p", str(target)]
            subprocess.run(command, check=True)
            print(f"{path} → {target.name}")


if __name__ == "__main__":
    main()
