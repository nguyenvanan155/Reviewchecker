/**
 * queue.js
 * Async promise-pool concurrency queue with graceful stop support.
 */

class Queue {
  constructor() {
    this._stopped = false;
    this._paused = false;
    this._pauseResolvers = [];
  }

  stop() {
    this._stopped = true;
    // Unpause if paused so any waiting resume() calls resolve
    this._drainPause();
  }

  pause() {
    if (!this._paused) {
      this._paused = true;
    }
  }

  resume() {
    if (this._paused) {
      this._paused = false;
      this._drainPause();
    }
  }

  reset() {
    this._stopped = false;
    this._paused = false;
    this._pauseResolvers = [];
  }

  isStopped() {
    return this._stopped;
  }

  isPaused() {
    return this._paused;
  }

  _drainPause() {
    const resolvers = this._pauseResolvers.splice(0);
    resolvers.forEach((r) => r());
  }

  _waitIfPaused() {
    if (!this._paused) return Promise.resolve();
    return new Promise((resolve) => {
      this._pauseResolvers.push(resolve);
    });
  }

  /**
   * Run an array of async tasks with a concurrency limit.
   *
   * @param {Array} items          Items to process
   * @param {number} concurrency   Max parallel workers
   * @param {function} task        Async function (item, index) => result
   * @param {function} onProgress  Called after each item: (done, total, item, result)
   */
  async run(items, concurrency, task, onProgress) {
    this.reset();

    const total = items.length;
    let index = 0;
    let done = 0;

    const worker = async () => {
      while (index < total) {
        if (this._stopped) break;
        await this._waitIfPaused();
        if (this._stopped) break;

        const currentIndex = index++;
        const item = items[currentIndex];
        let result;
        try {
          result = await task(item, currentIndex);
        } catch (err) {
          result = { status: '⚠️ Error', error: err.message };
        }
        done++;
        if (onProgress) onProgress(done, total, item, result);
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
    await Promise.all(workers);
  }
}

module.exports = Queue;
