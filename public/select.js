// Greenlight dropdowns: every <select> gets a button in the app's style and a list that opens right below it.
// The real <select> stays in the page (hidden), so forms and app code keep reading .value and 'change' as before.
// On phones the system picker is easier to use, so there the <select> is only restyled (see styles.css).

(() => {
  if (!window.matchMedia('(pointer: fine)').matches) return;

  // Setting .value or .selectedIndex from code updates the button too.
  for (const prop of ['value', 'selectedIndex']) {
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    Object.defineProperty(HTMLSelectElement.prototype, prop, {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, v); if (this._dd) this._dd.sync(); },
    });
  }

  let current = null; // the dropdown that is open

  function enhance(select) {
    if (select._dd || select.multiple) return;
    // Full width where the <select> was (forms, dialogs, grid cells); otherwise as wide as its text.
    const width = getComputedStyle(select).width;
    const wide = Boolean(select.closest('.dialog, .field, .step-row, .demo-view'))
      || (width !== 'auto' && width === getComputedStyle(select.parentElement).width);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `dd-button${wide ? ' dd-wide' : ''}${select.classList.contains('ws-select') ? ' ws-select' : ''}`;
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    const label = select.getAttribute('aria-label') || (select.id && document.querySelector(`label[for="${select.id}"]`)?.textContent.trim());
    if (label) button.setAttribute('aria-label', label);
    const text = document.createElement('span');
    text.className = 'dd-text';
    button.append(text);
    select.classList.add('dd-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.after(button);

    const list = document.createElement('ul');
    list.className = 'dd-list';
    list.setAttribute('role', 'listbox');
    if (label) list.setAttribute('aria-label', label);
    let active = -1;

    function sync() {
      const opt = select.options[select.selectedIndex];
      text.textContent = opt ? opt.textContent : '';
      button.disabled = select.disabled;
      button.hidden = select.hidden;
    }

    function options() { return [...select.options].filter((o) => !o.hidden); }

    function render() {
      list.replaceChildren(...options().map((o, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.textContent = o.textContent;
        li.className = 'dd-option';
        if (o.selected) { li.setAttribute('aria-selected', 'true'); active = i; }
        if (o.disabled) li.setAttribute('aria-disabled', 'true');
        li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus on the button
        li.addEventListener('click', () => choose(i));
        li.addEventListener('mousemove', () => highlight(i));
        return li;
      }));
      highlight(active);
    }

    function highlight(i) {
      const items = list.children;
      if (!items.length) return;
      active = Math.max(0, Math.min(items.length - 1, i));
      [...items].forEach((li, j) => li.classList.toggle('dd-active', j === active));
      items[active].scrollIntoView({ block: 'nearest' });
    }

    function place() {
      const r = button.getBoundingClientRect();
      list.style.minWidth = `${r.width}px`;
      list.style.left = `${Math.min(r.left, window.innerWidth - list.offsetWidth - 8)}px`;
      const below = window.innerHeight - r.bottom - 8;
      const above = r.top - 8;
      const height = Math.min(list.scrollHeight, 280);
      if (below < height && above > below) {
        list.style.top = '';
        list.style.bottom = `${window.innerHeight - r.top + 4}px`;
        list.style.maxHeight = `${Math.min(280, above)}px`;
      } else {
        list.style.bottom = '';
        list.style.top = `${r.bottom + 4}px`;
        list.style.maxHeight = `${Math.min(280, below)}px`;
      }
    }

    function open() {
      if (button.disabled) return;
      if (current) current.close();
      current = api;
      render();
      // Inside a modal dialog the list must live in the dialog, or it would sit behind it.
      (select.closest('dialog') || document.body).append(list);
      place();
      button.setAttribute('aria-expanded', 'true');
      button.classList.add('dd-open');
    }

    function close() {
      list.remove();
      button.setAttribute('aria-expanded', 'false');
      button.classList.remove('dd-open');
      if (current === api) current = null;
    }

    function choose(i) {
      const opt = options()[i];
      if (!opt || opt.disabled) return;
      const changed = !opt.selected;
      opt.selected = true;
      sync();
      close();
      button.focus();
      if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    button.addEventListener('click', () => (current === api ? close() : open()));
    button.addEventListener('keydown', (e) => {
      const isOpen = current === api;
      if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        if (!isOpen) return open();
        highlight(active + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (isOpen) choose(active); else open();
      } else if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        e.stopPropagation(); // don't close the dialog too
        close();
      } else if (e.key === 'Tab' && isOpen) {
        close();
      } else if (e.key.length === 1 && isOpen) {
        // Type a letter to jump to the next option starting with it.
        const items = options();
        const start = active + 1;
        for (let k = 0; k < items.length; k++) {
          const j = (start + k) % items.length;
          if (items[j].textContent.trim().toLowerCase().startsWith(e.key.toLowerCase())) { highlight(j); break; }
        }
      }
    });
    // Clicking the field's label focuses the dropdown.
    if (select.id) document.querySelector(`label[for="${select.id}"]`)?.addEventListener('click', (e) => { e.preventDefault(); button.focus(); });

    // Options or the disabled/hidden state changed from code (e.g. replaceChildren).
    new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden'] });
    select.addEventListener('change', sync);
    select.form?.addEventListener('reset', () => setTimeout(sync));

    const api = { sync, close, button, list };
    select._dd = api;
    sync();
  }

  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.tagName === 'SELECT') enhance(root);
    else root.querySelectorAll('select').forEach(enhance);
  }

  document.querySelectorAll('select').forEach(enhance);
  new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach(scan)))
    .observe(document.body, { childList: true, subtree: true });

  document.addEventListener('mousedown', (e) => {
    if (current && !current.list.contains(e.target) && !current.button.contains(e.target)) current.close();
  });
  window.addEventListener('resize', () => current?.close());
  document.addEventListener('scroll', (e) => { if (current && !current.list.contains(e.target)) current.close(); }, true);
})();
