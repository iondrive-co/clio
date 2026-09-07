
const INVISIBLE = [
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,
  /\x1bP[^\x1b]*\x1b\\/g,
  /\x1b\[\?[0-9;]*[hl]/g,
  /\x1b\[\?[0-9;]*\$[a-z]/g,
  /\x1b\[[>=][0-9;]*[a-zA-Z]/g,
  /\x1b\[[0-9;]*[cnq]/g,
  /\x1b\[[0-9;]*m/g,
  /\x1b\[[0-9;]*[ABCDEFGHIZdefgr]/g,
  /\x1b\[[su]/g,
  /\x1b[()*+][A-Za-z0-9]/g,
  /\x1b[78=><Fclmno|}~]/g,
  /[\x0e\x0f]/g,
];

export function drawsSomething(text) {
  if (!text) return false;
  let rest = String(text);
  for (const pattern of INVISIBLE) rest = rest.replace(pattern, '');
  return rest.length > 0;
}
