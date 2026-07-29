import { createApp } from 'vue';
import { createPinia } from 'pinia';
import {
  AutoComplete,
  Badge,
  Button,
  Col,
  DatePicker,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Menu,
  Modal,
  Progress,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip
} from 'ant-design-vue';
import App from './App.vue';
import { router } from './router';
import 'ant-design-vue/dist/reset.css';
import './styles.css';

window.addEventListener(
  'error',
  (event: ErrorEvent) => {
    if (
      event.message === 'ResizeObserver loop completed with undelivered notifications.' ||
      event.message === 'ResizeObserver loop limit exceeded'
    ) {
      event.preventDefault();
    }
  },
  true
);

const app = createApp(App).use(createPinia()).use(router);
[
  AutoComplete,
  Badge,
  Button,
  Col,
  DatePicker,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Menu,
  Modal,
  Progress,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip
].forEach((component) => app.use(component));
app.mount('#app');
