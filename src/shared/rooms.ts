import { readQuestionJson } from './question-json.ts';
import { graphemes, readingIssues } from './questions.ts';

export type BroughtQuestion = {
  text: string;
  displayAnswer: string;
  readings: string[];
  explanation: string;
};
export type RoomSettings = {
  name: string;
  public: boolean;
  capacity: number;
  presenter: boolean;
  guests: boolean;
  categories: string[];
  difficulties: number[];
  winMode: 'target' | 'questions';
  count: number;
  mistakes: number | null;
  source: 'normal' | 'original';
};
export type RoomMember = {
  id: string;
  name: string;
  guest: boolean;
  ready: boolean;
  joinedAt: number;
  connected: boolean;
};
export type RoomView = {
  guestAllowed?: boolean;
  id: string;
  instanceId: string;
  settings: RoomSettings;
  password: boolean;
  revision: number;
  hostId: string;
  members: RoomMember[];
  closed: boolean;
  playing: boolean;
  matchRoom: string | null;
  waiting: boolean;
  invite?: string;
};
export type CasualSettings = {
  enabled: boolean;
  players: number;
  casualGuests: boolean;
  roomGuests: boolean;
};
export const defaultCasualSettings: CasualSettings = {
  enabled: true,
  players: 4,
  casualGuests: false,
  roomGuests: false,
};
export const newRoomSettings = (guests: boolean): RoomSettings => ({
  name: '',
  public: true,
  capacity: 8,
  presenter: false,
  guests,
  categories: [],
  difficulties: [0, 1, 2],
  winMode: 'target',
  count: 7,
  mistakes: 3,
  source: 'normal',
});
export const emptyBroughtQuestion = (): BroughtQuestion => ({
  text: '',
  displayAnswer: '',
  readings: [''],
  explanation: '',
});

export function validateBroughtQuestion(value: unknown): BroughtQuestion {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('問題の形式を確認してください。');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !['text', 'displayAnswer', 'readings', 'explanation'].includes(key),
    )
  )
    throw new Error('未対応の問題項目があります。');
  for (const [key, max] of [
    ['text', 150],
    ['displayAnswer', 20],
    ['explanation', 300],
  ] as const) {
    if (key === 'explanation' && input[key] === undefined) continue;
    if (
      typeof input[key] !== 'string' ||
      graphemes(input[key]).length > max ||
      (key !== 'explanation' && !input[key].trim())
    )
      throw new Error(`${key} の文字数・形式を確認してください。`);
  }
  if (
    !Array.isArray(input.readings) ||
    input.readings.length < 1 ||
    input.readings.length > 8 ||
    input.readings.some((r) => typeof r !== 'string')
  )
    throw new Error('読みは1〜8種類です。');
  const readings = [
    ...new Set(input.readings.map((r: string) => r.normalize('NFKC').trim())),
  ];
  const issues = readingIssues(readings);
  if (issues.length) throw new Error(issues.map((i) => i.message).join('\n'));
  return {
    text: String(input.text),
    displayAnswer: String(input.displayAnswer),
    readings,
    explanation: typeof input.explanation === 'string' ? input.explanation : '',
  };
}

export function validateBroughtSet(value: unknown): BroughtQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500)
    throw new Error('持込問題は1〜500問です。');
  return value.map((q, i) => {
    try {
      return validateBroughtQuestion(q);
    } catch (error) {
      throw new Error(
        `問題${i + 1}：${error instanceof Error ? error.message : '入力を確認してください。'}`,
      );
    }
  });
}
export function parseBroughtJson(source: string): BroughtQuestion[] {
  const parsed = readQuestionJson(source) as {
    version?: unknown;
    questions?: unknown;
  } | null;
  if (
    !parsed ||
    Object.keys(parsed).sort().join(',') !== 'questions,version' ||
    parsed.version !== 1
  )
    throw new Error('version: 1 と questions を指定してください。');
  return validateBroughtSet(parsed.questions);
}
export function validateRoomSettings(value: unknown): RoomSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_ROOM_SETTINGS');
  const v = value as RoomSettings;
  if (
    Object.keys(v).sort().join(',') !==
      Object.keys(newRoomSettings(false)).sort().join(',') ||
    typeof v.name !== 'string' ||
    !v.name.trim() ||
    graphemes(v.name).length > 80 ||
    !['public', 'presenter', 'guests'].every(
      (k) => typeof v[k as keyof RoomSettings] === 'boolean',
    ) ||
    !Number.isInteger(v.capacity) ||
    v.capacity < 2 ||
    v.capacity > 8 ||
    !Array.isArray(v.categories) ||
    v.categories.length > 100 ||
    v.categories.some((c) => typeof c !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(c)) ||
    !Array.isArray(v.difficulties) ||
    !v.difficulties.length ||
    v.difficulties.some((d) => ![0, 1, 2].includes(d)) ||
    !['target', 'questions'].includes(v.winMode) ||
    !Number.isInteger(v.count) ||
    v.count < 1 ||
    v.count > 100 ||
    (v.mistakes !== null &&
      (!Number.isInteger(v.mistakes) || v.mistakes < 1 || v.mistakes > 100)) ||
    !['normal', 'original'].includes(v.source)
  )
    throw new Error('INVALID_ROOM_SETTINGS');
  return {
    ...v,
    name: v.name.trim(),
    categories: [...new Set(v.categories)],
    difficulties: [...new Set(v.difficulties)],
  };
}
