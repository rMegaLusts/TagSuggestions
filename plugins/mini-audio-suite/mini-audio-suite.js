(function () {
  const core = window.__miniAudioSuite;
  const { AUDIO_ROUTE, View, DisplayModeTagger, store } = core;

  const PluginApi = window.PluginApi;
  const React = PluginApi.React;
  const { Nav, Button } = PluginApi.libraries.Bootstrap;
  const { useHistory, useLocation } = PluginApi.libraries.ReactRouterDOM;
  const { faHeadphones } = PluginApi.libraries.FontAwesomeSolid;
  const { Icon, LoadingIndicator } = PluginApi.components;
  const { useLoadComponents } = PluginApi.hooks;
  const { SceneList: loadSceneList } = PluginApi.loadableComponents;
  const h = React.createElement;

  const AUDIO_LINK = "mas-audio-tab";
  const AUDIO_VIEW = "mas_audio";

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
    const [revision, setRevision] = React.useState(() => core.getSnapshot());
    React.useEffect(
      () => core.subscribe(() => setRevision(core.getSnapshot())),
      []
    );
    return revision;
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
      const cleared = filter.clearCriteria(false);
      const scoped = pageHook ? pageHook(cleared) : cleared;
      return core.includeMembership(scoped);
    };
  }

  function compose(outer, inner) {
    return (filter) => outer(inner ? inner(filter) : filter);
  }

  const audioCounts = { key: "", value: null };
  let countGeneration = 0;

  function childDepth(scope) {
    if (scope.kind === "performer") {
      return 0;
    }
    const box = document.getElementById("showSubContent");
    if (box instanceof HTMLInputElement && box.checked) {
      return -1;
    }
    return 0;
  }

  function countKey(scope, depth) {
    return [scope.kind, scope.id, store.tagState.rootId || "", depth].join(":");
  }

  function entityCriterion(scope, depth) {
    if (scope.kind === "performer") {
      return {
        performers: {
          value: [scope.id],
          modifier: core.criterion("IncludesAll"),
        },
      };
    }
    if (scope.kind === "studio") {
      return {
        studios: {
          value: [scope.id],
          modifier: core.criterion("Includes"),
          depth: depth,
        },
      };
    }
    return {
      tags: {
        value: [scope.id],
        modifier: core.criterion("IncludesAll"),
        depth: depth,
      },
    };
  }

  function formatCount(count, abbreviate) {
    if (!abbreviate || count < 1000) {
      return count.toLocaleString();
    }
    const units = ["", "K", "M", "B"];
    let unit = 0;
    let digits = 0;
    let value = count;
    while (value >= 1000 && unit + 1 < units.length) {
      value /= 1000;
      unit += 1;
      digits = 1;
    }
    const size = value.toLocaleString(undefined, { maximumFractionDigits: digits });
    return `${size}${units[unit]}`;
  }

  function counterClassName() {
    const sample = document.querySelector(".nav-tabs .nav-link .badge:not(.mas-audio-count)");
    if (sample) {
      return `${sample.className} mas-audio-count`;
    }
    return "badge badge-pill badge-secondary left-spacing mas-audio-count";
  }

  function shownAudioCount() {
    const scope = entityFromPath(window.location.pathname);
    if (!scope || !scope.separate()) {
      return null;
    }
    const key = countKey(scope, childDepth(scope));
    if (audioCounts.key !== key) {
      return null;
    }
    return audioCounts.value;
  }

  function renderAudioCount(link) {
    const count = shownAudioCount();
    const badge = link.querySelector(":scope > .mas-audio-count");
    if (count == null || count === 0) {
      badge?.remove();
      return;
    }
    const text = formatCount(count, store.ui.abbreviateCounters);
    const value = String(count);
    if (badge) {
      if (badge.textContent !== text) {
        badge.textContent = text;
      }
      if (badge.getAttribute("data-value") !== value) {
        badge.setAttribute("data-value", value);
      }
      return;
    }
    const created = document.createElement("span");
    created.className = counterClassName();
    created.textContent = text;
    created.setAttribute("data-value", value);
    link.appendChild(created);
  }

  function paintAudioTabs() {
    const pathname = window.location.pathname;
    const scope = entityFromPath(pathname);
    const enabled = !!(scope && scope.separate());
    const active = enabled && audioTabActive(pathname);
    syncAudioTabs(enabled, active);
  }

  function loadAudioCount(scope) {
    const generation = ++countGeneration;
    if (!store.ready || !scope || !scope.separate()) {
      audioCounts.key = "";
      audioCounts.value = null;
      return;
    }
    const depth = childDepth(scope);
    const key = countKey(scope, depth);
    if (audioCounts.key !== key) {
      audioCounts.value = null;
    }
    audioCounts.key = key;
    core.countMembership(entityCriterion(scope, depth)).then(
      (count) => {
        if (generation !== countGeneration) {
          return;
        }
        audioCounts.key = key;
        audioCounts.value = count;
        paintAudioTabs();
      },
      (err) => {
        console.error("[mini-audio-suite]", err);
      }
    );
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
      renderAudioCount(link);
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
      loadAudioCount(scope);
      const run = () => {
        const live = entityFromPath(location.pathname);
        if (live && live.separate() && store.ready) {
          const key = countKey(live, childDepth(live));
          if (key !== audioCounts.key) {
            loadAudioCount(live);
          }
        }
        syncAudioTabs(enabled, active);
      };
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
        view: listProps.view || AUDIO_VIEW,
        filterHook: compose(core.includeMembership, listProps.filterHook),
      }));
    }

    if (scope && scope.separate() && audioTabActive(pathname) && listProps.view === scope.view) {
      return h(Original, {
        key: "mas-audio-tab",
        view: listProps.view,
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

  const NAV_ITEM_COL =
    "col-4 col-sm-3 col-md-2 col-lg-auto";
  const NAV_BUTTON_CLASS =
    "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center";
  const NAV_ICON_CLASS = "nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0";

  function injectNavAfterScenes(children) {
    const childArray = React.Children.toArray(children);
    const scenesChild = childArray.find((child) => {
      if (!child || !child.props) {
        return false;
      }
      return child.props.eventKey === "/scenes" || child.props.href === "/scenes";
    });
    const colClass =
      scenesChild?.props?.className?.includes("col-") ?
        scenesChild.props.className
      : NAV_ITEM_COL;

    const audioLink = h(AudioNavItem, { className: colClass, key: AUDIO_ROUTE });
    const scenesIndex = childArray.findIndex((child) => child === scenesChild);
    if (scenesIndex === -1) {
      return childArray.concat([audioLink]);
    }
    const next = childArray.slice();
    next.splice(scenesIndex + 1, 0, audioLink);
    return next;
  }

  function AudioNavItem(props) {
    const history = useHistory();
    const location = useLocation();
    const active = isAudioNavPath(location.pathname);

    return h(
      Nav.Link,
      {
        eventKey: AUDIO_ROUTE,
        as: "div",
        className: props.className,
      },
      h(
        Button,
        {
          href: AUDIO_ROUTE,
          active: active,
          className: NAV_BUTTON_CLASS,
          onClick: (event) => {
            if (
              event.defaultPrevented ||
              event.button !== 0 ||
              event.metaKey ||
              event.altKey ||
              event.ctrlKey ||
              event.shiftKey
            ) {
              return;
            }
            event.preventDefault();
            history.push(AUDIO_ROUTE);
          },
        },
        h(Icon, { icon: faHeadphones, className: NAV_ICON_CLASS }),
        h("span", null, "Audio")
      )
    );
  }

  function AudioScenesPage() {
    const scenesLoading = useLoadComponents([loadSceneList]);
    const FilteredSceneList = PluginApi.components.FilteredSceneList;
    if (scenesLoading || !FilteredSceneList) {
      return h(LoadingIndicator);
    }
    return h(FilteredSceneList, { alterQuery: true, view: AUDIO_VIEW });
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
    // Stash calls patched components as (props, legacyContext) and appends the
    // render result last. The legacy context is an empty object; rendering it
    // is React error #31.
    PluginApi.patch.after(pageName, function () {
      const page = arguments[arguments.length - 1];
      return h(React.Fragment, null, h(EntityAudioController), page);
    });
  }

  mountController("PerformerPage");
  mountController("StudioPage");
  mountController("TagPage");

  PluginApi.register.route(AUDIO_ROUTE, AudioScenesPage);
})();
