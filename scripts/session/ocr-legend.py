# 범례 시트 OCR: 기호 설명 글자(외곽선·선 글꼴이라 텍스트 레이어에 없음)를 읽어 기호 이름으로 쓴다.
# 결과: <out>/f<fi>.json  {"file_index", "W", "H", "words": [{"t", "b": [x0,y0,x1,y1] (0-1 정규화), "c"}]}
# 필요: tesseract, pypdfium2
# 사용: python3 scripts/session/ocr-legend.py <out 폴더> <fi>:<pdf> [<fi>:<pdf> ...]
import csv, json, os, subprocess, sys
import pypdfium2 as pdfium

DPI = 300

def main(out, specs):
    os.makedirs(out, exist_ok=True)
    for spec in specs:
        fi, pdf = spec.split(':', 1)
        page = pdfium.PdfDocument(pdf)[0]
        W, H = page.get_size()
        img = os.path.join(out, f'f{fi}.png')
        page.render(scale=DPI / 72).to_pil().convert('L').save(img)
        p = subprocess.run(['tesseract', img, '-', '--psm', '11', 'tsv'], capture_output=True, text=True,
                           env=dict(os.environ, OMP_THREAD_LIMIT='1'))
        rows = csv.DictReader(p.stdout.splitlines(), delimiter='\t', quoting=csv.QUOTE_NONE)
        k = DPI / 72
        words = []
        for r in rows:
            t = (r.get('text') or '').strip()
            if r.get('level') != '5' or not t:
                continue
            x, y, w, h = (int(r[c]) for c in ('left', 'top', 'width', 'height'))
            words.append({'t': t, 'b': [round(x / k / W, 5), round(y / k / H, 5), round((x + w) / k / W, 5), round((y + h) / k / H, 5)],
                          'c': float(r.get('conf') or 0)})
        os.remove(img)
        json.dump({'file_index': int(fi), 'W': W, 'H': H, 'words': words}, open(os.path.join(out, f'f{fi}.json'), 'w'))
        print(f'f{fi}', len(words), 'words', flush=True)

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2:])
