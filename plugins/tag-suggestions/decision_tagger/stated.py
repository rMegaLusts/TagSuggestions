import re

from decision_tagger.models import Item, TagScore, Taxonomy

_TOKEN = re.compile(r"[^\W_]+")
_STATED_SCORE = 1.0
_MIN_SINGLE_TOKEN_LENGTH = 3


def apply_stated_scores(item: Item, taxonomy: Taxonomy, scores: list[TagScore]) -> list[TagScore]:
    stated = _stated_tag_ids(item, taxonomy)
    return [
        score.model_copy(update={"score": _STATED_SCORE}) if score.tag_id in stated else score
        for score in scores
    ]


def _stated_tag_ids(item: Item, taxonomy: Taxonomy) -> set[str]:
    haystack = _tokens(f"{item.title} {item.body}")
    stated: set[str] = set()
    for tag in taxonomy.tags:
        phrases = [_phrase(tag.name), *(_phrase(alias) for alias in tag.aliases)]
        if any(phrase and _contains(haystack, phrase) for phrase in phrases):
            stated.add(tag.id)
    return stated


def _phrase(name: str) -> list[str] | None:
    parts = _tokens(name)
    if not parts:
        return None
    if len(parts) == 1 and len(parts[0]) < _MIN_SINGLE_TOKEN_LENGTH:
        return None
    return parts


def _tokens(text: str) -> list[str]:
    return [match.group(0).casefold() for match in _TOKEN.finditer(text)]


def _contains(haystack: list[str], phrase: list[str]) -> bool:
    width = len(phrase)
    if width > len(haystack):
        return False
    return any(haystack[index : index + width] == phrase for index in range(len(haystack) - width + 1))
