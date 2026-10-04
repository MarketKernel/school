"""Draws a picture for every word in data/words.tsv with the OpenAI Images API.

Key: OPENAI_API_KEY from the environment or from the .env file at the repo root.

Output:
    images/cat.jpg, images/ice-cream.jpg, …

Usage:
    python3 draw.py --dry-run             # show what would be drawn, without requests
    python3 draw.py --limit 5             # first 5 — to check the style
    python3 draw.py                       # draw everything that's missing
    python3 draw.py --only numbers        # only these topics (or words)
    python3 draw.py --redo cat,dog        # redraw these words
    python3 draw.py --force               # redraw everything
"""

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from common import FOLDER, load_envs, pick, read_words

API_URL = "https://api.openai.com/v1/images/generations"
WORKERS = 4
SIZE = 320        # size to downscale to (px)
JPEG_QUALITY = 80

DEFAULTS = {
    "OPENAI_IMAGE_MODEL": "gpt-image-1-mini",
    "OPENAI_IMAGE_QUALITY": "low",  # low / medium / high — low is enough for 320 px
}

# Shared style for all pictures so the cards look like one set
STYLE = (
    "Картинка для детских карточек с английскими словами. Рисуй строго только то, что указано после слова «Нарисуй», "
    "ничего лишнего не добавляй. Люди и дети — милые мультяшные, животные — добрые и не страшные. "
    "Стиль: плоский, мягкие округлые формы, яркие тёплые цвета, мягкие контуры, чистый белый фон. "
    "Главное — крупно по центру. Без текста, без букв и без надписей; цифры — только если о них прямо сказано."
)


def setting(name: str) -> str:
    return os.environ.get(name) or DEFAULTS[name]


def generate(what: str, api_key: str) -> bytes:
    body = {
        "model": setting("OPENAI_IMAGE_MODEL"),
        "prompt": f"{STYLE}\nНарисуй: {what}.",
        "size": "1024x1024",
        "quality": setting("OPENAI_IMAGE_QUALITY"),
        "n": 1,
    }
    request = urllib.request.Request(
        API_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                return base64.b64decode(json.load(response)["data"][0]["b64_json"])
        except urllib.error.HTTPError as e:
            # 429 — rate limit (20 images/min for mini), 5xx — OpenAI failure: wait and retry
            if e.code in (429, 500, 502, 503) and attempt < 4:
                time.sleep(15 * (attempt + 1))
                continue
            raise RuntimeError(f"OpenAI вернул {e.code}: {e.read().decode('utf-8', 'replace')[:300]}") from e


def save_small(png: bytes, out: Path):
    """Downscales the image to SIZE px and saves it as JPEG (sips ships with every macOS)."""
    with tempfile.TemporaryDirectory() as tmp:
        big = Path(tmp) / "big.png"
        big.write_bytes(png)
        subprocess.run(["sips", "-Z", str(SIZE), "-s", "format", "jpeg", "-s", "formatOptions", str(JPEG_QUALITY),
                        str(big), "--out", str(out)], check=True, capture_output=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=FOLDER / "images", help="папка для картинок")
    parser.add_argument("--limit", type=int, help="нарисовать только первые N")
    parser.add_argument("--only", type=lambda v: set(v.split(",")), default=set(),
                        help="только эти темы или слова, через запятую: animals,food или cat,dog")
    parser.add_argument("--force", action="store_true", help="перерисовать всё")
    parser.add_argument("--redo", type=lambda v: set(v.split(",")), default=set(),
                        help="перерисовать только эти слова, через запятую: cat,dog")
    parser.add_argument("--dry-run", action="store_true", help="ничего не отправлять в сервис")
    args = parser.parse_args()

    load_envs()
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key and not args.dry_run:
        sys.exit("Нет ключа: впишите OPENAI_API_KEY в .env в корне репозитория (пример — .env.example)")

    rows = pick(read_words(), args.limit, args.only | args.redo)
    args.out.mkdir(parents=True, exist_ok=True)
    todo = [r for r in rows
            if args.force or r["word"] in args.redo or not (args.out / f"{r['slug']}.jpg").exists()]

    print(f"Модель: {setting('OPENAI_IMAGE_MODEL')}, качество: {setting('OPENAI_IMAGE_QUALITY')}. "
          f"Слов: {len(rows)}, нарисовать: {len(todo)}")
    if args.dry_run:
        for r in todo:
            print(f"  {r['word']}: {r['picture']} -> images/{r['slug']}.jpg")
        return

    def work(row):
        save_small(generate(row["picture"], api_key), args.out / f"{row['slug']}.jpg")

    failed = []
    with ThreadPoolExecutor(WORKERS) as pool:
        futures = {pool.submit(work, row): row["word"] for row in todo}
        for n, future in enumerate(as_completed(futures), 1):
            word = futures[future]
            try:
                future.result()
                print(f"  [{n}/{len(todo)}] {word}")
            except Exception as e:
                failed.append(word)
                print(f"  [{n}/{len(todo)}] {word} — ОШИБКА: {e}")

    print(f"Готово: нарисовано {len(todo) - len(failed)}, ошибок: {len(failed)}"
          + (f". Повторить: python3 tools/draw.py --redo {','.join(failed)}" if failed else ""))


if __name__ == "__main__":
    main()
