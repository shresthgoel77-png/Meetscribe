// Own exactly one Recall accelerator. Never unregisterAll or probe an unsaved preference.
function createRecallShortcutController({ globalShortcut, validateShortcut, toggle, platform = process.platform }) {
  let owned = '', state = 'unregistered', disposed = false, started = false;
  const canonical = value => {
    const parts = value.toLowerCase().split('+');
    const aliases = { control: 'ctrl', command: 'cmd', commandorcontrol: platform === 'darwin' ? 'cmd' : 'ctrl',
      cmdorctrl: platform === 'darwin' ? 'cmd' : 'ctrl', option: 'alt', meta: 'super' };
    const key = parts.pop();
    return [...new Set(parts.map(part => aliases[part] || part))].sort().join('+') + '+' + ({ enter: 'return', esc: 'escape' }[key] || key);
  };
  const conflict = () => Object.assign(new Error('SHORTCUT_CONFLICT: Recall could not acquire that shortcut. The previous binding and saved shortcut were kept. Choose another shortcut or Disable shortcut.'), { code: 'SHORTCUT_CONFLICT' });
  function acquire(value) {
    validateShortcut(value);
    if (value === '') return '';
    if (owned && canonical(value) === canonical(owned)) return owned;
    try { if (globalShortcut.register(value, () => { if (!disposed) toggle(); })) return value; } catch { /* same safe conflict for OS rejection */ }
    throw conflict();
  }
  return {
    start(value) {
      if (disposed || started) return; started = true;
      try { owned = acquire(value); state = value ? 'registered' : 'disabled'; }
      catch (error) { state = error.code === 'SHORTCUT_CONFLICT' ? 'conflict' : 'invalid'; }
    },
    save(updates, persist) {
      if (disposed) throw new Error('Recall shortcut is unavailable.');
      if (!Object.hasOwn(updates, 'recallShortcut')) { persist(updates); return { applied: updates }; }
      const next = updates.recallShortcut;
      let replacement;
      try { replacement = acquire(next); }
      catch (error) {
        const rest = { ...updates }; delete rest.recallShortcut;
        if (Object.keys(rest).length) persist(rest);
        return { applied: rest, error: error.code === 'SHORTCUT_CONFLICT' ? error :
          new Error('Invalid Recall shortcut. Choose modifiers and one supported key, or Disable shortcut.') };
      }
      try { persist(updates); }
      catch (error) {
        if (replacement && replacement !== owned) globalShortcut.unregister(replacement);
        throw error;
      }
      if (owned && owned !== replacement) globalShortcut.unregister(owned);
      owned = replacement; state = next ? 'registered' : 'disabled';
      return { applied: updates };
    },
    getState: () => state,
    dispose() {
      if (disposed) return; disposed = true;
      if (owned) globalShortcut.unregister(owned);
      owned = ''; state = 'unregistered';
    },
  };
}
module.exports = { createRecallShortcutController };
