import type { FixedQuestion } from '../../src/worker/catalog/definition';
import manifest from '../../supabase/seeds/mock-hiragana.json';

// 初期投入データをテスト入力として使用。アプリの実行コードからは参照しない。
export const questions = manifest as FixedQuestion[];
export const questionProvenance = {
  source: questions[0].source,
  permission: questions[0].permission,
  demoAllowed: true,
} as const;
