#!/usr/bin/env python3
"""
ARENA COMMAND — BRAND LINT (rule enforcement)
=============================================
Scans design/brand/**/*.svg and tools/brand_gen.py against the hard logo rules.
Run: python3 tools/brand_lint.py   (exit 1 on any violation)
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRAND = os.path.join(ROOT, "design", "brand")

FORBIDDEN_TAGS = ["<circle", "<ellipse", "<path", "<text", "<tspan", "<image", "<use"]
FORBIDDEN_ATTR = ["rx=", "ry=", "rx =", "ry =", "d=\"", "d='"]
FORBIDDEN_D = re.compile(r"[QCAqcAa]")   # curve/arc commands never allowed in path data
TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S)
DATATEXT_RE = re.compile(r'data-text="(.*?)"')

# widths the sidebar system allows (u = px at nominal render size)
ALLOWED_ICON_W = {64}
ALLOWED_LOCKUP_W = {240}
SHEET_OK = {"construction-sheet.svg", "vertical-template.svg", "module-icons.svg", "mark-states.svg"}

errors, warnings, checked = [], [], 0


def lint_svg(path):
    global checked
    checked += 1
    name = os.path.basename(path)
    src = open(path).read()
    rel = os.path.relpath(path, ROOT)

    for tag in FORBIDDEN_TAGS:
        if tag in src:
            errors.append(f"{rel}: forbidden element {tag!r} (no curves/ovals/round/text allowed)")
    for attr in FORBIDDEN_ATTR:
        if attr in src and name:  # path d= is doubly banned
            errors.append(f"{rel}: forbidden attribute/feature {attr!r}")

    m = re.search(r'viewBox="0 0 (\d+) (\d+)"', src)
    if not m:
        errors.append(f"{rel}: missing viewBox")
    else:
        w = int(m.group(1))
        if name not in SHEET_OK:
            if name.startswith("lockup-"):
                if w not in ALLOWED_LOCKUP_W:
                    errors.append(f"{rel}: lockup width {w}u not in {sorted(ALLOWED_LOCKUP_W)} (must fit expanded sidebar)")
            else:  # core/, icon-*, mark-*
                if w not in ALLOWED_ICON_W:
                    errors.append(f"{rel}: icon width {w}u not in {sorted(ALLOWED_ICON_W)} (must fit collapsed sidebar)")

    for t in TITLE_RE.findall(src) + DATATEXT_RE.findall(src):
        if "K" in t:
            errors.append(f"{rel}: capital K found in {t!r} — FORBIDDEN")

    for sw in re.findall(r'stroke-width="([\d.]+)"', src):
        if float(sw) > 2.0:
            warnings.append(f"{rel}: stroke-width {sw} > 2u (hairline system max)")

    for c in re.findall(r'fill="(#[0-9A-Fa-f]{6})"|stroke="(#[0-9A-Fa-f]{6})"', src):
        pass  # palette conformance handled in LOGO-SYSTEM.md; geometry is the hard gate


def lint_generator():
    gen = open(os.path.join(ROOT, "tools", "brand_gen.py")).read()
    if '"K":' in gen.split("GLYPH = {")[1].split("}")[0]:
        errors.append("brand_gen.py: a 'K' glyph exists in the alphabet — FORBIDDEN")
    for key in re.findall(r'"\w[\w ]*":\s*"\w[\w ]*"', gen.split("WORDMARK = {")[1].split("}")[0]):
        text = key.split(":")[1].strip().strip('"')
        if "K" in text:
            errors.append(f"brand_gen.py: wordmark {text!r} contains capital K — FORBIDDEN")


def main():
    for dirpath, _dirs, files in os.walk(BRAND):
        if "previews" in dirpath:
            continue
        for f in sorted(files):
            if f.endswith(".svg"):
                lint_svg(os.path.join(dirpath, f))
    lint_generator()

    print(f"brand_lint: {checked} SVG assets + generator scanned")
    for w in warnings:
        print("  WARN ", w)
    for e in errors:
        print("  FAIL ", e)
    if errors:
        print(f"RESULT: FAIL ({len(errors)} violations)")
        sys.exit(1)
    print("RESULT: PASS — no circles, ovals, curves, text elements, or capital K; widths conform")


if __name__ == "__main__":
    main()
