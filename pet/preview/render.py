from pathlib import Path
from playwright.sync_api import sync_playwright

here = Path(__file__).parent
out = here / "preview.png"

with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True)
    page = browser.new_page(viewport={"width": 1080, "height": 1400}, device_scale_factor=2)
    page.goto((here / "preview.html").as_uri())
    page.wait_for_timeout(700)
    page.screenshot(path=str(out), full_page=True)
    browser.close()

print("ok", out, out.stat().st_size, "bytes")
