import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LongPressTracker } from "../src/gesture";

const DELAY = 450;
const SLOP = 10;

function tracker(onFire = vi.fn()): { lp: LongPressTracker; onFire: ReturnType<typeof vi.fn> } {
	const lp = new LongPressTracker({
		delayMs: DELAY,
		slopPx: SLOP,
		setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
		clearTimer: (id) => clearTimeout(id),
		onFire,
	});
	return { lp, onFire };
}

describe("LongPressTracker", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("should fire once with the touch-down point when held past the delay", () => {
		const { lp, onFire } = tracker();
		lp.start(100, 200);
		vi.advanceTimersByTime(DELAY);
		expect(onFire).toHaveBeenCalledTimes(1);
		expect(onFire).toHaveBeenCalledWith(100, 200);
		vi.advanceTimersByTime(DELAY * 4);
		expect(onFire).toHaveBeenCalledTimes(1);
	});

	it("should not fire when the finger lifts before the delay (a tap)", () => {
		const { lp, onFire } = tracker();
		lp.start(0, 0);
		vi.advanceTimersByTime(DELAY - 1);
		expect(lp.end()).toBe(false);
		vi.advanceTimersByTime(DELAY);
		expect(onFire).not.toHaveBeenCalled();
	});

	it("should report fired on end so the caller can swallow the synthesized click", () => {
		const { lp } = tracker();
		lp.start(0, 0);
		vi.advanceTimersByTime(DELAY);
		expect(lp.end()).toBe(true);
		expect(lp.end()).toBe(false); // reset after reporting
	});

	it("should still fire when the finger jitters within the slop", () => {
		const { lp, onFire } = tracker();
		lp.start(50, 50);
		lp.move(57, 57); // ~9.9px
		vi.advanceTimersByTime(DELAY);
		expect(onFire).toHaveBeenCalledTimes(1);
	});

	it("should cancel when the finger travels past the slop (a scroll)", () => {
		const { lp, onFire } = tracker();
		lp.start(50, 50);
		lp.move(50, 61);
		expect(lp.pending).toBe(false);
		vi.advanceTimersByTime(DELAY);
		expect(onFire).not.toHaveBeenCalled();
		expect(lp.end()).toBe(false);
	});

	it("should measure travel from the touch-down point, not the last move", () => {
		const { lp, onFire } = tracker();
		lp.start(0, 0);
		for (let y = 1; y <= 11; y++) lp.move(0, y); // each step 1px, total 11px
		vi.advanceTimersByTime(DELAY);
		expect(onFire).not.toHaveBeenCalled();
	});

	it("should cancel without firing when explicitly cancelled (touchcancel, second finger)", () => {
		const { lp, onFire } = tracker();
		lp.start(0, 0);
		lp.cancel();
		vi.advanceTimersByTime(DELAY);
		expect(onFire).not.toHaveBeenCalled();
	});

	it("should restart the hold when a new press starts mid-press", () => {
		const { lp, onFire } = tracker();
		lp.start(0, 0);
		vi.advanceTimersByTime(DELAY - 100);
		lp.start(30, 30);
		vi.advanceTimersByTime(DELAY - 1);
		expect(onFire).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onFire).toHaveBeenCalledWith(30, 30);
	});

	it("should clear a previous fired state when a new press starts", () => {
		const { lp } = tracker();
		lp.start(0, 0);
		vi.advanceTimersByTime(DELAY);
		lp.start(0, 0); // no end() in between (lost touchend)
		expect(lp.end()).toBe(false);
	});

	it("should ignore moves when no press is pending", () => {
		const { lp, onFire } = tracker();
		lp.move(500, 500);
		expect(lp.pending).toBe(false);
		expect(onFire).not.toHaveBeenCalled();
	});
});
