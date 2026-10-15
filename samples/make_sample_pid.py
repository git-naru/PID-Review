"""데모/테스트용 샘플 P&ID PDF 3장(범례 1 + P&ID 2)을 생성한다.

  - PID-100-000: Legend (라인 번호 체계, 유체 코드, 배관 Class, 설비/계기 문자, 기호)
의도적으로 다음 결함을 포함한다 (검증 로직 확인용):
  - PID-100-001: TK-102 SLOP TANK 미연결, 4"-P-1004 라인 Spec 누락, 2"-P-1006 라인 끝단 미연결
  - PID-100-002: TO PID-100-003 Off-page (해당 도면 미입력), LT-201 태그 중복,
                 3"-P-2003-A2A 라인 Class가 범례에 없음

사용법: python3 samples/make_sample_pid.py
"""
import os

from reportlab.lib.pagesizes import A3, landscape
from reportlab.pdfgen import canvas

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
W, H = landscape(A3)


def text_c(c, x, y, s, size=7, bold=False):
    c.setFont("Helvetica-Bold" if bold else "Helvetica", size)
    c.drawCentredString(x, y, s)


def arrow(c, x1, y1, x2, y2):
    c.line(x1, y1, x2, y2)
    import math
    ang = math.atan2(y2 - y1, x2 - x1)
    L = 7
    for d in (2.7, -2.7):
        c.line(x2, y2, x2 - L * math.cos(ang + d / 6), y2 - L * math.sin(ang + d / 6))


def pipe(c, pts, label=None, label_at=0, dash=None, lw=1.2):
    c.setLineWidth(lw)
    if dash:
        c.setDash(*dash)
    for i in range(len(pts) - 2):
        c.line(*pts[i], *pts[i + 1])
    arrow(c, *pts[-2], *pts[-1])
    c.setDash()
    if label:
        (x1, y1), (x2, y2) = pts[label_at], pts[label_at + 1]
        mx, my = (x1 + x2) / 2, (y1 + y2) / 2
        if abs(y1 - y2) < 1:
            text_c(c, mx, my + 4, label, 6.5)
        else:
            c.saveState()
            c.translate(mx - 4, my)
            c.rotate(90)
            text_c(c, 0, 0, label, 6.5)
            c.restoreState()


def vessel_v(c, x, y, w, h, tag, name):
    c.setLineWidth(1.4)
    c.roundRect(x - w / 2, y - h / 2, w, h, w / 2.5)
    text_c(c, x, y + 4, tag, 8, True)
    text_c(c, x, y - 6, name, 6)


def tank(c, x, y, w, h, tag, name):
    c.setLineWidth(1.4)
    c.rect(x - w / 2, y - h / 2, w, h)
    c.line(x - w / 2, y + h / 2, x, y + h / 2 + 12)
    c.line(x, y + h / 2 + 12, x + w / 2, y + h / 2)
    text_c(c, x, y + 4, tag, 8, True)
    text_c(c, x, y - 6, name, 6)


def pump(c, x, y, tag, name):
    c.setLineWidth(1.4)
    c.circle(x, y, 16)
    c.line(x - 12, y - 22, x + 12, y - 22)
    c.line(x - 12, y - 22, x - 8, y - 12)
    c.line(x + 12, y - 22, x + 8, y - 12)
    text_c(c, x, y - 34, tag, 8, True)
    text_c(c, x, y - 43, name, 6)


def exchanger(c, x, y, tag, name):
    c.setLineWidth(1.4)
    c.roundRect(x - 50, y - 15, 100, 30, 14)
    c.line(x - 34, y - 15, x - 34, y + 15)
    text_c(c, x + 6, y + 1, tag, 8, True)
    text_c(c, x + 6, y - 24, name, 6)


def instrument(c, x, y, tag, line_to=None):
    c.setLineWidth(0.8)
    c.circle(x, y, 13)
    c.line(x - 13, y, x + 13, y)
    letters, num = tag.split("-")
    text_c(c, x, y + 3, letters, 6, True)
    text_c(c, x, y - 7, num, 6)
    if line_to:
        c.setDash(2, 2)
        c.line(x, y - 13, *line_to)
        c.setDash()


def control_valve(c, x, y, tag):
    c.setLineWidth(1)
    p = c.beginPath()
    p.moveTo(x - 9, y - 6); p.lineTo(x + 9, y + 6); p.lineTo(x + 9, y - 6); p.lineTo(x - 9, y + 6); p.close()
    c.drawPath(p)
    c.line(x, y, x, y + 14)
    c.arc(x - 8, y + 10, x + 8, y + 22, 0, 180)
    text_c(c, x, y - 16, tag, 6.5, True)


def psv(c, x, y, tag):
    c.setLineWidth(1)
    p = c.beginPath()
    p.moveTo(x - 7, y); p.lineTo(x + 7, y); p.lineTo(x, y + 10); p.close()
    c.drawPath(p)
    p = c.beginPath()
    p.moveTo(x, y + 10); p.lineTo(x + 12, y + 3); p.lineTo(x + 12, y + 17); p.close()
    c.drawPath(p)
    text_c(c, x + 2, y + 24, tag, 6.5, True)


def offpage(c, x, y, text, direction="right"):
    c.setLineWidth(1)
    p = c.beginPath()
    if direction == "right":
        p.moveTo(x, y - 9); p.lineTo(x + 70, y - 9); p.lineTo(x + 82, y); p.lineTo(x + 70, y + 9); p.lineTo(x, y + 9); p.close()
        c.drawPath(p)
        text_c(c, x + 38, y - 2.5, text, 6.5, True)
    else:
        p.moveTo(x, y); p.lineTo(x + 12, y - 9); p.lineTo(x + 82, y - 9); p.lineTo(x + 82, y + 9); p.lineTo(x + 12, y + 9); p.close()
        c.drawPath(p)
        text_c(c, x + 46, y - 2.5, text, 6.5, True)


def frame(c, dwg_no, title, rev="0"):
    c.setLineWidth(2)
    c.rect(20, 20, W - 40, H - 40)
    # title block
    c.setLineWidth(1)
    x0, y0 = W - 340, 20
    c.rect(x0, y0, 320, 80)
    c.line(x0, y0 + 40, x0 + 320, y0 + 40)
    c.line(x0 + 220, y0, x0 + 220, y0 + 40)
    text_c(c, x0 + 160, y0 + 58, title, 10, True)
    c.setFont("Helvetica", 7)
    c.drawString(x0 + 8, y0 + 24, "DWG NO.")
    c.setFont("Helvetica-Bold", 10)
    c.drawString(x0 + 8, y0 + 10, dwg_no)
    c.setFont("Helvetica", 7)
    c.drawString(x0 + 228, y0 + 24, "REV.")
    c.setFont("Helvetica-Bold", 10)
    c.drawString(x0 + 228, y0 + 10, rev)
    text_c(c, x0 + 160, y0 + 45, "PIPING AND INSTRUMENT DIAGRAM - SAMPLE PROJECT", 7)


def data_box(c, x, y, rows):
    """상단 설비 데이터 박스: rows = [(tag, name, [spec lines])]"""
    bw = 150
    for i, (tag, name, specs) in enumerate(rows):
        bx = x + i * (bw + 8)
        c.setLineWidth(0.6)
        c.rect(bx, y - 12 - 9 * len(specs), bw, 24 + 9 * len(specs))
        c.setFont("Helvetica-Bold", 7.5)
        c.drawString(bx + 5, y + 3, f"{tag}  {name}")
        c.setFont("Helvetica", 6.5)
        for j, s in enumerate(specs):
            c.drawString(bx + 5, y - 8 - 9 * j, s)


def sheet1(c):
    frame(c, "PID-100-001", "FEED PREHEAT AND SEPARATION")
    data_box(c, 40, H - 60, [
        ("TK-101", "FEED TANK", ["CAP: 50 m3", "SIZE: 3600 ID x 5000 H", "DP/DT: ATM / 60 C", "MOC: CS"]),
        ("P-101A/B", "FEED PUMP", ["CAP: 30 m3/h x 45 m", "MOTOR: 11 kW", "TYPE: CENTRIFUGAL", "MOC: CS/SS316"]),
        ("E-101", "FEED PREHEATER", ["DUTY: 450 kW", "TYPE: SHELL & TUBE (BEM)", "DP: 10 / 6 barg", "MOC: CS / SS304"]),
        ("V-101", "FLASH SEPARATOR", ["SIZE: 1500 ID x 4000 T/T", "DP/DT: 8 barg / 150 C", "MOC: CS"]),
        ("TK-102", "SLOP TANK", ["CAP: 10 m3", "DP/DT: ATM / 60 C", "MOC: CS"]),
    ])

    # equipment
    tank(c, 140, 420, 90, 120, "TK-101", "FEED TANK")
    pump(c, 300, 300, "P-101A", "FEED PUMP")
    pump(c, 300, 200, "P-101B", "FEED PUMP (STBY)")
    exchanger(c, 560, 380, "E-101", "FEED PREHEATER")
    vessel_v(c, 820, 420, 70, 170, "V-101", "FLASH SEPARATOR")
    tank(c, 1040, 220, 80, 90, "TK-102", "SLOP TANK")  # 의도적 미연결

    # process lines
    pipe(c, [(140, 360), (140, 300), (284, 300)], '6"-P-1001-A1A', 1)
    pipe(c, [(200, 300), (200, 200), (284, 200)], '6"-P-1003-A1A', 1)
    pipe(c, [(316, 300), (400, 300), (400, 380), (510, 380)], '4"-P-1002-A1A', 1)
    pipe(c, [(316, 200), (400, 200), (400, 300)])  # P-101B discharge tie-in
    control_valve(c, 455, 380, "FCV-101")
    pipe(c, [(610, 380), (700, 380), (700, 420), (785, 420)], '4"-P-1004', 0)  # Spec 누락
    pipe(c, [(820, 505), (820, 560), (1010, 560)], '4"-P-1005-A1A', 1)
    offpage(c, 1010, 560, "TO PID-100-002", "right")
    pipe(c, [(820, 335), (820, 280), (900, 280)], '2"-P-1006-A1A', 1)  # 끝단 미연결 (dangling)

    # utility
    text_c(c, 560, 470, "CWS", 7, True)
    pipe(c, [(560, 462), (560, 395)], '3"-CW-1101-B1A', 0, dash=(6, 3), lw=0.9)
    pipe(c, [(590, 365), (590, 300), (640, 300)], '3"-CW-1102-B1A', 0, dash=(6, 3), lw=0.9)
    text_c(c, 660, 297, "CWR", 7, True)

    # instruments
    instrument(c, 455, 450, "FIC-101", (455, 402))
    instrument(c, 360, 340, "FT-101", (360, 300))
    instrument(c, 890, 430, "LT-101", (855, 430))
    instrument(c, 680, 440, "TI-102", (680, 380))
    psv(c, 860, 520, "PSV-101")
    c.line(855, 505, 860, 520)


def sheet2(c):
    frame(c, "PID-100-002", "PRODUCT RECEIVING AND TRANSFER")
    data_box(c, 40, H - 60, [
        ("V-201", "PRODUCT RECEIVER", ["SIZE: 1200 ID x 3000 T/T", "DP/DT: 5 barg / 120 C", "MOC: SS304"]),
        ("P-201", "PRODUCT PUMP", ["CAP: 20 m3/h x 35 m", "MOTOR: 7.5 kW", "MOC: SS316"]),
        ("E-201", "PRODUCT COOLER", ["DUTY: 180 kW", "TYPE: PLATE", "MOC: SS316"]),
    ])
    offpage(c, 40, 500, "FROM PID-100-001", "left")
    pipe(c, [(122, 500), (300, 500), (300, 470)], '4"-P-1005-A1A', 0)
    vessel_v(c, 300, 400, 70, 140, "V-201", "PRODUCT RECEIVER")
    pipe(c, [(300, 330), (300, 260), (444, 260)], '3"-P-2001-A1A', 1)
    pump(c, 460, 260, "P-201", "PRODUCT PUMP")
    pipe(c, [(476, 260), (640, 260)], '3"-P-2002-A1A', 0)
    exchanger(c, 690, 260, "E-201", "PRODUCT COOLER")
    pipe(c, [(740, 260), (960, 260)], '3"-P-2003-A2A', 0)  # 범례에 없는 Class
    offpage(c, 960, 260, "TO PID-100-003", "right")  # 미입력 도면 참조

    instrument(c, 380, 420, "LT-201", (335, 420))
    instrument(c, 380, 360, "LT-201", (335, 360))  # 의도적 중복 태그
    instrument(c, 540, 310, "PI-201", (540, 260))
    instrument(c, 820, 310, "TI-201", (820, 260))


def legend(c):
    frame(c, "PID-100-000", "P&ID LEGEND AND SYMBOLS")

    def heading(x, y, s):
        c.setFont("Helvetica-Bold", 9)
        c.drawString(x, y, s)
        c.setLineWidth(0.6)
        c.line(x, y - 3, x + 250, y - 3)

    def table(x, y, rows, w=40):
        c.setFont("Helvetica", 7.5)
        for i, (k, v) in enumerate(rows):
            c.setFont("Helvetica-Bold", 7.5)
            c.drawString(x, y - 12 * i, k)
            c.setFont("Helvetica", 7.5)
            c.drawString(x + w, y - 12 * i, v)

    # 1. 라인 번호 체계
    heading(50, 770, "1. LINE NUMBERING SYSTEM")
    c.setFont("Helvetica-Bold", 11)
    c.drawString(80, 745, 'EXAMPLE:  6"-P-1001-A1A')
    table(80, 725, [("6\"", "NOMINAL PIPE SIZE (INCH)"), ("P", "FLUID CODE"), ("1001", "SEQUENCE NO. (1st DIGIT = AREA)"), ("A1A", "PIPING CLASS")], 50)

    # 2. 유체 코드
    heading(50, 650, "2. FLUID CODES")
    table(60, 632, [("P", "PROCESS"), ("CW", "COOLING WATER (SUPPLY/RETURN)"), ("LPS", "LOW PRESSURE STEAM"), ("N", "NITROGEN"), ("IA", "INSTRUMENT AIR"), ("D", "DRAIN")])

    # 3. 배관 Class
    heading(50, 540, "3. PIPING CLASSES")
    table(60, 522, [("A1A", "CS (A106 Gr.B), ASME 150#, CA 3.0 mm - PROCESS"), ("B1A", "CS GALVANIZED, ASME 150#, CA 1.5 mm - UTILITY WATER"), ("S1A", "SS316L, ASME 150#, CA 0 mm - CORROSIVE / PRODUCT")])

    # 4. 설비 Tag
    heading(400, 770, "4. EQUIPMENT IDENTIFICATION")
    table(410, 752, [("TK", "TANK"), ("V", "VESSEL / DRUM / SEPARATOR"), ("P", "PUMP (A/B = OPERATING/STANDBY)"), ("E", "HEAT EXCHANGER / COOLER"), ("C", "COLUMN"), ("K", "COMPRESSOR")])

    # 5. 계기 문자
    heading(400, 660, "5. INSTRUMENT IDENTIFICATION LETTERS (ISA 5.1)")
    c.setFont("Helvetica-Bold", 7.5)
    c.drawString(410, 642, "1ST LETTER (MEASURED VARIABLE)")
    c.drawString(580, 642, "SUCCEEDING LETTERS (FUNCTION)")
    table(410, 628, [("F", "FLOW"), ("L", "LEVEL"), ("P", "PRESSURE"), ("T", "TEMPERATURE")], 18)
    table(580, 628, [("I", "INDICATOR"), ("C", "CONTROLLER"), ("T", "TRANSMITTER"), ("V", "VALVE"), ("SV", "SAFETY VALVE")], 22)

    # 6. 기호
    heading(750, 770, "6. SYMBOLS")
    y = 740
    sym = [
        ("PROCESS LINE", lambda x, y: (c.setLineWidth(1.4), c.line(x, y, x + 50, y))),
        ("UTILITY LINE", lambda x, y: (c.setLineWidth(0.9), c.setDash(6, 3), c.line(x, y, x + 50, y), c.setDash())),
        ("INSTRUMENT SIGNAL", lambda x, y: (c.setLineWidth(0.8), c.setDash(2, 2), c.line(x, y, x + 50, y), c.setDash())),
        ("CONTROL VALVE", lambda x, y: control_valve(c, x + 25, y, "")),
        ("SAFETY / RELIEF VALVE", lambda x, y: psv(c, x + 20, y - 6, "")),
        ("FIELD INSTRUMENT", lambda x, y: (c.setLineWidth(0.8), c.circle(x + 25, y, 12))),
        ("PANEL INSTRUMENT (DCS)", lambda x, y: (c.setLineWidth(0.8), c.circle(x + 25, y, 12), c.line(x + 13, y, x + 37, y))),
        ("OFF-PAGE CONNECTOR", lambda x, y: offpage(c, x, y, "", "right")),
    ]
    for label, draw in sym:
        draw(760, y)
        c.setFont("Helvetica", 7.5)
        c.drawString(870, y - 3, label)
        y -= 40

    # 7. 일반 노트
    heading(50, 450, "7. GENERAL NOTES")
    c.setFont("Helvetica", 7.5)
    for i, s in enumerate([
        "1. ALL DIMENSIONS IN MM UNLESS OTHERWISE NOTED.",
        "2. LINES WITHOUT INSULATION CODE ARE NOT INSULATED.",
        "3. STANDBY PUMPS SHARE THE EQUIPMENT DATA OF THE OPERATING PUMP.",
    ]):
        c.drawString(60, 432 - 12 * i, s)


def main():
    for name, fn in (("PID-100-000.pdf", legend), ("PID-100-001.pdf", sheet1), ("PID-100-002.pdf", sheet2)):
        path = os.path.join(OUT_DIR, name)
        c = canvas.Canvas(path, pagesize=(W, H))
        c.setTitle(name)
        fn(c)
        c.showPage()
        c.save()
        print("wrote", path)


if __name__ == "__main__":
    main()
