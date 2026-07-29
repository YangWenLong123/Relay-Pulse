import type { BatchItem, BatchItemStatus } from '../types';

export type BatchCounts = Record<BatchItemStatus, number> & { total: number };

export function countBatchItems(items: BatchItem[]): BatchCounts {
  const counts: BatchCounts = {
    total: items.length,
    queued: 0,
    running: 0,
    success: 0,
    failed: 0,
    cancelled: 0
  };
  items.forEach((item) => {
    counts[item.status] += 1;
  });
  return counts;
}
