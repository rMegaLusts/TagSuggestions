from decision_tagger.models import Config, Item, Tag, Taxonomy


def item_state(item: Item, config: Config) -> dict:
    return {
        "title": item.title,
        "body": item.body[: config.body_char_budget],
        "metadata": dict(item.metadata),
    }


def dropped_body_chars(item: Item, config: Config) -> int:
    return max(0, len(item.body) - config.body_char_budget)


def noul_question(tag: Tag, category_name: str, config: Config) -> dict:
    instructions = config.question_template.replace("{category}", category_name).replace("{tag}", tag.name)
    if tag.aliases:
        instructions = f"{instructions} Also known as: {', '.join(tag.aliases)}."
    true = "The item states or clearly depicts this."
    if config.include_descriptions and tag.description:
        true = f"{true} This tag means: {tag.description}"
    criteria: dict[str, str] = {"true": true}
    if config.false_criteria:
        criteria["false"] = config.false_criteria
    return {"type": "noul", "instructions": instructions, "criteria": criteria}


def question_batches(taxonomy: Taxonomy, config: Config) -> list[dict[str, dict]]:
    batches: list[dict[str, dict]] = []
    limit = config.max_questions_per_request
    for category, tags in taxonomy.tags_by_primary():
        chunk: dict[str, dict] = {}
        for tag in tags:
            chunk[tag.id] = noul_question(tag, category.name, config)
            if len(chunk) == limit:
                batches.append(chunk)
                chunk = {}
        if chunk:
            batches.append(chunk)
    return batches
