(function () {
  const core = window.__miniAudioSuite;
  const { AUDIO_ROUTE, View, DisplayModeTagger, store } = core;

  const PluginApi = window.PluginApi;
  const React = PluginApi.React;
  const { Nav } = PluginApi.libraries.Bootstrap;
  const { NavLink, useLocation } = PluginApi.libraries.ReactRouterDOM;
  const { faHeadphones } = PluginApi.libraries.FontAwesomeSolid;
  const { Icon, LoadingIndicator } = PluginApi.components;
  const { useLoadComponents } = PluginApi.hooks;
  const { SceneList: loadSceneList } = PluginApi.loadableComponents;
  const h = React.createElement;

  const AUDIO_LINK = "mas-audio-tab";

  const entities = {
    performer: {
      pattern: /\/performers\/(\d+)/,
      view: View.PerformerScenes,
      separate: () => store.settings.separate_performers,
    },
    studio: {
      pattern: /\/studios\/(\d+)/,
      view: View.StudioScenes,
      separate: () => store.settings.separate_studios,
    },
    tag: {
      pattern: /\/tags\/(\d+)/,
      view: View.TagScenes,
      separate: () => store.settings.separate_tags,
    },
  };

  function useRevision() {
    return React.useSyncExternalStore(core.subscribe, core.getSnapshot, core.getSnapshot);
  }

  function entityFromPath(pathname) {
    for (const kind of Object.keys(entities)) {
      const spec = entities[kind];
      const match = pathname.match(spec.pattern);
      if (match) {
        return { kind, id: match[1], view: spec.view, separate: spec.separate };
      }
    }
    return null;
  }

  function isMainScenesPath(pathname) {
    return pathname.replace(/\/$/, "") === "/scenes";
  }

  function isAudioNavPath(pathname) {
    return pathname.replace(/\/$/, "") === AUDIO_ROUTE;
  }

  function isTagger(filter, pathname) {
    if (pathname.includes("/tagger")) {
      return true;
    }
    const mode = filter?.displayMode;
    return mode === DisplayModeTagger || mode === "tagger";
  }

  function audioTabActive(pathname) {
    return store.audioTab.on && store.audioTab.pathname === pathname;
  }

  function showAudioTab(pathname) {
    store.audioTab = { pathname, on: true };
    core.emit();
  }

  function hideAudioTab() {
    if (!store.audioTab.on) {
      return;
    }
    store.audioTab = { pathname: "", on: false };
    core.emit();
  }

  function scopedInclude(pageHook) {
    return (filter) => {
      const cleared = filter.clearCriteria(true);
      const scoped = pageHook ? pageHook(cleared) : cleared;
      return core.includeMembership(scoped);
    };
  }

  function compose(outer, inner) {
    return (filter) => outer(inner ? inner(filter) : filter);
  }

  function scenesLink(nav) {
    const item = nav.querySelector(":scope > .nav-item, :scope > .nav-link");
    if (!item) {
      return null;
    }
    return item.classList.contains("nav-link") ? item : item.querySelector(".nav-link");
  }

  function syncAudioTabs(enabled, active) {
    document.querySelectorAll(".nav-tabs").forEach((nav) => {
      let link = nav.querySelector(`.${AUDIO_LINK}`);
      const anchor = nav.querySelector(":scope > .nav-item, :scope > .nav-link");
      if (!enabled) {
        const item = link?.closest(".nav-item");
        if (item && item !== link) {
          item.remove();
        } else {
          link?.remove();
        }
        return;
      }
      if (!anchor) {
        return;
      }
      if (!link) {
        link = document.createElement("a");
        link.className = `nav-link ${AUDIO_LINK}`;
        link.href = "#";
        link.textContent = "Audio";
        link.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          showAudioTab(window.location.pathname);
        });
        if (anchor.classList.contains("nav-item")) {
          const item = document.createElement("li");
          item.className = "nav-item";
          item.appendChild(link);
          anchor.insertAdjacentElement("afterend", item);
        } else {
          anchor.insertAdjacentElement("afterend", link);
        }
      }
      link.classList.toggle("active", active);
      const scenes = scenesLink(nav);
      if (active && scenes && scenes !== link) {
        scenes.classList.remove("active");
      }
    });
  }

  function EntityAudioController() {
    const revision = useRevision();
    const location = useLocation();

    React.useEffect(() => {
      if (store.audioTab.on && store.audioTab.pathname !== location.pathname) {
        store.audioTab = { pathname: "", on: false };
        core.emit();
        return;
      }
      const scope = entityFromPath(location.pathname);
      const enabled = !!(scope && scope.separate());
      const active = enabled && audioTabActive(location.pathname);
      const run = () => syncAudioTabs(enabled, active);
      run();
      const observer = new MutationObserver(run);
      observer.observe(document.body, { childList: true, subtree: true });
      return () => observer.disconnect();
    }, [location.pathname, revision]);

    return null;
  }

  document.addEventListener(
    "click",
    (event) => {
      const link = event.target.closest?.(".nav-tabs .nav-link");
      if (!link || link.classList.contains(AUDIO_LINK)) {
        return;
      }
      if (audioTabActive(window.location.pathname)) {
        hideAudioTab();
      }
    },
    true
  );

  function SceneListGate(props) {
    const original = props.original;
    const listProps = Object.assign({}, props);
    delete listProps.original;
    useRevision();
    const location = useLocation();
    const Original = original;

    if (!store.ready) {
      return h(LoadingIndicator);
    }

    const pathname = location.pathname;
    const scope = entityFromPath(pathname);

    if (isAudioNavPath(pathname)) {
      return h(Original, Object.assign({}, listProps, {
        view: undefined,
        filterHook: compose(core.includeMembership, listProps.filterHook),
      }));
    }

    if (scope && scope.separate() && audioTabActive(pathname) && listProps.view === scope.view) {
      return h(Original, {
        key: "mas-audio-tab",
        alterQuery: false,
        filterHook: scopedInclude(listProps.filterHook),
      });
    }

    if (scope && scope.separate() && listProps.view === scope.view) {
      return h(Original, Object.assign({}, listProps, {
        filterHook: (filter) => {
          const next = listProps.filterHook ? listProps.filterHook(filter) : filter;
          return core.excludeMembership(next);
        },
      }));
    }

    if (store.settings.hide_scenes && isMainScenesPath(pathname) && listProps.view === View.Scenes) {
      return h(Original, Object.assign({}, listProps, {
        filterHook: (filter) => {
          const next = listProps.filterHook ? listProps.filterHook(filter) : filter;
          if (isTagger(next, pathname)) {
            return next;
          }
          return core.excludeMembership(next);
        },
      }));
    }

    return h(Original, listProps);
  }

  function injectNavAfterScenes(children) {
    const childArray = React.Children.toArray(children);
    const audioLink = h(
      Nav.Link,
      {
        eventKey: AUDIO_ROUTE,
        as: "div",
        key: AUDIO_ROUTE,
        className: "col-4 col-sm-3 col-md-2 col-lg-auto",
      },
      h(
        NavLink,
        { to: AUDIO_ROUTE, className: "nav-link", activeClassName: "active" },
        h(Icon, { icon: faHeadphones }),
        h("span", null, "Audio")
      )
    );
    const scenesIndex = childArray.findIndex((child) => {
      if (!child || !child.props) {
        return false;
      }
      return child.props.eventKey === "/scenes" || child.props.href === "/scenes";
    });
    if (scenesIndex === -1) {
      return childArray.concat([audioLink]);
    }
    const next = childArray.slice();
    next.splice(scenesIndex + 1, 0, audioLink);
    return next;
  }

  function AudioScenesPage() {
    const scenesLoading = useLoadComponents([loadSceneList]);
    const FilteredSceneList = PluginApi.components.FilteredSceneList;
    if (scenesLoading || !FilteredSceneList) {
      return h(LoadingIndicator);
    }
    return h(FilteredSceneList, { alterQuery: true });
  }

  PluginApi.patch.before("MainNavBar.MenuItems", (props) => [
    {
      children: injectNavAfterScenes(props.children),
    },
  ]);

  PluginApi.patch.instead("FilteredSceneList", (props, _ctx, original) =>
    h(SceneListGate, Object.assign({}, props, { original }))
  );

  function mountController(pageName) {
    PluginApi.patch.after(pageName, (_props, page) =>
      h(React.Fragment, null, h(EntityAudioController), page)
    );
  }

  mountController("PerformerPage");
  mountController("StudioPage");
  mountController("TagPage");

  PluginApi.register.route(AUDIO_ROUTE, AudioScenesPage);
})();
