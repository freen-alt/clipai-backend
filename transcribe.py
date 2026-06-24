#!/usr/bin/env python3
import sys
import json
import whisper

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Caminho do áudio não fornecido"}))
        sys.exit(1)

    audio_path = sys.argv[1]

    try:
        model = whisper.load_model("base")
        result = model.transcribe(audio_path, language="pt", fp16=False, verbose=False)

        segments = []
        for seg in result.get("segments", []):
            segments.append({
                "start": round(seg["start"], 2),
                "end": round(seg["end"], 2),
                "text": seg["text"].strip()
            })

        print(json.dumps({"segments": segments, "full_text": result.get("text", "")}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
