import argparse
import json
import sys
import time
from pathlib import Path

from pydantic import ValidationError

from decision_tagger.errors import TaggingError
from decision_tagger.evaluate import format_report, load_gold_items, run_eval
from decision_tagger.models import Config, Item, Taxonomy, load_config, load_item, load_taxonomy
from decision_tagger.questions import dropped_body_chars
from decision_tagger.systemone import SystemOneClient
from decision_tagger.tagging import DecisionClient, score_item, tag


def main(argv: list[str] | None = None, *, client: DecisionClient | None = None) -> int:
    parser = argparse.ArgumentParser(prog="decision-tagger")
    sub = parser.add_subparsers(dest="command", required=True)

    tag_parser = sub.add_parser("tag", help="Tag one item and print JSON assignments")
    _add_common(tag_parser)
    tag_parser.add_argument("item", type=Path)

    eval_parser = sub.add_parser("eval", help="Score gold items and print a report")
    _add_common(eval_parser)
    eval_parser.add_argument("items", type=Path)

    bench_parser = sub.add_parser("bench", help="Measure tagging latency for one item")
    _add_common(bench_parser)
    bench_parser.add_argument("item", type=Path)

    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
        taxonomy = load_taxonomy(args.taxonomy)
        owned = SystemOneClient(config) if client is None else None
        active = client or owned
        try:
            if args.command == "tag":
                print(run_tag(load_item(args.item), taxonomy, config, active))
            elif args.command == "eval":
                report = run_eval(load_gold_items(args.items), taxonomy, config, active)
                print(format_report(report), end="")
            else:
                print(run_bench(load_item(args.item), taxonomy, config, active), end="")
        finally:
            if owned is not None:
                owned.close()
    except (TaggingError, OSError, ValueError, ValidationError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


def run_tag(item: Item, taxonomy: Taxonomy, config: Config, client: DecisionClient) -> str:
    assignments = tag(item, taxonomy, config, client)
    dropped = dropped_body_chars(item, config)
    if dropped:
        print(
            f"warning: body cut to {config.body_char_budget} characters, {dropped} not seen by the model",
            file=sys.stderr,
        )
    return json.dumps([assignment.model_dump() for assignment in assignments], indent=2)


def run_bench(item: Item, taxonomy: Taxonomy, config: Config, client: DecisionClient) -> str:
    started = time.perf_counter()
    scoring = score_item(item, taxonomy, config, client)
    elapsed = time.perf_counter() - started
    questions = len(taxonomy.tags)
    per_question = elapsed / questions if questions else 0.0
    return (
        f"questions: {questions}\n"
        f"requests: {scoring.requests}\n"
        f"input_tokens: {scoring.input_tokens}\n"
        f"body_chars_dropped: {scoring.body_chars_dropped}\n"
        f"elapsed_seconds: {elapsed:.3f}\n"
        f"seconds_per_question: {per_question:.4f}\n"
    )


def _add_common(parser) -> None:
    parser.add_argument("--config", type=Path, default=Path("config.yaml"))
    parser.add_argument("--taxonomy", type=Path, default=Path("data/taxonomy.yaml"))
