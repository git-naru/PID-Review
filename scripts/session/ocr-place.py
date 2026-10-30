# OCR 단어 박스로 시트 판독 결과(out/f*.json)의 bbox 채우기 (bbox가 비어 있는 설비·밸브·계기·라인만).
# 원본은 out.noloc/에 한 번 복사해 두고, 거기서 읽어 out/에 쓴다(여러 번 실행해도 같음). 그다음 assemble.mjs.
# 사용: python3 scripts/session/ocr-place.py <work>
import json, os, re, sys, glob, shutil
job = sys.argv[1]
OUT = os.path.join(job, 'out'); BK = os.path.join(job, 'out.noloc')
if not os.path.exists(BK): shutil.copytree(OUT, BK)
TR = str.maketrans({'O': '0', 'Q': '0', 'I': '1', 'D': '0'})
def canon(s):
    s = re.sub(r'[—–−‐]', '-', str(s or '').upper())
    return re.sub(r'[^A-Z0-9]', '', s).translate(TR)
def lev1(a, b):  # 편집 거리 ≤1
    if a == b: return True
    if abs(len(a) - len(b)) > 1: return False
    i = 0
    while i < min(len(a), len(b)) and a[i] == b[i]: i += 1
    return a[i+1:] == b[i+1:] or a[i+1:] == b[i:] or a[i:] == b[i+1:]
def union(bs): return [min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs)]
tot = {'node': [0, 0], 'line': [0, 0]}
for f in sorted(glob.glob(os.path.join(BK, 'f*-p1.json'))):
    name = os.path.basename(f); fi = int(re.match(r'f(\d+)-', name).group(1))
    ocrf = os.path.join(job, 'ocr', f'f{fi}.json')
    if not os.path.exists(ocrf): continue
    words = json.load(open(ocrf))['words']
    for w in words: w['k'] = canon(w['t'])
    # 같은 줄(가로/세로 각각)에서 이웃한 단어를 이어 붙인 후보도 만든다 (라인 번호가 공백으로 쪼개지는 경우)
    joined = []
    for w in words:
        if not w['k']: continue
        h = (w['b'][3] - w['b'][1]) if w['r'] == 0 else (w['b'][2] - w['b'][0])
        nxt = [v for v in words if v is not w and v['k'] and v['r'] == w['r'] and (
            (w['r'] == 0 and abs(v['b'][1] - w['b'][1]) < h * 0.5 and 0 <= v['b'][0] - w['b'][2] < h * 1.5) or
            (w['r'] == 90 and abs(v['b'][0] - w['b'][0]) < h * 0.5 and 0 <= w['b'][1] - v['b'][3] < h * 1.5))]
        for v in nxt[:1]:
            joined.append({'k': w['k'] + v['k'], 'b': union([w['b'], v['b']]), 'c': min(w['c'], v['c'])})
    cands = [w for w in words if w['k']] + joined
    def find(key, prefix=False):
        if len(key) < 4: return None
        hits = [w for w in cands if w['k'] == key] or ([w for w in cands if w['k'].startswith(key)] if prefix else [])
        if not hits and len(key) >= 8:
            hits = [w for w in cands if lev1(w['k'], key)]
        if not hits: return None
        return max(hits, key=lambda w: w['c'])['b']
    def instrument(tag):
        m = re.match(r'^(?:\d{3,5}-)?([A-Z]{1,6})-?(\d{2,5}[A-Z]?)', str(tag or '').upper().replace(' ', ''))
        if not m: return None
        L, N = canon(m.group(1)), canon(m.group(2))
        for w in [x for x in words if x['k'] == N and x['r'] == 0]:
            h = w['b'][3] - w['b'][1]; cx = (w['b'][0] + w['b'][2]) / 2
            up = [x for x in words if x['k'] == L and x['r'] == 0 and 0 < w['b'][1] - x['b'][3] < h * 1.5 and abs((x['b'][0] + x['b'][2]) / 2 - cx) < h * 2]
            if up: return union([w['b'], up[0]['b']])
        return None
    d = json.load(open(f))
    for n in d.get('nodes', []):
        if n.get('bbox') or n.get('category') in ('offpage', 'battery_limit'): continue
        tot['node'][1] += 1
        b = find(canon(n.get('tag'))) if n.get('tag') else None
        if not b and n.get('category') == 'instrument': b = instrument(n.get('tag'))
        if not b and n.get('category') == 'equipment':  # 이름의 짧은 식별자 (PC#1A 등)
            for t in re.findall(r'[A-Z]{1,4}#\w+', str(n.get('name') or '').upper()): b = b or find(canon(t))
        if b: n['bbox'] = b; tot['node'][0] += 1
    for l in d.get('lines', []):
        if l.get('bbox') or l.get('kind') == 'signal' or not l.get('line_no'): continue
        tot['line'][1] += 1
        ln = str(l['line_no'])
        b = find(canon(ln))
        if not b:
            core = '-'.join(re.split(r'-', ln)[:3])
            if len(canon(core)) >= 7: b = find(canon(core), prefix=True)
        if b: l['bbox'] = b; tot['line'][0] += 1
    json.dump(d, open(os.path.join(OUT, name), 'w'), ensure_ascii=False)
print(tot)
