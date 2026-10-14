#!/usr/bin/env python3
"""Render a PDF page with source text highlighted when it can be matched exactly."""
import os
import re
import sys
import fitz


def main():
    if len(sys.argv) != 5:
        raise RuntimeError("Usage: highlight_page.py <pdf> <page> <text-file> <output>")
    pdf_path, page_value, text_path, output_path = sys.argv[1:]
    page_number = int(page_value)
    with open(text_path, "r", encoding="utf-8") as handle:
        source_text = handle.read()
    document = fitz.open(pdf_path)
    if document.needs_pass:
        raise RuntimeError("This PDF is password-protected.")
    if page_number < 1 or page_number > len(document):
        raise RuntimeError("The cited page is outside this PDF.")
    page = document[page_number - 1]

    # Long passages often wrap across PDF text blocks. Search exact, short windows until
    # one is found, then highlight every returned rectangle for that matching passage.
    normalized = re.sub(r"\s+", " ", source_text).strip()
    candidates = []
    for sentence in re.split(r"(?<=[.!?])\s+|\n+", normalized):
        sentence = sentence.strip()
        if len(sentence) >= 25:
            candidates.append(sentence[:180])
    words = normalized.split()
    for size in (18, 12, 8, 5):
        if len(words) >= size:
            candidates.extend(" ".join(words[index:index + size]) for index in range(0, min(10, len(words) - size + 1), 3))
    candidates.append(normalized[:100])

    rectangles = []
    for candidate in candidates:
        candidate = candidate.strip()
        if len(candidate) < 18:
            continue
        try:
            rectangles = page.search_for(candidate, quads=False)
        except Exception:
            rectangles = []
        if rectangles:
            break
    if rectangles:
        annotation = page.add_highlight_annot(rectangles)
        annotation.set_colors(stroke=(1.0, 0.72, 0.16))
        annotation.set_opacity(0.42)
        annotation.update()
    pixmap = page.get_pixmap(matrix=fitz.Matrix(1.6, 1.6), alpha=False)
    pixmap.save(output_path)
    document.close()
    print("highlighted" if rectangles else "not-found")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
