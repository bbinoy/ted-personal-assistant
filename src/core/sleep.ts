// "The Mac slept": one shared signal. The heartbeat tick notices a sleep (heartbeat/heartbeat.ts sleptFor) and calls `noteSleep()`; anything in flight whose connections died with
// the sleep (a voice synthesis and its upload, deadline.ts) holds the signal it took when it started and gives up when it aborts. A signal is good for ONE sleep: after it fires,
// `sleepSignal()` returns a fresh one, so work that starts after the wake-up is not affected.

let epoch = new AbortController();

/** The signal of the current stretch of uptime; it aborts (reason: an Error) when the Mac next sleeps. */
export const sleepSignal = (): AbortSignal => epoch.signal;

/** The Mac slept (or the clock jumped): aborts everything that holds the current signal. */
export function noteSleep(): void {
  const old = epoch;
  epoch = new AbortController();
  old.abort(new Error("the Mac slept"));
}
