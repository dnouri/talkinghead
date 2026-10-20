import argparse
import json
import re
import sys
from pathlib import Path


def words(text):
    return re.findall(r"[a-z0-9]+", text.casefold())


def main():
    parser = argparse.ArgumentParser(description="Check generated speech with a local Whisper model.")
    parser.add_argument("audio", type=Path)
    parser.add_argument("--expected", required=True)
    parser.add_argument("--model", default="small")
    args = parser.parse_args()
    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(
            args.model, device="cpu", compute_type="int8", cpu_threads=4,
            local_files_only=True,
        )
        segments, _ = model.transcribe(
            str(args.audio), language="en", beam_size=3, vad_filter=False,
            condition_on_previous_text=False,
        )
        transcript = " ".join(segment.text.strip() for segment in segments)
        passed = words(transcript) == words(args.expected)
        print(json.dumps({
            "result": "PASS" if passed else "FAIL", "audio": str(args.audio),
            "model": args.model, "expected": args.expected, "transcript": transcript,
        }))
        return 0 if passed else 1
    except Exception as error:
        print(json.dumps({"result": "BLOCKED", "error": str(error)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
