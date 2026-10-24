# stash-plugins

Stash plugin source. One source lists every plugin in this repository.

## Install in Stash

Settings → Plugins → Available Plugins → Add Source.

- Name: stash-plugins
- Source URL: `https://rmegalusts.github.io/stash-plugins/index.yml`
- Local path: `stash-plugins`

Stash reads `index.yml` from that URL and downloads the zip named for the plugin you install. Each plugin is a folder under `plugins/`. A push to `master` publishes the index.

## Plugins

### Tag Suggestions

Suggests tags for one scene with a decision model. Nothing is added until you approve it.

Python 3.12 or newer, which current Stash Docker images include. The first run installs `pydantic`, `httpx`, and `pyyaml` into the plugin folder.

Set the server URL in the plugin settings. The server must accept `POST /v1/systemone`. An API key set there is stored in Stash's config in plain text.

Remove a hand-copied `plugins/tag-suggestions` folder before reloading plugins, so only the installed copy loads.
