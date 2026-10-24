"""Rebuild the 5x7 Latin subset from the bundled Adafruit source."""
import json
import re
from pathlib import Path

assets = Path(__file__).with_name('assets')
source = assets.joinpath('adafruit-glcdfont.c').read_text()
array = source.split('font[] PROGMEM = {', 1)[1].split('};', 1)[0]
array = re.sub(r'//[^\n]*', '', array)
values = [int(v, 16) for v in re.findall(r'0x[0-9A-Fa-f]+', array)]
assert len(values) == 256 * 5
# Keep seven-row glyphs only. Uppercase letters and digits are guaranteed.
glyphs = {chr(c): values[c*5:c*5+5] for c in range(32, 127)
          if all(v < 128 for v in values[c*5:c*5+5])}
assert all(c in glyphs for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789?:/- ')
assets.joinpath('latin-5x7.json').write_text(json.dumps(glyphs) + '\n')
print(f'{len(glyphs)} glyphs; 5 columns × 7 rows; 6-cell character advance')
