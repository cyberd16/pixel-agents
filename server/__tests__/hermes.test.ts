import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { hermesProvider } from '../src/providers/hook/hermes/hermes.js';

/** The Hermes outbound envelope, exactly as agent/outbound_webhooks.py
 *  serializes it (hook_event_name/profile/tool_name/tool_input/session_id/cwd/
 *  extra/delivery_id/timestamp), with a helper so each test changes one field. */
function envelope(event: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: event,
    profile: 'default',
    tool_name: null,
    tool_input: null,
    session_id: 'sess-abc',
    cwd: '/work/project',
    extra: {},
    delivery_id: 'd1',
    timestamp: '2026-10-21T12:00:00Z',
    ...fields,
  };
}

describe('hermesProvider', () => {
  describe('identity', () => {
    it('has kind "hook" and id "hermes"', () => {
      expect(hermesProvider.kind).toBe('hook');
      expect(hermesProvider.id).toBe('hermes');
    });
    it('has the user-facing displayName', () => {
      expect(hermesProvider.displayName).toBe('Hermes Agent');
    });
    it('has protocolVersion 1', () => {
      expect(hermesProvider.protocolVersion).toBe(1);
    });
    it('declares NO team provider (Hermes sub-agents are full sessions)', () => {
      expect(hermesProvider.team).toBeUndefined();
      expect(hermesProvider.subagentToolNames.size).toBe(0);
    });
    it('classifies Hermes reading tools and not its write tools', () => {
      expect(hermesProvider.readingTools.has('read_file')).toBe(true);
      expect(hermesProvider.readingTools.has('search_files')).toBe(true);
      expect(hermesProvider.readingTools.has('terminal')).toBe(false);
    });
    it('has no file-fallback surface (push-only provider)', () => {
      expect(hermesProvider.getSessionDirs).toBeUndefined();
      expect(hermesProvider.parseTranscriptLine).toBeUndefined();
      expect(hermesProvider.buildLaunchCommand).toBeUndefined();
    });
  });

  describe('isAvailable', () => {
    let created: string | null = null;
    function cleanup(): void {
      if (created) fs.rmSync(created, { recursive: true, force: true });
      created = null;
      delete process.env.HERMES_HOME;
    }
    afterEach(cleanup);

    it('is false when HERMES_HOME does not exist', () => {
      created = null;
      process.env.HERMES_HOME = path.join(os.tmpdir(), 'pxl-hermes-absent-home');
      expect(hermesProvider.isAvailable!()).toBe(false);
    });
    it('is true when HERMES_HOME is a real directory', () => {
      created = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hermes-present-home'));
      process.env.HERMES_HOME = created;
      expect(hermesProvider.isAvailable!()).toBe(true);
    });
  });

  describe('normalizeHookEvent', () => {
    it('drops payloads missing hook_event_name', () => {
      expect(hermesProvider.normalizeHookEvent({ session_id: 's' })).toBeNull();
    });
    it('drops payloads with empty session_id (approval-shaped kwargs, stale subs)', () => {
      expect(
        hermesProvider.normalizeHookEvent(envelope('pre_tool_call', { session_id: '' })),
      ).toBeNull();
    });
    it('drops unknown event names', () => {
      expect(hermesProvider.normalizeHookEvent(envelope('pre_gateway_dispatch'))).toBeNull();
    });

    it('maps pre_tool_call to toolStart carrying the real tool_call_id', () => {
      const out = hermesProvider.normalizeHookEvent(
        envelope('pre_tool_call', {
          tool_name: 'terminal',
          tool_input: { command: 'ls -la', background: true },
          extra: { tool_call_id: 'tc-77', turn_id: 't1' },
        }),
      );
      expect(out).not.toBeNull();
      expect(out!.sessionId).toBe('sess-abc');
      expect(out!.event).toEqual({
        kind: 'toolStart',
        toolId: 'tc-77',
        toolName: 'terminal',
        input: { command: 'ls -la', background: true },
        runInBackground: true,
      });
    });
    it('falls back to a synthetic toolId when extra.tool_call_id is absent', () => {
      const out = hermesProvider.normalizeHookEvent(
        envelope('pre_tool_call', { tool_name: 'read_file', tool_input: { path: '/x' } }),
      );
      expect(out!.event.kind).toBe('toolStart');
      const e = out!.event as { toolId: string };
      expect(e.toolId.startsWith('hook-')).toBe(true);
    });

    it('maps post_tool_call to the current-sentinel toolEnd', () => {
      const out = hermesProvider.normalizeHookEvent(
        envelope('post_tool_call', { extra: { status: 'error', duration_ms: 12 } }),
      );
      expect(out!.event).toEqual({ kind: 'toolEnd', toolId: 'current' });
    });

    it('maps on_session_start to sessionStart with cwd, without a transcript path', () => {
      const out = hermesProvider.normalizeHookEvent(
        envelope('on_session_start', { extra: { model: 'qwen', platform: 'cli' } }),
      );
      expect(out!.event).toEqual({
        kind: 'sessionStart',
        source: 'startup',
        transcriptPath: undefined,
        cwd: '/work/project',
      });
    });
    it('drops on_session_start for unattended platforms (cron/batch)', () => {
      expect(
        hermesProvider.normalizeHookEvent(
          envelope('on_session_start', { extra: { platform: 'cron' } }),
        ),
      ).toBeNull();
      expect(
        hermesProvider.normalizeHookEvent(
          envelope('on_session_start', { extra: { platform: 'batch' } }),
        ),
      ).toBeNull();
    });

    it('maps on_session_end (per-turn) to turnEnd, cron-dropped like the start', () => {
      const out = hermesProvider.normalizeHookEvent(
        envelope('on_session_end', {
          extra: { completed: true, interrupted: false, platform: 'cli' },
        }),
      );
      expect(out!.event).toEqual({ kind: 'turnEnd' });
      expect(
        hermesProvider.normalizeHookEvent(
          envelope('on_session_end', { extra: { platform: 'cron' } }),
        ),
      ).toBeNull();
    });

    it('maps on_human_input_request to turnEnd awaitingInput (the idle bubble)', () => {
      const out = hermesProvider.normalizeHookEvent(
        envelope('on_human_input_request', { extra: { kind: 'elicitation', platform: 'cli' } }),
      );
      expect(out!.event).toEqual({ kind: 'turnEnd', awaitingInput: true });
    });

    it('maps on_session_finalize to sessionEnd', () => {
      const out = hermesProvider.normalizeHookEvent(
        envelope('on_session_finalize', { extra: { platform: 'tui' } }),
      );
      expect(out!.event).toEqual({ kind: 'sessionEnd', reason: 'tui' });
    });
  });

  describe('formatToolStatus', () => {
    it('renders read_file with the basename', () => {
      expect(hermesProvider.formatToolStatus('read_file', { path: '/a/b/notes.md' })).toBe(
        'Reading notes.md',
      );
    });
    it('renders terminal with the command', () => {
      expect(hermesProvider.formatToolStatus('terminal', { command: 'pytest -q' })).toBe(
        'Running: pytest -q',
      );
    });
    it('distinguishes search_files target', () => {
      expect(hermesProvider.formatToolStatus('search_files', { target: 'files' })).toBe(
        'Searching files',
      );
      expect(hermesProvider.formatToolStatus('search_files', { target: 'content' })).toBe(
        'Searching code',
      );
    });
    it('renders delegate_task goal as Subtask, unknown tools as Using <tool>', () => {
      expect(hermesProvider.formatToolStatus('delegate_task', { goal: 'triage issues' })).toBe(
        'Subtask: triage issues',
      );
      expect(hermesProvider.formatToolStatus('vision_analyze', {})).toBe('Using vision_analyze');
    });
    it('handles Windows-style paths for basename', () => {
      expect(hermesProvider.formatToolStatus('write_file', { path: 'C:\\proj\\main.py' })).toBe(
        'Writing main.py',
      );
    });
  });
});
