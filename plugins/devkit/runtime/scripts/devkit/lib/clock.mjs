// 時刻と時間帯（依存パッケージなし。Intl でタイムゾーンの時差を求める）。
// 試験だけ: DEVKIT_TEST_CLOCK=1 と DEVKIT_NOW（ISO 8601）がそろったときだけ、その時刻を「今」とする
// （本番で時計をずらして、待ち・時間帯・日ごとの上限・ブリーフィングの締切を飛ばせないように。Claude のコマンドではガードが止める）
export function now() {
  const t = process.env.DEVKIT_TEST_CLOCK === "1" && process.env.DEVKIT_NOW ? Date.parse(process.env.DEVKIT_NOW) : Number.NaN;
  return Number.isFinite(t) ? new Date(t) : new Date();
}

export function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// その瞬間の、タイムゾーンでの年月日時分
export function zonedParts(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(date)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
  return { y: parts.year, mo: parts.month, d: parts.day, h: parts.hour % 24, mi: parts.minute, s: parts.second };
}

// タイムゾーンでの年月日時分を、その瞬間（Date）にする（夏時間の切り替えも2回の補正で合わせる）
export function zonedToDate(y, mo, d, h, mi, tz) {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(t), tz);
    const seen = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    const diff = want - seen;
    if (diff === 0) break;
    t += diff;
  }
  return new Date(t);
}

export function parseHHMM(text) {
  const m = String(text ?? "").match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return m ? { h: Number(m[1]), mi: Number(m[2]) } : null;
}

// 毎日 HH:MM（タイムゾーン）の締切のうち、at 以前で最も新しいもの
export function deadlineAtOrBefore(at, hhmm, tz) {
  const t = parseHHMM(hhmm);
  const p = zonedParts(at, tz);
  let dl = zonedToDate(p.y, p.mo, p.d, t.h, t.mi, tz);
  if (dl.getTime() > at.getTime()) {
    const prev = new Date(Date.UTC(p.y, p.mo - 1, p.d - 1));
    dl = zonedToDate(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), t.h, t.mi, tz);
  }
  return dl;
}

// 締切の1つ前の締切（前回の締切）
export function previousDeadline(deadline, hhmm, tz) {
  return deadlineAtOrBefore(new Date(deadline.getTime() - 1), hhmm, tz);
}

// 締切の次の締切
export function nextDeadline(deadline, hhmm, tz) {
  let probe = new Date(deadline.getTime() + 20 * 3600_000);
  let dl = deadlineAtOrBefore(probe, hhmm, tz);
  while (dl.getTime() <= deadline.getTime()) {
    probe = new Date(probe.getTime() + 3600_000);
    dl = deadlineAtOrBefore(probe, hhmm, tz);
  }
  return dl;
}

// 表示用（例: 11/9 08:00）。タイムゾーンの名前は呼び出し側で添える
export function formatZoned(date, tz, { withDate = true } = {}) {
  const p = zonedParts(date, tz);
  const hm = `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
  return withDate ? `${p.mo}/${p.d} ${hm}` : hm;
}

// 日付のキー（例: 2026-11-09）。日ごとの上限に使う
export function dayKey(date, tz) {
  const p = zonedParts(date, tz);
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

// 時間帯（"22:00-07:00" のように日をまたいでもよい）の中か。null なら常に中
export function insideHours(at, hours, tz) {
  if (!hours) return true;
  const m = String(hours).match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!m) return true;
  const a = parseHHMM(m[1]);
  const b = parseHHMM(m[2]);
  const p = zonedParts(at, tz);
  const x = p.h * 60 + p.mi;
  const s = a.h * 60 + a.mi;
  const e = b.h * 60 + b.mi;
  return s <= e ? x >= s && x < e : x >= s || x < e;
}
