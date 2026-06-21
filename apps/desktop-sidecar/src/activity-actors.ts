/** Who-made-it classification for op-log events — shared by activity.list IPC
 *  and listOplogEventsForActivity. Keep in sync with apps/desktop activityActor. */

export function friendlyClientName(name?: string): string {
  if (!name) return 'Unknown client';
  const map: Record<string, string> = {
    'claude-ai': 'Claude Desktop', 'claude-desktop': 'Claude Desktop',
    'claude-code': 'Claude Code', 'cursor-vscode': 'Cursor', 'cursor': 'Cursor',
    'zed': 'Zed', 'windsurf': 'Windsurf', 'ghampus': 'Ghampus',
  };
  if (map[name]) return map[name]!;
  if (name.startsWith('local-agent-mode-')) return 'Claude Skills agent';
  return name;
}

export function actorOf(ev: { after?: unknown; before?: unknown }): { label: string; cls: string } {
  const aa = (ev.after ?? {}) as Record<string, unknown>;
  const bb = (ev.before ?? {}) as Record<string, unknown>;
  const client = (aa['addedBy'] ?? aa['correctedBy']) as string | undefined;
  if (client) return { label: friendlyClientName(client), cls: 'ai' };
  const trig = ((aa['triggeredBy'] ?? bb['triggeredBy']) as string | undefined) ?? '';
  const reason = ((aa['reason'] ?? bb['reason']) as string | undefined) ?? '';
  if (trig.startsWith('user:')) return { label: 'You', cls: 'user' };
  if (trig.startsWith('brain:') || /\bbrain:|auto-relink|auto-link/i.test(reason)) {
    return { label: 'Autonomous brain', cls: 'brain' };
  }
  if (/user-confirmed/i.test(reason)) return { label: 'You', cls: 'user' };
  if (trig.startsWith('ipc:')) return { label: 'App', cls: 'app' };
  return { label: 'System', cls: 'app' };
}
