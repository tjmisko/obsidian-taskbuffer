// gesture.ts — long-press recognition for touch rows. A pure state machine with
// an injected timer, so the thresholds and cancel rules are unit-tested under
// Node; view.ts feeds it touch events and performs the haptic + menu on fire.

export interface LongPressOptions {
	/** Hold time before the press fires. */
	delayMs: number;
	/** Finger travel (px) that turns the press into a scroll and cancels it. */
	slopPx: number;
	setTimer(fn: () => void, ms: number): number;
	clearTimer(id: number): void;
	/** Called once when the hold completes, with the touch-down point. */
	onFire(x: number, y: number): void;
}

/** 450ms sits between a tap and iOS's own ~500ms long-press. */
export const LONG_PRESS_DELAY_MS = 450;
export const LONG_PRESS_SLOP_PX = 10;

export class LongPressTracker {
	private timer: number | null = null;
	private originX = 0;
	private originY = 0;
	private fired = false;

	constructor(private readonly opts: LongPressOptions) {}

	/** A finger went down. Restarts any press already in progress. */
	start(x: number, y: number): void {
		this.cancel();
		this.fired = false;
		this.originX = x;
		this.originY = y;
		this.timer = this.opts.setTimer(() => {
			this.timer = null;
			this.fired = true;
			this.opts.onFire(this.originX, this.originY);
		}, this.opts.delayMs);
	}

	/** The finger moved. Travel past the slop means the user is scrolling. */
	move(x: number, y: number): void {
		if (this.timer === null) return;
		const dx = x - this.originX;
		const dy = y - this.originY;
		if (dx * dx + dy * dy > this.opts.slopPx * this.opts.slopPx) this.cancel();
	}

	/**
	 * The finger lifted. Returns true when this press fired, so the caller can
	 * swallow the click the lift would otherwise synthesize (it would close the
	 * menu the press just opened). Resets for the next press.
	 */
	end(): boolean {
		this.cancel();
		const fired = this.fired;
		this.fired = false;
		return fired;
	}

	/** Abandon the press (scroll, second finger, touchcancel) without firing. */
	cancel(): void {
		if (this.timer === null) return;
		this.opts.clearTimer(this.timer);
		this.timer = null;
	}

	/** True while a press is being held and has not yet fired or been cancelled. */
	get pending(): boolean {
		return this.timer !== null;
	}
}
