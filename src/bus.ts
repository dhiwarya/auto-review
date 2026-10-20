import { EventEmitter } from 'node:events';
import type { Job, StreamMessage } from './types.ts';

// In-process fan-out to the dashboard's live stream.
class Bus extends EventEmitter {
  emitJob(job: Job) {
    this.emit('message', { type: 'job', job } satisfies StreamMessage);
  }

  // The overview is rebuilt by the server on demand; this only says "it changed".
  overviewChanged() {
    this.emit('overview');
  }
}

export const bus = new Bus();
bus.setMaxListeners(50);
