<!--
 * @Description: 测试历史筛选、查看与清理抽屉
 * @Date: 2026-07-28 16:17:28
 * @FilePath: client/src/components/HistoryDrawer.vue
-->
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import type { Dayjs } from 'dayjs';
import { message, Modal } from 'ant-design-vue';
import { DeleteOutlined, ReloadOutlined } from '@ant-design/icons-vue';
import { clearHistory, deleteHistory, listHistory } from '../api/relays';
import { errorMessage } from '../api/http';
import type { TestResult } from '../types';

const props = defineProps<{ open: boolean; initialRelayId?: string }>();
const emit = defineEmits<{ close: [] }>();
const loading = ref<boolean>(false);
const records = ref<TestResult[]>([]);
const success = ref<boolean>();
const dateRange = ref<[Dayjs, Dayjs]>();
const loadError = ref<string>('');
const deletingIds = ref<Set<string>>(new Set());
const clearing = ref<boolean>(false);
let loadController: AbortController | undefined;

watch(
  () => props.open,
  (open) => {
    if (!open) {
      loadController?.abort();
      return;
    }
    void load();
  }
);

/**
 * @description 根据当前筛选条件加载测试历史，并丢弃过期请求
 */
async function load(): Promise<void> {
  loadController?.abort();
  const currentController = new AbortController();
  loadController = currentController;
  loading.value = true;
  loadError.value = '';
  try {
    records.value = await listHistory(
      {
        relayId: props.initialRelayId,
        success: success.value,
        from: dateRange.value?.[0].startOf('day').toISOString(),
        to: dateRange.value?.[1].endOf('day').toISOString()
      },
      currentController.signal
    );
  } catch (error) {
    if (!currentController.signal.aborted) {
      loadError.value = errorMessage(error);
      message.error(loadError.value);
    }
  } finally {
    if (loadController === currentController) {
      loadController = undefined;
      loading.value = false;
    }
  }
}

async function remove(id: string): Promise<void> {
  deletingIds.value = new Set(deletingIds.value).add(id);
  try {
    await deleteHistory(id);
    records.value = records.value.filter((record) => record.id !== id);
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    const next = new Set(deletingIds.value);
    next.delete(id);
    deletingIds.value = next;
  }
}

function confirmClear(): void {
  Modal.confirm({
    title: '清空全部测试历史？',
    content: '该操作不可恢复。',
    okText: '清空',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      clearing.value = true;
      try {
        await clearHistory();
        records.value = [];
        message.success('测试历史已清空');
      } catch (error) {
        message.error(errorMessage(error));
        throw error;
      } finally {
        clearing.value = false;
      }
    }
  });
}

function close(): void {
  loadController?.abort();
  emit('close');
}

onBeforeUnmount(() => loadController?.abort());
</script>

<template>
  <a-drawer :open="open" title="测试历史" :width="680" root-class-name="responsive-drawer" @close="close">
    <!-- 结果与日期筛选工具栏 -->
    <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px">
      <a-select v-model:value="success" allow-clear placeholder="全部结果" style="width: 120px" @change="load">
        <a-select-option :value="true">成功</a-select-option>
        <a-select-option :value="false">失败</a-select-option>
      </a-select>
      <a-range-picker v-model:value="dateRange" style="flex: 1; min-width: 230px" @change="load" />
      <a-tooltip title="刷新">
        <a-button shape="circle" :loading="loading" aria-label="刷新测试历史" @click="load">
          <template #icon><ReloadOutlined /></template>
        </a-button>
      </a-tooltip>
    </div>
    <div v-if="loadError" class="error-banner" role="alert">{{ loadError }}</div>
    <a-spin :spinning="loading">
      <a-list :data-source="records" item-layout="vertical">
        <template #renderItem="{ item }">
          <a-list-item>
            <template #actions>
              <span class="history-value">{{ item.model }}</span>
              <span>{{ item.protocol }}</span>
              <span>{{ item.totalDuration }}ms</span>
              <a-tooltip title="删除记录">
                <a-button
                  type="text"
                  danger
                  size="small"
                  :loading="deletingIds.has(item.id)"
                  :aria-label="`删除 ${item.relayName} 的历史记录`"
                  @click="remove(item.id)"
                >
                  <template #icon><DeleteOutlined /></template>
                </a-button>
              </a-tooltip>
            </template>
            <a-list-item-meta>
              <template #title>
                <a-space wrap>
                  <a-badge :status="item.success ? 'success' : 'error'" />
                  <strong>{{ item.relayName }}</strong>
                  <span class="muted">{{ new Date(item.testedAt).toLocaleString() }}</span>
                </a-space>
              </template>
              <template #description>
                <span class="history-description">{{ item.success ? item.responseText : `${item.errorType || 'error'}：${item.errorMessage}` }}</span>
              </template>
            </a-list-item-meta>
          </a-list-item>
        </template>
      </a-list>
      <a-empty v-if="!loading && !records.length" description="暂无测试历史" style="padding: 50px 0" />
    </a-spin>
    <template #footer>
      <div style="display: flex; justify-content: space-between">
        <a-button danger :loading="clearing" :disabled="!records.length || loading" @click="confirmClear">
          <template #icon><DeleteOutlined /></template>
          清空历史
        </a-button>
        <a-button @click="close">关闭</a-button>
      </div>
    </template>
  </a-drawer>
</template>
