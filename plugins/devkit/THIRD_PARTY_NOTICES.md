# 第三者のソフトウェアに関する表示

## superpowers

devkit（プラグイン `plugins/devkit/`）の次のファイルは、[obra/superpowers](https://github.com/obra/superpowers) v7.0.2（コミット 22f0b463e7a5e579904dd6211a520321035526f7）のスキルを、devkit の進め方に合わせて日本語で翻案したものです。devkit は superpowers 本体（プラグイン）には依存していません。

| devkit のファイル | 元にした superpowers のファイル |
| --- | --- |
| `skills/devkit-requirements/SKILL.md` | `skills/brainstorming/SKILL.md` |
| `agents/spec-reader.md` | `skills/brainstorming/builder-check-prompt.md` |
| `skills/devkit-tdd/SKILL.md` | `skills/test-driven-development/SKILL.md`、`writing-good-tests.md` |
| `skills/devkit-debugging/SKILL.md`、`techniques.md` | `skills/systematic-debugging/SKILL.md`、`root-cause-tracing.md`、`defense-in-depth.md`、`condition-based-waiting.md` |
| `skills/devkit-verification/SKILL.md` | `skills/verification-before-completion/SKILL.md` |
| `agents/reviewer.md`（品質レビューの観点） | `skills/requesting-code-review/code-reviewer.md`、`skills/subagent-driven-development/task-reviewer-prompt.md` |
| `agents/implementer.md`（差し戻しの受け止め方） | `skills/receiving-code-review/SKILL.md` |
| `agents/final-reviewer.md` | `skills/subagent-driven-development/references/final-review.md`、`skills/requesting-code-review/code-reviewer.md` |
| `skills/devkit-skill-authoring/SKILL.md` | `skills/writing-skills/SKILL.md` |
| `skills/devkit-diagnose/SKILL.md` | `skills/diagnosing-superpowers/SKILL.md` |

```
MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
