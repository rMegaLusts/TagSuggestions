import time
from pathlib import Path
from dataclasses import dataclass, field

from pydantic import BaseModel, Field

from decision_tagger.errors import TaggingError
from decision_tagger.models import Config, Item, TagScore, Taxonomy
from decision_tagger.selection import above_threshold, select
from decision_tagger.stated import apply_stated_scores
from decision_tagger.tagging import DecisionClient, score_item


class GoldItem(BaseModel):
    id: str
    title: str
    body: str
    metadata: dict[str, str | int | float | bool | None] = Field(default_factory=dict)
    tag_ids: list[str] = Field(default_factory=list)

    def as_item(self) -> Item:
        return Item(title=self.title, body=self.body, metadata=self.metadata)


@dataclass
class Counts:
    tp: int = 0
    fp: int = 0
    fn: int = 0

    @property
    def precision(self) -> float | None:
        total = self.tp + self.fp
        if total == 0:
            return None
        return self.tp / total

    @property
    def recall(self) -> float | None:
        total = self.tp + self.fn
        if total == 0:
            return None
        return self.tp / total


@dataclass
class Slice:
    micro: Counts = field(default_factory=Counts)
    per_tag: dict[str, Counts] = field(default_factory=dict)
    per_category: dict[str, Counts] = field(default_factory=dict)


@dataclass
class SweepPoint:
    threshold: float
    before: Counts
    after: Counts


@dataclass
class Report:
    before: Slice
    after: Slice
    sweep: list[SweepPoint]
    latencies: list[tuple[str, float]]
    selection_loss: int
    truncated: list[tuple[str, int]] = field(default_factory=list)


def load_gold_items(path: str | Path) -> list[GoldItem]:
    file = Path(path)
    items: list[GoldItem] = []
    for line_number, line in enumerate(file.read_text().splitlines(), start=1):
        if not line.strip():
            continue
        try:
            items.append(GoldItem.model_validate_json(line))
        except ValueError as exc:
            raise ValueError(f"{file}:{line_number} is not a gold item") from exc
    return items


def build_report(
    items: list[GoldItem],
    scores_by_id: dict[str, list[TagScore]],
    taxonomy: Taxonomy,
    config: Config,
    latencies: list[tuple[str, float]] | None = None,
    truncated: list[tuple[str, int]] | None = None,
) -> Report:
    categories = taxonomy.primary_categories()
    before = _slice(items, scores_by_id, taxonomy, config, categories, selected=False)
    after = _slice(items, scores_by_id, taxonomy, config, categories, selected=True)
    loss = 0
    for item in items:
        scores = scores_by_id[item.id]
        gold = set(item.tag_ids)
        passed = _assigned(item, scores, taxonomy, config, selected=False)
        chosen = _assigned(item, scores, taxonomy, config, selected=True)
        loss += len((gold & passed) - chosen)
    sweep = []
    for step in range(1, 10):
        point_config = config.model_copy(update={"threshold": step / 10})
        sweep.append(
            SweepPoint(
                threshold=step / 10,
                before=_slice(items, scores_by_id, taxonomy, point_config, categories, selected=False).micro,
                after=_slice(items, scores_by_id, taxonomy, point_config, categories, selected=True).micro,
            )
        )
    return Report(
        before=before,
        after=after,
        sweep=sweep,
        latencies=list(latencies or []),
        selection_loss=loss,
        truncated=list(truncated or []),
    )


def run_eval(
    items: list[GoldItem],
    taxonomy: Taxonomy,
    config: Config,
    client: DecisionClient,
) -> Report:
    scores_by_id: dict[str, list[TagScore]] = {}
    latencies: list[tuple[str, float]] = []
    truncated: list[tuple[str, int]] = []
    seen: set[str] = set()
    for item in items:
        if item.id in seen:
            raise ValueError(f"duplicate item id: {item.id}")
        seen.add(item.id)
        started = time.perf_counter()
        try:
            scoring = score_item(item.as_item(), taxonomy, config, client)
        except TaggingError as exc:
            raise TaggingError(f"{item.id} failed: {exc}") from exc
        latencies.append((item.id, time.perf_counter() - started))
        scores_by_id[item.id] = scoring.scores
        if scoring.body_chars_dropped:
            truncated.append((item.id, scoring.body_chars_dropped))
    return build_report(items, scores_by_id, taxonomy, config, latencies, truncated)


def format_report(report: Report) -> str:
    lines = [
        "Before selection",
        _format_counts(report.before.micro),
        "",
        "Per tag",
        *_format_table(report.before.per_tag),
        "",
        "Per category",
        *_format_table(report.before.per_category),
        "",
        "After selection",
        _format_counts(report.after.micro),
        f"gold tags above the threshold dropped by selection: {report.selection_loss}",
        "",
        "Per tag",
        *_format_table(report.after.per_tag),
        "",
        "Per category",
        *_format_table(report.after.per_category),
        "",
        "Threshold sweep",
    ]
    for point in report.sweep:
        lines.append(
            f"{point.threshold:.1f}  before {_format_counts(point.before)}  after {_format_counts(point.after)}"
        )
    lines.extend(["", "Latency"])
    if not report.latencies:
        lines.append("mean n/a")
    else:
        for item_id, elapsed in report.latencies:
            lines.append(f"{item_id}  {elapsed:.3f}s")
        mean = sum(elapsed for _, elapsed in report.latencies) / len(report.latencies)
        lines.append(f"mean  {mean:.3f}s")
    lines.extend(["", "Truncated bodies (characters the model never saw)"])
    if not report.truncated:
        lines.append("(none)")
    for item_id, dropped in report.truncated:
        lines.append(f"{item_id}  {dropped}")
    return "\n".join(lines) + "\n"


def _slice(
    items: list[GoldItem],
    scores_by_id: dict[str, list[TagScore]],
    taxonomy: Taxonomy,
    config: Config,
    categories: dict[str, str],
    *,
    selected: bool,
) -> Slice:
    micro = Counts()
    per_tag: dict[str, Counts] = {}
    per_category: dict[str, Counts] = {}
    for item in items:
        gold = set(item.tag_ids)
        assigned = _assigned(item, scores_by_id[item.id], taxonomy, config, selected=selected)
        _add(micro, gold, assigned)
        for tag_id in gold | assigned:
            _add(per_tag.setdefault(tag_id, Counts()), {tag_id} & gold, {tag_id} & assigned)
        involved = set(categories.get(tag_id, "unknown") for tag_id in gold | assigned)
        for category_id in involved:
            gold_in = {tag_id for tag_id in gold if categories.get(tag_id, "unknown") == category_id}
            assigned_in = {tag_id for tag_id in assigned if categories.get(tag_id, "unknown") == category_id}
            _add(per_category.setdefault(category_id, Counts()), gold_in, assigned_in)
    order = [category.id for category in taxonomy.categories]
    if "unknown" in per_category:
        order.append("unknown")
    return Slice(
        micro=micro,
        per_tag=dict(sorted(per_tag.items())),
        per_category={category_id: per_category[category_id] for category_id in order if category_id in per_category},
    )


def _assigned(
    item: GoldItem,
    scores: list[TagScore],
    taxonomy: Taxonomy,
    config: Config,
    *,
    selected: bool,
) -> set[str]:
    adjusted = apply_stated_scores(item.as_item(), taxonomy, scores)
    if selected:
        return {assignment.tag_id for assignment in select(adjusted, config)}
    return {score.tag_id for score in above_threshold(adjusted, config)}


def _add(counts: Counts, gold: set[str], assigned: set[str]) -> None:
    counts.tp += len(gold & assigned)
    counts.fp += len(assigned - gold)
    counts.fn += len(gold - assigned)


def _format_counts(counts: Counts) -> str:
    return (
        f"precision={_format_ratio(counts.precision)} recall={_format_ratio(counts.recall)} "
        f"tp={counts.tp} fp={counts.fp} fn={counts.fn}"
    )


def _format_ratio(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:.3f}"


def _format_table(rows: dict[str, Counts]) -> list[str]:
    if not rows:
        return ["(none)"]
    return [f"{name}  {_format_counts(counts)}" for name, counts in rows.items()]
