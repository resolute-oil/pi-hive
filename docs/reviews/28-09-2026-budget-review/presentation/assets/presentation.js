// Budget Refactor Presentation — interactive layer
// - Persists checkbox state to localStorage
// - Highlights active sidebar link on scroll
// - Resets state on demand
// - Renders Mermaid diagrams via CDN

(function () {
  'use strict';

  const STORAGE_KEY = 'pi-hive-budget-refactor-checklist-v1';

  // ------------------------------------------------------------------
  // Checkbox persistence
  // ------------------------------------------------------------------

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // ignore quota errors
    }
  }

  function applyState() {
    const state = loadState();
    const checkboxes = document.querySelectorAll('input[type="checkbox"][data-id]');
    checkboxes.forEach((cb) => {
      const id = cb.getAttribute('data-id');
      const checked = state[id] === true;
      cb.checked = checked;
      cb.closest('.checklist-item, .feature-block')?.classList.toggle('checked', checked);
    });
    updateProgress();
  }

  function updateProgress() {
    const all = document.querySelectorAll('input[type="checkbox"][data-id]');
    const checked = document.querySelectorAll('input[type="checkbox"][data-id]:checked');
    const features = document.querySelectorAll('.feature-block');
    const featuresDone = Array.from(features).filter((fb) => {
      const boxes = fb.querySelectorAll('input[type="checkbox"][data-id]');
      return boxes.length > 0 && Array.from(boxes).every((b) => b.checked);
    });

    const counter = document.getElementById('progress-counter');
    if (counter) {
      counter.textContent = `${checked.length}/${all.length} tasks (${featuresDone.length}/${features.length} features)`;
    }

    // Mark completed features visually
    features.forEach((fb) => {
      const boxes = fb.querySelectorAll('input[type="checkbox"][data-id]');
      const allChecked = boxes.length > 0 && Array.from(boxes).every((b) => b.checked);
      fb.classList.toggle('feature-complete', allChecked);
    });
  }

  function attachCheckboxHandlers() {
    const checkboxes = document.querySelectorAll('input[type="checkbox"][data-id]');
    checkboxes.forEach((cb) => {
      cb.addEventListener('change', () => {
        const state = loadState();
        const id = cb.getAttribute('data-id');
        state[id] = cb.checked;
        saveState(state);
        cb.closest('.checklist-item, .feature-block')?.classList.toggle('checked', cb.checked);
        updateProgress();
      });
    });
  }

  // ------------------------------------------------------------------
  // Reset
  // ------------------------------------------------------------------

  function resetState() {
    if (!confirm('Reset all checkboxes? This cannot be undone.')) return;
    localStorage.removeItem(STORAGE_KEY);
    document.querySelectorAll('input[type="checkbox"][data-id]').forEach((cb) => {
      cb.checked = false;
      cb.closest('.checklist-item, .feature-block')?.classList.remove('checked');
    });
    updateProgress();
  }

  // ------------------------------------------------------------------
  // Sidebar active state (intersection observer)
  // ------------------------------------------------------------------

  function attachNavObserver() {
    const sections = document.querySelectorAll('.page[id]');
    const links = document.querySelectorAll('.sidebar-nav a[href^="#"]');
    if (sections.length === 0 || links.length === 0) return;

    const linkMap = new Map();
    links.forEach((link) => {
      const id = link.getAttribute('href').slice(1);
      linkMap.set(id, link);
    });

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const id = entry.target.id;
            links.forEach((link) => link.classList.remove('active'));
            const link = linkMap.get(id);
            if (link) link.classList.add('active');
          }
        });
      },
      { rootMargin: '-20% 0px -75% 0px', threshold: 0 }
    );

    sections.forEach((section) => observer.observe(section));
  }

  // ------------------------------------------------------------------
  // Mermaid
  // ------------------------------------------------------------------

  function renderMermaid() {
    if (typeof mermaid === 'undefined') return;
    mermaid.initialize({
      startOnLoad: true,
      theme: 'neutral',
      themeVariables: {
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
        fontSize: '13px',
      },
      securityLevel: 'loose',
    });
  }

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------

  function init() {
    attachCheckboxHandlers();
    applyState();
    attachNavObserver();

    const resetBtn = document.getElementById('reset-state');
    if (resetBtn) resetBtn.addEventListener('click', resetState);

    if (typeof mermaid !== 'undefined') {
      renderMermaid();
    } else if (document.querySelector('.mermaid')) {
      // mermaid not loaded yet — wait for it
      const check = setInterval(() => {
        if (typeof mermaid !== 'undefined') {
          clearInterval(check);
          renderMermaid();
        }
      }, 100);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();