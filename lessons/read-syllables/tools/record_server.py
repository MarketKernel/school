"""Local server: serves the lesson folder and saves sounds recorded with one's own voice.

Usage:
    python3 record_server.py           # http://localhost:8000/tools/record.html
    python3 record_server.py 8080      # different port

record.html records from the microphone and posts the audio here. The server:
    1. saves the take to compare/recorded/ (git-ignored) and turns it into an mp3 (volume, silence trim);
    2. optionally converts it to the speak.py voice (ElevenLabs Speech-to-Speech);
    3. on «Поставить» copies the chosen take into the working set audio/ and rebuilds the game.

Recorded letters and syllables are marked in audio/recorded.json — speak.py --force won't overwrite them.

myvoice.html records one's own voice for the whole set: recordings go straight into audio/My/
(a copy of the working set), and «Поставить в игру» makes audio/My the working set.
"""

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import speak

LESSON = speak.LESSON  # the server serves the lesson folder; pages live in tools/
AUDIO = LESSON / "audio"
TAKES = LESSON / "compare" / "recorded"
STS_URL = "https://api.elevenlabs.io/v1/speech-to-speech/{voice}?output_format=mp3_44100_128"
STS_MODEL = "eleven_multilingual_sts_v2"
# Where a chosen take goes: the working set (the one the game uses)
SETS_TO_UPDATE = [AUDIO]
MY = AUDIO / "My"                       # the "my voice" set — a draft, git-ignored
KINDS = ["letters", "soft", "syllables"]


def kind_of(item: str) -> str:
    if len(item) == 1:
        return "letters"
    return "soft" if item.endswith("ь") else "syllables"


def rel(path: Path) -> str:
    return path.relative_to(LESSON).as_posix()


def wav_to_mp3(wav: Path, mp3: Path):
    subprocess.run(["lame", "--quiet", "-m", "m", "-b", "128", str(wav), str(mp3)], check=True)


def speech_to_speech(wav: Path) -> bytes:
    """Re-voices the recording with ELEVENLABS_VOICE, keeping the pronunciation."""
    boundary = uuid.uuid4().hex
    fields = {"model_id": STS_MODEL, "remove_background_noise": "true"}
    body = b"".join(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
        for k, v in fields.items()
    )
    body += (f'--{boundary}\r\nContent-Disposition: form-data; name="audio"; filename="take.wav"\r\n'
             f"Content-Type: audio/wav\r\n\r\n").encode() + wav.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    request = urllib.request.Request(
        STS_URL.format(voice=speak.setting("ELEVENLABS_VOICE")),
        data=body,
        headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"],
                 "Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"ElevenLabs вернул {e.code}: {e.read().decode('utf-8', 'replace')[:300]}") from e


def record(item: str, wav_bytes: bytes, to_voice: bool) -> dict:
    TAKES.mkdir(parents=True, exist_ok=True)
    stem = f"{speak.translit(item)}_{time.strftime('%H%M%S')}"
    wav = TAKES / f"{stem}.wav"
    wav.write_bytes(wav_bytes)

    own = TAKES / f"{stem}_own.mp3"
    wav_to_mp3(wav, own)
    if speak.normalize(own) < speak.QUIET_DB:
        raise RuntimeError("Запись почти беззвучная — проверьте микрофон")
    result = {"own": rel(own)}

    if to_voice:
        voiced = TAKES / f"{stem}_voice.mp3"
        voiced.write_bytes(speech_to_speech(wav))
        speak.normalize(voiced)
        result["voice"] = rel(voiced)
    return result


def read_marks(base: Path) -> dict:
    path = base / "recorded.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def write_marks(base: Path, marks: dict):
    (base / "recorded.json").write_text(json.dumps(marks, ensure_ascii=False, indent=2), encoding="utf-8")


def build_game() -> dict:
    build = subprocess.run(["node", "build_scripts/build.mjs"], cwd=LESSON / "game", capture_output=True, text=True)
    return {"built": build.returncode == 0, "buildLog": build.stdout[-300:] + build.stderr[-300:]}


def copy_set(src: Path, dst: Path):
    """Copies sounds and lists (letters/soft/syllables) from one set to another."""
    dst.mkdir(parents=True, exist_ok=True)
    for kind in KINDS:
        if (src / kind).exists():
            shutil.rmtree(dst / kind, ignore_errors=True)
            shutil.copytree(src / kind, dst / kind)
            shutil.copyfile(src / f"{kind}.json", dst / f"{kind}.json")


def my_init() -> dict:
    """On first run the "my voice" set is a copy of the working set, so unrecorded sounds play as they do in the game now."""
    if not MY.exists():
        copy_set(AUDIO, MY)
        write_marks(MY, read_marks(AUDIO))  # already self-recorded sounds show up right away
    return {"recorded": read_marks(MY)}


def my_record(item: str, wav_bytes: bytes, process: bool) -> dict:
    kind = kind_of(item)
    if not (MY / kind).exists():
        raise RuntimeError(f"В наборе audio/My нет раздела {kind}")
    # Always keep the source so it can be reprocessed
    raw_dir = MY / "_raw"
    raw_dir.mkdir(exist_ok=True)
    wav = raw_dir / f"{speak.translit(item)}.wav"
    wav.write_bytes(wav_bytes)

    dest = MY / kind / f"{speak.translit(item)}.mp3"
    wav_to_mp3(wav, dest)
    if process and speak.normalize(dest) < speak.QUIET_DB:
        raise RuntimeError("Запись почти беззвучная — проверьте микрофон")

    marks = read_marks(MY)
    marks[item] = "свой голос" + ("" if process else ", без обработки")
    write_marks(MY, marks)
    return {"file": rel(dest), "recorded": marks}


def my_apply() -> dict:
    """Makes the "my voice" set the game's working set."""
    copy_set(MY, AUDIO)
    marks = read_marks(AUDIO)
    marks.update(read_marks(MY))  # speak.py --force won't touch self-recorded sounds
    write_marks(AUDIO, marks)
    return build_game()


def use(item: str, file: str) -> dict:
    src = (LESSON / file).resolve()
    if TAKES.resolve() not in src.parents or not src.exists():
        raise RuntimeError(f"Нет такого дубля: {file}")
    kind = kind_of(item)
    updated = []
    for base in SETS_TO_UPDATE:
        if not (base / kind).exists():
            continue
        shutil.copyfile(src, base / kind / f"{speak.translit(item)}.mp3")
        # Mark the sound as hand-recorded so speak.py --force leaves it alone
        marks_path = base / "recorded.json"
        marks = json.loads(marks_path.read_text(encoding="utf-8")) if marks_path.exists() else {}
        marks[item] = file
        marks_path.write_text(json.dumps(marks, ensure_ascii=False, indent=2), encoding="utf-8")
        updated.append(rel(base))

    return {"updated": updated, **build_game()}


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # so the browser doesn't play a stale sound after it's replaced
        super().end_headers()

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(url.query)
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            if url.path == "/api/record":
                result = record(query["item"][0], body, query.get("voice", ["0"])[0] == "1")
            elif url.path == "/api/use":
                data = json.loads(body)
                result = use(data["item"], data["file"])
            elif url.path == "/api/my/init":
                result = my_init()
            elif url.path == "/api/my/record":
                result = my_record(query["item"][0], body, query.get("process", ["1"])[0] == "1")
            elif url.path == "/api/my/apply":
                result = my_apply()
            else:
                self.send_error(404)
                return
            self.reply(200, result)
        except Exception as e:
            self.reply(500, {"error": str(e)})

    def reply(self, code: int, data: dict):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main():
    speak.load_envs()
    if not shutil.which("lame"):
        sys.exit("Нужен lame: brew install lame")
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(("localhost", port), partial(Handler, directory=str(LESSON)))
    print(f"Свой голос: http://localhost:{port}/tools/myvoice.html")
    print(f"Запись с переводом в голос Olga: http://localhost:{port}/tools/record.html   (Ctrl+C — остановить)")
    server.serve_forever()


if __name__ == "__main__":
    main()
