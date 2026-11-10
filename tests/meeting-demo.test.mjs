import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const demoPath = join(root, 'index.html');

function loadDemoApi() {
  if (!existsSync(demoPath)) return {};

  const html = readFileSync(demoPath, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  const script = scripts.map((match) => match[1]).join('\n');
  const context = { console, window: {} };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(script, context, { filename: 'index.html' });
  return context.window.MeetingDemo ?? {};
}

test('formatElapsed zero-pads a one-minute duration', () => {
  const api = loadDemoApi();
  assert.equal(typeof api.formatElapsed, 'function');
  assert.equal(api.formatElapsed(65), '00:01:05');
});

test('createMinutes retains the current Chinese transcript in its overview', () => {
  const api = loadDemoApi();
  assert.equal(typeof api.createMinutes, 'function');
  const minutes = api.createMinutes('用户新增示例工作区，以降低首次导入门槛。', '产品评审');
  assert.match(minutes.overview, /用户新增示例工作区/);
});

test('createMinutes gives an explicit empty-transcript fallback', () => {
  const api = loadDemoApi();
  assert.equal(typeof api.createMinutes, 'function');
  const minutes = api.createMinutes('', '产品评审');
  assert.match(minutes.overview, /暂无可总结的逐字稿/);
});

test('createMinutes keeps an unrelated transcript source-grounded and leaves unknown ownership pending', () => {
  const api = loadDemoApi();
  const transcript = '财务决定取消发布会。李明明天退还场地费用。';
  const minutes = api.createMinutes(transcript, '预算复盘');
  const serialized = JSON.stringify(minutes);

  assert.match(serialized, /财务决定取消发布会/);
  assert.match(serialized, /李明明天退还场地费用/);
  assert.equal(minutes.actions[0].owner, '待确认');
  assert.equal(minutes.actions[0].due, '待确认');
  assert.doesNotMatch(serialized, /林然|周宁|示例工作区|首次使用/);
});

test('toMarkdown keeps Chinese content and structured headings', () => {
  const api = loadDemoApi();
  assert.equal(typeof api.toMarkdown, 'function');
  const markdown = api.toMarkdown({
    topic: '产品评审',
    transcript: '团队确认周三交付设计稿。',
    minutes: {
      overview: '团队确认周三交付设计稿。',
      conclusions: ['引导完成率继续观察。'],
      actions: [{ task: '输出设计稿', owner: '林然', due: '周三' }],
      questions: ['目标基线是否仍为 42%？'],
    },
  });

  assert.match(markdown, /# 产品评审 · 会议纪要/);
  assert.match(markdown, /团队确认周三交付设计稿/);
  assert.match(markdown, /## 行动项/);
});

test('upsertHistory preserves raw transcripts, replaces a matching meeting, and retains the newest 20', () => {
  const api = loadDemoApi();
  assert.equal(typeof api.upsertHistory, 'function');
  const minutes = {
    overview: '设计评审已经完成。',
    conclusions: ['确认信息架构。'],
    actions: [{ task: '提交设计稿', owner: '待确认', due: '待确认' }],
    questions: [],
  };
  const first = { id: 'meeting-a', topic: '设计评审', savedAt: '2026-11-09T08:00:00.000Z', transcript: '第一行\n第二行', minutes };
  const saved = api.upsertHistory([], first);

  assert.equal(saved[0].transcript, '第一行\n第二行');
  const updated = api.upsertHistory(saved, { ...first, savedAt: '2026-11-09T10:00:00.000Z', transcript: '已更新的逐字稿' });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].transcript, '已更新的逐字稿');

  const crowded = Array.from({ length: 21 }, (_, index) => ({
    id: `meeting-${index}`,
    topic: `会议 ${index}`,
    savedAt: `2026-11-${String(index + 1).padStart(2, '0')}T08:00:00.000Z`,
    transcript: `内容 ${index}`,
    minutes,
  }));
  const retained = api.upsertHistory([], crowded[0]);
  const result = crowded.slice(1).reduce((records, record) => api.upsertHistory(records, record), retained);

  assert.equal(result.length, 20);
  assert.equal(result[0].id, 'meeting-20');
  assert.equal(result.at(-1).id, 'meeting-1');
});

test('normalizeHistory rejects malformed local records without losing valid entries', () => {
  const api = loadDemoApi();
  assert.equal(typeof api.normalizeHistory, 'function');
  const valid = {
    id: 'meeting-valid',
    topic: '有效会议',
    savedAt: '2026-11-09T08:00:00.000Z',
    transcript: '完整逐字稿',
    minutes: { overview: '概览', conclusions: [], actions: [], questions: [] },
  };
  const normalized = api.normalizeHistory([valid, null, { id: 'bad' }, { ...valid, id: '' }]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].id, 'meeting-valid');
});
