"""PDF 페이지를 판독용 이미지로 렌더링한다 (브라우저 엔진 public/engine.js의 pageImages와 같은 구성).

각 페이지마다: 전체 1장(긴 변 1600px) + 6% 겹치게 자른 2x2 확대 이미지 4장(각 긴 변 약 1400px).
사용법: python3 render_pages.py <pdf> <file_index> <out_dir>
표준 출력: 페이지별 이미지 경로와 페이지 정규화 범위(JSON)
"""
import json
import os
import sys

import pypdfium2 as pdfium

TILE_LONG_SIDE = 1400
OVERVIEW_LONG_SIDE = 1600
OVERLAP = 0.06


def main(pdf_path, file_index, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    doc = pdfium.PdfDocument(pdf_path)
    pages = []
    for i in range(len(doc)):
        page = doc[i]
        w, h = page.get_size()
        scale = TILE_LONG_SIDE * 2 / max(w, h)
        img = page.render(scale=scale).to_pil().convert("RGB")
        W, H = img.size
        images = []
        k = OVERVIEW_LONG_SIDE / max(W, H)
        overview = img.resize((round(W * k), round(H * k))) if k < 1 else img
        p0 = os.path.join(out_dir, f"f{file_index}-p{i + 1}-0.jpg")
        overview.save(p0, quality=88)
        images.append({"path": p0, "range": [0, 0, 1, 1], "kind": "whole sheet"})
        tw, th = W / 2, H / 2
        for r in range(2):
            for c in range(2):
                x0, y0 = max(0, (c - OVERLAP) * tw), max(0, (r - OVERLAP) * th)
                x1, y1 = min(W, (c + 1 + OVERLAP) * tw), min(H, (r + 1 + OVERLAP) * th)
                p = os.path.join(out_dir, f"f{file_index}-p{i + 1}-{len(images)}.jpg")
                img.crop((round(x0), round(y0), round(x1), round(y1))).save(p, quality=88)
                images.append({"path": p, "range": [round(x0 / W, 3), round(y0 / H, 3), round(x1 / W, 3), round(y1 / H, 3)], "kind": "enlarged part"})
        pages.append({"page": i + 1, "images": images})
        page.close()
    doc.close()
    print(json.dumps(pages))


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]), sys.argv[3])
