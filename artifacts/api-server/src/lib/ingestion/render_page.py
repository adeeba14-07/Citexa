#!/usr/bin/env python3
"""Render one PDF page to a PNG on demand (used by the source viewer when no stored preview exists)."""

import json
import sys

import fitz


def main():
    if len(sys.argv) != 5:
        raise RuntimeError("Usage: render_page.py <pdf-path> <page-number> <output-png> <scale>")
    pdf_path, page_arg, output_path, scale_arg = sys.argv[1:]
    number = int(page_arg)
    scale = max(0.5, min(3.0, float(scale_arg)))
    document = fitz.open(pdf_path)
    try:
        if document.needs_pass:
            raise RuntimeError("This PDF is password-protected.")
        count = len(document)
        if number < 1 or number > count:
            raise RuntimeError(f"Page {number} is out of range (this file has {count} pages).")
        pixmap = document[number - 1].get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        pixmap.save(output_path)
    finally:
        document.close()
    print(json.dumps({"pageCount": count}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
