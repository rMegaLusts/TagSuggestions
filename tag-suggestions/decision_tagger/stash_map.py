from __future__ import annotations

from decision_tagger.models import Category, Item, Tag, Taxonomy


def scene_to_item(scene: dict) -> Item:
    return Item(
        title=scene.get("title") or "",
        body=scene.get("details") or "",
        metadata={},
    )


def taxonomy_from_stash_tags(stash_tags: list[dict], *, scene_tag_ids: frozenset[str]) -> Taxonomy:
    by_id = {raw["id"]: raw for raw in stash_tags}
    children_by_id = {tag_id: _child_ids(raw) for tag_id, raw in by_id.items()}

    category_ids = [
        tag_id
        for tag_id, raw in by_id.items()
        if not _parent_ids(raw) and _child_ids(raw)
    ]

    tag_to_categories: dict[str, set[str]] = {}
    for category_id in category_ids:
        for descendant_id in _descendants(category_id, children_by_id):
            tag_to_categories.setdefault(descendant_id, set()).add(category_id)

    categories_by_id = {
        category_id: Category(id=category_id, name=by_id[category_id]["name"])
        for category_id in category_ids
    }

    tags: list[Tag] = []
    for tag_id, member_categories in sorted(tag_to_categories.items(), key=lambda item: item[0]):
        if tag_id in scene_tag_ids:
            continue
        raw = by_id[tag_id]
        ordered_categories = sorted(
            member_categories,
            key=lambda category_id: categories_by_id[category_id].name.casefold(),
        )
        tags.append(
            Tag(
                id=tag_id,
                name=raw["name"],
                description=raw.get("description") or "",
                aliases=list(raw.get("aliases") or []),
                categories=ordered_categories,
            )
        )

    used_categories = {category_id for tag in tags for category_id in tag.categories}
    categories = sorted(
        (categories_by_id[category_id] for category_id in used_categories),
        key=lambda category: category.name.casefold(),
    )
    return Taxonomy(categories=categories, tags=tags)


def _parent_ids(raw: dict) -> list[str]:
    return [parent["id"] for parent in raw.get("parents") or [] if parent.get("id")]


def _child_ids(raw: dict) -> list[str]:
    return [child["id"] for child in raw.get("children") or [] if child.get("id")]


def _descendants(root_id: str, children_by_id: dict[str, list[str]]) -> set[str]:
    seen: set[str] = set()
    stack = list(children_by_id.get(root_id, []))
    while stack:
        tag_id = stack.pop()
        if tag_id in seen:
            continue
        seen.add(tag_id)
        stack.extend(children_by_id.get(tag_id, []))
    return seen
