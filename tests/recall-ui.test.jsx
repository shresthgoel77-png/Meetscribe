import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import MeetingRecall, { RecallAnswer, RecallFeedback, recallEnterAction, recallSourceDate, recallSourceLocator } from '../renderer/components/MeetingRecall.jsx';

const source = { evidenceId: 'E' + 'a'.repeat(24), title: 'A synthetic meeting', startedAt: '2026-11-10T03:00:00Z', section: 'Saved summary',
  text: 'The exact saved excerpt.', locator: { kind: 'notes', path: ['summary'], from: 0, to: 24 } };
const answer = { requestId: 'synthetic-id', status: 'answered', text: 'A validated answer.', sources: [source], claims: [],
  coverage: { details: 'sufficient', exhaustive: false }, uncertainty: [] };
const render = (change = {}, state = {}) => renderToStaticMarkup(React.createElement(RecallAnswer, { view: { answer: { ...answer, ...change }, ...state }, openSource: () => {} }));
describe('Recall React answer/evidence markup', () => {
  it('renders one speech error and never claims absent sources remain available', () => {
    const html = renderToStaticMarkup(React.createElement(RecallFeedback, { view: { playback: 'failed',
      answer: { status: 'insufficient_evidence', sources: [] }, error: { message: 'Gnani synthesis failed.' } } }));
    expect(html.match(/role="alert"/g)).toHaveLength(1); expect(html).toContain('delivered text remains readable');
    expect(html).not.toContain('sources remain'); expect(html).not.toContain('answering service');
  });
  it('makes selected-meeting coverage gaps explicit', () => {
    expect(render({ coverage: { meetings: { requested: 2, available: 2, retrieved: 2, cited: 1 } } })).toContain('Verified sources cover 1 of 2 requested meetings');
  });
  it('escapes model text, saved excerpts and titles as literal data without HTML execution', () => {
    const injection = '<img src=x onerror=alert(1)><script>secret()</script>';
    const html = render({ text: injection, sources: [{ ...source, title: injection, text: injection }] });
    expect(html).not.toContain('<img'); expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img'); expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Show saved evidence'); expect(html).toContain('Request meeting viewer:');
  });
  it('exposes the entire answer and exact excerpt in separate readable elements, without truncation', () => {
    const text = 'x'.repeat(599) + 'END', excerpt = 'saved '.repeat(260) + 'TAIL';
    const html = render({ text, sources: [{ ...source, text: excerpt }] });
    expect(html).toContain(text); expect(html).toContain(excerpt);
    expect(html).toContain('<details>'); expect(html).toContain('<blockquote');
    expect(html).not.toContain('line-clamp'); expect(html).not.toContain('dangerouslySetInnerHTML');
  });
  it('shows partial/contradictory/reduced coverage without choosing a newer winner', () => {
    const html = render({ coverage: { details: 'partial' }, uncertainty: ['conflicting_evidence', 'reduced_retrieval'] });
    expect(html).toContain('Partial coverage'); expect(html).toContain('Saved sources disagree'); expect(html).toContain('Query expansion was unavailable');
  });
  it.each(['empty_scope', 'no_match', 'context_limit', 'ambiguous_date', 'insufficient_support'])('renders honest %s state with no fabricated source chip', reason => {
    const html = render({ status: 'insufficient_evidence', text: 'Insufficient saved evidence.', sources: [], claims: [], coverage: { reason } });
    expect(html).toContain('Insufficient evidence'); expect(html).not.toContain('recall-source-chip');
  });
  it('keeps a stale answer readable while removing source controls and excerpts', () => {
    const html = render({}, { sourceStale: true });
    expect(html).toContain('A validated answer.'); expect(html).toContain('sources need fresh retrieval');
    expect(html).not.toContain('The exact saved excerpt.'); expect(html).not.toContain('recall-source-chip');
  });
  it('labels genuine recording time and synthetic/pasted segments without inventing time or paragraph numbers', () => {
    expect(recallSourceLocator({ locator: { kind: 'transcript', startSeconds: 0 } })).toBe('Recording 0:00');
    expect(recallSourceLocator({ locator: { kind: 'transcript', startSeconds: 125.8 } })).toBe('Recording 2:05');
    expect(recallSourceLocator({ locator: { kind: 'transcript', startSeconds: null, segmentIndex: 7 } })).toBe('Transcript segment 8 · no recording timestamp');
    expect(recallSourceLocator(source)).toBe('Saved notes · characters 1–24');
    expect(recallSourceDate(null)).toBe('Date unavailable'); expect(recallSourceDate('not a date')).toBe('Date unavailable');
  });
  it('renders an accessible separate shell/composer and honest disabled audio controls without App context', () => {
    const html = renderToStaticMarkup(React.createElement(MeetingRecall, { api: null, lifecycle: null, expanded: false, onToggleExpand: () => {}, onClose: () => {} }));
    expect(html).toContain('aria-label="Close Meeting Recall"'); expect(html).toContain('id="recall-question"');
    expect(html).toContain('Shift+Enter'); expect(html).toContain('aria-label="Stop Recall audio"');
    expect(html).toContain('selected saved excerpts go to your answering LLM');
  });
});
describe('Recall keyboard submission policy', () => {
  it.each([
    [{ key: 'Enter' }, 'submit'], [{ key: 'Enter', repeat: true }, 'ignore'], [{ key: 'Enter', shiftKey: true }, 'edit'],
    [{ key: 'Enter', isComposing: true }, 'edit'], [{ key: 'Enter', nativeEvent: { isComposing: true } }, 'edit'],
    [{ key: 'Enter', keyCode: 229 }, 'edit'], [{ key: 'a' }, 'edit'],
  ])('handles %j as %s', (event, result) => expect(recallEnterAction(event)).toBe(result));
});
