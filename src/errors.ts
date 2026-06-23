// Human-readable summary of strict-mode date errors, for a Notice.
import { DateError } from "./types";

export function summarizeDateErrors(errors: DateError[]): string {
	const head = `Task Buffer: ${errors.length} date error${errors.length === 1 ? "" : "s"} (strict mode)`;
	const shown = errors.slice(0, 5).map((e) => {
		const loc = e.lineNumber ? `${e.filePath}:${e.lineNumber}` : e.filePath;
		return `${loc} — invalid ${e.context} "${e.dateStr}": ${e.reason}`;
	});
	const more = errors.length > 5 ? `\n…and ${errors.length - 5} more` : "";
	return [head, ...shown].join("\n") + more;
}
