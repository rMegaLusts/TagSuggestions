from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Protocol

from decision_tagger.errors import TaggingError
from decision_tagger.models import AskResult, Config, Item, TagAssignment, TagScore, Taxonomy
from decision_tagger.questions import dropped_body_chars, item_state, question_batches
from decision_tagger.selection import select
from decision_tagger.stated import apply_stated_scores


class DecisionClient(Protocol):
    def ask(self, state: dict, questions: dict[str, dict]) -> AskResult: ...


@dataclass(frozen=True)
class Scoring:
    scores: list[TagScore]
    requests: int
    input_tokens: int
    body_chars_dropped: int


def score_item(item: Item, taxonomy: Taxonomy, config: Config, client: DecisionClient) -> Scoring:
    state = item_state(item, config)
    batches = question_batches(taxonomy, config)
    if config.concurrency == 1:
        results = [client.ask(state, batch) for batch in batches]
    else:
        results = _ask_concurrently(client, state, batches, config.concurrency)
    merged: dict[str, float] = {}
    tokens = 0
    for result in results:
        overlap = set(merged).intersection(result.scores)
        if overlap:
            raise TaggingError(f"duplicate answer for {sorted(overlap)[0]}")
        merged.update(result.scores)
        tokens += result.input_tokens
    expected = [tag.id for tag in taxonomy.tags]
    missing = [tag_id for tag_id in expected if tag_id not in merged]
    if missing:
        raise TaggingError(f"missing noul answer for {missing[0]}")
    known = set(expected)
    unexpected = [tag_id for tag_id in merged if tag_id not in known]
    if unexpected:
        raise TaggingError(f"unexpected answer for {unexpected[0]}")
    categories = taxonomy.primary_categories()
    scores = [
        TagScore(tag_id=tag_id, category=categories[tag_id], score=merged[tag_id]) for tag_id in expected
    ]
    return Scoring(
        scores=scores,
        requests=len(batches),
        input_tokens=tokens,
        body_chars_dropped=dropped_body_chars(item, config),
    )


def merged_to_scores(merged: dict[str, float], taxonomy: Taxonomy) -> list[TagScore]:
    categories = taxonomy.primary_categories()
    expected = [tag.id for tag in taxonomy.tags]
    missing = [tag_id for tag_id in expected if tag_id not in merged]
    if missing:
        raise TaggingError(f"missing noul answer for {missing[0]}")
    known = set(expected)
    unexpected = [tag_id for tag_id in merged if tag_id not in known]
    if unexpected:
        raise TaggingError(f"unexpected answer for {unexpected[0]}")
    return [
        TagScore(tag_id=tag_id, category=categories[tag_id], score=merged[tag_id]) for tag_id in expected
    ]


def tag(item: Item, taxonomy: Taxonomy, config: Config, client: DecisionClient) -> list[TagAssignment]:
    scores = apply_stated_scores(item, taxonomy, score_item(item, taxonomy, config, client).scores)
    return select(scores, config)


def ask_batch(
    item: Item,
    taxonomy: Taxonomy,
    config: Config,
    client: DecisionClient,
    *,
    batch_index: int,
    partial_scores: dict[str, float],
) -> tuple[dict[str, float], int, int, bool]:
    state = item_state(item, config)
    batches = question_batches(taxonomy, config)
    tags_to_ask = sum(len(batch) for batch in batches)
    if not batches:
        if batch_index != 0:
            raise TaggingError(f"batch index out of range: {batch_index}")
        return partial_scores, 0, 0, True
    if batch_index < 0 or batch_index >= len(batches):
        raise TaggingError(f"batch index out of range: {batch_index}")
    result = client.ask(state, batches[batch_index])
    overlap = set(partial_scores).intersection(result.scores)
    if overlap:
        raise TaggingError(f"duplicate answer for {sorted(overlap)[0]}")
    merged = {**partial_scores, **result.scores}
    tags_judged = len(merged)
    done = batch_index + 1 >= len(batches)
    return merged, tags_judged, tags_to_ask, done


def _ask_concurrently(
    client: DecisionClient,
    state: dict,
    batches: list[dict[str, dict]],
    concurrency: int,
) -> list[AskResult]:
    results: list[AskResult | None] = [None] * len(batches)
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(client.ask, state, batch) for batch in batches]
        try:
            for index, future in enumerate(futures):
                results[index] = future.result()
        except TaggingError:
            _cancel(futures)
            raise
        except Exception as exc:
            _cancel(futures)
            raise TaggingError("item tagging failed") from exc
    return [result for result in results if result is not None]


def _cancel(futures) -> None:
    for future in futures:
        future.cancel()
