"""Usage: python3 qa/technique-contact.py [evidence_dir] (or EVIDENCE_DIR; default qa/evidence) -- readable paired contact sheets of blurred public frames, without predictions."""
import json
import os
import sys
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("EVIDENCE_DIR", Path(__file__).resolve().parent / "evidence"))
shots = json.loads((root / "shots.json").read_text())
for start in range(0, len(shots), 6):
    group = shots[start:start + 6]
    sheet = Image.new("RGB", (1280, len(group) * 390), "#eeeeee")
    draw = ImageDraw.Draw(sheet)
    for row, s in enumerate(group):
        draw.text((10, row * 390 + 5), f"{s['id']}  t={s['t']:.3f}  hitter={s['side']}   BEFORE (-0.3s) / HIT", fill="black")
        for col, key in enumerate(["before", "hit"]):
            image = Image.open(s["frames"][key])
            if s["clip"] in ["test_2_portrait", "test_5_portrait"]:
                # Remove only the public derivative's black letterboxing.
                top = round(image.height * (656 / 1920))
                image = image.crop((0, top, image.width, top + round(image.width * 1080 / 1920)))
            image.thumbnail((640, 360))
            sheet.paste(image, (col * 640, row * 390 + 28))
    sheet.save(root / "frames" / f"contact-{start//6+1:02}.jpg", quality=92)
print(f"CONTACT_DONE {len(shots)} shots, {(len(shots)+5)//6} sheets")
