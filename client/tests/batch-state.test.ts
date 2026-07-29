import { describe, expect, it } from 'vitest';
import { countBatchItems } from '../src/utils/batch-state';
import type { BatchItem, BatchItemStatus, Relay } from '../src/types';

const relay = { id: 'relay' } as Relay;

describe('batch state counts', () => {
  it('keeps every task in exactly one state', () => {
    const statuses: BatchItemStatus[] = ['queued', 'running', 'success', 'failed', 'cancelled'];
    const items: BatchItem[] = statuses.map((status, index) => ({ relay: { ...relay, id: String(index) }, status }));
    const counts = countBatchItems(items);
    expect(counts.total).toBe(counts.queued + counts.running + counts.success + counts.failed + counts.cancelled);
  });
});
