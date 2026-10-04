"""Voices the English words from data/words.tsv with ElevenLabs or OpenAI Text-to-Speech.

The service is chosen by the EN_TTS_PROVIDER setting (elevenlabs or openai), elevenlabs by default.
Settings have their own EN_ prefix so they don't clash with the Russian voice of «Собери слово».
Keys — ELEVENLABS_API_KEY / OPENAI_API_KEY — come from the environment or from the .env file
at the repo root (template: .env.example next to it).

Output:
    audio/cat.mp3, audio/ice-cream.mp3, …

Usage:
    python3 speak.py --dry-run              # show what would be voiced, without requests
    python3 speak.py --limit 5              # first 5 words — to check the voice
    python3 speak.py                        # voice everything that's missing
    python3 speak.py --only animals,food    # only these topics (or words)
    python3 speak.py --redo cat,dog         # re-voice these words
    python3 speak.py --force                # re-voice everything
    python3 speak.py --voices               # list ElevenLabs voices available with your key
    python3 speak.py --normalize            # boost volume and trim silence of existing files

Volume: every new file is normalized to a −1 dBFS peak and edge silence is trimmed.
This needs lame: brew install lame (without it files stay as the service returned them).
"""

import argparse
import array
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import wave
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from common import FOLDER, load_envs, pick, read_words

OPENAI_URL = "https://api.openai.com/v1/audio/speech"
ELEVENLABS_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=mp3_44100_128"
ELEVENLABS_VOICES_URL = "https://api.elevenlabs.io/v1/voices"
WORKERS = {"openai": 4, "elevenlabs": 2}  # how many requests to send in parallel
API_KEYS = {"openai": "OPENAI_API_KEY", "elevenlabs": "ELEVENLABS_API_KEY"}

TARGET_PEAK_DB = -1.0   # peak level to normalize to
SILENCE_DB = -40.0      # quieter than this (relative to peak) counts as edge silence
EDGE_MARGIN = 0.05      # seconds of silence to keep before and after the sound
QUIET_DB = -40.0        # a source peak below this means the file is most likely empty
RETRIES_ON_EMPTY = 4    # how many times to re-request when the service returns silence

# Defaults — override in .env
DEFAULTS = {
    "EN_TTS_PROVIDER": "elevenlabs",
    "EN_ELEVENLABS_MODEL": "eleven_multilingual_v2",
    "EN_ELEVENLABS_VOICE": "EXAVITQu4vr4xnSDxMaL",  # Sarah — a soft, clear American voice from the default set
    "EN_OPENAI_TTS_MODEL": "gpt-4o-mini-tts",
    "EN_OPENAI_TTS_VOICE": "coral",
}

INSTRUCTIONS = (
    "You are voicing flashcards for a young child who is learning English. "
    "Say the word clearly and a little slowly, in a warm, friendly voice, with a standard American accent. "
    "Say it once and add nothing else."
)


def setting(name: str) -> str:
    return os.environ.get(name) or DEFAULTS[name]


def provider_label(provider: str) -> str:
    if provider == "elevenlabs":
        return f"ElevenLabs, модель: {setting('EN_ELEVENLABS_MODEL')}, голос: {setting('EN_ELEVENLABS_VOICE')}"
    return f"OpenAI, модель: {setting('EN_OPENAI_TTS_MODEL')}, голос: {setting('EN_OPENAI_TTS_VOICE')}"


def synthesize(word: str, provider: str, api_key: str) -> bytes:
    if provider == "elevenlabs":
        # A capital letter and a period make ElevenLabs read a lone word as a finished sentence, not cut short
        url = ELEVENLABS_URL.format(voice=setting("EN_ELEVENLABS_VOICE"))
        body = {"text": word[:1].upper() + word[1:] + ".", "model_id": setting("EN_ELEVENLABS_MODEL"),
                "language_code": "en"}
        headers = {"xi-api-key": api_key, "Content-Type": "application/json"}
    else:
        url = OPENAI_URL
        body = {"model": setting("EN_OPENAI_TTS_MODEL"), "voice": setting("EN_OPENAI_TTS_VOICE"),
                "input": word, "response_format": "mp3"}
        # instructions are supported only by gpt-4o-mini-tts and newer; tts-1 ignores them
        if not body["model"].startswith("tts-1"):
            body["instructions"] = INSTRUCTIONS
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    request = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except urllib.error.HTTPError as e:
            # 429 — rate limited, 5xx — service failure: wait and retry
            if e.code in (429, 500, 502, 503) and attempt < 2:
                time.sleep(5 * (attempt + 1))
                continue
            raise RuntimeError(f"{provider} вернул {e.code}: {e.read().decode('utf-8', 'replace')[:300]}") from e


def normalize(file: Path) -> float:
    """Normalizes the peak to TARGET_PEAK_DB and trims edge silence.
    Returns the source file's peak in dBFS (used to detect empty files)."""
    with tempfile.TemporaryDirectory() as tmp:
        raw, out = Path(tmp) / "raw.wav", Path(tmp) / "out.wav"
        subprocess.run(["lame", "--quiet", "--decode", str(file), str(raw)], check=True, stderr=subprocess.DEVNULL)
        with wave.open(str(raw)) as w:
            channels, rate = w.getnchannels(), w.getframerate()
            samples = array.array("h", w.readframes(w.getnframes()))
        if channels != 1:
            samples = samples[::channels]  # TTS returns mono; take one channel just in case

        peak = max((abs(x) for x in samples), default=0)
        peak_db = 20 * math.log10(max(peak, 1) / 32768)
        if peak_db < QUIET_DB:
            return peak_db  # leave an empty file alone — it needs to be re-voiced

        threshold = peak * 10 ** (SILENCE_DB / 20)
        loud = [i for i, x in enumerate(samples) if abs(x) >= threshold]
        margin = int(EDGE_MARGIN * rate)
        samples = samples[max(0, loud[0] - margin):loud[-1] + margin]

        gain = 32767 * 10 ** (TARGET_PEAK_DB / 20) / peak
        samples = array.array("h", (max(-32768, min(32767, round(x * gain))) for x in samples))

        with wave.open(str(out), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(samples.tobytes())
        subprocess.run(["lame", "--quiet", "-m", "m", "-b", "96", str(out), str(file)], check=True)
    return peak_db


def list_voices(api_key: str):
    """Prints the ElevenLabs voices this key can use, English ones first."""
    request = urllib.request.Request(ELEVENLABS_VOICES_URL, headers={"xi-api-key": api_key})
    with urllib.request.urlopen(request, timeout=60) as response:
        voices = json.load(response)["voices"]
    rows = []
    for v in voices:
        labels = v.get("labels") or {}
        rows.append((labels.get("language", "") not in ("", "en"), v["name"], v["voice_id"],
                     labels.get("accent", ""), labels.get("gender", ""), labels.get("age", ""),
                     labels.get("description", "") or labels.get("descriptive", "")))
    for _, name, voice_id, *info in sorted(rows):
        print(f"  {voice_id}  {name:<28} {', '.join(x for x in info if x)}")
    print("Голос для урока задаётся в .env: EN_ELEVENLABS_VOICE=<id>")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=FOLDER / "audio", help="папка для звуков")
    parser.add_argument("--limit", type=int, help="озвучить только первые N")
    parser.add_argument("--only", type=lambda v: set(v.split(",")), default=set(),
                        help="только эти темы или слова, через запятую: animals,food или cat,dog")
    parser.add_argument("--force", action="store_true", help="перезаписать готовые файлы")
    parser.add_argument("--redo", type=lambda v: set(v.split(",")), default=set(),
                        help="переозвучить только эти слова, через запятую: cat,dog")
    parser.add_argument("--provider", choices=list(API_KEYS), help="сервис озвучки (по умолчанию из EN_TTS_PROVIDER)")
    parser.add_argument("--dry-run", action="store_true", help="ничего не отправлять в сервис")
    parser.add_argument("--voices", action="store_true", help="показать голоса ElevenLabs, доступные по ключу")
    parser.add_argument("--normalize", action="store_true",
                        help="только выровнять громкость готовых файлов (без запросов в сервис)")
    args = parser.parse_args()

    if args.normalize:
        if not shutil.which("lame"):
            sys.exit("Нужен lame: brew install lame")
        files = sorted(args.out.glob("*.mp3"))
        with ThreadPoolExecutor(os.cpu_count() or 4) as pool:
            peaks = dict(zip(files, pool.map(normalize, files)))
        quiet = [f.stem for f, db in peaks.items() if db < QUIET_DB]
        print(f"Выровнено файлов: {len(files)}." + (f" Пустые (переозвучьте через --redo): {','.join(quiet)}" if quiet else ""))
        return

    load_envs()
    if args.voices:
        api_key = os.environ.get("ELEVENLABS_API_KEY") or sys.exit("Нет ключа: впишите ELEVENLABS_API_KEY в .env")
        list_voices(api_key)
        return

    provider = args.provider or setting("EN_TTS_PROVIDER")
    key_name = API_KEYS.get(provider) or sys.exit(f"Неизвестный EN_TTS_PROVIDER: {provider}. Можно: {', '.join(API_KEYS)}")
    api_key = os.environ.get(key_name, "")
    if not api_key and not args.dry_run:
        sys.exit(f"Нет ключа: впишите {key_name} в .env в корне репозитория (пример — .env.example)")

    rows = pick(read_words(), args.limit, args.only | args.redo)
    args.out.mkdir(parents=True, exist_ok=True)
    todo = [r for r in rows
            if args.force or r["word"] in args.redo or not (args.out / f"{r['slug']}.mp3").exists()]

    print(provider_label(provider))
    print(f"Слов: {len(rows)}, озвучить: {len(todo)}, уже готово: {len(rows) - len(todo)}")
    if args.dry_run:
        for r in todo:
            print(f"  {r['word']} -> audio/{r['slug']}.mp3")
        return

    can_normalize = shutil.which("lame") is not None
    if not can_normalize:
        print("  lame не найден — громкость не выравниваем (brew install lame)")

    def work(row):
        file = args.out / f"{row['slug']}.mp3"
        # On short text the service sometimes returns an empty file or silence — ask again
        for _ in range(RETRIES_ON_EMPTY):
            file.write_bytes(synthesize(row["word"], provider, api_key))
            try:
                if file.stat().st_size and (not can_normalize or normalize(file) >= QUIET_DB):
                    return
            except subprocess.CalledProcessError:
                pass  # lame couldn't read the response — corrupt file
        file.unlink(missing_ok=True)
        raise RuntimeError(f"{RETRIES_ON_EMPTY} раза пришла тишина или битый файл — попробуйте позже: --redo {row['word']}")

    failed = []
    with ThreadPoolExecutor(WORKERS[provider]) as pool:
        futures = {pool.submit(work, row): row["word"] for row in todo}
        for n, future in enumerate(as_completed(futures), 1):
            word = futures[future]
            try:
                future.result()
                print(f"  [{n}/{len(todo)}] {word}")
            except Exception as e:
                failed.append(word)
                print(f"  [{n}/{len(todo)}] {word} — ОШИБКА: {e}")

    print(f"Готово: озвучено {len(todo) - len(failed)}, ошибок: {len(failed)}"
          + (f". Повторить: python3 tools/speak.py --redo {','.join(failed)}" if failed else ""))


if __name__ == "__main__":
    main()
