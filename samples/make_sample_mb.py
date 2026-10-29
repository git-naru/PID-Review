"""샘플 P&ID(PID-100-001, 002)에 대응하는 물질수지(H&MB) 표를 만든다.

- PID-100-MB.xlsx : 엑셀 양식 (테스트용)
- PID-100-MB.csv  : 같은 내용의 CSV (샘플 데모에서 사용)

매칭 방식이 골고루 쓰이도록 만들었다.
  스트림 1, 2, 4, 5, 6, 7 : Line No. 행으로 매칭
  스트림 3              : Line No. 없이 From/To 설비 태그로 매칭
  스트림 8              : 도면에 없는 흐름 (Flash 증기 → Flare) → "도면에서 찾지 못한 스트림"
"""
import csv
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

HERE = Path(__file__).parent

STREAMS = ["1", "2", "3", "4", "5", "6", "7", "8"]
ROWS = [
    ("DESCRIPTION", "", ["Feed from tank", "Pump discharge", "Preheated feed", "Flash liquid", "Receiver outlet", "Product pump discharge", "Cooled product", "Flash vapor"]),
    ("FROM", "", ["TK-101", "P-101A", "E-101", "V-101", "V-201", "P-201", "E-201", "V-101"]),
    ("TO", "", ["P-101A", "E-101", "V-101", "V-201", "P-201", "E-201", "B.L.", "FLARE"]),
    ("LINE NO.", "", ["P-1001", "P-1002", "", "P-1005", "P-2001", "P-2002", "P-2003", "P-1007"]),
    ("PHASE", "", ["L", "L", "L", "L", "L", "L", "L", "V"]),
    ("TEMPERATURE", "°C", [40, 41, 120, 95, 90, 91, 45, 95]),
    ("PRESSURE", "kPa(g)", [20, 850, 780, 150, 120, 650, 600, 150]),
    ("MASS FLOW (NORMAL)", "kg/h", [25000, 25000, 25000, 23800, 23800, 23800, 23800, 1200]),
    ("MASS FLOW (DESIGN)", "kg/h", [27500, 27500, 27500, 26180, 26180, 26180, 26180, 1320]),
    ("VOLUMETRIC FLOW", "m3/h", [25.3, 25.3, 26.9, 25.1, 25.0, 25.0, 24.2, 410.0]),
    ("DENSITY", "kg/m3", [988, 988, 930, 948, 952, 952, 983, 2.9]),
]
COMPONENTS = [
    ("WATER", [20000, 20000, 20000, 18900, 18900, 18900, 18900, 1100]),
    ("PRODUCT X", [5000, 5000, 5000, 4900, 4900, 4900, 4900, 100]),
]


def table():
    rows = [["HEAT AND MATERIAL BALANCE - SAMPLE UNIT 100"], [], ["STREAM NO.", "UNIT", *STREAMS]]
    rows += [[name, unit, *vals] for name, unit, vals in ROWS]
    rows.append(["COMPONENT MASS FLOW", "kg/h"])
    rows += [[name, "", *vals] for name, vals in COMPONENTS]
    return rows


def main():
    rows = table()
    wb = Workbook()
    ws = wb.active
    ws.title = "H&MB"
    for r in rows:
        ws.append(r)
    ws["A1"].font = Font(bold=True, size=13)
    head = PatternFill("solid", fgColor="DDE6F0")
    for cell in ws[3]:
        cell.font = Font(bold=True)
        cell.fill = head
        cell.alignment = Alignment(horizontal="center")
    ws.column_dimensions["A"].width = 24
    for col in "CDEFGHIJ":
        ws.column_dimensions[col].width = 16
    wb.save(HERE / "PID-100-MB.xlsx")

    with open(HERE / "PID-100-MB.csv", "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(rows)
    print("PID-100-MB.xlsx, PID-100-MB.csv")


if __name__ == "__main__":
    main()
