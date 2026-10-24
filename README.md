# Tag Suggestions

Stash plugin source for Tag Suggestions. It suggests tags for one scene with a decision model. Nothing is added until you approve it.

## Install in Stash

Settings → Plugins → Available Plugins → Add Source.

- Name: Tag Suggestions
- Source URL: `https://rmegalusts.github.io/TagSuggestions/index.yml`
- Local path: `decision-tagger`

Install Tag Suggestions and reload plugins. Remove a hand-copied `plugins/tag-suggestions` folder first, so only the installed copy loads.

Stash reads `index.yml` from that URL and downloads the zip named there. This repository holds the plugin folder that zip is built from: the manifest, the entry script, the scene-page JavaScript, and `decision_tagger`.

## Requirements

Python 3.12 or newer, which current Stash Docker images include. The first run installs `pydantic`, `httpx`, and `pyyaml` into the plugin folder.

Set the server URL in the plugin settings. The server must accept `POST /v1/systemone`. An API key set there is stored in Stash's config in plain text.
