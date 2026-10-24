from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml
from pydantic import BaseModel, Field, field_validator, model_validator


class Item(BaseModel):
    title: str
    body: str
    metadata: dict[str, str | int | float | bool | None] = Field(default_factory=dict)


class Category(BaseModel):
    id: str
    name: str

    @field_validator("id", "name")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value


class Tag(BaseModel):
    id: str
    name: str
    description: str = ""
    aliases: list[str] = Field(default_factory=list)
    categories: list[str]

    @field_validator("id", "name")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value

    @field_validator("categories")
    @classmethod
    def categories_are_unique(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("a tag must list a category")
        if len(set(value)) != len(value):
            raise ValueError("a tag lists the same category more than once")
        return value

    @property
    def primary_category(self) -> str:
        return self.categories[0]


class Taxonomy(BaseModel):
    categories: list[Category]
    tags: list[Tag]

    def category(self, category_id: str) -> Category:
        for category in self.categories:
            if category.id == category_id:
                return category
        raise KeyError(category_id)

    def primary_categories(self) -> dict[str, str]:
        return {tag.id: tag.primary_category for tag in self.tags}

    def tags_by_primary(self) -> list[tuple[Category, list[Tag]]]:
        grouped: dict[str, list[Tag]] = {category.id: [] for category in self.categories}
        for tag in self.tags:
            grouped[tag.primary_category].append(tag)
        return [(category, grouped[category.id]) for category in self.categories]


class TagScore(BaseModel):
    tag_id: str
    category: str
    score: float


class TagAssignment(BaseModel):
    tag_id: str
    category: str
    score: float


class Config(BaseModel):
    server_url: str = "http://127.0.0.1:8080"
    model: str | None = None
    api_key_env: str | None = "SYSTEMONE_API_KEY"
    question_template: str = "Regarding {category}: does this item state or depict {tag}?"
    false_criteria: str | None = "The item does not state this and does not clearly depict it."
    include_descriptions: bool = False
    body_char_budget: int = 1000
    max_questions_per_request: int = 64
    concurrency: int = 4
    threshold: float = 0.5
    tag_limit: int = 12
    category_floor: int = 0
    category_cap: int = 4
    max_retries: int = 3
    retry_backoff_seconds: float = 0.5
    timeout_seconds: float = 120.0

    @model_validator(mode="after")
    def check_bounds(self) -> Config:
        if self.body_char_budget < 0:
            raise ValueError("body_char_budget must be >= 0")
        if self.max_questions_per_request < 1:
            raise ValueError("max_questions_per_request must be >= 1")
        if self.concurrency < 1:
            raise ValueError("concurrency must be >= 1")
        if not 0.0 <= self.threshold <= 1.0:
            raise ValueError("threshold must be between 0 and 1")
        if self.tag_limit < 0:
            raise ValueError("tag_limit must be >= 0")
        if self.category_floor < 0:
            raise ValueError("category_floor must be >= 0")
        if self.category_cap < 1:
            raise ValueError("category_cap must be >= 1")
        if self.category_floor > self.category_cap:
            raise ValueError("category_floor cannot exceed category_cap")
        if self.max_retries < 0:
            raise ValueError("max_retries must be >= 0")
        if self.retry_backoff_seconds < 0:
            raise ValueError("retry_backoff_seconds must be >= 0")
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be > 0")
        if "{category}" not in self.question_template or "{tag}" not in self.question_template:
            raise ValueError("question_template must include {category} and {tag}")
        return self


@dataclass(frozen=True)
class AskResult:
    scores: dict[str, float]
    input_tokens: int = 0


def taxonomy_from_dict(data: dict) -> Taxonomy:
    categories: list[Category] = []
    seen_categories: set[str] = set()
    tags_by_id: dict[str, Tag] = {}
    order: list[str] = []
    for raw_category in data.get("categories", []):
        category = Category.model_validate(
            {"id": raw_category["id"], "name": raw_category["name"]}
        )
        if category.id in seen_categories:
            raise ValueError(f"duplicate category: {category.id}")
        seen_categories.add(category.id)
        categories.append(category)
        for raw_tag in raw_category.get("tags", []):
            extras = [category_id for category_id in raw_tag.get("also_in") or [] if category_id != category.id]
            if raw_tag["id"] in tags_by_id:
                existing = tags_by_id[raw_tag["id"]]
                for extra in [category.id, *extras]:
                    if extra not in existing.categories:
                        existing.categories.append(extra)
                continue
            tag = Tag(
                id=raw_tag["id"],
                name=raw_tag["name"],
                description=raw_tag.get("description") or "",
                aliases=list(raw_tag.get("aliases") or []),
                categories=[category.id, *extras],
            )
            tags_by_id[tag.id] = tag
            order.append(tag.id)
    taxonomy = Taxonomy(categories=categories, tags=[tags_by_id[tag_id] for tag_id in order])
    known = {category.id for category in taxonomy.categories}
    for tag in taxonomy.tags:
        unknown = [category_id for category_id in tag.categories if category_id not in known]
        if unknown:
            raise ValueError(f"{tag.id} lists unknown category {unknown[0]}")
    return taxonomy


def load_taxonomy(path: str | Path) -> Taxonomy:
    file = Path(path)
    loaded = yaml.safe_load(file.read_text())
    if not isinstance(loaded, dict):
        raise ValueError(f"{file} does not contain a taxonomy")
    return taxonomy_from_dict(loaded)


def load_config(path: str | Path) -> Config:
    file = Path(path)
    loaded = yaml.safe_load(file.read_text()) or {}
    if not isinstance(loaded, dict):
        raise ValueError(f"{file} does not contain a config")
    return Config.model_validate(loaded)


def load_item(path: str | Path) -> Item:
    return Item.model_validate_json(Path(path).read_text())
