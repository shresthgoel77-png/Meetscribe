import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import MeetingRecall from './components/MeetingRecall.jsx';
import { createRecallLifecycle } from './lib/recallLifecycle.js';
import './styles/globals.css';
import './styles/recall.css';

const api = window.meetscribeRecall;
function applyTheme(theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.classList.toggle('light', theme !== 'dark');
}
export function RecallShell() {
  const [lifecycle, setLifecycle] = useState(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!api) return;
    applyTheme(api.startupTheme);
    const owner = createRecallLifecycle({ api, onTheme: applyTheme });
    setLifecycle(owner);
    return () => owner.dispose();
  }, []);
  const resize = async () => {
    if (!api) return;
    const next = !expanded;
    const reply = await api.resize({ requestId: crypto.randomUUID(), width: next ? 640 : 420, height: next ? 800 : 480 });
    if (reply?.status !== 'complete') throw new Error('Resize unavailable');
    setExpanded(next);
  };
  return <MeetingRecall api={api} lifecycle={lifecycle} expanded={expanded} onToggleExpand={resize} onClose={() => lifecycle?.close()} />;
}
// No App import/provider, meeting capture subscription or microphone/player construction.
createRoot(document.getElementById('root')).render(<RecallShell />);
