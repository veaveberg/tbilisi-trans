"""Rebuild the bundled bitmap subset: python3 subset-font.py path/to/unifont.hex.gz."""
import gzip
import json
import sys
from pathlib import Path

ranges = [(0x20, 0x7e), (0xa0, 0xff), (0x10a0, 0x10ff), (0x1c90, 0x1cbf)]
glyphs = {}
with gzip.open(sys.argv[1], 'rt') as source:
    for line in source:
        code, bits = line.strip().split(':')
        if any(start <= int(code, 16) <= end for start, end in ranges):
            glyphs[chr(int(code, 16))] = bits
assert all(c in glyphs for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789თავისუფლებისᲗᲐᲕ')
Path(__file__).with_name('assets').joinpath('unifont.json').write_text(json.dumps(glyphs, ensure_ascii=False) + '\n')
print(f'Bundled {len(glyphs)} bitmap glyphs')
