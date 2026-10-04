"""Draws pictures for a reading lesson's words with the OpenAI Images API.

What to draw: <folder>/data/pictures.tsv (level, word, description); the shared style of the pictures:
"pictureStyle" in <folder>/game.json. The folder is a lesson, or a shared word folder (lessons/potter) that keeps
pictureStyle in its shared.json; a plain page without game.json (lessons/merlin) keeps it in lesson.json.
Key: OPENAI_API_KEY from the environment or from the .env file at the repo root.

Output (in that folder):
    images/domik.jpg, …   images.json — word -> file

Usage (a folder name under lessons/ or a path):
    python3 draw.py potter                         # draw everything that's missing
    python3 draw.py potter --limit 3               # first 3 — to check the style
    python3 draw.py read-syllables --redo домик,лето   # redraw these words
    python3 draw.py potter --force                 # redraw everything
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

HERE = Path(__file__).parent
LESSONS = HERE.parent.parent  # lessons/
sys.path.insert(0, str(LESSONS / "russian" / "tools"))
from speak import load_envs, translit  # noqa: E402 — shared helpers live next to the sounds

API_URL = "https://api.openai.com/v1/images/generations"
WORKERS = 4
SIZE = 256        # size to downscale to (px)
JPEG_QUALITY = 80

DEFAULTS = {
    "OPENAI_IMAGE_MODEL": "gpt-image-1-mini",
    "OPENAI_IMAGE_QUALITY": "low",  # low / medium / high — low is enough for 256 px
}

# The shared style of the pictures is "pictureStyle" in a lesson's game.json or a shared word folder's shared.json.
# Write it so that the model draws only what the description says: characters of the story belong in the style only
# as an appearance reference, otherwise the model adds them to every picture (read-syllables got a crowd of pigs
# instead of straw for «соломы»).


def setting(name: str) -> str:
    return os.environ.get(name) or DEFAULTS[name]


def read_pictures(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines()[1:]:  # the first line is the header
        if line.strip():
            level, word, what = line.split("\t")
            rows.append({"level": int(level), "word": word.strip(), "what": what.strip()})
    return rows


# Where pictureStyle lives: a reading lesson, a shared word folder, a plain page
STYLE_FILES = ["game.json", "shared.json", "lesson.json"]


def find_folder(name: str) -> Path:
    """A folder with data/pictures.tsv by name (potter, read-syllables) or by path (., ../potter)."""
    for folder in [Path(name), LESSONS / name]:
        if (folder / "data" / "pictures.tsv").exists():
            return folder.resolve()
    sys.exit(f"Не найдена папка {name} с data/pictures.tsv (например, potter или read-syllables)")


def read_style(folder: Path) -> str:
    for name in STYLE_FILES:
        if (folder / name).exists():
            style = json.loads((folder / name).read_text(encoding="utf-8")).get("pictureStyle", "")
            if style:
                return style
    sys.exit(f"В {folder.name} нет pictureStyle — общего стиля картинок ({' или '.join(STYLE_FILES)})")


def generate(what: str, style: str, api_key: str) -> bytes:
    body = {
        "model": setting("OPENAI_IMAGE_MODEL"),
        "prompt": f"{style}\nНарисуй: {what}.",
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
    parser.add_argument("folder", help="папка с data/pictures.tsv: имя в lessons/ (potter, read-syllables) или путь")
    parser.add_argument("--limit", type=int, help="нарисовать только первые N")
    parser.add_argument("--force", action="store_true", help="перерисовать всё")
    parser.add_argument("--redo", type=lambda v: set(v.split(",")), default=set(),
                        help="перерисовать только эти слова, через запятую")
    args = parser.parse_args()
    folder = find_folder(args.folder)
    style = read_style(folder)
    args.out = folder / "images"

    load_envs()
    api_key = os.environ.get("OPENAI_API_KEY") or sys.exit("Нет ключа: впишите OPENAI_API_KEY в .env")

    rows = read_pictures(folder / "data" / "pictures.tsv")
    if args.limit:
        rows = rows[:args.limit]
    args.out.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out.parent / "images.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}

    todo = []
    for row in rows:
        file = args.out / f"{translit(row['word'])}.jpg"
        manifest[row["word"]] = file.relative_to(args.out.parent).as_posix()
        if args.force or row["word"] in args.redo or not file.exists():
            todo.append((row, file))

    print(f"Модель: {setting('OPENAI_IMAGE_MODEL')}, качество: {setting('OPENAI_IMAGE_QUALITY')}. "
          f"Всего {len(rows)}, нарисовать {len(todo)}")

    def work(job):
        row, file = job
        save_small(generate(row["what"], style, api_key), file)
        return row["word"]

    failed = []
    with ThreadPoolExecutor(WORKERS) as pool:
        futures = {pool.submit(work, job): job[0]["word"] for job in todo}
        for n, future in enumerate(as_completed(futures), 1):
            word = futures[future]
            try:
                future.result()
                print(f"  [{n}/{len(todo)}] {word}")
            except Exception as e:
                failed.append(word)
                print(f"  [{n}/{len(todo)}] {word} — ОШИБКА: {e}")

    # The manifest lists only files that actually exist on disk
    manifest = {k: v for k, v in manifest.items() if (args.out.parent / v).exists()}
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Готово: {len(manifest)} картинок, ошибок: {len(failed)} {failed or ''}. Список: {manifest_path}")


if __name__ == "__main__":
    main()
