// inline.ts — a tiny inline-markdown tokenizer for task bodies. A task body
// keeps its source markdown (wikilinks, code spans, emphasis, plain links), so
// `[[The Commons]]` and `` `taskbuffer.nvim` `` would otherwise show with their
// raw brackets/backticks. This turns a body into a flat list of styled tokens;
// the view paints each to a themed DOM node (<a class="internal-link">, <code>,
// <strong>, …) so a task reads the way it does in the editor.
//
// Deliberately FLAT — no nested emphasis. Task bodies are short and rarely
// nest, and a single left-to-right scan can never mis-balance delimiters.
//
// Pure module — no Obsidian/DOM imports; unit-tested under Node.

export type InlineToken =
	| { kind: "text"; text: string }
	| { kind: "code"; text: string }
	| { kind: "bold"; text: string }
	| { kind: "italic"; text: string }
	| { kind: "strike"; text: string }
	| { kind: "wikilink"; text: string; target: string }
	| { kind: "link"; text: string; href: string };

interface Matcher {
	re: RegExp; // sticky (`y`): only matches when anchored at lastIndex
	make: (m: RegExpExecArray) => InlineToken;
}

function wikilink(inner: string): InlineToken {
	// inner is the text between the brackets: `target`, `target|alias`,
	// `target#heading`, or `target#heading|alias`. Display the alias when given,
	// else the link verbatim; keep the heading on the target so navigation lands
	// on the right spot.
	const pipe = inner.indexOf("|");
	const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
	const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : "";
	return { kind: "wikilink", text: alias || target, target };
}

// Priority order: a code span suppresses formatting inside it, so it goes first;
// bold (two delimiters) is tried before italic (one) so `**x**` isn't read as
// `*` + `*x*`. The underscore-italic case requires a word boundary on each side
// so `snake_case` stays literal.
const MATCHERS: Matcher[] = [
	{ re: /`([^`\n]+)`/y, make: (m) => ({ kind: "code", text: m[1] ?? "" }) },
	{ re: /\[\[([^\]\n]+?)\]\]/y, make: (m) => wikilink(m[1] ?? "") },
	{ re: /\[([^\]\n]+?)\]\(([^)\s\n]+?)\)/y, make: (m) => ({ kind: "link", text: m[1] ?? "", href: m[2] ?? "" }) },
	{ re: /\*\*([^*\n]+?)\*\*/y, make: (m) => ({ kind: "bold", text: m[1] ?? "" }) },
	{ re: /__([^_\n]+?)__/y, make: (m) => ({ kind: "bold", text: m[1] ?? "" }) },
	{ re: /~~([^~\n]+?)~~/y, make: (m) => ({ kind: "strike", text: m[1] ?? "" }) },
	{ re: /\*([^*\n]+?)\*/y, make: (m) => ({ kind: "italic", text: m[1] ?? "" }) },
	{ re: /(?<![\w])_([^_\n]+?)_(?![\w])/y, make: (m) => ({ kind: "italic", text: m[1] ?? "" }) },
];

/**
 * Split a task body into ordered inline tokens. Unrecognized characters
 * accumulate into `text` tokens. Always round-trips: concatenating the visible
 * text of every token (minus delimiters) reproduces the rendered line.
 */
export function tokenizeInline(text: string): InlineToken[] {
	const tokens: InlineToken[] = [];
	let i = 0;
	let textStart = 0;
	while (i < text.length) {
		let hit: { token: InlineToken; end: number } | null = null;
		for (const m of MATCHERS) {
			m.re.lastIndex = i;
			const r = m.re.exec(text);
			if (r) {
				hit = { token: m.make(r), end: m.re.lastIndex };
				break;
			}
		}
		if (hit) {
			if (textStart < i) tokens.push({ kind: "text", text: text.slice(textStart, i) });
			tokens.push(hit.token);
			i = hit.end;
			textStart = i;
		} else {
			i += 1;
		}
	}
	if (textStart < text.length) tokens.push({ kind: "text", text: text.slice(textStart) });
	return tokens;
}
