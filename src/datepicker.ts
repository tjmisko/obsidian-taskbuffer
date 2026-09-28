// datepicker.ts — native date pickers for the defer-to-date action. Two routes:
//
//  • attachDateOverlay: a transparent <input type="date"> laid over a button.
//    On touch devices the tap lands on the input itself, which is the one way
//    guaranteed to raise the native picker (iOS calendar popover, Android dialog).
//  • openDatePicker: programmatic, via HTMLInputElement.showPicker(), for
//    desktop clicks, keyboard, and menu items. Where showPicker is missing or
//    refuses (no user activation), the caller's fallback runs instead.

import { epochToIsoDate, isoDateToEpoch } from "./dates";

/** Called once with the picked date's task epoch. */
export type OnDatePicked = (epoch: number) => void;

/**
 * Create a date input and route its first valid pick to `onPick`. An empty
 * value (the picker's Clear button) or an impossible date is ignored, and later
 * changes are dropped: on iOS the popover can report several taps before the
 * re-render removes it, and each must not defer the task again.
 */
function createDateInput(parent: HTMLElement, cls: string, initialEpoch: number, onPick: OnDatePicked): HTMLInputElement {
	const input = parent.createEl("input", { cls, attr: { type: "date", tabindex: "-1", "aria-hidden": "true" } });
	input.value = epochToIsoDate(initialEpoch);
	let picked = false;
	input.addEventListener("change", () => {
		if (picked) return;
		const epoch = isoDateToEpoch(input.value);
		if (epoch === null) return;
		picked = true;
		onPick(epoch);
	});
	return input;
}

/** Lay a transparent date input over `button` so a tap opens the native picker. */
export function attachDateOverlay(button: HTMLElement, initialEpoch: number, onPick: OnDatePicked): HTMLInputElement {
	button.addClass("has-date-overlay");
	const input = createDateInput(button, "taskbuffer-date-overlay", initialEpoch, onPick);
	// The input covers the whole button; keep its taps from also firing the
	// button's own click handler (and the row selection beneath it).
	input.addEventListener("click", (evt) => evt.stopPropagation());
	return input;
}

/**
 * Open the platform date picker anchored near (`x`, `y`) without a tap on an
 * input. Must be called from inside a user gesture (click, keydown, menu item).
 * Runs `fallback` when showPicker is unavailable or throws.
 */
export function openDatePicker(
	doc: Document,
	x: number,
	y: number,
	initialEpoch: number,
	onPick: OnDatePicked,
	fallback: () => void,
): void {
	// At most one floating input lives at a time: a picker dismissed without a
	// pick leaves its input behind, so sweep it up on the next open.
	for (const stale of Array.from(doc.body.querySelectorAll(".taskbuffer-date-floating"))) stale.remove();
	const input = createDateInput(doc.body, "taskbuffer-date-floating", initialEpoch, (epoch) => {
		// Let the picker finish closing before its anchor disappears.
		window.setTimeout(() => input.remove(), 500);
		onPick(epoch);
	});
	// Anchor at the gesture point: the picker popover positions itself against
	// the input, and a display:none input would refuse to open at all.
	input.style.left = `${Math.round(x)}px`;
	input.style.top = `${Math.round(y)}px`;

	if (typeof input.showPicker !== "function") {
		input.remove();
		fallback();
		return;
	}
	try {
		input.showPicker();
	} catch (err) {
		console.debug("taskbuffer: showPicker refused; using fallback", err);
		input.remove();
		fallback();
	}
}
