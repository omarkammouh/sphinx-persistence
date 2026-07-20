"""Client-side persistence for interactive books built with Sphinx.

Auto-saves a reader's work (form inputs, quiz answers, live-code cell source,
bespoke raw-HTML activities) to the browser's localStorage and restores it on
reload, with an export / import / reset toolbar docked into the article
header. Everything is client-side: no server, no accounts, no third-party
services.

Enable it like any Sphinx extension (in Jupyter Book / TeachBooks:
``sphinx.extra_extensions: [sphinx_persistence]``). All options are
optional and set as regular Sphinx config values:

- ``persistence_toolbar`` (bool, True): the export / import / reset buttons.
- ``persistence_code_cells`` (bool, True): save live-code (thebe) cell source.
- ``persistence_questions`` (bool, True): save TeachBooks-Questions answers.
- ``persistence_activities`` (bool, True): record & replay clicks inside
  bespoke ``{raw} html`` activities.
- ``persistence_progress_checkboxes`` (bool, False): "Mark as done" controls
  and sidebar completion ticks. Opt-in because it expects the
  ``data-learning-activity="true"`` / ``.la-title`` markup convention.
- ``persistence_part_heading_pages`` (str, ""): JS regex matched against
  ``location.pathname``; on matching pages, numbered part headings
  ("1. ...", "3.1.2: ...", "Model 3 ...") also receive a completion checkbox.
- ``persistence_activity_exclude_ids`` (list[str], []): activity root ids the
  click recorder must skip (e.g. timed quiz games).
- ``persistence_book_id`` (str, ""): identity stamped into progress exports so
  an import from a different book can warn. Falls back to
  ``<meta name="book-id">``, then the site host.
"""

import json
from pathlib import Path

__version__ = "0.1.0"

_STATIC = Path(__file__).resolve().parent / "static"

# Build-time-generated file carrying the window.sphinxPersistence options.
_CONFIG_JS = "sphinx-persistence-config.js"

# (config option, filename) in required load order: data-manager.js first (it
# owns the shared key registry and reset utilities the others call), the click
# recorder after it, the completion checkboxes last.
_MODULES = (
    (None, "data-manager.js"),  # always on: the backbone of every other module
    ("persistence_toolbar", "book-exporter.js"),
    ("persistence_code_cells", "thebe-code-persistence.js"),
    ("persistence_questions", "teachbook-questions-persistence.js"),
    ("persistence_activities", "activity-persistence.js"),
    ("persistence_progress_checkboxes", "progress-checkboxes.js"),
)


def _on_builder_inited(app):
    """Register the JS assets once the builder (and config) is ready."""
    if app.builder.format != "html":
        return

    # Guard against double registration: under Jupyter Book / TeachBooks this
    # event can fire more than once per process.
    if getattr(app, "_sbp_assets_registered", False):
        return
    app._sbp_assets_registered = True

    app.config.html_static_path.append(str(_STATIC))

    # Runtime options the JS modules read at init. Emitted as a NAMED file
    # (generated into the doctree dir, served from _static/), not an inline
    # body script: the Jupyter Book / TeachBooks stack duplicates inline
    # <script> bodies in the rendered head (the reason books carry dedup
    # extensions for thebe/togglebutton), while named files register once.
    runtime = {
        "bookId": app.config.persistence_book_id,
        "activityExcludeIds": list(app.config.persistence_activity_exclude_ids),
        "partHeadingPages": app.config.persistence_part_heading_pages,
    }
    generated = Path(app.doctreedir) / "sphinx_persistence_static"
    generated.mkdir(parents=True, exist_ok=True)
    (generated / _CONFIG_JS).write_text(
        f"window.sphinxPersistence = {json.dumps(runtime)};\n",
        encoding="utf-8",
    )
    app.config.html_static_path.append(str(generated))
    # Low priority so the config loads before the module files below.
    app.add_js_file(_CONFIG_JS, priority=200)

    for option, filename in _MODULES:
        if option is None or getattr(app.config, option):
            app.add_js_file(filename)


def setup(app):
    app.add_config_value("persistence_toolbar", True, "html")
    app.add_config_value("persistence_code_cells", True, "html")
    app.add_config_value("persistence_questions", True, "html")
    app.add_config_value("persistence_activities", True, "html")
    app.add_config_value("persistence_progress_checkboxes", False, "html")
    app.add_config_value("persistence_part_heading_pages", "", "html")
    app.add_config_value("persistence_activity_exclude_ids", [], "html")
    app.add_config_value("persistence_book_id", "", "html")

    app.connect("builder-inited", _on_builder_inited)

    return {
        "version": __version__,
        "parallel_read_safe": True,
        "parallel_write_safe": True,
    }
