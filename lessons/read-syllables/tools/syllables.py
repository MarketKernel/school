"""Splits words into syllables and counts how often each syllable occurs.

A syllable is a consonant + vowel pair (ма, ви, де…). Other letters
(single vowels, consonants without a following vowel) are shown separately
in the split but are not counted as syllables:
    увидев -> у-ви-де-в   (syllables: ви, де)

Usage:
    python3 syllables.py                    # reads words from data/words.txt
    python3 syllables.py words.txt -s syllables.txt -w words_split.txt
"""

import argparse
from collections import Counter
from pathlib import Path

VOWELS = set("аеёиоуыэюя")
SIGNS = set("ьъ")  # neither vowels nor consonants — attach to the previous part


def is_consonant(ch: str) -> bool:
    return ch.isalpha() and ch not in VOWELS and ch not in SIGNS


def split_word(word: str) -> list[str]:
    """Splits a word into parts: consonant + vowel pairs and single letters."""
    parts = []
    i = 0
    while i < len(word):
        ch = word[i]
        nxt = word[i + 1] if i + 1 < len(word) else ""
        if is_consonant(ch) and nxt in VOWELS:
            parts.append(ch + nxt)
            i += 2
            continue
        if ch in SIGNS and parts:
            parts[-1] += ch
        elif ch != "-":
            parts.append(ch)
        i += 1
    return parts


def is_syllable(part: str) -> bool:
    return len(part) == 2 and is_consonant(part[0]) and part[1] in VOWELS


def read_words(path: Path) -> list[str]:
    """Reads words.txt (format "count<TAB>word") or a plain word list."""
    words = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            words.append(line.split("\t")[-1].lower())
    return words


def main():
    data = Path(__file__).parent.parent / "data"
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file", nargs="?", default=data / "words.txt", type=Path)
    parser.add_argument("-s", "--syllables", type=Path, default=data / "syllables.txt",
                        help="куда сохранить слоги с частотой")
    parser.add_argument("-w", "--words", type=Path, default=data / "words_split.txt",
                        help="куда сохранить слова, разбитые на слоги")
    args = parser.parse_args()

    words = read_words(args.file)
    counts = Counter()
    split_lines = []
    for word in words:
        parts = split_word(word)
        split_lines.append(f"{word}\t{'-'.join(parts)}")
        counts.update(p for p in parts if is_syllable(p))

    # Most frequent syllables first, ties broken alphabetically
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))

    args.words.write_text("\n".join(split_lines) + "\n", encoding="utf-8")
    args.syllables.write_text("\n".join(f"{n}\t{s}" for s, n in ranked) + "\n", encoding="utf-8")

    print(f"Слов: {len(words)}, уникальных слогов: {len(counts)}")
    print(f"Разбивка слов: {args.words}")
    print(f"Слоги по частоте: {args.syllables}")


if __name__ == "__main__":
    main()
