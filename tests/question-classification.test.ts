import { beforeEach, expect, it, vi } from 'vitest';
import QuestionClassification from '../src/client/features/questions/QuestionClassification';
import type { QuestionOverview } from '../src/shared/questions';

const mocks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  uncertain: false,
  submit: vi.fn(),
}));
vi.mock('react', () => ({
  useRef: (value: unknown) => {
    const i = mocks.cursor++;
    if (i >= mocks.slots.length) mocks.slots[i] = { current: value };
    return mocks.slots[i];
  },
  useState: (value: unknown) => {
    const i = mocks.cursor++;
    if (i >= mocks.slots.length) mocks.slots[i] = value;
    return [
      mocks.slots[i],
      (next: unknown) => {
        mocks.slots[i] = next;
      },
    ];
  },
}));
vi.mock('../src/client/features/questions/useQuestionOperation', () => ({
  useQuestionOperation: () => ({
    busy: false,
    uncertain: mocks.uncertain,
    submit: mocks.submit,
  }),
}));
type Element = {
  type: unknown;
  props: {
    children?: unknown;
    value?: string;
    onChange?: (event: { target: { value: string } }) => void;
    onClick?: () => void;
  };
};
function find(root: unknown, match: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(root)) return root.map((item) => find(item, match)).find(Boolean);
  if (!root || typeof root !== 'object' || !('props' in root)) return;
  const element = root as Element;
  return match(element) ? element : find(element.props.children, match);
}
function draw(id = 'a', revision = 1, open = true) {
  const data = {
    submissions: [{ id, revision, input: { text: id, categoryId: 'old' } }],
    categories: [{ id: 'next', name: '変更先', active: true }],
  } as QuestionOverview;
  const render = () => {
    mocks.cursor = 0;
    return QuestionClassification({
      data,
      instanceId: 'instance',
      saved: async () => {},
      open,
      onClose: () => {},
    });
  };
  render();
  return render();
}
const button = (root: unknown, label: string) =>
  find(root, (element) => element.props.children === label);
const applyLabel = '確認したカテゴリ変更を一括反映';
function prepare() {
  find(draw(), (element) => element.type === 'textarea')?.props.onChange?.({
    target: { value: JSON.stringify([{ id: 'a', categoryId: 'next' }]) },
  });
  button(draw(), '分類結果を読み込んで変更前後を確認')?.props.onClick?.();
  expect(button(draw(), applyLabel)).toBeDefined();
}
beforeEach(() => {
  mocks.slots = [];
  mocks.uncertain = false;
  mocks.submit.mockReset();
});
it('閉じた後に選択対象や版が変わったら古い分類結果を破棄する', () => {
  prepare();
  draw('a', 1, false);
  expect(button(draw('b'), applyLabel)).toBeUndefined();
  expect(find(draw('b'), (element) => element.type === 'textarea')?.props.value).toBe('');
  prepare();
  expect(button(draw('a', 2), applyLabel)).toBeUndefined();
});
it('保存結果が不明な間は選択変更でも再試行用の対象と入力を保持する', () => {
  prepare();
  mocks.uncertain = true;
  expect(button(draw('b'), applyLabel)).toBeDefined();
  expect(
    find(draw('b'), (element) => element.type === 'textarea')?.props.value,
  ).toContain('"a"');
  button(draw('b'), '同じ内容で再試行')?.props.onClick?.();
  expect(mocks.submit).toHaveBeenCalledWith({});
  mocks.uncertain = false;
  expect(button(draw('b'), applyLabel)).toBeUndefined();
});
