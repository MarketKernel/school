"""Splits a text into unique words and sorts them by frequency.

Every word form counts as a separate word («дом», «дома», «домик» are different).

A reading lesson made from a text keeps the result as its data/words.txt.

Usage:
    python3 words.py text.txt                  # print the words
    python3 words.py ../../read-syllables/data/text1.txt -o ../../read-syllables/data/words.txt
"""

import argparse
import re
from collections import Counter
from pathlib import Path

# A word is letters (Cyrillic/Latin) with optional inner hyphens: «просто-напросто», «кто-то»
WORD_RE = re.compile(r"[а-яёa-z]+(?:-[а-яёa-z]+)*", re.IGNORECASE)


def count_words(text: str) -> Counter:
    words = (w.lower() for w in WORD_RE.findall(text))
    return Counter(words)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file", type=Path, help="текст, из которого брать слова")
    parser.add_argument("-o", "--output", type=Path, help="куда сохранить список слов")
    args = parser.parse_args()

    counts = count_words(args.file.read_text(encoding="utf-8"))
    # Most frequent first, ties broken alphabetically
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))

    lines = [f"{n}\t{word}" for word, n in ranked]
    result = "\n".join(lines)

    if args.output:
        args.output.write_text(result + "\n", encoding="utf-8")
        print(f"Сохранено в {args.output}")
    else:
        print(result)

    print(f"\nВсего слов: {sum(counts.values())}, уникальных: {len(counts)}")


if __name__ == "__main__":
    main()
