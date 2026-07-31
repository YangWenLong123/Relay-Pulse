<!--
 * @Description: 从本机 CC Switch 数据库预览并导入中转站
 * @Date: 2026-07-30
 * @FilePath: client/src/components/CcSwitchImportModal.vue
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { TableColumnsType } from 'ant-design-vue';
import { message } from 'ant-design-vue';
import { ReloadOutlined } from '@ant-design/icons-vue';
import { previewCcSwitchImport } from '../api/relays';
import { errorMessage } from '../api/http';
import { useRelayStore } from '../stores/relays';
import type { CcSwitchImportCandidate, CcSwitchImportPreview } from '../types';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const store = useRelayStore();
const preview = ref<CcSwitchImportPreview>();
const selectedRowKeys = ref<string[]>([]);
const loading = ref(false);
const importing = ref(false);
const loadError = ref('');
let loadController: AbortController | undefined;

const columns: TableColumnsType<CcSwitchImportCandidate> = [
  { title: '名称', dataIndex: 'name', key: 'name', width: 190 },
  { title: '来源', dataIndex: 'source', key: 'source', width: 90, responsive: ['sm'] },
  { title: 'Base URL', dataIndex: 'baseUrl', key: 'baseUrl', width: 280, responsive: ['md'] },
  { title: 'API Key', dataIndex: 'apiKeyMasked', key: 'apiKeyMasked', width: 170, responsive: ['lg'] },
  { title: '模型', dataIndex: 'model', key: 'model', width: 210, responsive: ['md'] },
  { title: '状态', key: 'status', width: 100 }
];

const candidates = computed(() => preview.value?.candidates ?? []);
const importableCount = computed(() => candidates.value.filter((candidate) => !candidate.alreadyExists).length);
const duplicateCount = computed(() => candidates.value.length - importableCount.value);

watch(
  () => props.open,
  (open) => {
    if (open) void loadPreview();
    else loadController?.abort();
  }
);

async function loadPreview(): Promise<void> {
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  loading.value = true;
  loadError.value = '';
  preview.value = undefined;
  selectedRowKeys.value = [];
  try {
    const result = await previewCcSwitchImport(controller.signal);
    if (controller.signal.aborted) return;
    preview.value = result;
  } catch (error) {
    if (!controller.signal.aborted) loadError.value = errorMessage(error);
  } finally {
    if (loadController === controller) {
      loading.value = false;
      loadController = undefined;
    }
  }
}

function onSelectionChange(keys: (string | number)[]): void {
  selectedRowKeys.value = keys.map(String);
}

function handleCancel(): void {
  if (importing.value) return;
  emit('close');
}

async function confirmImport(): Promise<void> {
  if (!selectedRowKeys.value.length || importing.value) return;
  importing.value = true;
  try {
    const result = await store.importCcSwitch(selectedRowKeys.value);
    const skipped = result.duplicateCount ? `，跳过 ${result.duplicateCount} 个重复项` : '';
    message.success(`已从 CC Switch 导入 ${result.imported.length} 个中转站${skipped}`);
    emit('close');
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <a-modal
    :open="open"
    :width="1280"
    title="从 CC Switch 导入"
    :mask-closable="!importing"
    :closable="!importing"
    :keyboard="!importing"
    @cancel="handleCancel"
  >
    <div class="cc-import-summary">
      <div><span>可导入</span><strong>{{ importableCount }}</strong></div>
      <div><span>已存在</span><strong>{{ duplicateCount }}</strong></div>
      <div><span>不支持</span><strong>{{ preview?.unsupportedCount ?? 0 }}</strong></div>
      <div><span>配置不完整</span><strong>{{ preview?.invalidCount ?? 0 }}</strong></div>
    </div>

    <div v-if="loadError" class="error-banner cc-import-error" role="alert">
      <span>{{ loadError }}</span>
      <a-button size="small" :loading="loading" @click="loadPreview">
        <template #icon><ReloadOutlined /></template>
        重试
      </a-button>
    </div>

    <a-table
      v-else
      row-key="id"
      size="small"
      :columns="columns"
      :data-source="candidates"
      :loading="loading"
      :pagination="{ pageSize: 6, showSizeChanger: false, hideOnSinglePage: true }"
      :row-selection="{
        selectedRowKeys,
        onChange: onSelectionChange,
        getCheckboxProps: (candidate: CcSwitchImportCandidate) => ({ disabled: candidate.alreadyExists })
      }"
    >
      <template #emptyText>
        <a-empty :description="loading ? '正在读取 CC Switch 配置' : '没有找到可识别的 Codex 或 Claude 配置'" />
      </template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          <div class="cc-import-name">
            <strong>{{ record.name }}</strong>
            <a-tag v-if="record.isCurrent" color="processing">当前使用</a-tag>
          </div>
        </template>
        <template v-else-if="column.key === 'source'">
          <a-tag :color="record.source === 'codex' ? 'blue' : 'orange'">{{ record.source === 'codex' ? 'Codex' : 'Claude' }}</a-tag>
        </template>
        <template v-else-if="column.key === 'baseUrl'">
          <a-tooltip :title="record.baseUrl"><span class="cc-import-value mono">{{ record.baseUrl }}</span></a-tooltip>
        </template>
        <template v-else-if="column.key === 'apiKeyMasked'">
          <span class="cc-import-value mono">{{ record.apiKeyMasked }}</span>
        </template>
        <template v-else-if="column.key === 'model'">
          <a-tooltip :title="record.model"><span class="cc-import-value">{{ record.model }}</span></a-tooltip>
        </template>
        <template v-else-if="column.key === 'status'">
          <a-tag :color="record.alreadyExists ? 'default' : 'success'">{{ record.alreadyExists ? '已存在' : '可导入' }}</a-tag>
        </template>
      </template>
    </a-table>

    <p v-if="preview && !loadError" class="cc-import-note">
      已选择 {{ selectedRowKeys.length }} 项。Gemini 配置暂不支持；导入项会追加到当前列表末尾。
    </p>

    <template #footer>
      <a-button :disabled="importing" @click="handleCancel">取消</a-button>
      <a-button type="primary" :loading="importing" :disabled="loading || !!loadError || !selectedRowKeys.length" @click="confirmImport">
        导入 {{ selectedRowKeys.length }} 项
      </a-button>
    </template>
  </a-modal>
</template>
