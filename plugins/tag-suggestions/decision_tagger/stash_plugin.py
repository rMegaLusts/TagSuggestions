from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from decision_tagger.models import Config, Item, TagAssignment, Taxonomy
from decision_tagger.questions import dropped_body_chars, item_state
from decision_tagger.stash_graphql import PLUGIN_ID, StashGraphQL
from decision_tagger.stash_map import scene_to_item, taxonomy_from_stash_tags
from decision_tagger.systemone import SystemOneClient
from decision_tagger.tagging import (
    DecisionClient,
    ask_batch,
    merged_to_scores,
    score_item,
)
from decision_tagger.selection import near_misses, select
from decision_tagger.stated import apply_stated_scores

DECISION_LOG_DIR = "tag-suggestions"
DECISION_LOG_FILE = "decisions.jsonl"
SNAPSHOT_RUNS_DIR = "runs"


_FLOAT_SETTINGS = {"threshold", "retry_backoff_seconds"}


def config_from_plugin_settings(settings: dict) -> tuple[Config, str | None]:
    api_key = _optional_str(settings.get("api_key"))
    data: dict[str, Any] = {}
    for field_name in Config.model_fields:
        if field_name not in settings:
            continue
        value = settings[field_name]
        if field_name in {"model", "false_criteria", "api_key_env", "question_template", "server_url"}:
            coerced = _optional_str(value)
            if coerced is not None:
                data[field_name] = coerced
            continue
        if field_name in _FLOAT_SETTINGS:
            parsed = _optional_float(field_name, value)
            if parsed is not None:
                data[field_name] = parsed
            continue
        if value is None or (isinstance(value, str) and value.strip() == ""):
            continue
        if field_name == "tag_limit" and value == 0:
            continue
        data[field_name] = value
    return Config.model_validate(data), api_key


def _optional_float(field_name: str, value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return float(text)
        except ValueError as exc:
            raise ValueError(f"{field_name} must be a number") from exc
    return float(value)


def settings_for_log(settings: dict) -> dict:
    redacted = dict(settings)
    redacted.pop("api_key", None)
    return redacted


def decision_log_path(config_dir: str | Path) -> Path:
    return Path(config_dir) / DECISION_LOG_DIR / DECISION_LOG_FILE


def _snapshot_id_token(snapshot_id: str) -> str:
    token = snapshot_id.strip()
    if not token:
        raise ValueError("snapshot_id is required")
    try:
        uuid.UUID(token)
    except ValueError as exc:
        raise ValueError("snapshot_id must be a UUID") from exc
    return token


def snapshot_path(config_dir: str | Path, snapshot_id: str) -> Path:
    token = _snapshot_id_token(snapshot_id)
    return Path(config_dir) / DECISION_LOG_DIR / SNAPSHOT_RUNS_DIR / f"{token}.json"


def discard_snapshot(config_dir: str | Path, snapshot_id: str) -> None:
    try:
        snapshot_path(config_dir, snapshot_id).unlink(missing_ok=True)
    except OSError:
        pass


def write_snapshot(config_dir: str | Path, snapshot_id: str, record: dict) -> None:
    path = snapshot_path(config_dir, snapshot_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")


def load_snapshot(config_dir: str | Path, snapshot_id: str) -> dict:
    path = snapshot_path(config_dir, snapshot_id)
    if not path.is_file():
        raise ValueError(f"snapshot not found: {snapshot_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def append_decision_log(
    config_dir: str | Path,
    *,
    scene_id: str,
    title: str,
    description: str,
    model: str | None,
    settings: dict,
    entries: list[dict],
    batch_id: str | None = None,
) -> None:
    path = decision_log_path(config_dir)
    if batch_id and batch_already_logged(path, batch_id):
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    safe_settings = settings_for_log(settings)
    lines: list[str] = []
    for entry in entries:
        record = {
            "scene_id": scene_id,
            "title": title,
            "description": description,
            "tag_id": entry["tag_id"],
            "score": entry["score"],
            "approved": entry["approved"],
            "role": entry.get("role", "suggested"),
            "model": model,
            "settings": safe_settings,
        }
        if batch_id:
            record["batch_id"] = batch_id
        lines.append(json.dumps(record, ensure_ascii=False))
    if not lines:
        return
    with path.open("a", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def batch_already_logged(path: Path, batch_id: str) -> bool:
    if not path.exists():
        return False
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            text = line.strip()
            if not text:
                continue
            try:
                record = json.loads(text)
            except json.JSONDecodeError:
                continue
            if record.get("batch_id") == batch_id:
                return True
    return False


def apply_decisions(
    config_dir: str | Path,
    *,
    stash: StashGraphQL,
    scene_id: str,
    title: str,
    description: str,
    model: str | None,
    settings: dict,
    entries: list[dict],
    batch_id: str,
) -> dict:
    token = batch_id.strip()
    if not token:
        raise ValueError("batch_id is required")
    approved = [str(entry["tag_id"]) for entry in entries if entry.get("approved")]
    if approved:
        stash.add_scene_tags(scene_id, approved)
    if batch_already_logged(decision_log_path(config_dir), token):
        return {"applied": True, "logged": True}
    try:
        append_decision_log(
            config_dir,
            scene_id=scene_id,
            title=title,
            description=description,
            model=model,
            settings=settings,
            entries=entries,
            batch_id=token,
        )
    except Exception as exc:
        return {"applied": True, "logged": False, "error": str(exc)}
    return {"applied": True, "logged": True}


def enrich_assignments(
    assignments: list[TagAssignment],
    taxonomy: Taxonomy,
    tag_names: dict[str, str],
) -> list[dict]:
    category_names = {category.id: category.name for category in taxonomy.categories}
    enriched: list[dict] = []
    for assignment in assignments:
        enriched.append(
            {
                "tag_id": assignment.tag_id,
                "tag_name": tag_names.get(assignment.tag_id, assignment.tag_id),
                "category_id": assignment.category,
                "category_name": category_names.get(assignment.category, assignment.category),
                "score": assignment.score,
            }
        )
    return enriched


def load_scene_taxonomy(
    scene_id: str,
    *,
    stash: StashGraphQL,
    settings: dict | None = None,
) -> tuple[dict, Taxonomy, Item, Config, str | None, dict[str, str], dict]:
    resolved_settings = settings if settings is not None else stash.load_plugin_settings()
    config, api_key = config_from_plugin_settings(resolved_settings)
    scene = stash.fetch_scene(scene_id)
    stash_tags = stash.fetch_all_tags()
    scene_tag_ids = frozenset(tag["id"] for tag in scene.get("tags") or [])
    taxonomy = taxonomy_from_stash_tags(stash_tags, scene_tag_ids=scene_tag_ids)
    item = scene_to_item(scene)
    tag_names = {raw["id"]: raw["name"] for raw in stash_tags}
    return scene, taxonomy, item, config, api_key, tag_names, resolved_settings


def asked_item_fields(item: Item, config: Config) -> dict:
    return {
        "title": item.title,
        "body": item.body,
        "asked_body": item_state(item, config)["body"],
        "body_chars_dropped": dropped_body_chars(item, config),
    }


def dialog_payload(
    *,
    scene_id: str,
    item: Item,
    config: Config,
    settings: dict,
    tags_to_ask: int,
    snapshot_id: str | None = None,
) -> dict:
    payload = {
        "scene_id": scene_id,
        **asked_item_fields(item, config),
        "model": config.model,
        "settings": settings_for_log(settings),
        "tags_to_ask": tags_to_ask,
    }
    if snapshot_id is not None:
        payload["snapshot_id"] = snapshot_id
    return payload


def snapshot_record(
    scene: dict,
    *,
    item: Item,
    taxonomy: Taxonomy,
    config: Config,
    tag_names: dict[str, str],
    settings: dict,
) -> dict:
    return {
        "scene_id": scene["id"],
        **asked_item_fields(item, config),
        "item": item.model_dump(),
        "taxonomy": taxonomy.model_dump(),
        "tag_names": tag_names,
        "config": config.model_dump(),
        "model": config.model,
        "settings": settings_for_log(settings),
    }


def prepare_dialog(
    scene_id: str,
    *,
    stash: StashGraphQL,
    config_dir: str | Path,
    settings: dict | None = None,
) -> dict:
    scene, taxonomy, item, config, _api_key, tag_names, resolved_settings = load_scene_taxonomy(
        scene_id, stash=stash, settings=settings
    )
    snapshot_id = str(uuid.uuid4())
    write_snapshot(
        config_dir,
        snapshot_id,
        snapshot_record(
            scene,
            item=item,
            taxonomy=taxonomy,
            config=config,
            tag_names=tag_names,
            settings=resolved_settings,
        ),
    )
    return dialog_payload(
        scene_id=scene["id"],
        item=item,
        config=config,
        settings=resolved_settings,
        tags_to_ask=len(taxonomy.tags),
        snapshot_id=snapshot_id,
    )


def suggest_batch_for_scene(
    snapshot_id: str,
    *,
    config_dir: str | Path,
    stash: StashGraphQL,
    batch_index: int,
    partial_scores: dict[str, float],
    client: DecisionClient | None = None,
) -> dict:
    record = load_snapshot(config_dir, snapshot_id)
    item = Item.model_validate(record["item"])
    taxonomy = Taxonomy.model_validate(record["taxonomy"])
    config = Config.model_validate(record["config"])
    tag_names = {str(key): str(value) for key, value in (record.get("tag_names") or {}).items()}
    api_key = config_from_plugin_settings(stash.load_plugin_settings())[1]
    owned: SystemOneClient | None = None
    active = client
    if active is None:
        owned = SystemOneClient(config, api_key=api_key)
        active = owned
    try:
        merged, tags_judged, tags_to_ask, done = ask_batch(
            item,
            taxonomy,
            config,
            active,
            batch_index=batch_index,
            partial_scores=partial_scores,
        )
    finally:
        if owned is not None:
            owned.close()
    base = dialog_payload(
        scene_id=str(record["scene_id"]),
        item=item,
        config=config,
        settings=record.get("settings") or {},
        tags_to_ask=tags_to_ask,
        snapshot_id=snapshot_id,
    )
    if not done:
        return {
            **base,
            "done": False,
            "batch_index": batch_index + 1,
            "scores": merged,
            "tags_judged": tags_judged,
        }
    scores = apply_stated_scores(item, taxonomy, merged_to_scores(merged, taxonomy))
    assignments = select(scores, config)
    misses = near_misses(scores, config, assignments)
    return {
        **base,
        "done": True,
        "tags_judged": tags_judged,
        "suggestions": enrich_assignments(assignments, taxonomy, tag_names),
        "near_misses": enrich_assignments(misses, taxonomy, tag_names),
    }


def suggest_for_scene(
    scene_id: str,
    *,
    stash: StashGraphQL,
    settings: dict | None = None,
    client: DecisionClient | None = None,
) -> dict:
    scene, taxonomy, item, config, api_key, tag_names, resolved_settings = load_scene_taxonomy(
        scene_id, stash=stash, settings=settings
    )
    owned: SystemOneClient | None = None
    active = client
    if active is None:
        owned = SystemOneClient(config, api_key=api_key)
        active = owned
    try:
        scores = apply_stated_scores(item, taxonomy, score_item(item, taxonomy, config, active).scores)
        assignments = select(scores, config)
        misses = near_misses(scores, config, assignments)
    finally:
        if owned is not None:
            owned.close()
    return {
        **dialog_payload(
            scene_id=scene["id"],
            item=item,
            config=config,
            settings=resolved_settings,
            tags_to_ask=len(taxonomy.tags),
        ),
        "suggestions": enrich_assignments(assignments, taxonomy, tag_names),
        "near_misses": enrich_assignments(misses, taxonomy, tag_names),
    }


def run_operation(
    plugin_input: dict,
    *,
    client: DecisionClient | None = None,
    stash: StashGraphQL | None = None,
) -> dict:
    args = plugin_input.get("args") or {}
    mode = args.get("mode") or "suggest"
    connection = plugin_input.get("server_connection") or {}
    config_dir = connection.get("Dir") or ""
    owned_stash: StashGraphQL | None = None
    active_stash = stash
    if active_stash is None:
        owned_stash = StashGraphQL(connection)
        active_stash = owned_stash
    try:
        if mode == "log_decisions":
            append_decision_log(
                config_dir,
                scene_id=str(args["scene_id"]),
                title=args.get("title") or "",
                description=args.get("description") or "",
                model=args.get("model"),
                settings=args.get("settings") or {},
                entries=list(args.get("entries") or []),
                batch_id=_optional_str(args.get("batch_id")),
            )
            return {"logged": len(args.get("entries") or [])}
        if mode == "apply":
            scene_id = args.get("scene_id")
            if not scene_id:
                raise ValueError("scene_id is required")
            batch_id = _optional_str(args.get("batch_id"))
            if batch_id is None:
                raise ValueError("batch_id is required")
            return apply_decisions(
                config_dir,
                stash=active_stash,
                scene_id=str(scene_id),
                title=args.get("title") or "",
                description=args.get("description") or "",
                model=args.get("model"),
                settings=args.get("settings") or {},
                entries=list(args.get("entries") or []),
                batch_id=batch_id,
            )
        if mode == "prepare":
            scene_id = args.get("scene_id")
            if not scene_id:
                raise ValueError("scene_id is required")
            settings = active_stash.load_plugin_settings()
            return prepare_dialog(
                str(scene_id),
                stash=active_stash,
                settings=settings,
                config_dir=config_dir,
            )
        if mode == "discard_snapshot":
            snapshot_id = _optional_str(args.get("snapshot_id"))
            if snapshot_id is None:
                raise ValueError("snapshot_id is required")
            discard_snapshot(config_dir, snapshot_id)
            return {"discarded": True}
        if mode == "suggest_batch":
            snapshot_id = _optional_str(args.get("snapshot_id"))
            if snapshot_id is None:
                raise ValueError("snapshot_id is required")
            batch_index = args.get("batch_index")
            if batch_index is None:
                raise ValueError("batch_index is required")
            scores = args.get("scores") or {}
            if not isinstance(scores, dict):
                raise ValueError("scores must be a map")
            return suggest_batch_for_scene(
                snapshot_id,
                config_dir=config_dir,
                stash=active_stash,
                batch_index=int(batch_index),
                partial_scores={str(key): float(value) for key, value in scores.items()},
                client=client,
            )
        if mode == "suggest":
            scene_id = args.get("scene_id")
            if not scene_id:
                raise ValueError("scene_id is required")
            settings = active_stash.load_plugin_settings()
            return suggest_for_scene(
                str(scene_id),
                stash=active_stash,
                settings=settings,
                client=client,
            )
        raise ValueError(f"unknown mode: {mode}")
    finally:
        if owned_stash is not None:
            owned_stash.close()


def plugin_main() -> None:
    import sys

    try:
        plugin_input = json.load(sys.stdin)
        output = run_operation(plugin_input)
        print(json.dumps({"output": output, "error": None}))
    except Exception as exc:
        print(json.dumps({"output": None, "error": str(exc)}))


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text if text else None
