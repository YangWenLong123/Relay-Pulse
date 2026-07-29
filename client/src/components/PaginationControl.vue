<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { LeftOutlined, RightOutlined } from '@ant-design/icons-vue';

type PageItem = number | 'ellipsis';

const props = withDefaults(
  defineProps<{
    current: number;
    pageSize: number;
    total: number;
    pageSizeOptions?: readonly number[];
  }>(),
  { pageSizeOptions: () => [10, 20, 50, 100] }
);

const emit = defineEmits<{
  'update:current': [page: number];
  'update:pageSize': [pageSize: number];
}>();

const pageCount = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
const jumpPage = ref(String(props.current));
const pages = computed<PageItem[]>(() => {
  const lastPage = pageCount.value;
  const currentPage = Math.min(Math.max(1, props.current), lastPage);

  if (lastPage <= 7) return Array.from({ length: lastPage }, (_, index) => index + 1);
  if (currentPage <= 4) return [1, 2, 3, 4, 5, 'ellipsis', lastPage];
  if (currentPage >= lastPage - 3) return [1, 'ellipsis', lastPage - 4, lastPage - 3, lastPage - 2, lastPage - 1, lastPage];
  return [1, 'ellipsis', currentPage - 1, currentPage, currentPage + 1, 'ellipsis', lastPage];
});

watch(
  () => props.current,
  (page) => {
    jumpPage.value = String(page);
  }
);

function setPage(page: number): void {
  emit('update:current', Math.min(Math.max(1, page), pageCount.value));
}

function onPageSizeChange(value: number): void {
  emit('update:pageSize', value);
}

function submitJump(): void {
  const page = Number(jumpPage.value);
  if (Number.isInteger(page)) setPage(page);
  else jumpPage.value = String(props.current);
}
</script>

<template>
  <nav v-if="total > 0" class="pagination-control" aria-label="分页">
    <a-tooltip title="上一页">
      <a-button class="pagination-icon" type="text" :disabled="current <= 1" aria-label="上一页" @click="setPage(current - 1)">
        <template #icon><LeftOutlined /></template>
      </a-button>
    </a-tooltip>

    <template v-for="(page, index) in pages" :key="`${page}-${index}`">
      <span v-if="page === 'ellipsis'" class="pagination-ellipsis" aria-hidden="true">...</span>
      <a-button
        v-else
        class="pagination-page"
        :class="{ active: page === current }"
        type="text"
        :aria-label="`第 ${page} 页`"
        :aria-current="page === current ? 'page' : undefined"
        @click="setPage(page)"
      >
        {{ page }}
      </a-button>
    </template>

    <a-tooltip title="下一页">
      <a-button class="pagination-icon" type="text" :disabled="current >= pageCount" aria-label="下一页" @click="setPage(current + 1)">
        <template #icon><RightOutlined /></template>
      </a-button>
    </a-tooltip>

    <a-select class="pagination-size" :value="pageSize" aria-label="每页条数" @update:value="onPageSizeChange">
      <a-select-option v-for="size in pageSizeOptions" :key="size" :value="size">{{ size }} 条/页</a-select-option>
    </a-select>

    <label class="pagination-jump">
      <span>跳至</span>
      <a-input
        v-model:value="jumpPage"
        inputmode="numeric"
        :aria-label="`跳至第几页，范围 1 至 ${pageCount}`"
        @blur="submitJump"
        @press-enter="submitJump"
      />
      <span>页</span>
    </label>
  </nav>
</template>

<style scoped>
.pagination-control {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-height: 56px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  color: var(--text);
}

.pagination-icon,
.pagination-page {
  width: 32px;
  min-width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 6px;
  color: var(--text);
}

.pagination-page.active {
  border: 1px solid var(--accent);
  background: var(--surface);
  color: var(--accent);
}

.pagination-page:not(.active):hover,
.pagination-icon:not(:disabled):hover {
  background: var(--accent-soft);
  color: var(--accent);
}

.pagination-ellipsis {
  display: grid;
  width: 24px;
  height: 32px;
  place-items: center;
  color: var(--muted);
}

.pagination-size { width: 116px; margin-left: 12px; }
.pagination-jump { display: inline-flex; align-items: center; gap: 8px; color: var(--text); white-space: nowrap; }
.pagination-jump :deep(.ant-input) { width: 52px; height: 32px; text-align: center; }

@media (max-width: 720px) {
  .pagination-control { flex-wrap: wrap; }
  .pagination-size { margin-left: 0; }
}
</style>
