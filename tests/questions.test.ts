import { describe, expect, it } from 'vitest';
import { exportQuestionJson, parseQuestionJson } from '../src/shared/question-json';
import {
  canReviewQuestion,
  canSubmitQuestion,
  emptyQuestion,
  normalizeTag,
  readingIssues,
  validateQuestionInput,
} from '../src/shared/questions';
import {
  answerReadings,
  orderQuestions,
  readingChoices,
} from '../src/worker/game/questions';
import { adjudicate, createState } from '../src/worker/game/state';

const input = () => ({
  ...emptyQuestion(),
  text: '日本で一番高い山は？',
  displayAnswer: '富士山',
  readings: ['ふじさん', 'ふじやま'],
  explanation: '標高3776mです。',
  evidence: '国土地理院の資料',
  categoryId: crypto.randomUUID(),
});

describe('作問入力と権限', () => {
  it('下書きは途中保存でき、提出には根拠・カテゴリ等が必要', () => {
    expect(validateQuestionInput(emptyQuestion(), false).issues).toEqual([]);
    expect(validateQuestionInput(emptyQuestion()).issues.length).toBeGreaterThan(0);
    expect(validateQuestionInput(input()).issues).toEqual([]);
    expect(
      validateQuestionInput({ ...input(), evidence: '' }).issues.some(
        (issue) => issue.path === 'evidence',
      ),
    ).toBe(true);
  });
  it('文字数上限・未知の項目・正答と同じひっかけを拒否する', () => {
    expect(
      validateQuestionInput({ ...input(), text: 'あ'.repeat(151) }).issues,
    ).toHaveLength(1);
    expect(validateQuestionInput({ ...input(), approved: true }).issues).toHaveLength(1);
    expect(
      validateQuestionInput({
        ...input(),
        traps: [{ answer: '別名', reading: 'ふじさん' }],
      }).issues,
    ).toHaveLength(1);
    expect(
      validateQuestionInput({ ...input(), readings: ['か\u3099く', 'がく'] }).value
        .readings,
    ).toEqual(['がく']);
  });
  it('全ての回答途中で必要な次文字を数え、短い正解後の枝は数えない', () => {
    expect(readingIssues(['あか', 'あき', 'あく', 'あけ', 'あこ'])).toHaveLength(1);
    expect(readingIssues(['あ', 'あか', 'あき', 'あく', 'あけ', 'あこ'])).toEqual([]);
    expect(readingIssues(['あ', 'い', 'う', 'え', 'お'])).toHaveLength(1);
  });
  it('資格と審査担当を独立させ、モデレーター自己承認を拒否', () => {
    expect(canSubmitQuestion('qualified', false, false)).toBe(false);
    expect(canSubmitQuestion('review', false, false)).toBe(true);
    expect(canSubmitQuestion('admin', false, true)).toBe(false);
    expect(canReviewQuestion(false, true, 'a', 'a')).toBe(false);
    expect(canReviewQuestion(true, false, 'a', 'a')).toBe(true);
    expect(canReviewQuestion(false, true, 'a', 'b')).toBe(true);
    expect(normalizeTag(' ＡＢＣ　 日本  ')).toBe('abc 日本');
  });
});

describe('JSON境界', () => {
  it('重複キーと500問超過を拒否し、原文を黙って欠落させない', () => {
    expect(() => parseQuestionJson('{"version":1,"version":1,"questions":[]}')).toThrow(
      '重複',
    );
    expect(() =>
      parseQuestionJson(
        JSON.stringify({ version: 1, questions: Array(501).fill(input()) }),
      ),
    ).toThrow('500');
    expect(() => parseQuestionJson('{\n"version":}')).toThrow('2行');
  });
  it('500問単位で分割し、出力→再取込で全問題を保持する', () => {
    const questions = Array.from({ length: 501 }, (_, i) => ({
      ...input(),
      text: `問題${i}`,
    }));
    const files = exportQuestionJson(questions);
    expect(files).toHaveLength(2);
    expect(files.flatMap(parseQuestionJson)).toEqual(questions);
  });
});

describe('複数読みでの採点', () => {
  function play(readings: string[], answer: string) {
    const state = createState(
      crypto.randomUUID(),
      [{ id: 'q', text: '問題', answer: readings[0], readings, explanation: '解説' }],
      0,
      2,
    );
    state.players = ['a', 'b'].map((id) => ({
      id,
      name: id,
      correct: 0,
      mistakes: 0,
      locked: false,
      disqualified: false,
      connected: true,
    }));
    state.phase = 'REVEALING';
    state.deadline = 10000;
    const send = (type: 'buzz' | 'choose', choiceId?: string) =>
      adjudicate(
        state,
        'a',
        {
          commandId: crypto.randomUUID(),
          matchId: state.matchId,
          questionId: 'q',
          type,
          payload:
            type === 'buzz'
              ? {}
              : {
                  attemptId: state.panel?.attemptId,
                  panelId: state.panel?.panelId,
                  choiceId,
                },
        },
        0,
      );
    send('buzz');
    for (const letter of answer) {
      expect(state.panel?.choices).toHaveLength(4);
      const choice = state.panel?.choices.find(
        (candidateChoice) => candidateChoice.text === letter,
      );
      expect(choice).toBeDefined();
      send('choose', choice?.id);
    }
    return state;
  }
  it('分岐した読みを正解にし、共通接頭辞だけでは正解にしない', () => {
    expect(play(['ふじさん', 'ふじやま'], 'ふじ').phase).toBe('ANSWERING');
    expect(play(['ふじさん', 'ふじやま'], 'ふじやま').judgment?.result).toBe('correct');
  });
  it('最初に登録済みの短い読みに到達したら正解にする', () => {
    expect(
      play(['あめりか', 'あめりかがっしゅうこく'], 'あめりか').judgment?.result,
    ).toBe('correct');
  });
  it('全ての正しい次文字を4択に含め、ダミーで補う', () => {
    const question = {
      id: 'q',
      text: 'q',
      answer: 'あか',
      readings: ['あか', 'あき', 'あく', 'あけ'],
      explanation: '',
    };
    expect(
      readingChoices(question, 'あ')
        .map((choice) => choice.text)
        .sort(),
    ).toEqual(['か', 'き', 'く', 'け']);
    expect(answerReadings({ ...question, readings: undefined })).toEqual(['あか']);
  });
  it('初心者へ上位難易度を出さず、同じ試合で重複しない', () => {
    const source = [0, 1, 2].map((difficulty) => ({
      id: String(difficulty),
      text: 'q',
      answer: 'あ',
      explanation: '',
      difficulty,
      categoryId: 'c',
    }));
    expect(orderQuestions(source, 0).map((question) => question.id)).toEqual(['0']);
    expect(new Set(orderQuestions(source, 2).map((question) => question.id)).size).toBe(
      3,
    );
  });
});
