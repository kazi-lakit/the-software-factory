export type QuestionOption = { letter: string; label: string; why: string; recommended: boolean };
export type ParsedQuestion = { prompt: string; options: QuestionOption[] };

const OPTION = /^([A-D])\.\s+(.+?)(?::\s+(.+))?$/;
const LOOKS_LIKE_OPTION = /^[A-D]\./;
const REPLY_LINE = /^reply with an option letter/i;
const RECOMMENDED = /\s*\(recommended\)\s*$/i;

/**
 * Reads the reply-format layout from a question's plain text: a prompt, then 2 to 4 lettered option lines
 * (`A. label: why`, the recommended one ending `(recommended)`), then an optional "Reply with an option letter" line.
 * Anything else is an older plain-text question: no options, the whole text as the prompt.
 */
export function parseQuestion(text: string): ParsedQuestion {
  const plain: ParsedQuestion = { prompt: text, options: [] };
  const lines = text.split("\n").map((line) => line.trim());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length > 0 && REPLY_LINE.test(lines[lines.length - 1]!)) {
    lines.pop();
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  }
  const first = lines.findIndex((line) => LOOKS_LIKE_OPTION.test(line));
  if (first < 0) return plain;
  const options: QuestionOption[] = [];
  for (let i = first; i < lines.length; i++) {
    const raw = lines[i]!;
    const recommended = RECOMMENDED.test(raw);
    const match = OPTION.exec(raw.replace(RECOMMENDED, ""));
    const letter = String.fromCharCode(65 + options.length);
    if (!match || match[1] !== letter) return plain;
    options.push({ letter, label: match[2]!, why: match[3] ?? "", recommended });
  }
  if (options.length < 2 || options.length > 4) return plain;
  return { prompt: lines.slice(0, first).join("\n").trim(), options };
}

/** The recommended option's letter, only when exactly one option is recommended. */
export function recommendedLetter(options: readonly QuestionOption[]): string | undefined {
  const marked = options.filter((option) => option.recommended);
  return marked.length === 1 ? marked[0]!.letter : undefined;
}

/** The text sent for an option: its lettered line without the `(recommended)` suffix. */
export function optionText(option: QuestionOption): string {
  return `${option.letter}. ${option.label}${option.why ? `: ${option.why}` : ""}`;
}
