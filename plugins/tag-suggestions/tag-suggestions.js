(function () {
  const PLUGIN_ID = "tag-suggestions";
  const DIALOG_ID = "tag-suggestions-dialog";

  function sceneIdFromPath() {
    const match = window.location.pathname.match(/\/scenes\/(\d+)/);
    return match ? match[1] : null;
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
    if (body.errors && body.errors.length) {
      throw new Error(body.errors[0].message || "GraphQL request failed");
    }
    if (!body.data) {
      throw new Error("GraphQL request returned no data");
    }
    return body.data;
  }

  async function runPlugin(args) {
    const query = `
      mutation RunTagSuggestions($plugin_id: ID!, $args: Map) {
        runPluginOperation(plugin_id: $plugin_id, args: $args)
      }
    `;
    const data = await callGQL({ query, variables: { plugin_id: PLUGIN_ID, args } });
    const result = data.runPluginOperation;
    if (result == null) {
      throw new Error("Tag suggestions returned no result");
    }
    if (typeof result === "string") {
      let parsed;
      try {
        parsed = JSON.parse(result);
      } catch (_err) {
        throw new Error(result);
      }
      if (parsed && parsed.error) {
        throw new Error(parsed.error);
      }
      return parsed.output ?? parsed;
    }
    if (typeof result === "object") {
      if (result.error && result.logged !== false) {
        throw new Error(result.error);
      }
      return result.output ?? result;
    }
    return result;
  }

  let pageScrollLocked = false;
  let savedBodyOverflow = "";
  let savedRootOverflow = "";

  function lockPageScroll() {
    if (pageScrollLocked) {
      return;
    }
    savedBodyOverflow = document.body.style.overflow;
    savedRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    pageScrollLocked = true;
  }

  function unlockPageScroll() {
    if (!pageScrollLocked) {
      return;
    }
    document.body.style.overflow = savedBodyOverflow;
    document.documentElement.style.overflow = savedRootOverflow;
    pageScrollLocked = false;
  }

  function holdPage(dialog) {
    const marked = [];
    for (const child of Array.from(document.body.children)) {
      if (child === dialog) {
        continue;
      }
      marked.push({
        element: child,
        inert: child.hasAttribute("inert"),
        ariaHidden: child.getAttribute("aria-hidden"),
      });
      child.setAttribute("inert", "");
      child.setAttribute("aria-hidden", "true");
    }
    dialog._pageHeld = marked;
  }

  function releasePage(dialog) {
    for (const entry of dialog._pageHeld || []) {
      if (entry.inert) {
        entry.element.setAttribute("inert", "");
      } else {
        entry.element.removeAttribute("inert");
      }
      if (entry.ariaHidden === null) {
        entry.element.removeAttribute("aria-hidden");
      } else {
        entry.element.setAttribute("aria-hidden", entry.ariaHidden);
      }
    }
    dialog._pageHeld = [];
  }

  async function discardSnapshot(snapshotId) {
    if (!snapshotId) {
      return;
    }
    try {
      await runPlugin({ mode: "discard_snapshot", snapshot_id: snapshotId });
    } catch (_err) {
      // best-effort
    }
  }

  async function closeDialog(root) {
    if (!root || !root.parentNode) {
      return;
    }
    root._abandoned = true;
    if (root._releaseFocusTrap) {
      root._releaseFocusTrap();
    }
    releasePage(root);
    const snapshotId = root.dataset.snapshotId;
    root.parentNode.removeChild(root);
    unlockPageScroll();
    await discardSnapshot(snapshotId);
  }

  // randomUUID is only defined in a secure context. Stash is often served over
  // plain HTTP, where getRandomValues still works.
  function newBatchId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function formatScore(score) {
    const numericScore = Number(score);
    return Number.isFinite(numericScore) ? numericScore.toFixed(2) : String(score);
  }

  function sceneTagChipClassName() {
    const sample = document.querySelector(".tag-item");
    if (sample) {
      // Scene tags are `tag-link`: the badge padding is 0 and the inner anchor
      // carries 2px 6px. A chip with no anchor keeps `tag-item` so that padding
      // stays on the chip. Drop `tag-link`, and do not add `btn` — Stash pulls
      // `.tag-item .btn` outside the pill.
      return Array.from(sample.classList)
        .filter((name) => name !== "tag-link")
        .join(" ");
    }
    return "badge badge-secondary tag-item";
  }

  function zoneSection(title, zoneName) {
    const section = document.createElement("div");
    section.className = "mb-3";
    const heading = document.createElement("div");
    heading.className = "font-weight-bold mb-2";
    heading.textContent = title;
    section.appendChild(heading);
    const zone = document.createElement("div");
    zone.dataset.zone = zoneName;
    section.appendChild(zone);
    return { section, zone };
  }

  function reviewChip(item, role, dialog) {
    const label = `${item.tag_name} (${formatScore(item.score)})`;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = sceneTagChipClassName();
    // Native button chrome adds padding on top of `.tag-item`.
    chip.style.appearance = "none";
    chip.style.setProperty("-webkit-appearance", "none");
    chip.style.border = "0";
    chip.dataset.tagId = String(item.tag_id);
    chip.dataset.role = role;
    chip.textContent = label;
    chip.addEventListener("click", () => {
      if (dialog._interactionLocked) {
        return;
      }
      const zoneName = chip.parentElement?.dataset?.zone;
      const next = zoneName === "to-add" ? "set-aside" : "to-add";
      chip._moveTo(dialog.querySelector(`[data-zone="${next}"]`));
    });
    chip._moveTo = (zone) => {
      zone.appendChild(chip);
      const action = zone.dataset.zone === "to-add" ? "Set aside" : "To add";
      chip.setAttribute("aria-label", `${action} ${label}`);
    };
    return chip;
  }

  function moveSuggestedTagsToAdd(dialog) {
    const toAdd = dialog.querySelector('[data-zone="to-add"]');
    dialog.querySelectorAll('[data-zone="set-aside"] [data-role="suggested"]').forEach((chip) => {
      chip._moveTo(toAdd);
    });
  }

  function approvedTagIds(dialog) {
    const ids = new Set();
    dialog.querySelectorAll('[data-zone="to-add"] [data-tag-id]').forEach((chip) => {
      ids.add(chip.dataset.tagId);
    });
    return ids;
  }

  function setDialogActions(dialog, { run, approveAll, apply }) {
    dialog.querySelector('[data-action="run"]').disabled = !run;
    dialog.querySelector('[data-action="approve-all"]').disabled = !approveAll;
    dialog.querySelector('[data-action="apply"]').disabled = !apply;
  }

  function renderAskedItem(section, payload) {
    section.replaceChildren();
    const title = document.createElement("div");
    title.className = "font-weight-bold mb-2";
    title.textContent = payload.title || "";
    section.appendChild(title);

    const asked = payload.asked_body;
    if (!asked) {
      const empty = document.createElement("p");
      empty.className = "text-muted mb-2";
      empty.textContent = "No Body was sent.";
      section.appendChild(empty);
    } else {
      const body = document.createElement("div");
      body.className = "mb-2";
      body.style.whiteSpace = "pre-wrap";
      body.textContent = asked;
      section.appendChild(body);
    }

    const dropped = Number(payload.body_chars_dropped) || 0;
    if (dropped > 0) {
      const note = document.createElement("p");
      note.className = "text-muted small mb-0";
      note.textContent = `${dropped} characters were not sent.`;
      section.appendChild(note);
    }
  }

  function renderPreparingBody(body) {
    body.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "d-flex align-items-center";
    wrap.style.gap = "0.5rem";
    const spinner = document.createElement("span");
    spinner.className = "spinner-border spinner-border-sm";
    spinner.setAttribute("role", "status");
    spinner.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = "Preparing this scene.";
    wrap.append(spinner, text);
    body.appendChild(wrap);
  }

  function renderIdleBody(body) {
    body.replaceChildren();
    const hint = document.createElement("p");
    hint.className = "text-muted mb-0";
    hint.textContent = "Press Run to judge Tags for this scene.";
    body.appendChild(hint);
  }

  function renderRunningBody(body, tagsJudged, tagsToAsk) {
    body.replaceChildren();
    const progress = document.createElement("p");
    progress.className = "mb-0";
    progress.textContent = `Tags judged: ${tagsJudged} / ${tagsToAsk}`;
    body.appendChild(progress);
  }

  function renderFailedBody(body, message) {
    body.replaceChildren();
    const error = document.createElement("p");
    error.className = "text-danger mb-0";
    error.textContent = message;
    body.appendChild(error);
  }

  function phaseErrorParagraph(message) {
    const error = document.createElement("p");
    error.className = "text-danger mb-2";
    error.dataset.role = "phase-error";
    error.textContent = message;
    return error;
  }

  function clearPhaseError(body) {
    body.querySelector('[data-role="phase-error"]')?.remove();
  }

  function showApplyError(body, message) {
    clearPhaseError(body);
    const error = phaseErrorParagraph(message);
    if (body.firstChild) {
      body.insertBefore(error, body.firstChild);
    } else {
      body.appendChild(error);
    }
  }

  function setChipInteraction(dialog, enabled) {
    dialog.querySelectorAll("[data-tag-id]").forEach((chip) => {
      chip.disabled = !enabled;
    });
  }

  function renderResultsBody(body, payload, dialog) {
    body.replaceChildren();
    const suggestions = payload.suggestions || [];
    const nearMisses = payload.near_misses || [];

    if (suggestions.length === 0 && nearMisses.length === 0) {
      body.textContent = "No Suggested Tags or Near Misses for this scene.";
      return;
    }

    const toAdd = zoneSection("To add", "to-add");
    const setAside = zoneSection("Set aside", "set-aside");
    body.append(toAdd.section, setAside.section);

    const placements = [
      [suggestions, "suggested", toAdd.zone],
      [nearMisses, "near_miss", setAside.zone],
    ];
    for (const [items, role, zone] of placements) {
      for (const item of items) {
        reviewChip(item, role, dialog)._moveTo(zone);
      }
    }
  }

  function focusableElements(container) {
    return Array.from(
      container.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => element.offsetParent !== null || element === document.activeElement);
  }

  function installFocusTrap(dialog) {
    function onKeyDown(event) {
      if (event.key !== "Tab" || dialog._abandoned) {
        return;
      }
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    dialog._releaseFocusTrap = () => document.removeEventListener("keydown", onKeyDown, true);
  }

  function mountDialog(sceneId, { preparing } = { preparing: false }) {
    const root = document.createElement("div");
    root.id = DIALOG_ID;
    root.className = "tag-suggestions-modal";
    // Stash ships Bootstrap 4, which has position-fixed and w-100/h-100 but not
    // top-0, start-0, or opacity-50. With top left at auto, a fixed box uses its
    // static position: below the scene page. Locking scroll then hides it.
    root.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;z-index:1050;";
    root.dataset.snapshotId = "";
    root.dataset.sceneId = sceneId;
    root.dataset.batchId = newBatchId();
    root._abandoned = false;
    root._interactionLocked = preparing;

    root.innerHTML = `
      <div aria-hidden="true" style="position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);"></div>
      <div class="position-relative d-flex align-items-center justify-content-center w-100 h-100 p-3" style="pointer-events: none;">
        <div
          class="border rounded shadow d-flex flex-column"
          role="dialog"
          aria-modal="true"
          aria-labelledby="tag-suggestions-dialog-title"
          style="pointer-events: auto; width: min(40rem, calc(100vw - 2rem)); max-height: calc(100vh - 2rem); overflow: hidden; min-height: 0;"
          data-role="dialog"
        >
          <div class="d-flex justify-content-between align-items-center border-bottom px-3 py-2 flex-shrink-0">
            <span id="tag-suggestions-dialog-title">Tag suggestions</span>
            <button type="button" class="btn btn-sm btn-secondary" data-action="close">Close</button>
          </div>
          <div class="px-3 py-3" data-role="scroll" style="overflow: auto; min-height: 0; flex: 1 1 auto;">
            <section class="mb-3" data-role="asked-item"></section>
            <div class="mb-3" data-role="body"></div>
            <div class="d-flex flex-wrap" data-role="actions" style="gap: 0.5rem;">
              <button type="button" class="btn btn-primary" data-action="run">Run</button>
              <button type="button" class="btn btn-secondary" data-action="approve-all">Approve all</button>
              <button type="button" class="btn btn-success" data-action="apply">Apply selected</button>
            </div>
          </div>
        </div>
      </div>
    `;

    const panel = root.querySelector('[data-role="dialog"]');
    const pageBg = getComputedStyle(document.body).backgroundColor;
    panel.style.backgroundColor = pageBg && pageBg !== "rgba(0, 0, 0, 0)" ? pageBg : "#202b33";

    const scroll = root.querySelector('[data-role="scroll"]');
    const askedSection = root.querySelector('[data-role="asked-item"]');
    const body = root.querySelector('[data-role="body"]');
    const state = {
      phase: preparing ? "preparing" : "idle",
      payload: null,
    };
    root._state = state;

    if (preparing) {
      askedSection.replaceChildren();
      renderPreparingBody(body);
      setDialogActions(root, { run: false, approveAll: false, apply: false });
    }

    function keepScrollInside(event) {
      if (!scroll.contains(event.target)) {
        event.preventDefault();
      }
    }
    root.addEventListener("wheel", keepScrollInside, { passive: false });
    root.addEventListener("touchmove", keepScrollInside, { passive: false });

    installFocusTrap(root);

    const closeButton = root.querySelector('[data-action="close"]');
    closeButton.addEventListener("click", () => {
      closeDialog(root);
    });

    root.querySelector('[data-action="approve-all"]').addEventListener("click", () => {
      if (root._interactionLocked) {
        return;
      }
      moveSuggestedTagsToAdd(root);
    });

    function finishPrepare(payload) {
      root.dataset.snapshotId = payload.snapshot_id || "";
      root._preparePayload = payload;
      state.phase = "idle";
      state.payload = payload;
      renderAskedItem(askedSection, payload);
      renderIdleBody(body);
      setDialogActions(root, { run: true, approveAll: false, apply: false });
      root._interactionLocked = false;
    }

    function showPrepareFailed(err) {
      state.phase = "failed";
      askedSection.replaceChildren();
      renderFailedBody(body, err.message || String(err));
      setDialogActions(root, { run: false, approveAll: false, apply: false });
      root._interactionLocked = false;
    }

    root._finishPrepare = finishPrepare;
    root._showPrepareFailed = showPrepareFailed;

    async function runJudging() {
      const snapshot = root._preparePayload;
      if (!snapshot || !snapshot.snapshot_id) {
        return;
      }
      state.phase = "running";
      state.payload = {
        scene_id: snapshot.scene_id,
        title: snapshot.title,
        body: snapshot.body,
        model: snapshot.model,
        settings: snapshot.settings,
        tags_to_ask: snapshot.tags_to_ask,
      };
      root.dataset.batchId = newBatchId();
      setDialogActions(root, { run: false, approveAll: false, apply: false });
      renderRunningBody(body, 0, snapshot.tags_to_ask || 0);

      let batchIndex = 0;
      let scores = {};
      try {
        for (;;) {
          const step = await runPlugin({
            mode: "suggest_batch",
            snapshot_id: snapshot.snapshot_id,
            batch_index: batchIndex,
            scores,
          });
          if (root._abandoned) {
            return;
          }
          scores = step.scores || scores;
          renderRunningBody(body, step.tags_judged ?? 0, step.tags_to_ask ?? snapshot.tags_to_ask ?? 0);
          if (step.done) {
            state.phase = "finished";
            state.payload = step;
            renderResultsBody(body, step, root);
            setDialogActions(root, { run: true, approveAll: true, apply: true });
            return;
          }
          batchIndex = step.batch_index ?? batchIndex + 1;
        }
      } catch (err) {
        if (root._abandoned) {
          return;
        }
        state.phase = "failed";
        renderFailedBody(body, err.message || String(err));
        setDialogActions(root, { run: true, approveAll: false, apply: false });
      }
    }

    root.querySelector('[data-action="run"]').addEventListener("click", () => {
      if (state.phase === "running" || root._interactionLocked) {
        return;
      }
      runJudging();
    });

    const applyButton = root.querySelector('[data-action="apply"]');
    applyButton.addEventListener("click", async () => {
      if (state.phase !== "finished" || root._interactionLocked) {
        return;
      }
      const resultPayload = state.payload;
      const approvedIds = approvedTagIds(root);
      const entries = [];
      for (const role of ["suggested", "near_miss"]) {
        const rows = role === "near_miss" ? resultPayload.near_misses : resultPayload.suggestions;
        for (const row of rows || []) {
          const tagId = String(row.tag_id);
          entries.push({
            tag_id: tagId,
            score: row.score,
            approved: approvedIds.has(tagId),
            role: role === "near_miss" ? "near_miss" : "suggested",
          });
        }
      }
      clearPhaseError(body);
      root._interactionLocked = true;
      setDialogActions(root, { run: false, approveAll: false, apply: false });
      setChipInteraction(root, false);
      try {
        const result = await runPlugin({
          mode: "apply",
          batch_id: root.dataset.batchId,
          scene_id: sceneId,
          title: resultPayload.title,
          description: resultPayload.body,
          model: resultPayload.model,
          settings: resultPayload.settings,
          entries,
        });
        if (root._abandoned || !root.parentNode) {
          return;
        }
        if (result && result.logged === false) {
          const added = entries.some((entry) => entry.approved);
          const lead = added
            ? "Tags were added, but the decision log failed"
            : "The decision log failed";
          showApplyError(body, `${lead}: ${result.error || "unknown error"}`);
          return;
        }
        await closeDialog(root);
      } catch (err) {
        if (root._abandoned || !root.parentNode) {
          return;
        }
        showApplyError(body, `Apply failed: ${err.message || err}`);
      } finally {
        if (root.parentNode && !root._abandoned) {
          root._interactionLocked = false;
          setDialogActions(root, { run: true, approveAll: true, apply: true });
          setChipInteraction(root, true);
        }
      }
    });

    document.body.appendChild(root);
    holdPage(root);
    lockPageScroll();
    scroll.scrollTop = 0;
    closeButton.focus();
    return root;
  }

  async function onSuggestClick(sceneId) {
    if (document.getElementById(DIALOG_ID)) {
      return;
    }
    const root = mountDialog(sceneId, { preparing: true });
    try {
      const payload = await runPlugin({ mode: "prepare", scene_id: sceneId });
      if (root._abandoned || !root.parentNode) {
        await discardSnapshot(payload.snapshot_id);
        return;
      }
      root._finishPrepare(payload);
    } catch (err) {
      if (root._abandoned || !root.parentNode) {
        return;
      }
      root._showPrepareFailed(err);
    }
  }

  function isSceneDetailPage() {
    return /\/scenes\/\d+/.test(window.location.pathname);
  }

  function operationsMenu() {
    const labelled = document.querySelector('.dropdown-menu[aria-labelledby="operation-menu"]');
    if (labelled) {
      return labelled;
    }
    const toggle = document.getElementById("operation-menu");
    return toggle?.closest(".dropdown")?.querySelector(".dropdown-menu") ?? null;
  }

  function ensureSuggestMenuItem() {
    const legacy = document.getElementById("tag-suggestions-button");
    if (legacy) {
      legacy.remove();
    }

    const existing = document.getElementById("tag-suggestions-menu-item");
    if (!isSceneDetailPage()) {
      if (existing) {
        existing.remove();
      }
      return;
    }

    const menu = operationsMenu();
    if (!menu) {
      return;
    }
    if (existing && existing.parentElement === menu) {
      return;
    }
    if (existing) {
      existing.remove();
    }

    const item = document.createElement("button");
    item.id = "tag-suggestions-menu-item";
    item.type = "button";
    item.className = "dropdown-item bg-secondary text-white";
    item.textContent = "Suggest tags";
    item.addEventListener("click", () => {
      const sceneId = sceneIdFromPath();
      if (sceneId) {
        onSuggestClick(sceneId);
      }
    });
    menu.insertBefore(item, menu.firstChild);
  }

  function installSuggestMenuItem() {
    const observer = new MutationObserver(() => ensureSuggestMenuItem());
    observer.observe(document.body, { childList: true, subtree: true });
    ensureSuggestMenuItem();
  }

  if (document.body) {
    installSuggestMenuItem();
  } else {
    document.addEventListener("DOMContentLoaded", installSuggestMenuItem);
  }

  const pluginApi = typeof PluginApi !== "undefined" ? PluginApi : window.PluginApi;
  if (pluginApi && pluginApi.Event) {
    pluginApi.Event.addEventListener("stash:location", () => {
      const dialog = document.getElementById(DIALOG_ID);
      if (dialog) {
        closeDialog(dialog);
      }
      ensureSuggestMenuItem();
    });
  }
})();
