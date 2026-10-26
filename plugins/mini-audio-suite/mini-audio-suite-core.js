(function () {
  const PLUGIN_ID = "mini-audio-suite";

  const PluginApi = window.PluginApi;
  const GQL = PluginApi.GQL;
  const Mod = GQL.CriterionModifier;

  const CRITERION = {
    GreaterThan: "GREATER_THAN",
    NotNull: "NOT_NULL",
    IsNull: "IS_NULL",
    Includes: "INCLUDES",
    IncludesAll: "INCLUDES_ALL",
    Excludes: "EXCLUDES",
    Equals: "EQUALS",
    MatchesRegex: "MATCHES_REGEX",
  };

  const store = {
    ready: false,
    version: 0,
    settings: {
      tag_name: "",
      hide_scenes: false,
      separate_performers: false,
      separate_studios: false,
      separate_tags: false,
    },
    tagState: { rootId: null, resolvedName: "", descendantIds: [] },
    ui: { abbreviateCounters: false },
    audioTab: { pathname: "", on: false },
    listeners: new Set(),
  };

  function emit() {
    store.version += 1;
    store.listeners.forEach((listener) => listener());
  }

  function subscribe(listener) {
    store.listeners.add(listener);
    return () => store.listeners.delete(listener);
  }

  function getSnapshot() {
    return store.version;
  }

  function graphqlUrl() {
    const baseURL = document.querySelector("base")?.getAttribute("href") ?? "/";
    return `${baseURL}graphql`;
  }

  async function callGQL(reqData) {
    const response = await fetch(graphqlUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqData),
    });
    const body = await response.json();
    if (body.errors?.length) {
      throw new Error(body.errors[0].message || "GraphQL request failed");
    }
    if (!body.data) {
      throw new Error("GraphQL request returned no data");
    }
    return body.data;
  }

  function criterion(name) {
    const fromEnum = Mod?.[name];
    if (fromEnum) {
      return fromEnum;
    }
    return CRITERION[name];
  }

  function parseBool(value) {
    return value === true || value === "true";
  }

  function parseSettings(plugins) {
    let value = plugins;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch (_err) {
        value = {};
      }
    }
    const raw = value?.[PLUGIN_ID] ?? {};
    return {
      tag_name: typeof raw.tag_name === "string" ? raw.tag_name : "",
      hide_scenes: parseBool(raw.hide_scenes),
      separate_performers: parseBool(raw.separate_performers ?? raw.hide_performers),
      separate_studios: parseBool(raw.separate_studios ?? raw.hide_studios),
      separate_tags: parseBool(raw.separate_tags ?? raw.hide_tags),
    };
  }

  function parseUi(ui) {
    let value = ui;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch (_err) {
        value = {};
      }
    }
    if (!value || typeof value !== "object") {
      value = {};
    }
    return {
      abbreviateCounters: parseBool(value.abbreviateCounters),
    };
  }

  function configuredTagName() {
    const trimmed = (store.settings.tag_name || "").trim();
    return trimmed || "Audio";
  }

  async function findTags(tagFilter) {
    const data = await callGQL({
      query: `query FindMasTag($filter: FindFilterType!, $tag_filter: TagFilterType!) {
        findTags(filter: $filter, tag_filter: $tag_filter) { tags { id name } }
      }`,
      variables: {
        filter: { per_page: 20 },
        tag_filter: tagFilter,
      },
    });
    return data.findTags?.tags ?? [];
  }

  async function findAllTagIds(tagFilter) {
    const ids = [];
    let page = 1;
    let count = Infinity;
    while (ids.length < count) {
      const data = await callGQL({
        query: `query FindMasTagIds($filter: FindFilterType!, $tag_filter: TagFilterType!) {
          findTags(filter: $filter, tag_filter: $tag_filter) { count tags { id } }
        }`,
        variables: {
          filter: { per_page: 500, page },
          tag_filter: tagFilter,
        },
      });
      const tags = data.findTags?.tags ?? [];
      count = data.findTags?.count ?? tags.length;
      for (const tag of tags) {
        if (tag?.id != null) {
          ids.push(tag.id);
        }
      }
      if (tags.length === 0 || page > 100) {
        break;
      }
      page += 1;
    }
    return ids;
  }

  function pickTag(tags, name) {
    const folded = name.toLowerCase();
    return (tags ?? []).find((tag) => tag.name && tag.name.toLowerCase() === folded) ?? null;
  }

  async function resolveAudioTag() {
    const name = configuredTagName();
    const pattern = `(?i)^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
    let tags = [];
    try {
      tags = await findTags({
        name: { value: pattern, modifier: criterion("MatchesRegex") },
      });
    } catch (err) {
      console.error("[mini-audio-suite]", err);
    }
    let match = pickTag(tags, name);
    if (!match) {
      try {
        tags = await findTags({
          name: { value: name, modifier: criterion("Equals") },
        });
      } catch (err) {
        console.error("[mini-audio-suite]", err);
      }
      match = pickTag(tags, name);
    }
    let descendantIds = [];
    if (match) {
      try {
        descendantIds = await findAllTagIds({
          parents: {
            value: [match.id],
            modifier: criterion("Includes"),
            depth: -1,
          },
        });
      } catch (err) {
        console.error("[mini-audio-suite]", err);
      }
    }
    store.tagState = match
      ? { rootId: match.id, resolvedName: match.name, descendantIds }
      : { rootId: null, resolvedName: name, descendantIds: [] };
    return store.tagState;
  }

  async function refreshConfiguration() {
    try {
      const data = await callGQL({
        query: `query { configuration { plugins ui } }`,
      });
      store.settings = parseSettings(data.configuration.plugins);
      store.ui = parseUi(data.configuration.ui);
      await resolveAudioTag();
    } catch (err) {
      console.error("[mini-audio-suite]", err);
    } finally {
      store.ready = true;
      emit();
    }
  }

  function present(filter) {
    return !!filter && Object.keys(filter).length > 0;
  }

  function hasOperator(filter) {
    return !!(filter && (filter.AND || filter.OR || filter.NOT));
  }

  // Stash allows one of AND / OR / NOT on a filter object. Criteria on that
  // object are ANDed with the single sub-filter.
  // Stash ANDs the free-text q clause onto the scene filter without
  // wrapping that filter. A top-level OR then outranks q, so a search
  // still returns every no-video scene. Nesting that OR under AND keeps
  // the parentheses.
  function groupOr(filter) {
    if (filter && filter.OR && !filter.AND && !filter.NOT) {
      return { AND: filter };
    }
    return filter;
  }

  function andFilters(base, extra) {
    if (!present(base)) {
      return groupOr(extra);
    }
    if (!present(extra)) {
      return base;
    }
    if (!hasOperator(base)) {
      return { ...base, AND: extra };
    }
    if (!hasOperator(extra)) {
      return { ...extra, AND: base };
    }
    if (base.AND && !base.OR && !base.NOT) {
      const { AND, ...criteria } = base;
      return { ...criteria, AND: andFilters(AND, extra) };
    }
    console.error("[mini-audio-suite] cannot AND two operator filters");
    return base;
  }

  function noVideoFilter() {
    return {
      file_count: { value: 0, modifier: criterion("GreaterThan") },
      NOT: {
        video_codec: { value: "", modifier: criterion("NotNull") },
      },
    };
  }

  function membershipFilter() {
    const noVideo = noVideoFilter();
    if (!store.tagState.rootId) {
      return noVideo;
    }
    return {
      tags: {
        value: [store.tagState.rootId],
        modifier: criterion("Includes"),
        depth: -1,
      },
      OR: noVideo,
    };
  }

  // Stash joins a tags value as scene_tag and that criterion's excludes as
  // scene_tag2, then discards a later join with the same alias. Two tags
  // criteria in one scene filter both test the first join, so a tag filter
  // stops matching the tags the user chose. The audio tag test has to use
  // whichever of those two aliases is still free.
  function collectTags(filter, found) {
    const tags = found ?? [];
    if (!filter || typeof filter !== "object") {
      return tags;
    }
    if (filter.tags) {
      tags.push(filter.tags);
    }
    collectTags(filter.AND, tags);
    collectTags(filter.OR, tags);
    collectTags(filter.NOT, tags);
    return tags;
  }

  function modifierIs(tags, name) {
    return tags?.modifier === criterion(name);
  }

  function usesExcludeSlot(tags) {
    if (modifierIs(tags, "Excludes")) {
      return true;
    }
    return Array.isArray(tags?.excludes) && tags.excludes.length > 0;
  }

  function usesValueSlot(tags) {
    if (modifierIs(tags, "IsNull") || modifierIs(tags, "NotNull")) {
      return true;
    }
    if (modifierIs(tags, "Excludes")) {
      return false;
    }
    return Array.isArray(tags?.value) && tags.value.length > 0;
  }

  function appendIds(list, ids) {
    const next = Array.isArray(list) ? list.slice() : [];
    const seen = new Set(next.map((id) => String(id)));
    for (const id of ids) {
      const key = String(id);
      if (!seen.has(key)) {
        seen.add(key);
        next.push(id);
      }
    }
    return next;
  }

  function audioTreeIds(depth) {
    const rootId = store.tagState.rootId;
    if (!rootId) {
      return [];
    }
    if (depth === -1) {
      return [rootId];
    }
    return appendIds([rootId], store.tagState.descendantIds ?? []);
  }

  function audioExcludesCriterion() {
    return {
      value: [store.tagState.rootId],
      modifier: criterion("Excludes"),
      depth: -1,
    };
  }

  function notNoVideo() {
    return { NOT: noVideoFilter() };
  }

  // NOT (lacks the audio tag AND NOT no-video) = audio tag OR no video.
  // The lacks-audio test is an excludes join, so it does not reuse scene_tag.
  function hasAudioOrNoVideoViaExcludeSlot() {
    return {
      NOT: {
        tags: audioExcludesCriterion(),
        AND: notNoVideo(),
      },
    };
  }

  function excludeAudioTagsAndNoVideo() {
    return {
      tags: audioExcludesCriterion(),
      AND: notNoVideo(),
    };
  }

  function mergeAudioExcludes(tagsList) {
    for (const tags of tagsList) {
      if (!usesExcludeSlot(tags)) {
        continue;
      }
      const depth = typeof tags.depth === "number" ? tags.depth : 0;
      const ids = audioTreeIds(depth);
      if (modifierIs(tags, "Excludes")) {
        tags.value = appendIds(tags.value, ids);
      } else {
        tags.excludes = appendIds(tags.excludes, ids);
      }
    }
  }

  function withMembership(base, mode) {
    if (!store.tagState.rootId) {
      return andFilters(base, mode === "include" ? noVideoFilter() : notNoVideo());
    }
    const tags = collectTags(base);
    if (tags.length === 0) {
      const extra = mode === "include" ? membershipFilter() : { NOT: membershipFilter() };
      return andFilters(base, extra);
    }
    const excludeTaken = tags.some(usesExcludeSlot);
    const valueTaken = tags.some(usesValueSlot);
    if (mode === "exclude") {
      if (!excludeTaken) {
        return andFilters(base, excludeAudioTagsAndNoVideo());
      }
      mergeAudioExcludes(tags);
      return andFilters(base, notNoVideo());
    }
    if (!excludeTaken) {
      return andFilters(base, hasAudioOrNoVideoViaExcludeSlot());
    }
    if (!valueTaken) {
      return andFilters(base, membershipFilter());
    }
    console.error(
      "[mini-audio-suite] tag filter already uses both tag joins; audio tag membership was not applied"
    );
    return base;
  }

  function patchMakeFilter(filter, transform) {
    const original = filter.makeFilter.bind(filter);
    filter.makeFilter = function masMakeFilter() {
      return transform(original());
    };
    return filter;
  }

  function includeMembership(filter) {
    return patchMakeFilter(filter, (base) => withMembership(base, "include"));
  }

  function excludeMembership(filter) {
    return patchMakeFilter(filter, (base) => withMembership(base, "exclude"));
  }

  async function countMembership(extra) {
    const data = await callGQL({
      query: `query MasAudioCount($scene_filter: SceneFilterType!) {
        findScenes(filter: { per_page: 1 }, scene_filter: $scene_filter) { count }
      }`,
      variables: { scene_filter: withMembership(extra, "include") },
    });
    return data.findScenes?.count ?? 0;
  }

  function sceneLacksRealVideo(scene) {
    const files = scene?.files ?? [];
    if (files.length === 0) {
      return false;
    }
    return files.every((file) => !file.video_codec);
  }

  function keepHlsWhenNoRealVideo(scene) {
    if (!sceneLacksRealVideo(scene)) {
      return scene;
    }
    const streams = scene.sceneStreams ?? [];
    const hls = streams.filter((stream) => (stream.label ?? "").startsWith("HLS"));
    if (hls.length === 0) {
      return scene;
    }
    return { ...scene, sceneStreams: hls };
  }

  PluginApi.patch.instead("ScenePlayer", (props, _ctx, original) => {
    const scene = keepHlsWhenNoRealVideo(props.scene);
    return original({ ...props, scene });
  });

  PluginApi.Event.addEventListener("stash:location", () => {
    refreshConfiguration();
  });

  refreshConfiguration();

  window.__miniAudioSuite = {
    AUDIO_ROUTE: "/plugins/mini-audio-suite/audio",
    View: {
      Scenes: "scenes",
      PerformerScenes: "performer_scenes",
      StudioScenes: "studio_scenes",
      TagScenes: "tag_scenes",
    },
    DisplayModeTagger: 3,
    store,
    subscribe,
    getSnapshot,
    criterion,
    includeMembership,
    excludeMembership,
    countMembership,
    emit,
  };
})();
