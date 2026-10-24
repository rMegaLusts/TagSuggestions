from decision_tagger.models import Config, Item, TagAssignment, Taxonomy
from decision_tagger.tagging import DecisionClient
from decision_tagger.tagging import tag as tag_with_client

__all__ = ["Config", "Item", "TagAssignment", "Taxonomy", "tag"]


def tag(item: Item, taxonomy: Taxonomy, config: Config, client: DecisionClient | None = None) -> list[TagAssignment]:
    if client is not None:
        return tag_with_client(item, taxonomy, config, client)
    from decision_tagger.systemone import SystemOneClient

    owned = SystemOneClient(config)
    try:
        return tag_with_client(item, taxonomy, config, owned)
    finally:
        owned.close()
