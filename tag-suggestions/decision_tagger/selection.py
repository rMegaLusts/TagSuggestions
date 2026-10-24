from decision_tagger.models import Config, TagAssignment, TagScore

NEAR_MISS_TAG_LIMIT_MULTIPLIER = 3


def above_threshold(scores: list[TagScore], config: Config) -> list[TagScore]:
    return [score for score in scores if score.score >= config.threshold]


def by_confidence(score: TagScore) -> tuple[float, str]:
    return (-score.score, score.tag_id)


def select(scores: list[TagScore], config: Config) -> list[TagAssignment]:
    seen: set[str] = set()
    for score in scores:
        if score.tag_id in seen:
            raise ValueError(f"duplicate tag score: {score.tag_id}")
        seen.add(score.tag_id)

    by_category: dict[str, list[TagScore]] = {}
    for score in sorted(above_threshold(scores, config), key=by_confidence):
        by_category.setdefault(score.category, []).append(score)
    ranked = sorted(by_category, key=lambda category_id: (-by_category[category_id][0].score, category_id))

    selected: list[TagScore] = []
    per_category: dict[str, int] = {}
    slots_left = config.tag_limit

    for category_id in ranked:
        if slots_left <= 0:
            break
        group = by_category[category_id]
        floor = min(config.category_floor, len(group), config.category_cap, slots_left)
        for score in group[:floor]:
            selected.append(score)
            per_category[category_id] = per_category.get(category_id, 0) + 1
            slots_left -= 1

    selected_ids = {score.tag_id for score in selected}
    remainder = sorted(
        (score for group in by_category.values() for score in group if score.tag_id not in selected_ids),
        key=by_confidence,
    )
    for score in remainder:
        if slots_left <= 0:
            break
        if per_category.get(score.category, 0) >= config.category_cap:
            continue
        selected.append(score)
        per_category[score.category] = per_category.get(score.category, 0) + 1
        slots_left -= 1

    selected.sort(key=by_confidence)
    return [
        TagAssignment(tag_id=score.tag_id, category=score.category, score=score.score) for score in selected
    ]


def near_misses(
    scores: list[TagScore],
    config: Config,
    selected: list[TagAssignment],
) -> list[TagAssignment]:
    selected_ids = {assignment.tag_id for assignment in selected}
    cap = config.tag_limit * NEAR_MISS_TAG_LIMIT_MULTIPLIER
    if cap <= 0:
        return []
    unselected = sorted(
        (
            score
            for score in above_threshold(scores, config)
            if score.tag_id not in selected_ids
        ),
        key=by_confidence,
    )
    return [
        TagAssignment(tag_id=score.tag_id, category=score.category, score=score.score)
        for score in unselected[:cap]
    ]
