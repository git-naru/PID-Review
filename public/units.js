// 공정 Flow 드롭박스의 구분. 이 페이지는 BL3U 전용: Option 1(기존 BL3U 자료) / Option 2.
// value는 저장 위치(묶음 키 `${value}-PFD|PID`)에 쓰이므로 바꾸지 않는다. 기존 BL3U 자료가 Option 1이다.
export const UNITS = [
  { value: 'BL3U', label: 'Option 1' },
  { value: 'BL3U_OP2', label: 'Option 2' },
];
export const DEFAULT_UNIT = 'BL3U';
// 목록에 없는 값(예: 예전에 만든 BL2U 단일 HTML)은 값 그대로 보여 준다
export const unitLabel = (u) => UNITS.find((x) => x.value === u)?.label || u;
export const slotLabel = (key) => {
  const m = /^(.*)-(PFD|PID)$/.exec(key);
  return m ? `${unitLabel(m[1])} · ${m[2] === 'PID' ? 'P&ID' : 'PFD'}` : key;
};
