// perf.ts — lightweight timing instrumentation. Logs phase durations to the
// console so we can see where wall-clock time goes between a user gesture (e.g.
// revealing the sidebar) and the view actually painting. Gated behind a runtime
// flag so production users pay nothing; flip it from settings or the console.
//
// Usage:
//   const end = perfStart("render");   // marks t0
//   ...work...
//   end({ rows: 42 });                 // logs "[taskbuffer] render: 12.3ms {rows:42}"
//
// or wrap an async phase:
//   await perfTime("scan", () => engine.refresh());

let enabled = false;

/** Toggle perf logging (wired to the `debugTiming` setting at load). */
export function setPerfEnabled(value: boolean): void {
	enabled = value;
}

export function perfEnabled(): boolean {
	return enabled;
}

function now(): number {
	return performance.now();
}

function emit(label: string, ms: number, detail?: Record<string, unknown>): void {
	const rounded = Math.round(ms * 10) / 10;
	if (detail && Object.keys(detail).length > 0) {
		// eslint-disable-next-line no-console
		console.log(`[taskbuffer] ${label}: ${rounded}ms`, detail);
	} else {
		// eslint-disable-next-line no-console
		console.log(`[taskbuffer] ${label}: ${rounded}ms`);
	}
}

/** Begin timing `label`; returns a function that logs the elapsed time when called. */
export function perfStart(label: string): (detail?: Record<string, unknown>) => number {
	const t0 = now();
	return (detail?: Record<string, unknown>) => {
		const ms = now() - t0;
		if (enabled) emit(label, ms, detail);
		return ms;
	};
}

/** Time an async phase, logging its duration. Returns the phase's result. */
export async function perfTime<T>(label: string, fn: () => Promise<T>, detail?: Record<string, unknown>): Promise<T> {
	const end = perfStart(label);
	try {
		return await fn();
	} finally {
		end(detail);
	}
}
