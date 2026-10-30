# 시트별 OCR 단어 박스 추출 (도면 글자가 외곽선이라 텍스트 레이어에 태그가 없는 CAD 출력용).
# 원본(가로 글자) + 90° 회전(세로 글자). 결과는 <work>/ocr/f<fi>.json, 0-1 정규화 좌표.
# 필요: tesseract, pdftoppm, Pillow  (apt-get install -y tesseract-ocr poppler-utils)
# 사용: python3 scripts/session/ocr-sheets.py <work>
import json, os, subprocess, sys, csv
from concurrent.futures import ThreadPoolExecutor
job = sys.argv[1]
named = os.path.join(job, 'named'); out = os.path.join(job, 'ocr'); os.makedirs(out, exist_ok=True)
files = sorted(os.listdir(named))
sheets = json.load(open(os.path.join(job, 'sheets.json')))
sheets = sheets['sheets'] if isinstance(sheets, dict) else sheets
manifest = json.load(open(os.path.join(job, 'manifest.json')))
mf = manifest['files'] if isinstance(manifest, dict) else manifest
todo = [s for s in sheets if s.get('sheet_type') == 'pid']
env = dict(os.environ, OMP_THREAD_LIMIT='1')

def tsv(img):
    p = subprocess.run(['tesseract', img, '-', '--psm', '11', 'tsv'], capture_output=True, text=True, env=env)
    rows = list(csv.DictReader(p.stdout.splitlines(), delimiter='\t', quoting=csv.QUOTE_NONE))
    return rows

def one(s):
    fi = s['file_index']; dst = os.path.join(out, f'f{fi}.json')
    if os.path.exists(dst): return fi
    name = mf[fi]['name'] if isinstance(mf[fi], dict) else mf[fi]
    pdf = os.path.join(named, name)
    base = os.path.join(out, f'f{fi}')
    subprocess.run(['pdftoppm', '-r', '220', '-png', '-f', str(s.get('page', 1)), '-l', str(s.get('page', 1)), '-singlefile', pdf, base], check=True)
    img = base + '.png'
    from PIL import Image
    im = Image.open(img); W, H = im.size
    rimg = base + '-r.png'; im.rotate(90, expand=True).save(rimg)  # 반시계 90°: 아래→위로 쓴 세로 글자가 가로가 됨
    words = []
    for rot, path in ((0, img), (90, rimg)):
        for r in tsv(path):
            t = (r.get('text') or '').strip()
            if not t or r.get('level') != '5': continue
            x, y, w, h = (int(r[k]) for k in ('left', 'top', 'width', 'height'))
            if rot == 0: box = [x / W, y / H, (x + w) / W, (y + h) / H]
            else:  # 반시계 90° 회전 이미지의 (x', y') → 원본 X = W - y', Y = x'
                box = [(W - (y + h)) / W, x / H, (W - y) / W, (x + w) / H]
            words.append({'t': t, 'b': [round(v, 5) for v in box], 'r': rot, 'c': float(r.get('conf') or 0)})
    json.dump({'file_index': fi, 'words': words}, open(dst, 'w'))
    os.remove(img); os.remove(rimg)
    return fi

with ThreadPoolExecutor(4) as ex:
    for i, fi in enumerate(ex.map(one, todo)):
        print(i + 1, '/', len(todo), 'f%d' % fi, flush=True)
