/**
 * Decides which of the offered meeting slots a prospect's reply picks, WITHOUT relying on a model.
 *
 * detect(text, slots, timezone) -> { selected: number|null (1-based), decided: boolean, method: 'rule', reason: string }
 *   decided=true  : the rules are sure (a pick, or a clear "no": none of these / another time / a counter-proposal)
 *   decided=false : the reply is ambiguous ("sounds good", "either works", "Thursday" with two Thursday slots); the caller
 *                   may ask a model, otherwise treats it as "no".
 *
 * Deliberately conservative: it only returns a pick when exactly ONE offered slot fits what the prospect wrote. A wrong
 * booking is worse than asking again.
 */

const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const WEEKDAY_RE = "(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)";
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const ORDINALS = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5 };
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5 };

const HARD_NEGATIVE = [
  /\bnone of (?:these|those|them|the above|the times|the options)\b/,
  /\bneither\b/,
  /\b(?:doesn'?t|don'?t|does not|do not|won'?t|will not|wouldn'?t|isn'?t|aren'?t|not) (?:really )?(?:work|suit|fit|possible|good|ideal|available|convenient)\b/,
  /\bnot (?:able|available|free)\b/,
  /\b(?:can'?t|cannot|can not|unable to) (?:make|do|attend|meet|manage|join)\b/,
  /\banother (?:time|day|date|slot)\b/,
  /\bother (?:times|days|dates|slots|options)\b/,
  /\bdifferent (?:time|day|date|slot|times|days)\b/,
  /\b(?:re-?schedule|postpone|push (?:it|this) back)\b/,
  /\bno longer\b/,
  /\bnot (?:interested|now|a good time)\b/,
  /\b(?:later|earlier) (?:time|date|in the week|than)\b/,
];
// A counter-proposal / question: only a pick if it clearly points at an offered slot.
const COUNTER = [/\b(?:can|could|would) we (?:do|try|make it|have|move|say)\b/, /\bhow about\b/, /\bwhat about\b/, /\bis there\b/, /\bdo you have\b/, /\bany chance\b/, /\bany(?:thing)? (?:earlier|later)\b/, /\bwould (?:prefer|rather)\b|\bi'?d (?:prefer|rather)\b|\bprefer\b/];
const COUNTER_STRONG = /\b(?:instead|rather than|rather|alternatively)\b/;

const AFFIRMATIVE = /\b(?:yes|yeah|yep|yup|sure|ok(?:ay)?|sounds? (?:good|great|perfect|fine)|works? (?:for me|great|well|fine)|that works|perfect|great|let'?s (?:do|go with) (?:it|that)|i'?ll take (?:it|that)|book (?:it|me|that))\b/;

function normalise(text) {
  return String(text || "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ /g, " ")
    .split("\n")
    .filter((line) => !line.trim().startsWith(">"))
    .join("\n")
    .replace(/(?:^|\n|\s)on [^\n]{1,260} wrote:[\s\S]*$/i, " ")
    .replace(/\n\s*[-_]{2,}\s*original message\s*[-_]{2,}[\s\S]*$/i, " ")
    .replace(/\n\s*from:\s.+\n\s*sent:[\s\S]*$/i, " ")
    .toLowerCase()
    .replace(/[ \t]+/g, " ")
    .trim();
}

function localParts(startTime, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone || "UTC", hourCycle: "h23", weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
      .formatToParts(new Date(startTime))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value])
  );
  return {
    weekday: WEEKDAYS[String(parts.weekday).slice(0, 3).toLowerCase()],
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

function uniqueSorted(list) {
  return [...new Set(list)].sort((a, b) => a - b);
}

/** Slot numbers named by "option 2", "#2", "the second one", "the last one", "2" alone, "option two". */
function indexMentions(text, count, days = []) {
  const found = [];
  let m;

  const optionNum = /(?:\boption|\bchoice|\bslot|\bnumber|\bno\.?|#)\s*(\d)\b(?!\s*(?:[:.]\d|am\b|pm\b|a\.m|p\.m))((?:\s*(?:,|or|and|\/|&)\s*(?:option\s*|#)?\d\b)*)/g;
  while ((m = optionNum.exec(text))) {
    found.push(Number(m[1]));
    for (const extra of String(m[2] || "").match(/\d/g) || []) found.push(Number(extra));
  }

  const optionWord = /\b(?:option|choice|slot|number)\s+(one|two|three|four|five)\b/g;
  while ((m = optionWord.exec(text))) found.push(NUMBER_WORDS[m[1]]);

  const ordinal = /\b(the\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\b(?:\s+(one|option|slot|time|choice|suggestion|proposal|offer))?/g;
  while ((m = ordinal.exec(text))) {
    const hasThe = Boolean(m[1]);
    const noun = m[3];
    const rest = text.slice(m.index + m[0].length);
    const next = (rest.match(/^\s*([a-z']+)/) || [])[1] || "";
    const atEnd = /^\s*(?:[.,!?;:)]|$)/.test(rest);
    const okNext = /^(?:please|works|work|is|for|would|sounds|will|looks|and|if|then|too|it|that|seems|suits)$/.test(next);
    const digitOrdinal = /^\d/.test(m[2]);
    if (digitOrdinal && days.includes(ORDINALS[m[2]])) continue; // "the 2nd" is the date of an offered slot, not option 2
    if (!(noun || ((hasThe || digitOrdinal) && (atEnd || okNext)))) continue;
    if (m[2] === "last") found.push(count);
    else found.push(ORDINALS[m[2]]);
  }

  // The whole reply is just a number: "2", "2.", "2 please", "go with 2".
  const bare = text.replace(/^(?:hi|hello|hey|thanks|thank you|dear)[^,\n]*,?\s*/, "").replace(/[\s.!)]+$/g, "");
  const alone = bare.match(/^(?:(?:i'?ll|i will|let'?s) (?:go with|take|do)|go with|take|pick|choose)?\s*([1-5])(?:\s*(?:please|thanks|thank you|works|is fine|for me|would be great|is great))*$/);
  if (alone) found.push(Number(alone[1]));

  return uniqueSorted(found.filter((n) => Number.isInteger(n) && n >= 1 && n <= count));
}

/** { times: [{hours:[..], minute}], weekdays: Set, dates: [{month?, day}] } mentioned in the reply. */
function extractConstraints(rawText, negatedWeekdays) {
  let text = rawText;
  const dates = [];
  const times = [];
  let m;

  // Dates first, removing them so their digits are not read as times.
  const monthDay = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?::|am\\b|pm\\b))`, "g");
  text = text.replace(monthDay, (_, mon, day) => { dates.push({ month: MONTHS[mon.slice(0, 4) === "sept" ? "sept" : mon.slice(0, 3)], day: Number(day) }); return " "; });
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`, "g");
  text = text.replace(dayMonth, (_, day, mon) => { dates.push({ month: MONTHS[mon.slice(0, 4) === "sept" ? "sept" : mon.slice(0, 3)], day: Number(day) }); return " "; });
  text = text.replace(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g, (_, a, b) => { dates.push({ pair: [Number(a), Number(b)] }); return " "; });
  text = text.replace(/\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/g, (_, day) => { dates.push({ day: Number(day) }); return " "; });

  const withMeridiem = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/g;
  text = text.replace(withMeridiem, (_, h, min, mer) => {
    const hour = Number(h);
    if (hour < 1 || hour > 12) return " ";
    const pm = mer.startsWith("p");
    times.push({ hours: [(hour % 12) + (pm ? 12 : 0)], minute: Number(min || 0) });
    return " ";
  });
  text = text.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_, h, min) => {
    const hour = Number(h);
    times.push({ hours: hour >= 13 || hour === 0 ? [hour] : hour === 12 ? [12, 0] : [hour, hour + 12], minute: Number(min) });
    return " ";
  });
  text = text.replace(/\bnoon\b/g, () => { times.push({ hours: [12], minute: 0 }); return " "; });
  // "at 2" with no am/pm: only trusted next to "at"
  text = text.replace(/\bat\s+(\d{1,2})\b(?!\s*(?:[:.]\d|st|nd|rd|th|%|\/))/g, (_, h) => {
    const hour = Number(h);
    if (hour < 1 || hour > 23) return " ";
    times.push({ hours: hour >= 13 ? [hour] : hour === 12 ? [12] : [hour, hour + 12], minute: 0 });
    return " ";
  });

  const weekdays = new Set();
  const weekdayRe = new RegExp(`\\b${WEEKDAY_RE}\\b`, "g");
  while ((m = weekdayRe.exec(text))) {
    const day = WEEKDAYS[m[1].slice(0, 3)];
    if (!negatedWeekdays.has(day)) weekdays.add(day);
  }
  return { times, weekdays, dates };
}

function negatedWeekdaySet(text) {
  const set = new Set();
  const re = new RegExp(`\\b(?:not|no|except|excluding|isn'?t|can'?t do|cannot do|won'?t work on|doesn'?t work on|can'?t make|cannot make)\\s+(?:on\\s+)?${WEEKDAY_RE}\\b`, "g");
  let m;
  while ((m = re.exec(text))) set.add(WEEKDAYS[m[1].slice(0, 3)]);
  return set;
}

function slotMatches(local, { times, weekdays, dates }) {
  if (times.length && !times.some((t) => t.hours.includes(local.hour) && t.minute === local.minute)) return false;
  if (weekdays.size && !weekdays.has(local.weekday)) return false;
  if (dates.length) {
    const ok = dates.some((d) => {
      if (d.pair) return (d.pair[0] === local.month && d.pair[1] === local.day) || (d.pair[1] === local.month && d.pair[0] === local.day);
      return d.day === local.day && (d.month === undefined || d.month === local.month);
    });
    if (!ok) return false;
  }
  return true;
}

function detect(rawText, slots, timezone) {
  const text = normalise(rawText);
  const list = Array.isArray(slots) ? slots : [];
  const count = list.length;
  if (!text) return { selected: null, decided: true, method: "rule", reason: "The reply is empty." };
  if (count === 0) return { selected: null, decided: true, method: "rule", reason: "No times were offered." };

  const hard = HARD_NEGATIVE.find((re) => re.test(text));
  if (hard) return { selected: null, decided: true, method: "rule", reason: "The prospect declined the offered times or asked for others." };

  const counter = COUNTER.some((re) => re.test(text));
  const strongCounter = COUNTER_STRONG.test(text);

  const locals = list.map((slot) => localParts(slot.startTime, timezone));
  const indexes = indexMentions(text.replace(new RegExp(`\\b${MONTH_RE}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "g"), " "), count, locals.map((l) => l.day));
  const constraints = extractConstraints(text, negatedWeekdaySet(text));
  const hasWhen = constraints.times.length > 0 || constraints.weekdays.size > 0 || constraints.dates.length > 0;
  const whenMatches = hasWhen ? locals.map((l, i) => (slotMatches(l, constraints) ? i + 1 : null)).filter(Boolean) : null;

  if (indexes.length > 1) return { selected: null, decided: false, method: "rule", reason: "The reply mentions more than one option." };

  if (indexes.length === 1) {
    // "the second one, Thursday 2pm" must agree; a conflict is ambiguous rather than a guess.
    if (whenMatches && whenMatches.length === 1 && whenMatches[0] !== indexes[0]) return { selected: null, decided: false, method: "rule", reason: "The option number and the time in the reply point at different slots." };
    if (strongCounter) return { selected: null, decided: true, method: "rule", reason: "The reply proposes something instead of the offered times." };
    return { selected: indexes[0], decided: true, method: "rule", reason: `The prospect chose option ${indexes[0]}.` };
  }

  if (whenMatches) {
    if (whenMatches.length === 1) {
      if (strongCounter) return { selected: null, decided: true, method: "rule", reason: "The reply proposes a time instead of the offered ones." };
      return { selected: whenMatches[0], decided: true, method: "rule", reason: `The day/time in the reply matches only option ${whenMatches[0]}.` };
    }
    if (whenMatches.length === 0) return { selected: null, decided: true, method: "rule", reason: "The day/time in the reply matches none of the offered times (counter-proposal)." };
    return { selected: null, decided: false, method: "rule", reason: "The day/time in the reply matches more than one offered time." };
  }

  if (counter) return { selected: null, decided: true, method: "rule", reason: "The reply asks about or proposes something other than the offered times." };

  if (AFFIRMATIVE.test(text) && count === 1) {
    return { selected: 1, decided: true, method: "rule", reason: "The prospect agreed and only one time was offered." };
  }
  return { selected: null, decided: false, method: "rule", reason: "The reply does not clearly name one of the offered times." };
}

/** Prompt pieces for the model fallback (strict JSON). */
function buildModelPrompt(labels, replyText) {
  return {
    system: [
      "You decide which of several offered meeting times a prospect chose in their latest email reply.",
      'Respond with ONLY a JSON object: {"selected": <number or null>, "confidence": <0..1>}.',
      '"selected" is the number of the offered time the prospect clearly chose, or null if they chose none, are ambiguous, asked for other times, or proposed their own time.',
      "Never guess: when unsure use null. Do not add commentary or code fences.",
    ].join("\n"),
    user: JSON.stringify({ offeredTimes: labels.map((label, i) => ({ number: i + 1, time: label })), prospectReply: String(replyText || "").slice(0, 2000) }),
  };
}

function parseModelAnswer(content, count) {
  try {
    const raw = String(content || "").trim();
    const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const parsed = JSON.parse(fenced ? fenced[1] : raw);
    const selected = Number.isInteger(parsed?.selected) && parsed.selected >= 1 && parsed.selected <= count ? parsed.selected : null;
    const confidence = Number(parsed?.confidence);
    return { selected, confidence: Number.isFinite(confidence) ? confidence : 0 };
  } catch {
    return { selected: null, confidence: 0 };
  }
}

module.exports = { detect, buildModelPrompt, parseModelAnswer, MODEL_MIN_CONFIDENCE: 0.7 };
