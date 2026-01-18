(() => {
  const PANEL_ID = 'chat-anchors-panel';
  const EDGE_LAYER_ID = 'chat-anchors-edge-layer';
  const STORAGE_KEY = 'chat_anchors_state_v1';
  const PREVIEW_CHARS = 5;
  const MAX_VISIBLE = 5;
  const HIGHLIGHT_CLASS = 'chat-anchors-highlight';
  const WHEEL_FRICTION = 0.94;
  const WHEEL_SPEED = 0.3;
  const WHEEL_MAX_VELOCITY = 180;
  const SETTLE_DELAY = 160;
  const DRAG_MARGIN = 8;
  const MIN_PANEL_WIDTH = 200;
  const MIN_PANEL_HEIGHT = 220;
  const DRAG_THRESHOLD = 4;
  const EDGE_THRESHOLD = 16;
  const EDGE_HOVER_THRESHOLD = 48;
  const EDGE_GAP = 8;
  const EDGE_DEFAULT = 'right';
  const SCROLL_SYNC_SMOOTH = true;
  const EDGE_ROTATION = {
    right: 0,
    bottom: 90,
    left: 180,
    top: -90
  };
  const EDGE_OPPOSITE = {
    left: 'right',
    right: 'left',
    top: 'bottom',
    bottom: 'top'
  };

  const DEFAULT_STATE = {
    removedByConversation: {},
    panelPosition: null,
    panelSize: null,
    panelCollapsed: false,
    panelCollapsedEdge: EDGE_DEFAULT,
    panelDockRect: null
  };

  let state = { ...DEFAULT_STATE };
  let currentConversationId = '';
  let currentUrl = location.href;
  let updateTimer = null;
  let observer = null;
  let lastSignature = '';
  let lastHighlighted = null;
  let selectedAnchorId = '';
  let listRef = null;
  let edgeSyncRaf = null;
  let edgeSyncTimer = null;
  let scrollSyncRaf = null;
  let visibleAnchorsRef = [];
  const pointerState = {
    x: 0,
    y: 0,
    active: false
  };
  const wheelState = {
    list: null,
    wrap: null,
    scrollTop: 0,
    velocity: 0,
    rafId: null,
    lastTime: 0,
    isPointerDown: false,
    pointerId: null,
    startPointerY: 0,
    lastPointerY: 0,
    lastPointerTime: 0,
    didDrag: false,
    blockClick: false,
    hasCapture: false,
    settleTimer: null
  };

  const storage = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
    ? chrome.storage.local
    : null;

  function loadState() {
    return new Promise((resolve) => {
      if (!storage) {
        resolve();
        return;
      }
      storage.get(STORAGE_KEY, (data) => {
        const saved = data && data[STORAGE_KEY];
        if (saved && typeof saved === 'object') {
          state = {
            ...DEFAULT_STATE,
            ...saved,
            removedByConversation: saved.removedByConversation || {}
          };
        }
        resolve();
      });
    });
  }

  let saveTimer = null;
  function saveState() {
    if (!storage) {
      return;
    }
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      storage.set({ [STORAGE_KEY]: state });
    }, 150);
  }

  function getPlatform() {
    const host = location.host;
    if (host.includes('chat.openai.com') || host.includes('chatgpt.com')) {
      return 'chatgpt';
    }
    if (host.includes('gemini.google.com')) {
      return 'gemini';
    }
    return 'unknown';
  }

  function getConversationId(platform) {
    const path = location.pathname || '/';
    if (platform === 'chatgpt') {
      const match = path.match(/\/(c|conversation|chat)\/([a-zA-Z0-9-]+)/);
      if (match) {
        return `chatgpt:${match[2]}`;
      }
      return `chatgpt:${path}`;
    }
    if (platform === 'gemini') {
      const match = path.match(/\/app\/([a-zA-Z0-9-]+)/);
      if (match) {
        return `gemini:${match[1]}`;
      }
      return `gemini:${path}`;
    }
    return '';
  }

  function normalizeText(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  function getPreview(text, maxChars = PREVIEW_CHARS) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return '';
    }
    const slice = normalized.slice(0, maxChars);
    return normalized.length > maxChars ? `${slice}...` : slice;
  }

  function hashString(input) {
    let hash = 0;
    for (let i = 0; i < input.length; i += 1) {
      hash = ((hash << 5) - hash) + input.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function getNearestEdge(rect) {
    const distances = {
      left: rect.left,
      right: window.innerWidth - rect.right,
      top: rect.top,
      bottom: window.innerHeight - rect.bottom
    };
    let edge = EDGE_DEFAULT;
    let distance = distances[edge];
    Object.keys(distances).forEach((key) => {
      const value = distances[key];
      if (value < distance) {
        distance = value;
        edge = key;
      }
    });
    return { edge, distance };
  }

  function getOppositeEdge(edge) {
    return EDGE_OPPOSITE[edge] || EDGE_DEFAULT;
  }

  function getPanelRect(panel) {
    const rect = panel.getBoundingClientRect();
    const left = parseFloat(panel.style.left);
    const top = parseFloat(panel.style.top);
    const width = parseFloat(panel.style.width);
    const height = parseFloat(panel.style.height);
    const resolvedLeft = Number.isNaN(left) ? rect.left : left;
    const resolvedTop = Number.isNaN(top) ? rect.top : top;
    const resolvedWidth = Number.isNaN(width) ? rect.width : width;
    const resolvedHeight = Number.isNaN(height) ? rect.height : height;
    return {
      left: resolvedLeft,
      top: resolvedTop,
      width: resolvedWidth,
      height: resolvedHeight,
      right: resolvedLeft + resolvedWidth,
      bottom: resolvedTop + resolvedHeight
    };
  }

  function isPointerNearSide(rect, edge, x, y) {
    const range = EDGE_HOVER_THRESHOLD;
    if (edge === 'left') {
      return Math.abs(x - rect.left) <= range && y >= rect.top - range && y <= rect.bottom + range;
    }
    if (edge === 'right') {
      return Math.abs(x - rect.right) <= range && y >= rect.top - range && y <= rect.bottom + range;
    }
    if (edge === 'top') {
      return Math.abs(y - rect.top) <= range && x >= rect.left - range && x <= rect.right + range;
    }
    if (edge === 'bottom') {
      return Math.abs(y - rect.bottom) <= range && x >= rect.left - range && x <= rect.right + range;
    }
    return false;
  }

  function getDockRect(panel) {
    const rect = getPanelRect(panel);
    const stored = state.panelDockRect || {};
    const left = typeof stored.x === 'number' ? stored.x : rect.left;
    const top = typeof stored.y === 'number' ? stored.y : rect.top;
    const width = typeof stored.width === 'number' ? stored.width : rect.width;
    const height = typeof stored.height === 'number' ? stored.height : rect.height;
    return {
      left,
      top,
      width,
      height
    };
  }

  function ensureEdgeLayer() {
    let layer = document.getElementById(EDGE_LAYER_ID);
    if (layer) {
      return layer;
    }
    layer = document.createElement('div');
    layer.id = EDGE_LAYER_ID;
    const icon = `
      <svg class="chat-anchors-edge-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M8 5l8 7-8 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    `;
    layer.innerHTML = `
      <button class="chat-anchors-edge-hide" type="button" aria-label="收起">${icon}</button>
      <button class="chat-anchors-edge-show" type="button" aria-label="展开">${icon}</button>
    `;
    document.body.appendChild(layer);
    return layer;
  }

  function syncEdgeLayer(panel) {
    if (!panel) {
      return;
    }
    const layer = ensureEdgeLayer();
    if (!layer) {
      return;
    }
    const isCollapsed = panel.dataset.collapsed === 'true';
    const rect = getPanelRect(panel);
    let left = rect.left;
    let top = rect.top;
    let width = rect.width;
    let height = rect.height;
    if (isCollapsed) {
      const dockRect = getDockRect(panel);
      const edge = panel.dataset.collapsedEdge || state.panelCollapsedEdge || EDGE_DEFAULT;
      if (edge === 'left' || edge === 'right') {
        width = 0;
        height = dockRect.height;
        top = clamp(dockRect.top, DRAG_MARGIN, window.innerHeight - dockRect.height - DRAG_MARGIN);
        left = edge === 'right' ? window.innerWidth : 0;
      } else {
        width = dockRect.width;
        height = 0;
        left = clamp(dockRect.left, DRAG_MARGIN, window.innerWidth - dockRect.width - DRAG_MARGIN);
        top = edge === 'bottom' ? window.innerHeight : 0;
      }
    }
    layer.style.left = `${left}px`;
    layer.style.top = `${top}px`;
    layer.style.width = `${width}px`;
    layer.style.height = `${height}px`;
    layer.dataset.visible = panel.dataset.visible || 'false';
    layer.dataset.nearEdge = panel.dataset.nearEdge || 'false';
    layer.dataset.edge = panel.dataset.edge || EDGE_DEFAULT;
    layer.dataset.collapsed = panel.dataset.collapsed || 'false';
    layer.dataset.collapsedEdge = panel.dataset.collapsedEdge || state.panelCollapsedEdge || EDGE_DEFAULT;
    layer.dataset.edgeHot = panel.dataset.edgeHot || 'false';
    layer.dataset.dimmed = panel.classList.contains('is-dimmed') && panel.dataset.collapsed !== 'true' ? 'true' : 'false';
    layer.dataset.dragging = panel.dataset.dragging === 'true' ? 'true' : 'false';
  }

  function updateEdgeButtons(panel) {
    if (!panel) {
      return;
    }
    const layer = ensureEdgeLayer();
    if (!layer) {
      return;
    }
    syncEdgeLayer(panel);
    const hideButton = layer.querySelector('.chat-anchors-edge-hide');
    const showButton = layer.querySelector('.chat-anchors-edge-show');
    const edge = layer.dataset.edge || EDGE_DEFAULT;
    const collapsedEdge = layer.dataset.collapsedEdge || state.panelCollapsedEdge || EDGE_DEFAULT;
    if (hideButton) {
      const rotation = EDGE_ROTATION[edge] || 0;
      hideButton.style.setProperty('--edge-rotation', `${rotation}deg`);
    }
    const showEdge = getOppositeEdge(collapsedEdge);
    if (showButton) {
      const rotation = EDGE_ROTATION[showEdge] || 0;
      showButton.style.setProperty('--edge-rotation', `${rotation}deg`);
    }
  }

  function updateEdgeHint(panel) {
    if (!panel) {
      return;
    }
    if (panel.dataset.collapsed === 'true') {
      panel.dataset.nearEdge = 'false';
      setEdgeHot(panel, false);
      updateEdgeButtons(panel);
      return;
    }
    const rect = getPanelRect(panel);
    const { edge, distance } = getNearestEdge(rect);
    panel.dataset.edge = edge;
    panel.dataset.nearEdge = distance <= EDGE_THRESHOLD ? 'true' : 'false';
    const nextHot = pointerState.active ? isEdgeHot(panel, rect, pointerState.x, pointerState.y) : false;
    setEdgeHot(panel, nextHot);
    updateEdgeButtons(panel);
  }

  function isEdgeHot(panel, rect, x, y) {
    if (!panel || panel.dataset.collapsed === 'true' || panel.dataset.nearEdge !== 'true') {
      return false;
    }
    const edge = panel.dataset.edge || EDGE_DEFAULT;
    const hideEdge = getOppositeEdge(edge);
    return isPointerNearSide(rect, hideEdge, x, y);
  }

  function setEdgeHot(panel, next) {
    const value = next ? 'true' : 'false';
    if (panel.dataset.edgeHot !== value) {
      panel.dataset.edgeHot = value;
      return true;
    }
    return false;
  }

  function scheduleEdgeSync(panel) {
    if (!panel) {
      return;
    }
    if (edgeSyncRaf) {
      cancelAnimationFrame(edgeSyncRaf);
    }
    edgeSyncRaf = requestAnimationFrame(() => {
      edgeSyncRaf = null;
      updateEdgeHint(panel);
    });
    if (edgeSyncTimer) {
      clearTimeout(edgeSyncTimer);
    }
    edgeSyncTimer = setTimeout(() => {
      edgeSyncTimer = null;
      updateEdgeHint(panel);
    }, 320);
  }

  function scheduleScrollSync() {
    if (scrollSyncRaf) {
      cancelAnimationFrame(scrollSyncRaf);
    }
    scrollSyncRaf = requestAnimationFrame(() => {
      scrollSyncRaf = null;
      syncPanelToScroll();
    });
  }

  function syncPanelToScroll() {
    if (!visibleAnchorsRef.length) {
      return;
    }
    const panel = document.getElementById(PANEL_ID);
    if (!panel || panel.dataset.visible !== 'true') {
      return;
    }
    if (panel.dataset.dragging === 'true' || wheelState.isPointerDown) {
      return;
    }
    const viewportCenter = window.innerHeight / 2;
    let closest = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    visibleAnchorsRef.forEach((anchor) => {
      if (!anchor || !anchor.scrollEl || typeof anchor.scrollEl.getBoundingClientRect !== 'function') {
        return;
      }
      const rect = anchor.scrollEl.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      const distance = Math.abs(center - viewportCenter);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = anchor;
      }
    });
    if (!closest || !closest.id) {
      return;
    }
    if (closest.id === selectedAnchorId) {
      return;
    }
    setSelectedAnchorId(closest.id);
    scrollListToAnchor(closest.id, !SCROLL_SYNC_SMOOTH);
  }

  function initScrollSync(panel) {
    if (!panel || panel.dataset.scrollSyncReady === 'true') {
      return;
    }
    panel.dataset.scrollSyncReady = 'true';
    window.addEventListener('scroll', (event) => {
      const target = event.target;
      if (target && target.closest && target.closest(`#${PANEL_ID}`)) {
        return;
      }
      scheduleScrollSync();
    }, { passive: true, capture: true });
  }

  function initEdgePointer(panel) {
    if (!panel || panel.dataset.edgePointerReady === 'true') {
      return;
    }
    panel.dataset.edgePointerReady = 'true';
    document.addEventListener('pointermove', (event) => {
      pointerState.x = event.clientX;
      pointerState.y = event.clientY;
      pointerState.active = true;
      if (panel.dataset.visible !== 'true') {
        return;
      }
      const rect = getPanelRect(panel);
      const nextHot = isEdgeHot(panel, rect, pointerState.x, pointerState.y);
      if (setEdgeHot(panel, nextHot)) {
        updateEdgeButtons(panel);
      }
    });
    window.addEventListener('blur', () => {
      pointerState.active = false;
      if (setEdgeHot(panel, false)) {
        updateEdgeButtons(panel);
      }
    });
  }

  function applyCollapsedPosition(panel) {
    if (!panel) {
      return;
    }
    const rect = panel.getBoundingClientRect();
    const edge = panel.dataset.collapsedEdge || state.panelCollapsedEdge || EDGE_DEFAULT;
    let left = rect.left;
    let top = rect.top;
    if (edge === 'right') {
      left = window.innerWidth - DRAG_MARGIN + EDGE_GAP;
      top = clamp(rect.top, DRAG_MARGIN, window.innerHeight - rect.height - DRAG_MARGIN);
    } else if (edge === 'left') {
      left = DRAG_MARGIN - EDGE_GAP - rect.width;
      top = clamp(rect.top, DRAG_MARGIN, window.innerHeight - rect.height - DRAG_MARGIN);
    } else if (edge === 'top') {
      left = clamp(rect.left, DRAG_MARGIN, window.innerWidth - rect.width - DRAG_MARGIN);
      top = DRAG_MARGIN - EDGE_GAP - rect.height;
    } else if (edge === 'bottom') {
      left = clamp(rect.left, DRAG_MARGIN, window.innerWidth - rect.width - DRAG_MARGIN);
      top = window.innerHeight - DRAG_MARGIN + EDGE_GAP;
    }
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function setPanelCollapsed(panel, collapsed) {
    if (!panel) {
      return;
    }
    const isCollapsed = panel.dataset.collapsed === 'true';
    if (collapsed === isCollapsed) {
      return;
    }
    if (collapsed) {
      const rect = panel.getBoundingClientRect();
      state.panelDockRect = {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      };
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      savePanelPosition(panel);
      const { edge } = getNearestEdge(rect);
      const targetEdge = edge || EDGE_DEFAULT;
      panel.dataset.collapsedEdge = targetEdge;
      state.panelCollapsedEdge = targetEdge;
      panel.dataset.collapsed = 'true';
      state.panelCollapsed = true;
      saveState();
      applyCollapsedPosition(panel);
    } else {
      panel.dataset.collapsed = 'false';
      state.panelCollapsed = false;
      saveState();
      applyPanelPosition(panel);
    }
    updateEdgeButtons(panel);
    updateEdgeHint(panel);
    scheduleEdgeSync(panel);
  }

  function getPreviewLimit(panel) {
    if (!panel) {
      return PREVIEW_CHARS;
    }
    const list = panel.querySelector('.chat-anchors-list');
    const width = list ? list.getBoundingClientRect().width : panel.getBoundingClientRect().width;
    const reserved = 82;
    const available = Math.max(80, width - reserved);
    const chars = Math.floor(available / 12);
    return clamp(chars, 4, 18);
  }

  function updatePreviewText(panel, root, limitOverride) {
    if (!panel || !root) {
      return;
    }
    const limit = limitOverride || getPreviewLimit(panel);
    const items = root.querySelectorAll('.chat-anchors-item');
    items.forEach((item) => {
      const fullText = item.dataset.fullText || '';
      const preview = getPreview(fullText, limit);
      const textEl = item.querySelector('.chat-anchors-text');
      if (textEl) {
        textEl.textContent = preview;
      }
    });
  }

  function updateWheelPadding(list) {
    if (!list) {
      return;
    }
    const panel = list.closest(`#${PANEL_ID}`);
    if (!panel) {
      return;
    }
    const styles = getComputedStyle(panel);
    const itemHeight = parseFloat(styles.getPropertyValue('--anchor-item-height')) || 36;
    const itemGap = parseFloat(styles.getPropertyValue('--anchor-item-gap')) || 8;
    const desired = Math.max(0, (list.clientHeight - itemHeight) / 2);
    const minPadding = Math.max(24, itemHeight / 2);
    const targetPadding = Math.max(minPadding, desired - itemGap);
    const nextPadding = Math.max(0, Math.round(targetPadding));
    const current = parseFloat(styles.getPropertyValue('--anchor-wheel-padding')) || 0;
    if (Math.abs(current - nextPadding) > 1) {
      panel.style.setProperty('--anchor-wheel-padding', `${nextPadding}px`);
    }
  }

  let tooltipEl = null;
  let tooltipAnchor = null;
  let tooltipHideTimer = null;

  function ensureTooltip() {
    if (tooltipEl) {
      return tooltipEl;
    }
    const el = document.createElement('div');
    el.className = 'chat-anchors-tooltip';
    el.setAttribute('role', 'tooltip');
    el.dataset.visible = 'false';
    el.hidden = true;
    document.body.appendChild(el);
    tooltipEl = el;
    return el;
  }

  function positionTooltip(anchorItem, tooltip) {
    if (!anchorItem || !tooltip) {
      return;
    }
    const itemRect = anchorItem.getBoundingClientRect();
    const panel = anchorItem.closest(`#${PANEL_ID}`);
    const panelRect = panel ? panel.getBoundingClientRect() : itemRect;
    const maxWidth = Math.min(320, window.innerWidth - 24);
    tooltip.style.maxWidth = `${maxWidth}px`;
    const tooltipRect = tooltip.getBoundingClientRect();

    const preferLeft = panelRect.left - 12 - tooltipRect.width;
    const preferRight = panelRect.right + 12;
    let left = preferLeft;
    if (left < 12) {
      left = preferRight;
    }
    left = clamp(left, 12, window.innerWidth - tooltipRect.width - 12);
    let top = itemRect.top + itemRect.height / 2 - tooltipRect.height / 2;
    top = clamp(top, 12, window.innerHeight - tooltipRect.height - 12);

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function showTooltip(anchorItem, text) {
    if (!text) {
      return;
    }
    const tooltip = ensureTooltip();
    tooltipAnchor = anchorItem;
    if (tooltipHideTimer) {
      clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
    }
    tooltip.textContent = text;
    tooltip.hidden = false;
    tooltip.dataset.visible = 'true';
    requestAnimationFrame(() => {
      positionTooltip(anchorItem, tooltip);
    });
  }

  function hideTooltip() {
    if (!tooltipEl) {
      return;
    }
    tooltipEl.dataset.visible = 'false';
    tooltipHideTimer = setTimeout(() => {
      if (tooltipEl && tooltipEl.dataset.visible === 'false') {
        tooltipEl.hidden = true;
        tooltipAnchor = null;
      }
    }, 160);
  }

  function refreshTooltipPosition() {
    if (!tooltipEl || tooltipEl.hidden || tooltipEl.dataset.visible !== 'true' || !tooltipAnchor) {
      return;
    }
    positionTooltip(tooltipAnchor, tooltipEl);
  }

  function getMaxScroll(list) {
    return Math.max(0, list.scrollHeight - list.clientHeight);
  }

  function getAnchorItem(list, anchorId) {
    if (!list || !anchorId) {
      return null;
    }
    const items = list.querySelectorAll('.chat-anchors-item');
    for (const item of items) {
      if (item.dataset.anchorId === anchorId) {
        return item;
      }
    }
    return null;
  }

  function updateSelectedStyles(list) {
    if (!list) {
      return;
    }
    const items = list.querySelectorAll('.chat-anchors-item');
    items.forEach((item) => {
      item.classList.toggle('is-selected', item.dataset.anchorId === selectedAnchorId);
    });
  }

  function setSelectedAnchorId(anchorId) {
    selectedAnchorId = anchorId || '';
    updateSelectedStyles(listRef);
  }

  function updateWheelTransforms(list) {
    if (!list) {
      return null;
    }
    updateWheelPadding(list);
    const items = list.querySelectorAll('.chat-anchors-item');
    if (!items.length) {
      return null;
    }
    const centerY = list.clientHeight / 2;
    let closest = null;
    let closestDistance = Number.POSITIVE_INFINITY;

    items.forEach((item) => {
      const itemCenter = item.offsetTop - list.scrollTop + item.offsetHeight / 2;
      const offset = itemCenter - centerY;
      const ratio = clamp(offset / centerY, -1, 1);
      const rotate = ratio * 35;
      const translateZ = -Math.abs(ratio) * 70;
      const scale = 1 - Math.abs(ratio) * 0.18;

      item.style.transform = `translateZ(${translateZ}px) rotateX(${rotate}deg) scale(${scale})`;
      item.style.opacity = String(1 - Math.abs(ratio) * 0.45);

      const distance = Math.abs(offset);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = item;
      }
    });

    items.forEach((item) => {
      item.classList.toggle('is-center', item === closest);
    });

    refreshTooltipPosition();
    return closest;
  }

  function centerItemInList(list, item, smooth) {
    if (!list || !item) {
      return;
    }
    const target = item.offsetTop - (list.clientHeight - item.offsetHeight) / 2;
    const maxScroll = getMaxScroll(list);
    const clamped = clamp(target, 0, maxScroll);
    if (Math.abs(list.scrollTop - clamped) < 1) {
      return;
    }
    if (smooth) {
      list.scrollTo({ top: clamped, behavior: 'smooth' });
      wheelState.scrollTop = clamped;
    } else {
      setWheelScrollTop(clamped);
    }
  }

  function snapClosestToCenter(list, smooth) {
    if (!list) {
      return;
    }
    const closest = updateWheelTransforms(list);
    if (!closest) {
      return;
    }
    centerItemInList(list, closest, smooth);
  }

  function scheduleSettleSelection() {
    if (wheelState.settleTimer) {
      clearTimeout(wheelState.settleTimer);
    }
    wheelState.settleTimer = setTimeout(() => {
      if (wheelState.isPointerDown || Math.abs(wheelState.velocity) > 0.2) {
        return;
      }
      const centerItem = updateWheelTransforms(wheelState.list);
      if (centerItem && centerItem.dataset.anchorId && !selectedAnchorId) {
        snapClosestToCenter(wheelState.list, true);
      }
    }, SETTLE_DELAY);
  }

  function setWheelScrollTop(nextValue) {
    const list = wheelState.list;
    if (!list) {
      return;
    }
    updateWheelPadding(list);
    const maxScroll = getMaxScroll(list);
    const clamped = clamp(nextValue, 0, maxScroll);
    wheelState.scrollTop = clamped;
    list.scrollTop = clamped;
    updateFadeState(list, wheelState.wrap);
    updateWheelTransforms(list);
    scheduleSettleSelection();
  }

  function stopWheelAnimation() {
    if (wheelState.rafId) {
      cancelAnimationFrame(wheelState.rafId);
      wheelState.rafId = null;
    }
  }

  function animateWheel(timestamp) {
    const list = wheelState.list;
    if (!list) {
      stopWheelAnimation();
      return;
    }
    if (!wheelState.lastTime) {
      wheelState.lastTime = timestamp;
    }
    const dt = Math.min(32, timestamp - wheelState.lastTime);
    wheelState.lastTime = timestamp;

    if (!wheelState.isPointerDown) {
      wheelState.scrollTop += wheelState.velocity;
      const maxScroll = getMaxScroll(list);
      if (wheelState.scrollTop < 0 || wheelState.scrollTop > maxScroll) {
        const overshoot = wheelState.scrollTop < 0
          ? wheelState.scrollTop
          : wheelState.scrollTop - maxScroll;
        wheelState.velocity -= overshoot * 0.12;
        wheelState.scrollTop = clamp(wheelState.scrollTop, 0, maxScroll);
      }
      setWheelScrollTop(wheelState.scrollTop);
      wheelState.velocity *= Math.pow(WHEEL_FRICTION, dt / 16.67);
    }

    if (Math.abs(wheelState.velocity) < 0.12 && !wheelState.isPointerDown) {
      wheelState.velocity = 0;
      stopWheelAnimation();
      scheduleSettleSelection();
      return;
    }
    wheelState.rafId = requestAnimationFrame(animateWheel);
  }

  function startWheelAnimation() {
    if (wheelState.rafId) {
      return;
    }
    wheelState.lastTime = 0;
    wheelState.rafId = requestAnimationFrame(animateWheel);
  }

  function handleWheelEvent(event) {
    if (!wheelState.list) {
      return;
    }
    event.preventDefault();
    wheelState.velocity = clamp(
      wheelState.velocity + event.deltaY * WHEEL_SPEED,
      -WHEEL_MAX_VELOCITY,
      WHEEL_MAX_VELOCITY
    );
    startWheelAnimation();
  }

  function handlePointerDown(event) {
    if (!wheelState.list || event.button !== 0) {
      return;
    }
    if (event.target.closest('.chat-anchors-action')) {
      return;
    }
    wheelState.isPointerDown = true;
    wheelState.pointerId = event.pointerId;
    wheelState.startPointerY = event.clientY;
    wheelState.lastPointerY = event.clientY;
    wheelState.lastPointerTime = performance.now();
    wheelState.didDrag = false;
    wheelState.blockClick = false;
    wheelState.hasCapture = false;
    wheelState.velocity = 0;
    stopWheelAnimation();
  }

  function handlePointerMove(event) {
    if (!wheelState.isPointerDown || event.pointerId !== wheelState.pointerId || !wheelState.list) {
      return;
    }
    const totalDelta = event.clientY - wheelState.startPointerY;
    if (!wheelState.didDrag && Math.abs(totalDelta) < DRAG_THRESHOLD) {
      return;
    }
    if (!wheelState.didDrag) {
      wheelState.didDrag = true;
      wheelState.blockClick = true;
      wheelState.hasCapture = true;
      wheelState.list.setPointerCapture(event.pointerId);
      wheelState.lastPointerY = event.clientY;
      wheelState.lastPointerTime = performance.now();
      return;
    }
    const now = performance.now();
    const deltaY = event.clientY - wheelState.lastPointerY;
    const deltaTime = Math.max(8, now - wheelState.lastPointerTime);
    wheelState.lastPointerY = event.clientY;
    wheelState.lastPointerTime = now;
    setWheelScrollTop(wheelState.scrollTop - deltaY);
    wheelState.velocity = clamp((-deltaY / deltaTime) * 16, -WHEEL_MAX_VELOCITY, WHEEL_MAX_VELOCITY);
    event.preventDefault();
  }

  function handlePointerUp(event) {
    if (!wheelState.isPointerDown || event.pointerId !== wheelState.pointerId) {
      return;
    }
    wheelState.isPointerDown = false;
    wheelState.pointerId = null;
    if (wheelState.list && wheelState.hasCapture) {
      wheelState.list.releasePointerCapture(event.pointerId);
      wheelState.hasCapture = false;
    }
    if (wheelState.didDrag) {
      wheelState.blockClick = true;
      setTimeout(() => {
        wheelState.blockClick = false;
      }, 200);
    }
    if (wheelState.didDrag && Math.abs(wheelState.velocity) > 0.2) {
      startWheelAnimation();
    } else {
      scheduleSettleSelection();
    }
  }

  function initWheel(list, wrap) {
    if (!list || list.dataset.wheelReady === 'true') {
      return;
    }
    list.dataset.wheelReady = 'true';
    list.style.touchAction = 'none';
    wheelState.list = list;
    wheelState.wrap = wrap;

    list.addEventListener('wheel', handleWheelEvent, { passive: false });
    list.addEventListener('pointerdown', handlePointerDown, { passive: false });
    list.addEventListener('pointermove', handlePointerMove, { passive: false });
    list.addEventListener('pointerup', handlePointerUp);
    list.addEventListener('pointercancel', handlePointerUp);
    list.addEventListener('click', (event) => {
      if (wheelState.blockClick) {
        event.preventDefault();
        event.stopPropagation();
        wheelState.blockClick = false;
      }
    });

    list.addEventListener('scroll', () => {
      wheelState.scrollTop = list.scrollTop;
      updateFadeState(list, wrap);
      updateWheelTransforms(list);
      scheduleSettleSelection();
    });
  }

  function scrollListToAnchor(anchorId, immediate = false) {
    const list = wheelState.list || listRef;
    if (!list) {
      return;
    }
    updateWheelPadding(list);
    const item = getAnchorItem(list, anchorId);
    if (!item) {
      return;
    }
    wheelState.velocity = 0;
    stopWheelAnimation();
    const target = item.offsetTop - (list.clientHeight - item.offsetHeight) / 2;
    const maxScroll = getMaxScroll(list);
    const clamped = clamp(target, 0, maxScroll);
    if (immediate) {
      setWheelScrollTop(clamped);
      return;
    }
    list.scrollTo({ top: clamped, behavior: 'smooth' });
    wheelState.scrollTop = clamped;
    updateWheelTransforms(list);
  }

  function applyPanelPosition(panel) {
    const maxWidth = window.innerWidth - DRAG_MARGIN * 2;
    const maxHeight = window.innerHeight - DRAG_MARGIN * 2;
    if (state.panelSize && typeof state.panelSize.width === 'number' && typeof state.panelSize.height === 'number') {
      const width = clamp(state.panelSize.width, MIN_PANEL_WIDTH, maxWidth);
      const height = clamp(state.panelSize.height, MIN_PANEL_HEIGHT, maxHeight);
      panel.style.width = `${width}px`;
      panel.style.height = `${height}px`;
    }
    if (!state.panelPosition || typeof state.panelPosition.x !== 'number' || typeof state.panelPosition.y !== 'number') {
      return;
    }
    const rect = panel.getBoundingClientRect();
    const left = clamp(state.panelPosition.x, DRAG_MARGIN, window.innerWidth - rect.width - DRAG_MARGIN);
    const top = clamp(state.panelPosition.y, DRAG_MARGIN, window.innerHeight - rect.height - DRAG_MARGIN);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function savePanelPosition(panel) {
    const left = parseFloat(panel.style.left);
    const top = parseFloat(panel.style.top);
    if (Number.isNaN(left) || Number.isNaN(top)) {
      return;
    }
    state.panelPosition = { x: left, y: top };
    saveState();
  }

  function savePanelSize(panel) {
    if (!panel.style.width && !panel.style.height) {
      return;
    }
    const rect = panel.getBoundingClientRect();
    state.panelSize = {
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
    saveState();
  }

  function initResizeObserver(panel, list, wrap) {
    if (panel.dataset.resizeObserverReady === 'true' || typeof ResizeObserver === 'undefined') {
      return;
    }
    panel.dataset.resizeObserverReady = 'true';
    const observer = new ResizeObserver(() => {
      panel.classList.toggle('is-resized', Boolean(panel.style.width || panel.style.height));
      updateWheelPadding(list);
      updateWheelTransforms(list);
      updateFadeState(list, wrap);
      updatePreviewText(panel, list);
      const hiddenList = panel.querySelector('.chat-anchors-hidden-list');
      if (hiddenList) {
        updatePreviewText(panel, hiddenList);
      }
      if (panel.dataset.collapsed === 'true') {
        applyCollapsedPosition(panel);
      }
      updateEdgeHint(panel);
      savePanelSize(panel);
    });
    observer.observe(panel);
  }

  function initPanelFocus(panel) {
    if (panel.dataset.focusReady === 'true') {
      return;
    }
    panel.dataset.focusReady = 'true';

    const setFocused = (focused) => {
      if (!focused && panel.dataset.dragging === 'true') {
        return;
      }
      panel.classList.toggle('is-dimmed', !focused);
      updateEdgeButtons(panel);
    };

    panel.addEventListener('mouseenter', () => setFocused(true));
    panel.addEventListener('mouseleave', () => setFocused(false));
    panel.addEventListener('focusin', () => setFocused(true));
    panel.addEventListener('focusout', () => {
      if (!panel.matches(':hover')) {
        setFocused(false);
      }
    });

    setFocused(false);
  }

  function initEdgeControls(panel) {
    if (panel.dataset.edgeReady === 'true') {
      return;
    }
    panel.dataset.edgeReady = 'true';
    const layer = ensureEdgeLayer();
    if (!layer) {
      return;
    }
    const hideButton = layer.querySelector('.chat-anchors-edge-hide');
    const showButton = layer.querySelector('.chat-anchors-edge-show');
    if (hideButton) {
      hideButton.addEventListener('click', (event) => {
        event.stopPropagation();
        setPanelCollapsed(panel, true);
      });
    }
    if (showButton) {
      showButton.addEventListener('click', (event) => {
        event.stopPropagation();
        setPanelCollapsed(panel, false);
      });
    }
  }

  function initDrag(panel) {
    if (panel.dataset.dragReady === 'true') {
      return;
    }
    panel.dataset.dragReady = 'true';
    const handle = panel.querySelector('.chat-anchors-header');
    if (!handle) {
      return;
    }
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let panelWidth = 0;
    let panelHeight = 0;
    let dragPointerId = null;

    const onPointerMove = (event) => {
      if (!dragging) {
        return;
      }
      const nextLeft = clamp(startLeft + (event.clientX - startX), DRAG_MARGIN, window.innerWidth - panelWidth - DRAG_MARGIN);
      const nextTop = clamp(startTop + (event.clientY - startY), DRAG_MARGIN, window.innerHeight - panelHeight - DRAG_MARGIN);
      panel.style.left = `${nextLeft}px`;
      panel.style.top = `${nextTop}px`;
      updateEdgeHint(panel);
    };

    const endDrag = () => {
      if (!dragging) {
        return;
      }
      dragging = false;
      panel.dataset.dragging = 'false';
      savePanelPosition(panel);
      if (!panel.matches(':hover')) {
        panel.classList.add('is-dimmed');
      }
      updateEdgeHint(panel);
      if (dragPointerId !== null) {
        try {
          handle.releasePointerCapture(dragPointerId);
        } catch (error) {
          // Ignore if capture already released.
        }
        dragPointerId = null;
      }
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', endDrag);
      document.removeEventListener('pointercancel', endDrag);
    };

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }
      if (panel.dataset.collapsed === 'true') {
        return;
      }
      const rect = panel.getBoundingClientRect();
      panelWidth = rect.width;
      panelHeight = rect.height;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      panel.style.left = `${startLeft}px`;
      panel.style.top = `${startTop}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      dragging = true;
      panel.dataset.dragging = 'true';
      panel.classList.remove('is-dimmed');
      updateEdgeHint(panel);
      dragPointerId = event.pointerId;
      handle.setPointerCapture(event.pointerId);
      document.addEventListener('pointermove', onPointerMove, { passive: false });
      document.addEventListener('pointerup', endDrag);
      document.addEventListener('pointercancel', endDrag);
    });
  }

  function getStableId({ turnEl, messageEl, index, text }) {
    const candidates = [];
    if (messageEl) {
      candidates.push(
        messageEl.getAttribute('data-message-id'),
        messageEl.getAttribute('data-id'),
        messageEl.id
      );
    }
    if (turnEl) {
      candidates.push(
        turnEl.getAttribute('data-message-id'),
        turnEl.getAttribute('data-id'),
        turnEl.id
      );
    }
    const found = candidates.find((value) => value && value.trim());
    if (found) {
      return found.trim();
    }
    return `${hashString(text)}-${index}`;
  }

  function extractTextFromElement(el) {
    if (!el) {
      return '';
    }
    const text = el.innerText || el.textContent || '';
    return normalizeText(text);
  }

  function findChatGPTAnchors() {
    const anchors = [];
    const turnEls = Array.from(document.querySelectorAll('[data-testid="conversation-turn"]'));
    if (turnEls.length) {
      turnEls.forEach((turnEl) => {
        const userEl = turnEl.querySelector('[data-message-author-role="user"]');
        if (!userEl) {
          return;
        }
        const textEl = userEl.querySelector('.whitespace-pre-wrap, .text-base, .markdown') || userEl;
        const text = extractTextFromElement(textEl);
        if (!text) {
          return;
        }
        anchors.push({
          turnEl,
          userEl,
          text
        });
      });
    } else {
      const userEls = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
      userEls.forEach((userEl) => {
        const textEl = userEl.querySelector('.whitespace-pre-wrap, .text-base, .markdown') || userEl;
        const text = extractTextFromElement(textEl);
        if (!text) {
          return;
        }
        anchors.push({
          turnEl: userEl.closest('article') || userEl,
          userEl,
          text
        });
      });
    }
    return anchors.map((anchor, idx) => {
      const index = idx + 1;
      return {
        id: getStableId({
          turnEl: anchor.turnEl,
          messageEl: anchor.userEl,
          index,
          text: anchor.text
        }),
        index,
        text: anchor.text,
        scrollEl: anchor.turnEl || anchor.userEl,
        highlightEl: anchor.userEl || anchor.turnEl
      };
    });
  }

  function findGeminiAnchors() {
    const anchors = [];
    const container = document.querySelector('main') || document.body;
    const turnSelectors = '[data-test-id="conversation-turn"], [data-testid="conversation-turn"]';
    const turnEls = Array.from(container.querySelectorAll(turnSelectors));
    const userSelectors = [
      '[data-test-id="user-message"]',
      '[data-testid="user-message"]',
      '[data-test-id="user-query"]',
      '[data-testid="user-query"]',
      '[data-test-id="query-text"]',
      'div[class*="user-message"]',
      'div[class*="userMessage"]',
      'div[class*="user-query"]',
      'div[class*="userQuery"]'
    ].join(',');

    if (turnEls.length) {
      turnEls.forEach((turnEl) => {
        const userEl = turnEl.querySelector(userSelectors) || turnEl.querySelector('[aria-label="You"], [aria-label="User"]');
        if (!userEl) {
          return;
        }
        const text = extractTextFromElement(userEl);
        if (!text) {
          return;
        }
        anchors.push({
          turnEl,
          userEl,
          text
        });
      });
    } else {
      const userEls = Array.from(container.querySelectorAll(userSelectors));
      userEls.forEach((userEl) => {
        if (userEl.closest('form') || userEl.closest('[contenteditable="true"]')) {
          return;
        }
        const text = extractTextFromElement(userEl);
        if (!text) {
          return;
        }
        anchors.push({
          turnEl: userEl.closest('article') || userEl,
          userEl,
          text
        });
      });
    }

    return anchors.map((anchor, idx) => {
      const index = idx + 1;
      return {
        id: getStableId({
          turnEl: anchor.turnEl,
          messageEl: anchor.userEl,
          index,
          text: anchor.text
        }),
        index,
        text: anchor.text,
        scrollEl: anchor.turnEl || anchor.userEl,
        highlightEl: anchor.userEl || anchor.turnEl
      };
    });
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) {
      listRef = panel.querySelector('.chat-anchors-list');
      panel.querySelectorAll('.chat-anchors-edge-hide, .chat-anchors-edge-show').forEach((el) => el.remove());
      panel.dataset.nearEdge = panel.dataset.nearEdge || 'false';
      panel.dataset.edge = panel.dataset.edge || state.panelCollapsedEdge || EDGE_DEFAULT;
      panel.dataset.edgeHot = panel.dataset.edgeHot || 'false';
      panel.dataset.collapsed = state.panelCollapsed ? 'true' : 'false';
      panel.dataset.collapsedEdge = state.panelCollapsedEdge || EDGE_DEFAULT;
      updateEdgeButtons(panel);
      initEdgePointer(panel);
      initScrollSync(panel);
      initEdgeControls(panel);
      if (panel.dataset.collapsed === 'true') {
        applyCollapsedPosition(panel);
      }
      updateEdgeHint(panel);
      return panel;
    }

    panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="chat-anchors-header">
        <div class="chat-anchors-title">对话目录</div>
        <div class="chat-anchors-subtitle">共 <span data-role="anchor-count">0</span> 轮</div>
      </div>
      <div class="chat-anchors-list-wrap" data-has-top="false" data-has-bottom="false">
        <div class="chat-anchors-center" aria-hidden="true"></div>
        <div class="chat-anchors-list" role="list"></div>
      </div>
      <button class="chat-anchors-hidden-toggle" type="button" aria-expanded="false" hidden>
        已隐藏 <span data-role="hidden-count">0</span>
      </button>
      <div class="chat-anchors-hidden-list" role="list" hidden></div>
    `;
    document.body.appendChild(panel);
    panel.dataset.nearEdge = 'false';
    panel.dataset.edge = state.panelCollapsedEdge || EDGE_DEFAULT;
    panel.dataset.edgeHot = 'false';
    panel.dataset.collapsed = state.panelCollapsed ? 'true' : 'false';
    panel.dataset.collapsedEdge = state.panelCollapsedEdge || EDGE_DEFAULT;
    updateEdgeButtons(panel);

    const toggle = panel.querySelector('.chat-anchors-hidden-toggle');
    const hiddenList = panel.querySelector('.chat-anchors-hidden-list');
    if (toggle && hiddenList) {
      toggle.addEventListener('click', () => {
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!expanded));
        hiddenList.hidden = expanded;
      });
    }

    const list = panel.querySelector('.chat-anchors-list');
    const listWrap = panel.querySelector('.chat-anchors-list-wrap');
    listRef = list;
    if (list && listWrap) {
      initWheel(list, listWrap);
      initPanelFocus(panel);
      initEdgePointer(panel);
      initScrollSync(panel);
      initEdgeControls(panel);
      initDrag(panel);
      initResizeObserver(panel, list, listWrap);
      requestAnimationFrame(() => {
        applyPanelPosition(panel);
        if (panel.dataset.collapsed === 'true') {
          applyCollapsedPosition(panel);
        }
        panel.classList.toggle('is-resized', Boolean(panel.style.width || panel.style.height));
        updateWheelPadding(list);
        updateWheelTransforms(list);
        updateFadeState(list, listWrap);
        updatePreviewText(panel, list);
        updateEdgeHint(panel);
      });
      if (panel.dataset.resizeReady !== 'true') {
        panel.dataset.resizeReady = 'true';
        window.addEventListener('resize', () => {
          applyPanelPosition(panel);
          if (panel.dataset.collapsed === 'true') {
            applyCollapsedPosition(panel);
          }
          updateWheelPadding(list);
          updateWheelTransforms(list);
          updateFadeState(list, listWrap);
          updatePreviewText(panel, list);
          const hiddenList = panel.querySelector('.chat-anchors-hidden-list');
          if (hiddenList) {
            updatePreviewText(panel, hiddenList);
          }
          updateEdgeHint(panel);
        });
      }
    }

    return panel;
  }

  function updateFadeState(list, wrap) {
    if (!list || !wrap) {
      return;
    }
    const hasTop = list.scrollTop > 2;
    const hasBottom = list.scrollTop + list.clientHeight < list.scrollHeight - 2;
    wrap.dataset.hasTop = String(hasTop);
    wrap.dataset.hasBottom = String(hasBottom);
  }

  function clearList(listEl) {
    while (listEl.firstChild) {
      listEl.removeChild(listEl.firstChild);
    }
  }

  function renderAnchorItem(anchor, { onClick, onAction, actionLabel, actionTitle }) {
    const item = document.createElement('div');
    item.className = 'chat-anchors-item';
    item.dataset.anchorId = anchor.id;
    item.dataset.fullText = anchor.text || '';
    item.setAttribute('role', 'button');
    item.tabIndex = 0;

    const index = document.createElement('span');
    index.className = 'chat-anchors-index';
    index.textContent = String(anchor.index);

    const text = document.createElement('span');
    text.className = 'chat-anchors-text';
    text.textContent = anchor.preview || '';

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'chat-anchors-action';
    action.textContent = actionLabel;
    action.title = actionTitle || '';
    if (actionTitle) {
      action.setAttribute('aria-label', actionTitle);
    }

    action.addEventListener('click', (event) => {
      event.stopPropagation();
      onAction(anchor.id);
    });

    item.addEventListener('click', () => onClick(anchor));
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onClick(anchor);
      }
    });
    item.addEventListener('mouseenter', () => showTooltip(item, anchor.text || ''));
    item.addEventListener('mouseleave', hideTooltip);
    item.addEventListener('focus', () => showTooltip(item, anchor.text || ''));
    item.addEventListener('blur', hideTooltip);

    item.append(index, text, action);
    return item;
  }

  function renderPanel({ anchors, hiddenAnchors, totalCount }) {
    const panel = ensurePanel();
    const list = panel.querySelector('.chat-anchors-list');
    const listWrap = panel.querySelector('.chat-anchors-list-wrap');
    const hiddenToggle = panel.querySelector('.chat-anchors-hidden-toggle');
    const hiddenList = panel.querySelector('.chat-anchors-hidden-list');
    const countEl = panel.querySelector('[data-role="anchor-count"]');
    const hiddenCountEl = panel.querySelector('[data-role="hidden-count"]');

    if (!list || !listWrap || !hiddenToggle || !hiddenList || !countEl || !hiddenCountEl) {
      return;
    }

    wheelState.list = list;
    wheelState.wrap = listWrap;
    countEl.textContent = String(totalCount);

    const previousScrollTop = list.scrollTop;
    updateWheelPadding(list);
    const previewLimit = getPreviewLimit(panel);

    clearList(list);
    anchors.forEach((anchor) => {
      const preview = getPreview(anchor.text || '', previewLimit);
      const anchorData = {
        ...anchor,
        preview
      };
      const item = renderAnchorItem(anchorData, {
        onClick: scrollToAnchor,
        onAction: hideAnchor,
        actionLabel: 'X',
        actionTitle: '隐藏锚点'
      });
      list.appendChild(item);
    });

    if (totalCount > MAX_VISIBLE) {
      listWrap.classList.add('is-scrollable');
    } else {
      listWrap.classList.remove('is-scrollable');
    }

    const anchorIds = new Set(anchors.map((anchor) => anchor.id));
    if (selectedAnchorId && !anchorIds.has(selectedAnchorId)) {
      selectedAnchorId = '';
    }

    updateSelectedStyles(list);

    if (selectedAnchorId) {
      scrollListToAnchor(selectedAnchorId, true);
    } else {
      setWheelScrollTop(Math.min(previousScrollTop, getMaxScroll(list)));
    }

    updateWheelTransforms(list);
    updateFadeState(list, listWrap);

    clearList(hiddenList);
    if (hiddenAnchors.length) {
      hiddenToggle.hidden = false;
      hiddenCountEl.textContent = String(hiddenAnchors.length);
      hiddenAnchors.forEach((anchor) => {
        const preview = getPreview(anchor.text || '', previewLimit);
        const anchorData = {
          ...anchor,
          preview
        };
        const item = renderAnchorItem(anchorData, {
          onClick: scrollToAnchor,
          onAction: restoreAnchor,
          actionLabel: '↩',
          actionTitle: '撤销隐藏'
        });
        item.classList.add('is-hidden');
        hiddenList.appendChild(item);
      });
    } else {
      hiddenToggle.hidden = true;
      hiddenToggle.setAttribute('aria-expanded', 'false');
      hiddenList.hidden = true;
      hiddenCountEl.textContent = '0';
    }

    panel.dataset.visible = 'true';
    updateEdgeHint(panel);
  }

  function hidePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) {
      panel.dataset.visible = 'false';
      updateEdgeButtons(panel);
    }
    visibleAnchorsRef = [];
    hideTooltip();
  }

  function scrollToAnchor(anchor) {
    if (!anchor || !anchor.scrollEl) {
      return;
    }
    hideTooltip();
    if (anchor.id) {
      setSelectedAnchorId(anchor.id);
      scrollListToAnchor(anchor.id);
    }
    anchor.scrollEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    highlightElement(anchor.highlightEl || anchor.scrollEl);
  }

  function highlightElement(element) {
    if (!element) {
      return;
    }
    if (lastHighlighted && lastHighlighted !== element) {
      lastHighlighted.classList.remove(HIGHLIGHT_CLASS);
    }
    element.classList.remove(HIGHLIGHT_CLASS);
    void element.offsetHeight;
    element.classList.add(HIGHLIGHT_CLASS);
    lastHighlighted = element;
    setTimeout(() => {
      element.classList.remove(HIGHLIGHT_CLASS);
    }, 1600);
  }

  function hideAnchor(anchorId) {
    if (!currentConversationId) {
      return;
    }
    const removed = state.removedByConversation[currentConversationId] || {};
    removed[anchorId] = true;
    state.removedByConversation[currentConversationId] = removed;
    saveState();
    scheduleUpdate(true);
  }

  function restoreAnchor(anchorId) {
    if (!currentConversationId) {
      return;
    }
    const removed = state.removedByConversation[currentConversationId] || {};
    if (removed[anchorId]) {
      delete removed[anchorId];
      state.removedByConversation[currentConversationId] = removed;
      saveState();
      scheduleUpdate(true);
    }
  }

  function scheduleUpdate(force = false) {
    if (updateTimer) {
      clearTimeout(updateTimer);
    }
    updateTimer = setTimeout(() => {
      updateTimer = null;
      updateAnchors(force);
    }, 200);
  }

  function updateAnchors(force = false) {
    const platform = getPlatform();
    if (platform === 'unknown') {
      hidePanel();
      return;
    }

    const anchors = platform === 'chatgpt'
      ? findChatGPTAnchors()
      : findGeminiAnchors();

    if (!anchors.length) {
      hidePanel();
      return;
    }

    const conversationId = getConversationId(platform);
    if (!conversationId) {
      hidePanel();
      return;
    }

    if (currentConversationId && currentConversationId !== conversationId) {
      selectedAnchorId = '';
    }
    currentConversationId = conversationId;

    const allIds = new Set(anchors.map((anchor) => anchor.id));
    const existingRemoved = state.removedByConversation[conversationId] || {};
    const cleanedRemoved = {};
    let removedChanged = false;
    Object.keys(existingRemoved).forEach((id) => {
      if (allIds.has(id)) {
        cleanedRemoved[id] = true;
      } else {
        removedChanged = true;
      }
    });
    if (removedChanged) {
      state.removedByConversation[conversationId] = cleanedRemoved;
      saveState();
    }

    const removed = removedChanged ? cleanedRemoved : existingRemoved;
    const visibleAnchors = anchors.filter((anchor) => !removed[anchor.id]);
    const hiddenAnchors = anchors.filter((anchor) => removed[anchor.id]);
    visibleAnchorsRef = visibleAnchors;

    const signature = `${conversationId}|${anchors.map((anchor) => anchor.id).join(',')}|${Object.keys(removed).join(',')}`;
    if (!force && signature === lastSignature) {
      return;
    }
    lastSignature = signature;

    renderPanel({
      anchors: visibleAnchors,
      hiddenAnchors,
      totalCount: anchors.length
    });
    scheduleScrollSync();
  }

  function handleUrlChange() {
    if (currentUrl !== location.href) {
      currentUrl = location.href;
      lastSignature = '';
      scheduleUpdate(true);
      attachObserver();
    }
  }

  function attachObserver() {
    const root = document.querySelector('main') || document.body;
    if (observer) {
      observer.disconnect();
    }
    observer = new MutationObserver(() => {
      scheduleUpdate();
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  function initHistoryWatcher() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      handleUrlChange();
    };

    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      handleUrlChange();
    };

    window.addEventListener('popstate', () => {
      handleUrlChange();
    });
  }

  function init() {
    loadState().then(() => {
      ensurePanel();
      initHistoryWatcher();
      attachObserver();
      scheduleUpdate(true);
    });
  }

  init();
})();
