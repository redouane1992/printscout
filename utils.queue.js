class Queue {
  constructor({ concurrency = 3, delayMs = 0 } = {}) {
    this.concurrency = concurrency;
    this.delayMs = delayMs;
    this.tasks = [];
  }

  add(fn) {
    this.tasks.push(fn);
  }

  async run() {
    const workers = [];
    let idx = 0;

    const runOne = async () => {
      while (idx < this.tasks.length) {
        const my = idx++;
        const fn = this.tasks[my];
        try { await fn(); } catch (e) { /* swallow */ }
        if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs));
      }
    };

    for (let i = 0; i < this.concurrency; i++) workers.push(runOne());
    await Promise.all(workers);
  }
}
