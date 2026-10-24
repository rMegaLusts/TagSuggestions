from __future__ import annotations

import json

import httpx

PLUGIN_ID = "tag-suggestions"

FIND_SCENE = """
query FindScene($id: ID!) {
  findScene(id: $id) {
    id
    title
    details
    tags { id name }
  }
}
"""

FIND_TAGS_PAGE = """
query FindTags($page: Int!, $per_page: Int!) {
  findTags(filter: { page: $page, per_page: $per_page }) {
    count
    tags {
      id
      name
      description
      aliases
      parents { id }
      children { id }
    }
  }
}
"""

BULK_ADD_SCENE_TAGS = """
mutation BulkAddSceneTags($input: BulkSceneUpdateInput!) {
  bulkSceneUpdate(input: $input) {
    id
  }
}
"""

PLUGIN_SETTINGS = """
query PluginSettings($id: ID!) {
  configuration {
    plugins(include: [$id])
  }
}
"""


class StashGraphQL:
    def __init__(self, server_connection: dict, *, http: httpx.Client | None = None):
        scheme = server_connection.get("Scheme") or "http"
        host = server_connection.get("Host") or "localhost"
        port = server_connection.get("Port") or 9999
        self._base_url = f"{scheme}://{host}:{port}"
        cookie = server_connection.get("SessionCookie") or {}
        cookie_value = cookie.get("Value") or ""
        cookie_name = cookie.get("Name") or "session"
        headers = {"Cookie": f"{cookie_name}={cookie_value}"}
        if http is None:
            self._http = httpx.Client(base_url=self._base_url, timeout=120.0, headers=headers)
            self._owns_http = True
        else:
            self._http = http
            self._owns_http = False

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def query(self, document: str, variables: dict | None = None) -> dict:
        response = self._http.post("/graphql", json={"query": document, "variables": variables or {}})
        response.raise_for_status()
        payload = response.json()
        if payload.get("errors"):
            raise RuntimeError(str(payload["errors"][0].get("message", payload["errors"])))
        return payload["data"]

    def fetch_scene(self, scene_id: str) -> dict:
        data = self.query(FIND_SCENE, {"id": scene_id})
        scene = data.get("findScene")
        if scene is None:
            raise ValueError(f"scene not found: {scene_id}")
        return scene

    def fetch_all_tags(self, *, per_page: int = 1000) -> list[dict]:
        page = 1
        tags: list[dict] = []
        total = None
        while total is None or len(tags) < total:
            data = self.query(FIND_TAGS_PAGE, {"page": page, "per_page": per_page})
            result = data["findTags"]
            total = int(result["count"])
            batch = result["tags"]
            if not batch:
                break
            tags.extend(batch)
            page += 1
        return tags

    def add_scene_tags(self, scene_id: str, tag_ids: list[str]) -> None:
        if not tag_ids:
            return
        self.query(
            BULK_ADD_SCENE_TAGS,
            {
                "input": {
                    "ids": [scene_id],
                    "tag_ids": {"ids": list(tag_ids), "mode": "ADD"},
                }
            },
        )

    def load_plugin_settings(self, plugin_id: str = PLUGIN_ID) -> dict:
        data = self.query(PLUGIN_SETTINGS, {"id": plugin_id})
        plugins = data["configuration"]["plugins"]
        if isinstance(plugins, str):
            plugins = json.loads(plugins)
        settings = plugins.get(plugin_id) or {}
        if not isinstance(settings, dict):
            return {}
        return settings
