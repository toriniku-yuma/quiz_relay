import { useState } from 'react';
import type { QuestionOverview } from '../../../shared/questions';
import Button from '../../components/Button';
import TextField from '../../components/TextField';

export default function QuestionSelectionSettings({
  data,
  busy,
  mutate,
}: {
  data: QuestionOverview;
  busy: boolean;
  mutate: (body: object) => Promise<boolean>;
}) {
  const [boundaries, setBoundaries] = useState(
    data.settings.rankBoundaries ?? [1200, 1600],
  );
  const [weights, setWeights] = useState(
    data.settings.difficultyWeights ?? [
      [1, 0, 0],
      [0.3, 0.7, 0],
      [0.1, 0.3, 0.6],
    ],
  );
  const [categories, setCategories] = useState(data.settings.categoryWeights ?? {});
  const [defect, setDefect] = useState(data.settings.reportThreshold);
  const [category, setCategory] = useState(data.settings.categoryReportThreshold);
  return (
    <section className="border border-line p-4">
      <h2 className="cursor-pointer text-xl font-bold">実力帯・出題割合・再審議の設定</h2>
      <div className="mt-4 grid gap-3">
        {['中級帯の最低レート', '上級帯の最低レート'].map((name, index) => (
          <TextField
            key={name}
            id={`rank-boundary-${index}`}
            label={name}
            type="number"
            value={boundaries[index]}
            onChange={(event) =>
              setBoundaries(
                boundaries.map((value, i) =>
                  i === index ? Number(event.target.value) : value,
                ),
              )
            }
          />
        ))}
        <p>
          割合は相対値です。候補がない難易度・カテゴリを除いて抽選します。0は出題対象外です。
        </p>
        {weights.map((row, band) => (
          <fieldset
            key={['初級', '中級', '上級'][band]}
            className="grid gap-2 border border-line p-3"
          >
            <legend>{['初級', '中級', '上級'][band]}帯の難易度割合</legend>
            {row.map(
              (weight, level) =>
                level <= band && (
                  <TextField
                    key={['簡単', '普通', '難しい'][level]}
                    id={`weight-${band}-${level}`}
                    label={['簡単', '普通', '難しい'][level]}
                    type="number"
                    min={0}
                    step="any"
                    value={weight}
                    onChange={(event) =>
                      setWeights(
                        weights.map((values, bandIndex) =>
                          bandIndex === band
                            ? values.map((value, levelIndex) =>
                                levelIndex === level ? Number(event.target.value) : value,
                              )
                            : values,
                        ),
                      )
                    }
                  />
                ),
            )}
          </fieldset>
        ))}
        {data.categories
          .filter((item) => item.active)
          .map((item) => (
            <TextField
              key={item.id}
              id={`category-weight-${item.id}`}
              label={`${item.name}の出題割合`}
              type="number"
              min={0}
              step="any"
              value={categories[item.id] ?? 1}
              onChange={(event) =>
                setCategories({ ...categories, [item.id]: Number(event.target.value) })
              }
            />
          ))}
        <TextField
          id="defect-threshold"
          label="問題不備の再審議しきい値"
          type="number"
          min={1}
          value={defect}
          onChange={(event) => setDefect(Number(event.target.value))}
        />
        <TextField
          id="category-threshold"
          label="カテゴリ違いの再審議しきい値"
          type="number"
          min={1}
          value={category}
          onChange={(event) => setCategory(Number(event.target.value))}
        />
        <Button
          disabled={busy}
          onClick={() => {
            void mutate({
              operation: 'settings',
              revision: data.settingsRevision,
              config: {
                ...data.settings,
                rankBoundaries: boundaries,
                difficultyWeights: weights,
                categoryWeights: categories,
                reportThreshold: defect,
                categoryReportThreshold: category,
              },
            });
          }}
        >
          出題・再審議設定を保存
        </Button>
      </div>
    </section>
  );
}
