// Tense of a tool call's one-line description (F-22).
//
// Contract: `inflectDescription` takes a description written in the
// imperative ("Find the config") and returns it in the asked tense
// ("Finding the config" / "Found the config"). Only verbs this module knows
// are changed; a description that does not open with one is returned as it
// was, so text in another language, or one that opens with a noun, is never
// altered.

export type DescriptionTense = "progressive" | "past";

// base → [past, progressive], for verbs the suffix rules get wrong.
const IRREGULAR: Record<string, readonly [string, string]> = {
  begin: ["began", "beginning"],
  bind: ["bound", "binding"],
  break: ["broke", "breaking"],
  bring: ["brought", "bringing"],
  build: ["built", "building"],
  catch: ["caught", "catching"],
  choose: ["chose", "choosing"],
  cut: ["cut", "cutting"],
  do: ["did", "doing"],
  draw: ["drew", "drawing"],
  feed: ["fed", "feeding"],
  find: ["found", "finding"],
  freeze: ["froze", "freezing"],
  get: ["got", "getting"],
  give: ["gave", "giving"],
  go: ["went", "going"],
  hide: ["hid", "hiding"],
  hold: ["held", "holding"],
  keep: ["kept", "keeping"],
  leave: ["left", "leaving"],
  let: ["let", "letting"],
  make: ["made", "making"],
  override: ["overrode", "overriding"],
  overwrite: ["overwrote", "overwriting"],
  put: ["put", "putting"],
  read: ["read", "reading"],
  rebuild: ["rebuilt", "rebuilding"],
  redo: ["redid", "redoing"],
  redraw: ["redrew", "redrawing"],
  reread: ["reread", "rereading"],
  rerun: ["reran", "rerunning"],
  reset: ["reset", "resetting"],
  rewrite: ["rewrote", "rewriting"],
  run: ["ran", "running"],
  see: ["saw", "seeing"],
  send: ["sent", "sending"],
  set: ["set", "setting"],
  shut: ["shut", "shutting"],
  split: ["split", "splitting"],
  take: ["took", "taking"],
  tell: ["told", "telling"],
  undo: ["undid", "undoing"],
  write: ["wrote", "writing"],
};

const words = (list: string): ReadonlySet<string> => new Set(list.split(" "));

// Regular verbs whose last consonant doubles before a suffix.
const DOUBLING = words(
  "commit crop debug defer drop emit flip format grep log map omit pin plan " +
    "plug pop prep scan scrub ship skip snap stop strip stub submit swap tag " +
    "transfer trim unpin unplug unzip wrap zip",
);

// Regular verbs that take the plain suffix rules.
const REGULAR = words(
  "add adjust align analyze append apply archive ask assert assign attach " +
    "audit bisect bump call capture change check clean clear clone close " +
    "collect compare compile compute configure confirm connect convert copy " +
    "count create delete deploy describe detect determine diff disable " +
    "discard display download dump edit enable ensure examine execute " +
    "expand export extract fetch fill filter finish fix fold force gather " +
    "generate import index insert inspect install join kill launch link " +
    "lint list load locate look mark measure merge migrate modify monitor " +
    "move normalize open parse patch pick ping poll prepare preview print " +
    "probe prune publish pull push query queue rebase record recover " +
    "refactor refresh regenerate register release reload remove rename " +
    "render reopen repair replace replay report reproduce resolve restart " +
    "restore retry revert review rotate sample save search select serve " +
    "show simulate sort squash stage start stash store summarise summarize " +
    "switch sync test touch trace track try tune typecheck uninstall unpack " +
    "update upgrade upload use validate verify view wait walk watch wire",
);

function isKnownVerb(word: string): boolean {
  return (
    Object.hasOwn(IRREGULAR, word) || DOUBLING.has(word) || REGULAR.has(word)
  );
}

const VOWELS = "aeiou";

function inflectVerb(base: string, tense: DescriptionTense): string {
  const irregular = Object.hasOwn(IRREGULAR, base) ? IRREGULAR[base] : undefined;
  if (irregular) return tense === "past" ? irregular[0] : irregular[1];
  const last = base[base.length - 1]!;
  const beforeLast = base[base.length - 2] ?? "";
  if (DOUBLING.has(base)) {
    return base + last + (tense === "past" ? "ed" : "ing");
  }
  if (tense === "past") {
    if (last === "e") return `${base}d`;
    if (last === "y" && !VOWELS.includes(beforeLast)) {
      return `${base.slice(0, -1)}ied`;
    }
    return `${base}ed`;
  }
  if (base.endsWith("ie")) return `${base.slice(0, -2)}ying`;
  if (last === "e" && beforeLast !== "e") return `${base.slice(0, -1)}ing`;
  return `${base}ing`;
}

function inflectWord(word: string, tense: DescriptionTense): string | null {
  const base = word.toLowerCase();
  if (!isKnownVerb(base)) return null;
  const inflected = inflectVerb(base, tense);
  const capitalised = word[0] !== word[0]!.toLowerCase();
  return capitalised
    ? inflected[0]!.toUpperCase() + inflected.slice(1)
    : inflected;
}

// Known verbs that also commonly name a thing ("test files", "the log").
// After "and" or a comma one of these may be a noun, so the text is left as
// written.
const NOUN_LIKE = words(
  "build change check diff export import index link list log mark merge " +
    "patch query queue record release report review sample search sort " +
    "stash test trace track update upgrade view watch",
);

// A word that may open a later clause: after ";", ",", "then" or "and".
const CLAUSE_WORD = /(;|,|\bthen|\band)(\s+)(?!(?:then|and)\b)([A-Za-z]+)\b/g;

/**
 * The description in `tense`, or the text unchanged when the opening word is
 * not a known verb or a later clause cannot be read with certainty. Never a
 * half-converted sentence.
 */
export function inflectDescription(
  text: string,
  tense: DescriptionTense,
): string {
  const opening = /^(\s*)([A-Za-z]+)\b/.exec(text);
  if (!opening) return text;
  const lead = inflectWord(opening[2]!, tense);
  if (lead === null) return text;
  let unsure = false;
  const rest = text
    .slice(opening[0].length)
    .replace(CLAUSE_WORD, (match, joiner: string, space: string, word: string) => {
      const base = word.toLowerCase();
      if (!isKnownVerb(base)) return match;
      const listJoiner = joiner === "," || joiner.toLowerCase() === "and";
      if (listJoiner && NOUN_LIKE.has(base)) {
        unsure = true;
        return match;
      }
      return joiner + space + (inflectWord(word, tense) ?? word);
    });
  return unsure ? text : opening[1]! + lead + rest;
}

/**
 * The tense a call's description is shown in for its status: progressive
 * while it runs, past once it completed cleanly, and none (the description
 * as written) when it failed, was cancelled, or has not started.
 */
export function tenseForCallStatus(
  statusType: string | undefined,
  isError: boolean | undefined,
): DescriptionTense | undefined {
  if (statusType === "running") return "progressive";
  if (statusType === "complete" && isError !== true) return "past";
  return undefined;
}

/** `inflectDescription` when a tense is given; the text unchanged otherwise. */
export function describeInTense(
  text: string,
  tense: DescriptionTense | undefined,
): string {
  return tense === undefined ? text : inflectDescription(text, tense);
}
