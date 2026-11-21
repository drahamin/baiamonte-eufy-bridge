/** Recover a previously responsive history connection, never a never-supported station. */
export class DatabaseReadWatchdog {
  private answered = false;
  private misses = 0;
  private timer?: NodeJS.Timeout;
  constructor(private readonly mayReconnect: () => boolean, private readonly reconnect: () => void) {}
  begin(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.answered || !this.mayReconnect()) { this.misses = 0; return; }
      if (++this.misses < 3) return;
      this.reset(); // A fresh connection must answer before another recovery is eligible.
      this.reconnect();
    }, 35000);
    this.timer.unref?.();
  }
  reply(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.answered = true;
    this.misses = 0;
  }
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.answered = false;
    this.misses = 0;
  }
}
