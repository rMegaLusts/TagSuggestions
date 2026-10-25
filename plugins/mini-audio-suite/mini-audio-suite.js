(function () {
  const PLUGIN_ID = "mini-audio-suite";
  const AUDIO_ROUTE = "/plugins/mini-audio-suite/audio";
  const AUDIO_TAB_QUERY = "mas_audio";

  const View = {
    Scenes: "scenes",
    PerformerScenes: "performer_scenes",
    StudioScenes: "studio_scenes",
    TagScenes: "tag_scenes",
  };

  const PluginApi = window.PluginApi;
  const React = PluginApi.React;
  const GQL = PluginApi.GQL;
  const { Nav } = PluginApi.libraries.Bootstrap;
  const { NavLink, useHistory, useLocation } = PluginApi.libraries.ReactRouterDOM;
  const { FormattedMessage } = PluginApi.libraries.Intl;
  const { faHeadphones } = PluginApi.libraries.FontAwesomeSolid;

  const { FilteredSceneList, Icon, LoadingIndicator } = PluginApi.components;

  const Mod = GQL.CriterionModifier;

  let settings = {
    tag_name: "",
    hide_scenes: false,
    hide_performers: false,
    hide_studios: false,
    hide_tags: false,
  };

  let tagState = { rootId: null, resolvedName: "" };

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

  function parseBool(value) {
    return value === true || value === "true";
  }

  function parseSettings(plugins) {
    const raw = plugins?.[PLUGIN_ID] ?? {};
    return {
      tag_name: typeof raw.tag_name === "string" ? raw.tag_name : "",
      hide_scenes: parseBool(raw.hide_scenes),
      hide_performers: parseBool(raw.hide_performers),
      hide_studios: parseBool(raw.hide_studios),
      hide_tags: parseBool(raw.hide_tags),
    };
  }

  async function refreshConfiguration() {
    const data = await callGQL({
      query: `query { configuration { plugins } }`,
    });
    settings = parseSettings(data.configuration.plugins);
    await resolveAudioTag();
  }

  function configuredTagName() {
    const trimmed = (settings.tag_name || "").trim();
    return trimmed || "Audio";
  }

  async function resolveAudioTag() {
    const name = configuredTagName();
    if (!name) {
      tagState = { rootId: null, resolvedName: "" };
      return tagState;
    }
    const pattern = `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
    const data = await callGQL({
      query: `query FindMasTag($filter: FindFilterType!, $tag_filter: TagFilterType!) {
        findTags(filter: $filter, tag_filter: $tag_filter) { tags { id name } }
      }`,
      variables: {
        filter: { per_page: 100 },
        tag_filter: {
          name: { value: pattern, modifier: Mod.MatchesRegex },
        },
      },
    });
    const match = (data.findTags?.tags ?? []).find(
      (t) => t.name && t.name.toLowerCase() === name.toLowerCase()
    );
    if (!match) {
      tagState = { rootId: null, resolvedName: name };
      return tagState;
    }
    tagState = { rootId: match.id, resolvedName: match.name };
    return tagState;
  }

  function buildNoVideoBranch() {
    return {
      AND: {
        file_count: { value: 0, modifier: Mod.GreaterThan },
        NOT: {
          video_codec: { value: "", modifier: Mod.NotNull },
        },
      },
    };
  }

  function buildMembershipOr(rootId) {
    const noVideo = buildNoVideoBranch();
    if (!rootId) {
      return noVideo;
    }
    return {
      OR: {
        tags: {
          value: [rootId],
          modifier: Mod.Includes,
          depth: -1,
        },
        OR: noVideo,
      },
    };
  }

  function mergeSceneFilter(base, extra) {
    if (!base || Object.keys(base).length === 0) {
      return extra;
    }
    return {
      AND: {
        ...base,
        ...extra,
      },
    };
  }

  function includeMembershipFilter(baseSceneFilter) {
    const membership = buildMembershipOr(tagState.rootId);
    return mergeSceneFilter(baseSceneFilter, { OR: membership });
  }

  function excludeMembershipFilter(baseSceneFilter) {
    const membership = buildMembershipOr(tagState.rootId);
    return mergeSceneFilter(baseSceneFilter, { NOT: { OR: membership } });
  }

  function patchMakeFilter(filter, transform) {
    const original = filter.makeFilter.bind(filter);
    filter.makeFilter = function masMakeFilter() {
      return transform(original());
    };
    return filter;
  }

  function withIncludeMembership(filter) {
    return patchMakeFilter(filter, includeMembershipFilter);
  }

  function withExcludeMembership(filter) {
    return patchMakeFilter(filter, excludeMembershipFilter);
  }

  function chainFilterHooks(outer, inner) {
    return (filter) => {
      let f = filter;
      if (inner) {
        f = inner(f);
      }
      return outer(f);
    };
  }

  function shouldExcludeForView(view) {
    if (view === View.Scenes) {
      return settings.hide_scenes;
    }
    if (view === View.PerformerScenes) {
      return settings.hide_performers;
    }
    if (view === View.StudioScenes) {
      return settings.hide_studios;
    }
    if (view === View.TagScenes) {
      return settings.hide_tags;
    }
    return false;
  }

  function isAudioNavPath(pathname) {
    return pathname.replace(/\/$/, "") === AUDIO_ROUTE;
  }

  function isEntityAudioTab(search) {
    return new URLSearchParams(search).get(AUDIO_TAB_QUERY) === "1";
  }

  function entityScopeFromPath(pathname) {
    const performer = pathname.match(/\/performers\/(\d+)/);
    if (performer) {
      return {
        type: "performer",
        id: performer[1],
        view: View.PerformerScenes,
      };
    }
    const studio = pathname.match(/\/studios\/(\d+)/);
    if (studio) {
      return {
        type: "studio",
        id: studio[1],
        view: View.StudioScenes,
      };
    }
    const tag = pathname.match(/\/tags\/(\d+)/);
    if (tag) {
      return {
        type: "tag",
        id: tag[1],
        view: View.TagScenes,
      };
    }
    return null;
  }

  function entityScopeFilterHook(scope) {
    if (!scope) {
      return null;
    }
    return (filter) =>
      patchMakeFilter(filter, (base) => {
        if (scope.type === "performer") {
          return mergeSceneFilter(base, {
            performers: {
              value: [scope.id],
              modifier: Mod.IncludesAll,
            },
          });
        }
        if (scope.type === "studio") {
          return mergeSceneFilter(base, {
            studios: {
              value: [scope.id],
              modifier: Mod.Includes,
              depth: -1,
            },
          });
        }
        if (scope.type === "tag") {
          return mergeSceneFilter(base, {
            tags: {
              value: [scope.id],
              modifier: Mod.Includes,
              depth: -1,
            },
          });
        }
        return base;
      });
  }

  function entityTabsEnabled(scope) {
    if (!scope) {
      return false;
    }
    if (scope.type === "performer") {
      return settings.hide_performers;
    }
    if (scope.type === "studio") {
      return settings.hide_studios;
    }
    if (scope.type === "tag") {
      return settings.hide_tags;
    }
    return false;
  }

  function injectNavAfterScenes(children) {
    const childArray = React.Children.toArray(children);
    const audioLink = (
      <Nav.Link
        eventKey={AUDIO_ROUTE}
        as="div"
        key={AUDIO_ROUTE}
        className="col-4 col-sm-3 col-md-2 col-lg-auto"
      >
        <NavLink to={AUDIO_ROUTE} className="nav-link" activeClassName="active">
          <Icon icon={faHeadphones} />
          <span>Audio</span>
        </NavLink>
      </Nav.Link>
    );
    const scenesIndex = childArray.findIndex((child) => {
      if (!child || !child.props) {
        return false;
      }
      return child.props.eventKey === "/scenes" || child.props.href === "/scenes";
    });
    if (scenesIndex === -1) {
      return [...childArray, audioLink];
    }
    const next = childArray.slice();
    next.splice(scenesIndex + 1, 0, audioLink);
    return next;
  }

  function sceneLacksRealVideo(scene) {
    const files = scene?.files ?? [];
    if (files.length === 0) {
      return false;
    }
    return files.every((file) => !file.video_codec);
  }

  function filterSceneStreams(scene) {
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

  const AudioScenesPage = () => {
    const [ready, setReady] = React.useState(false);

    React.useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          await refreshConfiguration();
        } catch (err) {
          console.error("[mini-audio-suite]", err);
        }
        if (!cancelled) {
          setReady(true);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, []);

    if (!ready) {
      return <LoadingIndicator />;
    }

    return <FilteredSceneList alterQuery />;
  };

  const EntityAudioTabBar = ({ enabled }) => {
    const history = useHistory();
    const location = useLocation();
    if (!enabled) {
      return null;
    }
    const audioTab = isEntityAudioTab(location.search);

    function selectTab(audio) {
      const params = new URLSearchParams(location.search);
      if (audio) {
        params.set(AUDIO_TAB_QUERY, "1");
      } else {
        params.delete(AUDIO_TAB_QUERY);
      }
      history.replace({ pathname: location.pathname, search: params.toString() });
    }

    return (
      <Nav variant="tabs" className="mas-entity-audio-tabs mb-2">
        <Nav.Item>
          <Nav.Link active={!audioTab} onClick={() => selectTab(false)}>
            <FormattedMessage id="scenes" />
          </Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link active={audioTab} onClick={() => selectTab(true)}>
            Audio
          </Nav.Link>
        </Nav.Item>
      </Nav>
    );
  };

  const EntityAudioScenesPanel = ({ scope }) => {
    const location = useLocation();
    if (!scope || !isEntityAudioTab(location.search)) {
      return null;
    }
    const scopeHook = entityScopeFilterHook(scope);
    const includeHook = React.useCallback(
      (filter) => withIncludeMembership(scopeHook ? scopeHook(filter) : filter),
      [scope]
    );
    return (
      <FilteredSceneList
        view={scope.view}
        filterHook={includeHook}
        alterQuery={false}
      />
    );
  };

  const EntityPageEnhancer = ({ children }) => {
    const location = useLocation();
    const scope = entityScopeFromPath(location.pathname);
    const enabled = entityTabsEnabled(scope);
    return (
      <>
        <EntityAudioTabBar enabled={enabled} />
        {children}
        {enabled ? <EntityAudioScenesPanel scope={scope} /> : null}
      </>
    );
  };

  function wrapEntityPage(pageName) {
    PluginApi.patch.after(pageName, (_props, page) => (
      <EntityPageEnhancer>{page}</EntityPageEnhancer>
    ));
  }

  PluginApi.patch.instead("PerformerScenesPanel", (props, _ctx, original) => {
    if (settings.hide_performers && isEntityAudioTab(window.location.search)) {
      return null;
    }
    return original(props);
  });

  PluginApi.patch.before("MainNavBar.MenuItems", (props) => [
    {
      children: injectNavAfterScenes(props.children),
    },
  ]);

  PluginApi.patch.before("FilteredSceneList", (props) => {
    const pathname = window.location.pathname;
    const onAudioNav = isAudioNavPath(pathname);
    const scope = entityScopeFromPath(pathname);
    const onEntityAudioTab =
      scope && entityTabsEnabled(scope) && isEntityAudioTab(window.location.search);

    if (onEntityAudioTab) {
      return [props];
    }

    let filterHook = props.filterHook;
    const view = props.view;

    if (onAudioNav) {
      const includeHook = chainFilterHooks(withIncludeMembership, filterHook);
      return [{ ...props, filterHook: includeHook, view: undefined }];
    }

    if (shouldExcludeForView(view)) {
      const excludeHook = chainFilterHooks(withExcludeMembership, filterHook);
      return [{ ...props, filterHook: excludeHook }];
    }

    return [props];
  });

  PluginApi.patch.instead("FilteredSceneList", (props, _ctx, original) => {
    const scope = entityScopeFromPath(window.location.pathname);
    if (
      scope &&
      entityTabsEnabled(scope) &&
      isEntityAudioTab(window.location.search) &&
      props.alterQuery !== false &&
      props.view === scope.view
    ) {
      return null;
    }
    return original(props);
  });

  PluginApi.patch.instead("ScenePlayer", (props, _ctx, original) => {
    const scene = filterSceneStreams(props.scene);
    return original({ ...props, scene });
  });

  PluginApi.register.route(AUDIO_ROUTE, AudioScenesPage);

  wrapEntityPage("PerformerPage");
  wrapEntityPage("StudioPage");
  wrapEntityPage("TagPage");

  PluginApi.Event.addEventListener("stash:location", () => {
    refreshConfiguration().catch((err) => {
      console.error("[mini-audio-suite]", err);
    });
  });

  refreshConfiguration().catch((err) => {
    console.error("[mini-audio-suite]", err);
  });
})();
