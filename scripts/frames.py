"""Each fixed video's frames as the reference samples them: decoded by OpenCV, then the
checkpoint's video processor's `sample_frames` (2 frames a second, 4 to 32 spread over the whole
video). For the hosts that read a video as its frames, `<media dir>/<video>.frames/{i:03}.png` and
`times.json` (each frame's time in seconds); for the reference, `sampled.json` (the source's frame
rate and frame count, and the frames' indices).

    python frames.py <checkpoint dir> <conversations.json> <media dir>
"""

import json
import sys
from pathlib import Path

import cv2
from PIL import Image
from transformers import AutoVideoProcessor
from transformers.video_utils import VideoMetadata

MAX_FRAMES = 32


def decode(path):
    """Every frame of the video at `path` as RGB, and its frame rate."""
    reader = cv2.VideoCapture(str(path))
    fps = reader.get(cv2.CAP_PROP_FPS)
    frames = []
    while True:
        ok, frame = reader.read()
        if not ok:
            break
        frames.append(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    reader.release()
    return frames, fps


def main():
    checkpoint, conversations, media = (Path(arg) for arg in sys.argv[1:4])
    processor = AutoVideoProcessor.from_pretrained(checkpoint)
    processor.max_frames = MAX_FRAMES
    turns = (turn for conversation in json.loads(conversations.read_text()).values() for turn in conversation["turns"])
    for turn in turns:
        for path in turn.get("videos", []):
            frames, fps = decode(media / path)
            metadata = VideoMetadata(total_num_frames=len(frames), fps=fps)
            indices = [int(index) for index in processor.sample_frames(metadata)]
            directory = media / f"{path}.frames"
            directory.mkdir(parents=True, exist_ok=True)
            for number, index in enumerate(indices):
                Image.fromarray(frames[index]).save(directory / f"{number:03}.png")
            times = [index / fps for index in indices]
            (directory / "times.json").write_text(json.dumps(times) + "\n")
            sampled = {"fps": fps, "total": len(frames), "indices": indices}
            (directory / "sampled.json").write_text(json.dumps(sampled) + "\n")
            print(f"{path}: {len(indices)} frames")


if __name__ == "__main__":
    main()
