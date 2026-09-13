export const graphemes = (text: string) =>
  Array.from(
    new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(
      text.normalize('NFKC').trim(),
    ),
    ({ segment }) => segment,
  );

export type Question = { id: string; text: string; answer: string; explanation: string };

export const questionProvenance = {
  source: 'Quiz Relay向けの独自作成。一般的な事実を基に作問し、既存問題集の転載なし。',
  permission: 'ユーザーが2026-09-11に作問・デモ利用方針を承認。',
  demoAllowed: true,
} as const;

// 全問題にquestionProvenanceを適用する。
export const questions: Question[] = [
  {
    id: 'mock-01',
    text: '雨上がりの空に見えることがある、赤から紫までの色が帯のように並ぶものは何でしょう？',
    answer: 'にじ',
    explanation: '空気中の水滴が光を屈折・分散させて見える虹です。',
  },
  {
    id: 'mock-02',
    text: '長い首を使って高い木の葉を食べる、体に斑点模様のある動物は何でしょう？',
    answer: 'きりん',
    explanation: 'キリンは長い首を持つ草食動物です。',
  },
  {
    id: 'mock-03',
    text: '海を泳ぐ哺乳類で、頭の上の噴気孔から呼吸をする大きな動物は何でしょう？',
    answer: 'くじら',
    explanation: 'クジラは肺で呼吸する哺乳類です。',
  },
  {
    id: 'mock-04',
    text: '鉛筆で書いた文字を、紙の上でこすって消すときに使う文房具は何でしょう？',
    answer: 'けしごむ',
    explanation: '消しゴムは紙に付着した黒鉛を取り除きます。',
  },
  {
    id: 'mock-05',
    text: '冷たい飲み物に浮かべることもある、水が凍って固体になったものは何でしょう？',
    answer: 'こおり',
    explanation: '固体になった水を氷と呼びます。',
  },
  {
    id: 'mock-06',
    text: '夜空に見え、地球のまわりを回っている天然の衛星は何でしょう？',
    answer: 'つき',
    explanation: '月は地球の天然の衛星です。',
  },
  {
    id: 'mock-07',
    text: '料理をはさむために二本一組で使う、日本の食卓でおなじみの道具は何でしょう？',
    answer: 'はし',
    explanation: '箸は二本の棒を組み合わせて使います。',
  },
  {
    id: 'mock-08',
    text: '背中にとげがあり、危険を感じると丸くなることで知られる小さな哺乳類は何でしょう？',
    answer: 'はりねずみ',
    explanation: 'ハリネズミは体を丸めて身を守ります。',
  },
  {
    id: 'mock-09',
    text: '冷凍庫で作ることもできる、牛乳などを使った冷たく甘いお菓子は何でしょう？',
    answer: 'あいすくりーむ',
    explanation: 'アイスクリームは乳原料などを凍らせて作る菓子です。',
  },
  {
    id: 'mock-10',
    text: '楽器の一つで、白と黒の鍵盤を押し、内部の弦をハンマーでたたいて音を出すものは何でしょう？',
    answer: 'ぴあの',
    explanation: 'ピアノは鍵盤の操作でハンマーが弦を打つ楽器です。',
  },
  {
    id: 'mock-11',
    text: '細かく刻んだ具とご飯を炒めて作る、中華料理でおなじみの料理は何でしょう？',
    answer: 'ちゃーはん',
    explanation: 'チャーハンはご飯と具材を炒めた料理です。',
  },
  {
    id: 'mock-12',
    text: '紙などを二枚の刃ではさんで切る、指を入れる輪が二つある道具は何でしょう？',
    answer: 'はさみ',
    explanation: 'はさみは二枚の刃を開閉して物を切ります。',
  },
];

export const dummyCharacters = graphemes(
  'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽぁぃぅぇぉゃゅょっー',
);

export function choicesFor(correct: string) {
  const candidates = dummyCharacters.filter((text) => text !== correct);
  if (!dummyCharacters.includes(correct) || candidates.length < 3)
    throw new Error('INVALID_QUESTION');

  const sample = [correct];
  while (sample.length < 4) {
    const random = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
    sample.push(candidates.splice(Math.floor(random * candidates.length), 1)[0]);
  }

  for (let i = sample.length - 1; i > 0; i--) {
    const j = Math.floor(
      (crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * (i + 1),
    );
    [sample[i], sample[j]] = [sample[j], sample[i]];
  }

  return sample.map((text) => ({ id: crypto.randomUUID(), text }));
}
