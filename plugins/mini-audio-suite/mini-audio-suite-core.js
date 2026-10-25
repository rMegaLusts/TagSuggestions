(function () {
  const PLUGIN_ID = "mini-audio-suite";

  const PluginApi = window.PluginApi;
  const GQL = PluginApi.GQL;
  const Mod = GQL.CriterionModifier;

  const CRITERION = {
    GreaterThan: "GREATER_THAN",
    NotNull: "NOT_NULL",
    Includes: "INCLUDES",
    IncludesAll: "INCLUDES_ALL",
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
    tagState: { rootId: null, resolvedName: "" },
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
    store.tagState = match
      ? { rootId: match.id, resolvedName: match.name }
      : { rootId: null, resolvedName: name };
    return store.tagState;
  }

  async function refreshConfiguration() {
    try {
      const data = await callGQL({
        query: `query { configuration { plugins } }`,
      });
      store.settings = parseSettings(data.configuration.plugins);
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
  function andFilters(base, extra) {
    if (!present(base)) {
      return extra;
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

  function patchMakeFilter(filter, transform) {
    const original = filter.makeFilter.bind(filter);
    filter.makeFilter = function masMakeFilter() {
      return transform(original());
    };
    return filter;
  }

  function includeMembership(filter) {
    return patchMakeFilter(filter, (base) => andFilters(base, membershipFilter()));
  }

  function excludeMembership(filter) {
    return patchMakeFilter(filter, (base) => andFilters(base, { NOT: membershipFilter() }));
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
    includeMembership,
    excludeMembership,
    emit,
  };
})();
