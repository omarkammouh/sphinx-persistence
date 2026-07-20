# sphinx-persistence

Save your readers' work in a Jupyter Book / TeachBooks / Sphinx website.

Without this extension, everything a reader does in an interactive book is
gone the moment they refresh or close the page: quiz answers, code they
edited, exercises they filled in. With this extension, all of it comes back,
and three new buttons appear in the page toolbar:

- **Export**: download all progress as a file
- **Import**: load that file on another computer
- **Reset**: wipe everything and start clean

Everything is stored in the reader's own browser. There is no server, no
account, and no data ever leaves their computer.

## Install

Two lines, then rebuild your book.

**1.** Add to your book's `requirements.txt`:

```
sphinx-persistence @ git+https://github.com/omarkammouh/sphinx-persistence
```

**2.** Add to your book's `_config.yml`:

```yaml
sphinx:
  extra_extensions:
    - sphinx_persistence
```

That is all. For a plain Sphinx project (no Jupyter Book), add
`"sphinx_persistence"` to the `extensions` list in `conf.py` instead.

## What gets saved

- Anything typed into text boxes and text areas
- Checkboxes, radio buttons, dropdowns and sliders
- Code the reader edits in live-code (thebe) cells
- Answers in TeachBooks-Questions quizzes (multiple choice and math)
- Custom HTML activities (the reader's clicks are recorded and replayed on
  reload, so the activity rebuilds itself, including its "Check" result)
- Optional "Mark as done" checkboxes, with checkmarks in the sidebar showing
  which pages are finished

## What does not get saved

- The output of code cells. Only the code is saved; the reader runs the cell
  again to get the output back.
- Anything inside an iframe from another website (YouTube, H5P on h5p.com,
  and so on). Browsers do not allow a page to look inside those.
- Canvas animations and games. They restart on purpose.
- Which tab of a tab-set was open.

## Settings

Everything works with no settings at all. If you want more, add any of these
under `sphinx: config:` in `_config.yml`:

| Setting | Default | What it does |
|---|---|---|
| `persistence_toolbar` | `true` | Show the Export / Import / Reset buttons |
| `persistence_code_cells` | `true` | Save edits in live-code cells |
| `persistence_questions` | `true` | Save TeachBooks-Questions answers |
| `persistence_activities` | `true` | Save custom HTML activities |
| `persistence_progress_checkboxes` | `false` | Add "Mark as done" checkboxes and sidebar checkmarks |
| `persistence_part_heading_pages` | `""` | On pages matching this pattern, numbered section headings also get a checkbox (for example `"chapter_3\|chapter_4"`) |
| `persistence_activity_exclude_ids` | `[]` | Activities that should never be saved (for example timed games) |
| `persistence_book_id` | `""` | A name for your book, so importing a progress file from a different book shows a warning |

## Good to know

- Progress is saved per browser, per computer. To move it, use Export on one
  machine and Import on the other.
- Browsers give a website about 5 MB of storage. If a reader ever fills it,
  they get a warning instead of silent data loss.
- If you edit your book, saved code is only restored into a cell whose
  original content still matches. It is skipped otherwise, never put into
  the wrong cell.
- Reset only touches this extension's data, nothing else on the site.

## Development

The JavaScript lives in `src/sphinx_persistence/static/`. Sphinx serves the
installed copy, so after editing, reinstall before rebuilding the site you
test against:

```
pip install --force-reinstall --no-deps /path/to/sphinx-persistence
```

## License

MIT
